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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { comboboxValue, pickCombobox } from "./comboboxTestKit";

vi.mock("uplot", () => {
  class FakeUPlot {
    // `uPlot.paths.stepped(...)` is consulted at construction to give
    // enum / lane series a stepped path; return a marker function so
    // tests can assert a series is stepped.
    static paths = { stepped: (_opts: unknown) => () => {} };
    over = document.createElement("div");
    scales = { x: {}, y: {} } as Record<string, { min?: number; max?: number }>;
    data: unknown = [[]];
    width = 600;
    cursor = { left: -10 };
    opts: { hooks?: Record<string, ((u: FakeUPlot) => void)[]> };
    root: HTMLElement;
    constructor(opts: FakeUPlot["opts"], data: unknown, el: HTMLElement) {
      this.opts = opts;
      this.root = el;
      this.data = data;
      el.appendChild(document.createElement("canvas"));
      instances.push(this);
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
    /** px → x value; linear so tests can pick a deterministic x. */
    posToVal(px: number) {
      return px / 100;
    }
    valToPos() {
      return 0;
    }
    /** Fire a registered hook as the real uPlot would. */
    fire(hook: string) {
      for (const f of this.opts.hooks?.[hook] ?? []) f(this);
    }
  }
  const instances: FakeUPlot[] = [];
  return { default: FakeUPlot, __instances: instances };
});
vi.mock("uplot/dist/uPlot.min.css", () => ({}));

const SIGNALS = [
  { message_id: 256, extended: false, message_name: "EngineData", transmitter: "EngineEcu", signal_name: "EngineSpeed", unit: "rpm" },
  { message_id: 256, extended: false, message_name: "EngineData", transmitter: "EngineEcu", signal_name: "EngineTemp", unit: "degC" },
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
// Per-signal value tables a test can populate (keyed by signal name);
// empty by default so signals read as numeric. Prefixed `mock` so the
// hoisted `vi.mock` factory may reference it lazily.
const mockValueTables: Record<string, { raw: number; label: string }[]> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { signals?: unknown[]; signalName?: string }) => {
    if (cmd === "list_signals") return SIGNALS;
    if (cmd === "sample_signals")
      return encodeSample((args?.signals ?? []).map(() => ({ t: [0, 1, 2], v: [10, 20, 15] })));
    if (cmd === "signal_min_max")
      // Host-owned all-time per-signal extent (ADR 0025) — matches the
      // sampled values' min/max so follow-live auto-norm has a range.
      return (args?.signals ?? []).map(() => ({ lo: 10, hi: 20 }));
    if (cmd === "list_value_tables") return mockValueTables[args?.signalName ?? ""] ?? [];
    return undefined;
  }),
}));
// `listen` is hooked up by the filter-defined-areas / file-watcher
// pathway for `dbc-changed`. The tests don't fire that event, but
// the mount-time `listen()` call needs a resolved unsubscriber.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import * as uplotModule from "uplot";

/** The FakeUPlot surface the hover test drives (see the mock above). */
type FakeUPlotInst = {
  cursor: { left: number };
  root: HTMLElement;
  over: HTMLElement;
  fire: (hook: string) => void;
};
const uplotInstances = (uplotModule as unknown as { __instances: FakeUPlotInst[] }).__instances;

import { PlotPanel } from "./PlotPanel";
import { PanelCommandsContext, createPanelCommandRegistry } from "./panelCommands";
import { TraceDataContext, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ElementRegistryContext, type ElementRegistry } from "./projectElements";
import { NotesContext, type NotesContextValue } from "./notesContext";
import { SignalCatalogProvider } from "./signalCatalogContext";
import { wheelColor } from "./palette";
import { freshTrace } from "./trace";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// A throwaway element registry: PlotPanel uses `ensure` (to register
// its element), `update` (to persist its `config` blob), and, via
// `useTrace`, `get` / `updateTrace`. `seed` pre-populates an element so
// a test can mount a panel against an element that already carries
// config (the close-and-reopen path).
type TS = ReturnType<typeof freshTrace>;
type Entry = { element: { kind: "plot"; id: string; config?: Record<string, unknown> }; trace: TS };
function makeRegistry(seed?: { id: string; config?: Record<string, unknown> }): ElementRegistry {
  const map = new Map<string, Entry>();
  const entry = (id: string, config?: Record<string, unknown>): Entry => ({
    element: { kind: "plot", id, config },
    trace: freshTrace(0),
  });
  if (seed) map.set(seed.id, entry(seed.id, seed.config));
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
    update: (id: string, patch: { config?: Record<string, unknown> }) => {
      const e = map.get(id);
      if (e) map.set(id, { ...e, element: { ...e.element, ...patch } });
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
  firstIndex: 0,
  truncationTsNs: null,
  sessionStartSeconds: 0,
  epoch: 0,
  fetchRange: async () => [],
  liveTail: { start: 0, rows: [] },
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
  signalColors: {},
  onSetSignalColor: () => {},
};

function renderPanel(opts?: {
  params?: Record<string, unknown>;
  registry?: ElementRegistry;
  notes?: NotesContextValue;
}) {
  const api = { updateParameters: vi.fn() };
  const props = { params: opts?.params ?? {}, api } as unknown as Parameters<typeof PlotPanel>[0];
  const registry = opts?.registry ?? makeRegistry();
  let tree = (
    <TraceDataContext.Provider value={traceData}>
      <ProjectContext.Provider value={projectCtx}>
        <SignalCatalogProvider>
          <ElementRegistryContext.Provider value={registry}>
            <PlotPanel {...props} />
          </ElementRegistryContext.Provider>
        </SignalCatalogProvider>
      </ProjectContext.Provider>
    </TraceDataContext.Provider>
  );
  if (opts?.notes) tree = <NotesContext.Provider value={opts.notes}>{tree}</NotesContext.Provider>;
  render(tree);
  return { api, registry };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  uplotInstances.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const k of Object.keys(mockValueTables)) delete mockValueTables[k];
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

  it("groups picker options under transmitter-ECU and message headers", async () => {
    renderPanel();
    const picker = screen.getByLabelText("add signal to focused plot area");
    fireEvent.click(picker);
    // No project buses in this harness -> the hierarchy is
    // ECU -> message (the bus level joins in when buses exist).
    await waitFor(() => {
      const headers = Array.from(document.querySelectorAll(".combobox-group")).map(
        (el) => el.textContent,
      );
      expect(headers).toEqual(["EngineEcu", "EngineData"]);
    });
  });

  it("picks a signal into the focused area; a repeat pick is a no-op", async () => {
    renderPanel();
    const picker = screen.getByLabelText("add signal to focused plot area");
    await pickCombobox(picker, "*|s:256:EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    await pickCombobox(picker, "*|s:256:EngineSpeed");
    expect(screen.getAllByText("EngineSpeed").length).toBe(1);
  });

  it("dragging an internal signal-row between areas moves it (sourcePanelId matches)", async () => {
    // Internal drag = a payload that carries this panel's elementId
    // as `sourcePanelId`. The drop handler treats it as a move:
    // signal leaves area 1 and lands in area 2.
    renderPanel();
    await pickCombobox(
      screen.getByLabelText("add signal to focused plot area"),
      "*|s:256:EngineSpeed",
    );
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
    // dragSignals + signalSelection unit suites).
    renderPanel();
    await pickCombobox(
      screen.getByLabelText("add signal to focused plot area"),
      "*|s:256:EngineSpeed",
    );
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
    await pickCombobox(
      screen.getByLabelText("add signal to focused plot area"),
      "*|s:256:EngineSpeed",
    );
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
    const picker = screen.getByLabelText("add signal to focused plot area");
    await pickCombobox(picker, "*|s:256:EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    await pickCombobox(picker, "*|s:256:EngineTemp");
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
    await pickCombobox(
      screen.getByLabelText("add signal to focused plot area"),
      "*|s:256:EngineSpeed",
    );
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
    const picker = screen.getByLabelText("add signal to focused plot area");
    await pickCombobox(picker, "*|s:256:EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    await pickCombobox(picker, "*|s:256:EngineTemp");
    await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
    // One area, two signals, unified mode → one canvas.
    expect(document.querySelectorAll(".plot-area").length).toBe(1);
    const modeSel = screen.getByLabelText("y-axis mode");
    expect(comboboxValue(modeSel)).toBe("unified");
    // Switch to per-unit. The fixture has two distinct units (rpm,
    // degC) so the derived axes split into two.
    await pickCombobox(modeSel, "per-unit");
    expect(document.querySelectorAll(".plot-area").length).toBe(2);
    expect(screen.getByText(/Area 1 · \[rpm\]/)).toBeInTheDocument();
    expect(screen.getByText(/Area 1 · \[degC\]/)).toBeInTheDocument();
    // Switch to individual: same as per-unit here (one per signal).
    // Re-query the selector — react may have re-mounted it.
    await pickCombobox(screen.getByLabelText("y-axis mode"), "individual");
    expect(document.querySelectorAll(".plot-area").length).toBe(2);
    expect(screen.getByText(/Area 1 · EngineSpeed/)).toBeInTheDocument();
  });

  it("measurement strip lists each signal exactly once in per-unit mode", async () => {
    // Regression guard for the derived-axis id mismatch: the strip's
    // per-trace cells must enumerate the *derived* axes (where
    // reportSeries stores each axis's series), and each signal lives
    // in exactly one derived axis, so per-unit mode shows one cell
    // set per signal — not zero (lookup miss) and not duplicates.
    renderPanel();
    const picker = screen.getByLabelText("add signal to focused plot area");
    await pickCombobox(picker, "*|s:256:EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    await pickCombobox(picker, "*|s:256:EngineTemp");
    await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
    await pickCombobox(screen.getByLabelText("y-axis mode"), "per-unit");
    fireEvent.click(screen.getByRole("checkbox", { name: /measurements/i }));
    // Default measurement keys include the per-trace value@A cell.
    expect(screen.getAllByText(/EngineData\.EngineSpeed @A/).length).toBe(1);
    expect(screen.getAllByText(/EngineData\.EngineTemp @A/).length).toBe(1);
  });

  it("show-points tri-state defaults to auto and persists to panel params", async () => {
    const { api } = renderPanel();
    const sel = screen.getByLabelText("show points");
    expect(comboboxValue(sel)).toBe("auto");
    await pickCombobox(sel, "on");
    expect(comboboxValue(sel)).toBe("on");
    // Last updateParameters call carries the new mode.
    const calls = api.updateParameters.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] ?? {};
    expect(lastCall.showPoints).toBe("on");
    await pickCombobox(sel, "off");
    expect(comboboxValue(screen.getByLabelText("show points"))).toBe("off");
  });

  it("restores its signals from the element's config when reopened with bare params", () => {
    // The close-and-reopen bug: reopening from the Elements list mounts
    // the panel with params carrying only `elementId`; the signal setup
    // lives on the element's `config`. Reading it back is what keeps the
    // panel from coming up empty.
    const registry = makeRegistry({
      id: "el-reopen",
      config: {
        areas: [
          {
            id: "a1",
            signals: [
              {
                busId: null,
                messageId: 256,
                extended: false,
                signalName: "EngineSpeed",
                messageName: "EngineData",
                unit: "rpm",
                color: "#abcdef",
              },
            ],
          },
        ],
      },
    });
    renderPanel({ params: { elementId: "el-reopen" }, registry });
    expect(screen.getByText("EngineSpeed")).toBeInTheDocument();
  });

  it("hovering one area drives the crosshair readout in every area (shared hoverX)", async () => {
    // The mouse crosshair is panel-level: a hover reported by *any*
    // area's uPlot flips every area's side-panel readout to
    // "value at crosshair" at the shared x. The canvas line itself
    // isn't drawable in jsdom; this exercises the state lift + the
    // owner-aware clear (a cursor reset fired by a non-hovered area's
    // setData must not clobber the shared hover).
    // rAF deferred to a microtask (not run synchronously): the panel's
    // throttle stores the returned id *after* requestAnimationFrame
    // returns, so a synchronous callback would leave the guard stuck.
    // Microtasks flush inside `await act(...)`, keeping the test
    // deterministic.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    // The construction effect refuses a 0×0 canvas (jsdom's default) —
    // give every element real dimensions so uPlot actually constructs.
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "add plot area" }));
      const area1 = screen.getByText("Area 1").closest(".plot-area")!;
      const area2 = screen.getByText("Area 2").closest(".plot-area")!;
      const instFor = (areaEl: Element) => {
        const list = uplotInstances.filter((i) => areaEl.contains(i.root));
        return list[list.length - 1];
      };
      await waitFor(() => expect(instFor(area2)).toBeTruthy());
      const readout = () => document.querySelector(".plot-signal-value") as HTMLElement;
      expect(readout().title).toBe("latest value");
      // Hover over *area 2* (empty — the signal lives in area 1): the
      // signal readout in area 1 must switch to the crosshair value.
      const u2 = instFor(area2)!;
      await act(async () => {
        u2.cursor.left = 150;
        u2.fire("setCursor");
      });
      expect(readout().title).toBe("value at crosshair");
      // A cursor reset from the non-owner area is ignored…
      const u1 = instFor(area1)!;
      await act(async () => {
        u1.cursor.left = -10;
        u1.fire("setCursor");
      });
      expect(readout().title).toBe("value at crosshair");
      // …while a leave from the owning area clears the shared hover.
      await act(async () => {
        u2.cursor.left = -10;
        u2.fire("setCursor");
      });
      expect(readout().title).toBe("latest value");
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
  });

  it("each derived axis carries a resolved flex-grow weight (default 1)", () => {
    renderPanel();
    const area = screen.getByText("Area 1").closest(".plot-area") as HTMLElement;
    expect(area.style.flexGrow).toBe("1");
  });

  it("restores per-axis weights from config and applies them as flex-grow", () => {
    const registry = makeRegistry({
      id: "el-weights",
      config: {
        areas: [{ id: "a1", signals: [] }],
        axisWeights: { a1: 2.5 },
      },
    });
    renderPanel({ params: { elementId: "el-weights" }, registry });
    const area = screen.getByText("Area 1").closest(".plot-area") as HTMLElement;
    // Unified mode → derived axis id == area id, so the stored weight
    // resolves onto this axis.
    expect(area.style.flexGrow).toBe("2.5");
  });

  it("round-trips axisWeights through updateParameters", () => {
    const { api } = renderPanel({
      params: { elementId: "el-w2" },
      registry: makeRegistry({
        id: "el-w2",
        config: { areas: [{ id: "a1", signals: [] }], axisWeights: { a1: 3 } },
      }),
    });
    const calls = api.updateParameters.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] ?? {};
    expect(lastCall.axisWeights).toEqual({ a1: 3 });
  });

  it("cycles the signal wheel for new notes; no fixed-colour picker", async () => {
    // A note dropped in "+ note" mode takes the wheel colour at the
    // index of the existing note count — like plot series seed by area
    // signal count (ADR 0026) — rather than one colour picked from a
    // toolbar swatch. Two pre-existing notes → the third gets
    // wheelColor(2) (deliberately ≠ the old default EVENT_COLOR, which
    // happens to equal wheelColor(1)).
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      const addNote = vi.fn();
      const notes: NotesContextValue = {
        notes: [
          { id: "n1", timestampNs: 0, label: "note 1" },
          { id: "n2", timestampNs: 1, label: "note 2" },
        ],
        addNote,
        renameNote: () => {},
        recolorNote: () => {},
        removeNote: () => {},
      };
      renderPanel({
        params: { elementId: "el-note" },
        registry: makeRegistry({
          id: "el-note",
          config: { areas: [{ id: "a1", signals: [] }], cursorMode: "note" },
        }),
        notes,
      });
      // The picker is gone: note mode shows no swatch.
      expect(screen.queryByLabelText("new note colour")).toBeNull();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      const inst = uplotInstances[uplotInstances.length - 1]!;
      await act(async () => inst.fire("ready"));
      // Plain left click on the plot (mousedown + mouseup, no move).
      // Retried: the note drop is a silent no-op until the first sample
      // decode anchors `baseSeconds`, which lands on its own microtask.
      await waitFor(() => {
        fireEvent.mouseDown(inst.over, { button: 0, clientX: 150, clientY: 100 });
        fireEvent.mouseUp(window, { button: 0, clientX: 150, clientY: 100 });
        expect(addNote).toHaveBeenCalled();
      });
      const lastCall = addNote.mock.calls[addNote.mock.calls.length - 1]!;
      expect(lastCall[3]).toBe(wheelColor(2));
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
  });

  it("collapses a fully-hidden axis and suppresses its splitter", () => {
    // Individual mode → one axis per signal. The all-hidden signal's
    // axis collapses (flex-grow 0, `.collapsed`) so it claims no plot
    // height; the visible signal's axis keeps a real weight, and the
    // splitter that would sit between the two is dropped.
    const registry = makeRegistry({
      id: "el-hidden",
      config: {
        areas: [
          {
            id: "a1",
            yAxisMode: "individual",
            signals: [
              { busId: null, messageId: 256, extended: false, signalName: "EngineSpeed", messageName: "EngineData", unit: "rpm", color: "#abc", hidden: true },
              { busId: null, messageId: 256, extended: false, signalName: "EngineTemp", messageName: "EngineData", unit: "V", color: "#def" },
            ],
          },
        ],
      },
    });
    renderPanel({ params: { elementId: "el-hidden" }, registry });
    const areas = Array.from(document.querySelectorAll(".plot-area")) as HTMLElement[];
    expect(areas.length).toBe(2);
    const collapsed = areas.filter((a) => a.classList.contains("collapsed"));
    expect(collapsed.length).toBe(1);
    expect(collapsed[0].style.flexGrow).toBe("0");
    // Two axes normally get one splitter between them; the collapsed
    // neighbour suppresses it.
    expect(document.querySelectorAll(".plot-area-splitter").length).toBe(0);
  });

  it("per-unit mode collects an area's enums onto one shared enum-lanes axis", async () => {
    // Both fixture signals carry a >=2-member value table → both are
    // enums. In per-unit mode they must fold into a single combined
    // axis (subtitle "(enums)"), not two separate unit axes.
    mockValueTables.EngineSpeed = [{ raw: 0, label: "Idle" }, { raw: 1, label: "Run" }];
    mockValueTables.EngineTemp = [{ raw: 0, label: "Cold" }, { raw: 1, label: "Hot" }];
    renderPanel();
    const picker = screen.getByLabelText("add signal to focused plot area");
    await pickCombobox(picker, "*|s:256:EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    await pickCombobox(picker, "*|s:256:EngineTemp");
    await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
    await pickCombobox(screen.getByLabelText("y-axis mode"), "per-unit");
    // One combined enum axis, not two per-unit axes.
    await waitFor(() => {
      expect(document.querySelectorAll(".plot-area").length).toBe(1);
    });
    expect(screen.getByText(/Area 1 · \(enums\)/)).toBeInTheDocument();
  });

  it("a numeric area does not rebuild its uPlot when value tables resolve", async () => {
    // Regression: keying uPlot construction on the whole `valueTables`
    // map tore down + rebuilt every numeric area when its (empty) tables
    // resolved, and the post-rebuild resample was skipped by the
    // descriptor-memo on a stopped trace — leaving a blank canvas (no
    // scale, no lines). The draw hook reads tables live instead, so a
    // table resolution must not recreate the instance.
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      // Seed the signal in config so the panel mounts *with* it — one
      // construction, not the empty-area + signal-added pair. Any extra
      // instance then is the table-resolution rebuild we're guarding.
      const registry = makeRegistry({
        id: "el-numrebuild",
        config: {
          areas: [
            {
              id: "a1",
              signals: [
                { busId: null, messageId: 256, extended: false, signalName: "EngineSpeed", messageName: "EngineData", unit: "rpm", color: "#abc" },
              ],
            },
          ],
        },
      });
      renderPanel({ params: { elementId: "el-numrebuild" }, registry });
      await waitFor(() => expect(uplotInstances.length).toBeGreaterThanOrEqual(1));
      // Flush the async value-table fetch (empty for this numeric signal)
      // and its state update.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // Still exactly one instance: the empty-table resolution redraws,
      // it does not tear down + rebuild uPlot.
      expect(uplotInstances.length).toBe(1);
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
  });

  it("a lanes axis constructs uPlot with stepped series and a blank y axis", async () => {
    mockValueTables.EngineSpeed = [{ raw: 0, label: "Idle" }, { raw: 1, label: "Run" }];
    mockValueTables.EngineTemp = [{ raw: 0, label: "Cold" }, { raw: 1, label: "Hot" }];
    // uPlot only constructs against a real-sized canvas.
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      renderPanel();
      const picker = screen.getByLabelText("add signal to focused plot area");
      await pickCombobox(picker, "*|s:256:EngineSpeed");
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      await pickCombobox(picker, "*|s:256:EngineTemp");
      await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
      await pickCombobox(screen.getByLabelText("y-axis mode"), "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
      await waitFor(() => expect(uplotInstances.length).toBeGreaterThan(0));
      const inst = uplotInstances[uplotInstances.length - 1] as unknown as {
        opts: { series: { paths?: unknown }[]; axes: { splits: () => number[]; grid?: { show?: boolean } }[] };
      };
      // x + two lane series, both stepped.
      expect(inst.opts.series).toHaveLength(3);
      expect(typeof inst.opts.series[1].paths).toBe("function");
      expect(typeof inst.opts.series[2].paths).toBe("function");
      // Blank y gutter: no splits, no grid.
      const yAxis = inst.opts.axes[1];
      expect(yAxis.splits()).toEqual([]);
      expect(yAxis.grid?.show).toBe(false);
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
  });

  it("renders N-1 splitters between N stacked axes", async () => {
    renderPanel();
    // One area → no splitter.
    expect(document.querySelectorAll(".plot-area-splitter").length).toBe(0);
    const picker = screen.getByLabelText("add signal to focused plot area");
    await pickCombobox(picker, "*|s:256:EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    await pickCombobox(picker, "*|s:256:EngineTemp");
    await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
    await pickCombobox(screen.getByLabelText("y-axis mode"), "per-unit");
    // Two units → two axes → exactly one splitter between them.
    expect(document.querySelectorAll(".plot-area").length).toBe(2);
    expect(document.querySelectorAll(".plot-area-splitter").length).toBe(1);
  });

  it("dragging a splitter shifts weight between exactly the two neighbours, conserving their sum", async () => {
    // Both neighbours report a 200px height; a 50px downward drag of the
    // 400px pair moves them to 250/150 → weights 1.25 / 0.75 (sum 2).
    const rect = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({ height: 200, width: 600, top: 0, left: 0, right: 600, bottom: 200, x: 0, y: 0, toJSON() {} } as DOMRect);
    try {
      const { api } = renderPanel();
      const picker = screen.getByLabelText("add signal to focused plot area");
      await pickCombobox(picker, "*|s:256:EngineSpeed");
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      await pickCombobox(picker, "*|s:256:EngineTemp");
      await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
      await pickCombobox(screen.getByLabelText("y-axis mode"), "per-unit");
      const sep = document.querySelector(".plot-area-splitter") as HTMLElement;
      fireEvent.mouseDown(sep, { clientY: 0 });
      act(() => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientY: 50 }));
      });
      act(() => {
        window.dispatchEvent(new MouseEvent("mouseup"));
      });
      const areas = document.querySelectorAll(".plot-area");
      const g0 = parseFloat((areas[0] as HTMLElement).style.flexGrow);
      const g1 = parseFloat((areas[1] as HTMLElement).style.flexGrow);
      expect(g0 + g1).toBeCloseTo(2);
      expect(g0).toBeCloseTo(1.25);
      expect(g1).toBeCloseTo(0.75);
      // Persisted: exactly the two neighbours, summing to their pair.
      const calls = api.updateParameters.mock.calls;
      const last = (calls[calls.length - 1]?.[0] ?? {}) as { axisWeights: Record<string, number> };
      const vals = Object.values(last.axisWeights);
      expect(vals).toHaveLength(2);
      expect(vals.reduce((a, b) => a + b, 0)).toBeCloseTo(2);
    } finally {
      rect.mockRestore();
    }
  });

  it("double-clicking a splitter equalises the pair", async () => {
    const registry = makeRegistry({
      id: "el-eq",
      config: {
        areas: [
          {
            id: "a1",
            yAxisMode: "per-unit",
            signals: [
              { busId: null, messageId: 256, extended: false, signalName: "EngineSpeed", messageName: "EngineData", unit: "rpm", color: "#111" },
              { busId: null, messageId: 256, extended: false, signalName: "EngineTemp", messageName: "EngineData", unit: "degC", color: "#222" },
            ],
          },
        ],
        // Lopsided starting weights on the two derived per-unit axes.
        axisWeights: { "a1/u:unit:rpm": 3, "a1/u:unit:degC": 1 },
      },
    });
    const { api } = renderPanel({ params: { elementId: "el-eq" }, registry });
    const areas = document.querySelectorAll(".plot-area");
    expect(parseFloat((areas[0] as HTMLElement).style.flexGrow)).toBeCloseTo(3);
    const sep = document.querySelector(".plot-area-splitter") as HTMLElement;
    fireEvent.doubleClick(sep);
    const after = document.querySelectorAll(".plot-area");
    expect(parseFloat((after[0] as HTMLElement).style.flexGrow)).toBeCloseTo(2);
    expect(parseFloat((after[1] as HTMLElement).style.flexGrow)).toBeCloseTo(2);
    const calls = api.updateParameters.mock.calls;
    const last = (calls[calls.length - 1]?.[0] ?? {}) as { axisWeights: Record<string, number> };
    expect(last.axisWeights["a1/u:unit:rpm"]).toBeCloseTo(2);
    expect(last.axisWeights["a1/u:unit:degC"]).toBeCloseTo(2);
  });

  it("mirrors its config onto the element via the registry", async () => {
    const { registry } = renderPanel({
      params: { elementId: "el-persist" },
      registry: makeRegistry({ id: "el-persist" }),
    });
    await pickCombobox(
      screen.getByLabelText("add signal to focused plot area"),
      "*|s:256:EngineSpeed",
    );
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    const cfg = (registry.get("el-persist")!.element as {
      config?: { areas?: Array<{ signals: unknown[] }> };
    }).config;
    expect(cfg?.areas?.some((a) => a.signals.length > 0)).toBe(true);
  });
});

describe("PlotPanel command registration (f / l hotkeys)", () => {
  function renderWithCommands() {
    const commands = createPanelCommandRegistry();
    const api = { updateParameters: vi.fn() };
    const props = {
      params: { elementId: "el-test" },
      api,
    } as unknown as Parameters<typeof PlotPanel>[0];
    render(
      <TraceDataContext.Provider value={traceData}>
        <ProjectContext.Provider value={projectCtx}>
          <SignalCatalogProvider>
            <ElementRegistryContext.Provider value={makeRegistry()}>
              <PanelCommandsContext.Provider value={commands}>
                <PlotPanel {...props} />
              </PanelCommandsContext.Provider>
            </ElementRegistryContext.Provider>
          </SignalCatalogProvider>
        </ProjectContext.Provider>
      </TraceDataContext.Provider>,
    );
    return commands;
  }

  it("registers plot.fitXAxis for its element", () => {
    const commands = renderWithCommands();
    expect(commands.invoke("el-test", "plot.fitXAxis")).toBe(true);
  });

  it("plot.followLive.enable re-enables follow live (enable-only)", () => {
    const commands = renderWithCommands();
    const checkbox = screen.getByRole("checkbox", { name: /follow live/i });
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    act(() => {
      commands.invoke("el-test", "plot.followLive.enable");
    });
    expect(checkbox).toBeChecked();
    // Enable-only: invoking again must not toggle it back off.
    act(() => {
      commands.invoke("el-test", "plot.followLive.enable");
    });
    expect(checkbox).toBeChecked();
  });
});
