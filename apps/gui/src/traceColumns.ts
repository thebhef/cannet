/// Per-panel trace-table column model: which columns are shown, in what
/// order, and how wide each is, plus the per-id-view sort. Split out of
/// the panel components so the arithmetic is unit-tested without a DOM.
/// Order, width, and visibility are all user-adjustable (drag a header
/// to reorder; drag its right divider to resize; toggle via the header's
/// right-click menu), and in per-id mode you can click a header to sort
/// by it. [`COLUMN_DEFS`] gives the default order; a saved layout may be
/// any permutation of the columns.
///
/// The arithmetic is generic over the column-key set (the `*For`
/// functions take the defs): the signal view's table reuses the same
/// model with its own keys (`signalColumns.ts`), while the trace-bound
/// wrappers here keep the original API for the trace views.

import type { Bus } from "./types";

/// A trace column's stable identity.
export type ColumnKey =
  | "idx"
  | "time"
  | "bus"
  | "ecu"
  | "dir"
  | "id"
  | "kind"
  | "len"
  | "data"
  | "msg"
  | "rate";

export interface ColumnDef<K extends string = ColumnKey> {
  key: K;
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
  { key: "ecu", label: "ecu", className: "col-ecu", defaultWidth: 110 },
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
export interface ColumnState<K extends string = ColumnKey> {
  key: K;
  width: number;
  visible: boolean;
}

/// The default per-panel column state for a defs set: each column at
/// its default width, in canonical order, visible unless flagged
/// `defaultHidden`.
export function defaultColumnsFor<K extends string>(
  defs: readonly ColumnDef<K>[],
): ColumnState<K>[] {
  return defs.map((d) => ({ key: d.key, width: d.defaultWidth, visible: !d.defaultHidden }));
}

/// Trace-bound [`defaultColumnsFor`].
export function defaultColumns(): ColumnState[] {
  return defaultColumnsFor(COLUMN_DEFS);
}

/// Validate a value persisted in a dockview panel's params (or a
/// project file) as column state for a defs set: known keys only, each
/// at most once, in **any order** (columns are user-reorderable, so a
/// saved permutation is honoured verbatim), each with sane width /
/// visible fields. Keys the saved layout doesn't mention — a column
/// added to the model after the layout was saved — are filled in at
/// their canonical slot with defaults, so old layouts keep the user's
/// widths/order and still gain new columns. Anything malformed (a
/// duplicate / unknown key, a corrupt blob, more entries than columns
/// exist) falls back to the defaults. `legacy` maps renamed keys
/// (old name → current), carrying width / visibility / position over.
export function columnsFromParamsFor<K extends string>(
  defs: readonly ColumnDef<K>[],
  value: unknown,
  legacy: Record<string, K> = {},
): ColumnState<K>[] {
  if (!Array.isArray(value) || value.length > defs.length) {
    return defaultColumnsFor(defs);
  }
  const canonical = new Set<string>(defs.map((d) => d.key));
  const seen = new Set<string>();
  const out: ColumnState<K>[] = [];
  for (const c of value) {
    if (c == null || typeof c !== "object") return defaultColumnsFor(defs);
    const o = c as { key?: unknown; width?: unknown; visible?: unknown };
    if (typeof o.width !== "number" || typeof o.visible !== "boolean") {
      return defaultColumnsFor(defs);
    }
    const key = typeof o.key === "string" && o.key in legacy ? legacy[o.key] : o.key;
    if (typeof key !== "string" || !canonical.has(key) || seen.has(key)) {
      return defaultColumnsFor(defs);
    }
    seen.add(key);
    out.push({ key: key as K, width: o.width, visible: o.visible });
  }
  // Fill in columns the saved layout predates: insert each after its
  // nearest canonical predecessor that the layout does hold, so a new
  // column lands where a fresh panel would put it.
  defs.forEach((def, defIdx) => {
    if (seen.has(def.key)) return;
    let insertAt = 0;
    for (let i = defIdx - 1; i >= 0; i--) {
      const at = out.findIndex((c) => c.key === defs[i].key);
      if (at >= 0) {
        insertAt = at + 1;
        break;
      }
    }
    out.splice(insertAt, 0, { key: def.key, width: def.defaultWidth, visible: !def.defaultHidden });
    seen.add(def.key);
  });
  return out;
}

/// Trace-bound [`columnsFromParamsFor`]. The legacy `"ch"` key is
/// treated as `"bus"` (the column was renamed when wire-level channel
/// display was replaced with the project's bus name).
export function columnsFromParams(value: unknown): ColumnState[] {
  return columnsFromParamsFor(COLUMN_DEFS, value, { ch: "bus" });
}

/// The definition for `key` in a defs set (label, css class, flex flag).
export function columnDefFor<K extends string>(
  defs: readonly ColumnDef<K>[],
  key: K,
): ColumnDef<K> {
  const def = defs.find((d) => d.key === key);
  if (!def) throw new Error(`unknown column: ${key}`);
  return def;
}

/// Trace-bound [`columnDefFor`].
export function columnDef(key: ColumnKey): ColumnDef {
  return columnDefFor(COLUMN_DEFS, key);
}

/// The currently-visible columns, in display order.
export function visibleColumns<K extends string>(
  columns: readonly ColumnState<K>[],
): ColumnState<K>[] {
  return columns.filter((c) => c.visible);
}

/// The CSS `grid-template-columns` value for the visible columns: each
/// fixed column contributes `<width>px`; the flex column contributes
/// `minmax(<width>px, 1fr)` so it fills leftover space but never
/// shrinks past its set width. Falls back to a single track when
/// nothing is visible.
export function gridTemplateColumnsFor<K extends string>(
  defs: readonly ColumnDef<K>[],
  columns: readonly ColumnState<K>[],
): string {
  const visible = visibleColumns(columns);
  if (visible.length === 0) return "1fr";
  return visible
    .map((c) => {
      const w = Math.max(MIN_COLUMN_WIDTH, Math.round(c.width));
      return columnDefFor(defs, c.key).flex ? `minmax(${w}px, 1fr)` : `${w}px`;
    })
    .join(" ");
}

/// Trace-bound [`gridTemplateColumnsFor`].
export function gridTemplateColumns(columns: readonly ColumnState[]): string {
  return gridTemplateColumnsFor(COLUMN_DEFS, columns);
}

/// Set one column's width (clamped to [`MIN_COLUMN_WIDTH`]), returning
/// a new array; unknown keys are a no-op.
export function resizeColumn<K extends string>(
  columns: readonly ColumnState<K>[],
  key: K,
  width: number,
): ColumnState<K>[] {
  return columns.map((c) =>
    c.key === key ? { ...c, width: Math.max(MIN_COLUMN_WIDTH, Math.round(width)) } : c,
  );
}

/// Toggle one column's visibility, returning a new array — but never
/// hide the last visible column (a table with no columns has nothing
/// to show).
export function toggleColumn<K extends string>(
  columns: readonly ColumnState<K>[],
  key: K,
): ColumnState<K>[] {
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
export function reorderColumn<K extends string>(
  columns: readonly ColumnState<K>[],
  key: K,
  beforeKey: K | null,
): ColumnState<K>[] {
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

/// A column sort: a column + direction, or `null` for the default
/// order (whatever the host returned).
export type SortState<K extends string = ColumnKey> = { key: K; dir: "asc" | "desc" } | null;

/// The sort a fresh by-id panel opens with — ascending by arbitration
/// id, the most useful default for scanning a bus's message map.
export const DEFAULT_SORT: SortState = { key: "id", dir: "asc" };

/// Clicking a column header cycles: not-sorted-by-it → ascending →
/// descending → not sorted (back to the default order).
export function nextSort<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (current?.key !== key) return { key, dir: "asc" };
  return current.dir === "asc" ? { key, dir: "desc" } : null;
}

// Sorted rows come from the host — the panel sends its `SortState`
// to the paged accessor (`fetch_by_id_page` / `fetch_signal_page`),
// which orders the whole snapshot before paging (ADR 0025), so a paged
// view sorts globally rather than per-page. The former client-side
// `sortValue` / `compareValues` / `sortRows` live in the host's
// `sort_by_id` / `signal_snapshot::sort_rows`.
