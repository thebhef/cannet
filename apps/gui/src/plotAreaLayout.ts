/**
 * Plot-area vertical layout: fit-to-panel axis weights and splitter
 * drag (ADR 0026).
 *
 * Every derived axis in a panel carries a **weight** (default 1). The
 * panel applies each weight as an inline `flexGrow`, so the browser's
 * flexbox distributes the available height proportionally — weights
 * never need renormalizing and a new axis simply appears at weight 1.
 * A splitter drag between two adjacent axes trades weight between that
 * pair only, conserving their sum.
 *
 * These are pure functions so the conservation / clamp / no-op-identity
 * behaviour can be unit-tested without uPlot or the DOM. The
 * reference-identity contract (return the *same* object when nothing
 * changes) lets React effects that persist weights skip no-op writes.
 */

/** Default weight for an axis with no stored override. */
export const AXIS_WEIGHT_DEFAULT = 1;

/** Friendly minimum pixel height a splitter drag will leave a
 * neighbour at (the CSS floor is lower — see ADR 0026). */
export const AXIS_MIN_PX = 48;

/** A weight map keyed by derived-axis id. */
export type AxisWeights = Record<string, number>;

function isValidWeight(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Tolerant parse of a persisted `axisWeights` blob: keep only string
 * keys mapping to positive finite numbers, drop everything else. */
export function axisWeightsFromRaw(v: unknown): AxisWeights {
  if (typeof v !== "object" || v === null) return {};
  const out: AxisWeights = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (isValidWeight(val)) out[k] = val;
  }
  return out;
}

/** Produce a weight for every live axis id — the stored value when
 * present and valid, otherwise the default. Stored ids that are no
 * longer live are dropped. */
export function resolveAxisWeights(ids: string[], stored: AxisWeights): AxisWeights {
  const out: AxisWeights = {};
  for (const id of ids) {
    const w = stored[id];
    out[id] = isValidWeight(w) ? w : AXIS_WEIGHT_DEFAULT;
  }
  return out;
}

/** Drop stored entries whose id is not in `liveIds`. Returns the same
 * reference when nothing is removed (so an effect can bail early). */
export function pruneAxisWeights(stored: AxisWeights, liveIds: Iterable<string>): AxisWeights {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
  const keys = Object.keys(stored);
  if (keys.every((k) => live.has(k))) return stored;
  const out: AxisWeights = {};
  for (const k of keys) {
    if (live.has(k)) out[k] = stored[k];
  }
  return out;
}

/** Which axis the splitter above `idx` trades weight with: the nearest
 * axis above it that isn't collapsed, or `null` when there is none.
 *
 * A collapsed axis (every signal hidden) is excluded from the
 * fit-to-panel distribution, so it has no weight to trade and gets no
 * splitter of its own. It must not *sever* the stack either — a
 * splitter that only ever paired immediate DOM neighbours would vanish
 * the moment a middle axis collapsed, leaving no way to resize the two
 * axes it sits between. So the splitter reaches over it. */
export function splitterPartnerAbove(collapsed: readonly boolean[], idx: number): number | null {
  if (collapsed[idx]) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (!collapsed[i]) return i;
  }
  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Apply a splitter drag of `deltaPx` (positive = drag down, grows the
 * `idAbove` neighbour) to the pair `(idAbove, idBelow)`, whose current
 * on-screen heights are `abovePx`/`belowPx`. Weight moves between the
 * two, conserving their sum; each neighbour is clamped to `minPx`.
 *
 * Returns the same reference when the drag is a no-op (zero delta, or
 * already pinned against a floor, or the pair is too short to hold two
 * floors). */
export function applySplitterDelta(
  weights: AxisWeights,
  idAbove: string,
  idBelow: string,
  deltaPx: number,
  abovePx: number,
  belowPx: number,
  minPx = AXIS_MIN_PX,
): AxisWeights {
  const wA = isValidWeight(weights[idAbove]) ? weights[idAbove] : AXIS_WEIGHT_DEFAULT;
  const wB = isValidWeight(weights[idBelow]) ? weights[idBelow] : AXIS_WEIGHT_DEFAULT;
  const pairPx = abovePx + belowPx;
  const pairW = wA + wB;
  // Degenerate pair, or too short to seat two floors: nothing to do.
  if (pairPx <= 0 || pairPx < 2 * minPx) return weights;
  const wPerPx = pairW / pairPx;
  const newAbovePx = clamp(abovePx + deltaPx, minPx, pairPx - minPx);
  const newWA = newAbovePx * wPerPx;
  if (newWA === wA) return weights;
  return { ...weights, [idAbove]: newWA, [idBelow]: pairW - newWA };
}

/** Set both neighbours of a pair to their average, conserving the sum
 * (the double-click "equalize" affordance). Same reference when the
 * pair is already equal. */
export function equalizePair(weights: AxisWeights, idA: string, idB: string): AxisWeights {
  const wA = isValidWeight(weights[idA]) ? weights[idA] : AXIS_WEIGHT_DEFAULT;
  const wB = isValidWeight(weights[idB]) ? weights[idB] : AXIS_WEIGHT_DEFAULT;
  if (wA === wB) return weights;
  const avg = (wA + wB) / 2;
  return { ...weights, [idA]: avg, [idB]: avg };
}
