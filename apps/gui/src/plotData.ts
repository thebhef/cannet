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
 * `"SIGSAMP\x01"` little-endian. The trailing version byte lets us
 * tweak the layout without breaking older builds outright. */
const SIGSAMP_MAGIC = [0x53, 0x49, 0x47, 0x53, 0x41, 0x4d, 0x50, 0x01];

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
 *   magic   "SIGSAMP\x01"   8 bytes
 *   from_s  f64             window first ts (NaN ⇒ null)
 *   last_s  f64             window last ts  (NaN ⇒ null)
 *   slice   f64             host diagnostic: lock-held slice ms
 *   decode  f64             host diagnostic: decode + decimate ms
 *   nsig    u32             number of signals
 *   per signal:
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
  const series: { t: number[]; v: number[] }[] = new Array(nsig);
  for (let s = 0; s < nsig; s++) {
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

/** Stable key for a `(bus, message, signal)` triple — what the plot
 * panel uses to dedupe a signal in its own state. `busId` may be
 * `null` for legacy plots that pre-date per-bus signal binding (the
 * "any bus" path). */
export function signalKey(
  busId: string | null,
  messageId: number,
  extended: boolean,
  signalName: string,
): string {
  return `${busId ?? "*"}|${extended ? "x" : "s"}:${messageId}:${signalName}`;
}

/**
 * Unit-based y-scale grouping (ADR 0026): on an axis, series sharing
 * a unit share one y scale, and each unit group auto-scales
 * independently to fill the axis.
 *
 * Given each signal's own observed value range (the plot area's
 * per-signal auto-norm latch), returns the range each signal should
 * actually be *normalised by*: the union (min lo, max hi) of the
 * latched ranges across every signal in its unit group. Signals with
 * a non-empty unit group by that unit; **unitless signals each form
 * their own group** — two signals that merely both lack a unit are
 * not known to be commensurable, and pinning them to a shared scale
 * would flatten whichever has the smaller range.
 *
 * A signal with no entry in `perSignalRanges` (nothing decoded yet,
 * or all values equal so far) contributes nothing to its group and
 * gets no entry in the result — the renderer keeps its midline
 * fallback for it.
 */
export function groupScaleRanges(
  members: ReadonlyArray<{ key: string; unit: string }>,
  perSignalRanges: ReadonlyMap<string, { lo: number; hi: number }>,
): Map<string, { lo: number; hi: number }> {
  // Pass 1: union each unit group's range.
  const groupRange = new Map<string, { lo: number; hi: number }>();
  const groupKeyFor = (m: { key: string; unit: string }) =>
    m.unit ? `unit:${m.unit}` : `sig:${m.key}`;
  for (const m of members) {
    const r = perSignalRanges.get(m.key);
    if (!r) continue;
    const gk = groupKeyFor(m);
    const g = groupRange.get(gk);
    if (!g) groupRange.set(gk, { lo: r.lo, hi: r.hi });
    else {
      if (r.lo < g.lo) g.lo = r.lo;
      if (r.hi > g.hi) g.hi = r.hi;
    }
  }
  // Pass 2: hand each signal its group's range.
  const out = new Map<string, { lo: number; hi: number }>();
  for (const m of members) {
    if (!perSignalRanges.has(m.key)) continue;
    const g = groupRange.get(groupKeyFor(m));
    if (g) out.set(m.key, { lo: g.lo, hi: g.hi });
  }
  return out;
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
