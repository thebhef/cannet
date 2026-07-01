import { useCallback, useEffect, useRef, useState } from "react";

/// The shared windowed-source primitive: one window over a host-paged
/// model, per the Layer-A lifecycle in
/// [ADR 0025](../../docs/adr/0025-frontend-windowed-source-contract.md).
///
/// A view holds only its current window — never the whole (indefinite)
/// model. This hook owns the lifecycle every windowed view shares:
/// memoising the request descriptor so an unchanged window means no
/// round-trip, single-flighting the fetch, re-anchoring when the
/// viewport scrolls out of the loaded page, dropping the window on a
/// descriptor change, and tracking extent (the scrollbar total)
/// separately from window content.
///
/// Two ADR-0025 rules are encoded here:
///
/// - **Extent-advance is not content-change.** A view parked in history
///   updates its scrollbar from a new extent and does *not* re-fetch.
///   When the caller knows the extent cheaply (the raw chrono count from
///   `trace-grew`), it passes `extent` and a parked window never makes a
///   round-trip at all. When it does not (the filtered match count, which
///   the host must scan for), it omits `extent` and a parked stale tick
///   does a **count-only** fetch (`limit === 0`) that re-counts without
///   re-paging.
/// - **The descriptor determines the result.** Window start, filter
///   predicate, sort key, decode settings — anything that changes the
///   rows belongs in `descriptor`. Changing it drops the window and
///   re-anchors; an empty descriptor (`""`) is inactive (no fetch).

/// One page returned by the host: the authoritative `total` for the
/// current descriptor, the absolute `start` index of `rows`, and the
/// rows themselves. A count-only fetch (`limit === 0`) returns
/// `rows: []` and only `total` is read.
export interface WindowPage<T> {
  total: number;
  start: number;
  rows: T[];
}

/// The view-facing surface: `count` (extent, drives the scrollbar),
/// `version` (bumped when window content changes, so consumers
/// re-render and re-consult `getRow`), a random-access row getter, and
/// the prefetch hook the virtualizer calls with its visible range.
export interface WindowedQuery<T> {
  count: number;
  version: number;
  getRow: (index: number) => T | null;
  ensureVisible: (start: number, end: number) => void;
}

export interface WindowedQueryOptions<T> {
  /// Memo key for everything that determines the result (window-invariant
  /// parts: capture identity, filter predicate, sort). `""` = inactive.
  descriptor: string;
  /// Fetch one page. `fromEnd` requests the last `limit` rows (the live
  /// tail); `limit === 0` is a count-only refresh.
  fetchPage: (
    offset: number,
    limit: number,
    fromEnd: boolean,
  ) => Promise<WindowPage<T>>;
  /// True → stale refreshes re-page the tail; false → parked, so a
  /// stale tick re-counts only (and not even that when `extent` is set).
  followLive: boolean;
  /// Bump to mark the window stale (the trace grew, run-state changed).
  extentSignal: number;
  /// The authoritative row total when the caller already knows it
  /// cheaply. When set, the scrollbar tracks it with no round-trip and a
  /// parked stale tick makes no count-only fetch. Omit when only the
  /// host can count (the filtered match count).
  extent?: number;
  /// Optional live-edge overlay consulted by `getRow` for indices past
  /// the loaded page, so follow-live never shows a placeholder at the
  /// tail between throttled re-pages.
  liveTail?: { start: number; rows: T[] } | null;
  /// Rows per fetched window. Big enough that ordinary scrolling stays
  /// inside the loaded page; small enough to stay a cheap IPC payload.
  pageSize?: number;
  /// Minimum spacing between live "keep up" refreshes.
  refreshMs?: number;
}

interface WindowState<T> {
  start: number;
  rows: T[];
  /// Host total for the current descriptor; superseded by `extent` when
  /// the caller supplies one.
  fetchedTotal: number;
  version: number;
}

function emptyWindow<T>(): WindowState<T> {
  return { start: 0, rows: [], fetchedTotal: 0, version: 0 };
}

const DEFAULT_PAGE = 512;
const DEFAULT_REFRESH_MS = 250;

export function useWindowedQuery<T>(
  opts: WindowedQueryOptions<T>,
): WindowedQuery<T> {
  const {
    descriptor,
    fetchPage,
    followLive,
    extentSignal,
    extent,
    liveTail,
    pageSize = DEFAULT_PAGE,
    refreshMs = DEFAULT_REFRESH_MS,
  } = opts;

  const [win, setWin] = useState<WindowState<T>>(emptyWindow);

  // Latest inputs + single-flight control, read by the stable `load`
  // callback. Mutated in render — a plain "latest value" ref, never read
  // for render output.
  const ctl = useRef({
    descriptor: "",
    fetchPage,
    followLive,
    pageSize,
    fetching: false,
    pending: null as
      | { wantStart: number; fromEnd: boolean; countOnly: boolean }
      | null,
    dirty: false,
  });
  ctl.current.fetchPage = fetchPage;
  ctl.current.followLive = followLive;
  ctl.current.pageSize = pageSize;

  const load = useCallback(
    (wantStart: number, fromEnd: boolean, countOnly: boolean) => {
      const c = ctl.current;
      if (c.descriptor === "") return;
      if (c.fetching) {
        // Only the most recent request matters — supersede any pending.
        c.pending = { wantStart, fromEnd, countOnly };
        return;
      }
      c.fetching = true;
      const descriptor = c.descriptor;
      const limit = countOnly ? 0 : c.pageSize;
      void c
        .fetchPage(Math.max(0, wantStart), limit, fromEnd)
        .then((res) => {
          if (ctl.current.descriptor !== descriptor) return; // changed under us
          setWin((p) =>
            countOnly
              ? { ...p, fetchedTotal: res.total, version: p.version + 1 }
              : {
                  start: res.start,
                  rows: res.rows,
                  fetchedTotal: res.total,
                  version: p.version + 1,
                },
          );
        })
        .catch(() => {
          /* keep the last window; a later tick or scroll retries */
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

  // Descriptor changed (capture cleared/reconnected, predicate edited,
  // sort changed) — drop the window and load the first page afresh
  // (immediate; not throttled).
  useEffect(() => {
    ctl.current.descriptor = descriptor;
    setWin((p) => ({ ...emptyWindow<T>(), version: p.version + 1 }));
    if (descriptor === "") return;
    load(0, ctl.current.followLive, false);
  }, [descriptor, load]);

  // Mark stale whenever the model grows or run-state changes. The
  // throttled tick below decides whether that needs a round-trip.
  useEffect(() => {
    ctl.current.dirty = true;
  }, [extentSignal, followLive]);

  // Throttled stale refresh. Following live → re-page the tail. Parked
  // with a known extent → nothing (the scrollbar reads `extent`
  // directly). Parked without a known extent → a count-only refresh so
  // the scrollbar tracks the growing total without re-paging history.
  const extentKnown = extent !== undefined;
  useEffect(() => {
    if (descriptor === "") return;
    const id = window.setInterval(() => {
      const c = ctl.current;
      if (!c.dirty || c.descriptor === "") return;
      c.dirty = false;
      if (c.followLive) load(0, true, false);
      else if (!extentKnown) load(0, false, true);
    }, refreshMs);
    return () => window.clearInterval(id);
  }, [descriptor, extentKnown, refreshMs, load]);

  const getRow = useCallback(
    (index: number): T | null => {
      if (index >= win.start && index < win.start + win.rows.length) {
        return win.rows[index - win.start];
      }
      const tail = liveTail;
      if (tail) {
        const off = index - tail.start;
        if (off >= 0 && off < tail.rows.length) return tail.rows[off];
      }
      return null;
    },
    [win, liveTail],
  );

  const ensureVisible = useCallback(
    (start: number, end: number) => {
      // Already inside the loaded page — nothing to fetch.
      if (start >= win.start && end <= win.start + win.rows.length) return;
      load(Math.max(0, start - Math.floor(pageSize / 4)), false, false);
    },
    [win, pageSize, load],
  );

  const count = extent !== undefined ? extent : win.fetchedTotal;
  return { count, version: win.version, getRow, ensureVisible };
}
