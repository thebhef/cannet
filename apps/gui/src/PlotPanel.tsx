import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { isEnumValueTable, type Bus, type SignalDescriptorRecord, type SignalExtent, type ValueTableEntryRecord } from "./types";
import { useTraceData } from "./traceData";
import { useProjectContext } from "./projectContext";
import { defaultBusColor } from "./busColor";
import {
  type ColorResolver,
  type ColorTarget,
  buildColorResolver,
  colorMapLaneFill,
} from "./colorMap";
import { useElementRegistry } from "./projectElements";
import { useTrace } from "./trace";
import { TraceControls } from "./TraceControls";
import { useNotes } from "./notesContext";
import { TRUNCATION_EVENT_ID } from "./notes";
import { GOTO_EVENT, type GotoPayload } from "./gotoEvent";
import { enumSegments, groupScaleRanges, mergeSeries, signalKey } from "./plotData";
import { followXWindow } from "./followWindow";
import { showPointsFromRaw, showPointsToUplot, type ShowPointsMode } from "./plotPoints";
import { Combobox, type ComboboxOption } from "./Combobox";
import { elementLabel } from "./elementLabel";
import { formatDurationSeconds, formatElapsed, fracDigitsForSpan } from "./format";
import { usePanelCommands } from "./panelCommands";
import { SourcesMenuSection } from "./SourcesPicker";
import {
  DEFAULT_MEASUREMENTS,
  MEASUREMENT_QUANTITIES,
  type MeasurementKey,
  type PanelHover,
  type Series,
  centerWindowOn,
  isMeasurementKey,
  nextHover,
  statsOver,
  valueAt,
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
 * plus a **side signal panel**: per signal a colour swatch (click to
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
 * colour is assigned on add and travels with it (re-ordering / moving
 * doesn't recolour).
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
 * range control); "fit data" refits x to the full signal extent;
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
 * lines; "+ note" drops one. Renaming, recolouring, removing, and
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

/** The colour wheel used to seed a new series' colour. Per ADR 0026
 * task 15 the wheel is at least 16 colours deep; the index for a
 * fresh series is `(signals already in that plot area) % len`, so
 * the first 16 series in any one area get distinct hues. */
const TRACE_COLORS = [
  "#c6f24e",
  "#4ecbff",
  "#ffaa3d",
  "#b48cff",
  "#ff7e5a",
  "#ffd93d",
  "#5ddb7c",
  "#e15dcf",
  "#8ce0d4",
  "#ff9bd2",
  "#a0bfff",
  "#d0ff7a",
  "#ff6b6b",
  "#7be3ff",
  "#ffcf85",
  "#c39bff",
];
const CURSOR_A_COLOR = "#ffd93d";
const CURSOR_B_COLOR = "#ff5577";
/// The mouse crosshair's line colour — uPlot's default cursor grey, kept
/// now that the line is drawn by the panel's own overlay (in *every*
/// stacked area, at the shared hover x) instead of uPlot's per-instance
/// native cursor.
const CROSSHAIR_COLOR = "#607d8b";
const EVENT_COLOR = "#4ecbff";
/// The derived truncation marker's cursor colour (ADR 0035) — a muted
/// amber, distinct from the note-event blue. Matches the trace floor row.
const TRUNCATION_COLOR = "#e0a030";
const AXIS_STROKE = "#cbd5e1";
const AXIS_GRID = "#222b35";
const AXIS_TICKS = "#3a4654";
const ZOOM_STEP = 1.15;
/** Floor for `sample_signals`' `max_points` (the host min/max-decimates
 * to at most `2 * max_points`). We ask for ~1× the canvas width — 2
 * points per pixel after the host's 2× envelope, the full resolution a
 * min/max plot can show; the floor catches early-mount cases where
 * `clientWidth` is still small. */
const MIN_DECIMATION_POINTS = 200;
/** Plot update-rate options (Hz) offered in the toolbar, and the
 * default. Lower = less CPU under a fast capture; the re-sample loop is
 * self-paced (next tick scheduled after the previous finishes), so a
 * slow tick just lowers the realised rate further. */
const RATE_OPTIONS = [5, 10, 15, 30, 60] as const;
const RATE_COMBO_OPTIONS: ComboboxOption[] = RATE_OPTIONS.map((hz) => ({
  value: String(hz),
  label: `${hz} Hz`,
}));
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
const DEFAULT_MAX_RATE_HZ = 15;
/** Width (seconds) of the follow-live x-window before the user has set
 * one by zooming/panning. The window grows from t=0 up to this and then
 * slides; once the user picks a width, that width is what follow-live
 * keeps. */
const DEFAULT_FOLLOW_WIDTH_SECONDS = 10;

type CursorMode = "off" | "x" | "y" | "note";

export interface SignalRef {
  /** Logical bus this signal is bound to. `null` is the legacy
   * "any bus" path — kept so plots from projects that pre-date
   * per-bus signal binding still sample. New picks always carry a
   * concrete `busId`. */
  busId: string | null;
  messageId: number;
  extended: boolean;
  signalName: string;
  messageName: string;
  unit: string;
  /** Plot colour — assigned when the signal is added and carried with
   * it (so re-ordering / moving between areas doesn't recolour it). */
  color: string;
  /** Hidden = line not drawn on the plot (swatch dimmed); the
   * side-panel value still updates. Absent ⇒ visible. */
  hidden?: boolean;
}

export interface PlotAreaConfig {
  id: string;
  signals: SignalRef[];
  /** How the area's series lay out across axes (ADR 0026). `unified`
   * (default) draws one axis with all series overlaid; `per-unit`
   * stacks one axis per unit (each enum series gets its own); and
   * `individual` stacks one axis per series. Y scales are always
   * auto-derived (no fixed-range option). */
  yAxisMode?: YAxisMode;
  /** Which signal's raw range / unit drives the y-axis labels for this
   * area. `null` falls back to the first non-hidden signal — that's
   * what `primarySignalForArea` resolves it to. Click a signal row in
   * the side panel to promote that signal to primary. */
  primarySignalKey?: string | null;
  /** Filter-defined plot area (ADR 0020): when present, this
   * area is in **filter mode** — its `signals` list is *computed* from
   * every catalog signal whose `${busName}.${messageName}.${signalName}`
   * matches the regex (case-sensitive JS `RegExp`). The persisted
   * `signals` list is left untouched while in filter mode so toggling
   * back to manual mode promotes the computed set without losing the
   * user's last manual selection.
   *
   * Mode-exclusive — see ADR 0020. The UI disables "add signal" while
   * a filter is set, and the regex editor takes the place of the
   * manual signals list. */
  signalFilter?: string;
}

interface NoteEvent {
  id: string;
  /** Time in display-relative seconds. */
  t: number;
  label: string;
  /** Cursor colour; defaults to the note event blue. The derived
   *  truncation marker (ADR 0035) overrides it. */
  color?: string;
}

interface XCursors {
  a: number | null;
  b: number | null;
}

interface PlotPanelParams {
  elementId?: unknown;
  areas?: unknown;
  followLive?: unknown;
  cursorMode?: unknown;
  measEnabled?: unknown;
  measKeys?: unknown;
  showDiag?: unknown;
  cursorX?: unknown;
  cursorYByArea?: unknown;
  // `notes` retired from panel params — see the session-scoped notes
  // store. A tolerant parser ignores the extra field on older blobs.
  maxRateHz?: unknown;
  signalsWidthPx?: unknown;
  showPoints?: unknown;
}

/** Per-area side-panel width range (pixels). Default and clamps for
 * the user-resizable column. */
const SIGNALS_WIDTH_DEFAULT = 220;
const SIGNALS_WIDTH_MIN = 120;
const SIGNALS_WIDTH_MAX = 600;

function signalsWidthFromRaw(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return SIGNALS_WIDTH_DEFAULT;
  return Math.max(SIGNALS_WIDTH_MIN, Math.min(SIGNALS_WIDTH_MAX, Math.round(v)));
}

/** A persisted max-rate value, clamped to one of {@link RATE_OPTIONS}. */
function maxRateFromRaw(v: unknown): number {
  return typeof v === "number" && (RATE_OPTIONS as readonly number[]).includes(v) ? v : DEFAULT_MAX_RATE_HZ;
}

/** The shared current x-window + a suppress flag so a programmatic
 * scale change doesn't bounce back through an area's `setScale` hook
 * as "the user zoomed". `xMin`/`xMax` are `null` until the first data
 * establishes a window. */
interface XSync {
  suppress: boolean;
  xMin: number | null;
  xMax: number | null;
}

function signalRefKey(s: SignalRef): string {
  return signalKey(s.busId, s.messageId, s.extended, s.signalName);
}

function isSignalRefCore(v: unknown): v is Omit<SignalRef, "color"> {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  // `busId` is the new field. Old saved layouts (no `busId`) load
  // with `busId: null`, the legacy "any bus" path.
  return (
    typeof o.messageId === "number" &&
    typeof o.extended === "boolean" &&
    typeof o.signalName === "string" &&
    typeof o.messageName === "string" &&
    typeof o.unit === "string" &&
    (o.busId == null || typeof o.busId === "string")
  );
}
function withColor(
  s: Omit<SignalRef, "color"> & { color?: unknown; busId?: unknown },
  fallbackIdx: number,
): SignalRef {
  return {
    ...s,
    busId: typeof s.busId === "string" ? s.busId : null,
    color:
      typeof s.color === "string" ? s.color : TRACE_COLORS[fallbackIdx % TRACE_COLORS.length],
  };
}

/** Drag-and-drop MIME for a `SignalRef` (within or across plot panels —
 * the payload is the full ref so the receiving panel can add it even if
 * it's not one of its own signals). The mime + parser are hoisted
 * into [`dragSignals.ts`](./dragSignals.ts) so the DBC panel and the
 * trace / by-id signal rows can produce the same payload shape. */
import {
  SIGNAL_DND_MIME,
  parseSignalDragData,
  setSignalDragData,
} from "./dragSignals";

/** Parse a drop event's mime data into colored `SignalRef`s + the
 * source panel id (when the payload set one). The plot panel uses
 * `sourcePanelId` to discriminate:
 *
 * - `sourcePanelId === this panel's elementId` → drag started inside
 *   this panel → **move** semantics (reorder / shift between areas).
 * - Otherwise (DBC panel, trace cell, by-id cell, a different plot
 *   panel) → **add** semantics: drop a fresh copy without disturbing
 *   the source. */
function parseDroppedSignals(s: string): {
  refs: SignalRef[];
  sourcePanelId: string | null;
} {
  const parsed = parseSignalDragData(s);
  return {
    refs: parsed.signals.map((r, i) => withColor(r, i)),
    sourcePanelId: parsed.sourcePanelId,
  };
}

function areasFromParams(raw: unknown): PlotAreaConfig[] {
  if (Array.isArray(raw)) {
    const out: PlotAreaConfig[] = [];
    for (const a of raw) {
      if (typeof a !== "object" || a === null) continue;
      const o = a as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : crypto.randomUUID();
      const signals = (Array.isArray(o.signals) ? o.signals.filter(isSignalRefCore) : []).map((s, i) => withColor(s, i));
      // `yMode` from a v7-and-earlier panel is ignored — y scales are
      // always auto-derived (ADR 0026). The field is tolerated on
      // parse so old projects don't reject; saving drops it.
      out.push({
        id,
        signals,
        yAxisMode: yAxisModeFromRaw(o.yAxisMode),
        primarySignalKey: typeof o.primarySignalKey === "string" ? o.primarySignalKey : null,
        signalFilter: typeof o.signalFilter === "string" ? o.signalFilter : undefined,
      });
    }
    if (out.length > 0) return out;
  }
  return [{ id: crypto.randomUUID(), signals: [], primarySignalKey: null }];
}

function cursorModeFromRaw(raw: unknown): CursorMode {
  return raw === "x" || raw === "y" || raw === "note" ? raw : "off";
}

function measKeysFromRaw(raw: unknown): MeasurementKey[] {
  if (Array.isArray(raw)) {
    const ks = raw.filter(isMeasurementKey);
    if (ks.length > 0) return ks;
  }
  return [...DEFAULT_MEASUREMENTS];
}

function fmtFreq(hz: number | null | undefined): string {
  if (hz == null || !Number.isFinite(hz)) return "—";
  if (Math.abs(hz) >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (Math.abs(hz) >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${hz.toFixed(2)} Hz`;
}
function fmtVal(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toPrecision(6);
}
/** Compact tick formatter for the y-axis: 3 significant figures
 * normally, scientific for very small / very large, trims trailing
 * zeros so "1.00" → "1". Distinct from `fmtVal` (6 sig figs) because
 * tick labels have to fit in the axis's fixed 52 px column. */
function fmtTickValue(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return v.toExponential(1);
  return parseFloat(v.toPrecision(3)).toString();
}

/** Width (px) the y-axis needs to fit `values` plus tick mark and
 * padding. Used by uPlot's `axis.size` to grow the gutter when a
 * primary signal produces wide labels (e.g. `1.23e+5 degC`). Reuses a
 * single offscreen 2d context — cheap to call per layout pass. */
let axisMeasureCtx: CanvasRenderingContext2D | null = null;
/** Must match the axis `font` in `axisCommon` below — measurement is
 * meaningless if the font differs from what uPlot actually paints. */
const AXIS_FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
function measureAxisSize(values: string[] | null | undefined): number {
  if (!values || values.length === 0) return 52;
  if (axisMeasureCtx == null) {
    const c = document.createElement("canvas").getContext("2d");
    if (!c) return 80;
    axisMeasureCtx = c;
  }
  axisMeasureCtx.font = AXIS_FONT;
  let widest = 0;
  for (const s of values) {
    const w = axisMeasureCtx.measureText(s).width;
    if (w > widest) widest = w;
  }
  // Tick mark + label gap + a few px of breathing room so the longest
  // label doesn't kiss the canvas edge. Floor at 52 so a bare `0`-only
  // axis doesn't collapse.
  return Math.max(52, Math.ceil(widest) + 18);
}
function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function elementIdFromParams(raw: unknown): string {
  const o = raw as { elementId?: unknown } | undefined;
  return typeof o?.elementId === "string" ? o.elementId : crypto.randomUUID();
}

// Filter helpers live in `./plotFilter` so the pure-logic
// tests can import them without dragging uplot into a jsdom run.
import { applyAreaFilters } from "./plotFilter";
import { deriveAxesForArea, type YAxisMode } from "./plotAxisDerivation";
import { useDecimatedRange } from "./useDecimatedRange";
import { diagCount } from "./diag"; // DIAG

const Y_AXIS_MODES: YAxisMode[] = ["unified", "per-unit", "individual"];
const Y_AXIS_MODE_OPTIONS: ComboboxOption[] = Y_AXIS_MODES.map((m) => ({ value: m, label: m }));
function yAxisModeFromRaw(v: unknown): YAxisMode {
  return v === "per-unit" || v === "individual" ? v : "unified";
}

export function PlotPanel(props: IDockviewPanelProps) {
  diagCount("render.PlotPanel"); // DIAG
  const data = useTraceData();
  const { dbcPaths, buses } = useProjectContext();
  const registry = useElementRegistry();
  const { ensure } = registry;

  const params = props.params as PlotPanelParams | undefined;
  const [elementId] = useState(() => elementIdFromParams(params));
  useEffect(() => {
    ensure(elementId, "plot");
  }, [ensure, elementId]);
  // Hydrate the state initializers below from the config persisted on
  // the *element* (survives closing and reopening this panel within a
  // session); fall back to the dockview `params` for older projects and
  // the unsaved-workspace `localStorage` layout, which still carry it
  // there. Read once at mount — `registry.get` resolves synchronously
  // because the element is restored before its panel mounts (project
  // open) or already exists (Elements-list reopen / fresh add).
  const [savedConfig] = useState<PlotPanelParams | undefined>(() => {
    const cfg = (registry.get(elementId)?.element as { config?: PlotPanelParams } | undefined)?.config;
    return cfg ?? params;
  });
  const plotElement = registry.get(elementId)?.element;
  // `sources` may be missing on a legacy mocked element (test
  // fixture) or an old project that hasn't gone through
  // `normalizeElement` yet — fall back to the wildcard so the picker
  // renders the default-all state instead of crashing.
  const currentSources =
    plotElement &&
    plotElement.kind !== "transmit" &&
    plotElement.kind !== "rbs" &&
    plotElement.kind !== "colormap"
      ? plotElement.sources ?? ["*"]
      : ["*"];
  const availableFilters = useMemo(
    () =>
      registry.entries
        .filter((e) => e.element.kind === "filter")
        .map((e) => ({ id: e.element.id, label: elementLabel(e.element) })),
    [registry.entries],
  );
  const handleSourcesChange = useCallback(
    (next: string[]) => registry.update(elementId, { sources: next }),
    [registry, elementId],
  );
  const trace = useTrace(data, elementId);
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
  const [maxRateHz, setMaxRateHz] = useState(() => maxRateFromRaw(savedConfig?.maxRateHz));
  const resampleIntervalMs = Math.max(1, Math.round(1000 / maxRateHz));
  const [showPoints, setShowPoints] = useState<ShowPointsMode>(() => showPointsFromRaw(savedConfig?.showPoints));
  /** Pixel width of every area's side panel — user-resizable via a
   * drag handle, persisted in panel config. */
  const [signalsWidth, setSignalsWidth] = useState(() => signalsWidthFromRaw(savedConfig?.signalsWidthPx));
  const [focusedAreaId, setFocusedAreaId] = useState<string>(() => areas[0]?.id ?? "");
  const [catalog, setCatalog] = useState<SignalDescriptorRecord[]>([]);

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
  // reported up from each area's windowed source via `onReportBase`).
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
  const [perfMs, setPerfMs] = useState(0);
  /** Server-side wall-clock of the worst recent `sample_signals` call
   * — `slice_matching_many` (lock-held clone) + decode + decimate.
   * Compare with `perfMs` to see how much of the total resample cost
   * is host work vs JS / IPC. */
  const [hostMs, setHostMs] = useState(0);
  const [rateHz, setRateHz] = useState(0);
  /** Per-area count of frames in the trace's current window, max
   * across areas — a quick read of "is the trace actually windowing
   * frames?" (`0` ⇒ stopped / zero-width). */
  const winFrames = winEnd - winStart;
  /** Per-area total of cached signal points (max across areas / signals),
   * fed by `reportCache`. `0` after a fresh signal-set / re-anchor;
   * grows as the resample fills the cache. */
  const [cachePts, setCachePts] = useState(0);
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;

  // Shared x-window + the per-area uPlot registry + the per-area data
  // extent (longest plotted signal across the panel) and window-start
  // (session-relative time of each area's first frame — the x-window's
  // floor, ADR 0024).
  const xSyncRef = useRef<XSync>({ suppress: false, xMin: null, xMax: null });
  const instancesRef = useRef<Map<string, uPlot>>(new Map());
  const extentByAreaRef = useRef<Map<string, number>>(new Map());
  const startByAreaRef = useRef<Map<string, number>>(new Map());

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
    }
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
    (min: number, max: number, fromId: string) => {
      // DIAG: fires only on a real user pan/zoom — if this spins
      // during the freeze, the setScale suppression window is being
      // missed and the x-sync ring (applyXAll → setScale hook →
      // onUserXChange) is the loop.
      diagCount("plot.userXChange"); // DIAG
      applyXAll(min, max, fromId);
      setFollowLive(false);
      bumpXEpoch();
    },
    [applyXAll, bumpXEpoch],
  );

  // An area finished a re-sample: update the panel's data extent and
  // reposition the shared x-window per `followXWindow` — slide to the live
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
  const onAreaResampled = useCallback(
    (areaId: string, firstT: number | null, lastT: number | null) => {
      diagCount("plot.areaResampled"); // DIAG
      if (lastT != null) extentByAreaRef.current.set(areaId, lastT);
      else extentByAreaRef.current.delete(areaId);
      if (firstT != null) startByAreaRef.current.set(areaId, firstT);
      else startByAreaRef.current.delete(areaId);
      const ext = sharedExtent();
      if (ext == null) return;
      const sync = xSyncRef.current;
      const win = followXWindow(
        followLiveRef.current,
        runningRef.current,
        sync.xMin,
        sync.xMax,
        ext,
        DEFAULT_FOLLOW_WIDTH_SECONDS,
        sharedStart(),
      );
      if (win) applyXAll(win.min, win.max, null);
    },
    [sharedExtent, sharedStart, applyXAll],
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

  const fitData = useCallback(() => {
    const ext = sharedExtent();
    // Fit the full span from the window's session-relative start (ADR
    // 0024 — a Clear re-anchors but doesn't re-zero), not a literal 0.
    const start = sharedStart();
    applyXAll(start, ext != null && ext > start ? ext : start + 1, null);
    setResetYEpoch((n) => n + 1);
    bumpXEpoch();
  }, [sharedExtent, sharedStart, applyXAll, bumpXEpoch]);

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
  const prevCountRef = useRef(data.count);
  useEffect(() => {
    if (prevCountRef.current > 0 && data.count === 0) {
      setCursorX({ a: null, b: null });
      setCursorYByArea({});
    }
    prevCountRef.current = data.count;
  }, [data.count]);

  useEffect(() => {
    if (!areas.some((a) => a.id === focusedAreaId)) setFocusedAreaId(areas[0]?.id ?? "");
  }, [areas, focusedAreaId]);

  const { api } = props;
  const { update } = registry;
  useEffect(() => {
    // `notes` is no longer persisted on the panel — it's
    // session-scoped in the host.
    const config = {
      areas,
      followLive,
      cursorMode,
      measEnabled,
      measKeys,
      showDiag,
      cursorX,
      cursorYByArea,
      maxRateHz,
      signalsWidthPx: signalsWidth,
      showPoints,
    };
    // Dual-write: onto the element (survives panel close + reopen and is
    // what `Save` serializes) and into the dockview `params` (the
    // unsaved-workspace `localStorage` layout restores from `params` on
    // app restart, and it doesn't persist the registry). The element's
    // no-op patch check is deep, so a mount whose state already equals
    // the stored config doesn't churn the registry or mark dirty.
    update(elementId, { config });
    api.updateParameters({ elementId, ...config });
  }, [
    api,
    update,
    elementId,
    areas,
    followLive,
    cursorMode,
    measEnabled,
    measKeys,
    showDiag,
    cursorX,
    cursorYByArea,
    maxRateHz,
    signalsWidth,
    showPoints,
  ]);

  const refreshCatalog = useCallback(() => {
    void invoke<SignalDescriptorRecord[]>("list_signals", {
      // The host expands unscoped DBCs to one record per project
      // bus, so the picker can offer the same signal on each bus the
      // DBC applies to.
      projectBuses: buses.map((b) => b.id),
    }).then(setCatalog);
  }, [buses]);
  useEffect(refreshCatalog, [refreshCatalog, dbcPaths, buses]);

  // Re-fetch the signal catalog when the host's
  // filesystem watcher reports a DBC change. Filter-mode plot areas
  // re-evaluate automatically off the new `catalog`.
  useEffect(() => {
    const unlisten = listen<string>("dbc-changed", () => {
      refreshCatalog();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshCatalog]);

  // --- area ops ---
  const addArea = useCallback(() => {
    setAreas((prev) => {
      const next: PlotAreaConfig = { id: crypto.randomUUID(), signals: [], primarySignalKey: null };
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
  const setAreaYAxisMode = useCallback((id: string, mode: YAxisMode) => {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, yAxisMode: mode } : a)));
  }, []);
  const setAreaPrimarySignal = useCallback((id: string, key: string | null) => {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, primarySignalKey: key } : a)));
  }, []);

  /// Set or clear an area's regex filter. `undefined` reverts the
  /// area to manual mode (per ADR 0020, the most recently computed
  /// signals list becomes the new manual list — the persisted
  /// `area.signals` is left untouched while in filter mode so the
  /// user's earlier manual selection survives a filter-on toggle as
  /// long as they didn't explicitly promote-and-clear). Setting a
  /// string enters filter mode; the renderer computes the signals
  /// from the catalog at every change to `catalog`, `buses`, or the
  /// regex itself.
  const setAreaSignalFilter = useCallback(
    (id: string, signalFilter: string | undefined) => {
      setAreas((prev) =>
        prev.map((a) => (a.id === id ? { ...a, signalFilter } : a)),
      );
    },
    [],
  );

  /// Promote a filter-mode area's currently computed signals into
  /// the persisted manual list, then clear `signalFilter` so the
  /// area is in manual mode. Called by the "switch to manual" path:
  /// the user's mental "this is the set I want" survives the mode
  /// switch instead of vanishing.
  const promoteFilterToManual = useCallback(
    (id: string, computed: SignalRef[]) => {
      setAreas((prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, signals: computed, signalFilter: undefined }
            : a,
        ),
      );
    },
    [],
  );

  const addSignalToFocused = useCallback(
    (desc: SignalDescriptorRecord) => {
      setAreas((prev) => {
        const targetId = prev.some((a) => a.id === focusedAreaId) ? focusedAreaId : prev[0]?.id;
        // Filter-mode areas (ADR 0020) manage their signals via the
        // regex — manual add is a no-op so the regex stays the
        // source of truth. The toolbar dropdown is already disabled
        // for this case; the guard is here for any other code path
        // that might call this.
        const target = prev.find((a) => a.id === targetId);
        if (target?.signalFilter != null) return prev;
        // Colour-wheel index is the count of signals *already in this
        // plot area*, per ADR 0026 — so the first 16 series in any
        // one area get distinct hues regardless of what other areas
        // hold.
        const seedIdx = target?.signals.length ?? 0;
        const ref: SignalRef = {
          busId: desc.bus_id,
          messageId: desc.message_id,
          extended: desc.extended,
          signalName: desc.signal_name,
          messageName: desc.message_name,
          unit: desc.unit,
          color: TRACE_COLORS[seedIdx % TRACE_COLORS.length],
        };
        const key = signalRefKey(ref);
        if (prev.some((a) => a.signals.some((s) => signalRefKey(s) === key))) return prev;
        return prev.map((a) => (a.id === targetId ? { ...a, signals: [...a.signals, ref] } : a));
      });
    },
    [focusedAreaId],
  );
  const removeSignal = useCallback((areaId: string, key: string) => {
    setAreas((prev) =>
      prev.map((a) => {
        if (a.id !== areaId) return a;
        // Filter-mode area: signals are computed; ignore manual
        // remove gestures.
        if (a.signalFilter != null) return a;
        return { ...a, signals: a.signals.filter((s) => signalRefKey(s) !== key) };
      }),
    );
  }, []);
  // A signal was dropped into `toAreaId`. Drop semantics depend on
  // where the drag started (carried as `isInternalMove`):
  //
  // - **Internal move** (drag started inside this panel): strip the
  //   ref from whichever area it was in and re-insert it at the new
  //   position (preserving colour). Re-orders within a single area,
  //   or moves between areas of this panel.
  // - **External add** (drag from DBC panel, trace cell, by-id
  //   cell, or another plot panel): insert into the target area
  //   without touching other areas — the same signal can live in
  //   multiple areas and the source is left alone. If the target
  //   area already has the same signal, drop is a no-op (no
  //   duplicates within one area).
  //
  // Filter-mode target areas reject the drop (manual signal
  // management is disabled in filter mode — ADR 0020).
  const placeSignal = useCallback(
    (ref: SignalRef, toAreaId: string, beforeKey: string | null, isInternalMove: boolean) => {
      const key = signalRefKey(ref);
      if (beforeKey === key) return; // dropped a row on itself — no-op
      setAreas((prev) => {
        const target = prev.find((a) => a.id === toAreaId);
        if (target == null || target.signalFilter != null) return prev;
        if (isInternalMove) {
          // Move: the ref already lives in some area of this panel.
          // Strip it from its origin area (could be the target — that's
          // a reorder), and insert at the new position. Preserves the
          // original colour by reusing the in-state ref.
          const existing = prev.flatMap((a) => a.signals).find((s) => signalRefKey(s) === key);
          const moved = existing ?? ref;
          const stripped = prev.map((a) =>
            a.signalFilter == null
              ? { ...a, signals: a.signals.filter((s) => signalRefKey(s) !== key) }
              : a,
          );
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
        // Re-seed the colour from the *target area's* wheel index, per
        // ADR 0026: a dragged-in series picks the colour at the
        // position equal to the count of series already in the area.
        // Cross-panel drags preserve the source ref's colour
        // (`parseDroppedSignals` passes it through as-is), which we
        // discard here so the wheel index is consistent regardless of
        // where the drag started.
        const seedIdx = target.signals.length;
        const seeded: SignalRef = { ...ref, color: TRACE_COLORS[seedIdx % TRACE_COLORS.length] };
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
  /** Set a series' colour after it's been added (per ADR 0026). Touches
   * only the named signal's `color` field; everything else (order,
   * hidden, primary-signal selection) stays put. Filter-mode areas
   * mutate the *computed* `signals` array — the colour change is
   * effectively session-only there because the next catalog re-eval
   * rebuilds the list; that matches the existing hidden-flag behaviour
   * documented in `toggleSignalHidden`. */
  const setSignalColor = useCallback((areaId: string, key: string, color: string) => {
    setAreas((prev) =>
      prev.map((a) =>
        a.id === areaId
          ? { ...a, signals: a.signals.map((s) => (signalRefKey(s) === key ? { ...s, color } : s)) }
          : a,
      ),
    );
  }, []);
  const toggleSignalHidden = useCallback((areaId: string, key: string) => {
    // Hidden flag toggles even in filter mode — it's display-only
    // and doesn't mutate the set the regex defines. The hidden flag
    // lives on the computed `SignalRef[]`, which is rebuilt on
    // every catalog change, so toggles only stick for the current
    // panel session. That's acceptable for a temporary "hide this
    // line while I look at the others" gesture.
    setAreas((prev) =>
      prev.map((a) =>
        a.id === areaId
          ? { ...a, signals: a.signals.map((s) => (signalRefKey(s) === key ? { ...s, hidden: !s.hidden } : s)) }
          : a,
      ),
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
      dispatchAddNote(crypto.randomUUID(), timestampNs, `note ${sessionNotes.length + 1}`);
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
        DEFAULT_FOLLOW_WIDTH_SECONDS,
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
  const reportPerf = useCallback((_areaId: string, ms: number) => setPerfMs((p) => Math.max(p * 0.6, ms)), []);
  const reportHostMs = useCallback((_areaId: string, ms: number) => setHostMs((p) => Math.max(p * 0.6, ms)), []);
  const reportRate = useCallback((_areaId: string, hz: number) => setRateHz((p) => Math.max(p * 0.7, hz)), []);
  const reportCache = useCallback((_areaId: string, n: number) => setCachePts(n), []);
  const reportBase = useCallback(
    (_areaId: string, secs: number | null) => setBaseSeconds(secs),
    [],
  );
  // Mirror the x-axis origin into a ref for the goto listener (above), which
  // subscribes once and so can't close over the live state value.
  useEffect(() => {
    baseSecondsRef.current = baseSeconds;
  }, [baseSeconds]);

  const busNameLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of buses) m.set(b.id, b.name);
    return m;
  }, [buses]);

  // Bus id → render colour (explicit `color`, else the palette colour
  // for the bus's list position) — mirrors `effectiveBusColor` so the
  // swatch in a signal row matches the bus's graph colour.
  const busColorLookup = useMemo(() => {
    const m = new Map<string, string>();
    buses.forEach((b, i) => m.set(b.id, b.color ?? defaultBusColor(i)));
    return m;
  }, [buses]);

  // Signal value→colour maps (ADR 0029): one resolver over every
  // colormap element, fed to each area so an enum lane box can be tinted
  // by its held value. Rebuilt only when the element set changes.
  const resolveColor = useMemo(
    () => buildColorResolver(registry.entries.map((e) => e.element)),
    [registry.entries],
  );

  /// Areas with `signalFilter` resolved into a computed `signals`
  /// list (ADR 0020). For manual areas this is identical to the
  /// stored `area`. For filter areas the `signals` field is replaced
  /// with the regex's match set against the catalog. Storage state
  /// (`areas`) is unchanged so toggling back to manual restores the
  /// last manually-managed list.
  const effectiveAreas = useMemo(
    () => applyAreaFilters(areas, catalog, busNameLookup),
    [areas, catalog, busNameLookup],
  );

  /// Expand each effective area into one or more derived axes, based on
  /// the area's `yAxisMode` (ADR 0026). Unified produces one entry per
  /// area (identical to today); per-unit groups signals by unit; and
  /// individual is one entry per signal. Each derived entry carries
  /// the parent area so panel-level callbacks (add signal, set primary,
  /// set mode, remove area) can route to the right place.
  const derivedAreaConfigs = useMemo(() => {
    const out: Array<{
      area: PlotAreaConfig;
      parentArea: PlotAreaConfig;
      isFirstOfParent: boolean;
      subtitle: string | null;
    }> = [];
    for (const a of effectiveAreas) {
      const mode = a.yAxisMode ?? "unified";
      const axes = deriveAxesForArea(a.id, a.signals, mode);
      axes.forEach((ax, i) => {
        // The derived `PlotAreaConfig` carries the axis's slice of
        // signals. `signalFilter` is preserved only on the first
        // derived axis so the filter UI / status bar doesn't render N
        // times for one logical area.
        const derivedArea: PlotAreaConfig = {
          id: ax.id,
          signals: ax.signals,
          yAxisMode: a.yAxisMode,
          primarySignalKey: a.primarySignalKey,
          signalFilter: i === 0 ? a.signalFilter : undefined,
        };
        out.push({
          area: derivedArea,
          parentArea: a,
          isFirstOfParent: i === 0,
          subtitle: ax.subtitle,
        });
      });
    }
    return out;
  }, [effectiveAreas]);

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
    for (const a of effectiveAreas) {
      if (a.signalFilter == null) continue;
      const count = a.signals.length;
      next.set(a.id, count);
      const wasCount = prev.get(a.id);
      if (busesChanged && wasCount != null && wasCount > 0 && count === 0) {
        void invoke("gui_emit_system_log", {
          level: "warn",
          source: "plot",
          message: `Plot panel filter "${a.signalFilter}" no longer matches any signal — a bus rename or removal invalidated it.`,
        }).catch(() => {
          /* best effort — the panel still renders correctly */
        });
      }
    }
    lastMatchCountsRef.current = next;
    lastBusesRef.current = buses;
  }, [effectiveAreas, buses]);
  const catalogOptions = useMemo(
    () =>
      catalog.map((s) => {
        const busLabel =
          s.bus_id == null
            ? null
            : busNameLookup.get(s.bus_id) ?? s.bus_id;
        return {
          value: signalKey(s.bus_id, s.message_id, s.extended, s.signal_name),
          // The bus → message ancestry renders as combobox group
          // headers, so two signals named the same on different buses
          // are pickable separately and the message name explicitly
          // groups its signals.
          path: busLabel ? [busLabel, s.message_name] : [s.message_name],
          label: `${s.signal_name}${s.unit ? ` [${s.unit}]` : ""}`,
          desc: s,
        };
      }),
    [catalog, busNameLookup],
  );
  const areaLabels = useMemo(() => new Map(areas.map((a, i) => [a.id, `Area ${i + 1}`])), [areas]);

  // Iterate the *derived* axes, not the parent areas: `reportSeries`
  // stores each axis's sampled series under its derived id (which in
  // per-unit / individual mode differs from the parent's), so the
  // measurement strip's `seriesFor(areaId, key)` lookups must use the
  // same ids. Each signal lives in exactly one derived axis of its
  // parent, so this enumerates every plotted signal exactly once.
  const plottedSignals = useMemo(() => {
    const out: Array<{ key: string; ref: SignalRef; color: string; areaId: string }> = [];
    for (const d of derivedAreaConfigs) {
      for (const s of d.area.signals) out.push({ key: signalRefKey(s), ref: s, color: s.color, areaId: d.area.id });
    }
    return out;
  }, [derivedAreaConfigs]);
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
      // Carry the note's colour (ADR 0035) so its cursor matches the trace
      // and events panel; `undefined` falls back to the default event blue.
      color: n.color ?? undefined,
    }));
  }, [sessionNotes, baseSeconds]);
  // The derived truncation marker (ADR 0035) as a plot cursor, when the
  // disk-spill store has truncated the oldest history (`firstIndex > 0`).
  const truncation = useMemo<NoteEvent | null>(() => {
    if (baseSeconds == null || data.truncationTsNs == null) return null;
    return {
      id: TRUNCATION_EVENT_ID,
      t: data.truncationTsNs / 1e9 - baseSeconds,
      label: "history truncated here",
      color: TRUNCATION_COLOR,
    };
  }, [data.truncationTsNs, baseSeconds]);
  const events = useMemo<NoteEvent[]>(
    () => [
      { id: "__t0", t: 0, label: "T0" },
      ...notes,
      ...(truncation ? [truncation] : []),
    ],
    [notes, truncation],
  );
  const dt = cursorX.a != null && cursorX.b != null ? cursorX.b - cursorX.a : null;
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
  useEffect(() => {
    if (toolbarMenuAt == null) return;
    const onDown = (e: MouseEvent) => {
      // Outside-click dismiss. The menu element stops its own
      // `mousedown` from bubbling, so any down that reaches the
      // document is by definition outside.
      if ((e.target as Element | null)?.closest(".plot-toolbar-menu") == null) {
        setToolbarMenuAt(null);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setToolbarMenuAt(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [toolbarMenuAt]);

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
        />
        <span className="plot-toolbar-sep" />
        <Combobox
          options={catalogOptions}
          value=""
          onChange={(v) => {
            const opt = catalogOptions.find((o) => o.value === v);
            if (opt) addSignalToFocused(opt.desc);
          }}
          placeholder={catalog.length === 0 ? "no DBC attached" : "add signal…"}
          ariaLabel="add signal to focused plot area"
        />
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
        <label className="plot-cursor-ctl" title="cap how often the plot re-samples — lower it under a fast capture">
          max
          <Combobox
            options={RATE_COMBO_OPTIONS}
            value={String(maxRateHz)}
            onChange={(v) => setMaxRateHz(Number(v))}
          />
        </label>
        <span
          className="plot-perf"
          title="update rate · worst recent resample (host slice + decode in parens) · device pixel ratio · frames in trace window · cached plot points (biggest area)"
        >
          {live && rateHz > 0 ? `${Math.round(rateHz)} Hz` : "—"} ·{" "}
          {perfMs > 0 ? `${perfMs.toFixed(0)} ms` : "—"}
          {hostMs > 0 ? ` (${hostMs.toFixed(0)} host)` : ""} · dpr {dpr.toFixed(2)} · win{" "}
          {fmtCount(winFrames)} · cache {fmtCount(cachePts)}
        </span>
      </div>
      {toolbarMenuAt && (
        <div
          className="plot-toolbar-menu"
          role="menu"
          style={{ left: toolbarMenuAt.x, top: toolbarMenuAt.y }}
          onMouseDown={(e) => e.stopPropagation()}
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
          return (
            <PlotArea
              key={d.area.id}
              area={d.area}
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
              // Per-axis chrome (y-axis-mode selector, filter editor,
              // primary-signal click) lives on the first derived axis
              // of each parent so the user has one source of truth.
              isParentHead={d.isFirstOfParent}
              winStart={winStart}
              winEnd={winEnd}
              originSeconds={data.sessionStartSeconds}
              live={live}
              followLive={followLive}
              showPoints={showPoints}
              resampleIntervalMs={resampleIntervalMs}
              signalsWidth={signalsWidth}
              onResizeSignalsWidth={(w) =>
                setSignalsWidth(Math.max(SIGNALS_WIDTH_MIN, Math.min(SIGNALS_WIDTH_MAX, w)))
              }
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
              onUserXChange={onUserXChange}
              onAreaResampled={onAreaResampled}
              onPlaceCursorX={placeCursorX}
              onPlaceCursorY={(which, v) => placeCursorY(d.area.id, which, v)}
              onAddNote={addNote}
              onReportSeries={reportSeries}
              onReportPerf={reportPerf}
              onReportHostMs={reportHostMs}
              onReportRate={reportRate}
              onReportCache={reportCache}
              onReportBase={reportBase}
              resetYEpoch={resetYEpoch}
              xEpoch={xEpoch}
              fitYEpoch={fitYEpoch}
              showDiag={showDiag}
              onSetPrimarySignal={(k) => setAreaPrimarySignal(parent.id, k)}
              onSetYAxisMode={(m) => setAreaYAxisMode(parent.id, m)}
              onFocus={() => setFocusedAreaId(parent.id)}
              onRemoveArea={() => removeArea(parent.id)}
              onRemoveSignal={(key) => removeSignal(parent.id, key)}
              onDropSignal={(ref, beforeKey, isInternalMove) =>
                placeSignal(ref, parent.id, beforeKey, isInternalMove)
              }
              onToggleHidden={(key) => toggleSignalHidden(parent.id, key)}
              onSetSignalColor={(key, color) => setSignalColor(parent.id, key, color)}
              onSetSignalFilter={(f) => setAreaSignalFilter(parent.id, f)}
              onPromoteFilterToManual={() => promoteFilterToManual(parent.id, parent.signals)}
              busNameLookup={busNameLookup}
              busColorLookup={busColorLookup}
              resolveColor={resolveColor}
              panelElementId={elementId}
            />
          );
        })}
      </div>

      {measEnabled && (
        <div className="plot-meas-strip">
          {measKeys.includes("a") && <MeasCell k="A (t)" v={fmtPos(cursorX.a)} cls="gold" />}
          {measKeys.includes("b") && <MeasCell k="B (t)" v={fmtPos(cursorX.b)} cls="pink" />}
          {measKeys.includes("dt") && <MeasCell k="Δt" v={formatDurationSeconds(dt)} />}
          {measKeys.includes("freq") && <MeasCell k="1/Δt" v={dt ? fmtFreq(1 / dt) : "—"} />}
          {plottedSignals.map(({ key, ref, color, areaId }) => {
            const s = seriesFor(areaId, key) ?? { t: [], v: [] };
            const va = cursorX.a != null ? valueAt(s, cursorX.a) : null;
            const vb = cursorX.b != null ? valueAt(s, cursorX.b) : null;
            const span = cursorX.a != null && cursorX.b != null ? statsOver(s, cursorX.a, cursorX.b) : null;
            const name = `${ref.messageName}.${ref.signalName}`;
            return (
              <span key={key} style={{ display: "contents" }}>
                {measKeys.includes("valA") && <MeasCell k={`${name} @A`} v={fmtVal(va)} swatch={color} />}
                {measKeys.includes("valB") && <MeasCell k={`${name} @B`} v={fmtVal(vb)} swatch={color} />}
                {measKeys.includes("delta") && (
                  <MeasCell k={`${name} Δ`} v={va != null && vb != null ? fmtVal(vb - va) : "—"} swatch={color} />
                )}
                {measKeys.includes("min") && <MeasCell k={`${name} min`} v={fmtVal(span?.min ?? null)} swatch={color} />}
                {measKeys.includes("max") && <MeasCell k={`${name} max`} v={fmtVal(span?.max ?? null)} swatch={color} />}
                {measKeys.includes("mean") && <MeasCell k={`${name} mean`} v={fmtVal(span?.mean ?? null)} swatch={color} />}
              </span>
            );
          })}
        </div>
      )}

    </div>
  );
}

function MeasCell({ k, v, cls, swatch }: { k: string; v: string; cls?: string; swatch?: string }) {
  return (
    <div className="plot-meas-cell">
      <div className="plot-meas-k">
        {swatch && <span className="plot-signal-swatch" style={{ background: swatch }} />}
        {k}
      </div>
      <div className={`plot-meas-v${cls ? ` ${cls}` : ""}`}>{v}</div>
    </div>
  );
}

/** Colour swatch in a plot-area signal row. Left-click toggles hidden
 * (preserves prior behaviour); right-click opens the browser's native
 * colour picker so the user can re-skin the series. The picker is a
 * stacked hidden `<input type="color">` whose value seeds from the
 * current swatch — committing fires `onPickColor` with the new
 * `#rrggbb`. (Native picker chosen over a bespoke palette so we
 * don't paint a custom UI for a one-off control; OSes render their
 * own with eye-droppers and recently-used swatches.) */
function SignalSwatch({
  hidden,
  color,
  onToggleHidden,
  onPickColor,
}: {
  hidden: boolean;
  color: string;
  onToggleHidden: () => void;
  onPickColor: (hex: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <span className="plot-signal-swatch-wrap">
      <button
        type="button"
        className={`plot-signal-swatch${hidden ? " hidden" : ""}`}
        style={{ background: color }}
        title={
          hidden
            ? "show this signal · right-click to pick a colour"
            : "hide this signal · right-click to pick a colour"
        }
        onClick={(e) => {
          e.stopPropagation();
          onToggleHidden();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          inputRef.current?.click();
        }}
      />
      <input
        ref={inputRef}
        type="color"
        aria-label="pick series colour"
        className="plot-signal-swatch-input"
        value={color}
        onChange={(e) => onPickColor(e.target.value)}
        // Keep the row's click handler from interpreting the input
        // click as "promote to primary".
        onClick={(e) => e.stopPropagation()}
      />
    </span>
  );
}

function MeasurementMenu({
  measKeys,
  onChange,
}: {
  measKeys: MeasurementKey[];
  onChange: (k: MeasurementKey[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const toggle = (k: MeasurementKey) => onChange(measKeys.includes(k) ? measKeys.filter((x) => x !== k) : [...measKeys, k]);
  return (
    <div className="plot-meas-menu" ref={wrapRef}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        measurements ▾
      </button>
      {open && (
        <div className="plot-meas-menu-pop" role="menu">
          {MEASUREMENT_QUANTITIES.map((q) => (
            <label key={q.key} className="checkbox">
              <input type="checkbox" checked={measKeys.includes(q.key)} onChange={() => toggle(q.key)} />
              {q.label}
              {q.perTrace ? " (per trace)" : ""}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

interface PlotAreaProps {
  area: PlotAreaConfig;
  label: string;
  isFirst: boolean;
  isLast: boolean;
  focused: boolean;
  removable: boolean;
  /** True when this PlotArea instance is the *first derived axis* of
   * its parent area (or the only axis, in unified mode). Per-area
   * chrome (y-axis-mode selector, filter editor + status bar) renders
   * only on the head so we don't surface N copies of the same control
   * when an area is in per-unit or individual mode. */
  isParentHead: boolean;
  winStart: number;
  winEnd: number;
  /** The application-level trace start (absolute seconds, ADR 0024): the
   * x-axis origin, so the plot's `t=0` matches the trace table's. `null`
   * until a session start is known. */
  originSeconds: number | null;
  live: boolean;
  followLive: boolean;
  /** Show-points tri-state from the panel toolbar — applied to every
   * series on this area's axis. See {@link ShowPointsMode}. */
  showPoints: ShowPointsMode;
  /** Min spacing between live re-samples (ms) — `1000 / maxRateHz`. */
  resampleIntervalMs: number;
  /** Pixel width of this area's right-hand side panel (signal rows
   * + headings). Set from a drag handle between the canvas and the
   * side panel. */
  signalsWidth: number;
  /** Called as the user drags the canvas/side-panel divider. */
  onResizeSignalsWidth: (px: number) => void;
  cursorMode: CursorMode;
  cursorXa: number | null;
  cursorXb: number | null;
  cursorYh1: number | null;
  cursorYh2: number | null;
  /** Panel-level mouse-crosshair x (shared across the whole area
   * stack), or `null` when the pointer isn't over any area. Every
   * area draws the crosshair line at this x and derives its
   * side-panel value readouts from it. */
  hoverX: number | null;
  /** Report this area's uPlot cursor to the panel: an x value while
   * the pointer is over the area, `null` when it leaves. Throttling
   * (one rAF per panel) and owner-aware clearing happen panel-side. */
  onHoverX: (areaId: string, x: number | null) => void;
  events: NoteEvent[];
  xSyncRef: MutableRefObject<XSync>;
  registerInstance: (id: string, u: uPlot | null) => void;
  onUserXChange: (min: number, max: number, fromId: string) => void;
  onAreaResampled: (areaId: string, firstT: number | null, lastT: number | null) => void;
  onPlaceCursorX: (which: "a" | "b", t: number) => void;
  onPlaceCursorY: (which: "h1" | "h2", v: number) => void;
  onAddNote: (t: number) => void;
  onReportSeries: (areaId: string, series: Map<string, Series>) => void;
  onReportPerf: (areaId: string, ms: number) => void;
  /** Host-side ms reported by `sample_signals` (slice + decode + decimate). */
  onReportHostMs: (areaId: string, ms: number) => void;
  /** Effective re-sample rate (Hz, smoothed) — `0` when not running. */
  onReportRate: (areaId: string, hz: number) => void;
  /** Largest per-signal cache size (display + diagnostic). */
  onReportCache: (areaId: string, points: number) => void;
  /** Report the area's cache base (x-axis origin, in
   * absolute seconds since the unix epoch — `res.from_seconds` from
   * the host's `sample_signals` reply). The panel uses this to
   * convert session-scoped notes' absolute ns to display-relative
   * seconds and back. Areas share the same x scale, so a single
   * panel-level base is fine — the panel takes whichever area
   * reports first. */
  onReportBase: (areaId: string, baseSeconds: number | null) => void;
  /** Panel-level bump → invalidate the per-trace auto-normalise range
   * (Fit Data / Clear use this so y rescales fresh on the next tick). */
  resetYEpoch: number;
  /** Panel-level bump on any programmatic x-window change → re-sample the
   * new slice. Needed for a *stopped* trace, whose self-paced resample
   * loop is off, so a goto / Fit Data / pan otherwise never refetches. */
  xEpoch: number;
  /** Toolbar's "fit y" — incremented to ask every area to refit y
   * from its currently rendered data. */
  fitYEpoch: number;
  /** Reveal the per-row y-range / cached-t-range diagnostic readout
   * (panel-level "diag" toggle). */
  showDiag: boolean;
  /** Set this area's primary signal (drives y-axis labels/units).
   * `null` reverts to the first-non-hidden default. */
  onSetPrimarySignal: (key: string | null) => void;
  /** Set the area's y-axis mode (unified / per-unit / individual). */
  onSetYAxisMode: (mode: YAxisMode) => void;
  onFocus: () => void;
  onRemoveArea: () => void;
  onRemoveSignal: (key: string) => void;
  /** A signal was dropped here. `beforeKey` null ⇒ append to this area;
   * otherwise insert before that row (re-order / move). `isInternalMove`
   * is true when the drag started inside this same plot panel
   * (sourcePanelId in the drag payload matched the panel's elementId);
   * in that case the parent runs move semantics (strip from origin,
   * insert at target). Otherwise drop is an add (DBC panel, trace
   * cell, by-id cell, another plot panel). */
  onDropSignal: (ref: SignalRef, beforeKey: string | null, isInternalMove: boolean) => void;
  onToggleHidden: (key: string) => void;
  /** Set a series' colour to the given `#rrggbb` value (ADR 0026
   * per-series colour picker). */
  onSetSignalColor: (key: string, color: string) => void;
  /** Set or clear this area's `signalFilter` (ADR 0020). Pass
   * `undefined` to revert the area to manual mode without promoting
   * the computed signals; the parent's `onPromoteFilterToManual`
   * does the promote-and-clear variant. */
  onSetSignalFilter: (filter: string | undefined) => void;
  /** Move the currently computed filter-mode signals into the
   * persisted manual list, then clear `signalFilter`. The "switch to
   * manual" affordance in the side panel calls this so the user
   * doesn't lose their current set on the mode switch. */
  onPromoteFilterToManual: () => void;
  /** Bus-id → bus-name resolution for the per-signal side panel.
   * Each signal row displays its bus name so a `(message, signal)`
   * shown on two different buses is unambiguous. */
  busNameLookup: ReadonlyMap<string, string>;
  /** Bus-id → render colour, for the swatch shown before the bus name
   * in each signal row (matches the bus's graph colour). */
  busColorLookup: ReadonlyMap<string, string>;
  /** Signal value→colour resolver (ADR 0029): tints an enum lane box by
   * its held value. Read live in the draw hook via a ref. */
  resolveColor: ColorResolver;
  /** The owning plot panel's element id. Stamped on this panel's
   * internal signal-row drags via `setSignalDragData(..., elementId)`
   * and compared against the dropped payload's `sourcePanelId` so
   * drops originating inside this same panel are treated as moves;
   * everything else (DBC panel, trace cell, another plot panel) is
   * an add. */
  panelElementId: string;
}

function PlotArea(p: PlotAreaProps) {
  diagCount("render.PlotArea"); // DIAG
  const {
    area,
    label,
    isFirst,
    isLast,
    focused,
    removable,
    isParentHead,
    winStart,
    winEnd,
    originSeconds,
    live,
    followLive,
    showPoints,
    resampleIntervalMs,
    signalsWidth,
    onResizeSignalsWidth,
    cursorMode,
    cursorXa,
    cursorXb,
    cursorYh1,
    cursorYh2,
    hoverX,
    onHoverX,
    events,
    xSyncRef,
    registerInstance,
    onUserXChange,
    onAreaResampled,
    onPlaceCursorX,
    onPlaceCursorY,
    onAddNote,
    onReportSeries,
    onReportPerf,
    onReportHostMs,
    onReportRate,
    onReportCache,
    onReportBase,
    resetYEpoch,
    xEpoch,
    fitYEpoch,
    showDiag,
    onSetPrimarySignal,
    onSetYAxisMode,
    onFocus,
    onRemoveArea,
    onRemoveSignal,
    onDropSignal,
    onToggleHidden,
    onSetSignalColor,
    onSetSignalFilter,
    onPromoteFilterToManual,
    busNameLookup,
    busColorLookup,
    resolveColor,
    panelElementId,
  } = p;

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const seriesRef = useRef<Map<string, Series>>(new Map());
  const presentRef = useRef<Map<string, number | null>>(new Map());
  const resampleBusyRef = useRef(false);
  // The plot's time-addressed windowed source (ADR 0025): it owns the
  // fetch + cache lifecycle (descriptor-memo, re-anchor, base/extent),
  // leaving `resample` only the renderer-shaping. Methods are stable
  // (`useCallback`), so destructure them for the resample closure.
  const range = useDecimatedRange();
  const { sample: sampleRange, current: currentRange, reset: resetRange } = range;
  /** Per-signal y-range pinned by a manual Fit Y (signal key → [lo, hi]
   * snapshot of the rendered extent at the moment Fit Y was hit). Only
   * read while {@link manualFitYRef} is set — it's a view-local user
   * override of the display, not model state. The widen-only auto-norm
   * latch that used to live here is gone: in follow-live the y-extent
   * now comes from the host's `signal_min_max` (ADR 0025), and a paused/
   * zoomed view fits the visible slice each tick. */
  const manualRangesRef = useRef<Map<string, { lo: number; hi: number }>>(new Map());
  /** True while a manual Fit Y override is active — the per-tick
   * normalisation in `resample` reads {@link manualRangesRef} instead of
   * the host extent. Cleared by Fit Data. */
  const manualFitYRef = useRef(false);
  /** The y-range actually used to normalise each signal on the most
   * recent resample — the widen-only latch, the manual Fit Y pin, or
   * the !follow-live visible-fit, whichever was active. Surfaced in
   * the side-panel rows so users can see what range the auto-norm is
   * operating against. */
  const effectiveRangesRef = useRef<Map<string, { lo: number; hi: number }>>(new Map());
  /** The primary signal's `{lo, hi, unit}` as of the most recent
   * resample, read by the y-axis value formatter to render real units
   * on the y-tick labels (the underlying data is normalised to
   * [0, 1]). Lives in a ref because the formatter is captured at
   * uPlot construction time and we don't want to recreate the chart
   * every time the primary changes. */
  const primaryAxisRef = useRef<{ lo: number; hi: number; unit: string | null } | null>(null);
  /** One-shot: have we already done the post-mount rebuild that
   * compensates for restored-from-project panels where the canvas
   * isn't laid out yet at uPlot's first construction? */
  const postMountRebuildDoneRef = useRef(false);
  const lastResampleTsRef = useRef(0);
  const rateEmaRef = useRef(0);
  const [valueTick, setValueTick] = useState(0); // bump → re-render side panel
  /** Filter-editor visibility (ADR 0020). Closed by default;
   * the "filter…" button in the side-panel head toggles it. The
   * editor itself is rendered below the head row when open, so it
   * stacks above the signals list. */
  const [filterEditOpen, setFilterEditOpen] = useState(false);
  // Bumped from the first ResizeObserver tick when the canvas turns
  // out to be a different size than what uPlot was constructed at
  // (typical on initial mount — dockview hasn't laid the panel out
  // yet). The construction effect depends on this, so bumping it
  // destroys + rebuilds uPlot at the now-correct size.
  const [resizeTick, setResizeTick] = useState(0);

  const areaId = area.id;
  const signals = area.signals;
  const signalSetKey = signals.map(signalRefKey).join("|");
  /** Which signal's raw range / unit drives the y-axis labels. Falls
   * back to the first non-hidden signal if the configured key is no
   * longer present (signal removed). `null` when the area is empty. */
  const primarySignal: SignalRef | null = (() => {
    const configured = area.primarySignalKey
      ? signals.find((s) => signalRefKey(s) === area.primarySignalKey)
      : null;
    if (configured) return configured;
    return signals.find((s) => !s.hidden) ?? signals[0] ?? null;
  })();
  const primaryKey = primarySignal ? signalRefKey(primarySignal) : null;
  // resample() is a stable useCallback — without a ref it would close
  // over a stale `primaryKey` and clobber `primaryAxisRef` back to the
  // old primary every tick (very visible while autoscrolling: the
  // labels flicker to the new primary then revert).
  const primaryKeyRef = useRef(primaryKey);
  primaryKeyRef.current = primaryKey;
  // Same problem for the primary's color, which the y-axis stroke /
  // ticks / labels read each draw to match the trace.
  const primaryColorRef = useRef<string | null>(primarySignal?.color ?? null);
  primaryColorRef.current = primarySignal?.color ?? null;
  // Live value→colour resolver for the draw hook (ADR 0029): updated each
  // render so a colormap edit re-tints the enum lane on the next draw
  // without rebuilding the uPlot instance.
  const colorResolverRef = useRef<ColorResolver>(resolveColor);
  colorResolverRef.current = resolveColor;
  // uPlot draws imperatively, so a colormap edit only re-tints the enum
  // lane on the next redraw. A running plot redraws on every sample; for
  // a paused/stopped one, force a redraw when the resolver changes.
  useEffect(() => {
    uplotRef.current?.redraw();
  }, [resolveColor]);

  // Value-table support for enum / state signals. When the
  // area shows *exactly one* signal *and* that signal's `VAL_`
  // table makes it an enum (>= 2 members — `isEnumValueTable`; a
  // single-member SNA sentinel stays numeric), the area switches to
  // "enum mode": auto-normalisation is bypassed (the values are
  // discrete enum codes, no rescaling), the series is rendered
  // stepped (not linearly interpolated between codes), and the
  // y-axis ticks become symbolic labels from the table.
  // Multi-signal areas keep current behaviour for the axis itself;
  // the per-signal table cache below feeds the side panel so a
  // labelled value reads as `<label> (<raw>)` on an exact raw match
  // for every signal regardless of axis mode — single-member tables
  // included.
  const [valueTables, setValueTables] = useState<Map<string, ValueTableEntryRecord[]>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const accum = new Map<string, ValueTableEntryRecord[]>();
    Promise.all(
      signals.map(async (s) => {
        try {
          diagCount("invoke.list_value_tables"); // DIAG
          const rows = await invoke<ValueTableEntryRecord[]>("list_value_tables", {
            messageId: s.messageId,
            extended: s.extended,
            signalName: s.signalName,
          });
          if (rows.length > 0) accum.set(signalRefKey(s), rows);
        } catch {
          /* signal stays numeric */
        }
      }),
    ).then(() => {
      if (cancelled) return;
      setValueTables(accum);
    });
    return () => {
      cancelled = true;
    };
  }, [signals]);
  // Axis-level enum mode is still gated on `signals.length === 1`
  // (the stepped path + symbolic y-axis ticks + label band only
  // make sense on a single-enum axis); derive that from the
  // per-signal map.
  const valueTable = useMemo<ValueTableEntryRecord[] | null>(() => {
    if (signals.length !== 1) return null;
    return valueTables.get(signalRefKey(signals[0])) ?? null;
  }, [signals, valueTables]);
  const enumMode = isEnumValueTable(valueTable) && signals.length === 1;
  // Ref mirrors so the resample callback (closure over the initial
  // signal set) sees the up-to-date enum-mode state without being
  // recreated on every value-table tick.
  const enumModeRef = useRef(enumMode);
  enumModeRef.current = enumMode;
  const valueTableRef = useRef(valueTable);
  valueTableRef.current = valueTable;

  const withSuppressed = useCallback(
    (fn: () => void) => {
      const sync = xSyncRef.current;
      const prev = sync.suppress;
      sync.suppress = true;
      try {
        fn();
      } finally {
        sync.suppress = prev;
      }
    },
    [xSyncRef],
  );

  const liveRef = useRef({
    winStart,
    winEnd,
    originSeconds,
    followLive,
    cursorMode,
    cursorXa,
    cursorXb,
    cursorYh1,
    cursorYh2,
    hoverX,
    events,
    onUserXChange,
    onHoverX,
    onAreaResampled,
    onPlaceCursorX,
    onPlaceCursorY,
    onAddNote,
    onReportSeries,
    onReportPerf,
    onReportHostMs,
    onReportRate,
    onReportCache,
    onReportBase,
  });
  useEffect(() => {
    liveRef.current = {
      winStart,
      winEnd,
      originSeconds,
      followLive,
      cursorMode,
      cursorXa,
      cursorXb,
      cursorYh1,
      cursorYh2,
      hoverX,
      events,
      onUserXChange,
      onHoverX,
      onAreaResampled,
      onPlaceCursorX,
      onPlaceCursorY,
      onAddNote,
      onReportSeries,
      onReportPerf,
      onReportHostMs,
      onReportRate,
      onReportCache,
      onReportBase,
    };
  });

  const recordRate = useCallback(() => {
    const now = performance.now();
    const dt = (now - lastResampleTsRef.current) / 1000;
    lastResampleTsRef.current = now;
    if (dt > 0 && dt < 5) {
      rateEmaRef.current = rateEmaRef.current === 0 ? 1 / dt : 0.2 * (1 / dt) + 0.8 * rateEmaRef.current;
    }
  }, []);

  const resample = useCallback(async () => {
    const u = uplotRef.current;
    if (!u) return;
    if (resampleBusyRef.current) return;
    diagCount("plotarea.resample"); // DIAG
    resampleBusyRef.current = true;
    const t0 = performance.now();
    try {
      const lr = liveRef.current;
      if (signals.length === 0) {
        resetRange();
        withSuppressed(() => u.setData([[]]));
        seriesRef.current = new Map();
        presentRef.current = new Map();
        lr.onReportSeries(areaId, new Map());
        lr.onAreaResampled(areaId, null, null);
        lr.onReportBase(areaId, null);
        lr.onReportCache(areaId, 0);
        recordRate();
        lr.onReportRate(areaId, rateEmaRef.current);
        setValueTick((v) => v + 1);
        return;
      }

      const canvasW = canvasRef.current?.clientWidth || 600;
      // One `max_points` per canvas pixel: the host min/max-decimates to
      // at most `2 * max_points`, i.e. the min and max of each pixel
      // column — the full resolution a min/max envelope can show.
      const maxPts = Math.max(MIN_DECIMATION_POINTS, Math.round(canvasW));

      // Follow-live auto-norm reads the host's all-time per-signal extent
      // (`signal_min_max`, ADR 0025) so a peak that has scrolled out of
      // the raw window still sets the y-scale. It is a scalar model query,
      // not part of the windowed `DecimatedRange` — so it rides the
      // sample's round-trip as a sidecar (no extra wall-clock) and fires
      // only on a real fetch. Skip it when a manual Fit Y is pinned, when
      // paused/zoomed (the visible slice is fit instead), or in enum mode
      // (no normalisation).
      const enumActivePre = enumModeRef.current && valueTableRef.current != null;
      const wantHostExtent = lr.followLive && !manualFitYRef.current && !enumActivePre;
      const sigQuery = signals.map((s) => ({
        busId: s.busId,
        messageId: s.messageId,
        extended: s.extended,
        signalName: s.signalName,
      }));
      const sidecar = wantHostExtent
        ? () => invoke<(SignalExtent | null)[]>("signal_min_max", { signals: sigQuery })
        : undefined;

      // The shared windowed source owns the fetch + cache lifecycle: the
      // window anchor is the trace window `[winStart, winEnd)`, the
      // visible-x slice is sent as absolute-seconds bounds (avoiding the
      // average-rate frame-index error on zoomed panels with non-uniform
      // per-id rates), and the descriptor-memo skips the round-trip when
      // nothing changed.
      const outcome = await sampleRange<(SignalExtent | null)[]>(
        {
          descriptor: signals.map(signalRefKey).join("|"),
          signals: signals.map((s) => ({
            key: signalRefKey(s),
            busId: s.busId,
            messageId: s.messageId,
            extended: s.extended,
            signalName: s.signalName,
          })),
          winStart: lr.winStart,
          winEnd: lr.winEnd,
          xMin: xSyncRef.current.xMin,
          xMax: xSyncRef.current.xMax,
          origin: lr.originSeconds,
          maxPoints: maxPts,
        },
        sidecar,
      );
      // uPlot was rebuilt while the fetch was in flight — this resample
      // belongs to the old instance; the rebuild kicks a fresh one.
      if (uplotRef.current !== u) return;
      if (outcome.kind === "pending") return; // nothing real yet — retry next tick

      if (outcome.kind === "empty") {
        // Window collapsed (trace just started, no frames yet, or the
        // visible x range collapsed). Clear the plot and keep ticking.
        withSuppressed(() => u.setData([[] as number[], ...signals.map(() => [] as number[])] as uPlot.AlignedData));
        seriesRef.current = new Map();
        presentRef.current = new Map();
        lr.onReportSeries(areaId, new Map());
        lr.onAreaResampled(areaId, null, null);
        lr.onReportCache(areaId, 0);
        recordRate();
        lr.onReportRate(areaId, rateEmaRef.current);
        return;
      }

      // Cached-points gauge: biggest series currently in the window.
      const snap = currentRange();
      let biggestCache = 0;
      if (snap) for (const c of snap.byKey.values()) if (c.t.length > biggestCache) biggestCache = c.t.length;
      lr.onReportCache(areaId, biggestCache);

      if (outcome.kind === "unchanged") {
        // Same request as last fetch — keep the rendered data, just feed
        // the follow-live edge and tick the rate readout.
        lr.onAreaResampled(areaId, outcome.firstT, outcome.lastT);
        recordRate();
        lr.onReportRate(areaId, rateEmaRef.current);
        return;
      }

      // outcome.kind === "sampled" — render the fresh window.
      const { snapshot } = outcome;
      const hostExtents = outcome.extra;
      const base = snapshot.base;
      lr.onReportHostMs(areaId, snapshot.sliceMs + snapshot.decodeMs);
      // Areas share x, so a panel-level base from any area lets
      // session-scoped notes project onto this panel's x-axis.
      lr.onReportBase(areaId, base);

      const seriesRel: Series[] = signals.map((s) => snapshot.byKey.get(signalRefKey(s)) ?? { t: [], v: [] });
      // Auto-normalisation: each series is re-mapped to [0, 1] from
      // its *unit group's* min/max (ADR 0026 — same-unit series share
      // one y scale; each unit group fills the canvas independently),
      // so signals with very different natural ranges (SOC 0–1 vs
      // current ±300) coexist on one axis. The side-panel value column
      // still shows the raw value (`seriesRef` keeps the un-normalised
      // series for that); the y-axis tick labels map back through the
      // primary signal's group range to real engineering values.
      //
      // The per-signal `(lo, hi)` driving the normalise (group union
      // happens below) is resolved by mode — no JS-held latch anymore:
      //
      //  * **Manual Fit Y** — the user-pinned `manualRangesRef`
      //    snapshot is used as-is until the next Fit Data / Clear.
      //  * **Follow-live ON** — the host's all-time per-signal extent
      //    (`hostExtents`, from `signal_min_max`). The host sees every
      //    decoded sample, so a peak that scrolled out of the raw
      //    window still sets the scale and the y-axis never "snaps
      //    back" — and it's a host-owned model fact (ADR 0025), not a
      //    range latched in a React ref.
      //  * **Follow-live OFF** — the visible slice's own min/max,
      //    recomputed each tick so a zoomed-in pan fills the canvas
      //    with its local detail (shaping already-paged data).
      const ranges = new Map<string, { lo: number; hi: number }>();
      signals.forEach((s, i) => {
        const key = signalRefKey(s);
        if (manualFitYRef.current) {
          const m = manualRangesRef.current.get(key);
          if (m) ranges.set(key, m);
          return;
        }
        if (lr.followLive) {
          const e = hostExtents?.[i];
          if (e && e.hi > e.lo) ranges.set(key, { lo: e.lo, hi: e.hi });
          return;
        }
        const ser = seriesRel[i];
        if (ser.v.length === 0) return;
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of ser.v) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) ranges.set(key, { lo, hi });
      });
      // Unit-based y-scale (ADR 0026): the per-signal latches above
      // feed `groupScaleRanges`, which hands every signal the *union*
      // range of its unit group — so same-unit series share one y
      // scale and each unit group auto-scales independently to fill
      // the axis. Unitless signals each keep their own range (two
      // signals that merely both lack a unit aren't known
      // commensurable).
      const scaleRanges = groupScaleRanges(
        signals.map((s) => ({ key: signalRefKey(s), unit: s.unit })),
        ranges,
      );
      // Enum-mode: skip auto-normalisation and pass raw enum codes
      // through. The y scale is pinned to the table's raw-value range
      // below so the trace's discrete codes plot at their natural
      // positions and the axis tick labels (set in `opts`) are
      // symbolic.
      const enumActive = enumModeRef.current && valueTableRef.current != null;
      const effective = new Map<string, { lo: number; hi: number }>();
      const displaySeries: Series[] = enumActive
        ? seriesRel
        : seriesRel.map((s, i) => {
            if (s.v.length === 0) return s;
            const key = signalRefKey(signals[i]);
            const r = scaleRanges.get(key);
            const out = new Array<number>(s.v.length);
            if (r && r.hi > r.lo) {
              effective.set(key, r);
              const span = r.hi - r.lo;
              for (let j = 0; j < s.v.length; j++) out[j] = (s.v[j] - r.lo) / span;
            } else {
              // No range available yet (signal hasn't decoded, or all
              // observed values are equal so far). Render at the canvas
              // midline so the line is *visible* — without this fallback
              // the raw values get drawn against the y = [0, 1] pin and
              // clipped to nothing.
              for (let j = 0; j < s.v.length; j++) out[j] = 0.5;
            }
            return { t: s.t, v: out };
          });
      const merged = mergeSeries(displaySeries) as uPlot.AlignedData;
      const xs = merged[0] as number[];
      // Live edge for follow-live / Fit Data: the trace window's true
      // last-frame time (`snapshot.lastT`, from the host's
      // `last_seconds`). The `xs` fallback covers the very first fetch,
      // before `last_seconds` has landed.
      const liveEdgeT =
        snapshot.lastT ?? (xs.length > 0 ? xs[xs.length - 1] : null);
      // Window-start floor for the shared x-window (ADR 0024): the trace
      // window's first-frame session-relative time (`snapshot.firstT`),
      // with the merged data's first x as the pre-`from_seconds` fallback.
      const windowStartT =
        snapshot.firstT ?? (xs.length > 0 ? xs[0] : null);

      withSuppressed(() => {
        // `setData(data, false)` keeps the current scales — we set
        // them ourselves a couple of lines down. Passing `true` here
        // (auto-fit to data extent first) produced a transient re-fit
        // every tick that visibly nudged the axis tick layout / the
        // canvas bbox by a pixel or two — the "wiggle" the user
        // reported in the gridlines/labels.
        u.setData(merged, false);
        const { xMin, xMax } = xSyncRef.current;
        if (xMin != null && xMax != null) u.setScale("x", { min: xMin, max: xMax });
        if (enumActive && valueTableRef.current != null) {
          const rows = valueTableRef.current;
          const lo = Math.min(...rows.map((r) => r.raw));
          const hi = Math.max(...rows.map((r) => r.raw));
          u.setScale("y", { min: lo - 0.5, max: hi + 0.5 });
        } else {
          // y is always auto-derived (ADR 0026): the data was already
          // normalised to [0, 1] above and the y-axis formatter
          // converts ticks back into the primary signal's real units.
          u.setScale("y", { min: 0, max: 1 });
        }
      });

      const sm = new Map<string, Series>();
      const pv = new Map<string, number | null>();
      signals.forEach((s, i) => {
        const key = signalRefKey(s);
        const ser = seriesRel[i];
        sm.set(key, ser);
        pv.set(key, ser.v.length > 0 ? ser.v[ser.v.length - 1] : null);
      });
      seriesRef.current = sm;
      presentRef.current = pv;
      effectiveRangesRef.current = effective;
      // Refresh the primary signal's range/unit so the y-axis value
      // formatter can convert normalised tick positions back to raw
      // signal units on the next draw. Read through the ref — this
      // callback's closure has a stale `primaryKey` once the user
      // promotes a new signal.
      const pk = primaryKeyRef.current;
      if (pk) {
        const r = effective.get(pk);
        if (r) {
          const sig = signals.find((s) => signalRefKey(s) === pk);
          primaryAxisRef.current = { lo: r.lo, hi: r.hi, unit: sig?.unit ?? null };
        } else {
          primaryAxisRef.current = null;
        }
      } else {
        primaryAxisRef.current = null;
      }
      lr.onReportSeries(areaId, sm);
      lr.onAreaResampled(areaId, windowStartT, liveEdgeT);
      lr.onReportPerf(areaId, performance.now() - t0);
      recordRate();
      lr.onReportRate(areaId, rateEmaRef.current);
      setValueTick((v) => v + 1);
    } catch {
      /* a failed sample just leaves the last one on screen */
    } finally {
      resampleBusyRef.current = false;
    }
  }, [signals, areaId, withSuppressed, recordRate, sampleRange, currentRange, resetRange]);

  const resampleRef = useRef(resample);
  useEffect(() => {
    resampleRef.current = resample;
  });
  const onUserXChangeRef = useRef(onUserXChange);
  useEffect(() => {
    onUserXChangeRef.current = onUserXChange;
  });

  // (Re)create the uPlot instance when the signal *set* changes.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    // Don't construct uPlot until the canvas has real dimensions. A
    // panel restored from a project file mounts before dockview has
    // laid out the layout — so the canvas is 0×0 at mount, uPlot's
    // axis-layout state initialises against the fallback size and never
    // recovers (data is set, but no axes / gridlines draw). Wait for
    // the first non-zero size, then re-run the effect.
    if (!el.clientWidth || !el.clientHeight) {
      const probe = new ResizeObserver(() => {
        if (el.clientWidth && el.clientHeight) {
          probe.disconnect();
          diagCount("uplot.resizeTick.probe"); // DIAG
          setResizeTick((n) => n + 1);
        }
      });
      probe.observe(el);
      return () => probe.disconnect();
    }
    const axisCommon = {
      stroke: AXIS_STROKE,
      grid: { stroke: AXIS_GRID, width: 1 },
      ticks: { stroke: AXIS_TICKS, width: 1 },
      font: "10px ui-monospace, SFMono-Regular, Menlo, monospace",
    };
    // Enum-mode hook-up: stepped paths + symbolic y-axis
    // ticks. The construction effect closes over `valueTable` so a
    // table-fetch resolution (which re-renders + triggers rebuild
    // through the `signalSetKey` dep on this effect) installs the
    // enum-mode opts on the next uPlot instance.
    const enumActiveAtConstruct = enumMode && valueTable != null;
    // The enum-mode area holds exactly one signal; capture its identity
    // so the draw hook can resolve a colormap tint for the held value
    // (ADR 0029). Stable for this instance — the effect rebuilds when the
    // signal set changes.
    const enumTarget: ColorTarget | null =
      enumActiveAtConstruct && signals[0]
        ? {
            messageId: signals[0].messageId,
            extended: signals[0].extended,
            signalName: signals[0].signalName,
            busId: signals[0].busId ?? null,
          }
        : null;
    const enumRaws = enumActiveAtConstruct ? valueTable.map((r) => r.raw) : [];
    const enumLabelFor = (raw: number): string => {
      const found = valueTable?.find((r) => r.raw === raw);
      return found ? found.label : String(raw);
    };
    const yAxis: uPlot.Axis = enumActiveAtConstruct
      ? {
          ...axisCommon,
          size: 80,
          splits: () => enumRaws,
          values: (_u, splits) =>
            splits.map((v) => `${v} "${enumLabelFor(Math.round(v))}"`),
        }
      : {
          ...axisCommon,
          // Tick *positions* stay on the underlying [0, 1] (or custom
          // yMode) scale — what changes is how we format each split's
          // value for display. In auto-mode the plot data is normalised
          // to [0, 1], so each split is mapped through the primary
          // signal's current `(lo, hi)` to recover a raw signal value
          // for the label (and the signal's unit is suffixed when the
          // DBC supplied one). In custom-mode the scale already *is*
          // the raw range, so the split value is taken as-is.
          values: (_u, splits) => splits.map((v) => {
            const p = primaryAxisRef.current;
            if (p == null) return fmtTickValue(v);
            const raw = p.lo + v * (p.hi - p.lo);
            return `${fmtTickValue(raw)}${p.unit ? ` ${p.unit}` : ""}`;
          }),
          // Sized from the formatted tick strings each layout pass: a
          // signal with units like `degC` and 5-digit raw values needs
          // far more than 52 px of gutter, otherwise labels run off the
          // canvas edge. We measure the widest formatted label in the
          // current tick set with a canvas 2d context (cheap; reuses a
          // module-level scratch context).
          size: (_u, values) => measureAxisSize(values),
          // Tint the y-axis to match the primary signal's trace so
          // it's obvious which series the labels correspond to. Falls
          // back to the neutral axis colour when there's no primary
          // (empty area). uPlot calls these per draw, so the ref read
          // picks up promotions immediately.
          stroke: () => primaryColorRef.current ?? AXIS_STROKE,
          ticks: { stroke: () => primaryColorRef.current ?? AXIS_TICKS, width: 1 },
        };
    // Only the bottom-most stacked area carries the "time (s)" label and
    // numeric ticks. Upper areas keep gridlines + tick marks (so the
    // shared x-grid still reads across the whole stack) but drop the
    // label and the numbers — they're identical on every area, so
    // repeating them just wastes vertical space.
    const xAxis: uPlot.Axis = isLast
      ? {
          ...axisCommon,
          label: "time (s)",
          labelSize: 16,
          size: 34,
          // Ticks share the trace's elapsed-time format (ADR 0024) so
          // the same timeline position reads identically in both views;
          // precision adapts to the visible span so zoomed-in ticks stay
          // distinguishable.
          values: (u, splits) => {
            const d = fracDigitsForSpan((u.scales.x.max ?? 0) - (u.scales.x.min ?? 0));
            return splits.map((v) => formatElapsed(v, d));
          },
        }
      : { ...axisCommon, size: 18, values: (_u, splits) => splits.map(() => "") };
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: Math.max(60, el.clientHeight - 2),
      // Both axes are `auto: false` — we own the range entirely, and
      // every code path that wants to move it does so via an explicit
      // `setScale`. Leaving `auto: true` (uPlot's default) means
      // uPlot's internal range tracker keeps re-fitting the scale to
      // the latest data on each draw, which fights with the normalised
      // [0, 1] / custom-fixed range the panel is trying to hold — the
      // user-visible symptom is the y-axis "jumping" between updates
      // even though our data is already in a fixed range.
      scales: { x: { time: false, auto: false }, y: { auto: false } },
      legend: { show: false },
      // uPlot's built-in drag-select (left-button) is off — we do
      // box-zoom on right-drag instead (see the `ready` hook), so
      // left-clicks are free for placing cursors / notes. The native
      // vertical cursor line (`x`) is off too: the crosshair is
      // panel-level (one shared x across the stacked areas), drawn by
      // our own draw-hook overlay in every area — the native line
      // would double it up in the hovered one. The horizontal line
      // stays: y is meaningful only under the pointer.
      cursor: { x: false, drag: { x: false, y: false } },
      axes: [xAxis, yAxis],
      series: [
        {},
        ...signals.map((s) => ({
          label: `${s.messageName}.${s.signalName}`,
          stroke: s.color,
          width: 1,
          // `auto` defers to uPlot's density default; `off` never draws
          // markers; `on` always draws them but capped at a flat max across
          // the visible range so a zoomed-out window doesn't render a
          // marker per decimated sample. See `plotPoints.ts`.
          points: showPointsToUplot(showPoints),
          show: !s.hidden,
          ...(enumActiveAtConstruct && uPlot.paths.stepped
            ? { paths: uPlot.paths.stepped({ align: 1 }) }
            : {}),
        })),
      ],
      hooks: {
        setScale: [
          (u: uPlot, key: string) => {
            if (key !== "x") return;
            if (xSyncRef.current.suppress) return;
            const { min, max } = u.scales.x;
            if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
            // Ignore a programmatic change echoing back at us — a missed
            // suppress window (uPlot re-fitting on (re)create / resize /
            // a `setData`), or it landing exactly where `applyXAll` put
            // it. Only a real user pan/zoom moves x off the shared
            // window; that drops out of follow-live.
            const { xMin, xMax } = xSyncRef.current;
            if (xMin != null && xMax != null && Math.abs(min - xMin) < 1e-9 && Math.abs(max - xMax) < 1e-9) {
              return;
            }
            liveRef.current.onUserXChange(min, max, areaId);
          },
        ],
        setCursor: [
          (u: uPlot) => {
            // Raw report — the panel rAF-throttles (once per panel,
            // not per area) and folds owner-aware clears.
            const leftPx = u.cursor.left;
            liveRef.current.onHoverX(areaId, leftPx == null || leftPx < 0 ? null : u.posToVal(leftPx, "x"));
          },
        ],
        draw: [
          (u: uPlot) => {
            const lr = liveRef.current;
            const ctx = u.ctx;
            const ratio = u.ctx.canvas.width / u.width || 1;
            const { left, top, width, height } = u.bbox;
            ctx.save();
            ctx.beginPath();
            ctx.rect(left, top, width, height);
            ctx.clip();
            ctx.font = `600 ${9.5 * ratio}px ui-monospace, monospace`;
            ctx.lineWidth = 1 * ratio;
            const vline = (xVal: number, color: string, dash: number[], lbl: string | null, atTop: boolean) => {
              const xp = u.valToPos(xVal, "x", true);
              if (xp < left - 4 || xp > left + width + 4) return;
              ctx.strokeStyle = color;
              ctx.setLineDash(dash.map((d) => d * ratio));
              ctx.beginPath();
              ctx.moveTo(xp, top);
              ctx.lineTo(xp, top + height);
              ctx.stroke();
              ctx.setLineDash([]);
              if (lbl != null) {
                const tw = ctx.measureText(lbl).width;
                const padX = 4 * ratio;
                const h = 13 * ratio;
                const ty = atTop ? top + 2 * ratio : top + height - h - 2 * ratio;
                ctx.fillStyle = "#0a0d0f";
                ctx.fillRect(xp - tw / 2 - padX, ty, tw + padX * 2, h);
                ctx.strokeStyle = color;
                ctx.strokeRect(xp - tw / 2 - padX, ty, tw + padX * 2, h);
                ctx.fillStyle = color;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(lbl, xp, ty + h / 2);
              }
            };
            for (const ev of lr.events) {
              vline(ev.t, ev.color ?? EVENT_COLOR, ev.id === "__t0" ? [] : [2, 3], isFirst ? ev.label : null, true);
            }
            // Task 15 / ADR 0026: the X cursor's time label appears on
            // every axis (it used to render only on the last area, so
            // adding a plot area visually hid the labels). Format as
            // "<letter> <time>" so a glance at any axis tells you both
            // which cursor and where — positions in the trace's
            // elapsed-time format, at the axis ticks' adaptive precision.
            const xDigits = fracDigitsForSpan((u.scales.x.max ?? 0) - (u.scales.x.min ?? 0));
            if (lr.cursorXa != null) {
              vline(lr.cursorXa, CURSOR_A_COLOR, [4, 3], `A ${formatElapsed(lr.cursorXa, xDigits)}`, false);
            }
            if (lr.cursorXb != null) {
              vline(lr.cursorXb, CURSOR_B_COLOR, [4, 3], `B ${formatElapsed(lr.cursorXb, xDigits)}`, false);
            }
            // The shared mouse crosshair (panel-level, like A/B): drawn
            // in *every* stacked area at the same x, so the hover in
            // one area lines up with the readouts everywhere. No label
            // — it tracks the pointer; `vline` clips it when the x
            // falls outside this area's window, same as A/B.
            if (lr.hoverX != null) {
              vline(lr.hoverX, CROSSHAIR_COLOR, [4, 3], null, false);
            }
            const hline = (yVal: number, color: string, lbl: string) => {
              const yp = u.valToPos(yVal, "y", true);
              if (yp < top - 4 || yp > top + height + 4) return;
              ctx.strokeStyle = color;
              ctx.setLineDash([4 * ratio, 3 * ratio]);
              ctx.beginPath();
              ctx.moveTo(left, yp);
              ctx.lineTo(left + width, yp);
              ctx.stroke();
              ctx.setLineDash([]);
              const tw = ctx.measureText(lbl).width;
              const padX = 4 * ratio;
              const h = 13 * ratio;
              const lx = left + 3 * ratio;
              ctx.fillStyle = "#0a0d0f";
              ctx.fillRect(lx, yp - h / 2, tw + padX * 2, h);
              ctx.strokeStyle = color;
              ctx.strokeRect(lx, yp - h / 2, tw + padX * 2, h);
              ctx.fillStyle = color;
              ctx.textAlign = "left";
              ctx.textBaseline = "middle";
              ctx.fillText(lbl, lx + padX, yp);
            };
            if (lr.cursorYh1 != null) hline(lr.cursorYh1, CURSOR_A_COLOR, "H1");
            if (lr.cursorYh2 != null) hline(lr.cursorYh2, CURSOR_B_COLOR, "H2");
            // A small Δ chip so the cursor delta is visible without
            // turning on the measurement strip.
            const chip = (cx: number, cy: number, text: string, color: string) => {
              const tw = ctx.measureText(text).width;
              const padX = 4 * ratio;
              const h = 13 * ratio;
              ctx.fillStyle = "#0a0d0f";
              ctx.fillRect(cx - tw / 2 - padX, cy - h / 2, tw + padX * 2, h);
              ctx.strokeStyle = color;
              ctx.strokeRect(cx - tw / 2 - padX, cy - h / 2, tw + padX * 2, h);
              ctx.fillStyle = color;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillText(text, cx, cy);
            };
            if (lr.cursorXa != null && lr.cursorXb != null && isLast) {
              const xp = u.valToPos((lr.cursorXa + lr.cursorXb) / 2, "x", true);
              if (xp > left && xp < left + width) {
                chip(xp, top + height - 18 * ratio, `Δt ${formatDurationSeconds(Math.abs(lr.cursorXb - lr.cursorXa))}`, "#cbd5e1");
              }
            }
            if (lr.cursorYh1 != null && lr.cursorYh2 != null) {
              const yp = u.valToPos((lr.cursorYh1 + lr.cursorYh2) / 2, "y", true);
              if (yp > top && yp < top + height) {
                chip(left + 40 * ratio, yp, `ΔH ${fmtVal(Math.abs(lr.cursorYh2 - lr.cursorYh1))}`, "#cbd5e1");
              }
            }
            // Logic-analyzer lane (ADR 0026): on an enum-only axis,
            // overlay an opaque label box on each constant-value
            // segment of the (stepped) line. The line + symbolic
            // y-axis ticks are still there; the boxes sit *in front*
            // of the line so a glance reads "Idle ── Running ──"
            // rather than just a step pattern. Only runs on the
            // enum-mode uPlot (the construction effect rebuilds the
            // instance when the value table resolves), so the cost
            // on numeric axes is zero.
            if (enumActiveAtConstruct && valueTableRef.current) {
              const table = valueTableRef.current;
              const labelFor = (raw: number): string => {
                const found = table.find((r) => r.raw === Math.round(raw));
                return found ? found.label : String(raw);
              };
              // Enum-mode areas hold exactly one signal, so its
              // series sits at uPlot index 1. `u.data` is the
              // AlignedData we just set — `setData(_, false)` keeps
              // it stable.
              const seriesIdx = 1;
              const seriesOpt = u.series[seriesIdx];
              const ts = u.data[0] as number[] | undefined;
              const vs = u.data[seriesIdx] as (number | null)[] | undefined;
              if (ts && vs && seriesOpt?.show !== false) {
                const boxColor = primaryColorRef.current ?? AXIS_STROKE;
                const segments = enumSegments(ts, vs);
                const padX = 4 * ratio;
                // All label boxes sit in one **centered horizontal
                // band** down the middle of the plot, regardless of
                // the held value. Tracking each value's y-position
                // (the per-value lane scheme) collapsed under tall
                // value tables — twelve enum values on a small canvas
                // left each lane a few pixels tall. Decoupling label
                // position from value gives the labels all the room
                // they need; the stepped line still draws at the
                // actual value, so the user reads "what" from the
                // line height and "which value name" from the
                // centered ribbon. (The line is visible above and
                // below the ribbon and obscured under it — same
                // logic-analyzer style.)
                //
                // Band sized at the larger of ~22 CSS px and 55% of
                // the plot height, centered. The minimum keeps very
                // small panels legible; the fraction lets a tall
                // panel breathe.
                const bandH = Math.max(22 * ratio, height * 0.55);
                const bandTop = top + (height - bandH) / 2;
                const bandBot = bandTop + bandH;
                for (const seg of segments) {
                  const x0 = u.valToPos(seg.t0, "x", true);
                  // `tEnd` is the next-sample timestamp (where the
                  // value changes), matching the stepped line's hold —
                  // so the box reaches the visual transition instead
                  // of cutting off at the last same-value sample.
                  const x1 = u.valToPos(seg.tEnd, "x", true);
                  // Clip-trim against the visible plot region first:
                  // a segment extending past the canvas still labels
                  // the visible portion, centred on what's on screen
                  // rather than off-canvas.
                  const visStart = Math.max(x0, left);
                  const visEnd = Math.min(x1, left + width);
                  const segW = visEnd - visStart;
                  if (segW <= 0) continue;
                  const lbl = labelFor(seg.v);
                  const tw = ctx.measureText(lbl).width;
                  // A thin segment still gets a coloured band so the
                  // held interval is visible even if the label text
                  // can't fit.
                  const labelFits = segW >= tw + padX * 2;
                  // A colormap (ADR 0029) targeting this signal tints the
                  // box by the held value: an opaque-ish fill in the
                  // value's colour with a contrasting label. Without a
                  // map, fall back to the neutral dark ribbon + series-
                  // coloured border/label. The ~65–85% fills keep the
                  // stepped line faintly visible underneath either way.
                  const mapColor = enumTarget
                    ? colorResolverRef.current(enumTarget, seg.v)
                    : null;
                  // Same ribbon style as the un-mapped case — the line
                  // shows through a 0.65-opacity dim fill — but the
                  // border and label take the value's colour, and the
                  // fill is a darkened shade of it.
                  const fill = mapColor ? colorMapLaneFill(mapColor) : "rgba(10, 13, 15, 0.65)";
                  const accent = mapColor ?? boxColor;
                  ctx.fillStyle = fill;
                  ctx.fillRect(visStart, bandTop, segW, bandH);
                  ctx.strokeStyle = accent;
                  ctx.strokeRect(visStart + 0.5, bandTop + 0.5, segW - 1, bandH - 1);
                  if (labelFits) {
                    ctx.fillStyle = accent;
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(lbl, visStart + segW / 2, (bandTop + bandBot) / 2);
                  }
                }
              }
            }
            ctx.restore();
          },
        ],
        ready: [
          (u: uPlot) => {
            const over = u.over;
            over.addEventListener(
              "wheel",
              (e: WheelEvent) => {
                const cmd = e.ctrlKey || e.metaKey;
                const shift = e.shiftKey;
                e.preventDefault();
                const rect = over.getBoundingClientRect();
                // Horizontal scroll (trackpad two-finger sideways, or
                // a mouse tilt-wheel) → pan x. The vertical wheel is
                // for zoom; an explicit "pan with the vertical wheel"
                // is still available via shift.
                const hScroll = Math.abs(e.deltaX) > Math.abs(e.deltaY);
                if (hScroll) {
                  const xs = u.scales.x;
                  if (xs.min == null || xs.max == null) return;
                  const span = xs.max - xs.min;
                  // Trackpad deltaX is roughly pixels per notch on
                  // most platforms; scale by the visible span so the
                  // pan feels the same at any zoom level.
                  const step = (e.deltaX / Math.max(1, rect.width)) * span;
                  const min = xs.min + step;
                  const max = xs.max + step;
                  withSuppressed(() => u.setScale("x", { min, max }));
                  liveRef.current.onUserXChange(min, max, areaId);
                  return;
                }
                const f = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
                if (cmd) {
                  // ⌘/ctrl + wheel → zoom y around the cursor (this area
                  // only). Buried under a modifier — usually you set y
                  // with the per-area range control.
                  const yc = u.posToVal(e.clientY - rect.top, "y");
                  const ys = u.scales.y;
                  if (ys.min == null || ys.max == null) return;
                  u.setScale("y", { min: yc - (yc - ys.min) * f, max: yc + (ys.max - yc) * f });
                  return;
                }
                const xs = u.scales.x;
                if (xs.min == null || xs.max == null) return;
                if (shift) {
                  // shift + wheel → pan x (synced); ~10% of the window per notch.
                  const span = xs.max - xs.min;
                  const step = (e.deltaY > 0 ? 1 : -1) * span * 0.1;
                  const min = xs.min + step;
                  const max = xs.max + step;
                  withSuppressed(() => u.setScale("x", { min, max }));
                  liveRef.current.onUserXChange(min, max, areaId);
                } else {
                  // plain wheel → zoom x around the cursor (synced).
                  const xc = u.posToVal(e.clientX - rect.left, "x");
                  const min = xc - (xc - xs.min) * f;
                  const max = xc + (xs.max - xc) * f;
                  withSuppressed(() => u.setScale("x", { min, max }));
                  liveRef.current.onUserXChange(min, max, areaId);
                }
              },
              { passive: false },
            );
            // Mouse on the plot:
            //   left-click   → place cursor A / H1 / note (cursor mode)
            //   left-drag    → pan x (synced)
            //   right-click  → place cursor B / H2
            //   right-drag   → box-zoom x (synced)
            // Click vs drag is a small movement threshold; uPlot's own
            // left-drag zoom is disabled (see the `cursor` opt).
            const DRAG_PX = 4;
            let drag: { btn: number; sx: number; sy: number; moved: boolean; minX: number; maxX: number } | null = null;
            const onMove = (e: MouseEvent) => {
              if (!drag) return;
              if (!drag.moved && (Math.abs(e.clientX - drag.sx) > DRAG_PX || Math.abs(e.clientY - drag.sy) > DRAG_PX))
                drag.moved = true;
              if (!drag.moved) return;
              if (drag.btn === 0) {
                // pan x: shift the *start* window by the pixel delta.
                const w = over.clientWidth || 1;
                const dxData = ((e.clientX - drag.sx) / w) * (drag.maxX - drag.minX);
                const min = drag.minX - dxData;
                const max = drag.maxX - dxData;
                withSuppressed(() => u.setScale("x", { min, max }));
                liveRef.current.onUserXChange(min, max, areaId);
              } else {
                // right-drag: draw the box-zoom selection.
                const r = over.getBoundingClientRect();
                const x0 = Math.max(0, Math.min(drag.sx, e.clientX) - r.left);
                const x1 = Math.min(r.width, Math.max(drag.sx, e.clientX) - r.left);
                u.setSelect({ left: x0, top: 0, width: Math.max(0, x1 - x0), height: over.clientHeight }, false);
              }
            };
            const onUp = (e: MouseEvent) => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
              const d = drag;
              drag = null;
              if (!d) return;
              const r = over.getBoundingClientRect();
              const lr = liveRef.current;
              if (d.btn === 2 && d.moved) {
                u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
                const a = u.posToVal(Math.min(d.sx, e.clientX) - r.left, "x");
                const b = u.posToVal(Math.max(d.sx, e.clientX) - r.left, "x");
                if (b - a > 0) {
                  withSuppressed(() => u.setScale("x", { min: a, max: b }));
                  lr.onUserXChange(a, b, areaId);
                }
                return;
              }
              if (d.moved) return; // left-drag pan already applied
              if (lr.cursorMode === "off") return;
              const x = u.posToVal(e.clientX - r.left, "x");
              const y = u.posToVal(e.clientY - r.top, "y");
              if (d.btn === 0) {
                if (lr.cursorMode === "x") lr.onPlaceCursorX("a", x);
                else if (lr.cursorMode === "y") lr.onPlaceCursorY("h1", y);
                else if (lr.cursorMode === "note") lr.onAddNote(x);
              } else {
                if (lr.cursorMode === "x") lr.onPlaceCursorX("b", x);
                else if (lr.cursorMode === "y") lr.onPlaceCursorY("h2", y);
              }
            };
            over.addEventListener("mousedown", (e: MouseEvent) => {
              if (e.button !== 0 && e.button !== 2) return;
              if (e.button === 2) e.preventDefault();
              const xs = u.scales.x;
              drag = { btn: e.button, sx: e.clientX, sy: e.clientY, moved: false, minX: xs.min ?? 0, maxX: xs.max ?? 1 };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            });
            over.addEventListener("contextmenu", (e: MouseEvent) => e.preventDefault());
          },
        ],
      },
    };
    // uPlot needs `data.length === series.length`; start with an
    // empty column per series (the resample below fills them).
    const initialData = [[] as number[], ...signals.map(() => [] as number[])] as uPlot.AlignedData;
    diagCount("uplot.create"); // DIAG
    const u = new uPlot(opts, initialData, el);
    uplotRef.current = u;
    registerInstance(areaId, u);
    // The signal set changed (or this is the first mount): the old
    // cache (anchored to the old set) is stale — drop it so the
    // re-sample below rebuilds it from a full fetch. Also clear the
    // busy-guard (a re-sample for the *previous* uPlot may still be in
    // flight; it'll no-op once it sees `uplotRef.current` moved on) so
    // this fresh instance gets its data even when the trace isn't
    // running (no timer to retry it).
    resetRange();
    resampleBusyRef.current = false;
    void resampleRef.current();
    // ...and once more after layout settles, in case the first call ran
    // before the window count had propagated (the data would arrive on
    // the next live tick — but a stopped trace has no tick).
    const raf = requestAnimationFrame(() => void resampleRef.current());

    // The canvas had real dimensions at construction (we guarded for
    // it above), so subsequent resizes just `setSize`. Guard against
    // a feedback loop: uPlot's `setSize` writes the canvas's CSS
    // width/height, which fires the ResizeObserver again — if the
    // delta is zero the redraw is wasted work *and* the side-effects
    // of setting the canvas size can subtly shift its bbox by a
    // sub-pixel, which the user perceives as the plot area "wiggling".
    let lastW = el.clientWidth || 600;
    let lastH = Math.max(60, el.clientHeight - 2);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth || 600;
      const h = Math.max(60, el.clientHeight - 2);
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      diagCount("uplot.setSize"); // DIAG
      withSuppressed(() => u.setSize({ width: w, height: h }));
    });
    ro.observe(el);

    // Belt-and-braces against the restored-from-project case: even when
    // the canvas had non-zero dimensions at construction, uPlot can
    // still end up with a stuck axis layout (whatever the exact cause —
    // jsdom can't reproduce, so I'm flying blind). The manual fix is
    // drag/drop, which causes uPlot to be re-created. Do that
    // programmatically once, ~250 ms after first mount, by which time
    // the layout has settled. Guarded so we only ever do it once per
    // panel lifetime.
    let postMountRebuildTimer = 0;
    if (!postMountRebuildDoneRef.current) {
      // Set `done` when the timer *fires*, not when we schedule it —
      // StrictMode runs the effect twice (run → cleanup → re-run) in
      // dev; flipping the flag at scheduling time leaves it `true`
      // after the cleanup clears the timer, so the second run skips
      // scheduling and the rebuild never happens.
      postMountRebuildTimer = window.setTimeout(() => {
        postMountRebuildDoneRef.current = true;
        diagCount("uplot.resizeTick.postMount"); // DIAG
        setResizeTick((n) => n + 1);
      }, 250);
    }

    return () => {
      cancelAnimationFrame(raf);
      if (postMountRebuildTimer) window.clearTimeout(postMountRebuildTimer);
      ro.disconnect();
      // A destroyed instance can't report a pointer-leave — clear the
      // shared hover so removing the hovered area doesn't leave a
      // frozen crosshair in the others (owner-aware: a rebuild of a
      // non-hovered area is a no-op).
      liveRef.current.onHoverX(areaId, null);
      registerInstance(areaId, null);
      diagCount("uplot.destroy"); // DIAG
      u.destroy();
      if (uplotRef.current === u) uplotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalSetKey, areaId, resizeTick, valueTable, showPoints, isLast]);

  // While the trace is running, re-sample on a self-paced loop at the
  // configured rate (each tick scheduled after the previous one
  // finishes — decoupled from React re-renders, which lurch / stall at
  // high capture rates, and never piling up). Pause/Stop ends the loop,
  // freezing the window; the leading re-sample on the running→paused
  // edge captures the frozen state. Also re-sample once when the window
  // re-anchors (Clear / Start gives a new `winStart`) or the rate
  // changes.
  useEffect(() => {
    void resampleRef.current();
    if (!live) {
      rateEmaRef.current = 0;
      return;
    }
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (stopped) return;
      try {
        await resampleRef.current();
      } catch {
        /* a transient sample failure must not kill the loop */
      }
      if (stopped) return;
      timer = window.setTimeout(() => void tick(), resampleIntervalMs);
    };
    timer = window.setTimeout(() => void tick(), resampleIntervalMs);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      rateEmaRef.current = 0;
      lastResampleTsRef.current = 0;
    };
  }, [live, winStart, resampleIntervalMs]);

  // Safety net: re-sample whenever the trace window grows. Catches the
  // first render after mount (where `winEnd` may still be `0` because
  // `useTrace` hasn't resolved the registry entry yet — its one-shot
  // resample would then see an empty window, and the renderedThrough
  // skip would suppress later ticks of the loop too) and keeps a
  // stopped / paused plot (whose loop is off) re-sampled when its
  // window otherwise changes. Cheap: deduped by the busy-guard and the
  // renderedThrough skip.
  useEffect(() => {
    void resampleRef.current();
  }, [winEnd]);

  // Forced re-sample when "follow live" toggles (so it snaps to / off
  // the live edge immediately).
  useEffect(() => {
    void resampleRef.current();
  }, [followLive]);

  // Forced re-sample on any programmatic x-window change (goto-event, Fit
  // Data, user pan/zoom). A running trace already refetches via the
  // resample loop; this is what keeps a *stopped* trace from jumping its
  // x-window without pulling the slice at the destination (ADR 0024).
  useEffect(() => {
    void resampleRef.current();
  }, [xEpoch]);

  // Panel asked us to refit y — drop any manual Fit Y override so the
  // next tick uses the host extent (follow-live) / visible slice fresh.
  useEffect(() => {
    manualRangesRef.current = new Map();
    manualFitYRef.current = false;
  }, [resetYEpoch]);

  /** Manual Fit Y: snapshot the *currently rendered* extent of each
   * series and pin it as the auto-norm range until Fit Data is hit.
   * Useful when the live capture has wide outliers but the user wants
   * the visible region's detail to fill the canvas. */
  const fitY = useCallback(() => {
    const sm = seriesRef.current;
    const next = new Map<string, { lo: number; hi: number }>();
    for (const [key, ser] of sm) {
      if (ser.v.length === 0) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of ser.v) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) continue;
      next.set(key, { lo, hi });
    }
    manualRangesRef.current = next;
    manualFitYRef.current = true;
    void resampleRef.current();
  }, []);
  // Wire the toolbar's "fit y" button to this area's `fitY`. Skip the
  // first run so we don't fire one on initial mount.
  const fitYEpochPrevRef = useRef(fitYEpoch);
  useEffect(() => {
    if (fitYEpochPrevRef.current === fitYEpoch) return;
    fitYEpochPrevRef.current = fitYEpoch;
    fitY();
  }, [fitYEpoch, fitY]);

  // Promoting a signal to primary needs to update the y-axis labels
  // *now* — the next resample is potentially seconds away (e.g. when
  // not following live). We refresh `primaryAxisRef` from the latest
  // effective range and ask uPlot to redraw axes only (the data
  // hasn't changed).
  useEffect(() => {
    if (primaryKey) {
      const r = effectiveRangesRef.current.get(primaryKey);
      if (r) {
        const sig = signals.find((s) => signalRefKey(s) === primaryKey);
        primaryAxisRef.current = { lo: r.lo, hi: r.hi, unit: sig?.unit ?? null };
      } else {
        primaryAxisRef.current = null;
      }
    } else {
      primaryAxisRef.current = null;
    }
    const u = uplotRef.current;
    // `redraw(rebuildPaths=false, recalcAxes=true)` — keep the cached
    // series geometry, just re-measure / re-label the axes.
    u?.redraw(false, true);
  }, [primaryKey, signals]);

  // Show / hide series in place when the per-signal `hidden` flags
  // change — no uPlot re-create needed (`signalSetKey` excludes it).
  const hiddenKey = signals.map((s) => (s.hidden ? "1" : "0")).join("");
  useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    signals.forEach((s, i) => u.setSeries(i + 1, { show: !s.hidden }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKey]);

  // Redraw the overlay when cursors / the shared crosshair / events
  // change (no resample).
  useEffect(() => {
    uplotRef.current?.redraw(false, false);
  }, [cursorXa, cursorXb, cursorYh1, cursorYh2, hoverX, events, isFirst, isLast]);

  const dh = cursorYh1 != null && cursorYh2 != null ? cursorYh2 - cursorYh1 : null;

  const displayValueFor = (key: string): number | null => {
    void valueTick;
    const s = seriesRef.current.get(key);
    if (s) {
      if (cursorXa != null) return valueAt(s, cursorXa);
      if (hoverX != null) return valueAt(s, hoverX);
    }
    return presentRef.current.get(key) ?? null;
  };
  /** The y-range the auto-normalisation is using for `key` right now —
   * surfaced in the side-panel rows so it's possible to *see*
   * whether the range is stable (latched under follow-live) or
   * changing tick-to-tick. */
  const rangeFor = (key: string): { lo: number; hi: number } | null => {
    void valueTick;
    return effectiveRangesRef.current.get(key) ?? null;
  };
  /** Cache x-origin (the application-level trace start, absolute seconds —
   * ADR 0024) — diagnostic. If this stays the same across a Clear, the cache
   * anchor didn't re-establish and the visible x-axis is in the *old*
   * timescale. */
  const cacheBaseValue = (): number | null => {
    void valueTick;
    return currentRange()?.base ?? null;
  };
  /** Leftmost and rightmost relative-t values cached for `key` —
   * diagnostic for whether the cache covers the visible x range. If
   * the line stops short of an edge, the cache's range here will
   * show why. */
  const cacheTRangeFor = (key: string): { first: number; last: number } | null => {
    void valueTick;
    const s = currentRange()?.byKey.get(key);
    if (!s || s.t.length === 0) return null;
    return { first: s.t[0], last: s.t[s.t.length - 1] };
  };
  /** Format a current value for the side panel. If the signal has a
   * value table, render as `<label> (<raw>)` for enum-style readout;
   * otherwise fall through to numeric. The raw is shown rounded —
   * enum codes are integers, and `Math.round` matches the lane's
   * `labelFor` lookup. */
  const formatValueFor = (key: string, v: number | null): string => {
    if (v == null || !Number.isFinite(v)) return "—";
    const table = valueTables.get(key);
    if (table) {
      const raw = Math.round(v);
      const label = table.find((r) => r.raw === raw)?.label;
      if (label) return `${label} (${raw})`;
    }
    return fmtVal(v);
  };
  const valueTitle = cursorXa != null ? "value at cursor A" : hoverX != null ? "value at crosshair" : "latest value";
  // With both X cursors placed: Δ value (A − B), shown as a second line
  // under the per-signal value.
  const showAbDelta = cursorXa != null && cursorXb != null;
  const deltaAbFor = (key: string): number | null => {
    void valueTick;
    if (cursorXa == null || cursorXb == null) return null;
    const s = seriesRef.current.get(key);
    if (!s) return null;
    const a = valueAt(s, cursorXa);
    const b = valueAt(s, cursorXb);
    return a != null && b != null ? a - b : null;
  };

  return (
    <div
      className={`plot-area${focused ? " focused" : ""}`}
      onMouseDown={onFocus}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SIGNAL_DND_MIME)) {
          e.preventDefault();
          // `copy` shows the "+" cursor — matches the transmit
          // panel's drop affordance and is the more useful signal
          // ("you can drop here"). The actual move-vs-add decision
          // happens at drop time via `sourcePanelId`, so the cursor
          // doesn't have to match the post-drop semantics.
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const { refs, sourcePanelId } = parseDroppedSignals(
          e.dataTransfer.getData(SIGNAL_DND_MIME),
        );
        if (refs.length === 0) return;
        e.preventDefault();
        const isInternalMove = sourcePanelId === panelElementId;
        // Append each ref in order. For internal drags this is a
        // move (strip from origin + insert); for external drags
        // it's an add.
        for (const r of refs) onDropSignal(r, null, isInternalMove);
      }}
    >
      <div className="plot-area-canvas" ref={canvasRef} />
      <div
        className="plot-area-resizer"
        role="separator"
        aria-orientation="vertical"
        title="drag to resize the side panel"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const startX = e.clientX;
          const startWidth = signalsWidth;
          const onMove = (ev: MouseEvent) => {
            // Side panel is right of the canvas, so dragging left
            // *widens* the side panel: width = startWidth - delta.
            onResizeSignalsWidth(startWidth - (ev.clientX - startX));
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      />
      <div className="plot-area-signals" style={{ flexBasis: `${signalsWidth}px` }}>
        <div className="plot-area-signals-head">
          <span
            className="plot-area-label"
            title={(() => {
              const b = cacheBaseValue();
              return b == null
                ? "no cache yet"
                : `cache x-origin (trace start): ${b.toFixed(3)} s — diagnostic for whether the cache re-anchored after a Clear`;
            })()}
          >
            {label}
          </span>
          <button
            className="plot-area-fit-y"
            title="fit y to the currently visible data — useful when zoomed in and you want the visible region to fill the canvas height"
            onClick={(e) => {
              e.stopPropagation();
              fitY();
            }}
          >
            fit y
          </button>
          {isParentHead && (
            // `display: contents` span: keeps the trigger a direct flex
            // item of the head while swallowing clicks (the head's own
            // click handler must not fire when using the picker).
            <span style={{ display: "contents" }} onClick={(e) => e.stopPropagation()}>
              <Combobox
                className="plot-area-y-mode"
                title="y-axis mode: unified (one axis), per-unit (one axis per unit), individual (one axis per series)"
                options={Y_AXIS_MODE_OPTIONS}
                value={area.yAxisMode ?? "unified"}
                ariaLabel="y-axis mode"
                onChange={(v) => onSetYAxisMode(v as YAxisMode)}
              />
            </span>
          )}
          {isParentHead && (
            <button
              className="plot-area-filter"
              title={
                area.signalFilter == null
                  ? "filter this area's signals by regex"
                  : "edit the regex driving this area"
              }
              onClick={(e) => {
                e.stopPropagation();
                setFilterEditOpen((v) => !v);
              }}
            >
              {area.signalFilter == null ? "filter…" : "filter ✎"}
            </button>
          )}
          {removable && (
            <button
              className="plot-area-remove"
              title="remove this plot area"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveArea();
              }}
            >
              ×
            </button>
          )}
        </div>
        {area.signalFilter != null && (
          <div className="plot-area-filter-status" title="filter-defined plot area (ADR 0020)">
            <span className="plot-area-filter-regex">
              /{area.signalFilter}/
            </span>
            <span className="plot-area-filter-count">
              {signals.length} signal{signals.length === 1 ? "" : "s"}
            </span>
            <button
              className="plot-area-filter-promote"
              title="convert to manual: keep these signals as a fixed list and clear the regex"
              onClick={(e) => {
                e.stopPropagation();
                onPromoteFilterToManual();
              }}
            >
              ⇨ manual
            </button>
            <button
              className="plot-area-filter-clear"
              title="discard the regex and revert to manual mode (signals you had before the filter come back)"
              onClick={(e) => {
                e.stopPropagation();
                onSetSignalFilter(undefined);
              }}
            >
              ×
            </button>
          </div>
        )}
        {filterEditOpen && (
          <SignalFilterEditor
            initial={area.signalFilter ?? ""}
            hasManualSignals={!area.signalFilter && area.signals.length > 0}
            onApply={(re) => {
              onSetSignalFilter(re || undefined);
              setFilterEditOpen(false);
            }}
            onCancel={() => setFilterEditOpen(false)}
          />
        )}
        {(cursorYh1 != null || cursorYh2 != null) && (
          <div className="plot-area-ycursors">
            <span className="gold">H1 {fmtVal(cursorYh1)}</span>
            <span className="pink">H2 {fmtVal(cursorYh2)}</span>
            <span>ΔH {fmtVal(dh)}</span>
          </div>
        )}
        {signals.length === 0 ? (
          <div className="plot-area-empty">{focused ? "pick a signal above" : "click here, then pick a signal"}</div>
        ) : (
          signals.map((s) => {
            const key = signalRefKey(s);
            const v = displayValueFor(key);
            const isPrimary = key === primaryKey;
            return (
              <div
                className={`plot-signal-row${s.hidden ? " hidden" : ""}${isPrimary ? " primary" : ""}`}
                key={key}
                title={isPrimary ? "primary signal (drives the y-axis units)" : "click to make this the primary signal for this area"}
                onClick={(e) => {
                  // Don't promote on a click that originated on the
                  // swatch / value / remove button — those have their
                  // own handlers (`stopPropagation`).
                  if (e.defaultPrevented) return;
                  onSetPrimarySignal(key);
                }}
                draggable
                onDragStart={(e) => {
                  // Always emit the array form — the receiving panel
                  // parses both shapes, but the new shape is one less
                  // case to maintain downstream. Strip `color` /
                  // `hidden` so the payload matches the
                  // `DraggableSignalRef` contract. Stamp the source
                  // panel id so a same-panel drop is treated as a
                  // move (across-panel drops fall through to add).
                  setSignalDragData(
                    e,
                    [{
                      busId: s.busId,
                      messageId: s.messageId,
                      extended: s.extended,
                      signalName: s.signalName,
                      messageName: s.messageName,
                      unit: s.unit,
                    }],
                    panelElementId,
                  );
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(SIGNAL_DND_MIME)) {
                    e.preventDefault();
                    e.stopPropagation();
                    // Same rationale as the area-level dragOver:
                    // "copy" gives the most legible "yes, drop here"
                    // cursor across browsers / editors. The real
                    // move-vs-add decision happens at drop time.
                    e.dataTransfer.dropEffect = "copy";
                  }
                }}
                onDrop={(e) => {
                  const { refs, sourcePanelId } = parseDroppedSignals(
                    e.dataTransfer.getData(SIGNAL_DND_MIME),
                  );
                  if (refs.length === 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const isInternalMove = sourcePanelId === panelElementId;
                  // Forward iteration preserves drop-order — each
                  // `placeSignal(ref, areaId, key)` inserts before
                  // the same row, so the first ref ends up first.
                  for (const r of refs) onDropSignal(r, key, isInternalMove);
                }}
              >
                <SignalSwatch
                  hidden={!!s.hidden}
                  color={s.color}
                  onToggleHidden={() => onToggleHidden(key)}
                  onPickColor={(c) => onSetSignalColor(key, c)}
                />
                <div className="plot-signal-text">
                  <span
                    className="plot-signal-name"
                    title={`${s.messageName}.${s.signalName} — drag to another plot area`}
                  >
                    {s.signalName}
                  </span>
                  <span className="plot-signal-message" title={s.messageName}>
                    {s.busId ? (
                      <>
                        <span
                          className="plot-bus-swatch"
                          style={{ background: busColorLookup.get(s.busId) ?? "#94a3b8" }}
                          aria-hidden="true"
                        />
                        {`${busNameLookup.get(s.busId) ?? s.busId} · ${s.messageName}`}
                      </>
                    ) : (
                      s.messageName
                    )}
                  </span>
                </div>
                <div className="plot-signal-readout">
                  <span className="plot-signal-value" title={valueTitle}>
                    {formatValueFor(key, v)}
                    {/* Unit suffix is only meaningful for numeric
                     * readouts — an enum row already self-labels via
                     * `<label> (<raw>)` and tacking on a unit string
                     * (often the empty string anyway) reads as noise.
                     * A single-member table is not an enum
                     * (`isEnumValueTable`), so its signal keeps the
                     * unit. */}
                    {!isEnumValueTable(valueTables.get(key)) && s.unit ? ` ${s.unit}` : ""}
                  </span>
                  {showAbDelta && (
                    <small className="plot-signal-delta" title="Δ value (cursor A − cursor B)">
                      Δ {fmtVal(deltaAbFor(key))}
                      {!isEnumValueTable(valueTables.get(key)) && s.unit ? ` ${s.unit}` : ""}
                    </small>
                  )}
                </div>
                <button
                  className="plot-signal-remove"
                  title="remove this signal"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveSignal(key);
                  }}
                >
                  ×
                </button>
                {showDiag && (() => {
                  const r = rangeFor(key);
                  const t = cacheTRangeFor(key);
                  if (r == null && t == null) return null;
                  return (
                    <small
                      className="plot-signal-range"
                      title="y-range: auto-normalisation latch (lo … hi). t-range: leftmost / rightmost cached sample's relative time (seconds). Useful for diagnosing a line that doesn't reach the canvas edges — if t doesn't span the visible x range, the cache is missing data there."
                    >
                      {r != null ? (
                        <>
                          y[{fmtVal(r.lo)} … {fmtVal(r.hi)}]
                        </>
                      ) : null}
                      {t != null ? (
                        <>
                          {" "}
                          t[{t.first.toFixed(2)} … {t.last.toFixed(2)}]
                        </>
                      ) : null}
                    </small>
                  );
                })()}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/// Inline regex editor for a plot area's `signalFilter` (ADR 0020).
/// Sits below the area's side-panel head when open. Apply
/// validates the regex by attempting to construct a `RegExp` and
/// surfaces a "bad regex" hint on failure; the area's filter is
/// only set when the regex compiles.
function SignalFilterEditor({
  initial,
  hasManualSignals,
  onApply,
  onCancel,
}: {
  initial: string;
  /// True when the area currently has manually-managed signals that
  /// will be discarded by entering filter mode. Surfaces a small
  /// hint so the user isn't surprised.
  hasManualSignals: boolean;
  /// Apply receives the new regex string. An empty string means
  /// "clear the filter / stay in manual mode"; otherwise filter
  /// mode is entered.
  onApply: (regex: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = useCallback(() => {
    if (value === "") {
      onApply("");
      return;
    }
    try {
      new RegExp(value);
      onApply(value);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [value, onApply]);
  return (
    <div className="plot-filter-editor" onMouseDown={(e) => e.stopPropagation()}>
      <input
        type="text"
        autoFocus
        value={value}
        placeholder="^busName\\.MessageName\\..*Speed$"
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          else if (e.key === "Escape") onCancel();
        }}
        aria-label="signal filter regex"
      />
      <button onClick={submit}>apply</button>
      <button onClick={onCancel}>×</button>
      {hasManualSignals && (
        <div className="plot-filter-editor-hint">
          Applying a filter discards this area's manual signal list.
        </div>
      )}
      {error && (
        <div className="plot-filter-editor-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

