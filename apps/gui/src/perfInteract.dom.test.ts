// @vitest-environment jsdom
//
// The synthetic interaction script for the ADR 0031 capture: the
// gestures are real DOM events at real elements, so the thing worth
// pinning is that each slot dispatches the gesture the app's own
// listeners are looking for, and that a cycle leaves the views where it
// found them.

import { beforeEach, describe, expect, it } from "vitest";

import {
  INTERACT_WARMUP_MS,
  INTERACT_STEP_MS,
  parseInteractScript,
  perfInteractTick,
} from "./perfInteract";

/** A stand-in for the panels the script gestures at: uPlot's overlay
 * element, the trace rows pane, and the panel's follow-live checkbox. */
function mountTargets(): { wheels: WheelEvent[]; rows: HTMLElement; box: HTMLInputElement } {
  document.body.innerHTML = `
    <div class="u-over"></div>
    <div class="trace-rows"></div>
    <label class="checkbox"><input type="checkbox" /> follow live</label>
  `;
  const over = document.querySelector<HTMLElement>(".u-over")!;
  // jsdom has no layout, so the element's rect is all zeros and the
  // gesture would land at the origin. Give it a plausible one — where
  // the wheel lands is load-bearing (the plot zooms around the cursor).
  over.getBoundingClientRect = () =>
    ({ left: 100, top: 50, width: 1000, height: 400, right: 1100, bottom: 450, x: 100, y: 50 }) as DOMRect;
  const wheels: WheelEvent[] = [];
  over.addEventListener("wheel", (e) => wheels.push(e as WheelEvent));
  const rows = document.querySelector<HTMLElement>(".trace-rows")!;
  // jsdom has no layout, so `scrollTop` is a plain settable property —
  // enough to assert the gesture moved it.
  rows.scrollTop = 5000;
  const box = document.querySelector<HTMLInputElement>("input[type=checkbox]")!;
  box.checked = true;
  return { wheels, rows, box };
}

/** Run ticks `[from, to)` and collect the labels of what happened. */
function drive(from: number, to: number, script: "scrub" | "follow" = "scrub"): string[] {
  const done: string[] = [];
  for (let t = from; t < to; t++) {
    const what = perfInteractTick(document, t, script);
    if (what) done.push(what);
  }
  return done;
}

const WARMUP_TICKS = INTERACT_WARMUP_MS / INTERACT_STEP_MS;

describe("perfInteractTick", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("zooms the plot in during the warm-up, at the leading edge", () => {
    // A saved plot window can be minutes wide, and a follow-live window
    // wider than the capture sits pinned to the session start — nothing
    // scrolls, and the interaction the capture is meant to measure never
    // happens. The warm-up is what puts the view somewhere real.
    const { wheels } = mountTargets();
    expect(drive(0, WARMUP_TICKS)).toEqual(Array(WARMUP_TICKS).fill("plot.zoom-in"));
    expect(wheels).toHaveLength(WARMUP_TICKS);
    // Zoom in (negative delta), no modifier, anchored right of centre so
    // the newest data stays on screen as the window narrows.
    expect(wheels[0].deltaY).toBeLessThan(0);
    expect(wheels[0].shiftKey).toBe(false);
    expect(wheels[0].clientX).toBeGreaterThan(0);
  });

  it("scrubs both heavy views once the warm-up is done", () => {
    const { wheels, rows } = mountTargets();
    drive(0, WARMUP_TICKS);
    wheels.length = 0;
    const before = rows.scrollTop;
    const done = drive(WARMUP_TICKS, WARMUP_TICKS + 16);
    expect(done).toEqual([
      "trace.scroll-up",
      "plot.pan-back",
      "plot.pan-forward",
      "trace.scroll-down",
      "plot.zoom-out",
      "plot.zoom-in",
      "trace.scroll-up",
      "trace.scroll-down",
    ]);
    // The cycle is net neutral: the rows pane ends where it started, so
    // a long capture scrubs the same region rather than walking off the
    // end of the trace into an unrepresentative one.
    expect(rows.scrollTop).toBe(before);
    // Pans carry the shift modifier (the plot's x-pan gesture); zooms
    // don't (plain wheel is zoom).
    expect(wheels.filter((w) => w.shiftKey)).toHaveLength(2);
    expect(wheels.filter((w) => !w.shiftKey)).toHaveLength(2);
  });

  it("puts follow-live back after the pans that dropped it", () => {
    // Panning x is how a user leaves follow-live, so a script that pans
    // and never resumes measures a parked plot for the rest of the run.
    const { box } = mountTargets();
    drive(0, WARMUP_TICKS);
    box.checked = false; // what the pan gestures do to the real panel
    expect(drive(WARMUP_TICKS + 8, WARMUP_TICKS + 9)).toEqual(["plot.follow-live"]);
    expect(box.checked).toBe(true);
    // Already following: nothing to do, and no spurious click.
    expect(drive(WARMUP_TICKS + 8, WARMUP_TICKS + 9)).toEqual([]);
  });

  it("leaves the window alone after the warm-up under `follow`", () => {
    // The scroll-smoothness gauges measure how evenly the follow-live
    // window advances. A pan moves it by a tenth of the window in one
    // step, which no such meter can tell apart from a stall — so the
    // scenario that answers "is the scroll smooth" has to be gestureless.
    const { wheels, rows } = mountTargets();
    drive(0, WARMUP_TICKS, "follow");
    const at = { wheels: wheels.length, scroll: rows.scrollTop };
    expect(drive(WARMUP_TICKS, WARMUP_TICKS + 64, "follow")).toEqual([]);
    expect(wheels).toHaveLength(at.wheels);
    expect(rows.scrollTop).toBe(at.scroll);
  });

  it("does nothing when the panels aren't in the layout", () => {
    // A project whose saved layout has no plot or no trace panel is a
    // legitimate capture — quieter, not broken.
    expect(() => drive(0, WARMUP_TICKS + 16)).not.toThrow();
    expect(drive(0, WARMUP_TICKS + 16)).toEqual([]);
  });

  it("falls back to the scrubbing script for an unknown name", () => {
    expect(parseInteractScript("follow")).toBe("follow");
    expect(parseInteractScript("scrub")).toBe("scrub");
    // A mistyped script must not silently produce a capture with no
    // interaction in it — that would read as "interaction is free".
    expect(parseInteractScript("srub")).toBe("scrub");
    expect(parseInteractScript(null)).toBe("scrub");
  });
});
