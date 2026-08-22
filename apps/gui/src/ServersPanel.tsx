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
//   server and shows the certificate that came back; it never pins
//   something remembered from an earlier look. A row the host is
//   *already* waiting on carries such an observation — the attempt that
//   raised the question made it — so "Review…" puts that question up
//   without dialling again, which is what lets a server that has since
//   gone quiet still be reviewed.
// - **The panel owns no dialog.** A row's affordance raises the one
//   app-wide trust dialog (`ServerTrustDialog.tsx`); a second modal of
//   the panel's own over the same question is impossible by
//   construction.
// - **An address can be added by hand**, because discovery is multicast
//   and a server on another subnet advertises nowhere this machine can
//   hear. "Add server…" is the same act as a row's "Trust…" for an
//   address that has no row yet: the host checks it and dials it, and
//   the question that comes back is put to the user by the app-wide
//   trust dialog. Accepting it is what stores something, which is what
//   makes the row; a question waved away leaves nothing behind, and the
//   address is typed again to retry.

import { useCallback, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import {
  addressShapeError,
  browseNotice,
  matchServerRows,
  nothingStoredNote,
  serverKey,
  trustLabel,
  useServerList,
  NOTHING_ADVERTISING,
  type ServerRow,
} from "./serverList";
import {
  forgetServer,
  raiseServerTrust,
  setServerToken,
  type TrustPrompt,
} from "./serverTrust";
import { ChipButton } from "./ChipButton";
import { Icon } from "./Icon";

export function ServersPanel(_props: IDockviewPanelProps) {
  const { servers, browse } = useServerList();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the last action had to say when it changed nothing — a Forget
  // on a row the trust store never held. Cleared by the next action.
  const [note, setNote] = useState<string | null>(null);
  // Which row's token field is showing — view-local, and addressed by
  // the row's identity so a list that moves underneath cannot leave it
  // on the wrong server.
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  // The add-by-address field: what has been typed, what the last attempt
  // to add it said, and which row that attempt pointed at.
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addNote, setAddNote] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  const matches = useMemo(() => matchServerRows(servers, query), [servers, query]);

  const run = useCallback(async (address: string, action: () => Promise<void>) => {
    setBusy(address);
    setNote(null);
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(String(err));
    }
    setBusy(null);
  }, []);

  /// Put this row's trust question to the user, in the app-wide dialog.
  ///
  /// The host may already be waiting on one: a refused attempt — from a
  /// connect, or from the background interface watch — leaves a real
  /// observation behind, and reviewing it must not depend on the server
  /// still being reachable. Only when the host is waiting on nothing
  /// does the row dial, because that is what produces a first-contact
  /// fingerprint. A refusal is the expected outcome of that dial — it
  /// is what the fingerprint comes from — so it is not surfaced as a
  /// failure.
  const trust = useCallback(async (address: string) => {
    setBusy(address);
    if (!(await raiseServerTrust(address))) {
      try {
        await invoke("refresh_interfaces", { address });
      } catch {
        // The refusal is the point; what it raised is asked below.
      }
      await raiseServerTrust(address);
    }
    setBusy(null);
    setError(null);
  }, []);

  /// Add the typed address. The host does the adding — it checks the
  /// address and dials it, and whatever question that raised is asked by
  /// the app-wide trust dialog. Only two things are decided here: that
  /// the text looks like an address at all, and that the list does not
  /// already have it.
  const add = useCallback(async () => {
    const shape = addressShapeError(typed);
    if (shape !== null) {
      setAddError(shape);
      setAddNote(null);
      return;
    }
    const key = serverKey(typed.trim());
    if (servers.some((r) => r.address === key)) {
      setAddError(null);
      setAddNote(`${key} is already in the list.`);
      setHighlight(key);
      return;
    }
    setBusy(key);
    try {
      const added = await invoke<string>("add_server", { address: key });
      setAddError(null);
      setAddNote(null);
      setTyped("");
      setAdding(false);
      // Points at the row if the dial went through with no question —
      // a loopback proxy, which the host records as manual. An address
      // that raised one has no row until the identity is accepted.
      setHighlight(added);
      // Typing an address and pressing Add is direct user input, so
      // whatever it raised is a question the user is waiting on.
      await raiseServerTrust(added);
    } catch (err) {
      setAddError(String(err));
      setAddNote(null);
    }
    setBusy(null);
  }, [servers, typed]);

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
        <span className="chip-field servers-search" title="search servers">
          <Icon name="search" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search"
            aria-label="search servers"
          />
        </span>
        <ChipButton
          icon="plus"
          label="Server"
          ariaLabel="Add Server"
          title="Add a server this machine cannot hear advertising — one on another subnet, or one started --no-mdns."
          pressed={adding}
          onPress={() => {
            setAdding((prev) => !prev);
            setAddError(null);
            setAddNote(null);
          }}
        />
      </div>
      {adding && (
        <form
          className="servers-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            type="text"
            value={typed}
            autoFocus
            placeholder="host:port"
            aria-label="server address"
            onChange={(e) => setTyped(e.target.value)}
          />
          <button type="submit" aria-label="add this server" disabled={busy !== null}>
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setTyped("");
              setAddError(null);
              setAddNote(null);
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {addError !== null && <p className="servers-error">{addError}</p>}
      {addNote !== null && (
        <p className="servers-notice" role="status">
          {addNote}
        </p>
      )}
      {notice !== null && (
        <p
          className={`servers-notice${browse.state === "running" || browse.state === "starting" ? "" : " servers-notice-warn"}`}
          role="status"
        >
          {notice}
        </p>
      )}
      {error !== null && <p className="servers-error">{error}</p>}
      {note !== null && (
        <p className="servers-notice" role="status">
          {note}
        </p>
      )}
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
              highlighted={highlight === row.address}
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
              onForget={() =>
                void run(row.address, async () => {
                  await forgetServer(row.address);
                  setNote(nothingStoredNote(row));
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/// What a row's trust affordance is called. A row the host is already
/// waiting on is *reviewed* — the question exists and is being looked
/// at again — while one it has never asked about is *trusted*, which
/// dials to find out what to ask.
function trustActionLabel(prompt: TrustPrompt | null): string {
  if (prompt === null) return "Trust…";
  switch (prompt.kind) {
    case "identityChanged":
      return "Review identity…";
    case "tokenRefused":
      return "Review token…";
    default:
      return "Review…";
  }
}

/// The token cell — the row's indicator for a credential the server
/// stopped accepting. The host's trust state cannot carry that (the pin
/// is still good), so the question it is waiting on is what says so,
/// and it says it where the token is.
function tokenLabel(row: ServerRow): string {
  if (row.prompt?.kind === "tokenRefused") return "token refused";
  return row.hasToken ? "token stored" : "no token";
}

interface ServerRowViewProps {
  row: ServerRow;
  busy: boolean;
  /// The last add pointed at this row — either it was just added, or it
  /// was already here and the panel is saying so rather than adding it
  /// a second time.
  highlighted: boolean;
  tokenOpen: boolean;
  onTrust: () => void;
  onToggleToken: () => void;
  onSaveToken: (token: string) => void;
  onForget: () => void;
}

function ServerRowView({
  row,
  busy,
  highlighted,
  tokenOpen,
  onTrust,
  onToggleToken,
  onSaveToken,
  onForget,
}: ServerRowViewProps) {
  const [token, setToken] = useState("");
  // Whether the trust store holds anything for this row. It decides
  // wording, never whether an action is offered: a row the user can see
  // is a row the user can act on, and a store that happens to be empty
  // for it is an answer the action gives, not a reason to withhold the
  // action.
  const credentials = row.fingerprint !== null || row.hasToken || row.insecure;
  const stored = credentials || row.manual;
  return (
    <div
      className={`server-row${row.online ? "" : " offline"}${highlighted ? " highlight" : ""}`}
    >
      <span className={`server-badge ${row.trust}`}>{trustLabel(row)}</span>
      <span className="server-name">{row.name ?? "not advertising"}</span>
      <span className="server-host">{row.host ?? ""}</span>
      <span className="server-address">{row.address}</span>
      <span className="server-version">{row.version ?? ""}</span>
      <span
        className={`server-token${row.prompt?.kind === "tokenRefused" ? " refused" : ""}`}
      >
        {tokenLabel(row)}
      </span>
      <span className="server-actions">
        {(row.trust !== "trusted" || row.prompt !== null) && (
          <button
            type="button"
            className={row.trust === "fingerprintChanged" ? "danger" : undefined}
            disabled={busy}
            aria-label={`${row.prompt === null ? "trust" : "review"} ${row.address}`}
            title={
              row.prompt === null
                ? "Connect to this server and show the certificate it presents, to compare against the one it printed."
                : "Look again at the question this server's last connection attempt raised."
            }
            onClick={onTrust}
          >
            {trustActionLabel(row.prompt)}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          aria-label={`set token for ${row.address}`}
          title={
            row.hasToken
              ? "Replace the access token stored for this server. The server prints the current one each time it starts."
              : "Store an access token for this server. The server prints it each time it starts."
          }
          onClick={onToggleToken}
        >
          Token…
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          aria-label={`forget ${row.address}`}
          title={
            credentials
              ? "Forget this server's fingerprint and token. The next connection to it asks again."
              : stored
                ? "Take this address back out of the list. Nothing is stored for it."
                : "Drop whatever is stored for this server. Nothing is, so the panel will say what is keeping the row here."
          }
          onClick={onForget}
        >
          Forget
        </button>
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
