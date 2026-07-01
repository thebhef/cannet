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
    const width = xMin != null && xMax != null && xMax > xMin ? xMax - xMin : defaultWidth;
    return { min: Math.max(windowStartT, ext - width), max: ext };
  }
  if (xMax == null) return { min: windowStartT, max: ext };
  return null;
}
