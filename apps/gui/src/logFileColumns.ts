/// The logger file gridview's column model: the shared
/// defs-parameterized arithmetic (`traceColumns.ts`) bound to the
/// folder listing's row shape, so these columns resize, reorder and
/// show/hide exactly the way every other gridview's do (ADR 0044).

import {
  type ColumnDef,
  type ColumnState,
  columnsFromParamsFor,
  defaultColumnsFor,
  gridTemplateColumnsFor,
} from "./traceColumns";

export type LogFileColumnKey =
  | "name"
  | "size"
  | "start"
  | "end"
  | "duration"
  | "messages"
  | "modified"
  | "action";

export const LOG_FILE_COLUMN_DEFS: readonly ColumnDef<LogFileColumnKey>[] = [
  { key: "name", label: "name", className: "col-lf-name", defaultWidth: 180, flex: true },
  { key: "size", label: "size", className: "col-lf-size", defaultWidth: 70 },
  { key: "duration", label: "duration", className: "col-lf-duration", defaultWidth: 75 },
  // The per-row Import button. No label: the icon says it, and only
  // closed files render one. 40px clears the button's own footprint —
  // its 14px icon, 0.3rem side padding and 1px border (`.logger-file-
  // import-btn` in index.css) — plus the row's 0.5rem right padding
  // every cell carries (`.logger-file-row > span`); the previous 32px
  // clipped it (owner feedback, 2026-09-23).
  { key: "action", label: "", className: "col-lf-action", defaultWidth: 40 },
  { key: "start", label: "start", className: "col-lf-start", defaultWidth: 150 },
  { key: "end", label: "end", className: "col-lf-end", defaultWidth: 150 },
  { key: "messages", label: "messages", className: "col-lf-messages", defaultWidth: 80 },
  { key: "modified", label: "modified", className: "col-lf-modified", defaultWidth: 115 },
];

export type LogFileColumnState = ColumnState<LogFileColumnKey>;

export function defaultLogFileColumns(): LogFileColumnState[] {
  return defaultColumnsFor(LOG_FILE_COLUMN_DEFS);
}

/// The column order this module shipped with before the owner asked for
/// name/size/duration/buttons/start/end (2026-09-23) — kept only to
/// recognise a persisted layout that is exactly that untouched built-in,
/// so it can move to the new order. A layout the user actually
/// reordered never matches this and keeps whatever order they gave it.
const PREVIOUS_DEFAULT_ORDER: readonly LogFileColumnKey[] = [
  "name",
  "size",
  "start",
  "end",
  "duration",
  "messages",
  "modified",
  "action",
];

function matchesKeyOrder(
  columns: readonly LogFileColumnState[],
  order: readonly LogFileColumnKey[],
): boolean {
  return columns.length === order.length && columns.every((c, i) => c.key === order[i]);
}

export function logFileColumnsFromParams(value: unknown): LogFileColumnState[] {
  const parsed = columnsFromParamsFor(LOG_FILE_COLUMN_DEFS, value);
  if (!matchesKeyOrder(parsed, PREVIOUS_DEFAULT_ORDER)) return parsed;
  // An untouched previous-default layout: carry each column's own
  // width/visibility over (in case the user resized one without ever
  // reordering), just in the new default order.
  const byKey = new Map(parsed.map((c) => [c.key, c]));
  return LOG_FILE_COLUMN_DEFS.map((d) => byKey.get(d.key)!);
}

export function logFileGridTemplateColumns(columns: readonly LogFileColumnState[]): string {
  return gridTemplateColumnsFor(LOG_FILE_COLUMN_DEFS, columns);
}
