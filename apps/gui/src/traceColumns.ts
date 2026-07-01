/// Per-panel trace-table column model: which columns are shown, in what
/// order, and how wide each is, plus the per-id-view sort. Split out of
/// the panel components so the arithmetic is unit-tested without a DOM.
/// Order, width, and visibility are all user-adjustable (drag a header
/// to reorder; drag its right divider to resize; toggle via the header's
/// right-click menu), and in per-id mode you can click a header to sort
/// by it. [`COLUMN_DEFS`] gives the default order; a saved layout may be
/// any permutation of the columns.

import type { Bus } from "./types";

/// A trace column's stable identity.
export type ColumnKey =
  | "idx"
  | "time"
  | "bus"
  | "dir"
  | "id"
  | "kind"
  | "len"
  | "data"
  | "msg"
  | "rate";

export interface ColumnDef {
  key: ColumnKey;
  /// Header label used in the chronological view.
  label: string;
  /// Header label used in the by-id view, if it differs from `label`.
  /// The `idx` column carries different meanings between views (a
  /// chronological row's position vs. an id's total frame count), so
  /// the header changes to match.
  byIdLabel?: string;
  /// CSS class on the header / cell element (carries colour, alignment).
  className: string;
  /// Default width in px.
  defaultWidth: number;
  /// If true the column flexes to fill leftover horizontal space (down
  /// to its set width); others stay fixed at their width. Exactly one
  /// flex column keeps the table filling the panel without a horizontal
  /// scrollbar in the common case.
  flex?: boolean;
  /// If true the column only makes sense in the per-id view (a single
  /// chronological frame has no "rate") — the chronological view drops it.
  byIdOnly?: boolean;
  /// If true the column starts hidden in a fresh panel (the user can
  /// re-show it via the header's right-click menu).
  defaultHidden?: boolean;
}

/// The columns, in their fixed display order. The chronological view
/// drops the `byIdOnly` ones, keeping the rest in this same order.
export const COLUMN_DEFS: readonly ColumnDef[] = [
  { key: "idx", label: "index", byIdLabel: "count", className: "col-idx", defaultWidth: 64 },
  { key: "time", label: "time (s)", className: "col-time", defaultWidth: 110 },
  { key: "rate", label: "msg/s", className: "col-rate", defaultWidth: 64, byIdOnly: true },
  { key: "bus", label: "bus", className: "col-bus", defaultWidth: 100 },
  { key: "id", label: "id", className: "col-id", defaultWidth: 96 },
  { key: "msg", label: "message", className: "col-msg", defaultWidth: 220 },
  { key: "len", label: "len", className: "col-len", defaultWidth: 44 },
  { key: "data", label: "data", className: "col-data", defaultWidth: 360, flex: true },
  { key: "dir", label: "dir", className: "col-dir", defaultWidth: 40 },
  { key: "kind", label: "type", className: "col-kind", defaultWidth: 110, defaultHidden: true },
];

/// Smallest a column can be dragged to.
export const MIN_COLUMN_WIDTH = 28;

/// User-adjustable state for one column.
export interface ColumnState {
  key: ColumnKey;
  width: number;
  visible: boolean;
}

/// The default per-panel column state: each column at its default
/// width, in canonical order, visible unless flagged `defaultHidden`
/// (currently just `type`).
export function defaultColumns(): ColumnState[] {
  return COLUMN_DEFS.map((d) => ({ key: d.key, width: d.defaultWidth, visible: !d.defaultHidden }));
}

/// Validate a value persisted in a dockview panel's params (or a
/// project file) as column state. It must be the canonical column set
/// — every key present exactly once — but **in any order** (columns are
/// user-reorderable, so a saved permutation is honoured verbatim), each
/// with sane width / visible fields. Anything else (wrong length, a
/// missing / duplicate / unknown key, a corrupt blob) falls back to
/// [`defaultColumns`]. A legacy `"ch"` key is treated as `"bus"` (the
/// column was renamed when wire-level channel display was replaced with
/// the project's bus name); width / visibility / position carry over.
export function columnsFromParams(value: unknown): ColumnState[] {
  if (!Array.isArray(value) || value.length !== COLUMN_DEFS.length) {
    return defaultColumns();
  }
  const canonical = new Set<string>(COLUMN_DEFS.map((d) => d.key));
  const seen = new Set<string>();
  const out: ColumnState[] = [];
  for (const c of value) {
    if (c == null || typeof c !== "object") return defaultColumns();
    const o = c as { key?: unknown; width?: unknown; visible?: unknown };
    if (typeof o.width !== "number" || typeof o.visible !== "boolean") return defaultColumns();
    const key = o.key === "ch" ? "bus" : o.key; // legacy rename
    if (typeof key !== "string" || !canonical.has(key) || seen.has(key)) {
      return defaultColumns();
    }
    seen.add(key);
    out.push({ key: key as ColumnKey, width: o.width, visible: o.visible });
  }
  // Length matches the canonical set and every key is canonical with no
  // duplicates ⇒ exactly a permutation of all columns.
  return out;
}

/// The definition for `key` (label, css class, flex flag).
export function columnDef(key: ColumnKey): ColumnDef {
  const def = COLUMN_DEFS.find((d) => d.key === key);
  if (!def) throw new Error(`unknown trace column: ${key}`);
  return def;
}

/// The currently-visible columns, in display order.
export function visibleColumns(columns: readonly ColumnState[]): ColumnState[] {
  return columns.filter((c) => c.visible);
}

/// The CSS `grid-template-columns` value for the visible columns: each
/// fixed column contributes `<width>px`; the flex column contributes
/// `minmax(<width>px, 1fr)` so it fills leftover space but never
/// shrinks past its set width. Falls back to a single track when
/// nothing is visible.
export function gridTemplateColumns(columns: readonly ColumnState[]): string {
  const visible = visibleColumns(columns);
  if (visible.length === 0) return "1fr";
  return visible
    .map((c) => {
      const w = Math.max(MIN_COLUMN_WIDTH, Math.round(c.width));
      return columnDef(c.key).flex ? `minmax(${w}px, 1fr)` : `${w}px`;
    })
    .join(" ");
}

/// Set one column's width (clamped to [`MIN_COLUMN_WIDTH`]), returning
/// a new array; unknown keys are a no-op.
export function resizeColumn(
  columns: readonly ColumnState[],
  key: ColumnKey,
  width: number,
): ColumnState[] {
  return columns.map((c) =>
    c.key === key ? { ...c, width: Math.max(MIN_COLUMN_WIDTH, Math.round(width)) } : c,
  );
}

/// Toggle one column's visibility, returning a new array — but never
/// hide the last visible column (a table with no columns has nothing
/// to show).
export function toggleColumn(columns: readonly ColumnState[], key: ColumnKey): ColumnState[] {
  const target = columns.find((c) => c.key === key);
  if (!target) return columns.slice();
  if (target.visible && visibleColumns(columns).length === 1) {
    return columns.slice();
  }
  return columns.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c));
}

/// Move `key` so it sits immediately before `beforeKey` in display
/// order, returning a new array. `beforeKey === null` moves it to the
/// end. A no-op (returns a copy) when either key is unknown or the move
/// wouldn't change anything. The full column set is reordered — hidden
/// columns keep their slots; the caller passes visible-neighbour keys to
/// reorder what's on screen.
export function reorderColumn(
  columns: readonly ColumnState[],
  key: ColumnKey,
  beforeKey: ColumnKey | null,
): ColumnState[] {
  if (key === beforeKey) return columns.slice();
  const from = columns.findIndex((c) => c.key === key);
  if (from < 0) return columns.slice();
  const moved = columns[from];
  const rest = columns.filter((_, i) => i !== from);
  if (beforeKey === null) return [...rest, moved];
  const to = rest.findIndex((c) => c.key === beforeKey);
  if (to < 0) return columns.slice();
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
}

// --- bus name lookup ---

/// Bus-id → bus-name lookup. Built once per render from `project.buses`
/// and passed into the row renderers + the sort path so neither has to
/// re-scan the bus list per row.
export type BusLookup = ReadonlyMap<string, string>;

export function busLookup(buses: readonly Bus[]): BusLookup {
  const m = new Map<string, string>();
  for (const b of buses) m.set(b.id, b.name);
  return m;
}

/// Render `bus_id` for a row's "bus" column: the project's bus *name*
/// when known, "unassigned" when null/undefined, or the raw id as a
/// fallback when the id refers to a bus that's been removed from the
/// project (defensive — keeps the trace from going blank on stale data).
export function busDisplayName(
  busId: string | null | undefined,
  lookup: BusLookup,
): string {
  if (busId == null) return "unassigned";
  return lookup.get(busId) ?? busId;
}

// --- per-id-view column sort ---

/// The per-id-view sort: a column + direction, or `null` for the
/// default order (whatever the host returned — by `(bus_id, channel,
/// id)`).
export type SortState = { key: ColumnKey; dir: "asc" | "desc" } | null;

/// The sort a fresh by-id panel opens with — ascending by arbitration
/// id, the most useful default for scanning a bus's message map.
export const DEFAULT_SORT: SortState = { key: "id", dir: "asc" };

/// Clicking a column header cycles: not-sorted-by-it → ascending →
/// descending → not sorted (back to the default order).
export function nextSort(current: SortState, key: ColumnKey): SortState {
  if (current?.key !== key) return { key, dir: "asc" };
  return current.dir === "asc" ? { key, dir: "desc" } : null;
}

// By-id rows are sorted host-side now — the panel sends its `SortState`
// to `fetch_by_id_page`, which orders the whole snapshot before paging
// (ADR 0025), so a paged view sorts globally rather than per-page. The
// former client-side `sortValue` / `compareValues` / `sortRows` live in
// the host's `sort_by_id` (apps/gui/src-tauri/src/lib.rs).
