import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import type { SignalDescriptorRecord } from "./types";
import { useTraceData } from "./traceData";
import { useProjectContext } from "./projectContext";
import { useElementRegistry } from "./projectElements";
import { useTrace } from "./trace";
import { TraceControls } from "./TraceControls";
import { decodeSignalsSample, mergeSeries, signalKey } from "./plotData";
import {
  DEFAULT_MEASUREMENTS,
  MEASUREMENT_QUANTITIES,
  type MeasurementKey,
  type Series,
  isMeasurementKey,
  statsOver,
  valueAt,
} from "./plotCursors";

/**
 * The Phase-4 signal-plotting panel — a software oscilloscope for
 * decoded CAN signals, in the spirit of vSignalyzer / CANape. See
 * `plans/phased-implementation.md` Phase 4 and
 * `plans/plot-panel-reference.html` for the target design.
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
 * latest sample) with a Δ(A − B) line under it once both X cursors are
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
 * ends it). Each tick computes the *visible* frame range (from the
 * shared x window plus an fps estimate carried in the cache), asks
 * `sample_signals` for just that range with `max_points` matched to
 * canvas width, and replaces the area's cache with the response
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
 * lines; the event log renames (click) and removes notes.
 *
 * Persistable state (the trace `elementId`, areas + signal→area
 * assignment, y-ranges, follow-live, cursor mode, measurement
 * toggle/selection, notes; cursor positions best-effort) is mirrored
 * into the dockview panel `params`. Pixel-level overlay drawing and the
 * canvas event wiring aren't unit-tested; the cursor/measurement maths
 * (`plotCursors.ts`) and the decimation (`signal_sampler`) are.
 *
 * Not built yet (`plans/backlog.md`): per-*trace* y offset/gain & log
 * scale; enum/state signals; triggers; CSV/image export.
 */

const TRACE_COLORS = [
  "#c6f24e",
  "#4ecbff",
  "#ffaa3d",
  "#b48cff",
  "#ff7e5a",
  "#ffd93d",
  "#5ddb7c",
  "#e15dcf",
];
const CURSOR_A_COLOR = "#ffd93d";
const CURSOR_B_COLOR = "#ff5577";
const EVENT_COLOR = "#4ecbff";
const AXIS_STROKE = "#cbd5e1";
const AXIS_GRID = "#222b35";
const AXIS_TICKS = "#3a4654";
const ZOOM_STEP = 1.15;
/** Floor for `sample_signals`' `max_points` (the host min/max-decimates
 * to at most `2 * max_points`). 2× the canvas width is what we ask for
 * in practice; the floor catches early-mount cases where `clientWidth`
 * is still small. */
const MIN_DECIMATION_POINTS = 200;
/** Plot update-rate options (Hz) offered in the toolbar, and the
 * default. Lower = less CPU under a fast capture; the re-sample loop is
 * self-paced (next tick scheduled after the previous finishes), so a
 * slow tick just lowers the realised rate further. */
const RATE_OPTIONS = [5, 10, 15, 30, 60] as const;
const DEFAULT_MAX_RATE_HZ = 15;
/** Width (seconds) of the follow-live x-window before the user has set
 * one by zooming/panning. The window grows from t=0 up to this and then
 * slides; once the user picks a width, that width is what follow-live
 * keeps. */
const DEFAULT_FOLLOW_WIDTH_SECONDS = 10;

type CursorMode = "off" | "x" | "y" | "note";

interface SignalRef {
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

type YMode = "auto" | { min: number; max: number };

interface PlotAreaConfig {
  id: string;
  signals: SignalRef[];
  yMode: YMode;
}

interface NoteEvent {
  id: string;
  /** Time in display-relative seconds. */
  t: number;
  label: string;
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
  cursorX?: unknown;
  cursorYByArea?: unknown;
  notes?: unknown;
  maxRateHz?: unknown;
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
  return signalKey(s.messageId, s.extended, s.signalName);
}

function isSignalRefCore(v: unknown): v is Omit<SignalRef, "color"> {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.messageId === "number" &&
    typeof o.extended === "boolean" &&
    typeof o.signalName === "string" &&
    typeof o.messageName === "string" &&
    typeof o.unit === "string"
  );
}
function withColor(s: Omit<SignalRef, "color"> & { color?: unknown }, fallbackIdx: number): SignalRef {
  return { ...s, color: typeof s.color === "string" ? s.color : TRACE_COLORS[fallbackIdx % TRACE_COLORS.length] };
}

/** Drag-and-drop MIME for a `SignalRef` (within or across plot panels —
 * the payload is the full ref so the receiving panel can add it even if
 * it's not one of its own signals). */
const SIGNAL_DND_MIME = "application/x-cannet-plot-signal";
function parseDroppedSignal(s: string): SignalRef | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return isSignalRefCore(o) ? withColor(o, 0) : null;
  } catch {
    return null;
  }
}

function yModeFromRaw(raw: unknown): YMode {
  if (typeof raw === "object" && raw !== null) {
    const o = raw as Record<string, unknown>;
    if (typeof o.min === "number" && typeof o.max === "number" && o.min < o.max) {
      return { min: o.min, max: o.max };
    }
  }
  return "auto";
}

function areasFromParams(raw: unknown): PlotAreaConfig[] {
  if (Array.isArray(raw)) {
    const out: PlotAreaConfig[] = [];
    for (const a of raw) {
      if (typeof a !== "object" || a === null) continue;
      const o = a as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : crypto.randomUUID();
      const signals = (Array.isArray(o.signals) ? o.signals.filter(isSignalRefCore) : []).map((s, i) => withColor(s, i));
      out.push({ id, signals, yMode: yModeFromRaw(o.yMode) });
    }
    if (out.length > 0) return out;
  }
  return [{ id: crypto.randomUUID(), signals: [], yMode: "auto" }];
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

function notesFromRaw(raw: unknown): NoteEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: NoteEvent[] = [];
  for (const n of raw) {
    if (typeof n !== "object" || n === null) continue;
    const o = n as Record<string, unknown>;
    if (typeof o.t === "number" && typeof o.label === "string") {
      out.push({ id: typeof o.id === "string" ? o.id : crypto.randomUUID(), t: o.t, label: o.label });
    }
  }
  return out;
}

function fmtTime(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  if (Math.abs(s) >= 1) return `${s.toFixed(4)} s`;
  if (Math.abs(s) >= 1e-3) return `${(s * 1e3).toFixed(3)} ms`;
  if (Math.abs(s) >= 1e-6) return `${(s * 1e6).toFixed(2)} µs`;
  return `${(s * 1e9).toFixed(0)} ns`;
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
function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function elementIdFromParams(raw: unknown): string {
  const o = raw as { elementId?: unknown } | undefined;
  return typeof o?.elementId === "string" ? o.elementId : crypto.randomUUID();
}

export function PlotPanel(props: IDockviewPanelProps) {
  const data = useTraceData();
  const { dbcPaths } = useProjectContext();
  const { ensure } = useElementRegistry();

  const params = props.params as PlotPanelParams | undefined;
  const [elementId] = useState(() => elementIdFromParams(params));
  useEffect(() => {
    ensure(elementId, "plot");
  }, [ensure, elementId]);
  const trace = useTrace(data, elementId);
  const live = trace.status === "running";
  const winStart = trace.offset;
  const winEnd = trace.offset + trace.frameCount;

  const [areas, setAreas] = useState<PlotAreaConfig[]>(() => areasFromParams(params?.areas));
  const [followLive, setFollowLive] = useState(() =>
    typeof params?.followLive === "boolean" ? params.followLive : true,
  );
  const [cursorMode, setCursorMode] = useState<CursorMode>(() => cursorModeFromRaw(params?.cursorMode));
  const [measEnabled, setMeasEnabled] = useState(() =>
    typeof params?.measEnabled === "boolean" ? params.measEnabled : false,
  );
  const [measKeys, setMeasKeys] = useState<MeasurementKey[]>(() => measKeysFromRaw(params?.measKeys));
  const [maxRateHz, setMaxRateHz] = useState(() => maxRateFromRaw(params?.maxRateHz));
  const resampleIntervalMs = Math.max(1, Math.round(1000 / maxRateHz));
  const [focusedAreaId, setFocusedAreaId] = useState<string>(() => areas[0]?.id ?? "");
  const [catalog, setCatalog] = useState<SignalDescriptorRecord[]>([]);

  const [cursorX, setCursorX] = useState<XCursors>(() => {
    const o = params?.cursorX as { a?: unknown; b?: unknown } | undefined;
    return { a: typeof o?.a === "number" ? o.a : null, b: typeof o?.b === "number" ? o.b : null };
  });
  const [cursorYByArea, setCursorYByArea] = useState<Record<string, { h1: number | null; h2: number | null }>>(
    () => {
      const o = params?.cursorYByArea;
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
  const [notes, setNotes] = useState<NoteEvent[]>(() => notesFromRaw(params?.notes));

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
  // extent (longest plotted signal across the panel).
  const xSyncRef = useRef<XSync>({ suppress: false, xMin: null, xMax: null });
  const instancesRef = useRef<Map<string, uPlot>>(new Map());
  const extentByAreaRef = useRef<Map<string, number>>(new Map());

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
    }
  }, []);

  const sharedExtent = useCallback((): number | null => {
    let m: number | null = null;
    for (const v of extentByAreaRef.current.values()) m = m == null ? v : Math.max(m, v);
    return m;
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

  // A user changed an area's x window (drag-select / ⌘+wheel / shift-pan):
  // record it as the shared window, propagate, drop out of follow-live.
  const onUserXChange = useCallback(
    (min: number, max: number, fromId: string) => {
      applyXAll(min, max, fromId);
      setFollowLive(false);
    },
    [applyXAll],
  );

  // An area finished a re-sample: update the panel's data extent and, if
  // following live, slide the shared x-window to the new edge.
  const followLiveRef = useRef(followLive);
  useEffect(() => {
    followLiveRef.current = followLive;
  });
  const onAreaResampled = useCallback(
    (areaId: string, lastT: number | null) => {
      if (lastT != null) extentByAreaRef.current.set(areaId, lastT);
      else extentByAreaRef.current.delete(areaId);
      const ext = sharedExtent();
      if (ext == null) return;
      const sync = xSyncRef.current;
      if (followLiveRef.current) {
        // Slide a fixed-width window so the right edge tracks the live
        // edge. Width = whatever the user last zoomed/panned to (else a
        // default); until the capture is that long the left edge stays
        // pinned at 0 and the window just grows.
        const width =
          sync.xMin != null && sync.xMax != null && sync.xMax > sync.xMin
            ? sync.xMax - sync.xMin
            : DEFAULT_FOLLOW_WIDTH_SECONDS;
        applyXAll(Math.max(0, ext - width), ext, null);
      } else if (sync.xMax == null) {
        applyXAll(0, ext, null);
      }
    },
    [sharedExtent, applyXAll],
  );

  const fitData = useCallback(() => {
    const ext = sharedExtent();
    applyXAll(0, ext != null && ext > 0 ? ext : 1, null);
  }, [sharedExtent, applyXAll]);

  // Reset the shared window + extent when the trace window re-anchors
  // (Clear / Start gives the element a new `offset`); cursors, which are
  // in window-relative seconds, no longer mean anything then — but don't
  // wipe restored cursors on the initial mount.
  const prevWinStartRef = useRef(winStart);
  useEffect(() => {
    xSyncRef.current.xMin = null;
    xSyncRef.current.xMax = null;
    extentByAreaRef.current.clear();
    if (prevWinStartRef.current !== winStart) {
      setCursorX({ a: null, b: null });
      setCursorYByArea({});
    }
    prevWinStartRef.current = winStart;
  }, [winStart]);

  // Clear cursors / notes when the capture itself resets.
  const prevCountRef = useRef(data.count);
  useEffect(() => {
    if (prevCountRef.current > 0 && data.count === 0) {
      setCursorX({ a: null, b: null });
      setCursorYByArea({});
      setNotes([]);
    }
    prevCountRef.current = data.count;
  }, [data.count]);

  useEffect(() => {
    if (!areas.some((a) => a.id === focusedAreaId)) setFocusedAreaId(areas[0]?.id ?? "");
  }, [areas, focusedAreaId]);

  const { api } = props;
  useEffect(() => {
    api.updateParameters({
      elementId,
      areas,
      followLive,
      cursorMode,
      measEnabled,
      measKeys,
      cursorX,
      cursorYByArea,
      notes,
      maxRateHz,
    });
  }, [
    api,
    elementId,
    areas,
    followLive,
    cursorMode,
    measEnabled,
    measKeys,
    cursorX,
    cursorYByArea,
    notes,
    maxRateHz,
  ]);

  const refreshCatalog = useCallback(() => {
    void invoke<SignalDescriptorRecord[]>("list_signals").then(setCatalog);
  }, []);
  useEffect(refreshCatalog, [refreshCatalog, dbcPaths]);

  // --- area ops ---
  const addArea = useCallback(() => {
    setAreas((prev) => {
      const next: PlotAreaConfig = { id: crypto.randomUUID(), signals: [], yMode: "auto" };
      setFocusedAreaId(next.id);
      return [...prev, next];
    });
  }, []);
  const removeArea = useCallback((id: string) => {
    setAreas((prev) => (prev.length <= 1 ? prev : prev.filter((a) => a.id !== id)));
    setCursorYByArea((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    setSeriesByArea((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const setAreaYMode = useCallback((id: string, yMode: YMode) => {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, yMode } : a)));
  }, []);

  const addSignalToFocused = useCallback(
    (desc: SignalDescriptorRecord) => {
      setAreas((prev) => {
        const targetId = prev.some((a) => a.id === focusedAreaId) ? focusedAreaId : prev[0]?.id;
        const total = prev.reduce((n, a) => n + a.signals.length, 0);
        const ref: SignalRef = {
          messageId: desc.message_id,
          extended: desc.extended,
          signalName: desc.signal_name,
          messageName: desc.message_name,
          unit: desc.unit,
          color: TRACE_COLORS[total % TRACE_COLORS.length],
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
      prev.map((a) => (a.id === areaId ? { ...a, signals: a.signals.filter((s) => signalRefKey(s) !== key) } : a)),
    );
  }, []);
  // A signal was dropped into `toAreaId`. If it already lives in this
  // panel it's moved (and removed from its old area — keeping its
  // colour); if not (drag from another panel) a copy is added. Inserted
  // before `beforeKey`'s row, or appended when `beforeKey` is null.
  const placeSignal = useCallback((ref: SignalRef, toAreaId: string, beforeKey: string | null) => {
    const key = signalRefKey(ref);
    if (beforeKey === key) return; // dropped a row on itself — no-op
    setAreas((prev) => {
      // What to insert: the existing ref (preserves its colour) if we
      // have it, else the dropped one.
      const existing = prev.flatMap((a) => a.signals).find((s) => signalRefKey(s) === key);
      const moved = existing ?? ref;
      const stripped = prev.map((a) => ({ ...a, signals: a.signals.filter((s) => signalRefKey(s) !== key) }));
      return stripped.map((a) => {
        if (a.id !== toAreaId) return a;
        if (beforeKey == null || beforeKey === key) return { ...a, signals: [...a.signals, moved] };
        const idx = a.signals.findIndex((s) => signalRefKey(s) === beforeKey);
        if (idx < 0) return { ...a, signals: [...a.signals, moved] };
        return { ...a, signals: [...a.signals.slice(0, idx), moved, ...a.signals.slice(idx)] };
      });
    });
  }, []);
  const toggleSignalHidden = useCallback((areaId: string, key: string) => {
    setAreas((prev) =>
      prev.map((a) =>
        a.id === areaId
          ? { ...a, signals: a.signals.map((s) => (signalRefKey(s) === key ? { ...s, hidden: !s.hidden } : s)) }
          : a,
      ),
    );
  }, []);

  // --- cursors / notes ---
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
  const addNote = useCallback((t: number) => {
    setNotes((p) => [...p, { id: crypto.randomUUID(), t, label: `note ${p.length + 1}` }]);
  }, []);
  const renameNote = useCallback((id: string, label: string) => {
    setNotes((p) => p.map((n) => (n.id === id ? { ...n, label } : n)));
  }, []);
  const removeNote = useCallback((id: string) => setNotes((p) => p.filter((n) => n.id !== id)), []);

  const reportSeries = useCallback(
    (areaId: string, series: Map<string, Series>) => {
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

  const catalogOptions = useMemo(
    () =>
      catalog.map((s) => ({
        key: signalKey(s.message_id, s.extended, s.signal_name),
        label: `${s.message_name}.${s.signal_name}${s.unit ? ` [${s.unit}]` : ""}`,
        desc: s,
      })),
    [catalog],
  );
  const areaLabels = useMemo(() => new Map(areas.map((a, i) => [a.id, `Area ${i + 1}`])), [areas]);

  const plottedSignals = useMemo(() => {
    const out: Array<{ key: string; ref: SignalRef; color: string; areaId: string }> = [];
    for (const a of areas) {
      for (const s of a.signals) out.push({ key: signalRefKey(s), ref: s, color: s.color, areaId: a.id });
    }
    return out;
  }, [areas]);
  const seriesFor = useCallback(
    (areaId: string, key: string): Series | undefined => seriesByArea.get(areaId)?.get(key),
    [seriesByArea],
  );
  const events = useMemo(() => [{ id: "__t0", t: 0, label: "T0" }, ...notes], [notes]);
  const dt = cursorX.a != null && cursorX.b != null ? cursorX.b - cursorX.a : null;

  return (
    <div className="plot-panel">
      <div className="plot-panel-toolbar">
        <TraceControls
          status={trace.status}
          onStart={trace.start}
          onStop={trace.stop}
          onPause={trace.pause}
          onResume={trace.resume}
          onClear={trace.clear}
        />
        <span className="plot-toolbar-sep" />
        <select
          value=""
          onChange={(e) => {
            const opt = catalogOptions.find((o) => o.key === e.target.value);
            if (opt) addSignalToFocused(opt.desc);
            e.currentTarget.selectedIndex = 0;
          }}
          aria-label="add signal to focused plot area"
        >
          <option value="">{catalog.length === 0 ? "no DBC attached" : "add signal…"}</option>
          {catalogOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <button onClick={refreshCatalog} title="reload signal list from the attached DBC">
          ↻
        </button>
        <button onClick={addArea}>add plot area</button>
        <button onClick={fitData}>fit data</button>
        <label className="checkbox">
          <input type="checkbox" checked={followLive} onChange={(e) => setFollowLive(e.target.checked)} />
          follow live
        </label>
        <span className="plot-toolbar-sep" />
        <label className="plot-cursor-ctl">
          cursors
          <select value={cursorMode} onChange={(e) => setCursorMode(e.target.value as CursorMode)}>
            <option value="off">off</option>
            <option value="x">X (A / B)</option>
            <option value="y">Y (H1 / H2)</option>
            <option value="note">+ note</option>
          </select>
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
          <select value={maxRateHz} onChange={(e) => setMaxRateHz(Number(e.target.value))}>
            {RATE_OPTIONS.map((hz) => (
              <option key={hz} value={hz}>
                {hz} Hz
              </option>
            ))}
          </select>
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

      <div className="plot-panel-areas">
        {areas.map((area, idx) => {
          const yc = cursorYByArea[area.id];
          return (
            <PlotArea
              key={area.id}
              area={area}
              label={areaLabels.get(area.id) ?? "Area"}
              isFirst={idx === 0}
              isLast={idx === areas.length - 1}
              focused={area.id === focusedAreaId}
              removable={areas.length > 1}
              winStart={winStart}
              winEnd={winEnd}
              live={live}
              followLive={followLive}
              resampleIntervalMs={resampleIntervalMs}
              cursorMode={cursorMode}
              cursorXa={cursorX.a}
              cursorXb={cursorX.b}
              cursorYh1={yc?.h1 ?? null}
              cursorYh2={yc?.h2 ?? null}
              events={events}
              xSyncRef={xSyncRef}
              registerInstance={registerInstance}
              onUserXChange={onUserXChange}
              onAreaResampled={onAreaResampled}
              onPlaceCursorX={placeCursorX}
              onPlaceCursorY={(which, v) => placeCursorY(area.id, which, v)}
              onAddNote={addNote}
              onReportSeries={reportSeries}
              onReportPerf={reportPerf}
              onReportHostMs={reportHostMs}
              onReportRate={reportRate}
              onReportCache={reportCache}
              onSetYMode={(m) => setAreaYMode(area.id, m)}
              onFocus={() => setFocusedAreaId(area.id)}
              onRemoveArea={() => removeArea(area.id)}
              onRemoveSignal={(key) => removeSignal(area.id, key)}
              onDropSignal={(ref, beforeKey) => placeSignal(ref, area.id, beforeKey)}
              onToggleHidden={(key) => toggleSignalHidden(area.id, key)}
            />
          );
        })}
      </div>

      {measEnabled && (
        <div className="plot-meas-strip">
          {measKeys.includes("a") && <MeasCell k="A (t)" v={fmtTime(cursorX.a)} cls="gold" />}
          {measKeys.includes("b") && <MeasCell k="B (t)" v={fmtTime(cursorX.b)} cls="pink" />}
          {measKeys.includes("dt") && <MeasCell k="Δt" v={fmtTime(dt)} />}
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

      {notes.length > 0 && (
        <div className="plot-events-log">
          {notes
            .slice()
            .sort((a, b) => a.t - b.t)
            .map((n) => (
              <EventLogRow
                key={n.id}
                t={fmtTime(n.t)}
                label={n.label}
                onRename={(l) => renameNote(n.id, l)}
                onRemove={() => removeNote(n.id)}
              />
            ))}
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

function EventLogRow({
  t,
  label,
  onRename,
  onRemove,
}: {
  t: string;
  label: string;
  onRename: (l: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const commit = () => {
    if (draft.trim()) onRename(draft.trim());
    setEditing(false);
  };
  return (
    <div className="plot-event-row">
      <span className="plot-event-t">{t}</span>
      {editing ? (
        <input
          className="plot-event-edit"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              setDraft(label);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className="plot-event-label"
          title="click to rename"
          onClick={() => {
            setDraft(label);
            setEditing(true);
          }}
        >
          {label}
        </span>
      )}
      <button onClick={onRemove} title="remove note">
        ×
      </button>
    </div>
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
  winStart: number;
  winEnd: number;
  live: boolean;
  followLive: boolean;
  /** Min spacing between live re-samples (ms) — `1000 / maxRateHz`. */
  resampleIntervalMs: number;
  cursorMode: CursorMode;
  cursorXa: number | null;
  cursorXb: number | null;
  cursorYh1: number | null;
  cursorYh2: number | null;
  events: Array<{ id: string; t: number; label: string }>;
  xSyncRef: MutableRefObject<XSync>;
  registerInstance: (id: string, u: uPlot | null) => void;
  onUserXChange: (min: number, max: number, fromId: string) => void;
  onAreaResampled: (areaId: string, lastT: number | null) => void;
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
  onSetYMode: (m: YMode) => void;
  onFocus: () => void;
  onRemoveArea: () => void;
  onRemoveSignal: (key: string) => void;
  /** A signal was dropped here. `beforeKey` null ⇒ append to this area;
   * otherwise insert before that row (re-order / move). The ref may be
   * one this panel doesn't have yet (drag from another panel). */
  onDropSignal: (ref: SignalRef, beforeKey: string | null) => void;
  onToggleHidden: (key: string) => void;
}

/** A plot area's sample cache: the data currently shown on the plot,
 * as a snapshot of the *visible* x-range from the host. Each resample
 * computes the visible frame range (from the shared x window plus an
 * fps estimate carried in this cache), asks `sample_signals` for that
 * range with `max_points` matched to canvas width, and replaces
 * {@link byKey} with the response. Memoised by {@link fetchKey} so
 * follow-live ticks where nothing changed (window paused, no zoom)
 * skip the host round-trip. Times in {@link byKey} are relative to
 * {@link base}, the timestamp of the trace window's first frame; this
 * stays stable even when the fetched range starts past it (zoomed-in
 * panels), so the x-axis origin is consistent across fetches. */
interface AreaCache {
  signalSetKey: string;
  anchorStart: number;
  /** ts(frame at `anchorStart`), set on the first fetch (which always
   * starts at `anchorStart` so the origin is unambiguous). */
  base: number | null;
  /** Relative time (seconds since `base`) of the last fetch's last
   * frame — the right edge for follow-live. */
  lastT: number | null;
  /** Estimated frames-per-second of the trace, carried from the last
   * fetch's response (`(visEnd - visStart) / (res.last - res.from)`).
   * Used to convert the visible x range to frame indices for the next
   * fetch; `null` until the first non-empty fetch completes. */
  fps: number | null;
  byKey: Map<string, { t: number[]; v: number[] }>;
  /** Per-signal observed `{lo, hi}` value range across every fetch
   * into this cache anchor — used by the auto-normalisation. Only
   * *widens*, never shrinks, so the rendered line doesn't slide
   * vertically every tick as new (slightly different) min/max values
   * arrive from a fresh decimation. Reset when the cache anchor
   * changes (signal set, buffer clear). */
  traceRanges: Map<string, { lo: number; hi: number }>;
  /** `${visStart}:${visEnd}:${maxPoints}` — skip the fetch if it
   * matches what we last asked for. */
  fetchKey: string;
  /** Latest `winEnd` we've seen, to detect a buffer clear shrinking
   * the window under us. */
  lastWinEnd: number;
}

function PlotArea(p: PlotAreaProps) {
  const {
    area,
    label,
    isFirst,
    isLast,
    focused,
    removable,
    winStart,
    winEnd,
    live,
    followLive,
    resampleIntervalMs,
    cursorMode,
    cursorXa,
    cursorXb,
    cursorYh1,
    cursorYh2,
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
    onSetYMode,
    onFocus,
    onRemoveArea,
    onRemoveSignal,
    onDropSignal,
    onToggleHidden,
  } = p;

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const seriesRef = useRef<Map<string, Series>>(new Map());
  const presentRef = useRef<Map<string, number | null>>(new Map());
  const resampleBusyRef = useRef(false);
  const cacheRef = useRef<AreaCache | null>(null);
  /** One-shot: have we already done the post-mount rebuild that
   * compensates for restored-from-project panels where the canvas
   * isn't laid out yet at uPlot's first construction? */
  const postMountRebuildDoneRef = useRef(false);
  const lastResampleTsRef = useRef(0);
  const rateEmaRef = useRef(0);
  const hoverRafRef = useRef(0);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [valueTick, setValueTick] = useState(0); // bump → re-render side panel
  const [yEditOpen, setYEditOpen] = useState(false);
  // Bumped from the first ResizeObserver tick when the canvas turns
  // out to be a different size than what uPlot was constructed at
  // (typical on initial mount — dockview hasn't laid the panel out
  // yet). The construction effect depends on this, so bumping it
  // destroys + rebuilds uPlot at the now-correct size.
  const [resizeTick, setResizeTick] = useState(0);

  const areaId = area.id;
  const signals = area.signals;
  const signalSetKey = signals.map(signalRefKey).join("|");
  const yMode = area.yMode;

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
    yMode,
    cursorMode,
    cursorXa,
    cursorXb,
    cursorYh1,
    cursorYh2,
    events,
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
  });
  useEffect(() => {
    liveRef.current = {
      winStart,
      winEnd,
      yMode,
      cursorMode,
      cursorXa,
      cursorXb,
      cursorYh1,
      cursorYh2,
      events,
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
    resampleBusyRef.current = true;
    const t0 = performance.now();
    try {
      const lr = liveRef.current;
      if (signals.length === 0) {
        cacheRef.current = null;
        withSuppressed(() => u.setData([[]]));
        seriesRef.current = new Map();
        presentRef.current = new Map();
        lr.onReportSeries(areaId, new Map());
        lr.onAreaResampled(areaId, null);
        lr.onReportCache(areaId, 0);
        recordRate();
        lr.onReportRate(areaId, rateEmaRef.current);
        setValueTick((v) => v + 1);
        return;
      }

      // (Re)anchor the cache. Reset whenever the signal set or the
      // trace window changes anchor, or `winEnd` shrinks under us (the
      // session buffer was cleared).
      const sk = signals.map(signalRefKey).join("|");
      let cache = cacheRef.current;
      if (
        !cache ||
        cache.anchorStart !== lr.winStart ||
        cache.signalSetKey !== sk ||
        lr.winEnd < cache.lastWinEnd
      ) {
        cache = {
          signalSetKey: sk,
          anchorStart: lr.winStart,
          base: null,
          lastT: null,
          fps: null,
          byKey: new Map(),
          traceRanges: new Map(),
          fetchKey: "",
          lastWinEnd: lr.winEnd,
        };
        cacheRef.current = cache;
      }

      // Compute the visible frame range. Without an fps estimate yet
      // (first tick), fetch the full window — that also establishes
      // `cache.base = ts(winStart)`. With an fps estimate, scope to the
      // visible x range so a zoomed-in panel asks for just that slice
      // (full detail) and a long-running show-all panel still gets the
      // whole window decimated host-side.
      const xMinReq = xSyncRef.current.xMin;
      const xMaxReq = xSyncRef.current.xMax;
      let visStart = lr.winStart;
      let visEnd = lr.winEnd;
      if (
        cache.fps != null &&
        cache.fps > 0 &&
        cache.base != null &&
        xMinReq != null &&
        xMaxReq != null &&
        xMaxReq > xMinReq
      ) {
        const winFrames = lr.winEnd - lr.winStart;
        const sStart = Math.max(0, Math.floor(xMinReq * cache.fps));
        const sEnd = Math.min(winFrames, Math.ceil(xMaxReq * cache.fps));
        visStart = lr.winStart + sStart;
        visEnd = lr.winStart + sEnd;
      }

      const canvasW = canvasRef.current?.clientWidth || 600;
      const maxPts = Math.max(MIN_DECIMATION_POINTS, Math.round(canvasW * 2));
      const fetchKey = `${visStart}:${visEnd}:${maxPts}`;

      // Same request as last successful fetch — nothing to do, just
      // keep the follow-live edge fed and the rate readout ticking.
      let biggestCache = 0;
      for (const c of cache.byKey.values()) if (c.t.length > biggestCache) biggestCache = c.t.length;
      lr.onReportCache(areaId, biggestCache);
      if (cache.fetchKey === fetchKey && cache.byKey.size > 0) {
        const wf = lr.winEnd - lr.winStart;
        const liveT = cache.fps != null && cache.fps > 0 ? wf / cache.fps : cache.lastT;
        lr.onAreaResampled(areaId, liveT);
        recordRate();
        lr.onReportRate(areaId, rateEmaRef.current);
        return;
      }

      if (visEnd <= visStart) {
        // Empty window (e.g. trace just started, no frames yet, or
        // visible x range collapsed). Clear the plot and keep ticking.
        withSuppressed(() => u.setData([[] as number[], ...signals.map(() => [] as number[])] as uPlot.AlignedData));
        cache.byKey = new Map();
        cache.fetchKey = fetchKey;
        cache.lastWinEnd = lr.winEnd;
        seriesRef.current = new Map();
        presentRef.current = new Map();
        lr.onReportSeries(areaId, new Map());
        lr.onAreaResampled(areaId, null);
        lr.onReportCache(areaId, 0);
        recordRate();
        lr.onReportRate(areaId, rateEmaRef.current);
        return;
      }

      const buf = await invoke<ArrayBuffer>("sample_signals", {
        fromIndex: visStart,
        windowEnd: visEnd,
        signals: signals.map((s) => ({
          messageId: s.messageId,
          extended: s.extended,
          signalName: s.signalName,
        })),
        maxPoints: maxPts,
      });
      const res = decodeSignalsSample(buf);
      if (uplotRef.current !== u || cacheRef.current !== cache) return;
      lr.onReportHostMs(areaId, res.slice_ms + res.decode_ms);

      if (cache.base == null) {
        // The first fetch on a fresh cache is always anchored at
        // `lr.winStart` (no fps yet), so `res.from_seconds` is exactly
        // ts(winStart) — the x-axis origin.
        if (res.from_seconds == null) return; // nothing real yet — try again next tick
        cache.base = res.from_seconds;
      }
      const base = cache.base;

      // Replace cache contents with the visible-range fetch.
      const newByKey = new Map<string, { t: number[]; v: number[] }>();
      signals.forEach((s, i) => {
        const key = signalRefKey(s);
        const got = res.series[i] ?? { t: [], v: [] };
        const t = new Array<number>(got.t.length);
        for (let j = 0; j < got.t.length; j++) t[j] = got.t[j] - base;
        newByKey.set(key, { t, v: got.v.slice() });
      });
      cache.byKey = newByKey;

      // Right edge of the fetched range, relative to base (for
      // follow-live). When the fetch was scoped to a zoomed-in slice,
      // this is the slice's right edge — but follow-live's "extent"
      // logic uses it just to slide the shared window, so that's
      // correct: we still see new data on the right.
      if (res.last_seconds != null) cache.lastT = res.last_seconds - base;

      // Update the fps estimate once — `(visEnd - visStart) /
      // (res.last_seconds - res.from_seconds)` jitters by tiny amounts
      // every fetch, which jitters `visStart` / `visEnd` in the next
      // call, which jitters the host's decimation bucket boundaries,
      // which the user sees as points popping in / out near the
      // edges. Latch fps to the first non-empty fetch's value (which
      // came from a full-window scan, so it reflects the whole trace's
      // rate); resets on cache anchor change.
      if (
        cache.fps == null &&
        res.from_seconds != null &&
        res.last_seconds != null &&
        res.last_seconds > res.from_seconds
      ) {
        cache.fps = (visEnd - visStart) / (res.last_seconds - res.from_seconds);
      }
      cache.fetchKey = fetchKey;
      cache.lastWinEnd = lr.winEnd;

      const seriesRel: Series[] = signals.map((s) => cache!.byKey.get(signalRefKey(s)) ?? { t: [], v: [] });
      // Per-trace auto-normalisation: each trace's values are re-mapped
      // to [0, 1] from its own min/max, so signals with very different
      // natural ranges (SOC 0–1 vs current ±300) both fill the canvas
      // height. The side-panel value column still shows the raw value
      // (`seriesRef` keeps the un-normalised series for that). The
      // y-axis labels become normalised positions [0, 1] — meaningful
      // numbers per trace will arrive with the per-trace gain/offset
      // controls (`plans/backlog.md`).
      //
      // The range is *persistent* across fetches (only widens, never
      // shrinks) so a fresh decimation with a slightly different
      // sample set doesn't recompute a slightly different range and
      // visibly slide the rendered line vertically every tick. Reset
      // implicitly when the cache anchor changes.
      signals.forEach((s, i) => {
        const key = signalRefKey(s);
        const ser = seriesRel[i];
        if (ser.v.length === 0) return;
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of ser.v) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
        const existing = cache!.traceRanges.get(key);
        if (existing) {
          if (lo < existing.lo) existing.lo = lo;
          if (hi > existing.hi) existing.hi = hi;
        } else {
          cache!.traceRanges.set(key, { lo, hi });
        }
      });
      // Sample-and-hold the last value to the visible right edge so a
      // sparse signal (e.g. 1 Hz on a 100 ms zoom) doesn't visually
      // "end early" between its last sample and the right edge —
      // uPlot has no next point to draw to without an explicit
      // synthetic one. The host's `slice` already includes the
      // *previous* sample for the left edge, so left-side gaps are
      // covered by the data; this is the symmetric right-edge case.
      const xMaxForExtend = xSyncRef.current.xMax;
      const displaySeries: Series[] = seriesRel.map((s, i) => {
        if (s.v.length === 0) return s;
        const range = cache!.traceRanges.get(signalRefKey(signals[i]));
        const span = range != null && range.hi > range.lo ? range.hi - range.lo : 0;
        const out = new Array<number>(s.v.length);
        if (span > 0 && range != null) {
          for (let j = 0; j < s.v.length; j++) out[j] = (s.v[j] - range.lo) / span;
        } else {
          for (let j = 0; j < s.v.length; j++) out[j] = s.v[j];
        }
        if (xMaxForExtend != null && s.t.length > 0 && s.t[s.t.length - 1] < xMaxForExtend) {
          return { t: [...s.t, xMaxForExtend], v: [...out, out[out.length - 1]] };
        }
        return { t: s.t, v: out };
      });
      const merged = mergeSeries(displaySeries) as uPlot.AlignedData;
      const xs = merged[0] as number[];
      // Live-edge time for follow-live: when the fetch was scoped to a
      // zoomed-in slice, `cache.lastT` is the slice's right edge, *not*
      // the live edge — extrapolate from the window's frame count and
      // the fps estimate so follow-live keeps sliding to the real edge.
      const winFrames = lr.winEnd - lr.winStart;
      const liveEdgeT =
        cache.fps != null && cache.fps > 0
          ? winFrames / cache.fps
          : (cache.lastT ?? (xs.length > 0 ? xs[xs.length - 1] : null));

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
        if (lr.yMode === "auto") u.setScale("y", { min: 0, max: 1 });
        else u.setScale("y", { min: lr.yMode.min, max: lr.yMode.max });
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
      lr.onReportSeries(areaId, sm);
      lr.onAreaResampled(areaId, liveEdgeT);
      lr.onReportPerf(areaId, performance.now() - t0);
      recordRate();
      lr.onReportRate(areaId, rateEmaRef.current);
      setValueTick((v) => v + 1);
    } catch {
      /* a failed sample just leaves the last one on screen */
    } finally {
      resampleBusyRef.current = false;
    }
  }, [signals, areaId, withSuppressed, recordRate]);

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
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: Math.max(60, el.clientHeight - 2),
      scales: { x: { time: false } },
      legend: { show: false },
      // uPlot's built-in drag-select (left-button) is off — we do
      // box-zoom on right-drag instead (see the `ready` hook), so
      // left-clicks are free for placing cursors / notes.
      cursor: { drag: { x: false, y: false } },
      axes: [
        { ...axisCommon, label: "time (s)", labelSize: 16, size: 34 },
        { ...axisCommon, size: 52 },
      ],
      series: [
        {},
        ...signals.map((s) => ({
          label: `${s.messageName}.${s.signalName}`,
          stroke: s.color,
          width: 1,
          points: { show: false },
          show: !s.hidden,
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
            if (hoverRafRef.current) return;
            hoverRafRef.current = requestAnimationFrame(() => {
              hoverRafRef.current = 0;
              const leftPx = u.cursor.left;
              if (leftPx == null || leftPx < 0) {
                setHoverX((prev) => (prev == null ? prev : null));
                return;
              }
              setHoverX(u.posToVal(leftPx, "x"));
            });
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
              vline(ev.t, EVENT_COLOR, ev.id === "__t0" ? [] : [2, 3], isFirst ? ev.label : null, true);
            }
            if (lr.cursorXa != null) vline(lr.cursorXa, CURSOR_A_COLOR, [4, 3], isLast ? "A" : null, false);
            if (lr.cursorXb != null) vline(lr.cursorXb, CURSOR_B_COLOR, [4, 3], isLast ? "B" : null, false);
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
                chip(xp, top + height - 18 * ratio, `Δt ${fmtTime(Math.abs(lr.cursorXb - lr.cursorXa))}`, "#cbd5e1");
              }
            }
            if (lr.cursorYh1 != null && lr.cursorYh2 != null) {
              const yp = u.valToPos((lr.cursorYh1 + lr.cursorYh2) / 2, "y", true);
              if (yp > top && yp < top + height) {
                chip(left + 40 * ratio, yp, `ΔH ${fmtVal(Math.abs(lr.cursorYh2 - lr.cursorYh1))}`, "#cbd5e1");
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
    cacheRef.current = null;
    resampleBusyRef.current = false;
    void resampleRef.current();
    // ...and once more after layout settles, in case the first call ran
    // before the window count had propagated (the data would arrive on
    // the next live tick — but a stopped trace has no tick).
    const raf = requestAnimationFrame(() => void resampleRef.current());

    // The canvas had real dimensions at construction (we guarded for it
    // above), so subsequent resizes just `setSize`.
    const ro = new ResizeObserver(() => {
      withSuppressed(() => u.setSize({ width: el.clientWidth || 600, height: Math.max(60, el.clientHeight - 2) }));
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
        setResizeTick((n) => n + 1);
      }, 250);
    }

    return () => {
      cancelAnimationFrame(raf);
      if (postMountRebuildTimer) window.clearTimeout(postMountRebuildTimer);
      ro.disconnect();
      if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = 0;
      registerInstance(areaId, null);
      u.destroy();
      if (uplotRef.current === u) uplotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalSetKey, areaId, resizeTick]);

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

  // Apply the y-axis range *immediately* when it *changes* — no need to
  // wait for the next re-sample. (Not on the initial mount: the resample
  // does the first fit, and uPlot hasn't got real data yet then.)
  const prevYModeKeyRef = useRef<string | null>(null);
  const yModeKey = yMode === "auto" ? "auto" : `${yMode.min}:${yMode.max}`;
  useEffect(() => {
    const first = prevYModeKeyRef.current == null;
    prevYModeKeyRef.current = yModeKey;
    if (first) return;
    const u = uplotRef.current;
    if (!u) return;
    withSuppressed(() => {
      if (yMode === "auto") {
        u.setData(u.data, true);
        const { xMin, xMax } = xSyncRef.current;
        if (xMin != null && xMax != null) u.setScale("x", { min: xMin, max: xMax });
      } else {
        u.setScale("y", { min: yMode.min, max: yMode.max });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yModeKey]);

  // Show / hide series in place when the per-signal `hidden` flags
  // change — no uPlot re-create needed (`signalSetKey` excludes it).
  const hiddenKey = signals.map((s) => (s.hidden ? "1" : "0")).join("");
  useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    signals.forEach((s, i) => u.setSeries(i + 1, { show: !s.hidden }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKey]);

  // Redraw the overlay when cursors / events change (no resample).
  useEffect(() => {
    uplotRef.current?.redraw(false, false);
  }, [cursorXa, cursorXb, cursorYh1, cursorYh2, events, isFirst, isLast]);

  const yLabel = yMode === "auto" ? "y: auto" : `y: ${yMode.min}…${yMode.max}`;
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
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        const ref = parseDroppedSignal(e.dataTransfer.getData(SIGNAL_DND_MIME));
        if (ref) {
          e.preventDefault();
          onDropSignal(ref, null); // append to this area
        }
      }}
    >
      <div className="plot-area-canvas" ref={canvasRef} />
      <div className="plot-area-signals">
        <div className="plot-area-signals-head">
          <span className="plot-area-label">{label}</span>
          <button
            className="plot-area-y"
            title="set this area's y-axis range"
            onClick={(e) => {
              e.stopPropagation();
              setYEditOpen((v) => !v);
            }}
          >
            {yLabel}
          </button>
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
        {yEditOpen && (
          <YRangeEditor
            yMode={yMode}
            onApply={(m) => {
              onSetYMode(m);
              setYEditOpen(false);
            }}
            onCancel={() => setYEditOpen(false)}
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
            return (
              <div
                className={`plot-signal-row${s.hidden ? " hidden" : ""}`}
                key={key}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(SIGNAL_DND_MIME, JSON.stringify(s));
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(SIGNAL_DND_MIME)) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(e) => {
                  const ref = parseDroppedSignal(e.dataTransfer.getData(SIGNAL_DND_MIME));
                  if (ref) {
                    e.preventDefault();
                    e.stopPropagation();
                    onDropSignal(ref, key); // insert before this row
                  }
                }}
              >
                <button
                  className={`plot-signal-swatch${s.hidden ? " hidden" : ""}`}
                  style={{ background: s.color }}
                  title={s.hidden ? "show this signal" : "hide this signal"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleHidden(key);
                  }}
                />
                <span className="plot-signal-name" title={`${s.messageName}.${s.signalName} — drag to another plot area`}>
                  {s.messageName}.{s.signalName}
                </span>
                <span className="plot-signal-value">
                  <span title={valueTitle}>
                    {fmtVal(v)}
                    {s.unit ? ` ${s.unit}` : ""}
                  </span>
                  {showAbDelta && (
                    <small className="plot-signal-delta" title="Δ value (cursor A − cursor B)">
                      Δ {fmtVal(deltaAbFor(key))}
                      {s.unit ? ` ${s.unit}` : ""}
                    </small>
                  )}
                </span>
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
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function YRangeEditor({ yMode, onApply, onCancel }: { yMode: YMode; onApply: (m: YMode) => void; onCancel: () => void }) {
  const [min, setMin] = useState(yMode === "auto" ? "" : String(yMode.min));
  const [max, setMax] = useState(yMode === "auto" ? "" : String(yMode.max));
  return (
    <div className="plot-y-editor" onMouseDown={(e) => e.stopPropagation()}>
      <input type="number" step="any" value={min} placeholder="min" onChange={(e) => setMin(e.target.value)} />
      <input type="number" step="any" value={max} placeholder="max" onChange={(e) => setMax(e.target.value)} />
      <button
        onClick={() => {
          const lo = parseFloat(min);
          const hi = parseFloat(max);
          if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) onApply({ min: lo, max: hi });
        }}
      >
        set
      </button>
      <button onClick={() => onApply("auto")}>auto</button>
      <button onClick={onCancel}>×</button>
    </div>
  );
}
