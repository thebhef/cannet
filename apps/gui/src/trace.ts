/// A "trace" is a capture window over the session buffer (the host-side
/// `TraceStore` — every frame received since the current connection).
/// It has a start point (an index into the session buffer) and is
/// either *running* (no end — grows with the buffer), *paused* (frozen
/// at an end, will resume from there), or *stopped* (frozen at an end).
/// Each trace-style view (chronological, per-message-id, …) shows one
/// trace *element*. The window is host state (`trace_windows.rs`), so it
/// survives the panel closing and the frontend reloading; the element
/// registry (`projectElements.ts`) mirrors it, and the run controls are
/// host commands. What stays here is the read side — the arithmetic a
/// view pages with over the mirrored window and the live count — and
/// `useTrace`, the React glue between a panel and its element.

import { useCallback } from "react";

import { useTraceLive, useTraceModel } from "./traceData";
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

/// The window a view reads before the host's mirror has one for its
/// element: empty and stopped at 0.
export const NO_TRACE: TraceState = { start: 0, end: 0, isPaused: false };

export function traceStatus(s: TraceState): TraceStatus {
  if (s.end === null) return "running";
  return s.isPaused ? "paused" : "stopped";
}

/// Number of frames the trace currently spans, given the session
/// buffer's frame count. Clamped to `[0, …]` and to the buffer's
/// bounds (a buffer that shrank under the trace — a new connection — is
/// re-anchored by the host; this stays defensive regardless).
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
  /// Widen the window to the whole session buffer, keeping its run
  /// state — the "All Data" button.
  allData: () => void;
}

/// Bind a panel to the trace `elementId`: a window over the shared
/// capture (the trace contexts), with start / stop / pause /
/// resume / clear / all data. The window is the registry's mirror of the
/// host's; until the host has one for this element this reads
/// [`NO_TRACE`]. The controls go to the host, which answers through the
/// mirror — nothing here moves the window.
///
/// `rows` says whether the caller draws frame rows. Only the unfiltered
/// chronological table does; the plot, the signals view and a by-id
/// trace read the window's bounds and run state and nothing else. Pass
/// `false` there — the window is otherwise re-paged (a thousand decoded
/// frames, fetched and dropped) on every Clear / Connect / DBC reload /
/// Start / Stop, once per open panel. `getFrame` then always returns
/// `null`; every other field is unaffected.
export function useTrace(elementId: string, rows: boolean): TraceHandle {
  const reg = useElementRegistry();
  // Both halves: the window arithmetic is a function of the live capture,
  // and the paging descriptor of the model's identity.
  const model = useTraceModel();
  const live = useTraceLive();
  const sessionCount = live.count;
  const state = reg.get(elementId)?.trace ?? NO_TRACE;

  // Clamp the window start up to the windowed-ring low-water mark (ADR 0002
  // DS-8) so truncated rows below the floor aren't rendered as placeholders.
  const { offset, frameCount } = traceWindow(state, sessionCount, live.firstIndex);

  // Every renderer shows elapsed time since the one application-level trace
  // start (ADR 0024): the session-buffer start.
  const baseTimestampSeconds = model.sessionStartSeconds;

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
      const rows = absEnd > absStart ? await model.fetchRange(absStart, absEnd) : [];
      return { total: frameCount, start: absStart - offset, rows };
    },
    [model, offset, frameCount],
  );

  const win = useWindowedQuery<TraceFrameRecord>({
    // An empty descriptor is the primitive's "inactive" state (ADR
    // 0025): no fetch, no refresh tick, `getRow` always `null`.
    descriptor: rows ? `${model.epoch}:${offset}` : "",
    fetchPage,
    followLive: false,
    extentSignal: live.count,
    extent: frameCount,
    liveTail: rows ? { start: live.liveTail.start - offset, rows: live.liveTail.rows } : null,
  });
  const getFrame = win.getRow;
  const ensureVisible = win.ensureVisible;

  const { controlTrace } = reg;
  const start = useCallback(() => controlTrace(elementId, "start"), [controlTrace, elementId]);
  const stop = useCallback(() => controlTrace(elementId, "stop"), [controlTrace, elementId]);
  const pause = useCallback(() => controlTrace(elementId, "pause"), [controlTrace, elementId]);
  const resume = useCallback(() => controlTrace(elementId, "resume"), [controlTrace, elementId]);
  const clear = useCallback(() => controlTrace(elementId, "clear"), [controlTrace, elementId]);
  const allData = useCallback(() => controlTrace(elementId, "allData"), [controlTrace, elementId]);

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
    allData,
  };
}
