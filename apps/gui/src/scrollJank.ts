/**
 * Scroll-smoothness meter for the follow-live plot.
 *
 * A follow-live window should advance by exactly the elapsed real time,
 * every repaint. Anything else — the window stepping to data arrival, an
 * axis gutter resizing under it, a redraw that ran long — shows up as
 * the *rate* of advance varying from repaint to repaint. That variation
 * is what reads as jank, so measure it directly: sample how far the
 * window moved and how long that took, and report how much the rate
 * wobbles around its own average.
 *
 * The point of having a number is to stop arguing from impressions.
 * Smoothness work is easy to talk yourself into, and a percentage that
 * moves when you change one constant settles it.
 *
 * Cost is a handful of flops per repaint against two EMAs — cheap enough
 * to leave on.
 */

/** Rolling state. Seed with {@link emptyJankMeter}. */
export interface JankMeter {
  /** Smoothed rate of window advance (data-seconds per wall-second). */
  rateEma: number;
  /** Smoothed absolute deviation of the rate from `rateEma`. */
  devEma: number;
  /** Window position at the previous sample (session-relative seconds). */
  lastX: number | null;
  /** `performance.now()` at the previous sample. */
  lastMs: number;
  /** Samples folded in so far; the reading is suppressed until enough. */
  samples: number;
}

export function emptyJankMeter(): JankMeter {
  return { rateEma: 0, devEma: 0, lastX: null, lastMs: 0, samples: 0 };
}

/** Samples closer together than this carry no usable rate — repaints
 * can land in the same millisecond, and dividing by ~0 manufactures
 * enormous fake rates. */
const MIN_DT_MS = 4;
/** Beyond this the gap isn't jank, it's a different situation — a
 * backgrounded window, a stalled loop — and folding it in would swamp
 * the average with one outlier. */
const MAX_DT_MS = 500;
/** Readings below this are noise, not a measurement. */
const MIN_SAMPLES = 12;
/** Below this rate (data-seconds per wall-second) the view isn't
 * scrolling — paused, or follow-live off. Reporting there would divide
 * by a rate that is only float noise and manufacture huge percentages. */
const MIN_RATE = 0.05;

/**
 * Fold one repaint into the meter: the window's left edge `xMin` (any
 * consistent reference point on the window works — they all translate
 * together) at time `nowMs`. `alpha` is the EMA weight for new samples.
 *
 * Samples that can't carry rate information are dropped rather than
 * distorting the average, but still re-anchor the position so the next
 * one measures a real interval.
 */
export function observeScroll(m: JankMeter, xMin: number, nowMs: number, alpha: number): JankMeter {
  const dtMs = nowMs - m.lastMs;
  if (m.lastX == null) return { ...m, lastX: xMin, lastMs: nowMs };
  if (xMin === m.lastX) {
    // The window hasn't moved. Repaints happen more often than the
    // window advances, so treating every repaint as a rate sample would
    // measure an alternation between zero and a full step — an artefact
    // of how often we look, not of how evenly the plot scrolls. Hold the
    // anchor so the next real move is measured across the whole interval
    // it actually took. Once the window has been still long enough to be
    // *stopped* rather than between steps, drop the history: a paused or
    // unfollowed view has no scroll to report on, and stale numbers here
    // are worse than none.
    return dtMs > MAX_DT_MS ? emptyJankMeter() : m;
  }
  if (dtMs < MIN_DT_MS || dtMs > MAX_DT_MS) {
    return { ...m, lastX: xMin, lastMs: nowMs };
  }
  const rate = (xMin - m.lastX) / (dtMs / 1000);
  // First real sample seeds the average rather than deviating from zero.
  const rateEma = m.samples === 0 ? rate : m.rateEma + (rate - m.rateEma) * alpha;
  const dev = Math.abs(rate - rateEma);
  const devEma = m.samples === 0 ? 0 : m.devEma + (dev - m.devEma) * alpha;
  return { rateEma, devEma, lastX: xMin, lastMs: nowMs, samples: m.samples + 1 };
}

/**
 * Unevenness as a percentage of the scroll rate: `0` is a perfectly
 * uniform scroll, and bigger is worse. `null` while the window is
 * stationary (nothing to be smooth about) or before enough samples.
 *
 * Normalising by the rate keeps the reading comparable across zoom
 * levels and resample rates, so a change in one constant is legible
 * against a run at different settings.
 */
export function jankPercent(m: JankMeter): number | null {
  if (m.samples < MIN_SAMPLES || Math.abs(m.rateEma) < MIN_RATE) return null;
  return (m.devEma / Math.abs(m.rateEma)) * 100;
}
