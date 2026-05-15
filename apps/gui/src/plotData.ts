// Pure helpers for the plot panel: merging independently-sampled signal
// series onto one shared time axis for uPlot.
//
// CAN signals are sampled at frame arrival times, so two signals on
// different messages almost never share timestamps. uPlot wants one x
// array with a parallel y array per series, so we build the sorted union
// of every series' timestamps and, for each series, carry the most
// recent value forward (sample-and-hold) — `null` before the series'
// first sample so uPlot leaves a gap rather than drawing from zero.

import type { SignalsSample } from "./types";

/** Magic bytes at the start of a `sample_signals` binary response —
 * `"SIGSAMP\x02"` little-endian. The trailing version byte lets us
 * tweak the layout without breaking older builds outright; v2 adds the
 * per-signal `value_lo` / `value_hi` running extrema. */
const SIGSAMP_MAGIC = [0x53, 0x49, 0x47, 0x53, 0x41, 0x4d, 0x50, 0x02];

/**
 * Decode the compact binary `SignalsSample` produced by the Rust host's
 * `sample_signals` command (see `encode_signals_sample`). Returns the
 * same shape as the previous JSON representation; the win is in *not*
 * paying for JSON-encoding `Vec<f64>` arrays into base-10 text on the
 * host and `JSON.parse`-ing them back on the JS side — at 10 panels ×
 * several signals × thousands of points the JSON path was 100-200 ms of
 * every plot-tick wall clock.
 *
 * Layout — little-endian throughout:
 * ```
 *   magic   "SIGSAMP\x02"   8 bytes
 *   from_s  f64             window first ts (NaN ⇒ null)
 *   last_s  f64             window last ts  (NaN ⇒ null)
 *   slice   f64             host diagnostic: lock-held slice ms
 *   decode  f64             host diagnostic: decode + decimate ms
 *   nsig    u32             number of signals
 *   per signal:
 *     lo    f64             running min across all samples (NaN ⇒ null)
 *     hi    f64             running max across all samples (NaN ⇒ null)
 *     n     u32             sample count
 *     t[n]  f64×n           timestamps (absolute seconds)
 *     v[n]  f64×n           values
 * ```
 */
export function decodeSignalsSample(buf: ArrayBuffer): SignalsSample {
  const view = new DataView(buf);
  const magicView = new Uint8Array(buf, 0, 8);
  for (let i = 0; i < 8; i++) {
    if (magicView[i] !== SIGSAMP_MAGIC[i]) {
      throw new Error("sample_signals: bad magic in binary response");
    }
  }
  let off = 8;
  const fromS = view.getFloat64(off, true);
  off += 8;
  const lastS = view.getFloat64(off, true);
  off += 8;
  const sliceMs = view.getFloat64(off, true);
  off += 8;
  const decodeMs = view.getFloat64(off, true);
  off += 8;
  const nsig = view.getUint32(off, true);
  off += 4;
  const series: { t: number[]; v: number[]; value_lo: number | null; value_hi: number | null }[] = new Array(nsig);
  for (let s = 0; s < nsig; s++) {
    const lo = view.getFloat64(off, true);
    off += 8;
    const hi = view.getFloat64(off, true);
    off += 8;
    const n = view.getUint32(off, true);
    off += 4;
    // The f64 arrays may sit at offsets that aren't 8-aligned within
    // `buf` (the `u32` lens are 4-aligned), so `new Float64Array(buf,
    // off, n)` can throw. Slice to a fresh aligned buffer first; the
    // copy is bulk-memcpy and still much cheaper than JSON parse.
    const tBuf = buf.slice(off, off + n * 8);
    const vBuf = buf.slice(off + n * 8, off + n * 16);
    off += n * 16;
    // Convert to plain `number[]` so the rest of the pipeline (merge,
    // normalise, mergeSeries) keeps its existing types unchanged.
    series[s] = {
      t: Array.from(new Float64Array(tBuf)),
      v: Array.from(new Float64Array(vBuf)),
      value_lo: Number.isNaN(lo) ? null : lo,
      value_hi: Number.isNaN(hi) ? null : hi,
    };
  }
  return {
    from_seconds: Number.isNaN(fromS) ? null : fromS,
    last_seconds: Number.isNaN(lastS) ? null : lastS,
    series,
    slice_ms: sliceMs,
    decode_ms: decodeMs,
  };
}

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

/**
 * Min/max-decimate a `(t, v)` series to roughly `maxBuckets` time
 * buckets — keep the min- and max-value point of each bucket (in time
 * order) so peaks/troughs survive. Bucketing is by index (the trace
 * store's samples are roughly time-uniform), so it's a single O(n)
 * walk; returns at most `2 * maxBuckets` points. `maxBuckets <= 0`, or a
 * series that already fits, is returned as-is (a copy). Mirrors the
 * host's `signal_sampler::decimate_min_max` — used to keep a plot
 * area's accumulated cache bounded without a round-trip.
 */
export function decimatePoints(t: number[], v: number[], maxBuckets: number): { t: number[]; v: number[] } {
  const n = Math.min(t.length, v.length);
  if (maxBuckets <= 0 || n <= maxBuckets) return { t: t.slice(0, n), v: v.slice(0, n) };
  const bucket = Math.ceil(n / maxBuckets);
  const outT: number[] = [];
  const outV: number[] = [];
  for (let start = 0; start < n; start += bucket) {
    const end = Math.min(start + bucket, n);
    let lo = start;
    let hi = start;
    for (let i = start; i < end; i++) {
      if (v[i] < v[lo]) lo = i;
      if (v[i] > v[hi]) hi = i;
    }
    const a = Math.min(lo, hi);
    const b = Math.max(lo, hi);
    outT.push(t[a]);
    outV.push(v[a]);
    if (b !== a) {
      outT.push(t[b]);
      outV.push(v[b]);
    }
  }
  return { t: outT, v: outV };
}
