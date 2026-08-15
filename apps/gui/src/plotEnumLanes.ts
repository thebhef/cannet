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

/** One `(raw, label)` row of a signal's value table, as the lane draw
 * needs it — structurally the `ValueTableEntryRecord` the host serves. */
interface LabelRow {
  raw: number;
  label: string;
}

/** Per-table code→label maps, so a draw builds one lookup per table
 * rather than one per table *per draw*. Weak, so a table that goes out
 * of scope (its signal removed, its DBC unloaded) takes its map with
 * it. */
const laneLabelMaps = new WeakMap<readonly LabelRow[], (raw: number) => string>();

/** A code→label resolver for one value table: the label the table gives
 * `raw`, or the code itself rendered as a number when the table doesn't
 * list it.
 *
 * The tile draw calls this once per visible segment, and a segment count
 * grows with the window — a linear `table.find` per segment was a
 * measurable share of the lane's draw cost on a long capture. The map is
 * cached against the table's own identity, so repeated draws of an
 * unchanged table cost one lookup each.
 *
 * First row wins on a duplicate `raw`, matching the linear scan this
 * replaces. */
export function laneLabels(table: readonly LabelRow[]): (raw: number) => string {
  const cached = laneLabelMaps.get(table);
  if (cached) return cached;
  const byRaw = new Map<number, string>();
  for (const r of table) if (!byRaw.has(r.raw)) byRaw.set(r.raw, r.label);
  const lookup = (raw: number): string => byRaw.get(raw) ?? String(raw);
  laneLabelMaps.set(table, lookup);
  return lookup;
}

/** Measured widths, keyed by the font that produced them. A tile lane
 * draws a handful of distinct labels over and over, so this stays tiny
 * — bounded by (fonts in use) × (labels in the loaded value tables). */
const tileLabelWidths = new Map<string, number>();

/** Width in canvas pixels of a tile label in `ctx`'s current font,
 * memoised per `(label, font)`.
 *
 * `measureText` is a text-shaping call, and the tile draw makes one per
 * visible segment even though the labels repeat: a lane cycling through
 * six states redraws the same six strings for as many segments as the
 * window holds. Keying on the font as well as the label is not
 * optional — the same string measures differently under the axis font
 * and the label font, and a label-only memo would silently return the
 * wrong width to whichever caller measured second. */
export function measureTileLabel(ctx: CanvasRenderingContext2D, label: string): number {
  const key = `${ctx.font}\u0000${label}`;
  const hit = tileLabelWidths.get(key);
  if (hit !== undefined) return hit;
  const width = ctx.measureText(label).width;
  tileLabelWidths.set(key, width);
  return width;
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

/** Horizontal period of the diagonal stripes an extrapolated lane tile
 * is overlaid with (ADR 0026), in CSS pixels. Wide enough that the
 * pattern reads as hatching at a glance rather than as a texture, and
 * that a label's glyphs are crossed a couple of times at most. */
export const EXTRAPOLATION_STRIPE_PERIOD_PX = 20;

/** One stripe, as the two endpoints to stroke between. */
export interface StripeLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The 45° stripe overlay for one rectangle (ADR 0026): the stroke width
 * that makes the painted and unpainted bands exactly even, and the lines
 * to stroke — which run past the rectangle's edges, so the caller clips
 * to it.
 *
 * **The width is not half the period.** A 45° stroke of width `w`
 * occupies `w·√2` horizontally, so a naive `period / 2` paints
 * `period / √2` ≈ 71 % of each period and the overlay reads as a
 * repaint of the tile rather than as hatching over it. Even bands need
 * `period / (2·√2)`.
 *
 * Stripes are anchored to the canvas x origin rather than to the
 * rectangle, so two tiles that meet continue one another's pattern
 * instead of both restarting it at their shared edge — which would put
 * a double-width band on every join.
 *
 * All lengths are in the caller's pixel space (device pixels, i.e. CSS
 * pixels already multiplied by the canvas ratio, if that is what it
 * passes as `periodPx`).
 */
export function stripeOverlay(
  rect: { x0: number; x1: number; yTop: number; yBot: number },
  periodPx: number,
): { lineWidth: number; lines: StripeLine[] } {
  const lineWidth = periodPx / (2 * Math.SQRT2);
  const lines: StripeLine[] = [];
  const h = rect.yBot - rect.yTop;
  if (!(periodPx > 0) || !(h > 0) || !(rect.x1 > rect.x0)) return { lineWidth, lines };
  // A stripe starting at `xt` on the top edge reaches `xt + h` on the
  // bottom one, so the rectangle is covered by every anchored start from
  // one height left of it through its right edge.
  const first = Math.floor((rect.x0 - h) / periodPx);
  const last = Math.ceil(rect.x1 / periodPx);
  for (let k = first; k <= last; k++) {
    const xt = k * periodPx;
    lines.push({ x0: xt, y0: rect.yTop, x1: xt + h, y1: rect.yBot });
  }
  return { lineWidth, lines };
}

/**
 * The part of `[t0, tEnd]` that `spans` marks as extrapolation, or
 * `null` when they do not meet.
 *
 * A tile is a run of one held code and a stretch of extrapolation is a
 * run of silence; neither is a subdivision of the other, so a tile can
 * be wholly, partly, or not at all stale. **Only the stale part is
 * striped** — a tile that went stale halfway through still shows, in
 * the same picture, when it was a reading and when it stopped being one.
 *
 * Spans are ascending and non-overlapping, so the union of their
 * overlaps with one tile is reported as its outer bounds; a tile
 * straddling two stretches has data between them, and the caller's
 * per-span iteration is what keeps that gap unstriped.
 */
export function stripedOverlap(
  t0: number,
  tEnd: number,
  span: readonly [number, number],
): { from: number; to: number } | null {
  const from = Math.max(t0, span[0]);
  const to = Math.min(tEnd, span[1]);
  return to > from ? { from, to } : null;
}
