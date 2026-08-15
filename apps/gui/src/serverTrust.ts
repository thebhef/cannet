// Server trust — a view over the host's model, never a decision.
//
// The host decides how each server is reached (`connect_flow.rs`) and
// remembers what the user accepted (`server_trust.rs`, ADR 0032). This
// module reads the questions it is waiting on and passes the answers
// back. Nothing here holds a token, decides whether a connection is
// safe, or keeps an authoritative copy of what is pinned: the
// fingerprint strings that arrive are for the user to read, and the
// list below is re-read from the host after every change.
//
// The one decision that *is* this side's: **which question becomes a
// modal.** A question the host raised on its own is an indicator on the
// rows that carry it; only a user action puts one on screen, through
// the single raise below.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

import { serverKey } from "./serverList";

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

/// The host's pending question about `address`, or `null` when it is
/// waiting on nothing for that server.
///
/// The host keys a question by whatever address the connection was made
/// with, and a row is keyed the way the trust store files it, so the
/// two are matched through {@link serverKey} rather than by string
/// equality. The address that comes back is the host's own spelling —
/// the answer is written back against the question that was asked.
export function promptFor(
  prompts: ServerPrompts,
  address: string,
): RaisedPrompt | null {
  const key = serverKey(address);
  for (const [at, prompt] of Object.entries(prompts)) {
    if (serverKey(at) === key) return { address: at, prompt };
  }
  return null;
}

/// One question, put in front of the user because they asked to see it.
export interface RaisedPrompt {
  address: string;
  prompt: TrustPrompt;
}

// ---- The one raised question ----------------------------------------------
//
// **A trust question becomes a modal only when a user action asks for
// it.** The host raises questions on its own schedule — a background
// interface watch against a known server finds its certificate changed
// while nobody was trying to connect — and interrupting the user with a
// modal for that is a nuisance. Such a question surfaces as an
// indicator on the server's row and on the bus rows bound to it; this
// is what the *user's* own act of connecting, trusting, or reviewing
// puts on screen, and there is exactly one of them.

let raised: RaisedPrompt | null = null;
const raiseListeners = new Set<() => void>();

function publishRaise() {
  for (const listener of [...raiseListeners]) listener();
}

/// Put the host's pending question about `address` in front of the
/// user, and say whether there was one to put there.
///
/// **The host is asked at the moment of raising**, which is what keeps
/// a raise from outliving the attempt that made it: an attempt that
/// raised no question leaves nothing armed, so a later question the
/// host asks on its own cannot be caught by a stale request and turned
/// into the modal ruling this out.
export async function raiseServerTrust(address: string): Promise<boolean> {
  let prompts: ServerPrompts = {};
  try {
    prompts = (await invoke<ServerPrompts>("get_server_prompts")) ?? {};
  } catch {
    // Host without the command (older build, dev shell): nothing to
    // ask about, so nothing is raised.
  }
  raised = promptFor(prompts, address);
  publishRaise();
  return raised !== null;
}

/// Close whatever is raised. The host keeps the question — it is still
/// true, and the indicators still say so — but the user is done with
/// this dialog.
export function clearServerTrust(): void {
  raised = null;
  publishRaise();
}

function subscribeRaise(onChange: () => void): () => void {
  raiseListeners.add(onChange);
  return () => raiseListeners.delete(onChange);
}

/// The question the user asked to see, if any.
export function useRaisedServerTrust(): RaisedPrompt | null {
  return useSyncExternalStore(
    subscribeRaise,
    () => raised,
    () => raised,
  );
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

/// A stable identity for one question, so the dialog showing it is a
/// different element from the one showing the next, different question
/// about the same server — a half-typed token never carries across.
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
