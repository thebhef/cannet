// Frontend diagnostic counters, **off unless a launch asks for them**.
// Call sites tagged `// DIAG` across the frontend bump named counters; a
// 1 Hz reporter logs the per-second delta of every counter to the
// devtools console, plus two saturation measures:
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
// `setRegistry` updater — and kept as a standing dev aid: the next "the
// GUI feels wedged" report starts from this console stream instead of
// from scratch.
//
// Cheap is not the same as free, and all of this is measurement
// equipment shipping in the product binary: a Map read-modify-write on
// every render, a burst logger that clones and serializes that Map from
// inside `diagCount`, a `longtask` observer, and a console line a
// second. So it is armed by the host — `--diag`, which the perf-capture
// flags imply (see `diag::diag_enabled_from_args`) — and a launch that
// didn't ask registers, schedules and installs none of it. What stays
// unconditional is the 1 Hz reporter's *heartbeat*: the host reads the
// arrival of `report_js_heap` as evidence the renderer's main thread is
// still turning, so that beat is a product feature, not instrumentation.

import { invoke } from "@tauri-apps/api/core";

// Armed state for everything above. Off until the host says otherwise.
let enabled = false;

/// Whether the diagnostic machinery is armed.
export function isDiagEnabled(): boolean {
  return enabled;
}

/// Arm (or disarm) the diagnostic machinery. Arming registers the
/// `longtask` observer and installs the console capture entry point;
/// disarming takes both back down. Idempotent — the boot path and a
/// manually started capture may both call it.
export function setDiagEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  if (on) {
    armLongTasks();
    if (typeof window !== "undefined") {
      window.__cannetPerf = { begin: beginDiagCapture, end: endDiagCapture };
    }
  } else {
    disarmLongTasks();
    if (typeof window !== "undefined") delete window.__cannetPerf;
  }
}

const counts = new Map<string, number>();

// Gauges: latest absolute readings (not per-second deltas). The 1 Hz
// reporter prints each gauge's current value. Used for size/rate
// readings — the trace buffer `count`, aggregate and per-bus FPS, and
// host round-trip timings — where the instantaneous value, not its
// change, is what we want to watch against buffer growth.
const gauges = new Map<string, number>();

export function diagGauge(key: string, value: number): void {
  if (!enabled) return;
  gauges.set(key, value);
}

// Time a promise (typically an `invoke` round-trip) and record its
// duration in ms as a gauge under `key`. Lets a capture show whether a
// host fetch gets slower as the buffer grows. Passes the resolved value
// (and any rejection) straight through, so it's drop-in around a call.
export async function diagTime<T>(key: string, p: Promise<T>): Promise<T> {
  // Disarmed, the wrapper is the promise it was handed — not even the
  // two `performance.now()` reads.
  if (!enabled) return p;
  const t0 = performance.now();
  try {
    return await p;
  } finally {
    diagGauge(key, performance.now() - t0);
  }
}

// Local wall-clock `HH:MM:SS.mmm` stamp prefixed onto every diag line,
// matching the sidecar's log format so a capture that interleaves the
// devtools console with the host's System Messages can be aligned by
// time. (We stamp in-message rather than rely on the console's own
// timestamps, which aren't reliably present in copied text.)
function logStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Burst logging: the 1 Hz reporter relies on timers, and the freeze
// under investigation starves timers entirely (the [diag] stream goes
// silent). This path doesn't: every BURST_EVERY counter increments,
// log the totals synchronously from inside diagCount itself. A wedged
// render/effect loop still executes instrumented code, so its own
// counting forces the evidence out.
const BURST_EVERY = 5000;
let totalSinceBurst = 0;
let lastBurst = new Map<string, number>();

/// Current absolute counter values. The 1 Hz reporter reads `counts`
/// directly; this is the read side for anything outside this module —
/// notably tests that assert a render/work count stays bounded.
export function diagCounts(): ReadonlyMap<string, number> {
  return counts;
}

export function diagCount(key: string, n = 1): void {
  if (!enabled) return;
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
    console.log(`${logStamp()} [diag-burst] +${BURST_EVERY} events ${JSON.stringify(delta)}`);
  }
}

// --- Render-tier perf capture (ADR 0031) ---
//
// During a capture the 1 Hz reporter (below) also *pushes* each second's
// snapshot to the host (`diag_push`), which accumulates them and reduces
// the series to a diffable `RenderReport` on finish — the render-tier
// counterpart to the host-side perf harness's baseline. The host ignores
// pushes when no capture is armed, so the reporter pushes unconditionally
// while `capturing` without a round-trip to check.
let capturing = false;
let captureStartMs = 0;

/// Arm a host-side capture under `label` and start pushing per-second
/// samples. Returns once the host has armed.
export async function beginDiagCapture(label: string): Promise<void> {
  // A capture whose counters were never armed reduces to a report of
  // zeros that reads like real idle data — arm them rather than let that
  // shape out (the launch flags normally have already).
  setDiagEnabled(true);
  await invoke("diag_capture_start", { label });
  captureStartMs = performance.now();
  capturing = true;
}

/// Stop pushing and finish the host-side capture, returning its
/// `FinishedCapture` ({ report, path }). When `path` is given the host
/// also writes the report there as JSON.
export async function endDiagCapture(path?: string): Promise<unknown> {
  capturing = false;
  return invoke("diag_capture_finish", { path: path ?? null });
}

// Scriptable entry point so an operator (or automation) can bracket a
// capture from the devtools console without a dedicated UI:
//   await window.__cannetPerf.begin("ev-demo: 2 plots + 2 traces")
//   …let the RBS workload run…
//   await window.__cannetPerf.end("<path>/<date>-<hash>-frontend.json")
declare global {
  interface Window {
    __cannetPerf?: {
      begin: (label: string) => Promise<void>;
      end: (path?: string) => Promise<unknown>;
    };
  }
}

// Long-task accounting, armed with the rest of the machinery: the
// entries are consumed only by the 1 Hz line and the capture, so an
// unarmed launch registers no observer at all.
let longTaskMs = 0;
let po: PerformanceObserver | undefined;

function armLongTasks(): void {
  if (po) return;
  let supported = false;
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTaskMs += e.duration;
    });
    po.observe({ entryTypes: ["longtask"] });
    supported = true;
  } catch {
    // longtask entries unsupported (e.g. jsdom) — lag still tells
    // the story.
    po = undefined;
  }
  // One-shot probe: a capture showing `longtask=0ms` is only meaningful
  // if the observer is actually live. If this logs `false`, treat the
  // longtask column as absent and read `lag` instead.
  // eslint-disable-next-line no-console
  console.log(`${logStamp()} [diag] longtask observer supported: ${supported}`);
}

function disarmLongTasks(): void {
  po?.disconnect();
  po = undefined;
  longTaskMs = 0;
}

let running = false;

/// Start the 1 Hz reporter (idempotent). Returns a stop function so
/// the mounting effect can clean up (tests unmount App; a dangling
/// interval would keep the runner alive).
///
/// The tick always sends the heartbeat; the counter delta, the gauge
/// snapshot and the console line are built only while armed.
export function startDiagReporter(): () => void {
  if (running) return () => {};
  running = true;

  let last = new Map<string, number>();
  let lastTick = performance.now();

  const interval = window.setInterval(() => {
    const now = performance.now();
    const lag = now - lastTick - 1000;
    lastTick = now;
    // Report the renderer's JS-heap size to the host so the crash
    // health log can split a JS leak from native/GPU growth. Chromium-
    // only (`performance.memory`); absent elsewhere (jsdom in tests).
    //
    // The call goes out either way, because the host reads its *arrival*
    // as this window's liveness heartbeat (`crash.rs`): it runs on the
    // main thread, so a renderer that has stopped responding stops
    // sending it, and that is the only way a frontend hang reaches
    // `cannet.log` at all. `0` is the host's "no reading" — it records
    // the beat and leaves the last real heap figure alone.
    const mem = (performance as { memory?: { usedJSHeapSize?: number } })
      .memory;
    const heap = typeof mem?.usedJSHeapSize === "number" ? mem.usedJSHeapSize : 0;
    if (heap > 0) diagGauge("jsheap_mb", heap / (1024 * 1024));
    void invoke("report_js_heap", { bytes: heap }).catch(() => {});
    // Everything below is the diagnostic half of the tick: the delta
    // build, the Map clone, two `JSON.stringify`s and the console line.
    // Disarmed, the tick is the heartbeat and nothing else.
    if (!enabled) return;
    const delta: Record<string, number> = {};
    for (const [k, v] of counts) {
      const d = v - (last.get(k) ?? 0);
      if (d !== 0) delta[k] = d;
    }
    last = new Map(counts);
    const lt = longTaskMs;
    longTaskMs = 0;
    const g: Record<string, number> = {};
    for (const [k, v] of gauges) g[k] = Math.round(v * 10) / 10;
    // eslint-disable-next-line no-console
    console.log(
      `${logStamp()} [diag] lag=${lag.toFixed(0)}ms longtask=${lt.toFixed(0)}ms gauges=${JSON.stringify(g)} ${JSON.stringify(delta)}`,
    );
    if (capturing) {
      // Best-effort: a dropped second isn't worth surfacing, and a
      // failing invoke (e.g. host gone) shouldn't break the reporter.
      void invoke("diag_push", {
        sample: {
          t_ms: now - captureStartMs,
          lag_ms: lag,
          longtask_ms: lt,
          counts: delta,
          gauges: g,
        },
      }).catch(() => {});
    }
  }, 1000);

  return () => {
    window.clearInterval(interval);
    running = false;
    // The machinery exists to feed this reporter, so it goes down with
    // it — a remount re-arms from the host's answer.
    setDiagEnabled(false);
  };
}
