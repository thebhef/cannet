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
///
/// `traceStartOffsetSeconds` shifts the time column's zero point
/// forward into the session — `null` means "use the session start"
/// (display = frame.ts - sessionStart). A positive value means "this
/// many seconds after session start is my zero" (display =
/// frame.ts - sessionStart - offset). Set on Clear and on Stop→Start,
/// left alone on Pause→Resume, cleared on a new session (Connect).
export interface TraceState {
  start: number;
  end: number | null;
  isPaused: boolean;
  traceStartOffsetSeconds: number | null;
}

/// A fresh, empty, *running* trace anchored at session count `n` and
/// (optionally) at `offsetSeconds` into the session timeline. Used by
/// Start / clear; pass `null` for offset on the initial state and on
/// session-start (Connect), pass a number to anchor the time column at
/// "now" in session-relative seconds.
export function freshTrace(n: number, offsetSeconds: number | null = null): TraceState {
  return { start: n, end: null, isPaused: false, traceStartOffsetSeconds: offsetSeconds };
}

/// An empty, *stopped* trace anchored at session count `n` and
/// (optionally) at `offsetSeconds` into the session timeline.
export function clearedTrace(n: number, offsetSeconds: number | null = null): TraceState {
  return { start: n, end: n, isPaused: false, traceStartOffsetSeconds: offsetSeconds };
}

/// Clear the trace (wipe its window to empty at `n` and re-anchor the
/// time column at `offsetSeconds` into the session) while keeping
/// whatever run state it was in — running stays running (it just keeps
/// growing from `n`), stopped stays stopped, paused stays paused.
/// Clear, deliberately, does *not* imply Stop or Pause.
export function clearKeepingState(
  s: TraceState,
  n: number,
  offsetSeconds: number | null = null,
): TraceState {
  return s.end === null
    ? freshTrace(n, offsetSeconds)
    : { ...clearedTrace(n, offsetSeconds), isPaused: s.isPaused };
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
/// (e.g. a new connection or "New project" cleared it). A *running*
/// trace whose start dangled past the new end restarts empty (still
/// running); a *frozen* (stopped / paused) one whose window is now out
/// of range collapses to an empty window at the new end, keeping its
/// paused-ness — so it stays stopped/paused rather than coming back to
/// life. No-op otherwise — returns the same object so a `setState` with
/// it bails out.
///
/// The per-view time-column offset is *preserved* here. Clearing it on
/// a true session restart is the job of [`clearTraceStartOffset`],
/// driven by `sessionStartSeconds` change — buffer shrink alone is
/// only a defensive clamp and doesn't necessarily mean a new session.
export function reanchorToSession(s: TraceState, sessionCount: number): TraceState {
  if (s.end === null) return s.start > sessionCount ? freshTrace(sessionCount) : s;
  if (s.start > sessionCount)
    return {
      ...clearedTrace(sessionCount),
      isPaused: s.isPaused,
      traceStartOffsetSeconds: s.traceStartOffsetSeconds,
    };
  if (s.end > sessionCount) return { ...s, end: sessionCount };
  return s;
}

/// Drop the per-view time-column offset. Used by the App on every
/// session-start change so each trace falls back to displaying frames
/// relative to the session start (the user's Clear / Stop+Start choice
/// from the previous session no longer makes sense in a fresh one).
/// Returns the same object if there was no offset to drop, so a
/// `setState` with it bails out.
export function clearTraceStartOffset(s: TraceState): TraceState {
  if (s.traceStartOffsetSeconds === null) return s;
  return { ...s, traceStartOffsetSeconds: null };
}

/// Freeze the trace at session count `n` (Stop, or pause→stop). Keeps
/// an existing end and the time-column offset if there is one.
export function stopTrace(s: TraceState, n: number): TraceState {
  return {
    start: s.start,
    end: s.end ?? n,
    isPaused: false,
    traceStartOffsetSeconds: s.traceStartOffsetSeconds,
  };
}

/// Freeze the trace at `n`, marked paused so Resume will continue it.
/// No-op if not running. Time-column offset is preserved — Pause/Resume
/// is meant to keep the same view.
export function pauseTrace(s: TraceState, n: number): TraceState {
  return s.end === null
    ? { start: s.start, end: n, isPaused: true, traceStartOffsetSeconds: s.traceStartOffsetSeconds }
    : s;
}

/// Resume a paused trace — it continues, including anything received
/// while paused (it was all in the session buffer). The time-column
/// offset is preserved. No-op otherwise.
export function resumeTrace(s: TraceState): TraceState {
  return s.end !== null && s.isPaused
    ? { start: s.start, end: null, isPaused: false, traceStartOffsetSeconds: s.traceStartOffsetSeconds }
    : s;
}

/// Session-relative seconds of the latest frame in the buffer, or
/// `null` if either the session hasn't started or no frames have
/// arrived yet. Used by Clear / Start to capture the user's "now"
/// reference as a session offset — so the time column re-zeros at the
/// moment of the click rather than at session start.
function currentSessionOffsetSeconds(data: TraceData): number | null {
  if (data.sessionStartSeconds === null || data.count === 0) return null;
  const tip = data.getFrame(data.count - 1);
  if (!tip) return null;
  return tip.timestamp_seconds - data.sessionStartSeconds;
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
  /// Effective zero point for the time column in seconds (Unix epoch).
  /// Combines the session start (`data.sessionStartSeconds`) with the
  /// per-view trace start offset (Clear / Stop+Start). `null` until a
  /// session is configured.
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
  const state = reg.get(elementId)?.trace ?? clearedTrace(0);

  const offset = Math.min(state.start, sessionCount);
  const frameCount = traceFrameCount(state, sessionCount);

  const baseTimestampSeconds =
    data.sessionStartSeconds === null
      ? null
      : data.sessionStartSeconds + (state.traceStartOffsetSeconds ?? 0);

  const getFrame = useCallback((i: number) => data.getFrame(offset + i), [data, offset]);
  const ensureVisible = useCallback(
    (a: number, b: number) => data.ensureVisible(offset + a, offset + b),
    [data, offset],
  );

  const { updateTrace } = reg;
  const start = useCallback(
    () => updateTrace(elementId, () => freshTrace(data.count, currentSessionOffsetSeconds(data))),
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
    () =>
      updateTrace(elementId, (s) =>
        clearKeepingState(s, data.count, currentSessionOffsetSeconds(data)),
      ),
    [updateTrace, elementId, data],
  );

  return {
    status: traceStatus(state),
    frameCount,
    offset,
    version: data.version,
    baseTimestampSeconds,
    getFrame,
    ensureVisible,
    start,
    stop,
    pause,
    resume,
    clear,
  };
}
