/// Per-panel trace-table column model: which columns are shown and how
/// wide each is. Split out of `TraceView.tsx` so the width / visibility
/// arithmetic is unit-tested without a DOM. Column *order* is fixed —
/// it matches the canonical trace layout; only width and visibility are
/// user-adjustable (drag a header divider; toggle in the panel's
/// "columns" menu).

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
