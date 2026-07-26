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
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import {
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
    expect(update).toHaveBeenCalledWith("t1", { config: { mode: "chronological" } });
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
