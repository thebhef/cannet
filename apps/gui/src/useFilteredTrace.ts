import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { FilterPredicate, TraceFrameRecord } from "./types";
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

/// Host `fetch_filtered_trace` reply (see `ipc.rs::FilteredTracePage`).
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

interface PageState {
  count: number;
  start: number;
  rows: TraceFrameRecord[];
  version: number;
}

const EMPTY: PageState = { count: 0, start: 0, rows: [], version: 0 };

/// Page the host-side filtered view of the trace window
/// `[winStart, winEnd)`. `active` is false when the panel has no
/// filter (the caller uses the shared unfiltered cache instead).
///
/// The view stays live across Start / Stop / Clear and as the trace
/// grows: following live re-pages the tail; while parked it does a
/// count-only refresh so the scrollbar tracks the growing total
/// without re-pulling the (stable) history page the user is reading —
/// `ensureVisible` re-pulls rows where they actually scroll. The
/// live refreshes are throttled to `REFRESH_MS`.
export function useFilteredTrace(
  active: boolean,
  winStart: number,
  winEnd: number,
  filter: FilterPredicate | null,
  followLive: boolean,
  running: boolean,
): FilteredTrace {
  const [page, setPage] = useState<PageState>(EMPTY);

  // Latest inputs + single-flight fetch control, read by the stable
  // `load` callback. Mutated in render — a plain "latest value" ref,
  // never read for render output.
  const ctl = useRef({
    ctxKey: "",
    winStart: 0,
    winEnd: 0,
    filter: null as FilterPredicate | null,
    followLive: false,
    fetching: false,
    pending: null as
      | { wantStart: number; fromEnd: boolean; countOnly: boolean }
      | null,
    dirty: false,
  });
  ctl.current.winStart = winStart;
  ctl.current.winEnd = winEnd;
  ctl.current.filter = filter;
  ctl.current.followLive = followLive;

  const load = useCallback(
    (wantStart: number, fromEnd: boolean, countOnly: boolean) => {
      const c = ctl.current;
      if (c.filter == null) return;
      if (c.fetching) {
        // Only the most recent request matters — supersede any pending.
        c.pending = { wantStart, fromEnd, countOnly };
        return;
      }
      c.fetching = true;
      const ctxKey = c.ctxKey;
      diagCount("invoke.fetch_filtered_trace"); // DIAG
      void invoke<FilteredTracePage>("fetch_filtered_trace", {
        filter: c.filter,
        scanStart: c.winStart,
        scanEnd: c.winEnd,
        offset: fromEnd ? 0 : Math.max(0, wantStart),
        limit: countOnly ? 0 : PAGE,
        fromEnd,
      })
        .then((res) => {
          if (ctl.current.ctxKey !== ctxKey) return; // window/filter changed
          setPage((p) =>
            countOnly
              ? { ...p, count: res.count, version: p.version + 1 }
              : {
                  count: res.count,
                  start: res.start,
                  rows: res.rows,
                  version: p.version + 1,
                },
          );
        })
        .catch(() => {
          /* keep the last page; a later tick or scroll retries */
        })
        .finally(() => {
          c.fetching = false;
          if (c.pending) {
            const n = c.pending;
            c.pending = null;
            load(n.wantStart, n.fromEnd, n.countOnly);
          }
        });
    },
    [],
  );

  const ctxKey =
    active && filter != null ? `${winStart}:${JSON.stringify(filter)}` : "";

  // Window start or predicate changed — drop the page and load the
  // first page afresh (immediate; not throttled).
  useEffect(() => {
    ctl.current.ctxKey = ctxKey;
    setPage((p) => ({ ...EMPTY, version: p.version + 1 }));
    if (ctxKey === "") return;
    load(0, ctl.current.followLive, false);
  }, [ctxKey, load]);

  // Mark the view stale whenever the trace grows or its run-state
  // changes — Start / Stop / Clear move `winEnd` / `running`.
  useEffect(() => {
    ctl.current.dirty = true;
  }, [followLive, running, winEnd]);

  // Throttled refresh: at most every `REFRESH_MS`, if stale, re-page.
  // Following live → re-page the tail; parked → a count-only refresh.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      const c = ctl.current;
      if (!c.dirty || c.ctxKey === "") return;
      c.dirty = false;
      if (c.followLive) load(0, true, false);
      else load(0, false, true);
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [active, load]);

  const getFrame = useCallback(
    (i: number) =>
      i >= page.start && i < page.start + page.rows.length
        ? page.rows[i - page.start]
        : null,
    [page],
  );

  const ensureVisible = useCallback(
    (start: number, end: number) => {
      // Already inside the loaded page — nothing to fetch.
      if (start >= page.start && end <= page.start + page.rows.length) return;
      load(Math.max(0, start - Math.floor(PAGE / 4)), false, false);
    },
    [page, load],
  );

  return { count: page.count, version: page.version, getFrame, ensureVisible };
}
