/// The view-signals panel's toolbar filters (task 89): a status-chip
/// filter and a bus fly-out, both on the owner-ruled selection model —
/// **nothing selected is no filter; any one selected is just those
/// items; several selected is the union** — so an empty selection never
/// reads as an empty grid. Pure and DOM-free so the model is
/// unit-testable without mounting the panel; the panel supplies the
/// `<select>`/checkbox affordances.

import type { ViewSignalRow, ViewSignalStatus } from "./types";

/// The status taxonomy in severity order (mirrors the host's
/// `ViewSignalStatus` declaration order, which *is* the severity
/// order — see `view_signals.rs`).
export const VIEW_SIGNAL_STATUSES: readonly ViewSignalStatus[] = [
  "not-decoded",
  "scale",
  "ambiguous",
  "stale",
  "decoded",
];

/// The states where the value a view gets is not the value it asked
/// for — what the attention count sums and what the footer readout's
/// shortcut selects. Mirrors `ViewSignalStatus::needs_attention`.
export const VIEW_SIGNAL_ATTENTION_STATUSES: readonly ViewSignalStatus[] = [
  "not-decoded",
  "scale",
  "ambiguous",
];

/// A stable key for the bus fly-out's checklist and filter set: a
/// row's `busId`, with a sentinel for the (rare) reference bound to no
/// bus — `busId` is never the empty string for a real project bus
/// (they're UUIDs), so it can't collide.
export const UNBOUND_BUS_KEY = "";

export function busFilterKey(busId: string | null): string {
  return busId ?? UNBOUND_BUS_KEY;
}

/// One entry of the bus fly-out: the key to filter on, the label to
/// show, and how many rows it covers — the buses the open views'
/// signals actually sit on, not every project bus (a bus nothing here
/// references would be a dead entry).
export interface ViewSignalBusOption {
  key: string;
  label: string;
  count: number;
}

/// Every bus the given rows reference, in ascending label order — the
/// fly-out's checklist. The unbound sentinel, when present, sorts last
/// (matching `bus_sort_key`'s blanks-last rule on the host).
export function viewSignalBusOptions(rows: readonly ViewSignalRow[]): ViewSignalBusOption[] {
  const byKey = new Map<string, ViewSignalBusOption>();
  for (const r of rows) {
    const key = busFilterKey(r.busId);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, { key, label: r.busName ?? "(no bus)", count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.key === UNBOUND_BUS_KEY) return b.key === UNBOUND_BUS_KEY ? 0 : 1;
    if (b.key === UNBOUND_BUS_KEY) return -1;
    return a.label.localeCompare(b.label);
  });
}

/// Apply both filters: a row passes when its status is in
/// `statusFilter` (or nothing is selected) *and* its bus is in
/// `busFilter` (or nothing is selected). The two filters AND together;
/// each filter alone ORs its selection.
export function applyViewSignalFilters(
  rows: readonly ViewSignalRow[],
  statusFilter: ReadonlySet<ViewSignalStatus>,
  busFilter: ReadonlySet<string>,
): ViewSignalRow[] {
  return rows.filter(
    (r) =>
      (statusFilter.size === 0 || statusFilter.has(r.status)) &&
      (busFilter.size === 0 || busFilter.has(busFilterKey(r.busId))),
  );
}

/// Is the status filter exactly the attention set (in either order)? —
/// what the footer readout's click target toggles to/from, and what
/// its label reads while active.
export function isAttentionFilter(statusFilter: ReadonlySet<ViewSignalStatus>): boolean {
  return (
    statusFilter.size === VIEW_SIGNAL_ATTENTION_STATUSES.length &&
    VIEW_SIGNAL_ATTENTION_STATUSES.every((s) => statusFilter.has(s))
  );
}
