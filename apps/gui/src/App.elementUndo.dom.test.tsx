// @vitest-environment jsdom
//
// Element-registry undo/redo against the REAL App: a view change made
// inside a panel (the trace panel's mode toggle) reversed by actual
// Ctrl+Z / Ctrl+Y, and interleaved with a layout step so one chord
// always reverses the most recent change. Tauri IPC mocked, dockview
// real.
//
// Also the transaction cases — one user gesture, one chord, however many
// writes and whichever stacks it took: adding a panel, removing an
// element (its panel comes back with it), dragging a plot area between
// panels, inserting a filter upstream, and the drags of persisted knobs
// that used to cost one undo per mouse move.

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
      case "list_dbc_content":
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

/// How many plot areas each mounted plot panel is showing, in DOM
/// order.
function areaCounts(): number[] {
  return Array.from(document.querySelectorAll(".plot-panel")).map(
    (p) => p.querySelectorAll(".plot-area").length,
  );
}

/// One `DataTransfer` stand-in for a plot-area drag: `dragStart` writes
/// the area onto it and the drop reads it back, so every event in the
/// gesture must be handed the same object.
function areaDragTransfer() {
  const store = new Map<string, string>();
  const types: string[] = [];
  return {
    types,
    setData(t: string, v: string) {
      store.set(t, v);
      if (!types.includes(t)) types.push(t);
    },
    getData: (t: string) => store.get(t) ?? "",
    dropEffect: "",
    effectAllowed: "",
  };
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

  it("returns a plot area dragged between two panels in one chord", async () => {
    await mountApp();
    // Two plot panels in two different dockview groups, so both stay
    // rendered — a panel only renders while it is the visible one in
    // its group, and a cross-panel drag needs both ends alive.
    await act(async () => {
      fireEvent.click(findButton("Add plot panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("no plot panel yet");
    });
    await act(async () => {
      fireEvent.click(findButton("add plot area"));
    });
    // Send the next panel to the trace's group instead: bring the
    // project panel forward, focus the trace from its inventory, then
    // add — a new panel joins whichever group is active.
    await act(async () => {
      fireEvent.click(findButton("Project panel"));
    });
    await act(async () => {
      fireEvent.click(buttonIn(elementRow("Trace 1"), "Focus"));
    });
    await act(async () => {
      fireEvent.click(findButton("Add plot panel"));
    });
    await act(async () => {
      fireEvent.click(buttonIn(elementRow("Plot 1"), "Focus"));
    });
    await waitFor(() => {
      if (document.querySelectorAll(".plot-panel").length !== 2)
        throw new Error("second plot panel not in its own group");
    });
    expect(areaCounts()).toEqual([2, 1]);

    // Move the second panel's only area onto the first panel's stack.
    const dt = areaDragTransfer();
    const grips = Array.from(
      document.querySelectorAll<HTMLElement>(".plot-panel"),
    )[1].querySelectorAll<HTMLElement>('[aria-label="reorder plot area"]');
    await act(async () => {
      fireEvent.dragStart(grips[0], { dataTransfer: dt });
      const target = document.querySelectorAll<HTMLElement>(".plot-panel")[0].querySelector(
        ".plot-area",
      )!;
      fireEvent.dragOver(target, { dataTransfer: dt });
      fireEvent.drop(target, { dataTransfer: dt });
    });
    // The area landed, and the panel that gave it up kept a fresh empty
    // one (a plot panel always shows at least one area).
    await waitFor(() => {
      const counts = areaCounts();
      if (counts[0] !== 3) throw new Error(`drop left ${JSON.stringify(counts)}`);
    });

    // One chord: two panels' configs, one gesture, one step.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      const counts = areaCounts();
      if (counts[0] !== 2 || counts[1] !== 1) throw new Error(`undo left ${JSON.stringify(counts)}`);
    });
  }, 30_000);

  it("a drag of the side-panel splitter is one step, not one per mouse move", async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(findButton("Add plot panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("no plot panel yet");
    });
    const sidePanelWidth = () =>
      parseFloat(
        document.querySelector<HTMLElement>(".plot-panel .plot-area-signals")!.style.flexBasis,
      );
    const before = sidePanelWidth();

    // Three moves left of the resizer: the side panel is right of the
    // canvas, so each one widens it.
    await act(async () => {
      fireEvent.mouseDown(document.querySelector(".plot-panel .plot-area-resizer")!, {
        clientX: 500,
      });
    });
    for (const clientX of [480, 460, 440]) {
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX }));
      });
    }
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(sidePanelWidth()).toBe(before + 60);

    // One chord takes the whole drag back — not its last mouse move.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      const width = sidePanelWidth();
      if (width !== before) throw new Error(`undo left the side panel at ${width}`);
    });
  }, 30_000);

  it("a drag of an axis splitter is one step", async () => {
    // jsdom measures everything as zero, and the splitter shifts weight
    // by measured pixels — give the two areas a height, leave the rest
    // of the document as jsdom already reports it.
    const zero = { height: 0, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    const rect = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        return this.classList?.contains("plot-area") ? { ...zero, height: 200 } : zero;
      });
    try {
      await mountApp();
      await act(async () => {
        fireEvent.click(findButton("Add plot panel"));
      });
      await waitFor(() => {
        if (!document.querySelector(".plot-panel")) throw new Error("no plot panel yet");
      });
      await act(async () => {
        fireEvent.click(findButton("add plot area"));
      });
      await waitFor(() => {
        if (!document.querySelector(".plot-area-splitter")) throw new Error("no splitter yet");
      });
      const weights = () =>
        Array.from(document.querySelectorAll<HTMLElement>(".plot-panel .plot-area")).map((a) =>
          parseFloat(a.style.flexGrow),
        );
      expect(weights()).toEqual([1, 1]);

      await act(async () => {
        fireEvent.mouseDown(document.querySelector(".plot-area-splitter")!, { clientY: 0 });
      });
      for (const clientY of [25, 50]) {
        await act(async () => {
          window.dispatchEvent(new MouseEvent("mousemove", { clientY }));
        });
      }
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mouseup"));
      });
      expect(weights()[0]).toBeCloseTo(1.25);

      // One chord, and the pair is even again — the intermediate mouse
      // moves are not steps of their own.
      await act(async () => {
        key({ key: "z", ctrlKey: true });
      });
      await waitFor(() => {
        const w = weights();
        if (w[0] !== 1 || w[1] !== 1) throw new Error(`undo left weights ${JSON.stringify(w)}`);
      });
    } finally {
      rect.mockRestore();
    }
  }, 30_000);

  it("a drag of a trace column edge is one step", async () => {
    await mountApp();
    const template = () =>
      document.querySelector<HTMLElement>(".trace-panel .trace-header")!.style.gridTemplateColumns;
    const before = template();
    const handle = document.querySelector<HTMLElement>(".trace-panel .col-resize-handle")!;
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};

    await act(async () => {
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    });
    for (const clientX of [110, 120, 130]) {
      await act(async () => {
        fireEvent.pointerMove(handle, { clientX, pointerId: 1 });
      });
    }
    await act(async () => {
      fireEvent.pointerUp(handle, { clientX: 130, pointerId: 1 });
    });
    expect(template()).not.toBe(before);

    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (template() !== before) throw new Error(`undo left columns at ${template()}`);
    });
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

  it("a typed rename is one step, not one per keystroke", async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(findButton("Project panel"));
    });
    const input = elementRow("Trace 1").querySelector<HTMLInputElement>("input")!;

    // Type a new name a character at a time, exactly as the inline
    // rename writes it: one registry write per keystroke.
    await act(async () => {
      fireEvent.focus(input);
    });
    for (const value of ["F", "Fu", "Fue", "Fuel"]) {
      await act(async () => {
        fireEvent.change(input, { target: { value } });
      });
    }
    expect(elementRow("Fuel")).toBeTruthy();
    await act(async () => {
      fireEvent.blur(input);
    });

    // One chord takes the whole edit back — not its last keystroke.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      elementRow("Trace 1"); // throws while the row is named anything else
    });

    // And redo puts the whole name back, also in one chord.
    await act(async () => {
      key({ key: "y", ctrlKey: true });
    });
    await waitFor(() => {
      elementRow("Fuel");
    });
  }, 30_000);

  it("typing in a find box is not a step", async () => {
    // Params-only view state (a find box, the DBC panel's expanded set)
    // stays out of undo: it never reaches the element, and the layout
    // history scrubs `params`.
    await mountApp();
    await act(async () => {
      fireEvent.click(findButton("DBC panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".dbc-panel")) throw new Error("no DBC panel yet");
    });
    await act(async () => {
      clickMode("trace");
    });
    expect(traceMode()).toBe("trace");

    const search = document.querySelector<HTMLInputElement>("input.dbc-panel-search")!;
    await act(async () => {
      fireEvent.change(search, { target: { value: "engine" } });
    });
    expect(search.value).toBe("engine");

    // The first chord reaches straight past the typing to the view
    // change, and the box keeps what was typed into it.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (traceMode() !== "by ID") throw new Error(`undo left mode "${traceMode()}"`);
    });
    expect(document.querySelector<HTMLInputElement>("input.dbc-panel-search")!.value).toBe(
      "engine",
    );
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
