/// The RBS signals grid's column model: the same defs-parameterized
/// arithmetic `viewSignalsColumns.ts` uses
/// (`traceColumns.ts`), bound to `rbs_signal_rows`'s row shape.
///
/// Unlike the views panel, sorting here runs **client-side**
/// (`sortRbsSignalRows`) rather than being delegated to the host: the
/// grid's own severity order depends on Out of Range, which is decided
/// in the frontend (`rbsSignalsFilter.ts`), so there is no host sort
/// key that alone determines row order. The row set this grid ever
/// holds is one `.cannet_rbs` config's fields — bounded the same way
/// the views panel's is, so client-side sort adds no growth-with-
/// capture-length cost `CLAUDE.md`'s paging rule is about.

import type { RbsSignalRow } from "./types";
import {
  type ColumnDef,
  type ColumnState,
  type SortState,
  columnDefFor,
  columnsFromParamsFor,
  defaultColumnsFor,
  gridTemplateColumnsFor,
} from "./traceColumns";
import { RBS_SIGNAL_STATUSES, rbsSignalDisplayStatus } from "./rbsSignalsFilter";

export type RbsSignalColumnKey =
  | "status"
  | "bus"
  | "msg"
  | "signal"
  | "value"
  | "default"
  | "unit"
  | "detail"
  | "remove";

/// Columns with no sort at all — the prototype's own choice: a value
/// cell and a free-text detail have nothing meaningful to order by.
export const RBS_SIGNAL_UNSORTABLE: ReadonlySet<RbsSignalColumnKey> = new Set([
  "value",
  "detail",
  "remove",
]);

export const RBS_SIGNAL_COLUMN_DEFS: readonly ColumnDef<RbsSignalColumnKey>[] = [
  // No label: the chip alone carries the status, same call the view-
  // signals grid makes.
  { key: "status", label: "", className: "col-rs-status", defaultWidth: 40 },
  { key: "bus", label: "bus", className: "col-rs-bus", defaultWidth: 110 },
  { key: "msg", label: "message", className: "col-rs-msg", defaultWidth: 170 },
  { key: "signal", label: "signal", className: "col-rs-signal", defaultWidth: 150 },
  { key: "value", label: "value", className: "col-rs-value", defaultWidth: 150 },
  // Beside the live value, because that is what it explains: the feed
  // collapses the DBC and override layers into one value, so an
  // overridden field's DBC default has nowhere else to show.
  { key: "default", label: "default", className: "col-rs-default", defaultWidth: 110 },
  { key: "unit", label: "unit", className: "col-rs-unit", defaultWidth: 70 },
  { key: "detail", label: "detail", className: "col-rs-detail", defaultWidth: 260, flex: true },
  // The row's removal — its own column rather than a control floating
  // in the detail text (owner ruling 2026-08-30). No label: the trash
  // says it, and only removable rows render one.
  { key: "remove", label: "", className: "col-rs-remove", defaultWidth: 36 },
];

export type RbsSignalColumnState = ColumnState<RbsSignalColumnKey>;
export type RbsSignalSortState = SortState<RbsSignalColumnKey>;

/// A fresh panel's sort — bus by default, sorted the same way the
/// views grid is.
export const DEFAULT_RBS_SIGNAL_SORT: RbsSignalSortState = { key: "bus", dir: "asc" };

export function defaultRbsSignalColumns(): RbsSignalColumnState[] {
  return defaultColumnsFor(RBS_SIGNAL_COLUMN_DEFS);
}

export function rbsSignalColumnsFromParams(value: unknown): RbsSignalColumnState[] {
  return columnsFromParamsFor(RBS_SIGNAL_COLUMN_DEFS, value);
}

export function rbsSignalColumnDef(key: RbsSignalColumnKey): ColumnDef<RbsSignalColumnKey> {
  return columnDefFor(RBS_SIGNAL_COLUMN_DEFS, key);
}

export function rbsSignalGridTemplateColumns(columns: readonly RbsSignalColumnState[]): string {
  return gridTemplateColumnsFor(RBS_SIGNAL_COLUMN_DEFS, columns);
}

/// Order `rows` by one column, client-side (see the module doc for
/// why this grid can't delegate the way the views grid does). Ties
/// fall back to the host's own `(bus, message, signal)` order — a
/// stable sort over an already bus/message/signal-ordered input needs
/// no explicit tie-break to get it.
export function sortRbsSignalRows(
  rows: readonly RbsSignalRow[],
  sort: RbsSignalSortState,
): RbsSignalRow[] {
  if (!sort) return [...rows];
  const { key, dir } = sort;
  const mul = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => mul * compareByColumn(key, a, b));
}

function compareByColumn(key: RbsSignalColumnKey, a: RbsSignalRow, b: RbsSignalRow): number {
  switch (key) {
    case "status": {
      const ra = RBS_SIGNAL_STATUSES.indexOf(rbsSignalDisplayStatus(a));
      const rb = RBS_SIGNAL_STATUSES.indexOf(rbsSignalDisplayStatus(b));
      return ra - rb;
    }
    case "bus":
      return a.busKey.localeCompare(b.busKey);
    case "msg":
      return (a.messageName ?? a.messageKey).localeCompare(b.messageName ?? b.messageKey);
    case "signal":
      return a.signalName.localeCompare(b.signalName);
    case "unit":
      return a.unit.localeCompare(b.unit);
    case "default": {
      // A field the DBC gives no start value sorts after every field
      // that has one, in both directions of the toggle's ascending
      // half — "none" is the absence of a number, not a small one.
      const av = a.defaultValue;
      const bv = b.defaultValue;
      if (av == null || bv == null) return (av == null ? 1 : 0) - (bv == null ? 1 : 0);
      return av - bv;
    }
    case "value":
    case "detail":
    case "remove":
      return 0;
  }
}
