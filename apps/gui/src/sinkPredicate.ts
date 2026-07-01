// Pure builder that turns a consumer's `sources` (and any upstream
// filter's `predicate`) into the host-side `FilterPredicate` shape
// the `fetch_trace_range` / `fetch_by_id_page` / `sample_signals`
// commands accept. Lifted out of the panel code so it has one
// unambiguous home and the resolution is unit-testable.

import type { FilterPredicate, ProjectElement } from "./types";

/// One sink's resolved fetch predicate, or `null` when nothing needs
/// constraining (the host returns every frame). See `buildSinkPredicate`.
export type SinkFilter = FilterPredicate | null;

/// Build the `FilterPredicate` the host should apply when fetching for
/// `sink`. `lookupElement` returns project elements by id (for
/// resolving filter-source chains).
///
/// Rules (mirroring the producer-selection model):
///
/// - `sources` is `["*"]` and no filter sources → `null` (host
///   returns every frame, including unassigned ones — today's
///   pre-filter behaviour).
/// - `sources` contains `"*"` plus filter ids → AND of each filter's
///   resolved predicate (the wildcard adds no constraint).
/// - `sources` is an explicit list (no `"*"`) → `All[Any[Bus(b)…],
///   filterPred1, filterPred2, …]` over the listed buses and the
///   filter sources' predicates.
/// - `sources` is `[]` → a predicate that rejects everything (`Any[]`).
///
/// Cycles among filters are prevented at write time
/// (`applyElementPatch`), so the recursive walk here is bounded.
export function buildSinkPredicate(
  sink: ProjectElement,
  lookupElement: (id: string) => ProjectElement | undefined,
): SinkFilter {
  if (sink.kind === "transmit" || sink.kind === "rbs" || sink.kind === "colormap") return null;
  const sources = sink.sources;
  if (sources.length === 0) {
    return { any: [] };
  }
  // Split into the bus and filter halves.
  const buses: string[] = [];
  const filterIds: string[] = [];
  let hasWildcard = false;
  for (const s of sources) {
    if (s === "*") {
      hasWildcard = true;
    } else {
      const el = lookupElement(s);
      if (el?.kind === "filter") filterIds.push(el.id);
      else buses.push(s);
    }
  }
  const filterPredicates: FilterPredicate[] = [];
  for (const id of filterIds) {
    const p = resolveFilterPredicate(id, lookupElement, new Set());
    if (p) filterPredicates.push(p);
  }
  if (hasWildcard) {
    // Wildcard means "every bus, including future ones"; it's the
    // unconstrained baseline. The only remaining constraints are the
    // upstream filter predicates.
    if (filterPredicates.length === 0) return null;
    if (filterPredicates.length === 1) return filterPredicates[0];
    return { all: filterPredicates };
  }
  // Explicit-list path: at most one bus → drop the `any` wrapper.
  const busPredicate: FilterPredicate | null =
    buses.length === 0
      ? null
      : buses.length === 1
        ? { bus: buses[0] }
        : { any: buses.map((b) => ({ bus: b })) };
  const all: FilterPredicate[] = [];
  if (busPredicate) all.push(busPredicate);
  all.push(...filterPredicates);
  if (all.length === 0) return { any: [] }; // Should be unreachable: empty sources is handled above.
  if (all.length === 1) return all[0];
  return { all };
}

/// Resolve a filter id to its effective predicate: the filter's own
/// predicate (if set) AND-composed with its upstream filter sources'
/// predicates (recursive). Visited set guards against pathological
/// cycles (shouldn't happen since `applyElementPatch` rejects them;
/// defensive in case a project file is hand-edited).
function resolveFilterPredicate(
  filterId: string,
  lookupElement: (id: string) => ProjectElement | undefined,
  visited: ReadonlySet<string>,
): FilterPredicate | null {
  if (visited.has(filterId)) return null;
  const el = lookupElement(filterId);
  if (!el || el.kind !== "filter") return null;
  const ownPredicate = el.predicate ?? null;
  const nextVisited = new Set(visited);
  nextVisited.add(filterId);

  // Walk this filter's own sources to fold their predicates in.
  // (Bus-source ids on a filter would scope to those buses; treat them
  // like the consumer's bus-source path here.)
  const upstream: FilterPredicate[] = [];
  let hasWildcard = false;
  const upstreamBuses: string[] = [];
  for (const s of el.sources) {
    if (s === "*") {
      hasWildcard = true;
    } else {
      const upEl = lookupElement(s);
      if (upEl?.kind === "filter") {
        const p = resolveFilterPredicate(s, lookupElement, nextVisited);
        if (p) upstream.push(p);
      } else {
        upstreamBuses.push(s);
      }
    }
  }
  if (!hasWildcard && el.sources.length > 0 && upstreamBuses.length > 0) {
    upstream.push(
      upstreamBuses.length === 1
        ? { bus: upstreamBuses[0] }
        : { any: upstreamBuses.map((b) => ({ bus: b })) },
    );
  }
  // An empty `sources` on this filter means "matches nothing"; fold
  // that in.
  if (el.sources.length === 0) {
    upstream.push({ any: [] });
  }

  const all: FilterPredicate[] = [];
  if (ownPredicate) all.push(ownPredicate);
  all.push(...upstream);
  if (all.length === 0) return null;
  if (all.length === 1) return all[0];
  return { all };
}
