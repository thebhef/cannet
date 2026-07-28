/**
 * Plot-panel configuration model: the persistable shapes a plot panel
 * and its areas exchange (`SignalRef`, `PlotAreaConfig`, cursor/window
 * types) plus the pure parse / migration / formatting helpers that turn
 * a persisted `params` blob into those shapes.
 *
 * Split out of `PlotPanel.tsx` so the renderer components
 * (`PlotPanel` / `PlotArea`) share one definition without importing each
 * other, and so the parse/format logic is unit-testable without dragging
 * uPlot into a jsdom run. No React / uPlot imports live here.
 */
import { signalKey } from "./plotData";
import { SIGNAL_WHEEL } from "./palette";
import { DEFAULT_MEASUREMENTS, type MeasurementKey, type Series, isMeasurementKey } from "./plotCursors";
import type { YAxisMode } from "./plotAxisDerivation";
import { parseSignalDragData } from "./dragSignals";

/** The shared signal colour wheel (ADR 0026, `palette.ts`) seeds a new
 * series' colour: the index for a fresh series is `(signals already in
 * that plot area) % len`, so the first 16 series in any one area get
 * distinct hues. */
export const TRACE_COLORS = SIGNAL_WHEEL;

export type CursorMode = "off" | "x" | "y" | "note";

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
  /** Pattern-defined series (ADR 0020 / ADR 0038): regex patterns
   * evaluated against the canonical signal path
   * `bus/ecu/message/signal`, OR-combined with the manual `signals`
   * list (`signalSelection.ts`). The renderer treats the area's
   * series as `signals` + the pattern matches not already picked
   * manually — manual picks win, so their colour / order / hidden
   * state is authoritative. Not mode-exclusive: adds, drops, and
   * removes keep working alongside patterns. */
  patterns?: string[];
}

export interface NoteEvent {
  id: string;
  /** Time in display-relative seconds. */
  t: number;
  label: string;
  /** Cursor colour; defaults to the note event blue. The derived
   *  truncation marker (ADR 0035) overrides it. */
  color?: string;
}

export interface XCursors {
  a: number | null;
  b: number | null;
}

export interface PlotPanelParams {
  [key: string]: unknown;
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
  /** Per-derived-axis vertical weight (flex-grow), keyed by axis id.
   * See {@link AxisWeights}. Absent axes default to weight 1. */
  axisWeights?: unknown;
}

/** The area→panel reporting surface: the readouts and data an area
 * pushes up to its panel on each resample. Grouped into one object so
 * the panel↔area interface (and the area's `liveRef` mirror) carry a
 * single stable prop instead of six parallel `onReport*` callbacks.
 * Each takes the reporting area's id (the panel keys per-area state by
 * it; the scalar readouts fold across areas). */
export interface PlotAreaReports {
  /** Last-sampled per-signal series for the area (measurement strip). */
  series: (areaId: string, series: Map<string, Series>) => void;
  /** Worst recent total resample wall-clock (ms) — JS + IPC. */
  perf: (areaId: string, ms: number) => void;
  /** Host-side ms from `sample_signals` (slice + decode + decimate). */
  hostMs: (areaId: string, ms: number) => void;
  /** Effective re-sample rate (Hz, smoothed); `0` when not running. */
  rate: (areaId: string, hz: number) => void;
  /** Largest per-signal cache size (display + diagnostic). */
  cache: (areaId: string, points: number) => void;
  /** The area's cache base (x-axis origin, absolute seconds since the
   * unix epoch) — the panel projects session-scoped notes through it. */
  base: (areaId: string, baseSeconds: number | null) => void;
}

/** The shared current x-window + a suppress flag so a programmatic
 * scale change doesn't bounce back through an area's `setScale` hook
 * as "the user zoomed". `xMin`/`xMax` are `null` until the first data
 * establishes a window. */
export interface XSync {
  suppress: boolean;
  xMin: number | null;
  xMax: number | null;
}

/** Per-area side-panel width range (pixels). Default and clamps for
 * the user-resizable column. */
export const SIGNALS_WIDTH_DEFAULT = 220;
export const SIGNALS_WIDTH_MIN = 120;
export const SIGNALS_WIDTH_MAX = 600;

/** Plot update-rate options (Hz) offered in the toolbar, and the
 * default. Lower = less CPU under a fast capture; the re-sample loop is
 * self-paced (next tick scheduled after the previous finishes), so a
 * slow tick just lowers the realised rate further. */
export const RATE_OPTIONS = [5, 10, 15, 30, 60] as const;
export const DEFAULT_MAX_RATE_HZ = 15;

export function signalRefKey(s: SignalRef): string {
  return signalKey(s.busId, s.messageId, s.extended, s.signalName);
}

export function isSignalRefCore(v: unknown): v is Omit<SignalRef, "color"> {
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

export function withColor(
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

/** Parse a drop event's mime data into colored `SignalRef`s + the
 * source panel id (when the payload set one). The plot panel uses
 * `sourcePanelId` to discriminate:
 *
 * - `sourcePanelId === this panel's elementId` → drag started inside
 *   this panel → **move** semantics (reorder / shift between areas).
 * - Otherwise (DBC panel, trace cell, by-id cell, a different plot
 *   panel) → **add** semantics: drop a fresh copy without disturbing
 *   the source. */
export function parseDroppedSignals(s: string): {
  refs: SignalRef[];
  sourcePanelId: string | null;
} {
  const parsed = parseSignalDragData(s);
  return {
    refs: parsed.signals.map((r, i) => withColor(r, i)),
    sourcePanelId: parsed.sourcePanelId,
  };
}

export function yAxisModeFromRaw(v: unknown): YAxisMode {
  return v === "per-unit" || v === "individual" ? v : "unified";
}

export function areasFromParams(raw: unknown): PlotAreaConfig[] {
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
      // A pre-patterns panel persisted a single `signalFilter` regex
      // (exclusive filter mode); it migrates to a one-entry pattern
      // list. Note the regex *subject* changed with ADR 0038 (dotted
      // `bus.message.signal` → `bus/ecu/message/signal`), so an old
      // filter may need a touch-up — its pattern is preserved verbatim
      // for the user to edit rather than guessed at.
      const patterns = Array.isArray(o.patterns)
        ? o.patterns.filter((p): p is string => typeof p === "string")
        : typeof o.signalFilter === "string"
          ? [o.signalFilter]
          : [];
      out.push({
        id,
        signals,
        yAxisMode: yAxisModeFromRaw(o.yAxisMode),
        primarySignalKey: typeof o.primarySignalKey === "string" ? o.primarySignalKey : null,
        patterns: patterns.length > 0 ? patterns : undefined,
      });
    }
    if (out.length > 0) return out;
  }
  return [{ id: crypto.randomUUID(), signals: [], primarySignalKey: null }];
}

export function cursorModeFromRaw(raw: unknown): CursorMode {
  return raw === "x" || raw === "y" || raw === "note" ? raw : "off";
}

export function measKeysFromRaw(raw: unknown): MeasurementKey[] {
  if (Array.isArray(raw)) {
    const ks = raw.filter(isMeasurementKey);
    if (ks.length > 0) return ks;
  }
  return [...DEFAULT_MEASUREMENTS];
}

export function signalsWidthFromRaw(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return SIGNALS_WIDTH_DEFAULT;
  return Math.max(SIGNALS_WIDTH_MIN, Math.min(SIGNALS_WIDTH_MAX, Math.round(v)));
}

/** A persisted max-rate value, clamped to one of {@link RATE_OPTIONS}. */
export function maxRateFromRaw(v: unknown): number {
  return typeof v === "number" && (RATE_OPTIONS as readonly number[]).includes(v) ? v : DEFAULT_MAX_RATE_HZ;
}

export function fmtFreq(hz: number | null | undefined): string {
  if (hz == null || !Number.isFinite(hz)) return "—";
  if (Math.abs(hz) >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (Math.abs(hz) >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${hz.toFixed(2)} Hz`;
}

export function fmtVal(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toPrecision(6);
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
