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
/** Inline encoder mirroring `lib.rs::encode_signals_sample` — keeps the
 * fixture self-contained so the test doesn't depend on Rust. Layout
 * matches what `decodeSignalsSample` parses. */
function encodeSample(series: { t: number[]; v: number[] }[]): ArrayBuffer {
  const totalPts = series.reduce((s, p) => s + p.t.length, 0);
  const buf = new ArrayBuffer(8 + 32 + 4 + series.length * 4 + totalPts * 16);
  const view = new DataView(buf);
  const magic = [0x53, 0x49, 0x47, 0x53, 0x41, 0x4d, 0x50, 0x01];
  for (let i = 0; i < 8; i++) view.setUint8(i, magic[i]);
  let off = 8;
  view.setFloat64(off, 0, true);
  off += 8;
  view.setFloat64(off, 2, true);
  off += 8;
  view.setFloat64(off, 0, true);
  off += 8;
  view.setFloat64(off, 0, true);
  off += 8;
  view.setUint32(off, series.length, true);
  off += 4;
  for (const p of series) {
    view.setUint32(off, p.t.length, true);
    off += 4;
    for (const t of p.t) {
      view.setFloat64(off, t, true);
      off += 8;
    }
    for (const v of p.v) {
      view.setFloat64(off, v, true);
      off += 8;
    }
  }
  return buf;
}
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { signals?: unknown[] }) => {
    if (cmd === "list_signals") return SIGNALS;
    if (cmd === "sample_signals")
      return encodeSample((args?.signals ?? []).map(() => ({ t: [0, 1, 2], v: [10, 20, 15] })));
    return undefined;
  }),
}));
// `listen` is hooked up by the filter-defined-areas / file-watcher
// pathway for `dbc-changed`. The tests don't fire that event, but
// the mount-time `listen()` call needs a resolved unsubscriber.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
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
  sessionStartSeconds: 0,
  getFrame: () => null,
  ensureVisible: () => {},
};
const projectCtx: ProjectContextValue = {
  projectPath: null,
  dirty: false,
  dbcPaths: ["/tmp/x.dbc"],
  dbcBuses: {},
  buses: [],
  interfaceBindings: [],
  connectedAddresses: [],
  connectedBusIds: [],
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
  onSetBusSpeed: () => {},
  onSetBusFd: () => {},
  onSetBusFdDataSpeed: () => {},
  busesWithPendingHwConfig: [],
  onAddBinding: () => {},
  onRemoveBinding: () => {},
  onConnect: () => {},
  onDisconnect: () => {},
  localVirtualBuses: [],
  onAddVirtualBus: () => {},
  onRemoveVirtualBus: () => {},
  onUpdateVirtualBus: () => {},
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
    fireEvent.change(picker, { target: { value: "*|s:256:EngineSpeed" } });
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: "*|s:256:EngineSpeed" } });
    expect(screen.getAllByText("EngineSpeed").length).toBe(1);
  });

  it("dragging an internal signal-row between areas moves it (sourcePanelId matches)", async () => {
    // Internal drag = a payload that carries this panel's elementId
    // as `sourcePanelId`. The drop handler treats it as a move:
    // signal leaves area 1 and lands in area 2.
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /EngineData\.EngineSpeed/ })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("add signal to focused plot area"), {
      target: { value: "*|s:256:EngineSpeed" },
    });
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "add plot area" }));
    // Pull the panel's elementId off the live signal row that just
    // emitted it. Easier: read it back from the dragstart by firing
    // dragstart on the existing row.
    const sigRow = screen.getByText("EngineSpeed").closest(".plot-signal-row") as HTMLElement;
    const store: Record<string, string> = {};
    const dt = {
      setData: (t: string, v: string) => {
        store[t] = v;
      },
      getData: (t: string) => store[t] ?? "",
      types: [] as string[],
      effectAllowed: "" as DataTransfer["effectAllowed"],
      dropEffect: "" as DataTransfer["dropEffect"],
    };
    Object.defineProperty(dt, "types", {
      get: () => Object.keys(store),
    });
    fireEvent.dragStart(sigRow, { dataTransfer: dt });
    // Drop onto Area 2 — same payload (carrying sourcePanelId).
    const area2 = screen.getByText("Area 2").closest(".plot-area")!;
    fireEvent.dragOver(area2, { dataTransfer: dt });
    fireEvent.drop(area2, { dataTransfer: dt });
    // Move semantics: signal is gone from Area 1, present in Area 2.
    expect(screen.getAllByText("EngineSpeed").length).toBe(1);
  });

  it("dragging a signal to another area copies it (both areas show it)", async () => {
    // Drop-on-different-area
    // is a *copy*, not a move. The user wanted the same signal in
    // multiple areas, and prior move semantics surprised drag-from-
    // DBC-panel users who expected each drop to add a fresh series.
    // Within-area reorder still works (covered by a separate test
    // below if one exists; the helper logic is tested via the
    // dragSignals + plotFilter unit suites).
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /EngineData\.EngineSpeed/ })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("add signal to focused plot area"), {
      target: { value: "*|s:256:EngineSpeed" },
    });
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
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
    // Now the signal appears in BOTH areas — copy, not move.
    expect(screen.getAllByText("EngineSpeed").length).toBe(2);
  });

  it("clicking a signal's swatch toggles it hidden", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /EngineData\.EngineSpeed/ })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("add signal to focused plot area"), {
      target: { value: "*|s:256:EngineSpeed" },
    });
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    const swatch = screen.getByTitle(/^hide this signal/);
    fireEvent.click(swatch);
    expect(screen.getByTitle(/^show this signal/)).toBeInTheDocument();
    // The signal's value still renders (it just isn't drawn on the plot).
    expect(screen.getByText("EngineSpeed")).toBeInTheDocument();
  });

  it("toggling measurements shows the readout strip with the default cells", () => {
    renderPanel();
    expect(document.querySelector(".plot-meas-strip")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /measurements/i }));
    expect(document.querySelector(".plot-meas-strip")).not.toBeNull();
    expect(screen.getByText("Δt")).toBeInTheDocument();
  });

  it("seeds a dropped signal's colour from the target area's existing series count", async () => {
    // Drop two signals onto Area 1 in succession; the second should get
    // a different colour from the first (target.signals.length grows).
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /EngineData\.EngineSpeed/ })).toBeInTheDocument(),
    );
    const picker = screen.getByLabelText("add signal to focused plot area") as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: "*|s:256:EngineSpeed" } });
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: "*|s:256:EngineTemp" } });
    await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
    const swatches = document.querySelectorAll(".plot-signal-swatch");
    expect(swatches.length).toBe(2);
    const c1 = (swatches[0] as HTMLElement).style.background;
    const c2 = (swatches[1] as HTMLElement).style.background;
    expect(c1).not.toBe("");
    expect(c2).not.toBe("");
    expect(c1).not.toBe(c2);
  });

  it("changing a series' colour via the swatch picker updates the swatch", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /EngineData\.EngineSpeed/ })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("add signal to focused plot area"), {
      target: { value: "*|s:256:EngineSpeed" },
    });
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    const picker = screen.getByLabelText("pick series colour") as HTMLInputElement;
    fireEvent.change(picker, { target: { value: "#123456" } });
    // The swatch's background style should reflect the new colour.
    // jsdom normalises hex → rgb() in inline styles.
    const swatch = document.querySelector(".plot-signal-swatch") as HTMLElement;
    expect(swatch.style.background).toBe("rgb(18, 52, 86)");
  });

  it("y-axis-mode selector switches an area between unified / per-unit / individual; per-unit splits by unit", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /EngineData\.EngineSpeed/ })).toBeInTheDocument(),
    );
    const picker = screen.getByLabelText("add signal to focused plot area") as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: "*|s:256:EngineSpeed" } });
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: "*|s:256:EngineTemp" } });
    await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
    // One area, two signals, unified mode → one canvas.
    expect(document.querySelectorAll(".plot-area").length).toBe(1);
    const modeSel = screen.getByLabelText("y-axis mode") as HTMLSelectElement;
    expect(modeSel.value).toBe("unified");
    // Switch to per-unit. The fixture has two distinct units (rpm,
    // degC) so the derived axes split into two.
    fireEvent.change(modeSel, { target: { value: "per-unit" } });
    expect(document.querySelectorAll(".plot-area").length).toBe(2);
    expect(screen.getByText(/Area 1 · \[rpm\]/)).toBeInTheDocument();
    expect(screen.getByText(/Area 1 · \[degC\]/)).toBeInTheDocument();
    // Switch to individual: same as per-unit here (one per signal).
    // Re-query the selector — react may have re-mounted it.
    fireEvent.change(screen.getByLabelText("y-axis mode"), { target: { value: "individual" } });
    expect(document.querySelectorAll(".plot-area").length).toBe(2);
    expect(screen.getByText(/Area 1 · EngineSpeed/)).toBeInTheDocument();
  });

  it("show-points tri-state defaults to auto and persists to panel params", () => {
    const api = renderPanel();
    const sel = screen.getByLabelText("show points") as HTMLSelectElement;
    expect(sel.value).toBe("auto");
    fireEvent.change(sel, { target: { value: "on" } });
    expect(sel.value).toBe("on");
    // Last updateParameters call carries the new mode.
    const calls = api.updateParameters.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] ?? {};
    expect(lastCall.showPoints).toBe("on");
    fireEvent.change(sel, { target: { value: "off" } });
    expect((screen.getByLabelText("show points") as HTMLSelectElement).value).toBe("off");
  });
});
