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
import type { TimelineEvent } from "./notes";
import { useElementRegistry } from "./projectElements";
import { useWindowedQuery, type WindowPage } from "./useWindowedQuery";

/// A row in a trace-style view (ADR 0035): the common base the single
/// TraceView renderer draws, either a CAN frame or a timeline event. The
/// `row` discriminant picks the cell layout. Events carry no frame index,
/// so the merge into this stream happens at the *view*, by timestamp —
/// frames stay index-paged (ADR 0025), events are fetched whole (ADR 0035).
export type TraceRow =
  | { row: "frame"; frame: TraceFrameRecord }
  | { row: "event"; event: TimelineEvent };

/// Rows fetched per unfiltered-chrono window. Big enough that ordinary
/// scrolling stays inside the loaded page (the view shows ~tens of rows
/// at a time); small enough to stay a cheap IPC payload per fetch.
const CHRONO_PAGE = 1000;

export type TraceStatus = "running" | "paused" | "stopped";

/// `start` / `end` are session-buffer frame counts; an `end` of `null`
/// means "running, grows with the buffer". `isPaused` distinguishes a
/// paused trace (Resume continues it) from a stopped one (Start begins
/// a fresh window) and is only meaningful when `end !== null`.
///
/// Every renderer roots its time column at the one application-level
/// trace start — `data.sessionStartSeconds` (ADR 0024) — so the window
/// state carries no per-view time offset.
export interface TraceState {
  start: number;
  end: number | null;
  isPaused: boolean;
}

/// A fresh, empty, *running* trace anchored at session count `n`. Used
/// by Start / clear.
export function freshTrace(n: number): TraceState {
  return { start: n, end: null, isPaused: false };
}

/// An empty, *stopped* trace anchored at session count `n`.
export function clearedTrace(n: number): TraceState {
  return { start: n, end: n, isPaused: false };
}

/// A *stopped* trace spanning the whole restored session buffer `[0, n)`.
/// Used when a prior capture is reloaded on project open (ADR 0002 DS-7):
/// the view shows the reloaded history, frozen (it isn't live), with the
/// time column rooted at the session start the host restored.
export function restoredTrace(n: number): TraceState {
  return { start: 0, end: n, isPaused: false };
}

/// Clear the trace (wipe its window to empty at `n`) while keeping
/// whatever run state it was in — running stays running (it just keeps
/// growing from `n`), stopped stays stopped, paused stays paused.
/// Clear, deliberately, does *not* imply Stop or Pause.
export function clearKeepingState(s: TraceState, n: number): TraceState {
  return s.end === null
    ? freshTrace(n)
    : { ...clearedTrace(n), isPaused: s.isPaused };
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

/// The chronological window's absolute range `[offset, offset + frameCount)`
/// over the session buffer, clamped to the windowed-ring low-water mark
/// `firstIndex` (ADR 0002 DS-8): rows below the mark were truncated off
/// disk, so the window starts at `max(start, firstIndex)` and never renders
/// evicted rows as blank placeholders. `firstIndex` is itself clamped to the
/// buffer so a stale floor left by a Clear / new session for a tick can't
/// push the window out of range. Pure so it's unit-tested without React.
export function traceWindow(
  s: TraceState,
  sessionCount: number,
  firstIndex: number,
): { offset: number; frameCount: number } {
  const floor = Math.min(Math.max(0, firstIndex), sessionCount);
  const end = Math.min(s.end ?? sessionCount, sessionCount);
  const offset = Math.max(Math.min(s.start, sessionCount), floor);
  return { offset, frameCount: Math.max(0, end - offset) };
}

/// Re-anchor a trace if the session buffer shrank out from under it
/// (e.g. a new connection or "New project" cleared it). A *running*
/// trace whose start dangled past the new end restarts empty (still
/// running); a *frozen* (stopped / paused) one whose window is now out
/// of range collapses to an empty window at the new end, keeping its
/// paused-ness — so it stays stopped/paused rather than coming back to
/// life. No-op otherwise — returns the same object so a `setState` with
/// it bails out.
export function reanchorToSession(s: TraceState, sessionCount: number): TraceState {
  if (s.end === null) return s.start > sessionCount ? freshTrace(sessionCount) : s;
  if (s.start > sessionCount) return { ...clearedTrace(sessionCount), isPaused: s.isPaused };
  if (s.end > sessionCount) return { ...s, end: sessionCount };
  return s;
}

/// Freeze the trace at session count `n` (Stop, or pause→stop). Keeps
/// an existing end.
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
  return s.end !== null && s.isPaused
    ? { start: s.start, end: null, isPaused: false }
    : s;
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
  /// Bumped when the window's loaded rows change — pass through to the
  /// view so it re-renders and re-consults `getFrame`.
  version: number;
  /// Zero point for the time column in seconds (Unix epoch): the single
  /// application-level trace start, `data.sessionStartSeconds` (ADR 0024).
  /// `null` until a session is configured.
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
///
/// `rows` says whether the caller draws frame rows. Only the unfiltered
/// chronological table does; the plot, the signals view and a by-id
/// trace read the window's bounds and run state and nothing else. Pass
/// `false` there — the window is otherwise re-paged (a thousand decoded
/// frames, fetched and dropped) on every Clear / Connect / DBC reload /
/// Start / Stop, once per open panel. `getFrame` then always returns
/// `null`; every other field is unaffected.
export function useTrace(data: TraceData, elementId: string, rows: boolean): TraceHandle {
  const reg = useElementRegistry();
  const sessionCount = data.count;
  const state = reg.get(elementId)?.trace ?? clearedTrace(0);

  // Clamp the window start up to the windowed-ring low-water mark (ADR 0002
  // DS-8) so truncated rows below the floor aren't rendered as placeholders.
  const { offset, frameCount } = traceWindow(state, sessionCount, data.firstIndex);

  // Every renderer shows elapsed time since the one application-level trace
  // start (ADR 0024): the session-buffer start.
  const baseTimestampSeconds = data.sessionStartSeconds;

  // This panel's window over the unfiltered chronological rows
  // `[offset, offset + frameCount)`, indexed locally `[0, frameCount)`.
  // The window holds only the visible page; the host pages the rest.
  // `extent` is `frameCount` (known cheaply here), so an extent advance
  // while parked never re-fetches (ADR 0025); the auto-scrolling view
  // drives fetches via `ensureVisible`, and `liveTail` covers the live
  // edge between them, so no background re-page is needed.
  const fetchPage = useCallback(
    async (
      localOffset: number,
      limit: number,
      fromEnd: boolean,
    ): Promise<WindowPage<TraceFrameRecord>> => {
      const winEnd = offset + frameCount;
      const absStart = fromEnd
        ? Math.max(offset, winEnd - limit)
        : offset + localOffset;
      const absEnd = Math.min(winEnd, absStart + limit);
      const rows = absEnd > absStart ? await data.fetchRange(absStart, absEnd) : [];
      return { total: frameCount, start: absStart - offset, rows };
    },
    [data, offset, frameCount],
  );

  const win = useWindowedQuery<TraceFrameRecord>({
    // An empty descriptor is the primitive's "inactive" state (ADR
    // 0025): no fetch, no refresh tick, `getRow` always `null`.
    descriptor: rows ? `${data.epoch}:${offset}` : "",
    fetchPage,
    followLive: false,
    extentSignal: data.count,
    extent: frameCount,
    liveTail: rows ? { start: data.liveTail.start - offset, rows: data.liveTail.rows } : null,
    pageSize: CHRONO_PAGE,
  });
  const getFrame = win.getRow;
  const ensureVisible = win.ensureVisible;

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
    () => updateTrace(elementId, (s) => clearKeepingState(s, data.count)),
    [updateTrace, elementId, data],
  );

  return {
    status: traceStatus(state),
    frameCount,
    offset,
    version: win.version,
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
