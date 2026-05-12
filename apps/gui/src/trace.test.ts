import { describe, expect, it } from "vitest";

import {
  clampToSession,
  clearedTrace,
  freshTrace,
  pauseTrace,
  resumeTrace,
  stopTrace,
  traceFrameCount,
  traceStatus,
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

describe("clampToSession", () => {
  it("re-anchors when the buffer shrank below the start", () => {
    expect(clampToSession({ start: 1000, end: 2000, isPaused: false }, 0)).toEqual(freshTrace(0));
  });

  it("trims a stale end", () => {
    expect(clampToSession({ start: 5, end: 100, isPaused: true }, 50)).toEqual({
      start: 5,
      end: 50,
      isPaused: true,
    });
  });

  it("is the same object when nothing needs clamping", () => {
    const s = { start: 5, end: 10, isPaused: false };
    expect(clampToSession(s, 100)).toBe(s);
  });
});
