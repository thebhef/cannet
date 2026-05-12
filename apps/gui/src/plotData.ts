// Pure helpers for the plot panel: merging independently-sampled signal
// series onto one shared time axis for uPlot.
//
// CAN signals are sampled at frame arrival times, so two signals on
// different messages almost never share timestamps. uPlot wants one x
// array with a parallel y array per series, so we build the sorted union
// of every series' timestamps and, for each series, carry the most
// recent value forward (sample-and-hold) — `null` before the series'
// first sample so uPlot leaves a gap rather than drawing from zero.

export interface RawSeries {
  /** Strictly-increasing sample times (seconds). */
  t: number[];
  /** Parallel sampled values. */
  v: number[];
}

/**
 * Merge `series` into uPlot's `[xs, ...ys]` shape. `xs` is the sorted
 * union of every series' timestamps; `ys[k][i]` is series `k`'s
 * sample-and-hold value at `xs[i]`, or `null` before its first sample.
 *
 * With no series, returns `[[]]` — a valid empty uPlot data set.
 */
export function mergeSeries(series: RawSeries[]): (number | null)[][] {
  const xsSet = new Set<number>();
  for (const s of series) {
    for (const t of s.t) xsSet.add(t);
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const out: (number | null)[][] = [xs];
  for (const s of series) {
    const ys: (number | null)[] = new Array(xs.length).fill(null);
    let j = 0;
    let last: number | null = null;
    for (let i = 0; i < xs.length; i++) {
      while (j < s.t.length && s.t[j] <= xs[i]) {
        last = s.v[j];
        j++;
      }
      ys[i] = last;
    }
    out.push(ys);
  }
  return out;
}

/** Stable key for a `(message, signal)` pair. */
export function signalKey(messageId: number, extended: boolean, signalName: string): string {
  return `${extended ? "x" : "s"}:${messageId}:${signalName}`;
}
