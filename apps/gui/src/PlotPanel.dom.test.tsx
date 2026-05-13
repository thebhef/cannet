// @vitest-environment jsdom
//
// Component tests for the plot panel's React state machine — area
// add/remove, picking signals into the focused area, toggling
// measurements. uPlot and the Tauri `invoke` bridge are mocked, so this
// exercises the panel's behaviour without a real canvas or backend.
// (The pixel-level overlay drawing and the canvas click→cursor wiring
// are out of reach here; the cursor/measurement *maths* are covered by
// plotCursors.test.ts and the decimation by the Rust signal_sampler
// tests.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("uplot", () => {
  class FakeUPlot {
    over = document.createElement("div");
    scales = { x: {}, y: {} } as Record<string, { min?: number; max?: number }>;
    data: unknown = [[]];
    width = 600;
    constructor(_opts: unknown, data: unknown, el: HTMLElement) {
      this.data = data;
      el.appendChild(document.createElement("canvas"));
    }
    setData(d: unknown) {
      this.data = d;
    }
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

const SIGNALS = [
  { message_id: 256, extended: false, message_name: "EngineData", signal_name: "EngineSpeed", unit: "rpm" },
  { message_id: 256, extended: false, message_name: "EngineData", signal_name: "EngineTemp", unit: "degC" },
];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { signals?: unknown[] }) => {
    if (cmd === "list_signals") return SIGNALS;
    if (cmd === "sample_signals")
      return {
        from_seconds: 0,
        last_seconds: 2,
        series: (args?.signals ?? []).map(() => ({ t: [0, 1, 2], v: [10, 20, 15] })),
      };
    return undefined;
  }),
}));

import { PlotPanel } from "./PlotPanel";
import { TraceDataContext, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ElementRegistryContext, type ElementRegistry } from "./projectElements";
import { freshTrace } from "./trace";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// A throwaway element registry: PlotPanel only uses `ensure` (to
// register its element) and, via `useTrace`, `get` / `updateTrace`.
type TS = ReturnType<typeof freshTrace>;
type Entry = { element: { kind: "plot"; id: string }; trace: TS };
function makeRegistry(): ElementRegistry {
  const map = new Map<string, Entry>();
  const entry = (id: string): Entry => ({ element: { kind: "plot", id }, trace: freshTrace(0) });
  return {
    get entries() {
      return [...map.values()];
    },
    get: (id: string) => map.get(id),
    create: () => {
      const id = Math.random().toString(36).slice(2);
      map.set(id, entry(id));
      return id;
    },
    ensure: (id: string) => {
      if (!map.has(id)) map.set(id, entry(id));
    },
    updateTrace: (id: string, updater: (s: TS) => TS) => {
      const e = map.get(id);
      if (e) map.set(id, { ...e, trace: updater(e.trace) });
    },
    remove: (id: string) => {
      map.delete(id);
    },
  } as unknown as ElementRegistry;
}

const traceData: TraceData = {
  count: 100,
  version: 1,
  baseTimestampSeconds: 0,
  getFrame: () => null,
  ensureVisible: () => {},
};
const projectCtx: ProjectContextValue = {
  projectPath: null,
  dirty: false,
  dbcPath: "/tmp/x.dbc",
  remoteAddress: "127.0.0.1:50051",
  remoteConnected: false,
  blfPath: null,
  onNewProject: () => {},
  onOpenProject: () => {},
  onSaveProject: () => {},
  onSaveProjectAs: () => {},
  onReloadDbc: () => {},
  onConnect: () => {},
  onDisconnect: () => {},
};

function renderPanel() {
  const api = { updateParameters: vi.fn() };
  const props = { params: {}, api } as unknown as Parameters<typeof PlotPanel>[0];
  render(
    <TraceDataContext.Provider value={traceData}>
      <ProjectContext.Provider value={projectCtx}>
        <ElementRegistryContext.Provider value={makeRegistry()}>
          <PlotPanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>
    </TraceDataContext.Provider>,
  );
  return api;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PlotPanel", () => {
  it("starts with one plot area; cursors & measurements default off", () => {
    renderPanel();
    expect(screen.getByText("Area 1")).toBeInTheDocument();
    expect(screen.queryByText("Area 2")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "add plot area" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "fit data" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /measurements/i })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /follow live/i })).toBeChecked();
    expect(document.querySelector(".plot-meas-strip")).toBeNull();
  });

  it("adds plot areas and exposes a remove affordance per area when >1", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "add plot area" }));
    expect(screen.getByText("Area 2")).toBeInTheDocument();
    expect(screen.getAllByTitle("remove this plot area").length).toBe(2);
    // Removing one returns to a single, non-removable area.
    fireEvent.click(screen.getAllByTitle("remove this plot area")[1]);
    expect(screen.queryByText("Area 2")).not.toBeInTheDocument();
    expect(screen.queryAllByTitle("remove this plot area").length).toBe(0);
  });

  it("picks a signal into the focused area; a repeat pick is a no-op", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /EngineData\.EngineSpeed/ })).toBeInTheDocument(),
    );
    const picker = screen.getByLabelText("add signal to focused plot area") as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: "s:256:EngineSpeed" } });
    await waitFor(() => expect(screen.getByText("EngineData.EngineSpeed")).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: "s:256:EngineSpeed" } });
    expect(screen.getAllByText("EngineData.EngineSpeed").length).toBe(1);
  });

  it("a picked signal can be dragged to another area", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /EngineData\.EngineSpeed/ })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("add signal to focused plot area"), {
      target: { value: "s:256:EngineSpeed" },
    });
    await waitFor(() => expect(screen.getByText("EngineData.EngineSpeed")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "add plot area" }));
    // Drop the signal onto Area 2. The drag payload is the full SignalRef.
    const MIME = "application/x-cannet-plot-signal";
    const payload = JSON.stringify({
      messageId: 256,
      extended: false,
      signalName: "EngineSpeed",
      messageName: "EngineData",
      unit: "rpm",
    });
    const dt = { types: [MIME], getData: (t: string) => (t === MIME ? payload : ""), dropEffect: "" };
    const area2 = screen.getByText("Area 2").closest(".plot-area")!;
    fireEvent.dragOver(area2, { dataTransfer: dt });
    fireEvent.drop(area2, { dataTransfer: dt });
    // Still exactly one occurrence of the signal — it just lives in Area 2 now.
    expect(screen.getAllByText("EngineData.EngineSpeed").length).toBe(1);
  });

  it("clicking a signal's swatch toggles it hidden", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /EngineData\.EngineSpeed/ })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("add signal to focused plot area"), {
      target: { value: "s:256:EngineSpeed" },
    });
    await waitFor(() => expect(screen.getByText("EngineData.EngineSpeed")).toBeInTheDocument());
    const swatch = screen.getByTitle("hide this signal");
    fireEvent.click(swatch);
    expect(screen.getByTitle("show this signal")).toBeInTheDocument();
    // The signal's value still renders (it just isn't drawn on the plot).
    expect(screen.getByText("EngineData.EngineSpeed")).toBeInTheDocument();
  });

  it("toggling measurements shows the readout strip with the default cells", () => {
    renderPanel();
    expect(document.querySelector(".plot-meas-strip")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /measurements/i }));
    expect(document.querySelector(".plot-meas-strip")).not.toBeNull();
    expect(screen.getByText("Δt")).toBeInTheDocument();
  });
});
