/// The signal view's column model: the same defs-parameterized
/// arithmetic as the trace tables (`traceColumns.ts`), bound to the
/// signal-snapshot columns. Headers and value formatting for the
/// shared statistics columns (`count`, `time (s)`, `msg/s`) are
/// identical to the by-id view — only the counted population differs
/// (per-signal mux-matched updates; see `fetch_signal_page`).

import { hostSettings } from "./hostSettings";
import {
  type ColumnDef,
  type ColumnState,
  type SortState,
  columnDefFor,
  columnsFromParamsFor,
  configuredColumnsFor,
  defaultColumnsFor,
  gridTemplateColumnsFor,
} from "./traceColumns";

/// A signal-view column's stable identity. The sort keys travel to the
/// host verbatim (`signal_snapshot::sort_rows`).
export type SignalColumnKey =
  | "bus"
  | "ecu"
  | "msg"
  | "signal"
  | "section"
  | "rate"
  | "time"
  | "count"
  | "value"
  | "unit";

/// The columns, in their fixed display order.
export const SIGNAL_COLUMN_DEFS: readonly ColumnDef<SignalColumnKey>[] = [
  { key: "time", label: "time (s)", className: "col-time", defaultWidth: 110 },
  { key: "count", label: "count", className: "col-idx", defaultWidth: 64, defaultHidden: true },
  { key: "rate", label: "msg/s", className: "col-rate", defaultWidth: 64, defaultHidden: true },
  { key: "bus", label: "bus", className: "col-bus", defaultWidth: 100, defaultHidden: true },
  { key: "ecu", label: "ecu", className: "col-ecu", defaultWidth: 110 },
  { key: "msg", label: "message", className: "col-msg", defaultWidth: 200 },
  { key: "signal", label: "signal", className: "col-signal", defaultWidth: 220 },
  // The section cell is also the move-to-section control. It gets its
  // own fixed-width column rather than riding in the signal cell: that
  // cell is a `draggable` grid item under
  // `.trace-row span { overflow: hidden }`, which clipped the control
  // away behind any signal name long enough to fill 220px.
  { key: "section", label: "section", className: "col-section", defaultWidth: 120 },
  { key: "value", label: "value", className: "col-value", defaultWidth: 260, flex: true },
  { key: "unit", label: "unit", className: "col-unit", defaultWidth: 60 },
];

export type SignalColumnState = ColumnState<SignalColumnKey>;
export type SignalSortState = SortState<SignalColumnKey>;

/// A fresh panel's sort: none — the host's descriptor order
/// `(bus, message id, extended, signal name)`, the canonical-path-ish
/// stable order.
export const DEFAULT_SIGNAL_SORT: SignalSortState = null;

/// The app's built-in signal-table layout.
export function defaultSignalColumns(): SignalColumnState[] {
  return defaultColumnsFor(SIGNAL_COLUMN_DEFS);
}

/// The layout a fresh signal table opens with — `signal_columns` when
/// the user has set one, else the built-in.
export function configuredSignalColumns(): SignalColumnState[] {
  return configuredColumnsFor(SIGNAL_COLUMN_DEFS, hostSettings().signal_columns);
}

export function signalColumnsFromParams(value: unknown): SignalColumnState[] {
  return columnsFromParamsFor(SIGNAL_COLUMN_DEFS, value, {}, configuredSignalColumns());
}

export function signalColumnDef(key: SignalColumnKey): ColumnDef<SignalColumnKey> {
  return columnDefFor(SIGNAL_COLUMN_DEFS, key);
}

export function signalGridTemplateColumns(columns: readonly SignalColumnState[]): string {
  return gridTemplateColumnsFor(SIGNAL_COLUMN_DEFS, columns);
}
