/// Shared signal-selection model (ADR 0038): manual picks + OR-combined
/// regex patterns evaluated against the canonical signal path
/// `bus/ecu/message/signal`. One implementation drives the plot panel's
/// pattern-defined series and the signal view's selection editor, so
/// the same pattern selects the same signals on every surface (the
/// signal view's own evaluation happens host-side against the same
/// subject — `signal_snapshot.rs`). Kept free of `PlotPanel.tsx`
/// imports so pure-logic tests run without uplot.

import type { SignalDescriptorRecord } from "./types";
import { signalKey } from "./plotData";
import { stableSignalColor } from "./palette";

/// The canonical signal path (ADR 0038). Segments are the DBC names
/// verbatim; a missing bus or transmitter renders an empty segment so
/// segment positions stay fixed for patterns. Mirrors the host's
/// `signal_snapshot::signal_path`.
export function signalPath(
  busName: string | null | undefined,
  transmitter: string | null | undefined,
  messageName: string,
  signalName: string,
): string {
  return `${busName ?? ""}/${transmitter ?? ""}/${messageName}/${signalName}`;
}

/// A catalog entry's canonical path: the bus segment is the project's
/// bus *name* (falling back to the raw id for a bus that's been
/// removed), matching the host's regex subject.
export function catalogPath(
  s: SignalDescriptorRecord,
  busNames: ReadonlyMap<string, string>,
): string {
  const busName = s.bus_id == null ? null : busNames.get(s.bus_id) ?? s.bus_id;
  return signalPath(busName, s.transmitter, s.message_name, s.signal_name);
}

/// One pattern's evaluation against the catalog — what a selection
/// editor renders per row (validity + live match count).
export interface PatternResolution {
  pattern: string;
  /// False when the pattern doesn't compile; `matches` is then empty.
  valid: boolean;
  matches: SignalDescriptorRecord[];
}

/// Evaluate each pattern against every catalog entry's canonical path.
/// Case-sensitive (JS default). An invalid pattern resolves to
/// `valid: false` — surfaced in the editor, never a crash.
export function resolvePatterns(
  patterns: readonly string[],
  catalog: readonly SignalDescriptorRecord[],
  busNames: ReadonlyMap<string, string>,
): PatternResolution[] {
  return patterns.map((pattern) => {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return { pattern, valid: false, matches: [] };
    }
    return {
      pattern,
      valid: true,
      matches: catalog.filter((s) => re.test(catalogPath(s, busNames))),
    };
  });
}

/// Shape the plot panel renders. Same fields as `PlotPanel.tsx`'s local
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

/// Shape `applyAreaSelections` accepts. Subset of `PlotPanel`'s
/// `PlotAreaConfig` — anything the helpers need without bringing the
/// renderer along.
export interface SelectableArea {
  id: string;
  signals: FilterSignalRef[];
  patterns?: string[];
  // Other PlotAreaConfig fields pass through unchanged; the
  // function is generic over them.
}

const refKey = (s: FilterSignalRef) =>
  signalKey(s.busId, s.messageId, s.extended, s.signalName);

/// Resolve `patterns` to coloured refs, deduped across patterns and
/// against `exclude` (the area's manual picks — a manual pick wins, so
/// its colour/hide state is authoritative). Pattern-matched signals get
/// their stable-by-identity wheel colour (`palette.ts`), so a signal
/// keeps its colour across re-evaluations, sorts, and views.
export function signalsFromPatterns(
  patterns: readonly string[],
  catalog: readonly SignalDescriptorRecord[],
  busNames: ReadonlyMap<string, string>,
  exclude: readonly FilterSignalRef[] = [],
): FilterSignalRef[] {
  const seen = new Set(exclude.map(refKey));
  const out: FilterSignalRef[] = [];
  for (const res of resolvePatterns(patterns, catalog, busNames)) {
    for (const s of res.matches) {
      const key = signalKey(s.bus_id, s.message_id, s.extended, s.signal_name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        busId: s.bus_id,
        messageId: s.message_id,
        extended: s.extended,
        signalName: s.signal_name,
        messageName: s.message_name,
        unit: s.unit,
        color: stableSignalColor(key),
      });
    }
  }
  return out;
}

/// Resolve a consumer element's `sources` wiring into the set of bus
/// ids it can see: `"*"` (or an empty/unwired list) means every bus
/// (`null` return); bus ids pass through; a filter element's id
/// resolves to that filter's own upstream buses, transitively
/// (cycle-guarded). Used to scope the signal catalog a plot's picker
/// and patterns draw from, matching what its samples can actually
/// come from.
export function effectiveSourceBuses(
  sources: readonly string[] | undefined,
  busIds: readonly string[],
  filterSources: ReadonlyMap<string, readonly string[]>,
  seen: ReadonlySet<string> = new Set(),
): ReadonlySet<string> | null {
  if (!sources || sources.length === 0 || sources.includes("*")) return null;
  const out = new Set<string>();
  for (const id of sources) {
    if (busIds.includes(id)) {
      out.add(id);
    } else if (filterSources.has(id) && !seen.has(id)) {
      const nested = effectiveSourceBuses(filterSources.get(id), busIds, filterSources, new Set([...seen, id]));
      if (nested == null) return null; // a wildcard anywhere upstream opens everything
      for (const b of nested) out.add(b);
    }
    // Unknown ids (stale wiring) contribute nothing, same as the graph.
  }
  return out;
}

/// Filter the catalog down to `buses` (from [`effectiveSourceBuses`]).
/// `null` = unrestricted. Null-bus descriptors (the no-project-buses
/// degenerate state) only appear unrestricted — a plot wired to
/// specific buses can't sample them.
export function scopeCatalog(
  catalog: readonly SignalDescriptorRecord[],
  buses: ReadonlySet<string> | null,
): SignalDescriptorRecord[] {
  if (buses == null) return [...catalog];
  return catalog.filter((s) => s.bus_id != null && buses.has(s.bus_id));
}

/// Apply each area's `patterns` to the catalog, returning the area
/// list the renderer should treat as authoritative: the manual
/// `signals` plus the pattern matches not already picked manually.
/// The persisted `signals` on the source areas is left intact.
export function applyAreaSelections<A extends SelectableArea>(
  areas: readonly A[],
  catalog: readonly SignalDescriptorRecord[],
  busNames: ReadonlyMap<string, string>,
): A[] {
  return areas.map((a) => {
    if (!a.patterns?.length) return a;
    return {
      ...a,
      signals: [...a.signals, ...signalsFromPatterns(a.patterns, catalog, busNames, a.signals)],
    };
  });
}
