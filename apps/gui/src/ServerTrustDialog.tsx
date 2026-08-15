// The trust-on-first-use dialog and its three siblings (ADR 0041).
//
// The host raises a question about one server; this renders it and
// writes the answer back. It decides nothing: which question appears,
// and what happens once it is answered, are the host's
// (`connect_flow.rs`). The only state here is view-local — what the
// user has typed, and which questions they have waved away in this
// window.
//
// Two rules the markup exists to keep visible:
//
// - **The fingerprint is shown verbatim**, in the same `SHA256:` form
//   the server prints at startup, because comparing those two strings
//   by eye *is* the security check.
// - **Cancel stores nothing.** Rejecting an identity, declining an
//   unprotected connection, or dismissing a refused token all leave the
//   host exactly as it was, and no connection is made.

import { useEffect, useState } from "react";

import {
  acceptServerFingerprint,
  acceptServerInsecure,
  nextPrompt,
  promptKey,
  setServerToken,
  useServerPrompts,
  type TrustPrompt,
} from "./serverTrust";

/// Mount once. Renders at most one dialog — the first pending question
/// this window has not dismissed — and nothing at all when the host is
/// waiting on no one.
export function ServerTrustDialogs() {
  const prompts = useServerPrompts();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pending = nextPrompt(prompts, dismissed);
  if (pending === null) return null;
  return (
    <ServerTrustDialog
      key={promptKey(pending.address, pending.prompt)}
      address={pending.address}
      prompt={pending.prompt}
      onDismiss={() =>
        setDismissed((prev) => {
          const next = new Set(prev);
          next.add(promptKey(pending.address, pending.prompt));
          return next;
        })
      }
    />
  );
}

export interface ServerTrustDialogProps {
  address: string;
  prompt: TrustPrompt;
  /// Close without storing anything. The host keeps the question — it
  /// is still true — but this window stops asking it.
  onDismiss: () => void;
}

/// One trust question. Exported for tests and for any surface that
/// wants to re-raise a specific question.
export function ServerTrustDialog({
  address,
  prompt,
  onDismiss,
}: ServerTrustDialogProps) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  // The host drops the question once the answer is stored, so a
  // successful write needs no dismissal — the dialog unmounts with the
  // prompt. A failed one stays put and says why.
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void (async () => {
      try {
        await action();
        setError(null);
      } catch (err) {
        setError(String(err));
      }
      setBusy(false);
    })();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onDismiss}>
      <div
        className="modal server-trust"
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel(prompt)}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="modal-message">
          <strong>{dialogLabel(prompt)}</strong>
          <br />
          <span className="server-trust-address">{address}</span>
        </p>
        {prompt.kind === "acceptIdentity" && (
          <>
            <p className="server-trust-explain">
              Nothing has been accepted for this server yet, so the connection
              was refused. Check that the fingerprint below is the one the
              server printed when it started.
            </p>
            <Fingerprint label="Fingerprint" value={prompt.observed} />
          </>
        )}
        {prompt.kind === "identityChanged" && (
          <>
            <p className="server-trust-explain server-trust-warn">
              The connection was refused. This happens when a server is
              reinstalled or its certificate is replaced — and it is also what
              an impersonated server looks like. Accept it only if you know why
              it changed.
            </p>
            <Fingerprint label="Accepted before" value={prompt.expected} />
            <Fingerprint label="Presented now" value={prompt.observed} />
          </>
        )}
        {prompt.kind === "tokenRefused" && (
          <p className="server-trust-explain">
            The server refused the access token. It prints the current one each
            time it starts; paste that value below.
          </p>
        )}
        {prompt.kind === "noProtection" && (
          <>
            <p className="server-trust-explain server-trust-warn">
              A protected connection could not be established, so nothing was
              sent. Either the server is running without TLS, or it is not
              answering. Connecting anyway leaves the traffic — and control of
              the bus — unprotected on this network.
            </p>
            <p className="server-trust-detail">{prompt.detail}</p>
          </>
        )}
        {promptTakesToken(prompt) && (
          <label className="server-trust-token">
            Access token
            <input
              type="text"
              aria-label="access token"
              placeholder="the token the server printed"
              value={token}
              autoFocus
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
        )}
        {error !== null && <p className="server-trust-error">{error}</p>}
        <div className="modal-buttons">
          {prompt.kind === "acceptIdentity" && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(() =>
                  acceptServerFingerprint(address, prompt.observed, token),
                )
              }
            >
              Accept and connect
            </button>
          )}
          {prompt.kind === "identityChanged" && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                run(() =>
                  acceptServerFingerprint(address, prompt.observed, token),
                )
              }
            >
              Accept the new identity
            </button>
          )}
          {prompt.kind === "tokenRefused" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => setServerToken(address, token))}
            >
              Save token
            </button>
          )}
          {prompt.kind === "noProtection" && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => run(() => acceptServerInsecure(address))}
            >
              Connect without protection
            </button>
          )}
          <button type="button" disabled={busy} onClick={onDismiss}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/// One fingerprint line, shown exactly as the server prints it.
function Fingerprint({ label, value }: { label: string; value: string }) {
  return (
    <p className="server-trust-fingerprint">
      <span className="server-trust-fingerprint-label">{label}</span>
      <code>{value}</code>
    </p>
  );
}

/// Whether this question collects a token. Accepting an identity is the
/// moment the operator has the server's console in front of them, so
/// the token field rides along with it rather than waiting for a second
/// rejection.
function promptTakesToken(prompt: TrustPrompt): boolean {
  return (
    prompt.kind === "acceptIdentity" ||
    prompt.kind === "identityChanged" ||
    prompt.kind === "tokenRefused"
  );
}

function dialogLabel(prompt: TrustPrompt): string {
  switch (prompt.kind) {
    case "acceptIdentity":
      return "Accept this server's identity?";
    case "identityChanged":
      return "This server's identity has changed";
    case "tokenRefused":
      return "The server refused the access token";
    case "noProtection":
      return "This server cannot be reached securely";
  }
}
