/**
 * Enum-lane geometry for the per-unit combined enum axis (ADR 0026).
 *
 * The shared enum axis stacks its signals as horizontal
 * logic-analyzer lanes on a normalized [0, 1] y scale. These pure
 * helpers own the geometry — where each lane sits, how a raw enum code
 * maps into its lane band, and how tall a value tile draws — so the
 * `PlotArea` draw hook stays a thin consumer and the maths is
 * unit-tested without a canvas.
 *
 * Lane order is top-first: lane 0 is the topmost band (largest y on
 * the [0, 1] scale). Lane scale is a *table* fact — a lane's value
 * range comes from its value table's raw min/max, not observed data —
 * so it's independent of follow-live extents and fit-y snapshots.
 */

/** A closed sub-interval of the normalized [0, 1] y scale, or the
 * padded raw-value range of a lane. `hi >= lo`. */
export interface Band {
  lo: number;
  hi: number;
}

/** Fraction of each lane's slot left empty as the gap between lanes. */
const DEFAULT_GAP_FRACTION = 0.15;
/** Fraction of a lane's height a value tile fills by default. */
const DEFAULT_TILE_FRACTION = 0.6;

/** Split [0, 1] into `count` equal, non-overlapping lane bands, ordered
 * top-first (lane 0 highest). Adjacent lanes are separated by a gap of
 * `gapFraction` of each lane's slot, with half that as top/bottom
 * margin. `count <= 0` → no lanes. */
export function laneBands(count: number, gapFraction = DEFAULT_GAP_FRACTION): Band[] {
  if (count <= 0) return [];
  const slot = 1 / count;
  const gap = slot * gapFraction;
  const bands: Band[] = [];
  for (let i = 0; i < count; i++) {
    // Slot i (top-first): [1 - (i+1)·slot, 1 - i·slot]; inset by gap/2.
    const hi = 1 - i * slot - gap / 2;
    const lo = 1 - (i + 1) * slot + gap / 2;
    bands.push({ lo, hi });
  }
  return bands;
}

/** The padded raw-value range for a lane: the table's raw min/max, each
 * pushed out half a code so the extreme codes sit inside the band
 * rather than on its edge. Empty table → a unit fallback so the lane
 * still has a non-zero span. */
export function laneValueRange(table: readonly { raw: number }[]): Band {
  if (table.length === 0) return { lo: -0.5, hi: 0.5 };
  let min = table[0].raw;
  let max = table[0].raw;
  for (const e of table) {
    if (e.raw < min) min = e.raw;
    if (e.raw > max) max = e.raw;
  }
  return { lo: min - 0.5, hi: max + 0.5 };
}

function clamp01Frac(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Map a raw value from its `range` into the lane `band` on the [0, 1]
 * scale, clamping out-of-range values to the band edges. A zero-width
 * range maps to the band midpoint. */
export function normalizeIntoLane(value: number, range: Band, band: Band): number {
  const width = range.hi - range.lo;
  const frac = width === 0 ? 0.5 : clamp01Frac((value - range.lo) / width);
  return band.lo + frac * (band.hi - band.lo);
}

/** The centered vertical extent a value tile draws within its lane
 * `band`. The tile is `tileFraction` of the lane height, floored at
 * `minPx` (given the lane's on-screen pixel height `lanePx`) and capped
 * at the full lane band. */
export function laneTileBand(
  band: Band,
  lanePx: number,
  tileFraction = DEFAULT_TILE_FRACTION,
  minPx = 6,
): Band {
  const minFrac = lanePx > 0 ? minPx / lanePx : 0;
  const frac = Math.min(1, Math.max(tileFraction, minFrac));
  const center = (band.lo + band.hi) / 2;
  const half = ((band.hi - band.lo) * frac) / 2;
  return { lo: center - half, hi: center + half };
}
