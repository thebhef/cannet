// The Servers panel: the one place this machine's relationship with
// every cannet server is managed (ADR 0041).
//
// **Server selection and authentication are user-level, not
// per-project.** A server is trusted by this machine, once, in here;
// what a project does with it is a separate question answered on a bus.
// That is why this is a singleton panel and not a form inside a bus
// row.
//
// One merged list, keyed by `host:port`: a server advertising on the
// network and a server this machine has accepted are the same row, and
// a trusted server that is switched off stays in the list, greyed,
// because forgetting it must not require waiting for it to come back.
//
// Three rules the markup exists to keep visible:
//
// - **The badge is the host's.** Trusted, new, and identity-changed are
//   computed in `server_list.rs` from the trust store and from what a
//   refused connection actually observed. Nothing here re-derives them.
// - **The fingerprint is shown verbatim**, in the same `SHA256:` form
//   the server printed, so the string a user compared once can be
//   compared again.
// - **Trusting is always a fresh observation.** "Trust…" dials the
//   server first and shows the certificate that came back; it never
//   pins something remembered from an earlier look.

import { useCallback, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import { ServerTrustDialog } from "./ServerTrustDialog";
import {
  browseNotice,
  matchServerRows,
  trustLabel,
  useServerList,
  NOTHING_ADVERTISING,
  type ServerRow,
} from "./serverList";
import { forgetServer, setServerToken } from "./serverTrust";

export function ServersPanel(_props: IDockviewPanelProps) {
  const { servers, browse } = useServerList();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which row's trust dialog is open, and which row's token field is
  // showing — both view-local, both addressed by the row's identity so
  // a list that moves underneath cannot leave them on the wrong server.
  const [dialogFor, setDialogFor] = useState<string | null>(null);
  const [tokenFor, setTokenFor] = useState<string | null>(null);

  const matches = useMemo(() => matchServerRows(servers, query), [servers, query]);
  const dialogRow = servers.find((r) => r.address === dialogFor);

  const run = useCallback(async (address: string, action: () => Promise<void>) => {
    setBusy(address);
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(String(err));
    }
    setBusy(null);
  }, []);

  /// Dial the server so the host sees the certificate it is presenting
  /// now, then show whatever question that raised. A refusal is the
  /// expected outcome — it is what produces the fingerprint — so the
  /// error is not surfaced as a failure.
  const trust = useCallback(async (address: string) => {
    setBusy(address);
    try {
      await invoke("refresh_interfaces", { address });
    } catch {
      // The refusal is the point; the question it raised is on the row.
    }
    setBusy(null);
    setError(null);
    setDialogFor(address);
  }, []);

  const notice = browseNotice(browse);

  return (
    <div className="settings-panel servers-panel">
      <h2 className="settings-title">Servers</h2>
      <p className="settings-hint">
        Servers this machine can reach: the ones advertising on this network
        and the ones whose identity has been accepted here. Accepting a server
        is a decision for this machine, not for a project.
      </p>
      <div className="servers-toolbar">
        <input
          type="text"
          className="servers-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search"
          aria-label="search servers"
        />
      </div>
      {notice !== null && (
        <p
          className={`servers-notice${browse.state === "running" || browse.state === "starting" ? "" : " servers-notice-warn"}`}
          role="status"
        >
          {notice}
        </p>
      )}
      {error !== null && <p className="servers-error">{error}</p>}
      {servers.length === 0 ? (
        browse.state === "running" && <p className="servers-empty">{NOTHING_ADVERTISING}</p>
      ) : matches.length === 0 ? (
        <p className="servers-empty">No server matches.</p>
      ) : (
        <div className="servers-list">
          {matches.map((row) => (
            <ServerRowView
              key={row.address}
              row={row}
              busy={busy === row.address}
              tokenOpen={tokenFor === row.address}
              onTrust={() => void trust(row.address)}
              onToggleToken={() =>
                setTokenFor((prev) => (prev === row.address ? null : row.address))
              }
              onSaveToken={(token) =>
                void run(row.address, async () => {
                  await setServerToken(row.address, token);
                  setTokenFor(null);
                })
              }
              onForget={() => void run(row.address, () => forgetServer(row.address))}
            />
          ))}
        </div>
      )}
      {dialogRow?.prompt != null && (
        <ServerTrustDialog
          address={dialogRow.address}
          prompt={dialogRow.prompt}
          onDismiss={() => setDialogFor(null)}
        />
      )}
    </div>
  );
}

interface ServerRowViewProps {
  row: ServerRow;
  busy: boolean;
  tokenOpen: boolean;
  onTrust: () => void;
  onToggleToken: () => void;
  onSaveToken: (token: string) => void;
  onForget: () => void;
}

function ServerRowView({
  row,
  busy,
  tokenOpen,
  onTrust,
  onToggleToken,
  onSaveToken,
  onForget,
}: ServerRowViewProps) {
  const [token, setToken] = useState("");
  // Everything stored for a server is dropped together, so the button
  // appears whenever there is anything to drop — which is not the same
  // as the row being trusted: a loopback server is reached in the clear
  // and has nothing stored behind it.
  const stored = row.fingerprint !== null || row.hasToken || row.insecure;
  return (
    <div className={`server-row${row.online ? "" : " offline"}`}>
      <span className={`server-badge ${row.trust}`}>{trustLabel(row)}</span>
      <span className="server-name">{row.name ?? "not advertising"}</span>
      <span className="server-host">{row.host ?? ""}</span>
      <span className="server-address">{row.address}</span>
      <span className="server-version">{row.version ?? ""}</span>
      <span className="server-token">
        {row.hasToken ? "token stored" : "no token"}
      </span>
      <span className="server-actions">
        {row.trust !== "trusted" && (
          <button
            type="button"
            className={row.trust === "fingerprintChanged" ? "danger" : undefined}
            disabled={busy}
            aria-label={`trust ${row.address}`}
            title="Connect to this server and show the certificate it presents, to compare against the one it printed."
            onClick={onTrust}
          >
            {row.trust === "fingerprintChanged" ? "Review identity…" : "Trust…"}
          </button>
        )}
        {row.fingerprint !== null && (
          <button
            type="button"
            disabled={busy}
            aria-label={`set token for ${row.address}`}
            title="Replace the access token stored for this server. The server prints the current one each time it starts."
            onClick={onToggleToken}
          >
            Token…
          </button>
        )}
        {stored && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            aria-label={`forget ${row.address}`}
            title="Forget this server's fingerprint and token. The next connection to it asks again."
            onClick={onForget}
          >
            Forget
          </button>
        )}
      </span>
      {row.fingerprint !== null && (
        <code className="server-fingerprint">{row.fingerprint}</code>
      )}
      {row.insecure && (
        <span className="server-fingerprint unprotected">
          connects without protection
        </span>
      )}
      {tokenOpen && (
        <span className="server-token-entry">
          <input
            type="text"
            aria-label={`access token for ${row.address}`}
            placeholder="the token the server printed"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            aria-label={`save token for ${row.address}`}
            onClick={() => onSaveToken(token)}
          >
            Save
          </button>
        </span>
      )}
    </div>
  );
}
