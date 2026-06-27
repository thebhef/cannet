import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { ByIdSnapshotRecord, FilterPredicate } from "./types";
import type { SortState } from "./traceColumns";
import { useWindowedQuery, type WindowPage } from "./useWindowedQuery";
import { diagCount } from "./diag"; // DIAG

/// Rows fetched per by-id page. The by-id set is bounded by id-space (one
/// row per arbitration id), so in practice a single page covers it; the
/// virtualizer fetches more only for a capture with an unusually large id
/// space. Big enough that ordinary scrolling stays inside the loaded
/// page; small enough to stay a cheap IPC payload.
const PAGE = 1024;

/// Spacing between the live "keep up with the trace" refreshes — the
/// by-id values (latest frame, rate, new ids) lag the tail by at most
/// this while running.
const REFRESH_MS = 250;

/// Host `fetch_by_id_page` reply (see `ipc.rs::RowPage`).
interface ByIdPage {
  count: number;
  start: number;
  rows: ByIdSnapshotRecord[];
}

/// A paged, host-sorted view of the by-id snapshot of the trace window
/// `[winStart, winEnd)`. It holds only the visible page — never the whole
/// snapshot — and mirrors the `count` / `getRow` / `ensureVisible`
/// surface the chronological views consume.
export interface ByIdView {
  count: number;
  version: number;
  getRow: (index: number) => ByIdSnapshotRecord | null;
  ensureVisible: (start: number, end: number) => void;
}

/// Page the host-side by-id snapshot of the window `[winStart, winEnd)`,
/// sorted host-side per `sort` and constrained by `filter`. `active` is
/// false when the panel is not in by-id mode.
///
/// A thin adapter over [`useWindowedQuery`], symmetric with
/// [`useFilteredTrace`]: the generic primitive owns the windowed-source
/// lifecycle (descriptor memoisation, single-flight, re-anchor on
/// scroll-out, drop on a descriptor change) and this layer supplies the
/// by-id `fetchPage`. The sort lives in the descriptor — host-side
/// sorting means a *paged* view orders the whole set, so changing the
/// sort re-fetches page 0 afresh. `bus_names` rides along so the host can
/// sort the "bus" column by the project name the user sees.
///
/// While `running`, the throttled refresh re-pages so latest values,
/// rates and newly-seen ids stay live (the by-id set is bounded, so
/// re-paging page 0 covers the common single-page case); stopped/paused,
/// the snapshot is static. Bounding the host scan to `winEnd` (not the
/// live tip) is what makes a paused snapshot reflect the window it shows.
export function useByIdView(
  active: boolean,
  winStart: number,
  winEnd: number,
  sort: SortState,
  filter: FilterPredicate | null,
  busNames: [string, string][],
  running: boolean,
): ByIdView {
  const sortKey = sort?.key ?? null;
  const sortDir = sort?.dir ?? null;
  const descriptor = active
    ? `${winStart}:${sortKey ?? ""}:${sortDir ?? ""}:${JSON.stringify(filter)}`
    : "";

  const fetchPage = useCallback(
    async (
      offset: number,
      limit: number,
    ): Promise<WindowPage<ByIdSnapshotRecord>> => {
      diagCount("invoke.fetch_by_id_page"); // DIAG
      // While running, snapshot to the live tip: pass a past-the-end
      // `scanEnd` so the host clamps it to the buffer length and takes the
      // O(keys) fast path. Bounding to the lagging `winEnd` (the frontend's
      // throttled frame count) instead forces the host's non-chunked
      // window scan — an O(buffer) pass holding the append mutex every
      // refresh tick, which starved rx/tx as the buffer grew. The window
      // bound only matters for a frozen paused/stopped snapshot, where it
      // is scanned once per descriptor change, not on a live tick.
      const scanEnd = running ? Number.MAX_SAFE_INTEGER : winEnd;
      const res = await invoke<ByIdPage>("fetch_by_id_page", {
        filter,
        scanStart: winStart,
        scanEnd,
        sortKey,
        sortDir,
        busNames,
        offset: Math.max(0, offset),
        limit,
      });
      return { total: res.count, start: res.start, rows: res.rows };
    },
    [filter, winStart, winEnd, sortKey, sortDir, busNames, running],
  );

  const { count, version, getRow, ensureVisible } =
    useWindowedQuery<ByIdSnapshotRecord>({
      descriptor,
      fetchPage,
      // While running, re-page so live values / rates / new ids refresh.
      followLive: running,
      // `winEnd` advances every grow tick; `running` flips on Start/Stop.
      extentSignal: winEnd + (running ? 0 : 1),
      pageSize: PAGE,
      refreshMs: REFRESH_MS,
    });

  return { count, version, getRow, ensureVisible };
}
