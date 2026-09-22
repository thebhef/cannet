// Show-points tri-state and its mapping to uPlot's per-series `points`
// spec. Extracted from PlotPanel so the marker-column filter — the part
// with real logic — is unit-testable without a canvas. The cursor maths
// live in `plotCursors.ts` under the same convention.

import type uPlot from "uplot";

/** Show-points tri-state — applies to every series on every axis of
 * every plot area in the panel. `auto` defers to uPlot's density-aware
 * default, which only draws points when there's room between samples;
 * `off` forces no points; `on` forces points at every served sample,
 * uncapped. See ADR 0026. */
export type ShowPointsMode = "auto" | "off" | "on";

/** Parse a persisted value back to the tri-state, defaulting to `auto`. */
export function showPointsFromRaw(v: unknown): ShowPointsMode {
  return v === "off" || v === "on" ? v : "auto";
}

/** Map the panel's tri-state to a uPlot `Series.points` spec.
 *
 * - `auto` → omit `show`, so uPlot's default density-aware filter draws
 *   points only when the sample-to-pixel ratio is low enough.
 * - `off` → `show: false`.
 * - `on` → `show: true`.
 *
 * *Which* columns get a marker is not decided here: every mode goes
 * through the one filter [`applySampleMarkerFilter`] installs on the
 * constructed instance, which marks the series' own samples and nothing
 * else. Two mechanisms deciding that is how a held column came to be
 * marked as if it were a reading.
 *
 * **A marker is a filled square, in every mode.** Two decisions, both
 * about the one cost uPlot never caches — `drawSeries` rebuilds the
 * marker path, and fills *and* strokes it, on every repaint of the
 * series layer:
 *
 * - `width: 0`, so the path builder hands back no stroke path at all and
 *   the second pass over every marker is skipped. The fill is then the
 *   series' own colour throughout, where uPlot's stroked marker defaults
 *   to a white middle.
 * - {@link squareMarkerPaths} in place of uPlot's arc builder, so a
 *   marker is one pixel-snapped `rect` rather than four anti-aliased
 *   Béziers, and the markers that would paint the same pixels twice are
 *   collapsed first. Same side as the disc's diameter — the disc's
 *   radius was `(size - width) / 2` and `width` is 0 here.
 *
 * The hover marker is untouched by both: it is one per series, drawn on
 * the overlay canvas, and stays a disc (ADR 0026). */
export function showPointsToUplot(mode: ShowPointsMode): uPlot.Series.Points {
  const shape = { width: 0, paths: squareMarkerPaths } as const;
  if (mode === "off") return { show: false, ...shape };
  if (mode === "on") return { show: true, ...shape };
  return { ...shape };
}

/** The show-points mode forced on every plot panel for this run, or
 * `null` when the launch asked for nothing (the ordinary case).
 *
 * Set once at boot from the `--show-points` launch flag (ADR 0031), so
 * a measurement run can pin the mode it is measuring without editing —
 * and so re-saving — the project it measures. Deliberately a module
 * flag rather than a panel prop or a persisted field: it is a property
 * of the *process*, it must reach every panel including ones restored
 * later, and it must never be written back. Same shape as `diag.ts`'s
 * own launch-time arming. */
let forcedShowPoints: ShowPointsMode | null = null;

/** Arm {@link showPointsOverride} from the launch flags. */
export function setShowPointsOverride(mode: ShowPointsMode | null): void {
  forcedShowPoints = mode;
}

/** The forced show-points mode for this run, or `null`. A panel reads
 * this at render and draws `override ?? its own state`, leaving the
 * state (and so what is persisted) untouched. */
export function showPointsOverride(): ShowPointsMode | null {
  return forcedShowPoints;
}

/** How few samples a series may hold and still keep its point markers
 * in `auto` mode, whatever the density of the axis it is drawn on.
 *
 * uPlot's automatic rule is about *drawn* density: it compares the
 * number of x columns in view against the room for markers, and every
 * series on an axis shares those columns. A series with only a handful
 * of samples of its own therefore loses its markers the moment it is
 * plotted beside a fast one — and a line drawn through a handful of
 * held values says nothing about where the samples actually are. Below
 * this count the samples *are* the information, so they stay marked.
 *
 * Deliberately small: at this count a series' markers are still
 * countable at a glance, and above it the line already carries the
 * shape. */
export const AUTO_POINT_MARKER_FLOOR = 32;

/** A uPlot series as far as the floor and the marker filter are
 * concerned. */
interface PointsHost {
  points?: { show?: uPlot.Series.Points["show"]; filter?: uPlot.Series.Points["filter"] };
}

/** Apply {@link AUTO_POINT_MARKER_FLOOR} to a live uPlot instance's
 * `series` (index 0 is x, and is skipped): a series holding at most
 * that many samples draws its markers; above it, uPlot's own
 * density-aware answer stands.
 *
 * Applied to the constructed instance rather than to the options
 * because the above-floor half *is* uPlot's default function, installed
 * during construction — wrapping it keeps that half exactly as uPlot
 * defines it, with no copy of its density rule here to drift. A series
 * whose `show` is not a function (the caller forced markers on or off)
 * is left alone.
 *
 * `sampleCount` is consulted per draw, not once: a series' length
 * changes with every fetch and the instance is not rebuilt for that. */
export function applyAutoPointFloor(
  series: readonly PointsHost[],
  sampleCount: (seriesIdx: number) => number,
): void {
  for (let i = 1; i < series.length; i++) {
    const points = series[i]?.points;
    const base = points?.show;
    if (!points || typeof base !== "function") continue;
    points.show = (u, seriesIdx, i0, i1, gaps) =>
      sampleCount(seriesIdx) <= AUTO_POINT_MARKER_FLOOR || base(u, seriesIdx, i0, i1, gaps) === true;
  }
}

/**
 * Which of a series' **own sample columns** get a marker drawn at them.
 *
 * A marker says "there was a reading here", so it may only ever sit on a
 * column the series has a sample at — `sampleColumns` in `plotData.ts`,
 * which reads the series' raw timestamps rather than anything the merge
 * materialized. Everything else in a merged row is sample-and-hold: the
 * columns a denser neighbour contributed, the stretch past a stopped
 * series' last frame, the interior of a stall, the whole grid a
 * one-sample hline is drawn across. Marking those claims samples that do
 * not exist, and claims them most densely exactly where the plot has the
 * least data (ADR 0026).
 *
 * The extrapolated stretches need no separate exclusion here, and are
 * deliberately not consulted: a stretch is extrapolation *because* the
 * series has no sample in it, so a stretch's interior has no column to
 * offer. Its two ends do — a stall is bounded by readings, and the last
 * frame before a series stopped is a reading — and those keep their
 * markers, which is what makes the dashed stretch beside them legible.
 *
 * `columns` is ascending and indexes `xs`; the result is every one of
 * them inside the visible `[from, to]`, with nothing thinned away.
 *
 * **Every served sample is marked, and there is no cap.** There used to
 * be one — a flat 500 markers across the visible range, strided
 * uniformly — and it was the reason `Points: On` looked like
 * extrapolation: an even stride over a min/max envelope aliases onto one
 * leg of it, so a run of dots hugged one side of a line that was
 * oscillating through both, and most extrema carried no dot at all. The
 * markers were on the line; the wrong ones were being chosen.
 *
 * The serve bounds this to a few points per canvas pixel column — but
 * it bounds the *count*, not the cost. uPlot caches a series' line path
 * and nothing else, so this function and the arc path built from its
 * answer are re-run on **every repaint** of the series layer. That is
 * why the panel's hover chrome draws on its own overlay canvas instead
 * of asking uPlot to redraw (ADR 0026), and why a marker is filled and
 * not stroked.
 */
export function sampleMarkerColumns(
  columns: readonly number[],
  xs: readonly number[],
  from: number,
  to: number,
): number[] {
  let i0 = 0;
  while (i0 < columns.length && xs[columns[i0]] < from) i0++;
  let i1 = columns.length - 1;
  while (i1 >= 0 && xs[columns[i1]] > to) i1--;
  if (i1 < i0) return [];
  const out: number[] = [];
  for (let i = i0; i <= i1; i++) out.push(columns[i]);
  return out;
}

/**
 * The single column a **hover** marker may sit on for one series: the
 * column nearest `hoverX` among the series' *own* sample columns, or
 * `null` when it has none at all.
 *
 * Hover changes *when* a marker is drawn, never *where* (ADR 0026), so
 * the candidates are the same {@link sampleMarkerColumns} draws from —
 * the series' raw timestamps, not the merged grid. That is the whole
 * difference from the per-series hover point this replaces, which snapped
 * to the nearest **merged** column and so landed on whatever a denser
 * neighbour happened to contribute, most often on a column this series
 * was merely held across.
 *
 * There is no proximity limit, deliberately: a series that stopped
 * arriving keeps its marker on its last reading while the pointer moves
 * on past it, which is the honest picture — the marker stays where the
 * data is, and the stretch between it and the pointer is already drawn as
 * extrapolation. A limit would instead make the marker blink out with no
 * statement about why.
 */
export function hoverMarkerColumn(
  columns: readonly number[],
  xs: readonly number[],
  hoverX: number,
): number | null {
  if (columns.length === 0 || !Number.isFinite(hoverX)) return null;
  let lo = 0;
  let hi = columns.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[columns[mid]] < hoverX) lo = mid + 1;
    else hi = mid;
  }
  const at = columns[lo];
  const before = lo > 0 ? columns[lo - 1] : at;
  return Math.abs(xs[at] - hoverX) <= Math.abs(xs[before] - hoverX) ? at : before;
}

/**
 * Install {@link sampleMarkerColumns} as the `points.filter` of every
 * series of a live uPlot instance (index 0 is x, and is skipped), so
 * uPlot's point layer draws markers only where the series has samples.
 *
 * Applied to the constructed instance rather than to the options for the
 * same reason {@link applyAutoPointFloor} is: `sampleColumns` changes
 * with every fetch and the instance is not rebuilt for that, so the
 * columns are read per draw through the callback.
 *
 * **`show` decides whether markers are drawn; this decides only which.**
 * uPlot draws the point layer when `show || idxs`, so an index list
 * returned while `show` is false would resurrect the markers the panel's
 * `off` mode — or the density rule under `auto` — just turned down.
 * Hence the early `null`: narrowing, never enabling.
 */
export function applySampleMarkerFilter(
  series: readonly PointsHost[],
  sampleColumns: (seriesIdx: number) => readonly number[],
): void {
  for (let i = 1; i < series.length; i++) {
    const points = series[i]?.points;
    if (!points) continue;
    points.filter = (u, seriesIdx, show) => {
      if (!show) return null;
      const xs = u.data[0] as number[] | undefined;
      if (!xs) return null;
      return sampleMarkerColumns(
        sampleColumns(seriesIdx),
        xs,
        u.scales.x?.min ?? -Infinity,
        u.scales.x?.max ?? Infinity,
      );
    };
  }
}

/**
 * Collapse a series' visible marker centres to the squares actually
 * worth painting, one device-pixel column at a time.
 *
 * `centres` is flat — `[x0, y0, x1, y1, …]` in device pixels, ascending
 * in x — and so is the result, which carries the **top-left corner** of
 * each square; the side is common to the series and is the caller's.
 * Flat both ways on purpose: a repaint of a wide canvas runs this over
 * thousands of markers per series, and a pair-per-marker shape would
 * allocate that many short-lived arrays every time.
 *
 * The serve hands a pixel column its first, last, min and max sample
 * (ADR 0026), so `Points: On` asks for up to four markers per column per
 * series. A held signal's four are the same pixel; a noisy one's first
 * and last usually land inside the marker its nearer extreme already
 * covers. So a marker whose square would overlap one already kept **in
 * the same column** is dropped: identical ink, one rect instead of four.
 *
 * Two things this is deliberately not:
 *
 * - **Not a stride and not a cap.** Both were tried (a flat 500 markers
 *   on an even index stride) and both leave a column's extreme bare,
 *   which is what made `Points: On` read as extrapolation. Every marker
 *   kept here still sits on a served sample, and a column's extremes are
 *   dropped only where another marker already paints the same pixels.
 * - **Not a collapse across columns.** Neighbouring columns whose
 *   extremes are a pixel apart do overlap as squares, and both draw. The
 *   column is the unit because it is the unit the serve decimates to;
 *   merging across columns would start deciding which readings survive.
 */
export function collapseMarkerSquares(centres: readonly number[], side: number): number[] {
  const out: number[] = [];
  const half = side / 2;
  // Tops kept for the column being collapsed. Reused across columns —
  // `kept` is the live length, so a new column costs no allocation.
  const keptTops: number[] = [];
  let kept = 0;
  let columnLeft = Number.NaN;
  for (let i = 0; i + 1 < centres.length; i += 2) {
    const left = Math.round(centres[i] - half);
    const top = Math.round(centres[i + 1] - half);
    if (left !== columnLeft) {
      columnLeft = left;
      kept = 0;
    }
    let covered = false;
    for (let k = 0; k < kept; k++) {
      if (Math.abs(top - keptTops[k]) < side) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    keptTops[kept++] = top;
    out.push(left, top);
  }
  return out;
}

/**
 * The `points.paths` every series draws its markers with: one `Path2D`
 * of axis-aligned squares, pixel-snapped, filled and never stroked.
 *
 * uPlot's own builder puts a `moveTo` plus an `arc` per marker into a
 * `Path2D` — four cubic Béziers each, flattened and anti-aliased when
 * the path is rasterized — and it does so on **every** repaint, because
 * `drawSeries` caches a series' line path and nothing else. On a wide
 * canvas with several plot areas that is six figures of arcs per data
 * repaint. A square is one `rect`, its four edges land on whole device
 * pixels, and {@link collapseMarkerSquares} first drops the markers that
 * would paint the same pixels twice.
 *
 * The shape is otherwise uPlot's: the same disc diameter (`points.size`
 * at the canvas pixel ratio — the disc's radius was `(size - width) / 2`
 * and `width` is 0 in every mode), the same clip inflated by one marker
 * so a marker on the plot box's edge is not clipped in half, a null
 * stroke path so `drawPath` skips the stroke pass, and the fill left to
 * the series (`points.fill`, which an enum lane sets to its own marker
 * ink). See ADR 0026.
 */
export function squareMarkerPaths(
  u: uPlot,
  seriesIdx: number,
  idx0: number,
  idx1: number,
  filtIdxs?: number[] | null,
): uPlot.Series.Points.Paths | null {
  const xs = u.data[0] as number[] | undefined;
  const ys = u.data[seriesIdx] as (number | null)[] | undefined;
  if (!xs || !ys) return null;
  const series = u.series[seriesIdx];
  const ratio = u.ctx.canvas.width / u.width || 1;
  const side = Math.max(1, Math.round((series.points?.size ?? 0) * ratio));
  const xKey = u.series[0].scale ?? "x";
  const yKey = series.scale ?? "y";
  const centres: number[] = [];
  const place = (i: number): void => {
    const v = ys[i];
    if (v == null) return;
    centres.push(u.valToPos(xs[i], xKey, true), u.valToPos(v, yKey, true));
  };
  if (filtIdxs) for (const i of filtIdxs) place(i);
  else for (let i = idx0; i <= idx1; i++) place(i);

  const fill = new Path2D();
  const squares = collapseMarkerSquares(centres, side);
  for (let i = 0; i + 1 < squares.length; i += 2) fill.rect(squares[i], squares[i + 1], side, side);

  const { left, top, width, height } = u.bbox;
  const clip = new Path2D();
  clip.rect(left - side, top - side, width + side * 2, height + side * 2);

  // uPlot's own points builder returns these two band-clip flags. They
  // are inert for a point layer — `drawPath` hands a points path
  // straight to `strokeFill` with no band clip — but carrying the same
  // value keeps this a drop-in for it.
  return { stroke: null, fill, clip, flags: 0b11 };
}
