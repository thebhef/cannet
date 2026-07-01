import { describe, expect, it } from "vitest";

import {
  clearKeepingState,
  clearTraceStartOffset,
  clearedTrace,
  freshTrace,
  pauseTrace,
  reanchorToSession,
  restoredTrace,
  resumeTrace,
  stopTrace,
  traceFrameCount,
  traceStatus,
} from "./trace";

describe("freshTrace / clearedTrace / traceStatus / traceFrameCount", () => {
  it("a fresh trace is running, anchored, and spans the buffer past its start", () => {
    const t = freshTrace(5);
    expect(t).toEqual({ start: 5, end: null, isPaused: false, traceStartOffsetSeconds: null });
    expect(traceStatus(t)).toBe("running");
    expect(traceFrameCount(t, 12)).toBe(7);
    expect(traceFrameCount(t, 5)).toBe(0);
    // Session shrank under the trace — defensive clamp to 0.
    expect(traceFrameCount(t, 2)).toBe(0);
  });

  it("a cleared trace is empty and stopped — it stays put as the buffer grows", () => {
    const t = clearedTrace(7);
    expect(t).toEqual({ start: 7, end: 7, isPaused: false, traceStartOffsetSeconds: null });
    expect(traceStatus(t)).toBe("stopped");
    expect(traceFrameCount(t, 7)).toBe(0);
    expect(traceFrameCount(t, 10_000)).toBe(0);
  });

  it("a restored trace is stopped and spans the whole reloaded buffer", () => {
    const t = restoredTrace(3626);
    expect(t).toEqual({ start: 0, end: 3626, isPaused: false, traceStartOffsetSeconds: null });
    expect(traceStatus(t)).toBe("stopped");
    // It spans every reloaded frame, and stays put as a stopped trace.
    expect(traceFrameCount(t, 3626)).toBe(3626);
    expect(traceFrameCount(t, 5000)).toBe(3626);
  });

  it("clear keeps the run state — running stays running, stopped stopped, paused paused", () => {
    expect(clearKeepingState(freshTrace(2), 9)).toEqual(freshTrace(9)); // running → empty running
    expect(traceStatus(clearKeepingState(stopTrace(freshTrace(2), 5), 9))).toBe("stopped");
    expect(clearKeepingState(stopTrace(freshTrace(2), 5), 9)).toEqual({
      start: 9, end: 9, isPaused: false, traceStartOffsetSeconds: null,
    });
    expect(traceStatus(clearKeepingState(pauseTrace(freshTrace(2), 5), 9))).toBe("paused");
    expect(clearKeepingState(pauseTrace(freshTrace(2), 5), 9)).toEqual({
      start: 9, end: 9, isPaused: true, traceStartOffsetSeconds: null,
    });
  });

  it("clear captures an offsetSeconds, freshTrace/clearedTrace accept one too", () => {
    // The per-view "trace start time" (offset in session-relative
    // seconds) is what Clear / Stop+Start use to re-zero the time
    // column at the moment of the click.
    expect(freshTrace(5, 1.25)).toEqual({
      start: 5, end: null, isPaused: false, traceStartOffsetSeconds: 1.25,
    });
    expect(clearedTrace(7, 0)).toEqual({
      start: 7, end: 7, isPaused: false, traceStartOffsetSeconds: 0,
    });
    expect(clearKeepingState(freshTrace(2), 9, 3.5).traceStartOffsetSeconds).toBe(3.5);
  });
});

describe("stopTrace / pauseTrace / resumeTrace", () => {
  it("stop freezes a running trace and reports 'stopped'", () => {
    const s = stopTrace(freshTrace(5), 20);
    expect(s).toEqual({ start: 5, end: 20, isPaused: false, traceStartOffsetSeconds: null });
    expect(traceStatus(s)).toBe("stopped");
    expect(traceFrameCount(s, 100)).toBe(15); // bounded by the end, not the buffer
  });

  it("pause freezes a running trace and reports 'paused'; pause is a no-op once frozen", () => {
    const p = pauseTrace(freshTrace(5), 20);
    expect(p).toEqual({ start: 5, end: 20, isPaused: true, traceStartOffsetSeconds: null });
    expect(traceStatus(p)).toBe("paused");
    expect(pauseTrace(p, 999)).toBe(p);
    expect(pauseTrace(stopTrace(freshTrace(0), 1), 999).end).toBe(1);
  });

  it("resume continues a paused trace (including the gap) and is a no-op otherwise", () => {
    const p = pauseTrace(freshTrace(5), 20);
    const r = resumeTrace(p);
    expect(r).toEqual({ start: 5, end: null, isPaused: false, traceStartOffsetSeconds: null });
    expect(traceStatus(r)).toBe("running");
    expect(traceFrameCount(r, 100)).toBe(95); // grows again, gap included
    expect(resumeTrace(freshTrace(0))).toEqual(freshTrace(0)); // running: no-op
    expect(resumeTrace(stopTrace(freshTrace(0), 3))).toEqual(stopTrace(freshTrace(0), 3)); // stopped: no-op
  });

  it("stop on a paused trace moves it to stopped, keeping the end", () => {
    const s = stopTrace(pauseTrace(freshTrace(5), 20), 999);
    expect(s).toEqual({ start: 5, end: 20, isPaused: false, traceStartOffsetSeconds: null });
    expect(traceStatus(s)).toBe("stopped");
  });

  it("pause/resume preserve the time-column offset (the user's chosen zero stays put)", () => {
    const s = freshTrace(5, 2.0);
    expect(pauseTrace(s, 20).traceStartOffsetSeconds).toBe(2.0);
    expect(resumeTrace(pauseTrace(s, 20)).traceStartOffsetSeconds).toBe(2.0);
    expect(stopTrace(s, 20).traceStartOffsetSeconds).toBe(2.0);
  });
});

describe("reanchorToSession", () => {
  it("re-anchors a running trace whose start dangled past the new end — still running", () => {
    expect(
      reanchorToSession(
        { start: 1000, end: null, isPaused: false, traceStartOffsetSeconds: null },
        0,
      ),
    ).toEqual(freshTrace(0));
  });

  it("collapses an out-of-range frozen trace to empty at the new end, keeping paused-ness", () => {
    expect(
      reanchorToSession(
        { start: 1000, end: 2000, isPaused: false, traceStartOffsetSeconds: null },
        0,
      ),
    ).toEqual(clearedTrace(0));
    expect(
      reanchorToSession(
        { start: 1000, end: 2000, isPaused: true, traceStartOffsetSeconds: null },
        0,
      ),
    ).toEqual({ start: 0, end: 0, isPaused: true, traceStartOffsetSeconds: null });
  });

  it("trims a stale end", () => {
    expect(
      reanchorToSession(
        { start: 5, end: 100, isPaused: true, traceStartOffsetSeconds: null },
        50,
      ),
    ).toEqual({ start: 5, end: 50, isPaused: true, traceStartOffsetSeconds: null });
  });

  it("is the same object when nothing needs clamping", () => {
    const s = { start: 5, end: 10, isPaused: false, traceStartOffsetSeconds: null };
    expect(reanchorToSession(s, 100)).toBe(s);
  });

  it("preserves the per-view offset on a routine shrink-clamp", () => {
    // `reanchorToSession` is a defensive clamp triggered by buffer
    // shrink; clearing the per-view offset is the App's job on a real
    // session-start change. So a paused/stopped trace whose end gets
    // trimmed must keep its offset.
    const r = reanchorToSession(
      { start: 5, end: 100, isPaused: true, traceStartOffsetSeconds: 2.5 },
      50,
    );
    expect(r.traceStartOffsetSeconds).toBe(2.5);
  });
});

describe("clearTraceStartOffset", () => {
  it("drops a non-null offset and returns a new object", () => {
    const s = { start: 5, end: null, isPaused: false, traceStartOffsetSeconds: 1.5 };
    const r = clearTraceStartOffset(s);
    expect(r.traceStartOffsetSeconds).toBeNull();
    expect(r).not.toBe(s);
  });

  it("is the same object when the offset is already null (lets setState bail)", () => {
    const s = { start: 5, end: null, isPaused: false, traceStartOffsetSeconds: null };
    expect(clearTraceStartOffset(s)).toBe(s);
  });
});
