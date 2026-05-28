import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Fzf } from "fzf";

import type {
  DbcContentRecord,
  DbcMessageContentRecord,
  DbcSignalContentRecord,
  DbcSignalMux,
} from "./types";
import { useProjectContext } from "./projectContext";
import {
  dedupeSignalRefs,
  fanOutByBus,
  setSignalDragData,
  type DraggableSignalRef,
} from "./dragSignals";

/**
 * Phase 12 DBC discovery panel. Tree-with-fuzzy-search over every
 * loaded DBC's messages and signals — the spatial / search counterpart
 * to the project panel's DBC inventory (ADR 0012 keeps the inventory
 * role on the project panel; this is the discovery role).
 *
 * **Singleton** — same pattern as the project, graph, and
 * system-messages panels. The DBC set lives on the host, so a second
 * instance would have no per-panel differentiation worth carrying.
 * The toolbar button toggles show/focus.
 *
 * The host owns the DBC set; the panel is a pure viewer over
 * [`list_dbc_content`]. Search runs against an
 * [`fzf`](https://github.com/ajitid/fzf-for-js)-backed matcher
 * (technology-inventory.md → fuzzy-search library); the matched set
 * auto-expands ancestors and the rest of the visible tree dims.
 *
 * View-only in this slice — drag sources and multi-select land in the
 * next slice of Phase 12.
 */

interface PanelParams {
  /// Search query the panel was last typing in. Persisted so reopening
  /// the panel from a saved layout restores the same filter.
  filter?: unknown;
  /// Node ids the user has manually expanded (see `nodeId`). Persisted
  /// as an array; loaded back as a Set on mount.
  expanded?: unknown;
  /// Panel-wide "show details" toggle (Phase 12 polish). When `true`,
  /// each message / signal row renders a detail block underneath
  /// showing bit layout, scale, range, mux, attributes, value table,
  /// etc. — every DBC field we have a frontend representation for.
  showDetails?: unknown;
}

function filterFromParams(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function expandedFromParams(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v === "string") out.add(v);
  }
  return out;
}

function showDetailsFromParams(raw: unknown): boolean {
  return typeof raw === "boolean" ? raw : false;
}

/// Stable id for one tree node. The bus-prefix in every node id below
/// the bus root scopes the rest — a DBC under bus-a is a distinct
/// expand-state key from the same DBC under bus-b, so the user's
/// expand/collapse choices per bus group survive a layout save.
///
/// Bus ids: `bus:<bus_id>` for a project bus, `bus:::unassigned` for
/// the orphan group (DBCs scoped to no current bus), and `bus:::all`
/// for the no-buses-configured fallback. The `:::` separator avoids
/// collision with a literal bus id of "unassigned" or "all".
function busNodeId(busId: string): string {
  return `bus:${busId}`;
}
function dbcNodeId(busId: string, path: string): string {
  return `dbc:${busId}::${path}`;
}
function messageNodeId(
  busId: string,
  path: string,
  messageId: number,
  extended: boolean,
): string {
  return `msg:${busId}::${path}::${extended ? "x" : "s"}${messageId}`;
}
function signalNodeId(
  busId: string,
  path: string,
  messageId: number,
  extended: boolean,
  signalName: string,
): string {
  return `sig:${busId}::${path}::${extended ? "x" : "s"}${messageId}::${signalName}`;
}

/// Sentinel bus ids. Real project bus ids are UUIDs, so the `:::`
/// prefix can't collide.
const UNASSIGNED_BUS_ID = ":::unassigned";
const ALL_BUSES_BUS_ID = ":::all";

/// Last path component for display — DBC file paths can get long; the
/// basename is what the user actually recognises. Falls back to the
/// whole path when there's no separator.
function basename(path: string): string {
  const slashed = path.lastIndexOf("/");
  const backed = path.lastIndexOf("\\");
  const cut = Math.max(slashed, backed);
  return cut < 0 ? path : path.slice(cut + 1);
}

/// Concatenated search haystack for one node — every text fragment
/// the phase-12 spec requires we match against, joined with spaces.
/// fzf's matcher then does the fuzzy work over this single string.
///
/// `busPrefix` (when non-empty) is woven in as `${bus}.${msg}.${sig}`
/// so queries like `chassis.BrakeStatus.Speed` (or fzf's abbreviation
/// form `c.BrSt.Sp`, `c.brsps`, etc.) home in on a single (bus, message,
/// signal) triple. Bus-prefix is empty for the sentinel groups
/// ("(All DBCs)", "(Unassigned)") where there's no real bus context.
function messageHaystack(busPrefix: string, m: DbcMessageContentRecord): string {
  const decId = m.messageId.toString(10);
  const hexId = `0x${m.messageId.toString(16).toUpperCase()}`;
  const attrs = m.attributes
    .map((a) => `${a.name}=${a.value}`)
    .join(" ");
  const dotted = busPrefix ? `${busPrefix}.${m.name}` : m.name;
  return `${dotted} ${m.comment} ${decId} ${hexId} ${attrs}`.trim();
}
function signalHaystack(
  busPrefix: string,
  m: DbcMessageContentRecord,
  s: DbcSignalContentRecord,
): string {
  const vals = s.valueTable
    .map((e) => `${e.raw} ${e.label}`)
    .join(" ");
  const attrs = s.attributes.map((a) => `${a.name}=${a.value}`).join(" ");
  const dotted = busPrefix
    ? `${busPrefix}.${m.name}.${s.name}`
    : `${m.name}.${s.name}`;
  // The dotted form is the fzf-target shape — same as the
  // filter-defined plot area target (ADR 0020). Other fields are
  // appended so a query against units / comments / value-table
  // labels / attribute names still hits.
  return `${dotted} ${s.unit} ${s.comment} ${vals} ${attrs}`.trim();
}

/// Bus-name prefix used when building haystacks. Empty for sentinel
/// groups (no real bus context to disambiguate against).
function busSearchPrefix(g: BusGroup): string {
  if (g.busId === ALL_BUSES_BUS_ID || g.busId === UNASSIGNED_BUS_ID) {
    return "";
  }
  return g.label;
}

/// One row the panel renders. Carries `dim` (filter active, not in
/// match set) and `expanded`/`hasChildren` flags so the row renderer
/// is a flat map. The `kind` discriminator picks between the four
/// row layouts; signal / message / dbc rows carry their owning DBC
/// path so the drag handler can resolve per-DBC bus scoping at drag
/// time.
interface RenderRow {
  id: string;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  dim: boolean;
  /// True when this row is in the panel's selection set. Bus and DBC
  /// rows are never selectable (clicking expands/collapses them);
  /// message / signal rows can be selected and dragged.
  selected: boolean;
  kind:
    | { tag: "bus"; busId: string; label: string; unscopedNote: boolean }
    | { tag: "dbc"; path: string; scopeLabel: string | null }
    | { tag: "message"; dbcPath: string; message: DbcMessageContentRecord }
    | {
        tag: "signal";
        dbcPath: string;
        messageId: number;
        extended: boolean;
        messageName: string;
        signal: DbcSignalContentRecord;
      };
}

/// Group [`DbcContentRecord`]s by the bus(es) they apply to. Each
/// project bus gets its own group; an unscoped DBC appears in every
/// bus group (it applies to all buses). DBCs scoped to bus ids no
/// longer in the project fall into an `(Unassigned)` group at the
/// end. When the project has zero buses configured we collapse to a
/// single `(All DBCs)` group so the tree still has a single root
/// pattern.
interface BusGroup {
  busId: string;
  label: string;
  /// `true` when an entry in `dbcs` is unscoped (would otherwise be
  /// invisibly merged into every per-bus group). The DBC row gets a
  /// small "(applies to all buses)" label so the user knows why it's
  /// duplicated across bus groups.
  dbcs: Array<{ dbc: DbcContentRecord; unscoped: boolean }>;
}

function groupByBus(
  content: readonly DbcContentRecord[],
  buses: readonly { id: string; name: string }[],
  dbcBuses: Readonly<Record<string, string[]>>,
): BusGroup[] {
  if (buses.length === 0) {
    // No project buses → collapse to a single "All DBCs" group.
    return [
      {
        busId: ALL_BUSES_BUS_ID,
        label: "All DBCs (no buses configured)",
        dbcs: content.map((d) => ({ dbc: d, unscoped: true })),
      },
    ];
  }
  const knownBusIds = new Set(buses.map((b) => b.id));
  const groups: BusGroup[] = buses.map((b) => ({
    busId: b.id,
    label: b.name || b.id,
    dbcs: [],
  }));
  const groupByBusId = new Map(groups.map((g) => [g.busId, g]));
  const unassigned: BusGroup = {
    busId: UNASSIGNED_BUS_ID,
    label: "(Unassigned — scoped to a bus that's no longer in the project)",
    dbcs: [],
  };
  for (const d of content) {
    const scope = dbcBuses[d.dbcPath] ?? [];
    if (scope.length === 0) {
      // Unscoped: applies to every project bus.
      for (const g of groups) g.dbcs.push({ dbc: d, unscoped: true });
      continue;
    }
    const liveScope = scope.filter((b) => knownBusIds.has(b));
    if (liveScope.length === 0) {
      unassigned.dbcs.push({ dbc: d, unscoped: false });
      continue;
    }
    for (const busId of liveScope) {
      const g = groupByBusId.get(busId);
      if (g) g.dbcs.push({ dbc: d, unscoped: false });
    }
  }
  if (unassigned.dbcs.length > 0) groups.push(unassigned);
  return groups;
}

/// Walk the bus-grouped content tree, applying `effectiveExpanded`
/// (= user's expand state ∪ ancestors-of-matches when filtering),
/// and produce a flat row list ready to render. `matchSet` is the
/// fzf-matched node ids; rows not in it are dimmed (when
/// `filterActive`). `selection` flips rows' `selected` flag for the
/// highlight class.
function buildRows(
  groups: readonly BusGroup[],
  effectiveExpanded: ReadonlySet<string>,
  matchSet: ReadonlySet<string>,
  filterActive: boolean,
  selection: ReadonlySet<string>,
): RenderRow[] {
  const out: RenderRow[] = [];
  for (const g of groups) {
    const bId = busNodeId(g.busId);
    const bExpanded = effectiveExpanded.has(bId);
    out.push({
      id: bId,
      depth: 0,
      expanded: bExpanded,
      hasChildren: g.dbcs.length > 0,
      dim: filterActive && !matchSet.has(bId),
      selected: false,
      kind: {
        tag: "bus",
        busId: g.busId,
        label: g.label,
        unscopedNote: false,
      },
    });
    if (!bExpanded) continue;
    for (const { dbc, unscoped } of g.dbcs) {
      const dId = dbcNodeId(g.busId, dbc.dbcPath);
      const dExpanded = effectiveExpanded.has(dId);
      out.push({
        id: dId,
        depth: 1,
        expanded: dExpanded,
        hasChildren: dbc.messages.length > 0,
        dim: filterActive && !matchSet.has(dId),
        selected: false,
        kind: {
          tag: "dbc",
          path: dbc.dbcPath,
          scopeLabel: unscoped ? "applies to all buses" : null,
        },
      });
      if (!dExpanded) continue;
      for (const m of dbc.messages) {
        const mId = messageNodeId(g.busId, dbc.dbcPath, m.messageId, m.extended);
        const mExpanded = effectiveExpanded.has(mId);
        out.push({
          id: mId,
          depth: 2,
          expanded: mExpanded,
          hasChildren: m.signals.length > 0,
          dim: filterActive && !matchSet.has(mId),
          selected: selection.has(mId),
          kind: { tag: "message", dbcPath: dbc.dbcPath, message: m },
        });
        if (!mExpanded) continue;
        for (const s of m.signals) {
          const sId = signalNodeId(
            g.busId,
            dbc.dbcPath,
            m.messageId,
            m.extended,
            s.name,
          );
          out.push({
            id: sId,
            depth: 3,
            expanded: false,
            hasChildren: false,
            dim: filterActive && !matchSet.has(sId),
            selected: selection.has(sId),
            kind: {
              tag: "signal",
              dbcPath: dbc.dbcPath,
              messageId: m.messageId,
              extended: m.extended,
              messageName: m.name,
              signal: s,
            },
          });
        }
      }
    }
  }
  return out;
}

/// Indexed lookup of every searchable node — one entry per message
/// and per signal. The flat shape lets fzf rank a single list and the
/// result includes both kinds. Used to build the panel's `matchSet`.
interface SearchEntry {
  id: string;
  ancestors: string[];
  haystack: string;
}

function buildSearchIndex(groups: readonly BusGroup[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const g of groups) {
    const bId = busNodeId(g.busId);
    const prefix = busSearchPrefix(g);
    for (const { dbc } of g.dbcs) {
      const dId = dbcNodeId(g.busId, dbc.dbcPath);
      for (const m of dbc.messages) {
        const mId = messageNodeId(g.busId, dbc.dbcPath, m.messageId, m.extended);
        out.push({
          id: mId,
          ancestors: [bId, dId],
          haystack: messageHaystack(prefix, m),
        });
        for (const s of m.signals) {
          out.push({
            id: signalNodeId(g.busId, dbc.dbcPath, m.messageId, m.extended, s.name),
            ancestors: [bId, dId, mId],
            haystack: signalHaystack(prefix, m, s),
          });
        }
      }
    }
  }
  return out;
}

/// Run `query` against `index` via fzf; return `(matched ids,
/// ancestors-of-matches ids)`. The render layer uses the union as
/// "effectively expanded" and the matched set as "not-dim". An empty
/// query short-circuits to empty sets — the caller's
/// `filterActive` flag turns dimming off.
function searchMatches(
  index: readonly SearchEntry[],
  query: string,
): { matchSet: Set<string>; ancestorsOfMatches: Set<string> } {
  const matchSet = new Set<string>();
  const ancestorsOfMatches = new Set<string>();
  if (query.trim() === "" || index.length === 0) {
    return { matchSet, ancestorsOfMatches };
  }
  // fzf's `Fzf` constructor expects to read the haystack off each item
  // — passing the SearchEntry directly with a `selector` keeps the
  // `id` available on the result rows.
  const fzf = new Fzf<readonly SearchEntry[]>(index, {
    selector: (e) => e.haystack,
    casing: "case-insensitive",
  });
  for (const res of fzf.find(query)) {
    matchSet.add(res.item.id);
    for (const a of res.item.ancestors) ancestorsOfMatches.add(a);
  }
  return { matchSet, ancestorsOfMatches };
}

const DEFAULT_EXPANDED_DEPTH_ON_LOAD = 1;

/// Auto-expand every bus group AND its immediate DBC children when
/// the panel first loads content, so the user sees the messages
/// without an extra click. Used once on mount / content-arrival;
/// subsequent toggle clicks override.
function initialExpandedRoots(groups: readonly BusGroup[]): Set<string> {
  const out = new Set<string>();
  if (DEFAULT_EXPANDED_DEPTH_ON_LOAD < 1) return out;
  for (const g of groups) {
    out.add(busNodeId(g.busId));
    for (const { dbc } of g.dbcs) {
      out.add(dbcNodeId(g.busId, dbc.dbcPath));
    }
  }
  return out;
}

/// Resolve a render row to the draggable signals it contributes.
/// For message rows that's every signal in the message; for signal
/// rows it's just the one. Bus fan-out follows `fanOutByBus`: a
/// scoped DBC's signals fan across the scope buses (one ref per
/// scope bus); an unscoped DBC's signals drop as a single
/// `busId: null` ref so the user gets ONE series per signal, not
/// one per project bus (an unscoped DBC is "the user didn't tell us
/// which bus" — fabricating N series would be a surprise). Returns
/// an empty list for DBC rows (those aren't draggable).
function rowToSignalRefs(
  row: RenderRow,
  content: readonly DbcContentRecord[],
  dbcBuses: Readonly<Record<string, string[]>>,
): DraggableSignalRef[] {
  if (row.kind.tag === "bus" || row.kind.tag === "dbc") return [];
  const dbcPath = row.kind.dbcPath;
  const scopedBuses = dbcBuses[dbcPath] ?? [];
  if (row.kind.tag === "signal") {
    const s = row.kind.signal;
    return fanOutByBus(
      {
        messageId: row.kind.messageId,
        extended: row.kind.extended,
        signalName: s.name,
        messageName: row.kind.messageName,
        unit: s.unit,
      },
      scopedBuses,
    );
  }
  // Message row → contribute every signal that belongs to it. Find
  // the message in `content` so the source-order signal list is what
  // the panel rendered.
  const messageKind = row.kind; // narrows to the message arm.
  const dbc = content.find((d) => d.dbcPath === dbcPath);
  const msg = dbc?.messages.find(
    (m) =>
      m.messageId === messageKind.message.messageId &&
      m.extended === messageKind.message.extended,
  );
  if (!msg) return [];
  return msg.signals.flatMap((s) =>
    fanOutByBus(
      {
        messageId: msg.messageId,
        extended: msg.extended,
        signalName: s.name,
        messageName: msg.name,
        unit: s.unit,
      },
      scopedBuses,
    ),
  );
}

/// The set of selectable rows in display order — used by Shift-click
/// range-extend to walk from the anchor to the clicked row. Bus /
/// DBC rows are filtered out because they aren't selectable.
function selectableIdsInOrder(rows: readonly RenderRow[]): string[] {
  return rows
    .filter((r) => r.kind.tag !== "bus" && r.kind.tag !== "dbc")
    .map((r) => r.id);
}

export function DbcPanel(props: IDockviewPanelProps) {
  const { api } = props;
  const params = props.params as PanelParams | undefined;
  const { dbcPaths, dbcBuses, buses } = useProjectContext();

  const [filter, setFilter] = useState<string>(() => filterFromParams(params?.filter));
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    expandedFromParams(params?.expanded),
  );
  const [showDetails, setShowDetails] = useState<boolean>(() =>
    showDetailsFromParams(params?.showDetails),
  );
  const [content, setContent] = useState<DbcContentRecord[]>([]);
  /// Per-panel selection set (panel-local; not persisted in params —
  /// selection is transient discovery state, like a text-input
  /// selection, not a saved layout property).
  const [selection, setSelection] = useState<Set<string>>(new Set());
  /// Anchor for Shift-click range extension. Tracks the row that
  /// started the current selection contour.
  const selectionAnchorRef = useRef<string | null>(null);

  /// Bus-grouped view of the loaded DBC content. Reshapes the host's
  /// flat list into one entry per bus (+ optional Unassigned /
  /// All-DBCs fallback groups). Memoised so a re-render that doesn't
  /// touch `content` / `buses` / `dbcBuses` doesn't rebuild it.
  const busGroups = useMemo(
    () => groupByBus(content, buses, dbcBuses),
    [content, buses, dbcBuses],
  );

  /// Pull a fresh `list_dbc_content` snapshot and slot it in. Used
  /// both for the dependency-driven refresh (project's DBC set
  /// changed) and the event-driven refresh (host's filesystem
  /// watcher saw the file change on disk).
  const refreshContent = useCallback(() => {
    let cancelled = false;
    void invoke<DbcContentRecord[]>("list_dbc_content").then((next) => {
      if (cancelled) return;
      setContent(next);
      // Auto-expand each bus group the first time content arrives
      // if the user has no expand-state of their own. Compute the
      // groups locally — the memoised `busGroups` reflects state
      // from a previous render.
      setExpanded((prev) => {
        if (prev.size > 0) return prev;
        return initialExpandedRoots(groupByBus(next, buses, dbcBuses));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [buses, dbcBuses]);

  // Re-fetch on mount and whenever the loaded-DBC set changes. The
  // project context's `dbcPaths` mirrors the host's set so it's the
  // right dependency for add/remove/reload-via-UI; the explicit
  // `dbc-changed` event below covers the auto-reload-on-file-change
  // path (Phase 12 follow-up: host watches DBC files).
  useEffect(() => refreshContent(), [dbcPaths, refreshContent]);

  // Phase 12 follow-up: when the host's filesystem watcher reports a
  // DBC change, refresh our snapshot so the tree reflects the new
  // content without a manual reload.
  useEffect(() => {
    const unlisten = listen<string>("dbc-changed", () => {
      refreshContent();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshContent]);

  // Persist filter + expanded + showDetails into the dockview panel
  // params so the saved layout round-trips them. Selection
  // deliberately doesn't ride along — it's transient state, like an
  // editor's text caret.
  useEffect(() => {
    api.updateParameters({ filter, expanded: Array.from(expanded), showDetails });
  }, [api, filter, expanded, showDetails]);

  const searchIndex = useMemo(() => buildSearchIndex(busGroups), [busGroups]);
  const { matchSet, ancestorsOfMatches } = useMemo(
    () => searchMatches(searchIndex, filter),
    [searchIndex, filter],
  );
  const filterActive = filter.trim() !== "";
  const effectiveExpanded = useMemo(() => {
    if (!filterActive) return expanded;
    const merged = new Set(expanded);
    for (const a of ancestorsOfMatches) merged.add(a);
    return merged;
  }, [expanded, ancestorsOfMatches, filterActive]);

  const rows = useMemo(
    () => buildRows(busGroups, effectiveExpanded, matchSet, filterActive, selection),
    [busGroups, effectiveExpanded, matchSet, filterActive, selection],
  );

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onRowClick = useCallback(
    (id: string, modifiers: { shift: boolean; meta: boolean }) => {
      if (modifiers.shift) {
        // Range-extend from the anchor (or from `id` itself if no
        // anchor is set) through the clicked row, over the currently
        // visible selectable rows. The anchor is preserved so a
        // subsequent shift-click extends from the same point.
        const orderedIds = selectableIdsInOrder(rows);
        const anchor = selectionAnchorRef.current ?? id;
        const iA = orderedIds.indexOf(anchor);
        const iB = orderedIds.indexOf(id);
        if (iA < 0 || iB < 0) return;
        const [lo, hi] = iA <= iB ? [iA, iB] : [iB, iA];
        setSelection(new Set(orderedIds.slice(lo, hi + 1)));
        return;
      }
      if (modifiers.meta) {
        // Toggle this row's membership; update the anchor to the
        // toggled row so a follow-up shift-click extends from here.
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        selectionAnchorRef.current = id;
        return;
      }
      // Plain click: replace selection with just this row.
      setSelection(new Set([id]));
      selectionAnchorRef.current = id;
    },
    [rows],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, row: RenderRow) => {
      // If the dragged row is itself in the selection, the gesture
      // drags every selected row. Otherwise it drags just this row
      // (matching the file-manager / IDE convention; the panel's
      // visible selection is unchanged so the user can keep it).
      const draggedRows = selection.has(row.id)
        ? rows.filter((r) => selection.has(r.id))
        : [row];
      const refs = dedupeSignalRefs(
        draggedRows.flatMap((r) => rowToSignalRefs(r, content, dbcBuses)),
      );
      if (refs.length === 0) return;
      setSignalDragData(e, refs);
    },
    [selection, rows, content, dbcBuses],
  );

  return (
    <div className="dbc-panel">
      <div className="dbc-panel-toolbar">
        <input
          type="search"
          className="dbc-panel-search"
          placeholder="search messages, signals, comments, attributes…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="search DBC content"
        />
        {filterActive && (
          <span className="dbc-panel-match-count" aria-live="polite">
            {matchSet.size} match{matchSet.size === 1 ? "" : "es"}
          </span>
        )}
        <label className="dbc-panel-details-toggle" title="show bit layout, scale, range, attributes, value table for every signal">
          <input
            type="checkbox"
            checked={showDetails}
            onChange={(e) => setShowDetails(e.target.checked)}
          />
          details
        </label>
      </div>
      <div className="dbc-panel-tree" role="tree">
        {content.length === 0 && (
          <div className="dbc-panel-empty">
            No DBC attached. Add one from the toolbar's <em>Add DBC…</em>.
          </div>
        )}
        {rows.map((row) => (
          <DbcRow
            key={row.id}
            row={row}
            showDetails={showDetails}
            onToggle={toggle}
            onClick={onRowClick}
            onDragStart={handleDragStart}
          />
        ))}
      </div>
    </div>
  );
}

interface DbcRowProps {
  row: RenderRow;
  showDetails: boolean;
  onToggle: (id: string) => void;
  onClick: (id: string, modifiers: { shift: boolean; meta: boolean }) => void;
  onDragStart: (e: React.DragEvent, row: RenderRow) => void;
}

function DbcRow({ row, showDetails, onToggle, onClick, onDragStart }: DbcRowProps) {
  const indent = `${row.depth * 14}px`;
  // Bus / DBC rows: clicking anywhere toggles expand (they aren't
  // selectable). Message / signal rows: row body selects, chevron
  // toggles expand separately. A draggable row carries the drag-
  // source handlers.
  const isContainerRow = row.kind.tag === "bus" || row.kind.tag === "dbc";
  const selectable = !isContainerRow;
  const draggable = !isContainerRow;
  const baseClass = [
    "dbc-row",
    `dbc-row-${row.kind.tag}`,
    row.dim ? "dbc-row-dim" : "",
    row.selected ? "dbc-row-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const onRowClick = (e: React.MouseEvent) => {
    if (isContainerRow) {
      if (row.hasChildren) onToggle(row.id);
      return;
    }
    onClick(row.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
  };
  const onChevronClick = (e: React.MouseEvent) => {
    if (!row.hasChildren) return;
    e.stopPropagation();
    onToggle(row.id);
  };
  // The details block sits below the row at the same indent + 14 px
  // (so it's visually associated with the row's content column).
  const detailIndent = `${row.depth * 14 + 14}px`;
  return (
    <>
      <div
        className={baseClass}
        role="treeitem"
        aria-selected={selectable ? row.selected : undefined}
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        aria-level={row.depth + 1}
        style={{ paddingLeft: indent }}
        onClick={onRowClick}
        draggable={draggable}
        onDragStart={draggable ? (e) => onDragStart(e, row) : undefined}
      >
        <span
          className="dbc-row-chevron"
          aria-hidden="true"
          onClick={onChevronClick}
        >
          {row.hasChildren ? (row.expanded ? "▼" : "▶") : ""}
        </span>
        <DbcRowContent kind={row.kind} />
      </div>
      {showDetails && row.kind.tag === "message" && (
        <MessageDetails message={row.kind.message} indent={detailIndent} />
      )}
      {showDetails && row.kind.tag === "signal" && (
        <SignalDetails signal={row.kind.signal} indent={detailIndent} />
      )}
    </>
  );
}

/// Compact human-readable summary of a signal's bit-layout. Mirrors
/// what a DBC editor would show on the signal line: start bit + size,
/// byte order, signedness, float kind.
function formatBitLayout(s: DbcSignalContentRecord): string {
  const order = s.byteOrder === "little" ? "@1" : "@0";
  const sign = s.signed ? "-" : "+";
  const endBit = s.startBit + s.length - 1;
  const float = s.floatKind === "integer" ? "" : ` · ${s.floatKind}`;
  return `bits ${s.startBit}–${endBit} (${s.length})${order}${sign}${float}`;
}

/// `physical = raw * factor + offset`, formatted for display. We
/// preserve the DBC's literal `(factor,offset)` shape so the text is
/// recognisable to anyone reading the DBC source.
function formatScale(s: DbcSignalContentRecord): string {
  return `(${s.factor}, ${s.offset})`;
}

/// `[min, max]` physical range. DBCs frequently declare `[0|0]` to
/// mean "no constraint" — surface that explicitly rather than
/// printing the literal `[0, 0]` which would mislead a reader.
function formatRange(s: DbcSignalContentRecord): string {
  if (s.min === s.max) return "[no range]";
  return `[${s.min}, ${s.max}]${s.unit ? ` ${s.unit}` : ""}`;
}

/// Mux indicator as a short label — `mux`, `m<N>`, `m<N>M`, or empty
/// for plain signals.
function formatMux(mux: DbcSignalMux): string {
  switch (mux.kind) {
    case "plain":
      return "";
    case "multiplexor":
      return "mux switch (M)";
    case "multiplexed":
      return `mux arm m${mux.selector}`;
    case "multiplexor_and_multiplexed":
      return `extended mux m${mux.selector}M`;
  }
}

interface SignalDetailsProps {
  signal: DbcSignalContentRecord;
  indent: string;
}

function SignalDetails({ signal, indent }: SignalDetailsProps) {
  const mux = formatMux(signal.mux);
  return (
    <div className="dbc-row-details" style={{ paddingLeft: indent }}>
      <dl className="dbc-details-grid">
        <dt>layout</dt>
        <dd>{formatBitLayout(signal)}</dd>
        <dt>scale</dt>
        <dd>{formatScale(signal)}</dd>
        <dt>range</dt>
        <dd>{formatRange(signal)}</dd>
        {mux && (
          <>
            <dt>mux</dt>
            <dd>{mux}</dd>
          </>
        )}
        {signal.attributes.length > 0 && (
          <>
            <dt>attrs</dt>
            <dd>
              {signal.attributes.map((a) => (
                <span key={a.name} className="dbc-details-attr">
                  {a.name}=<em>{a.value}</em>
                </span>
              ))}
            </dd>
          </>
        )}
        {signal.valueTable.length > 0 && (
          <>
            <dt>values</dt>
            <dd>
              {signal.valueTable.map((v) => (
                <span key={v.raw} className="dbc-details-value">
                  {v.raw}={v.label}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

interface MessageDetailsProps {
  message: DbcMessageContentRecord;
  indent: string;
}

function MessageDetails({ message, indent }: MessageDetailsProps) {
  const decId = message.messageId.toString(10);
  const hexId = `0x${message.messageId.toString(16).toUpperCase()}${
    message.extended ? "x" : ""
  }`;
  return (
    <div className="dbc-row-details" style={{ paddingLeft: indent }}>
      <dl className="dbc-details-grid">
        <dt>id</dt>
        <dd>
          {hexId} <span className="dbc-details-aside">({decId})</span>
        </dd>
        <dt>length</dt>
        <dd>
          {message.expectedLen} B{message.isFd ? " · FD" : ""}
          {message.isFd && message.brs ? " · BRS" : ""}
        </dd>
        {message.usesExtendedMux && (
          <>
            <dt>mux</dt>
            <dd>extended (m&lt;N&gt;M) — bytes-only in TX</dd>
          </>
        )}
        {message.attributes.length > 0 && (
          <>
            <dt>attrs</dt>
            <dd>
              {message.attributes.map((a) => (
                <span key={a.name} className="dbc-details-attr">
                  {a.name}=<em>{a.value}</em>
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function DbcRowContent({ kind }: { kind: RenderRow["kind"] }) {
  if (kind.tag === "bus") {
    return <span className="dbc-row-label">{kind.label}</span>;
  }
  if (kind.tag === "dbc") {
    return (
      <>
        <span className="dbc-row-label" title={kind.path}>
          {basename(kind.path)}
        </span>
        {kind.scopeLabel && (
          <span className="dbc-row-meta dbc-row-scope">{kind.scopeLabel}</span>
        )}
      </>
    );
  }
  if (kind.tag === "message") {
    const m = kind.message;
    const idLabel = `0x${m.messageId.toString(16).toUpperCase()}${
      m.extended ? "x" : ""
    }`;
    return (
      <>
        <span className="dbc-row-label">{m.name}</span>
        <span className="dbc-row-meta">{idLabel}</span>
        {m.comment && <span className="dbc-row-comment">{m.comment}</span>}
      </>
    );
  }
  const s = kind.signal;
  return (
    <>
      <span className="dbc-row-label">{s.name}</span>
      {s.unit && <span className="dbc-row-meta">[{s.unit}]</span>}
      {s.comment && <span className="dbc-row-comment">{s.comment}</span>}
    </>
  );
}
