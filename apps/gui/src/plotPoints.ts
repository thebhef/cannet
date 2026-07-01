// Show-points tri-state and its mapping to uPlot's per-series `points`
// spec. Extracted from PlotPanel so the density-thinning filter — the
// part with real logic — is unit-testable without a canvas. The cursor
// maths live in `plotCursors.ts` under the same convention.

import type uPlot from "uplot";

/** Show-points tri-state — applies to every series on every axis of
 * every plot area in the panel. `auto` defers to uPlot's density-aware
 * default, which only draws points when there's room between samples;
 * `off` forces no points; `on` forces points always (thinned — see
 * [`showPointsToUplot`]). See task 15 / ADR 0026. */
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
 * - `on` → `show: true` plus a thinning `filter` that caps the drawn
 *   markers to [`MAX_POINT_MARKERS`] across the visible range. Without it,
 *   "always show" draws a marker on every decimated sample, so a wide /
 *   zoomed-out window pays for thousands of overlapping markers per
 *   redraw — the perf cliff this guards. At or below the cap the filter is
 *   a no-op (every in-view point is marked). */
export function showPointsToUplot(mode: ShowPointsMode): uPlot.Series.Points {
  if (mode === "off") return { show: false };
  if (mode === "on") return { show: true, filter: capPointMarkers };
  return {};
}

/** uPlot `points.filter` for the `on` mode: return the data indices to
 * mark, strided down to at most [`MAX_POINT_MARKERS`] across the visible
 * range, or `null` when the in-view points already fit that cap (uPlot
 * then marks them all). The visible index span comes from the series'
 * `idxs` (uPlot sets it each draw). The last in-view index is always kept
 * so the series end shows a marker. */
export function capPointMarkers(u: uPlot, seriesIdx: number): number[] | null {
  const idxs = u.series[seriesIdx]?.idxs;
  if (!idxs) return null;
  const [i0, i1] = idxs;
  if (i0 == null || i1 == null || i1 < i0) return null;
  const count = i1 - i0 + 1;
  if (count <= MAX_POINT_MARKERS) return null;
  const stride = Math.ceil(count / MAX_POINT_MARKERS);
  const out: number[] = [];
  for (let i = i0; i <= i1; i += stride) out.push(i);
  if (out[out.length - 1] !== i1) out.push(i1);
  return out;
}
