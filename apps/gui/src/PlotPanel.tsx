import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { isEnumValueTable, type Bus } from "./types";
import { useTraceLive, useTraceModel } from "./traceData";
import { useProjectContext } from "./projectContext";
import { useSignalCatalog } from "./signalCatalogContext";
import { defaultBusColor } from "./busColor";
import { theme, useThemeName } from "./theme";
import { buildColorResolver } from "./colorMap";
import { useTrace } from "./trace";
import { TraceControls } from "./TraceControls";
import { useNotes } from "./notesContext";
import { TRUNCATION_EVENT_ID } from "./notes";
import { GOTO_EVENT, type GotoPayload } from "./gotoEvent";
import { mergeSeries } from "./plotData";
import { hostSettings, useSetting } from "./hostSettings";
import { fetchWindowExtent } from "./useDecimatedRange";
import { stableSignalColor, wheelColor } from "./palette";
import {
  SIGNALS_WIDTH_MAX,
  SIGNALS_WIDTH_MIN,
  areasFromParams,
  cursorModeFromRaw,
  fmtCount,
  measKeysFromRaw,
  newPlotArea,
  reorderAreas,
  signalRefKey,
  signalValueFormats,
  signalsWidthFromRaw,
  type AxisHandlers,
  type CursorMode,
  type NoteEvent,
  type PlotAreaConfig,
  type PlotAreaReports,
  type PlotPanelParams,
  type SignalRef,
  type XCursors,
  type XSync,
} from "./plotPanelConfig";
import {
  advanceLiveEdge,
  followXWindow,
  liveEdgeAt,
  type LiveEdge,
  type LiveEdgeTuning,
} from "./followWindow";
import { showPointsFromRaw, type ShowPointsMode } from "./plotPoints";
import { Combobox, type ComboboxOption } from "./Combobox";
import { formatElapsed, fracDigitsForSpan } from "./format";
import { usePanelCommands } from "./panelCommands";
import { SourcesMenuSection } from "./SourcesPicker";
import { useElementPanel, useElementSources } from "./useElementPanel";
import { useDismissableMenu } from "./useDismissableMenu";
import { busLookup } from "./traceColumns";
import {
  type MeasurementKey,
  type PanelHover,
  type Series,
  centerWindowOn,
  nextHover,
} from "./plotCursors";

/**
 * The signal-plotting panel — a software oscilloscope for
 * decoded CAN signals, in the spirit of vSignalyzer / CANape.
 *
 * It's backed by a **trace element** (`useTrace`), exactly like the
 * trace panels — a window over the host-side session buffer with
 * Start / Stop / Pause / Clear. It just renders signal *values* over
 * time instead of message rows: while running it follows the live
 * capture, Pause/Stop freeze the window (which also stops the
 * re-sampling), Clear re-anchors the window to "now".
 *
 * A plot panel owns a **stack of plot areas** (starts with one; "add
 * plot area" appends more) that flex to fill the panel and share one x
 * (time) axis — its extent is the longest plotted signal across all
 * areas. Each plot area is a uPlot canvas (time axis at the bottom)
 * plus a **side signal panel**: per signal a color swatch (click to
 * hide / show the line — the value keeps updating), name, and value (at
 * cursor A when one is placed, else at the mouse crosshair, else the
 * latest sample). The crosshair is panel-level like cursor A/B: one
 * shared x across the stack, drawn in every area, so hovering anywhere
 * reads out each series' value in *all* areas at that time. The value
 * carries a Δ(A − B) line under it once both X cursors are
 * placed; an "y: auto / min…max" control; and the H1/H2 Y-cursor
 * read-out when those are placed. Picking a `(message, signal)` from the
 * toolbar drops it into the focused area; **drag a signal row** to
 * re-order it within an area, onto another plot area, or onto another
 * plot panel (cross-panel = a copy; the source keeps it). A signal's
 * color is assigned on add and travels with it (re-ordering / moving
 * doesn't recolor). The areas themselves re-order by dragging the
 * grip in an area's side-panel heading onto another area, which drops
 * it at that area's position in the stack.
 *
 * Data: while running, each area re-samples on a self-paced loop at a
 * configurable rate (toolbar; decoupled from React re-renders; Pause/Stop
 * ends it). Each tick asks `sample_signals` for the *visible* x-range
 * (as absolute-seconds bounds) with `max_points` matched to canvas
 * width, and replaces the area's cache with the response
 * (memoised by fetch-key so paused / un-zoomed ticks skip the
 * round-trip). So a zoomed-in panel gets full-detail decimation over
 * the narrow slice it shows, a show-all panel gets the whole capture
 * window decimated host-side, and both stay bounded by canvas pixel
 * width. {@link mergeSeries} stitches the cached series onto one
 * timeline. Per-trace **auto-normalisation**
 * (each trace's values re-mapped to [0, 1] from its own min/max) lets
 * signals with very different natural ranges share the canvas; the
 * side panel shows the raw value. The toolbar shows the resulting
 * update rate.
 *
 * Interaction: drag-select or **wheel** zooms x on every area (and
 * leaves "follow live"); `shift`+wheel pans x; `⌘/ctrl`+wheel zooms y
 * on the hovered area (buried — y is usually set with the per-area
 * range control); "fit data" refits x to the capture's full extent,
 * asked of the host on the press (a window zoomed into history stops
 * re-sampling, so the extent it carries is the one it last drew);
 * **follow live** slides a fixed-width window so the right edge tracks
 * the live edge — the width is whatever you last zoomed/panned to (a
 * default until the capture is that long, then it slides).
 *
 * Cursors & measurements are off by default (toolbar). "X" cursors:
 * left-click = A, right-click = B (through every area); "Y": per-area
 * H1/H2; "+ note": drops an event note. "clear cursors" removes them.
 * The measurement strip's cell set is configurable: A, B, Δt, 1/Δt,
 * and per-trace value@A / value@B / Δ / min / max / mean over [A, B].
 * Event markers (the window-start "T0" plus notes) draw as vertical
 * lines; "+ note" drops one. Renaming, recoloring, removing, and
 * jumping to a note live in the dedicated events view (ADR 0035),
 * which broadcasts a "goto" this panel re-centres its x-window on.
 *
 * Persistable state (areas + signal→area assignment, y-ranges,
 * follow-live, cursor mode, measurement toggle/selection; cursor
 * positions best-effort — notes are session-scoped in the host) is
 * persisted on the element (so it survives closing and reopening the
 * panel within a session) and mirrored into the dockview panel `params`.
 * Pixel-level overlay drawing and the
 * canvas event wiring aren't unit-tested; the cursor/measurement maths
 * (`plotCursors.ts`) and the decimation (`signal_sampler`) are.
 *
 * Not built yet: per-*trace* y offset/gain & log
 * scale; enum/state signals; triggers; CSV/image export.
 */

/** Stable empty set for areas with no manual picks yet. */
const EMPTY_KEY_SET: ReadonlySet<string> = new Set();
/** Stable empty list for areas with no patterns — a fresh `[]` per render
 * would defeat `PlotArea`'s memo. */
const EMPTY_RESOLUTIONS: readonly PatternResolution[] = [];
const SHOW_POINTS_OPTIONS: ComboboxOption[] = [
  { value: "auto", label: "auto" },
  { value: "off", label: "off" },
  { value: "on", label: "on" },
];
const CURSOR_MODE_OPTIONS: ComboboxOption[] = [
  { value: "off", label: "off" },
  { value: "x", label: "X (A / B)" },
  { value: "y", label: "Y (H1 / H2)" },
  { value: "note", label: "+ note" },
];
/** How far the follow-live clock may fall behind the data edge before it
 * gives up nudging and resyncs hard (a stalled loop, a backgrounded
 * tab). Generous, because the nudge below closes ordinary errors on its
 * own — a hard resync is a visible jump, and at a 1.5 s zoom even a
 * few hundred ms of it is a chunk of the plot. */
const FOLLOW_MAX_LAG_SECONDS = 2;
/** How far behind the newest frame the follow-live window tracks, as a
 * multiple of the resample interval. The strip between the last fetch
 * and now has no data yet, so an edge sitting on the newest sample
 * leaves it blank and refills it each fetch — the leading edge drops
 * out. Trading a little latency for a window that is always full is the
 * right side of that deal for a scrolling view. */
const FOLLOW_TARGET_LAG_TICKS = 3;
/** Bounds on that lag: enough to cover a tick plus host latency, and
 * never so much that the view feels detached from the bus. */
const FOLLOW_TARGET_LAG_MIN_S = 0.3;
const FOLLOW_TARGET_LAG_MAX_S = 0.9;
/** Time constant for the follow-live clock's pull toward the data edge.
 * Short enough that the window never strands itself ahead of the data,
 * long enough to filter arrival jitter. Being a time constant rather
 * than a per-update fraction keeps the behaviour idempotent across the
 * per-area calls. */
const FOLLOW_EDGE_TAU_SECONDS = 0.25;
/** The follow-live target lag for a given plot fetch interval, within
 * the bounds above. */
function targetLagFor(fetchIntervalMs: number): number {
  return Math.min(
    FOLLOW_TARGET_LAG_MAX_S,
    Math.max(FOLLOW_TARGET_LAG_MIN_S, (FOLLOW_TARGET_LAG_TICKS * fetchIntervalMs) / 1000),
  );
}

// Pattern-selection helpers live in `./signalSelection` so the
// pure-logic tests can import them without dragging uplot into a jsdom run.
import {
  applyAreaSelections,
  effectiveSourceBuses,
  resolvePatterns,
  scopeCatalog,
  type PatternResolution,
} from "./signalSelection";
import {
  GUTTER_HYSTERESIS_PX,
  createGutterCoordinator,
  deriveAxesForArea,
  retainedAxisIds,
  type GutterCoordinator,
  type YAxisMode,
} from "./plotAxisDerivation";
import {
  axisScalesFromRaw,
  pruneAxisScales,
  setAxisScale,
  type AxisScales,
} from "./plotAxisScale";
import { messageEcuLookup } from "./plotSignalLabel";
import { useValueTables } from "./useValueTables";
import {
  type AxisWeights,
  applySplitterDelta,
  axisWeightsFromRaw,
  collapsedRunHeads,
  equalizePair,
  pruneAxisWeights,
  resolveAxisWeights,
  splitterPartnerAbove,
} from "./plotAreaLayout";
import {
  NO_PLOT_SIGNAL_SELECTION,
  selectPlotSignal,
  type PlotSignalSelection,
} from "./plotAreaSelection";
import {
  SOLO_OFF,
  soloFromRaw,
  soloMaskSignals,
  soloMatches,
  soloPatternInvalid,
  soloRegex,
  soloToParams,
  soloVisibleKeys,
  type SoloState,
} from "./plotSolo";
import { setSignalDragData } from "./dragSignals";
import { diagCount, diagGauge } from "./diag"; // DIAG
import { usePlotBadge } from "./usePlotBadge";
import { PlotArea } from "./PlotArea";
import { MeasurementMenu, PlotMeasurementStrip, type PlottedSignal } from "./PlotMeasurements";


export function PlotPanel(props: IDockviewPanelProps) {
  diagCount("render.PlotPanel"); // DIAG
  const model = useTraceModel();
  const capture = useTraceLive();
  const { buses } = useProjectContext();
  const { elementId, registry, element, savedConfig, persist } = useElementPanel<PlotPanelParams>(
    props,
    "plot",
  );
  const { currentSources, availableFilters, handleSourcesChange } = useElementSources(
    registry,
    elementId,
    element,
  );
  // `false`: the plot reads the window bounds and run state, never a
  // frame row — so it does not page one (ADR 0025).
  const trace = useTrace(elementId, false);
  const live = trace.status === "running";
  const winStart = trace.offset;
  const winEnd = trace.offset + trace.frameCount;

  const [areas, setAreas] = useState<PlotAreaConfig[]>(() => areasFromParams(savedConfig?.areas));
  const [followLive, setFollowLive] = useState(() =>
    typeof savedConfig?.followLive === "boolean" ? savedConfig.followLive : true,
  );
  const [cursorMode, setCursorMode] = useState<CursorMode>(() => cursorModeFromRaw(savedConfig?.cursorMode));
  const [measEnabled, setMeasEnabled] = useState(() =>
    typeof savedConfig?.measEnabled === "boolean" ? savedConfig.measEnabled : false,
  );
  const [measKeys, setMeasKeys] = useState<MeasurementKey[]>(() => measKeysFromRaw(savedConfig?.measKeys));
  /** Show the per-row y / t-range diagnostic readout under each
   * signal's value. Off by default — useful for development and for
   * users debugging cache / auto-norm issues, but visually noisy in
   * normal use. Persisted in panel params. */
  const [showDiag, setShowDiag] = useState(() =>
    typeof savedConfig?.showDiag === "boolean" ? savedConfig.showDiag : false,
  );
  const [showPoints, setShowPoints] = useState<ShowPointsMode>(() => showPointsFromRaw(savedConfig?.showPoints));
  /** Pixel width of every area's side panel — user-resizable via a
   * drag handle, persisted in panel config. */
  const [signalsWidth, setSignalsWidth] = useState(() => signalsWidthFromRaw(savedConfig?.signalsWidthPx));
  /** Per-derived-axis vertical weights (flex-grow), keyed by axis id.
   * Persisted in panel config; pruned to the live axis set below and
   * resolved (defaults filled) at render (ADR 0026). */
  const [axisWeights, setAxisWeights] = useState<AxisWeights>(() =>
    axisWeightsFromRaw(savedConfig?.axisWeights),
  );
  /** Per-derived-axis manual y range + log flag (ADR 0026), keyed by
   * axis id. Persisted sparsely — an entry only where the user
   * overrode a default — and retired when the signals that give an
   * axis its identity leave the plot (`retainedAxisIds`). */
  const [axisScales, setAxisScales] = useState<AxisScales>(() =>
    axisScalesFromRaw(savedConfig?.axisScales),
  );
  /** Solo (`plotSolo.ts`): a panel-wide regex over the series display
   * names, masking everything it doesn't match out of the *view*. It
   * never rewrites a series' persisted `hidden` flag — clearing solo
   * restores exactly the visibility the user had. Persisted with the
   * panel config like the other view params, sparsely (absent = off). */
  const [solo, setSolo] = useState<SoloState>(() => soloFromRaw(savedConfig?.solo));
  const [focusedAreaId, setFocusedAreaId] = useState<string>(() => areas[0]?.id ?? "");
  /** The signal rows the user has selected, in one logical area
   * (`plotAreaSelection.ts`). Transient view state — deliberately not in
   * `savedConfig`, so it neither persists nor marks the project dirty. */
  const [signalSelection, setSignalSelection] = useState<PlotSignalSelection>(
    NO_PLOT_SIGNAL_SELECTION,
  );
  const { catalog, refresh: refreshCatalog } = useSignalCatalog();

  const [cursorX, setCursorX] = useState<XCursors>(() => {
    const o = savedConfig?.cursorX as { a?: unknown; b?: unknown } | undefined;
    return { a: typeof o?.a === "number" ? o.a : null, b: typeof o?.b === "number" ? o.b : null };
  });
  const [cursorYByArea, setCursorYByArea] = useState<Record<string, { h1: number | null; h2: number | null }>>(
    () => {
      const o = savedConfig?.cursorYByArea;
      const out: Record<string, { h1: number | null; h2: number | null }> = {};
      if (typeof o === "object" && o !== null) {
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          if (typeof v === "object" && v !== null) {
            const vv = v as Record<string, unknown>;
            out[k] = { h1: typeof vv.h1 === "number" ? vv.h1 : null, h2: typeof vv.h2 === "number" ? vv.h2 : null };
          }
        }
      }
      return out;
    },
  );
  // Notes live in the session-scoped host store. The
  // panel reads `notes` through `useNotes()` (absolute trace ns)
  // and converts to/from display-relative seconds against
  // `baseSeconds` (the panel's x-axis origin in absolute seconds,
  // reported up from each area's windowed source via `reports.base`).
  // Edits go through the same context's
  // dispatchers, which forward to the host's `add_note` /
  // `rename_note` / `remove_note` Tauri commands — the
  // `notes-changed` event broadcasts the new list to every plot
  // panel.
  const { notes: sessionNotes, addNote: dispatchAddNote } = useNotes();

  // Per-area last-sampled series (only kept while the measurement strip
  // is on — it's the only consumer; the side-panel values come from the
  // area's own ref) and a perf read-out.
  const [seriesByArea, setSeriesByArea] = useState<Map<string, Map<string, Series>>>(new Map());
  /** Per-area count of frames in the trace's current window, max
   * across areas — a quick read of "is the trace actually windowing
   * frames?" (`0` ⇒ stopped / zero-width). */
  const winFrames = winEnd - winStart;
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  const badge = usePlotBadge();

  // Shared x-window + the per-area uPlot registry + the per-area data
  // extent (longest plotted signal across the panel) and window-start
  // (session-relative time of each area's first frame — the x-window's
  // floor, ADR 0024).
  const xSyncRef = useRef<XSync>({ suppress: false, xMin: null, xMax: null });
  const instancesRef = useRef<Map<string, uPlot>>(new Map());
  const extentByAreaRef = useRef<Map<string, number>>(new Map());
  const startByAreaRef = useRef<Map<string, number>>(new Map());

  /// One y-gutter for the whole stack, so every axis's plot box starts
  /// at the same x and the shared cursors / gridlines / enum tiles are
  /// collinear down the panel (`plotAxisDerivation.ts`).
  const gutterBroadcastRef = useRef(false);
  const gutterRef = useRef<GutterCoordinator | null>(null);
  if (gutterRef.current == null) {
    gutterRef.current = createGutterCoordinator(GUTTER_HYSTERESIS_PX, () => {
      // We're inside the reporting axis's own layout pass; the others
      // pick the new width up on their next one, which for a stopped
      // trace may never come. Nudge them — but after we're out of
      // uPlot's layout, and only once per change. The nudged axes
      // re-report the same needs, so this doesn't recur.
      if (gutterBroadcastRef.current) return;
      gutterBroadcastRef.current = true;
      queueMicrotask(() => {
        gutterBroadcastRef.current = false;
        for (const u of instancesRef.current.values()) u.redraw(false, true);
      });
    });
  }
  const reportGutterNeed = useCallback(
    (areaId: string, needed: number) => gutterRef.current!.report(areaId, needed),
    [],
  );

  const registerInstance = useCallback((id: string, u: uPlot | null) => {
    if (u) {
      instancesRef.current.set(id, u);
      const { xMin, xMax, suppress } = xSyncRef.current;
      if (xMin != null && xMax != null) {
        xSyncRef.current.suppress = true;
        u.setScale("x", { min: xMin, max: xMax });
        xSyncRef.current.suppress = suppress;
      }
    } else {
      instancesRef.current.delete(id);
      extentByAreaRef.current.delete(id);
      startByAreaRef.current.delete(id);
      // A destroyed axis stops reporting, so its need must not keep
      // holding the panel's gutter wide.
      gutterRef.current?.forget(id);
    }
  }, []);

  /// A live plot's own interaction surface, for an axis that has none.
  /// A collapsed axis renders no canvas — so uPlot never constructs
  /// there and its row is a hole in the panel's pointer surface: the
  /// wheel does nothing and the shared crosshair blanks out as the
  /// pointer crosses it. Every axis shares one x window and one canvas
  /// column, so replaying the gesture here is the gesture the user
  /// would have made a few pixels higher. `null` while no axis has a
  /// uPlot yet.
  const plotSurface = useCallback((): HTMLElement | null => {
    for (const u of instancesRef.current.values()) return u.over;
    return null;
  }, []);

  const sharedExtent = useCallback((): number | null => {
    let m: number | null = null;
    for (const v of extentByAreaRef.current.values()) m = m == null ? v : Math.max(m, v);
    return m;
  }, []);

  // The x-window floor across the panel: the *earliest* window-start of any
  // area (areas share one x-axis). `0` before any area reports — so a plot
  // over a session-origin trace floors at 0, its long-standing behaviour.
  const sharedStart = useCallback((): number => {
    let m: number | null = null;
    for (const v of startByAreaRef.current.values()) m = m == null ? v : Math.min(m, v);
    return m ?? 0;
  }, []);

  const applyXAll = useCallback((min: number, max: number, exceptId: string | null) => {
    const sync = xSyncRef.current;
    const prev = sync.suppress;
    sync.suppress = true;
    sync.xMin = min;
    sync.xMax = max;
    for (const [id, u] of instancesRef.current) {
      if (id === exceptId) continue;
      const xs = u.scales.x;
      if (xs.min === min && xs.max === max) continue;
      u.setScale("x", { min, max });
    }
    sync.suppress = prev;
  }, []);

  // Bumped on any programmatic x-window change (user pan/zoom, Fit Data,
  // goto-event) so every area re-samples the new slice. The self-paced
  // resample loop only ticks while running (ADR 0024); a *stopped* trace
  // otherwise never refetches after its window moves, leaving uPlot
  // holding the old off-screen slice — the "jump lands on empty" bug.
  const [xEpoch, setXEpoch] = useState(0);
  const bumpXEpoch = useCallback(() => setXEpoch((n) => n + 1), []);

  // A user changed an area's x window (drag-select / ⌘+wheel / shift-pan):
  // record it as the shared window, propagate, drop out of follow-live.
  const onUserXChange = useCallback(
    (min: number, max: number, fromId: string, keepFollow = false) => {
      // DIAG: fires only on a real user pan/zoom — if this spins
      // during the freeze, the setScale suppression window is being
      // missed and the x-sync ring (applyXAll → setScale hook →
      // onUserXChange) is the loop.
      diagCount("plot.userXChange"); // DIAG
      applyXAll(min, max, fromId);
      // A zoom out over the old end of the window is a request to change
      // scale, not to stop following: `followXWindow` keeps whatever
      // width the user lands on and re-slides it to the live edge, so
      // follow-live survives it intact.
      if (!keepFollow) setFollowLive(false);
      bumpXEpoch();
    },
    [applyXAll, bumpXEpoch],
  );

  // Where the shared x-window goes per `followXWindow` — slide to the live
  // edge only while *running*; a restored stopped trace fits its full span
  // once instead of a trailing default-width slice.
  const followLiveRef = useRef(followLive);
  useEffect(() => {
    followLiveRef.current = followLive;
  });
  const runningRef = useRef(live);
  useEffect(() => {
    runningRef.current = live;
  });
  /** Follow-live's clock anchor, or `null` before the first slide / after
   * a pause — the next slide re-anchors on the data edge. */
  const liveEdgeRef = useRef<LiveEdge | null>(null);
  /** Clock tuning, in a ref so the resample callback stays stable. The
   * target lag follows the plot fetch interval: a longer gap between
   * fetches means the window has to sit further back to stay full, so
   * it is derived from the setting rather than fixed. */
  const liveEdgeTuningRef = useRef<LiveEdgeTuning>({
    maxLagSeconds: FOLLOW_MAX_LAG_SECONDS,
    tauSeconds: FOLLOW_EDGE_TAU_SECONDS,
    targetLagSeconds: targetLagFor(hostSettings().plot_fetch_interval_ms),
  });
  const fetchIntervalMs = useSetting("plot_fetch_interval_ms");
  useEffect(() => {
    liveEdgeTuningRef.current.targetLagSeconds = targetLagFor(fetchIntervalMs);
  }, [fetchIntervalMs]);
  /** Pending coalesced slide, or `0` when none is scheduled (ADR 0024 —
   * "one slide per frame"). */
  const slideRafRef = useRef(0);
  /** Recompute the shared x-window from the panel's current extent and
   * push it to every area. One clock read, one fan-out — see
   * {@link onAreaResampled}. */
  const slideXWindow = useCallback(() => {
      const ext = sharedExtent();
      if (ext == null) return;
      // Follow-live slides to a *clock*-derived edge, not to the data
      // edge. Stepping straight to `ext` moves the window by however
      // much data happened to arrive since the last tick — a quantity
      // uncorrelated with when we repaint — so the whole plot juddered,
      // and the jump scaled with pixels-per-second (worse zoomed in).
      // Deriving the edge from elapsed real time makes position a
      // function of time, so even an irregular tick lands the window
      // where it belongs. See `advanceLiveEdge`.
      let edgeT = ext;
      if (followLiveRef.current && runningRef.current) {
        const nowMs = performance.now();
        const edge = advanceLiveEdge(liveEdgeRef.current, ext, nowMs, liveEdgeTuningRef.current);
        liveEdgeRef.current = edge;
        // Never track behind the window's own start: a fresh session has
        // less capture than the display lag, and an edge before the
        // start inverts the window (see `followXWindow`).
        edgeT = Math.max(liveEdgeAt(edge, nowMs), sharedStart());
      } else {
        liveEdgeRef.current = null; // re-anchor on the next resume
      }
      const sync = xSyncRef.current;
      const win = followXWindow(
        followLiveRef.current,
        runningRef.current,
        sync.xMin,
        sync.xMax,
        edgeT,
        hostSettings().follow_window_ms / 1000,
        sharedStart(),
      );
      if (win) {
        diagCount("followwin.slide"); // DIAG
        diagGauge("winw", win.max - win.min); // DIAG
        diagGauge("ext", ext); // DIAG
        applyXAll(win.min, win.max, null);
      }
  }, [sharedExtent, sharedStart, applyXAll]);

  // An area finished a re-sample. Record its contribution to the panel's
  // data extent / window floor *now* — Fit Data reads those synchronously
  // — but defer the follow-live slide to the next frame, coalescing every
  // area's report into one (ADR 0024). Sliding per report made the fan-out
  // O(areas²): each of N areas pushed its own clock-derived window into all
  // N uPlots per resample interval, and `applyXAll`'s equality skip could
  // never fire because no two areas read `performance.now()` at the same
  // instant. Fetch cadence (the per-area resample loop) and redraw cadence
  // (this frame) are now independent.
  const onAreaResampled = useCallback(
    (areaId: string, firstT: number | null, lastT: number | null) => {
      diagCount("plot.areaResampled"); // DIAG
      if (lastT != null) extentByAreaRef.current.set(areaId, lastT);
      else extentByAreaRef.current.delete(areaId);
      if (firstT != null) startByAreaRef.current.set(areaId, firstT);
      else startByAreaRef.current.delete(areaId);
      if (slideRafRef.current) return;
      slideRafRef.current = requestAnimationFrame(() => {
        slideRafRef.current = 0;
        slideXWindow();
      });
    },
    [slideXWindow],
  );
  useEffect(
    () => () => {
      if (slideRafRef.current) cancelAnimationFrame(slideRafRef.current);
      slideRafRef.current = 0;
    },
    [],
  );

  /** Bumped to ask every PlotArea to invalidate its per-trace
   * normalisation range — used by Fit Data and the wrapped trace
   * Clear so y rescales fresh. */
  const [resetYEpoch, setResetYEpoch] = useState(0);
  /** Increment to ask every area to Fit Y from its currently rendered
   * data — toolbar's "fit y" hits all areas at once. (Per-area Fit Y
   * lives on the side-panel header.) */
  const [fitYEpoch, setFitYEpoch] = useState(0);
  const fitYAll = useCallback(() => setFitYEpoch((n) => n + 1), []);

  /** Fit the x-axis to `[start, ext)`, where `ext` comes from a host
   * round-trip over `[ws, we)` when possible (falling back to the
   * panel's own rendered extent) — the shared body behind "fit data"
   * (fits to the *window's* current start) and "All data" (fits to the
   * whole buffer, `start` pinned at 0 rather than derived). */
  const fitToRange = useCallback(
    async (start: number, ws: number, we: number) => {
      // `sharedExtent()` is only as fresh as the last area re-sample, and a
      // window zoomed into history stops re-sampling while the capture
      // grows (its request can't return different bytes). Fitting to it
      // would end the plot where the capture stood when the user panned
      // away — so ask the host where the window ends *now*. One round-trip
      // per press; none per tick, which is what the parked view saves.
      const base = baseSecondsRef.current;
      let ext: number | null = null;
      if (base != null && Number.isFinite(base)) {
        try {
          const last = await fetchWindowExtent(ws, we);
          if (last != null) ext = last - base;
        } catch {
          /* host unreachable — fall back to the rendered extent below */
        }
      }
      ext ??= sharedExtent();
      applyXAll(start, ext != null && ext > start ? ext : start + 1, null);
      setResetYEpoch((n) => n + 1);
      bumpXEpoch();
    },
    [sharedExtent, applyXAll, bumpXEpoch],
  );

  const fitData = useCallback(
    // Fit the full span from the window's session-relative start (ADR
    // 0024 — a Clear re-anchors but doesn't re-zero), not a literal 0.
    () => fitToRange(sharedStart(), winStart, winEnd),
    [fitToRange, sharedStart, winStart, winEnd],
  );

  // Hotkey / palette implementations for this panel instance
  // (ADR 0018): with the panel focused, `f` re-runs fit-data and `l`
  // re-enters follow-live (enable-only — panning the x axis is how
  // the user drops out).
  usePanelCommands(elementId, {
    "plot.fitXAxis": fitData,
    "plot.followLive.enable": () => setFollowLive(true),
  });

  /** Wrap the trace's Clear so it also wipes the panel-level overlays
   * (cursors, notes) and the per-area normalisation range — the trace
   * state alone re-anchors the window, but everything visually layered
   * on top would otherwise keep its old positions. */
  const handlePlotClear = useCallback(() => {
    // The trace clear cascades to the host, which clears the
    // session-scoped notes store and emits `notes-changed` — no
    // per-panel `setNotes` to do here.
    trace.clear();
    setCursorX({ a: null, b: null });
    setCursorYByArea({});
    setResetYEpoch((n) => n + 1);
  }, [trace]);

  /** "All data": widen the trace window to the whole session buffer
   * (still following live if it was already running — `allDataTrace`)
   * and fit the x-axis to it. The DBC-reload recovery workflow this
   * serves: Clear collapses the window to now so re-picking signals
   * against the fresh DBC resamples cheaply, then All data widens back
   * out for one full-history resample. Overlay reset mirrors Clear;
   * `fitToRange` bumps `resetYEpoch` itself, so no separate call here. */
  const handleAllData = useCallback(() => {
    const n = capture.count;
    trace.allData();
    setCursorX({ a: null, b: null });
    setCursorYByArea({});
    void fitToRange(0, 0, n);
  }, [trace, capture.count, fitToRange]);

  // Reset the shared window + extent when the trace window re-anchors
  // (Clear / Start gives the element a new `offset`); cursors, which are
  // in window-relative seconds, no longer mean anything then — but don't
  // wipe restored cursors on the initial mount.
  const prevWinStartRef = useRef(winStart);
  useEffect(() => {
    xSyncRef.current.xMin = null;
    xSyncRef.current.xMax = null;
    extentByAreaRef.current.clear();
    startByAreaRef.current.clear();
    if (prevWinStartRef.current !== winStart) {
      setCursorX({ a: null, b: null });
      setCursorYByArea({});
    }
    prevWinStartRef.current = winStart;
  }, [winStart]);

  // Clear cursors when the capture itself resets. Notes are
  // session-scoped (the host clears them in `clear_trace_store`
  // and emits `notes-changed`), so nothing for this panel to
  // wipe locally.
  const prevCountRef = useRef(capture.count);
  useEffect(() => {
    if (prevCountRef.current > 0 && capture.count === 0) {
      setCursorX({ a: null, b: null });
      setCursorYByArea({});
    }
    prevCountRef.current = capture.count;
  }, [capture.count]);

  useEffect(() => {
    if (!areas.some((a) => a.id === focusedAreaId)) setFocusedAreaId(areas[0]?.id ?? "");
  }, [areas, focusedAreaId]);

  // Dual-write this panel's config (`notes` excluded — session-scoped
  // in the host) onto the element and into the dockview params — see
  // `useElementPanel`'s `persist`.
  useEffect(() => {
    persist({
      areas,
      followLive,
      cursorMode,
      measEnabled,
      measKeys,
      showDiag,
      cursorX,
      cursorYByArea,
      signalsWidthPx: signalsWidth,
      showPoints,
      axisWeights,
      axisScales,
      solo: soloToParams(solo),
    });
  }, [
    persist,
    areas,
    solo,
    followLive,
    cursorMode,
    measEnabled,
    measKeys,
    showDiag,
    cursorX,
    cursorYByArea,
    signalsWidth,
    showPoints,
    axisWeights,
    axisScales,
  ]);

  // --- area ops ---
  const addArea = useCallback(() => {
    setAreas((prev) => {
      const next: PlotAreaConfig = newPlotArea();
      setFocusedAreaId(next.id);
      return [...prev, next];
    });
  }, []);
  const removeArea = useCallback((id: string) => {
    setAreas((prev) => (prev.length <= 1 ? prev : prev.filter((a) => a.id !== id)));
    // Per-axis state is keyed by *derived* axis id: the parent's id in
    // unified mode, `${parentId}/…` per derived axis otherwise. Match
    // both so a per-unit / individual area doesn't leak its axes'
    // entries on removal.
    const belongsToArea = (k: string) => k === id || k.startsWith(`${id}/`);
    setCursorYByArea((prev) => {
      const keys = Object.keys(prev).filter(belongsToArea);
      if (keys.length === 0) return prev;
      const rest = { ...prev };
      for (const k of keys) delete rest[k];
      return rest;
    });
    setSeriesByArea((prev) => {
      const keys = [...prev.keys()].filter(belongsToArea);
      if (keys.length === 0) return prev;
      const next = new Map(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
  }, []);
  /// Drag-reorder: move `draggedId` to where `targetId` sits in the
  /// stack. Ordering is the `areas` array itself, so this is a pure
  /// permutation — everything else about an area (weights, cursors,
  /// sampled series, focus) is keyed by id and rides along untouched.
  const reorderArea = useCallback((draggedId: string, targetId: string) => {
    setAreas((prev) => reorderAreas(prev, draggedId, targetId));
  }, []);
  const setAreaYAxisMode = useCallback((id: string, mode: YAxisMode) => {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, yAxisMode: mode } : a)));
  }, []);
  /// Collapse / expand a whole logical area (ADR 0026). Stored on the
  /// area, so every axis it derives shares one collapse state and the
  /// setting persists with the panel. Expanding drops the flag rather
  /// than storing `false`, keeping the persisted blob sparse.
  const toggleAreaCollapsed = useCallback((id: string) => {
    setAreas((prev) =>
      prev.map((a) => (a.id === id ? { ...a, collapsed: a.collapsed ? undefined : true } : a)),
    );
  }, []);
  const setAreaPrimarySignal = useCallback((id: string, key: string | null) => {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, primarySignalKey: key } : a)));
  }, []);

  /// Replace an area's regex pattern list (`signalSelection.ts`).
  /// Empty / `undefined` leaves just the manual picks; the renderer
  /// re-resolves patterns against the catalog on every change to
  /// `catalog`, `buses`, or the patterns themselves.
  const setAreaPatterns = useCallback(
    (id: string, patterns: string[] | undefined) => {
      setAreas((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, patterns: patterns?.length ? patterns : undefined } : a,
        ),
      );
    },
    [],
  );

  /// Convert regex → manual (one-way): materialize the area's current
  /// *effective* series (manual + pattern matches) into the persisted
  /// manual list and clear the patterns. The user's mental "this is
  /// the set I want" becomes explicit picks.
  const materializePatterns = useCallback(
    (id: string, effective: SignalRef[]) => {
      setAreas((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, signals: effective, patterns: undefined } : a,
        ),
      );
    },
    [],
  );

  const removeSignal = useCallback((areaId: string, key: string) => {
    // Only manual picks are removable row-by-row; a pattern-derived
    // row has no manual entry (this is then a no-op) and is removed by
    // editing the pattern or converting to manual — the row's UI hides
    // its × for that case.
    setAreas((prev) =>
      prev.map((a) => {
        if (a.id !== areaId) return a;
        return { ...a, signals: a.signals.filter((s) => signalRefKey(s) !== key) };
      }),
    );
  }, []);
  // A signal was dropped into `toAreaId`. Drop semantics depend on
  // where the drag started (carried as `isInternalMove`):
  //
  // - **Internal move** (drag started inside this panel): strip the
  //   ref from whichever area it was in and re-insert it at the new
  //   position (preserving color). Re-orders within a single area,
  //   or moves between areas of this panel.
  // - **External add** (drag from DBC panel, trace cell, by-id
  //   cell, or another plot panel): insert into the target area
  //   without touching other areas — the same signal can live in
  //   multiple areas and the source is left alone. If the target
  //   area already has the same signal, drop is a no-op (no
  //   duplicates within one area).
  //
  const placeSignal = useCallback(
    (ref: SignalRef, toAreaId: string, beforeKey: string | null, isInternalMove: boolean) => {
      const key = signalRefKey(ref);
      if (beforeKey === key) return; // dropped a row on itself — no-op
      setAreas((prev) => {
        const target = prev.find((a) => a.id === toAreaId);
        if (target == null) return prev;
        if (isInternalMove) {
          // Move: the ref already lives in some area of this panel.
          // Strip it from its origin area (could be the target — that's
          // a reorder), and insert at the new position. Preserves the
          // original color by reusing the in-state ref. (Dragging a
          // pattern-derived row has no manual entry to strip — the
          // insert below materializes it as a manual pick, keeping the
          // dragged ref's stable color.)
          const existing = prev.flatMap((a) => a.signals).find((s) => signalRefKey(s) === key);
          // The drag payload carries no color; a materializing
          // pattern row keeps the stable-by-identity color it was
          // already rendered with.
          const moved = existing ?? { ...ref, color: ref.color || stableSignalColor(key) };
          const stripped = prev.map((a) => ({
            ...a,
            signals: a.signals.filter((s) => signalRefKey(s) !== key),
          }));
          return stripped.map((a) => {
            if (a.id !== toAreaId) return a;
            if (beforeKey == null) return { ...a, signals: [...a.signals, moved] };
            const idx = a.signals.findIndex((s) => signalRefKey(s) === beforeKey);
            if (idx < 0) return { ...a, signals: [...a.signals, moved] };
            return { ...a, signals: [...a.signals.slice(0, idx), moved, ...a.signals.slice(idx)] };
          });
        }
        // External add: only the target area is touched. Within an
        // area we do prevent a second copy of the same signal (no
        // semantic value to plotting the identical series twice on
        // one axis); duplicates across different areas are fine.
        if (target.signals.some((s) => signalRefKey(s) === key)) return prev;
        // Re-seed the color from the *target area's* wheel index, per
        // ADR 0026: a dragged-in series picks the color at the
        // position equal to the count of series already in the area.
        // Cross-panel drags preserve the source ref's color
        // (`parseDroppedSignals` passes it through as-is), which we
        // discard here so the wheel index is consistent regardless of
        // where the drag started.
        const seedIdx = target.signals.length;
        const seeded: SignalRef = { ...ref, color: wheelColor(seedIdx) };
        return prev.map((a) => {
          if (a.id !== toAreaId) return a;
          if (beforeKey == null) return { ...a, signals: [...a.signals, seeded] };
          const idx = a.signals.findIndex((s) => signalRefKey(s) === beforeKey);
          if (idx < 0) return { ...a, signals: [...a.signals, seeded] };
          return { ...a, signals: [...a.signals.slice(0, idx), seeded, ...a.signals.slice(idx)] };
        });
      });
    },
    [],
  );
  /** Set a series' color after it's been added (per ADR 0026). A
   * manual pick updates in place; a pattern-derived row (no manual
   * entry) is materialized as a manual pick carrying the new color —
   * that's what makes a per-signal color override stick across
   * pattern re-evaluations and project reloads. */
  const setSignalColor = useCallback((areaId: string, ref: SignalRef, color: string) => {
    const key = signalRefKey(ref);
    setAreas((prev) =>
      prev.map((a) => {
        if (a.id !== areaId) return a;
        if (a.signals.some((s) => signalRefKey(s) === key)) {
          return { ...a, signals: a.signals.map((s) => (signalRefKey(s) === key ? { ...s, color } : s)) };
        }
        return { ...a, signals: [...a.signals, { ...ref, color }] };
      }),
    );
  }, []);
  /** Toggle a series' hidden flag. Same materialization rule as
   * `setSignalColor`: hiding a pattern-derived row pins it as a manual
   * pick (hidden), so the choice persists instead of being rebuilt
   * away on the next catalog re-evaluation. */
  const toggleSignalHidden = useCallback((areaId: string, ref: SignalRef) => {
    const key = signalRefKey(ref);
    setAreas((prev) =>
      prev.map((a) => {
        if (a.id !== areaId) return a;
        if (a.signals.some((s) => signalRefKey(s) === key)) {
          return {
            ...a,
            signals: a.signals.map((s) => (signalRefKey(s) === key ? { ...s, hidden: !s.hidden } : s)),
          };
        }
        return { ...a, signals: [...a.signals, { ...ref, hidden: true }] };
      }),
    );
  }, []);

  // --- cursors / notes ---
  // The mouse crosshair is panel-level, like cursor A/B: one shared x
  // for the whole stack, so every area draws the crosshair line and
  // reads its side-panel values at the same time — not just the area
  // under the pointer. Areas report their uPlot cursor through
  // `reportHoverX` (raw, per mousemove); a single panel-level rAF
  // coalesces those into at most one state commit per frame. The
  // owner-aware fold (`nextHover`) keeps a non-hovered area's
  // setData-triggered cursor reset from clearing the hover.
  const [hoverX, setHoverX] = useState<number | null>(null);
  const hoverRef = useRef<PanelHover | null>(null);
  const hoverRafRef = useRef(0);
  const reportHoverX = useCallback((areaId: string, x: number | null) => {
    hoverRef.current = nextHover(hoverRef.current, areaId, x);
    if (hoverRafRef.current) return;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = 0;
      setHoverX(hoverRef.current?.x ?? null);
    });
  }, []);
  useEffect(
    () => () => {
      if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = 0;
    },
    [],
  );
  const placeCursorX = useCallback((which: "a" | "b", t: number) => setCursorX((p) => ({ ...p, [which]: t })), []);
  const placeCursorY = useCallback((areaId: string, which: "h1" | "h2", v: number) => {
    setCursorYByArea((p) => ({
      ...p,
      [areaId]: { h1: p[areaId]?.h1 ?? null, h2: p[areaId]?.h2 ?? null, [which]: v },
    }));
  }, []);
  const clearCursors = useCallback(() => {
    setCursorX({ a: null, b: null });
    setCursorYByArea({});
  }, []);
  // Panel-level cache base — set by whichever PlotArea
  // reports it first. Areas share the same x scale, so any one is
  // representative; later reports overwrite it (a re-anchor after
  // Clear flows through the same callback). `null` when no area
  // has anchored yet (e.g. no frames in the window).
  const [baseSeconds, setBaseSeconds] = useState<number | null>(null);
  // Display-relative `t` (seconds, panel x-axis units) → absolute
  // trace ns: the host's note store works in
  // `RawTraceFrame::timestamp_ns` units so a note placed in panel
  // A lands on the same timeline in panel B even if their
  // x-axis bases drift. If the cache hasn't anchored yet (no
  // frames in the window) there's no sensible ns to write —
  // silently drop.
  const addNote = useCallback(
    (t: number) => {
      if (baseSeconds == null || !Number.isFinite(baseSeconds)) return;
      const timestampNs = Math.round((baseSeconds + t) * 1e9);
      // Color cycles the shared signal wheel by the existing note
      // count — like plot series seed by area signal count (ADR 0026) —
      // so successive notes are visually distinct without any picking.
      dispatchAddNote(
        crypto.randomUUID(),
        timestampNs,
        `note ${sessionNotes.length + 1}`,
        wheelColor(sessionNotes.length),
      );
    },
    [baseSeconds, dispatchAddNote, sessionNotes.length],
  );
  // Jump the panel's x-window so the note at display-relative time
  // `t` is centred. Preserves the current zoom width; drops out of
  // follow-live (otherwise the next resample would slide the view
  // straight back to the live edge).
  const gotoNote = useCallback(
    (t: number) => {
      const sync = xSyncRef.current;
      const [min, max] = centerWindowOn(
        t,
        { min: sync.xMin, max: sync.xMax },
        hostSettings().follow_window_ms / 1000,
      );
      applyXAll(min, max, null);
      setFollowLive(false);
      bumpXEpoch();
    },
    [applyXAll, bumpXEpoch],
  );
  // Cross-panel "goto" (ADR 0035): the events view broadcasts a target
  // timestamp; centre the x-window on it. The payload is absolute ns, so
  // convert against this panel's x-axis origin (`baseSeconds`), read through a
  // ref so the listener subscribes once. Before the cache anchors there's no
  // origin to project against — drop it.
  const baseSecondsRef = useRef<number | null>(null);
  useEffect(() => {
    let live = true;
    const unlisten = listen<GotoPayload>(GOTO_EVENT, (e) => {
      if (!live) return;
      const b = baseSecondsRef.current;
      if (b == null || !Number.isFinite(b)) return;
      gotoNote(e.payload / 1e9 - b);
    });
    return () => {
      live = false;
      void unlisten.then((fn) => fn());
    };
  }, [gotoNote]);

  const reportSeries = useCallback(
    (areaId: string, series: Map<string, Series>) => {
      diagCount("plot.reportSeries"); // DIAG
      if (!measEnabled) return;
      setSeriesByArea((p) => {
        const next = new Map(p);
        next.set(areaId, series);
        return next;
      });
    },
    [measEnabled],
  );
  // The four timing / size read-outs and the smoothness meter go through
  // the badge accumulator: they feed only the toolbar strip, so they are
  // batched to its flush rate instead of costing a render per report.
  const { report: badgeSink } = badge;
  const reportPerf = useCallback((_areaId: string, ms: number) => badgeSink.perf(ms), [badgeSink]);
  const reportHostMs = useCallback((_areaId: string, ms: number) => badgeSink.hostMs(ms), [badgeSink]);
  const reportJank = useCallback(
    (_areaId: string, pct: number | null) => badgeSink.jank(pct),
    [badgeSink],
  );
  const reportRate = useCallback((_areaId: string, hz: number) => badgeSink.rate(hz), [badgeSink]);
  const reportCache = useCallback((_areaId: string, n: number) => badgeSink.cache(n), [badgeSink]);
  // Not a diagnostic: the x-axis origin projects notes, the truncation
  // marker and Fit Data onto this panel's timeline. Every area reports the
  // same value every tick, so gate the commit on a real change rather than
  // leaning on React's bail-out.
  const lastBaseRef = useRef<number | null>(null);
  const reportBase = useCallback((_areaId: string, secs: number | null) => {
    if (lastBaseRef.current === secs) return;
    lastBaseRef.current = secs;
    setBaseSeconds(secs);
  }, []);
  // Group the area→panel readouts into one stable object so each
  // PlotArea gets a single `reports` prop / liveRef entry rather than
  // six parallel callbacks (`PlotAreaReports`).
  const reports = useMemo<PlotAreaReports>(
    () => ({
      series: reportSeries,
      perf: reportPerf,
      hostMs: reportHostMs,
      jank: reportJank,
      rate: reportRate,
      cache: reportCache,
      base: reportBase,
    }),
    [reportSeries, reportPerf, reportHostMs, reportJank, reportRate, reportCache, reportBase],
  );
  // Mirror the x-axis origin into a ref for the goto listener (above), which
  // subscribes once and so can't close over the live state value.
  useEffect(() => {
    baseSecondsRef.current = baseSeconds;
  }, [baseSeconds]);

  const busNameLookup = useMemo(() => busLookup(buses), [buses]);

  // The active theme. Both memos below resolve a themed color, so they
  // are rebuilt when it changes rather than handing the areas colors
  // from the theme that was active when the bus list last moved.
  const themeName = useThemeName();

  // Bus id → render color (explicit `color`, else the palette color
  // for the bus's list position) — mirrors `effectiveBusColor` so the
  // swatch in a signal row matches the bus's graph color.
  const busColorLookup = useMemo(() => {
    const m = new Map<string, string>();
    buses.forEach((b, i) => m.set(b.id, b.color ?? defaultBusColor(i)));
    return m;
  }, [buses, themeName]);

  // Signal value→color maps (ADR 0029): one resolver over every
  // colormap element, fed to each area so an enum lane box can be tinted
  // by its held value. Rebuilt only when the element set changes.
  const resolveColor = useMemo(
    () => buildColorResolver(registry.entries.map((e) => e.element)),
    [registry.entries],
  );

  /// The catalog restricted to the plot's effective `sources` wiring
  /// (`signalSelection.ts`): the picker and the patterns only offer /
  /// match signals on buses this plot can actually sample. Unwired or
  /// `"*"` = the full catalog.
  const scopedCatalog = useMemo(() => {
    const filterSources = new Map<string, readonly string[]>(
      registry.entries
        .filter((e) => e.element.kind === "filter")
        .map((e) => [e.element.id, (e.element as { sources?: string[] }).sources ?? []]),
    );
    const busSet = effectiveSourceBuses(currentSources, buses.map((b) => b.id), filterSources);
    return scopeCatalog(catalog, busSet);
  }, [catalog, currentSources, buses, registry.entries]);

  /// `messageEcuKey` → transmitting ECU, built once for the whole
  /// panel: every area's signal rows name their message by its DBC
  /// ancestry, and the ECU only lives in the catalog.
  const ecuLookup = useMemo(() => messageEcuLookup(scopedCatalog), [scopedCatalog]);

  /// `signalKey` → the DBC facts that decide how that signal's values
  /// read (fixed decimals / float / hex). Built once for the whole
  /// panel, like `ecuLookup`, and shared by every readout: the side
  /// panel rows, the A/B delta and the measurement strip.
  const valueFormats = useMemo(() => signalValueFormats(scopedCatalog), [scopedCatalog]);

  /// Areas with their `patterns` resolved against the catalog
  /// (`signalSelection.ts`): the effective series list is the manual
  /// picks plus the pattern matches not already picked. Storage state
  /// (`areas`) holds only the manual picks + the pattern strings.
  const effectiveAreas = useMemo(
    () => applyAreaSelections(areas, scopedCatalog, busNameLookup),
    [areas, scopedCatalog, busNameLookup],
  );

  /// The solo match list — every plotted series whose display name the
  /// pattern matches, in panel order (areas in stack order, rows in area
  /// order). Taken from the *effective* areas, so pattern-derived rows
  /// are solo-able like manual picks. Empty while the pattern is empty
  /// or unparseable, which is what makes an invalid pattern inert.
  const soloMatchList = useMemo(
    () => soloMatches(effectiveAreas, solo.pattern),
    [effectiveAreas, solo.pattern],
  );
  const soloActive = soloRegex(solo.pattern) != null;
  /// The `soloMaskKey`s solo leaves visible — every match, or the
  /// stepped / checked subset of them.
  const soloVisible = useMemo(
    () => soloVisibleKeys(soloMatchList, solo.indices),
    [soloMatchList, solo.indices],
  );
  const soloInvalid = soloPatternInvalid(solo.pattern);
  /// Editing the pattern drops any stepped / checked subset: the
  /// positions index the *old* match list, and a new pattern is a new
  /// list — so a fresh pattern always starts as the matches-only view.
  const setSoloPattern = useCallback(
    (pattern: string) => setSolo({ pattern, indices: null }),
    [],
  );
  const clearSolo = useCallback(() => setSolo(SOLO_OFF), []);

  /// Per-area manual-pick keys (from *stored* state, not the effective
  /// list) — how the row renderer tells a manual pick from a
  /// pattern-derived row (which gets no per-row × and a pattern badge).
  const manualKeysByArea = useMemo(
    () => new Map(areas.map((a) => [a.id, new Set(a.signals.map((s) => signalRefKey(s)))])),
    [areas],
  );

  /// Each logical area's signal keys in the panel's canonical order —
  /// what a Shift+click range walks. Taken from the *effective* area, so
  /// the range spans every derived axis the area's y-axis mode splits
  /// its rows across (ADR 0026): the order is the area's, not any one
  /// axis's.
  const selectionOrderByArea = useMemo(
    () => new Map(effectiveAreas.map((a) => [a.id, a.signals.map((s) => signalRefKey(s))])),
    [effectiveAreas],
  );
  const selectSignal = useCallback(
    (areaId: string, key: string, modifiers: { mod: boolean; shift: boolean }) => {
      const order = selectionOrderByArea.get(areaId) ?? [];
      setSignalSelection((prev) => selectPlotSignal(prev, areaId, key, modifiers, order));
    },
    [selectionOrderByArea],
  );

  /// Live mirrors of the selection and the effective (materialized)
  /// areas, read by the selection's bulk-visibility action and its drag
  /// payload below. Both callbacks are bound once per axis in
  /// `areaHandlers` (task 49.B), so they read the *current* selection
  /// through a ref rather than closing over it — closing over either
  /// value would remint the callback (and so `areaHandlers`) on every
  /// selection click or catalog re-evaluation, defeating the memoised
  /// `PlotArea`'s per-axis guard the same way a fresh callback identity
  /// always does in this file.
  const signalSelectionRef = useRef(signalSelection);
  signalSelectionRef.current = signalSelection;
  const effectiveAreasRef = useRef(effectiveAreas);
  effectiveAreasRef.current = effectiveAreas;

  /// The parent area's current selection, resolved to its *effective*
  /// `SignalRef`s (manual picks + live pattern matches, spanning every
  /// derived axis the y-axis mode splits the area across) — `[]` when
  /// the selection belongs to a different area or is empty.
  const selectedRefsFor = useCallback((areaId: string): SignalRef[] => {
    const sel = signalSelectionRef.current;
    if (sel.areaId !== areaId || sel.ids.size === 0) return [];
    const parent = effectiveAreasRef.current.find((a) => a.id === areaId);
    if (!parent) return [];
    return parent.signals.filter((s) => sel.ids.has(signalRefKey(s)));
  }, []);

  /// Bulk hide/show over the parent area's current selection — the
  /// selection's context menu Hide / Show (task 49.B). The batched
  /// sibling of `toggleSignalHidden` above: same per-row materialization
  /// rule (a touched pattern-derived row becomes a manual pick), applied
  /// to every selected row in **one** `setAreas` call — one persist, one
  /// resample per touched derived axis, not N single-row toggles.
  const setSelectionHidden = useCallback(
    (areaId: string, hidden: boolean) => {
      const refs = selectedRefsFor(areaId);
      if (refs.length === 0) return;
      const keys = new Set(refs.map(signalRefKey));
      setAreas((prev) =>
        prev.map((a) => {
          if (a.id !== areaId) return a;
          const existingKeys = new Set(a.signals.map(signalRefKey));
          const updated = a.signals.map((s) =>
            keys.has(signalRefKey(s)) ? { ...s, hidden } : s,
          );
          const toAppend = refs
            .filter((r) => !existingKeys.has(signalRefKey(r)))
            .map((r) => ({ ...r, hidden }));
          return { ...a, signals: [...updated, ...toAppend] };
        }),
      );
    },
    [selectedRefsFor],
  );

  /// A selected row started a drag: fan the whole selection into the
  /// drag payload (DbcPanel precedent, ADR 0045) instead of just the
  /// grabbed row. A no-op when the parent area's selection is empty or
  /// belongs to a different area — the row's own single-ref drag covers
  /// that case (`PlotArea`).
  const dragSelection = useCallback(
    (areaId: string, dataTransfer: DataTransfer) => {
      const refs = selectedRefsFor(areaId);
      if (refs.length === 0) return;
      setSignalDragData(
        { dataTransfer },
        refs.map((r) => ({
          busId: r.busId,
          messageId: r.messageId,
          extended: r.extended,
          signalName: r.signalName,
          messageName: r.messageName,
          unit: r.unit,
        })),
        elementId,
      );
    },
    [selectedRefsFor, elementId],
  );

  /// Per-area pattern resolutions for the filter UI (match counts,
  /// invalid flags) — evaluated against the same catalog the effective
  /// series come from.
  const patternResolutionsByArea = useMemo(
    () =>
      new Map(
        areas.map((a) => [a.id, resolvePatterns(a.patterns ?? [], scopedCatalog, busNameLookup)]),
      ),
    [areas, scopedCatalog, busNameLookup],
  );

  /// Panel-level enum detection (ADR 0026). One `list_value_tables`
  /// fetch over every signal in the panel (via the shared
  /// `useValueTables` hook), reduced to the set of enum keys — signals
  /// whose `VAL_` table has >= 2 members. `deriveAxesForArea` consults
  /// this to collect a per-unit area's enums onto the shared
  /// enum-lanes axis. The per-area side-panel readout keeps its own
  /// `useValueTables` call inside `PlotArea`; folding the two fetches
  /// into one downward-passed map is a follow-up.
  const allPanelSignals = useMemo(
    () => effectiveAreas.flatMap((a) => a.signals),
    [effectiveAreas],
  );
  const panelValueTables = useValueTables(allPanelSignals);
  const enumKeys = useMemo(() => {
    const set = new Set<string>();
    for (const [key, table] of panelValueTables) {
      if (isEnumValueTable(table)) set.add(key);
    }
    return set;
  }, [panelValueTables]);

  /// Expand each effective area into one or more derived axes, based on
  /// the area's `yAxisMode` (ADR 0026). Unified produces one entry per
  /// area (identical to today); per-unit groups signals by unit (with
  /// all enums on one shared enum-lanes axis); and individual is one
  /// entry per signal. Each derived entry carries the parent area so
  /// panel-level callbacks (add signal, set primary, set mode, remove
  /// area) can route to the right place.
  const derivedAreaConfigs = useMemo(() => {
    const out: Array<{
      area: PlotAreaConfig;
      parentArea: PlotAreaConfig;
      isFirstOfParent: boolean;
      subtitle: string | null;
      enumLanes: boolean;
      // This axis draws nothing, so it's excluded from the fit-to-panel
      // height distribution and its canvas collapses; its rows stay in
      // the side panel so they remain un-hideable (ADR 0026). Two ways
      // to get here: the user collapsed the parent *area* (one flag,
      // every derived axis of that area), or every signal on this one
      // axis is hidden.
      collapsed: boolean;
      // The parent area's own collapse flag drove it (as opposed to the
      // all-hidden rule) — what the head toggle can undo.
      collapsedByFlag: boolean;
      // Solo left this axis with nothing visible — the same view-level
      // collapse as all-hidden, and equally not the area's own flag.
      collapsedBySolo: boolean;
    }> = [];
    const isEnum = (k: string) => enumKeys.has(k);
    for (const a of effectiveAreas) {
      const mode = a.yAxisMode ?? "unified";
      const axes = deriveAxesForArea(a.id, a.signals, mode, isEnum);
      axes.forEach((ax, i) => {
        // Solo masks *after* the axes are derived, never before: the
        // axis set (and so every id keyed by it — weights, manual
        // ranges, uPlot instances) is a function of the area's signals
        // and its y-axis mode, and a view mask must not move it. What
        // the mask changes is only which of an axis's series draw
        // (`plotSolo.ts`) — the same lever `hidden` pulls, composed on
        // top of it and never written back.
        const signals = soloActive ? soloMaskSignals(a.id, ax.signals, soloVisible) : ax.signals;
        // The derived `PlotAreaConfig` carries the axis's slice of
        // signals. `patterns` is preserved only on the first
        // derived axis so the filter UI / status bar doesn't render N
        // times for one logical area.
        const derivedArea: PlotAreaConfig = {
          id: ax.id,
          signals,
          yAxisMode: a.yAxisMode,
          primarySignalKey: a.primarySignalKey,
          patterns: i === 0 ? a.patterns : undefined,
          collapsed: a.collapsed,
        };
        const allHidden = signals.length > 0 && signals.every((s) => s.hidden);
        out.push({
          area: derivedArea,
          parentArea: a,
          isFirstOfParent: i === 0,
          subtitle: ax.subtitle,
          enumLanes: ax.kind === "enum-lanes",
          collapsed: a.collapsed === true || allHidden,
          collapsedByFlag: a.collapsed === true,
          // An axis whose only reason to be blank is the solo mask —
          // it collapses like any all-hidden axis, but says why, and
          // its area's persisted `collapsed` stays untouched.
          collapsedBySolo: allHidden && !ax.signals.every((s) => s.hidden),
        });
      });
    }
    return out;
  }, [effectiveAreas, enumKeys, soloActive, soloVisible]);

  /// Per-*derived-axis* slice of the selection — the shape that keeps a
  /// selection click off the memoised areas that hold none of the
  /// affected rows. Every axis outside the selected area (and every one
  /// inside it holding no selected row) gets the shared empty set, so
  /// its `PlotArea` sees an unchanged prop identity and does not
  /// re-render.
  const selectedKeysByAxis = useMemo(() => {
    const m = new Map<string, ReadonlySet<string>>();
    for (const d of derivedAreaConfigs) {
      if (d.parentArea.id !== signalSelection.areaId) {
        m.set(d.area.id, EMPTY_KEY_SET);
        continue;
      }
      const slice = new Set<string>();
      for (const s of d.area.signals) {
        const key = signalRefKey(s);
        if (signalSelection.ids.has(key)) slice.add(key);
      }
      m.set(d.area.id, slice.size === 0 ? EMPTY_KEY_SET : slice);
    }
    return m;
  }, [derivedAreaConfigs, signalSelection]);

  // Fit-to-panel weights (ADR 0026): resolve a flex-grow for every
  // live derived axis (stored value or default 1), and prune stored
  // entries whose axis no longer exists so the config doesn't
  // accumulate stale ids. `pruneAxisWeights` returns the same
  // reference when nothing is removed, so the setState is a no-op then
  // and the effect can't loop.
  const derivedAxisIds = useMemo(
    () => derivedAreaConfigs.map((d) => d.area.id),
    [derivedAreaConfigs],
  );
  const resolvedAxisWeights = useMemo(
    () => resolveAxisWeights(derivedAxisIds, axisWeights),
    [derivedAxisIds, axisWeights],
  );
  useEffect(() => {
    setAxisWeights((prev) => pruneAxisWeights(prev, derivedAxisIds));
  }, [derivedAxisIds]);

  // Manual y ranges retire on a different rule from the weights: they
  // are pruned to every id the areas' signals *could* mint in any
  // y-axis mode, not to the ids currently derived. A weight describes
  // the layout the user is looking at, so a mode change resetting it is
  // right; a manual range is what the user asked of an axis, and the
  // ids regenerate identically, so switching to `individual` and back
  // must restore it (`retainedAxisIds`, ADR 0026).
  const retainedScaleIds = useMemo(
    () => effectiveAreas.flatMap((a) => retainedAxisIds(a.id, a.signals)),
    [effectiveAreas],
  );
  useEffect(() => {
    setAxisScales((prev) => pruneAxisScales(prev, retainedScaleIds));
  }, [retainedScaleIds]);

  /// Bus-rename invalidation (ADR 0020). Track the previous match
  /// count for each filter-mode area; when a buses-list change drops
  /// any area's count from non-zero to zero, emit a System Messages
  /// warning naming the panel + the broken regex. The warning lands
  /// via `gui_emit_system_log` — the host's existing log bus picks
  /// it up and the System Messages panel renders it like any other
  /// `sys_warn!`.
  const lastMatchCountsRef = useRef<Map<string, number>>(new Map());
  const lastBusesRef = useRef<readonly Bus[]>(buses);
  useEffect(() => {
    const prev = lastMatchCountsRef.current;
    const next = new Map<string, number>();
    const busesChanged = lastBusesRef.current !== buses;
    for (const [areaId, resolutions] of patternResolutionsByArea) {
      for (const res of resolutions) {
        if (!res.valid) continue;
        const id = `${areaId}:${res.pattern}`;
        const count = res.matches.length;
        next.set(id, count);
        const wasCount = prev.get(id);
        if (busesChanged && wasCount != null && wasCount > 0 && count === 0) {
          void invoke("gui_emit_system_log", {
            level: "warn",
            source: "plot",
            message: `Plot panel pattern "${res.pattern}" no longer matches any signal — a bus rename or removal invalidated it.`,
          }).catch(() => {
            /* best effort — the panel still renders correctly */
          });
        }
      }
    }
    lastMatchCountsRef.current = next;
    lastBusesRef.current = buses;
  }, [patternResolutionsByArea, buses]);
  const areaLabels = useMemo(() => new Map(areas.map((a, i) => [a.id, `Area ${i + 1}`])), [areas]);

  /// Per-derived-axis callback bundle, rebuilt only when the axis set
  /// itself changes. Building these inline in the render loop handed
  /// every `PlotArea` a dozen fresh function identities per panel
  /// render, which defeated memoising the component: the whole stack
  /// re-rendered whenever any panel state moved, however unrelated.
  const areaHandlers = useMemo(() => {
    const m = new Map<string, AxisHandlers>();
    for (const d of derivedAreaConfigs) {
      const axisId = d.area.id;
      const parent = d.parentArea;
      m.set(axisId, {
        onPlaceCursorY: (which, v) => placeCursorY(axisId, which, v),
        onSetPrimarySignal: (k) => setAreaPrimarySignal(parent.id, k),
        onSelectSignal: (key, modifiers) => selectSignal(parent.id, key, modifiers),
        onSetYAxisMode: (mode) => setAreaYAxisMode(parent.id, mode),
        onToggleCollapsed: () => toggleAreaCollapsed(parent.id),
        onFocus: () => setFocusedAreaId(parent.id),
        onRemoveArea: () => removeArea(parent.id),
        onReorderArea: (draggedId) => reorderArea(draggedId, parent.id),
        onRemoveSignal: (key) => removeSignal(parent.id, key),
        onDropSignal: (ref, beforeKey, isInternalMove) =>
          placeSignal(ref, parent.id, beforeKey, isInternalMove),
        onToggleHidden: (ref) => toggleSignalHidden(parent.id, ref),
        onSetSignalColor: (ref, color) => setSignalColor(parent.id, ref, color),
        onSetPatterns: (ps) => setAreaPatterns(parent.id, ps),
        onMaterializePatterns: () => materializePatterns(parent.id, parent.signals),
        onSetYScale: (patch) => setAxisScales((prev) => setAxisScale(prev, axisId, patch)),
        onSetSelectionHidden: (hidden) => setSelectionHidden(parent.id, hidden),
        onDragSelection: (dataTransfer) => dragSelection(parent.id, dataTransfer),
      });
    }
    return m;
  }, [
    derivedAreaConfigs,
    placeCursorY,
    setAreaPrimarySignal,
    selectSignal,
    setAreaYAxisMode,
    toggleAreaCollapsed,
    removeArea,
    reorderArea,
    removeSignal,
    placeSignal,
    toggleSignalHidden,
    setSignalColor,
    setAreaPatterns,
    materializePatterns,
    setSelectionHidden,
    dragSelection,
  ]);
  const resizeSignalsWidth = useCallback(
    (w: number) => setSignalsWidth(Math.max(SIGNALS_WIDTH_MIN, Math.min(SIGNALS_WIDTH_MAX, w))),
    [],
  );
  /// Collapsed-ness of the axis stack, positionally — what
  /// `splitterPartnerAbove` reads to pair splitters across collapsed
  /// axes.
  const collapsedFlags = useMemo(
    () => derivedAreaConfigs.map((d) => d.collapsed),
    [derivedAreaConfigs],
  );
  /// Which collapsed axis heads each contiguous run of them — one
  /// shared drag handle per run rather than one per axis (ADR 0026).
  const runHeadFlags = useMemo(() => collapsedRunHeads(collapsedFlags), [collapsedFlags]);

  // Iterate the *derived* axes, not the parent areas: `reportSeries`
  // stores each axis's sampled series under its derived id (which in
  // per-unit / individual mode differs from the parent's), so the
  // measurement strip's `seriesFor(areaId, key)` lookups must use the
  // same ids. Each signal lives in exactly one derived axis of its
  // parent, so this enumerates every plotted signal exactly once.
  const plottedSignals = useMemo(() => {
    const out: PlottedSignal[] = [];
    for (const d of derivedAreaConfigs) {
      for (const s of d.area.signals) {
        const key = signalRefKey(s);
        // The strip's cells are per-signal readouts, so they format by
        // the same DBC facts the side panel's rows do.
        out.push({ key, ref: s, color: s.color, areaId: d.area.id, fmt: valueFormats.get(key) });
      }
    }
    return out;
  }, [derivedAreaConfigs, valueFormats]);
  const seriesFor = useCallback(
    (areaId: string, key: string): Series | undefined => seriesByArea.get(areaId)?.get(key),
    [seriesByArea],
  );
  // Project session-scoped notes onto this panel's display-relative
  // x axis. When the cache hasn't anchored yet (`baseSeconds`
  // null — no frames yet), notes don't render; an area reports a
  // base on its first non-empty fetch.
  const notes = useMemo<NoteEvent[]>(() => {
    if (baseSeconds == null || !Number.isFinite(baseSeconds)) return [];
    return sessionNotes.map((n) => ({
      id: n.id,
      t: n.timestampNs / 1e9 - baseSeconds,
      label: n.label,
      // Carry the note's color (ADR 0035) so its cursor matches the trace
      // and events panel; `undefined` falls back to the default event blue.
      color: n.color ?? undefined,
    }));
  }, [sessionNotes, baseSeconds]);
  // The derived truncation marker (ADR 0035) as a plot cursor, when the
  // disk-spill store has truncated the oldest history (`firstIndex > 0`).
  const truncation = useMemo<NoteEvent | null>(() => {
    if (baseSeconds == null || model.truncationTsNs == null) return null;
    return {
      id: TRUNCATION_EVENT_ID,
      t: model.truncationTsNs / 1e9 - baseSeconds,
      label: "history truncated here",
      // A muted amber, distinct from the note-event blue (ADR 0035).
      // Matches the trace floor row.
      color: theme().eventTruncation,
    };
  }, [model.truncationTsNs, baseSeconds, themeName]);
  const events = useMemo<NoteEvent[]>(
    () => [
      { id: "__t0", t: 0, label: "T0" },
      ...notes,
      ...(truncation ? [truncation] : []),
    ],
    [notes, truncation],
  );
  // Cursor *positions* render in the trace's elapsed-time format
  // (ADR 0024 — one string for one timeline position across views), with
  // precision adapted to the shared x-window's span like the axis ticks.
  // Reading the ref during render is fine here: every x-window change
  // that could alter the span re-renders the panel (xEpoch bump).
  const { xMin, xMax } = xSyncRef.current;
  const xLabelDigits = xMin != null && xMax != null ? fracDigitsForSpan(xMax - xMin) : 4;
  const fmtPos = (t: number | null): string =>
    t == null ? "—" : formatElapsed(t, xLabelDigits);

  /** Right-click anywhere on the panel toolbar opens this menu —
   * currently just the diagnostic-readout toggle, but the shape is
   * here so future seldom-used options (perf badge visibility, debug
   * overlays) have somewhere to land without crowding the main row of
   * buttons. `null` = closed; otherwise the viewport coords to anchor
   * the popup at. */
  const [toolbarMenuAt, setToolbarMenuAt] = useState<{ x: number; y: number } | null>(null);
  const toolbarMenuRef = useDismissableMenu<HTMLDivElement>(toolbarMenuAt != null, () =>
    setToolbarMenuAt(null),
  );

  return (
    <div className="plot-panel">
      <div
        className="plot-panel-toolbar"
        onContextMenu={(e) => {
          // Right-click the *toolbar* to open the panel menu (the
          // `plot-toolbar-menu` shell hosts the diagnostics toggle and
          // the sources picker). Deliberately not bound to the whole
          // panel: right-click + drag over a plot area is uPlot's
          // zoom gesture, and a plain right-click places cursor B —
          // a panel-wide handler stole both.
          e.preventDefault();
          setToolbarMenuAt({ x: e.clientX, y: e.clientY });
        }}
      >
        <TraceControls
          status={trace.status}
          onStart={trace.start}
          onStop={trace.stop}
          onPause={trace.pause}
          onResume={trace.resume}
          onClear={handlePlotClear}
          onAllData={handleAllData}
        />
        <span className="plot-toolbar-sep" />
        <button onClick={refreshCatalog} title="reload signal list from the attached DBC">
          ↻
        </button>
        <button onClick={addArea}>add plot area</button>
        <button onClick={fitData}>fit data</button>
        <button onClick={fitYAll} title="fit each area's y-axis to its currently visible data — useful after zooming in">
          fit y
        </button>
        <label className="checkbox">
          <input type="checkbox" checked={followLive} onChange={(e) => setFollowLive(e.target.checked)} />
          follow live
        </label>
        <label
          className="plot-cursor-ctl"
          title="draw sample points on every series: auto = let uPlot decide based on sample density; off = never draw points; on = always draw points"
        >
          points
          <Combobox
            options={SHOW_POINTS_OPTIONS}
            value={showPoints}
            onChange={(v) => setShowPoints(v as ShowPointsMode)}
            ariaLabel="show points"
          />
        </label>
        <span className="plot-toolbar-sep" />
        <label
          className="plot-solo"
          title="solo: show only the series whose name matches this regex (case-insensitive, partial). Everything else is masked out of the view — no series' own hide state is changed, and clearing the box (or Escape) brings the full view back."
        >
          solo
          <input
            className="plot-solo-input"
            aria-label="solo pattern"
            aria-invalid={soloInvalid || undefined}
            placeholder="regex"
            value={solo.pattern}
            onChange={(e) => setSoloPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                clearSolo();
              }
            }}
          />
          {soloInvalid && <span className="plot-solo-error">bad regex</span>}
          {solo.pattern !== "" && (
            <button
              className="plot-solo-clear"
              aria-label="clear solo"
              title="clear solo — every series goes back to its own visibility"
              onClick={clearSolo}
            >
              ×
            </button>
          )}
        </label>
        <span className="plot-toolbar-sep" />
        <label className="plot-cursor-ctl">
          cursors
          <Combobox
            options={CURSOR_MODE_OPTIONS}
            value={cursorMode}
            onChange={(v) => setCursorMode(v as CursorMode)}
          />
        </label>
        <button onClick={clearCursors} title="remove all placed cursors">
          clear cursors
        </button>
        <label className="checkbox">
          <input type="checkbox" checked={measEnabled} onChange={(e) => setMeasEnabled(e.target.checked)} />
          measurements
        </label>
        {measEnabled && <MeasurementMenu measKeys={measKeys} onChange={setMeasKeys} />}
        <span className="plot-toolbar-sep" />
        <span
          className="plot-perf"
          title="update rate · worst recent resample (host slice + decode in parens) · device pixel ratio · frames in trace window · cached plot points (biggest area)"
        >
          {live && badge.value.rateHz > 0 ? `${Math.round(badge.value.rateHz)} Hz` : "—"} ·{" "}
          {badge.value.perfMs > 0 ? `${badge.value.perfMs.toFixed(0)} ms` : "—"}
          {badge.value.hostMs > 0 ? ` (${badge.value.hostMs.toFixed(0)} host)` : ""}
          {badge.value.jankPct != null ? ` · jank ${badge.value.jankPct.toFixed(1)}%` : ""} · dpr{" "}
          {dpr.toFixed(2)} · win {fmtCount(winFrames)} · cache {fmtCount(badge.value.cachePts)}
        </span>
      </div>
      {toolbarMenuAt && (
        <div
          ref={toolbarMenuRef}
          className="plot-toolbar-menu"
          role="menu"
          style={{ left: toolbarMenuAt.x, top: toolbarMenuAt.y }}
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={showDiag}
            title="show the per-signal y-range / cached-t-range diagnostic line in each row"
            onClick={() => {
              setShowDiag((v) => !v);
              setToolbarMenuAt(null);
            }}
          >
            <span className="plot-toolbar-menu-mark" aria-hidden="true">
              {showDiag ? "✓" : ""}
            </span>
            show diagnostics
          </button>
          <SourcesMenuSection
            value={currentSources}
            buses={buses}
            filters={availableFilters}
            onChange={handleSourcesChange}
          />
        </div>
      )}

      <div className="plot-panel-areas">
        {derivedAreaConfigs.map((d, idx) => {
          // Cursor Y is per-derived-axis (so each axis can carry its
          // own H1/H2). Look it up by the derived id.
          const yc = cursorYByArea[d.area.id];
          const parent = d.parentArea;
          // A splitter sits before every axis but the first, trading
          // vertical weight between it and the axis above (ADR 0026).
          // It's a 0-height flex child (its hit area is an overlaid
          // pseudo-element) so it doesn't perturb the fit-to-panel
          // distribution. Measuring the neighbours' live pixel heights
          // at drag start keeps the weight math independent of the
          // panel's absolute size.
          // A splitter trades vertical weight between two axes, and a
          // collapsed (fully-hidden) axis has none to trade — so it
          // gets no splitter, and the splitter reaches *over* it to
          // pair the axes it sits between. Pairing DOM neighbours
          // instead would make collapsing a middle axis silently
          // remove the only handle for resizing either side of it.
          const handlers = areaHandlers.get(d.area.id)!;
          const aboveIdx = splitterPartnerAbove(collapsedFlags, idx);
          const above = aboveIdx == null ? null : derivedAreaConfigs[aboveIdx];
          const showSplitter = above != null;
          return (
            <Fragment key={d.area.id}>
              {showSplitter && above && (
                <div
                  className="plot-area-splitter"
                  role="separator"
                  aria-orientation="horizontal"
                  title="drag to resize; double-click to equalize"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const sep = e.currentTarget;
                    const idAbove = above.area.id;
                    const idBelow = d.area.id;
                    // By id, not by DOM adjacency: a splitter can pair
                    // two axes with collapsed strips between them.
                    const byId = (id: string) =>
                      Array.from(sep.parentElement?.children ?? []).find(
                        (c) => (c as HTMLElement).dataset?.areaId === id,
                      ) as HTMLElement | undefined ?? null;
                    const aboveEl = byId(idAbove);
                    const belowEl = byId(idBelow);
                    if (!aboveEl || !belowEl) return;
                    const abovePx0 = aboveEl.getBoundingClientRect().height;
                    const belowPx0 = belowEl.getBoundingClientRect().height;
                    const startY = e.clientY;
                    // Seed the pair's resolved weights so the drag has
                    // real numbers even for axes still at the default.
                    const base: AxisWeights = {
                      ...axisWeights,
                      [idAbove]: resolvedAxisWeights[idAbove],
                      [idBelow]: resolvedAxisWeights[idBelow],
                    };
                    const onMove = (ev: MouseEvent) => {
                      setAxisWeights(
                        applySplitterDelta(
                          base,
                          idAbove,
                          idBelow,
                          ev.clientY - startY,
                          abovePx0,
                          belowPx0,
                        ),
                      );
                    };
                    const onUp = () => {
                      window.removeEventListener("mousemove", onMove);
                      window.removeEventListener("mouseup", onUp);
                    };
                    window.addEventListener("mousemove", onMove);
                    window.addEventListener("mouseup", onUp);
                  }}
                  onDoubleClick={() => {
                    const idAbove = above.area.id;
                    const idBelow = d.area.id;
                    setAxisWeights((prev) =>
                      equalizePair(
                        {
                          ...prev,
                          [idAbove]: resolvedAxisWeights[idAbove],
                          [idBelow]: resolvedAxisWeights[idBelow],
                        },
                        idAbove,
                        idBelow,
                      ),
                    );
                  }}
                />
              )}
              <PlotArea
                area={d.area}
                flexGrow={d.collapsed ? 0 : resolvedAxisWeights[d.area.id]}
                collapsed={d.collapsed}
                collapsedBySolo={d.collapsedBySolo}
                collapsedRunHead={runHeadFlags[idx]}
                enumLanes={d.enumLanes}
                yScale={axisScales[d.area.id]}
              label={
                d.subtitle == null
                  ? areaLabels.get(parent.id) ?? "Area"
                  : `${areaLabels.get(parent.id) ?? "Area"} · ${d.subtitle}`
              }
              isFirst={idx === 0}
              isLast={idx === derivedAreaConfigs.length - 1}
              // Focus marks the *logical area* the toolbar's "add
              // signal" targets, so every derived axis of the focused
              // parent gets the outline — deliberate: the drop target
              // is the parent area, not one of its axes.
              focused={parent.id === focusedAreaId}
              // Removal is parent-area level — only show the X on the
              // first derived axis of each parent so we don't render N
              // remove buttons for one logical area.
              removable={effectiveAreas.length > 1 && d.isFirstOfParent}
              // Reorder is parent-area level too: one grip per logical
              // area, and only once there is another area to trade
              // places with.
              parentAreaId={parent.id}
              reorderable={effectiveAreas.length > 1}
              // Per-axis chrome (y-axis-mode selector, filter editor,
              // primary-signal click) lives on the first derived axis
              // of each parent so the user has one source of truth.
              isParentHead={d.isFirstOfParent}
              winStart={winStart}
              winEnd={winEnd}
              originSeconds={model.sessionStartSeconds}
              live={live}
              followLive={followLive}
              showPoints={showPoints}
              signalsWidth={signalsWidth}
              onResizeSignalsWidth={resizeSignalsWidth}
              cursorMode={cursorMode}
              cursorXa={cursorX.a}
              cursorXb={cursorX.b}
              cursorYh1={yc?.h1 ?? null}
              cursorYh2={yc?.h2 ?? null}
              hoverX={hoverX}
              onHoverX={reportHoverX}
              events={events}
              xSyncRef={xSyncRef}
              registerInstance={registerInstance}
              plotSurface={plotSurface}
              reportGutterNeed={reportGutterNeed}
              onUserXChange={onUserXChange}
              onAreaResampled={onAreaResampled}
              onPlaceCursorX={placeCursorX}
              onAddNote={addNote}
              reports={reports}
              resetYEpoch={resetYEpoch}
              xEpoch={xEpoch}
              fitYEpoch={fitYEpoch}
              showDiag={showDiag}
              {...handlers}
              selectedKeys={selectedKeysByAxis.get(d.area.id) ?? EMPTY_KEY_SET}
              manualKeys={manualKeysByArea.get(parent.id) ?? EMPTY_KEY_SET}
              patternResolutions={patternResolutionsByArea.get(parent.id) ?? EMPTY_RESOLUTIONS}
              catalog={scopedCatalog}
              busNameLookup={busNameLookup}
              busColorLookup={busColorLookup}
              ecuLookup={ecuLookup}
              valueFormats={valueFormats}
              resolveColor={resolveColor}
              panelElementId={elementId}
              />
            </Fragment>
          );
        })}
      </div>

      {measEnabled && (
        <PlotMeasurementStrip
          measKeys={measKeys}
          cursorX={cursorX}
          plottedSignals={plottedSignals}
          seriesFor={seriesFor}
          fmtPos={fmtPos}
        />
      )}

    </div>
  );
}

