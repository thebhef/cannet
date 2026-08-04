/// Pacing for a plot area's self-driven resample loop.
///
/// The tail of a resample — merging the sampled series onto the shared
/// time axis, normalising them, handing the array to uPlot, and the
/// redraw that follows — is synchronous UI-thread work, and it grows
/// with the number of series the area holds. A loop that always waits
/// the configured fetch interval therefore lets one heavy area take an
/// unbounded share of the frame: past some series count the interval is
/// shorter than the tail, and the thread never gets an idle slot to run
/// input, layout or paint in. That is the difference between a plot that
/// is slow to fill and a window that has stopped responding.
///
/// So the loop waits proportionally to what the last tick actually cost:
/// at least the configured interval, and at least [`RESAMPLE_IDLE_RATIO`]
/// times the last tick's synchronous cost. An area can then never occupy
/// more than `1 / (1 + RESAMPLE_IDLE_RATIO)` of the thread however many
/// signals it holds — it updates less often instead, which is the trade
/// a view over a paged model is allowed to make (a slower readout is a
/// cost; an unresponsive window is a defect).
///
/// The ratio carries headroom because the measured span is the
/// resample's own synchronous section: the redraw uPlot runs off the
/// panel's window slide is proportional to it but lands in a later task,
/// so it is paced by the same back-off without being inside the
/// measurement.

/// Idle time the loop leaves per unit of synchronous work — the pacing's
/// only tuning knob. `4` bounds a plot area at a fifth of the UI thread.
export const RESAMPLE_IDLE_RATIO = 4;

/// Ceiling on the back-off, so a pathological area still refreshes
/// rather than going silent. Above it the per-tick block itself (uPlot's
/// draw is one indivisible call) is the remaining cost.
export const RESAMPLE_MAX_DELAY_MS = 2_000;

/// How long the resample loop should idle before its next tick, given
/// the configured fetch interval and the synchronous cost of the tick
/// that just finished. A cheap tick (the ordinary case: a handful of
/// series) is paced by the interval alone and this is a no-op.
export function nextResampleDelayMs(intervalMs: number, lastRenderMs: number): number {
  if (!Number.isFinite(lastRenderMs) || lastRenderMs <= 0) return intervalMs;
  const backOff = Math.min(RESAMPLE_MAX_DELAY_MS, lastRenderMs * RESAMPLE_IDLE_RATIO);
  return Math.max(intervalMs, backOff);
}
