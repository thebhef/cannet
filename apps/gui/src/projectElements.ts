import { createContext, useContext } from "react";

import type { ColorRule, ProjectElement, ProjectElementKind } from "./types";
import type { TraceState } from "./trace";

/// A registry entry: the persisted project element plus its runtime
/// state. `trace` is the live `[start, end, isPaused]` session window —
/// *not* persisted in the project (it re-anchors to the session buffer,
/// which resets on a new connection / app exit). Both element kinds use
/// it: a `plot` element is a trace-style window too, it just renders
/// signal values instead of message rows.
export interface RegistryEntry {
  element: ProjectElement;
  trace: TraceState;
}

/// The element registry: every project element + its runtime state,
/// and the operations that mutate the set. Lives as `App` state and is
/// handed down via [`ElementRegistryContext`]; it's restored from
/// `project.elements` on Open, seeded with one trace element on first
/// launch / New, and serialized back (the `element`s only) on Save.
export interface ElementRegistry {
  /// All entries, in insertion order.
  entries: readonly RegistryEntry[];
  get(id: string): RegistryEntry | undefined;
  /// Create a new element of `kind` + its entry; returns the new id.
  create(kind: ProjectElementKind): string;
  /// Ensure an entry with `id` exists and has the given `kind` (a panel
  /// found its element missing — heal it; or an old project saved a plot
  /// element as `trace` — correct it). No-op if already present with
  /// that kind.
  ensure(id: string, kind: ProjectElementKind): void;
  /// Replace an element's session window. The updater may return the
  /// same object to signal "no change".
  updateTrace(id: string, updater: (s: TraceState) => TraceState): void;
  /// Patch a project element's fields in place (e.g. set `sources` or a
  /// filter's `predicate`). The patch is shallow — any field in the
  /// patch replaces the matching field on the element. The element's
  /// `kind` and `id` must match the existing entry; mismatches are a
  /// no-op (so a stale closure can't accidentally retype an element).
  /// Unknown ids are also a no-op.
  update(id: string, patch: Partial<ProjectElement>): void;
  /// Remove an element and close its panel, if any.
  remove(id: string): void;
}

export const ElementRegistryContext = createContext<ElementRegistry | null>(null);

export function useElementRegistry(): ElementRegistry {
  const ctx = useContext(ElementRegistryContext);
  if (!ctx) {
    throw new Error("useElementRegistry must be used inside an ElementRegistryContext provider");
  }
  return ctx;
}

/// Validate a value persisted in `project.elements`. Unknown / future
/// element kinds fail this and get dropped on open (rather than
/// crashing).
export function isProjectElement(v: unknown): v is ProjectElement {
  if (v == null || typeof v !== "object") return false;
  const o = v as { kind?: unknown; id?: unknown };
  return (
    (o.kind === "trace" ||
      o.kind === "plot" ||
      o.kind === "transmit" ||
      o.kind === "filter" ||
      o.kind === "rbs" ||
      o.kind === "colormap") &&
    typeof o.id === "string"
  );
}

/// Normalise a project element fresh from disk so callers can rely
/// on the normalised shape: every consumer (`trace` / `plot` /
/// `filter`) has a `sources: string[]` (defaulting to `["*"]` — fan
/// in from every bus), and every `transmit` has a `sinks: string[]`
/// (defaulting to `[]` — empty for a migrated project; freshly
/// created transmits pre-fill from the current bus list elsewhere).
/// Older saved projects only had an inert `source?: string` field on
/// consumers; treat it as `["*"]` so the loaded project fans out by
/// default. `sinks` does not support a wildcard — it's an explicit
/// list only.
export function normalizeElement(el: ProjectElement): ProjectElement {
  // `name` (ADR 0019): keep a string, drop anything else — the
  // list-level `assignDefaultNames` pass backfills the dropped /
  // missing ones with `${Kind} ${n}` defaults.
  const nameRaw = (el as unknown as { name?: unknown }).name;
  const name = typeof nameRaw === "string" ? nameRaw : undefined;
  if (el.kind === "transmit") {
    const raw = (el as unknown as { sinks?: unknown }).sinks;
    const frameIdsRaw = (el as unknown as { frameIds?: unknown }).frameIds;
    return { ...el, name, sinks: stringList(raw, []), frameIds: stringList(frameIdsRaw, []) };
  }
  if (el.kind === "rbs") {
    // `path` references the `.cannet_rbs` file; `run` is the
    // project-persisted Run flag (ADR 0028 — default off, so a
    // malformed flag never auto-transmits).
    const pathRaw = (el as unknown as { path?: unknown }).path;
    const runRaw = (el as unknown as { run?: unknown }).run;
    return {
      ...el,
      name,
      path: typeof pathRaw === "string" ? pathRaw : null,
      run: runRaw === true,
    };
  }
  if (el.kind === "colormap") {
    // A signal value→color map (ADR 0029): not a consumer, so no
    // `sources`. Coerce the target-signal fields and rule list defensively
    // so a malformed blob loads as an inert, editable map.
    const o = el as unknown as {
      busId?: unknown;
      messageId?: unknown;
      extended?: unknown;
      signalName?: unknown;
      rules?: unknown;
    };
    return {
      ...el,
      name,
      busId: typeof o.busId === "string" ? o.busId : null,
      messageId: typeof o.messageId === "number" ? o.messageId : 0,
      extended: o.extended === true,
      signalName: typeof o.signalName === "string" ? o.signalName : "",
      rules: normalizeColorRules(o.rules),
    };
  }
  const raw = (el as unknown as { sources?: unknown }).sources;
  return { ...el, name, sources: stringList(raw, ["*"]) } as ProjectElement;
}

/// Coerce an unknown value to a well-formed `ColorRule[]` (ADR 0029),
/// dropping any entry missing numeric `min`/`max` or a string `color`.
function normalizeColorRules(v: unknown): ColorRule[] {
  if (!Array.isArray(v)) return [];
  const out: ColorRule[] = [];
  for (const r of v) {
    if (r == null || typeof r !== "object") continue;
    const o = r as { min?: unknown; max?: unknown; color?: unknown };
    if (typeof o.min === "number" && typeof o.max === "number" && typeof o.color === "string") {
      out.push({ min: o.min, max: o.max, color: o.color });
    }
  }
  return out;
}

/// Coerce an unknown value to a `string[]`, falling back to
/// `fallback` when missing or malformed.
function stringList(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v) && v.every((s) => typeof s === "string")) {
    return v as string[];
  }
  return fallback;
}

/// Apply a shallow patch to one element in a registry's entries,
/// returning a new array (or the same one if no change applied). The
/// patch's `kind` / `id` (if present) must match the existing element;
/// mismatched calls and unknown ids are no-ops. A patch on a `filter`
/// element's `sources` that would introduce a cycle (filter →
/// filter → ... → itself) is also a no-op. Pulled out as a pure
/// function so the registry's `update` logic is testable without
/// rendering React.
export function applyElementPatch(
  entries: readonly RegistryEntry[],
  id: string,
  patch: Partial<ProjectElement>,
): readonly RegistryEntry[] {
  const i = entries.findIndex((e) => e.element.id === id);
  if (i < 0) return entries;
  const current = entries[i].element;
  if (patch.kind != null && patch.kind !== current.kind) return entries;
  if (patch.id != null && patch.id !== current.id) return entries;
  // Filters can chain through `sources` — reject a patch that would
  // make the filter graph cyclic.
  const patchedSources = (patch as { sources?: unknown }).sources;
  if (
    current.kind === "filter" &&
    Array.isArray(patchedSources) &&
    wouldCycle(entries, id, patchedSources as string[])
  ) {
    return entries;
  }
  // A patch that changes no value must return the SAME entries array, so
  // a caller deriving the patch in a render effect doesn't churn the
  // registry identity. The transmit panel's sinks-sync effect recomputes
  // its `ordered` array every render and depends on the registry value;
  // without this short-circuit each (value-equal) update allocates a new
  // entries array → new registry identity → the effect re-fires → update
  // → … an unbounded render loop while the panel is mounted. Arrays are
  // compared by content because the effect always passes a fresh array.
  if (patchIsNoOp(current, patch)) return entries;
  const merged = { ...current, ...patch } as ProjectElement;
  const next = entries.slice();
  next[i] = { ...entries[i], element: merged };
  return next;
}

/// True when every field in `patch` already equals the element's current
/// value (array fields compared element-wise). Used by [`applyElementPatch`]
/// to keep a no-op patch identity-stable.
function patchIsNoOp(current: ProjectElement, patch: Partial<ProjectElement>): boolean {
  const cur = current as unknown as Record<string, unknown>;
  const pat = patch as unknown as Record<string, unknown>;
  for (const key of Object.keys(pat)) {
    const a = cur[key];
    const b = pat[key];
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length || a.some((v, idx) => v !== b[idx])) return false;
    } else if (a !== b) {
      return false;
    }
  }
  return true;
}

/// Would patching filter `filterId`'s `sources` to `newSources`
/// introduce a cycle? Walks the filter-to-filter dependency graph
/// from `newSources`, treating buses / `"*"` / unknown ids as leaves
/// (no further traversal). A return path back to `filterId` means a
/// cycle. Sinks (trace / plot) and transmits can't participate in a
/// cycle — sinks aren't producers anyone references, and transmits
/// only point at buses.
function wouldCycle(
  entries: readonly RegistryEntry[],
  filterId: string,
  newSources: readonly string[],
): boolean {
  // Snapshot filter-source edges, then overlay the patch.
  const filterEdges = new Map<string, readonly string[]>();
  for (const e of entries) {
    if (e.element.kind === "filter") {
      filterEdges.set(e.element.id, e.element.sources);
    }
  }
  filterEdges.set(filterId, newSources);

  // BFS from the patched filter's targets, following filter→filter
  // edges. If we ever land on `filterId`, the patch would close the
  // loop.
  const stack: string[] = [];
  for (const s of newSources) if (filterEdges.has(s)) stack.push(s);
  const seen = new Set<string>();
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (f === filterId) return true;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const s of filterEdges.get(f) ?? []) {
      if (filterEdges.has(s)) stack.push(s);
    }
  }
  return false;
}
