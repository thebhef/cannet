// Server trust — a view over the host's model, never a decision.
//
// The host decides how each server is reached (`connect_flow.rs`) and
// remembers what the user accepted (`server_trust.rs`, ADR 0032). This
// module only subscribes to the questions it raises and passes the
// answers back. Nothing here holds a token, decides whether a
// connection is safe, or keeps an authoritative copy of what is pinned:
// the fingerprint strings that arrive are for the user to read, and the
// list below is re-read from the host after every change.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/// Tauri event the host fires whenever the set of pending trust
/// questions moves. Must match
/// `connect_flow::SERVER_PROMPTS_CHANGED_EVENT` host-side.
export const SERVER_PROMPTS_CHANGED_EVENT = "server-prompts-changed";

/// A question about one server that only the user can answer. Mirrors
/// the host's `connect_flow::TrustPrompt`.
export type TrustPrompt =
  /// First contact: `observed` is the `SHA256:` line the server printed
  /// at startup, for the user to compare before it is pinned.
  | { kind: "acceptIdentity"; observed: string }
  /// The server presented a different certificate than the pinned one.
  /// The connection was refused before anything was sent.
  | { kind: "identityChanged"; expected: string; observed: string }
  /// The server refused the access token.
  | { kind: "tokenRefused" }
  /// A protected connection never reached a certificate — the endpoint
  /// is not speaking TLS, or is not answering at all.
  | { kind: "noProtection"; detail: string };

/// Pending questions, keyed by the server address they are about.
export type ServerPrompts = Record<string, TrustPrompt>;

/// Subscribe to the host's pending trust questions. Same
/// pull-then-follow shape as the connection states and the interface
/// cache (ADR 0016): one snapshot on mount, then the change event. The
/// payload is the whole map, bounded by the servers a project names.
export function useServerPrompts(): ServerPrompts {
  const [prompts, setPrompts] = useState<ServerPrompts>({});

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      try {
        const initial = await invoke<ServerPrompts>("get_server_prompts");
        if (!cancelled && initial) setPrompts(initial);
      } catch {
        // Host without the command (older build, dev shell): fall
        // through to the listener and stay empty if none comes.
      }
      try {
        unlisten = await listen<ServerPrompts>(
          SERVER_PROMPTS_CHANGED_EVENT,
          (e) => {
            if (!cancelled) setPrompts(e.payload ?? {});
          },
        );
      } catch {
        // Same fallback: stay on whatever snapshot we have.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  return prompts;
}

/// Pin `fingerprint` for `address`, storing `token` alongside it when
/// one was given. The write behind both first contact and the
/// re-accept path out of a changed identity.
export async function acceptServerFingerprint(
  address: string,
  fingerprint: string,
  token: string | null,
): Promise<void> {
  await invoke("accept_server_fingerprint", {
    address,
    fingerprint,
    token: token === null || token === "" ? null : token,
  });
}

/// Replace the access token stored for `address`. An empty string
/// removes it.
export async function setServerToken(
  address: string,
  token: string,
): Promise<void> {
  await invoke("set_server_token", { address, token });
}

/// Record that the user chose to reach `address` without protection.
/// Drops any pin and token for it — a credential never rides an
/// unencrypted channel.
export async function acceptServerInsecure(address: string): Promise<void> {
  await invoke("accept_server_insecure", { address });
}

/// Forget everything stored for `address`; the next connection starts
/// over at trust-on-first-use.
export async function forgetServer(address: string): Promise<void> {
  await invoke("forget_server", { address });
}

/// Separates the fields of a dismissal key. A newline, because no
/// address, fingerprint, or prompt kind can contain one — so two
/// different questions can never produce the same key by running their
/// fields together.
const KEY_SEPARATOR = "\n";

/// A stable identity for one question, so dismissing it dismisses that
/// question and not the next, different one about the same server.
export function promptKey(address: string, prompt: TrustPrompt): string {
  const fields = (...rest: string[]) =>
    [address, prompt.kind, ...rest].join(KEY_SEPARATOR);
  switch (prompt.kind) {
    case "acceptIdentity":
      return fields(prompt.observed);
    case "identityChanged":
      return fields(prompt.expected, prompt.observed);
    case "tokenRefused":
      return fields();
    case "noProtection":
      return fields(prompt.detail);
  }
}

/// The question to put in front of the user next: the first pending one
/// the user has not dismissed, in address order so the choice is stable
/// across re-renders.
export function nextPrompt(
  prompts: ServerPrompts,
  dismissed: ReadonlySet<string>,
): { address: string; prompt: TrustPrompt } | null {
  for (const address of Object.keys(prompts).sort()) {
    const prompt = prompts[address];
    if (!dismissed.has(promptKey(address, prompt))) return { address, prompt };
  }
  return null;
}
