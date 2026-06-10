import { describe, expect, it, vi } from "vitest";

import { insertFilterUpstream } from "./insertFilterUpstream";
import type { ElementRegistry, RegistryEntry } from "./projectElements";
import type { ProjectElement } from "./types";
import { freshTrace } from "./trace";

/// Fake registry that records `create` + `update` calls and reflects
/// them in `entries` / `get`. Mirrors the App.tsx behaviour closely
/// enough for the orchestration test.
function fakeRegistry(initial: ProjectElement[]) {
  const map = new Map<string, RegistryEntry>(
    initial.map((el) => [el.id, { element: el, trace: freshTrace(0) }]),
  );
  const create = vi.fn((kind: ProjectElement["kind"]) => {
    const id = `created-${kind}-${map.size}`;
    const fresh =
      kind === "transmit"
        ? ({ kind, id, sinks: [], frameIds: [] } as ProjectElement)
        : kind === "filter"
          ? ({ kind, id, sources: ["*"] } as ProjectElement)
          : ({ kind, id, sources: ["*"] } as ProjectElement);
    map.set(id, { element: fresh, trace: freshTrace(0) });
    return id;
  });
  const update = vi.fn((id: string, patch: Partial<ProjectElement>) => {
    const entry = map.get(id);
    if (!entry) return;
    map.set(id, {
      ...entry,
      element: { ...entry.element, ...patch } as ProjectElement,
    });
  });
  const registry: ElementRegistry = {
    get entries() {
      return [...map.values()];
    },
    get: (id) => map.get(id),
    create,
    ensure: vi.fn(),
    updateTrace: vi.fn(),
    update,
    remove: vi.fn(),
  };
  return { registry, create, update, map };
}

describe("insertFilterUpstream", () => {
  it("creates a filter, transfers ['*'] from the sink, and routes the sink through the filter", () => {
    const { registry, create, update } = fakeRegistry([
      { kind: "trace", id: "t1", sources: ["*"] },
    ]);
    const filterId = insertFilterUpstream(registry, "t1");
    expect(filterId).toBe("created-filter-1");
    expect(create).toHaveBeenCalledWith("filter");
    // Filter inherits the trace's prior input list verbatim.
    expect(update).toHaveBeenCalledWith(filterId, { sources: ["*"] });
    // Trace's only source becomes the new filter.
    expect(update).toHaveBeenCalledWith("t1", { sources: [filterId] });
  });

  it("preserves an explicit bus list on the new filter", () => {
    const { registry, update } = fakeRegistry([
      { kind: "trace", id: "t1", sources: ["b1", "b2"] },
    ]);
    const filterId = insertFilterUpstream(registry, "t1");
    expect(update).toHaveBeenCalledWith(filterId, { sources: ["b1", "b2"] });
  });

  it("preserves an existing filter chain (sink wired to old filter → new filter inherits old filter)", () => {
    const { registry, update } = fakeRegistry([
      { kind: "filter", id: "oldF", sources: ["*"] },
      { kind: "trace", id: "t1", sources: ["oldF"] },
    ]);
    const filterId = insertFilterUpstream(registry, "t1");
    expect(update).toHaveBeenCalledWith(filterId, { sources: ["oldF"] });
    expect(update).toHaveBeenCalledWith("t1", { sources: [filterId] });
  });

  it("is a no-op for an unknown sink id", () => {
    const { registry, create } = fakeRegistry([]);
    expect(insertFilterUpstream(registry, "nope")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("is a no-op when targeting a transmit element (transmits aren't consumers)", () => {
    const { registry, create } = fakeRegistry([
      { kind: "transmit", id: "tx1", sinks: ["b1"], frameIds: [] },
    ]);
    expect(insertFilterUpstream(registry, "tx1")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
