/// A "trace" is a capture window over the session buffer (the host-side
/// `TraceStore` — every frame received since the current connection).
/// It has a start point (an index into the session buffer) and is
/// either *running* (no end — grows with the buffer), *paused* (frozen
/// at an end, will resume from there), or *stopped* (frozen at an end).
/// Each trace-style view (chronological, per-message-id, …) shows one
/// trace *element*; the window state lives in the element registry
/// (`projectElements.ts`), not in the panel, so it survives the panel
/// closing. The arithmetic lives here so it's unit-tested without
/// React; `useTrace` is the React glue between a panel and its element.

import { useCallback } from "react";

import type { TraceData } from "./traceData";
import type { TraceFrameRecord } from "./types";
import { useElementRegistry } from "./projectElements";

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

/// A fresh, empty, *running* trace anchored at session count `n` — the
/// Start action (and the initial state).
export function freshTrace(n: number): TraceState {
  return { start: n, end: null, isPaused: false };
}

/// An empty, *stopped* trace anchored at session count `n` — the Clear
/// action: it wipes the window and sets the stop time, so nothing
/// accumulates until the user hits Start (which gives a `freshTrace`).
export function clearedTrace(n: number): TraceState {
  return { start: n, end: n, isPaused: false };
}

export function traceStatus(s: TraceState): TraceStatus {
  if (s.end === null) return "running";
  return s.isPaused ? "paused" : "stopped";
}

/// Number of frames the trace currently spans, given the session
/// buffer's frame count. Clamped to `[0, …]` and to the buffer's
/// bounds (a buffer that shrank under the trace — a new connection — is
/// re-anchored by [`reanchorToSession`]; this stays defensive
/// regardless).
export function traceFrameCount(s: TraceState, sessionCount: number): number {
  const start = Math.min(s.start, sessionCount);
  const end = Math.min(s.end ?? sessionCount, sessionCount);
  return Math.max(0, end - start);
}

/// Re-anchor a trace if the session buffer shrank out from under it
/// (e.g. a new connection cleared it). No-op otherwise — returns the
/// same object so a `setState` with it bails out.
export function reanchorToSession(s: TraceState, sessionCount: number): TraceState {
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

/// Bind a panel to the trace `elementId`: a window over the shared
/// capture (`data`, from `useTraceData()`), with start / stop / pause /
/// resume / clear. The window state lives in the element registry — the
/// panel must have ensured the entry exists (`reg.ensureTrace`); until
/// then this falls back to a fresh window.
export function useTrace(data: TraceData, elementId: string): TraceHandle {
  const reg = useElementRegistry();
  const sessionCount = data.count;
  const state = reg.get(elementId)?.trace ?? freshTrace(0);

  const offset = Math.min(state.start, sessionCount);
  const frameCount = traceFrameCount(state, sessionCount);

  const getFrame = useCallback((i: number) => data.getFrame(offset + i), [data, offset]);
  const ensureVisible = useCallback(
    (a: number, b: number) => data.ensureVisible(offset + a, offset + b),
    [data, offset],
  );

  const { updateTrace } = reg;
  const start = useCallback(
    () => updateTrace(elementId, () => freshTrace(data.count)),
    [updateTrace, elementId, data],
  );
  const stop = useCallback(
    () => updateTrace(elementId, (s) => stopTrace(s, data.count)),
    [updateTrace, elementId, data],
  );
  const pause = useCallback(
    () => updateTrace(elementId, (s) => pauseTrace(s, data.count)),
    [updateTrace, elementId, data],
  );
  const resume = useCallback(() => updateTrace(elementId, resumeTrace), [updateTrace, elementId]);
  const clear = useCallback(
    () => updateTrace(elementId, () => clearedTrace(data.count)),
    [updateTrace, elementId, data],
  );

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
    clear,
  };
}
