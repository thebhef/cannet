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
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { comboboxValue, pickCombobox } from "./comboboxTestKit";

/// Synthetic cost of a resample's synchronous section (see the
/// `setData` stub below). `perTickMs` is what one tick "costs";
/// `accMs` is the total charged so far, which a test adds to
/// `performance.now()` so the area's own measurement sees it.
/// Prefixed `mock` so the hoisted `vi.mock` factory may reference it.
const mockRenderCost = { perTickMs: 0, accMs: 0 };

/// What the stand-in for uPlot's own density-aware `points.show`
/// answers. `false` is the dense case — the axis has more columns in
/// view than there is room for markers — which is what the automatic
/// minimum-count floor has to override for a sparse *series*.
const mockUplotPointsShow = { answer: false };

/** A 2D context that records the calls that put ink on the canvas.
 * Style state is deliberately not recorded — `PlotArea.draw.test.ts`
 * owns *how* each mark is styled; what this tier is for is **which
 * instance** drew one. */
function drawRecorder(ops: { op: string; args: number[] }[]) {
  const rec =
    (op: string) =>
    (...args: unknown[]) => {
      ops.push({ op, args: args as number[] });
    };
  return {
    canvas: { width: 600 },
    font: "",
    lineWidth: 1,
    strokeStyle: "",
    fillStyle: "",
    textAlign: "left",
    textBaseline: "middle",
    shadowColor: "",
    shadowBlur: 0,
    save: () => {},
    restore: () => {},
    setLineDash: () => {},
    beginPath: rec("beginPath"),
    arc: rec("arc"),
    fill: rec("fill"),
    stroke: rec("stroke"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    rect: rec("rect"),
    clip: rec("clip"),
    fillRect: rec("fillRect"),
    strokeRect: rec("strokeRect"),
    fillText: rec("fillText"),
    measureText: (t: string) => ({ width: t.length * 6 }),
  } as unknown as CanvasRenderingContext2D;
}

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
    /** The plot box the draw hook paints inside. */
    bbox = { left: 0, top: 0, width: 600, height: 400 };
    /** Every ink call the draw hook made on this instance, in order.
     * jsdom has no canvas, so a recorder stands in — without one, the
     * overlay (the shared crosshair, the hover markers) is unreachable
     * from the panel tier, and the overlay is the only place a claim
     * about *another* area's drawing can be checked. */
    drawOps: { op: string; args: number[] }[] = [];
    ctx = drawRecorder(this.drawOps);
    opts: {
      hooks?: Record<string, ((u: FakeUPlot) => void)[]>;
      series?: { width?: number }[];
    };
    root: HTMLElement;
    /** The live series objects, as real uPlot exposes them off the
     * options it was constructed with. Their `width` is read back on
     * every draw, so writing to it is how a restyle that changes no
     * data (a bolded selection) reaches the canvas. */
    series: { width?: number }[];
    constructor(opts: FakeUPlot["opts"], data: unknown, el: HTMLElement) {
      this.opts = opts;
      this.series = opts.series ?? [];
      // Real uPlot fills in its density-aware `points.show` during
      // construction when the caller left it unset. Stand that in with
      // a constant a test can set, so the auto marker floor's "defer to
      // uPlot above the floor" half is observable at all.
      for (let i = 1; i < this.series.length; i++) {
        const s = this.series[i] as { points?: { show?: unknown } };
        s.points = { ...(s.points ?? {}) };
        if (s.points.show === undefined) s.points.show = () => mockUplotPointsShow.answer;
      }
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
    /** x value → px, the inverse of `posToVal` above, so a mark the draw
     * hook paints reads back as the time it was painted at; y inverted
     * over the 400 px box. */
    valToPos(v: number, axis: string) {
      return axis === "x" ? v * 100 : 400 - v;
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
function encodeSample(
  series: { t: number[]; v: number[]; extrapolated?: [number, number][] }[],
  complete = true,
): ArrayBuffer {
  const totalPts = series.reduce((s, p) => s + p.t.length, 0);
  const totalSpans = series.reduce((s, p) => s + (p.extrapolated?.length ?? 0), 0);
  const buf = new ArrayBuffer(
    8 + 32 + 8 + series.length * 8 + totalPts * 16 + totalSpans * 16,
  );
  const view = new DataView(buf);
  const magic = [0x53, 0x49, 0x47, 0x53, 0x41, 0x4d, 0x50, 0x03];
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
  view.setUint32(off, complete ? 1 : 0, true);
  off += 4;
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
    const spans = p.extrapolated ?? [];
    view.setUint32(off, spans.length, true);
    off += 4;
    for (const [a, b] of spans) {
      view.setFloat64(off, a, true);
      off += 8;
      view.setFloat64(off, b, true);
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
// Per-signal extrapolated stretches the fake host serves alongside the
// points (ADR 0026), keyed by signal name; empty by default, so a test
// that doesn't ask for them sees the plot it always saw. The *rule* that
// produces these host-side is pinned in `signal_cache.rs`, and the wire
// they travel on in `plotData.test.ts`; what a panel test pins is the
// third link — what the renderer does once it has them. Prefixed `mock`
// for the hoisted factory.
const mockExtrapolated: Record<string, [number, number][]> = {};
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
/// While `on`, `sample_signals` answers the way a host mid-rebuild does:
/// a serve is bounded in time, so each call returns one more point than
/// the last and reports the series as **not** caught up, until `of`
/// points have been served. Set `of: 0` for the other partial shape — a
/// serve that has decoded nothing yet. Prefixed `mock` for the hoisted
/// factory.
const mockSampleRebuild = { on: false, served: 0, of: 0 };
/// Signal names the fake host holds **only** as file-backed series
/// (`docs/CONTEXT.md`). The host keys such a series by its provenance,
/// so a query that asks for it as a DBC-backed signal names an identity
/// nothing has ever decoded — and gets an empty serve, not the series.
/// Modelled here so a caller that drops the provenance flag is visible
/// in what the plot draws rather than only in the request. Prefixed
/// `mock` for the hoisted factory.
const mockFileBackedSignals = new Set<string>();
// Signals whose defining database is assigned to no bus. Such a database
// decodes nothing (`filter::dbc_applies`), so the host leaves its signals
// out of the descriptor universe and answers with no samples for them —
// which is what a view configured against it sees. Prefixed `mock` for
// the hoisted factory.
const mockUnassignedSignals = new Set<string>();
/// The host's categorical reduction, modelled so a lane's serve carries
/// what the real one carries: an **over-budget** window comes back as
/// its run boundaries (plus the series' last point, so the final tile
/// has an end); a window that already fits the point budget is served
/// whole, because the reduction exists to fit a budget and the sample
/// positions inside a run are what a renderer marks and a cursor snaps
/// to. Mirrors `signal_cache.rs::window_categorical`. Prefixed `mock`
/// for the hoisted factory.
function mockReduceRuns(s: { t: number[]; v: number[] }, maxPoints: number) {
  if (maxPoints === 0 || s.t.length <= maxPoints) return s;
  const t: number[] = [];
  const v: number[] = [];
  s.t.forEach((ts, i) => {
    if (i === 0 || s.v[i] !== s.v[i - 1]) {
      t.push(ts);
      v.push(s.v[i]);
    }
  });
  const last = s.t.length - 1;
  if (t[t.length - 1] !== s.t[last]) {
    t.push(s.t[last]);
    v.push(s.v[last]);
  }
  return { t, v };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { signals?: unknown[]; signalName?: string }) => {
    if (cmd === "list_signals")
      return SIGNALS.filter((sig) => !mockUnassignedSignals.has(sig.signal_name));
    if (cmd === "sample_signals") {
      if (mockSampleStall.on)
        return new Promise<ArrayBuffer>((resolve) => mockSampleStall.pending.push(resolve));
      if (mockSampleRebuild.on) {
        const n = Math.min(mockSampleRebuild.served + 1, mockSampleRebuild.of);
        mockSampleRebuild.served = n;
        const t = Array.from({ length: n }, (_, i) => i);
        return encodeSample(
          (args?.signals ?? []).map(() => ({ t, v: t.map((x) => 10 + x) })),
          mockSampleRebuild.of > 0 && n >= mockSampleRebuild.of,
        );
      }
      const req = args as { categorical?: boolean; maxPoints?: number } | undefined;
      return encodeSample(
        (args?.signals ?? []).map((s) => {
          const q = s as { signalName?: string; fileBacked?: boolean };
          const name = q.signalName ?? "";
          if (mockFileBackedSignals.has(name) && !q.fileBacked) return { t: [], v: [] };
          if (mockUnassignedSignals.has(name)) return { t: [], v: [] };
          const series = mockSampleSeries[name] ?? { t: [0, 1, 2], v: [10, 20, 15] };
          const points = req?.categorical ? mockReduceRuns(series, req.maxPoints ?? 0) : series;
          return { ...points, extrapolated: mockExtrapolated[name] ?? [] };
        }),
      );
    }
    if (cmd === "signal_min_max")
      // Host-owned all-time per-signal extent (ADR 0025) — matches the
      // sampled values' min/max so follow-live auto-norm has a range.
      return (args?.signals ?? []).map((s) => {
        const q = s as { signalName?: string; fileBacked?: boolean };
        const name = q.signalName ?? "";
        if (mockFileBackedSignals.has(name) && !q.fileBacked) return null;
        if (mockUnassignedSignals.has(name)) return null;
        return mockSignalExtents[name] ?? { lo: 10, hi: 20 };
      });
    if (cmd === "list_value_tables") return mockValueTables[args?.signalName ?? ""] ?? [];
    if (cmd === "get_settings") return { ...mockSettings };
    return undefined;
  }),
}));
// `listen` is hooked up by the filter-defined-areas / file-watcher
// pathway for `dbc-changed`. Handlers for that event are captured so a
// test can deliver it the way the host's watcher does; everything else
// just needs a resolved unsubscriber.
let dbcChangedHandlers: Array<() => void> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    if (name === "dbc-changed") dbcChangedHandlers.push(handler);
    return () => {
      dbcChangedHandlers = dbcChangedHandlers.filter((h) => h !== handler);
    };
  }),
}));
/// The host announcing that the loaded DBC set changed.
function announceDbcChange(): void {
  for (const h of [...dbcChangedHandlers]) h();
}

import * as uplotModule from "uplot";

/** The FakeUPlot surface the tests drive (see the mock above). */
type FakeUPlotInst = {
  cursor: { left: number };
  root: HTMLElement;
  over: HTMLElement;
  data: unknown;
  series: { width?: number }[];
  scales: Record<string, { min?: number; max?: number }>;
  xCalls: { min: number; max: number }[];
  redraws: number;
  drawOps: { op: string; args: number[] }[];
  fire: (hook: string, ...args: unknown[]) => void;
};
const uplotInstances = (uplotModule as unknown as { __instances: FakeUPlotInst[] }).__instances;

import { invoke } from "@tauri-apps/api/core";

import { PlotPanel } from "./PlotPanel";
import { PLOT_AREA_DND_MIME, type PlotAreaConfig } from "./plotPanelConfig";
import { parsePlotAreaDragData } from "./plotAreaTransfer";
import { SIGNAL_DND_MIME, parseSignalDragData } from "./dragSignals";
import { PanelCommandsContext, createPanelCommandRegistry } from "./panelCommands";
import { TraceDataProvider, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ElementRegistryContext, type ElementRegistry } from "./projectElements";
import { NotesContext, type NotesContextValue } from "./notesContext";
import { resetEventHighlight, selectEvents } from "./eventHighlight";
import type { Note } from "./notes";
import { SignalCatalogProvider } from "./signalCatalogContext";
import { SignalGeneratorContext } from "./signalGeneratorContext";
import { stableSignalColor, wheelColor } from "./palette";
import { signalKey } from "./plotData";
import { freshTrace } from "./trace";
import { makeLiveRegistry } from "./registryTestKit";
import type { ProjectElement } from "./types";
import { diagCounts } from "./diag";
import { AUTO_POINT_MARKER_FLOOR } from "./plotPoints";
import { FIRST_SAMPLE_INDICATOR_MS } from "./useFirstSampleWait";
import { hydrateSettings, updateSettings } from "./hostSettings";
import { THEMES, activeTheme, setActiveTheme } from "./theme";
import { startThemeSync } from "./themeSync";
import { LONG_SIGNAL_NAME, LONG_SIGNAL_TAIL, expectMiddleEllipsis } from "./longNameTestKit";

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
  /// Overrides for the session-buffer facts the panel mounts against —
  /// e.g. `{ count: 0 }` for a capture that holds no frames at all
  /// (a signals-only MDF import).
  trace?: Partial<TraceData>;
  /// Wire the panel-local command registry (`plot.setVisibleRange` and
  /// the existing `f`/`l`/`Mod+F` hotkeys) so a test can drive it with
  /// `commands.invoke(elementId, id, arg)`.
  commands?: ReturnType<typeof createPanelCommandRegistry>;
}) {
  const api = { updateParameters: vi.fn() };
  const props = { params: opts?.params ?? {}, api } as unknown as Parameters<typeof PlotPanel>[0];
  const registry = opts?.registry ?? makeRegistry();
  let baseData = { ...traceData, ...opts?.trace };
  let generatorIndexes: ReadonlyMap<string, number> = new Map();
  const build = (data: TraceData) => {
    let tree = (
      <TraceDataProvider value={data}>
        <ProjectContext.Provider value={projectCtx}>
          <SignalCatalogProvider>
            <ElementRegistryContext.Provider value={registry}>
              <SignalGeneratorContext.Provider value={generatorIndexes}>
                <PlotPanel {...props} />
              </SignalGeneratorContext.Provider>
            </ElementRegistryContext.Provider>
          </SignalCatalogProvider>
        </ProjectContext.Provider>
      </TraceDataProvider>
    );
    if (opts?.notes) tree = <NotesContext.Provider value={opts.notes}>{tree}</NotesContext.Provider>;
    if (opts?.commands) {
      tree = <PanelCommandsContext.Provider value={opts.commands}>{tree}</PanelCommandsContext.Provider>;
    }
    return tree;
  };
  const { rerender } = render(build(baseData));
  return {
    api,
    registry,
    /// Push a new session-buffer frame count through the trace context —
    /// what a `trace-grew` event does, and what moves the plot's `winEnd`.
    growTrace: (count: number) => {
      baseData = { ...baseData, count };
      rerender(build(baseData));
    },
    /// Bump the trace model's re-anchor epoch — what `invalidateCache`
    /// does on every DBC-set change the frontend makes (add, remove,
    /// reload in place, re-scope, open project).
    bumpEpoch: () => {
      baseData = { ...baseData, epoch: baseData.epoch + 1 };
      rerender(build(baseData));
    },
    /// Publish a new host-evaluated generator answer — what editing a
    /// generator rule does to every panel.
    setGeneratorIndexes: (m: ReadonlyMap<string, number>) => {
      generatorIndexes = m;
      rerender(build(baseData));
    },
  };
}

/// The toolbar's follow-live control. It is a chip toggle now, so its
/// position is `aria-pressed` rather than a checkbox's `checked`.
function followChip(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Follow Live" });
}

/// The points chip's current state, read off its own words.
function pointsMode(): string {
  return screen.getByRole("button", { name: "Show Points" }).textContent ?? "";
}

/// The areas as the panel last persisted them — what a reload would
/// parse back. `persist` dual-writes into the dockview params, so the
/// newest `updateParameters` call carrying an `areas` array is it.
function persistedAreas(api: { updateParameters: ReturnType<typeof vi.fn> }): PlotAreaConfig[] {
  const calls = api.updateParameters.mock.calls as unknown as [Record<string, unknown>][];
  for (let i = calls.length - 1; i >= 0; i--) {
    const areas = calls[i][0]?.areas;
    if (Array.isArray(areas)) return areas as PlotAreaConfig[];
  }
  throw new Error("the panel has not persisted any areas");
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

/// Drop a signal onto an area, the way the Database panel / another area
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

/// Drop `name` onto the panel's first area ("Area 1") — the setup most
/// tests below need ("there is a signal on the plot"), now that drag
/// and the patterns editor are the add paths (the toolbar's
/// single-pick `add signal…` combobox is gone). None of these tests
/// change which area is focused before calling this, so the target is
/// always the panel's default first area. The unit comes from the
/// fixture `SIGNALS` catalog, same as the old picker resolved it from.
function addFocusedSignal(name: string): void {
  const unit = SIGNALS.find((s) => s.signal_name === name)?.unit ?? "";
  dropSignal("Area 1", name, unit);
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

/// Fire a drop carrying a modifier state. jsdom implements no
/// `DragEvent`, so `fireEvent.drop` builds a plain `Event` and drops
/// every `MouseEventInit` field on the floor — `ctrlKey` included,
/// which is how the plot area tells a move from a copy. Define it on
/// the event object instead; React's synthetic event reads it straight
/// off the native one.
function dropWithCtrl(target: Element, dataTransfer: unknown, ctrlKey: boolean): void {
  const ev = createEvent.drop(target, { dataTransfer });
  Object.defineProperty(ev, "ctrlKey", { value: ctrlKey });
  fireEvent(target, ev);
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
  dbcChangedHandlers = [];
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const k of Object.keys(mockValueTables)) delete mockValueTables[k];
  for (const k of Object.keys(mockSampleSeries)) delete mockSampleSeries[k];
  for (const k of Object.keys(mockExtrapolated)) delete mockExtrapolated[k];
  for (const k of Object.keys(mockSignalExtents)) delete mockSignalExtents[k];
  mockSampleBounds.from = 0;
  mockSampleBounds.last = 2;
  mockSampleStall.on = false;
  mockSampleStall.pending.length = 0;
  mockSampleRebuild.on = false;
  mockSampleRebuild.served = 0;
  mockSampleRebuild.of = 0;
  mockRenderCost.perTickMs = 0;
  mockRenderCost.accMs = 0;
  mockFileBackedSignals.clear();
  mockUnassignedSignals.clear();
  mockUplotPointsShow.answer = false;
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  // Awaited: an un-awaited publish here can resolve inside a later
  // test's own `hydrateSettings()` call and clobber settings that
  // test just set up (see the `plot_fetch_interval_ms` case below).
  await hydrateSettings();
});

describe("PlotPanel", () => {
  it("starts with one plot area; cursors & measurements default off", () => {
    renderPanel();
    expect(screen.getByText("Area 1")).toBeInTheDocument();
    expect(screen.queryByText("Area 2")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Plot Area" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fit Data" })).toBeInTheDocument();
    for (const name of ["X Cursors", "Y Cursors", "Notes"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }
    expect(followChip()).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".plot-meas-strip")).toBeNull();
  });

  it("offers no toolbar single-pick add-signal combobox — drag and patterns are the add paths", () => {
    renderPanel();
    expect(screen.queryByLabelText("add signal to focused plot area")).not.toBeInTheDocument();
  });

  it("adds plot areas and exposes a remove affordance per area when >1", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
    expect(screen.getByText("Area 2")).toBeInTheDocument();
    const removeButtons = screen.getAllByTitle("remove this plot area");
    expect(removeButtons.length).toBe(2);
    // The retired × glyph is now the registry's drawn "x" icon.
    expect(removeButtons[0].textContent).toBe("");
    expect(removeButtons[0].querySelector("svg")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
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

  it("names a signal row's message by its DBC ancestry, ECU included", async () => {
    // The row's second line is the same bus · ecu · message the DBC
    // tree shows. The ECU isn't part of a plotted signal's identity, so
    // it's resolved from the catalog.
    renderPanel();
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    // No project buses in this harness, so the bus segment drops out.
    expect(screen.getByText("EngineEcu · EngineData")).toBeInTheDocument();
  });

  it("dropping the same signal onto an area twice is a no-op the second time", async () => {
    // Restates the old toolbar picker's "repeat pick is a no-op" pin
    // now that drag is the add path (the combobox is gone):
    // the drop handler's own per-area dedup (`onDropSignal`) is what
    // makes a second drop of the same signal onto the same area inert.
    renderPanel();
    dropSignal("Area 1", "EngineSpeed", "rpm");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    dropSignal("Area 1", "EngineSpeed", "rpm");
    expect(screen.getAllByText("EngineSpeed").length).toBe(1);
  });

  it("a growing trace window alone does not re-sample a running plot", async () => {
    // `trace-grew` moves `winEnd` ~10x/s. A *running* plot re-samples on
    // its own self-paced loop; a second trigger keyed on `winEnd` put an
    // undeduped 10 Hz floor under that cadence (its comment claimed a
    // `renderedThrough` skip that has never existed in the tree).
    await withSizedCanvas(async () => {
      const { growTrace } = renderPanel();
      addFocusedSignal("EngineSpeed");
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
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));

      const before = sampleCalls();
      await act(async () => {
        growTrace(30);
      });
      // Polled, not asserted synchronously: when the window change lands
      // while a fetch is still on the wire, the trigger hits the resample
      // busy-guard and the follow-up fetch arrives only after the
      // in-flight one completes. A synchronous read here raced that on
      // loaded CI runners. The mid-flight interleaving itself is pinned
      // deterministically by the next test.
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(before));
    });
  });

  it("a stopped plot's window change survives landing mid-fetch", async () => {
    // The timing hole behind the test above's CI flake, pinned
    // deterministically: the window moves while a fetch is still on the
    // wire, so the `winEnd` trigger fires into the resample busy-guard.
    // A stopped panel has no loop behind it — the contract is that the
    // change is still served afterward, with the window as it stands
    // now, not silently dropped leaving the stale slice on screen.
    await withSizedCanvas(async () => {
      const registry = makeRegistry({
        id: "el-stopped",
        trace: { start: 0, end: 60, isPaused: false },
      });
      const { growTrace } = renderPanel({ params: { elementId: "el-stopped" }, registry });
      addFocusedSignal("EngineSpeed");
      // Reach quiescence first: the mount fetch and the restored trace's
      // one-shot full-span fit both land, so neither can supply the
      // follow-up fetch below and mask a dropped trigger.
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));
      await act(async () => {
        await Promise.resolve();
      });
      const before = sampleCalls();

      // First window change fetches — and the fetch stalls on the wire.
      mockSampleStall.on = true;
      await act(async () => {
        growTrace(45);
      });
      await waitFor(() => expect(sampleCalls()).toBe(before + 1));

      // Second window change lands while it is still in flight (a Clear
      // racing a slow serve): the trigger fires into the busy-guard.
      await act(async () => {
        growTrace(30);
      });

      // Land the stalled fetch. The trigger already fired into the
      // guard; what must follow is a fresh fetch for the newest window,
      // from the panel's own completion path.
      mockSampleStall.on = false;
      await act(async () => {
        for (const resolve of mockSampleStall.pending.splice(0))
          resolve(encodeSample([{ t: [0, 1, 2], v: [10, 20, 15] }]));
        await Promise.resolve();
      });
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(before + 1));
      // Counting fetches is not enough: the panel must have asked for
      // the window as it stands *now*, not the one the stalled fetch
      // was serving.
      const lastWindowEnd = () => {
        const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "sample_signals");
        return (calls[calls.length - 1]?.[1] as { windowEnd?: number })?.windowEnd;
      };
      await waitFor(() => expect(lastWindowEnd()).toBe(30));
    });
  });

  it("dragging an internal signal-row between areas moves it (sourcePanelId matches)", async () => {
    // Internal drag = a payload that carries this panel's elementId
    // as `sourcePanelId`. The drop handler treats it as a move:
    // signal leaves area 1 and lands in area 2.
    renderPanel();
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
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
    // Database-panel users who expected each drop to add a fresh series.
    // Within-area reorder still works (covered by a separate test
    // below if one exists; the helper logic is tested via the
    // dragSignals + signalSelection unit suites).
    renderPanel();
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
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
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    const swatch = screen.getByTitle(/^hide this signal/);
    fireEvent.click(swatch);
    expect(screen.getByTitle(/^show this signal/)).toBeInTheDocument();
    // The signal's value still renders (it just isn't drawn on the plot).
    expect(screen.getByText("EngineSpeed")).toBeInTheDocument();
  });

  it("draws no measurement strip, even for a config that says it was on", () => {
    // The strip needs rework and stays hidden until it gets it. Hiding
    // it only from people who never turned it on would leave everyone
    // who had it with a permanent strip and no toggle left to dismiss
    // it with — strictly worse than before. So: hidden for everyone.
    renderPanel();
    expect(document.querySelector(".plot-meas-strip")).toBeNull();
    cleanup();
    renderPanel({ params: { measEnabled: true } });
    expect(document.querySelector(".plot-meas-strip")).toBeNull();
    expect(screen.queryByText("Δt")).toBeNull();
  });

  it("keeps the stored measurement preference untouched while it is suppressed", () => {
    // Suppressed on read, never written away: whoever reworks the strip
    // inherits each user's real preference rather than a field this
    // change silently zeroed. A test that only checked the strip was
    // absent would pass over an implementation that erased it.
    const { api } = renderPanel({ params: { measEnabled: true } });
    // Force a persist by changing something unrelated.
    fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
    const calls = api.updateParameters.mock.calls;
    const last = (calls[calls.length - 1]?.[0] ?? {}) as { measEnabled?: unknown };
    expect(last.measEnabled).toBe(true);
  });

  it("stores no color for a dropped signal and renders the resolved one", async () => {
    // Adding a series used to seed its color from its position in the
    // target area, so the same signal read differently in two areas.
    // Nothing is stored now: the swatch shows what the shared resolver
    // answers for that signal's identity (ADR 0026).
    const { api } = renderPanel();
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    addFocusedSignal("EngineTemp");
    await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
    const swatches = document.querySelectorAll(".plot-signal-swatch");
    expect(swatches.length).toBe(2);
    expect(swatches[0]).toHaveStyle({
      background: stableSignalColor(signalKey(null, 256, false, "EngineSpeed")),
    });
    expect(swatches[1]).toHaveStyle({
      background: stableSignalColor(signalKey(null, 256, false, "EngineTemp")),
    });
    const stored = persistedAreas(api)[0].signals;
    expect(stored.map((s) => s.signalName)).toEqual(["EngineSpeed", "EngineTemp"]);
    for (const s of stored) {
      expect(s.colorPick).toBeUndefined();
      expect((s as unknown as Record<string, unknown>).color).toBeUndefined();
    }
  });

  it("strokes an unpicked series with the resolver's color", async () => {
    await withSizedCanvas(async () => {
      renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(uplotInstances.length).toBeGreaterThan(0));
      const inst = liveInstanceIn("Area 1") as unknown as {
        opts: { series: { stroke?: unknown }[] };
      };
      const s = inst.opts.series[1];
      const stroke = typeof s.stroke === "function" ? (s.stroke as () => string)() : s.stroke;
      expect(stroke).toBe(stableSignalColor(signalKey(null, 256, false, "EngineSpeed")));
    });
  });

  it("recolors a stopped plot when a generator rule claims its signal", async () => {
    // A plot that isn't receiving samples draws only when asked. A
    // generator edit changes the color a live stroke function answers,
    // so without a redraw the canvas keeps the old color until
    // something else nudges it.
    await withSizedCanvas(async () => {
      const { setGeneratorIndexes } = renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(uplotInstances.length).toBeGreaterThan(0));
      const inst = liveInstanceIn("Area 1") as unknown as {
        opts: { series: { stroke?: unknown }[] };
        redraws: number;
      };
      const strokeOf = () => {
        const s = inst.opts.series[1];
        return typeof s.stroke === "function" ? (s.stroke as () => string)() : s.stroke;
      };
      const key = signalKey(null, 256, false, "EngineSpeed");
      expect(strokeOf()).toBe(stableSignalColor(key));
      const instancesBefore = uplotInstances.length;
      const redrawsBefore = inst.redraws;

      setGeneratorIndexes(new Map([[key, 5]]));

      expect(strokeOf()).toBe(wheelColor(5));
      // The side panel's swatch follows the same resolution point.
      expect(document.querySelector(".plot-signal-swatch") as HTMLElement).toHaveStyle({
        background: wheelColor(5),
      });
      // In place: no teardown + rebuild, and a redraw so the stopped
      // plot repaints instead of waiting for a tick.
      expect(uplotInstances.length).toBe(instancesBefore);
      expect(inst.redraws).toBeGreaterThan(redrawsBefore);
    });
  });

  it("persists a picked color as the series' pick, and the pick wins", async () => {
    const { api } = renderPanel();
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("pick series color"), {
      target: { value: "#123456" },
    });
    const swatch = document.querySelector(".plot-signal-swatch") as HTMLElement;
    expect(swatch.style.background).toBe("rgb(18, 52, 86)");
    await waitFor(() =>
      expect(persistedAreas(api)[0].signals[0].colorPick).toBe("#123456"),
    );
  });

  it("re-resolves a series whose stored color came from the old seeding, and honours a stored pick", async () => {
    // The upgrade case. A `color` written before the resolver is
    // indistinguishable from an explicit pick, so it is dropped and the
    // series re-resolves — which is what makes several areas holding the
    // same signals agree again. A `colorPick` is a real pick and stands.
    const sig = (signalName: string, over: Record<string, unknown>) => ({
      busId: null,
      messageId: 256,
      extended: false,
      signalName,
      messageName: "EngineData",
      unit: "rpm",
      ...over,
    });
    const registry = makeRegistry({
      id: "el-upgrade",
      config: {
        areas: [
          {
            id: "a1",
            signals: [
              sig("EngineSpeed", { color: "#ff0000" }),
              sig("EngineTemp", { colorPick: "#00ff00" }),
            ],
          },
        ],
      },
    });
    const { api } = renderPanel({ params: { elementId: "el-upgrade" }, registry });
    const swatches = document.querySelectorAll(".plot-signal-swatch");
    expect(swatches[0]).toHaveStyle({
      background: stableSignalColor(signalKey(null, 256, false, "EngineSpeed")),
    });
    expect(swatches[1]).toHaveStyle({ background: "#00ff00" });
    await waitFor(() => expect(persistedAreas(api)[0].signals).toHaveLength(2));
    const stored = persistedAreas(api)[0].signals;
    expect(stored[0].colorPick).toBeUndefined();
    expect((stored[0] as unknown as Record<string, unknown>).color).toBeUndefined();
    expect(stored[1].colorPick).toBe("#00ff00");
  });

  it("changing a series' color via the swatch picker updates the swatch", async () => {
    renderPanel();
    addFocusedSignal("EngineSpeed");
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
      addFocusedSignal("EngineSpeed");
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

  // Flipping the theme setting has to reach the canvas. The tokens
  // re-resolve on their own (a `data-theme` flip is all CSS needs), but
  // uPlot draws imperatively: a plot that isn't receiving samples keeps
  // whatever chrome it last drew until something asks it to redraw.
  it("follows a theme change live: the attribute flips and every plot redraws", async () => {
    await withSizedCanvas(async () => {
      renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(uplotInstances.length).toBeGreaterThan(0));
      const stop = startThemeSync();
      try {
        const inst = liveInstanceIn("Area 1") as unknown as {
          opts: { axes: { stroke?: unknown }[] };
          redraws: number;
        };
        const redrawsBefore = inst.redraws;
        await act(async () => {
          await updateSettings({ theme: "light" });
        });
        // The stylesheet's half of the switch.
        expect(document.documentElement.dataset.theme).toBe("light");
        expect(activeTheme()).toBe("light");
        // The canvas's half: a redraw, and an axis that resolves to the
        // applied theme's color when it happens. uPlot resolves axis
        // strokes per draw, so the second is what makes the first
        // enough.
        expect(inst.redraws).toBeGreaterThan(redrawsBefore);
        const stroke = inst.opts.axes[0].stroke;
        expect(typeof stroke === "function" ? (stroke as () => string)() : stroke).toBe(
          THEMES.light.axisText,
        );
      } finally {
        stop();
        setActiveTheme("dark");
      }
    });
  });

  // `lighthk` is a live switch on the same terms as any other theme —
  // same attribute, same redraw.
  it("follows a switch to the lighthk theme live, same as any other theme change", async () => {
    await withSizedCanvas(async () => {
      renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(uplotInstances.length).toBeGreaterThan(0));
      const stop = startThemeSync();
      try {
        const inst = liveInstanceIn("Area 1") as unknown as {
          opts: { axes: { stroke?: unknown }[] };
          redraws: number;
        };
        const redrawsBefore = inst.redraws;
        await act(async () => {
          await updateSettings({ theme: "lighthk" });
        });
        expect(document.documentElement.dataset.theme).toBe("lighthk");
        expect(activeTheme()).toBe("lighthk");
        expect(inst.redraws).toBeGreaterThan(redrawsBefore);
        const stroke = inst.opts.axes[0].stroke;
        expect(typeof stroke === "function" ? (stroke as () => string)() : stroke).toBe(
          THEMES.lighthk.axisText,
        );
      } finally {
        stop();
        setActiveTheme("dark");
      }
    });
  });

  it("y-axis-mode selector switches an area between unified / per-unit / individual; per-unit splits by unit", async () => {
    renderPanel();
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    addFocusedSignal("EngineTemp");
    await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
    // One area, two signals, unified mode → one canvas.
    expect(document.querySelectorAll(".plot-area").length).toBe(1);
    const modeSel = screen.getByLabelText("y-axis mode");
    expect(comboboxValue(modeSel)).toBe("unified");
    // Switch to per-unit. The fixture has two distinct units (rpm,
    // degC) so the derived axes split into two.
    await pickCombobox(modeSel, "per-unit");
    expect(document.querySelectorAll(".plot-area").length).toBe(2);
    // The area's name and the axis's own label are separate spans — the
    // axis's disclosure sits between them (ADR 0026).
    const axisLabels = () =>
      Array.from(document.querySelectorAll(".plot-area-axis-label")).map((e) => e.textContent);
    expect(screen.getAllByText("Area 1").length).toBe(2);
    expect(axisLabels()).toEqual(["[rpm]", "[degC]"]);
    // Switch to individual: same as per-unit here (one per signal).
    // Re-query the selector — react may have re-mounted it.
    await pickCombobox(screen.getByLabelText("y-axis mode"), "individual");
    expect(document.querySelectorAll(".plot-area").length).toBe(2);
    expect(axisLabels()).toEqual(["EngineSpeed", "EngineTemp"]);
  });

  // The guard that read "measurement strip lists each signal exactly
  // once in per-unit mode" lived here. It asserted on the strip's
  // rendered per-trace cells, and the strip does not render — nor does
  // `reportSeries` collect the series it read, so there is nothing left
  // for it to observe. Removed rather than left passing over an empty
  // document; the rework that brings the strip back brings it back with
  // it, and the derived-axis id mismatch it guarded is worth a failing
  // test first.

  it("show-points tri-state defaults to auto and persists to panel params", () => {
    const { api } = renderPanel();
    expect(pointsMode()).toBe("Points: Auto");
    // The chip cycles: auto → off → on → auto.
    fireEvent.click(screen.getByRole("button", { name: "Show Points" }));
    expect(pointsMode()).toBe("Points: Off");
    fireEvent.click(screen.getByRole("button", { name: "Show Points" }));
    expect(pointsMode()).toBe("Points: On");
    // Last updateParameters call carries the new mode.
    const calls = api.updateParameters.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] ?? {};
    expect(lastCall.showPoints).toBe("on");
  });

  it("the points and cursor-mode controls take a real press with measurements on", () => {
    // The toolbar's controls used to vanish with no effect when a row
    // was pressed: the panel root claims focus on any mousedown that
    // isn't already headed for a focusable. Driven with measurements
    // enabled — the state the report was made in — though the panel's
    // focus claim never consulted it.
    renderPanel({ params: { measEnabled: true } });
    fireEvent.click(screen.getByRole("button", { name: "Show Points" }));
    expect(pointsMode()).toBe("Points: Off");
    const xCursors = screen.getByRole("button", { name: "X Cursors" });
    expect(xCursors).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(xCursors);
    expect(screen.getByRole("button", { name: "X Cursors" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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

  // ADR 0045: a pattern dropped on a plot area joins that area's live
  // pattern list. It is never flattened to its current matches — that
  // is what the explicit materialize path is for.
  it("appends dropped patterns to the area, live, and never flattens them", async () => {
    const MIME = "application/x-cannet-plot-signal";
    const PATTERNS_MIME = "application/x-cannet-drag-patterns";
    const payload = JSON.stringify({ signals: [], patterns: ["EngineSpeed"] });
    const dt = {
      types: [MIME, PATTERNS_MIME],
      getData: (t: string) => (t === MIME ? payload : ""),
      dropEffect: "",
    };
    await withSizedCanvas(async () => {
      renderPanel();
      const area = screen.getByText("Area 1").closest(".plot-area")!;
      fireEvent.dragOver(area, { dataTransfer: dt });
      fireEvent.drop(area, { dataTransfer: dt });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /patterns \(1\)/ })).toBeInTheDocument(),
      );
      // The rule's current match is drawn — as a pattern-derived row,
      // not as a manual pick.
      expect(screen.getByText("EngineSpeed")).toBeInTheDocument();
      expect(screen.getByTitle(/added by a pattern/)).toBeInTheDocument();
    });
  });

  it("merges a dropped pattern into an area that already has one, without duplicating", async () => {
    const registry = makeRegistry({
      id: "el-drop-patterns",
      config: { areas: [{ id: "a1", signals: [], patterns: ["EngineSpeed"] }] },
    });
    const MIME = "application/x-cannet-plot-signal";
    const payload = JSON.stringify({
      signals: [],
      patterns: ["EngineSpeed", "EngineTemp"],
    });
    const dt = {
      types: [MIME, "application/x-cannet-drag-patterns"],
      getData: (t: string) => (t === MIME ? payload : ""),
      dropEffect: "",
    };
    await withSizedCanvas(async () => {
      renderPanel({ params: { elementId: "el-drop-patterns" }, registry });
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      const area = screen.getByText("Area 1").closest(".plot-area")!;
      fireEvent.drop(area, { dataTransfer: dt });
      // Two patterns, not three: the repeat of one it already carries
      // is dropped (D11).
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /patterns \(2\)/ })).toBeInTheDocument(),
      );
    });
  });

  it("adds a whole message's signals once, however often the drop overlaps", async () => {
    // D11 at the plot end: a message payload is just its signals, and
    // a payload overlapping the area's existing content lands each at
    // most once.
    const MIME = "application/x-cannet-plot-signal";
    const sig = (signalName: string) => ({
      busId: null,
      messageId: 256,
      extended: false,
      signalName,
      messageName: "EngineData",
      unit: "rpm",
    });
    const payload = JSON.stringify({
      signals: [sig("EngineSpeed"), sig("EngineTemp"), sig("EngineSpeed")],
      patterns: [],
    });
    const dt = {
      types: [MIME, "application/x-cannet-drag-signals"],
      getData: (t: string) => (t === MIME ? payload : ""),
      dropEffect: "",
    };
    await withSizedCanvas(async () => {
      renderPanel();
      const area = screen.getByText("Area 1").closest(".plot-area")!;
      fireEvent.drop(area, { dataTransfer: dt });
      await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
      // …and dropping the same payload again changes nothing.
      fireEvent.drop(area, { dataTransfer: dt });
      await waitFor(() => {
        expect(screen.getAllByText("EngineSpeed")).toHaveLength(1);
        expect(screen.getAllByText("EngineTemp")).toHaveLength(1);
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
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
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

  /** Hover at `x` (panel units) by reporting it from `hovered`'s uPlot,
   * then redraw `drawn`'s and hand back the hover markers it painted, as
   * the x values they landed on. `-10` px is uPlot's pointer-is-gone
   * cursor, i.e. an un-hover. */
  async function hoverMarkersOn(
    hovered: FakeUPlotInst,
    drawn: FakeUPlotInst,
    left: number,
  ): Promise<number[]> {
    await act(async () => {
      hovered.cursor.left = left;
      hovered.fire("setCursor");
    });
    drawn.drawOps.length = 0;
    await act(async () => {
      drawn.fire("draw");
    });
    // The marker is the only disc the overlay draws; `valToPos` is the
    // inverse of the `posToVal` the hover came in through, so the centre
    // reads back as the time it was drawn at.
    return drawn.drawOps.filter((o) => o.op === "arc").map((o) => o.args[0] / 100);
  }

  it("a hover in one area reveals the markers in the areas the pointer is not in", async () => {
    // The owner's report, at the panel tier: the hover markers appeared
    // only on the area under the pointer, while the crosshair they
    // belong with already spanned the whole stack. Both now come off the
    // one shared hover x, so the area being measured here is the one the
    // pointer was never in.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
      const area1 = screen.getByText("Area 1").closest(".plot-area")!;
      const area2 = screen.getByText("Area 2").closest(".plot-area")!;
      const instFor = (areaEl: Element) => {
        const list = uplotInstances.filter((i) => areaEl.contains(i.root));
        return list[list.length - 1];
      };
      await waitFor(() => expect(instFor(area2)).toBeTruthy());
      const u1 = instFor(area1)!;
      const u2 = instFor(area2)!;
      await waitFor(() => expect((u1.data as number[][])[0]?.length).toBeGreaterThan(0));
      // Pointer in area 2, which holds no signal at all. Area 1 marks
      // the sample nearest 1.9 s — its own, at 2 s.
      expect(await hoverMarkersOn(u2, u1, 190)).toEqual([2]);
      // And the pointer leaving takes them with it.
      expect(await hoverMarkersOn(u2, u1, -10)).toEqual([]);
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
  });

  it("an enum lane takes the hover the same way a numeric axis does", async () => {
    // The second half of the report: a lane showed no hover marker even
    // with the pointer inside it. It draws its own now, from the same
    // shared x — measured from the *other* area's hover, so the two
    // halves of the parity are one assertion.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    mockValueTables.EngineSpeed = [
      { raw: 0, label: "Idle" },
      { raw: 1, label: "Run" },
      { raw: 2, label: "Fault" },
    ];
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [0, 1, 2] };
    mockSampleSeries.EngineTemp = { t: [0, 1, 2], v: [10, 11, 12] };
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      addFocusedSignal("EngineTemp");
      await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
      // Per-unit: the enum goes onto its own shared lanes axis, the
      // numeric onto a unit axis — two areas, one panel.
      await pickCombobox(screen.getByLabelText("y-axis mode"), "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(2));
      const areas = [...document.querySelectorAll(".plot-area")];
      const lanes = areas.find((a) => a.getAttribute("data-area-id")?.endsWith("/u:enum"))!;
      const numeric = areas.find((a) => a !== lanes)!;
      const instFor = (areaEl: Element) => {
        const list = uplotInstances.filter((i) => areaEl.contains(i.root));
        return list[list.length - 1];
      };
      await waitFor(() => expect(instFor(lanes)).toBeTruthy());
      const uLane = instFor(lanes)!;
      const uNum = instFor(numeric)!;
      await waitFor(() => expect((uLane.data as number[][])[0]?.length).toBeGreaterThan(0));
      expect(await hoverMarkersOn(uNum, uLane, 190)).toEqual([2]);
      expect(await hoverMarkersOn(uNum, uLane, -10)).toEqual([]);
      // The mode still means what it meant: `off` is off, hover or not.
      // `auto` → `off` is one press of the cycling chip.
      fireEvent.click(screen.getByRole("button", { name: "Show Points" }));
      await waitFor(() => expect(instFor(lanes)).toBeTruthy());
      expect(await hoverMarkersOn(instFor(numeric)!, instFor(lanes)!, 190)).toEqual([]);
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
      addFocusedSignal("EngineSpeed");
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
        describeNote: () => {},
        retagNote: () => {},
        removeNote: () => {},
        linkEvents: () => {},
        unlinkEvents: () => {},
        setNoteSubjects: () => {},
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
      addFocusedSignal("EngineSpeed");
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
      const note = addNote.mock.calls[addNote.mock.calls.length - 1]![0] as Note;
      expect(note.color).toBe(wheelColor(2));
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
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    addFocusedSignal("EngineTemp");
    await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
    await pickCombobox(screen.getByLabelText("y-axis mode"), "per-unit");
    // One combined enum axis, not two per-unit axes.
    await waitFor(() => {
      expect(document.querySelectorAll(".plot-area").length).toBe(1);
    });
    expect(document.querySelector(".plot-area-axis-label")?.textContent).toBe("(enums)");
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
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBeGreaterThan(0));
      mockSampleStall.on = true;
      const before = uplotInstances.length;
      // The rebuild lands ~250 ms after the instance was constructed.
      await waitFor(() => expect(uplotInstances.length).toBeGreaterThan(before), { timeout: 2000 });
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBeGreaterThan(0));
    });
  });

  it("an area whose first sample is slow says it is building, and stops when it lands", async () => {
    // A cold decimation cache has a whole capture of history to decode
    // for a new signal set, so the canvas is blank until points start
    // coming back and reads as "no data" or "hung". Stalling every fetch
    // stands in for that wait; the gate is real time, so only the
    // positive direction is asserted here (the sub-threshold case is in
    // `useFirstSampleWait.test.tsx`, under fake timers).
    const building = () => document.querySelector(".plot-area-building");
    await withSizedCanvas(async () => {
      mockSampleStall.on = true;
      renderPanel();
      addFocusedSignal("EngineSpeed");
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

  it("stops saying it is building on the first points, not on the finished series", async () => {
    // The first-paint half of the split. A host serve is bounded in
    // time, so a cold one answers with the prefix it has decoded and
    // says the series is still building. That prefix is a plot the user
    // can read — the placeholder has done its job and must go, even
    // though the rebuild has not finished.
    const building = () => document.querySelector(".plot-area-building");
    await withSizedCanvas(async () => {
      mockSampleStall.on = true;
      renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(building()).not.toBeNull(), { timeout: 2000 });

      mockSampleStall.on = false;
      await act(async () => {
        for (const resolve of mockSampleStall.pending.splice(0))
          // `false`: points, and the host still catching up.
          resolve(encodeSample([{ t: [0, 1, 2], v: [10, 20, 15] }], false));
        await Promise.resolve();
      });
      await waitFor(() => expect(building()).toBeNull());
      expect(drawnPoints(liveInstanceIn("Area 1"))).toBeGreaterThan(0);
    });
  });

  it("keeps saying it is building while a partial answer has no points yet", async () => {
    // The other half. "Nothing *yet*" is exactly a serve that ran out of
    // budget before it decoded anything — settling on it would replace
    // the placeholder with a blank canvas, which is the "no data or
    // hung?" state the gate exists to prevent.
    const building = () => document.querySelector(".plot-area-building");
    await withSizedCanvas(async () => {
      mockSampleStall.on = true;
      renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(building()).not.toBeNull(), { timeout: 2000 });

      mockSampleStall.on = false;
      mockSampleRebuild.on = true; // every further serve: empty, incomplete
      await act(async () => {
        for (const resolve of mockSampleStall.pending.splice(0))
          resolve(encodeSample([{ t: [], v: [] }], false));
        await new Promise((r) => setTimeout(r, 300));
      });
      expect(building()).not.toBeNull();

      // …and it goes the moment the rebuild produces something.
      mockSampleRebuild.of = 3;
      await waitFor(() => expect(building()).toBeNull(), { timeout: 2000 });
    });
  });

  it("stops saying it is building when the host is caught up with nothing to show", async () => {
    // A signal no loaded DBC decodes answers complete-and-empty. That is
    // "nothing to draw", not "nothing to draw yet" — the placeholder must
    // not sit there forever on it.
    const building = () => document.querySelector(".plot-area-building");
    await withSizedCanvas(async () => {
      mockSampleStall.on = true;
      renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(building()).not.toBeNull(), { timeout: 2000 });

      mockSampleStall.on = false;
      await act(async () => {
        for (const resolve of mockSampleStall.pending.splice(0))
          resolve(encodeSample([{ t: [], v: [] }], true));
        await Promise.resolve();
      });
      await waitFor(() => expect(building()).toBeNull());
    });
  });

  it("paints each partial answer as the rebuild advances", async () => {
    // The point of the whole exercise: the plot fills in while the host
    // decodes, rather than showing one finished picture minutes later.
    // The fake host serves one more point per call and only reports it
    // is caught up on the last one — so the growing canvas is driven by
    // the same re-request the real partial serves drive.
    await withSizedCanvas(async () => {
      mockSampleRebuild.on = true;
      mockSampleRebuild.of = 5;
      renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBeGreaterThan(0));
      const early = drawnPoints(liveInstanceIn("Area 1"));
      expect(early).toBeLessThan(5);
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBe(5), {
        timeout: 3000,
      });
      // (That the memo takes over again once the host reports it is
      // caught up is pinned at the hook, in `useDecimatedRange.test.ts`.
      // It is not observable here: this panel's trace is running, so its
      // window grows every tick and a refetch is correct regardless.)
    });
  });

  it("paints each partial answer on a stopped trace too, with no user interaction", async () => {
    // The boot-restore case. A restored capture is *stopped*
    // (`restoredTrace`), so the self-paced resample loop — which only
    // runs while the trace is running — cannot be what re-requests.
    // ADR 0049 nonetheless says a partial answer is continued by the
    // view until the host reports it caught up; if nothing does that
    // here, the prefix the cold pyramid rebuild served sits on screen
    // until the user zooms or hits Fit Data.
    //
    // `of` is set well above the handful of resamples mount alone
    // triggers, so reaching it can only be the catch-up re-request.
    await withSizedCanvas(async () => {
      mockSampleRebuild.on = true;
      mockSampleRebuild.of = 30;
      const registry = makeRegistry({
        id: "el-restored",
        trace: { start: 0, end: 60, isPaused: false },
      });
      renderPanel({ params: { elementId: "el-restored" }, registry });
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBe(30), {
        timeout: 5000,
      });
    });
  });

  it("stops re-sampling a stopped trace once the host reports it caught up", async () => {
    // The other half: the catch-up re-request must terminate. A stopped
    // trace has no window growth to justify a further fetch, so once the
    // host's answer is complete the memo takes over and the panel goes
    // quiet — otherwise this is a permanent host round-trip loop over a
    // capture that cannot change.
    await withSizedCanvas(async () => {
      mockSampleRebuild.on = true;
      mockSampleRebuild.of = 3;
      const registry = makeRegistry({
        id: "el-settled",
        trace: { start: 0, end: 60, isPaused: false },
      });
      renderPanel({ params: { elementId: "el-settled" }, registry });
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBe(3), {
        timeout: 5000,
      });
      // Past the post-mount uPlot rebuild (250 ms) so its own resample
      // is inside the quiet window rather than after it.
      await new Promise((r) => setTimeout(r, 400));
      const settled = sampleCalls();
      await new Promise((r) => setTimeout(r, 600));
      expect(sampleCalls()).toBe(settled);
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
      expect(screen.getByText("drag a signal here, or add a pattern above")).toBeInTheDocument();
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
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      addFocusedSignal("EngineTemp");
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
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    addFocusedSignal("EngineTemp");
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
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      addFocusedSignal("EngineTemp");
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
    addFocusedSignal("EngineSpeed");
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
    fireEvent.click(followChip());
    expect(followChip()).toHaveAttribute("aria-pressed", "false");
    act(() => {
      commands.invoke("el-test", "plot.followLive.enable");
    });
    expect(followChip()).toHaveAttribute("aria-pressed", "true");
    // Enable-only: invoking again must not toggle it back off.
    act(() => {
      commands.invoke("el-test", "plot.followLive.enable");
    });
    expect(followChip()).toHaveAttribute("aria-pressed", "true");
  });

  it("panel.find focuses and selects the solo pattern box", () => {
    const commands = renderWithCommands();
    const solo = screen.getByLabelText("solo pattern") as HTMLInputElement;
    fireEvent.change(solo, { target: { value: "Engine" } });
    expect(document.activeElement).not.toBe(solo);
    act(() => {
      commands.invoke("el-test", "panel.find");
    });
    expect(document.activeElement).toBe(solo);
    expect(solo.selectionStart).toBe(0);
    expect(solo.selectionEnd).toBe(solo.value.length);
  });

  it("registers plot.setVisibleRange for its element", () => {
    const commands = renderWithCommands();
    expect(commands.invoke("el-test", "plot.setVisibleRange", "0 10")).toBe(true);
  });
});

// `plot.setVisibleRange` must land the jump through the same
// programmatic x-window path as Fit Data / goto-event — `applyXAll`
// followed by an x-epoch bump — or a *stopped* panel's window moves on
// screen while its data stays the stale slice from before the jump (the
// resample loop that would otherwise catch a running trace up is off).
// `sampleCalls()` increasing is the epoch bump's fingerprint: nothing
// else re-samples a stopped panel.
describe("plot.setVisibleRange", () => {
  const STOPPED = { id: "el-range", trace: { start: 0, end: 60, isPaused: false } };

  it("an explicit range moves the uPlot x-scale and re-samples a stopped panel", async () => {
    await withSizedCanvas(async () => {
      const commands = createPanelCommandRegistry();
      renderPanel({ params: { elementId: STOPPED.id }, registry: makeRegistry(STOPPED), commands });
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));
      const inst = liveInstanceIn("Area 1");

      // The first jump also *drops* follow-live, and that transition's
      // own effect forces a resample — which would mask a missing
      // x-epoch bump. Spend that jump here, then check the epoch bump
      // in isolation on a second jump, where follow-live is already
      // off and cannot fire again.
      act(() => {
        commands.invoke(STOPPED.id, "plot.setVisibleRange", "10 20");
      });
      await act(async () => {});
      inst.xCalls.length = 0;
      const before = sampleCalls();

      act(() => {
        commands.invoke(STOPPED.id, "plot.setVisibleRange", "30 40");
      });
      await act(async () => {});

      expect(inst.xCalls[inst.xCalls.length - 1]).toEqual({ min: 30, max: 40 });
      // The resample-forcing half of the path: without the x-epoch bump,
      // this stopped panel's data would stay the pre-jump slice under
      // the new scale — follow-live is already off, so its own effect
      // can't be what triggers this.
      expect(sampleCalls()).toBeGreaterThan(before);
    });
  });

  it("a bare width keeps the panel's current centre", async () => {
    await withSizedCanvas(async () => {
      const commands = createPanelCommandRegistry();
      renderPanel({ params: { elementId: STOPPED.id }, registry: makeRegistry(STOPPED), commands });
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));
      const inst = liveInstanceIn("Area 1");

      // Establish a known window (centre 15) before asking for a width.
      act(() => {
        commands.invoke(STOPPED.id, "plot.setVisibleRange", "10 20");
      });
      await act(async () => {});
      inst.xCalls.length = 0;

      act(() => {
        commands.invoke(STOPPED.id, "plot.setVisibleRange", "4");
      });
      await act(async () => {});

      expect(inst.xCalls[inst.xCalls.length - 1]).toEqual({ min: 13, max: 17 });
    });
  });

  it("drops follow-live, the same as any other programmatic jump", async () => {
    await withSizedCanvas(async () => {
      const commands = createPanelCommandRegistry();
      renderPanel({ params: { elementId: STOPPED.id }, registry: makeRegistry(STOPPED), commands });
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));
      expect(followChip()).toHaveAttribute("aria-pressed", "true");

      act(() => {
        commands.invoke(STOPPED.id, "plot.setVisibleRange", "10 20");
      });
      await act(async () => {});

      expect(followChip()).toHaveAttribute("aria-pressed", "false");
    });
  });
});

// The y-normalisation pipeline, asserted on the array `PlotArea` hands
// uPlot via `setData` in each axis mode.
//
// Two rules are protected here, and every expectation below should be
// traceable to one of them (ADR 0026):
//
//  1. **An axis draws one scale.** Every series on an axis is
//     normalised against the range that axis labels, so what a viewer
//     reads off the ticks is what each row was drawn against. An axis
//     carrying a second, unlabelled scale is what once drew a -200..0 A
//     current as -1.5..0.
//  2. **A lane is a band, and the bands are the visible lanes' to
//     share.** An enum's codes map into its own slice of the axis, and
//     a hidden lane's slice goes back to the rest rather than staying
//     reserved.
//
// Expected values are written as literals rather than recomputed from
// the lane helpers, so a change in the helpers cannot quietly move the
// expectation with the code — but each literal is derived in its own
// comment from the rule above it, not transcribed from a run. An
// assertion that cannot be justified that way does not belong here.
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
    for (const n of names) {
      addFocusedSignal(n);
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

  it("enum lanes: the fetch asks the host for the categorical reduction", async () => {
    // The host reduces an over-budget window either by per-bucket
    // extremes (right for a line, a category error for codes — the
    // states held between the bucket's lowest and highest code vanish)
    // or by run boundaries. Only the view knows which it draws, so a
    // lane axis must say so on its own fetch, and a numeric one must
    // not.
    mockValueTables.EngineSpeed = ENUM3;
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [0, 1, 2] };
    mockSampleSeries.EngineTemp = { t: [0, 1, 2], v: [10, 11, 12] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed", "EngineTemp"], "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(2));
      await waitFor(() => {
        const modes = vi
          .mocked(invoke)
          .mock.calls.filter((c) => c[0] === "sample_signals")
          .map((c) => (c[1] as { categorical?: boolean; signals: { signalName: string }[] }))
          .filter((a) => a.signals.length > 0)
          .map((a) => [a.signals[0].signalName, a.categorical === true] as const);
        expect(modes).toContainEqual(["EngineSpeed", true]);
        expect(modes).toContainEqual(["EngineTemp", false]);
      });
    } finally {
      restore();
    }
  });

  it("enum lanes: a within-budget window draws a column per sample, not per transition", async () => {
    // Regression guard. The categorical serve reduces an over-budget
    // window to its run boundaries; run-reducing one that already fits
    // as well left a lane whose whole drawn content was its transitions
    // — four columns for twelve samples. Everything that shows *where
    // the samples are* rides on those columns: the point markers, and
    // the per-series hover point, which snaps to the nearest column.
    // Held codes, so the runs are far fewer than the samples.
    mockValueTables.EngineSpeed = ENUM3;
    mockValueTables.EngineTemp = ENUM3;
    const held = { t: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], v: [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2] };
    mockSampleSeries.EngineSpeed = held;
    mockSampleSeries.EngineTemp = held;
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed", "EngineTemp"], "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
      await waitForData((data) => {
        // Every sample, not the four run boundaries the reduction keeps.
        expect(data[0]).toEqual(held.t);
        // …and each lane holds a value at every one of them.
        expect(data[1]?.length).toBe(held.t.length);
        expect(data[1]?.every((y) => y != null)).toBe(true);
      });
    } finally {
      restore();
    }
  });

  it("blanks an extrapolated stretch out of the solid stroke", async () => {
    // ADR 0026. The host says which stretches of the window have no data
    // behind them; the renderer must stop the *solid* stroke there, or a
    // dash drawn over it reads as a solid line with darker patches. The
    // dashes themselves go on the canvas, which this suite's uPlot stub
    // has none of — what is observable here is the half that has to
    // agree with them: the data uPlot is handed.
    //
    // EngineSpeed samples at 0 and 1 and is then held to column 3 by its
    // neighbour, which samples out to 3. That hold is the extent
    // overdraw the classification labels.
    mockSampleSeries.EngineSpeed = { t: [0, 1], v: [10, 12] };
    mockSampleSeries.EngineTemp = { t: [0, 1, 2, 3], v: [10, 12, 14, 16] };
    mockExtrapolated.EngineSpeed = [[1, 3]];
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed", "EngineTemp"], "unified");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
      await waitForData((data) => {
        expect(data[0]).toEqual([0, 1, 2, 3]);
        // The neighbour is untouched — it has data at every column.
        expect(data[2]?.every((y) => y != null)).toBe(true);
        // The held tail is gone from the stroke: two values, then
        // nothing. Blanked to the far column inclusive, because nothing
        // out there is a sample of this series — leaving the held value
        // would keep the tail solid *and* drop a point marker where
        // there is no point.
        expect(data[1]?.slice(0, 2).every((y) => y != null)).toBe(true);
        expect(data[1]?.slice(2)).toEqual([null, null]);
      });
    } finally {
      restore();
    }
  });

  it("enum lanes: keeps a stale lane's row whole so the tile survives to be hatched", async () => {
    // The two renderers differentiate extrapolation differently, and a
    // lane must not get the line's treatment. Blanking the row is how a
    // line's solid stroke is stopped at its data — but `enumSegments`
    // ends a run at a `null`, so the same blanking on a lane would
    // *delete* the stale tile instead of marking it, and a lane's held
    // state is information whether or not the signal is still arriving.
    // The extent overdraw the classification labels here is exactly the
    // tail EngineSpeed is held across by its faster neighbour.
    mockValueTables.EngineSpeed = ENUM3;
    mockValueTables.EngineTemp = ENUM3;
    mockSampleSeries.EngineSpeed = { t: [0, 1], v: [0, 1] };
    mockSampleSeries.EngineTemp = { t: [0, 1, 2, 3], v: [0, 1, 2, 0] };
    mockExtrapolated.EngineSpeed = [[1, 3]];
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed", "EngineTemp"], "per-unit");
      await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
      await waitForData((data) => {
        expect(data[0]).toEqual([0, 1, 2, 3]);
        // Every column still carries a lane position for the stale
        // signal — nothing was blanked, so `enumSegments` still produces
        // a tile out to the axis's last column for the draw hook to
        // hatch the stale part of.
        expect(data[1]?.length).toBe(4);
        expect(data[1]?.every((y) => y != null)).toBe(true);
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
    // (Two samples on the late signal, not one: a one-sample series is
    // deliberately drawn as a full-width hline instead — see
    // `mergeSeries` — and would carry no leading gap to test.)
    mockValueTables.EngineSpeed = ENUM3;
    mockValueTables.EngineTemp = ENUM3;
    mockSampleSeries.EngineSpeed = { t: [0, 2], v: [0, 2] };
    mockSampleSeries.EngineTemp = { t: [1, 2], v: [1, 1] };
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

  it("numeric: one axis draws one scale, whatever units its series carry", async () => {
    // rpm 10..20 and degC 100..200 overlaid on one axis. The axis draws
    // the union 10..200 — the rpm series in the bottom twentieth, the
    // degC series filling the rest — so the tick labels are true of
    // both. Scaling each unit group to fill the canvas on its own drew
    // them on top of each other at amplitudes the axis never stated.
    mockSignalExtents.EngineSpeed = { lo: 10, hi: 20 };
    mockSignalExtents.EngineTemp = { lo: 100, hi: 200 };
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [10, 20, 15] };
    mockSampleSeries.EngineTemp = { t: [0, 1, 2], v: [100, 200, 150] };
    const restore = stubSize();
    try {
      renderPanel();
      await addSignals(["EngineSpeed", "EngineTemp"]);
      await waitForData((data) => {
        expect(data[0]).toEqual([0, 1, 2]);
        expect(data[1]?.[0]).toBeCloseTo(0, 6);
        expect(data[1]?.[1]).toBeCloseTo(10 / 190, 6);
        expect(data[1]?.[2]).toBeCloseTo(5 / 190, 6);
        expect(data[2]?.[0]).toBeCloseTo(90 / 190, 6);
        expect(data[2]?.[1]).toBeCloseTo(1, 6);
        expect(data[2]?.[2]).toBeCloseTo(140 / 190, 6);
      });
      await waitFor(() => expect(yTickLabels([0, 1])).toEqual(["10 rpm", "200 rpm"]));
    } finally {
      restore();
    }
  });

  // The amplitude a series is *drawn* at and the range its axis
  // *labels* are two different numbers, and nothing checked they were
  // the same one. A series scaled privately under a shared axis is
  // drawn against a range the axis never states — so a -200..0 A
  // current overlaid with a -1.5..0 companion filled the canvas while
  // the gutter read -1.5..0, and the trace was two orders of magnitude
  // off its own data with nothing on screen to say so. The ratio is
  // just the two signals' amplitudes, so it is whatever the pairing
  // happens to be.
  //
  // These walk every y-axis mode and every way an axis can end up
  // holding more than one would-be scale, and check the general claim
  // rather than the one pairing: *every* drawn series reads back, in
  // its own axis's labels, as the data it holds.
  describe("a drawn series reads as its own data", () => {
    /** The uPlot instance drawing each axis on screen right now. An
     * area rebuilds its chart on a signal-set or mode change and the
     * superseded instances stay in the array, so this keeps the newest
     * instance per mounted root. */
    function liveInstances() {
      const all = uplotInstances as unknown as (FakeUPlotInst & {
        opts: { axes: { values: (u: unknown, s: number[]) => string[] }[] };
      })[];
      const live: typeof all = [];
      for (let i = all.length - 1; i >= 0; i--) {
        if (!document.body.contains(all[i].root)) continue;
        if (!live.some((l) => l.root === all[i].root)) live.unshift(all[i]);
      }
      return live;
    }

    /** What every drawn row reads as: its normalised extent mapped back
     * through its own axis's tick labels — the range a viewer takes off
     * the screen — sorted by lower bound. */
    function drawnAmplitudes(): { lo: number; hi: number }[] {
      const out: { lo: number; hi: number }[] = [];
      for (const inst of liveInstances()) {
        const [aLo, aHi] = inst.opts.axes[1].values(inst, [0, 1]);
        const axLo = parseFloat(aLo);
        const axHi = parseFloat(aHi);
        for (const row of (inst.data as (number | null)[][]).slice(1)) {
          let lo = Infinity;
          let hi = -Infinity;
          for (const v of row) {
            if (v == null) continue;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          out.push({ lo: axLo + lo * (axHi - axLo), hi: axLo + hi * (axHi - axLo) });
        }
      }
      return out.sort((a, b) => a.lo - b.lo);
    }

    /** A -200..0 current and a -1.5..0 companion, dropped in that
     * order, with `units` — the companion first when the caller wants
     * the small signal to be the one an axis would label through. */
    async function plotBothWith(units: [string, string], mode: string) {
      mockSampleSeries.BigCurrent = { t: [0, 1, 2], v: [-200, -100, 0] };
      mockSignalExtents.BigCurrent = { lo: -200, hi: 0 };
      mockSampleSeries.SmallCompanion = { t: [0, 1, 2], v: [-1.5, -0.75, 0] };
      mockSignalExtents.SmallCompanion = { lo: -1.5, hi: 0 };
      renderPanel();
      dropSignal("Area 1", "SmallCompanion", units[0]);
      await waitFor(() => expect(screen.getByText("SmallCompanion")).toBeInTheDocument());
      dropSignal("Area 1", "BigCurrent", units[1]);
      await waitFor(() => expect(screen.getByText("BigCurrent")).toBeInTheDocument());
      await pickCombobox(screen.getByLabelText("y-axis mode"), mode);
      await waitFor(() => {
        const amps = drawnAmplitudes();
        expect(amps.length).toBe(2);
        expect(amps[0].lo).toBeCloseTo(-200, 3);
        expect(amps[0].hi).toBeCloseTo(0, 3);
        expect(amps[1].lo).toBeCloseTo(-1.5, 3);
        expect(amps[1].hi).toBeCloseTo(0, 3);
      });
    }

    for (const mode of ["unified", "per-unit", "individual"]) {
      it(`holds for two units on one area, ${mode}`, async () => {
        const restore = stubSize();
        try {
          await plotBothWith(["V", "A"], mode);
        } finally {
          restore();
        }
      });

      it(`holds for two unitless signals on one area, ${mode}`, async () => {
        // A DBC that declares no unit is the common case, and it is the
        // one that put two would-be scales on a *per-unit* axis: the
        // axis groups them by their (empty) unit while the scale split
        // them apart.
        const restore = stubSize();
        try {
          await plotBothWith(["", ""], mode);
        } finally {
          restore();
        }
      });

      it(`holds for the same unit on one area, ${mode}`, async () => {
        // The control: same-unit series always shared one scale, so
        // this pairing read correctly before and must still.
        const restore = stubSize();
        try {
          await plotBothWith(["A", "A"], mode);
        } finally {
          restore();
        }
      });
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
  function renderSeeded(opts: { signals: string[]; axisScales?: Record<string, unknown>; mode?: string }) {
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
              ...(opts.mode ? { yAxisMode: opts.mode } : {}),
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
      // A log axis labels exponentially whatever the magnitude: its
      // ticks *are* decades, so `1`, `10`, `100` beside a
      // `1.00000e+6` further up would read as two notations on one
      // axis.
      await waitFor(() =>
        expect(yTickLabels([0, 0.5, 1])).toEqual([
          "1.00000e+0 A",
          "1.00000e+1 A",
          "1.00000e+2 A",
        ]),
      );
    } finally {
      restore();
    }
  });

  it("re-labels the y-axis when the float-format settings change, with no reload", async () => {
    // The tick formatter is a closure the uPlot instance keeps, so a
    // live read alone would leave the axis on the old rule until
    // something else rebuilt it. Lowering the large-end threshold has
    // to re-label the axis on its own.
    mockSignalExtents.LimitEffective = { lo: 1, hi: 100 };
    mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [1, 50, 100] };
    const restore = stubSize();
    try {
      renderSeeded({ signals: ["LimitEffective"] });
      await waitFor(() => expect(yTickLabels([0, 1])).toEqual(["1 A", "100 A"]));

      mockSettings.float_exponential_from = 10;
      await act(async () => {
        await hydrateSettings();
      });

      await waitFor(() => expect(yTickLabels([0, 1])).toEqual(["1 A", "1.00000e+2 A"]));
    } finally {
      restore();
      // Put the cache back *awaited*, inside this test: the suite's own
      // reset does not await its re-hydrate, so a settings value left
      // changed here would publish — and re-render a plot area — in
      // whichever test happens to be running when it lands.
      delete mockSettings.float_exponential_from;
      await act(async () => {
        await hydrateSettings();
      });
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

  describe("manual-range regression matrix", () => {
    // Owner's 0.7.0 repro: a manual range set within a 0.0-1.0-valued
    // float signal's own band rendered offscreen. Grooming confirmed it
    // does not reproduce on current code, and called for
    // regression-pinning across value shapes
    // (float/int/uint) and y-axis modes (unified/per-unit/individual)
    // rather than a bisect. `resolveAxisRange` is pinned per shape in
    // `plotAxisScale.test.ts`; these walk the real normalisation
    // pipeline (`PlotArea.tsx`'s row-scaling block) so a regression in
    // the *seam* between engineering-unit bounds and the always-[0,1]
    // uPlot scale is caught. In every case the manual range is set wider
    // than the signal's own auto (follow-live) extent — matching auto
    // would mask a broken override, since it would render identically
    // whether or not the manual bound is actually applied.

    it("float, unified mode: a manual range covering the 0.0-1.0 data band is honoured in engineering units", async () => {
      mockSignalExtents.LimitEffective = { lo: 0.2, hi: 0.8 };
      mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [0.2, 0.5, 0.8] };
      const restore = stubSize();
      try {
        renderSeeded({ signals: ["LimitEffective"], axisScales: { a1: { min: 0, max: 1 } } });
        await waitForData((data) => {
          expect(data[1]?.[0]).toBeCloseTo(0.2, 6);
          expect(data[1]?.[1]).toBeCloseTo(0.5, 6);
          expect(data[1]?.[2]).toBeCloseTo(0.8, 6);
        });
        await waitFor(() => expect(yTickLabels([0, 1])).toEqual(["0 A", "1 A"]));
      } finally {
        restore();
      }
    });

    it("float, per-unit mode: a manual range covering the 0.0-1.0 data band is honoured in engineering units", async () => {
      mockSignalExtents.LimitEffective = { lo: 0.2, hi: 0.8 };
      mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [0.2, 0.5, 0.8] };
      const restore = stubSize();
      try {
        renderSeeded({
          signals: ["LimitEffective"],
          mode: "per-unit",
          axisScales: { "a1/u:unit:A": { min: 0, max: 1 } },
        });
        await waitForData((data) => {
          expect(data[1]?.[0]).toBeCloseTo(0.2, 6);
          expect(data[1]?.[1]).toBeCloseTo(0.5, 6);
          expect(data[1]?.[2]).toBeCloseTo(0.8, 6);
        });
        await waitFor(() => expect(yTickLabels([0, 1])).toEqual(["0 A", "1 A"]));
      } finally {
        restore();
      }
    });

    it("float, individual mode: a manual range covering the 0.0-1.0 data band is honoured in engineering units", async () => {
      mockSignalExtents.LimitEffective = { lo: 0.2, hi: 0.8 };
      mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [0.2, 0.5, 0.8] };
      const restore = stubSize();
      try {
        renderSeeded({
          signals: ["LimitEffective"],
          mode: "individual",
          axisScales: { "a1/i:*|s:256:LimitEffective": { min: 0, max: 1 } },
        });
        await waitForData((data) => {
          expect(data[1]?.[0]).toBeCloseTo(0.2, 6);
          expect(data[1]?.[1]).toBeCloseTo(0.5, 6);
          expect(data[1]?.[2]).toBeCloseTo(0.8, 6);
        });
        await waitFor(() => expect(yTickLabels([0, 1])).toEqual(["0 A", "1 A"]));
      } finally {
        restore();
      }
    });

    it("int (per-unit mode): a manual range covering the signed -128..127 band is honoured in engineering units", async () => {
      mockSignalExtents.EngineTemp = { lo: -100, hi: 100 };
      mockSampleSeries.EngineTemp = { t: [0, 1, 2], v: [-100, 0, 100] };
      const restore = stubSize();
      try {
        renderSeeded({
          signals: ["EngineTemp"],
          mode: "per-unit",
          axisScales: { "a1/u:unit:degC": { min: -128, max: 127 } },
        });
        await waitForData((data) => {
          expect(data[1]?.[0]).toBeCloseTo(28 / 255, 6);
          expect(data[1]?.[1]).toBeCloseTo(128 / 255, 6);
          expect(data[1]?.[2]).toBeCloseTo(228 / 255, 6);
        });
        await waitFor(() => expect(yTickLabels([0, 1])).toEqual(["-128 degC", "127 degC"]));
      } finally {
        restore();
      }
    });

    it("uint (individual mode): a manual range covering the 0-255 band is honoured in engineering units", async () => {
      mockSignalExtents.LimitNominal = { lo: 50, hi: 200 };
      mockSampleSeries.LimitNominal = { t: [0, 1, 2], v: [50, 128, 200] };
      const restore = stubSize();
      try {
        renderSeeded({
          signals: ["LimitNominal"],
          mode: "individual",
          axisScales: { "a1/i:*|s:256:LimitNominal": { min: 0, max: 255 } },
        });
        await waitForData((data) => {
          expect(data[1]?.[0]).toBeCloseTo(50 / 255, 6);
          expect(data[1]?.[1]).toBeCloseTo(128 / 255, 6);
          expect(data[1]?.[2]).toBeCloseTo(200 / 255, 6);
        });
        await waitFor(() => expect(yTickLabels([0, 1])).toEqual(["0 A", "255 A"]));
      } finally {
        restore();
      }
    });

    // The combination the rest of the matrix leaves out: manual bounds
    // on an axis carrying *more than one* series. Every case above puts
    // one signal on the axis, where "the manual range won" and "the
    // series was normalised against its own extent" are the same
    // arithmetic and cannot be told apart.
    //
    // The rule pinned here is the one an axis exists to keep: an axis
    // draws exactly one scale, and every series on it is normalised
    // against that scale, so what a viewer reads off the tick labels is
    // what each row was drawn against (ADR 0026). A manual bound
    // replaces the derived side of that scale for the *axis*, not for
    // each series in turn — so a small companion must sit low on a
    // large manual range instead of filling the canvas.
    //
    // Two `A` signals share one axis in both `unified` and `per-unit`;
    // `individual` gives each its own axis, which the single-signal
    // cases above already cover.
    for (const [mode, axisId] of [
      ["unified", "a1"],
      ["per-unit", "a1/u:unit:A"],
    ] as const) {
      it(`${mode} mode: a manual range scales every series on the axis, not each series' own extent`, async () => {
        // Auto would union these to 0..500. The manual range is 0..1000
        // and is neither signal's own extent, so a row normalised
        // against the auto union, or against itself, reads differently
        // from a row normalised against the manual range.
        mockSignalExtents.LimitEffective = { lo: 400, hi: 500 };
        mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [400, 450, 500] };
        mockSignalExtents.LimitNominal = { lo: 0, hi: 10 };
        mockSampleSeries.LimitNominal = { t: [0, 1, 2], v: [0, 5, 10] };
        const restore = stubSize();
        try {
          renderSeeded({
            signals: ["LimitEffective", "LimitNominal"],
            ...(mode === "unified" ? {} : { mode }),
            axisScales: { [axisId]: { min: 0, max: 1000 } },
          });
          await waitForData((data) => {
            // Both rows on 0..1000. Normalised against their own
            // extents each row would run 0 -> 1; against the 0..500
            // auto union the big row would run 0.8 -> 1.
            expect(data[1]?.[0]).toBeCloseTo(0.4, 6);
            expect(data[1]?.[1]).toBeCloseTo(0.45, 6);
            expect(data[1]?.[2]).toBeCloseTo(0.5, 6);
            expect(data[2]?.[0]).toBeCloseTo(0, 6);
            expect(data[2]?.[1]).toBeCloseTo(0.005, 6);
            expect(data[2]?.[2]).toBeCloseTo(0.01, 6);
          });
          // And the labels state that scale, so the reading is honest.
          await waitFor(() => expect(yTickLabels([0, 1])).toEqual(["0 A", "1000 A"]));
        } finally {
          restore();
        }
      });
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
      fireEvent.click(screen.getByRole("button", { name: "Fit Data" }));
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
      addFocusedSignal("EngineSpeed");
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
      addFocusedSignal("EngineSpeed");
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
      addFocusedSignal("EngineSpeed");
      fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
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

// Post-DBC-reload recovery: Clear collapses the window
// to now so re-picking signals against a freshly-reloaded DBC resamples
// cheaply; All data then widens the window back out to the whole buffer
// for one full-history resample, fitting the x-axis to it.
describe("PlotPanel All data button", () => {
  it("renders beside Clear in the trace controls", () => {
    renderPanel();
    const controls = screen.getByRole("button", { name: "Clear" }).closest<HTMLElement>(
      ".trace-controls",
    )!;
    expect(within(controls).getByRole("button", { name: "All Data" })).toBeInTheDocument();
  });

  it("widens a parked, stopped window to the whole buffer and fits the x-axis to it", async () => {
    await withSizedCanvas(async () => {
      const registry = makeRegistry({
        id: "el-alldata",
        // Stopped, parked mid-buffer — as Clear would leave a panel
        // after a DBC-reload re-pick, well short of a full-history view.
        trace: { start: 40, end: 60, isPaused: false },
      });
      renderPanel({ params: { elementId: "el-alldata" }, registry });
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));
      // Let the post-mount rebuild land before capturing the instance —
      // same rationale as the Fit Data tests above.
      await new Promise((r) => setTimeout(r, 400));
      const inst = liveInstanceIn("Area 1");
      inst.xCalls.length = 0;

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "All Data" }));
      });
      await act(async () => {});

      // The trace window widened to the whole session buffer (100 frames
      // in the default fixture) — still stopped, since it wasn't running.
      expect(registry.get("el-alldata")?.trace).toEqual({ start: 0, end: 100, isPaused: false });
      // The x-axis fit starts at 0 — not the old parked start (40) that
      // plain Fit Data would have used — which is what "All Data" adds.
      const last = inst.xCalls[inst.xCalls.length - 1];
      expect(last?.min).toBe(0);
    });
  });

  it("keeps a running window running, still following live", async () => {
    await withSizedCanvas(async () => {
      const registry = makeRegistry({
        id: "el-alldata-running",
        trace: { start: 40, end: null, isPaused: false },
      });
      renderPanel({ params: { elementId: "el-alldata-running" }, registry });
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "All Data" }));
      });

      // A running trace stays running (grows with the buffer) — only its
      // start moved to 0.
      expect(registry.get("el-alldata-running")?.trace).toEqual({
        start: 0, end: null, isPaused: false,
      });
    });
  });
});

describe("PlotPanel area collapse", () => {
  const sig = (signalName: string, unit: string, hidden?: boolean) => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "EngineData",
    unit,
    color: "#4ecbff",
    ...(hidden ? { hidden: true } : {}),
  });

  /// The `areas` list in the panel's most recent persist.
  function persistedAreas(api: { updateParameters: { mock: { calls: unknown[][] } } }) {
    const calls = api.updateParameters.mock.calls;
    const last = (calls[calls.length - 1]?.[0] ?? {}) as {
      areas?: Array<Record<string, unknown>>;
    };
    return last.areas ?? [];
  }

  /// The x-axis config of each *drawing* uPlot, top to bottom. Two
  /// filters, both needed: a superseded instance stays in the mock's
  /// array (so keep the newest per mounted root, as `liveInstances`
  /// does), and a collapsed area keeps its last instance's root in the
  /// document while drawing nothing — which is the very state under
  /// test, so it must not be counted.
  function liveXAxes(): { label?: unknown }[] {
    const all = uplotInstances as unknown as (FakeUPlotInst & {
      opts: { axes?: { scale?: string; label?: unknown }[] };
    })[];
    const live: typeof all = [];
    for (let i = all.length - 1; i >= 0; i--) {
      const area = all[i].root.closest(".plot-area");
      if (area === null || area.classList.contains("collapsed")) continue;
      if (!live.some((l) => l.root === all[i].root)) live.unshift(all[i]);
    }
    return live.map((u) => (u.opts.axes ?? []).find((a) => a.scale !== "y") ?? {});
  }

  it("collapses and expands an area from its head toggle, persisting the flag", () => {
    const registry = makeRegistry({
      id: "el-collapse",
      config: { areas: [{ id: "a1", signals: [sig("EngineSpeed", "rpm")] }] },
    });
    const { api } = renderPanel({ params: { elementId: "el-collapse" }, registry });
    const area = () => document.querySelector(".plot-area") as HTMLElement;
    expect(area().classList.contains("collapsed")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "collapse plot area" }));
    expect(area().classList.contains("collapsed")).toBe(true);
    expect(area().style.flexGrow).toBe("0");
    expect(persistedAreas(api)[0]?.collapsed).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "expand plot area" }));
    expect(area().classList.contains("collapsed")).toBe(false);
    expect(persistedAreas(api)[0]?.collapsed).toBeFalsy();
  });

  it("reduces a collapsed area to its heading row", () => {
    // The collapsed representation is one heading row — area name,
    // signal-count chip, and the pattern match chip when a rule feeds
    // the area. Everything else (rows, filter status, y-cursors, the
    // per-area chrome) goes with the plot height.
    const registry = makeRegistry({
      id: "el-collapse-heading",
      config: {
        areas: [{ id: "a1", signals: [sig("EngineSpeed", "rpm"), sig("EngineTemp", "degC")] }],
      },
    });
    renderPanel({ params: { elementId: "el-collapse-heading" }, registry });
    const area = () => document.querySelector(".plot-area") as HTMLElement;
    expect(area().querySelectorAll(".plot-signal-row").length).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "collapse plot area" }));
    const side = area().querySelector(".plot-area-signals") as HTMLElement;
    // The side panel is exactly the heading row — no rows below it.
    expect(side.children.length).toBe(1);
    expect(side.children[0]).toHaveClass("plot-area-signals-head");
    expect(area().querySelectorAll(".plot-signal-row").length).toBe(0);
    expect(area().querySelector(".plot-area-ycursors")).toBeNull();
    // The heading carries the area's name and how many series it holds.
    expect(within(side).getByText("2 signals")).toBeInTheDocument();
    // Per-area chrome is part of the expanded layout, not the heading.
    expect(within(side).queryByRole("button", { name: "fit y" })).toBeNull();
    expect(within(side).queryByLabelText("y-axis mode")).toBeNull();
  });

  it("renders one heading row for a collapsed multi-axis area", () => {
    // One logical area is one collapse state (ADR 0026) — and one
    // collapsed *representation*: the derived axes that would each draw
    // their own strip are not rendered at all while the area is
    // collapsed.
    const registry = makeRegistry({
      id: "el-collapse-individual",
      config: {
        areas: [
          {
            id: "a1",
            yAxisMode: "individual",
            collapsed: true,
            signals: [sig("EngineSpeed", "rpm"), sig("EngineTemp", "degC")],
          },
        ],
      },
    });
    renderPanel({ params: { elementId: "el-collapse-individual" }, registry });
    const areas = Array.from(document.querySelectorAll(".plot-area")) as HTMLElement[];
    expect(areas.length).toBe(1);
    expect(areas[0].classList.contains("collapsed")).toBe(true);
    expect(screen.getAllByRole("button", { name: "expand plot area" }).length).toBe(1);
  });

  it("keeps the x-axis time label when the bottom area is collapsed", async () => {
    // Bottom-of-column chrome — the x-axis time label, and with it the
    // A/B cursor delta — belongs to the lowest axis that *draws*, not to
    // the last one in the stack. A collapsed area is a heading row with
    // no canvas behind it, so anchoring positionally made both vanish
    // the moment the bottom area was collapsed.
    const registry = makeRegistry({
      id: "el-collapse-xaxis",
      config: {
        areas: [
          { id: "a1", signals: [sig("EngineSpeed", "rpm")] },
          { id: "a2", collapsed: true, signals: [sig("EngineTemp", "degC")] },
        ],
      },
    });
    await withSizedCanvas(async () => {
      renderPanel({ params: { elementId: "el-collapse-xaxis" }, registry });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      // One area draws; the collapsed one has no uPlot at all.
      const live = liveXAxes();
      expect(live).toHaveLength(1);
      expect(live[0].label).toBeDefined();
    });
  });

  it("moves the x-axis time label back down when the bottom area is expanded", async () => {
    const registry = makeRegistry({
      id: "el-collapse-xaxis-back",
      config: {
        areas: [
          { id: "a1", signals: [sig("EngineSpeed", "rpm")] },
          { id: "a2", signals: [sig("EngineTemp", "degC")] },
        ],
      },
    });
    await withSizedCanvas(async () => {
      renderPanel({ params: { elementId: "el-collapse-xaxis-back" }, registry });
      const settle = async () => {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 60));
        });
      };
      await settle();
      // Two drawing axes: only the lower one carries the label.
      expect(liveXAxes().map((a) => a.label !== undefined)).toEqual([false, true]);

      // Collapse the lower area; the label moves up to the one still drawing.
      fireEvent.click(screen.getAllByRole("button", { name: "collapse plot area" })[1]);
      await settle();
      expect(liveXAxes().map((a) => a.label !== undefined)).toEqual([true]);

      fireEvent.click(screen.getByRole("button", { name: "expand plot area" }));
      await settle();
      expect(liveXAxes().map((a) => a.label !== undefined)).toEqual([false, true]);
    });
  });

  it("carries the pattern match chip on a collapsed area's heading", async () => {
    // A pattern rule is what feeds the area, and its status line is one
    // of the things the collapse takes away — so the count rides the
    // heading instead (ADR 0020 membership).
    const registry = makeRegistry({
      id: "el-collapse-chip",
      config: {
        areas: [{ id: "a1", collapsed: true, signals: [], patterns: ["EngineSpeed"] }],
      },
    });
    renderPanel({ params: { elementId: "el-collapse-chip" }, registry });
    // The catalog resolves on its own microtask, so the count arrives
    // with it.
    const head = document.querySelector(".plot-area-signals-head") as HTMLElement;
    await waitFor(() => expect(within(head).getByText("1 match")).toBeInTheDocument());
    expect(within(head).getByText("1 signal")).toBeInTheDocument();
    expect(document.querySelector(".plot-area-filter-status")).toBeNull();
  });

  it("restores the prior layout exactly on a collapse round-trip", () => {
    // Collapsing is layout, not configuration: the per-axis weights the
    // user dragged must come back untouched when the area expands.
    const registry = makeRegistry({
      id: "el-collapse-roundtrip",
      config: {
        areas: [
          {
            id: "a1",
            yAxisMode: "per-unit",
            signals: [sig("EngineSpeed", "rpm"), sig("EngineTemp", "degC")],
          },
        ],
        axisWeights: { "a1/u:unit:rpm": 3, "a1/u:unit:degC": 1 },
      },
    });
    const { api } = renderPanel({ params: { elementId: "el-collapse-roundtrip" }, registry });
    const grows = () =>
      Array.from(document.querySelectorAll(".plot-area")).map(
        (a) => (a as HTMLElement).style.flexGrow,
      );
    expect(grows()).toEqual(["3", "1"]);

    fireEvent.click(screen.getByRole("button", { name: "collapse plot area" }));
    expect(grows()).toEqual(["0"]);
    fireEvent.click(screen.getByRole("button", { name: "expand plot area" }));
    expect(grows()).toEqual(["3", "1"]);
    const calls = api.updateParameters.mock.calls;
    const last = (calls[calls.length - 1]?.[0] ?? {}) as { axisWeights: Record<string, number> };
    expect(last.axisWeights).toEqual({ "a1/u:unit:rpm": 3, "a1/u:unit:degC": 1 });
  });

  it("gives a contiguous run of collapsed axes one shared drag handle", () => {
    // Four axes, the middle two collapsed: the run shows a single
    // handle (on its first axis), not one per collapsed axis.
    const registry = makeRegistry({
      id: "el-collapse-run",
      config: {
        areas: [
          {
            id: "a1",
            yAxisMode: "individual",
            signals: [
              sig("Top", "rpm"),
              sig("Mid1", "V", true),
              sig("Mid2", "degC", true),
              sig("Bottom", "A"),
            ],
          },
        ],
      },
    });
    renderPanel({ params: { elementId: "el-collapse-run" }, registry });
    const areas = Array.from(document.querySelectorAll(".plot-area")) as HTMLElement[];
    expect(areas.map((a) => a.classList.contains("collapsed"))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    const handles = document.querySelectorAll(".plot-area-collapsed-handle");
    expect(handles.length).toBe(1);
    expect(areas[1].contains(handles[0])).toBe(true);
  });

  it("reorders the panel by dragging a collapsed run's shared handle", () => {
    // A collapsed area still has to be draggable — that is what the
    // run's handle is for. It carries the run's first area, and a drop
    // targets the area whose row it was released on.
    const registry = makeRegistry({
      id: "el-collapse-drag",
      config: {
        areas: [
          { id: "a1", signals: [sig("TopSignal", "rpm")] },
          { id: "a2", collapsed: true, signals: [sig("BottomSignal", "rpm")] },
        ],
      },
    });
    renderPanel({ params: { elementId: "el-collapse-drag" }, registry });
    // A collapsed area is a heading row with no signal rows to read, so
    // the stack's order shows as "which slot is the collapsed one".
    const stacked = () =>
      Array.from(document.querySelectorAll(".plot-area")).map((el) =>
        el.classList.contains("collapsed")
          ? "collapsed"
          : el.querySelector(".plot-signal-name")?.textContent,
      );
    expect(stacked()).toEqual(["TopSignal", "collapsed"]);

    const handle = document.querySelector(".plot-area-collapsed-handle")!;
    const dt = areaDragTransfer();
    fireEvent.dragStart(handle, { dataTransfer: dt });
    const first = document.querySelectorAll(".plot-area")[0];
    fireEvent.dragOver(first, { dataTransfer: dt });
    fireEvent.drop(first, { dataTransfer: dt });

    expect(stacked()).toEqual(["collapsed", "TopSignal"]);
  });

  it("gives an area with no visible signals no expand affordance to click", () => {
    // A fully-hidden area collapses because there is nothing to draw —
    // expanding it would only reserve height for a blank canvas. Its
    // rows stay in the side panel, so un-hiding one is the way back
    // (ADR 0026 hidden-signal handling).
    const registry = makeRegistry({
      id: "el-collapse-auto",
      config: { areas: [{ id: "a1", signals: [sig("EngineSpeed", "rpm", true)] }] },
    });
    renderPanel({ params: { elementId: "el-collapse-auto" }, registry });
    const area = document.querySelector(".plot-area") as HTMLElement;
    expect(area.classList.contains("collapsed")).toBe(true);
    expect(screen.getByRole("button", { name: "expand plot area" })).toBeDisabled();
  });
});

describe("PlotPanel axis collapse", () => {
  const sig = (signalName: string, unit: string, hidden?: boolean) => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "EngineData",
    unit,
    color: "#4ecbff",
    ...(hidden ? { hidden: true } : {}),
  });

  /// A two-unit per-unit area: two derived axes with stable ids
  /// (`a1/u:unit:rpm`, `a1/u:unit:degC`).
  function twoAxisRegistry(id: string, config: Record<string, unknown> = {}) {
    return makeRegistry({
      id,
      config: {
        areas: [
          {
            id: "a1",
            yAxisMode: "per-unit",
            signals: [sig("EngineSpeed", "rpm"), sig("EngineTemp", "degC")],
          },
        ],
        ...config,
      },
    });
  }
  const areaEls = () => Array.from(document.querySelectorAll(".plot-area")) as HTMLElement[];
  const lastParams = (api: { updateParameters: { mock: { calls: unknown[][] } } }) =>
    (api.updateParameters.mock.calls[api.updateParameters.mock.calls.length - 1]?.[0] ??
      {}) as Record<string, unknown>;

  it("collapses one axis to its label strip and gives its height to the rest", () => {
    // An axis's disclosure is the same toggle the area's is, on the
    // axis's own label. Collapsing drops its canvas and its rows,
    // leaving the label strip; its weight share goes to the axes that
    // are still drawing (they keep their own weights, the collapsed one
    // takes none).
    const { api } = renderPanel({
      params: { elementId: "el-axis-collapse" },
      registry: twoAxisRegistry("el-axis-collapse"),
    });
    expect(areaEls().length).toBe(2);
    expect(document.querySelectorAll(".plot-area-splitter").length).toBe(1);

    fireEvent.click(screen.getAllByRole("button", { name: "collapse axis" })[0]);
    const [first, second] = areaEls();
    expect(first.classList.contains("collapsed")).toBe(true);
    expect(first.style.flexGrow).toBe("0");
    expect(first.querySelectorAll(".plot-signal-row").length).toBe(0);
    // The strip still says which axis it is, and stays expandable.
    expect(within(first).getByText("[rpm]")).toBeInTheDocument();
    expect(within(first).getByRole("button", { name: "expand axis" })).toBeEnabled();
    // The axis still drawing keeps its own weight, so the stack still fits.
    expect(second.classList.contains("collapsed")).toBe(false);
    expect(second.style.flexGrow).toBe("1");
    // Nothing to trade with a zero-height axis, so its splitter goes.
    expect(document.querySelectorAll(".plot-area-splitter").length).toBe(0);
    // Persisted per axis id, beside the weights, and sparse.
    expect(lastParams(api).axisCollapsed).toEqual({ "a1/u:unit:rpm": true });
  });

  it("restores the axis on expand, weights untouched by the round-trip", () => {
    const { api } = renderPanel({
      params: { elementId: "el-axis-roundtrip" },
      registry: twoAxisRegistry("el-axis-roundtrip", {
        axisWeights: { "a1/u:unit:rpm": 3, "a1/u:unit:degC": 1 },
      }),
    });
    const grows = () => areaEls().map((a) => a.style.flexGrow);
    expect(grows()).toEqual(["3", "1"]);

    fireEvent.click(screen.getAllByRole("button", { name: "collapse axis" })[0]);
    expect(grows()).toEqual(["0", "1"]);
    fireEvent.click(screen.getByRole("button", { name: "expand axis" }));
    expect(grows()).toEqual(["3", "1"]);
    expect(lastParams(api).axisWeights).toEqual({
      "a1/u:unit:rpm": 3,
      "a1/u:unit:degC": 1,
    });
    expect(lastParams(api).axisCollapsed).toEqual({});
    expect(areaEls()[0].querySelectorAll(".plot-signal-row").length).toBe(1);
  });

  it("reads a persisted collapsed axis back on load", () => {
    renderPanel({
      params: { elementId: "el-axis-persisted" },
      registry: twoAxisRegistry("el-axis-persisted", {
        axisCollapsed: { "a1/u:unit:degC": true },
      }),
    });
    expect(areaEls().map((a) => a.classList.contains("collapsed"))).toEqual([false, true]);
  });

  it("is layout, not visibility — the series and their hidden flags are untouched", () => {
    // Collapse is not hide: the signal keeps existing on the axis, so
    // nothing about the area's persisted series changes, and expanding
    // brings the same set back with the same fetch behind it.
    const { api } = renderPanel({
      params: { elementId: "el-axis-not-hide" },
      registry: twoAxisRegistry("el-axis-not-hide"),
    });
    const areasBefore = JSON.stringify(lastParams(api).areas);

    fireEvent.click(screen.getAllByRole("button", { name: "collapse axis" })[0]);
    expect(JSON.stringify(lastParams(api).areas)).toBe(areasBefore);
    // The measurement strip enumerates every *plotted* signal, so a
    // still-plotted series shows there while its axis is collapsed.
    expect(screen.getByRole("button", { name: "expand axis" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "expand axis" }));
    expect(JSON.stringify(lastParams(api).areas)).toBe(areasBefore);
    expect(within(areaEls()[0]).getByText("EngineSpeed")).toBeInTheDocument();
  });

  it("leaves every strip expandable when all of an area's axes collapse", () => {
    // No last-axis rule: an area with every axis collapsed is the same
    // shape the all-hidden rule already produces, and each strip keeps
    // its own toggle, so nothing is wedged.
    renderPanel({
      params: { elementId: "el-axis-all" },
      registry: twoAxisRegistry("el-axis-all", {
        axisCollapsed: { "a1/u:unit:rpm": true, "a1/u:unit:degC": true },
      }),
    });
    expect(areaEls().map((a) => a.classList.contains("collapsed"))).toEqual([true, true]);
    expect(screen.getAllByRole("button", { name: "expand axis" }).length).toBe(2);
    // One shared handle for the run, not one per axis (ADR 0026).
    expect(document.querySelectorAll(".plot-area-collapsed-handle").length).toBe(1);
  });

  it("gives a unified area's single axis no separate axis toggle", () => {
    // In unified mode the area *is* the axis, so the area toggle is the
    // only disclosure — a second one on the same row would say nothing.
    renderPanel({
      params: { elementId: "el-axis-unified" },
      registry: makeRegistry({
        id: "el-axis-unified",
        config: { areas: [{ id: "a1", signals: [sig("EngineSpeed", "rpm")] }] },
      }),
    });
    expect(screen.queryByRole("button", { name: "collapse axis" })).toBeNull();
    expect(screen.getByRole("button", { name: "collapse plot area" })).toBeInTheDocument();
  });

  it("drops a collapsed entry when its axis stops existing", () => {
    // Same lifecycle as the weights: a mode change re-derives the axis
    // ids, and an entry keyed by one that no longer exists retires.
    const { api } = renderPanel({
      params: { elementId: "el-axis-prune" },
      registry: twoAxisRegistry("el-axis-prune", {
        axisCollapsed: { "a1/u:unit:rpm": true, "gone/u:unit:V": true },
      }),
    });
    expect(lastParams(api).axisCollapsed).toEqual({ "a1/u:unit:rpm": true });
  });
});

describe("PlotPanel hidden signal rows", () => {
  const twoSignalRegistry = (id: string) =>
    makeRegistry({
      id,
      config: {
        areas: [
          {
            id: "a1",
            signals: [
              { busId: null, messageId: 256, extended: false, signalName: "EngineSpeed", messageName: "EngineData", unit: "rpm", color: "#abc" },
              { busId: null, messageId: 256, extended: false, signalName: "EngineTemp", messageName: "EngineData", unit: "degC", color: "#def" },
            ],
          },
        ],
      },
    });

  const row = (name: string) => screen.getByText(name).closest(".plot-signal-row") as HTMLElement;

  it("drops a hidden row to swatch + name, and restores it on show", () => {
    const registry = twoSignalRegistry("el-hide-compact");
    renderPanel({ params: { elementId: "el-hide-compact" }, registry });

    // Shown: the full readout — message, value, remove/badge affordance.
    const shown = row("EngineSpeed");
    expect(shown.querySelector(".plot-signal-message")).not.toBeNull();
    expect(shown.querySelector(".plot-signal-readout")).not.toBeNull();
    expect(
      shown.querySelector(".plot-signal-remove") ?? shown.querySelector(".plot-signal-pattern-badge"),
    ).not.toBeNull();

    // The swatch is the only un-hide affordance (ADR 0026) — same
    // gesture, no new control.
    fireEvent.click(row("EngineSpeed").querySelector("button.plot-signal-swatch")!);
    const hidden = row("EngineSpeed");
    expect(hidden.classList.contains("hidden")).toBe(true);
    expect(hidden.querySelector(".plot-signal-message")).toBeNull();
    expect(hidden.querySelector(".plot-signal-readout")).toBeNull();
    expect(hidden.querySelector(".plot-signal-remove")).toBeNull();
    expect(hidden.querySelector(".plot-signal-pattern-badge")).toBeNull();
    // Swatch and name survive — the un-hide path and the row's identity.
    expect(hidden.querySelector(".plot-signal-swatch")).not.toBeNull();
    expect(hidden.querySelector(".plot-signal-name")).not.toBeNull();
    // The other row is untouched.
    expect(row("EngineTemp").classList.contains("hidden")).toBe(false);
    expect(row("EngineTemp").querySelector(".plot-signal-message")).not.toBeNull();

    // Showing it again restores the full row.
    fireEvent.click(row("EngineSpeed").querySelector("button.plot-signal-swatch")!);
    const shownAgain = row("EngineSpeed");
    expect(shownAgain.classList.contains("hidden")).toBe(false);
    expect(shownAgain.querySelector(".plot-signal-message")).not.toBeNull();
    expect(shownAgain.querySelector(".plot-signal-readout")).not.toBeNull();
  });

  it("still shows compact rows when every signal on the axis is hidden", () => {
    // ADR 0026: an all-hidden axis keeps its rows rather than
    // reducing to a heading — a swatch in one of them is the only way
    // back. They compact exactly like any other hidden row.
    const bothHidden = makeRegistry({
      id: "el-all-hidden",
      config: {
        areas: [
          {
            id: "a1",
            signals: [
              { busId: null, messageId: 256, extended: false, signalName: "EngineSpeed", messageName: "EngineData", unit: "rpm", color: "#abc", hidden: true },
              { busId: null, messageId: 256, extended: false, signalName: "EngineTemp", messageName: "EngineData", unit: "degC", color: "#def", hidden: true },
            ],
          },
        ],
      },
    });
    renderPanel({ params: { elementId: "el-all-hidden" }, registry: bothHidden });

    expect(document.querySelector(".plot-area")!.classList.contains("collapsed")).toBe(true);
    // Not a deliberate collapse — the row list still renders, compact.
    expect(document.querySelector(".plot-area")!.classList.contains("heading-only")).toBe(false);
    const rows = Array.from(document.querySelectorAll(".plot-signal-row"));
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.classList.contains("hidden")).toBe(true);
      expect(r.querySelector(".plot-signal-message")).toBeNull();
      expect(r.querySelector(".plot-signal-swatch")).not.toBeNull();
    }
    // The swatch still un-hides from here.
    fireEvent.click(row("EngineSpeed").querySelector("button.plot-signal-swatch")!);
    expect(row("EngineSpeed").classList.contains("hidden")).toBe(false);
    expect(row("EngineSpeed").querySelector(".plot-signal-message")).not.toBeNull();
  });
});

describe("PlotPanel solo", () => {
  const sig = (signalName: string, unit = "V", hidden?: boolean) => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "Pack",
    unit,
    color: "#4ecbff",
    ...(hidden ? { hidden: true } : {}),
  });

  /// The `areas` list in the panel's most recent persist.
  const persistedAreas = (api: { updateParameters: { mock: { calls: unknown[][] } } }) => {
    const calls = api.updateParameters.mock.calls;
    const last = (calls[calls.length - 1]?.[0] ?? {}) as { areas?: Array<Record<string, unknown>> };
    return last.areas ?? [];
  };
  /// The `solo` blob in the panel's most recent persist.
  const persistedSolo = (api: { updateParameters: { mock: { calls: unknown[][] } } }) => {
    const calls = api.updateParameters.mock.calls;
    return (calls[calls.length - 1]?.[0] as { solo?: unknown } | undefined)?.solo;
  };

  /// Every signal row's name paired with whether it renders hidden —
  /// what "only the matches are visible" reads as on screen.
  const rowVisibility = () =>
    Array.from(document.querySelectorAll(".plot-signal-row")).map(
      (r) =>
        [
          r.querySelector(".plot-signal-name")?.textContent ?? "",
          !r.classList.contains("hidden"),
        ] as [string, boolean],
    );

  const soloBox = () => screen.getByLabelText("solo pattern") as HTMLInputElement;
  const typeSolo = (pattern: string) => fireEvent.change(soloBox(), { target: { value: pattern } });

  /// One panel, two areas, cell-voltage-style names — the workflow the
  /// feature exists for.
  const cellRegistry = (id: string, config?: Record<string, unknown>) =>
    makeRegistry({
      id,
      config: {
        areas: [
          { id: "a1", signals: [sig("Cell1"), sig("Cell16")] },
          { id: "a2", signals: [sig("PackVoltage")] },
        ],
        ...config,
      },
      trace: { start: 0, end: 60, isPaused: false } as unknown as ReturnType<typeof freshTrace>,
    });

  it("shows only the matching series across every area of the panel", () => {
    const registry = cellRegistry("el-solo-basic");
    renderPanel({ params: { elementId: "el-solo-basic" }, registry });
    expect(rowVisibility()).toEqual([
      ["Cell1", true],
      ["Cell16", true],
      ["PackVoltage", true],
    ]);

    // Area 1 holds the match, so its other row is masked; Area 2 holds
    // none and is left exactly as it was.
    typeSolo("Cell16");
    expect(rowVisibility()).toEqual([
      ["Cell1", false],
      ["Cell16", true],
      ["PackVoltage", true],
    ]);
    // The subject is the canonical path, so a message fragment selects
    // as readily as a name — one dialect with the area patterns.
    typeSolo("/Pack/Cell16$");
    expect(rowVisibility()).toEqual([
      ["Cell1", false],
      ["Cell16", true],
      ["PackVoltage", true],
    ]);
  });

  it("leaves an area with no matches exactly as solo-off leaves it", () => {
    // Solo scopes to the areas it found something in. An area with no
    // match is not "everything masked" — it is untouched: its rows keep
    // their own visibility and it keeps its plot height.
    const registry = cellRegistry("el-solo-scope");
    renderPanel({ params: { elementId: "el-solo-scope" }, registry });
    const collapsedFlags = () =>
      Array.from(document.querySelectorAll(".plot-area")).map((a) =>
        a.classList.contains("collapsed"),
      );
    const before = rowVisibility();
    expect(collapsedFlags()).toEqual([false, false]);

    typeSolo("Cell16");
    // Area 2 reads the same as it did with solo off…
    expect(rowVisibility()[2]).toEqual(before[2]);
    expect(collapsedFlags()).toEqual([false, false]);
    // …while Area 1, which does match, is masked down to the match.
    expect(rowVisibility().slice(0, 2)).toEqual([
      ["Cell1", false],
      ["Cell16", true],
    ]);
  });

  it("touches nothing at all when the pattern matches nowhere", () => {
    const registry = cellRegistry("el-solo-nomatch");
    renderPanel({ params: { elementId: "el-solo-nomatch" }, registry });
    const before = rowVisibility();
    typeSolo("NoSuchSignal");
    expect(rowVisibility()).toEqual(before);
    expect(rowVisibility().every(([, visible]) => visible)).toBe(true);
    // …including a pattern that would have matched but for its case.
    typeSolo("cell16");
    expect(rowVisibility()).toEqual(before);
  });

  it("masks pattern-derived series like manual picks", async () => {
    // An ADR-0038 area defines its series by pattern; those rows are
    // materialized from the catalog rather than stored in `signals`.
    // Solo masks what is *plotted*, so it has to see them too.
    const registry = makeRegistry({
      id: "el-solo-pattern",
      config: {
        areas: [
          { id: "a1", signals: [sig("Cell1")] },
          { id: "a2", signals: [], patterns: ["/EngineData/Limit"] },
        ],
      },
      trace: { start: 0, end: 60, isPaused: false } as unknown as ReturnType<typeof freshTrace>,
    });
    renderPanel({ params: { elementId: "el-solo-pattern" }, registry });
    // The catalog the pattern resolves against arrives over `invoke`.
    await waitFor(() =>
      expect(rowVisibility()).toEqual([
        ["Cell1", true],
        ["LimitNominal", true],
        ["LimitEffective", true],
      ]),
    );

    // Area 1 holds no match, so it stays as it was; Area 2's
    // pattern-derived rows mask like manual picks.
    typeSolo("LimitEffective");
    expect(rowVisibility()).toEqual([
      ["Cell1", true],
      ["LimitNominal", false],
      ["LimitEffective", true],
    ]);

    // …and they are first-class members of the match list: the
    // read-out, the mask and the match menu all include them.
    typeSolo("Limit");
    expect(rowVisibility()).toEqual([
      ["Cell1", true],
      ["LimitNominal", true],
      ["LimitEffective", true],
    ]);
    expect(screen.getByLabelText("solo position").textContent).toBe("all (2)");
    fireEvent.contextMenu(document.querySelector(".plot-solo")!);
    expect(
      Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual(["Area 2 · LimitNominal", "Area 2 · LimitEffective"]);
  });

  it("never touches the other series' persisted hidden flags", () => {
    // Solo is a view-layer mask: the non-matches are *drawn* hidden but
    // their stored state is untouched, so clearing solo restores exactly
    // the view the user had — including the one row they really did hide.
    const registry = makeRegistry({
      id: "el-solo-persist",
      config: {
        areas: [{ id: "a1", signals: [sig("Cell1"), sig("Cell16"), sig("PackVoltage", "V", true)] }],
      },
    });
    const { api } = renderPanel({ params: { elementId: "el-solo-persist" }, registry });
    typeSolo("Cell16");
    expect(rowVisibility()).toEqual([
      ["Cell1", false],
      ["Cell16", true],
      ["PackVoltage", false],
    ]);
    expect(
      (persistedAreas(api)[0]?.signals as Array<Record<string, unknown>>).map((s) => [
        s.signalName,
        s.hidden,
      ]),
    ).toEqual([
      ["Cell1", undefined],
      ["Cell16", undefined],
      ["PackVoltage", true],
    ]);

    typeSolo("");
    expect(rowVisibility()).toEqual([
      ["Cell1", true],
      ["Cell16", true],
      ["PackVoltage", false],
    ]);
  });

  /// Every signal row's name paired with its class list — for telling a
  /// solo-masked row apart from one the user hid on their own.
  const rowClasses = () =>
    Array.from(document.querySelectorAll(".plot-signal-row")).map(
      (r) => [r.querySelector(".plot-signal-name")?.textContent ?? "", r.className] as [string, string],
    );

  it("styles a solo-masked row distinctly from a row the user hid", () => {
    const registry = makeRegistry({
      id: "el-solo-mask-style",
      config: {
        areas: [{ id: "a1", signals: [sig("Cell1"), sig("Cell16"), sig("PackVoltage", "V", true)] }],
      },
    });
    renderPanel({ params: { elementId: "el-solo-mask-style" }, registry });
    // Solo off: PackVoltage carries the plain hidden class, no solo marker.
    expect(rowClasses().find(([n]) => n === "PackVoltage")?.[1]).toMatch(/\bhidden\b/);
    expect(rowClasses().find(([n]) => n === "PackVoltage")?.[1]).not.toMatch(/solo-masked/);

    typeSolo("Cell16");
    // Cell1 draws nothing now, but solo — not the user — is why: it
    // gets the solo marker on top of the hidden state.
    const cell1 = rowClasses().find(([n]) => n === "Cell1")?.[1] ?? "";
    expect(cell1).toMatch(/\bhidden\b/);
    expect(cell1).toMatch(/\bsolo-masked\b/);
    // PackVoltage was already hidden on its own — solo changes nothing
    // about *why*, so it keeps the plain treatment.
    const packVoltage = rowClasses().find(([n]) => n === "PackVoltage")?.[1] ?? "";
    expect(packVoltage).toMatch(/\bhidden\b/);
    expect(packVoltage).not.toMatch(/solo-masked/);
    // The match itself is neither.
    const cell16 = rowClasses().find(([n]) => n === "Cell16")?.[1] ?? "";
    expect(cell16).not.toMatch(/\bhidden\b/);
    expect(cell16).not.toMatch(/solo-masked/);
  });

  /// The per-area match chip's text in an area's signal-panel heading —
  /// `null` when the area shows none (solo off, or a zero-match area).
  const chipText = (areaLabel: string) =>
    screen
      .getByText(areaLabel)
      .closest(".plot-area-signals-head")
      ?.querySelector(".plot-solo-chip")?.textContent ?? null;

  it("shows a per-area match chip while solo is active, and nothing for a zero-match area", () => {
    const registry = cellRegistry("el-solo-chip");
    renderPanel({ params: { elementId: "el-solo-chip" }, registry });
    expect(chipText("Area 1")).toBeNull();
    expect(chipText("Area 2")).toBeNull();

    // Area 1 holds 2 series, 1 of which matches; Area 2 holds none.
    typeSolo("Cell16");
    expect(chipText("Area 1")).toBe("1 of 2 match");
    expect(chipText("Area 2")).toBeNull();

    typeSolo("");
    expect(chipText("Area 1")).toBeNull();
  });

  it("is inert while the pattern is invalid, and says so", () => {
    const registry = cellRegistry("el-solo-invalid");
    renderPanel({ params: { elementId: "el-solo-invalid" }, registry });
    typeSolo("Cell1(");
    expect(soloBox()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("bad regex")).toBeInTheDocument();
    // Nothing filtered — an unparseable pattern changes no visibility.
    expect(rowVisibility().every(([, visible]) => visible)).toBe(true);
    // Completing it makes it live again — and its capture group makes
    // two keys ("" for Cell1, "6" for Cell16), of which the fresh
    // pattern lands on the first page. Cell16's match is on page 2, so
    // it drops out of the side list entirely (item 5) rather than
    // showing hidden; PackVoltage never matched at all, so it stays
    // (item 3's ordinary compact-hidden row, not off-page).
    typeSolo("Cell1(6)?");
    expect(soloBox()).not.toHaveAttribute("aria-invalid");
    expect(rowVisibility()).toEqual([
      ["Cell1", true],
      ["PackVoltage", true],
    ]);
    expect(screen.queryByText("Cell16")).not.toBeInTheDocument();
  });

  it("restores the full view on Escape, and on clearing the box", () => {
    const registry = cellRegistry("el-solo-clear");
    const { api } = renderPanel({ params: { elementId: "el-solo-clear" }, registry });
    typeSolo("Cell16");
    fireEvent.keyDown(soloBox(), { key: "Escape" });
    expect(soloBox().value).toBe("");
    expect(rowVisibility().every(([, visible]) => visible)).toBe(true);
    expect(persistedSolo(api)).toBeUndefined();

    typeSolo("Cell16");
    fireEvent.click(screen.getByRole("button", { name: "clear solo" }));
    expect(soloBox().value).toBe("");
    expect(rowVisibility().every(([, visible]) => visible)).toBe(true);
  });

  it("collapses a matching area whose matches are all off the visible subset", () => {
    // Same view-level rule as an all-hidden area: nothing to draw, so it
    // gives up its plot height — but the area's own `collapsed` flag is
    // not written, so clearing solo brings it back expanded. Only an
    // area solo *applies* to can get here; one with no match keeps its
    // height whatever the visible subset is.
    const registry = makeRegistry({
      id: "el-solo-collapse",
      config: {
        areas: [
          { id: "a1", signals: [sig("Cell1")] },
          { id: "a2", signals: [sig("Cell2")] },
          { id: "a3", signals: [sig("PackVoltage")] },
        ],
      },
      trace: { start: 0, end: 60, isPaused: false } as unknown as ReturnType<typeof freshTrace>,
    });
    const { api } = renderPanel({ params: { elementId: "el-solo-collapse" }, registry });
    const collapsedFlags = () =>
      Array.from(document.querySelectorAll(".plot-area")).map((a) =>
        a.classList.contains("collapsed"),
      );
    expect(collapsedFlags()).toEqual([false, false, false]);

    // A fresh capturing pattern lands on page 1, so Area 2's match is
    // off the page and it collapses; Area 3 never matched and keeps its
    // height.
    typeSolo("(Cell\\d)");
    expect(collapsedFlags()).toEqual([false, true, false]);
    expect(persistedAreas(api)[1]?.collapsed).toBeFalsy();
    fireEvent.click(screen.getByRole("button", { name: "next solo match" }));
    expect(collapsedFlags()).toEqual([true, false, false]);
    // …and back on the whole set, both matching areas draw again.
    fireEvent.click(screen.getByRole("button", { name: "next solo match" }));
    expect(collapsedFlags()).toEqual([false, false, false]);

    typeSolo("");
    expect(collapsedFlags()).toEqual([false, false, false]);
  });

  it("persists the pattern with the panel config, and restores it", () => {
    const registry = cellRegistry("el-solo-save");
    const { api } = renderPanel({ params: { elementId: "el-solo-save" }, registry });
    // Absent while solo is off — the blob stays sparse, like `collapsed`.
    expect(persistedSolo(api)).toBeUndefined();
    // Captureless, so there is no page to persist — the pattern alone.
    typeSolo("Cell16");
    expect(persistedSolo(api)).toEqual({ pattern: "Cell16" });

    cleanup();
    const restored = cellRegistry("el-solo-restore", { solo: { pattern: "Cell16" } });
    renderPanel({ params: { elementId: "el-solo-restore" }, registry: restored });
    expect(soloBox().value).toBe("Cell16");
    expect(rowVisibility()).toEqual([
      ["Cell1", false],
      ["Cell16", true],
      ["PackVoltage", true],
    ]);
  });

  /// Three matching series across two areas — a match list long enough
  /// to step through and to wrap around.
  const stepRegistry = (id: string, config?: Record<string, unknown>) =>
    makeRegistry({
      id,
      config: {
        areas: [
          { id: "a1", signals: [sig("Cell1"), sig("Cell2")] },
          { id: "a2", signals: [sig("Cell3"), sig("PackVoltage")] },
        ],
        ...config,
      },
      trace: { start: 0, end: 60, isPaused: false } as unknown as ReturnType<typeof freshTrace>,
    });

  const soloPosition = () => screen.getByLabelText("solo position").textContent;
  const visibleNames = () =>
    rowVisibility()
      .filter(([, visible]) => visible)
      .map(([name]) => name);

  it("cycles all -> page 1 -> ... -> page N -> all with next / previous", () => {
    const registry = stepRegistry("el-solo-step");
    renderPanel({ params: { elementId: "el-solo-step" }, registry });

    // A fresh capturing pattern lands on page 1 of its three one-group
    // pages.
    typeSolo("(Cell\\d)");
    const next = screen.getByRole("button", { name: "next solo match" });
    const prev = screen.getByRole("button", { name: "previous solo match" });
    expect(visibleNames()).toEqual(["Cell1"]);
    expect(soloPosition()).toBe('1/3 \u00b7 "Cell1" (1 of 3)');

    fireEvent.click(next);
    fireEvent.click(next);
    expect(visibleNames()).toEqual(["Cell3"]);
    expect(soloPosition()).toBe('3/3 \u00b7 "Cell3" (1 of 3)');
    // Past the last page is the whole matched set, not page 1 \u2014 and
    // PackVoltage stays masked, since its area did match.
    fireEvent.click(next);
    expect(visibleNames()).toEqual(["Cell1", "Cell2", "Cell3"]);
    expect(soloPosition()).toBe("all (3)");
    // ...and one more press opens page 1 again.
    fireEvent.click(next);
    expect(soloPosition()).toBe('1/3 \u00b7 "Cell1" (1 of 3)');
    // Backwards off page 1 is the whole set too, and again round.
    fireEvent.click(prev);
    expect(soloPosition()).toBe("all (3)");
    fireEvent.click(prev);
    expect(soloPosition()).toBe('3/3 \u00b7 "Cell3" (1 of 3)');
  });

  it("drops off-page rows from the side list entirely, not just styled hidden", () => {
    // The page is the working set (groomed 2026-08-14): a match parked
    // on another page has no row here at all \u2014 no `.hidden` styling to
    // find, because there is no row.
    const registry = stepRegistry("el-solo-offpage-absent");
    renderPanel({ params: { elementId: "el-solo-offpage-absent" }, registry });
    typeSolo("(Cell\\d)");
    expect(soloPosition()).toBe('1/3 \u00b7 "Cell1" (1 of 3)');
    expect(screen.getByText("Cell1")).toBeInTheDocument();
    expect(screen.queryByText("Cell2")).not.toBeInTheDocument();
    expect(screen.queryByText("Cell3")).not.toBeInTheDocument();
    // PackVoltage never matched at all \u2014 it's the *ordinary* masked row
    // (item 3's compact-hidden treatment), not off-page, so it stays.
    expect(screen.getByText("PackVoltage")).toBeInTheDocument();
    expect(document.querySelectorAll(".plot-signal-row").length).toBe(2);
  });

  it("scrolls the side panel back to the top on a page step", () => {
    const registry = stepRegistry("el-solo-scroll");
    renderPanel({ params: { elementId: "el-solo-scroll" }, registry });
    typeSolo("(Cell\\d)");
    const panel = screen.getByText("Cell1").closest(".plot-area-signals") as HTMLElement;
    panel.scrollTop = 40;
    expect(panel.scrollTop).toBe(40);
    fireEvent.click(screen.getByRole("button", { name: "next solo match" }));
    expect(soloPosition()).toBe('2/3 \u00b7 "Cell2" (1 of 3)');
    expect(panel.scrollTop).toBe(0);
  });

  it("restores the off-page rows when solo clears", () => {
    const registry = stepRegistry("el-solo-offpage-restore");
    renderPanel({ params: { elementId: "el-solo-offpage-restore" }, registry });
    typeSolo("(Cell\\d)");
    expect(screen.queryByText("Cell2")).not.toBeInTheDocument();

    typeSolo("");
    expect(screen.getByText("Cell2")).toBeInTheDocument();
    expect(document.querySelectorAll(".plot-signal-row").length).toBe(4);
  });

  it("renders a signal both individually hidden and on the current solo page compact, not suppressed", () => {
    // The interplay case: `soloMaskSignals` never overrides a signal's
    // own `hidden` flag for a member of the visible page \u2014 it only
    // forces `hidden` on the ones *outside* it. So an on-page row that
    // the user hid stays exactly a hidden row: compact (item 3), never
    // dropped for being "off the page" (item 5), because it isn't.
    const registry = makeRegistry({
      id: "el-solo-hidden-onpage",
      config: {
        areas: [{ id: "a1", signals: [sig("Cell1", "V", true), sig("Cell2")] }],
      },
      trace: { start: 0, end: 60, isPaused: false } as unknown as ReturnType<typeof freshTrace>,
    });
    renderPanel({ params: { elementId: "el-solo-hidden-onpage" }, registry });
    typeSolo("(Cell\\d)");
    // Numeric-ascending group keys land "1" on page 1.
    expect(soloPosition()).toBe('1/2 \u00b7 "Cell1" (1 of 2)');
    const cell1 = screen.getByText("Cell1").closest(".plot-signal-row") as HTMLElement;
    expect(cell1.classList.contains("hidden")).toBe(true);
    // The user hid it, not solo \u2014 so no solo marker.
    expect(cell1.classList.contains("solo-masked")).toBe(false);
    expect(cell1.querySelector(".plot-signal-message")).toBeNull();
    // Cell2's group is the other page \u2014 genuinely off it, suppressed.
    expect(screen.queryByText("Cell2")).not.toBeInTheDocument();
  });

  it("shows every captureless match at once, and leaves a zero-match area alone", () => {
    // A pattern that captures nothing has no index to page by, so it is
    // a flat filter: whatever matches, in every signal panel, all at
    // once \u2014 and a panel with no match is left alone, as ever.
    const registry = makeRegistry({
      id: "el-solo-flat",
      config: {
        areas: [
          { id: "a1", signals: [sig("Cell1"), sig("Cell2")] },
          { id: "a2", signals: [sig("Cell3"), sig("PackVoltage")] },
          { id: "a3", signals: [sig("Current", "A")] },
        ],
      },
      trace: { start: 0, end: 60, isPaused: false } as unknown as ReturnType<typeof freshTrace>,
    });
    renderPanel({ params: { elementId: "el-solo-flat" }, registry });

    typeSolo("Cell");
    expect(rowVisibility()).toEqual([
      ["Cell1", true],
      ["Cell2", true],
      ["Cell3", true],
      // Area 2 matched, so solo applies to it and masks its non-match\u2026
      ["PackVoltage", false],
      // \u2026while Area 3 matched nothing and is untouched.
      ["Current", true],
    ]);
    expect(soloPosition()).toBe("all (3)");

    // Nothing to step: the controls are visibly inert, and the keys
    // move nothing.
    expect(screen.getByRole("button", { name: "next solo match" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "previous solo match" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "next solo match" }));
    fireEvent.keyDown(document.querySelector(".plot-panel")!, { key: "PageDown" });
    expect(soloPosition()).toBe("all (3)");

    // A capturing pattern over the same rows still pages.
    typeSolo("(Cell\\d)");
    expect(soloPosition()).toBe('1/3 \u00b7 "Cell1" (1 of 3)');
    expect(screen.getByRole("button", { name: "next solo match" })).not.toBeDisabled();
  });

  it("steps by capture-group key, so one page covers every area sharing it", () => {
    // The workflow the grouping exists for: one step is a cell index,
    // wherever in the panel that cell is plotted.
    const registry = makeRegistry({
      id: "el-solo-keyed",
      config: {
        areas: [
          { id: "a1", signals: [sig("Cell1"), sig("Cell2")] },
          { id: "a2", signals: [sig("Cell1"), sig("Cell10")] },
        ],
      },
      trace: { start: 0, end: 60, isPaused: false } as unknown as ReturnType<typeof freshTrace>,
    });
    renderPanel({ params: { elementId: "el-solo-keyed" }, registry });
    typeSolo("Cell(?<cell>\\d+)$");
    // Both Cell1 rows are the one group on show, and the read-out names
    // its key. Cell2 and Cell10 match too, just on other pages \u2014 off
    // the page, not merely unmatched, so they drop out of the side
    // list entirely (item 5) rather than showing hidden.
    expect(rowVisibility()).toEqual([
      ["Cell1", true],
      ["Cell1", true],
    ]);
    expect(screen.queryByText("Cell2")).not.toBeInTheDocument();
    expect(screen.queryByText("Cell10")).not.toBeInTheDocument();
    expect(soloPosition()).toBe("1/3 \u00b7 cell=1 (2 of 4)");
    // Keys order numerically: 2 before 10.
    fireEvent.click(screen.getByRole("button", { name: "next solo match" }));
    expect(soloPosition()).toBe("2/3 \u00b7 cell=2 (1 of 4)");
    fireEvent.click(screen.getByRole("button", { name: "next solo match" }));
    expect(soloPosition()).toBe("3/3 \u00b7 cell=10 (1 of 4)");
  });

  it("cycles the pages with PgDn / PgUp while the panel has focus", () => {
    const registry = stepRegistry("el-solo-keys");
    renderPanel({ params: { elementId: "el-solo-keys" }, registry });
    typeSolo("(Cell\\d)");
    const panel = document.querySelector(".plot-panel")!;

    fireEvent.keyDown(panel, { key: "PageDown" });
    expect(soloPosition()).toBe('2/3 \u00b7 "Cell2" (1 of 3)');
    fireEvent.keyDown(panel, { key: "PageDown" });
    fireEvent.keyDown(panel, { key: "PageDown" });
    expect(soloPosition()).toBe("all (3)");
    fireEvent.keyDown(panel, { key: "PageUp" });
    expect(soloPosition()).toBe('3/3 \u00b7 "Cell3" (1 of 3)');

    // ...and from inside the solo box itself, which is where focus sits
    // right after typing a pattern.
    fireEvent.keyDown(soloBox(), { key: "PageDown" });
    expect(soloPosition()).toBe("all (3)");
  });

  it("puts the configured number of groups on a page", async () => {
    // The setting is a page *size*: how many groups one page shows, and
    // so how far one press of the cycle moves.
    mockSettings.solo_page_size = 2;
    await hydrateSettings();
    try {
      const registry = stepRegistry("el-solo-page");
      renderPanel({ params: { elementId: "el-solo-page" }, registry });
      typeSolo("(Cell\\d)");
      // Three groups at two per page is two pages, the second short.
      expect(visibleNames()).toEqual(["Cell1", "Cell2"]);
      expect(soloPosition()).toBe('1/2 \u00b7 "Cell1"\u2013"Cell2" (2 of 3)');

      const panel = document.querySelector(".plot-panel")!;
      fireEvent.keyDown(panel, { key: "PageDown" });
      expect(visibleNames()).toEqual(["Cell3"]);
      expect(soloPosition()).toBe('2/2 \u00b7 "Cell3" (1 of 3)');
      fireEvent.keyDown(panel, { key: "PageDown" });
      expect(soloPosition()).toBe("all (3)");
      // The buttons walk the same cycle as the keys.
      fireEvent.click(screen.getByRole("button", { name: "next solo match" }));
      expect(soloPosition()).toBe('1/2 \u00b7 "Cell1"\u2013"Cell2" (2 of 3)');
    } finally {
      delete mockSettings.solo_page_size;
      await hydrateSettings();
    }
  });

  it("steps after a click on a part of the plot that takes no focus of its own", () => {
    // The canvas column, a signal row, the area chrome - none of them
    // are focusable, so clicking one used to drop focus out of the
    // panel's subtree entirely and the keystroke never reached the
    // panel's handler. Stepping has to work from anywhere in the panel,
    // not only while one of the toolbar's own controls holds focus.
    const registry = stepRegistry("el-solo-keys-anywhere");
    renderPanel({ params: { elementId: "el-solo-keys-anywhere" }, registry });
    typeSolo("(Cell\\d)");

    fireEvent.mouseDown(document.querySelector(".plot-area-canvas")!);
    expect(document.activeElement).toBe(document.querySelector(".plot-panel"));
    fireEvent.keyDown(document.activeElement!, { key: "PageDown" });
    expect(soloPosition()).toBe('2/3 \u00b7 "Cell2" (1 of 3)');

    // A press headed for something that takes focus of its own is left
    // alone - the panel only claims what would otherwise fall out of it.
    soloBox().focus();
    fireEvent.mouseDown(soloBox());
    expect(document.activeElement).toBe(soloBox());
  });

  it("ignores PgDn / PgUp while no solo pattern is matching", () => {
    const registry = stepRegistry("el-solo-keys-off");
    renderPanel({ params: { elementId: "el-solo-keys-off" }, registry });
    const panel = document.querySelector(".plot-panel")!;
    fireEvent.keyDown(panel, { key: "PageDown" });
    expect(visibleNames()).toEqual(["Cell1", "Cell2", "Cell3", "PackVoltage"]);
    // A pattern that matches nothing has nothing to step through, and
    // nothing to mask either.
    typeSolo("Nope");
    fireEvent.keyDown(panel, { key: "PageDown" });
    expect(visibleNames()).toEqual(["Cell1", "Cell2", "Cell3", "PackVoltage"]);
    expect(soloPosition()).toBe("no matches");
  });

  it("gives the no-matches read-out a distinct visual treatment", () => {
    const registry = stepRegistry("el-solo-empty-style");
    renderPanel({ params: { elementId: "el-solo-empty-style" }, registry });
    const posEl = () => screen.getByLabelText("solo position");
    typeSolo("Cell1");
    expect(posEl().className).not.toMatch(/plot-solo-pos-empty/);
    typeSolo("NoSuchSignal");
    expect(posEl().className).toMatch(/plot-solo-pos-empty/);
  });

  it("restores the full view from a page on Escape", () => {
    const registry = stepRegistry("el-solo-step-escape");
    const { api } = renderPanel({ params: { elementId: "el-solo-step-escape" }, registry });
    typeSolo("(Cell\\d)");
    expect(visibleNames()).toEqual(["Cell1"]);
    expect(persistedSolo(api)).toEqual({ pattern: "(Cell\\d)", page: 0 });

    fireEvent.keyDown(soloBox(), { key: "Escape" });
    expect(visibleNames()).toEqual(["Cell1", "Cell2", "Cell3", "PackVoltage"]);
    expect(persistedSolo(api)).toBeUndefined();
  });

  it("lands a modified pattern back on page 1", () => {
    // A new pattern is a new group list, so the page it was on means
    // nothing; page 1 is what the user typed it looking for.
    const registry = stepRegistry("el-solo-retype");
    renderPanel({ params: { elementId: "el-solo-retype" }, registry });
    typeSolo("(Cell\\d)");
    fireEvent.click(screen.getByRole("button", { name: "next solo match" }));
    expect(soloPosition()).toBe('2/3 \u00b7 "Cell2" (1 of 3)');
    typeSolo("(Cell[23])");
    expect(soloPosition()).toBe('1/2 \u00b7 "Cell2" (1 of 2)');
  });

  it("reads a page stored under a captureless pattern as the flat view", () => {
    // The pattern lost its capture group (or the blob predates the rule);
    // either way the stored page names nothing, so the flat filter is
    // what restores.
    const registry = stepRegistry("el-solo-restore-flat", {
      solo: { pattern: "Cell", page: 2 },
    });
    renderPanel({ params: { elementId: "el-solo-restore-flat" }, registry });
    expect(soloPosition()).toBe("all (3)");
    expect(visibleNames()).toEqual(["Cell1", "Cell2", "Cell3"]);
  });

  it("pulls a restored page past the end onto the last one", () => {
    // Only a capturing pattern has pages to restore onto at all.
    const registry = stepRegistry("el-solo-restore-page", {
      solo: { pattern: "(Cell\\d)", page: 9 },
    });
    renderPanel({ params: { elementId: "el-solo-restore-page" }, registry });
    expect(soloPosition()).toBe('3/3 \u00b7 "Cell3" (1 of 3)');
    expect(visibleNames()).toEqual(["Cell3"]);
  });

  it("leaves the panel untouched when a restored pattern matches nothing yet", () => {
    // A page restored before the catalog populated the pattern's rows
    // has no group to name; nothing matches, so nothing is masked and
    // no area collapses - the panel waits rather than going blank.
    const registry = stepRegistry("el-solo-restore-empty", {
      solo: { pattern: "NotYetLoaded", page: 2 },
    });
    renderPanel({ params: { elementId: "el-solo-restore-empty" }, registry });
    expect(visibleNames()).toEqual(["Cell1", "Cell2", "Cell3", "PackVoltage"]);
    expect(soloPosition()).toBe("no matches");
    expect(
      Array.from(document.querySelectorAll(".plot-area")).map((a) =>
        a.classList.contains("collapsed"),
      ),
    ).toEqual([false, false]);
  });

  it("reads a pre-paging blob as the pattern alone, whole set shown", () => {
    const registry = stepRegistry("el-solo-restore-old", {
      solo: { pattern: "Cell", indices: [1] },
    });
    renderPanel({ params: { elementId: "el-solo-restore-old" }, registry });
    expect(soloPosition()).toBe("all (3)");
  });

  /// Open the solo control's context menu and read its group items.
  const openSoloMenu = () => fireEvent.contextMenu(document.querySelector(".plot-solo")!);
  const menuItems = () =>
    Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).map(
      (b) => [b.getAttribute("aria-label"), b.getAttribute("aria-checked") === "true"] as const,
    );

  it("lists the step sequence's groups, marking the ones on show", () => {
    const registry = stepRegistry("el-solo-menu");
    renderPanel({ params: { elementId: "el-solo-menu" }, registry });
    typeSolo("(Cell\\d)");
    openSoloMenu();
    expect(menuItems()).toEqual([
      ['"Cell1"', true],
      ['"Cell2"', false],
      ['"Cell3"', false],
    ]);
    // On the whole set, every group is on show.
    fireEvent.click(screen.getByRole("button", { name: "previous solo match" }));
    expect(menuItems()).toEqual([
      ['"Cell1"', true],
      ['"Cell2"', true],
      ['"Cell3"', true],
    ]);
  });

  it("ticks a subset of the groups, and shows exactly that", () => {
    const registry = stepRegistry("el-solo-menu-subset");
    renderPanel({ params: { elementId: "el-solo-menu-subset" }, registry });
    typeSolo("(Cell\\d)");
    openSoloMenu();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: '"Cell3"' }));
    expect(visibleNames()).toEqual(["Cell3"]);
    expect(soloPosition()).toBe('1 group \u00b7 "Cell3" (1 of 3)');
    // The menu stays up, and a second tick adds to the subset rather
    // than replacing it.
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: '"Cell1"' }));
    expect(visibleNames()).toEqual(["Cell1", "Cell3"]);
    expect(soloPosition()).toBe('2 groups \u00b7 "Cell1", "Cell3" (2 of 3)');
    expect(menuItems()).toEqual([
      ['"Cell1"', true],
      ['"Cell2"', false],
      ['"Cell3"', true],
    ]);
    // Past two, the read-out counts instead of listing.
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: '"Cell2"' }));
    expect(soloPosition()).toBe("3 groups (3 of 3)");

    // Unticking is the same gesture, and emptying the subset is the
    // whole matched set again.
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: '"Cell1"' }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: '"Cell2"' }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: '"Cell3"' }));
    expect(visibleNames()).toEqual(["Cell1", "Cell2", "Cell3"]);
    expect(soloPosition()).toBe("all (3)");
  });

  it("ticks individual matches when the pattern captures nothing", () => {
    // No groups to tick, so the items are the matches themselves \u2014
    // labelled by area so two rows of the same name read apart.
    const registry = stepRegistry("el-solo-menu-flat");
    renderPanel({ params: { elementId: "el-solo-menu-flat" }, registry });
    typeSolo("Cell");
    openSoloMenu();
    expect(menuItems()).toEqual([
      ["Area 1 \u00b7 Cell1", true],
      ["Area 1 \u00b7 Cell2", true],
      ["Area 2 \u00b7 Cell3", true],
    ]);

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Area 2 \u00b7 Cell3" }));
    expect(visibleNames()).toEqual(["Cell3"]);
    expect(soloPosition()).toBe("1 signal \u00b7 Area 2 \u00b7 Cell3 (1 of 3)");
    // \u2026and there is still no cycle to resume, so the subset stays put.
    expect(screen.getByRole("button", { name: "next solo match" })).toBeDisabled();
  });

  it("leaves a ticked subset behind when you step, resuming from where it sat", () => {
    const registry = stepRegistry("el-solo-menu-step-out");
    renderPanel({ params: { elementId: "el-solo-menu-step-out" }, registry });
    typeSolo("(Cell\\d)");
    openSoloMenu();

    // Forward resumes at the page *after* the last checked group's.
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: '"Cell2"' }));
    expect(soloPosition()).toBe('1 group \u00b7 "Cell2" (1 of 3)');
    fireEvent.click(screen.getByRole("button", { name: "next solo match" }));
    expect(soloPosition()).toBe('3/3 \u00b7 "Cell3" (1 of 3)');

    // Backward resumes at the page *before* the first checked group's.
    openSoloMenu();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: '"Cell2"' }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: '"Cell3"' }));
    expect(soloPosition()).toBe('2 groups \u00b7 "Cell2", "Cell3" (2 of 3)');
    fireEvent.click(screen.getByRole("button", { name: "previous solo match" }));
    expect(soloPosition()).toBe('1/3 \u00b7 "Cell1" (1 of 3)');
  });

  it("drops a ticked subset when the pattern is modified", () => {
    const registry = stepRegistry("el-solo-menu-retype");
    renderPanel({ params: { elementId: "el-solo-menu-retype" }, registry });
    typeSolo("(Cell\\d)");
    openSoloMenu();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: '"Cell3"' }));
    expect(soloPosition()).toBe('1 group \u00b7 "Cell3" (1 of 3)');
    // A new pattern is a new item list, so the ticks mean nothing.
    typeSolo("(Cell[23])");
    expect(soloPosition()).toBe('1/2 \u00b7 "Cell2" (1 of 2)');
  });

  it("persists a ticked subset instead of a page, and restores it", () => {
    const registry = stepRegistry("el-solo-subset-save");
    const { api } = renderPanel({ params: { elementId: "el-solo-subset-save" }, registry });
    typeSolo("(Cell\\d)");
    openSoloMenu();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: '"Cell3"' }));
    const blob = persistedSolo(api) as Record<string, unknown>;
    // The subset displaces the page \u2014 the two forms are exclusive.
    expect(blob).toEqual({ pattern: "(Cell\\d)", checked: [expect.any(String)] });

    cleanup();
    const restored = stepRegistry("el-solo-subset-restore", { solo: blob });
    renderPanel({ params: { elementId: "el-solo-subset-restore" }, registry: restored });
    expect(visibleNames()).toEqual(["Cell3"]);
    expect(soloPosition()).toBe('1 group \u00b7 "Cell3" (1 of 3)');
  });

  it("reads a subset whose ticks no longer name anything as the whole set", () => {
    const registry = stepRegistry("el-solo-subset-stale", {
      solo: { pattern: "(Cell\\d)", checked: ["a group this pattern never makes"] },
    });
    renderPanel({ params: { elementId: "el-solo-subset-stale" }, registry });
    expect(soloPosition()).toBe("all (3)");
    expect(visibleNames()).toEqual(["Cell1", "Cell2", "Cell3"]);
  });

  it("offers no match menu while the pattern is empty or unparseable", () => {
    const registry = stepRegistry("el-solo-menu-off");
    renderPanel({ params: { elementId: "el-solo-menu-off" }, registry });
    openSoloMenu();
    expect(menuItems()).toEqual([]);
    typeSolo("Cell(");
    openSoloMenu();
    expect(menuItems()).toEqual([]);
  });

  it("opens the match menu on a left-click of the position read-out too", () => {
    const registry = stepRegistry("el-solo-menu-leftclick");
    renderPanel({ params: { elementId: "el-solo-menu-leftclick" }, registry });
    typeSolo("(Cell\\d)");
    expect(menuItems()).toEqual([]);
    fireEvent.click(screen.getByLabelText("solo position"));
    expect(menuItems()).toEqual([
      ['"Cell1"', true],
      ['"Cell2"', false],
      ['"Cell3"', false],
    ]);
  });

  /// A catalogued series, so a manual pick and a row an area's
  /// `patterns` materialize resolve through the same catalog entry.
  const catalogSig = (signalName: string, unit = "A") => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "EngineData",
    unit,
    color: "#4ecbff",
  });

  /// One area holding both kinds of row — two manual picks plus the row
  /// its own `patterns` entry adds (ADR 0038) — beside an area holding
  /// neither match.
  const mixedRegistry = (id: string) =>
    makeRegistry({
      id,
      config: {
        areas: [
          {
            id: "a1",
            signals: [catalogSig("LimitNominal"), catalogSig("EngineTemp", "degC")],
            patterns: ["EngineData/Limit"],
          },
          { id: "a2", signals: [catalogSig("EngineSpeed", "rpm")] },
        ],
      },
      trace: { start: 0, end: 60, isPaused: false } as unknown as ReturnType<typeof freshTrace>,
    });

  it("groups a pattern-provided row exactly like a manual pick", async () => {
    // What decides how much a page shows is whether the *solo* pattern
    // captures — not how a row got into the area. A capture group both
    // rows share makes them one group, so one page shows both kinds
    // together.
    const registry = mixedRegistry("el-solo-mixed-keyed");
    renderPanel({ params: { elementId: "el-solo-mixed-keyed" }, registry });
    await waitFor(() =>
      expect(rowVisibility()).toEqual([
        ["LimitNominal", true],
        ["EngineTemp", true],
        ["LimitEffective", true],
        ["EngineSpeed", true],
      ]),
    );

    typeSolo("(Limit)\\w+");
    expect(rowVisibility()).toEqual([
      ["LimitNominal", true],
      ["EngineTemp", false],
      ["LimitEffective", true],
      ["EngineSpeed", true],
    ]);
    expect(soloPosition()).toBe('1/1 · "Limit" (2 of 2)');
  });

  it("shows both row kinds at once when the solo pattern captures nothing", async () => {
    // The same two rows under a pattern with no capture group. There is
    // no index to page by, so it filters flat: both matches on show
    // together, whichever kind of row they are, and nothing to step.
    const registry = mixedRegistry("el-solo-mixed-flat");
    renderPanel({ params: { elementId: "el-solo-mixed-flat" }, registry });
    await waitFor(() => expect(rowVisibility().length).toBe(4));

    typeSolo("Limit");
    expect(rowVisibility()).toEqual([
      ["LimitNominal", true],
      ["EngineTemp", false],
      ["LimitEffective", true],
      ["EngineSpeed", true],
    ]);
    expect(soloPosition()).toBe("all (2)");

    const next = screen.getByRole("button", { name: "next solo match" });
    expect(next).toBeDisabled();
    fireEvent.click(next);
    expect(soloPosition()).toBe("all (2)");
  });

  it("flips visibility without a host round-trip or a chart rebuild", async () => {
    // Every plotted signal is already sampled — hidden ones included —
    // so a solo change is a re-normalise + redraw of the window each
    // area already holds: no fetch, and no new uPlot instance (which at
    // the series counts this panel targets is the expensive thing).
    // A stopped trace, so no self-paced tick can be mistaken for either.
    await withSizedCanvas(async () => {
      const registry = cellRegistry("el-solo-nofetch");
      renderPanel({ params: { elementId: "el-solo-nofetch" }, registry });
      // Past the one-shot post-mount rebuild (250 ms) first, then flush
      // until a flush costs nothing — so the counts below measure the
      // solo change and only it.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      for (let i = 0; i < 20; i++) {
        const settled = sampleCalls();
        await act(async () => {
          await new Promise((r) => setTimeout(r, 100));
        });
        if (sampleCalls() === settled) break;
      }
      const before = sampleCalls();
      const builtBefore = uplotInstances.length;
      expect(before).toBeGreaterThan(0);
      const instance = liveInstanceIn("Area 1");
      const drawn = drawnPoints(instance);
      expect(drawn).toBeGreaterThan(0);

      await act(async () => {
        typeSolo("Cell16");
        await new Promise((r) => setTimeout(r, 200));
      });
      expect(sampleCalls()).toBe(before);
      expect(uplotInstances.length).toBe(builtBefore);
      // …and the same instance still draws its window rather than
      // blanking out until the next pan/zoom.
      expect(liveInstanceIn("Area 1")).toBe(instance);
      expect(drawnPoints(instance)).toBe(drawn);
    });
  });

  it("repaints when the pattern is cleared, not only when it is typed", async () => {
    // Two amps signals on one per-unit axis: while both draw, the group
    // unions to 0..3000 and the effective limit sits in the bottom
    // sixth; soloing it rescales the axis to what is drawn. Clearing
    // the pattern has to put the axis back *now* — the normalisation
    // only moves on a resample, so a deactivation that skips one leaves
    // the solo scale on screen until a pan or zoom forces one.
    mockSignalExtents.LimitNominal = { lo: 0, hi: 3000 };
    mockSignalExtents.LimitEffective = { lo: 0, hi: 500 };
    mockSampleSeries.LimitNominal = { t: [0, 1, 2], v: [3000, 3000, 3000] };
    mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [0, 250, 500] };
    const amps = (signalName: string) => ({
      busId: null,
      messageId: 256,
      extended: false,
      signalName,
      messageName: "EngineData",
      unit: "A",
      color: "#4ecbff",
    });
    const registry = makeRegistry({
      id: "el-solo-repaint",
      config: {
        areas: [
          { id: "a1", yAxisMode: "per-unit", signals: [amps("LimitNominal"), amps("LimitEffective")] },
        ],
      },
      trace: { start: 0, end: 60, isPaused: false } as unknown as ReturnType<typeof freshTrace>,
    });
    await withSizedCanvas(async () => {
      renderPanel({ params: { elementId: "el-solo-repaint" }, registry });
      const effective = () =>
        ((uplotInstances[uplotInstances.length - 1]?.data ?? []) as (number | null)[][])[2];
      await waitFor(() => expect(effective()?.[2]).toBeCloseTo(500 / 3000, 6));

      typeSolo("LimitEffective");
      await waitFor(() => expect(effective()?.[2]).toBeCloseTo(1, 6));

      typeSolo("");
      await waitFor(() => expect(effective()?.[2]).toBeCloseTo(500 / 3000, 6));
    });
  });

  it("repaints a solo change that landed while a fetch was in flight", async () => {
    // The same repaint, this time asked for while the area is waiting on
    // a sample it just requested — the shape of "I zoomed, then cleared
    // the box". A stopped trace has no self-paced tick to retry with, so
    // a repaint the busy guard turns away is turned away for good and
    // the axis keeps the scale it had until the next pan or zoom.
    mockSignalExtents.LimitNominal = { lo: 0, hi: 3000 };
    mockSignalExtents.LimitEffective = { lo: 0, hi: 500 };
    mockSampleSeries.LimitNominal = { t: [0, 1, 2], v: [3000, 3000, 3000] };
    mockSampleSeries.LimitEffective = { t: [0, 1, 2], v: [0, 250, 500] };
    const amps = (signalName: string) => ({
      busId: null,
      messageId: 256,
      extended: false,
      signalName,
      messageName: "EngineData",
      unit: "A",
      color: "#4ecbff",
    });
    const registry = makeRegistry({
      id: "el-solo-inflight",
      config: {
        areas: [
          { id: "a1", yAxisMode: "per-unit", signals: [amps("LimitNominal"), amps("LimitEffective")] },
        ],
      },
      trace: { start: 0, end: 60, isPaused: false } as unknown as ReturnType<typeof freshTrace>,
    });
    await withSizedCanvas(async () => {
      renderPanel({ params: { elementId: "el-solo-inflight" }, registry });
      const effective = () =>
        ((uplotInstances[uplotInstances.length - 1]?.data ?? []) as (number | null)[][])[2];
      await waitFor(() => expect(effective()?.[2]).toBeCloseTo(500 / 3000, 6));
      // Past the one-shot post-mount rebuild, so the only fetch in
      // flight below is the one this test parks.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });

      typeSolo("LimitEffective");
      await waitFor(() => expect(effective()?.[2]).toBeCloseTo(1, 6));

      // Park the fetch a window change asks for…
      mockSampleStall.on = true;
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "All Data" }));
      });
      await waitFor(() => expect(mockSampleStall.pending.length).toBeGreaterThan(0));

      // …clear solo while it is still out, and let it land.
      typeSolo("");
      mockSampleStall.on = false;
      await act(async () => {
        for (const resolve of mockSampleStall.pending.splice(0)) {
          resolve(
            encodeSample([
              { t: [0, 1, 2], v: [3000, 3000, 3000] },
              { t: [0, 1, 2], v: [0, 250, 500] },
            ]),
          );
        }
      });
      await waitFor(() => expect(effective()?.[2]).toBeCloseTo(500 / 3000, 6));
    });
  });
});

describe("PlotPanel signal-row selection", () => {
  /// The signal names of every selected row, in DOM order — the panel's
  /// selection as it reads on screen.
  const selectedNames = () =>
    Array.from(document.querySelectorAll(".plot-signal-row.selected")).map(
      (r) => r.querySelector(".plot-signal-name")?.textContent ?? "",
    );

  /// The row whose signal name is `name`, optionally within one area.
  /// The same signal can sit in several areas, so multi-area tests scope
  /// the lookup; a single-area test omits `areaLabel` and searches the
  /// whole panel (its rows may be spread over several derived axes).
  function row(name: string, areaLabel?: string): HTMLElement {
    const scope: ParentNode =
      areaLabel == null ? document : screen.getByText(areaLabel).closest(".plot-area")!;
    const found = Array.from(scope.querySelectorAll(".plot-signal-row")).find(
      (r) => r.querySelector(".plot-signal-name")?.textContent === name,
    );
    if (!found) throw new Error(`no signal row for ${name}${areaLabel ? ` in ${areaLabel}` : ""}`);
    return found as HTMLElement;
  }

  const clickRow = (name: string, init?: Record<string, unknown>, areaLabel?: string) =>
    fireEvent.click(row(name, areaLabel), init);

  /// The name of the row marked primary (drives the y-axis units).
  const primaryName = () =>
    document.querySelector(".plot-signal-row.primary .plot-signal-name")?.textContent ?? null;

  async function addToFocused(names: string[]) {
    for (const n of names) {
      addFocusedSignal(n);
      await waitFor(() => expect(row(n)).toBeInTheDocument());
    }
  }

  it("selects a row and promotes it to primary on a plain click", async () => {
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp"]);
    // The first-added signal is the default primary, and nothing is
    // selected until the user clicks.
    expect(primaryName()).toBe("EngineSpeed");
    expect(selectedNames()).toEqual([]);

    clickRow("EngineTemp");
    expect(selectedNames()).toEqual(["EngineTemp"]);
    expect(primaryName()).toBe("EngineTemp");

    // A second plain click replaces the selection rather than adding.
    clickRow("EngineSpeed");
    expect(selectedNames()).toEqual(["EngineSpeed"]);
    expect(primaryName()).toBe("EngineSpeed");
  });

  it("toggles membership on ctrl-click, leaving the primary alone", async () => {
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp", "LimitNominal"]);
    clickRow("EngineSpeed");
    expect(primaryName()).toBe("EngineSpeed");

    clickRow("LimitNominal", { ctrlKey: true });
    expect(selectedNames()).toEqual(["EngineSpeed", "LimitNominal"]);
    // Only a *plain* click promotes — the modified chords build the
    // selection and nothing else.
    expect(primaryName()).toBe("EngineSpeed");

    clickRow("EngineSpeed", { ctrlKey: true });
    expect(selectedNames()).toEqual(["LimitNominal"]);
    expect(primaryName()).toBe("EngineSpeed");
  });

  it("range-selects from the anchor on shift-click, leaving the primary alone", async () => {
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp", "LimitNominal"]);
    clickRow("EngineTemp");
    clickRow("LimitNominal", { shiftKey: true });
    expect(selectedNames()).toEqual(["EngineTemp", "LimitNominal"]);
    expect(primaryName()).toBe("EngineTemp");

    // The anchor stays on the first click's row, so the next range runs
    // the other way from the same point.
    clickRow("EngineSpeed", { shiftKey: true });
    expect(selectedNames()).toEqual(["EngineSpeed", "EngineTemp"]);
    expect(primaryName()).toBe("EngineTemp");
  });

  it("extends the selection with Shift+Up/Down, from the anchor", async () => {
    // The gridview's keyboard range gesture (ADR 0044) over the signal
    // rows: the press is the panel's, so it works from anywhere in the
    // panel, and it runs on the area the selection already belongs to.
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp", "LimitNominal"]);
    const panel = document.querySelector(".plot-panel")!;
    clickRow("EngineTemp");

    fireEvent.keyDown(panel, { key: "ArrowDown", shiftKey: true });
    expect(selectedNames()).toEqual(["EngineTemp", "LimitNominal"]);
    // The anchor is the range's fixed end, so coming back shrinks the
    // range through it and then extends the other way.
    fireEvent.keyDown(panel, { key: "ArrowUp", shiftKey: true });
    expect(selectedNames()).toEqual(["EngineTemp"]);
    fireEvent.keyDown(panel, { key: "ArrowUp", shiftKey: true });
    expect(selectedNames()).toEqual(["EngineSpeed", "EngineTemp"]);
    // Only a plain click promotes, so the range gesture leaves the
    // primary where it was.
    expect(primaryName()).toBe("EngineTemp");
  });

  it("leaves Shift+Up/Down to a text field in the panel", async () => {
    // Shift+arrow is how text is selected; the solo box keeps it even
    // though the press would otherwise reach the panel's handler.
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp"]);
    clickRow("EngineSpeed");
    fireEvent.keyDown(screen.getByLabelText("solo pattern"), {
      key: "ArrowDown",
      shiftKey: true,
    });
    expect(selectedNames()).toEqual(["EngineSpeed"]);
  });

  it("does nothing on Shift+Up/Down while no row is selected", async () => {
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp"]);
    fireEvent.keyDown(document.querySelector(".plot-panel")!, {
      key: "ArrowDown",
      shiftKey: true,
    });
    expect(selectedNames()).toEqual([]);
  });

  it("ranges across a per-unit area's derived axes, in the area's own order", async () => {
    // One logical area, four signals, three units → three PlotArea
    // instances, each holding a slice of the area's rows (ADR 0026). A
    // range is over the *area's* order, not any one axis's.
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp", "LimitNominal", "LimitEffective"]);
    await pickCombobox(screen.getByLabelText("y-axis mode"), "per-unit");
    expect(document.querySelectorAll(".plot-area").length).toBe(3);

    clickRow("EngineSpeed");
    clickRow("LimitNominal", { shiftKey: true });
    // EngineTemp sits on a third axis between them and is swept in.
    expect(selectedNames()).toEqual(["EngineSpeed", "EngineTemp", "LimitNominal"]);
    // …and the row past the range's end is not.
    expect(row("LimitEffective").classList.contains("selected")).toBe(false);
  });

  it("never spans two areas — a click in another area clears the first", async () => {
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp"]);
    clickRow("EngineSpeed");
    clickRow("EngineTemp", { ctrlKey: true });
    expect(selectedNames()).toEqual(["EngineSpeed", "EngineTemp"]);

    fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
    await act(async () => dropSignal("Area 2", "LimitNominal", "A"));
    // Ctrl-click, so nothing but the selection can move: it still lands
    // wholly in area 2.
    clickRow("LimitNominal", { ctrlKey: true }, "Area 2");
    expect(selectedNames()).toEqual(["LimitNominal"]);
    expect(row("EngineSpeed", "Area 1").classList.contains("selected")).toBe(false);
  });

  it("leaves the selection alone when the swatch toggles hidden", async () => {
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp"]);
    clickRow("EngineSpeed");
    expect(selectedNames()).toEqual(["EngineSpeed"]);
    // The swatch's own handler stops the row click, so hide/show is not
    // a selection gesture.
    fireEvent.click(row("EngineTemp").querySelector(".plot-signal-swatch")!);
    expect(row("EngineTemp").classList.contains("hidden")).toBe(true);
    expect(selectedNames()).toEqual(["EngineSpeed"]);
    expect(primaryName()).toBe("EngineSpeed");
  });

  it("draws the selected series bold, without rebuilding the chart", async () => {
    await withSizedCanvas(async () => {
      renderPanel();
      await addToFocused(["EngineSpeed", "EngineTemp"]);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      const inst = liveInstanceIn("Area 1");
      // series[0] is x; the signal series follow in order.
      const widths = () => inst.series.slice(1).map((s) => s.width);
      expect(widths()).toEqual([1, 1]);

      const redraws = inst.redraws;
      await act(async () => {
        clickRow("EngineTemp", { ctrlKey: true });
      });
      expect(widths()).toEqual([1, 2]);
      // The same instance, restyled and redrawn — a rebuild would cost a
      // cold whole-window refetch on every selection click.
      expect(liveInstanceIn("Area 1")).toBe(inst);
      expect(inst.redraws).toBeGreaterThan(redraws);

      // Deselecting puts the line back.
      await act(async () => {
        clickRow("EngineTemp", { ctrlKey: true });
      });
      expect(widths()).toEqual([1, 1]);
      expect(liveInstanceIn("Area 1")).toBe(inst);
    });
  });

  it("keeps the selection bold across a rebuild of the chart", async () => {
    // A signal-set change does rebuild the instance; the fresh one has
    // to open with the widths the standing selection implies, or the
    // bolding silently drops off the moment a signal is added.
    await withSizedCanvas(async () => {
      renderPanel();
      await addToFocused(["EngineSpeed", "EngineTemp"]);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      const before = liveInstanceIn("Area 1");
      await act(async () => {
        clickRow("EngineSpeed", { ctrlKey: true });
      });

      await addToFocused(["LimitNominal"]);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      const after = liveInstanceIn("Area 1");
      expect(after).not.toBe(before);
      expect(after.series.slice(1).map((s) => s.width)).toEqual([2, 1, 1]);
    });
  });

  it("re-renders no plot area that holds none of the affected rows", async () => {
    // The selection reaches each `PlotArea` as an area-scoped slice, so
    // a click that changes it must not invalidate the memo on areas that
    // hold neither the rows leaving the selection nor the ones joining
    // it. Ctrl-clicks throughout, so this measures the selection alone: a
    // plain click also moves the primary, which is an `areas` edit (and
    // scoped to its own area in its own right — see "PlotPanel per-area
    // render scoping").
    await withSizedCanvas(async () => {
      // Three areas seeded from a saved config, so they all mount
      // together and no area's own settling (first-sample wait, the
      // post-mount uPlot rebuild) can land mid-measurement. A *stopped*
      // panel, so no self-paced resample can either.
      const sig = (signalName: string, unit: string) => ({
        busId: null,
        messageId: 256,
        extended: false,
        signalName,
        messageName: "EngineData",
        unit,
        color: "#4ecbff",
      });
      const registry = makeRegistry({
        id: "el-sel-memo",
        config: {
          areas: [
            { id: "a1", signals: [sig("EngineSpeed", "rpm"), sig("EngineTemp", "degC")] },
            { id: "a2", signals: [sig("LimitNominal", "A")] },
            { id: "a3", signals: [sig("LimitEffective", "A")] },
          ],
        },
        trace: { start: 0, end: 60, isPaused: false },
      });
      renderPanel({ params: { elementId: "el-sel-memo" }, registry });
      const counter = (k: string) => diagCounts().get(k) ?? 0;
      // Everything the mount kicks off asynchronously — the value-table
      // fetch, the first-sample wait, the settings hydration a previous
      // test's teardown left in flight — re-renders the stack when it
      // lands. Flush until a flush costs nothing, so the counts below
      // measure the click and only the click.
      for (let i = 0; i < 20; i++) {
        const settled = counter("render.PlotArea");
        await act(async () => {
          await new Promise((r) => setTimeout(r, 60));
        });
        if (counter("render.PlotArea") === settled) break;
      }

      await act(async () => {
        clickRow("EngineSpeed", { ctrlKey: true }, "Area 1");
      });
      // Extending the selection inside area 1: only area 1 re-renders.
      let before = counter("render.PlotArea");
      await act(async () => {
        clickRow("EngineTemp", { ctrlKey: true }, "Area 1");
      });
      expect(selectedNames()).toEqual(["EngineSpeed", "EngineTemp"]);
      expect(counter("render.PlotArea") - before).toBe(1);

      // Moving the selection to area 2: areas 1 and 2 re-render (one
      // loses its highlight, the other gains one) and area 3 does not.
      before = counter("render.PlotArea");
      await act(async () => {
        clickRow("LimitNominal", { ctrlKey: true }, "Area 2");
      });
      expect(selectedNames()).toEqual(["LimitNominal"]);
      expect(counter("render.PlotArea") - before).toBe(2);
    });
  });

  /// The `areas` list persisted so far, one entry per `updateParameters`
  /// call — used to count persists, not just read the latest one.
  const persistCalls = (api: { updateParameters: { mock: { calls: unknown[][] } } }) =>
    api.updateParameters.mock.calls.length;

  it("bulk-hides the selection from its context menu, in one persist", async () => {
    const { api } = renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp", "LimitNominal"]);
    clickRow("EngineSpeed");
    clickRow("LimitNominal", { ctrlKey: true });
    expect(selectedNames()).toEqual(["EngineSpeed", "LimitNominal"]);

    const before = persistCalls(api);
    fireEvent.contextMenu(row("EngineSpeed"));
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));

    expect(row("EngineSpeed").classList.contains("hidden")).toBe(true);
    expect(row("LimitNominal").classList.contains("hidden")).toBe(true);
    expect(row("EngineTemp").classList.contains("hidden")).toBe(false);
    // One setAreas/persist for the whole batch, not one per touched row.
    expect(persistCalls(api) - before).toBe(1);
  });

  it("un-hides the selection from the context menu's Show", async () => {
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp"]);
    clickRow("EngineSpeed");
    clickRow("EngineTemp", { ctrlKey: true });
    fireEvent.contextMenu(row("EngineSpeed"));
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(row("EngineSpeed").classList.contains("hidden")).toBe(true);
    expect(row("EngineTemp").classList.contains("hidden")).toBe(true);

    fireEvent.contextMenu(row("EngineSpeed"));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(row("EngineSpeed").classList.contains("hidden")).toBe(false);
    expect(row("EngineTemp").classList.contains("hidden")).toBe(false);
  });

  it("bulk-hides a selection spanning a per-unit area's derived axes, in one persist", async () => {
    // One logical area, four signals, three units → three `PlotArea`
    // instances (ADR 0026). A range across them (49A) still resolves to
    // one logical area's selection, so the bulk action still touches
    // that one area's persisted `signals` list in one `setAreas` call.
    const { api } = renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp", "LimitNominal", "LimitEffective"]);
    await pickCombobox(screen.getByLabelText("y-axis mode"), "per-unit");
    expect(document.querySelectorAll(".plot-area").length).toBe(3);

    clickRow("EngineSpeed");
    clickRow("LimitNominal", { shiftKey: true });
    expect(selectedNames()).toEqual(["EngineSpeed", "EngineTemp", "LimitNominal"]);

    const before = persistCalls(api);
    fireEvent.contextMenu(row("EngineSpeed"));
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));

    expect(row("EngineSpeed").classList.contains("hidden")).toBe(true);
    expect(row("EngineTemp").classList.contains("hidden")).toBe(true);
    expect(row("LimitNominal").classList.contains("hidden")).toBe(true);
    expect(row("LimitEffective").classList.contains("hidden")).toBe(false);
    expect(persistCalls(api) - before).toBe(1);
  });

  it("hiding a pattern-derived row leaves every row where it was", async () => {
    // The row moves when the user moves it, and at no other time.
    // Hiding has to write an entry to carry the flag, and that entry
    // used to read as a manual pick — which sorts ahead of the pattern
    // matches, so the row jumped to the top of its area.
    const registry = makeRegistry({
      id: "el-hide-order",
      config: { areas: [{ id: "a1", signals: [], patterns: ["/EngineData/"] }] },
    });
    renderPanel({ params: { elementId: "el-hide-order" }, registry });
    const order = () =>
      Array.from(document.querySelectorAll(".plot-signal-name")).map((n) => n.textContent);
    await waitFor(() => expect(order()).toHaveLength(4));
    const before = order();
    expect(before[1]).toBe("EngineTemp");

    fireEvent.click(row("EngineTemp").querySelector("button.plot-signal-swatch")!);

    expect(row("EngineTemp").classList.contains("hidden")).toBe(true);
    expect(order()).toEqual(before);
    // A hidden row compacts to swatch + name (item 3), so neither the
    // badge nor a remove control renders while it's hidden — the
    // persistence check has to happen on the way back. Showing it
    // again still reads as the pattern's row, not a pick: the badge
    // returns and there is no per-row × to remove something the
    // pattern would put straight back.
    fireEvent.click(row("EngineTemp").querySelector("button.plot-signal-swatch")!);
    expect(row("EngineTemp").classList.contains("hidden")).toBe(false);
    expect(row("EngineTemp").querySelector(".plot-signal-remove")).toBeNull();
    expect(row("EngineTemp").querySelector(".plot-signal-pattern-badge")).not.toBeNull();
  });

  it("bulk-hides pattern-derived rows without moving them or turning them into picks", async () => {
    // "Engine" matches both fixture signals under the EngineEcu/
    // EngineData ancestry (EngineSpeed, EngineTemp) and neither Limit
    // signal.
    const registry = makeRegistry({
      id: "el-sel-patterns",
      config: { areas: [{ id: "a1", signals: [], patterns: ["Engine"] }] },
    });
    const { api } = renderPanel({ params: { elementId: "el-sel-patterns" }, registry });
    await waitFor(() => expect(row("EngineSpeed")).toBeInTheDocument());
    expect(row("EngineTemp")).toBeInTheDocument();
    // Both start pattern-derived: a badge, no remove button.
    expect(row("EngineSpeed").querySelector(".plot-signal-remove")).toBeNull();
    expect(row("EngineTemp").querySelector(".plot-signal-remove")).toBeNull();

    clickRow("EngineSpeed");
    clickRow("EngineTemp", { ctrlKey: true });

    const before = persistCalls(api);
    fireEvent.contextMenu(row("EngineSpeed"));
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));

    expect(row("EngineSpeed").classList.contains("hidden")).toBe(true);
    expect(row("EngineTemp").classList.contains("hidden")).toBe(true);
    // The entry each hide wrote carries the flag and nothing else: the
    // rows are still the pattern's, so they keep their badge, their
    // place, and no per-row ×.
    expect(row("EngineSpeed").querySelector(".plot-signal-remove")).toBeNull();
    expect(row("EngineTemp").querySelector(".plot-signal-remove")).toBeNull();
    // The pattern itself is untouched — still live, still the one entry.
    expect(screen.getByRole("button", { name: /patterns \(1\)/ })).toBeInTheDocument();
    expect(persistCalls(api) - before).toBe(1);
  });

  it("right-clicking a row outside the selection replaces it with just that row", async () => {
    // The platform norm (Explorer / Finder / VS Code): a context menu
    // needs an unambiguous, on-screen answer to "what does this act
    // on", so right-clicking outside the selection redefines it first.
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp", "LimitNominal"]);
    clickRow("EngineSpeed");
    clickRow("LimitNominal", { ctrlKey: true });
    expect(selectedNames()).toEqual(["EngineSpeed", "LimitNominal"]);

    fireEvent.contextMenu(row("EngineTemp"));
    expect(selectedNames()).toEqual(["EngineTemp"]);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(row("EngineTemp").classList.contains("hidden")).toBe(true);
    expect(row("EngineSpeed").classList.contains("hidden")).toBe(false);
    expect(row("LimitNominal").classList.contains("hidden")).toBe(false);
  });

  it("right-clicking the swatch still opens the color picker, not the selection menu", async () => {
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp"]);
    clickRow("EngineSpeed");
    fireEvent.contextMenu(row("EngineTemp").querySelector(".plot-signal-swatch")!);
    expect(document.querySelector(".plot-selection-menu")).toBeNull();
    // The row's own context-menu handler never saw the event either —
    // the selection is unchanged.
    expect(selectedNames()).toEqual(["EngineSpeed"]);
  });

  it("drags the whole selection when a selected row starts the drag", async () => {
    // DatabasePanel precedent (ADR 0045): a grab that lands on a row already
    // in the selection carries every selected row's signal.
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp", "LimitNominal"]);
    clickRow("EngineSpeed");
    clickRow("LimitNominal", { ctrlKey: true });
    expect(selectedNames()).toEqual(["EngineSpeed", "LimitNominal"]);

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
    Object.defineProperty(dt, "types", { get: () => Object.keys(store) });
    fireEvent.dragStart(row("EngineSpeed"), { dataTransfer: dt });

    const payload = JSON.parse(store["application/x-cannet-plot-signal"]) as {
      signals: { signalName: string }[];
    };
    expect(payload.signals.map((s) => s.signalName).sort()).toEqual(
      ["EngineSpeed", "LimitNominal"].sort(),
    );
  });

  it("dragging an unselected row drags just that row, leaving the selection untouched", async () => {
    // DatabasePanel precedent: "the panel's visible selection is unchanged
    // so the user can keep it" — a drag has no on-screen moment that
    // needs the selection to visibly repoint the way a context menu
    // does.
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp", "LimitNominal"]);
    clickRow("EngineSpeed");
    clickRow("LimitNominal", { ctrlKey: true });
    expect(selectedNames()).toEqual(["EngineSpeed", "LimitNominal"]);

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
    Object.defineProperty(dt, "types", { get: () => Object.keys(store) });
    fireEvent.dragStart(row("EngineTemp"), { dataTransfer: dt });

    const payload = JSON.parse(store["application/x-cannet-plot-signal"]) as {
      signals: { signalName: string }[];
    };
    expect(payload.signals.map((s) => s.signalName)).toEqual(["EngineTemp"]);
    expect(selectedNames()).toEqual(["EngineSpeed", "LimitNominal"]);
  });

  it("hides a two-signal selection sharing one axis with at most one extra resample", async () => {
    // The batching property at the seam that actually costs something:
    // one signal-set change on the touched axis, not one per row.
    await withSizedCanvas(async () => {
      const registry = makeRegistry({
        id: "el-sel-resample",
        config: { areas: [{ id: "a1", signals: [] }] },
        trace: { start: 0, end: 60, isPaused: false },
      });
      renderPanel({ params: { elementId: "el-sel-resample" }, registry });
      await addToFocused(["EngineSpeed", "EngineTemp"]);
      const counter = (k: string) => diagCounts().get(k) ?? 0;
      // Settle whatever mount kicked off before measuring.
      for (let i = 0; i < 20; i++) {
        const settled = counter("plotarea.resample");
        await act(async () => {
          await new Promise((r) => setTimeout(r, 60));
        });
        if (counter("plotarea.resample") === settled) break;
      }
      clickRow("EngineSpeed");
      clickRow("EngineTemp", { ctrlKey: true });

      const before = counter("plotarea.resample");
      fireEvent.contextMenu(row("EngineSpeed"));
      fireEvent.click(screen.getByRole("button", { name: "Hide" }));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      expect(counter("plotarea.resample") - before).toBeLessThanOrEqual(2);
    });
  });

  it("offers a 'Sort area' action on the row context menu", async () => {
    renderPanel();
    await addToFocused(["EngineSpeed", "EngineTemp"]);
    fireEvent.contextMenu(row("EngineSpeed"));
    expect(screen.getByRole("button", { name: "Sort area" })).toBeInTheDocument();
  });

  it("sorts the area by (generator index, then name) in one persist", async () => {
    // Scrambled add order; LimitNominal and EngineSpeed carry generator
    // slots (0 and 1), EngineTemp and LimitEffective don't — they tail,
    // ordered by name.
    const { api, setGeneratorIndexes } = renderPanel();
    await addToFocused(["EngineTemp", "LimitNominal", "EngineSpeed", "LimitEffective"]);
    setGeneratorIndexes(
      new Map([
        [signalKey(null, 256, false, "LimitNominal"), 0],
        [signalKey(null, 256, false, "EngineSpeed"), 1],
      ]),
    );
    await waitFor(() => expect(row("EngineSpeed")).toBeInTheDocument());

    const before = persistCalls(api);
    fireEvent.contextMenu(row("EngineSpeed"));
    fireEvent.click(screen.getByRole("button", { name: "Sort area" }));

    expect(
      Array.from(document.querySelectorAll(".plot-signal-row")).map(
        (r) => r.querySelector(".plot-signal-name")?.textContent,
      ),
    ).toEqual(["LimitNominal", "EngineSpeed", "EngineTemp", "LimitEffective"]);
    // One persist for the whole reorder.
    expect(persistCalls(api) - before).toBe(1);
  });

  it("sorts a per-unit area's whole signal list, not one derived axis's slice", async () => {
    // One logical area, four signals, three units → three `PlotArea`
    // instances (ADR 0026). Invoking Sort from one derived axis's row
    // menu must still reorder the *parent's* full manual `signals`
    // list — not just the signals grouped onto that one derived axis.
    // Two of the four signals share a unit (A), so a "sort this axis's
    // slice only" implementation would produce the same *visual*
    // grouping for that pair; the persisted list is what actually
    // proves the whole area sorted, since it interleaves signals from
    // every unit rather than keeping each unit's block contiguous.
    const { api, setGeneratorIndexes } = renderPanel();
    await addToFocused(["EngineTemp", "LimitNominal", "EngineSpeed", "LimitEffective"]);
    await pickCombobox(screen.getByLabelText("y-axis mode"), "per-unit");
    expect(document.querySelectorAll(".plot-area").length).toBe(3);
    setGeneratorIndexes(
      new Map([
        [signalKey(null, 256, false, "LimitEffective"), 0],
        [signalKey(null, 256, false, "EngineTemp"), 1],
      ]),
    );
    await waitFor(() => expect(row("EngineSpeed")).toBeInTheDocument());

    const before = persistCalls(api);
    // Invoked from the unit-A axis (LimitNominal's row), which shows
    // neither LimitEffective nor EngineTemp — the two the answer must
    // still place ahead of it.
    fireEvent.contextMenu(row("LimitNominal"));
    fireEvent.click(screen.getByRole("button", { name: "Sort area" }));

    const calls = api.updateParameters.mock.calls as unknown as [Record<string, unknown>][];
    const persisted = (calls[calls.length - 1]?.[0] ?? {}) as {
      areas?: { signals: { signalName: string }[] }[];
    };
    // LimitEffective (idx 0) and EngineTemp (idx 1) lead; EngineSpeed
    // and LimitNominal tail, alphabetically — interleaved across units,
    // which only a whole-list sort produces.
    expect(persisted.areas?.[0].signals.map((s) => s.signalName)).toEqual([
      "LimitEffective",
      "EngineTemp",
      "EngineSpeed",
      "LimitNominal",
    ]);
    expect(persistCalls(api) - before).toBe(1);
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
      addFocusedSignal("EngineSpeed");
      fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
      fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
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
        const follow = followChip();
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

// The follow-live window's *width*. `followXWindow` is unit-tested with
// the window injected, so the edge these tests own is the one no unit
// can see: the panel feeds its own output back in. Every slide the panel
// makes goes through `applyXAll`, which records the applied window as
// the shared window — so a width read back out of that record is the
// panel honouring its own last slide, not the user.
describe("PlotPanel follow-live window width", () => {
  /// The `follow_window_ms` default, in seconds.
  const DEFAULT_WINDOW_S = 10;

  /// Width of the last x window the panel pushed into `inst`.
  function lastWidth(inst: FakeUPlotInst): number {
    const last = inst.xCalls[inst.xCalls.length - 1];
    if (!last) throw new Error("no x window was applied");
    return last.max - last.min;
  }

  /// A running panel with one signal, past its post-mount uPlot rebuild,
  /// with the capture starting `startExt` seconds long. `grow` moves the
  /// capture on: both halves of it, because a frame append moves the
  /// session frame count *and* the window's last timestamp, and the
  /// windowed source's descriptor memo keys on the count — a fixture
  /// that moved only the timestamp would leave the panel with no reason
  /// to make the round-trip that would show it.
  async function runningPanel(startExt: number): Promise<{
    inst: FakeUPlotInst;
    grow: (ext: number) => void;
  }> {
    mockSampleBounds.last = startExt;
    const panel = renderPanel();
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 400));
    let count = traceData.count;
    return {
      inst: liveInstanceIn("Area 1"),
      grow: (ext: number) => {
        mockSampleBounds.last = ext;
        panel.growTrace((count += 100));
      },
    };
  }

  it("grows to the default width instead of freezing at the width of its first slide", async () => {
    // THE REGRESSION. The first slide happens a few hundred ms after
    // connect, when the capture is far shorter than `follow_window_ms` —
    // so `followXWindow` takes its "capture shorter than the window"
    // branch and returns a sliver. `applyXAll` then records that sliver
    // as the shared window, and every later slide read it back as "the
    // width the user zoomed to". Measured in the app: a 0.02-0.1 s
    // window against a 10 s setting, for the whole session.
    await withSizedCanvas(async () => {
      const { inst, grow } = await runningPanel(0.4);
      // Several slides while the capture is still shorter than the
      // window — this is where the sliver used to get latched.
      await outsideAct(() => new Promise((r) => setTimeout(r, 300)));
      // The capture outgrows the window.
      grow(60);
      inst.xCalls.length = 0;
      await outsideAct(() => new Promise((r) => setTimeout(r, 500)));

      // The documented contract: with no width of their own, the window
      // grows until it is `follow_window_ms` wide, then slides.
      expect(lastWidth(inst)).toBeCloseTo(DEFAULT_WINDOW_S, 1);
    });
  });

  it("keeps a width the user zoomed to across later programmatic slides", async () => {
    // The other half of the same edge: the fix must not throw the user's
    // width away with the feedback. A real zoom sets it; the panel's own
    // slides must neither overwrite nor erase it.
    await withSizedCanvas(async () => {
      const { inst, grow } = await runningPanel(20);
      await outsideAct(() => new Promise((r) => setTimeout(r, 200)));
      // uPlot moves its own scale, then tells us — a user zoom to 3 s
      // wide, over the t=0 half, so follow-live survives it.
      inst.scales.x = { min: 4, max: 7 };
      await act(async () => {
        inst.fire("setScale", "x");
      });
      const follow = followChip();
      if (follow.getAttribute("aria-pressed") !== "true") fireEvent.click(follow);

      grow(80);
      inst.xCalls.length = 0;
      await outsideAct(() => new Promise((r) => setTimeout(r, 500)));

      expect(lastWidth(inst)).toBeCloseTo(3, 1);
    });
  });
});

// What follow-live does when the frames stop — a disconnect with the
// trace still running, which is the state the app leaves the panel in
// (nothing stops a trace on disconnect; the capture stays, it just
// stops growing). The unit tests own `advanceLiveEdge`'s arithmetic;
// what this describe owns is the panel's whole loop — fetch, report,
// clock, slide — because "the plot keeps scrolling" is a statement
// about the window the panel pushes into uPlot, not about the clock.
describe("PlotPanel follow-live after the frames stop", () => {
  /// Every x window the panel pushed into `inst` since it was last
  /// cleared, right edge only.
  const rightEdges = (inst: FakeUPlotInst) => inst.xCalls.map((c) => c.max);

  /// A running follow-live panel with one signal, past its post-mount
  /// uPlot rebuild, whose capture is `startExt` seconds long and then
  /// grows with real time until `stop()` — both halves of a frame
  /// append, the window's last timestamp *and* the session frame count,
  /// because the fetch key carries the count as "there are frames you
  /// have not seen" (`useDecimatedRange`). Growing only the timestamp
  /// would model a bus nobody can see, not a live one.
  async function growingPanel(startExt: number): Promise<{
    inst: FakeUPlotInst;
    stop: () => void;
  }> {
    mockSampleBounds.last = startExt;
    const panel = renderPanel();
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 400));
    const t0 = Date.now();
    let count = traceData.count;
    const timer = setInterval(() => {
      mockSampleBounds.last = startExt + (Date.now() - t0) / 1000;
      panel.growTrace((count += 10));
    }, 20);
    return { inst: liveInstanceIn("Area 1"), stop: () => clearInterval(timer) };
  }

  it("comes to rest on the last frame instead of sliding on past it", async () => {
    // THE REGRESSION. Disconnect leaves the trace running, so the
    // resample loop keeps ticking and keeps feeding the follow-live
    // clock the same live edge. The clock is allowed to *predict*
    // forward between data updates — that is what keeps the motion
    // smooth — and the ceiling on that prediction is what decides
    // where it stops once the data stops. Owner-reported symptom: the
    // plot panel keeps scrolling after disconnect.
    await withSizedCanvas(async () => {
      const { inst, stop } = await growingPanel(60);
      // A live capture, following its edge.
      await outsideAct(() => new Promise((r) => setTimeout(r, 400)));
      // Disconnect: the frames stop. This is the newest one there will
      // ever be — the trace stays running, so the loop keeps ticking.
      stop();
      const lastFrame = mockSampleBounds.last;

      // Give it longer than any prediction headroom to settle...
      await outsideAct(() => new Promise((r) => setTimeout(r, 500)));
      inst.xCalls.length = 0;
      // ...and then watch: a window that has come to rest pushes the
      // same right edge every tick.
      await outsideAct(() => new Promise((r) => setTimeout(r, 500)));
      const edges = rightEdges(inst);
      expect(edges.length).toBeGreaterThan(2);
      for (const e of edges) expect(e).toBeCloseTo(edges[0], 9);
      // And it rests *on* the data, not out in the blank strip past it.
      expect(edges[0]).toBeLessThanOrEqual(lastFrame + 0.05);
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
      addFocusedSignal("EngineSpeed");
      fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
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
    // The plot's fetch cadence is a `settings.json` field, not the
    // per-panel toolbar control that was removed. The
    // test above measures the default (67 ms, so >= 10 fetches in a
    // second); this one raises the interval and the round-trips have
    // to actually thin out. The redraw path is untouched — it stays on
    // rAF — so only the fetch count moves.
    await withSizedCanvas(async () => {
      mockSettings.plot_fetch_interval_ms = 300;
      await hydrateSettings();
      renderPanel();
      addFocusedSignal("EngineSpeed");
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
      const panel = renderPanel();
      addFocusedSignal("EngineSpeed");
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      // A capture that grows the way a frame append grows one: the
      // window's last timestamp *and* the session frame count. The count
      // is what the fetch key carries as "there are frames you have not
      // seen" (`useDecimatedRange`), so a fixture that moved only the
      // timestamp leaves every tick on the memo's unchanged fast path —
      // no `setData`, and so none of the synchronous render work this
      // test is pacing against.
      let count = traceData.count;
      const growing = setInterval(() => {
        mockSampleBounds.last += 0.05;
        panel.growTrace((count += 10));
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
      // A *stopped* panel, so the self-paced resample loop is off and
      // cannot land a tick between the baseline read and the click. Its
      // mount-time one-shots still can, though — see the quiet loop
      // below.
      const registry = makeRegistry({
        id: "el-memo",
        trace: { start: 0, end: 60, isPaused: false },
      });
      renderPanel({ params: { elementId: "el-memo" }, registry });
      addFocusedSignal("EngineSpeed");
      fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
      await act(async () => dropSignal("Area 2", "EngineSpeed", "rpm"));
      // Past every mount-time one-shot each area schedules: the
      // first-sample gate (`useFirstSampleWait`) and the once-per-area
      // post-mount uPlot rebuild, whose trailing `requestAnimationFrame`
      // re-sample is the one that used to land *after* the baseline read
      // and read as a fan-out. A fixed sleep cannot drain it — the
      // rebuild's commit only flushes when this `act` scope closes, so
      // the animation frame it schedules is still pending however long
      // the sleep was. Sleep past the timers, then flush until a flush
      // costs nothing, the way the per-area render-scoping tests below
      // do.
      await act(async () => {
        await new Promise((r) => setTimeout(r, FIRST_SAMPLE_INDICATOR_MS + 100));
      });
      for (let i = 0; i < 20; i++) {
        const settled = counter("render.PlotArea");
        await act(async () => {
          await new Promise((r) => setTimeout(r, 60));
        });
        if (counter("render.PlotArea") === settled) break;
      }

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

describe("PlotPanel area drag payload", () => {
  const sig = (signalName: string, unit = "V") => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "Pack",
    unit,
    color: "#112233",
  });

  it("drags the whole area: its config, its manual ranges, and a signal payload", () => {
    // One gesture, two payloads (ADR 0045). Another plot panel reads the
    // area; a panel that only knows signals reads the degraded half and
    // adds them.
    const registry = makeRegistry({
      id: "el-area-drag",
      config: {
        areas: [
          {
            id: "a1",
            signals: [sig("Cell1"), sig("Cell2")],
            patterns: ["Cell\d+"],
            yAxisMode: "per-unit",
            collapsed: true,
          },
          { id: "a2", signals: [sig("Other", "A")] },
        ],
        axisScales: { a1: { max: 10 }, "a1/u:unit:V": { min: 1 }, a2: { max: 99 } },
      },
    });
    renderPanel({ params: { elementId: "el-area-drag" }, registry });

    const dt = areaDragTransfer();
    fireEvent.dragStart(screen.getAllByLabelText("reorder plot area")[0], { dataTransfer: dt });

    const area = parsePlotAreaDragData(dt.getData(PLOT_AREA_DND_MIME));
    expect(area).not.toBeNull();
    expect(area!.sourcePanelId).toBe("el-area-drag");
    expect(area!.area.id).toBe("a1");
    expect(area!.area.signals.map((s) => s.signalName)).toEqual(["Cell1", "Cell2"]);
    expect(area!.area.patterns).toEqual(["Cell\d+"]);
    expect(area!.area.yAxisMode).toBe("per-unit");
    expect(area!.area.collapsed).toBe(true);
    // Only this area's ranges travel — not the neighbour's, and not the
    // layout weights.
    expect(area!.axisScales).toEqual({ a1: { max: 10 }, "a1/u:unit:V": { min: 1 } });

    const signals = parseSignalDragData(dt.getData(SIGNAL_DND_MIME));
    expect(signals.signals.map((s) => s.signalName)).toEqual(["Cell1", "Cell2"]);
    expect(signals.patterns).toEqual(["Cell\d+"]);
    expect(signals.sourcePanelId).toBe("el-area-drag");
  });

  it("drags a collapsed run's shared handle with the same payload", () => {
    const registry = makeRegistry({
      id: "el-area-drag-run",
      config: {
        areas: [
          { id: "a1", signals: [sig("Cell1")] },
          { id: "a2", collapsed: true, signals: [sig("Cell2")] },
        ],
        axisScales: { a2: { max: 4 } },
      },
    });
    renderPanel({ params: { elementId: "el-area-drag-run" }, registry });

    const dt = areaDragTransfer();
    fireEvent.dragStart(document.querySelector(".plot-area-collapsed-handle")!, {
      dataTransfer: dt,
    });
    const area = parsePlotAreaDragData(dt.getData(PLOT_AREA_DND_MIME));
    expect(area!.area.id).toBe("a2");
    expect(area!.area.collapsed).toBe(true);
    expect(area!.axisScales).toEqual({ a2: { max: 4 } });
  });

  it("never lands an area drag as a signal drop inside a plot panel", async () => {
    // The area drag carries signals too (the degradation payload), and a
    // signal row is a drop target of its own. Inside a plot panel the
    // gesture is an area gesture: dropping on a row must reorder areas,
    // not move that area's series into the row's area.
    const registry = makeRegistry({
      id: "el-area-drag-row",
      config: {
        areas: [
          { id: "a1", signals: [sig("Cell1")] },
          { id: "a2", signals: [sig("Cell2")] },
        ],
      },
    });
    renderPanel({ params: { elementId: "el-area-drag-row" }, registry });
    const stacked = () =>
      Array.from(document.querySelectorAll(".plot-area")).map((el) =>
        Array.from(el.querySelectorAll(".plot-signal-name")).map((n) => n.textContent),
      );
    expect(stacked()).toEqual([["Cell1"], ["Cell2"]]);

    const dt = areaDragTransfer();
    fireEvent.dragStart(screen.getAllByLabelText("reorder plot area")[1], { dataTransfer: dt });
    const row = document.querySelectorAll(".plot-area")[0].querySelector(".plot-signal-row")!;
    fireEvent.dragOver(row, { dataTransfer: dt });
    fireEvent.drop(row, { dataTransfer: dt });

    // Reordered, and no series changed hands.
    expect(stacked()).toEqual([["Cell2"], ["Cell1"]]);
  });
});

describe("PlotPanel area drag between panels", () => {
  const sig = (signalName: string, unit = "V") => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "Pack",
    unit,
    color: "#112233",
  });

  /// Two plot panels sharing one element registry — what a cross-panel
  /// drag needs. Each reads its own config off its dockview params (the
  /// panel falls back to them when the registry carries none) and gets
  /// its own `updateParameters` spy, so each panel's persisted state is
  /// observable on its own.
  function renderTwoPanels(a: Record<string, unknown>, b: Record<string, unknown>) {
    const apiA = { updateParameters: vi.fn() };
    const apiB = { updateParameters: vi.fn() };
    const registry = makeRegistry();
    const props = (params: Record<string, unknown>, api: { updateParameters: unknown }) =>
      ({ params, api }) as unknown as Parameters<typeof PlotPanel>[0];
    render(
      <TraceDataProvider value={traceData}>
        <ProjectContext.Provider value={projectCtx}>
          <SignalCatalogProvider>
            <ElementRegistryContext.Provider value={registry}>
              <div data-testid="panel-a">
                <PlotPanel {...props(a, apiA)} />
              </div>
              <div data-testid="panel-b">
                <PlotPanel {...props(b, apiB)} />
              </div>
            </ElementRegistryContext.Provider>
          </SignalCatalogProvider>
        </ProjectContext.Provider>
      </TraceDataProvider>,
    );
    return { apiA, apiB };
  }

  /// Each area of a panel, as the signal names it lists — the stack's
  /// contents, in order. A *collapsed* area is one heading row with no
  /// signal rows to read, so it shows as its count chip instead; the
  /// per-area identity assertions ride on `lastPersist` either way.
  const stackOf = (panel: string) =>
    Array.from(screen.getByTestId(panel).querySelectorAll(".plot-area")).map((el) => {
      const names = Array.from(el.querySelectorAll(".plot-signal-name")).map((n) => n.textContent);
      if (names.length > 0) return names;
      const chip = el.querySelector(".plot-area-count-chip");
      return chip ? [chip.textContent] : names;
    });

  const lastPersist = (api: { updateParameters: { mock: { calls: unknown[][] } } }) => {
    const calls = api.updateParameters.mock.calls;
    return (calls[calls.length - 1]?.[0] ?? {}) as {
      areas?: { id: string; collapsed?: boolean; patterns?: string[]; yAxisMode?: string; primarySignalKey?: string | null }[];
      axisScales?: Record<string, unknown>;
    };
  };

  /// The whole gesture: grab `from`'s grip number `grip`, release it on
  /// area number `onArea` of panel `to`.
  function dragAreaBetween(
    from: string,
    grip: number,
    to: string,
    onArea: number,
    opts?: { ctrlKey?: boolean; cancel?: boolean },
  ) {
    const dt = areaDragTransfer();
    const handle = within(screen.getByTestId(from)).getAllByLabelText("reorder plot area")[grip];
    fireEvent.dragStart(handle, { dataTransfer: dt });
    if (opts?.cancel) {
      fireEvent.dragEnd(handle, { dataTransfer: dt });
      return;
    }
    const target = screen.getByTestId(to).querySelectorAll(".plot-area")[onArea];
    fireEvent.dragOver(target, { dataTransfer: dt });
    dropWithCtrl(target, dt, opts?.ctrlKey ?? false);
  }

  const SOURCE = {
    elementId: "el-src",
    areas: [
      {
        id: "a1",
        signals: [sig("Cell1")],
        patterns: ["Cell\d+"],
        yAxisMode: "per-unit",
        primarySignalKey: "pk",
        collapsed: true,
      },
      { id: "a2", signals: [sig("Other", "A")] },
    ],
    axisScales: { a1: { max: 10 }, "a1/u:unit:V": { min: 1 }, a2: { max: 99 } },
  };
  const TARGET = { elementId: "el-dst", areas: [{ id: "b1", signals: [sig("Bee")] }] };

  it("moves an area to the drop position of another panel, ranges and all", () => {
    const { apiA, apiB } = renderTwoPanels(SOURCE, TARGET);
    expect(stackOf("panel-a")).toEqual([["1 signal"], ["Other"]]);
    expect(stackOf("panel-b")).toEqual([["Bee"]]);

    dragAreaBetween("panel-a", 0, "panel-b", 0);

    // Landed above the area it was dropped on; gone from the source.
    expect(stackOf("panel-b")).toEqual([["1 signal"], ["Bee"]]);
    expect(stackOf("panel-a")).toEqual([["Other"]]);

    const moved = lastPersist(apiB).areas![0];
    expect(moved.id).toBe("a1");
    expect(moved.patterns).toEqual(["Cell\d+"]);
    expect(moved.yAxisMode).toBe("per-unit");
    expect(moved.primarySignalKey).toBe("pk");
    expect(moved.collapsed).toBe(true);
    expect(screen.getByTestId("panel-b").querySelectorAll(".plot-area")[0]).toHaveClass("collapsed");
    // The manual ranges travelled under the same keys — the area id
    // moved with the area — and the layout weights did not travel.
    expect(lastPersist(apiB).axisScales).toEqual({ a1: { max: 10 }, "a1/u:unit:V": { min: 1 } });
    expect(lastPersist(apiB)).not.toHaveProperty("axisWeights.a1");
    // The source kept its own area's range and let the moved one go.
    expect(lastPersist(apiA).axisScales).toEqual({ a2: { max: 99 } });
    expect(lastPersist(apiA).areas!.map((a) => a.id)).toEqual(["a2"]);
  });

  it("copies instead of moving when Ctrl is held at the drop", () => {
    const { apiA, apiB } = renderTwoPanels(SOURCE, TARGET);
    dragAreaBetween("panel-a", 0, "panel-b", 0, { ctrlKey: true });

    // Both panels hold it now.
    expect(stackOf("panel-a")).toEqual([["1 signal"], ["Other"]]);
    expect(stackOf("panel-b")).toEqual([["1 signal"], ["Bee"]]);

    const copy = lastPersist(apiB).areas![0];
    expect(copy.id).not.toBe("a1");
    expect(copy.patterns).toEqual(["Cell\d+"]);
    expect(copy.collapsed).toBe(true);
    // The copy is its own area, so its ranges are re-keyed onto its id.
    expect(lastPersist(apiB).axisScales).toEqual({
      [copy.id]: { max: 10 },
      [`${copy.id}/u:unit:V`]: { min: 1 },
    });
    // The source is untouched, ranges included.
    expect(lastPersist(apiA).areas!.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(lastPersist(apiA).axisScales).toEqual({
      a1: { max: 10 },
      "a1/u:unit:V": { min: 1 },
      a2: { max: 99 },
    });
  });

  it("keeps a same-panel drop a reorder, Ctrl or no Ctrl", () => {
    const { apiA } = renderTwoPanels(SOURCE, TARGET);
    const dt = areaDragTransfer();
    const grips = within(screen.getByTestId("panel-a")).getAllByLabelText("reorder plot area");
    fireEvent.dragStart(grips[1], { dataTransfer: dt });
    const first = screen.getByTestId("panel-a").querySelectorAll(".plot-area")[0];
    fireEvent.dragOver(first, { dataTransfer: dt });
    fireEvent.drop(first, { dataTransfer: dt, ctrlKey: true });

    expect(stackOf("panel-a")).toEqual([["Other"], ["1 signal"]]);
    expect(lastPersist(apiA).areas!.map((a) => a.id)).toEqual(["a2", "a1"]);
  });

  it("leaves both panels alone when the drag is cancelled", () => {
    // Nothing is claimed until a plot panel takes the drop, which is
    // also why dropping the degraded signal payload on some other
    // receptive panel adds there without emptying the source.
    renderTwoPanels(SOURCE, TARGET);
    dragAreaBetween("panel-a", 0, "panel-b", 0, { cancel: true });
    expect(stackOf("panel-a")).toEqual([["1 signal"], ["Other"]]);
    expect(stackOf("panel-b")).toEqual([["Bee"]]);
  });

  it("leaves a fresh empty area behind when a panel gives up its last one", () => {
    const { apiA } = renderTwoPanels(
      { elementId: "el-solo-src", areas: [{ id: "a1", signals: [sig("Cell1")] }] },
      TARGET,
    );
    dragAreaBetween("panel-a", 0, "panel-b", 0);
    expect(stackOf("panel-b")).toEqual([["Cell1"], ["Bee"]]);
    // A plot panel always shows an area to drop into.
    expect(stackOf("panel-a")).toEqual([[]]);
    expect(lastPersist(apiA).areas!.map((a) => a.id)).not.toContain("a1");
  });

  it("offers the grip on a single area too — it is the move handle", () => {
    // Reorder needs a second area; moving to another panel does not.
    renderPanel();
    expect(screen.getAllByLabelText("reorder plot area").length).toBe(1);
  });
});

describe("PlotPanel per-area render scoping", () => {
  const counter = (k: string) => diagCounts().get(k) ?? 0;
  const sig = (signalName: string) => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "EngineData",
    unit: "V",
    color: "#4ecbff",
  });

  /// Three logical areas of two rows each, mounted together from a saved
  /// config on a *stopped* trace, and left alone until the mount's async
  /// work (value tables, settings hydration, the first-sample gate) has
  /// stopped re-rendering the stack — so a count taken afterwards
  /// measures the edit and only the edit.
  ///
  /// Deliberately *without* a sized canvas: with no uPlot instance an
  /// area's own fetch/redraw machinery is inert, so every render it does
  /// is one React handed it because a prop's identity moved. That is
  /// exactly what per-area scoping governs, and measuring it without the
  /// resample loop's renders on top makes the counts exact rather than
  /// bounded.
  async function threeAreas(elementId: string) {
    const registry = makeRegistry({
      id: elementId,
      config: {
        areas: [
          { id: "a1", signals: [sig("Alpha1"), sig("Alpha2")] },
          { id: "a2", signals: [sig("Beta1"), sig("Beta2")] },
          { id: "a3", signals: [sig("Gamma1"), sig("Gamma2")] },
        ],
      },
      trace: { start: 0, end: 60, isPaused: false },
    });
    const panel = renderPanel({ params: { elementId }, registry });
    expect(document.querySelectorAll(".plot-area").length).toBe(3);
    // Past the first-sample gate (`useFirstSampleWait`): with no canvas
    // nothing ever settles it, so each area's "building…" timer fires on
    // its own ~300 ms after mount — mount noise that lands in whatever
    // `act` window is open when it does, quiet-loop or measurement.
    await act(async () => {
      await new Promise((r) => setTimeout(r, FIRST_SAMPLE_INDICATOR_MS + 100));
    });
    for (let i = 0; i < 20; i++) {
      const settled = counter("render.PlotArea");
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      if (counter("render.PlotArea") === settled) break;
    }
    return panel;
  }

  /// The n-th stacked area (0-based).
  const areaAt = (i: number) => document.querySelectorAll(".plot-area")[i] as HTMLElement;
  /// A signal row by name, anywhere in the panel.
  const rowNamed = (name: string): HTMLElement => {
    const found = Array.from(document.querySelectorAll(".plot-signal-row")).find(
      (r) => r.querySelector(".plot-signal-name")?.textContent === name,
    );
    if (!found) throw new Error(`no signal row for ${name}`);
    return found as HTMLElement;
  };

  it("collapsing one area re-renders that area alone", async () => {
    // An `areas` edit rewrites one entry of the list; every other area's
    // derived config — and so the memoised `PlotArea` reading it — must
    // come through the edit untouched.
    await threeAreas("el-scope-collapse");
    const before = counter("render.PlotArea");
    await act(async () => {
      fireEvent.click(within(areaAt(1)).getByRole("button", { name: "collapse plot area" }));
    });
    expect(areaAt(1).classList.contains("collapsed")).toBe(true);
    expect(counter("render.PlotArea") - before).toBe(1);
  });

  it("hiding a row re-renders only its own area", async () => {
    await threeAreas("el-scope-hide");
    const before = counter("render.PlotArea");
    await act(async () => {
      fireEvent.click(within(areaAt(2)).getAllByTitle(/^hide this signal/)[0]);
    });
    expect(within(areaAt(2)).getByTitle(/^show this signal/)).toBeInTheDocument();
    expect(counter("render.PlotArea") - before).toBe(1);
  });

  it("promoting a row to primary re-renders only its own area", async () => {
    // A plain click both moves the selection and rewrites the parent
    // area's `primarySignalKey` — an `areas` edit, and the one the
    // selection guard above deliberately avoids by ctrl-clicking.
    await threeAreas("el-scope-primary");
    const before = counter("render.PlotArea");
    await act(async () => {
      fireEvent.click(rowNamed("Beta2"));
    });
    expect(rowNamed("Beta2").classList.contains("primary")).toBe(true);
    expect(counter("render.PlotArea") - before).toBe(1);
  });

  it("does not fan out through the registry when the panel re-renders after a persist", async () => {
    // Persisting the edit replaces the element registry's entries array,
    // and in the app that lands as a re-render of every panel. Nothing a
    // plot area is handed may be derived from the *array* — only from
    // the elements it actually reads (this panel's own config change
    // must not re-mint the signal catalog it scopes) — or the scoping
    // above is undone one render later.
    await threeAreas("el-scope-persist");
    await act(async () => {
      fireEvent.click(within(areaAt(1)).getByRole("button", { name: "collapse plot area" }));
    });
    const before = counter("render.PlotArea");
    // Purely panel-local, so this render's only new input is the entries
    // array the persist above replaced.
    await act(async () => {
      fireEvent.contextMenu(document.querySelector(".plot-panel-toolbar")!);
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(counter("render.PlotArea") - before).toBe(0);
  });
});

describe("PlotPanel signal set: membership vs order", () => {
  const counter = (k: string) => diagCounts().get(k) ?? 0;
  const sig = (signalName: string, unit: string) => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "EngineData",
    unit,
    color: "#4ecbff",
  });

  /// A stopped two-area panel whose first area holds two same-unit rows,
  /// settled past the post-mount rebuild and every async first fetch, so
  /// the counts below measure the gesture alone.
  async function settledPanel(elementId: string) {
    const registry = makeRegistry({
      id: elementId,
      config: {
        areas: [
          { id: "a1", signals: [sig("LimitNominal", "A"), sig("LimitEffective", "A")] },
          { id: "a2", signals: [sig("EngineSpeed", "rpm")] },
        ],
      },
      trace: { start: 0, end: 60, isPaused: false },
    });
    const panel = renderPanel({ params: { elementId }, registry });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    for (let i = 0; i < 20; i++) {
      const settled = sampleCalls() + counter("render.PlotArea");
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      if (sampleCalls() + counter("render.PlotArea") === settled) break;
    }
    return panel;
  }

  const rowNamed = (name: string): HTMLElement => {
    const found = Array.from(document.querySelectorAll(".plot-signal-row")).find(
      (r) => r.querySelector(".plot-signal-name")?.textContent === name,
    );
    if (!found) throw new Error(`no signal row for ${name}`);
    return found as HTMLElement;
  };
  /// Drag one row onto another inside the same panel — an internal move,
  /// which for two rows of one area is a reorder.
  function reorderRow(from: string, onto: string) {
    const dt = areaDragTransfer();
    fireEvent.dragStart(rowNamed(from), { dataTransfer: dt });
    fireEvent.dragOver(rowNamed(onto), { dataTransfer: dt });
    fireEvent.drop(rowNamed(onto), { dataTransfer: dt });
  }
  const namesIn = (areaLabel: string) =>
    Array.from(
      screen.getByText(areaLabel).closest(".plot-area")!.querySelectorAll(".plot-signal-name"),
    ).map((n) => n.textContent);

  it("repaints a reordered area from cache instead of refetching it", async () => {
    // Reordering an area's rows changes nothing about *which* samples it
    // holds, and the decimation cache is keyed by signal — so the uPlot
    // rebuild the new series order needs must repaint from that cache
    // rather than dropping it for a cold whole-window fetch (and the
    // "building…" gate that comes with one).
    await withSizedCanvas(async () => {
      await settledPanel("el-order-nofetch");
      const instance = liveInstanceIn("Area 1");
      const drawn = drawnPoints(instance);
      expect(drawn).toBeGreaterThan(0);
      const before = sampleCalls();
      expect(before).toBeGreaterThan(0);

      await act(async () => {
        reorderRow("LimitEffective", "LimitNominal");
        await new Promise((r) => setTimeout(r, 200));
      });

      expect(namesIn("Area 1")).toEqual(["LimitEffective", "LimitNominal"]);
      expect(sampleCalls()).toBe(before);
      // The series array is index-parallel with the signals, so the new
      // order does cost a fresh uPlot instance — that is the accepted
      // half of the trade — but it comes up already drawing the window
      // the old one had.
      const rebuilt = liveInstanceIn("Area 1");
      expect(rebuilt).not.toBe(instance);
      expect(drawnPoints(rebuilt)).toBe(drawn);
      expect(document.querySelector(".plot-area-building")).toBeNull();
    });
  });

  it("refetches when the signal set's membership changes", async () => {
    // The other direction of the same rule: a row joining the area is a
    // set the cache has never been anchored to, so it must fetch.
    await withSizedCanvas(async () => {
      await settledPanel("el-order-membership");
      const before = sampleCalls();

      await act(async () => {
        dropSignal("Area 1", "EngineTemp", "degC");
        await new Promise((r) => setTimeout(r, 200));
      });

      expect(namesIn("Area 1")).toContain("EngineTemp");
      expect(sampleCalls()).toBeGreaterThan(before);
    });
  });

  it("reordering rows inside one area re-renders only that area", async () => {
    // A reorder rewrites one area's `signals`; every other area holds
    // exactly what it held, panel-level value-table state included.
    await settledPanel("el-order-renders");
    // Past the first-sample gate, which never settles without a canvas.
    await act(async () => {
      await new Promise((r) => setTimeout(r, FIRST_SAMPLE_INDICATOR_MS + 100));
    });
    const before = counter("render.PlotArea");
    await act(async () => {
      reorderRow("LimitEffective", "LimitNominal");
    });
    expect(namesIn("Area 1")).toEqual(["LimitEffective", "LimitNominal"]);
    // The dragged area renders for the reorder and for dropping its own
    // drag-over state; the point is that the other area renders at all.
    expect(counter("render.PlotArea") - before).toBeLessThanOrEqual(2);
  });
});

describe("PlotPanel rehydration", () => {
  /// The panel over a registry that really applies patches, so a write
  /// from outside the panel reaches it the way the app's would.
  function renderLive(config: Record<string, unknown>) {
    const { Provider, control } = makeLiveRegistry([
      { kind: "plot", id: "p1", sources: ["*"], config } as unknown as ProjectElement,
    ]);
    const api = { updateParameters: vi.fn() };
    const props = { params: { elementId: "p1" }, api } as unknown as Parameters<
      typeof PlotPanel
    >[0];
    render(
      <TraceDataProvider value={traceData}>
        <ProjectContext.Provider value={projectCtx}>
          <SignalCatalogProvider>
            <Provider>
              <PlotPanel {...props} />
            </Provider>
          </SignalCatalogProvider>
        </ProjectContext.Provider>
      </TraceDataProvider>,
    );
    return { control, api };
  }

  const oneArea = [{ id: "a1", signals: [] }];
  const twoAreas = [
    { id: "a1", signals: [] },
    { id: "a2", signals: [] },
  ];

  it("repaints from an externally rewritten config", () => {
    const { control } = renderLive({ areas: oneArea, followLive: true, measEnabled: false });
    expect(document.querySelectorAll(".plot-area").length).toBe(1);
    expect(followChip()).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".plot-meas-strip")).toBeNull();
    act(() => {
      control.update("p1", {
        config: { areas: twoAreas, followLive: false, measEnabled: true },
      } as never);
    });
    expect(document.querySelectorAll(".plot-area").length).toBe(2);
    expect(followChip()).toHaveAttribute("aria-pressed", "false");
    // The rewritten config turns measurements on; the strip stays away
    // regardless, because it is suppressed until it is reworked.
    expect(document.querySelector(".plot-meas-strip")).toBeNull();
  });

  it("keeps the panel's own edit — a persist is not a resync trigger", () => {
    const { control } = renderLive({ areas: oneArea });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Add Plot Area" }));
    });
    expect(document.querySelectorAll(".plot-area").length).toBe(2);
    const cfg = (control.entries()[0].element as { config?: { areas?: unknown[] } }).config;
    expect(cfg?.areas?.length).toBe(2);
  });
});

/// Sparse series: what the plot draws when a signal has so few samples
/// that an ordinary line render says nothing.
describe("PlotPanel sparse series", () => {
  /// Every y value the newest instance in the area currently holds.
  const drawnValues = (areaLabel: string) =>
    ((liveInstanceIn(areaLabel).data as (number | null)[][])[1] ?? []);

  it("draws a one-sample series as a horizontal line", async () => {
    // One point is not a line, and a lone sample renders as nothing at
    // all with markers off. The value it holds is the whole series, so
    // it is held across the window.
    mockSampleSeries.EngineSpeed = { t: [1], v: [12] };
    await withSizedCanvas(async () => {
      renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => {
        const xs = (liveInstanceIn("Area 1").data as (number | null)[][])[0] ?? [];
        // Two ends to draw between…
        expect(xs.length).toBeGreaterThan(1);
        // …and the same value at every one of them (12 normalised by
        // the host extent 10..20).
        const ys = drawnValues("Area 1");
        expect(ys.length).toBe(xs.length);
        expect([...new Set(ys)]).toEqual([0.2]);
      });
    });
  });

  it("keeps markers on a sparse series in auto mode, however dense the axis", async () => {
    // The merged x axis is shared, so uPlot's density rule answers for
    // the *axis*, not the series: a handful-of-samples series plotted
    // beside a fast one loses its markers and reads as a bare line
    // through held values. Below the floor the samples are the
    // information, so they stay marked.
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [10, 20, 15] };
    mockSampleSeries.EngineTemp = {
      t: Array.from({ length: AUTO_POINT_MARKER_FLOOR + 40 }, (_, i) => i / 100),
      v: Array.from({ length: AUTO_POINT_MARKER_FLOOR + 40 }, () => 15),
    };
    await withSizedCanvas(async () => {
      renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
      addFocusedSignal("EngineTemp");
      await waitFor(() => expect(screen.getByText("EngineTemp")).toBeInTheDocument());
      await waitFor(() => {
        const inst = liveInstanceIn("Area 1");
        expect(((inst.data as (number | null)[][])[0] ?? []).length).toBeGreaterThan(1);
        const show = (i: number) =>
          (inst.series[i] as { points?: { show?: (...a: unknown[]) => boolean } }).points?.show?.(
            inst,
            i,
            0,
            5000,
          );
        // Three samples of its own → marked, even though uPlot's own
        // answer for this axis is "too dense".
        expect(show(1)).toBe(true);
        // Above the floor → uPlot's answer stands.
        expect(show(2)).toBe(false);
      });
    });
  });
});

/// A **file-backed** signal (`docs/CONTEXT.md`) on the plot: imported
/// from the capture file, carried by no message and decoded by no DBC.
/// The host keys its series by that provenance, so every query the plot
/// issues for it has to say so — a fetch that drops the flag names a
/// DBC identity nothing decodes and comes back empty.
describe("PlotPanel file-backed signals", () => {
  /// Drop a **file-backed** row onto the first area, exactly as the
  /// Database view's file branch does: no bus, the source signal channel
  /// group index in the message slot, and the provenance flag that keeps
  /// that number out of the message-id namespace.
  function dropFileSignal(signalName: string, unit: string) {
    const MIME = "application/x-cannet-plot-signal";
    const payload = JSON.stringify({
      busId: null,
      messageId: 7,
      extended: false,
      signalName,
      messageName: "Analog",
      unit,
      fileBacked: true,
    });
    const dt = { types: [MIME], getData: (t: string) => (t === MIME ? payload : ""), dropEffect: "" };
    const area = screen.getByText("Area 1").closest(".plot-area")!;
    fireEvent.dragOver(area, { dataTransfer: dt });
    fireEvent.drop(area, { dataTransfer: dt });
  }

  /// The `signals` list of the newest `sample_signals` round-trip.
  const lastSampleQuery = () => {
    const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "sample_signals");
    const args = calls[calls.length - 1]?.[1] as { signals?: Record<string, unknown>[] };
    return args?.signals ?? [];
  };
  /// …and of the newest `signal_min_max` one — the sidecar built from
  /// the same signal list on the same tick, so the two make a controlled
  /// pair over one render.
  const lastExtentQuery = () => {
    const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "signal_min_max");
    const args = calls[calls.length - 1]?.[1] as { signals?: Record<string, unknown>[] };
    return args?.signals ?? [];
  };

  it("samples one by its provenance, so its points draw", async () => {
    mockFileBackedSignals.add("AmbientTemp");
    mockSampleSeries.AmbientTemp = { t: [0, 1, 2], v: [10, 20, 15] };
    await withSizedCanvas(async () => {
      renderPanel();
      dropFileSignal("AmbientTemp", "degC");
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));

      // The window fetch carries the flag…
      expect(lastSampleQuery()).toEqual([
        expect.objectContaining({ signalName: "AmbientTemp", fileBacked: true }),
      ]);
      // …as the extent sidecar built from the same list already did.
      expect(lastExtentQuery()).toEqual([
        expect.objectContaining({ signalName: "AmbientTemp", fileBacked: true }),
      ]);
      // And therefore the series reaches the canvas.
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBe(3));
    });
  });

  /// A signals-only capture (e.g. an MDF whose channel groups are all
  /// recorded signals, no bus traffic): the session buffer holds zero
  /// frames, but the file-backed series exist and the session origin is
  /// anchored at their first sample. The plot must still fetch and draw
  /// them — a frame-count gate that reads "no frames" as "no data"
  /// silently blanks every signal the import just brought in.
  it("draws a file-backed signal when the capture holds no frames", async () => {
    mockFileBackedSignals.add("AcVoltage");
    mockSampleSeries.AcVoltage = { t: [0, 1, 2], v: [10, 20, 15] };
    await withSizedCanvas(async () => {
      renderPanel({ trace: { count: 0 } });
      dropFileSignal("AcVoltage", "V");
      await waitFor(() => expect(sampleCalls()).toBeGreaterThan(0));
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBe(3));
    });
  });
});

describe("PlotPanel DBC-set change", () => {
  const sig = (signalName: string, unit: string) => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "EngineData",
    unit,
    color: "#4ecbff",
  });

  /// A stopped panel with one signal on the plot, settled past the
  /// post-mount rebuild and every async first fetch — so a round-trip
  /// after this point was caused by the gesture under test and nothing
  /// else. Stopped is the case that matters: a live capture's `winEnd`
  /// moves every tick, which re-keys the fetch memo on its own.
  async function settledPanel() {
    const registry = makeRegistry({
      id: "el-dbc-change",
      config: { areas: [{ id: "a1", signals: [sig("EngineSpeed", "rpm")] }] },
      trace: { start: 0, end: 60, isPaused: false },
    });
    const panel = renderPanel({ params: { elementId: "el-dbc-change" }, registry });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    for (let i = 0; i < 20; i++) {
      const settled = sampleCalls();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      if (sampleCalls() === settled) break;
    }
    return panel;
  }

  it("refetches its window when the DBC set changes", async () => {
    // A DBC load re-decodes the capture: the same window over the same
    // signals is different numbers afterwards. The plot's fetch memo
    // asks "could this request return different bytes?" and answers
    // from the window and the slice alone — so on a *stopped* capture,
    // where neither moves, an unchanged request would freeze the plot
    // on the pre-load decode forever. The trace model's re-anchor epoch
    // is what every frontend-initiated DBC change already bumps
    // (`App.invalidateCache`), so the plot has to fold it into the
    // request the way every row-addressed trace window does.
    await withSizedCanvas(async () => {
      const panel = await settledPanel();
      const before = sampleCalls();
      expect(before).toBeGreaterThan(0);

      await act(async () => {
        panel.bumpEpoch();
        await new Promise((r) => setTimeout(r, 400));
      });
      expect(sampleCalls()).toBeGreaterThan(before);
    });
  });
});

describe("PlotPanel enum overlays after a DBC change", () => {
  it("relabels a lane that mounted before its DBCs were installed", async () => {
    // The owner's report, exactly: a project reopened under a newer
    // build had one enum lane render numeric until the
    // view was closed and reopened. The panel asks for its value tables
    // once per signal set; a panel that asked before the project's DBCs
    // were installed got "no table" and had nothing to make it ask
    // again. `dbc-changed` is that something (ADR 0053 §4).
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [0, 1, 2] };
    renderPanel();
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(screen.getByText("EngineSpeed")).toBeInTheDocument());
    await pickCombobox(screen.getByLabelText("y-axis mode"), "per-unit");
    // No table yet: the signal is numeric, so it lands on its unit axis.
    await waitFor(() => expect(document.querySelectorAll(".plot-area").length).toBe(1));
    const areaId = () =>
      document.querySelector(".plot-area")?.getAttribute("data-area-id") ?? "";
    await waitFor(() => expect(areaId()).not.toBe(""));
    expect(areaId().endsWith("/u:enum")).toBe(false);

    // The project's DBCs are installed (or the file was edited on disk):
    // the host now has a table for it.
    mockValueTables.EngineSpeed = [
      { raw: 0, label: "Idle" },
      { raw: 1, label: "Run" },
      { raw: 2, label: "Fault" },
    ];
    await act(async () => {
      announceDbcChange();
      await new Promise((r) => setTimeout(r, 400));
    });
    await waitFor(() => expect(areaId().endsWith("/u:enum")).toBe(true));
  });
});

describe("PlotPanel when the database behind a signal is unassigned", () => {
  /// The whole of what a `dbc-changed` does to a plot panel: the shared
  /// catalog / value-table fan-out (`dbcChanged.ts`) plus the trace
  /// model's re-anchor epoch, which `App.invalidateCache` bumps on the
  /// same carrier. The panel folds that epoch into its fetch descriptor,
  /// so without it a window whose bytes changed under an unchanged
  /// request would stay memoised.
  async function announceAssignmentChange(panel: { bumpEpoch: () => void }) {
    await act(async () => {
      announceDbcChange();
      panel.bumpEpoch();
      await new Promise((r) => setTimeout(r, 400));
    });
  }

  it("keeps the series configured, and any assigned database that provides it brings it back", async () => {
    // The guarantee that makes cache revival worth having (ADR 0047's
    // assignment amendment). Unassigning a
    // database parks its decoded samples; the plot series that named one
    // of its signals must stay configured and render nothing, so that
    // assigning a database again brings the view back whole instead of
    // leaving the user to rebuild the plot by hand.
    //
    // Both directions, and by *signal* rather than by file: a view
    // config names `bus | messageId : signalName` and carries no DBC
    // path (`signalKey`), so what restores it is any assigned database
    // that provides the signal — this test never tells the panel which
    // file is loaded, because the panel has no way to ask.
    mockSampleSeries.EngineSpeed = { t: [0, 1, 2], v: [10, 20, 15] };
    await withSizedCanvas(async () => {
      const panel = renderPanel();
      addFocusedSignal("EngineSpeed");
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBe(3));

      // The database is unassigned: it decodes nothing, so the host
      // stops listing the signal and stops answering for it.
      mockUnassignedSignals.add("EngineSpeed");
      await announceAssignmentChange(panel);
      // The configuration stands — the row is still on the panel…
      expect(screen.getByText("EngineSpeed")).toBeInTheDocument();
      // …and the lane is simply empty.
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBe(0));

      // A database providing that signal is assigned. The series was
      // never rebuilt by hand, so it comes back drawing on its own.
      mockUnassignedSignals.delete("EngineSpeed");
      await announceAssignmentChange(panel);
      await waitFor(() => expect(drawnPoints(liveInstanceIn("Area 1"))).toBe(3));
      expect(screen.getByText("EngineSpeed")).toBeInTheDocument();
    });
  });

  describe("view-signals push", () => {
    it("pushes its referenced signals on mount, and un-pushes on unmount", () => {
      renderPanel({ params: { elementId: "el-view-signals" } });
      expect(invoke).toHaveBeenCalledWith(
        "set_view_signals",
        expect.objectContaining({ viewId: "el-view-signals", signals: [] }),
      );

      dropSignal("Area 1", "EngineSpeed", "rpm");
      expect(invoke).toHaveBeenCalledWith(
        "set_view_signals",
        expect.objectContaining({
          viewId: "el-view-signals",
          signals: [
            {
              busId: null,
              messageId: 256,
              extended: false,
              signalName: "EngineSpeed",
              fileBacked: undefined,
              messageName: "EngineData",
              unit: "rpm",
            },
          ],
        }),
      );

      cleanup();
      expect(invoke).toHaveBeenCalledWith("remove_view_signals", { viewId: "el-view-signals" });
    });

    it("pushes what an area's pattern matches, identity-only", async () => {
      // A pattern-matched signal is one the view is using, so it
      // belongs in the panel that lists them. It pushes no messageName
      // or unit: those resolve live from the catalog, so there is
      // nothing recorded for a database change to have drifted from.
      const registry = makeRegistry({
        id: "el-pattern-push",
        config: { areas: [{ id: "a1", signals: [], patterns: ["EngineSpeed"] }] },
      });
      await withSizedCanvas(async () => {
        renderPanel({ params: { elementId: "el-pattern-push" }, registry });
        await waitFor(() =>
          expect(
            [...vi.mocked(invoke).mock.calls]
              .reverse()
              .find(
                (c) =>
                  c[0] === "set_view_signals" &&
                  (c[1] as { viewId?: string } | undefined)?.viewId === "el-pattern-push",
              )?.[1],
          ).toEqual(
            expect.objectContaining({
              signals: [
                { busId: null, messageId: 256, extended: false, signalName: "EngineSpeed" },
              ],
            }),
          ),
        );
      });
    });
  });
});

// The y gutter of a single-enum axis. Its three rows are one matrix:
// two enum tables of very different sizes and, as the control, the same
// axis with no value table at all. The control is what makes a reading
// here mean anything — if the enum rows printed what the numeric row
// prints, the probe would be measuring the harness rather than the axis.
//
// Owner's 0.9.0 report: enum labels appeared down the y axis, which
// blows the gutter out for long names and paints a tick per table row
// for a table with hundreds of them. The overlay already names the
// value at the point of interest, so the axis carries raw numbers only.
describe("single-enum y axis", () => {
  const ENUM3 = [
    { raw: 0, label: "Idle" },
    { raw: 1, label: "Run" },
    { raw: 2, label: "Fault" },
  ];
  /** A table big enough that a tick per row is visibly wrong, with
   * names long enough to blow out a gutter sized to hold them. */
  const ENUM300 = Array.from({ length: 300 }, (_, i) => ({
    raw: i,
    label: `LongishStateName_${i}`,
  }));

  /** uPlot only constructs against a real-sized canvas. */
  function stubSize() {
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    return () => {
      cw.mockRestore();
      ch.mockRestore();
    };
  }

  /** jsdom has no canvas 2d context, so the axis's own label
   * measurement short-circuits to a constant and the gutter stops
   * saying anything. Stand in a measurer (6 px a character) so the
   * width the axis *asks for* is observable. */
  function stubMeasure() {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind: string) {
      return kind === "2d"
        ? ({
            font: "",
            measureText: (t: string) => ({ width: t.length * 6 }),
          } as unknown as CanvasRenderingContext2D)
        : null;
    } as typeof HTMLCanvasElement.prototype.getContext;
    return () => {
      HTMLCanvasElement.prototype.getContext = orig;
    };
  }

  type YAxis = {
    splits?: (u: unknown, i: number, min: number, max: number, incr: number, space: number) => number[];
    values: (u: unknown, s: number[]) => string[];
    size: (u: unknown, v: string[] | null, i: number, c: number) => number;
  };

  /** Drop `signal` on the focused area as its own axis, and hand back
   * that axis's tick set, labels and requested gutter.
   *
   * `incr` stands in for the increment uPlot picks from the axis's
   * pixel height — the same argument real uPlot passes a `splits`
   * callback, and the only place tick density is decided. */
  async function enumAxis(
    signal: string,
    table: { raw: number; label: string }[] | null,
    incr: number,
    series: { t: number[]; v: number[] } = { t: [0, 1, 2], v: [0, 1, 2] },
  ) {
    if (table) mockValueTables[signal] = table;
    mockSampleSeries[signal] = series;
    renderPanel();
    addFocusedSignal(signal);
    await waitFor(() => expect(screen.getByText(signal)).toBeInTheDocument());
    await pickCombobox(screen.getByLabelText("y-axis mode"), "individual");
    const inst = await waitFor(() => {
      const i = uplotInstances[uplotInstances.length - 1] as unknown as {
        opts: { axes: YAxis[] };
      };
      // The value table resolves asynchronously and rebuilds the
      // instance; the enum axis is the one that installs `splits`.
      if (table) expect(typeof i.opts.axes[1].splits).toBe("function");
      return i;
    });
    const y = inst.opts.axes[1];
    const lo = table ? Math.min(...table.map((r) => r.raw)) - 0.5 : 0;
    const hi = table ? Math.max(...table.map((r) => r.raw)) + 0.5 : 1;
    const splits = y.splits ? y.splits(inst, 1, lo, hi, incr, 30) : null;
    const values = splits ? y.values(inst, splits) : null;
    return { inst, splits, values, gutter: y.size(inst, values, 1, 0) };
  }

  it("CONTROL: a signal with no value table leaves tick density to uPlot", async () => {
    const restore = stubSize();
    const unmeasure = stubMeasure();
    try {
      const { splits, gutter } = await enumAxis("EngineTemp", null, 0.25);
      // No `splits` override at all — uPlot's own density-aware splits
      // stand, which is what "capped and thinned" has to end up looking
      // like on the enum axis too.
      expect(splits).toBeNull();
      expect(gutter).toBe(52);
    } finally {
      unmeasure();
      restore();
    }
  });

  it("labels its ticks with the raw number alone — no enum text", async () => {
    const restore = stubSize();
    const unmeasure = stubMeasure();
    try {
      const { splits, values, gutter } = await enumAxis("EngineSpeed", ENUM3, 0.25);
      expect(splits).toEqual([0, 1, 2]);
      expect(values).toEqual(["0", "1", "2"]);
      // The gutter is measured from what is drawn, so a numeric tick
      // set sits at the same floor a numeric axis does — not the fixed
      // 80 px the labelled axis used to reserve.
      expect(gutter).toBe(52);
    } finally {
      unmeasure();
      restore();
    }
  });

  it("bounds its tick count for a table with hundreds of values", async () => {
    const restore = stubSize();
    const unmeasure = stubMeasure();
    try {
      // 25 is what uPlot's own increment search settles on for a
      // -0.5..299.5 scale at 400 px with its 30 px minimum spacing.
      const { splits, values, gutter } = await enumAxis("LimitNominal", ENUM300, 25);
      expect(splits!.length).toBeLessThanOrEqual(13);
      expect(splits!.length).toBeGreaterThan(1);
      // Every label a bare integer: no quotes, no name, whatever the
      // table calls the value.
      expect(values!.every((v) => /^\d+$/.test(v))).toBe(true);
      expect(gutter).toBe(52);
    } finally {
      unmeasure();
      restore();
    }
  });

  it("still names the held value in the overlay", async () => {
    const restore = stubSize();
    const unmeasure = stubMeasure();
    try {
      // The last code needs a run of its own to get a tile: a segment
      // that ends at the sample that opened it has no width.
      const { inst } = await enumAxis("EngineSpeed", ENUM3, 0.25, {
        t: [0, 0.5, 1, 2],
        v: [0, 1, 2, 2],
      });
      const drawn = inst as unknown as FakeUPlotInst;
      drawn.drawOps.length = 0;
      await act(async () => {
        drawn.fire("draw");
      });
      const texts = drawn.drawOps
        .filter((o) => o.op === "fillText")
        .map((o) => String((o.args as unknown[])[0]));
      // The axis lost the names; the tiles still carry them.
      expect(texts).toContain("Idle");
      expect(texts).toContain("Run");
      expect(texts).toContain("Fault");
    } finally {
      unmeasure();
      restore();
    }
  });
});

describe("plot legend with long names", () => {
  it("splits a long signal name and the message line beneath it", () => {
    renderPanel();
    dropSignal("Area 1", LONG_SIGNAL_NAME, "degC");
    dropSignal("Area 1", "TopSignal", "rpm");
    const rows = document.querySelectorAll(".plot-signal-row");
    expectMiddleEllipsis(
      rows[0].querySelector(".plot-signal-name"),
      LONG_SIGNAL_NAME,
      LONG_SIGNAL_TAIL,
    );
    // The message line carries the composed `bus · ecu · message`
    // label; this fixture's is short, so it stays one text node — the
    // same rule, applied to a different string.
    expect(rows[0].querySelector(".plot-signal-message .name-text")).toBeNull();
    // The control: the short signal beside it is still one text node.
    expect(rows[1].querySelector(".plot-signal-name .name-text")).toBeNull();
    expect(rows[1].querySelector(".plot-signal-name")!.textContent).toBe("TopSignal");
  });
});

describe("a plot area's axis label with a long name", () => {
  it("splits the signal name an individual axis is labelled with", async () => {
    // In `individual` mode the axis label *is* a signal name, so it
    // takes the same treatment as every other name surface.
    renderPanel();
    dropSignal("Area 1", LONG_SIGNAL_NAME, "degC");
    dropSignal("Area 1", "TopSignal", "rpm");
    await pickCombobox(screen.getByLabelText("y-axis mode"), "individual");
    const labels = document.querySelectorAll(".plot-area-axis-label");
    expectMiddleEllipsis(labels[0], LONG_SIGNAL_NAME, LONG_SIGNAL_TAIL);
    // The control: a short one stays a plain text node.
    expect(labels[1].querySelector(".name-text")).toBeNull();
    expect(labels[1].textContent).toBe("TopSignal");
  });
});

// The performance read-out is a diagnostic, and its numbers change
// width every tick beside controls that must not move — so it is off,
// and it lives with the other diagnostics on the toolbar's own
// right-click menu rather than taking a visible toggle.
describe("the plot toolbar's performance read-out", () => {
  const openToolbarMenu = () =>
    fireEvent.contextMenu(document.querySelector(".plot-panel-toolbar")!, {
      clientX: 10,
      clientY: 10,
    });
  const perfItem = () =>
    screen.getByRole("menuitemcheckbox", { name: /performance readout/i });

  it("is hidden by default, and the bar carries no toggle for it", () => {
    renderPanel();
    expect(document.querySelector(".plot-perf")).toBeNull();
    // Nothing on the bar itself offers to bring it back — the menu is
    // the only way in.
    const bar = document.querySelector(".plot-panel-toolbar")!;
    expect(bar.textContent).not.toMatch(/performance|dpr| Hz/i);
  });

  it("comes on from the toolbar's right-click menu, and goes off again", () => {
    renderPanel();
    openToolbarMenu();
    expect(perfItem()).toHaveAttribute("aria-checked", "false");
    fireEvent.click(perfItem());
    const perf = document.querySelector(".plot-perf");
    expect(perf).not.toBeNull();
    expect(perf!.textContent).toMatch(/dpr/);

    openToolbarMenu();
    expect(perfItem()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(perfItem());
    expect(document.querySelector(".plot-perf")).toBeNull();
  });
});

describe("PlotPanel authoring an event from the plot (ADR 0056)", () => {
  /// Shift+click in a plot area with signals selected creates an event
  /// whose subjects are those signals and whose time is the clicked x.
  /// The gesture is a modifier on the canvas, so it reads the same in
  /// every cursor mode — and with nothing selected it names nothing and
  /// leaves the click to whatever the mode already did.
  function notesCtx(addNote: ReturnType<typeof vi.fn>): NotesContextValue {
    return {
      notes: [],
      addNote,
      renameNote: () => {},
      recolorNote: () => {},
      describeNote: () => {},
      retagNote: () => {},
      removeNote: () => {},
      linkEvents: () => {},
      unlinkEvents: () => {},
      setNoteSubjects: () => {},
    };
  }

  const signalRow = (name: string): HTMLElement => {
    const found = Array.from(document.querySelectorAll(".plot-signal-row")).find(
      (r) => r.querySelector(".plot-signal-name")?.textContent === name,
    );
    if (!found) throw new Error(`no signal row for ${name}`);
    return found as HTMLElement;
  };

  /// Mount a panel in `cursorMode`, add `names` to its area and select
  /// them, then hand back the note dispatcher and the uPlot instance.
  async function setup(names: string[], cursorMode: string) {
    const addNote = vi.fn();
    renderPanel({
      params: { elementId: `el-auth-${cursorMode}-${names.join("+")}` },
      registry: makeRegistry({
        id: `el-auth-${cursorMode}-${names.join("+")}`,
        config: { areas: [{ id: "a1", signals: [] }], cursorMode },
      }),
      notes: notesCtx(addNote),
    });
    for (const n of names) {
      addFocusedSignal(n);
      await waitFor(() => expect(signalRow(n)).toBeInTheDocument());
    }
    names.forEach((n, i) => fireEvent.click(signalRow(n), i === 0 ? {} : { ctrlKey: true }));
    const inst = uplotInstances[uplotInstances.length - 1]!;
    await act(async () => inst.fire("ready"));
    return { addNote, inst };
  }

  const clickPlot = (inst: { over: Element }, init: Record<string, unknown>) => {
    fireEvent.mouseDown(inst.over, { button: 0, clientX: 150, clientY: 100, ...init });
    fireEvent.mouseUp(window, { button: 0, clientX: 150, clientY: 100, ...init });
  };

  let cw: ReturnType<typeof vi.spyOn>;
  let ch: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
  });
  afterEach(() => {
    cw.mockRestore();
    ch.mockRestore();
  });

  it("authors an event about the selected signals", async () => {
    const { addNote, inst } = await setup(["EngineSpeed", "EngineTemp"], "off");
    await waitFor(() => {
      clickPlot(inst, { shiftKey: true });
      expect(addNote).toHaveBeenCalled();
    });
    const note = addNote.mock.calls[addNote.mock.calls.length - 1]![0] as Note;
    expect(note.subjects).toEqual([
      { kind: "signal", messageId: 256, extended: false, signalName: "EngineSpeed" },
      { kind: "signal", messageId: 256, extended: false, signalName: "EngineTemp" },
    ]);
    expect(Number.isFinite(note.timestampNs)).toBe(true);
  });

  it("records nothing about the gesture that made it", async () => {
    // Provenance-agnostic (ADR 0056): the event is a note like any
    // other — same kind default, same label scheme, same wheel color.
    const { addNote, inst } = await setup(["EngineSpeed"], "off");
    await waitFor(() => {
      clickPlot(inst, { shiftKey: true });
      expect(addNote).toHaveBeenCalled();
    });
    const note = addNote.mock.calls[addNote.mock.calls.length - 1]![0] as Note;
    expect(Object.keys(note).sort()).toEqual(["color", "id", "label", "subjects", "timestampNs"]);
    expect(note.label).toBe("note 1");
    expect(note.color).toBe(wheelColor(0));
  });

  it("works in every cursor mode, being a modifier of its own", async () => {
    for (const mode of ["x", "y", "note"]) {
      cleanup();
      const { addNote, inst } = await setup(["EngineSpeed"], mode);
      await waitFor(() => {
        clickPlot(inst, { shiftKey: true });
        expect(addNote).toHaveBeenCalled();
      });
      const note = addNote.mock.calls[addNote.mock.calls.length - 1]![0] as Note;
      expect(note.subjects).toHaveLength(1);
    }
  });

  it("names nothing and stays out of the way when no signal is selected", async () => {
    // Nothing selected: Shift+click in `off` mode does what it always
    // did, which is nothing at all.
    const addNote = vi.fn();
    renderPanel({
      params: { elementId: "el-auth-none" },
      registry: makeRegistry({
        id: "el-auth-none",
        config: { areas: [{ id: "a1", signals: [] }], cursorMode: "off" },
      }),
      notes: notesCtx(addNote),
    });
    addFocusedSignal("EngineSpeed");
    await waitFor(() => expect(signalRow("EngineSpeed")).toBeInTheDocument());
    const inst = uplotInstances[uplotInstances.length - 1]!;
    await act(async () => inst.fire("ready"));
    clickPlot(inst, { shiftKey: true });
    await act(async () => {});
    expect(addNote).not.toHaveBeenCalled();
  });

  it("leaves the note cursor's own plain click subject-less", async () => {
    const { addNote, inst } = await setup(["EngineSpeed"], "note");
    await waitFor(() => {
      clickPlot(inst, {});
      expect(addNote).toHaveBeenCalled();
    });
    const note = addNote.mock.calls[addNote.mock.calls.length - 1]![0] as Note;
    expect(note.subjects).toEqual([]);
  });
});

describe("a note marker's label on the plot canvas", () => {
  /// A panel with one area and the given notes, drawn once, returning
  /// every string the draw hook painted. The recorder's `measureText` is
  /// a flat 6 px a character, so the 50-character budget is 300 px — and
  /// the fake plot box is 600 px wide, wide enough not to clamp it.
  async function markerTexts(
    notes: { id: string; label: string }[],
    plotWidth?: number,
  ): Promise<string[]> {
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      renderPanel({
        params: { elementId: "el-marker-label" },
        registry: makeRegistry({
          id: "el-marker-label",
          // A signal, not an empty area: notes only render once an area
          // has reported an x-axis origin from a non-empty fetch.
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
                    color: "#4ecbff",
                  },
                ],
              },
            ],
          },
        }),
        notes: {
          notes: notes.map((n) => ({ ...n, timestampNs: 1_000_000_000 })),
          addNote: () => {},
          renameNote: () => {},
          recolorNote: () => {},
          describeNote: () => {},
          retagNote: () => {},
          removeNote: () => {},
          linkEvents: () => {},
          unlinkEvents: () => {},
          setNoteSubjects: () => {},
        },
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      const inst = uplotInstances[uplotInstances.length - 1] as FakeUPlotInst & {
        bbox: { width: number };
      };
      // The draw hook measures against the plot box, which the fake
      // holds at a constant — so a narrower plot is set here, not
      // through `clientWidth`.
      if (plotWidth !== undefined) inst.bbox.width = plotWidth;
      inst.drawOps.length = 0;
      await act(async () => {
        inst.fire("draw");
      });
      return inst.drawOps
        .filter((o) => o.op === "fillText")
        .map((o) => String((o.args as unknown[])[0]));
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
  }

  it("draws a short label on one line, unchanged", async () => {
    const texts = await markerTexts([{ id: "n1", label: "brake on" }]);
    expect(texts).toContain("brake on");
  });

  it("leaves a label inside the character budget on one line", async () => {
    // 42 characters, under the 50 a line holds — wrapping a label that
    // fits would be churn.
    const label = "brake pedal pressed while the pack was warm";
    const texts = await markerTexts([{ id: "n1", label }]);
    expect(texts).toContain(label);
  });

  it("wraps a long label rather than running it across the plot", async () => {
    // An event label is free text. Drawn as one chip it overruns the
    // area and covers its neighbours' markers.
    const label =
      "brake pedal pressed hard while the pack was still warm and the contactor stayed shut the whole time";
    const texts = await markerTexts([{ id: "n1", label }]);
    expect(texts).not.toContain(label);
    // Wrapped at a space, each line inside the 50-character budget.
    expect(texts).toContain("brake pedal pressed hard while the pack was still");
    expect(texts).toContain("warm and the contactor stayed shut the whole time");
    expect(texts.every((t) => t.length <= 50)).toBe(true);
  });

  it("truncates once it runs out of lines, and says so", async () => {
    const label =
      "brake pedal pressed hard while the pack was still warm and the contactor had not yet opened again so the fault latched until the next key cycle";
    const texts = await markerTexts([{ id: "n1", label }]);
    expect(texts).toContain("brake pedal pressed hard while the pack was still");
    // Two lines is the cap, so the second says it continues — and the
    // ellipsis is inside the budget, not hung off the end of it.
    const second = texts.find((t) => t.endsWith("…"));
    expect(second).toBe("warm and the contactor had not yet opened again s…");
    expect(second!.length).toBeLessThanOrEqual(50);
    // Nothing past the cap reached the canvas.
    expect(texts.some((t) => t.includes("key cycle"))).toBe(false);
  });

  it("still fits a narrow plot, whatever the character budget says", async () => {
    // The budget is a cap on the label, not a claim about the area: a
    // plot narrower than 60 characters wraps at the plot instead.
    const label = "brake pedal pressed hard while the pack was still warm";
    const texts = await markerTexts([{ id: "n1", label }], 200);
    expect(texts).toContain("brake pedal pressed hard while");
    expect(texts).toContain("the pack was still warm");
  });
});

describe("where the A/B cursors put their timestamps", () => {
  const sig = (signalName: string, unit: string) => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "EngineData",
    unit,
    color: "#4ecbff",
  });

  /// Every string each stacked area's draw hook painted, top to bottom,
  /// with a pair of x cursors already placed.
  async function textsPerArea(areas: unknown[]): Promise<string[][]> {
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      renderPanel({
        params: { elementId: "el-ab-label" },
        registry: makeRegistry({
          id: "el-ab-label",
          config: { areas, cursorX: { a: 0.5, b: 1.5 } },
        }),
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      const all = uplotInstances as FakeUPlotInst[];
      const live: FakeUPlotInst[] = [];
      for (let i = all.length - 1; i >= 0; i--) {
        const area = all[i].root.closest(".plot-area");
        if (area === null || area.classList.contains("collapsed")) continue;
        if (!live.some((l) => l.root === all[i].root)) live.unshift(all[i]);
      }
      for (const u of live) u.drawOps.length = 0;
      await act(async () => {
        for (const u of live) u.fire("draw");
      });
      return live.map((u) =>
        u.drawOps.filter((o) => o.op === "fillText").map((o) => String((o.args as unknown[])[0])),
      );
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
  }

  const abLabels = (texts: string[]) => texts.filter((t) => /^[AB] /.test(t));

  it("labels the pair once, on the bottom area", async () => {
    // One x is one time however many areas it crosses. The lines cross
    // all of them — that is what lines a reading in one area up with a
    // reading in another — but the timestamp is said once, beside the
    // x-axis time label and the delta chip.
    const perArea = await textsPerArea([
      { id: "a1", signals: [sig("EngineSpeed", "rpm")] },
      { id: "a2", signals: [sig("EngineTemp", "degC")] },
    ]);
    expect(perArea).toHaveLength(2);
    expect(abLabels(perArea[0])).toEqual([]);
    expect(abLabels(perArea[1])).toHaveLength(2);
  });

  it("still labels them on a single-area panel", async () => {
    const perArea = await textsPerArea([{ id: "a1", signals: [sig("EngineSpeed", "rpm")] }]);
    expect(abLabels(perArea[0])).toHaveLength(2);
  });

  it("moves the labels up when the bottom area is collapsed", async () => {
    // Same rule as the x-axis time label: the bottom *drawing* axis
    // carries it, and a collapsed area draws nothing.
    const perArea = await textsPerArea([
      { id: "a1", signals: [sig("EngineSpeed", "rpm")] },
      { id: "a2", collapsed: true, signals: [sig("EngineTemp", "degC")] },
    ]);
    expect(perArea).toHaveLength(1);
    expect(abLabels(perArea[0])).toHaveLength(2);
  });
});

describe("where the event marker labels sit", () => {
  const sig = (signalName: string, unit: string) => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "EngineData",
    unit,
    color: "#4ecbff",
  });

  /// Every string each drawing area painted, top to bottom, with one
  /// note on the timeline.
  async function textsPerArea(areas: unknown[]): Promise<string[][]> {
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      renderPanel({
        params: { elementId: "el-marker-top" },
        registry: makeRegistry({ id: "el-marker-top", config: { areas } }),
        notes: {
          notes: [{ id: "n1", timestampNs: 1_000_000_000, label: "brake on" }],
          addNote: () => {},
          renameNote: () => {},
          recolorNote: () => {},
          describeNote: () => {},
          retagNote: () => {},
          removeNote: () => {},
          linkEvents: () => {},
          unlinkEvents: () => {},
          setNoteSubjects: () => {},
        },
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      const all = uplotInstances as FakeUPlotInst[];
      const live: FakeUPlotInst[] = [];
      for (let i = all.length - 1; i >= 0; i--) {
        const area = all[i].root.closest(".plot-area");
        if (area === null || area.classList.contains("collapsed")) continue;
        if (!live.some((l) => l.root === all[i].root)) live.unshift(all[i]);
      }
      for (const u of live) u.drawOps.length = 0;
      await act(async () => {
        for (const u of live) u.fire("draw");
      });
      return live.map((u) =>
        u.drawOps.filter((o) => o.op === "fillText").map((o) => String((o.args as unknown[])[0])),
      );
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
  }

  it("labels the markers once, on the top area", async () => {
    const perArea = await textsPerArea([
      { id: "a1", signals: [sig("EngineSpeed", "rpm")] },
      { id: "a2", signals: [sig("EngineTemp", "degC")] },
    ]);
    expect(perArea).toHaveLength(2);
    expect(perArea[0]).toContain("brake on");
    expect(perArea[1]).not.toContain("brake on");
  });

  it("hands the labels to the next area when the top one is collapsed live", async () => {
    // The interactive path, which the config-driven test below cannot
    // reach: an area that was already drawing has to stop, and the one
    // under it has to start.
    //
    // Note what this does *not* prove. jsdom rebuilds the lower area's
    // uPlot on the collapse (the assertion that it is the same instance
    // fails), so the draw hook gets a fresh closure either way and this
    // stays green whether `isFirst` is read off the closure or off the
    // live ref. The ref read is the correct form regardless — every
    // other mutable draw input in this file goes through it, because
    // the hook is registered once per instance — but a browser that
    // does not rebuild is a case only the application can show.
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      renderPanel({
        params: { elementId: "el-marker-collapse" },
        registry: makeRegistry({
          id: "el-marker-collapse",
          config: {
            areas: [
              { id: "a1", signals: [sig("EngineSpeed", "rpm")] },
              { id: "a2", signals: [sig("EngineTemp", "degC")] },
            ],
          },
        }),
        notes: {
          notes: [{ id: "n1", timestampNs: 1_000_000_000, label: "brake on" }],
          addNote: () => {},
          renameNote: () => {},
          recolorNote: () => {},
          describeNote: () => {},
          retagNote: () => {},
          removeNote: () => {},
          linkEvents: () => {},
          unlinkEvents: () => {},
          setNoteSubjects: () => {},
        },
      });
      const settle = async () => {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 60));
        });
      };
      await settle();
      const live = () => {
        const all = uplotInstances as FakeUPlotInst[];
        const out: FakeUPlotInst[] = [];
        for (let i = all.length - 1; i >= 0; i--) {
          const area = all[i].root.closest(".plot-area");
          if (area === null || area.classList.contains("collapsed")) continue;
          if (!out.some((l) => l.root === all[i].root)) out.unshift(all[i]);
        }
        return out;
      };
      const drew = (u: FakeUPlotInst) => {
        u.drawOps.length = 0;
        u.fire("draw");
        return u.drawOps
          .filter((o) => o.op === "fillText")
          .map((o) => String((o.args as unknown[])[0]))
          .includes("brake on");
      };
      expect(live().map(drew)).toEqual([true, false]);

      fireEvent.click(screen.getAllByRole("button", { name: "collapse plot area" })[0]);
      await settle();
      const after = live();
      expect(after).toHaveLength(1);
      expect(drew(after[0])).toBe(true);
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
  });

  it("moves the labels down when the top area is collapsed", async () => {
    // Collapsing the topmost area used to take the marker labels with
    // it — a collapsed area is a heading row with no canvas to draw on.
    const perArea = await textsPerArea([
      { id: "a1", collapsed: true, signals: [sig("EngineSpeed", "rpm")] },
      { id: "a2", signals: [sig("EngineTemp", "degC")] },
    ]);
    expect(perArea).toHaveLength(1);
    expect(perArea[0]).toContain("brake on");
  });
});

describe("a highlight repaints the plot", () => {
  const sig = (signalName: string, unit: string) => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "EngineData",
    unit,
    color: "#4ecbff",
  });

  const NOTES = {
    notes: [
      { id: "n1", timestampNs: 1_000_000_000, label: "brake on" },
      { id: "n2", timestampNs: 1_500_000_000, label: "contactor open" },
    ],
    addNote: () => {},
    renameNote: () => {},
    recolorNote: () => {},
    describeNote: () => {},
    retagNote: () => {},
    removeNote: () => {},
    linkEvents: () => {},
    unlinkEvents: () => {},
    setNoteSubjects: () => {},
  };

  afterEach(() => {
    resetEventHighlight();
  });

  it("redraws when an event is selected, and again when it is dropped", async () => {
    // The highlight reaches the draw hook through a ref, so nothing
    // repaints unless the overlay effect depends on it. A live trace
    // hides that behind its ticks; a stopped one keeps the stale frame,
    // and the marker the reader just selected never comes forward.
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      renderPanel({
        params: { elementId: "el-lit-redraw" },
        registry: makeRegistry({
          id: "el-lit-redraw",
          config: { areas: [{ id: "a1", signals: [sig("EngineSpeed", "rpm")] }] },
        }),
        notes: NOTES,
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      const inst = uplotInstances[uplotInstances.length - 1] as FakeUPlotInst;
      const before = inst.redraws;

      await act(async () => {
        selectEvents(["n1"]);
      });
      expect(inst.redraws).toBeGreaterThan(before);

      const lit = inst.redraws;
      await act(async () => {
        selectEvents([]);
      });
      expect(inst.redraws).toBeGreaterThan(lit);
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
  });

  it("draws the lit marker's label last, over the quiet ones", async () => {
    // Fading the neighbours and then painting one of their chips over
    // the lit marker says two opposite things at once.
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      renderPanel({
        params: { elementId: "el-lit-order" },
        registry: makeRegistry({
          id: "el-lit-order",
          config: { areas: [{ id: "a1", signals: [sig("EngineSpeed", "rpm")] }] },
        }),
        notes: NOTES,
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      const inst = uplotInstances[uplotInstances.length - 1] as FakeUPlotInst;
      await act(async () => {
        selectEvents(["n1"]);
      });
      inst.drawOps.length = 0;
      await act(async () => {
        inst.fire("draw");
      });
      const texts = inst.drawOps
        .filter((o) => o.op === "fillText")
        .map((o) => String((o.args as unknown[])[0]));
      // Both labels drawn; the lit one last, so it is on top.
      expect(texts).toContain("brake on");
      expect(texts).toContain("contactor open");
      expect(texts.lastIndexOf("brake on")).toBeGreaterThan(texts.lastIndexOf("contactor open"));
    } finally {
      cw.mockRestore();
      ch.mockRestore();
    }
  });
});

describe("run state gates the self-paced resample loop", () => {
  const sig = (signalName: string, unit = "V") => ({
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "Pack",
    unit,
    color: "#112233",
  });
  const resamples = () => diagCounts().get("plotarea.resample") ?? 0;
  const slides = () => diagCounts().get("followwin.slide") ?? 0;
  const wait = (ms: number) => act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

  function mount(trace: TS) {
    renderPanel({
      params: { elementId: "el-run-state" },
      registry: makeRegistry({
        id: "el-run-state",
        config: { areas: [{ id: "a1", signals: [sig("EngineSpeed", "rpm")] }] },
        trace,
      }),
    });
  }

  it("a running trace keeps the loop sampling and sliding", async () => {
    // `plot_fetch_interval_ms` defaults to 67 ms, so a live area ticks
    // several times over the measured window.
    await withSizedCanvas(async () => {
      mount(freshTrace(0));
      await wait(300);
      const r0 = resamples();
      const s0 = slides();
      await wait(500);
      expect(resamples() - r0).toBeGreaterThan(0);
      expect(slides() - s0).toBeGreaterThan(0);
    });
  });

  it("a stopped trace costs no steady-state render work at all", async () => {
    await withSizedCanvas(async () => {
      mount({ start: 0, end: 60, isPaused: false });
      // A mount owes several one-shot re-samples (the build effect's
      // pair, the ~250 ms post-mount uPlot rebuild's pair behind it),
      // and jsdom delivers the animation-frame half of each late. Wait
      // for two consecutive quiet windows so what follows is the
      // steady state and not the tail of the mount.
      let quiet = 0;
      for (let i = 0; i < 16 && quiet < 2; i++) {
        const before = resamples();
        await wait(150);
        quiet = resamples() === before ? quiet + 1 : 0;
      }
      expect(quiet).toBe(2);

      const r0 = resamples();
      const s0 = slides();
      await wait(500);
      expect(resamples() - r0).toBe(0);
      expect(slides() - s0).toBe(0);
    });
  });
});
