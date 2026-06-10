// @vitest-environment jsdom
//
// Component test for the trace panel's filter wiring. A trace wired to
// a filter pages its *chronological* rows host-side through
// `fetch_filtered_trace` (with the resolved predicate) — it never
// holds the whole filtered set in memory. The host evaluator and the
// predicate builder are covered by `filter.rs` / `sinkPredicate.test.ts`
// and `lib.rs::filtered_trace_page`; this guards the panel→host wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "fetch_filtered_trace") return { count: 0, start: 0, rows: [] };
    return [];
  }),
}));

import { TracePanel } from "./TracePanel";
import { TraceDataContext, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import { freshTrace } from "./trace";
import type { ProjectElement } from "./types";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const traceData: TraceData = {
  count: 100,
  version: 1,
  baseTimestampSeconds: 0,
  getFrame: () => null,
  ensureVisible: () => {},
};

const projectCtx = {
  projectPath: null,
  dirty: false,
  dbcPaths: [],
  dbcBuses: {},
  buses: [],
  interfaceBindings: [],
  connectedAddresses: [],
  remoteConnected: false,
  blfPath: null,
  onNewProject: () => {},
  onOpenProject: () => {},
  onSaveProject: () => {},
  onSaveProjectAs: () => {},
  onAddDbc: () => {},
  onRemoveDbc: () => {},
  onReloadDbc: () => {},
  onSetDbcBuses: () => {},
  onAddBus: () => {},
  onRemoveBus: () => {},
  onRenameBus: () => {},
  onSetBusColor: () => {},
  onAddBinding: () => {},
  onRemoveBinding: () => {},
  onConnect: () => {},
  onDisconnect: () => {},
} as unknown as ProjectContextValue;

function makeRegistry(elements: ProjectElement[]): ElementRegistry {
  const map = new Map<string, RegistryEntry>();
  for (const element of elements) {
    map.set(element.id, { element, trace: freshTrace(0) });
  }
  return {
    get entries() {
      return [...map.values()];
    },
    get: (id: string) => map.get(id),
    create: () => "",
    ensure: () => {},
    updateTrace: () => {},
    update: () => {},
    remove: () => {},
  } as unknown as ElementRegistry;
}

function renderPanel(elements: ProjectElement[], count = 100) {
  const api = { updateParameters: vi.fn() };
  const props = {
    params: { elementId: "t1", mode: "chronological" },
    api,
  } as unknown as Parameters<typeof TracePanel>[0];
  // One registry instance across re-renders so the trace element (and
  // its window) survive a simulated window growth.
  const registry = makeRegistry(elements);
  const tree = (c: number) => (
    <TraceDataContext.Provider value={{ ...traceData, count: c }}>
      <ProjectContext.Provider value={projectCtx}>
        <ElementRegistryContext.Provider value={registry}>
          <TracePanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>
    </TraceDataContext.Provider>
  );
  const { rerender } = render(tree(count));
  return { grow: (c: number) => rerender(tree(c)) };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const traceAndFilter: ProjectElement[] = [
  { kind: "trace", id: "t1", sources: ["f1"] } as ProjectElement,
  {
    kind: "filter",
    id: "f1",
    sources: ["*"],
    predicate: { id_list: [256] },
  } as ProjectElement,
];

describe("TracePanel chronological filtering", () => {
  it("pages the window through fetch_filtered_trace with the resolved predicate", async () => {
    renderPanel(traceAndFilter);
    // A freshly-started trace follows live, so the panel asks for the
    // tail page (`fromEnd`) and the running total in one call.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("fetch_filtered_trace", {
        filter: { id_list: [256] },
        scanStart: 0,
        scanEnd: 100,
        offset: 0,
        limit: 512,
        fromEnd: true,
      }),
    );
  });

  it("does not filter-fetch when the trace fans in from every bus", () => {
    // `sources=["*"]` → no predicate → the cheap shared chunk cache is
    // used; the panel itself issues no `fetch_filtered_trace`.
    renderPanel([{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("re-pages the tail as the trace window grows", async () => {
    const { grow } = renderPanel(traceAndFilter, 100);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "fetch_filtered_trace",
        expect.objectContaining({ scanEnd: 100, fromEnd: true }),
      ),
    );
    grow(150);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "fetch_filtered_trace",
        expect.objectContaining({ scanEnd: 150, fromEnd: true }),
      ),
    );
  });
});
