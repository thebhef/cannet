/// The follow-live edge's clock anchor. The displayed edge is derived
/// from wall-clock time since the anchor, not from data arrival — see
/// [`advanceLiveEdge`].
export interface LiveEdge {
  /// Session-relative seconds at the anchor (ADR 0024's timeline).
  sessionT: number;
  /// `performance.now()` milliseconds at the anchor.
  wallMs: number;
  /// Newest data edge seen, to tell a capture re-anchor (it moves
  /// backwards) from a merely quiet bus (it stops moving).
  lastExt: number;
}

/// Tuning for the follow-live clock. See [`advanceLiveEdge`].
export interface LiveEdgeTuning {
  /// How far the clock may fall behind before it gives up nudging and
  /// resyncs hard — a stalled loop or a backgrounded tab.
  maxLagSeconds: number;
  /// Time constant of the pull toward the data edge.
  tauSeconds: number;
  /// How far *behind* the newest frame the window's right edge tracks.
  /// Zero puts the edge on the newest sample, which means the strip
  /// between the last fetch and now is empty and refills each fetch —
  /// the leading edge visibly drops out. A lag of a couple of resample
  /// intervals keeps the trace running past the right edge instead.
  targetLagSeconds: number;
}

/// The displayed follow-live edge at `nowMs`, in session-relative
/// seconds: the anchor plus the real time elapsed since it was taken.
export function liveEdgeAt(edge: LiveEdge, nowMs: number): number {
  return edge.sessionT + (nowMs - edge.wallMs) / 1000;
}

/// Fold the newest data edge `ext` into the follow-live clock.
///
/// Driving the window's right edge straight off `ext` makes the whole
/// plot translate by a *variable* amount each repaint, because `ext` is
/// data-arrival time sampled at whatever cadence the resample loop
/// happens to tick at. Every fixed-time feature — gridlines, tiles, the
/// labels on them — then judders together, and the jump scales with
/// pixels-per-second, so zooming in makes it worse. Predicting the edge
/// from elapsed real time instead makes the motion smooth, and lets the
/// data fill in behind it.
///
/// Prediction alone isn't enough, though: a clock that only gets
/// corrected when it has drifted *far* from the data is free to sit
/// anywhere inside that tolerance, so the gap between the trace's
/// leading edge and the window's right edge wanders — the data reads as
/// not keeping up with the window. So each update also pulls the edge a
/// `gain` fraction of the way toward `ext`. That's enough to lock onto
/// the data's rate and hold a steady offset from it, while still
/// filtering the per-update arrival jitter that caused the judder. The
/// offset it settles at is `dt · (1 − gain) / gain` — raise `gain` to
/// sit closer to the live edge, lower it to filter harder.
///
/// The pull is a first-order filter with time constant `tauSeconds`,
/// applied against *elapsed time* rather than per call. That matters for
/// two reasons: the correction is then independent of the resample rate
/// (`RATE_OPTIONS` spans 5–60 Hz), and calling this several times for the
/// same instant — once per plot area, which is what the panel does —
/// converges to the same answer instead of over-correcting once per area.
///
/// The edge never moves backwards, so a quiet bus coasts to a bounded
/// offset and holds rather than scrolling into open space. Two cases
/// still resync hard, because no amount of nudging would catch up:
/// - `ext` moved **backwards** — the capture re-anchored (a buffer clear).
/// - the clock fell more than `maxLagSeconds` **behind** the data — a
///   stalled loop or a backgrounded tab.
export function advanceLiveEdge(
  edge: LiveEdge | null,
  ext: number,
  nowMs: number,
  tuning: LiveEdgeTuning,
): LiveEdge {
  // Track a point *behind* the newest frame, so the trace always runs
  // past the right edge instead of up to it.
  const target = ext - tuning.targetLagSeconds;
  if (!edge) return { sessionT: target, wallMs: nowMs, lastExt: ext };
  if (ext < edge.lastExt) return { sessionT: target, wallMs: nowMs, lastExt: ext };
  const predicted = liveEdgeAt(edge, nowMs);
  if (target > predicted + tuning.maxLagSeconds) {
    return { sessionT: target, wallMs: nowMs, lastExt: ext };
  }
  // No new data since the last update: the stream has stalled, or this
  // is a second plot area reporting the same tick. Hold the edge and
  // re-anchor the clock. Advancing here is what made a disconnected
  // trace keep sliding — the clock gained elapsed time each update while
  // the pull only clawed back a fraction, so the window crept to
  // equilibrium instead of stopping. Smoothing the gaps *between* data
  // updates is the job; extrapolating past a dead stream is not.
  if (ext === edge.lastExt) return { ...edge, wallMs: nowMs };
  const dt = Math.max(0, (nowMs - edge.wallMs) / 1000);
  const corrected = predicted + (target - predicted) * (1 - Math.exp(-dt / tuning.tauSeconds));
  // Re-anchoring every update keeps `sessionT` the currently displayed
  // edge, so this is simply "never go backwards".
  return { sessionT: Math.max(edge.sessionT, corrected), wallMs: nowMs, lastExt: ext };
}

/// Where the shared plot x-window should sit after an area finishes a
/// resample, or `null` to leave it untouched. Pure so the follow-live /
/// fit-on-restore decision is unit-testable.
///
/// Times are session-relative seconds (ADR 0024: one origin, no per-view
/// re-zero). `windowStartT` is the trace window's first-frame time in that
/// scale — the floor the window may never drop below. It is `0` only when
/// the window starts at the session origin; after a per-trace Clear /
/// Stop→Start it is the elapsed time of the clear, so the plot keeps
/// showing session time instead of snapping the left edge back to zero.
///
/// - Following a *running* trace: slide a fixed-width window so its right
///   edge tracks the live edge `ext`. Width is whatever the user last
///   zoomed/panned to (`xMax - xMin`), else `defaultWidth`; until the
///   capture is that long the left edge stays pinned at `windowStartT` and
///   the window just grows.
/// - Otherwise, if no window has been set yet (`xMax == null`), fit the
///   whole span `[windowStartT, ext]` once. This is the restore case: a
///   reloaded *stopped* trace has no live edge, so follow-live must not
///   slide it to a trailing `defaultWidth` slice — it fits the full span,
///   and every later resample no-ops (the window is now set).
/// - Otherwise leave the window as-is (a zoomed/panned stopped trace keeps
///   the user's view).
export function followXWindow(
  followLive: boolean,
  running: boolean,
  xMin: number | null,
  xMax: number | null,
  ext: number,
  defaultWidth: number,
  windowStartT: number,
): { min: number; max: number } | null {
  if (followLive && running) {
    const hasUserWidth = xMin != null && xMax != null && xMax > xMin;
    const width = hasUserWidth ? xMax - xMin : defaultWidth;
    let min = ext - width;
    let max = ext;
    if (min < windowStartT) {
      min = windowStartT;
      // A width the user chose is kept even when the capture is shorter
      // than it — the live edge just sits inside the window until the
      // capture catches up. Fitting to the data instead silently
      // *replaces* their zoom: the width is only ever remembered as the
      // current window's span, so once it collapses to the capture
      // length it never comes back. Reconnecting is exactly that case.
      // With no chosen width, growing from the start is still right.
      if (hasUserWidth) max = windowStartT + width;
    }
    // Never hand back an inverted or empty window. Just after a session
    // starts there is barely any capture, so a live edge tracking a
    // little *behind* the newest frame can still sit before the window's
    // own start. Pushing that to `setScale` is worse than doing nothing:
    // uPlot normalises the flipped range, the normalised value no longer
    // matches what the panel recorded, and the echo reads as a user pan
    // — dropping follow-live and leaving the window as wide as the lag.
    if (min >= max) return null;
    return { min, max };
  }
  if (xMax == null) return { min: windowStartT, max: ext };
  return null;
}
