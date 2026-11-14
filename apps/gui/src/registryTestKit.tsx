// Test kit: an element registry backed by real React state and the real
// `applyElementPatch`, so a write re-renders whatever is mounted under
// it and carries the config-epoch bookkeeping panels resync on. The
// per-test-file `makeRegistry` fakes are static — enough for a panel
// that only reads its own element and writes it back, but they cannot
// model an edit landing on a mounted panel from outside.
//
// Trace windows are host state: the kit records the run controls a
// panel sends and lets the test push the host's answer, the way the
// app's mirror would. It computes no window itself.

import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  applyElementPatch,
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import type { TraceState } from "./trace";
import type { TraceControl } from "./traceWindows";
import type { ProjectElement } from "./types";

/// A running window over the whole buffer — what a seeded element's
/// mirror holds unless a test says otherwise.
export const RUNNING_TRACE: TraceState = { start: 0, end: null, isPaused: false };

export interface LiveRegistryControl {
  /// Patch an element from *outside* any panel: no writer token, so
  /// every mounted panel on that element resyncs from it. Call inside
  /// `act`.
  update(id: string, patch: Partial<ProjectElement>): void;
  /// The entries as they currently stand.
  entries(): readonly RegistryEntry[];
  /// Every run control a panel sent to the host, in order.
  traceControls(): ReadonlyArray<{ id: string; action: TraceControl }>;
  /// The host's answer: element `id`'s mirrored window becomes `window`.
  /// Call inside `act`.
  setTrace(id: string, window: TraceState): void;
}

/// A `Provider` to wrap the component under test in, plus the `control`
/// handle for driving external writes into it.
export function makeLiveRegistry(elements: ProjectElement[]) {
  const initial: RegistryEntry[] = elements.map((element) => ({
    element,
    trace: RUNNING_TRACE,
  }));
  let latest: readonly RegistryEntry[] = initial;
  const sent: Array<{ id: string; action: TraceControl }> = [];
  let write: (id: string, patch: Partial<ProjectElement>, writer?: string) => void = () => {};
  let mirror: (id: string, window: TraceState) => void = () => {};

  function Provider({ children }: { children: ReactNode }) {
    const [entries, setEntries] = useState<readonly RegistryEntry[]>(initial);
    latest = entries;
    const update = useCallback(
      (id: string, patch: Partial<ProjectElement>, writer?: string) =>
        setEntries((prev) => applyElementPatch(prev, id, patch, writer)),
      [],
    );
    write = update;
    mirror = (id, window) =>
      setEntries((prev) => prev.map((e) => (e.element.id === id ? { ...e, trace: window } : e)));
    const value = useMemo<ElementRegistry>(
      () => ({
        entries,
        get: (id: string) => entries.find((e) => e.element.id === id),
        create: () => "",
        ensure: () => {},
        controlTrace: (id: string, action: TraceControl) => {
          sent.push({ id, action });
        },
        update,
        remove: () => {},
        duplicate: async () => "",
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
    traceControls: () => sent,
    setTrace: (id, window) => mirror(id, window),
  };
  return { Provider, control };
}
