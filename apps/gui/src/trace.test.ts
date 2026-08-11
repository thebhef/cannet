import { describe, expect, it } from "vitest";

import {
  allDataTrace,
  clearKeepingState,
  clearedTrace,
  freshTrace,
  pauseTrace,
  reanchorToSession,
  restoredTrace,
  resumeTrace,
  stopTrace,
  traceFrameCount,
  traceStatus,
  traceWindow,
} from "./trace";

describe("freshTrace / clearedTrace / traceStatus / traceFrameCount", () => {
  it("a fresh trace is running, anchored, and spans the buffer past its start", () => {
    const t = freshTrace(5);
    expect(t).toEqual({ start: 5, end: null, isPaused: false });
    expect(traceStatus(t)).toBe("running");
    expect(traceFrameCount(t, 12)).toBe(7);
    expect(traceFrameCount(t, 5)).toBe(0);
    // Session shrank under the trace — defensive clamp to 0.
    expect(traceFrameCount(t, 2)).toBe(0);
  });

  it("a cleared trace is empty and stopped — it stays put as the buffer grows", () => {
    const t = clearedTrace(7);
    expect(t).toEqual({ start: 7, end: 7, isPaused: false });
    expect(traceStatus(t)).toBe("stopped");
    expect(traceFrameCount(t, 7)).toBe(0);
    expect(traceFrameCount(t, 10_000)).toBe(0);
  });

  it("a restored trace is stopped and spans the whole reloaded buffer", () => {
    const t = restoredTrace(3626);
    expect(t).toEqual({ start: 0, end: 3626, isPaused: false });
    expect(traceStatus(t)).toBe("stopped");
    // It spans every reloaded frame, and stays put as a stopped trace.
    expect(traceFrameCount(t, 3626)).toBe(3626);
    expect(traceFrameCount(t, 5000)).toBe(3626);
  });

  it("traceWindow clamps the window start up to the low-water mark", () => {
    // No eviction: the window spans the whole running trace.
    const running = freshTrace(0);
    expect(traceWindow(running, 1000, 0)).toEqual({ offset: 0, frameCount: 1000 });
    // Eviction raised the mark to 300 → the window starts there, 700 live rows.
    expect(traceWindow(running, 1000, 300)).toEqual({ offset: 300, frameCount: 700 });
    // A stale floor past the buffer (a Clear left it for a tick) clamps to the
    // buffer rather than going negative.
    expect(traceWindow(running, 1000, 5000)).toEqual({ offset: 1000, frameCount: 0 });
    // A frozen (stopped) window whose span is partly below the mark keeps only
    // the part at/above it.
    const frozen = { start: 0, end: 500, isPaused: false };
    expect(traceWindow(frozen, 1000, 300)).toEqual({ offset: 300, frameCount: 200 });
    // …and one wholly below the mark collapses to empty.
    expect(traceWindow(frozen, 1000, 600)).toEqual({ offset: 600, frameCount: 0 });
  });

  it("clear keeps the run state — running stays running, stopped stopped, paused paused", () => {
    expect(clearKeepingState(freshTrace(2), 9)).toEqual(freshTrace(9)); // running → empty running
    expect(traceStatus(clearKeepingState(stopTrace(freshTrace(2), 5), 9))).toBe("stopped");
    expect(clearKeepingState(stopTrace(freshTrace(2), 5), 9)).toEqual({
      start: 9, end: 9, isPaused: false,
    });
    expect(traceStatus(clearKeepingState(pauseTrace(freshTrace(2), 5), 9))).toBe("paused");
    expect(clearKeepingState(pauseTrace(freshTrace(2), 5), 9)).toEqual({
      start: 9, end: 9, isPaused: true,
    });
  });

  it("all-data widens to the whole buffer keeping the run state — the mirror of clear", () => {
    // Running stays running: still growing with the buffer, just from 0
    // instead of wherever it was — "still following live".
    expect(allDataTrace(freshTrace(2), 9)).toEqual(freshTrace(0));
    expect(traceStatus(allDataTrace(freshTrace(2), 9))).toBe("running");
    // Stopped becomes the full buffer to date, frozen (restoredTrace's shape).
    expect(traceStatus(allDataTrace(stopTrace(freshTrace(2), 5), 9))).toBe("stopped");
    expect(allDataTrace(stopTrace(freshTrace(2), 5), 9)).toEqual({
      start: 0, end: 9, isPaused: false,
    });
    // Paused stays paused, widened to the full buffer.
    expect(traceStatus(allDataTrace(pauseTrace(freshTrace(2), 5), 9))).toBe("paused");
    expect(allDataTrace(pauseTrace(freshTrace(2), 5), 9)).toEqual({
      start: 0, end: 9, isPaused: true,
    });
  });
});

describe("stopTrace / pauseTrace / resumeTrace", () => {
  it("stop freezes a running trace and reports 'stopped'", () => {
    const s = stopTrace(freshTrace(5), 20);
    expect(s).toEqual({ start: 5, end: 20, isPaused: false });
    expect(traceStatus(s)).toBe("stopped");
    expect(traceFrameCount(s, 100)).toBe(15); // bounded by the end, not the buffer
  });

  it("pause freezes a running trace and reports 'paused'; pause is a no-op once frozen", () => {
    const p = pauseTrace(freshTrace(5), 20);
    expect(p).toEqual({ start: 5, end: 20, isPaused: true });
    expect(traceStatus(p)).toBe("paused");
    expect(pauseTrace(p, 999)).toBe(p);
    expect(pauseTrace(stopTrace(freshTrace(0), 1), 999).end).toBe(1);
  });

  it("resume continues a paused trace (including the gap) and is a no-op otherwise", () => {
    const p = pauseTrace(freshTrace(5), 20);
    const r = resumeTrace(p);
    expect(r).toEqual({ start: 5, end: null, isPaused: false });
    expect(traceStatus(r)).toBe("running");
    expect(traceFrameCount(r, 100)).toBe(95); // grows again, gap included
    expect(resumeTrace(freshTrace(0))).toEqual(freshTrace(0)); // running: no-op
    expect(resumeTrace(stopTrace(freshTrace(0), 3))).toEqual(stopTrace(freshTrace(0), 3)); // stopped: no-op
  });

  it("stop on a paused trace moves it to stopped, keeping the end", () => {
    const s = stopTrace(pauseTrace(freshTrace(5), 20), 999);
    expect(s).toEqual({ start: 5, end: 20, isPaused: false });
    expect(traceStatus(s)).toBe("stopped");
  });
});

describe("reanchorToSession", () => {
  it("re-anchors a running trace whose start dangled past the new end — still running", () => {
    expect(
      reanchorToSession({ start: 1000, end: null, isPaused: false }, 0),
    ).toEqual(freshTrace(0));
  });

  it("collapses an out-of-range frozen trace to empty at the new end, keeping paused-ness", () => {
    expect(
      reanchorToSession({ start: 1000, end: 2000, isPaused: false }, 0),
    ).toEqual(clearedTrace(0));
    expect(
      reanchorToSession({ start: 1000, end: 2000, isPaused: true }, 0),
    ).toEqual({ start: 0, end: 0, isPaused: true });
  });

  it("trims a stale end", () => {
    expect(
      reanchorToSession({ start: 5, end: 100, isPaused: true }, 50),
    ).toEqual({ start: 5, end: 50, isPaused: true });
  });

  it("is the same object when nothing needs clamping", () => {
    const s = { start: 5, end: 10, isPaused: false };
    expect(reanchorToSession(s, 100)).toBe(s);
  });
});
