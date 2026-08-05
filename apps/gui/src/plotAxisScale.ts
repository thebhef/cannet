/**
 * Manual y-axis control: the per-derived-axis range override and log
 * flag, plus the maths that turns them into the range an axis actually
 * draws (ADR 0026).
 *
 * An axis normally derives its scale from its data — the unit-group
 * union in `plotData.ts::groupScaleRanges`, widened when a group holds
 * a single constant value. This module is the *override* on top of
 * that: a user-set min, a user-set max, and whether the axis maps its
 * range logarithmically. All three are view configuration, so they ride
 * the plot panel's persisted config keyed by derived-axis id, exactly
 * as `axisWeights` does.
 *
 * The dict is **sparse**: an entry exists only where the user has
 * overridden something, so a panel nobody has configured persists
 * nothing and clearing the last field deletes the entry rather than
 * storing an empty one.
 *
 * Pure functions, no React and no uPlot, so the precedence and the
 * decade maths are unit-testable.
 */

import { constantRange } from "./plotData";

/** One axis's manual scale settings. Every field is optional and an
 * absent field means "automatic" — the derived-from-data behaviour. */
export interface AxisScale {
  /** Manual lower bound. Not applied while {@link log} is set (a log
   * axis derives its min from the smallest positive value present), but
   * still *held*, so turning log off restores what the user typed. */
  min?: number;
  /** Manual upper bound. Applies on a log axis too. */
  max?: number;
  /** Draw this axis on a log scale. */
  log?: boolean;
}

/** Manual scale settings keyed by derived-axis id (`DerivedAxis.id`). */
export type AxisScales = Record<string, AxisScale>;

/** True when an entry carries no override at all — the state in which
 * it must not be stored. */
export function axisScaleIsEmpty(s: AxisScale): boolean {
  return s.min === undefined && s.max === undefined && !s.log;
}

function isBound(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Tolerant parse of a persisted `axisScales` blob: keep only string
 * keys mapping to an object with finite bounds and a `true` log flag,
 * drop everything else — including entries that would come out empty. */
export function axisScalesFromRaw(v: unknown): AxisScales {
  if (typeof v !== "object" || v === null) return {};
  const out: AxisScales = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "object" || val === null) continue;
    const o = val as Record<string, unknown>;
    const e: AxisScale = {};
    if (isBound(o.min)) e.min = o.min;
    if (isBound(o.max)) e.max = o.max;
    if (o.log === true) e.log = true;
    if (!axisScaleIsEmpty(e)) out[k] = e;
  }
  return out;
}

/** A patch to one axis's settings: a number sets a bound, `null` clears
 * it, and an absent key leaves it alone. `log: false` clears the flag. */
export interface AxisScalePatch {
  min?: number | null;
  max?: number | null;
  log?: boolean;
}

/** Apply `patch` to `id`'s entry, keeping the dict sparse: an entry
 * left with no overrides is deleted rather than stored empty. Returns
 * the same reference when nothing changes, so a persisting effect can
 * bail early. */
export function setAxisScale(scales: AxisScales, id: string, patch: AxisScalePatch): AxisScales {
  const cur = scales[id] ?? {};
  const next: AxisScale = { ...cur };
  if ("min" in patch) {
    if (isBound(patch.min)) next.min = patch.min;
    else delete next.min;
  }
  if ("max" in patch) {
    if (isBound(patch.max)) next.max = patch.max;
    else delete next.max;
  }
  if ("log" in patch) {
    if (patch.log) next.log = true;
    else delete next.log;
  }
  if (next.min === cur.min && next.max === cur.max && !!next.log === !!cur.log) return scales;
  const out = { ...scales };
  if (axisScaleIsEmpty(next)) delete out[id];
  else out[id] = next;
  return out;
}

/** Drop entries whose axis id is not in `retainIds`. Returns the same
 * reference when nothing is removed.
 *
 * `retainIds` is deliberately *not* the live axis set: an axis's
 * settings survive a y-axis-mode change (the ids regenerate
 * identically), and retire only when the signals that give the axis its
 * identity leave the plot. See `retainedAxisIds` in
 * `plotAxisDerivation.ts`. */
export function pruneAxisScales(scales: AxisScales, retainIds: Iterable<string>): AxisScales {
  const keep = retainIds instanceof Set ? retainIds : new Set(retainIds);
  const keys = Object.keys(scales);
  if (keys.every((k) => keep.has(k))) return scales;
  const out: AxisScales = {};
  for (const k of keys) {
    if (keep.has(k)) out[k] = scales[k];
  }
  return out;
}

/** The range an axis draws: its bounds plus whether they map
 * logarithmically. `null` from {@link resolveAxisRange} means there is
 * nothing to draw at all. */
export interface ResolvedAxisRange {
  lo: number;
  hi: number;
  log: boolean;
}

/** Snap a value down / up to a decade boundary, tolerating the float
 * error in `Math.log10` on exact powers of ten. */
function decadeFloor(v: number): number {
  const e = Math.log10(v);
  const r = Math.round(e);
  return 10 ** (Math.abs(e - r) < 1e-9 ? r : Math.floor(e));
}
function decadeCeil(v: number): number {
  const e = Math.log10(v);
  const r = Math.round(e);
  return 10 ** (Math.abs(e - r) < 1e-9 ? r : Math.ceil(e));
}

/**
 * The range an axis actually draws, given the range its data derived
 * (`auto`, already unit-grouped and constant-widened — `null` when
 * nothing has decoded), the user's overrides, and — on a log axis —
 * the smallest positive value present in the data (`minPositive`).
 *
 * Precedence: **a manual bound beats everything automatic.** Either
 * bound may stand alone; the other stays automatic. A manual bound the
 * automatic side has crossed (a max under the data's own floor) would
 * leave the axis with no span, so it takes the same ±10 % band a
 * constant signal gets, centred on the value the user pinned.
 *
 * On a log axis the min is *derived*, not settable: it is the smallest
 * positive value present, snapped down to a decade, because a log axis
 * cannot render zero or negatives. A manual max still applies and is
 * used exactly — only the auto-derived bounds snap to decades. Nothing
 * positive to draw (no positive sample, or a manual max at or below
 * zero) returns `null`: the series draws nothing, and the caller says
 * so rather than showing an empty axis.
 */
export function resolveAxisRange(
  auto: { lo: number; hi: number } | null,
  setting: AxisScale | undefined,
  minPositive: number | null,
): ResolvedAxisRange | null {
  if (setting?.log) {
    const hiRaw = setting.max ?? auto?.hi ?? null;
    if (hiRaw == null || hiRaw <= 0) return null;
    const loRaw = minPositive != null && minPositive > 0 ? minPositive : auto && auto.lo > 0 ? auto.lo : null;
    if (loRaw == null) return null;
    const lo = decadeFloor(loRaw);
    const hi = setting.max != null ? setting.max : decadeCeil(hiRaw);
    if (hi <= lo) return { lo, hi: lo * 10, log: true };
    return { lo, hi, log: true };
  }
  const lo = setting?.min ?? auto?.lo ?? null;
  const hi = setting?.max ?? auto?.hi ?? null;
  if (lo == null || hi == null) return null;
  if (hi > lo) return { lo, hi, log: false };
  // No span left: anchor on whichever bound the user pinned (the min
  // when both are) and widen it the way a constant group is widened.
  const anchor = setting?.min ?? setting?.max ?? lo;
  return { ...constantRange(anchor), log: false };
}

/** Map a value onto the axis's [0, 1] display scale. `null` on a log
 * axis for a non-positive value: those points are **dropped**, not
 * clamped — a clamped point sitting on the axis floor reads as a real
 * reading. */
export function normalizeOnAxis(v: number, r: ResolvedAxisRange): number | null {
  if (r.log) {
    if (v <= 0 || r.lo <= 0) return null;
    const span = Math.log10(r.hi) - Math.log10(r.lo);
    if (!(span > 0)) return 0.5;
    return (Math.log10(v) - Math.log10(r.lo)) / span;
  }
  const span = r.hi - r.lo;
  if (!(span > 0)) return 0.5;
  return (v - r.lo) / span;
}

/** Inverse of {@link normalizeOnAxis} — what a tick at normalised
 * position `n` reads as in the signal's own units. */
export function denormalizeOnAxis(n: number, r: ResolvedAxisRange): number {
  if (r.log) {
    const loE = Math.log10(r.lo);
    return 10 ** (loE + n * (Math.log10(r.hi) - loE));
  }
  return r.lo + n * (r.hi - r.lo);
}

/** Most tick splits a log axis draws, so a range spanning many decades
 * doesn't paint a label per decade into a gutter that can't hold them. */
const MAX_LOG_SPLITS = 10;

/** Normalised tick positions for a log axis: one per decade boundary
 * inside the range, thinned to {@link MAX_LOG_SPLITS}. Off a log axis
 * it answers uPlot's ordinary even quarters, so the same callback can
 * serve both. */
export function logDecadeSplits(r: ResolvedAxisRange | null): number[] {
  if (r == null || !r.log) return [0, 0.25, 0.5, 0.75, 1];
  const first = Math.ceil(Math.log10(r.lo) - 1e-9);
  const last = Math.floor(Math.log10(r.hi) + 1e-9);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [0, 0.5, 1];
  const count = last - first + 1;
  const step = Math.ceil(count / MAX_LOG_SPLITS);
  const out: number[] = [];
  for (let e = first; e <= last; e += step) {
    const n = normalizeOnAxis(10 ** e, r);
    if (n != null) out.push(n);
  }
  return out;
}
