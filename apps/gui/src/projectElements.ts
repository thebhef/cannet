import { createContext, useContext } from "react";

import type { ProjectElement } from "./types";
import type { TraceState } from "./trace";

/// A registry entry: the persisted project element plus its runtime
/// state. For a trace element, `trace` is the live `[start, end,
/// isPaused]` window — *not* persisted in the project (it re-anchors to
/// the session buffer, which resets on a new connection / app exit).
export interface RegistryEntry {
  element: ProjectElement;
  /// The live trace window. (Only trace elements exist for now; when
  /// other kinds arrive this becomes a kind-tagged union of runtime
  /// state.)
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
  /// Create a new trace element + entry; returns its id.
  createTrace(view: ProjectElement["view"]): string;
  /// Ensure an entry with `id` exists (a panel found its element
  /// missing — heal it). No-op if it's already there.
  ensureTrace(id: string, view: ProjectElement["view"]): void;
  /// Replace a trace element's window. The updater may return the same
  /// object to signal "no change".
  updateTrace(id: string, updater: (s: TraceState) => TraceState): void;
  /// Set a trace element's `view` — the panel's mode toggle. No-op if
  /// the element doesn't exist or already has that view.
  setElementView(id: string, view: ProjectElement["view"]): void;
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
  const o = v as { kind?: unknown; id?: unknown; view?: unknown };
  return (
    o.kind === "trace" &&
    typeof o.id === "string" &&
    (o.view === "chronological" || o.view === "by-id")
  );
}
