import { createContext, useContext } from "react";

import type { TraceFrameRecord } from "./types";

/**
 * Capture-level state shared by every trace panel.
 *
 * The capture itself lives host-side (`TraceStore`); this is the
 * frontend view-cache plumbing a trace view needs: how many frames
 * exist, a getter that returns a (cached, decoded) row by absolute
 * index, and a callback the view calls to ask the host to fetch the
 * chunks covering its viewport. `version` is bumped whenever cached
 * rows change so consumers re-render and re-consult `getFrame`.
 *
 * Trace panels keep their *own* scroll position, auto-scroll toggle,
 * and expanded-row set — those are per-panel and never live here.
 */
export interface TraceData {
  count: number;
  version: number;
  baseTimestampSeconds: number | null;
  getFrame: (absoluteIndex: number) => TraceFrameRecord | null;
  ensureVisible: (start: number, end: number) => void;
}

export const TraceDataContext = createContext<TraceData | null>(null);

export function useTraceData(): TraceData {
  const ctx = useContext(TraceDataContext);
  if (!ctx) {
    throw new Error("useTraceData must be used inside a TraceDataContext provider");
  }
  return ctx;
}
