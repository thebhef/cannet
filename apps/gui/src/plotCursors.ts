// Pure helpers for the plot panel's cursors and measurement strip.
//
// A sampled signal series here is `{ t, v }` with `t` strictly
// increasing (display-relative seconds). "Value at x" is sample-and-hold
// — the most recent sample at or before x — matching how the plot draws
// CAN signals; outside the series' range it's `null`.

export interface Series {
  /** Strictly-increasing sample times (display-relative seconds). */
  t: number[];
  /** Parallel values. */
  v: number[];
}

/**
 * Index of the last sample whose time is `<= x`, or `-1` if every
 * sample is after `x` (or the series is empty). Binary search.
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
  // Walk from the first sample >= lo. (indexAtOrBefore(lo) is the last
  // <= lo; +1 lands on the first >= lo, give or take an exact hit.)
  let i = indexAtOrBefore(s.t, lo);
  if (i < 0) i = 0;
  else if (s.t[i] < lo) i += 1;
  for (; i < s.t.length; i++) {
    const t = s.t[i];
    if (t > hi) break;
    if (t < lo) continue;
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
