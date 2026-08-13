/**
 * Plot-panel configuration model: the persistable shapes a plot panel
 * and its areas exchange (`SignalRef`, `PlotAreaConfig`, cursor/window
 * types) plus the pure parse / migration / formatting helpers that turn
 * a persisted `params` blob into those shapes.
 *
 * Split out of `PlotPanel.tsx` so the renderer components
 * (`PlotPanel` / `PlotArea`) share one definition without importing each
 * other, and so the parse/format logic is unit-testable without dragging
 * uPlot into a jsdom run. No uPlot and no components live here; the one
 * runtime dependency it takes is `hostSettings`, which {@link newPlotArea}
 * reads for the configured default y-axis mode.
 */
import { READOUT_SIG_FIGS, formatFloat } from "./floatFormat";
import { formatSignalValue } from "./format";
import { hostSettings } from "./hostSettings";
import { signalKey } from "./plotData";
import { DEFAULT_MEASUREMENTS, type MeasurementKey, type Series, isMeasurementKey } from "./plotCursors";
import type { YAxisMode } from "./plotAxisDerivation";
import type { AxisScalePatch } from "./plotAxisScale";
import type { SignalDescriptorRecord } from "./types";
// Type-only, so the cycle with `plotAreaTransfer` (which parses areas
// through this module) is erased at build time.
import type { PlotAreaDragPayload } from "./plotAreaTransfer";
import { parseSignalDragData } from "./dragSignals";

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
  /** The color the user picked for this series, and nothing else
   * (ADR 0026). A series nobody recolored carries none and resolves
   * its color live through `signalColorResolver.ts`, so a generator or
   * a theme change recolors it without rewriting stored state. */
  colorPick?: string;
  /** Hidden = line not drawn on the plot (swatch dimmed); the
   * side-panel value still updates. Absent ⇒ visible. */
  hidden?: boolean;
  /** This entry exists only to carry overrides for a row the area's
   * *patterns* put there — it is not a claim on the row's membership or
   * its position. Hiding or recoloring a pattern-derived row has to
   * write an entry somewhere, and without this marker that entry would
   * read as a manual pick and drag the row into the manual block; the
   * row would move because it was hidden, which is not something the
   * user asked for. A row placed by a *drop* carries no marker, because
   * a drop is a claim on position. Absent ⇒ a manual pick. */
  viaPattern?: boolean;
  /** A **file-backed** signal (`docs/CONTEXT.md`): imported from the
   * capture file as a value series, with no message carrying it. Its
   * `messageId` is then a signal channel group index and `messageName`
   * that group's label. Absent ⇒ DBC-backed. */
  fileBacked?: boolean;
}

export interface PlotAreaConfig {
  id: string;
  signals: SignalRef[];
  /** How the area's series lay out across axes (ADR 0026). `unified`
   * (default) draws one axis with all series overlaid; `per-unit`
   * stacks one axis per unit (each enum series gets its own); and
   * `individual` stacks one axis per series. Y scales are auto-derived
   * from the data unless the user overrides an axis's bounds or asks
   * for a log scale — that override is per *axis*, so it lives in the
   * panel's `axisScales` (see {@link PlotPanelParams.axisScales}), not
   * here. */
  yAxisMode?: YAxisMode;
  /** Which signal's raw range / unit drives the y-axis labels for this
   * area. `null` falls back to the first non-hidden signal — that's
   * what `primarySignalForArea` resolves it to. Click a signal row in
   * the side panel to promote that signal to primary. */
  primarySignalKey?: string | null;
  /** Collapsed = the area gives up its plot height: every axis it
   * derives renders as a strip (no canvas) while its side-panel rows
   * stay, so the toggle back is always in reach (ADR 0026). Absent ⇒
   * expanded. An area whose signals are *all hidden* collapses anyway,
   * flag or no flag — there is nothing to draw on it. */
  collapsed?: boolean;
  /** Pattern-defined series (ADR 0020 / ADR 0038): regex patterns
   * evaluated against the canonical signal path
   * `bus/ecu/message/signal`, OR-combined with the manual `signals`
   * list (`signalSelection.ts`). The renderer treats the area's
   * series as `signals` + the pattern matches not already picked
   * manually — manual picks win, so their color / order / hidden
   * state is authoritative. Not mode-exclusive: adds, drops, and
   * removes keep working alongside patterns. */
  patterns?: string[];
}

export interface NoteEvent {
  id: string;
  /** Time in display-relative seconds. */
  t: number;
  label: string;
  /** Cursor color; defaults to the note event blue. The derived
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
  signalsWidthPx?: unknown;
  showPoints?: unknown;
  /** Per-derived-axis vertical weight (flex-grow), keyed by axis id.
   * See {@link AxisWeights}. Absent axes default to weight 1. */
  axisWeights?: unknown;
  /** The panel's solo state — the regex and, when a page of its match
   * groups is on show, that page's index. See `plotSolo.ts`. Sparse:
   * absent while solo is off. */
  solo?: unknown;
  /** Per-derived-axis manual y range + log flag, keyed by axis id.
   * See `AxisScales` in `plotAxisScale.ts`. Sparse: an entry exists
   * only where the user overrode something, so an axis that is
   * autoscaling and linear has none. */
  axisScales?: unknown;
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
  /** Scroll unevenness (%) while following live; `null` when the window
   * is stationary or the meter hasn't enough samples. */
  jank: (areaId: string, pct: number | null) => void;
  /** Largest per-signal cache size (display + diagnostic). */
  cache: (areaId: string, points: number) => void;
  /** The area's cache base (x-axis origin, absolute seconds since the
   * unix epoch) — the panel projects session-scoped notes through it. */
  base: (areaId: string, baseSeconds: number | null) => void;
}

/** The panel→area callbacks that are bound to *which* axis is calling —
 * routing an edit to the right derived axis or its parent area. Grouped
 * (and built once per axis-set change rather than per render) so a
 * memoised `PlotArea` isn't handed a dozen fresh function identities
 * every time unrelated panel state moves. */
export interface AxisHandlers {
  onPlaceCursorY: (which: "h1" | "h2", v: number) => void;
  onSetPrimarySignal: (key: string | null) => void;
  /** A signal row was clicked: apply the click to the *parent area's*
   * selection (`plotAreaSelection.ts`). Routed to the parent, not the
   * derived axis, so a Shift range spans the axes a per-unit /
   * individual y-axis mode splits the area's rows across. */
  onSelectSignal: (key: string, modifiers: { mod: boolean; shift: boolean }) => void;
  onSetYAxisMode: (mode: YAxisMode) => void;
  /** Collapse the parent area if expanded, expand it if collapsed —
   * one collapse state per logical area (ADR 0026). */
  onToggleCollapsed: () => void;
  onFocus: () => void;
  onRemoveArea: () => void;
  /** The parent area's grip (or its collapsed run's handle) started a
   * drag: write the area's payloads onto the transfer (ADR 0045). */
  onDragArea: (dataTransfer: DataTransfer) => void;
  /** A plot-area drag was released on this area — the panel decides
   * what that means from the payload's source panel and whether Ctrl
   * was held at the drop (`copy`). */
  onDropArea: (payload: PlotAreaDragPayload, copy: boolean) => void;
  onRemoveSignal: (key: string) => void;
  onDropSignal: (ref: SignalRef, beforeKey: string | null, isInternalMove: boolean) => void;
  onToggleHidden: (ref: SignalRef) => void;
  onSetSignalColor: (ref: SignalRef, color: string) => void;
  onSetPatterns: (patterns: string[] | undefined) => void;
  onMaterializePatterns: () => void;
  /** Set / clear this axis's manual y bounds or log flag. A `null`
   * bound clears it (back to automatic); an absent key leaves it
   * alone. The panel owns the sparse store (ADR 0026). */
  onSetYScale: (patch: AxisScalePatch) => void;
  /** Bulk-set the parent area's current *selection* hidden/shown in one
   * batch — the selection's context menu. Same
   * materialization rule as `onToggleHidden`, applied to every selected
   * row in one persist / one resample rather than N single-row calls.
   * A no-op if the parent area's selection is empty. */
  onSetSelectionHidden: (hidden: boolean) => void;
  /** A selected row started a drag: fan the whole selection into the
   * drag payload instead of just the grabbed row (DbcPanel precedent,
   * ADR 0045). A no-op if the parent area's selection is empty. */
  onDragSelection: (dataTransfer: DataTransfer) => void;
  /** The one-shot "sort area" action: sort the *parent*
   * area's whole manual `signals` list by (generator index, name) —
   * routed to the parent like `onSetPrimarySignal`, not the derived
   * axis, so invoking it from a per-unit / individual axis still sorts
   * every unit's signals, not just the ones that axis shows. */
  onSortArea: () => void;
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

/** Minimum spacing between live plot re-samples (ms, ≈15 Hz). The
 * re-sample loop is self-paced (the next tick is scheduled after the
 * previous one finishes), so a slow tick just lowers the realised rate
 * further. */
export const RESAMPLE_INTERVAL_MS = 67;

export function signalRefKey(s: SignalRef): string {
  return signalKey(s.busId, s.messageId, s.extended, s.signalName, s.fileBacked);
}

export function isSignalRefCore(v: unknown): v is Omit<SignalRef, "colorPick"> {
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

/** Normalize a parsed or dropped series into a {@link SignalRef}: a
 * non-string `busId` becomes the legacy `null`, and the only color
 * carried through is an explicit **pick**.
 *
 * A `color` written before the shared resolver existed is dropped
 * rather than read as a pick (ADR 0026). The panel used to seed one
 * from the series' position in its area, and nothing distinguishes
 * those from a color the user chose — so every stored one goes and the
 * series re-resolve, which is what makes several areas holding the
 * same signals agree on their colors again. */
export function signalRefFromRaw(
  s: Omit<SignalRef, "colorPick"> & { colorPick?: unknown; busId?: unknown },
): SignalRef {
  const ref: SignalRef = {
    busId: typeof s.busId === "string" ? s.busId : null,
    messageId: s.messageId,
    extended: s.extended,
    signalName: s.signalName,
    messageName: s.messageName,
    unit: s.unit,
  };
  if (s.hidden) ref.hidden = true;
  if (s.viaPattern) ref.viaPattern = true;
  if (s.fileBacked) ref.fileBacked = true;
  if (typeof s.colorPick === "string") ref.colorPick = s.colorPick;
  return ref;
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
  /// The live patterns the payload carried (ADR 0045). An area appends
  /// them to its own `patterns` list — they are never flattened to
  /// their current matches by a drop.
  patterns: string[];
  sourcePanelId: string | null;
} {
  const parsed = parseSignalDragData(s);
  return {
    refs: parsed.signals.map(signalRefFromRaw),
    patterns: parsed.patterns,
    sourcePanelId: parsed.sourcePanelId,
  };
}

/** Narrow a persisted `yAxisMode` to a {@link YAxisMode}. The `unified`
 * fallback here is a *compatibility* answer — what an area saved before
 * the field existed was drawn as — and deliberately **not** the
 * `plot_y_axis_mode` setting: re-reading that for an existing area would
 * re-lay-out plots the user already has. Only {@link newPlotArea} reads
 * the setting. */
export function yAxisModeFromRaw(v: unknown): YAxisMode {
  return v === "per-unit" || v === "individual" ? v : "unified";
}

/** A brand-new, empty plot area — the panel's "add plot area" button and
 * the first area of a panel with no saved layout. This is the one place
 * the `plot_y_axis_mode` setting is read: a *default* seeds a view at
 * creation and never touches one that exists. */
export function newPlotArea(): PlotAreaConfig {
  return {
    id: crypto.randomUUID(),
    signals: [],
    primarySignalKey: null,
    yAxisMode: yAxisModeFromRaw(hostSettings().plot_y_axis_mode),
  };
}

export function areasFromParams(raw: unknown): PlotAreaConfig[] {
  if (Array.isArray(raw)) {
    const out: PlotAreaConfig[] = [];
    for (const a of raw) {
      if (typeof a !== "object" || a === null) continue;
      const o = a as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : crypto.randomUUID();
      const signals = (Array.isArray(o.signals) ? o.signals.filter(isSignalRefCore) : []).map(signalRefFromRaw);
      // `yMode` from a v7-and-earlier panel is still ignored, and
      // deliberately not migrated onto the per-axis manual range that
      // replaced it (`axisScales`). It was a per-*area* fixed range,
      // and an area is not an axis: the settings it would migrate into
      // are keyed by derived-axis ids that did not exist when `yMode`
      // was written, so any migration would have to guess which of an
      // area's axes the old range meant. The field is tolerated on
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
        collapsed: o.collapsed === true ? true : undefined,
      });
    }
    if (out.length > 0) return out;
  }
  return [newPlotArea()];
}

/** Mime type a plot-area drag carries, holding the dragged area's id.
 * Distinct from the signal drag's `SIGNAL_DND_MIME` (`dragSignals.ts`)
 * so an area drag and a signal drag can share the same drop surface —
 * the plot area — without either handler having to guess which gesture
 * is in flight. */
export const PLOT_AREA_DND_MIME = "application/x-cannet-plot-area";

/** Move the area `draggedId` to where `targetId` currently sits — the
 * whole of a plot-area drag-reorder. Ordering *is* the areas array (the
 * panel renders and persists it in order), so a reorder is a pure
 * permutation of it and nothing keyed by area id has to move with it.
 *
 * Insertion uses the target's index in the *original* list, so the
 * dragged area lands where the pointer let go in both directions:
 * dragging down puts it after the target, dragging up puts it before.
 * A no-op (same area, or an id that isn't here) returns the input
 * reference so the caller's `setState` bails out. */
export function reorderAreas(
  areas: PlotAreaConfig[],
  draggedId: string,
  targetId: string,
): PlotAreaConfig[] {
  if (draggedId === targetId) return areas;
  const from = areas.findIndex((a) => a.id === draggedId);
  const to = areas.findIndex((a) => a.id === targetId);
  if (from < 0 || to < 0) return areas;
  const next = areas.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** The one-shot "sort area" action: reorders `signals` by
 * (generator wheel index, then display name) once — the result is
 * written back into the persisted manual list like any other reorder,
 * and drag order stays the primary model afterward. A generator-claimed
 * signal (a key present in `generatorIndexes`) sorts by `(index, name)`
 * ahead of every unclaimed one, which sorts by name alone. Name
 * collation is case-insensitive (`localeCompare` at `"base"`
 * sensitivity, the same rule `DbcPanel`'s ECU grouping uses) — how
 * names are browsed everywhere else in the panel.
 *
 * `Array.prototype.sort` is a stable sort (guaranteed since ES2019), so
 * two signals that tie on the full key — same index, same
 * case-insensitive name — keep their current relative order, and
 * re-running the action on an already-sorted list is a no-op. Pattern-
 * derived rows are never in `signals`, so they aren't touched — they
 * keep following their pattern's own evaluation order. */
export function sortAreaSignals(
  signals: readonly SignalRef[],
  generatorIndexes: ReadonlyMap<string, number>,
): SignalRef[] {
  return [...signals].sort((a, b) => {
    const ia = generatorIndexes.get(signalRefKey(a));
    const ib = generatorIndexes.get(signalRefKey(b));
    if (ia != null && ib != null && ia !== ib) return ia - ib;
    if ((ia != null) !== (ib != null)) return ia != null ? -1 : 1;
    return a.signalName.localeCompare(b.signalName, undefined, { sensitivity: "base" });
  });
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

export function fmtFreq(hz: number | null | undefined): string {
  if (hz == null || !Number.isFinite(hz)) return "—";
  if (Math.abs(hz) >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (Math.abs(hz) >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${hz.toFixed(2)} Hz`;
}

/** What a plotted signal's DBC says about how its values should read —
 * the two facts the host computes per signal and the catalog carries
 * (`SignalDescriptorRecord`). Held per signal rather than derived from
 * a value, because the same number reads differently depending on the
 * signal it came from: `12.25` from a factor-0.25 signal is exact,
 * from a float it is a rounding. */
export interface SignalValueFormat {
  /** Decimal places the signal's DBC factor implies, or `null` when it
   * implies no fixed precision (a `SIG_VALTYPE_` float, or a factor
   * with no finite decimal expansion) — then the float rule applies. */
  decimals: number | null;
  /** Render the value as a bit pattern (`0xDEADBEEF`). The host's
   * `display_hex` verdict, already gated on the signal being a raw
   * field (ADR 0043). */
  hex: boolean;
}

/** Every catalog signal's {@link SignalValueFormat}, keyed by the
 * canonical `signalKey`. Built once per panel from the signal catalog —
 * the same shape as `messageEcuLookup`, and for the same reason: the
 * facts live on the catalog, not on a plotted signal ref. */
export function signalValueFormats(
  catalog: readonly SignalDescriptorRecord[],
): ReadonlyMap<string, SignalValueFormat> {
  const out = new Map<string, SignalValueFormat>();
  for (const s of catalog) {
    out.set(signalKey(s.bus_id, s.message_id, s.extended, s.signal_name), {
      decimals: s.decimals ?? null,
      hex: !!s.display_hex,
    });
  }
  return out;
}

/** Format a plotted value for a readout — the signal area, the cursor
 * readouts, the measurement strip.
 *
 * `fmt` is the signal's own rendering facts; the three cases are the
 * three kinds of signal a DBC describes:
 *
 * - **fixed precision** (`decimals` set): exactly that many decimals,
 *   so a factor-0.25 signal reads `12.25` and never `12.250000`.
 *   `decimals: 0` covers the unscaled integers, raw bit fields included.
 * - **hex**: a raw bit field whose DBC asked for it — the same
 *   rendering the trace rows and the signal view use.
 * - **float or unknown** (`fmt` omitted, or `decimals: null`): the
 *   shared float rule ({@link formatFloat}) at the readouts' six
 *   figures, read live from the settings. Omitted where the number
 *   belongs to an axis rather than one signal (a y-cursor position, a
 *   scale bound), which may span several signals' formats. */
export function fmtVal(v: number | null | undefined, fmt?: SignalValueFormat | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (fmt?.hex) return formatSignalValue(v, true);
  if (fmt?.decimals != null) return v.toFixed(fmt.decimals);
  return formatFloat(v, READOUT_SIG_FIGS);
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
