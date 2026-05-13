import { createContext, useContext } from "react";

import type { ProjectElement, ProjectElementKind } from "./types";
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
  return (o.kind === "trace" || o.kind === "plot") && typeof o.id === "string";
}
