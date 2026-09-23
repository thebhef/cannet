// The **Connection › Servers** section of the settings view: the one
// place this machine's relationship with every cannet server is managed
// (ADR 0041).
//
// **Server selection and authentication are user-level, not
// per-project.** A server is trusted by this machine, once, in here;
// what a project does with it is a separate question answered on a bus.
// That is why it is a section of the app-global settings view and not a
// form inside a bus row.
//
// A gridview (ADR 0044): one leaf row per server, no branches — there
// is nothing to group `host:port` under — in a bounded row space with
// its own scrollbar, so the settings view's own scroll does not walk
// through it. Modelled on `ProjectCachesList.tsx`: rows as plain
// elements over `arrayRowSpace`, not through the column framework,
// because the settings renderer has nowhere to persist a
// resizable/reorderable column layout and building one would be a
// gesture that forgets itself on every reopen.
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
// - **The section owns no dialog.** A row's affordance raises the one
//   app-wide trust dialog (`ServerTrustDialog.tsx`); a second modal of
//   its own over the same question is impossible by construction.
// - **An address can be added by hand**, because discovery is multicast
//   and a server on another subnet advertises nowhere this machine can
//   hear. "Add server…" is the same act as a row's "Trust…" for an
//   address that has no row yet: the host checks it and dials it, and
//   the question that comes back is put to the user by the app-wide
//   trust dialog. Accepting it is what stores something, which is what
//   makes the row; a question waved away leaves nothing behind, and the
//   address is typed again to retry.

import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import { useInterfaceDiscovery, type DiscoveryState } from "./ConnectionManagement";
import {
  addressShapeError,
  browseNotice,
  incompatibleProtocolNote,
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
import { arrayRowSpace, type GridviewAdapter, type GridviewRow } from "./gridviewRows";
import { ChipButton } from "./ChipButton";
import { Icon } from "./Icon";
import { SettingsShownContext } from "./settingsShown";
import { useGridview } from "./useGridview";
import { useScrollRestore } from "./useScrollRestore";

/// How many rows the bounded row space holds — what PageUp/PageDown
/// move by (`.servers-grid`'s max-height over a row).
const PAGE_ROWS = 6;

export function ServersSection() {
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

  // Watch every server the store can actually reach — a pin or an
  // explicit unprotected choice — so its row shows live interfaces and
  // its connection is exercised (with backoff) while the section is
  // open, instead of failing silently until a bus needs it. Untrusted
  // rows are left alone: a watch would dial them and raise a
  // first-contact question nobody asked for. So is a server that has
  // advertised a protocol major this build does not speak (ADR 0059):
  // the watch would be refused every time, and the row already says
  // why. The host refcounts the watch tasks, so sharing an address
  // with Connection Management is safe in both directions.
  const watchable = useMemo(
    () =>
      servers
        .filter((r) => r.fingerprint !== null || r.insecure)
        .filter((r) => incompatibleProtocolNote(r) === null)
        .map((r) => r.address),
    [servers],
  );
  const discovery = useInterfaceDiscovery(watchable);

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

  // The gridview's row space (ADR 0044): one leaf per server, in the
  // order the host merged them and the search left them. Nothing
  // groups servers, so `isExpanded` never matters and no expanded set
  // is kept.
  const gridRows = useMemo<GridviewRow[]>(
    () => matches.map((r) => ({ id: r.address, kind: "leaf", expandable: false, depth: 0 })),
    [matches],
  );

  const listRef = useRef<HTMLDivElement | null>(null);
  // Read through a ref so the adapter's memo can close over the
  // gridview's row-id helper before `useGridview` has run — the same
  // forward reference the other non-virtualized gridviews use, for the
  // same reason: `scrollToRow` only runs on a later interaction.
  const rowDomIdRef = useRef<(id: string) => string>((id) => id);

  const adapter = useMemo<GridviewAdapter>(() => {
    const space = arrayRowSpace(gridRows, () => false);
    return {
      ...space,
      // The rows are all in the document, so this is the "scroll it
      // just into view" arithmetic the other non-virtualized gridviews
      // use.
      scrollToRow(index) {
        const id = space.rowIdAt(index);
        const container = listRef.current;
        if (id == null || container == null) return;
        const el = document.getElementById(rowDomIdRef.current(id));
        if (el == null) return;
        const c = container.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.top < c.top) container.scrollTop += r.top - c.top;
        else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom;
      },
      setExpanded: () => {
        /* no branches to expand */
      },
      isSelectable: () => true,
    };
  }, [gridRows]);

  const grid = useGridview({ adapter, pageRows: PAGE_ROWS, idPrefix: "servers" });
  rowDomIdRef.current = grid.rowDomId;

  // Puts the row space's own scroll offset back across a settings-panel
  // hide and show — the same mechanism `SettingsPanel.tsx` uses for
  // `.settings-list`, shared rather than duplicated (`useScrollRestore.ts`).
  const shownCount = useContext(SettingsShownContext);
  const onGridScroll = useScrollRestore(listRef, shownCount);

  return (
    <div className="setting-custom servers-section">
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
        <div
          className="servers-grid"
          ref={listRef}
          onScroll={onGridScroll}
          {...grid.containerProps}
        >
          {matches.map((row) => (
            <ServerRowView
              key={row.address}
              row={row}
              domId={grid.rowDomId(row.address)}
              cursor={grid.cursor === row.address}
              selected={grid.selection.has(row.address)}
              onRowClick={(e) => {
                grid.onRowClick(row.address, {
                  mod: e.metaKey || e.ctrlKey,
                  shift: e.shiftKey,
                });
                // Clicking a row hands the grid the keyboard — the
                // container is the only thing in a gridview that holds
                // focus (ADR 0044) — unless the click was aimed at a
                // control that wants it itself.
                const target = e.target as HTMLElement | null;
                if (target?.closest("button") == null && target?.closest("input") == null) {
                  listRef.current?.focus();
                }
              }}
              discovery={discovery.entries[row.address]}
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

/// The row's live-interfaces line. Failures are deliberately not
/// worded here: a terminal one surfaces as the row's trust prompt and
/// badge, and a down server keeps its last snapshot (or "discovering…")
/// rather than flashing transport errors at the section.
function interfacesLabel(state: DiscoveryState): string {
  switch (state.status) {
    case "pending":
      return "interfaces: discovering…";
    case "err":
      return "interfaces: unreachable";
    case "ok":
      return state.interfaces.length === 0
        ? "no interfaces"
        : `interfaces: ${state.interfaces.map((i) => i.display_name).join(", ")}`;
  }
}

interface ServerRowViewProps {
  row: ServerRow;
  /// The gridview's dom id for this row, and where its cursor and
  /// selection currently are (ADR 0044).
  domId: string;
  cursor: boolean;
  selected: boolean;
  onRowClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /// The host's live interface snapshot for this row's address —
  /// present only for a row the section watches (something is stored to
  /// reach it with).
  discovery: DiscoveryState | undefined;
  busy: boolean;
  /// The last add pointed at this row — either it was just added, or it
  /// was already here and the section is saying so rather than adding
  /// it a second time.
  highlighted: boolean;
  tokenOpen: boolean;
  onTrust: () => void;
  onToggleToken: () => void;
  onSaveToken: (token: string) => void;
  onForget: () => void;
}

function ServerRowView({
  row,
  domId,
  cursor,
  selected,
  onRowClick,
  discovery,
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
  // Greyed before anything dials it: the server advertised a protocol
  // major this build does not speak (ADR 0059). Advisory — the host
  // refuses the connection itself — but a row nothing here can use
  // should look that way rather than fail on click.
  const incompatible = incompatibleProtocolNote(row);
  return (
    <div
      id={domId}
      className={`server-row${row.online ? "" : " offline"}${highlighted ? " highlight" : ""}${
        incompatible === null ? "" : " incompatible"
      }${cursor ? " cursor" : ""}${selected ? " selected" : ""}`}
      onClick={onRowClick}
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
                : "Drop whatever is stored for this server. Nothing is, so the row's notice will say what is keeping it here."
          }
          onClick={onForget}
        >
          Forget
        </button>
      </span>
      {incompatible !== null && (
        <span className="server-protocol">{incompatible}</span>
      )}
      {row.fingerprint !== null && (
        <code className="server-fingerprint">{row.fingerprint}</code>
      )}
      {discovery !== undefined && (
        <span className="server-interfaces">{interfacesLabel(discovery)}</span>
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
