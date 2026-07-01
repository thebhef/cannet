import { createContext, useContext } from "react";

import type { TraceFrameRecord } from "./types";

/**
 * Capture-level state shared by every trace panel.
 *
 * The capture itself lives host-side (`TraceStore`); this carries the
 * shared *model facts* a trace view needs — how many frames exist, the
 * session's zero point — plus the two thin accessors a per-view window
 * is built on (ADR 0025): a raw paged read of the unfiltered
 * chronological rows, and the live-edge tail. Each panel owns its own
 * window over these (`useTrace` → `useWindowedQuery`); the model itself
 * is never held whole frontend-side.
 *
 * Trace panels keep their *own* scroll position, auto-scroll toggle,
 * and expanded-row set — those are per-panel and never live here.
 */
export interface TraceData {
  count: number;
  /// Unix-epoch seconds of the session's zero point. Set by the host's
  /// `start_session` (via the `trace-grew` event); `null` until the
  /// first session-grow tick after a Clear / Connect. Every trace view
  /// renders relative to this, optionally shifted further by its own
  /// per-view `traceStartOffsetSeconds` (panel Clear / Stop+Start).
  sessionStartSeconds: number | null;
  /// Bumped whenever the model's identity changes out from under the
  /// windows — Clear, Connect, project load, a decode-settings/DBC
  /// change, or a buffer shrink. A per-view window folds this into its
  /// descriptor so it drops and re-anchors (ADR 0025).
  epoch: number;
  /// Fetch raw (unfiltered) chronological rows for the absolute index
  /// range `[start, end)` — the unfiltered `RowPage` read. A per-view
  /// window translates its local offset into this absolute range.
  fetchRange: (start: number, end: number) => Promise<TraceFrameRecord[]>;
  /// The newest frames as carried by the most recent `trace-grew`: a
  /// contiguous run ending at the live tip, `start` being the absolute
  /// index of `rows[0]`. A window overlays this so following live never
  /// shows a placeholder at the live edge between fetches.
  liveTail: { start: number; rows: TraceFrameRecord[] };
}

export const TraceDataContext = createContext<TraceData | null>(null);

export function useTraceData(): TraceData {
  const ctx = useContext(TraceDataContext);
  if (!ctx) {
    throw new Error("useTraceData must be used inside a TraceDataContext provider");
  }
  return ctx;
}
