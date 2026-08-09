// @vitest-environment jsdom
//
// The shared element-panel lifecycle hooks: id resolution + `ensure` +
// `config` hydration + dual-write persist (`useElementPanel`), and the
// sources-picker kind-narrowing (`useElementSources`). Four panels
// (trace, plot, transmit, rbs) build on these; this is the canonical
// coverage for the shared logic itself — each panel's own DOM test
// still covers its integration (which config keys it round-trips,
// how it wires the picker's presentation).

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  applyElementPatch,
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import { useElementPanel, useElementSources } from "./useElementPanel";
import { freshTrace } from "./trace";
import type { ProjectElement } from "./types";

function makeRegistry(elements: ProjectElement[]) {
  const map = new Map<string, RegistryEntry>();
  for (const element of elements) {
    map.set(element.id, { element, trace: freshTrace(0) });
  }
  const ensure = vi.fn();
  const update = vi.fn((id: string, patch: Partial<ProjectElement>) => {
    const e = map.get(id);
    if (e) map.set(id, { ...e, element: { ...e.element, ...patch } as ProjectElement });
  });
  const registry: ElementRegistry = {
    get entries() {
      return [...map.values()];
    },
    get: (id: string) => map.get(id),
    create: () => "",
    ensure,
    updateTrace: () => {},
    update,
    remove: () => {},
  };
  return { registry, ensure, update };
}

function wrapperFor(registry: ElementRegistry) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ElementRegistryContext.Provider value={registry}>{children}</ElementRegistryContext.Provider>
    );
  };
}

/// A registry wrapper backed by real React state and the real
/// `applyElementPatch` — so a write re-renders the panel under test and
/// carries the epoch/origin bookkeeping the rehydrate path keys on.
/// `control.update` is the external writer (no writer token), standing
/// in for whatever rewrites an element's config from outside the panel.
function liveWrapperFor(elements: ProjectElement[]) {
  const control: { update: (id: string, patch: Partial<ProjectElement>) => void } = {
    update: () => {},
  };
  const initial: RegistryEntry[] = elements.map((element) => ({
    element,
    trace: freshTrace(0),
  }));
  function Wrapper({ children }: { children: ReactNode }) {
    const [entries, setEntries] = useState<readonly RegistryEntry[]>(initial);
    const update = useCallback(
      (id: string, patch: Partial<ProjectElement>, writer?: string) =>
        setEntries((prev) => applyElementPatch(prev, id, patch, writer)),
      [],
    );
    control.update = update;
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
    return <ElementRegistryContext.Provider value={value}>{children}</ElementRegistryContext.Provider>;
  }
  return { Wrapper, control };
}

afterEach(() => vi.clearAllMocks());

describe("useElementPanel", () => {
  it("uses the elementId from params when present", () => {
    const { registry } = makeRegistry([]);
    const api = { updateParameters: vi.fn() };
    const { result } = renderHook(
      () => useElementPanel({ params: { elementId: "t1" }, api } as never, "trace"),
      { wrapper: wrapperFor(registry) },
    );
    expect(result.current.elementId).toBe("t1");
  });

  it("generates a fresh id when params carry none (a corrupt blob or a layout saved before elements existed)", () => {
    const { registry } = makeRegistry([]);
    const api = { updateParameters: vi.fn() };
    const { result } = renderHook(
      () => useElementPanel({ params: undefined, api } as never, "trace"),
      { wrapper: wrapperFor(registry) },
    );
    expect(typeof result.current.elementId).toBe("string");
    expect(result.current.elementId.length).toBeGreaterThan(0);
  });

  it("calls ensure(elementId, kind) on mount", () => {
    const { registry, ensure } = makeRegistry([]);
    const api = { updateParameters: vi.fn() };
    renderHook(() => useElementPanel({ params: { elementId: "p1" }, api } as never, "plot"), {
      wrapper: wrapperFor(registry),
    });
    expect(ensure).toHaveBeenCalledWith("p1", "plot");
  });

  it("hydrates savedConfig from the element's config over bare params", () => {
    const { registry } = makeRegistry([
      {
        kind: "trace",
        id: "t1",
        sources: ["*"],
        config: { mode: "chronological" },
      } as unknown as ProjectElement,
    ]);
    const api = { updateParameters: vi.fn() };
    const { result } = renderHook(
      () => useElementPanel({ params: { elementId: "t1", mode: "by-id" }, api } as never, "trace"),
      { wrapper: wrapperFor(registry) },
    );
    expect(result.current.savedConfig).toEqual({ mode: "chronological" });
  });

  it("falls back to params when the element has no config yet", () => {
    const { registry } = makeRegistry([
      { kind: "trace", id: "t1", sources: ["*"] } as ProjectElement,
    ]);
    const api = { updateParameters: vi.fn() };
    const { result } = renderHook(
      () => useElementPanel({ params: { elementId: "t1", mode: "by-id" }, api } as never, "trace"),
      { wrapper: wrapperFor(registry) },
    );
    expect(result.current.savedConfig).toEqual({ elementId: "t1", mode: "by-id" });
  });

  it("persist(config) dual-writes: registry.update with the config, and updateParameters with elementId + config spread", () => {
    const { registry, update } = makeRegistry([
      { kind: "trace", id: "t1", sources: ["*"] } as ProjectElement,
    ]);
    const api = { updateParameters: vi.fn() };
    const { result } = renderHook(
      () => useElementPanel({ params: { elementId: "t1" }, api } as never, "trace"),
      { wrapper: wrapperFor(registry) },
    );
    result.current.persist({ mode: "chronological" });
    // The third argument is this panel's writer token — what makes the
    // write recognisable as its own echo rather than an external edit.
    expect(update).toHaveBeenCalledWith(
      "t1",
      { config: { mode: "chronological" } },
      expect.any(String),
    );
    expect(api.updateParameters).toHaveBeenCalledWith({ elementId: "t1", mode: "chronological" });
  });

  it("persist() with no config only writes elementId to params — no registry write (transmit/rbs, which have no config field)", () => {
    const { registry, update } = makeRegistry([
      { kind: "transmit", id: "x1", sinks: [], frameIds: [] } as ProjectElement,
    ]);
    const api = { updateParameters: vi.fn() };
    const { result } = renderHook(
      () => useElementPanel({ params: { elementId: "x1" }, api } as never, "transmit"),
      { wrapper: wrapperFor(registry) },
    );
    result.current.persist();
    expect(update).not.toHaveBeenCalled();
    expect(api.updateParameters).toHaveBeenCalledWith({ elementId: "x1" });
  });
});

describe("useElementPanel rehydration", () => {
  const traceElement = { kind: "trace", id: "t1", sources: ["*"], config: { mode: "by-id" } } as
    unknown as ProjectElement;

  it("does not rehydrate on mount — `savedConfig` is the mount read", () => {
    const { Wrapper } = liveWrapperFor([traceElement]);
    const api = { updateParameters: vi.fn() };
    const rehydrate = vi.fn();
    renderHook(
      () => useElementPanel({ params: { elementId: "t1" }, api } as never, "trace", rehydrate),
      { wrapper: Wrapper },
    );
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it("rehydrates from the element when its config is rewritten externally", () => {
    const { Wrapper, control } = liveWrapperFor([traceElement]);
    const api = { updateParameters: vi.fn() };
    const rehydrate = vi.fn();
    renderHook(
      () => useElementPanel({ params: { elementId: "t1" }, api } as never, "trace", rehydrate),
      { wrapper: Wrapper },
    );
    act(() => control.update("t1", { config: { mode: "chronological" } }));
    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(rehydrate).toHaveBeenCalledWith({ mode: "chronological" });
  });

  it("does not rehydrate from the panel's own persist (no self-clobber, no loop)", () => {
    const { Wrapper } = liveWrapperFor([traceElement]);
    const api = { updateParameters: vi.fn() };
    const rehydrate = vi.fn();
    const { result } = renderHook(
      () => useElementPanel({ params: { elementId: "t1" }, api } as never, "trace", rehydrate),
      { wrapper: Wrapper },
    );
    act(() => result.current.persist({ mode: "chronological" }));
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it("still rehydrates after the panel has persisted its own config", () => {
    const { Wrapper, control } = liveWrapperFor([traceElement]);
    const api = { updateParameters: vi.fn() };
    const rehydrate = vi.fn();
    const { result } = renderHook(
      () => useElementPanel({ params: { elementId: "t1" }, api } as never, "trace", rehydrate),
      { wrapper: Wrapper },
    );
    act(() => result.current.persist({ mode: "chronological" }));
    act(() => control.update("t1", { config: { mode: "by-id" } }));
    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(rehydrate).toHaveBeenCalledWith({ mode: "by-id" });
  });

  it("ignores a write that leaves the config untouched (a sources rewire)", () => {
    const { Wrapper, control } = liveWrapperFor([traceElement]);
    const api = { updateParameters: vi.fn() };
    const rehydrate = vi.fn();
    renderHook(
      () => useElementPanel({ params: { elementId: "t1" }, api } as never, "trace", rehydrate),
      { wrapper: Wrapper },
    );
    act(() => control.update("t1", { sources: ["b1"] }));
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it("keeps the element view live through an external write", () => {
    const { Wrapper, control } = liveWrapperFor([traceElement]);
    const api = { updateParameters: vi.fn() };
    const { result } = renderHook(
      () => useElementPanel({ params: { elementId: "t1" }, api } as never, "trace"),
      { wrapper: Wrapper },
    );
    act(() => control.update("t1", { sources: ["b1"] }));
    expect(result.current.element).toMatchObject({ sources: ["b1"] });
  });
});

describe("useElementSources", () => {
  it("reads sources off a trace/plot/signals/filter element", () => {
    const { registry } = makeRegistry([
      { kind: "plot", id: "p1", sources: ["b1", "b2"] } as ProjectElement,
    ]);
    const { result } = renderHook(() =>
      useElementSources(registry, "p1", registry.get("p1")?.element),
    );
    expect(result.current.currentSources).toEqual(["b1", "b2"]);
  });

  it("defaults to the wildcard when sources is missing (legacy/healing element)", () => {
    const { registry } = makeRegistry([
      { kind: "plot", id: "p1" } as unknown as ProjectElement,
    ]);
    const { result } = renderHook(() =>
      useElementSources(registry, "p1", registry.get("p1")?.element),
    );
    expect(result.current.currentSources).toEqual(["*"]);
  });

  it("defaults to the wildcard for kinds with no sources concept (transmit, rbs, colormap)", () => {
    const { registry } = makeRegistry([
      { kind: "transmit", id: "x1", sinks: [], frameIds: [] } as ProjectElement,
      { kind: "rbs", id: "r1", path: null, run: false } as ProjectElement,
      {
        kind: "colormap",
        id: "c1",
        messageId: 0,
        extended: false,
        signalName: "s",
        rules: [],
      } as ProjectElement,
    ]);
    for (const id of ["x1", "r1", "c1"]) {
      const { result } = renderHook(() =>
        useElementSources(registry, id, registry.get(id)?.element),
      );
      expect(result.current.currentSources).toEqual(["*"]);
    }
  });

  it("collects only filter elements into availableFilters, labelled", () => {
    const { registry } = makeRegistry([
      { kind: "plot", id: "p1", sources: ["*"] } as ProjectElement,
      { kind: "filter", id: "f1", sources: ["*"], name: "My Filter" } as ProjectElement,
      { kind: "trace", id: "t1", sources: ["*"] } as ProjectElement,
    ]);
    const { result } = renderHook(() =>
      useElementSources(registry, "p1", registry.get("p1")?.element),
    );
    expect(result.current.availableFilters).toEqual([{ id: "f1", label: "My Filter" }]);
  });

  it("handleSourcesChange patches the element's sources through the registry", () => {
    const { registry, update } = makeRegistry([
      { kind: "trace", id: "t1", sources: ["*"] } as ProjectElement,
    ]);
    const { result } = renderHook(() =>
      useElementSources(registry, "t1", registry.get("t1")?.element),
    );
    result.current.handleSourcesChange(["f1"]);
    expect(update).toHaveBeenCalledWith("t1", { sources: ["f1"] });
  });
});
