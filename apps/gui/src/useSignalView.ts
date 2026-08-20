import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { SignalPageRow, SignalSectionsWire, SignalSelectionWire } from "./types";
import type { SignalSortState } from "./signalColumns";
import { useWindowedQuery, type WindowPage } from "./useWindowedQuery";
import { diagCount } from "./diag"; // DIAG

/// Host `fetch_signal_page` reply (see `ipc.rs::RowPage`).
interface SignalPage {
  count: number;
  start: number;
  rows: SignalPageRow[];
}

/// A paged, host-sorted latest-per-signal snapshot of the trace window,
/// plus the host's selection error (an invalid pattern the frontend's
/// JS-regex validation didn't catch — the two dialects differ).
export interface SignalView {
  count: number;
  version: number;
  getRow: (index: number) => SignalPageRow | null;
  ensureVisible: (start: number, end: number) => void;
  error: string | null;
}

/// Page the host-side per-signal snapshot of `[winStart, winEnd)` —
/// `useByIdView`'s per-signal sibling, over the same windowed-source
/// primitive. Selection, sectioning, sort, and paging all evaluate
/// host-side (`fetch_signal_page`); the panel holds only the visible
/// page, and a page row is a signal *or* a section header — the header
/// occupies a row slot, so `count` is the fold-aware extent and the
/// panel's viewport arithmetic stays one uniform row space.
export function useSignalView(
  active: boolean,
  winStart: number,
  winEnd: number,
  selection: SignalSelectionWire,
  sections: SignalSectionsWire,
  sort: SignalSortState,
  busNames: [string, string][],
  sourceBuses: readonly string[] | null,
  running: boolean,
): SignalView {
  const sortKey = sort?.key ?? null;
  const sortDir = sort?.dir ?? null;
  const [error, setError] = useState<string | null>(null);
  const descriptor = active
    ? `${winStart}:${sortKey ?? ""}:${sortDir ?? ""}:${JSON.stringify(selection)}:${JSON.stringify(sections)}:${JSON.stringify(sourceBuses)}`
    : "";

  const fetchPage = useCallback(
    async (offset: number, limit: number): Promise<WindowPage<SignalPageRow>> => {
      diagCount("invoke.fetch_signal_page"); // DIAG
      // While running, snapshot to the live tip (host clamps and takes
      // its O(keys)/O(groups) fast paths); the window bound only
      // matters for a frozen paused/stopped snapshot. Same rationale
      // as `useByIdView`.
      const scanEnd = running ? Number.MAX_SAFE_INTEGER : winEnd;
      try {
        const res = await invoke<SignalPage>("fetch_signal_page", {
          selection,
          sections,
          scanStart: winStart,
          scanEnd,
          sortKey,
          sortDir,
          busNames,
          sourceBuses: sourceBuses == null ? null : [...sourceBuses],
          offset: Math.max(0, offset),
          limit,
        });
        setError(null);
        return { total: res.count, start: res.start, rows: res.rows };
      } catch (e) {
        // An invalid pattern (host regex dialect) — surface it on the
        // panel and show an empty snapshot rather than crash-looping.
        setError(String(e));
        return { total: 0, start: 0, rows: [] };
      }
    },
    [
      selection,
      sections,
      winStart,
      winEnd,
      sortKey,
      sortDir,
      busNames,
      sourceBuses,
      running,
    ],
  );

  const { count, version, getRow, ensureVisible } = useWindowedQuery<SignalPageRow>({
    descriptor,
    fetchPage,
    followLive: running,
    extentSignal: winEnd + (running ? 0 : 1),
  });

  return { count, version, getRow, ensureVisible, error };
}
