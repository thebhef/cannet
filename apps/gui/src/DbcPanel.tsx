import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { Fzf } from "fzf";

import type {
  DbcContentRecord,
  DbcMessageContentRecord,
  DbcSignalContentRecord,
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

/// Stable id for one tree node. The `path` component is the DBC file
/// path the host returned in [`DbcContentRecord.dbcPath`] — stable
/// across reloads of the same file. The id is the React key, the
/// expand-state key, and the parent/ancestor lookup key.
function dbcNodeId(path: string): string {
  return `dbc:${path}`;
}
function messageNodeId(path: string, messageId: number, extended: boolean): string {
  return `msg:${path}::${extended ? "x" : "s"}${messageId}`;
}
function signalNodeId(
  path: string,
  messageId: number,
  extended: boolean,
  signalName: string,
): string {
  return `sig:${path}::${extended ? "x" : "s"}${messageId}::${signalName}`;
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
function messageHaystack(m: DbcMessageContentRecord): string {
  const decId = m.messageId.toString(10);
  const hexId = `0x${m.messageId.toString(16).toUpperCase()}`;
  const attrs = m.attributes
    .map((a) => `${a.name}=${a.value}`)
    .join(" ");
  return `${m.name} ${m.comment} ${decId} ${hexId} ${attrs}`.trim();
}
function signalHaystack(
  m: DbcMessageContentRecord,
  s: DbcSignalContentRecord,
): string {
  const vals = s.valueTable
    .map((e) => `${e.raw} ${e.label}`)
    .join(" ");
  const attrs = s.attributes.map((a) => `${a.name}=${a.value}`).join(" ");
  // Inline the parent message's identity so a query like "EngineData"
  // surfaces every signal under it, not just the message row.
  return `${m.name} ${s.name} ${s.unit} ${s.comment} ${vals} ${attrs}`.trim();
}

/// One row the panel renders. Carries `dim` (filter active, not in
/// match set) and `expanded`/`hasChildren` flags so the row renderer
/// is a flat map. The `kind` discriminator picks between the three
/// row layouts; signal / message rows carry their owning DBC path
/// so the drag handler can resolve per-DBC bus scoping at drag time.
interface RenderRow {
  id: string;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  dim: boolean;
  /// True when this row is in the panel's selection set. DBC rows are
  /// never selectable (clicking expands/collapses them); message /
  /// signal rows can be selected and dragged.
  selected: boolean;
  kind:
    | { tag: "dbc"; path: string }
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

/// Walk the content tree, applying `effectiveExpanded` (= user's
/// expand state ∪ ancestors-of-matches when filtering), and produce
/// a flat row list ready to render. `matchSet` is the fzf-matched
/// node ids; rows not in it are dimmed (when `filterActive`).
/// `selection` flips rows' `selected` flag for the highlight class.
function buildRows(
  content: readonly DbcContentRecord[],
  effectiveExpanded: ReadonlySet<string>,
  matchSet: ReadonlySet<string>,
  filterActive: boolean,
  selection: ReadonlySet<string>,
): RenderRow[] {
  const out: RenderRow[] = [];
  for (const d of content) {
    const dId = dbcNodeId(d.dbcPath);
    const dExpanded = effectiveExpanded.has(dId);
    out.push({
      id: dId,
      depth: 0,
      expanded: dExpanded,
      hasChildren: d.messages.length > 0,
      dim: filterActive && !matchSet.has(dId),
      selected: false,
      kind: { tag: "dbc", path: d.dbcPath },
    });
    if (!dExpanded) continue;
    for (const m of d.messages) {
      const mId = messageNodeId(d.dbcPath, m.messageId, m.extended);
      const mExpanded = effectiveExpanded.has(mId);
      out.push({
        id: mId,
        depth: 1,
        expanded: mExpanded,
        hasChildren: m.signals.length > 0,
        dim: filterActive && !matchSet.has(mId),
        selected: selection.has(mId),
        kind: { tag: "message", dbcPath: d.dbcPath, message: m },
      });
      if (!mExpanded) continue;
      for (const s of m.signals) {
        const sId = signalNodeId(d.dbcPath, m.messageId, m.extended, s.name);
        out.push({
          id: sId,
          depth: 2,
          expanded: false,
          hasChildren: false,
          dim: filterActive && !matchSet.has(sId),
          selected: selection.has(sId),
          kind: {
            tag: "signal",
            dbcPath: d.dbcPath,
            messageId: m.messageId,
            extended: m.extended,
            messageName: m.name,
            signal: s,
          },
        });
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

function buildSearchIndex(content: readonly DbcContentRecord[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const d of content) {
    const dId = dbcNodeId(d.dbcPath);
    for (const m of d.messages) {
      const mId = messageNodeId(d.dbcPath, m.messageId, m.extended);
      out.push({
        id: mId,
        ancestors: [dId],
        haystack: messageHaystack(m),
      });
      for (const s of m.signals) {
        out.push({
          id: signalNodeId(d.dbcPath, m.messageId, m.extended, s.name),
          ancestors: [dId, mId],
          haystack: signalHaystack(m, s),
        });
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

/// Auto-expand every DBC root when the panel first loads content, so
/// the user sees something other than file names. Used once on mount /
/// content-arrival; the user's subsequent toggle clicks override.
function initialExpandedRoots(content: readonly DbcContentRecord[]): Set<string> {
  const out = new Set<string>();
  if (DEFAULT_EXPANDED_DEPTH_ON_LOAD < 1) return out;
  for (const d of content) out.add(dbcNodeId(d.dbcPath));
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
  if (row.kind.tag === "dbc") return [];
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
/// range-extend to walk from the anchor to the clicked row. DBC rows
/// are filtered out because they aren't selectable.
function selectableIdsInOrder(rows: readonly RenderRow[]): string[] {
  return rows.filter((r) => r.kind.tag !== "dbc").map((r) => r.id);
}

export function DbcPanel(props: IDockviewPanelProps) {
  const { api } = props;
  const params = props.params as PanelParams | undefined;
  const { dbcPaths, dbcBuses } = useProjectContext();

  const [filter, setFilter] = useState<string>(() => filterFromParams(params?.filter));
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    expandedFromParams(params?.expanded),
  );
  const [content, setContent] = useState<DbcContentRecord[]>([]);
  /// Per-panel selection set (panel-local; not persisted in params —
  /// selection is transient discovery state, like a text-input
  /// selection, not a saved layout property).
  const [selection, setSelection] = useState<Set<string>>(new Set());
  /// Anchor for Shift-click range extension. Tracks the row that
  /// started the current selection contour.
  const selectionAnchorRef = useRef<string | null>(null);

  // Re-fetch on mount and whenever the loaded-DBC set changes. The
  // project context's `dbcPaths` mirrors the host's set so it's the
  // right dependency without a separate `dbc-changed` event.
  useEffect(() => {
    let cancelled = false;
    void invoke<DbcContentRecord[]>("list_dbc_content").then((next) => {
      if (cancelled) return;
      setContent(next);
      // Auto-expand each DBC root the first time content arrives if
      // the user has no expand-state of their own (a freshly-added
      // panel or one with no saved expansion). Doesn't override a
      // user who has explicitly collapsed everything — only opens
      // roots that have no entry either way.
      setExpanded((prev) => {
        if (prev.size > 0) return prev;
        return initialExpandedRoots(next);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [dbcPaths]);

  // Persist filter + expanded into the dockview panel params so the
  // saved layout round-trips them. Selection deliberately doesn't
  // ride along — it's transient state, like an editor's text caret.
  useEffect(() => {
    api.updateParameters({ filter, expanded: Array.from(expanded) });
  }, [api, filter, expanded]);

  const searchIndex = useMemo(() => buildSearchIndex(content), [content]);
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
    () => buildRows(content, effectiveExpanded, matchSet, filterActive, selection),
    [content, effectiveExpanded, matchSet, filterActive, selection],
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
  onToggle: (id: string) => void;
  onClick: (id: string, modifiers: { shift: boolean; meta: boolean }) => void;
  onDragStart: (e: React.DragEvent, row: RenderRow) => void;
}

function DbcRow({ row, onToggle, onClick, onDragStart }: DbcRowProps) {
  const indent = `${row.depth * 14}px`;
  // DBC root rows: clicking anywhere toggles expand (they aren't
  // selectable). Message / signal rows: row body selects, chevron
  // toggles expand separately. A draggable row carries the drag-
  // source handlers.
  const isDbcRoot = row.kind.tag === "dbc";
  const selectable = !isDbcRoot;
  const draggable = !isDbcRoot;
  const baseClass = [
    "dbc-row",
    `dbc-row-${row.kind.tag}`,
    row.dim ? "dbc-row-dim" : "",
    row.selected ? "dbc-row-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const onRowClick = (e: React.MouseEvent) => {
    if (isDbcRoot) {
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
  return (
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
  );
}

function DbcRowContent({ kind }: { kind: RenderRow["kind"] }) {
  if (kind.tag === "dbc") {
    return (
      <span className="dbc-row-label" title={kind.path}>
        {basename(kind.path)}
      </span>
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
