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
  { key: "start", label: "start", className: "col-lf-start", defaultWidth: 150 },
  { key: "end", label: "end", className: "col-lf-end", defaultWidth: 150 },
  { key: "duration", label: "duration", className: "col-lf-duration", defaultWidth: 75 },
  { key: "messages", label: "messages", className: "col-lf-messages", defaultWidth: 80 },
  { key: "modified", label: "modified", className: "col-lf-modified", defaultWidth: 115 },
  // The per-row Import button. No label: the icon says it, and only
  // closed files render one.
  { key: "action", label: "", className: "col-lf-action", defaultWidth: 32 },
];

export type LogFileColumnState = ColumnState<LogFileColumnKey>;

export function defaultLogFileColumns(): LogFileColumnState[] {
  return defaultColumnsFor(LOG_FILE_COLUMN_DEFS);
}

export function logFileColumnsFromParams(value: unknown): LogFileColumnState[] {
  return columnsFromParamsFor(LOG_FILE_COLUMN_DEFS, value);
}

export function logFileGridTemplateColumns(columns: readonly LogFileColumnState[]): string {
  return gridTemplateColumnsFor(LOG_FILE_COLUMN_DEFS, columns);
}
