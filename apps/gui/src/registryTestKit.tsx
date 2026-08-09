// Test kit: an element registry backed by real React state and the real
// `applyElementPatch`, so a write re-renders whatever is mounted under
// it and carries the config-epoch bookkeeping panels resync on. The
// per-test-file `makeRegistry` fakes are static — enough for a panel
// that only reads its own element and writes it back, but they cannot
// model an edit landing on a mounted panel from outside.

import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  applyElementPatch,
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import { freshTrace } from "./trace";
import type { ProjectElement } from "./types";

export interface LiveRegistryControl {
  /// Patch an element from *outside* any panel: no writer token, so
  /// every mounted panel on that element resyncs from it. Call inside
  /// `act`.
  update(id: string, patch: Partial<ProjectElement>): void;
  /// The entries as they currently stand.
  entries(): readonly RegistryEntry[];
}

/// A `Provider` to wrap the component under test in, plus the `control`
/// handle for driving external writes into it.
export function makeLiveRegistry(elements: ProjectElement[]) {
  const initial: RegistryEntry[] = elements.map((element) => ({
    element,
    trace: freshTrace(0),
  }));
  let latest: readonly RegistryEntry[] = initial;
  let write: (id: string, patch: Partial<ProjectElement>, writer?: string) => void = () => {};

  function Provider({ children }: { children: ReactNode }) {
    const [entries, setEntries] = useState<readonly RegistryEntry[]>(initial);
    latest = entries;
    const update = useCallback(
      (id: string, patch: Partial<ProjectElement>, writer?: string) =>
        setEntries((prev) => applyElementPatch(prev, id, patch, writer)),
      [],
    );
    write = update;
    const value = useMemo<ElementRegistry>(
      () => ({
        entries,
        get: (id: string) => entries.find((e) => e.element.id === id),
        create: () => "",
        ensure: () => {},
        updateTrace: () => {},
        update,
        remove: () => {},
      }),
      [entries, update],
    );
    return (
      <ElementRegistryContext.Provider value={value}>{children}</ElementRegistryContext.Provider>
    );
  }

  const control: LiveRegistryControl = {
    update: (id, patch) => write(id, patch),
    entries: () => latest,
  };
  return { Provider, control };
}
