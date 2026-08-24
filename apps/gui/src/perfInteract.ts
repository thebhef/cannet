/**
 * Synthetic interaction for the self-driving performance capture
 * (ADR 0031).
 *
 * The capture opens a saved project, connects, and records — so it sees
 * the app's *resting* cost under load and nothing else. Most of what the
 * render path actually costs is paid on interaction: the virtualiser
 * re-windowing as the trace table scrolls, the plot re-fetching and
 * re-decimating as its x-window pans and zooms. A capture that never
 * touches either cannot see a regression in them.
 *
 * ADR 0031 rules out WebDriver (no macOS support), and the app is its
 * own driver anyway: these are real DOM events dispatched at the real
 * elements, through the same listeners a mouse reaches. Nothing here is
 * a stand-in for the render path — it is the render path, driven from
 * inside the process.
 *
 * Two scripts, because the two things the capture could not see are not
 * the same scenario:
 *
 * - `scrub` — the interaction gate. Zooms the plot in to a working
 *   window, then cycles scroll / pan / zoom gestures with idle slots
 *   between them.
 * - `follow` — the same zoom-in, then nothing. Follow-live scrolling at
 *   a real zoom, with no gesture perturbing the x-window, which is the
 *   only scenario the scroll-smoothness gauges mean anything in: a pan
 *   moves the window by more than a second in one step, and a meter that
 *   measures how evenly the window advances cannot tell that apart from
 *   a stall.
 */

/** The scripts {@link perfInteractTick} understands. */
export const PERF_INTERACT_SCRIPTS = ["scrub", "follow"] as const;
export type PerfInteractScript = (typeof PERF_INTERACT_SCRIPTS)[number];

/** Parse the `--perf-interact` value, defaulting an unknown or absent
 * one to `scrub` — a mistyped script should still measure something
 * rather than silently running a capture with no interaction in it. */
export function parseInteractScript(v: string | null | undefined): PerfInteractScript {
  return (PERF_INTERACT_SCRIPTS as readonly string[]).includes(v ?? "")
    ? (v as PerfInteractScript)
    : "scrub";
}

/** Gap between gestures. Faster than a person, deliberately — this is a
 * load probe, and a gesture rate below the app's own fetch cadence would
 * measure the fetch loop rather than the interaction. */
export const INTERACT_STEP_MS = 150;

/** Zoom-in notches the warm-up spends before the script proper. A saved
 * plot window is whatever the project was last left at (the ev-zonal
 * example carries ~170 s); at 1.15× per notch this brings any plausible
 * saved width down to a few seconds, which is where a follow-live window
 * actually slides rather than sitting pinned to the session start. */
const ZOOM_WARMUP_NOTCHES = 32;

/** How long the warm-up takes, so the caller can let it finish before
 * bracketing the capture — the measurement wants the steady state, not
 * 32 zoom steps. */
export const INTERACT_WARMUP_MS = ZOOM_WARMUP_NOTCHES * INTERACT_STEP_MS;

/** Rows-pane travel per scroll gesture (px). Large enough to leave the
 * loaded page and force a re-page, small enough to stay in the region
 * the previous gesture warmed. */
const TRACE_SCROLL_PX = 800;

/** Wheel delta per notch — the magnitude a mouse reports; the plot's
 * handler only reads its sign for zoom and pan. */
const WHEEL_NOTCH = 100;

function plotOver(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(".u-over");
}

function traceRows(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(".trace-rows");
}

/** Dispatch a wheel notch near the plot's leading (right) edge — that is
 * where a user zooms when they want a closer look at what is arriving,
 * and it keeps the newest data on screen as the window narrows. */
function wheelAtLeadingEdge(el: HTMLElement, init: WheelEventInit): void {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width * 0.9,
      clientY: r.top + r.height / 2,
      ...init,
    }),
  );
}

function zoom(doc: Document, out: boolean): string | null {
  const el = plotOver(doc);
  if (!el) return null;
  wheelAtLeadingEdge(el, { deltaY: out ? WHEEL_NOTCH : -WHEEL_NOTCH });
  return out ? "plot.zoom-out" : "plot.zoom-in";
}

function pan(doc: Document, forward: boolean): string | null {
  const el = plotOver(doc);
  if (!el) return null;
  // shift+wheel is the plot's x-pan gesture (~10 % of the window per
  // notch); it drops the panel out of follow-live, which the script's
  // `follow-live` slot puts back.
  wheelAtLeadingEdge(el, { deltaY: forward ? WHEEL_NOTCH : -WHEEL_NOTCH, shiftKey: true });
  return forward ? "plot.pan-forward" : "plot.pan-back";
}

function scrollTrace(doc: Document, dy: number): string | null {
  const el = traceRows(doc);
  if (!el) return null;
  el.scrollTop = Math.max(0, el.scrollTop + dy);
  return dy < 0 ? "trace.scroll-up" : "trace.scroll-down";
}

function resumeFollowLive(doc: Document): string | null {
  // The plot toolbar's follow-live control is a chip toggle (ADR 0055):
  // its accessible name identifies it and `aria-pressed` is its
  // position. A gesture the app's own listener would not see is a
  // gesture the capture did not measure, so this has to track the
  // control's real markup.
  const chips = doc.querySelectorAll<HTMLButtonElement>(
    '.plot-panel-toolbar button[aria-label="Follow Live"]',
  );
  for (const chip of chips) {
    if (chip.getAttribute("aria-pressed") === "true") return null;
    chip.click();
    return "plot.follow-live";
  }
  return null;
}

/** The `scrub` cycle. `null` slots are deliberate idle time: the app has
 * to be left alone long enough between gestures to finish the work each
 * one triggered, or the capture measures a queue rather than a cost. */
const SCRUB_CYCLE: Array<((doc: Document) => string | null) | null> = [
  (d) => scrollTrace(d, -TRACE_SCROLL_PX),
  (d) => pan(d, false),
  (d) => pan(d, true),
  (d) => scrollTrace(d, TRACE_SCROLL_PX),
  (d) => zoom(d, true),
  (d) => zoom(d, false),
  (d) => scrollTrace(d, -TRACE_SCROLL_PX / 2),
  (d) => scrollTrace(d, TRACE_SCROLL_PX / 2),
  resumeFollowLive,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
];

/**
 * Perform tick `tick` of `script` against `doc`, returning what it did
 * (or `null` for an idle slot, or a gesture whose target isn't on
 * screen — a project whose layout has no plot or no trace panel is a
 * legitimate capture, just a quieter one).
 *
 * Pure in the sense that matters for testing: the tick number is the
 * only state, so a test can drive the script forward deterministically
 * without a clock.
 */
export function perfInteractTick(
  doc: Document,
  tick: number,
  script: PerfInteractScript,
): string | null {
  if (tick < ZOOM_WARMUP_NOTCHES) return zoom(doc, false);
  if (script === "follow") return null;
  const slot = SCRUB_CYCLE[(tick - ZOOM_WARMUP_NOTCHES) % SCRUB_CYCLE.length];
  return slot ? slot(doc) : null;
}

/**
 * Drive {@link perfInteractTick} on a timer until the returned function
 * is called. Thin glue — the schedule is the only thing it adds.
 */
export function startPerfInteraction(doc: Document, script: PerfInteractScript): () => void {
  let tick = 0;
  const id = window.setInterval(() => {
    perfInteractTick(doc, tick, script);
    tick += 1;
  }, INTERACT_STEP_MS);
  return () => window.clearInterval(id);
}
