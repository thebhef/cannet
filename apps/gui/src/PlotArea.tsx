/**
 * `PlotArea` — one uPlot canvas plus its side signal panel: the render
 * unit a `PlotPanel` stacks. Split out of PlotPanel.tsx (task 0030) at
 * the natural component seam; the two share the panel↔area interface
 * (`PlotAreaProps`, below) and the config model in `plotPanelConfig.ts`.
 *
 * This file owns the imperative uPlot lifecycle (construct / resample /
 * draw-hook overlay / mouse + wheel wiring) and the area's side panel
 * (signal rows, drag/drop, per-signal value readouts). The cursor /
 * marker draw layer stays inline in the construction effect's `draw`
 * hook: uPlot installs hooks at construction time and they close over
 * construction-time locals (enum/lane targets, the value-table ref),
 * so it does not cleanly separate into its own module.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import uPlot from "uplot";

import { isEnumValueTable, type SignalDescriptorRecord, type SignalExtent, type ValueTableEntryRecord } from "./types";
import { type ColorResolver, type ColorTarget, colorMapLaneFill } from "./colorMap";
import { enumSegments, groupScaleRanges, mergeSeries, scaleGroupKey } from "./plotData";
import {
  denormalizeOnAxis,
  logDecadeSplits,
  resolveAxisRange,
  type AxisScale,
  type AxisScalePatch,
  type ResolvedAxisRange,
} from "./plotAxisScale";
import { useDismissableMenu } from "./useDismissableMenu";
import { useSetting } from "./hostSettings";
import {
  TICK_SIG_FIGS,
  formatFloat,
  useFloatFormatRule,
  type FloatFormatRule,
} from "./floatFormat";
import {
  PLOT_AREA_DND_MIME,
  fmtVal,
  parseDroppedSignals,
  signalRefKey,
  type CursorMode,
  type NoteEvent,
  type PlotAreaConfig,
  type PlotAreaReports,
  type SignalRef,
  type SignalValueFormat,
  type XSync,
} from "./plotPanelConfig";
import { parsePlotAreaDragData, type PlotAreaDragPayload } from "./plotAreaTransfer";
import { showPointsToUplot, type ShowPointsMode } from "./plotPoints";
import { nextResampleDelayMs } from "./plotPacing";
import { Combobox, type ComboboxOption } from "./Combobox";
import { formatDurationSeconds, formatElapsed, fracDigitsForSpan } from "./format";
import { SIGNAL_DND_MIME, setSignalDragData } from "./dragSignals";
import { type Series, valueAt } from "./plotCursors";
import type { PatternResolution } from "./signalSelection";
import { SignalPatternEditor } from "./SignalPatternEditor";
import { type YAxisMode } from "./plotAxisDerivation";
import { messageEcuKey, signalRowLabel } from "./plotSignalLabel";
import { useUndoGesture } from "./undoGesture";
import { emptyJankMeter, jankPercent, jankPixels, observeScroll, scrollStepMs } from "./scrollJank";
import { useValueTables } from "./useValueTables";
import {
  laneBandsForVisible,
  laneLabels,
  laneTileBand,
  laneValueRange,
  measureTileLabel,
  normalizeIntoLane,
  tileLabelX,
} from "./plotEnumLanes";
import {
  useDecimatedRange,
  type DecimatedOutcome,
  type DecimatedSnapshot,
} from "./useDecimatedRange";
import { useFirstSampleWait } from "./useFirstSampleWait";
import { diagCount, diagGauge } from "./diag"; // DIAG
import { theme, useThemeName } from "./theme";

const ZOOM_STEP = 1.15;
/** Line width (CSS px) for a *selected* series, against 1 for the rest.
 * Enough to pick one trace out of a dense area at a glance without the
 * line reading as a band. */
const SELECTED_SERIES_WIDTH = 2;
/** Floor for `sample_signals`' `max_points` (the host min/max-decimates
 * to at most `2 * max_points`). We ask for ~1× the canvas width — 2
 * points per pixel after the host's 2× envelope, the full resolution a
 * min/max plot can show; the floor catches early-mount cases where
 * `clientWidth` is still small. */
const MIN_DECIMATION_POINTS = 200;

/** Compact tick formatter for the y-axis. Shares the readouts'
 * magnitude rule through {@link formatFloat} so one value can't read
 * `0.0001` in the signal area and `1.0e-4` on the axis beside it; it
 * keeps its own, narrower sig-fig budget, and it does not follow a
 * signal's fixed precision or hex radix — a tick is a position on an
 * axis that several signals may share, not one signal's reading.
 *
 * A **log axis always labels exponentially**: its ticks are decade
 * boundaries, and mixing `1`, `100` and `1.00000e+6` on one axis reads
 * as two different quantities.
 *
 * The rule is passed in rather than read here, because the callback is
 * installed on the uPlot instance at construction — see the rebuild
 * effect's deps. */
function fmtTickValue(v: number, rule: FloatFormatRule, log: boolean): string {
  return formatFloat(v, TICK_SIG_FIGS, { rule, alwaysExponential: log });
}

/** Width (px) the y-axis needs to fit `values` plus tick mark and
 * padding. Used by uPlot's `axis.size` to grow the gutter when a
 * primary signal produces wide labels (e.g. `1.23e+5 degC`). Reuses a
 * single offscreen 2d context — cheap to call per layout pass. */
let axisMeasureCtx: CanvasRenderingContext2D | null = null;
/** Must match the axis `font` in `axisCommon` below — measurement is
 * meaningless if the font differs from what uPlot actually paints. */
const AXIS_FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
/** Fraction of the visible span fetched beyond each edge of the plot's
 * x-window, so the window can slide between fetches without reaching
 * past the data it was given. */
const FETCH_MARGIN_FRACTION = 0.2;
/** EMA weight for the scroll-smoothness meter. Slow enough that the
 * reading is steady to read off the status line, fast enough to respond
 * within a second or so of changing something. */
const JANK_ALPHA = 0.1;
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
/** Width (px) of a single tick label in the axis font. Reuses the same
 * offscreen context as {@link measureAxisSize}. */
function measureLabelWidth(text: string): number {
  if (axisMeasureCtx == null) {
    const c = document.createElement("canvas").getContext("2d");
    if (!c) return text.length * 7;
    axisMeasureCtx = c;
  }
  axisMeasureCtx.font = AXIS_FONT;
  return axisMeasureCtx.measureText(text).width;
}

/** The bottom stacked area's x-axis label, with no cursor over the
 * panel. */
const X_AXIS_LABEL = "time (s)";
/** Bold monospace for that label, so the digits appended below are
 * fixed-pitch. uPlot centres the label string, so a proportional font
 * would shift it under the plot every time a digit changed shape. Same
 * family as the tick font (`AXIS_FONT`) at uPlot's own label size. */
const X_AXIS_LABEL_FONT = "bold 12px ui-monospace, SFMono-Regular, Menlo, monospace";

/** The bottom x-axis's label text.
 *
 * With no free cursor over the panel it is the plain axis label. With
 * one, it also carries the cursor's own position on the timeline — the
 * instant every side-panel value readout is taken at, which is
 * otherwise nowhere on screen. Elapsed time since the session origin,
 * at the same precision as the ticks beside it (ADR 0024), so the
 * cursor's time reads on the same scale as everything else.
 *
 * `xMax` is the visible window's upper bound: the cursor's time is
 * padded to the width of the longest string that window can produce, so
 * the label keeps one width — and so one position under uPlot's centred
 * drawing — as the pointer moves. A label that re-centres on every
 * mouse move is worse than no label at all. The width only changes when
 * the *window* crosses a magnitude boundary, which is a pan/zoom, not a
 * mouse move.
 */
function xAxisLabelText(hoverX: number | null, xMax: number | null, fracDigits: number): string {
  if (hoverX == null || !Number.isFinite(hoverX)) return X_AXIS_LABEL;
  const text = formatElapsed(hoverX, fracDigits);
  const width =
    xMax != null && Number.isFinite(xMax) ? formatElapsed(xMax, fracDigits).length : text.length;
  return `${X_AXIS_LABEL} · ${text.padStart(width)}`;
}

const Y_AXIS_MODES: YAxisMode[] = ["unified", "per-unit", "individual"];
const Y_AXIS_MODE_OPTIONS: ComboboxOption[] = Y_AXIS_MODES.map((m) => ({ value: m, label: m }));

/** Whether a sampled window has anything to draw at all. The first-sample
 * gate ends on the first *points*, not on the first answer (ADR 0049):
 * the host's serve is bounded in time, so a cold one comes back with the prefix it
 * has decoded and keeps decoding — an answer with points is a plot the
 * user can read, an answer with none is still a blank canvas. */
function hasAnyPoints(snapshot: DecimatedSnapshot): boolean {
  for (const s of snapshot.byKey.values()) if (s.t.length > 0) return true;
  return false;
}

/** Shared drag-over affordance for a signal drop target — the plot-area
 * surface and each signal row use the same one, rather than two
 * hand-copied handlers. `stopEvent` is set on the row so its handler
 * wins over the area surface beneath it. The "copy" cursor is the most
 * legible "you can drop here" across browsers; the real move-vs-add
 * decision happens at drop time via `sourcePanelId`, so the cursor need
 * not match the post-drop semantics. */
function signalDragOver(e: DragEvent<HTMLElement>, stopEvent: boolean): void {
  if (isAreaDrag(e)) return;
  if (!e.dataTransfer.types.includes(SIGNAL_DND_MIME)) return;
  e.preventDefault();
  if (stopEvent) e.stopPropagation();
  e.dataTransfer.dropEffect = "copy";
}

/** Shared drop handler for a signal drop target. Parses the payload,
 * discriminates move (drag started in this same panel — `sourcePanelId`
 * matches) from add, and places each ref at `beforeKey` (`null` =
 * append to the area). Forward iteration preserves drop order. Shared
 * by the area surface (`beforeKey: null`) and each signal row
 * (`beforeKey: <row key>`, `stopEvent: true`). */
function signalDrop(
  e: DragEvent<HTMLElement>,
  opts: {
    beforeKey: string | null;
    stopEvent: boolean;
    panelElementId: string;
    onDropSignal: (ref: SignalRef, beforeKey: string | null, isInternalMove: boolean) => void;
    /// Live patterns the payload carried, for the area to append to its
    /// own list (ADR 0045). The drop never flattens them.
    onDropPatterns: (patterns: readonly string[]) => void;
  },
): void {
  if (isAreaDrag(e)) return;
  const { refs, patterns, sourcePanelId } = parseDroppedSignals(
    e.dataTransfer.getData(SIGNAL_DND_MIME),
  );
  if (refs.length === 0 && patterns.length === 0) return;
  e.preventDefault();
  if (opts.stopEvent) e.stopPropagation();
  const isInternalMove = sourcePanelId === opts.panelElementId;
  for (const r of refs) opts.onDropSignal(r, opts.beforeKey, isInternalMove);
  if (patterns.length > 0) opts.onDropPatterns(patterns);
}

/** Drag-over / drop for a plot-area *reorder* — the gesture that
 * permutes the panel's area stack. It shares the plot area's drop
 * surface with the signal drop above, discriminated by mime type.
 *
 * Deliberately no per-`dragover` state: an insertion marker would be a
 * React commit per mouse move over a canvas whose resample loop is
 * already paced against its own render cost. The drag ghost plus the
 * "move" cursor carry the affordance; the areas are large enough that
 * which one the pointer is over is unambiguous. */
function areaDragOver(e: DragEvent<HTMLElement>): void {
  if (!isAreaDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
}

/** Is the drag in flight a plot-area drag? Read from the mime list,
 * which is all `dragover` gets. An area drag also carries the signal
 * payload for panels that only understand signals (ADR 0045), so inside
 * a plot panel — where both handlers sit on the same surfaces — the
 * area half wins and the signal half is ignored. */
function isAreaDrag(e: DragEvent<HTMLElement>): boolean {
  return e.dataTransfer.types.includes(PLOT_AREA_DND_MIME);
}

function areaDrop(
  e: DragEvent<HTMLElement>,
  onDropArea: (payload: PlotAreaDragPayload, copy: boolean) => void,
): boolean {
  const payload = parsePlotAreaDragData(e.dataTransfer.getData(PLOT_AREA_DND_MIME));
  if (!payload) return false;
  e.preventDefault();
  // Ctrl is read *at the drop*, not at the grab: the user decides
  // move-vs-copy while dragging, and the modifier they are holding when
  // they let go is the answer.
  onDropArea(payload, e.ctrlKey);
  return true;
}

/** Color swatch in a plot-area signal row. Left-click toggles hidden
 * (preserves prior behaviour); right-click opens the browser's native
 * color picker so the user can re-skin the series. The picker is a
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
            ? "show this signal · right-click to pick a color"
            : "hide this signal · right-click to pick a color"
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
        aria-label="pick series color"
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

/** Default y-gutter width (px) before uPlot's first layout pass has
 * reported one — the floor `measureAxisSize` never goes below. Used to
 * decide whether a right-click landed on the axis or in the plot box. */
const DEFAULT_Y_GUTTER_PX = 52;

/**
 * The y axis's own context menu (ADR 0026): a manual min, a manual max
 * and a log-scale toggle for one derived axis.
 *
 * Both bounds default to **empty, meaning automatic** — the axis keeps
 * the auto-scaling it has always done — so a user who never opens this
 * sees no change, and clearing a field puts the axis back. Committing
 * follows the repo's one inline-edit precedent (`EventRow`): Enter and
 * blur commit, and the menu's Escape dismisses without committing the
 * draft.
 *
 * The min box is absent while log is on: a log axis cannot render zero
 * or negatives, so rather than accept a min and then reject it the min
 * becomes derived. The value the user typed is *held* by the store, so
 * turning log back off returns it.
 */
function YAxisScaleMenu({
  position,
  scale,
  onSet,
  onClose,
}: {
  position: { x: number; y: number };
  scale: AxisScale | undefined;
  onSet: (patch: AxisScalePatch) => void;
  onClose: () => void;
}) {
  const menuRef = useDismissableMenu<HTMLDivElement>(true, onClose);
  const log = !!scale?.log;
  const [minDraft, setMinDraft] = useState(scale?.min == null ? "" : String(scale.min));
  const [maxDraft, setMaxDraft] = useState(scale?.max == null ? "" : String(scale.max));
  const commit = (which: "min" | "max", text: string) => {
    const t = text.trim();
    if (t === "") {
      onSet({ [which]: null });
      return;
    }
    const v = Number(t);
    // Unparseable input is left in the box rather than silently
    // committed as a clear — the user is mid-edit, not asking for auto.
    if (Number.isFinite(v)) onSet({ [which]: v });
  };
  const boundRow = (which: "min" | "max", draft: string, setDraft: (s: string) => void) => (
    <label className="plot-axis-menu-row">
      <span>{which}</span>
      <input
        aria-label={`y axis ${which === "min" ? "minimum" : "maximum"}`}
        placeholder="auto"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(which, draft);
        }}
        onBlur={() => commit(which, draft)}
      />
    </label>
  );
  return (
    <div
      ref={menuRef}
      className="plot-axis-menu"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="plot-axis-menu-title">y axis</div>
      {!log && boundRow("min", minDraft, setMinDraft)}
      {boundRow("max", maxDraft, setMaxDraft)}
      <label className="plot-axis-menu-row">
        <input
          type="checkbox"
          aria-label="log scale"
          checked={log}
          onChange={(e) => onSet({ log: e.target.checked })}
        />
        <span>log scale</span>
      </label>
      <div className="plot-axis-menu-hint">
        {log ? "min is the smallest positive value" : "empty = automatic"}
      </div>
    </div>
  );
}

/**
 * The signal-row selection's context menu: bulk Hide /
 * Show over whatever is currently selected in this area. Opened by
 * right-clicking a selected row (or, per the row's own handler, a row
 * that becomes the sole selection because it wasn't one already —
 * the platform norm: right-click on an unselected item replaces the
 * selection with it before showing the item's menu). Same floating
 * shell as the y-axis menu (`YAxisScaleMenu`) and the sources picker's
 * context menu.
 *
 * No bulk recolor and no dedicated bulk-remove affordance here —
 * visibility and drag-out are the whole surface.
 *
 * **Sort area** rides along on this same menu: the row
 * context menu is the "context menu on the plot area's signal panel"
 * the grooming asks for, so a one-shot area-wide sort sits alongside
 * the selection-scoped Hide/Show rather than opening a second menu.
 * Unlike Hide/Show it ignores the selection entirely — it reorders the
 * *whole* parent area's manual `signals` list by (generator index,
 * name), once, and drag order is the primary model again the moment
 * it's done.
 */
function SignalSelectionMenu({
  position,
  onHide,
  onShow,
  onSortArea,
  onClose,
}: {
  position: { x: number; y: number };
  onHide: () => void;
  onShow: () => void;
  onSortArea: () => void;
  onClose: () => void;
}) {
  const menuRef = useDismissableMenu<HTMLDivElement>(true, onClose);
  return (
    <div
      ref={menuRef}
      className="plot-selection-menu"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className="plot-selection-menu-action"
        onClick={() => {
          onHide();
          onClose();
        }}
      >
        Hide
      </button>
      <button
        className="plot-selection-menu-action"
        onClick={() => {
          onShow();
          onClose();
        }}
      >
        Show
      </button>
      <button
        className="plot-selection-menu-action"
        title="reorder this area's signal list by generator index, then name — a one-time sort, not a live mode"
        onClick={() => {
          onSortArea();
          onClose();
        }}
      >
        Sort area
      </button>
    </div>
  );
}

interface PlotAreaProps {
  area: PlotAreaConfig;
  /** Vertical flex-grow weight for this axis (ADR 0026 fit-to-panel).
   * Applied inline on the root; the browser distributes stack height
   * proportionally. Undefined falls back to the CSS default (1). */
  flexGrow?: number;
  /** True when this axis draws nothing — the parent area is collapsed,
   * or every signal on the axis is hidden. The canvas collapses (no
   * reserved plot height) while the side-panel rows stay visible so
   * they remain un-hideable (ADR 0026). */
  collapsed?: boolean;
  /** True when the *solo* mask (`plotSolo.ts`), not the user's own
   * hide state, is what left this axis with nothing to draw — the
   * head toggle's inert state says so instead of blaming hidden rows. */
  collapsedBySolo?: boolean;
  /** Keys ({@link signalRefKey}) of this axis's rows solo's mask is
   * hiding, from {@link soloMaskedKeys} — a row already hidden on its
   * own isn't included (solo isn't why). The row renderer styles these
   * with a solo marker instead of the plain hidden treatment. */
  soloMaskedKeys?: ReadonlySet<string>;
  /** Solo's match count for this (parent) area — `3 of 12 match` in the
   * signal-panel heading — or `null` while solo isn't applying to it
   * (off, or a zero-match area, which is left untouched by design). Set
   * only on the first derived axis, so the chip renders once per
   * logical area. */
  soloChip?: { matched: number; total: number } | null;
  /** True when this collapsed axis heads a contiguous run of collapsed
   * axes — it draws the run's single shared drag handle (ADR 0026). */
  collapsedRunHead?: boolean;
  /** True when this axis is the shared per-unit enum-lanes axis (all of
   * an area's enums stacked as logic-analyzer lanes, ADR 0026). The
   * lane render lands in a later slice; today the axis draws as plain
   * numeric lines. */
  enumLanes?: boolean;
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
  /** A live plot's interaction surface, borrowed while this axis is
   * `collapsed` — it renders no canvas, so it has no uPlot and no
   * pointer surface of its own. See the placeholder effect. */
  plotSurface: () => HTMLElement | null;
  /** Declare the y-gutter width this axis needs and get back the one
   * the whole panel has agreed on (the widest anyone needs), so every
   * plot box starts at the same x. Called from uPlot's `axis.size`. */
  reportGutterNeed: (areaId: string, needed: number) => number;
  /** A user pan/zoom moved the shared x-window. `keepFollow` leaves
   * follow-live on — a zoom whose intent is "change the scale", not
   * "stop tracking the live edge". */
  onUserXChange: (min: number, max: number, fromId: string, keepFollow?: boolean) => void;
  onAreaResampled: (areaId: string, firstT: number | null, lastT: number | null) => void;
  onPlaceCursorX: (which: "a" | "b", t: number) => void;
  onPlaceCursorY: (which: "h1" | "h2", v: number) => void;
  onAddNote: (t: number) => void;
  /** The area→panel reporting surface (measurement series, perf
   * timings, effective rate, cache size, x-axis base) — one grouped
   * object instead of six parallel callbacks. See {@link PlotAreaReports}. */
  reports: PlotAreaReports;
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
  /** A signal row was clicked — apply it to the parent area's selection
   * (`plotAreaSelection.ts`). Plain click also promotes the row to
   * primary (see the row's handler); Ctrl and Shift only select. */
  onSelectSignal: (key: string, modifiers: { mod: boolean; shift: boolean }) => void;
  /** Set the area's y-axis mode (unified / per-unit / individual). */
  onSetYAxisMode: (mode: YAxisMode) => void;
  /** Collapse the parent area if expanded, expand it if collapsed —
   * one collapse state per logical area (ADR 0026). */
  onToggleCollapsed: () => void;
  onFocus: () => void;
  onRemoveArea: () => void;
  /** This area's grip (or its collapsed run's shared handle) started a
   * drag: the panel writes the area's payloads onto the transfer
   * (ADR 0045). */
  onDragArea: (dataTransfer: DataTransfer) => void;
  /** A plot-area drag was dropped on this one. What it means — a
   * reorder of this panel's stack, or an area arriving from another
   * panel, moved or (Ctrl) copied — is the panel's decision, from the
   * payload and the modifier held at the drop. */
  onDropArea: (payload: PlotAreaDragPayload, copy: boolean) => void;
  onRemoveSignal: (key: string) => void;
  /** A signal was dropped here. `beforeKey` null ⇒ append to this area;
   * otherwise insert before that row (re-order / move). `isInternalMove`
   * is true when the drag started inside this same plot panel
   * (sourcePanelId in the drag payload matched the panel's elementId);
   * in that case the parent runs move semantics (strip from origin,
   * insert at target). Otherwise drop is an add (Database panel, trace
   * cell, by-id cell, another plot panel). */
  onDropSignal: (ref: SignalRef, beforeKey: string | null, isInternalMove: boolean) => void;
  onToggleHidden: (ref: SignalRef) => void;
  /** Set a series' color to the given `#rrggbb` value (ADR 0026
   * per-series color picker). */
  onSetSignalColor: (ref: SignalRef, color: string) => void;
  /** Replace this area's regex pattern list (`signalSelection.ts`);
   * `undefined` / empty clears it, leaving just the manual picks. */
  onSetPatterns: (patterns: string[] | undefined) => void;
  /** Convert regex → manual: materialize the area's current effective
   * series into the persisted manual list and clear the patterns. */
  onMaterializePatterns: () => void;
  /** This axis's manual y bounds + log flag, or `undefined` when the
   * axis is fully automatic (ADR 0026). The panel holds the sparse
   * store keyed by derived-axis id. */
  yScale?: AxisScale;
  /** Set / clear one of those settings. A `null` bound is a clear. */
  onSetYScale: (patch: AxisScalePatch) => void;
  /** Keys of this area's *manual* picks — how the row renderer tells
   * a manual pick (removable) from a pattern-derived row (removed by
   * editing the pattern; shows a pattern badge instead of ×). */
  /** This axis's slice of the parent area's selected signal keys — the
   * rows drawn highlighted, and the series drawn bold. The panel scopes
   * it per axis so a selection click leaves the memoised areas that
   * hold no selected row untouched. */
  selectedKeys: ReadonlySet<string>;
  manualKeys: ReadonlySet<string>;
  /** The area's patterns evaluated against the catalog: per-pattern
   * match counts / invalid flags for the filter status line. */
  patternResolutions: readonly PatternResolution[];
  /** The signal catalog, for the pattern editor's live match counts. */
  catalog: readonly SignalDescriptorRecord[];
  /** Bus-id → bus-name resolution for the per-signal side panel.
   * Each signal row displays its bus name so a `(message, signal)`
   * shown on two different buses is unambiguous. */
  busNameLookup: ReadonlyMap<string, string>;
  /** Bus-id → render color, for the swatch shown before the bus name
   * in each signal row (matches the bus's graph color). */
  busColorLookup: ReadonlyMap<string, string>;
  /** `messageEcuKey` → transmitting ECU, for the signal row's message
   * line. The ECU isn't part of a plotted signal's identity, so the
   * panel resolves it from the catalog once and shares it. */
  ecuLookup: ReadonlyMap<string, string>;
  /** `signalKey` → how that signal's values should read (fixed
   * precision / float / hex). Resolved from the catalog once per panel,
   * for the same reason as `ecuLookup`: it is a DBC fact, not part of a
   * plotted signal's identity. */
  valueFormats: ReadonlyMap<string, SignalValueFormat>;
  /** Signal value→color resolver (ADR 0029): tints an enum lane box by
   * its held value. Read live in the draw hook via a ref. */
  resolveColor: ColorResolver;
  /** A series' render color, through the panel's shared resolution
   * point (ADR 0026): the user's pick on that series, else what the
   * signal's identity resolves to. Nothing is stored for an unpicked
   * series, so this is read live — via a ref in the draw hooks. */
  seriesColor: (s: SignalRef) => string;
  /** The owning plot panel's element id. Stamped on this panel's
   * internal signal-row drags via `setSignalDragData(..., elementId)`
   * and compared against the dropped payload's `sourcePanelId` so
   * drops originating inside this same panel are treated as moves;
   * everything else (Database panel, trace cell, another plot panel) is
   * an add. */
  panelElementId: string;
  /** Bulk-set the parent area's current selection hidden/shown — the
   * selection's context menu Hide / Show. */
  onSetSelectionHidden: (hidden: boolean) => void;
  /** A selected row started a drag: fan the whole selection into the
   * drag payload instead of just the grabbed row (DatabasePanel
   * precedent, ADR 0045). */
  onDragSelection: (dataTransfer: DataTransfer) => void;
  /** The row context menu's one-shot "Sort area" action: reorders
   * the *parent* area's whole manual `signals` list. */
  onSortArea: () => void;
}

/** The lookup's stand-in for a signal whose value table hasn't resolved
 * (or that has none) — one shared array, so the per-table label cache
 * keys on a stable identity instead of a fresh literal per draw. */
const NO_VALUE_TABLE: readonly ValueTableEntryRecord[] = [];

/** Draw the logic-analyzer value tiles for one enum series into a
 * pixel band (ADR 0026). Each constant-value segment of the (stepped)
 * line gets an opaque-ish box carrying its label, centred on the
 * visible part of the box (`tileLabelX`); a colormap targeting
 * the signal (ADR 0029) tints the box by the held value. Shared by the
 * single-enum axis (one full-height centered band) and each lane of
 * the combined enum-lanes axis (one call per signal, its lane band).
 * The stepped line still draws behind the ~0.65-alpha fill, so the
 * waveform reads through. */
function drawEnumTiles(
  ctx: CanvasRenderingContext2D,
  u: uPlot,
  o: {
    seriesIdx: number;
    table: readonly ValueTableEntryRecord[];
    target: ColorTarget | null;
    resolveColor: ColorResolver;
    /** Top / bottom of the tile band, in canvas pixels. */
    bandTop: number;
    bandBot: number;
    /** Fallback border/label color when no colormap tints the value. */
    accent: string;
    left: number;
    width: number;
    ratio: number;
    /** The signal's raw sample values (enum codes), index-aligned with
     * `u.data`. The lanes axis passes these because it plots normalized
     * lane positions, which can't be matched against a value table; the
     * single-enum axis plots raw codes already and omits it. */
    rawValues?: (number | null)[];
  },
): void {
  const seriesOpt = u.series[o.seriesIdx];
  const ts = u.data[0] as number[] | undefined;
  const vs = o.rawValues ?? (u.data[o.seriesIdx] as (number | null)[] | undefined);
  if (!ts || !vs || seriesOpt?.show === false) return;
  const labelFor = laneLabels(o.table);
  const bandH = o.bandBot - o.bandTop;
  const padX = 4 * o.ratio;
  for (const seg of enumSegments(ts, vs)) {
    const x0 = u.valToPos(seg.t0, "x", true);
    // `tEnd` is the next-sample timestamp (where the value changes),
    // matching the stepped line's hold, so the box reaches the visual
    // transition instead of cutting off at the last same-value sample.
    const x1 = u.valToPos(seg.tEnd, "x", true);
    // Clip-trim the box against the visible plot region; a segment past
    // the canvas still labels its visible portion (`tileLabelX`).
    const visStart = Math.max(x0, o.left);
    const visEnd = Math.min(x1, o.left + o.width);
    const segW = visEnd - visStart;
    if (segW <= 0) continue;
    // Enum codes are integers, but arrive as f64 from the host.
    const raw = Math.round(seg.v);
    const lbl = labelFor(raw);
    const tw = measureTileLabel(ctx, lbl);
    const labelX = tileLabelX({ lo: x0, hi: x1 }, { lo: o.left, hi: o.left + o.width }, tw, padX);
    const mapColor = o.target ? o.resolveColor(o.target, raw) : null;
    // ~65-85% fills keep the stepped line faintly visible underneath.
    const fill = mapColor ? colorMapLaneFill(mapColor) : theme().laneFillDefault;
    const accent = mapColor ?? o.accent;
    ctx.fillStyle = fill;
    ctx.fillRect(visStart, o.bandTop, segW, bandH);
    ctx.strokeStyle = accent;
    ctx.strokeRect(visStart + 0.5, o.bandTop + 0.5, segW - 1, bandH - 1);
    if (labelX != null) {
      ctx.fillStyle = accent;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(lbl, labelX, Math.round((o.bandTop + o.bandBot) / 2));
    }
  }
}

/** Memoised: a plot panel re-renders for its own reasons (toolbar
 * menus, the ~2 Hz perf badge, cursor placement) far more often than
 * any area's inputs change, and an area render walks its whole signal
 * list. The panel holds up its end by handing every callback down as a
 * stable identity — the per-axis bundle in `AxisHandlers` and the
 * grouped `PlotAreaReports` — so this memo can actually hit. */
export const PlotArea = memo(function PlotArea(p: PlotAreaProps) {
  diagCount("render.PlotArea"); // DIAG
  // The side-panel resize persists on every mouse move; the gesture is
  // what makes the whole drag one undo step.
  const undoGesture = useUndoGesture();
  const {
    area,
    flexGrow,
    collapsed,
    collapsedBySolo,
    soloMaskedKeys,
    soloChip,
    collapsedRunHead,
    enumLanes,
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
    plotSurface,
    reportGutterNeed,
    onUserXChange,
    onAreaResampled,
    onPlaceCursorX,
    onPlaceCursorY,
    onAddNote,
    reports,
    resetYEpoch,
    xEpoch,
    fitYEpoch,
    showDiag,
    onSetPrimarySignal,
    onSelectSignal,
    onSetYAxisMode,
    onToggleCollapsed,
    onFocus,
    onRemoveArea,
    onDragArea,
    onDropArea,
    onRemoveSignal,
    onDropSignal,
    onToggleHidden,
    onSetSignalColor,
    onSetPatterns,
    onMaterializePatterns,
    yScale,
    onSetYScale,
    selectedKeys,
    manualKeys,
    patternResolutions,
    catalog,
    busNameLookup,
    busColorLookup,
    ecuLookup,
    valueFormats,
    resolveColor,
    seriesColor,
    panelElementId,
    onSetSelectionHidden,
    onDragSelection,
    onSortArea,
  } = p;

  /** Fold dropped patterns into this area's own list (ADR 0045): live,
   * deduped, and never flattened to their current matches — that is
   * what the explicit materialize path is for. */
  const appendPatterns = useCallback(
    (incoming: readonly string[]) =>
      onSetPatterns([...new Set([...(area.patterns ?? []), ...incoming])]),
    [area.patterns, onSetPatterns],
  );

  /** How often the live loop below re-samples, from `settings.json`
   * (ADR 0034). Drawing stays pinned to rAF — this is the fetch, which
   * is where the host-side cost is. */
  const fetchIntervalMs = useSetting("plot_fetch_interval_ms");

  /** How a float reads, from `settings.json` (ADR 0034). Reactive
   * because the y-axis tick formatter is a closure the uPlot instance
   * keeps — it is in the rebuild effect's deps, so a settings change
   * re-labels the axis rather than waiting for a relaunch. The value
   * readouts below re-render with this component. */
  const floatRule = useFloatFormatRule();

  /** The active theme. Read here for two reasons: the side panel's
   * swatches resolve a color while rendering (and this component is
   * behind a `memo`, so nothing else would re-render it), and the
   * canvas needs the redraw below. */
  const themeName = useThemeName();

  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** The empty stand-in drawn in the canvas column while collapsed. */
  const placeholderRef = useRef<HTMLDivElement | null>(null);
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
  /** Rolling scroll-smoothness meter, fed from the draw hook. */
  const jankRef = useRef(emptyJankMeter());
  /** The y-range actually used to normalise each signal on the most
   * recent resample — the widen-only latch, the manual Fit Y pin, or
   * the !follow-live visible-fit, whichever was active. Surfaced in
   * the side-panel rows so users can see what range the auto-norm is
   * operating against. */
  const effectiveRangesRef = useRef<Map<string, ResolvedAxisRange>>(new Map());
  /** The primary signal's `{lo, hi, unit}` as of the most recent
   * resample, read by the y-axis value formatter to render real units
   * on the y-tick labels (the underlying data is normalised to
   * [0, 1]). Lives in a ref because the formatter is captured at
   * uPlot construction time and we don't want to recreate the chart
   * every time the primary changes. */
  const primaryAxisRef = useRef<(ResolvedAxisRange & { unit: string | null }) | null>(null);
  /** One-shot: have we already done the post-mount rebuild that
   * compensates for restored-from-project panels where the canvas
   * isn't laid out yet at uPlot's first construction? */
  const postMountRebuildDoneRef = useRef(false);
  /** The signal set the live uPlot instance was constructed for, so the
   * construction effect can tell a set change (cache is stale) from a
   * rebuild for any other reason (cache is still good). `null` before
   * the first construction. */
  const builtSignalSetRef = useRef<string | null>(null);
  /** Set by the construction effect when the fresh — and therefore
   * empty — uPlot instance should be repainted from the windowed
   * source's cached window instead of waiting on a refetch. Consumed by
   * the next resample. */
  const repaintFromCacheRef = useRef(false);
  /** The host's per-signal all-time extents from the most recent fetch
   * that asked for them, so a repaint normalises against the same range
   * the drawn window was normalised against (ADR 0025 — the extent is a
   * model fact; this is just the last answer, not a substitute for it).
   * Keyed by signal, like the decimation cache, so it survives a
   * reorder of the very list the sidecar answered in. */
  const hostExtentsRef = useRef<ReadonlyMap<string, SignalExtent> | null>(null);
  const lastResampleTsRef = useRef(0);
  const rateEmaRef = useRef(0);
  /** Synchronous cost (ms) of the last resample's render section — what
   * the fetch loop paces itself against so a many-series area can't take
   * the whole UI thread (`plotPacing.ts`). */
  const renderCostMsRef = useRef(0);
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
  /** The signal list in **order** — what the uPlot instance is built
   * against, since its series array is index-parallel with `signals`.
   * Only the instance keys on this: reordering the rows does cost a
   * destroy + rebuild, and nothing else. */
  const signalSetKey = signals.map(signalRefKey).join("|");
  /** The same list as a **set** — what the sampled data keys on. The
   * decimation cache is a map from signal key to series, so a reorder
   * leaves every sample it holds valid; only a signal joining or leaving
   * makes it stale. Deriving both from one place (rather than spelling
   * the join out again at each use) is what keeps the cache descriptor
   * and the built-instance compare from drifting apart. */
  const signalMembershipKey = signals.map(signalRefKey).sort().join("|");
  /** "Nothing drawn *yet*" for the current signal set, as opposed to
   * "nothing to draw". A membership change re-anchors the windowed
   * source, so the next sample is a cold whole-window one — seconds
   * against a large buffer with a cold decimation cache. Gated behind a
   * short delay so a fast add never flashes it. A reorder keeps the
   * cache, so it isn't a wait at all. */
  const { waiting: buildingFirstSample, settled: firstSampleSettled } = useFirstSampleWait(
    signals.length > 0 ? signalMembershipKey : null,
  );
  /** Live mirror of `signals` for the uPlot draw hook, which is
   * captured at construction and so would otherwise see the signal
   * list as it was then — `signalSetKey` deliberately excludes
   * `hidden` and carries no color, so neither rebuilds the instance. */
  const signalsRef = useRef(signals);
  signalsRef.current = signals;
  /** Live mirror of the selection for the construction effect, which is
   * not re-run on a selection change (that is the point) but must build
   * a rebuilt instance with the widths the selection already implies. */
  const selectedKeysRef = useRef(selectedKeys);
  selectedKeysRef.current = selectedKeys;
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
  const primaryColorRef = useRef<string | null>(
    primarySignal ? seriesColor(primarySignal) : null,
  );
  primaryColorRef.current = primarySignal ? seriesColor(primarySignal) : null;
  /** Live mirror of the series-color resolver, for the same reason as
   * `signalsRef`: the draw hooks and the function strokes are captured
   * at construction, and a recolor must not need a rebuild. */
  const seriesColorRef = useRef(seriesColor);
  seriesColorRef.current = seriesColor;
  // Same reason as the colormap resolver below: a series stroke is a
  // function uPlot calls per draw, so a generator rule changing the
  // answer only reaches the canvas on the next one. A running plot
  // redraws on every sample; a paused/stopped one needs the nudge.
  useEffect(() => {
    uplotRef.current?.redraw();
  }, [seriesColor]);
  // Live value→color resolver for the draw hook (ADR 0029): updated each
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

  // Same reason, for a theme change: the axis stroke / grid / tick
  // colors are functions uPlot resolves per draw and the draw hook
  // reads `theme()` live, so one redraw is all it takes — but a plot
  // that isn't receiving samples would keep the old chrome until
  // something else nudged it, which is exactly the stale canvas the
  // switch must not leave behind.
  useEffect(() => {
    uplotRef.current?.redraw();
  }, [themeName]);

  // Draw the selection in the plot: a selected series gets a bold line.
  // uPlot re-reads `series[i].width` on every draw, so applying the
  // selection is a write onto the live instance plus a redraw — never a
  // rebuild, which at the series counts this panel targets is the cost
  // the pacing work exists to avoid.
  useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    let changed = false;
    signals.forEach((s, i) => {
      const series = u.series[i + 1]; // series[0] is x
      if (!series) return;
      const w = selectedKeys.has(signalRefKey(s)) ? SELECTED_SERIES_WIDTH : 1;
      if (series.width === w) return;
      series.width = w;
      changed = true;
    });
    if (changed) u.redraw();
  }, [selectedKeys, signals]);

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
  const valueTables = useValueTables(signals);
  // Axis-level enum mode is still gated on `signals.length === 1`
  // (the stepped path + symbolic y-axis ticks + label band only
  // make sense on a single-enum axis); derive that from the
  // per-signal map.
  const valueTable = useMemo<ValueTableEntryRecord[] | null>(() => {
    if (signals.length !== 1) return null;
    return valueTables.get(signalRefKey(signals[0])) ?? null;
  }, [signals, valueTables]);
  // Combined enum-lanes axis (ADR 0026): the panel flags this axis (its
  // derived `kind`) as holding all of an area's enums, drawn as stacked
  // logic-analyzer lanes. This wins over single-enum mode — a lone enum
  // on a per-unit area is a one-lane enum-lanes axis, not the old
  // centered-ribbon render. The resample + draw hook read lane state
  // through refs so a table-fetch tick doesn't recreate the
  // (deps-stable) resample callback.
  const laneMode = enumLanes === true && signals.length > 0;
  const laneModeRef = useRef(laneMode);
  laneModeRef.current = laneMode;
  const valueTablesRef = useRef(valueTables);
  valueTablesRef.current = valueTables;
  // Merged raw sample rows (enum codes), one per signal, index-aligned
  // with the y columns of `u.data`. The lanes axis plots normalized
  // lane positions, so the draw hook reads its values from here to
  // match them against a value table. Null off the lanes axis.
  const laneRawRef = useRef<(number | null)[][] | null>(null);
  // The lane draw hook reads tables live from `valueTablesRef`, so it
  // needs no uPlot rebuild when they resolve — but a stopped trace
  // won't redraw on its own. Nudge one so lane labels appear once the
  // tables land. Cheap and a no-op on numeric axes.
  useEffect(() => {
    uplotRef.current?.redraw();
  }, [valueTables]);
  const enumMode = !laneMode && isEnumValueTable(valueTable) && signals.length === 1;
  // Ref mirrors so the resample callback (closure over the initial
  // signal set) sees the up-to-date enum-mode state without being
  // recreated on every value-table tick.
  const enumModeRef = useRef(enumMode);
  enumModeRef.current = enumMode;
  const valueTableRef = useRef(valueTable);
  valueTableRef.current = valueTable;

  /** Manual y control (ADR 0026) is offered on *numeric* axes only. An
   * enum-lanes axis takes its geometry from `laneBandsForVisible` and a
   * single-enum axis from its value table's raw range, so neither a
   * min/max nor a log mapping means anything on them — the menu omits
   * them rather than offering something inert, and any setting a mode
   * change left behind is ignored while the axis renders that way. */
  const yScaleSettable = !laneMode && !enumMode;
  const effectiveYScale = yScaleSettable ? yScale : undefined;
  // Read through a ref for the same reason the enum state is: the
  // resample callback is deps-stable and would otherwise close over the
  // setting as it was when the signal set last changed.
  const yScaleRef = useRef(effectiveYScale);
  yScaleRef.current = effectiveYScale;
  /** Log changes the *shape* of the axis, not just its numbers: the
   * tick splits move onto decade boundaries, which uPlot takes at
   * construction. Toggling it is a user gesture, so rebuilding the
   * instance is cheap and keeps the splits callback honest. */
  const logActive = !!effectiveYScale?.log;
  /** Series that hold data but nothing positive, so a log axis draws
   * none of them. Named rather than counted: the point of the message
   * is that a *specific* trace is missing, not that something is. */
  const [logEmptySignals, setLogEmptySignals] = useState<string>("");
  /** Where the axis's scale menu is open, in client coordinates.
   * `null` when closed. */
  const [axisMenu, setAxisMenu] = useState<{ x: number; y: number } | null>(null);
  /** Where the selection's context menu (Hide / Show) is
   * open, in client coordinates. `null` when closed. */
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number } | null>(null);
  /** Width the y gutter currently reserves — what tells a right-click
   * on the *axis* from one in the plot box, where uPlot owns the
   * gesture (right-drag box zoom). Tracked from the same `axis.size`
   * report the panel latches, so it follows the agreed width rather
   * than guessing; it moves rarely, so the state write is cheap. */
  const [gutterPx, setGutterPx] = useState(DEFAULT_Y_GUTTER_PX);
  const gutterPxRef = useRef(gutterPx);
  const trackGutter = useCallback(
    (id: string, needed: number) => {
      const w = reportGutterNeed(id, needed);
      if (w !== gutterPxRef.current) {
        gutterPxRef.current = w;
        setGutterPx(w);
      }
      return w;
    },
    [reportGutterNeed],
  );

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
    reports,
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
      reports,
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
    // Start of this tick's *synchronous* section — everything from the
    // sample landing to `setData` runs without yielding, and it is what
    // the loop paces itself against (`plotPacing.ts`). Set once the
    // round-trip is back so the host's latency (which costs the UI
    // thread nothing) never inflates the back-off.
    let syncStart = t0;
    try {
      const lr = liveRef.current;
      if (signals.length === 0) {
        resetRange();
        withSuppressed(() => u.setData([[]]));
        seriesRef.current = new Map();
        presentRef.current = new Map();
        lr.reports.series(areaId, new Map());
        lr.onAreaResampled(areaId, null, null);
        lr.reports.base(areaId, null);
        lr.reports.cache(areaId, 0);
        recordRate();
        lr.reports.rate(areaId, rateEmaRef.current);
        setValueTick((v) => v + 1);
        return;
      }

      // Fetch past both edges of the visible window. The window slides
      // continuously between fetches (ADR 0024: viewport position is a
      // function of time), so a slice cut exactly to the window is
      // already stale by the time it renders — the edge it has drifted
      // toward has no data, and the next fetch snaps it back. That reads
      // as contiguous points flickering in from either end. The margin
      // covers the drift; `maxPoints` scales with it so resolution per
      // visible pixel is unchanged.
      const vis = xSyncRef.current;
      let fetchMin = vis.xMin;
      let fetchMax = vis.xMax;
      if (fetchMin != null && fetchMax != null && fetchMax > fetchMin) {
        const pad = (fetchMax - fetchMin) * FETCH_MARGIN_FRACTION;
        fetchMin -= pad;
        fetchMax += pad;
      }
      const canvasW = (canvasRef.current?.clientWidth || 600) * (1 + 2 * FETCH_MARGIN_FRACTION);
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
      // Lane axes get their y from the value tables, not observed data
      // (ADR 0026), so they need no host extent either.
      const wantHostExtent =
        lr.followLive && !manualFitYRef.current && !enumActivePre && !laneModeRef.current;
      const sigQuery = signals.map((s) => ({
        busId: s.busId,
        messageId: s.messageId,
        extended: s.extended,
        signalName: s.signalName,
        fileBacked: s.fileBacked ?? false,
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
      // A rebuilt uPlot starts empty while the windowed source still
      // holds the window that was on screen. Draw that cached window
      // straight back instead of dropping the cache to force a refetch:
      // the refetch is a whole round-trip, and a cold one — dropping the
      // cache drops the `base` that makes it a *slice* fetch — so the
      // panel would sit blank for as long as a full-window sample takes.
      // The normal fetch cycle resumes on the next tick.
      const cached = repaintFromCacheRef.current ? currentRange() : null;
      repaintFromCacheRef.current = false;
      const outcome: DecimatedOutcome<(SignalExtent | null)[]> = cached
        ? { kind: "sampled", snapshot: cached, extra: null }
        : await sampleRange<(SignalExtent | null)[]>(
            {
              // Membership, not order: the cache is keyed by signal, so
              // re-anchoring it on a reorder would throw away a window
              // every sample of which is still valid.
              descriptor: signalMembershipKey,
              signals: signals.map((s) => ({
                key: signalRefKey(s),
                busId: s.busId,
                messageId: s.messageId,
                extended: s.extended,
                signalName: s.signalName,
              })),
              winStart: lr.winStart,
              winEnd: lr.winEnd,
              xMin: fetchMin,
              xMax: fetchMax,
              origin: lr.originSeconds,
              maxPoints: maxPts,
              // This axis draws held states (lanes, or the single-enum
              // ribbon), so the host must reduce an over-budget window
              // by its transitions. A min/max envelope over enum codes
              // keeps each bucket's lowest and highest code and drops
              // every state held in between — at a window wider than the
              // point budget the lane stops showing what was held.
              categorical: laneModeRef.current || enumActivePre,
            },
            sidecar,
          );
      syncStart = performance.now();
      // uPlot was rebuilt while the fetch was in flight — this resample
      // belongs to the old instance; the rebuild kicks a fresh one.
      if (uplotRef.current !== u) return;
      if (outcome.kind === "pending") return; // nothing real yet — retry next tick
      // The wait ends at the first *paint* or at the host's "that is all
      // there is", whichever comes first. A serve is bounded in time, so
      // a cold one answers with the prefix it has decoded: points to
      // draw means the area is no longer waiting even though the rebuild
      // runs on, while a partial answer that decoded nothing yet is still
      // "nothing *yet*" and keeps the placeholder up. Everything else —
      // an empty window, a memoised one, a completed answer however
      // empty — is definitive.
      if (
        outcome.kind !== "sampled" ||
        outcome.snapshot.complete ||
        hasAnyPoints(outcome.snapshot)
      )
        firstSampleSettled();

      if (outcome.kind === "empty") {
        // Window collapsed (trace just started, no frames yet, or the
        // visible x range collapsed). Clear the plot and keep ticking.
        withSuppressed(() => u.setData([[] as number[], ...signals.map(() => [] as number[])] as uPlot.AlignedData));
        seriesRef.current = new Map();
        presentRef.current = new Map();
        lr.reports.series(areaId, new Map());
        lr.onAreaResampled(areaId, null, null);
        lr.reports.cache(areaId, 0);
        recordRate();
        lr.reports.rate(areaId, rateEmaRef.current);
        return;
      }

      // Cached-points gauge: biggest series currently in the window.
      const snap = currentRange();
      let biggestCache = 0;
      if (snap) for (const c of snap.byKey.values()) if (c.t.length > biggestCache) biggestCache = c.t.length;
      lr.reports.cache(areaId, biggestCache);

      if (outcome.kind === "unchanged") {
        // Same request as last fetch — keep the rendered data, just feed
        // the follow-live edge and tick the rate readout.
        lr.onAreaResampled(areaId, outcome.firstT, outcome.lastT);
        recordRate();
        lr.reports.rate(areaId, rateEmaRef.current);
        return;
      }

      // outcome.kind === "sampled" — render the fresh window.
      const { snapshot } = outcome;
      // Keyed by signal, not by position: the sidecar answers in the
      // order it was asked, but the answer outlives that order (a
      // reorder rebuilds the chart and repaints from cache without
      // re-asking), and a positional read would then normalise each
      // series against another signal's extent.
      if (outcome.extra) {
        const extents = new Map<string, SignalExtent>();
        signals.forEach((s, i) => {
          const e = outcome.extra?.[i];
          if (e) extents.set(signalRefKey(s), e);
        });
        hostExtentsRef.current = extents;
      }
      const hostExtents = hostExtentsRef.current;
      const base = snapshot.base;
      lr.reports.hostMs(areaId, snapshot.sliceMs + snapshot.decodeMs);
      // Areas share x, so a panel-level base from any area lets
      // session-scoped notes project onto this panel's x-axis.
      lr.reports.base(areaId, base);

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
      //
      // Two rules apply to every one of those branches:
      //
      //  * **A hidden signal contributes nothing.** It isn't drawn, so
      //    it must not set the scale the drawn signals share — an axis
      //    auto-scales to its data (ADR 0026), and what is hidden is
      //    not on the axis. The host still owns each signal's all-time
      //    extent (ADR 0025); *which* of those extents an axis unions
      //    is a view decision, so it is made here rather than by
      //    telling the host what the user has hidden.
      //  * **A degenerate extent still counts.** A signal that never
      //    moves has `hi === lo`. Dropping it left it with no range at
      //    all, so it fell back to the canvas midline and stopped
      //    sharing its unit group's scale — a constant 3000 A limit
      //    drew mid-canvas next to a 500 A signal filling the canvas.
      //    It contributes its one value to the group union instead,
      //    and a group whose *whole* union is one value is widened to
      //    a minimum range by `groupScaleRanges` so its axis still
      //    reads as that value (ADR 0026).
      const ranges = new Map<string, { lo: number; hi: number }>();
      signals.forEach((s, i) => {
        if (s.hidden) return;
        const key = signalRefKey(s);
        if (manualFitYRef.current) {
          const m = manualRangesRef.current.get(key);
          if (m) ranges.set(key, m);
          return;
        }
        if (lr.followLive) {
          const e = hostExtents?.get(key);
          if (e) ranges.set(key, { lo: e.lo, hi: e.hi });
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
        if (Number.isFinite(lo) && Number.isFinite(hi)) ranges.set(key, { lo, hi });
      });
      // Unit-based y-scale (ADR 0026): the per-signal latches above
      // feed `groupScaleRanges`, which hands every signal the *union*
      // range of its unit group — so same-unit series share one y
      // scale and each unit group auto-scales independently to fill
      // the axis. Unitless signals each keep their own range (two
      // signals that merely both lack a unit aren't known
      // commensurable).
      const members = signals.map((s) => ({ key: signalRefKey(s), unit: s.unit }));
      const scaleRanges = groupScaleRanges(members, ranges);
      // Manual y control (ADR 0026) sits on top of that: a user-set
      // bound replaces the derived one — and so beats the follow-live
      // extent and the visible fit alike — while an unset bound keeps
      // auto-scaling, item-4 constant widening included. It is applied
      // per *group*, because the axis's setting governs every scale
      // drawn on it, and the groups are what those scales are.
      //
      // A log axis derives its own minimum from the data: the smallest
      // positive value each group actually holds. That is not
      // recoverable from the group's `(lo, hi)` — a group spanning zero
      // has a non-positive `lo` and positive samples both — so it is
      // folded over the sampled values, once per group, and only when
      // a log axis asked for it.
      const setting = yScaleRef.current;
      const minPositive = new Map<string, number>();
      if (setting?.log) {
        signals.forEach((s, i) => {
          if (s.hidden) return;
          const gk = scaleGroupKey(members[i]);
          let m = minPositive.get(gk) ?? Infinity;
          for (const v of seriesRel[i].v) if (v > 0 && v < m) m = v;
          if (Number.isFinite(m)) minPositive.set(gk, m);
        });
      }
      const axisRanges = new Map<string, ResolvedAxisRange>();
      const noPositive: string[] = [];
      if (setting) {
        signals.forEach((s, i) => {
          if (s.hidden) return;
          const key = members[i].key;
          const resolved = resolveAxisRange(
            scaleRanges.get(key) ?? null,
            setting,
            minPositive.get(scaleGroupKey(members[i])) ?? null,
          );
          if (resolved) axisRanges.set(key, resolved);
          else if (setting.log && seriesRel[i].v.length > 0) noPositive.push(s.signalName);
        });
      } else {
        for (const [key, r] of scaleRanges) axisRanges.set(key, { ...r, log: false });
      }
      setLogEmptySignals(noPositive.join(", "));
      // Enum-mode: skip auto-normalisation and pass raw enum codes
      // through. The y scale is pinned to the table's raw-value range
      // below so the trace's discrete codes plot at their natural
      // positions and the axis tick labels (set in `opts`) are
      // symbolic.
      const enumActive = enumModeRef.current && valueTableRef.current != null;
      const effective = new Map<string, ResolvedAxisRange>();
      // Lane axis: normalise each enum into its own lane band on the
      // [0, 1] scale (ADR 0026). The lane's value range is a *table*
      // fact (padded raw min/max), independent of observed data; a
      // signal with no table draws flat at its lane midline.
      const laneActive = laneModeRef.current;
      // Merge onto the shared time axis *first*, then normalise the
      // merged rows. The lane draw hook has to match plotted samples
      // against a value table, which only works on the model values
      // (raw enum codes) — so it needs a raw array index-aligned with
      // `u.data`. Merging first makes that alignment structural: both
      // arrays are the same rows, one derived from the other.
      //
      // Equivalent to normalising first, because `mergeSeries` derives
      // its x column from timestamps alone and sample-and-holds values
      // without interpolating: holding a normalised value is the same
      // as normalising a held one. The `null` before a series' first
      // sample must be carried through untouched.
      const mergedRaw = mergeSeries(seriesRel);
      const xs = mergedRaw[0] as number[];
      const rawRows = mergedRaw.slice(1);
      const displayRows: (number | null)[][] = laneActive
        ? (() => {
            // Hidden lanes drop out of the layout, so the visible ones
            // share the whole axis height (ADR 0026).
            const bands = laneBandsForVisible(signals.map((s) => !!s.hidden));
            return rawRows.map((row, i) => {
              const band = bands[i];
              // No lane: the series isn't drawn (`show: false`), so
              // leave its raw codes rather than invent a position.
              if (band == null) return row;
              if (seriesRel[i].v.length === 0) return row; // all null anyway
              const table = valueTablesRef.current.get(signalRefKey(signals[i]));
              if (table && table.length > 0) {
                const range = laneValueRange(table);
                return row.map((v) => (v == null ? null : normalizeIntoLane(v, range, band)));
              }
              const mid = (band.lo + band.hi) / 2;
              return row.map((v) => (v == null ? null : mid));
            });
          })()
        : enumActive
        ? rawRows
        : // Normalise **in place**. `rawRows` were just allocated by
          // `mergeSeries` and, off the lane path, nothing else reads them
          // (`laneRawRef` is only set in lane mode), so a `map` here just
          // buys a second array per series — one full `signals.length ×
          // xs.length` allocation per tick, churned every tick. A
          // Chromium CPU profile of a 512-series area put those two
          // `map`s at 17 % of the UI thread and most of another 14 % in
          // the GC they fed.
          rawRows.map((row, i) => {
            if (seriesRel[i].v.length === 0) return row; // all null anyway
            const key = members[i].key;
            const r = axisRanges.get(key);
            if (r && r.hi > r.lo) {
              effective.set(key, r);
              if (r.log) {
                // Non-positive samples are **dropped** (`null`, so uPlot
                // leaves a gap), not clamped onto the floor — a clamped
                // point reads as a real reading (ADR 0026).
                const loE = Math.log10(r.lo);
                const inv = 1 / (Math.log10(r.hi) - loE);
                for (let j = 0; j < row.length; j++) {
                  const v = row[j];
                  if (v != null) row[j] = v > 0 ? (Math.log10(v) - loE) * inv : null;
                }
                return row;
              }
              const span = r.hi - r.lo;
              for (let j = 0; j < row.length; j++) {
                const v = row[j];
                if (v != null) row[j] = (v - r.lo) / span;
              }
              return row;
            }
            if (setting?.log) {
              // A log axis over a series with nothing positive in it has
              // no range at all. Blank the row rather than fall to the
              // midline below, which would draw a flat line where the
              // axis can show no reading (the side panel says so).
              for (let j = 0; j < row.length; j++) row[j] = null;
              return row;
            }
            // No range available yet — the signal hasn't decoded, so
            // it has no entry at all (a constant one does, widened to
            // a minimum range). Render at the canvas midline so the
            // line is *visible* — without this fallback the raw values
            // get drawn against the y = [0, 1] pin and clipped to
            // nothing.
            for (let j = 0; j < row.length; j++) {
              if (row[j] != null) row[j] = 0.5;
            }
            return row;
          });
      const merged = [xs, ...displayRows] as uPlot.AlignedData;
      // Raw codes for the lane draw hook, same row order as `u.data`.
      laneRawRef.current = laneActive ? rawRows : null;
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
      // Refresh the range/unit the y-axis value formatter converts
      // normalised tick positions back through. Prefer the parent
      // area's primary signal, but only when it's actually on *this*
      // derived axis — in per-unit mode each axis is a different unit
      // group, so the primary lives on at most one of them. For every
      // other axis (and when no primary is set) fall back to this
      // axis's first ranged signal, so labels read real units (V, A, %)
      // instead of the normalised [0, 1]. Read through the ref — the
      // closure's `primaryKey` goes stale on promotion.
      const pk = primaryKeyRef.current;
      let labelKey: string | null = pk && effective.has(pk) ? pk : null;
      if (!labelKey) {
        for (const s of signals) {
          const k = signalRefKey(s);
          if (effective.has(k)) {
            labelKey = k;
            break;
          }
        }
      }
      if (labelKey) {
        const r = effective.get(labelKey)!;
        const sig = signals.find((s) => signalRefKey(s) === labelKey);
        primaryAxisRef.current = { ...r, unit: sig?.unit ?? null };
      } else {
        primaryAxisRef.current = null;
      }
      lr.reports.series(areaId, sm);
      lr.onAreaResampled(areaId, windowStartT, liveEdgeT);
      lr.reports.perf(areaId, performance.now() - t0);
      recordRate();
      lr.reports.rate(areaId, rateEmaRef.current);
      setValueTick((v) => v + 1);
    } catch {
      /* a failed sample just leaves the last one on screen */
    } finally {
      renderCostMsRef.current = performance.now() - syncStart;
      resampleBusyRef.current = false;
    }
  }, [
    signals,
    signalMembershipKey,
    areaId,
    withSuppressed,
    recordRate,
    sampleRange,
    currentRange,
    resetRange,
    firstSampleSettled,
  ]);

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
      stroke: () => theme().axisText,
      grid: { stroke: () => theme().axisGrid, width: 1 },
      ticks: { stroke: () => theme().axisTicks, width: 1 },
      font: "10px ui-monospace, SFMono-Regular, Menlo, monospace",
    };
    // Enum-mode hook-up: stepped paths + symbolic y-axis
    // ticks. The construction effect closes over `valueTable` so a
    // table-fetch resolution (which re-renders + triggers rebuild
    // through the `signalSetKey` dep on this effect) installs the
    // enum-mode opts on the next uPlot instance.
    const enumActiveAtConstruct = enumMode && valueTable != null;
    // Combined enum-lanes axis (ADR 0026): stepped paths for every
    // series, a blank y gutter (tiles carry the labels, the side panel
    // carries identity), and per-signal color targets for the draw
    // hook. The lane *tables* are read live from `valueTablesRef` in
    // the draw hook (a redraw effect below shows labels once they
    // resolve), so this instance need not rebuild when they land.
    const laneModeAtConstruct = laneMode;
    const laneTargetsAtConstruct: (ColorTarget | null)[] = laneModeAtConstruct
      ? signals.map((s) => ({
          messageId: s.messageId,
          extended: s.extended,
          signalName: s.signalName,
          busId: s.busId ?? null,
        }))
      : [];
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
    const yAxis: uPlot.Axis = laneModeAtConstruct
      ? {
          // Blank gutter: no splits / values / grid. The lane tiles
          // carry the value labels and the side panel carries identity,
          // so a y scale would only waste horizontal space (ADR 0026).
          // It still reserves whatever the panel agreed on — the boxes
          // have to start at the same x for the shared cursor to be
          // collinear — it just leaves it empty.
          ...axisCommon,
          size: () => trackGutter(areaId, 14),
          grid: { show: false },
          ticks: { show: false },
          splits: () => [],
          values: () => [],
        }
      : enumActiveAtConstruct
      ? {
          ...axisCommon,
          size: () => trackGutter(areaId, 80),
          splits: () => enumRaws,
          values: (_u, splits) =>
            splits.map((v) => `${v} "${enumLabelFor(Math.round(v))}"`),
        }
      : {
          ...axisCommon,
          // Tick *positions* stay on the underlying [0, 1] scale — what
          // changes is how we format each split's value for display.
          // The plot data is normalised to [0, 1], so each split is
          // mapped back through the primary signal's current range to
          // recover a raw signal value for the label (and the signal's
          // unit is suffixed when the DBC supplied one). That mapping
          // is the axis's own: linear by default, by decades when the
          // axis is on a log scale.
          values: (_u, splits) => splits.map((v) => {
            const p = primaryAxisRef.current;
            if (p == null) return fmtTickValue(v, floatRule, logActive);
            const label = fmtTickValue(denormalizeOnAxis(v, p), floatRule, logActive);
            return `${label}${p.unit ? ` ${p.unit}` : ""}`;
          }),
          // A log axis puts its ticks on decade boundaries; uPlot's own
          // even splits over the normalised [0, 1] would read `1`,
          // `3.98`, `15.8`… Installed only when the axis is log at
          // construction, so a linear axis keeps uPlot's default
          // spacing untouched.
          ...(logActive ? { splits: () => logDecadeSplits(primaryAxisRef.current) } : {}),
          // Sized from the formatted tick strings each layout pass: a
          // signal with units like `degC` and 5-digit raw values needs
          // far more than 52 px of gutter, otherwise labels run off the
          // canvas edge. We measure the widest formatted label in the
          // current tick set with a canvas 2d context (cheap; reuses a
          // module-level scratch context).
          // The measurement is a *request*: the panel hands back the
          // width every axis in the stack reserves (the widest anyone
          // needs), latched against tick-text churn. Both parts matter
          // — a per-axis width leaves the plot boxes starting at
          // different x, and an unlatched one makes the left edge
          // twitch frame to frame under an auto-fitted scale.
          size: (_u, values) => trackGutter(areaId, measureAxisSize(values)),
          // Tint the y-axis to match the primary signal's trace so
          // it's obvious which series the labels correspond to. Falls
          // back to the neutral axis color when there's no primary
          // (empty area). uPlot calls these per draw, so the ref read
          // picks up promotions immediately.
          stroke: () => primaryColorRef.current ?? theme().axisText,
          ticks: { stroke: () => primaryColorRef.current ?? theme().axisTicks, width: 1 },
        };
    // Elapsed-time labels widen as you zoom in (more fractional digits,
    // ADR 0024), so a fixed tick spacing lets them collide. Space the
    // ticks by the widest label the current span produces plus a gap, so
    // they never overlap. Applied to *every* stacked area (not just the
    // labelled bottom one) so all areas pick the same tick increment and
    // their shared x-gridlines stay aligned.
    const xTickSpace: uPlot.Axis["space"] = (_u, _axisIdx, min, max) => {
      const d = fracDigitsForSpan((max ?? 0) - (min ?? 0));
      const widest = measureLabelWidth(formatElapsed(max ?? 0, d));
      return Math.max(50, Math.ceil(widest) + 22);
    };
    // Only the bottom-most stacked area carries the "time (s)" label and
    // numeric ticks. Upper areas keep gridlines + tick marks (so the
    // shared x-grid still reads across the whole stack) but drop the
    // label and the numbers — they're identical on every area, so
    // repeating them just wastes vertical space.
    //
    // That one label is also where the free cursor's own time is read
    // out. The crosshair is panel-level (one shared x for the whole
    // stack), so the readout is too: it belongs to the single labelled
    // axis at the foot of the panel, not to each area. uPlot calls
    // `label` on every draw, so this reads `liveRef` and costs no React
    // state of its own — the redraw the shared hover already triggers
    // repaints it.
    const xAxis: uPlot.Axis = isLast
      ? {
          ...axisCommon,
          label: (u: uPlot) =>
            xAxisLabelText(
              liveRef.current.hoverX,
              u.scales.x.max ?? null,
              fracDigitsForSpan((u.scales.x.max ?? 0) - (u.scales.x.min ?? 0)),
            ),
          labelFont: X_AXIS_LABEL_FONT,
          labelSize: 16,
          size: 34,
          space: xTickSpace,
          // Ticks share the trace's elapsed-time format (ADR 0024) so
          // the same timeline position reads identically in both views;
          // precision adapts to the visible span so zoomed-in ticks stay
          // distinguishable.
          values: (u, splits) => {
            const d = fracDigitsForSpan((u.scales.x.max ?? 0) - (u.scales.x.min ?? 0));
            return splits.map((v) => formatElapsed(v, d));
          },
        }
      : { ...axisCommon, size: 18, space: xTickSpace, values: (_u, splits) => splits.map(() => "") };
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: Math.max(24, el.clientHeight - 2),
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
        ...signals.map((s, i) => ({
          label: `${s.messageName}.${s.signalName}`,
          // Resolved live per draw, like the y-axis stroke below:
          // `signalSetKey` carries no color, so this instance is never
          // rebuilt for a recolor and a captured string would keep the
          // color the series had when it was constructed. uPlot resolves
          // a function stroke on every draw (and hands the same function
          // to the point markers), so the next redraw carries the new
          // color — a pick, a generator change, or a theme switch alike.
          // The construction-time series is the fallback for the one
          // render between a signal-set change and the rebuild it
          // triggers.
          stroke: () => seriesColorRef.current(signalsRef.current[i] ?? s),
          // Selected series draw bold. Unlike `stroke`, uPlot does not
          // call a function for `width` — it reads the number off the
          // series object on every draw — so the selection is applied by
          // writing it there (the effect below) and this is only the
          // starting value a (re)built instance opens with.
          width: selectedKeysRef.current.has(signalRefKey(s)) ? SELECTED_SERIES_WIDTH : 1,
          // `auto` defers to uPlot's density default; `off` never draws
          // markers; `on` always draws them but capped at a flat max across
          // the visible range so a zoomed-out window doesn't render a
          // marker per decimated sample. See `plotPoints.ts`.
          points: showPointsToUplot(showPoints),
          show: !s.hidden,
          ...((enumActiveAtConstruct || laneModeAtConstruct) && uPlot.paths.stepped
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
            diagCount("userx.setscale-hook"); // DIAG
            diagGauge("userx.leak.min", min); // DIAG
            diagGauge("userx.leak.max", max); // DIAG
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
            // Scroll-smoothness sample, taken here because this is the
            // one place that sees every repaint and the window position
            // that was actually painted — not what we intended to paint.
            {
              const xs = u.scales.x;
              if (xs.min != null) {
                jankRef.current = observeScroll(jankRef.current, xs.min, performance.now(), JANK_ALPHA);
                const pct = jankPercent(jankRef.current);
                lr.reports.jank(areaId, pct);
                // Also diag gauges, so the ADR 0031 capture carries scroll
                // smoothness into the RenderReport instead of it being
                // eyeballed. Distinct from the report's long-task
                // `jank_fraction`: this is how evenly the window scrolls,
                // not how busy the main thread was.
                //
                // Three numbers, because one is not interpretable: the
                // percentage is a *rate* deviation and so moves with the
                // zoom and with the cadence the window advances at, while
                // the pixels a user can actually see stay put. `_px` is
                // the same wobble with both of those divided out and
                // `_step_ms` is the cadence, without which neither of the
                // other two can be read.
                if (pct != null) diagGauge("scroll_jank_pct", pct);
                const pxPerSecond =
                  xs.max != null && xs.max > xs.min ? width / ratio / (xs.max - xs.min) : 0;
                const px = jankPixels(jankRef.current, pxPerSecond);
                if (px != null) diagGauge("scroll_jank_px", px);
                const step = scrollStepMs(jankRef.current);
                if (step != null) diagGauge("scroll_step_ms", step);
              }
            }
            ctx.save();
            ctx.beginPath();
            ctx.rect(left, top, width, height);
            ctx.clip();
            ctx.font = `600 ${9.5 * ratio}px ui-monospace, monospace`;
            ctx.lineWidth = 1 * ratio;
            // Logic-analyzer lane (ADR 0026): on an enum-only axis,
            // overlay an opaque label box on each constant-value
            // segment of the (stepped) line. The line + symbolic
            // y-axis ticks are still there; the boxes sit *in front*
            // of the line so a glance reads "Idle ── Running ──"
            // rather than just a step pattern. Only runs on the
            // enum-mode uPlot (the construction effect rebuilds the
            // instance when the value table resolves), so the cost
            // on numeric axes is zero.
            //
            // Drawn before the cursor / event overlays below: tiles are
            // content, those are annotation, so the readouts you are
            // actively pointing at have to stay legible over them.
            if (enumActiveAtConstruct && valueTableRef.current) {
              // Single-enum axis: one signal (series index 1), tiles in
              // a centered horizontal ribbon. Decoupling the ribbon from
              // the held value (vs. a per-value lane) keeps labels legible
              // even for a tall table on a short canvas; the stepped line
              // still draws at the real value. Band = max(~22 CSS px, 55%
              // of the plot height), centered.
              const bandH = Math.max(22 * ratio, height * 0.55);
              const bandTop = top + (height - bandH) / 2;
              drawEnumTiles(ctx, u, {
                seriesIdx: 1,
                table: valueTableRef.current,
                target: enumTarget,
                resolveColor: colorResolverRef.current,
                bandTop,
                bandBot: bandTop + bandH,
                accent: primaryColorRef.current ?? theme().axisText,
                left,
                width,
                ratio,
              });
            } else if (laneModeAtConstruct) {
              // Combined enum-lanes axis: one tile row per *visible*
              // signal, in its lane band (ADR 0026). Lane geometry is
              // normalized [0, 1] (top-first); convert to canvas pixels
              // via `valToPos`.
              //
              // Read the signals through the ref, not this hook's
              // closure: hiding a signal deliberately doesn't rebuild
              // the uPlot instance (`signalSetKey` ignores `hidden`), so
              // a captured list would keep drawing the lanes as they
              // were laid out at construction while the data underneath
              // has already re-flowed.
              const laneSignals = signalsRef.current;
              const bands = laneBandsForVisible(laneSignals.map((s) => !!s.hidden));
              laneSignals.forEach((s, i) => {
                const laneNorm = bands[i];
                if (laneNorm == null) return;
                const laneTopPx = u.valToPos(laneNorm.hi, "y", true);
                const laneBotPx = u.valToPos(laneNorm.lo, "y", true);
                const tileNorm = laneTileBand(laneNorm, laneBotPx - laneTopPx);
                // A shared empty table, not a fresh `[]`: the label
                // lookup is cached against the table's identity, and a
                // new array every draw would miss it every draw.
                const table = valueTablesRef.current.get(signalRefKey(s)) ?? NO_VALUE_TABLE;
                drawEnumTiles(ctx, u, {
                  seriesIdx: i + 1,
                  table,
                  target: laneTargetsAtConstruct[i] ?? null,
                  resolveColor: colorResolverRef.current,
                  bandTop: u.valToPos(tileNorm.hi, "y", true),
                  bandBot: u.valToPos(tileNorm.lo, "y", true),
                  accent: seriesColorRef.current(signalsRef.current[i] ?? s),
                  left,
                  width,
                  ratio,
                  // Raw codes: the plotted series holds lane positions.
                  // Without a table the lookup is meaningless either
                  // way, so keep the plotted values there — that's what
                  // draws today (one flat tile at the lane midline).
                  rawValues: table.length > 0 ? (laneRawRef.current?.[i] ?? undefined) : undefined,
                });
              });
            }
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
                ctx.fillStyle = theme().canvasChipFill;
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
              vline(ev.t, ev.color ?? theme().eventMarker, ev.id === "__t0" ? [] : [2, 3], isFirst ? ev.label : null, true);
            }
            // Task 15 / ADR 0026: the X cursor's time label appears on
            // every axis (it used to render only on the last area, so
            // adding a plot area visually hid the labels). Format as
            // "<letter> <time>" so a glance at any axis tells you both
            // which cursor and where — positions in the trace's
            // elapsed-time format, at the axis ticks' adaptive precision.
            const xDigits = fracDigitsForSpan((u.scales.x.max ?? 0) - (u.scales.x.min ?? 0));
            if (lr.cursorXa != null) {
              vline(lr.cursorXa, theme().cursorA, [4, 3], `A ${formatElapsed(lr.cursorXa, xDigits)}`, false);
            }
            if (lr.cursorXb != null) {
              vline(lr.cursorXb, theme().cursorB, [4, 3], `B ${formatElapsed(lr.cursorXb, xDigits)}`, false);
            }
            // The shared mouse crosshair (panel-level, like A/B): drawn
            // in *every* stacked area at the same x, so the hover in
            // one area lines up with the readouts everywhere. No label
            // — it tracks the pointer; `vline` clips it when the x
            // falls outside this area's window, same as A/B.
            if (lr.hoverX != null) {
              vline(lr.hoverX, theme().crosshair, [4, 3], null, false);
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
              ctx.fillStyle = theme().canvasChipFill;
              ctx.fillRect(lx, yp - h / 2, tw + padX * 2, h);
              ctx.strokeStyle = color;
              ctx.strokeRect(lx, yp - h / 2, tw + padX * 2, h);
              ctx.fillStyle = color;
              ctx.textAlign = "left";
              ctx.textBaseline = "middle";
              ctx.fillText(lbl, lx + padX, yp);
            };
            if (lr.cursorYh1 != null) hline(lr.cursorYh1, theme().cursorA, "H1");
            if (lr.cursorYh2 != null) hline(lr.cursorYh2, theme().cursorB, "H2");
            // A small Δ chip so the cursor delta is visible without
            // turning on the measurement strip.
            const chip = (cx: number, cy: number, text: string, color: string) => {
              const tw = ctx.measureText(text).width;
              const padX = 4 * ratio;
              const h = 13 * ratio;
              ctx.fillStyle = theme().canvasChipFill;
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
                chip(xp, top + height - 18 * ratio, `Δt ${formatDurationSeconds(Math.abs(lr.cursorXb - lr.cursorXa))}`, theme().axisText);
              }
            }
            if (lr.cursorYh1 != null && lr.cursorYh2 != null) {
              const yp = u.valToPos((lr.cursorYh1 + lr.cursorYh2) / 2, "y", true);
              if (yp > top && yp < top + height) {
                chip(left + 40 * ratio, yp, `ΔH ${fmtVal(Math.abs(lr.cursorYh2 - lr.cursorYh1))}`, theme().axisText);
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
                  diagCount("userx.wheel.hpan"); // DIAG
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
                  diagCount("userx.wheel.shiftpan"); // DIAG
                  liveRef.current.onUserXChange(min, max, areaId);
                } else {
                  // plain wheel → zoom x around the cursor (synced).
                  const px = e.clientX - rect.left;
                  const xc = u.posToVal(px, "x");
                  const min = xc - (xc - xs.min) * f;
                  const max = xc + (xs.max - xc) * f;
                  withSuppressed(() => u.setScale("x", { min, max }));
                  // Only one gesture means "stop following": zooming
                  // *out* over the leading half. That widens the window
                  // around a point near the live edge, which is how you
                  // pull older data into view — everything else (zooming
                  // in anywhere, or any zoom over the t=0 half) is a
                  // scale change, and `followXWindow` keeps the new
                  // width while continuing to track.
                  const zoomingOut = f > 1;
                  const onLeadingHalf = px >= rect.width / 2;
                  diagCount("userx.wheel.zoom"); // DIAG
                  liveRef.current.onUserXChange(min, max, areaId, !(zoomingOut && onLeadingHalf));
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
                diagCount("userx.drag.pan"); // DIAG
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
                  diagCount("userx.boxzoom"); // DIAG
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
    // Construct inside the suppress window, and seed the shared x-window
    // before anything can observe the instance. uPlot sets its scales
    // during construction, which fires our `setScale` hook; unsuppressed,
    // a fresh instance's default range doesn't match the shared window,
    // so the hook reads it as a user pan — `applyXAll` yanks every area
    // to that default range and follow-live switches off. The rebuild is
    // triggered by the signal set changing, which is exactly what
    // connecting does once DBCs and value tables resolve.
    let u!: uPlot;
    withSuppressed(() => {
      u = new uPlot(opts, initialData, el);
      const { xMin, xMax } = xSyncRef.current;
      if (xMin != null && xMax != null) u.setScale("x", { min: xMin, max: xMax });
    });
    uplotRef.current = u;
    registerInstance(areaId, u);
    // Only a changed signal *membership* makes the cached window stale
    // (it is anchored to the old set) — drop it, and the host extents
    // that go with it, so the re-sample below rebuilds both from a full
    // fetch. Every other reason this effect re-runs (a reorder, the
    // post-mount layout rebuild below, a resize, an axis / value-table
    // change) leaves the cache valid over an empty instance, so repaint
    // from it instead: throwing it away costs a full-window round-trip
    // and shows a blank panel until that lands. Also clear the
    // busy-guard (a re-sample for the *previous* uPlot may still be in
    // flight; it'll no-op once it sees `uplotRef.current` moved on) so
    // this fresh instance gets its data even when the trace isn't
    // running (no timer to retry it).
    if (builtSignalSetRef.current !== signalMembershipKey) {
      builtSignalSetRef.current = signalMembershipKey;
      hostExtentsRef.current = null;
      resetRange();
    } else {
      repaintFromCacheRef.current = true;
    }
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
    let lastH = Math.max(24, el.clientHeight - 2);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth || 600;
      const h = Math.max(24, el.clientHeight - 2);
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
    // The float rule enters as its three numbers, not as the object:
    // the hook builds a fresh one each render, so the object itself
    // would rebuild the instance on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    signalSetKey,
    areaId,
    resizeTick,
    valueTable,
    showPoints,
    isLast,
    logActive,
    floatRule.exponentialBelow,
    floatRule.exponentialFrom,
    floatRule.mantissaDecimals,
  ]);

  // While the trace is running, re-sample on a self-paced loop at the
  // configured rate (each tick scheduled after the previous one
  // finishes — decoupled from React re-renders, which lurch / stall at
  // high capture rates, and never piling up). Pause/Stop ends the loop,
  // freezing the window; the leading re-sample on the running→paused
  // edge captures the frozen state. Also re-sample once when the window
  // re-anchors (Clear / Start gives a new `winStart`) or the rate
  // changes.
  //
  // The interval is a floor, not the cadence: a tick that did expensive
  // synchronous work is followed by proportional idle time, so however
  // many signals the area holds it can never occupy more than a bounded
  // share of the UI thread (`plotPacing.ts`). At the ordinary handful of
  // series the tick is far cheaper than the interval and this is a no-op.
  useEffect(() => {
    void resampleRef.current();
    if (!live) {
      rateEmaRef.current = 0;
      return;
    }
    let stopped = false;
    let timer = 0;
    const nextDelay = () => nextResampleDelayMs(fetchIntervalMs, renderCostMsRef.current);
    const tick = async () => {
      if (stopped) return;
      try {
        await resampleRef.current();
      } catch {
        /* a transient sample failure must not kill the loop */
      }
      if (stopped) return;
      timer = window.setTimeout(() => void tick(), nextDelay());
    };
    timer = window.setTimeout(() => void tick(), nextDelay());
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      rateEmaRef.current = 0;
      lastResampleTsRef.current = 0;
    };
  }, [live, winStart, fetchIntervalMs]);

  // Re-sample on a window change the loop above cannot see: the first
  // non-empty window after mount (`winEnd` is still `0` on the first
  // render, because `useTrace` hasn't resolved the registry entry yet,
  // so the loop's one-shot resample saw nothing), and any later change
  // while the loop is off — a stopped / paused panel whose window moved
  // under it. While the trace is running the loop already covers every
  // later change, and firing here too put an undeduped `trace-grew`-rate
  // floor (~10 Hz) under the resample cadence: the busy-guard drops only
  // *overlapping* calls, not interleaved ones.
  const sampledWindowRef = useRef(false);
  useEffect(() => {
    if (live && sampledWindowRef.current) return;
    if (winEnd > 0) sampledWindowRef.current = true;
    void resampleRef.current();
  }, [winEnd, live]);

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
    // Lane axes take their y from the value tables, not observed data
    // (ADR 0026) — Fit Y has nothing to snapshot and must not leave a
    // stale manual latch that survives a mode switch.
    if (laneModeRef.current) return;
    // Fit Y *clears* a manual range rather than writing the fitted
    // numbers into it. Under a sparse store "fit y" and "clear the
    // fields" are the same intent — go back to automatic — and seeding
    // the fields would silently pin every axis the user ever fitted.
    // The log flag is not a range and survives: fitting a log axis to
    // its visible data is still a log axis.
    onSetYScale({ min: null, max: null });
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
      // A constant series (`hi === lo`) is kept: it still has to
      // contribute its value to its unit group's union, the same way
      // the auto path does.
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      next.set(key, { lo, hi });
    }
    manualRangesRef.current = next;
    manualFitYRef.current = true;
    void resampleRef.current();
  }, [onSetYScale]);
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
        primaryAxisRef.current = { ...r, unit: sig?.unit ?? null };
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
  // `setSeries` alone left the area blank until the next pan/zoom
  // forced a resample, because what a visibility change really moves is
  // the *normalisation* (a hidden series contributes nothing to its
  // group's scale) and that only happens on a resample. So resample —
  // but from the window already cached, not from the host: the fetch
  // covers hidden signals too, so every sample this needs is in hand
  // and a round-trip would return the same bytes. That matters beyond
  // one swatch click: solo's step mode flips visibility per keystroke.
  const hiddenKey = signals.map((s) => (s.hidden ? "1" : "0")).join("");
  const hiddenKeyPrevRef = useRef(hiddenKey);
  useEffect(() => {
    if (hiddenKeyPrevRef.current === hiddenKey) return;
    hiddenKeyPrevRef.current = hiddenKey;
    const u = uplotRef.current;
    if (!u) return;
    signals.forEach((s, i) => u.setSeries(i + 1, { show: !s.hidden }));
    // Falls back to a real fetch on its own when there is no cached
    // window yet (`resample` reads `currentRange()` through this flag).
    repaintFromCacheRef.current = true;
    void resampleRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKey]);

  // A changed manual bound re-normalises the data, and normalisation
  // only happens on a resample — so take the same proven path the
  // hidden-signal toggle above does: drop the fetch memo (an unchanged
  // request short-circuits before the normalise) and resample. One host
  // fetch per gesture, and it is what makes a *stopped* trace redraw at
  // the new bound instead of waiting for a tick that never comes.
  const yScaleKey = `${effectiveYScale?.min ?? ""}|${effectiveYScale?.max ?? ""}|${logActive ? "log" : ""}`;
  const yScaleKeyPrevRef = useRef(yScaleKey);
  useEffect(() => {
    if (yScaleKeyPrevRef.current === yScaleKey) return;
    yScaleKeyPrevRef.current = yScaleKey;
    resetRange();
    void resampleRef.current();
  }, [yScaleKey, resetRange]);

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
   * otherwise fall through to numeric, at the precision and radix that
   * signal's DBC implies. The raw is shown rounded — enum codes are
   * integers. `v` comes from `seriesRef`, which holds
   * the un-normalised series, so this matches the code the lane tile
   * labels (the tile inverts its lane normalisation to get there). */
  const formatValueFor = (key: string, v: number | null): string => {
    if (v == null || !Number.isFinite(v)) return "—";
    const table = valueTables.get(key);
    if (table) {
      const raw = Math.round(v);
      const label = table.find((r) => r.raw === raw)?.label;
      if (label) return `${label} (${raw})`;
    }
    return fmtVal(v, valueFormats.get(key));
  };
  // A collapsed axis renders no canvas, so uPlot never constructs here
  // and this row is a hole in the panel's pointer surface: the wheel
  // does nothing and the shared crosshair blanks out as the pointer
  // crosses it. Replay the gesture on a live plot's own surface — every
  // axis shares one x window and one canvas column, so the same
  // `clientX` there is the gesture the user meant.
  //
  // Two things deliberately don't carry over, because the strip has no
  // y scale to interpret them against: ⌘/ctrl + wheel (y zoom) lands on
  // the borrowed axis, and in "y" cursor mode the press isn't forwarded
  // at all rather than dropping H1/H2 at a meaningless value.
  useEffect(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const replay = (e: Event) => {
      const over = plotSurface();
      if (!over) return;
      const m = e as MouseEvent;
      if (e.type !== "wheel" && e.type !== "mousemove" && liveRef.current.cursorMode === "y") return;
      if (e.type === "wheel" || e.type === "contextmenu") e.preventDefault();
      const r = over.getBoundingClientRect();
      const init: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        clientX: m.clientX,
        // Nothing here maps to a y value; aim at the borrowed plot's
        // middle so the replayed press lands inside its box.
        clientY: r.top + r.height / 2,
        button: m.button,
        buttons: m.buttons,
        shiftKey: m.shiftKey,
        ctrlKey: m.ctrlKey,
        metaKey: m.metaKey,
      };
      over.dispatchEvent(
        e.type === "wheel"
          ? new WheelEvent("wheel", { ...init, deltaX: (e as WheelEvent).deltaX, deltaY: (e as WheelEvent).deltaY })
          : new MouseEvent(e.type, init),
      );
    };
    const types = ["wheel", "mousemove", "mouseleave", "mousedown", "contextmenu"];
    for (const t of types) el.addEventListener(t, replay, { passive: false });
    return () => {
      for (const t of types) el.removeEventListener(t, replay);
    };
  }, [collapsed, plotSurface]);

  /** The row's message line: the signal's DBC ancestry, `bus · ecu ·
   * message` — the same hierarchy the picker groups by. */
  const messageLabelFor = (s: SignalRef): string =>
    signalRowLabel(
      s.busId == null ? null : busNameLookup.get(s.busId) ?? s.busId,
      ecuLookup.get(messageEcuKey(s.busId, s.messageId, s.extended)),
      s.messageName,
    );
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
      className={`plot-area${focused ? " focused" : ""}${collapsed ? " collapsed" : ""}`}
      data-area-id={areaId}
      style={flexGrow == null ? undefined : { flexGrow }}
      onMouseDown={onFocus}
      onDragOver={(e) => {
        areaDragOver(e);
        signalDragOver(e, false);
      }}
      onDrop={(e) => {
        if (areaDrop(e, onDropArea)) return;
        signalDrop(e, {
          beforeKey: null,
          stopEvent: false,
          panelElementId,
          onDropSignal,
          onDropPatterns: appendPatterns,
        });
      }}
    >
      <div
        className="plot-area-canvas"
        ref={canvasRef}
        onContextMenu={(e) => {
          // Only on the y-axis gutter: inside the plot box uPlot owns
          // the right button (box zoom / cursor B), and the event
          // bubbles here from its overlay. The gutter is the strip
          // left of the box, whose width the axis reports.
          if (!yScaleSettable) return;
          if (e.clientX - e.currentTarget.getBoundingClientRect().left > gutterPx) return;
          e.preventDefault();
          e.stopPropagation();
          setAxisMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {axisMenu && (
        <YAxisScaleMenu
          position={axisMenu}
          scale={effectiveYScale}
          onSet={onSetYScale}
          onClose={() => setAxisMenu(null)}
        />
      )}
      {selectionMenu && (
        <SignalSelectionMenu
          position={selectionMenu}
          onHide={() => onSetSelectionHidden(true)}
          onShow={() => onSetSelectionHidden(false)}
          onSortArea={onSortArea}
          onClose={() => setSelectionMenu(null)}
        />
      )}
      {collapsed && (
        <div className="plot-area-placeholder" ref={placeholderRef}>
          {collapsedRunHead && (
            // One handle per contiguous run of collapsed axes, on the
            // run's first axis (ADR 0026). It drags this axis's parent
            // area, the same payload the head grip carries — a
            // collapsed area has to stay reorderable, and the empty
            // canvas column is the obvious thing to grab. A drop lands
            // on whichever area's row it was released over, so
            // targeting a specific area inside a run means dropping on
            // that area's own side-panel strip.
            <div
              className="plot-area-collapsed-handle"
              aria-label="reorder collapsed plot area"
              title="drag to reorder this plot area, or to move it to another plot panel (Ctrl to copy)"
              draggable
              onDragStart={(e) => onDragArea(e.dataTransfer)}
            />
          )}
        </div>
      )}
      {buildingFirstSample && !collapsed && (
        // Overlaid on the canvas column rather than placed in the flow,
        // so nothing moves when it clears. The side panel keeps its own
        // width, hence the inline `right`.
        <div
          className="plot-area-building"
          role="status"
          style={{ right: `${signalsWidth}px` }}
          title="building this signal set's decimation cache — the host is decoding this signal's history and the plot paints as points arrive"
        >
          <span className="plot-area-building-bar" aria-hidden="true" />
          <span>building…</span>
        </div>
      )}
      {logEmptySignals !== "" && !collapsed && (
        // A log axis cannot render zero or negatives, and those points
        // are dropped rather than clamped — so a series with nothing
        // positive in it draws nothing at all. Say which one, rather
        // than leaving a silently empty axis (ADR 0026).
        <div
          className="plot-area-note"
          role="status"
          style={{ right: `${signalsWidth}px` }}
          title="a log axis cannot show zero or negative values, and non-positive samples are dropped rather than clamped"
        >
          {logEmptySignals}: no positive values to plot on a log axis
        </div>
      )}
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
          undoGesture.begin();
          const onMove = (ev: MouseEvent) => {
            // Side panel is right of the canvas, so dragging left
            // *widens* the side panel: width = startWidth - delta.
            onResizeSignalsWidth(startWidth - (ev.clientX - startX));
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            undoGesture.end();
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      />
      <div className="plot-area-signals" style={{ flexBasis: `${signalsWidth}px` }}>
        <div className="plot-area-signals-head">
          {isParentHead && (
            // The grip alone is draggable, not the whole head: the head
            // holds a combobox and buttons, and a draggable ancestor
            // eats their pointer gestures. It renders on a single-area
            // panel too — there is nothing to reorder there, but the
            // area can still be dragged to another plot panel.
            <span
              className="plot-area-grip"
              aria-label="reorder plot area"
              title="drag to reorder this plot area, or to move it to another plot panel (Ctrl to copy)"
              draggable
              onDragStart={(e) => onDragArea(e.dataTransfer)}
            >
              ⠿
            </span>
          )}
          {isParentHead && (
            // One collapse state per logical area (ADR 0026), so the
            // toggle renders on the parent head only — however many
            // derived axes that area stacks. An area whose signals are
            // all hidden collapses on its own and has no expanded form
            // to go to (there is nothing to draw), so the toggle is
            // inert there and says why.
            <button
              className="plot-area-collapse"
              aria-label={collapsed ? "expand plot area" : "collapse plot area"}
              aria-expanded={!collapsed}
              disabled={!!collapsed && area.collapsed !== true}
              title={
                !!collapsed && area.collapsed !== true
                  ? collapsedBySolo
                    ? "no signal on this area matches the solo pattern — clear solo to expand it"
                    : "every signal on this area is hidden — un-hide one to expand it"
                  : collapsed
                    ? "expand this plot area"
                    : "collapse this plot area — it gives up its plot height, its rows stay listed"
              }
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapsed();
              }}
            >
              {collapsed ? "▸" : "▾"}
            </button>
          )}
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
          {soloChip && (
            <span
              className="plot-solo-chip"
              title="how many of this area's series the solo pattern matches"
            >
              {soloChip.matched} of {soloChip.total} match
            </span>
          )}
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
                !area.patterns?.length
                  ? "add signals by regex pattern (bus/ecu/message/signal)"
                  : "edit the patterns adding signals to this area"
              }
              onClick={(e) => {
                e.stopPropagation();
                setFilterEditOpen((v) => !v);
              }}
            >
              {!area.patterns?.length ? "patterns…" : `patterns (${area.patterns.length}) ✎`}
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
        {!filterEditOpen && (area.patterns?.length ?? 0) > 0 && (
          <div className="plot-area-filter-status" title="pattern-defined series (ADR 0020 / ADR 0038)">
            {patternResolutions.map((res) => (
              <span className="plot-area-filter-regex" key={res.pattern} title={res.pattern}>
                /{res.pattern}/{" "}
                <span className={res.valid ? "plot-area-filter-count" : "plot-area-filter-error"}>
                  {res.valid ? res.matches.length : "bad regex"}
                </span>
              </span>
            ))}
            <button
              className="plot-area-filter-promote"
              title="convert to manual: keep the matched signals as explicit picks and clear the patterns (one-way)"
              onClick={(e) => {
                e.stopPropagation();
                onMaterializePatterns();
              }}
            >
              ⇨ manual
            </button>
            <button
              className="plot-area-filter-clear"
              title="discard the patterns (manual picks stay)"
              onClick={(e) => {
                e.stopPropagation();
                onSetPatterns(undefined);
              }}
            >
              ×
            </button>
          </div>
        )}
        {filterEditOpen && (
          <div onClick={(e) => e.stopPropagation()}>
            <SignalPatternEditor
              patterns={area.patterns ?? []}
              catalog={catalog}
              busNames={busNameLookup}
              onChange={(ps) => onSetPatterns(ps.length ? ps : undefined)}
              onMaterialize={() => {
                onMaterializePatterns();
                setFilterEditOpen(false);
              }}
            />
          </div>
        )}
        {(cursorYh1 != null || cursorYh2 != null) && (
          <div className="plot-area-ycursors">
            <span className="gold">H1 {fmtVal(cursorYh1)}</span>
            <span className="pink">H2 {fmtVal(cursorYh2)}</span>
            <span>ΔH {fmtVal(dh)}</span>
          </div>
        )}
        {signals.length === 0 ? (
          <div className="plot-area-empty">drag a signal here, or add a pattern above</div>
        ) : (
          signals.map((s) => {
            const key = signalRefKey(s);
            const v = displayValueFor(key);
            const isPrimary = key === primaryKey;
            const isSelected = selectedKeys.has(key);
            const isSoloMasked = !!soloMaskedKeys?.has(key);
            return (
              <div
                className={`plot-signal-row${s.hidden ? " hidden" : ""}${isSoloMasked ? " solo-masked" : ""}${isPrimary ? " primary" : ""}${isSelected ? " selected" : ""}`}
                key={key}
                title={
                  isPrimary
                    ? "primary signal (drives the y-axis units) · ctrl-click / shift-click to select several"
                    : "click to select this signal and make it this area's primary · ctrl-click / shift-click to select several"
                }
                onClick={(e) => {
                  // Don't act on a click that originated on the
                  // swatch / value / remove button — those have their
                  // own handlers (`stopPropagation`).
                  if (e.defaultPrevented) return;
                  const mod = e.ctrlKey || e.metaKey;
                  onSelectSignal(key, { mod, shift: e.shiftKey });
                  // A plain click is today's promote gesture plus the
                  // highlight; the modified chords only build the
                  // selection, leaving the primary where it is.
                  if (!mod && !e.shiftKey) onSetPrimarySignal(key);
                }}
                onContextMenu={(e) => {
                  // The swatch's own context-menu handler (color
                  // picker) stops propagation, so this never fires for
                  // a right-click aimed at it.
                  if (e.defaultPrevented) return;
                  e.preventDefault();
                  e.stopPropagation();
                  // Platform norm: right-click on a row outside the
                  // selection replaces the selection with just that
                  // row before showing its menu (Explorer / Finder /
                  // VS Code); right-click on a row already in the
                  // selection acts on the whole thing. A drag has no
                  // such moment to visibly repoint the selection to
                  // (DatabasePanel's precedent leaves it alone, see the
                  // drag handler below), but a context menu inherently
                  // asks "what does this apply to" and needs an
                  // unambiguous, on-screen answer.
                  if (!isSelected) onSelectSignal(key, { mod: false, shift: false });
                  setSelectionMenu({ x: e.clientX, y: e.clientY });
                }}
                draggable
                onDragStart={(e) => {
                  // A grab that lands on a row already in the
                  // selection drags the whole selection (DatabasePanel
                  // precedent, ADR 0045); the panel resolves it from
                  // the parent area's full effective signal list, since
                  // this axis may hold only part of it (per-unit /
                  // individual mode). Otherwise, drag just this row —
                  // and leave the selection exactly as it is, matching
                  // DatabasePanel: "the panel's visible selection is
                  // unchanged so the user can keep it".
                  if (isSelected) {
                    onDragSelection(e.dataTransfer);
                    return;
                  }
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
                onDragOver={(e) => signalDragOver(e, true)}
                onDrop={(e) =>
                  signalDrop(e, {
                    beforeKey: key,
                    stopEvent: true,
                    panelElementId,
                    onDropSignal,
                    onDropPatterns: appendPatterns,
                  })
                }
              >
                <SignalSwatch
                  hidden={!!s.hidden}
                  color={seriesColor(s)}
                  onToggleHidden={() => onToggleHidden(s)}
                  onPickColor={(c) => onSetSignalColor(s, c)}
                />
                <div className="plot-signal-text">
                  <span
                    className="plot-signal-name"
                    title={`${s.messageName}.${s.signalName} — drag to another plot area`}
                  >
                    {s.signalName}
                  </span>
                  <span className="plot-signal-message" title={messageLabelFor(s)}>
                    {s.busId ? (
                      <>
                        <span
                          className="plot-bus-swatch"
                          style={{ background: busColorLookup.get(s.busId) ?? theme().busUnknown }}
                          aria-hidden="true"
                        />
                        {messageLabelFor(s)}
                      </>
                    ) : (
                      messageLabelFor(s)
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
                      {/* A difference, not a reading — the plain float
                        * rule, as in the measurement strip. */}
                      Δ {fmtVal(deltaAbFor(key))}
                      {!isEnumValueTable(valueTables.get(key)) && s.unit ? ` ${s.unit}` : ""}
                    </small>
                  )}
                </div>
                {manualKeys.has(key) ? (
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
                ) : (
                  <span
                    className="plot-signal-pattern-badge"
                    title="added by a pattern — edit the area's patterns to remove, or drag/recolor to pin it as a manual pick"
                  >
                    ◇
                  </span>
                )}
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
});
