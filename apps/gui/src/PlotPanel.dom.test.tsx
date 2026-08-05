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

/// Synthetic cost of a resample's synchronous section (see the
/// `setData` stub below). `perTickMs` is what one tick "costs";
/// `accMs` is the total charged so far, which a test adds to
/// `performance.now()` so the area's own measurement sees it.
/// Prefixed `mock` so the hoisted `vi.mock` factory may reference it.
const mockRenderCost = { perTickMs: 0, accMs: 0 };

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
    /** Every `setScale("x", …)` this instance was given, in order — the
     * panel's x-window decisions (follow-live slide, Fit Data) are only
     * observable through this call. */
    xCalls: { min: number; max: number }[] = [];
    setData(d: unknown) {
      this.data = d;
      // Stand in for the cost of shaping + drawing a large series set:
      // `setData` is the one call the resample's synchronous section
      // makes into uPlot, so charging the fake clock here is what makes
      // an expensive area expensive from the loop's point of view.
      // jsdom cannot make it expensive for real (no canvas, no paths).
      mockRenderCost.accMs += mockRenderCost.perTickMs;
    }
    setScale(key?: string, range?: { min: number; max: number }) {
      if (key === "x" && range) this.xCalls.push({ min: range.min, max: range.max });
    }
    setSeries() {}
    setSelect() {}
    setSize() {}
    /** How many redraws this instance was asked for — how a restyle that
     * changes no data (a recolored series) becomes visible on a stopped
     * trace, and the only place that is observable. */
    redraws = 0;
    redraw() {
      this.redraws++;
    }
    destroy() {}
    /** px → x value; linear so tests can pick a deterministic x. */
    posToVal(px: number) {
      return px / 100;
    }
    valToPos() {
      return 0;
    }
    /** Fire a registered hook as the real uPlot would. Extra args are
     * passed through after `u` (uPlot's `setScale` hook takes the scale
     * key as its second argument). */
    fire(hook: string, ...args: unknown[]) {
      for (const f of this.opts.hooks?.[hook] ?? []) (f as (...a: unknown[]) => void)(this, ...args);
    }
  }
  const instances: FakeUPlot[] = [];
  return { default: FakeUPlot, __instances: instances };
});
vi.mock("uplot/dist/uPlot.min.css", () => ({}));

const SIGNALS = [
  // `decimals: 2` is the catalog's fixed-precision fact — EngineSpeed's
  // DBC factor is 0.25, so its values land on two decimal places.
  { message_id: 256, extended: false, message_name: "EngineData", transmitter: "EngineEcu", signal_name: "EngineSpeed", unit: "rpm", decimals: 2 },
  { message_id: 256, extended: false, message_name: "EngineData", transmitter: "EngineEcu", signal_name: "EngineTemp", unit: "degC" },
  // A third signal, so the enum-lane tests have three lanes to hide the
  // middle one of — and, with the fourth, a same-unit *pair*, so
  // per-unit mode has a unit group to scale rather than one signal per
  // axis (ADR 0026).
  { message_id: 256, extended: false, message_name: "EngineData", transmitter: "EngineEcu", signal_name: "LimitNominal", unit: "A" },
  { message_id: 256, extended: false, message_name: "EngineData", transmitter: "EngineEcu", signal_name: "LimitEffective", unit: "A" },
];
/** The window anchors `sample_signals` reports alongside the series:
 * `from` is the window's first-frame time and `last` its last-frame time
 * (the live edge), both absolute seconds. Host-side these are a fact
 * about the *window* — `window_anchors(from_index)` bounded by
 * `window_end` — not about the queried signals, so one pair serves every
 * area. A test that grows the capture moves `last`. */
const mockSampleBounds = { from: 0, last: 2 };
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
  view.setFloat64(off, mockSampleBounds.from, true);
  off += 8;
  view.setFloat64(off, mockSampleBounds.last, true);
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
// Per-signal sampled series (keyed by signal name) for tests that need
// specific values — enum codes, or differing timestamps to exercise
// `mergeSeries`'s sample-and-hold. Unset signals fall back to the
// default numeric fixture. Prefixed `mock` for the hoisted factory.
const mockSampleSeries: Record<string, { t: number[]; v: number[] }> = {};
// Per-signal all-time extents the fake host serves from `signal_min_max`
// (ADR 0025), keyed by signal name. Unset signals fall back to the
// default `10..20`, which matches the default sampled fixture.
const mockSignalExtents: Record<string, { lo: number; hi: number }> = {};
/// Settings the fake host serves from `get_settings`. Empty means "every
/// field at its default"; a test that cares sets a key and re-hydrates.
const mockSettings: Record<string, unknown> = {};
/// While set, every `sample_signals` call returns a promise that does
/// not settle on its own — so a test can observe what the panel draws
/// with no further fetch able to land. Each such call parks its resolver
/// in `pending`, so a test that needs the stalled fetch to *finish*
/// (rather than stay stalled forever) can hand it a sample. Prefixed
/// `mock` for the hoisted factory.
const mockSampleStall = { on: false, pending: [] as ((buf: ArrayBuffer) => void)[] };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { signals?: unknown[]; signalName?: string }) => {
    if (cmd === "list_signals") return SIGNALS;
    if (cmd === "sample_signals") {
      if (mockSampleStall.on)
        return new Promise<ArrayBuffer>((resolve) => mockSampleStall.pending.push(resolve));
      return encodeSample(
        (args?.signals ?? []).map(
          (s) =>
            mockSampleSeries[(s as { signalName?: string }).signalName ?? ""] ?? {
              t: [0, 1, 2],
              v: [10, 20, 15],
            },
        ),
      );
    }
    if (cmd === "signal_min_max")
      // Host-owned all-time per-signal extent (ADR 0025) — matches the
      // sampled values' min/max so follow-live auto-norm has a range.
      return (args?.signals ?? []).map(
        (s) => mockSignalExtents[(s as { signalName?: string }).signalName ?? ""] ?? { lo: 10, hi: 20 },
      );
    if (cmd === "list_value_tables") return mockValueTables[args?.signalName ?? ""] ?? [];
    if (cmd === "get_settings") return { ...mockSettings };
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

/** The FakeUPlot surface the tests drive (see the mock above). */
type FakeUPlotInst = {
  cursor: { left: number };
  root: HTMLElement;
  over: HTMLElement;
  data: unknown;
  scales: Record<string, { min?: number; max?: number }>;
  xCalls: { min: number; max: number }[];
  redraws: number;
  fire: (hook: string, ...args: unknown[]) => void;
};
const uplotInstances = (uplotModule as unknown as { __instances: FakeUPlotInst[] }).__instances;

import { invoke } from "@tauri-apps/api/core";

import { PlotPanel } from "./PlotPanel";
import { PanelCommandsContext, createPanelCommandRegistry } from "./panelCommands";
import { TraceDataProvider, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ElementRegistryContext, type ElementRegistry } from "./projectElements";
import { NotesContext, type NotesContextValue } from "./notesContext";
import { SignalCatalogProvider } from "./signalCatalogContext";
import { wheelColor } from "./palette";
import { freshTrace } from "./trace";
import { diagCounts } from "./diag";
import { hydrateSettings } from "./hostSettings";

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
function makeRegistry(seed?: {
  id: string;
  config?: Record<string, unknown>;
  /// Window state for the seeded element — defaults to a fresh running
  /// trace; a seeded `end` makes the panel read as stopped.
  trace?: TS;
}): ElementRegistry {
  const map = new Map<string, Entry>();
  const entry = (id: string, config?: Record<string, unknown>, trace?: TS): Entry => ({
    element: { kind: "plot", id, config },
    trace: trace ?? freshTrace(0),
  });
  if (seed) map.set(seed.id, entry(seed.id, seed.config, seed.trace));
  // The real registry keeps `entries` as state and only replaces the array
  // when something actually changed. Mirror that: a getter that rebuilt the
  // array on every read would re-run every memo hanging off it and make
  // render-count assertions meaningless.
  let snapshot: Entry[] | null = null;
  const touched = () => {
    snapshot = null;
  };
  return {
    get entries() {
      if (snapshot == null) snapshot = [...map.values()];
      return snapshot;
    },
    get: (id: string) => map.get(id),
    create: () => {
      const id = Math.random().toString(36).slice(2);
      map.set(id, entry(id));
      touched();
      return id;
    },
    ensure: (id: string) => {
      if (!map.has(id)) {
        map.set(id, entry(id));
        touched();
      }
    },
    update: (id: string, patch: { config?: Record<string, unknown> }) => {
      const e = map.get(id);
      if (e) {
        map.set(id, { ...e, element: { ...e.element, ...patch } });
        touched();
      }
    },
    updateTrace: (id: string, updater: (s: TS) => TS) => {
      const e = map.get(id);
      if (e) {
        map.set(id, { ...e, trace: updater(e.trace) });
        touched();
      }
    },
    remove: (id: string) => {
      map.delete(id);
      touched();
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
  onUpdateBus: () => {},
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
  const build = (data: TraceData) => {
    let tree = (
      <TraceDataProvider value={data}>
        <ProjectContext.Provider value={projectCtx}>
          <SignalCatalogProvider>
            <ElementRegistryContext.Provider value={registry}>
              <PlotPanel {...props} />
            </ElementRegistryContext.Provider>
          </SignalCatalogProvider>
        </ProjectContext.Provider>
      </TraceDataProvider>
    );
    if (opts?.notes) tree = <NotesContext.Provider value={opts.notes}>{tree}</NotesContext.Provider>;
    return tree;
  };
  const { rerender } = render(build(traceData));
  return {
    api,
    registry,
    /// Push a new session-buffer frame count through the trace context —
    /// what a `trace-grew` event does, and what moves the plot's `winEnd`.
    growTrace: (count: number) => rerender(build({ ...traceData, count })),
  };
}

/// How many `sample_signals` round-trips the panel has made so far —
/// the plot's fetch cadence, counted straight off the mocked bridge.
const sampleCalls = () =>
  vi.mocked(invoke).mock.calls.filter((c) => c[0] === "sample_signals").length;

/// The newest uPlot instance rendered inside the named area. Areas
/// rebuild their instance on a signal-set change, so the last one wins.
function liveInstanceIn(areaLabel: string): FakeUPlotInst {
  const areaEl = screen.getByText(areaLabel).closest(".plot-area")!;
  for (let i = uplotInstances.length - 1; i >= 0; i--) {
    if (areaEl.contains(uplotInstances[i].root)) return uplotInstances[i];
  }
  throw new Error(`no uPlot instance for ${areaLabel}`);
}

/// How many x samples an instance currently holds — `0` for a freshly
/// constructed (or cleared) chart.
const drawnPoints = (inst: FakeUPlotInst) => ((inst.data as unknown[][])[0] ?? []).length;

/// Drop a signal onto an area, the way the DBC panel / another area
/// does — the only way to give a *non-focused* area a signal.
function dropSignal(areaLabel: string, signalName: string, unit: string) {
  const MIME = "application/x-cannet-plot-signal";
  const payload = JSON.stringify({
    messageId: 256,
    extended: false,
    signalName,
    messageName: "EngineData",
    unit,
  });
  const dt = { types: [MIME], getData: (t: string) => (t === MIME ? payload : ""), dropEffect: "" };
  const area = screen.getByText(areaLabel).closest(".plot-area")!;
  fireEvent.dragOver(area, { dataTransfer: dt });
  fireEvent.drop(area, { dataTransfer: dt });
}

/// One `DataTransfer` stand-in for a plot-area drag gesture: dragStart
/// writes the dragged area's id onto it and the drop target reads it
/// back, so every event in the gesture must be handed the *same* object.
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

/// Let React render the way it does in the app — batched per update,
/// not collected into an `act` scope. Render *cadence* is only
/// measurable outside `act`, which flushes everything queued in its
/// scope as one commit.
async function outsideAct(body: () => Promise<void>): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prev = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await body();
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = prev;
  }
}

/// Run `body` with non-zero element dimensions. The uPlot construction
/// effect refuses a 0x0 canvas (jsdom's default), and with no instance
/// `resample` returns before it fetches — so any test that counts
/// fetches needs a sized canvas.
async function withSizedCanvas(body: () => Promise<void>): Promise<void> {
  const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
  const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
  try {
    await body();
  } finally {
    cw.mockRestore();
    ch.mockRestore();
  }
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
  for (const k of Object.keys(mockSampleSeries)) delete mockSampleSeries[k];
  for (const k of Object.keys(mockSignalExtents)) delete mockSignalExtents[k];
  mockSampleBounds.from = 0;
  mockSampleBounds.last = 2;
  mockSampleStall.on = false;
  mockSampleStall.pending.length = 0;
  mockRenderCost.perTickMs = 0;
  mockRenderCost.accMs = 0;
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  void hydrateSettings();
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

  it("drag-reorders plot areas, carrying each area's signals with it", () => {
    // Areas are labelled by position ("Area 1" is whichever is on top),
    // so the reorder is observable through the *signals* each stacked
    // area holds, not through its label.
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "add plot area" }));
    dropSignal("Area 1", "TopSignal", "rpm");
    dropSignal("Area 2", "BottomSignal", "rpm");
    const stackedSignal = () =>
      Array.from(document.querySelectorAll(".plot-area")).map(
        (el) => el.querySelector(".plot-signal-name")?.textContent,
      );
    expect(stackedSignal()).toEqual(["TopSignal", "BottomSignal"]);

    // Drag the second area's grip onto the first — dragging up drops it
    // above the target.
    const grips = screen.getAllByLabelText("reorder plot area");
    expect(grips.length).toBe(2);
    const dt = areaDragTransfer();
    fireEvent.dragStart(grips[1], { dataTransfer: dt });
    const first = document.querySelectorAll(".plot-area")[0];
    fireEvent.dragOver(first, { dataTransfer: dt });
    fireEvent.drop(first, { dataTransfer: dt });

    expect(stackedSignal()).toEqual(["BottomSignal", "TopSignal"]);
  });

  it("offers no reorder grip while a panel holds a single area", () => {
    renderPanel();
    expect(screen.queryAllByLabelText("reorder plot area").length).toBe(0);
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

  it("names a signal row's message by its DBC ancestry, ECU included", async () => {
    // The row's second line is the same bus · ecu · message the picker
    // groups by and the DBC tree shows. The ECU isn't part of a plotted
    // signal's identity, so it's resolved from the catalog.
    renderPanel();
    await pickCombobox(
      screen.getByLabelText("add signal to focused plot area"),
      "*|s:256:EngineSpeed",
    );
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    // No project buses in this harness, so the bus segment drops out.
    expect(screen.getByText("EngineEcu · EngineData")).toBeInTheDocument();
  });

  it("picks a signal into the focused area; a repeat pick is a no-op", async () => {
    renderPanel();
    const picker = screen.getByLabelText("add signal to focused plot area");
    await pickCombobox(picker, "*|s:256:EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    await pickCombobox(picker, "*|s:256:EngineSpeed");
    expect(screen.getAllByText("EngineSpeed").length).toBe(1);
  });

  it("a growing trace window alone does not re-sample a running plot", async () => {
    // `trace-grew` moves `winEnd` ~10x/s. A *running* plot re-samples on
    // its own self-paced loop; a second trigger keyed on `winEnd` put an
    // undeduped 10 Hz floor under that cadence (its comment claimed a
    // `renderedThrough` skip that has never existed in the tree).
    await withSizedCanvas(async () => {
      const { growTrace } = renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));

      const before = sampleCalls();
      // Freeze the clock for the measurement so the resample loop cannot
      // confound it: the tick already pending on the real clock may fire,
      // but its re-arm lands on the fake timer we never advance. The
      // remaining slack is fixed one-off work (measured identical at 6
      // and at 18 growths), not per-growth cost.
      vi.useFakeTimers();
      try {
        for (let n = 1; n <= 12; n++) {
          await act(async () => {
            growTrace(100 + n * 10);
          });
        }
      } finally {
        vi.useRealTimers();
      }
      expect(sampleCalls() - before).toBeLessThanOrEqual(2);
    });
  });

  it("a stopped plot still re-samples when its window changes under it", async () => {
    // The half of the `winEnd` trigger that must survive: a stopped panel
    // has no resample loop, so a window change is the only thing that can
    // pull fresh data. Here the session buffer shrinks under a frozen
    // window (what a Clear does to a stopped panel), moving `winEnd`
    // alone — `winStart`'s own trigger cannot cover it.
    await withSizedCanvas(async () => {
      const registry = makeRegistry({
        id: "el-stopped",
        trace: { start: 0, end: 60, isPaused: false },
      });
      const { growTrace } = renderPanel({ params: { elementId: "el-stopped" }, registry });
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));

      const before = sampleCalls();
      await act(async () => {
        growTrace(30);
      });
      expect(sampleCalls()).toBeGreaterThan(before);
    });
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

  it("seeds a dropped signal's color from the target area's existing series count", async () => {
    // Drop two signals onto Area 1 in succession; the second should get
    // a different color from the first (target.signals.length grows).
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

  it("changing a series' color via the swatch picker updates the swatch", async () => {
    renderPanel();
    await pickCombobox(
      screen.getByLabelText("add signal to focused plot area"),
      "*|s:256:EngineSpeed",
    );
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    const picker = screen.getByLabelText("pick series color") as HTMLInputElement;
    fireEvent.change(picker, { target: { value: "#123456" } });
    // The swatch's background style should reflect the new color.
    // jsdom normalises hex → rgb() in inline styles.
    const swatch = document.querySelector(".plot-signal-swatch") as HTMLElement;
    expect(swatch.style.background).toBe("rgb(18, 52, 86)");
  });

  it("changing a series' color restyles the live uPlot series in place", async () => {
    // THE REGRESSION: the swatch took the new color and the plotted line
    // kept the old one — the series' stroke was read once at construction
    // and nothing rebuilt or restyled the instance for a color-only
    // change, so only closing and reopening the panel recolored the line.
    await withSizedCanvas(async () => {
      renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await waitFor(() => expect(uplotInstances.length).toBeGreaterThan(0));
      const before = uplotInstances.length;
      const redrawsBefore = liveInstanceIn("Area 1").redraws;
      fireEvent.change(screen.getByLabelText("pick series color"), {
        target: { value: "#123456" },
      });
      const inst = liveInstanceIn("Area 1") as unknown as {
        opts: { series: { stroke?: unknown }[] };
        redraws: number;
      };
      // uPlot resolves a series' stroke per draw, so a function stroke is
      // what a live instance takes a color change through.
      const s = inst.opts.series[1];
      const stroke = typeof s.stroke === "function" ? (s.stroke as () => string)() : s.stroke;
      expect(stroke).toBe("#123456");
      // In place: no teardown + rebuild, and a redraw so a stopped trace
      // repaints at the new color instead of waiting for a tick.
      expect(uplotInstances.length).toBe(before);
      expect(inst.redraws).toBeGreaterThan(redrawsBefore);
    });
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

  it("edits an area's pattern in place and re-resolves its series", async () => {
    // A pattern used to be removable and re-typable only. Editing the
    // row must re-resolve the area's series and reach the host with the
    // new signal set.
    const registry = makeRegistry({
      id: "el-patterns",
      config: { areas: [{ id: "a1", signals: [], patterns: ["EngineSpeed"] }] },
    });
    await withSizedCanvas(async () => {
      renderPanel({ params: { elementId: "el-patterns" }, registry });
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: /patterns \(1\)/ }));
      const input = screen.getByLabelText("pattern 1") as HTMLInputElement;
      expect(input.value).toBe("EngineSpeed");
      fireEvent.change(input, { target: { value: "EngineTemp" } });
      fireEvent.blur(input);
      await waitFor(() => {
        expect(screen.getByText("EngineTemp")).toBeInTheDocument();
        expect(screen.queryByText("EngineSpeed")).not.toBeInTheDocument();
      });
      // Still one pattern — edited, not removed and re-added.
      expect(screen.getByRole("button", { name: /patterns \(1\)/ })).toBeInTheDocument();
      // …and the host is sampled for the pattern's new match.
      await waitFor(() => {
        const sampled = vi
          .mocked(invoke)
          .mock.calls.filter((c) => c[0] === "sample_signals")
          .flatMap((c) =>
            ((c[1] as { signals?: { signalName: string }[] } | undefined)?.signals ?? []).map(
              (s) => s.signalName,
            ),
          );
        expect(sampled).toContain("EngineTemp");
      });
    });
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

  it("the bottom x-axis label reads out the free cursor's time", async () => {
    // The per-signal readouts give each signal's value *at the cursor*;
    // the cursor's own position on the timeline is what they're all
    // relative to, and the bottom axis label is where it goes. Elapsed
    // time since the session origin, same convention as the ticks
    // beside it (ADR 0024). With no cursor the label is its static self.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      await waitFor(() => expect(uplotInstances.length).toBeGreaterThan(0));
      const inst = uplotInstances[uplotInstances.length - 1];
      // uPlot calls the label at draw time with the live instance; the
      // window it reports drives both the precision and the reserved
      // width.
      inst.scales.x = { min: 0, max: 10 };
      const label = () => {
        const xAxis = (inst as unknown as { opts: { axes: { label: unknown }[] } }).opts.axes[0];
        expect(typeof xAxis.label).toBe("function");
        return (xAxis.label as (u: unknown) => string)(inst);
      };
      expect(label()).toBe("time (s)");
      // Hover at x = 1.5 (the fake's posToVal is px / 100).
      await act(async () => {
        inst.cursor.left = 150;
        inst.fire("setCursor");
      });
      // Padded to the width of the window's widest time ("10.0000"), so
      // the string can't change width as the pointer moves.
      expect(label()).toBe("time (s) ·  1.5000");
      // Pointer leaves → back to the static label; a held number would
      // have no crosshair on screen to refer to.
      await act(async () => {
        inst.cursor.left = -10;
        inst.fire("setCursor");
      });
      expect(label()).toBe("time (s)");
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

  it("cycles the signal wheel for new notes; no fixed-color picker", async () => {
    // A note dropped in "+ note" mode takes the wheel color at the
    // index of the existing note count — like plot series seed by area
    // signal count (ADR 0026) — rather than one color picked from a
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
      expect(screen.queryByLabelText("new note color")).toBeNull();
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
    // The collapsed axis is the top one and has no weight to trade, so
    // the visible axis below it has nothing to pair with.
    expect(document.querySelectorAll(".plot-area-splitter").length).toBe(0);
  });

  it("a splitter reaches over a collapsed axis to pair the axes either side of it", () => {
    // Hiding every signal on a middle axis must not take away the only
    // handle for resizing its neighbours: the splitter skips the
    // collapsed strip and trades weight between the two live axes.
    const registry = makeRegistry({
      id: "el-mid-hidden",
      config: {
        areas: [
          {
            id: "a1",
            yAxisMode: "individual",
            signals: [
              { busId: null, messageId: 256, extended: false, signalName: "Top", messageName: "EngineData", unit: "rpm", color: "#abc" },
              { busId: null, messageId: 256, extended: false, signalName: "Middle", messageName: "EngineData", unit: "V", color: "#def", hidden: true },
              { busId: null, messageId: 256, extended: false, signalName: "Bottom", messageName: "EngineData", unit: "degC", color: "#fed" },
            ],
          },
        ],
      },
    });
    renderPanel({ params: { elementId: "el-mid-hidden" }, registry });
    const areas = Array.from(document.querySelectorAll(".plot-area")) as HTMLElement[];
    expect(areas.length).toBe(3);
    expect(areas[1].classList.contains("collapsed")).toBe(true);
    const splitters = Array.from(document.querySelectorAll(".plot-area-splitter"));
    expect(splitters.length).toBe(1);

    // Drag it: the weight has to move between the *live* axes, not the
    // collapsed one. jsdom reports zero-height boxes, so give the drag
    // real pixel heights to divide by.
    const rect = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({ height: 200, width: 600, top: 0, left: 0, bottom: 200, right: 600, x: 0, y: 0, toJSON: () => ({}) });
    try {
      fireEvent.mouseDown(splitters[0], { clientY: 100 });
      fireEvent.mouseMove(window, { clientY: 150 });
      fireEvent.mouseUp(window, { clientY: 150 });
    } finally {
      rect.mockRestore();
    }
    // Pair sum conserved (2), top grown, bottom shrunk, middle still 0.
    const after = Array.from(document.querySelectorAll(".plot-area")) as HTMLElement[];
    expect(Number(after[0].style.flexGrow)).toBeCloseTo(1.25);
    expect(after[1].style.flexGrow).toBe("0");
    expect(Number(after[2].style.flexGrow)).toBeCloseTo(0.75);
  });

  it("a collapsed axis's placeholder forwards the wheel to a live plot", () => {
    // A collapsed axis has no canvas, so no uPlot and no pointer
    // surface — its row would be a dead strip for zoom and crosshair.
    // The placeholder replays the gesture on a live plot instead.
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      const registry = makeRegistry({
        id: "el-fwd",
        config: {
          areas: [
            {
              id: "a1",
              yAxisMode: "individual",
              signals: [
                { busId: null, messageId: 256, extended: false, signalName: "Shown", messageName: "EngineData", unit: "rpm", color: "#abc" },
                { busId: null, messageId: 256, extended: false, signalName: "Gone", messageName: "EngineData", unit: "V", color: "#def", hidden: true },
              ],
            },
          ],
        },
      });
      renderPanel({ params: { elementId: "el-fwd" }, registry });
      const placeholder = document.querySelector(".plot-area-placeholder") as HTMLElement;
      expect(placeholder).not.toBeNull();
      const seen: WheelEvent[] = [];
      for (const inst of uplotInstances) {
        inst.over.addEventListener("wheel", (e) => seen.push(e as WheelEvent));
      }
      expect(uplotInstances.length).toBeGreaterThan(0);
      fireEvent.wheel(placeholder, { deltaY: -120, clientX: 137 });
      expect(seen.length).toBe(1);
      expect(seen[0].deltaY).toBe(-120);
      // Same x, so the zoom anchors where the pointer actually was.
      expect(seen[0].clientX).toBe(137);
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
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

  it("the post-mount rebuild repaints the fresh uPlot from the cached window", async () => {
    // THE REGRESSION: the ~250 ms post-mount rebuild dropped the windowed
    // source's cache, so a panel that had already drawn went blank and
    // refetched its whole window from scratch — seconds of nothing on a
    // real capture, with the data popping in, vanishing, and returning.
    //
    // Stalling every fetch from the moment the first window is on screen
    // makes that observable without racing the self-paced resample loop:
    // once the rebuilt instance exists, the only thing that can fill it
    // is the cache, because no further round-trip can ever land.
    await withSizedCanvas(async () => {
      renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBeGreaterThan(0));
      mockSampleStall.on = true;
      const before = uplotInstances.length;
      // The rebuild lands ~250 ms after the instance was constructed.
      await waitFor(() => expect(uplotInstances.length).toBeGreaterThan(before), { timeout: 2000 });
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBeGreaterThan(0));
    });
  });

  it("an area whose first sample is slow says it is building, and stops when it lands", async () => {
    // A cold decimation cache decodes the whole window on the first
    // sample for a signal set, so the canvas is blank for seconds and
    // reads as "no data" or "hung". Stalling every fetch stands in for
    // that wait; the gate is real time, so only the positive direction
    // is asserted here (the sub-threshold case is in
    // `useFirstSampleWait.test.tsx`, under fake timers).
    const building = () => document.querySelector(".plot-area-building");
    await withSizedCanvas(async () => {
      mockSampleStall.on = true;
      renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await waitFor(() => expect(building()).not.toBeNull(), { timeout: 2000 });

      // The moment the sample lands it goes. Hand the stalled fetch its
      // answer rather than starting a fresh one: the in-flight round-trip
      // holds the area's resample guard, exactly as the slow cold sample
      // this stands in for does.
      mockSampleStall.on = false;
      await act(async () => {
        for (const resolve of mockSampleStall.pending.splice(0))
          resolve(encodeSample([{ t: [0, 1, 2], v: [10, 20, 15] }]));
        await Promise.resolve();
      });
      await waitFor(() => expect(building()).toBeNull());
    });
  });

  it("an area with no signals never says it is building", async () => {
    // "Nothing to draw yet" must stay distinguishable from "nothing to
    // draw": an empty area is the latter and arms nothing, however long
    // it sits there.
    await withSizedCanvas(async () => {
      mockSampleStall.on = true;
      renderPanel();
      // Long enough for the gate to have fired had it been armed — the
      // sibling test above proves it fires inside this budget.
      await new Promise((r) => setTimeout(r, 1000));
      expect(document.querySelector(".plot-area-building")).toBeNull();
      expect(screen.getByText("pick a signal above")).toBeInTheDocument();
    });
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
      <TraceDataProvider value={traceData}>
        <ProjectContext.Provider value={projectCtx}>
          <SignalCatalogProvider>
            <ElementRegistryContext.Provider value={makeRegistry()}>
              <PanelCommandsContext.Provider value={commands}>
                <PlotPanel {...props} />
              </PanelCommandsContext.Provider>
            </ElementRegistryContext.Provider>
          </SignalCatalogProvider>
        </ProjectContext.Provider>
      </TraceDataProvider>,
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


// Characterisation of the y-normalisation pipeline: the exact array
// `PlotArea` hands uPlot via `setData` in each axis mode.
//
// The plot's core data path — per-signal normalise, then `mergeSeries`
// onto a shared time axis — had no assertions on its *output*, so a
// refactor there was flying blind. These pin current behaviour with
// literal expected values (not recomputed from the lane helpers), so a
// change in which transform lands on which series is caught.
//
// uPlot needs aligned data: one x column and parallel y columns. Each
// signal arrives with its own timestamps (its own message, its own
// cycle rate), so `mergeSeries` unions the timestamps and sample-and-
// holds each signal forward, leaving `null` before its first sample.
describe("PlotArea y-normalisation", () => {
  const ENUM3 = [
    { raw: 0, label: "Idle" },
    { raw: 1, label: "Run" },
    { raw: 2, label: "Fault" },
  ];

  /** uPlot only constructs against a real-sized canvas. */
  function stubSize() {
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    return () => {
      cw.mockRestore();
      ch.mockRestore();
    };
  }

  /** The data most recently handed to the newest uPlot instance. */
  function lastData(): (number | null)[][] {
    const inst = uplotInstances[uplotInstances.length - 1] as unknown as {
      data: (number | null)[][];
    };
    return inst.data;
  }

  /** The y-axis tick labels the newest instance would draw at `splits`.
   * Tick *positions* stay on the normalised [0, 1] scale; the label
   * formatter maps them back through the axis's range, so this is where
   * the scale an axis actually settled on is observable. */
  function yTickLabels(splits: number[]): string[] {
    const inst = uplotInstances[uplotInstances.length - 1] as unknown as {
      opts: { axes: { values: (u: unknown, s: number[]) => string[] }[] };
    };
    return inst.opts.axes[1].values(inst, splits);
  }

  /** Wait for the newest instance's data to satisfy `check`.
   *
   * Value tables resolve asynchronously, after the area has rendered at
   * least once, and their resolution re-runs the resample — so the
   * first `setData` an area receives can predate them. */
  async function waitForData(check: (d: (number | null)[][]) => void) {
    await waitFor(() => {
      expect(uplotInstances.length).toBeGreaterThan(0);
      const d = lastData();
      expect(d[0]?.length ?? 0).toBeGreaterThan(0);
      check(d);
    });
  }

  /** Add `names` to the focused area, then switch the area to `mode`. */
  async function addSignals(names: string[], mode?: string) {
    const picker = screen.getByLabelText("add signal to focused plot area");
    for (const n of names) {
      await pickCombobox(picker, `*|s:256:${n}`);
      await waitFor(() => expect(screen.getByText(n)).toBeInTheDocument());
    }
    if (mode) await pickCombobox(screen.getByLabelText("y-axis mode"), mode);
  }

  /** Click the hide swatch on `name`'s side-panel row. */
  function hideSignal(name: string) {
    const row = screen.getByText(name).closest(".plot-signal-row")!;
    fireEvent.click(row.querySelector(".plot-signal-swatch")!);
  }

  it("enum lanes: each signal is normalised into its own lane band", async () => {
    // Two 3-code enums on one per-unit area → a two-lane axis. Lane 0
    // (top) spans [0.5375, 0.9625], lane 1 spans [0.0375, 0.4625]; each
    // code maps to its fraction of the table's padded range [-0.5, 2.5],
    // i.e. 1/6, 1/2, 5/6 of the band.
    mockValueTables.EngineSpeed = ENUM3;
    mockValueTables.EngineTemp = ENUM3;
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [0, 1, 2] };
    mockSampleSeries.EngineTemp = { t: [0, 1, 2], v: [0, 1, 2] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed", "EngineTemp"], "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
      await waitForData((data) => {
        expect(data[0]).toEqual([0, 1, 2]);
        expect(data[1]?.[0]).toBeCloseTo(0.6083333, 6);
        expect(data[1]?.[1]).toBeCloseTo(0.75, 6);
        expect(data[1]?.[2]).toBeCloseTo(0.8916667, 6);
        // Same codes, lane 1 — a whole band lower.
        expect(data[2]?.[0]).toBeCloseTo(0.1083333, 6);
        expect(data[2]?.[1]).toBeCloseTo(0.25, 6);
        expect(data[2]?.[2]).toBeCloseTo(0.3916667, 6);
      });
    } finally {
      restore();
    }
  });

  it("enum lanes: a late value-table resolution re-normalises the data", async () => {
    // Regression: tables are fetched after the area first renders, and
    // the lane normalisation runs *through* them, so a resolution has
    // to re-run the resample. A redraw cannot fix it — the no-table
    // midline fallback (lane 0 → 0.75, lane 1 → 0.25) is baked into the
    // data, not the drawing. A live trace papers over it on the next
    // tick; a stopped trace would sit on flat lanes forever.
    mockValueTables.EngineSpeed = ENUM3;
    mockValueTables.EngineTemp = ENUM3;
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [0, 1, 2] };
    mockSampleSeries.EngineTemp = { t: [0, 1, 2], v: [0, 1, 2] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed", "EngineTemp"], "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
      // No manual resample: the lanes must leave the midline on their own.
      await waitForData((data) => {
        expect(data[1]).not.toEqual([0.75, 0.75, 0.75]);
        expect(data[2]).not.toEqual([0.25, 0.25, 0.25]);
        expect(data[1]?.[2]).toBeCloseTo(0.8916667, 6);
      });
    } finally {
      restore();
    }
  });

  it("enum lanes: sample-and-hold and the pre-first-sample null survive", async () => {
    // The signals have *different* timestamps, so the merge has real
    // work to do: union to [0, 1, 2], hold each value forward, and leave
    // `null` before a signal's first sample. A null must stay null —
    // normalising one would silently plot a bogus lane position.
    mockValueTables.EngineSpeed = ENUM3;
    mockValueTables.EngineTemp = ENUM3;
    mockSampleSeries.EngineSpeed = { t: [0, 2], v: [0, 2] };
    mockSampleSeries.EngineTemp = { t: [1], v: [1] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed", "EngineTemp"], "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
      await waitForData((data) => {
        expect(data[0]).toEqual([0, 1, 2]);
        // Code 0 held across x=1, then code 2.
        expect(data[1]?.[0]).toBeCloseTo(0.6083333, 6);
        expect(data[1]?.[1]).toBeCloseTo(0.6083333, 6);
        expect(data[1]?.[2]).toBeCloseTo(0.8916667, 6);
        // No sample until x=1 → null first, then code 1 held forward.
        expect(data[2]?.[0]).toBeNull();
        expect(data[2]?.[1]).toBeCloseTo(0.25, 6);
        expect(data[2]?.[2]).toBeCloseTo(0.25, 6);
      });
    } finally {
      restore();
    }
  });

  it("numeric: each unit group is normalised to [0, 1] by its own range", async () => {
    // No value tables → both signals numeric. Values 10/20/15 against
    // the host extent 10..20 → 0, 1, 0.5. rpm and degC are separate
    // unit groups but share an extent here, so both rows match.
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [10, 20, 15] };
    mockSampleSeries.EngineTemp = { t: [0, 1, 2], v: [10, 20, 15] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed", "EngineTemp"]);
      await waitForData((data) => {
        expect(data[0]).toEqual([0, 1, 2]);
        expect(data[1]?.[0]).toBeCloseTo(0, 6);
        expect(data[1]?.[1]).toBeCloseTo(1, 6);
        expect(data[1]?.[2]).toBeCloseTo(0.5, 6);
        expect(data[2]?.[0]).toBeCloseTo(0, 6);
        expect(data[2]?.[1]).toBeCloseTo(1, 6);
        expect(data[2]?.[2]).toBeCloseTo(0.5, 6);
      });
    } finally {
      restore();
    }
  });

  it("enum lanes: hiding a lane hands its vertical space to the rest", async () => {
    // Three enums on one per-unit area → a three-lane axis. Hide the
    // middle one and the two survivors must re-flow onto a *two*-lane
    // layout — the hidden lane's share of the axis height goes to them,
    // it does not stay reserved.
    mockValueTables.EngineSpeed = ENUM3;
    mockValueTables.EngineTemp = ENUM3;
    mockValueTables.LimitNominal = ENUM3;
    for (const n of ["EngineSpeed", "EngineTemp", "LimitNominal"]) {
      mockSampleSeries[n] = { t: [0, 1, 2], v: [0, 1, 2] };
    }
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed", "EngineTemp", "LimitNominal"], "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
      // Three lanes: lane 1 (the middle) centres on 0.5.
      await waitForData((data) => expect(data[2]?.[1]).toBeCloseTo(0.5, 6));
      hideSignal("EngineTemp");
      // Two lanes: [0.5375, 0.9625] and [0.0375, 0.4625]; code 1 sits
      // at the band midpoint, codes 0 / 2 at 1/6 and 5/6 of the band.
      await waitForData((data) => {
        expect(data[1]?.[0]).toBeCloseTo(0.6083333, 6);
        expect(data[1]?.[1]).toBeCloseTo(0.75, 6);
        expect(data[1]?.[2]).toBeCloseTo(0.8916667, 6);
        expect(data[3]?.[0]).toBeCloseTo(0.1083333, 6);
        expect(data[3]?.[1]).toBeCloseTo(0.25, 6);
        expect(data[3]?.[2]).toBeCloseTo(0.3916667, 6);
      });
    } finally {
      restore();
    }
  });

  it("a signal's readout takes the decimal precision its DBC factor implies", async () => {
    // EngineSpeed is a scaled integer (factor 0.25 → `decimals: 2` on
    // its catalog record): its readout holds two decimals, so a value
    // that lands on a half still reads to the signal's own precision
    // rather than being trimmed like a float.
    mockSignalExtents.EngineSpeed = { lo: 12, hi: 13 };
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [12.5, 12.5, 12.5] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed"]);
      await waitFor(() =>
        expect(document.querySelector(".plot-signal-value")?.textContent).toBe("12.50 rpm"),
      );
    } finally {
      restore();
    }
  });

  it("y-axis ticks stay decimal until a value needs more than five decimals", async () => {
    // The tick labels shared no threshold with the value readouts: an
    // axis spanning 0…0.0002 read "1.0e-4" at its midpoint while the
    // signal area printed the digits.
    mockSignalExtents.LimitNominal = { lo: 0, hi: 0.0002 };
    mockSampleSeries.LimitNominal = { t: [0, 1, 2], v: [0, 0.0001, 0.0002] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["LimitNominal"], "per-unit");
      await waitForData((data) => {
        expect(data[1]?.[1]).toBeCloseTo(0.5, 6);
      });
      await waitFor(() =>
        expect(yTickLabels([0, 0.5, 1])).toEqual(["0 A", "0.0001 A", "0.0002 A"]),
      );
    } finally {
      restore();
    }
  });

  it("numeric: a hidden signal no longer sets its unit group's scale", async () => {
    // Two amps signals on one per-unit axis: a 3000 A "nominal" limit
    // and a 0–500 A "effective" one. While both are visible the group
    // unions to 0..3000 and the effective limit is squashed into the
    // bottom sixth; hiding the nominal must rescale the axis to what is
    // actually drawn.
    mockSignalExtents.LimitNominal = { lo: 0, hi: 3000 };
    mockSignalExtents.LimitEffective = { lo: 0, hi: 500 };
    mockSampleSeries.LimitNominal = { t: [0, 1, 2], v: [3000, 3000, 3000] };
    mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [0, 250, 500] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["LimitNominal", "LimitEffective"], "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
      await waitForData((data) => {
        expect(data[2]?.[1]).toBeCloseTo(250 / 3000, 6);
        expect(data[2]?.[2]).toBeCloseTo(500 / 3000, 6);
      });
      hideSignal("LimitNominal");
      await waitForData((data) => {
        expect(data[2]?.[0]).toBeCloseTo(0, 6);
        expect(data[2]?.[1]).toBeCloseTo(0.5, 6);
        expect(data[2]?.[2]).toBeCloseTo(1, 6);
      });
    } finally {
      restore();
    }
  });

  it("numeric: same-unit signals share one scale even when one is constant", async () => {
    // A limit that never moves has a degenerate all-time extent
    // (`hi === lo`). It still belongs to its unit group: 3000 A must
    // draw at the top of a 400..3000 A axis, not at the canvas midline
    // while the other amps signal fills the canvas on a scale of its
    // own — per-unit mode exists to keep them commensurable (ADR 0026).
    mockSignalExtents.LimitNominal = { lo: 3000, hi: 3000 };
    mockSignalExtents.LimitEffective = { lo: 400, hi: 500 };
    mockSampleSeries.LimitNominal = { t: [0, 1, 2], v: [3000, 3000, 3000] };
    mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [400, 450, 500] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["LimitNominal", "LimitEffective"], "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
      await waitForData((data) => {
        // One shared scale, 400..3000 (span 2600).
        expect(data[1]?.[0]).toBeCloseTo(1, 6);
        expect(data[1]?.[2]).toBeCloseTo(1, 6);
        expect(data[2]?.[0]).toBeCloseTo(0, 6);
        expect(data[2]?.[1]).toBeCloseTo(50 / 2600, 6);
        expect(data[2]?.[2]).toBeCloseTo(100 / 2600, 6);
      });
    } finally {
      restore();
    }
  });

  it("numeric: a unit group with no span reads as its value, not a bare 0–1 scale", async () => {
    // The degenerate end of the case above: the group's whole range is
    // one value, so there is nothing to normalise by. It gets a ±10 %
    // minimum range instead, so the trace still sits mid-canvas (never
    // NaN — dividing by a zero span would draw nothing at all) but the
    // axis labels read the value it holds rather than 0…1.
    mockSignalExtents.LimitNominal = { lo: 3000, hi: 3000 };
    mockSampleSeries.LimitNominal = { t: [0, 1, 2], v: [3000, 3000, 3000] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["LimitNominal"], "per-unit");
      await waitForData((data) => {
        expect(data[1]).toEqual([0.5, 0.5, 0.5]);
      });
      await waitFor(() => expect(yTickLabels([0, 0.5, 1])).toEqual(["2700 A", "3000 A", "3300 A"]));
    } finally {
      restore();
    }
  });

  it("numeric: a constant of exactly zero gets an absolute ±1 band", async () => {
    // A proportional band collapses at zero, so the fraction cannot be
    // the rule there — the axis falls back to an absolute ±1.
    mockSignalExtents.LimitNominal = { lo: 0, hi: 0 };
    mockSampleSeries.LimitNominal = { t: [0, 1, 2], v: [0, 0, 0] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["LimitNominal"], "per-unit");
      await waitForData((data) => {
        expect(data[1]).toEqual([0.5, 0.5, 0.5]);
      });
      await waitFor(() => expect(yTickLabels([0, 0.5, 1])).toEqual(["-1 A", "0 A", "1 A"]));
    } finally {
      restore();
    }
  });

  /// Unit each fixture signal declares — needed to seed an area
  /// through saved config, where the signal refs are written out in
  /// full rather than picked from the catalog.
  const unitOf = (name: string) => SIGNALS.find((s) => s.signal_name === name)?.unit ?? "";
  let seedCounter = 0;

  /// A panel restored from saved config holding one area with `signals`
  /// and (optionally) per-axis scale settings. The saved-config path is
  /// the only way to pin a *known* axis id: a freshly added area's id
  /// is a UUID, and the derived-axis ids the settings key off are built
  /// from it.
  function renderSeeded(opts: { signals: string[]; axisScales?: Record<string, unknown> }) {
    const elementId = `el-scale-${seedCounter++}`;
    return renderPanel({
      params: { elementId },
      registry: makeRegistry({
        id: elementId,
        config: {
          areas: [
            {
              id: "a1",
              signals: opts.signals.map((n) => ({
                busId: null,
                messageId: 256,
                extended: false,
                signalName: n,
                messageName: "EngineData",
                unit: unitOf(n),
                color: "#4ecbff",
              })),
            },
          ],
          ...(opts.axisScales ? { axisScales: opts.axisScales } : {}),
        },
      }),
    });
  }

  /// The `axisScales` dict in the panel's most recent persist.
  function persistedScales(api: { updateParameters: { mock: { calls: unknown[][] } } }) {
    const calls = api.updateParameters.mock.calls;
    return (calls[calls.length - 1]?.[0] ?? {}) as { axisScales?: Record<string, unknown> };
  }

  it("a manual max beats the follow-live extent", async () => {
    // The whole point of pinning a bound: it must not silently stop
    // applying the moment the capture grows past it. The host's
    // all-time extent says 400..500; the axis draws 400..1000.
    mockSignalExtents.LimitEffective = { lo: 400, hi: 500 };
    mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [400, 450, 500] };
    const restore = stubSize();
    try {
      renderSeeded({ signals: ["LimitEffective"], axisScales: { a1: { max: 1000 } } });
      await waitForData((data) => {
        expect(data[1]?.[0]).toBeCloseTo(0, 6);
        expect(data[1]?.[1]).toBeCloseTo(50 / 600, 6);
        expect(data[1]?.[2]).toBeCloseTo(100 / 600, 6);
      });
      await waitFor(() => expect(yTickLabels([0, 0.5, 1])).toEqual(["400 A", "700 A", "1000 A"]));
    } finally {
      restore();
    }
  });

  it("either bound stands alone — a manual min leaves the max automatic", async () => {
    mockSignalExtents.LimitEffective = { lo: 400, hi: 500 };
    mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [400, 450, 500] };
    const restore = stubSize();
    try {
      renderSeeded({ signals: ["LimitEffective"], axisScales: { a1: { min: 0 } } });
      await waitForData((data) => {
        expect(data[1]?.[0]).toBeCloseTo(0.8, 6);
        expect(data[1]?.[2]).toBeCloseTo(1, 6);
      });
      await waitFor(() => expect(yTickLabels([0, 1])).toEqual(["0 A", "500 A"]));
    } finally {
      restore();
    }
  });

  it("log: values map by decades and the ticks land on decade boundaries", async () => {
    mockSignalExtents.LimitEffective = { lo: 1, hi: 100 };
    mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [1, 10, 100] };
    const restore = stubSize();
    try {
      renderSeeded({ signals: ["LimitEffective"], axisScales: { a1: { log: true } } });
      await waitForData((data) => {
        expect(data[1]?.[0]).toBeCloseTo(0, 6);
        expect(data[1]?.[1]).toBeCloseTo(0.5, 6);
        expect(data[1]?.[2]).toBeCloseTo(1, 6);
      });
      const inst = uplotInstances[uplotInstances.length - 1] as unknown as {
        opts: { axes: { splits: () => number[] }[] };
      };
      expect(inst.opts.axes[1].splits()).toEqual([0, 0.5, 1]);
      await waitFor(() => expect(yTickLabels([0, 0.5, 1])).toEqual(["1 A", "10 A", "100 A"]));
    } finally {
      restore();
    }
  });

  it("log: a non-positive point is dropped, not clamped onto the floor", async () => {
    // A clamped point sitting on the axis floor reads as a real
    // reading, so the sample leaves a gap instead.
    mockSignalExtents.LimitEffective = { lo: -5, hi: 10 };
    mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [-5, 0, 10] };
    const restore = stubSize();
    try {
      renderSeeded({ signals: ["LimitEffective"], axisScales: { a1: { log: true } } });
      await waitForData((data) => {
        expect(data[1]?.[0]).toBeNull();
        expect(data[1]?.[1]).toBeNull();
        expect(data[1]?.[2]).toBeCloseTo(0, 6);
      });
    } finally {
      restore();
    }
  });

  it("log: a series with no positive value at all says so rather than drawing an empty axis", async () => {
    mockSignalExtents.LimitEffective = { lo: -5, hi: -1 };
    mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [-5, -3, -1] };
    const restore = stubSize();
    try {
      renderSeeded({ signals: ["LimitEffective"], axisScales: { a1: { log: true } } });
      await waitFor(() => expect(screen.getByText(/no positive values/i)).toBeInTheDocument());
      await waitFor(() => expect(screen.getByText(/no positive values/i).textContent).toContain("LimitEffective"));
    } finally {
      restore();
    }
  });

  it("fit y clears a manual range instead of writing numbers into it", async () => {
    // Under a sparse store, "fit y" and "clear the fields" are the same
    // intent — go back to automatic — so they do the same thing. Fit y
    // seeding the fields would silently pin every axis it ever fitted.
    mockSignalExtents.LimitEffective = { lo: 400, hi: 500 };
    mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [400, 450, 500] };
    const restore = stubSize();
    try {
      const { api } = renderSeeded({
        signals: ["LimitEffective"],
        axisScales: { a1: { min: 0, max: 1000 } },
      });
      await waitFor(() => expect(persistedScales(api).axisScales).toEqual({ a1: { min: 0, max: 1000 } }));
      await act(async () => {
        fireEvent.click(document.querySelector(".plot-area-fit-y")!);
      });
      await waitFor(() => expect(persistedScales(api).axisScales).toEqual({}));
    } finally {
      restore();
    }
  });

  it("keeps an axis's settings across a mode change and drops them when its signals go", async () => {
    // `a1/u:unit:A` is a *per-unit* axis id, and the area is in
    // `unified` mode — so nothing derives it right now. It survives all
    // the same, because switching back to per-unit must restore the
    // amps axis's range. `a1/u:unit:zz` has no signal of that unit left
    // in the area, so it retires.
    const restore = stubSize();
    try {
      const { api } = renderSeeded({
        signals: ["LimitEffective"],
        axisScales: { "a1/u:unit:A": { max: 5 }, "a1/u:unit:zz": { max: 1 } },
      });
      await waitFor(() =>
        expect(persistedScales(api).axisScales).toEqual({ "a1/u:unit:A": { max: 5 } }),
      );
    } finally {
      restore();
    }
  });

  /// Right-click the y-axis gutter — the strip left of the plot box.
  /// jsdom lays nothing out, so every rect is at x = 0 and a small
  /// `clientX` is inside the gutter while a large one is inside the
  /// plot box (which is what the real geometry check compares).
  function rightClickAxis(clientX: number) {
    const canvas = document.querySelectorAll(".plot-area-canvas");
    fireEvent.contextMenu(canvas[canvas.length - 1], { clientX, clientY: 10 });
  }

  it("right-clicking the y axis opens its scale menu; right-clicking the plot does not", async () => {
    const restore = stubSize();
    try {
      renderSeeded({ signals: ["LimitEffective"] });
      await waitFor(() => expect(document.querySelector(".plot-area-canvas")).toBeInTheDocument());
      rightClickAxis(400);
      expect(screen.queryByLabelText("y axis maximum")).not.toBeInTheDocument();
      rightClickAxis(4);
      expect(screen.getByLabelText("y axis minimum")).toBeInTheDocument();
      expect(screen.getByLabelText("y axis maximum")).toBeInTheDocument();
      expect(screen.getByLabelText("log scale")).not.toBeChecked();
    } finally {
      restore();
    }
  });

  it("a typed bound pins the axis, and clearing the field returns it to automatic", async () => {
    const restore = stubSize();
    try {
      const { api } = renderSeeded({ signals: ["LimitEffective"] });
      await waitFor(() => expect(document.querySelector(".plot-area-canvas")).toBeInTheDocument());
      rightClickAxis(4);
      const max = screen.getByLabelText("y axis maximum");
      await act(async () => {
        fireEvent.change(max, { target: { value: "1000" } });
        fireEvent.keyDown(max, { key: "Enter" });
      });
      await waitFor(() => expect(persistedScales(api).axisScales).toEqual({ a1: { max: 1000 } }));
      await act(async () => {
        fireEvent.change(max, { target: { value: "" } });
        fireEvent.keyDown(max, { key: "Enter" });
      });
      await waitFor(() => expect(persistedScales(api).axisScales).toEqual({}));
    } finally {
      restore();
    }
  });

  it("log hides the min box and gives it back, still holding its value", async () => {
    const restore = stubSize();
    try {
      const { api } = renderSeeded({ signals: ["LimitEffective"], axisScales: { a1: { min: 5 } } });
      await waitFor(() => expect(document.querySelector(".plot-area-canvas")).toBeInTheDocument());
      rightClickAxis(4);
      expect(screen.getByLabelText("y axis minimum")).toHaveValue("5");
      await act(async () => {
        fireEvent.click(screen.getByLabelText("log scale"));
      });
      // The min stops being settable — a log axis derives it — but the
      // value the user typed is held, not discarded.
      expect(screen.queryByLabelText("y axis minimum")).not.toBeInTheDocument();
      await waitFor(() => expect(persistedScales(api).axisScales).toEqual({ a1: { min: 5, log: true } }));
      await act(async () => {
        fireEvent.click(screen.getByLabelText("log scale"));
      });
      expect(screen.getByLabelText("y axis minimum")).toHaveValue("5");
      await waitFor(() => expect(persistedScales(api).axisScales).toEqual({ a1: { min: 5 } }));
    } finally {
      restore();
    }
  });

  it("an enum-lanes axis offers no scale menu", async () => {
    // A lane's geometry comes from `laneBandsForVisible`, not from a
    // value range, so neither a bound nor a log mapping means anything
    // there — the menu is omitted rather than offering something inert.
    mockValueTables.EngineSpeed = ENUM3;
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [0, 1, 2] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed"], "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
      await waitForData((data) => expect(data[1]?.[0]).not.toBe(0));
      rightClickAxis(4);
      expect(screen.queryByLabelText("y axis maximum")).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("single-enum axis: raw codes pass through un-normalised", async () => {
    // One enum on its own axis keeps the codes as-is — the y scale is
    // pinned to the table's raw range instead. This is the axis mode
    // that already agreed with the signal panel.
    mockValueTables.EngineSpeed = ENUM3;
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [0, 1, 2] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed"], "individual");
      await waitForData((data) => {
        expect(data[0]).toEqual([0, 1, 2]);
        expect(data[1]).toEqual([0, 1, 2]);
      });
    } finally {
      restore();
    }
  });
});

// The plot's x window is *panel*-wide (`xSyncRef`), and Fit Data sets it
// from the panel's data extent. Since the Tier 1 parked-view fast path,
// a window zoomed into history stops re-sampling while the capture
// grows — so the extent the panel carries stops advancing too. These
// tests pin down what Fit Data then shows.
//
// `sample_signals` reports the window's live edge (`last_seconds`) as a
// fact about the *window*, derived host-side from the store's anchors
// and independent of which signals were asked for; `mockSampleBounds`
// stands in for it, and moving it is this harness's "the capture grew".
describe("PlotPanel Fit Data over a parked window", () => {
  /// The live edge when the panel parks, and after the capture grows.
  const PARKED_EDGE = 2;
  const GROWN_EDGE = 9;
  /// Visible slice to park at: entirely inside history. `PlotArea` pads
  /// the fetch by ±20 %, so the slice actually requested ends at 1.12 —
  /// still short of `PARKED_EDGE`, which is what makes it parked.
  const HISTORY = { min: 0.4, max: 1.0 };

  beforeEach(() => {
    mockSampleBounds.last = PARKED_EDGE;
  });

  /// Replay a user zoom the way uPlot does — it moves its own x scale and
  /// then fires `setScale`, which the panel reads as a user pan/zoom
  /// (shared window updated, follow-live dropped).
  async function zoomInto(inst: FakeUPlotInst, min: number, max: number) {
    inst.scales.x = { min, max };
    await act(async () => {
      inst.fire("setScale", "x");
    });
  }

  /// Press the toolbar's Fit Data and return the x window it applied.
  async function pressFitData(inst: FakeUPlotInst): Promise<{ min: number; max: number }> {
    inst.xCalls.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fit data" }));
    });
    await act(async () => {});
    const last = inst.xCalls[inst.xCalls.length - 1];
    if (!last) throw new Error("fit data applied no x window");
    return last;
  }

  /// Grow the capture past the parked slice: the host's live edge moves
  /// to `GROWN_EDGE` and `winEnd` advances a few `trace-grew` ticks'
  /// worth. Real timers are off for this so the only thing that can
  /// re-sample is the window growth itself.
  async function growPastTheParkedSlice(growTrace: (n: number) => void) {
    mockSampleBounds.last = GROWN_EDGE;
    for (let n = 1; n <= 5; n++) {
      await act(async () => {
        growTrace(100 + n * 10);
      });
    }
  }

  it("Fit Data on a parked panel fits to the capture's true live edge", async () => {
    // THE REGRESSION. The panel parked at a live edge of 2 s, the capture
    // ran on to 9 s, and Fit Data — whose whole job is "show me
    // everything" — fits to 2. Nothing looks broken; the plot just ends
    // early, as though the capture had stopped when the user panned away.
    await withSizedCanvas(async () => {
      const { growTrace } = renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));
      // Let the 250 ms post-mount rebuild land before freezing the clock:
      // it destroys and replaces the area's uPlot, and `inst` is captured
      // by identity here and driven for the rest of the test.
      await new Promise((r) => setTimeout(r, 400));
      const inst = liveInstanceIn("Area 1");

      vi.useFakeTimers();
      try {
        await zoomInto(inst, HISTORY.min, HISTORY.max);
        await growPastTheParkedSlice(growTrace);

        expect((await pressFitData(inst)).max).toBe(GROWN_EDGE);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("repeated Fit Data presses agree on the live edge", async () => {
    // This started as the severity question: before the fix the first
    // press fit to the stale edge, and landing the right edge *on* that
    // edge un-parked the window, so the re-sample it forced refreshed the
    // extent and the second press was right — one press stale, not stuck
    // for the session. Now both presses are right, and this guards the
    // second one against re-acquiring a stale edge from the first.
    await withSizedCanvas(async () => {
      const { growTrace } = renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 400));
      const inst = liveInstanceIn("Area 1");

      vi.useFakeTimers();
      try {
        await zoomInto(inst, HISTORY.min, HISTORY.max);
        await growPastTheParkedSlice(growTrace);

        await pressFitData(inst);
        expect((await pressFitData(inst)).max).toBe(GROWN_EDGE);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("every area of a panel parks together — a second area is no rescue", async () => {
    // `sharedExtent()` maxes over the areas, so one area still reaching
    // the live edge would keep the panel's cached extent fresh. It can't
    // happen: the x window is panel-wide, so all areas request the same
    // slice and park as one — which is why Fit Data can't lean on the
    // cached extent and asks the host instead. Both areas stay quiet
    // while the capture grows, and both land on the same fitted window.
    await withSizedCanvas(async () => {
      const { growTrace } = renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      fireEvent.click(screen.getByRole("button", { name: "add plot area" }));
      await act(async () => {
        dropSignal("Area 2", "EngineTemp", "degC");
      });
      await new Promise((r) => setTimeout(r, 500));
      const a1 = liveInstanceIn("Area 1");
      const a2 = liveInstanceIn("Area 2");

      vi.useFakeTimers();
      try {
        await zoomInto(a1, HISTORY.min, HISTORY.max);
        const afterZoom = sampleCalls();
        await growPastTheParkedSlice(growTrace);
        // The Tier 1 exit criterion: no host round-trips while parked.
        expect(sampleCalls()).toBe(afterZoom);

        a2.xCalls.length = 0;
        const fitted = await pressFitData(a1);
        // Both areas were moved to the same window, and it spans the
        // whole capture — not the part of it they had seen.
        expect(a2.xCalls[a2.xCalls.length - 1]).toEqual(fitted);
        expect(fitted.max).toBe(GROWN_EDGE);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("PlotPanel follow-live slide cadence", () => {
  /// `performance.now()` that steps forward a fixed amount per read. Real
  /// areas resample milliseconds apart, so each one evaluates the
  /// follow-live clock at a *different* instant and derives a slightly
  /// different x window; a frozen clock would hide that behind
  /// `applyXAll`'s equality skip and make the assertion vacuous.
  function steppingClock(stepMs: number) {
    let t = 100_000;
    return vi.spyOn(performance, "now").mockImplementation(() => (t += stepMs));
  }

  /// rAF under test control: the panel coalesces its follow-live slide
  /// into one frame, so "how many frames ran" has to be an input, not a
  /// race against jsdom's real clock.
  function captureFrames() {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queued.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    return async () => {
      const due = queued.splice(0);
      await act(async () => {
        for (const cb of due) cb(0);
      });
    };
  }

  it("slides the shared x window once per frame, not once per area", async () => {
    // `applyXAll` fans a new window out to *every* uPlot in the panel, and
    // it ran once per area resample — so N areas cost N² canvas redraws
    // per resample interval. The equality skip can't save it: each area
    // reads its own `performance.now()`, so the windows differ.
    await withSizedCanvas(async () => {
      const runFrames = captureFrames();
      renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      fireEvent.click(screen.getByRole("button", { name: "add plot area" }));
      fireEvent.click(screen.getByRole("button", { name: "add plot area" }));
      // A cross-area drop is an *add*, so the same signal can sit in all
      // three areas — enough to give each one a live uPlot.
      await act(async () => dropSignal("Area 2", "EngineSpeed", "rpm"));
      await act(async () => dropSignal("Area 3", "EngineSpeed", "rpm"));
      await runFrames();
      await act(async () => {});
      await runFrames();
      // Wait out every area's one-shot post-mount uPlot rebuild before
      // capturing instances. That rebuild is a real 250 ms timer *per
      // area*, and the three areas mount at three different instants, so
      // on a loaded machine the assertions below straddle it: a rebuild
      // deregisters the captured instance and registers a fresh one, and
      // the panel's fan-out then lands on an instance the test isn't
      // holding. The captured one records nothing, which reads exactly
      // like "the panel slid one area's window but not another's" — the
      // flake this test used to show. It fires once per area, so once
      // it's past, no later delay can move the instances again.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      await runFrames();
      const areas = ["Area 1", "Area 2", "Area 3"].map(liveInstanceIn);

      const clock = steppingClock(5);
      try {
        // One resample in every area: toggling follow-live forces one
        // (the panel has to snap on/off the live edge immediately).
        const follow = screen.getByRole("checkbox", { name: /follow live/i });
        await act(async () => fireEvent.click(follow)); // off
        await runFrames();
        for (const a of areas) a.xCalls.length = 0;

        await act(async () => fireEvent.click(follow)); // on
        await act(async () => {});
        await runFrames();

        for (const a of areas) {
          // The one coalesced panel-wide slide reached this area — a
          // silent instance would satisfy the equality below vacuously
          // (`undefined` equals `undefined`), which is how the flake
          // could also pass for the wrong reason.
          expect(a.xCalls.length).toBeGreaterThanOrEqual(1);
          // At most the area's own re-pin of the shared window inside
          // `resample`, plus the one coalesced panel-wide slide.
          expect(a.xCalls.length).toBeLessThanOrEqual(2);
        }
        // …and it is the *same* window everywhere (one clock read, one
        // fan-out), which is what makes the equality skip able to fire.
        const last = areas.map((a) => a.xCalls[a.xCalls.length - 1]);
        expect(last[1]).toEqual(last[0]);
        expect(last[2]).toEqual(last[0]);
      } finally {
        clock.mockRestore();
      }
    });
  });
});

describe("PlotPanel diagnostic readouts", () => {
  const counter = (k: string) => diagCounts().get(k) ?? 0;

  /// `performance.now()` stepping by an uneven amount per read. The
  /// readouts this describe is about are *timings*, so a frozen (or
  /// evenly-stepping) clock makes every tick report the identical number
  /// and React's bail-on-same-value hides the per-tick `setState`s the
  /// test is trying to catch.
  function jitteryClock() {
    const real = performance.now.bind(performance);
    let i = 0;
    return vi.spyOn(performance, "now").mockImplementation(() => {
      i = (i + 1) % 7;
      return real() + i * 0.37;
    });
  }

  it("does not re-render the panel or its areas once per resample", async () => {
    // The toolbar's perf badge was fed by five panel-level `setState`s
    // per area resample. Every one of those re-rendered the panel, and
    // through it every `PlotArea` — so N areas cost N² React renders per
    // resample interval for a read-out nobody can follow above ~2 Hz.
    await withSizedCanvas(async () => {
      renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      fireEvent.click(screen.getByRole("button", { name: "add plot area" }));
      await act(async () => dropSignal("Area 2", "EngineSpeed", "rpm"));
      // Past the 250 ms post-mount uPlot rebuild, so its renders aren't
      // counted as steady-state cost.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });

      // A capture that actually grows. Without it the follow-live clock
      // coasts to its ceiling, the x window stops moving, and every tick
      // takes the windowed source's "unchanged" fast path — which reports
      // two of the five readouts instead of all five, and would make the
      // assertions below vacuous.
      const growing = setInterval(() => {
        mockSampleBounds.last += 0.05;
      }, 20);
      const clock = jitteryClock();
      try {
        const before = {
          panel: counter("render.PlotPanel"),
          area: counter("render.PlotArea"),
          resample: counter("plotarea.resample"),
        };
        // Let the self-paced resample loops run — the steady state of a
        // running plot, with no user interaction at all. Deliberately
        // *not* inside `act`: `act` collects every update in its scope
        // and flushes them together, which would collapse a second's
        // worth of per-tick renders into one and make the count
        // meaningless.
        await outsideAct(() => new Promise((r) => setTimeout(r, 1000)));
        const resamples = counter("plotarea.resample") - before.resample;
        expect(resamples).toBeGreaterThanOrEqual(10);
        // The badge flushes on its own ~2 Hz timer, so the panel renders a
        // handful of times over this second however many samples land.
        expect(counter("render.PlotPanel") - before.panel).toBeLessThanOrEqual(6);
        // An area re-renders for its own side-panel values, and for
        // nothing else — no cross-area fan-out.
        expect(counter("render.PlotArea") - before.area).toBeLessThanOrEqual(resamples + 4);
      } finally {
        clock.mockRestore();
        clearInterval(growing);
      }
    });
  });

  it("paces the fetch loop from the plot fetch interval setting", async () => {
    // Task 44's Tier 4: the plot's fetch cadence is a `settings.json`
    // field, not the per-panel toolbar control that was removed. The
    // test above measures the default (67 ms, so >= 10 fetches in a
    // second); this one raises the interval and the round-trips have
    // to actually thin out. The redraw path is untouched — it stays on
    // rAF — so only the fetch count moves.
    await withSizedCanvas(async () => {
      mockSettings.plot_fetch_interval_ms = 300;
      await hydrateSettings();
      renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      const growing = setInterval(() => {
        mockSampleBounds.last += 0.05;
      }, 20);
      const clock = jitteryClock();
      try {
        const before = counter("plotarea.resample");
        await outsideAct(() => new Promise((r) => setTimeout(r, 1000)));
        const resamples = counter("plotarea.resample") - before;
        // ~3 at 300 ms; the loop is self-paced, so it can only be
        // slower. Well clear of the >= 10 the default produces.
        expect(resamples).toBeGreaterThanOrEqual(1);
        expect(resamples).toBeLessThanOrEqual(6);
      } finally {
        clock.mockRestore();
        clearInterval(growing);
      }
    });
  });

  /// `performance.now()` with the synthetic per-tick render cost added
  /// in, so the area's own measurement of its synchronous section reads
  /// as expensive. Real elapsed time still flows underneath, so
  /// `setTimeout` and the loop's own cadence are unaffected.
  function costlyRenderClock(perTickMs: number) {
    const real = performance.now.bind(performance);
    mockRenderCost.perTickMs = perTickMs;
    mockRenderCost.accMs = 0;
    return vi.spyOn(performance, "now").mockImplementation(() => real() + mockRenderCost.accMs);
  }

  it("backs the fetch loop off when a tick's own render work is expensive", async () => {
    // The resample tail (merge onto the shared time
    // axis, normalise, `setData`, redraw) is synchronous UI-thread work
    // that grows with the series count. Waiting a fixed interval after
    // it lets one heavy area take an unbounded share of the frame — at
    // 512 series a Chromium CPU profile of the shipping app showed the
    // main thread 98 % busy and 38 % of seconds janked. The loop now
    // idles in proportion to what the last tick cost, so the thread
    // always gets slots back.
    //
    // 250 ms per tick against the default 67 ms interval: unpaced that
    // is ~4 ticks a second and no idle at all; paced it is 1000 ms of
    // idle per tick, so at most one or two land in the second.
    await withSizedCanvas(async () => {
      renderPanel();
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      const growing = setInterval(() => {
        mockSampleBounds.last += 0.05;
      }, 20);
      const clock = costlyRenderClock(250);
      try {
        const before = counter("plotarea.resample");
        await outsideAct(() => new Promise((r) => setTimeout(r, 1000)));
        const resamples = counter("plotarea.resample") - before;
        expect(resamples).toBeGreaterThanOrEqual(1);
        // Without the back-off this is the interval-paced ~13.
        expect(resamples).toBeLessThanOrEqual(3);
      } finally {
        clock.mockRestore();
        clearInterval(growing);
      }
    });
  });

  it("re-renders no plot area when only panel-local state changes", async () => {
    // `PlotArea` could not benefit from `React.memo` while the panel
    // handed it a fresh inline arrow for every callback on every render.
    await withSizedCanvas(async () => {
      // A *stopped* panel, so no self-paced resample can land between the
      // baseline read and the click and be mistaken for a fan-out.
      const registry = makeRegistry({
        id: "el-memo",
        trace: { start: 0, end: 60, isPaused: false },
      });
      renderPanel({ params: { elementId: "el-memo" }, registry });
      await pickCombobox(
        screen.getByLabelText("add signal to focused plot area"),
        "*|s:256:EngineSpeed",
      );
      fireEvent.click(screen.getByRole("button", { name: "add plot area" }));
      await act(async () => dropSignal("Area 2", "EngineSpeed", "rpm"));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });

      const before = counter("render.PlotArea");
      // Purely panel-local: the toolbar context menu. No `PlotArea` prop
      // depends on it.
      await act(async () => {
        fireEvent.contextMenu(document.querySelector(".plot-panel-toolbar")!);
      });
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(counter("render.PlotArea") - before).toBe(0);
    });
  });
});
