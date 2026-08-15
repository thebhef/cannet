// The **Connection › Trusted servers** row of the settings view: every
// server whose identity this machine has accepted, and the one action
// over it (ADR 0041).
//
// It lives in settings for the same reason the project-cache list does:
// "what has this install agreed to trust, and how do I take that back"
// is a question a user comes to settings for, and there is no other
// home for it. Nothing here decides anything — the host owns the store
// (`server_trust.rs`), and the list is re-read from it after a change.
//
// The fingerprint is shown in full, in the same `SHA256:` form the
// server prints and the accept dialog showed, so the string a user
// compared once can be compared again.

import { useCallback, useEffect, useState } from "react";

import {
  forgetServer,
  listTrustedServers,
  type TrustedServer,
} from "./serverTrust";

export function TrustedServersList() {
  const [rows, setRows] = useState<readonly TrustedServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setRows(await listTrustedServers());
  }, []);

  // Asked for, never polled: on open, and after a change below.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const forget = useCallback(
    async (address: string) => {
      setBusy(true);
      try {
        await forgetServer(address);
        setError(null);
      } catch (err) {
        setError(String(err));
      }
      await refresh();
      setBusy(false);
    },
    [refresh],
  );

  return (
    <div className="trusted-servers">
      {error !== null && <p className="trusted-servers-error">{error}</p>}
      {rows.length === 0 && (
        <p className="trusted-servers-empty">
          No server identities accepted yet. The first connection to a server
          off this machine asks.
        </p>
      )}
      {rows.map((row) => (
        <div key={row.address} className="trusted-server-row">
          <span className="trusted-server-address">{row.address}</span>
          {row.insecure ? (
            <span className="trusted-server-fingerprint unprotected">
              connects without protection
            </span>
          ) : (
            <code className="trusted-server-fingerprint">
              {row.fingerprint ?? "no fingerprint"}
            </code>
          )}
          <span className="trusted-server-token">
            {row.hasToken ? "token stored" : "no token"}
          </span>
          <button
            type="button"
            className="danger"
            disabled={busy}
            title="Forget this server's fingerprint and token. The next connection to it asks again."
            onClick={() => void forget(row.address)}
          >
            Forget
          </button>
        </div>
      ))}
    </div>
  );
}
