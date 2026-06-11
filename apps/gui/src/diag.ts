// Frontend diagnostic counters. Call sites tagged `// DIAG` across
// the frontend bump named counters; a 1 Hz reporter logs the
// per-second delta of every counter to the devtools console, plus two
// saturation measures:
//
// - `lag`: how late the 1-second interval fired. A healthy loop logs
//   lag≈0; a flooded loop can't run timers on time, so lag explodes.
// - `longtask`: total ms spent in >50 ms uninterruptible tasks this
//   second — the direct measure of "too busy to echo a keypress".
//
// Reading a stall: find the seconds where lag/longtask blow up and
// see which counter's delta exploded with them; the burst logger
// below covers the case where the stall starves timers entirely.
//
// Built for (and proven by) the rename-while-streaming lockup hunt —
// it identified a self-scheduling render loop from an impure
// `setRegistry` updater — and kept as a standing dev aid: the
// counters are cheap (a Map write per event), and the next "the GUI
// feels wedged" report starts from this console stream instead of
// from scratch.

const counts = new Map<string, number>();

// Burst logging: the 1 Hz reporter relies on timers, and the freeze
// under investigation starves timers entirely (the [diag] stream goes
// silent). This path doesn't: every BURST_EVERY counter increments,
// log the totals synchronously from inside diagCount itself. A wedged
// render/effect loop still executes instrumented code, so its own
// counting forces the evidence out.
const BURST_EVERY = 5000;
let totalSinceBurst = 0;
let lastBurst = new Map<string, number>();

export function diagCount(key: string, n = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + n);
  totalSinceBurst += n;
  if (totalSinceBurst >= BURST_EVERY) {
    totalSinceBurst = 0;
    const delta: Record<string, number> = {};
    for (const [k, v] of counts) {
      const d = v - (lastBurst.get(k) ?? 0);
      if (d !== 0) delta[k] = d;
    }
    lastBurst = new Map(counts);
    // eslint-disable-next-line no-console
    console.log(`[diag-burst] +${BURST_EVERY} events ${JSON.stringify(delta)}`);
  }
}

let running = false;

/// Start the 1 Hz reporter (idempotent). Returns a stop function so
/// the mounting effect can clean up (tests unmount App; a dangling
/// interval would keep the runner alive).
export function startDiagReporter(): () => void {
  if (running) return () => {};
  running = true;

  let last = new Map<string, number>();
  let lastTick = performance.now();
  let longTaskMs = 0;

  let po: PerformanceObserver | undefined;
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTaskMs += e.duration;
    });
    po.observe({ entryTypes: ["longtask"] });
  } catch {
    // longtask entries unsupported (e.g. jsdom) — lag still tells
    // the story.
  }

  const interval = window.setInterval(() => {
    const now = performance.now();
    const lag = now - lastTick - 1000;
    lastTick = now;
    const delta: Record<string, number> = {};
    for (const [k, v] of counts) {
      const d = v - (last.get(k) ?? 0);
      if (d !== 0) delta[k] = d;
    }
    last = new Map(counts);
    const lt = longTaskMs;
    longTaskMs = 0;
    // eslint-disable-next-line no-console
    console.log(
      `[diag] lag=${lag.toFixed(0)}ms longtask=${lt.toFixed(0)}ms ${JSON.stringify(delta)}`,
    );
  }, 1000);

  return () => {
    window.clearInterval(interval);
    po?.disconnect();
    running = false;
  };
}
