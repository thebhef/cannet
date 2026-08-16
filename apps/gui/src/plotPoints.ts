// Show-points tri-state and its mapping to uPlot's per-series `points`
// spec. Extracted from PlotPanel so the density-thinning filter — the
// part with real logic — is unit-testable without a canvas. The cursor
// maths live in `plotCursors.ts` under the same convention.

import type uPlot from "uplot";

/** Show-points tri-state — applies to every series on every axis of
 * every plot area in the panel. `auto` defers to uPlot's density-aware
 * default, which only draws points when there's room between samples;
 * `off` forces no points; `on` forces points always (thinned — see
 * [`showPointsToUplot`]). See ADR 0026. */
export type ShowPointsMode = "auto" | "off" | "on";

/** Parse a persisted value back to the tri-state, defaulting to `auto`. */
export function showPointsFromRaw(v: unknown): ShowPointsMode {
  return v === "off" || v === "on" ? v : "auto";
}

/** Hard cap on the number of point-markers `on` mode draws across the
 * visible range — a flat maximum, independent of canvas width. Markers
 * denser than this just cost draw time (a min/max envelope already carries
 * the shape), so a zoomed-out window is bounded to this many overlapping
 * dots per series instead of one per decimated sample. The single tuning
 * knob for point-marker cost. */
export const MAX_POINT_MARKERS = 500;

/** Map the panel's tri-state to a uPlot `Series.points` spec.
 *
 * - `auto` → omit `show`, so uPlot's default density-aware filter draws
 *   points only when the sample-to-pixel ratio is low enough.
 * - `off` → `show: false`.
 * - `on` → `show: true`.
 *
 * *Which* columns get a marker is not decided here: every mode goes
 * through the one filter [`applySampleMarkerFilter`] installs on the
 * constructed instance, which marks the series' own samples and thins
 * them to [`MAX_POINT_MARKERS`]. Two mechanisms deciding that is how a
 * held column came to be marked as if it were a reading. */
export function showPointsToUplot(mode: ShowPointsMode): uPlot.Series.Points {
  if (mode === "off") return { show: false };
  if (mode === "on") return { show: true };
  return {};
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
 * shape. It is also a rounding error against [`MAX_POINT_MARKERS`], so
 * the floor can never be the reason a redraw is expensive. */
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
 * `columns` is ascending and indexes `xs`; the result is a subset of it,
 * limited to the visible `[from, to]` and strided down to `max` because a
 * marker per sample costs the same in a zoomed-out window as it ever did.
 * The last in-view sample is always kept, so a series' newest reading is
 * always marked.
 */
export function sampleMarkerColumns(
  columns: readonly number[],
  xs: readonly number[],
  from: number,
  to: number,
  max = MAX_POINT_MARKERS,
): number[] {
  let i0 = 0;
  while (i0 < columns.length && xs[columns[i0]] < from) i0++;
  let i1 = columns.length - 1;
  while (i1 >= 0 && xs[columns[i1]] > to) i1--;
  if (i1 < i0) return [];
  const count = i1 - i0 + 1;
  const stride = Math.max(1, Math.ceil(count / Math.max(1, max)));
  const out: number[] = [];
  for (let i = i0; i <= i1; i += stride) out.push(columns[i]);
  if (out[out.length - 1] !== columns[i1]) out.push(columns[i1]);
  return out;
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
 *
 * It also carries the [`MAX_POINT_MARKERS`] cap that the `on` mode used
 * to install for itself, so a zoomed-out window still pays for a bounded
 * number of overlapping markers per series.
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
