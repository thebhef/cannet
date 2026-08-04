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

/** Lane bands for a signal list in which some signals are hidden.
 *
 * A hidden signal drops out of the lane layout entirely: the visible
 * lanes are laid out as if it were not there, so hiding one gives the
 * rest more room rather than leaving a reserved gap. Returns one entry
 * per input signal, in input order — the band a visible signal
 * occupies, or `null` for a hidden one (which draws nothing). All
 * hidden → all `null`, and no lane band is computed at all. */
export function laneBandsForVisible(
  hidden: readonly boolean[],
  gapFraction = DEFAULT_GAP_FRACTION,
): (Band | null)[] {
  let visible = 0;
  for (const h of hidden) if (!h) visible++;
  const bands = laneBands(visible, gapFraction);
  let next = 0;
  return hidden.map((h) => (h ? null : bands[next++]));
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

/** Where a value tile's label starts, in canvas pixels, given the
 * tile's full horizontal extent `seg` and the visible plot region
 * `vis` (both in canvas pixels). `null` when the visible part of the
 * tile is too narrow to hold `textWidth` plus `padX` either side.
 *
 * The label centres on the midpoint of the tile's **visible** part,
 * rounded to a whole pixel so glyphs aren't re-rasterised at a new
 * subpixel phase every frame.
 *
 * Centring on the tile's *own* midpoint instead is tempting — it is
 * rigid against the tile, so it can't drift while the plot scrolls —
 * but a tile's off-screen edges aren't model facts. The host widens
 * each fetched slice by two boundary points either side so a line
 * renderer has a segment running off each edge, and those points are
 * re-fetched every round trip: the tile's midpoint jumps with them,
 * and zoomed in far enough they are whole screens away, which puts the
 * label hard against an edge. Only the part you can see is trustworthy.
 *
 * That leaves one honest residual. Where a tile's *real* edge (a value
 * transition) is on screen and the other side runs off, this midpoint
 * sits between a moving edge and a fixed one, so under follow-live it
 * tracks at half the scroll rate. A tile spanning the whole viewport —
 * the common case for a held value, and the one where a moving label
 * is most distracting — has no real edge in view, so its label sits
 * dead centre and stays there. */
export function tileLabelX(
  seg: Band,
  vis: Band,
  textWidth: number,
  padX: number,
): number | null {
  const visStart = Math.max(seg.lo, vis.lo);
  const visEnd = Math.min(seg.hi, vis.hi);
  if (visEnd - visStart < textWidth + padX * 2) return null;
  return Math.round((visStart + visEnd - textWidth) / 2);
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
