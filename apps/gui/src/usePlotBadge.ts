/// The plot toolbar's perf read-out, decoupled from the resample loop.
///
/// Every plot area reports its resample cost, host time, effective rate,
/// cached-point count and smoothness on each tick. Feeding those straight
/// into React state cost one panel render per report — so N stacked areas
/// re-rendered the panel (and, before memoisation, every area in it) N
/// times per resample interval, for a diagnostic strip no one can read
/// above a couple of hertz.
///
/// So: accumulate into a ref, and flush to state on a lazily-scheduled
/// timer. The timer is armed by a report and disarmed when it fires, so a
/// panel with nothing sampling does no work at all (ADR 0024 — a view at
/// rest costs nothing).

import { useCallback, useEffect, useRef, useState } from "react";

/// How often accumulated readings reach the DOM. Fast enough that the
/// numbers still feel live, slow enough that the render cost is
/// independent of how hard the panel is sampling.
export const BADGE_FLUSH_MS = 500;

/// The toolbar strip's values. `jankPct` is `null` when the smoothness
/// meter has nothing to say.
export interface PlotBadge {
  /// Worst recent end-to-end resample cost (ms), decayed between reports.
  perfMs: number;
  /// Worst recent host-side slice + decode cost (ms), decayed likewise.
  hostMs: number;
  /// Effective resample rate (Hz), decayed likewise.
  rateHz: number;
  /// Cached signal points in the biggest area.
  cachePts: number;
  jankPct: number | null;
}

/// The report side, one call per reading. Stable for the panel's lifetime,
/// so the callback bundle handed to each area never changes identity.
export interface PlotBadgeSink {
  perf(ms: number): void;
  hostMs(ms: number): void;
  rate(hz: number): void;
  cache(n: number): void;
  jank(pct: number | null): void;
}

const EMPTY: PlotBadge = { perfMs: 0, hostMs: 0, rateHz: 0, cachePts: 0, jankPct: null };

function same(a: PlotBadge, b: PlotBadge): boolean {
  return (
    a.perfMs === b.perfMs &&
    a.hostMs === b.hostMs &&
    a.rateHz === b.rateHz &&
    a.cachePts === b.cachePts &&
    a.jankPct === b.jankPct
  );
}

export function usePlotBadge(): { value: PlotBadge; report: PlotBadgeSink } {
  const [value, setValue] = useState<PlotBadge>(EMPTY);
  const pending = useRef<PlotBadge>(EMPTY);
  const timer = useRef(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = 0;
    },
    [],
  );

  const schedule = useCallback(() => {
    if (timer.current || !mounted.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      setValue((prev) => (same(prev, pending.current) ? prev : { ...pending.current }));
    }, BADGE_FLUSH_MS);
  }, []);

  const report = useRef<PlotBadgeSink>({
    // The `max(previous * decay, latest)` shape is what makes these
    // readable: a spike sticks around long enough to notice, then bleeds
    // off. It used to live in the `setState` updaters; folding it into
    // the accumulator keeps the semantics per *report*, not per flush.
    perf: (ms) => {
      pending.current.perfMs = Math.max(pending.current.perfMs * 0.6, ms);
      schedule();
    },
    hostMs: (ms) => {
      pending.current.hostMs = Math.max(pending.current.hostMs * 0.6, ms);
      schedule();
    },
    rate: (hz) => {
      pending.current.rateHz = Math.max(pending.current.rateHz * 0.7, hz);
      schedule();
    },
    cache: (n) => {
      pending.current.cachePts = n;
      schedule();
    },
    jank: (pct) => {
      pending.current.jankPct = pct;
      schedule();
    },
  }).current;

  return { value, report };
}
