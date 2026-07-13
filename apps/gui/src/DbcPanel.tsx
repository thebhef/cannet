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
import type { SignalSnapshotRecord } from "./types";
import { useProjectContext } from "./projectContext";
import { useElementRegistry } from "./projectElements";
import { buildColorResolver, type ColorResolver } from "./colorMap";
import { SignalValueCell } from "./SignalValueCell";
import { signalKey } from "./plotData";
import {
  dedupeSignalRefs,
  setSignalDragData,
  type DraggableSignalRef,
} from "./dragSignals";

/**
 * DBC discovery panel. Tree-with-fuzzy-search over every
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
 * [`list_dbc_content`]. The tree is organised
 * bus → DBC → ECU → message → signal (the ECU level mirrors the RBS
 * panel's per-transmitter grouping). Search runs against an
 * [`fzf`](https://github.com/ajitid/fzf-for-js)-backed matcher; while
 * a filter is active only matches, the paths to them, and expanded
 * children of matches render — everything else is removed, so a
 * filtered render is bounded by the match set however large the
 * database is.
 *
 * Rows are drag sources for signals (see {@link setSignalDragData}),
 * support multi-select, and the whole tree is keyboard-navigable
 * (arrow keys move / expand / collapse, Enter selects).
 */

interface PanelParams {
  /// Search query the panel was last typing in. Persisted so reopening
  /// the panel from a saved layout restores the same filter.
  filter?: unknown;
  /// Node ids the user has manually expanded (see `nodeId`). Persisted
  /// as an array; loaded back as a Set on mount.
  expanded?: unknown;
  /// Panel-wide "show details" toggle. When `true`,
  /// each message / signal row renders a detail block underneath
  /// showing bit layout, scale, range, mux, attributes, value table,
  /// etc. — every DBC field we have a frontend representation for.
  showDetails?: unknown;
}

function filterFromParams(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

export function expandedFromParams(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const v of raw) {
    // Drop legacy ids that embedded the DBC's on-disk path. Node ids are
    // now keyed by index + filename, which never contains a path
    // separator, so such an id matches no current node — and
    // re-persisting it would write a machine-local absolute path back
    // into the project file on the next save.
    if (typeof v === "string" && !/[/\\]/.test(v)) out.add(v);
  }
  return out;
}

function showDetailsFromParams(raw: unknown): boolean {
  return typeof raw === "boolean" ? raw : false;
}

/// Stable, project-local identity for a DBC in the tree: its index in
/// the loaded DBC list plus its filename. The filename is the
/// meaningful handle — rename the file on disk and the project loses
/// the reference anyway — and the index disambiguates two loaded DBCs
/// that happen to share a filename. Deliberately *not* the on-disk
/// path: node ids are persisted into the saved layout's `expanded` set
/// (below), and an absolute path would bake a machine-specific location
/// into the committed project file. The index is stable across a
/// save/load round-trip because the layout and the DBC list live in the
/// same project file and are written together.
export function dbcKey(index: number, path: string): string {
  return `${index}:${basename(path)}`;
}

/// Stable id for one tree node. The bus-prefix in every node id below
/// the bus root scopes the rest — a DBC under bus-a is a distinct
/// expand-state key from the same DBC under bus-b, so the user's
/// expand/collapse choices per bus group survive a layout save. The DBC
/// segment is a `dbcKey`, never a path.
///
/// Bus ids: `bus:<bus_id>` for a project bus, `bus:::unassigned` for
/// the orphan group (DBCs scoped to no current bus), and `bus:::all`
/// for the no-buses-configured fallback. The `:::` separator avoids
/// collision with a literal bus id of "unassigned" or "all".
function busNodeId(busId: string): string {
  return `bus:${busId}`;
}
export function dbcNodeId(busId: string, key: string): string {
  return `dbc:${busId}::${key}`;
}
/// `ecu` is the DBC transmitter name, or the `:::none` sentinel for
/// messages whose `BO_` line carries the `Vector__XXX` placeholder
/// (`:::` can't collide with a real node name).
function ecuNodeId(busId: string, key: string, ecu: string): string {
  return `ecu:${busId}::${key}::${ecu}`;
}
function messageNodeId(
  busId: string,
  key: string,
  messageId: number,
  extended: boolean,
): string {
  return `msg:${busId}::${key}::${extended ? "x" : "s"}${messageId}`;
}
function signalNodeId(
  busId: string,
  key: string,
  messageId: number,
  extended: boolean,
  signalName: string,
): string {
  return `sig:${busId}::${key}::${extended ? "x" : "s"}${messageId}::${signalName}`;
}

/// Sentinel bus ids. Real project bus ids are UUIDs, so the `:::`
/// prefix can't collide.
const UNASSIGNED_BUS_ID = ":::unassigned";
const ALL_BUSES_BUS_ID = ":::all";

/// Sentinel ECU key + display label for messages with no `BO_`
/// transmitter (`Vector__XXX`). The label matches the RBS panel's
/// fallback so the two per-ECU groupings read the same.
const NO_TRANSMITTER_ECU_KEY = ":::none";
const NO_TRANSMITTER_LABEL = "(no transmitter)";

/// One per-transmitter group of a DBC's messages — the ECU tree
/// level. `key` feeds the node id (stable across renames of the
/// display label); `transmitter` is `null` for the no-sender group.
interface EcuGroup {
  key: string;
  label: string;
  transmitter: string | null;
  messages: DbcMessageContentRecord[];
}

/// Group a DBC's host-ordered message list per transmitter ECU,
/// mirroring the RBS panel's grouping. ECUs sort alphabetically
/// (case-insensitive); the "(no transmitter)" group, when present,
/// sorts last. Message order within a group stays the host's
/// `(extended, messageId)` order.
function groupByEcu(messages: readonly DbcMessageContentRecord[]): EcuGroup[] {
  const byEcu = new Map<string, EcuGroup>();
  for (const m of messages) {
    const key = m.transmitter ?? NO_TRANSMITTER_ECU_KEY;
    let g = byEcu.get(key);
    if (!g) {
      g = {
        key,
        label: m.transmitter ?? NO_TRANSMITTER_LABEL,
        transmitter: m.transmitter,
        messages: [],
      };
      byEcu.set(key, g);
    }
    g.messages.push(m);
  }
  return [...byEcu.values()].sort((a, b) => {
    if (a.transmitter === null) return b.transmitter === null ? 0 : 1;
    if (b.transmitter === null) return -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

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
/// The dotted ancestry is woven in as `${bus}.${ecu}.${msg}.${sig}`
/// — the same hierarchy the tree renders — so queries like
/// `chassis.BrakeStatus.Speed`, `bmsstatus` (ECU + message-name
/// fragment), or fzf's abbreviation form (`c.BrSt.Sp`, `c.brsps`)
/// home in on the right node. The ADR-0020 plot-target shape
/// (`bus.msg.sig`) remains a subsequence of this, so target-shaped
/// queries keep working. Bus-prefix is empty for the sentinel groups
/// ("(All DBCs)", "(Unassigned)") where there's no real bus context;
/// the ECU segment is absent for `Vector__XXX` messages.
function messageHaystack(busPrefix: string, m: DbcMessageContentRecord): string {
  const decId = m.messageId.toString(10);
  const hexId = `0x${m.messageId.toString(16).toUpperCase()}`;
  const attrs = m.attributes
    .map((a) => `${a.name}=${a.value}`)
    .join(" ");
  const dotted = [busPrefix, m.transmitter ?? "", m.name]
    .filter((p) => p !== "")
    .join(".");
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
  const dotted = [busPrefix, m.transmitter ?? "", m.name, s.name]
    .filter((p) => p !== "")
    .join(".");
  // Other fields are appended so a query against units / comments /
  // value-table labels / attribute names still hits.
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

/// One row the panel renders. Carries `expanded`/`hasChildren` flags
/// so the row renderer is a flat map. The `kind` discriminator picks
/// between the five row layouts; signal / message / dbc rows carry
/// their owning DBC path so the drag handler can resolve per-DBC bus
/// scoping at drag time. While a filter is active, rows outside the
/// match set (and not on a path to / under a match) are not built at
/// all — hiding is structural, not a style.
interface RenderRow {
  id: string;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  /// True when this row is in the panel's selection set. Bus, DBC,
  /// and ECU rows are never selectable (clicking expands/collapses
  /// them); message / signal rows can be selected and dragged.
  selected: boolean;
  kind:
    | { tag: "bus"; busId: string; label: string; unscopedNote: boolean }
    | { tag: "dbc"; path: string; scopeLabel: string | null }
    | { tag: "ecu"; label: string }
    | {
        tag: "message";
        /// Bus context — set from the bus group this row was
        /// rendered under. `null` for the `(All DBCs)` /
        /// `(Unassigned)` sentinel groups (no real bus context). A
        /// drag from this row produces a `SignalRef` carrying this
        /// `busId`; that's what makes the per-bus tree's visual
        /// position determine the drag destination.
        busId: string | null;
        dbcPath: string;
        message: DbcMessageContentRecord;
      }
    | {
        tag: "signal";
        busId: string | null;
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
  dbcs: Array<{ dbc: DbcContentRecord; unscoped: boolean; key: string }>;
}

export function groupByBus(
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
        dbcs: content.map((d, i) => ({ dbc: d, unscoped: true, key: dbcKey(i, d.dbcPath) })),
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
  for (const [i, d] of content.entries()) {
    const key = dbcKey(i, d.dbcPath);
    const scope = dbcBuses[d.dbcPath] ?? [];
    if (scope.length === 0) {
      // Unscoped: applies to every project bus.
      for (const g of groups) g.dbcs.push({ dbc: d, unscoped: true, key });
      continue;
    }
    const liveScope = scope.filter((b) => knownBusIds.has(b));
    if (liveScope.length === 0) {
      unassigned.dbcs.push({ dbc: d, unscoped: false, key });
      continue;
    }
    for (const busId of liveScope) {
      const g = groupByBusId.get(busId);
      if (g) g.dbcs.push({ dbc: d, unscoped: false, key });
    }
  }
  if (unassigned.dbcs.length > 0) groups.push(unassigned);
  return groups;
}

/// Walk the bus-grouped content tree, applying `effectiveExpanded`
/// (= user's expand state ∪ ancestors-of-matches when filtering),
/// and produce a flat row list ready to render.
///
/// While a filter is active the walk *removes* everything outside the
/// match structure instead of rendering it dimmed: a container (bus /
/// DBC / ECU) renders only when its subtree holds a match
/// (`ancestorsOfMatches`); a message renders when it matched or a
/// signal under it matched; a signal renders when it matched or its
/// message matched (so expanding a matched message still reveals its
/// children). This bounds a filtered render by the match set — the
/// task-33 responsiveness rule.
///
/// `selection` flips rows' `selected` flag for the highlight class.
function buildRows(
  groups: readonly BusGroup[],
  effectiveExpanded: ReadonlySet<string>,
  matchSet: ReadonlySet<string>,
  ancestorsOfMatches: ReadonlySet<string>,
  filterActive: boolean,
  selection: ReadonlySet<string>,
): RenderRow[] {
  const out: RenderRow[] = [];
  for (const g of groups) {
    const bId = busNodeId(g.busId);
    if (filterActive && !ancestorsOfMatches.has(bId)) continue;
    const bExpanded = effectiveExpanded.has(bId);
    // `dragBusId` is what message / signal rows under this group
    // carry as their `busId` — the destination bus a drag from this
    // visual position should produce. Sentinel groups (no real bus)
    // contribute `null` (legacy "any bus" path).
    const dragBusId =
      g.busId === ALL_BUSES_BUS_ID || g.busId === UNASSIGNED_BUS_ID ? null : g.busId;
    out.push({
      id: bId,
      depth: 0,
      expanded: bExpanded,
      hasChildren: g.dbcs.length > 0,
      selected: false,
      kind: {
        tag: "bus",
        busId: g.busId,
        label: g.label,
        unscopedNote: false,
      },
    });
    if (!bExpanded) continue;
    for (const { dbc, unscoped, key } of g.dbcs) {
      const dId = dbcNodeId(g.busId, key);
      if (filterActive && !ancestorsOfMatches.has(dId)) continue;
      const dExpanded = effectiveExpanded.has(dId);
      out.push({
        id: dId,
        depth: 1,
        expanded: dExpanded,
        hasChildren: dbc.messages.length > 0,
        selected: false,
        kind: {
          tag: "dbc",
          path: dbc.dbcPath,
          scopeLabel: unscoped ? "applies to all buses" : null,
        },
      });
      if (!dExpanded) continue;
      for (const ecu of groupByEcu(dbc.messages)) {
        const eId = ecuNodeId(g.busId, key, ecu.key);
        if (filterActive && !ancestorsOfMatches.has(eId)) continue;
        const eExpanded = effectiveExpanded.has(eId);
        out.push({
          id: eId,
          depth: 2,
          expanded: eExpanded,
          hasChildren: ecu.messages.length > 0,
          selected: false,
          kind: { tag: "ecu", label: ecu.label },
        });
        if (!eExpanded) continue;
        for (const m of ecu.messages) {
          const mId = messageNodeId(g.busId, key, m.messageId, m.extended);
          const mMatched = matchSet.has(mId);
          if (filterActive && !mMatched && !ancestorsOfMatches.has(mId)) {
            continue;
          }
          const mExpanded = effectiveExpanded.has(mId);
          out.push({
            id: mId,
            depth: 3,
            expanded: mExpanded,
            hasChildren: m.signals.length > 0,
            selected: selection.has(mId),
            kind: { tag: "message", busId: dragBusId, dbcPath: dbc.dbcPath, message: m },
          });
          if (!mExpanded) continue;
          for (const s of m.signals) {
            const sId = signalNodeId(
              g.busId,
              key,
              m.messageId,
              m.extended,
              s.name,
            );
            // Under a matched message every signal shows (the user
            // explicitly expanded it); under a merely-expanded
            // message only matched signals do.
            if (filterActive && !mMatched && !matchSet.has(sId)) continue;
            out.push({
              id: sId,
              depth: 4,
              expanded: false,
              hasChildren: false,
              selected: selection.has(sId),
              kind: {
                tag: "signal",
                busId: dragBusId,
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

export function buildSearchIndex(groups: readonly BusGroup[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const g of groups) {
    const bId = busNodeId(g.busId);
    const prefix = busSearchPrefix(g);
    for (const { dbc, key } of g.dbcs) {
      const dId = dbcNodeId(g.busId, key);
      for (const m of dbc.messages) {
        const eId = ecuNodeId(
          g.busId,
          key,
          m.transmitter ?? NO_TRANSMITTER_ECU_KEY,
        );
        const mId = messageNodeId(g.busId, key, m.messageId, m.extended);
        out.push({
          id: mId,
          ancestors: [bId, dId, eId],
          haystack: messageHaystack(prefix, m),
        });
        for (const s of m.signals) {
          out.push({
            id: signalNodeId(g.busId, key, m.messageId, m.extended, s.name),
            ancestors: [bId, dId, eId, mId],
            haystack: signalHaystack(prefix, m, s),
          });
        }
      }
    }
  }
  return out;
}

/// Score floor, as a fraction of the best match's score. fzf accepts
/// any subsequence, so on a large database a query like "pressure"
/// also "matches" text where the letters merely appear scattered
/// across word boundaries — and unlike a ranked list, the tree shows
/// every member of the match set with equal prominence. fzf scores
/// contiguous, boundary-aligned matches far above scattered ones
/// (measured on the ev-zonal fixture: literal hits ≥0.8× top, junk
/// ≤0.5×), so a relative floor keeps the real matches — including
/// abbreviation queries, whose score spread is narrow — and drops
/// the noise.
const MIN_RELATIVE_SCORE = 0.7;

/// Run `query` against `index` via fzf; return `(matched ids,
/// ancestors-of-matches ids)`. The render layer shows the matched
/// set plus the paths to it and uses the ancestor set as "effectively
/// expanded". An empty query short-circuits to empty sets — the
/// caller's `filterActive` flag turns hiding off.
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
  const results = fzf.find(query);
  const floor = (results[0]?.score ?? 0) * MIN_RELATIVE_SCORE;
  for (const res of results) {
    // Results arrive score-descending; everything past the floor is
    // scattered-subsequence noise.
    if (res.score < floor) break;
    matchSet.add(res.item.id);
    for (const a of res.item.ancestors) ancestorsOfMatches.add(a);
  }
  return { matchSet, ancestorsOfMatches };
}

/// Auto-expand every bus group, its DBC children, and their ECU
/// groups when the panel first loads content, so the user sees the
/// messages without an extra click (messages themselves stay
/// collapsed — the rendered row count is bounded by the message
/// count, not the signal count). Used once on mount /
/// content-arrival; subsequent toggle clicks override.
function initialExpandedRoots(groups: readonly BusGroup[]): Set<string> {
  const out = new Set<string>();
  for (const g of groups) {
    out.add(busNodeId(g.busId));
    for (const { dbc, key } of g.dbcs) {
      out.add(dbcNodeId(g.busId, key));
      for (const ecu of groupByEcu(dbc.messages)) {
        out.add(ecuNodeId(g.busId, key, ecu.key));
      }
    }
  }
  return out;
}

/// Resolve a render row to the draggable signals it contributes.
/// For message rows that's every signal in the message; for signal
/// rows it's just the one. Returns an empty list for bus / DBC rows
/// (those aren't draggable).
///
/// **Bus context comes from the row's visual position**, not the
/// DBC's `dbcBuses` scoping. With the per-bus tree (slice 6), the
/// same unscoped DBC is rendered under each project bus group; a
/// drag from the bus-a copy of `EngineSpeed` produces a ref with
/// `busId: "bus-a"` even though the DBC is unscoped. This matches
/// what the user expects from the visual layout — they explicitly
/// chose to drag from bus-a's view.
///
/// Sentinel groups ("(All DBCs)", "(Unassigned)") carry `busId:
/// null` on their rows; drag from those produces the legacy
/// "any bus" ref.
function rowToSignalRefs(
  row: RenderRow,
  content: readonly DbcContentRecord[],
): DraggableSignalRef[] {
  if (row.kind.tag === "bus" || row.kind.tag === "dbc" || row.kind.tag === "ecu") {
    return [];
  }
  const busId = row.kind.busId;
  if (row.kind.tag === "signal") {
    const s = row.kind.signal;
    return [
      {
        busId,
        messageId: row.kind.messageId,
        extended: row.kind.extended,
        signalName: s.name,
        messageName: row.kind.messageName,
        unit: s.unit,
      },
    ];
  }
  // Message row → contribute every signal that belongs to it. Find
  // the message in `content` so the source-order signal list is
  // what the panel rendered.
  const messageKind = row.kind; // narrows to the message arm.
  const dbc = content.find((d) => d.dbcPath === messageKind.dbcPath);
  const msg = dbc?.messages.find(
    (m) =>
      m.messageId === messageKind.message.messageId &&
      m.extended === messageKind.message.extended,
  );
  if (!msg) return [];
  return msg.signals.map((s) => ({
    busId,
    messageId: msg.messageId,
    extended: msg.extended,
    signalName: s.name,
    messageName: msg.name,
    unit: s.unit,
  }));
}

/// The set of selectable rows in display order — used by Shift-click
/// range-extend to walk from the anchor to the clicked row. Bus /
/// DBC / ECU rows are filtered out because they aren't selectable.
function selectableIdsInOrder(rows: readonly RenderRow[]): string[] {
  return rows
    .filter((r) => r.kind.tag === "message" || r.kind.tag === "signal")
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
  /// Live value column (Task 20): when on, every rendered signal row
  /// shows its live-latest decoded value via the shared value renderer
  /// (`SignalValueCell`) — the same `fetch_signal_page` rows the signal
  /// view reads, so the two surfaces cannot drift. Live-only: the DBC
  /// panel is a singleton navigator with no trace-window state
  /// (pausing belongs to signal-view elements).
  const [showValues, setShowValues] = useState<boolean>(
    () => (params as { showValues?: unknown } | undefined)?.showValues === true,
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
  // path (the host watches DBC files).
  useEffect(() => refreshContent(), [dbcPaths, refreshContent]);

  // When the host's filesystem watcher reports a
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
    api.updateParameters({ filter, expanded: Array.from(expanded), showDetails, showValues });
  }, [api, filter, expanded, showDetails, showValues]);

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
    () =>
      buildRows(
        busGroups,
        effectiveExpanded,
        matchSet,
        ancestorsOfMatches,
        filterActive,
        selection,
      ),
    [busGroups, effectiveExpanded, matchSet, ancestorsOfMatches, filterActive, selection],
  );

  // --- live value column (Task 20) ---
  const registry = useElementRegistry();
  const resolveColor = useMemo(
    () => buildColorResolver(registry.entries.map((e) => e.element)),
    [registry.entries],
  );
  /// The rendered signal rows' descriptor keys — exactly what the tree
  /// shows (the panel's rows are structurally bounded), refreshed as
  /// expansion / filtering changes.
  const renderedSignalKeys = useMemo(() => {
    if (!showValues) return [];
    return rows
      .filter((r) => r.kind.tag === "signal")
      .map((r) => {
        const k = r.kind as Extract<RenderRow["kind"], { tag: "signal" }>;
        return {
          busId: k.busId,
          messageId: k.messageId,
          extended: k.extended,
          signalName: k.signal.name,
        };
      });
  }, [rows, showValues]);
  const [valuesByKey, setValuesByKey] = useState<ReadonlyMap<string, SignalSnapshotRecord>>(
    new Map(),
  );
  useEffect(() => {
    if (!showValues || renderedSignalKeys.length === 0) {
      setValuesByKey(new Map());
      return;
    }
    let live = true;
    const fetchValues = () => {
      void invoke<{ rows: SignalSnapshotRecord[] }>("fetch_signal_page", {
        selection: { keys: renderedSignalKeys, patterns: [] },
        // Live-latest only: scan to the buffer tip (host clamps).
        scanStart: 0,
        scanEnd: Number.MAX_SAFE_INTEGER,
        sortKey: null,
        sortDir: null,
        busNames: buses.map((b) => [b.id, b.name]),
        projectBuses: buses.map((b) => b.id),
        sourceBuses: null,
        offset: 0,
        limit: renderedSignalKeys.length,
      })
        .then((page) => {
          if (!live) return;
          setValuesByKey(
            new Map(
              page.rows.map((r) => [
                signalKey(r.bus_id, r.message_id, r.extended, r.signal_name),
                r,
              ]),
            ),
          );
        })
        .catch(() => {
          /* best effort — the tree renders without values */
        });
    };
    fetchValues();
    const id = window.setInterval(fetchValues, 500);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [showValues, renderedSignalKeys, buses]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /// Keyboard cursor — the node id the arrow keys operate on. Kept
  /// as an id (not an index) so it survives re-renders; when the row
  /// it points at is filtered/collapsed away, the next arrow press
  /// restarts from the top. View-local, deliberately not persisted.
  const [activeId, setActiveId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  // Keep the keyboard cursor visible while arrowing through a long
  // tree.
  useEffect(() => {
    if (activeId == null) return;
    const el = treeRef.current?.querySelector('[data-active="true"]');
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const onRowClick = useCallback(
    (id: string, modifiers: { shift: boolean; meta: boolean }) => {
      setActiveId(id);
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

  /// Container-row click / chevron click: toggle expansion and move
  /// the keyboard cursor there so arrowing continues from where the
  /// mouse left off.
  const toggleAndActivate = useCallback(
    (id: string) => {
      setActiveId(id);
      toggle(id);
    },
    [toggle],
  );

  /// Arrow-key tree navigation (task 33): Up/Down move the cursor
  /// over the visible rows, Right expands (then steps into the first
  /// child), Left collapses (or walks to the parent), Enter / Space
  /// selects a message / signal row (with the same shift / meta
  /// modifiers as a click) or toggles a container row.
  const onTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (rows.length === 0) return;
      const idx = activeId == null ? -1 : rows.findIndex((r) => r.id === activeId);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveId(rows[Math.min(idx + 1, rows.length - 1)].id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveId(rows[Math.max(idx < 0 ? 0 : idx - 1, 0)].id);
      } else if (e.key === "ArrowRight") {
        if (idx < 0) return;
        e.preventDefault();
        const row = rows[idx];
        if (row.hasChildren && !row.expanded) {
          toggle(row.id);
        } else if (
          row.expanded &&
          idx + 1 < rows.length &&
          rows[idx + 1].depth === row.depth + 1
        ) {
          setActiveId(rows[idx + 1].id);
        }
      } else if (e.key === "ArrowLeft") {
        if (idx < 0) return;
        e.preventDefault();
        const row = rows[idx];
        if (row.hasChildren && row.expanded) {
          toggle(row.id);
        } else {
          for (let i = idx - 1; i >= 0; i -= 1) {
            if (rows[i].depth < row.depth) {
              setActiveId(rows[i].id);
              break;
            }
          }
        }
      } else if (e.key === "Enter" || e.key === " ") {
        if (idx < 0) return;
        e.preventDefault();
        const row = rows[idx];
        if (row.kind.tag === "message" || row.kind.tag === "signal") {
          onRowClick(row.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
        } else if (row.hasChildren) {
          toggle(row.id);
        }
      }
    },
    [rows, activeId, toggle, onRowClick],
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
        draggedRows.flatMap((r) => rowToSignalRefs(r, content)),
      );
      if (refs.length === 0) return;
      setSignalDragData(e, refs);
    },
    [selection, rows, content],
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
        <label className="dbc-panel-details-toggle" title="show each signal's live decoded value (latest frame; mux-aware)">
          <input
            type="checkbox"
            checked={showValues}
            onChange={(e) => setShowValues(e.target.checked)}
          />
          values
        </label>
      </div>
      <div
        ref={treeRef}
        className="dbc-panel-tree"
        role="tree"
        tabIndex={0}
        aria-activedescendant={activeId != null ? domRowId(activeId) : undefined}
        onKeyDown={onTreeKeyDown}
      >
        {content.length === 0 && (
          <div className="dbc-panel-empty">
            No DBC attached. Add one from the toolbar's <em>Add DBC…</em>.
          </div>
        )}
        {rows.map((row) => (
          <DbcRow
            key={row.id}
            row={row}
            active={row.id === activeId}
            showDetails={showDetails}
            value={
              showValues && row.kind.tag === "signal"
                ? valuesByKey.get(
                    signalKey(
                      row.kind.busId,
                      row.kind.messageId,
                      row.kind.extended,
                      row.kind.signal.name,
                    ),
                  ) ?? null
                : undefined
            }
            resolveColor={resolveColor}
            onToggle={toggleAndActivate}
            onClick={onRowClick}
            onDragStart={handleDragStart}
          />
        ))}
      </div>
    </div>
  );
}

/// DOM id for one tree row — what `aria-activedescendant` points at.
/// Node ids can carry arbitrary text (DBC paths, bus labels), so
/// URI-encode to keep the id whitespace-free.
function domRowId(nodeId: string): string {
  return `dbcnode-${encodeURIComponent(nodeId)}`;
}

interface DbcRowProps {
  row: RenderRow;
  active: boolean;
  showDetails: boolean;
  /// The signal row's live snapshot when the value column is on:
  /// a record (render its value), `null` (no update yet — blank), or
  /// `undefined` (column off / not a signal row).
  value?: SignalSnapshotRecord | null;
  resolveColor: ColorResolver | null;
  onToggle: (id: string) => void;
  onClick: (id: string, modifiers: { shift: boolean; meta: boolean }) => void;
  onDragStart: (e: React.DragEvent, row: RenderRow) => void;
}

function DbcRow({ row, active, showDetails, value, resolveColor, onToggle, onClick, onDragStart }: DbcRowProps) {
  const indent = `${row.depth * 14}px`;
  // Bus / DBC / ECU rows: clicking anywhere toggles expand (they
  // aren't selectable). Message / signal rows: row body selects,
  // chevron toggles expand separately. A draggable row carries the
  // drag-source handlers.
  const isContainerRow =
    row.kind.tag === "bus" || row.kind.tag === "dbc" || row.kind.tag === "ecu";
  const selectable = !isContainerRow;
  const draggable = !isContainerRow;
  const baseClass = [
    "dbc-row",
    `dbc-row-${row.kind.tag}`,
    row.selected ? "dbc-row-selected" : "",
    active ? "dbc-row-active" : "",
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
        id={domRowId(row.id)}
        className={baseClass}
        role="treeitem"
        aria-selected={selectable ? row.selected : undefined}
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        aria-level={row.depth + 1}
        data-active={active || undefined}
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
        {value !== undefined && row.kind.tag === "signal" && (
          <span className="dbc-row-value">
            <SignalValueCell
              value={value?.value}
              unit={value?.unit ?? ""}
              label={value?.label}
              target={{
                messageId: row.kind.messageId,
                extended: row.kind.extended,
                signalName: row.kind.signal.name,
                busId: row.kind.busId,
              }}
              resolveColor={resolveColor}
            />
          </span>
        )}
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
  if (kind.tag === "ecu") {
    return <span className="dbc-row-label">{kind.label}</span>;
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
