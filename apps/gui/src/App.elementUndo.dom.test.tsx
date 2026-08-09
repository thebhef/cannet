// @vitest-environment jsdom
//
// Element-registry undo/redo against the REAL App: a view change made
// inside a panel (the trace panel's mode toggle) reversed by actual
// Ctrl+Z / Ctrl+Y, and interleaved with a layout step so one chord
// always reverses the most recent change. Tauri IPC mocked, dockview
// real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "fetch_system_log":
      case "fetch_notes":
      case "fetch_trace_range":
      case "list_transmit_frames":
      case "list_signals":
      case "rbs_dirty":
        return [];
      case "fetch_filtered_trace":
      case "fetch_by_id_page":
        return { count: 0, start: 0, rows: [] };
      case "app_version":
        return "0.0.0-test";
      case "get_sidecar_status":
        return { phase: "offline", address: null };
      default:
        return null;
    }
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    const arr = listeners.get(event) ?? [];
    arr.push(handler);
    listeners.set(event, arr);
    return () => {
      const a = listeners.get(event) ?? [];
      const i = a.indexOf(handler);
      if (i >= 0) a.splice(i, 1);
    };
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    onResized: async () => () => {},
    setTitle: async () => {},
    isMaximized: async () => false,
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    destroy: async () => {},
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

vi.mock("uplot", () => {
  class FakeUPlot {
    over = document.createElement("div");
    scales = { x: {}, y: {} };
    data: unknown = [[]];
    width = 600;
    constructor(_opts: unknown, data: unknown, el: HTMLElement) {
      this.data = data;
      el.appendChild(document.createElement("canvas"));
    }
    setData() {}
    setScale() {}
    setSeries() {}
    setSelect() {}
    setSize() {}
    redraw() {}
    destroy() {}
    posToVal() {
      return 0;
    }
    valToPos() {
      return 0;
    }
  }
  return { default: FakeUPlot };
});
vi.mock("uplot/dist/uPlot.min.css", () => ({}));

// The graph panel is where a filter is inserted upstream of a view.
// `@xyflow/react` imports CSS vitest can't parse, so stub it — but
// render each node through its `nodeTypes` component and each edge as a
// marker, because the node buttons and the wiring are exactly what this
// file drives and asserts on.
vi.mock("@xyflow/react", () => {
  const Position = { Left: "left", Right: "right", Top: "top", Bottom: "bottom" } as const;
  const MarkerType = { ArrowClosed: "arrowclosed" } as const;
  const Handle = () => null;
  const Background = () => null;
  const Controls = () => null;
  type FakeNode = { id: string; type: string; data: unknown };
  type FakeEdge = { id: string; source: string; target: string };
  const ReactFlow = ({
    nodes,
    edges,
    nodeTypes,
    children,
  }: {
    nodes?: FakeNode[];
    edges?: FakeEdge[];
    nodeTypes?: Record<string, (p: { id: string; data: unknown }) => React.ReactNode>;
    children?: React.ReactNode;
  }) => (
    <div data-testid="reactflow">
      {(nodes ?? []).map((n) => {
        const Node = nodeTypes?.[n.type];
        return Node ? <Node key={n.id} id={n.id} data={n.data} /> : null;
      })}
      {(edges ?? []).map((e) => (
        <div key={e.id} className="rf-edge" data-source={e.source} data-target={e.target} />
      ))}
      {children}
    </div>
  );
  const ReactFlowProvider = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const applyNodeChanges = (_changes: unknown, nodes: unknown) => nodes;
  const applyEdgeChanges = (_changes: unknown, edges: unknown) => edges;
  return {
    Position,
    MarkerType,
    Handle,
    Background,
    Controls,
    ReactFlow,
    ReactFlowProvider,
    applyNodeChanges,
    applyEdgeChanges,
  };
});
vi.mock("@xyflow/react/dist/style.css", () => ({}));

import { StrictMode } from "react";
import { invoke } from "@tauri-apps/api/core";

import { App } from "./App";
import { hydrateState } from "./hostState";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
}

/// The trace panel's selected view mode, as its toolbar shows it.
function traceMode(): string {
  return Array.from(document.querySelectorAll(".trace-panel .mode-toggle button.active"))
    .map((b) => b.textContent?.replace(/\s+/g, " ").trim())
    .join();
}

/// Click one of the trace panel's mode buttons.
function clickMode(label: string): void {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".trace-panel .mode-toggle button"),
  ).find((b) => b.textContent?.replace(/\s+/g, " ").trim() === label);
  if (!btn) throw new Error(`mode button "${label}" not found`);
  fireEvent.click(btn);
}

const key = (init: KeyboardEventInit) => {
  fireEvent.keyDown(document.activeElement ?? document.body, init);
};

/// One row of the project panel's Elements inventory, by display name.
function elementRow(name: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>(".project-element")).find(
    (r) => r.querySelector<HTMLInputElement>("input")?.value === name,
  );
  if (!row) throw new Error(`no element row named "${name}"`);
  return row;
}

/// The open panels, by tab title. A panel renders only while it is the
/// visible one in its group, so this — not the panel's own DOM — is what
/// says whether a panel is open.
function tabTitles(): string[] {
  return Array.from(document.querySelectorAll(".dv-tab")).map((t) => t.textContent ?? "");
}

/// A button inside `root`, by label.
function buttonIn(root: ParentNode, label: string): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
}

/// The host calls App's RBS reconciler has made so far — the ones that
/// load, unload, or arm a simulation. Nothing about undo may add to
/// this list (ADR 0050).
function rbsHostCalls(): string[] {
  return vi
    .mocked(invoke)
    .mock.calls.map(([cmd]) => cmd)
    .filter((cmd) => ["rbs_init", "rbs_load", "rbs_unload", "rbs_set_run"].includes(cmd));
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountApp() {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
}

describe("element undo", () => {
  it("reverses a view change made inside a panel, and redoes it", async () => {
    await mountApp();
    // The seeded trace view opens by-ID; switching it writes the
    // element's config, which is what the history records.
    expect(traceMode()).toBe("by ID");
    await act(async () => {
      clickMode("trace");
    });
    expect(traceMode()).toBe("trace");

    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    // The panel repaints from the restored element (the rehydrate path).
    await waitFor(() => {
      if (traceMode() !== "by ID") throw new Error(`undo left mode "${traceMode()}"`);
    });

    await act(async () => {
      key({ key: "y", ctrlKey: true });
    });
    await waitFor(() => {
      if (traceMode() !== "trace") throw new Error(`redo left mode "${traceMode()}"`);
    });
  }, 30_000);

  it("adding a panel is one step — the panel's own config seed is not another", async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(findButton("Add plot panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("no plot panel yet");
    });
    // One chord, and the added panel is gone: the config the panel
    // persisted as it mounted must not have consumed the first undo.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (document.querySelector(".plot-panel"))
        throw new Error("plot panel still present after one undo");
    });
  }, 30_000);

  it("undoes the most recent change, whichever stack it lives on", async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(findButton("Add plot panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("no plot panel yet");
    });
    await act(async () => {
      clickMode("trace");
    });
    expect(traceMode()).toBe("trace");

    // Newest first: the view change, then the panel that preceded it.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (traceMode() !== "by ID") throw new Error(`undo left mode "${traceMode()}"`);
    });
    expect(document.querySelector(".plot-panel")).not.toBeNull();

    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (document.querySelector(".plot-panel"))
        throw new Error("plot panel still present after the second undo");
    });
    expect(traceMode()).toBe("by ID");

    // And back out again, oldest-undone first.
    await act(async () => {
      key({ key: "y", ctrlKey: true });
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("plot panel not restored");
    });
    expect(traceMode()).toBe("by ID");
    await act(async () => {
      key({ key: "y", ctrlKey: true });
    });
    await waitFor(() => {
      if (traceMode() !== "trace") throw new Error(`redo left mode "${traceMode()}"`);
    });
  }, 30_000);

  it("brings back a removed element and its panel in one chord", async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(findButton("Add plot panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("no plot panel yet");
    });
    // A view change, so the element carries state the restore has to
    // bring back with it.
    await act(async () => {
      fireEvent.click(findButton("add plot area"));
    });
    await waitFor(() => {
      if (document.querySelectorAll(".plot-panel .plot-area").length !== 2)
        throw new Error("second area not added");
    });

    // Remove the element: the registry loses it and its panel closes —
    // one gesture across both stacks.
    await act(async () => {
      fireEvent.click(findButton("Project panel"));
    });
    await act(async () => {
      fireEvent.click(buttonIn(elementRow("Plot 1"), "Remove"));
    });
    expect(tabTitles()).not.toContain("Plot 1");
    expect(() => elementRow("Plot 1")).toThrow();


    // One chord returns both halves, and the panel repaints from the
    // re-created element rather than from a fresh default.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (!tabTitles().includes("Plot 1")) throw new Error("panel did not come back");
    });
    // Both halves: the element is back in the inventory, and its panel
    // repaints from the re-created element rather than from a fresh
    // default — two areas, not one.
    await act(async () => {
      fireEvent.click(buttonIn(elementRow("Plot 1"), "Focus"));
    });
    await waitFor(() => {
      const areas = document.querySelectorAll(".plot-panel .plot-area").length;
      if (areas !== 2) throw new Error(`undo left ${areas} areas`);
    });

    // And redo takes both halves away again.
    await act(async () => {
      key({ key: "y", ctrlKey: true });
    });
    await waitFor(() => {
      if (tabTitles().includes("Plot 1")) throw new Error("redo left the panel open");
    });
    await act(async () => {
      fireEvent.click(findButton("Project panel"));
    });
    expect(() => elementRow("Plot 1")).toThrow();
  }, 30_000);

  it("inserting a filter upstream is one step — the filter goes with it", async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(findButton("Graph panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".graph-node-trace")) throw new Error("no trace node yet");
    });
    expect(document.querySelectorAll(".graph-node-filter")).toHaveLength(0);

    // Three registry writes and a new element, from one click.
    await act(async () => {
      fireEvent.click(
        document.querySelector<HTMLButtonElement>(".graph-node-trace .graph-node-insert-filter")!,
      );
    });
    await waitFor(() => {
      if (document.querySelectorAll(".graph-node-filter").length !== 1)
        throw new Error("filter node not created");
    });
    // The trace now reads through the filter.
    expect(document.querySelectorAll(".rf-edge")).toHaveLength(1);

    // One chord takes the filter away *and* puts the trace's sources
    // back — creation joins the gesture's step.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      const filters = document.querySelectorAll(".graph-node-filter").length;
      if (filters !== 0) throw new Error(`undo left ${filters} filter nodes`);
    });
    expect(document.querySelectorAll(".rf-edge")).toHaveLength(0);

    // And redo puts the whole insert back.
    await act(async () => {
      key({ key: "y", ctrlKey: true });
    });
    await waitFor(() => {
      if (document.querySelectorAll(".graph-node-filter").length !== 1)
        throw new Error("redo did not restore the filter");
    });
    expect(document.querySelectorAll(".rf-edge")).toHaveLength(1);
  }, 30_000);

  it("adding a filter from the graph toolbar is undoable on its own", async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(findButton("Graph panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".graph-panel")) throw new Error("no graph panel yet");
    });
    await act(async () => {
      fireEvent.click(findButton("+ filter"));
    });
    await waitFor(() => {
      if (document.querySelectorAll(".graph-node-filter").length !== 1)
        throw new Error("filter not created");
    });
    // A bare filter has no panel, so nothing on the layout stack would
    // reverse it; the element stack has to — and the chord must not
    // fall through to the layout step that opened this panel.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (document.querySelectorAll(".graph-node-filter").length !== 0)
        throw new Error("undo left the filter");
    });
    expect(document.querySelector(".graph-panel")).not.toBeNull();
  }, 30_000);

  it("never replays a behavior field, and never wakes the host reconciler", async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(findButton("Add RBS panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".rbs-panel")) throw new Error("no RBS panel yet");
    });
    const runBox = () =>
      document.querySelector<HTMLInputElement>(".rbs-run-toggle input[type=checkbox]")!;

    // A view change (undoable) …
    await act(async () => {
      clickMode("trace");
    });
    expect(traceMode()).toBe("trace");
    // … then a bus-facing one (never undoable): arm the simulation.
    await act(async () => {
      fireEvent.click(runBox());
    });
    await waitFor(() => {
      if (!runBox().checked) throw new Error("run flag did not take");
    });
    const armed = rbsHostCalls();
    expect(armed).toContain("rbs_set_run");

    // The chord steps straight past the run flag to the view change:
    // arming the simulation was not a step, so it cannot be undone.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (traceMode() !== "by ID") throw new Error(`undo left mode "${traceMode()}"`);
    });
    expect(runBox().checked).toBe(true);
    expect(rbsHostCalls()).toEqual(armed);

    // Same on the way back out.
    await act(async () => {
      key({ key: "y", ctrlKey: true });
    });
    await waitFor(() => {
      if (traceMode() !== "trace") throw new Error(`redo left mode "${traceMode()}"`);
    });
    expect(runBox().checked).toBe(true);
    expect(rbsHostCalls()).toEqual(armed);
  }, 30_000);
});
