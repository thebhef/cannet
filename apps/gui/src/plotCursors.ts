// Pure helpers for the plot panel's cursors and measurement strip.
//
// A sampled signal series here is `{ t, v }` with `t` non-decreasing
// (display-relative seconds) — not strictly increasing: the host's
// signal cache guarantees non-decreasing order only (see plotData.ts's
// `RawSeries.t`), so two samples can share a `t` when two frames land on
// the same hardware timestamp tick. Every walk below treats a tie as
// "at or before" / "at or after" rather than assuming each `t` is
// unique. "Value at x" is sample-and-hold — the most recent sample at
// or before x — matching how the plot draws CAN signals; outside the
// series' range it's `null`.

export interface Series {
  /** Non-decreasing sample times (display-relative seconds); see the
   * module doc — ties are real input, not a malformed fixture. */
  t: number[];
  /** Parallel values. */
  v: number[];
}

/**
 * Index of the last sample whose time is `<= x`, or `-1` if every
 * sample is after `x` (or the series is empty). Binary search. Under a
 * tie at `x` this is the *last* of the tied indices — the most recent
 * of them, which is the right answer for sample-and-hold.
 */
export function indexAtOrBefore(t: readonly number[], x: number): number {
  let lo = 0;
  let hi = t.length - 1;
  if (hi < 0 || t[0] > x) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Index of the first sample whose time is `>= x`, or `t.length` if
 * every sample is before `x` (or the series is empty). Binary search —
 * the complement of {@link indexAtOrBefore}: under a tie at `x` this is
 * the *first* of the tied indices, so a walk starting here sees every
 * one of them rather than only the last.
 */
function indexAtOrAfter(t: readonly number[], x: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sample-and-hold value of `s` at time `x`, or `null` if before the
 * series' first sample (or the series is empty). */
export function valueAt(s: Series, x: number): number | null {
  const i = indexAtOrBefore(s.t, x);
  return i < 0 ? null : s.v[i];
}

export interface SpanStats {
  /** Number of samples in `[a, b]` (inclusive of the endpoints' nearest
   * samples — see below). 0 if the span is empty / outside the data. */
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
}

/**
 * Min / max / mean of `s` over the closed time span `[lo, hi]` (the
 * arguments are sorted, so order doesn't matter). Counts the samples
 * with `lo <= t <= hi`. All-`null` stats with `count = 0` when the span
 * contains no samples.
 */
export function statsOver(s: Series, a: number, b: number): SpanStats {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let count = 0;
  let mn = Infinity;
  let mx = -Infinity;
  let sum = 0;
  // Walk from the first sample >= lo, found directly rather than
  // derived from indexAtOrBefore(lo) + 1: when a sample sits exactly on
  // `lo` and is tied with an earlier one at the same time, the "last
  // <= lo" index skips straight past that earlier tie, undercounting
  // the span. indexAtOrAfter lands on the *first* of any such tie.
  for (let i = indexAtOrAfter(s.t, lo); i < s.t.length; i++) {
    const t = s.t[i];
    if (t > hi) break;
    const val = s.v[i];
    count += 1;
    if (val < mn) mn = val;
    if (val > mx) mx = val;
    sum += val;
  }
  if (count === 0) return { count: 0, min: null, max: null, mean: null };
  return { count, min: mn, max: mx, mean: sum / count };
}

/** The measurement quantities a plot panel can show in its readout
 * strip. The first four are cursor-derived scalars; the rest are
 * per-trace and repeat for every plotted signal. */
export const MEASUREMENT_QUANTITIES = [
  { key: "a", label: "A (t)", perTrace: false },
  { key: "b", label: "B (t)", perTrace: false },
  { key: "dt", label: "Δt", perTrace: false },
  { key: "freq", label: "1/Δt", perTrace: false },
  { key: "valA", label: "value @ A", perTrace: true },
  { key: "valB", label: "value @ B", perTrace: true },
  { key: "delta", label: "Δ (B−A)", perTrace: true },
  { key: "min", label: "min [A,B]", perTrace: true },
  { key: "max", label: "max [A,B]", perTrace: true },
  { key: "mean", label: "mean [A,B]", perTrace: true },
] as const;

export type MeasurementKey = (typeof MEASUREMENT_QUANTITIES)[number]["key"];

/** Default selection: the cursor scalars plus value-at-cursor. */
export const DEFAULT_MEASUREMENTS: MeasurementKey[] = ["a", "b", "dt", "freq", "valA", "valB", "delta"];

export function isMeasurementKey(k: unknown): k is MeasurementKey {
  return typeof k === "string" && MEASUREMENT_QUANTITIES.some((q) => q.key === k);
}

/** The plot panel's shared mouse-crosshair position: one x value (panel
 * time domain) plus the plot area that produced it (the "owner"). */
export interface PanelHover {
  /** Id of the plot area the pointer is over. */
  areaId: string;
  /** Crosshair x in the panel's time domain (display-relative seconds). */
  x: number;
}

/**
 * Fold one area's cursor report into the panel-level hover state. A
 * report with an `x` takes the hover (that area becomes the owner); a
 * clear (`x == null`) only applies when it comes from the owner —
 * uPlot fires a cursor reset from *every* area on `setData`, and a
 * non-hovered area's reset must not clobber the hover the pointer is
 * still holding elsewhere.
 */
export function nextHover(prev: PanelHover | null, areaId: string, x: number | null): PanelHover | null {
  if (x != null) return { areaId, x };
  return prev && prev.areaId !== areaId ? prev : null;
}

/**
 * The new `[min, max]` x-window for a "goto" jump centred on `t`.
 * Preserves the current window's width when it's set and positive
 * (so a goto keeps the user's current zoom); falls back to
 * `defaultWidth` otherwise. The left edge is clamped to `>= 0` —
 * the trace timeline starts at 0 and a negative `min` would render
 * empty space before T0.
 */
export function centerWindowOn(
  t: number,
  current: { min: number | null; max: number | null },
  defaultWidth: number,
): [number, number] {
  const width =
    current.min != null && current.max != null && current.max > current.min
      ? current.max - current.min
      : defaultWidth;
  const min = Math.max(0, t - width / 2);
  return [min, min + width];
}
