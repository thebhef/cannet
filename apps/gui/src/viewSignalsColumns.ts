/// The view-signals panel's column model (task 89): the same
/// defs-parameterized arithmetic the trace tables and the signal view
/// use (`traceColumns.ts`), bound to `list_view_signals`'s row shape.
/// Sort keys travel to the host verbatim (`view_signals::sort_rows`);
/// `source` and `detail` carry no host sort (there is nothing to order
/// a candidate picker or a free-text detail by), so the panel's own
/// `onSortColumn` no-ops for them the way the signals view's `section`
/// column does.

import {
  type ColumnDef,
  type ColumnState,
  type SortState,
  columnDefFor,
  columnsFromParamsFor,
  defaultColumnsFor,
  gridTemplateColumnsFor,
} from "./traceColumns";

export type ViewSignalColumnKey =
  | "status"
  | "bus"
  | "signal"
  | "msg"
  | "database"
  | "source"
  | "used"
  | "detail";

/// Columns with no host sort — clicking their header is a no-op (the
/// panel's `onSortColumn` checks this before calling `nextSort`).
export const VIEW_SIGNAL_UNSORTABLE: ReadonlySet<ViewSignalColumnKey> = new Set([
  "source",
  "detail",
]);

export const VIEW_SIGNAL_COLUMN_DEFS: readonly ColumnDef<ViewSignalColumnKey>[] = [
  // No label: the chip alone carries the status (the prototype's own
  // choice — a header word would repeat what every cell already says).
  { key: "status", label: "", className: "col-vs-status", defaultWidth: 40 },
  { key: "bus", label: "bus", className: "col-vs-bus", defaultWidth: 110 },
  { key: "signal", label: "signal", className: "col-vs-signal", defaultWidth: 160 },
  { key: "msg", label: "message", className: "col-vs-msg", defaultWidth: 170 },
  { key: "database", label: "database", className: "col-vs-database", defaultWidth: 150 },
  { key: "source", label: "source", className: "col-vs-source", defaultWidth: 190 },
  { key: "used", label: "applies to", className: "col-vs-used", defaultWidth: 150 },
  { key: "detail", label: "detail", className: "col-vs-detail", defaultWidth: 260, flex: true },
];

export type ViewSignalColumnState = ColumnState<ViewSignalColumnKey>;
export type ViewSignalSortState = SortState<ViewSignalColumnKey>;

/// A fresh panel's sort — bus, per the grooming resolution ("sortable,
/// sorted by bus by default").
export const DEFAULT_VIEW_SIGNAL_SORT: ViewSignalSortState = { key: "bus", dir: "asc" };

export function defaultViewSignalColumns(): ViewSignalColumnState[] {
  return defaultColumnsFor(VIEW_SIGNAL_COLUMN_DEFS);
}

export function viewSignalColumnsFromParams(value: unknown): ViewSignalColumnState[] {
  return columnsFromParamsFor(VIEW_SIGNAL_COLUMN_DEFS, value);
}

export function viewSignalColumnDef(key: ViewSignalColumnKey): ColumnDef<ViewSignalColumnKey> {
  return columnDefFor(VIEW_SIGNAL_COLUMN_DEFS, key);
}

export function viewSignalGridTemplateColumns(
  columns: readonly ViewSignalColumnState[],
): string {
  return gridTemplateColumnsFor(VIEW_SIGNAL_COLUMN_DEFS, columns);
}
