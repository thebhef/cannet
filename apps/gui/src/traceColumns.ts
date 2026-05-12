/// Per-panel trace-table column model: which columns are shown and how
/// wide each is, plus the per-id-view sort. Split out of the panel
/// components so the arithmetic is unit-tested without a DOM. Column
/// *order* is fixed — it matches the canonical trace layout; width and
/// visibility are user-adjustable (drag a header divider; toggle via the
/// header's right-click menu), and in per-id mode you can click a
/// header to sort by it.

import type { TraceFrameRecord } from "./types";

/// A trace column's stable identity.
export type ColumnKey =
  | "idx"
  | "time"
  | "ch"
  | "dir"
  | "id"
  | "kind"
  | "len"
  | "data"
  | "msg";

export interface ColumnDef {
  key: ColumnKey;
  /// Header label.
  label: string;
  /// CSS class on the header / cell element (carries colour, alignment).
  className: string;
  /// Default width in px.
  defaultWidth: number;
  /// If true the column flexes to fill leftover horizontal space (down
  /// to its set width); others stay fixed at their width. Exactly one
  /// flex column keeps the table filling the panel without a horizontal
  /// scrollbar in the common case.
  flex?: boolean;
}

/// The columns, in their fixed display order.
export const COLUMN_DEFS: readonly ColumnDef[] = [
  { key: "idx", label: "#", className: "col-idx", defaultWidth: 64 },
  { key: "time", label: "time (s)", className: "col-time", defaultWidth: 110 },
  { key: "ch", label: "ch", className: "col-ch", defaultWidth: 40 },
  { key: "dir", label: "dir", className: "col-dir", defaultWidth: 40 },
  { key: "id", label: "id", className: "col-id", defaultWidth: 96 },
  { key: "kind", label: "type", className: "col-kind", defaultWidth: 110 },
  { key: "len", label: "len", className: "col-len", defaultWidth: 44 },
  { key: "data", label: "data", className: "col-data", defaultWidth: 360, flex: true },
  { key: "msg", label: "message", className: "col-msg", defaultWidth: 220 },
];

/// Smallest a column can be dragged to.
export const MIN_COLUMN_WIDTH = 28;

/// User-adjustable state for one column.
export interface ColumnState {
  key: ColumnKey;
  width: number;
  visible: boolean;
}

/// The default per-panel column state: every column visible at its
/// default width, in canonical order.
export function defaultColumns(): ColumnState[] {
  return COLUMN_DEFS.map((d) => ({ key: d.key, width: d.defaultWidth, visible: true }));
}

/// Validate a value persisted in a dockview panel's params (or a
/// project file) as column state — it must be the canonical columns,
/// in order, with sane width / visible fields. Anything else (a stale
/// or corrupt blob) falls back to [`defaultColumns`].
export function columnsFromParams(value: unknown): ColumnState[] {
  if (
    Array.isArray(value) &&
    value.length === COLUMN_DEFS.length &&
    value.every(
      (c, i) =>
        c != null &&
        typeof c === "object" &&
        (c as { key?: unknown }).key === COLUMN_DEFS[i].key &&
        typeof (c as { width?: unknown }).width === "number" &&
        typeof (c as { visible?: unknown }).visible === "boolean",
    )
  ) {
    return (value as ColumnState[]).map((c) => ({ ...c }));
  }
  return defaultColumns();
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

// --- per-id-view column sort ---

/// The per-id-view sort: a column + direction, or `null` for the
/// default order (whatever the host returned — by channel/id).
export type SortState = { key: ColumnKey; dir: "asc" | "desc" } | null;

/// Clicking a column header cycles: not-sorted-by-it → ascending →
/// descending → not sorted (back to the default order).
export function nextSort(current: SortState, key: ColumnKey): SortState {
  if (current?.key !== key) return { key, dir: "asc" };
  return current.dir === "asc" ? { key, dir: "desc" } : null;
}

/// The value a row sorts by for a given column — raw fields, so no
/// dependency on the formatters.
function sortValue(row: TraceFrameRecord, key: ColumnKey): number | string | number[] {
  switch (key) {
    case "idx":
      return row.index;
    case "time":
      return row.timestamp_seconds;
    case "ch":
      return row.channel;
    case "dir":
      return row.direction;
    case "id":
      return row.id;
    case "kind":
      return row.kind.kind;
    case "len":
      return row.data.length;
    case "data":
      return row.data;
    case "msg":
      return row.decoded?.name ?? "";
  }
}

function compareValues(a: number | string | number[], b: number | string | number[]): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  }
  return 0;
}

/// A new array of `rows` sorted by `sort` (a stable sort — equal keys
/// keep the host's order). `null` returns `rows` unchanged.
export function sortRows(
  rows: readonly TraceFrameRecord[],
  sort: SortState,
): TraceFrameRecord[] {
  if (!sort) return rows.slice();
  const factor = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      const c = compareValues(sortValue(x.row, sort.key), sortValue(y.row, sort.key));
      return c !== 0 ? c * factor : x.i - y.i;
    })
    .map(({ row }) => row);
}
