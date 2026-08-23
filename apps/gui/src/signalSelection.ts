/// Shared signal-selection model (ADR 0038): manual picks + OR-combined
/// regex patterns evaluated against the canonical signal path
/// `bus/ecu/message/signal`. One implementation drives the plot panel's
/// pattern-defined series and the signal view's selection editor, so
/// the same pattern selects the same signals on every surface (the
/// signal view's own evaluation happens host-side against the same
/// subject — `signal_snapshot.rs`). Kept free of `PlotPanel.tsx`
/// imports so pure-logic tests run without uplot.

import type { SignalDescriptorRecord } from "./types";
import { recordSignalKey, signalKey } from "./plotData";
import type { SignalRef } from "./plotPanelConfig";

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

/// Everything the signal view selects by pattern: its view-level
/// patterns plus every *live* section's own, deduped and in that order.
/// A section's patterns are part of what the view selects rather than a
/// re-ordering of rows that were already there, and patterns belonging
/// to a section that no longer exists contribute nothing — the same
/// rule the host applies when it resolves the selection
/// (`signal_snapshot.rs`'s `selection_with_section_patterns`), mirrored
/// here for the surfaces that need the matches without a round trip.
export function selectedPatterns(
  patterns: readonly string[],
  sectionNames: readonly string[],
  sectionPatterns: Readonly<Record<string, readonly string[]>>,
): string[] {
  const out = [...patterns];
  for (const name of sectionNames) {
    for (const p of sectionPatterns[name] ?? []) {
      if (!out.includes(p)) out.push(p);
    }
  }
  return out;
}

/// Shape `applyAreaSelections` accepts. Subset of `PlotPanel`'s
/// `PlotAreaConfig` — anything the helpers need without bringing the
/// renderer along. The series shape is the shared `SignalRef`
/// (`plotPanelConfig.ts`), imported directly now that it lives in a
/// uPlot-free module.
export interface SelectableArea {
  id: string;
  signals: SignalRef[];
  patterns?: string[];
  // Other PlotAreaConfig fields pass through unchanged; the
  // function is generic over them.
}

const refKey = (s: SignalRef) =>
  signalKey(s.busId, s.messageId, s.extended, s.signalName, s.fileBacked);

/// Resolve `patterns` to refs, deduped across patterns and against
/// `exclude` (the area's manual picks — a manual pick wins, so its
/// color/hide state is authoritative). A pattern match carries no
/// color: like any series nobody picked one for, it resolves live
/// through `signalColorResolver.ts` (ADR 0026), which keeps its color
/// stable across re-evaluations, sorts, and views without storing it.
export function signalsFromPatterns(
  patterns: readonly string[],
  catalog: readonly SignalDescriptorRecord[],
  busNames: ReadonlyMap<string, string>,
  exclude: readonly SignalRef[] = [],
): SignalRef[] {
  const seen = new Set(exclude.map(refKey));
  const out: SignalRef[] = [];
  for (const res of resolvePatterns(patterns, catalog, busNames)) {
    for (const s of res.matches) {
      const key = recordSignalKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        busId: s.bus_id,
        messageId: s.message_id,
        extended: s.extended,
        signalName: s.signal_name,
        messageName: s.message_name,
        unit: s.unit,
        ...(s.file_backed ? { fileBacked: true as const } : {}),
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

/// Apply one area's `patterns` to the catalog, returning the area the
/// renderer should treat as authoritative: the manual `signals` plus the
/// pattern matches not already picked manually. The persisted `signals`
/// is left intact, and an area with no patterns is returned *as it came
/// in* — callers rely on that identity to tell an untouched area from an
/// edited one.
export function applyAreaSelection<A extends SelectableArea>(
  area: A,
  catalog: readonly SignalDescriptorRecord[],
  busNames: ReadonlyMap<string, string>,
): A {
  if (!area.patterns?.length) return area;
  // Entries marked `viaPattern` carry overrides for a row the patterns
  // put there — they are not a claim on where the row sits, so they
  // stay in the pattern's order rather than jumping into the manual
  // block. Everything else is a pick (a drop *is* a claim on position)
  // and keeps its slot ahead of the matches, which is also what keeps a
  // manual pick authoritative over a pattern that happens to match it.
  const pinned = area.signals.filter((s) => !s.viaPattern);
  const matches = signalsFromPatterns(area.patterns, catalog, busNames, pinned);
  const matched = new Set(matches.map(refKey));
  const stored = new Map(area.signals.map((s) => [refKey(s), s]));
  return {
    ...area,
    signals: [
      // The picks — plus any marked entry the patterns no longer match,
      // which has nothing left to sit behind and so keeps the slot it
      // already had rather than disappearing with its overrides.
      ...area.signals.filter((s) => !s.viaPattern || !matched.has(refKey(s))),
      ...matches.map((m) => stored.get(refKey(m)) ?? m),
    ],
  };
}

/// [`applyAreaSelection`] over a whole area list.
export function applyAreaSelections<A extends SelectableArea>(
  areas: readonly A[],
  catalog: readonly SignalDescriptorRecord[],
  busNames: ReadonlyMap<string, string>,
): A[] {
  return areas.map((a) => applyAreaSelection(a, catalog, busNames));
}

/// Move section `moved` to where `target` currently sits in the view's
/// section order — the whole of the signal view's section drag-reorder
/// (ADR 0045). The order *is* the `names` array (the host arranges the
/// row space from it, and the pattern-claim tie-break reads the same
/// order), so a reorder is a pure permutation of it and nothing keyed
/// by section name has to move along.
///
/// Insertion uses the target's index in the *original* list, so the
/// dragged section lands where the pointer let go in both directions.
/// A no-op — same section, or a name that isn't here — returns the
/// input reference so a caller's `setState` can bail out. The implicit
/// unassigned section is not in `names`; dropping onto its header means
/// "to the front", which is `target: names[0]` for the caller to pick.
export function reorderSectionNames(
  names: readonly string[],
  moved: string,
  target: string,
): readonly string[] {
  if (moved === target) return names;
  const from = names.indexOf(moved);
  const to = names.indexOf(target);
  if (from < 0 || to < 0) return names;
  const next = [...names];
  next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
