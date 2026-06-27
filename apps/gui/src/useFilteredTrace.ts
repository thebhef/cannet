import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { FilterPredicate, TraceFrameRecord } from "./types";
import { useWindowedQuery, type WindowPage } from "./useWindowedQuery";
import { diagCount } from "./diag"; // DIAG

/// Rows fetched per filtered page. Big enough that ordinary scrolling
/// stays inside the loaded page; small enough that one page is a cheap
/// IPC payload to deserialize on the UI thread.
const PAGE = 512;

/// Minimum spacing between the live "keep up with the trace"
/// refreshes. The filtered view lags the tail by at most this; the
/// throttle bounds both the UI-thread parse cost and the host-side
/// window scans under a high-rate stream.
const REFRESH_MS = 250;

/// Host `fetch_filtered_trace` reply (see `ipc.rs::RowPage`).
interface FilteredTracePage {
  count: number;
  start: number;
  rows: TraceFrameRecord[];
}

/// A paged view of one trace's *filtered* chronological rows. It holds
/// only the visible page in memory — never the whole filtered set, and
/// nothing is truncated: any match is reachable by scrolling, the host
/// pages it in. Mirrors the `count` / `getFrame` / `ensureVisible`
/// surface the chronological `TraceView` consumes.
export interface FilteredTrace {
  count: number;
  version: number;
  getFrame: (matchIndex: number) => TraceFrameRecord | null;
  ensureVisible: (start: number, end: number) => void;
}

/// Page the host-side filtered view of the trace window
/// `[winStart, winEnd)`. `active` is false when the panel has no
/// filter (the caller uses the shared unfiltered cache instead).
///
/// This is a thin adapter over [`useWindowedQuery`]: the generic
/// primitive owns the windowed-source lifecycle (descriptor
/// memoisation, single-flight fetch, re-anchor on scroll-out, drop on a
/// descriptor change), and this layer supplies the filtered-specific
/// `fetchPage` plus the **incremental match-count cursor**. The match
/// count is the filtered view's extent; rather than re-scan the whole
/// window every refresh, a count-only refresh resumes from the last
/// `(count, end)` it knows and the host counts only newly-appended
/// frames — O(Δ) (ADR 0025). The cursor is reconciled to the
/// authoritative total whenever a row page is fetched (which scans the
/// window from its start to position the page).
export function useFilteredTrace(
  active: boolean,
  winStart: number,
  winEnd: number,
  filter: FilterPredicate | null,
  followLive: boolean,
  running: boolean,
): FilteredTrace {
  // Incremental-count cursor: the total match count and the absolute
  // index up to which it has been counted. Reset by a row-page fetch
  // (which reads the authoritative count) and seeded fresh per
  // descriptor (a new window/predicate fetches a page first). Mutated
  // inside the single-flighted `fetchPage`, so reads and writes never
  // overlap.
  const cursor = useRef({ countedEnd: winStart, total: 0 });

  const descriptor =
    active && filter != null ? `${winStart}:${JSON.stringify(filter)}` : "";

  // A new window or predicate invalidates the incremental cursor: reset it
  // to an empty count at the new window start before the first fetch under
  // the new descriptor. The follow-live tail fetch now resumes from the
  // checkpoint too, so without this it would resume from the *previous*
  // descriptor's stale total. The first fetch then counts the window from
  // scratch and reseeds. Declared before `useWindowedQuery` so this effect
  // runs before the one that issues that first fetch.
  useEffect(() => {
    cursor.current = { countedEnd: winStart, total: 0 };
  }, [descriptor, winStart]);

  const fetchPage = useCallback(
    async (
      offset: number,
      limit: number,
      fromEnd: boolean,
    ): Promise<WindowPage<TraceFrameRecord>> => {
      diagCount("invoke.fetch_filtered_trace"); // DIAG
      const countOnly = limit === 0;
      // Both the count-only refresh and the follow-live tail (`fromEnd`)
      // resume from the incremental checkpoint so the host counts only the
      // newly-appended tail (O(Δ)) instead of re-scanning the window. A
      // positioned page (neither) scans from the window start to place
      // itself by match-index, so it ignores the checkpoint.
      const useCheckpoint = countOnly || fromEnd;
      const res = await invoke<FilteredTracePage>("fetch_filtered_trace", {
        filter,
        scanStart: winStart,
        scanEnd: winEnd,
        offset: fromEnd ? 0 : Math.max(0, offset),
        limit,
        fromEnd,
        prevCount: useCheckpoint ? cursor.current.total : null,
        prevCountEnd: useCheckpoint ? cursor.current.countedEnd : null,
      });
      // The host returns the full total either way; advance the cursor
      // so the next checkpoint-using fetch resumes from here.
      cursor.current = { countedEnd: winEnd, total: res.count };
      return { total: res.count, start: res.start, rows: res.rows };
    },
    [filter, winStart, winEnd],
  );

  const { count, version, getRow, ensureVisible } =
    useWindowedQuery<TraceFrameRecord>({
      descriptor,
      fetchPage,
      followLive,
      // `winEnd` advances every grow tick; `running` flips on Start/Stop.
      // Either marks the view stale so the throttled tick refreshes.
      extentSignal: winEnd + (running ? 0 : 1),
      pageSize: PAGE,
      refreshMs: REFRESH_MS,
    });

  return { count, version, getFrame: getRow, ensureVisible };
}
