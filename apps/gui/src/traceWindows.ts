// Each element's trace window: a mirror of the host's map.
//
// The host owns the windows (`trace_windows.rs`), beside the session
// buffer they index, so a frontend reload does not move them. This module
// only subscribes to the map and forwards the run controls; it computes
// no window. The paging arithmetic over a window (`traceWindow`,
// `traceFrameCount`, `traceStatus` in `trace.ts`) is read-side and stays
// in the views (ADR 0024, ADR 0025).

import { useCallback } from "react";

import { invoke } from "./ipc";
import type { TraceState } from "./trace";
import { useHostMirror } from "./useHostMirror";

/// Tauri event the host fires whenever any window changes. Must match
/// `trace_windows::TRACE_WINDOWS_CHANGED_EVENT` host-side.
export const TRACE_WINDOWS_CHANGED_EVENT = "trace-windows-changed";

/// Every element's window, keyed by element id.
export type TraceWindows = Readonly<Record<string, TraceState>>;

/// A run control, as the host names it.
export type TraceControl = "start" | "stop" | "pause" | "resume" | "clear" | "allData";

/// The empty map a host that cannot answer leaves us on. Module-level so
/// the mirror's fallback identity never changes.
const NO_WINDOWS: TraceWindows = {};

const fetchTraceWindows = () =>
  invoke<TraceWindows>("get_trace_windows").then((w) => w ?? NO_WINDOWS);

/// Subscribe to the host's trace-window map: the shared host-mirror
/// pattern, with the change event carrying the whole new map. No
/// polling — a running window grows by arithmetic, so the map moves only
/// on a run control, a session (re)start, a restore, an element
/// appearing or leaving, and project open / close.
export function useTraceWindows(): TraceWindows {
  const fetch = useCallback(fetchTraceWindows, []);
  return useHostMirror<TraceWindows, TraceWindows | null>({
    fetch,
    fallback: NO_WINDOWS,
    event: TRACE_WINDOWS_CHANGED_EVENT,
    fromPayload: (payload) => payload ?? NO_WINDOWS,
  }).value;
}

/// Run `action` on element `elementId`'s window. The host applies it at
/// its own frame count and publishes the result; the mirror updates from
/// that, never from a guess made here.
export function controlTraceWindow(elementId: string, action: TraceControl): Promise<void> {
  return invoke<void>("trace_window_control", { elementId, action });
}

/// Hand the host the registry's element ids, whole: it adds a window for
/// each new id, keeps the ones it has, and drops the rest.
export function syncTraceWindows(elementIds: readonly string[]): Promise<void> {
  return invoke<void>("sync_trace_windows", { elementIds });
}
