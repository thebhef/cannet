/// The RBS signals grid's display status and toolbar filters — the RBS
/// analogue of `viewSignalsFilter.ts`, on the same owner-ruled
/// selection model: **nothing selected is no filter; any
/// one selected is just those items; several selected is their
/// union**.
///
/// The one real difference from the views panel: **Out of Range is
/// decided here, not by the host** (grooming resolution — truncation
/// on transmit is correct, so the encoder has nothing to flag; the
/// frontend is where a value is caught before it's ever sent). That
/// makes the *display* status a superset of the host's
/// `RbsSignalStatus`, and — because the full severity order can only
/// be known once Out of Range is folded in — sorting this grid runs
/// client-side over the host's (bounded, single-config) row set rather
/// than being delegated to the host the way `list_view_signals` is.

import type { RbsSignalRow, RbsSignalStatus } from "./types";
import { isOutOfSignalRange } from "./rbsValueClamp";

/// The host's taxonomy plus the frontend-only Out of Range case,
/// slotted into the severity order the grooming names: "Not Encoded /
/// Out of Range / Unknown Value / Override / Default / Muted".
export type RbsSignalDisplayStatus = RbsSignalStatus | "out-of-range";

export const RBS_SIGNAL_STATUSES: readonly RbsSignalDisplayStatus[] = [
  "not-encoded",
  "out-of-range",
  "unknown-value",
  "override",
  "default",
  "muted",
];

/// A row's status as the grid shows it: the host's `status`, upgraded
/// to `"out-of-range"` when it's an applied override whose decoded
/// value sits outside the signal's physical range. Every other status
/// passes through unchanged — Not Encoded/Unknown Value/Default/Muted
/// rows have no user-set numeric value here to be out of range.
export function rbsSignalDisplayStatus(row: RbsSignalRow): RbsSignalDisplayStatus {
  if (row.status === "override" && row.value != null && isOutOfSignalRange(row.value, row)) {
    return "out-of-range";
  }
  return row.status;
}

/// One entry of the bus fly-out: the file's bus key, and how many rows
/// it covers — the buses this config's rows actually sit on.
export interface RbsSignalBusOption {
  key: string;
  count: number;
}

/// Every bus key the given rows reference, ascending — the fly-out's
/// checklist. Unlike the views panel there's no "unbound" sentinel: an
/// RBS row's `busKey` is always the file's own key, resolved or not.
export function rbsSignalBusOptions(rows: readonly RbsSignalRow[]): RbsSignalBusOption[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.busKey, (counts.get(r.busKey) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/// Apply both filters: a row passes when its display status is in
/// `statusFilter` (or nothing is selected) *and* its bus is in
/// `busFilter` (or nothing is selected).
export function applyRbsSignalFilters(
  rows: readonly RbsSignalRow[],
  statusFilter: ReadonlySet<RbsSignalDisplayStatus>,
  busFilter: ReadonlySet<string>,
): RbsSignalRow[] {
  return rows.filter(
    (r) =>
      (statusFilter.size === 0 || statusFilter.has(rbsSignalDisplayStatus(r))) &&
      (busFilter.size === 0 || busFilter.has(r.busKey)),
  );
}

/// Is the status filter exactly the "problem" statuses (everything but
/// Override/Default/Muted)? — what the footer readout's click target
/// toggles to/from.
export const RBS_SIGNAL_PROBLEM_STATUSES: readonly RbsSignalDisplayStatus[] = [
  "not-encoded",
  "out-of-range",
  "unknown-value",
];

export function isRbsProblemFilter(statusFilter: ReadonlySet<RbsSignalDisplayStatus>): boolean {
  return (
    statusFilter.size === RBS_SIGNAL_PROBLEM_STATUSES.length &&
    RBS_SIGNAL_PROBLEM_STATUSES.every((s) => statusFilter.has(s))
  );
}
