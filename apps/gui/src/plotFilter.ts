/// Filter-defined plot area helpers (ADR 0020). Kept in
/// their own module so the pure-logic tests can import them without
/// pulling in `PlotPanel.tsx`'s uplot dependency (uplot needs a real
/// canvas, which jsdom doesn't provide).

import type { SignalDescriptorRecord } from "./types";

/// Same colour palette the plot panel uses — duplicated so this
/// module stays import-free of `PlotPanel.tsx`. Keep in sync.
const TRACE_COLORS = [
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#a78bfa",
  "#22d3ee",
  "#fb7185",
  "#facc15",
];

/// Shape the panel renders. Same fields as `PlotPanel.tsx`'s local
/// `SignalRef`. Kept here to avoid a circular import.
export interface FilterSignalRef {
  busId: string | null;
  messageId: number;
  extended: boolean;
  signalName: string;
  messageName: string;
  unit: string;
  color: string;
  hidden?: boolean;
}

/// Shape `applyAreaFilters` accepts. Subset of `PlotPanel`'s
/// `PlotAreaConfig` — anything the helpers need without bringing the
/// renderer along.
export interface FilterableArea {
  id: string;
  signals: FilterSignalRef[];
  signalFilter?: string;
  // Other PlotAreaConfig fields pass through unchanged; the
  // function is generic over them.
}

/// Resolve every catalog signal whose
/// `${busName}.${messageName}.${signalName}` matches `regex` to a
/// coloured `FilterSignalRef[]`. Per ADR 0020: unbound (null-bus)
/// signals render as `(unassigned)` in the prefix; the regex is
/// case-sensitive (JS default).
///
/// Returns `[]` for a syntactically invalid regex — the caller's UI
/// surfaces that as a "bad regex" hint without crashing the panel.
/// `colorOffset` is the area's index in the panel; combined with the
/// match index it produces stable colours across re-evaluations, so
/// a re-loaded DBC that re-adds the same signal keeps its colour.
export function signalsFromFilter(
  regex: string,
  catalog: readonly SignalDescriptorRecord[],
  busNameLookup: ReadonlyMap<string, string>,
  colorOffset: number,
): FilterSignalRef[] {
  let re: RegExp;
  try {
    re = new RegExp(regex);
  } catch {
    return [];
  }
  const out: FilterSignalRef[] = [];
  let matchIdx = 0;
  for (const s of catalog) {
    const busName =
      s.bus_id == null ? "(unassigned)" : busNameLookup.get(s.bus_id) ?? s.bus_id;
    const target = `${busName}.${s.message_name}.${s.signal_name}`;
    if (!re.test(target)) continue;
    out.push({
      busId: s.bus_id,
      messageId: s.message_id,
      extended: s.extended,
      signalName: s.signal_name,
      messageName: s.message_name,
      unit: s.unit,
      color: TRACE_COLORS[(colorOffset + matchIdx) % TRACE_COLORS.length],
    });
    matchIdx += 1;
  }
  return out;
}

/// Apply each area's `signalFilter` (when set) to the catalog,
/// returning the area list the renderer should treat as authoritative.
/// Persisted `signals` on a filter-mode area is left intact in the
/// returned shape — callers that route a drop / add-signal action
/// should consult the original `area.signalFilter` to decide whether
/// to ignore the gesture.
export function applyAreaFilters<A extends FilterableArea>(
  areas: readonly A[],
  catalog: readonly SignalDescriptorRecord[],
  busNameLookup: ReadonlyMap<string, string>,
): A[] {
  return areas.map((a, idx) => {
    if (a.signalFilter == null) return a;
    return {
      ...a,
      signals: signalsFromFilter(a.signalFilter, catalog, busNameLookup, idx * 17),
    };
  });
}
