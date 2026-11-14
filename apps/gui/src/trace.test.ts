import { describe, expect, it } from "vitest";

import { traceFrameCount, traceStatus, traceWindow, type TraceState } from "./trace";

// The window arithmetic (fresh, clear, stop, pause, resume, all data,
// re-anchor) is the host's and is tested there (`trace_windows.rs`). What
// stays here is the read side a view pages with.

const running = (start: number): TraceState => ({ start, end: null, isPaused: false });
const stopped = (start: number, end: number): TraceState => ({ start, end, isPaused: false });
const paused = (start: number, end: number): TraceState => ({ start, end, isPaused: true });

describe("traceStatus / traceFrameCount", () => {
  it("a running window spans the buffer past its start", () => {
    const t = running(5);
    expect(traceStatus(t)).toBe("running");
    expect(traceFrameCount(t, 12)).toBe(7);
    expect(traceFrameCount(t, 5)).toBe(0);
    // Session shrank under the trace — defensive clamp to 0.
    expect(traceFrameCount(t, 2)).toBe(0);
  });

  it("an empty stopped window stays put as the buffer grows", () => {
    const t = stopped(7, 7);
    expect(traceStatus(t)).toBe("stopped");
    expect(traceFrameCount(t, 7)).toBe(0);
    expect(traceFrameCount(t, 10_000)).toBe(0);
  });

  it("a stopped whole-buffer window spans every frame and stays put", () => {
    const t = stopped(0, 3626);
    expect(traceFrameCount(t, 3626)).toBe(3626);
    expect(traceFrameCount(t, 5000)).toBe(3626);
  });

  it("a frozen window is bounded by its end, not the buffer; paused reads paused", () => {
    expect(traceFrameCount(stopped(5, 20), 100)).toBe(15);
    expect(traceStatus(paused(5, 20))).toBe("paused");
    expect(traceFrameCount(paused(5, 20), 100)).toBe(15);
  });
});

describe("traceWindow", () => {
  it("clamps the window start up to the low-water mark", () => {
    // No eviction: the window spans the whole running trace.
    expect(traceWindow(running(0), 1000, 0)).toEqual({ offset: 0, frameCount: 1000 });
    // Eviction raised the mark to 300 → the window starts there, 700 live rows.
    expect(traceWindow(running(0), 1000, 300)).toEqual({ offset: 300, frameCount: 700 });
    // A stale floor past the buffer (a Clear left it for a tick) clamps to the
    // buffer rather than going negative.
    expect(traceWindow(running(0), 1000, 5000)).toEqual({ offset: 1000, frameCount: 0 });
    // A frozen (stopped) window whose span is partly below the mark keeps only
    // the part at/above it.
    expect(traceWindow(stopped(0, 500), 1000, 300)).toEqual({ offset: 300, frameCount: 200 });
    // …and one wholly below the mark collapses to empty.
    expect(traceWindow(stopped(0, 500), 1000, 600)).toEqual({ offset: 600, frameCount: 0 });
  });
});
