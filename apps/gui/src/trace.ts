/// A "trace" is a capture window over the session buffer (the host-side
/// `TraceStore` — every frame received since the current connection).
/// It has a start point (an index into the session buffer) and is
/// either *running* (no end — grows with the buffer), *paused* (frozen
/// at an end, will resume from there), or *stopped* (frozen at an end).
/// Each trace-style view (chronological, per-message-id, …) owns one of
/// these; the controls are a common component but the state is
/// per-view. The arithmetic lives here so it's unit-tested without
/// React; `useTrace` is the React glue.

import { useCallback, useEffect, useState } from "react";

import type { TraceData } from "./traceData";
import type { TraceFrameRecord } from "./types";

export type TraceStatus = "running" | "paused" | "stopped";

/// `start` / `end` are session-buffer frame counts; an `end` of `null`
/// means "running, grows with the buffer". `isPaused` distinguishes a
/// paused trace (Resume continues it) from a stopped one (Start begins
/// a fresh window) and is only meaningful when `end !== null`.
export interface TraceState {
  start: number;
  end: number | null;
  isPaused: boolean;
}

/// A fresh, empty, running trace anchored at session count `n`.
export function freshTrace(n: number): TraceState {
  return { start: n, end: null, isPaused: false };
}

export function traceStatus(s: TraceState): TraceStatus {
  if (s.end === null) return "running";
  return s.isPaused ? "paused" : "stopped";
}

/// Number of frames the trace currently spans, given the session
/// buffer's frame count. Clamped to `[0, …]` and to the buffer's
/// bounds (a buffer that shrank under the trace — a new connection — is
/// re-anchored by [`clampToSession`]; this stays defensive regardless).
export function traceFrameCount(s: TraceState, sessionCount: number): number {
  const start = Math.min(s.start, sessionCount);
  const end = Math.min(s.end ?? sessionCount, sessionCount);
  return Math.max(0, end - start);
}

/// Re-anchor a trace if the session buffer shrank out from under it
/// (e.g. a new connection cleared it). No-op otherwise — returns the
/// same object so a `setState` with it bails out.
export function clampToSession(s: TraceState, sessionCount: number): TraceState {
  if (s.start > sessionCount) return freshTrace(sessionCount);
  if (s.end !== null && s.end > sessionCount) return { ...s, end: sessionCount };
  return s;
}

/// Freeze the trace at session count `n` (Stop, or pause→stop). Keeps
/// an existing end if there is one.
export function stopTrace(s: TraceState, n: number): TraceState {
  return { start: s.start, end: s.end ?? n, isPaused: false };
}

/// Freeze the trace at `n`, marked paused so Resume will continue it.
/// No-op if not running.
export function pauseTrace(s: TraceState, n: number): TraceState {
  return s.end === null ? { start: s.start, end: n, isPaused: true } : s;
}

/// Resume a paused trace — it continues, including anything received
/// while paused (it was all in the session buffer). No-op otherwise.
export function resumeTrace(s: TraceState): TraceState {
  return s.end !== null && s.isPaused ? { start: s.start, end: null, isPaused: false } : s;
}

/// What a trace-style panel needs from its trace: the windowed view of
/// the shared capture, plus the controls.
export interface TraceHandle {
  status: TraceStatus;
  /// Frames in the trace's window — the view renders `[0, frameCount)`.
  frameCount: number;
  /// Where the window starts in the session buffer (a count). Views
  /// that query the buffer by absolute index — e.g. the per-message-ID
  /// panel's "latest since" — need this; chronological views use the
  /// windowed `getFrame` / `ensureVisible` and never see it.
  offset: number;
  /// Bumped when the chunk cache changes — pass through to the view.
  version: number;
  /// Timestamp of session row 0 (the time column's zero point). Trace
  /// windows currently share the session's zero point rather than
  /// re-basing per trace.
  baseTimestampSeconds: number | null;
  getFrame: (traceIndex: number) => TraceFrameRecord | null;
  ensureVisible: (start: number, end: number) => void;
  start: () => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  clear: () => void;
}

/// Wrap the shared capture (`useTraceData()`) in a per-view trace
/// window with start / stop / pause / resume / clear.
export function useTrace(data: TraceData): TraceHandle {
  const sessionCount = data.count;
  const [state, setState] = useState<TraceState>(() => freshTrace(0));

  // Re-anchor if a new connection replaced the session buffer underneath.
  useEffect(() => {
    setState((s) => clampToSession(s, sessionCount));
  }, [sessionCount]);

  const offset = Math.min(state.start, sessionCount);
  const frameCount = traceFrameCount(state, sessionCount);

  const getFrame = useCallback((i: number) => data.getFrame(offset + i), [data, offset]);
  const ensureVisible = useCallback(
    (a: number, b: number) => data.ensureVisible(offset + a, offset + b),
    [data, offset],
  );

  const start = useCallback(() => setState(freshTrace(data.count)), [data]);
  const stop = useCallback(() => setState((s) => stopTrace(s, data.count)), [data]);
  const pause = useCallback(() => setState((s) => pauseTrace(s, data.count)), [data]);
  const resume = useCallback(() => setState(resumeTrace), []);

  return {
    status: traceStatus(state),
    frameCount,
    offset,
    version: data.version,
    baseTimestampSeconds: data.baseTimestampSeconds,
    getFrame,
    ensureVisible,
    start,
    stop,
    pause,
    resume,
    clear: start, // Clear is just "fresh trace from now", same as stop→start.
  };
}
