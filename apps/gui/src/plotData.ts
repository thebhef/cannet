// Pure helpers for the plot panel: merging independently-sampled signal
// series onto one shared time axis for uPlot.
//
// CAN signals are sampled at frame arrival times, so two signals on
// different messages almost never share timestamps. uPlot wants one x
// array with a parallel y array per series, so we build the sorted union
// of every series' timestamps and, for each series, carry the most
// recent value forward (sample-and-hold) — `null` before the series'
// first sample so uPlot leaves a gap rather than drawing from zero.

import type { SampledPoints, SignalsSample } from "./types";

/** Magic bytes at the start of a `sample_signals` binary response —
 * `"SIGSAMP\x03"` little-endian. The trailing version byte lets us
 * tweak the layout without breaking older builds outright; `\x02` added
 * the `flags` word that carries the host's completeness token, and
 * `\x03` the per-signal list of extrapolated stretches (ADR 0026). */
const SIGSAMP_MAGIC = [0x53, 0x49, 0x47, 0x53, 0x41, 0x4d, 0x50, 0x03];

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
 *   flags   u32             bit 0: the sampled caches are caught up
 *   nsig    u32             number of signals
 *   per signal:
 *     n     u32             sample count
 *     t[n]  f64×n           timestamps (absolute seconds)
 *     v[n]  f64×n           values
 *     m     u32             extrapolated-span count
 *     s[m]  f64×2m          span (from, to) pairs, ascending seconds
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
  // Bit 0 is the completeness token: a serve is bounded in time, so a
  // cold one answers with the prefix it decoded and leaves this clear.
  const flags = view.getUint32(off, true);
  off += 4;
  const nsig = view.getUint32(off, true);
  off += 4;
  const series: SampledPoints[] = new Array(nsig);
  for (let s = 0; s < nsig; s++) {
    const n = view.getUint32(off, true);
    off += 4;
    // Read the f64 runs straight out of `buf` via `DataView`. The arrays
    // may sit at offsets that aren't 8-aligned (the `u32` lens are only
    // 4-aligned), but `getFloat64` reads any byte offset — so unlike
    // `new Float64Array(buf, off, n)` it needs no aligned copy. This
    // deliberately avoids the previous `buf.slice()` per signal: at a
    // high plot update rate × many signals those fresh per-tick
    // `ArrayBuffer`s were a large source of churned native memory that
    // V8 reclaims only lazily, ratcheting the renderer's working set.
    // Output is plain `number[]` so the rest of the pipeline (merge,
    // normalise, mergeSeries) keeps its existing types unchanged.
    const t = new Array<number>(n);
    const v = new Array<number>(n);
    const vOff = off + n * 8;
    for (let j = 0; j < n; j++) t[j] = view.getFloat64(off + j * 8, true);
    for (let j = 0; j < n; j++) v[j] = view.getFloat64(vOff + j * 8, true);
    off += n * 16;
    // The host's extrapolation classification for this window. Usually
    // empty or a single tail span, so a plain loop over pairs is the
    // whole cost.
    const m = view.getUint32(off, true);
    off += 4;
    const extrapolated: [number, number][] = new Array(m);
    for (let j = 0; j < m; j++) {
      extrapolated[j] = [view.getFloat64(off, true), view.getFloat64(off + 8, true)];
      off += 16;
    }
    series[s] = { t, v, extrapolated };
  }
  return {
    from_seconds: Number.isNaN(fromS) ? null : fromS,
    last_seconds: Number.isNaN(lastS) ? null : lastS,
    series,
    complete: (flags & 1) !== 0,
    slice_ms: sliceMs,
    decode_ms: decodeMs,
  };
}

export interface RawSeries {
  /** Strictly-increasing sample times (seconds). */
  t: number[];
  /** Parallel sampled values. */
  v: number[];
  /** The host's extrapolation classification for this window, in the
   * same time base as `t` (ADR 0026). Absent on a series nobody
   * classified — every merge behaves exactly as it did before the
   * classification existed. */
  extrapolated?: readonly ExtrapolatedSpan[];
}

/** One stretch a view draws without data behind it: `[from, to]` in the
 * series' own time base. The host decides these (ADR 0026) — the raw
 * cadence they turn on is a model fact the frontend cannot see. */
export type ExtrapolatedSpan = readonly [number, number];

/** A stretch of merged columns to stroke dashed rather than solid: the
 * column the extrapolation runs from, and the one it runs to.
 *
 * `i1`'s value in the row may be `null` — that is the past-the-end tail,
 * which is held *flat* out to the last column the axis has, so a
 * renderer reads its far value from `i0` when `i1` has none. */
export interface ExtrapolatedSegment {
  i0: number;
  i1: number;
}

/**
 * Merge `series` into uPlot's `[xs, ...ys]` shape. `xs` is the sorted
 * union of every series' timestamps; `ys[k][i]` is series `k`'s
 * sample-and-hold value at `xs[i]`, or `null` before its first sample.
 *
 * With no series, returns `[[]]` — a valid empty uPlot data set.
 *
 * **A series holding exactly one sample is drawn as a horizontal line
 * through that value**, held across every column rather than starting
 * at its own timestamp. One point is not a line — there is nothing to
 * draw between a sample and itself — and a series whose entire content
 * is one value has no shape a leading gap could be hiding. `span` (the
 * visible x-window) covers the case where such a series is the only
 * thing on the axis: the union is then a single column, so the window's
 * two ends are added to give the line somewhere to run. It is used for
 * nothing else — a union that already spans two columns is left exactly
 * as the samples made it.
 *
 * The one-sample fill itself is unconditional, so on a *shared* axis
 * such a series is held across whatever columns its neighbours
 * contributed — after its only sample, and before it. Every other
 * series is drawn no further than its own data.
 */
export function mergeSeries(
  series: RawSeries[],
  span?: { from: number; to: number } | null,
): (number | null)[][] {
  const xsSet = new Set<number>();
  for (const s of series) {
    for (const t of s.t) xsSet.add(t);
    // An *interior* extrapolated stretch is bounded by a sample of this
    // series at each end, so blanking either end to break the solid
    // stroke would also cut the data-backed segment beside it short.
    // When the two ends are already neighbouring columns there is
    // nothing in between to blank, so the stretch gets a column of its
    // own — its midpoint — which exists only to be blanked. A stretch
    // running off either end of the series needs none: what it would
    // break is already `null` (before the first sample) or is blanked to
    // the axis edge (after the last).
    if (s.t.length === 0 || !s.extrapolated) continue;
    const first = s.t[0];
    const last = s.t[s.t.length - 1];
    for (const [a, b] of s.extrapolated) {
      if (a >= first && b <= last) xsSet.add((a + b) / 2);
    }
  }
  if (
    xsSet.size === 1 &&
    span &&
    Number.isFinite(span.from) &&
    Number.isFinite(span.to) &&
    span.to > span.from
  ) {
    xsSet.add(span.from);
    xsSet.add(span.to);
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const out: (number | null)[][] = [xs];
  for (const s of series) {
    if (s.t.length === 1) {
      out.push(new Array<number | null>(xs.length).fill(s.v[0]));
      continue;
    }
    // The fill looks redundant — every index is assigned below — but it
    // is what keeps `ys` a *packed* array. `new Array(n)` alone is
    // holey, and holey arrays stay on a slower element kind even once
    // every hole is written. The `null` before a series' first sample
    // comes from `last`, not from this fill.
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

/**
 * Split each merged row against its series' extrapolated spans (ADR
 * 0026): **blank the row wherever the stroke would be extrapolation**,
 * and return the column stretches a renderer must draw dashed instead.
 *
 * The two halves are one operation because they must not disagree: a
 * stretch that is blanked but not returned vanishes from the plot, and
 * one returned but not blanked is drawn twice — solid underneath the
 * dashes, which reads as solid.
 *
 * `rows` is mutated in place, matching how `PlotArea` normalises the
 * same arrays; `rows[k]` belongs to `series[k]`, as `mergeSeries`
 * returns them (its `xs` row removed).
 *
 * **A span only produces a segment where something is drawn today.** The
 * classification is about the whole window, but a multi-sample series is
 * still not drawn before its first sample — the pre-first-sample `null`
 * of ADR 0026 stands, and a dash there would be new ink, not honest ink.
 * So a span whose ends aren't both carrying a value is skipped whole:
 * neither blanked nor dashed. The one-sample series is the case where
 * this *does* fire on both wings, because `mergeSeries` holds its value
 * across every column.
 */
export function splitExtrapolatedRows(
  xs: readonly number[],
  rows: (number | null)[][],
  series: readonly RawSeries[],
): ExtrapolatedSegment[][] {
  return rows.map((row, k) => {
    const spans = series[k]?.extrapolated;
    if (!spans || spans.length === 0 || xs.length === 0) return [];
    const out: ExtrapolatedSegment[] = [];
    for (const [a, b] of spans) {
      // The columns the stretch is drawn between: the last one at or
      // before its start, and the first one at or after its end —
      // **each clamped to the column grid**. A stretch running past the
      // newest column (the past-the-end tail) is drawn to that column
      // and no further, which is exactly the extent the plot already
      // had; a stretch beginning before the oldest column is drawn from
      // that column, for the same reason. The near end needs the clamp
      // as much as the far end does: the fetch reaches past the visible
      // x range while no series has a sample before the capture's first
      // frame, so a *leading* span routinely starts left of column 0 —
      // and discarding it there left the one-sample hline's leading
      // wing drawn solid while its trailing wing dashed.
      const i0 = Math.max(lastAtOrBefore(xs, a), 0);
      const found = firstAtOrAfter(xs, b);
      const i1 = found >= 0 ? found : xs.length - 1;
      // Is the far column carrying a *sample* of this series, or only a
      // held value? Asked of the series' own timestamps rather than of
      // the column grid, because a neighbour's column can land exactly
      // on a stretch's end without this series having anything there.
      const t = series[k].t;
      const bounded = t.length > 0 && t[t.length - 1] >= b;
      if (i1 <= i0) continue;
      if (row[i0] == null || row[i1] == null) continue;
      // Blank what the solid stroke must no longer cover. An unbounded
      // stretch takes its far column too: nothing there is a sample of
      // this series, and leaving the held value behind would both draw a
      // stray marker at the axis edge and leave the tail solid.
      const blankTo = bounded ? i1 - 1 : i1;
      for (let i = i0 + 1; i <= blankTo; i++) row[i] = null;
      out.push({ i0, i1 });
    }
    return out;
  });
}

/**
 * Which merged columns carry a **genuine sample** of each series: the
 * columns whose x is one of that series' own timestamps.
 *
 * `mergeSeries` materializes a value for a series at columns it never
 * measured — every column of a dense neighbour's between two of its own
 * samples, every column of an extrapolated stretch, the midpoint minted
 * to break an interior stall, and (for a one-sample series) the whole
 * grid. Held values are what makes the line continuous and the tile
 * survive; they are not readings, and a marker drawn at one claims a
 * sample that does not exist. So a marker asks this, never the row.
 *
 * **Matched on the series' own timestamps rather than on anything the
 * merge produced** — that is the seam that cannot regress when the merge
 * changes. Whatever columns merging mints, holds across, or blanks, a
 * column is a sample of series `k` exactly when its x came out of
 * `series[k].t`; a column the merge invents has no such x to match, so a
 * new materializing rule cannot grow a marker. The alternative seam —
 * subtracting the extrapolated spans from the row — is a function of the
 * classification, and would still mark every held column the
 * classification does not cover (the dense neighbour's, which is most of
 * them).
 *
 * `xs` and each `t` are ascending, so this is one walk over both.
 * Returns one ascending column list per series, aligned with `series`.
 */
export function sampleColumns(
  xs: readonly number[],
  series: readonly RawSeries[],
): number[][] {
  return series.map((s) => {
    const out: number[] = [];
    let i = 0;
    for (const t of s.t) {
      while (i < xs.length && xs[i] < t) i++;
      if (i >= xs.length) break;
      if (xs[i] === t) out.push(i++);
    }
    return out;
  });
}

/** Index of the last entry of the ascending `xs` that is `<= x`, or -1. */
function lastAtOrBefore(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (hi < 0 || xs[0] > x) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Index of the first entry of the ascending `xs` that is `>= x`, or -1. */
function firstAtOrAfter(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (hi < 0 || xs[hi] < x) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] >= x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Stable key for a `(bus, message, signal)` triple — what the plot
 * panel uses to dedupe a signal in its own state. `busId` may be
 * `null` for legacy plots that pre-date per-bus signal binding (the
 * "any bus" path). Byte-for-byte `signal_snapshot::signal_identity`
 * host-side.
 *
 * The flag slot carries provenance as well as id width. A file-backed
 * signal (`docs/CONTEXT.md`) has no message and no bus, so `messageId`
 * is its source signal channel group index; `f` keeps that number out
 * of the message-id namespace, which is free to hold the same value. */
export function signalKey(
  busId: string | null,
  messageId: number,
  extended: boolean,
  signalName: string,
  fileBacked = false,
): string {
  const flag = fileBacked ? "f" : extended ? "x" : "s";
  return `${busId ?? "*"}|${flag}:${messageId}:${signalName}`;
}

/** `signalKey` for a catalog or snapshot record — the one place that
 * reads a record's provenance, so a surface listing both kinds cannot
 * key a file-backed signal as if it were a message's. */
export function recordSignalKey(r: {
  bus_id: string | null;
  message_id: number;
  extended: boolean;
  signal_name: string;
  file_backed?: boolean;
}): string {
  return signalKey(r.bus_id, r.message_id, r.extended, r.signal_name, r.file_backed);
}

/**
 * Walk a stepped enum series and return its constant-value segments,
 * each as `(t0, tEnd, v)`:
 *
 * - `t0` is the timestamp of the first sample holding `v`.
 * - `tEnd` is the timestamp at which the held value visually *ends*,
 *   matching uPlot's stepped-line rendering — i.e. the timestamp of
 *   the *next* sample (which is where the value changes), not the
 *   last sample of the run. A stepped line holds a sample's value
 *   forward until the next sample, so a box drawn `[t0, tEnd]` covers
 *   exactly the visible held interval.
 * - For the very last segment of the series there's no next sample;
 *   `tEnd` falls back to the last sample's own timestamp.
 *
 * Used by the plot panel's logic-analyzer lane (ADR 0026) to overlay
 * a label box on each held segment.
 *
 * A `null` sample ends the current segment without starting a new
 * one: when the source is sparse (e.g. a frame that didn't fire) the
 * gap should not get a label.
 */
export function enumSegments(
  ts: ReadonlyArray<number>,
  vs: ReadonlyArray<number | null>,
): Array<{ t0: number; tEnd: number; v: number }> {
  const out: Array<{ t0: number; tEnd: number; v: number }> = [];
  const n = Math.min(ts.length, vs.length);
  if (n === 0) return out;
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    const sameAsRun = i < n && vs[i] === vs[runStart];
    if (sameAsRun) continue;
    const v = vs[runStart];
    if (v != null) {
      // Box extends to the next sample's timestamp (where the value
      // actually changes) — matches the stepped line. Fall back to
      // the last sample's own timestamp on the final segment.
      const tEnd = i < n ? ts[i] : ts[i - 1];
      out.push({ t0: ts[runStart], tEnd, v });
    }
    runStart = i;
  }
  return out;
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
 * A signal with no entry in `perSignalRanges` (nothing decoded yet)
 * contributes nothing to its group and gets no entry in the result —
 * the renderer keeps its midline fallback for it.
 *
 * A group whose *whole* union has no span — every member constant at
 * the same value — is widened to {@link CONSTANT_MIN_RANGE_FRACTION}
 * of that value either side of it, so the axis labels read the value
 * it holds instead of a bare 0–1. See {@link constantRange}.
 */
/** Which y-scale group a signal belongs to: its unit, or itself when
 * it declares none (two signals that merely both lack a unit are not
 * known to be commensurable). Shared with the renderer, which has to
 * fold per-group facts — a log axis's smallest positive value — over
 * the same grouping {@link groupScaleRanges} unions by. */
export function scaleGroupKey(m: { key: string; unit: string }): string {
  return m.unit ? `unit:${m.unit}` : `sig:${m.key}`;
}

export function groupScaleRanges(
  members: ReadonlyArray<{ key: string; unit: string }>,
  perSignalRanges: ReadonlyMap<string, { lo: number; hi: number }>,
): Map<string, { lo: number; hi: number }> {
  // Pass 1: union each unit group's range.
  const groupRange = new Map<string, { lo: number; hi: number }>();
  const groupKeyFor = scaleGroupKey;
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
  // Pass 2: hand each signal its group's range, widening a group that
  // turned out to have no span at all.
  const out = new Map<string, { lo: number; hi: number }>();
  for (const m of members) {
    if (!perSignalRanges.has(m.key)) continue;
    const g = groupRange.get(groupKeyFor(m));
    if (g) out.set(m.key, g.hi > g.lo ? { lo: g.lo, hi: g.hi } : constantRange(g.lo));
  }
  return out;
}

/** Half-width of a constant group's scale, as a fraction of the value
 * it holds. Ten per cent puts the trace mid-canvas with round-ish
 * numbers either side, so the axis reads as the value. */
export const CONSTANT_MIN_RANGE_FRACTION = 0.1;

/** Half-width used when a constant sits at exactly zero, where the
 * proportional band collapses. Absolute, because there is no value to
 * take a fraction of — and ±1 keeps the axis in the units the signal
 * is measured in rather than inventing a magnitude. */
export const CONSTANT_ZERO_HALF_RANGE = 1;

/**
 * The scale to draw a group that never moves on.
 *
 * A constant has no span, so any scale for it is a choice rather than
 * a measurement — but *some* choice has to be made: normalising by a
 * zero span is a divide by zero, and the fallback that avoided it drew
 * the trace on the raw 0–1 canvas, an axis that said nothing about the
 * value under it. The band is centred on the value so the trace still
 * sits mid-canvas, and wide enough that the tick labels either side
 * read as that value.
 *
 * A non-finite value has nothing to centre on and is returned
 * unwidened; the renderer's midline fallback still covers it.
 */
export function constantRange(v: number): { lo: number; hi: number } {
  if (!Number.isFinite(v)) return { lo: v, hi: v };
  const half = Math.abs(v) * CONSTANT_MIN_RANGE_FRACTION || CONSTANT_ZERO_HALF_RANGE;
  return { lo: v - half, hi: v + half };
}
