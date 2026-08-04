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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "fetch_filtered_trace" || cmd === "fetch_by_id_page") {
      return { count: 0, start: 0, rows: [] };
    }
    return [];
  }),
}));
// The panel subscribes to the cross-panel "goto" bus at mount; the tests
// don't fire it, but `listen()` must resolve to an unsubscriber.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { TracePanel } from "./TracePanel";
import { TraceDataProvider, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import { freshTrace } from "./trace";
import { LIVE_TAIL_ROWS, resetLiveTailDemand } from "./liveTailDemand";
import type { ProjectElement } from "./types";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const traceData: TraceData = {
  count: 100,
  firstIndex: 0,
  truncationTsNs: null,
  sessionStartSeconds: 0,
  epoch: 0,
  fetchRange: async () => [],
  liveTail: { start: 0, rows: [] },
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
  onUpdateBus: () => {},
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
    update: (id: string, patch: Partial<ProjectElement>) => {
      const e = map.get(id);
      if (e) map.set(id, { ...e, element: { ...e.element, ...patch } as ProjectElement });
    },
    remove: () => {},
  } as unknown as ElementRegistry;
}

function renderPanel(elements: ProjectElement[], count = 100, mode = "chronological") {
  const api = { updateParameters: vi.fn() };
  const props = {
    params: { elementId: "t1", mode },
    api,
  } as unknown as Parameters<typeof TracePanel>[0];
  // One registry instance across re-renders so the trace element (and
  // its window) survive a simulated window growth.
  const registry = makeRegistry(elements);
  const tree = (c: number) => (
    <TraceDataProvider value={{ ...traceData, count: c }}>
      <ProjectContext.Provider value={projectCtx}>
        <ElementRegistryContext.Provider value={registry}>
          <TracePanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>
    </TraceDataProvider>
  );
  const { rerender, container } = render(tree(count));
  return { grow: (c: number) => rerender(tree(c)), container, api, registry };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  resetLiveTailDemand();
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

describe("TracePanel live-tail demand", () => {
  /// What the panel last told the host it wants shipped per `trace-grew`.
  const declaredRows = () => {
    const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "set_live_tail_rows");
    return calls.length === 0 ? null : (calls[calls.length - 1][1] as { rows: number }).rows;
  };

  it("asks for a tail only while an unfiltered chronological view follows live", async () => {
    // The host collected and decoded 256 trailing frames on every
    // `trace-grew` regardless of whether anything read them; only this
    // view does.
    renderPanel([{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement]);
    await waitFor(() => expect(declaredRows()).toBe(LIVE_TAIL_ROWS));
  });

  it("withdraws the demand when the view switches to by-id", async () => {
    const { container } = renderPanel([
      { kind: "trace", id: "t1", sources: ["*"] } as ProjectElement,
    ]);
    await waitFor(() => expect(declaredRows()).toBe(LIVE_TAIL_ROWS));
    const byId = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.replace(/\s+/g, " ").trim() === "by ID",
    )!;
    await act(async () => {
      fireEvent.click(byId);
    });
    expect(declaredRows()).toBe(0);
  });

  it("asks for no tail in by-id mode", async () => {
    renderPanel([{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement], 100, "by-id");
    // Give the mount effects a chance to declare something.
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(declaredRows() ?? 0).toBe(0);
  });

  it("asks for no tail when the trace is filtered", async () => {
    // A filtered chronological view pages through `useFilteredTrace`, which
    // has no live-tail overlay — the raw tail would be the wrong rows.
    renderPanel(traceAndFilter);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(declaredRows() ?? 0).toBe(0);
  });
});

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
        // The follow-live tail resumes from the incremental checkpoint; on
        // the first fetch under a descriptor it's the freshly-reset empty
        // count at the window start (so the host counts the window once and
        // seeds the cursor, then later ticks resume in O(Δ)).
        prevCount: 0,
        prevCountEnd: 0,
      }),
    );
  });

  it("does not filter-fetch when the trace fans in from every bus", () => {
    // `sources=["*"]` → no predicate → the cheap shared chunk cache is
    // used; the panel itself issues no `fetch_filtered_trace`.
    renderPanel([{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement]);
    expect(invoke).not.toHaveBeenCalledWith("fetch_filtered_trace", expect.anything());
  });

  it("right-clicking a column header opens the column menu, not the sources picker", () => {
    // Regression: the panel opens its sources context-menu on any
    // right-click. The header's own show/hide-columns menu must stop
    // the event from bubbling, or the sources menu renders over it and
    // the column menu can't be used.
    const { container } = renderPanel(
      [{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement],
      100,
      "by-id",
    );
    const header = container.querySelector(".trace-header");
    expect(header).toBeTruthy();
    fireEvent.contextMenu(header!);
    expect(container.querySelector(".column-context-menu")).toBeInTheDocument();
    expect(document.querySelector(".sources-context-menu")).not.toBeInTheDocument();
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

describe("TracePanel config persistence", () => {
  it("restores config from the element over bare reopen params", () => {
    // Reopened from the Elements list, params carry only `elementId`
    // (+ the default `mode: by-id`); the real setup lives on the
    // element's `config`, which must win.
    const el = {
      kind: "trace",
      id: "t1",
      sources: ["*"],
      config: { mode: "chronological", autoScroll: false },
    } as unknown as ProjectElement;
    const { api } = renderPanel([el], 100, "by-id");
    const calls = api.updateParameters.mock.calls;
    const last = calls[calls.length - 1]?.[0] ?? {};
    expect(last.mode).toBe("chronological");
    expect(last.autoScroll).toBe(false);
  });

  it("mirrors its config onto the element via the registry", () => {
    const { registry } = renderPanel(
      [{ kind: "trace", id: "t1", sources: ["*"] } as ProjectElement],
      100,
      "by-id",
    );
    const cfg = (registry.get("t1")!.element as { config?: { mode?: string } }).config;
    expect(cfg?.mode).toBe("by-id");
  });
});
