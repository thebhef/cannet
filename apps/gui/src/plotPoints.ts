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
 * **`width: 0` in every mode — a marker is a filled disc, not a ring.**
 * uPlot builds one `Path2D` of arcs per repaint and then fills *and*
 * strokes it; at `width: 0` the path builder hands back no stroke path
 * at all, so the second pass over every marker is skipped. The drawn
 * size is unchanged: the radius is `(size - width) / 2`, so dropping a
 * 1 px stroke that was centred on the arc grows the disc by exactly the
 * half-width that stroke used to cover. What changes is the middle —
 * uPlot's stroked marker defaults to a white fill, and an unstroked one
 * takes the series' own colour throughout. */
export function showPointsToUplot(mode: ShowPointsMode): uPlot.Series.Points {
  if (mode === "off") return { show: false, width: 0 };
  if (mode === "on") return { show: true, width: 0 };
  return { width: 0 };
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
