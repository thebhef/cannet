// The Events panel's one list (ADR 0035): the authored events and every
// bus's bus-error episodes, merged by time, oldest first, paged by offset
// through the shared windowed-source primitive (`useWindowedQuery`), like
// the trace. The host merges, filters and counts (`events_page`); this view
// holds one page and shapes its rows for the renderer (CLAUDE.md § GUI
// architecture).

import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  noteToEvent,
  truncationEvent,
  type EventKind,
  type Note,
  type TimelineEvent,
} from "./notes";
import { busErrorEpisodeEvents } from "./plotEvents";
import { useTraceModel } from "./traceData";
import type { Bus } from "./types";
import type { BusErrorEpisodeWire } from "./useBusErrorMarkers";
import { useWindowedQuery, type WindowPage } from "./useWindowedQuery";

/// One row of `events_page`'s answer (`ipc.rs`'s `EventsPageRow`): an
/// authored event, the truncation marker's place, or an episode.
export type EventsPageRowWire =
  | ({ row: "note" } & Note)
  | { row: "truncation"; timestampNs: number }
  | ({ row: "busError" } & BusErrorEpisodeWire);

/// `events_page`'s answer (`ipc.rs`'s `EventsPage`).
export interface EventsPageWire {
  count: number;
  start: number;
  rows: EventsPageRowWire[];
  complete: boolean;
  version: number;
}

export interface EventsPageQuery {
  /// Rows in the filtered list — the row space's extent.
  count: number;
  /// Bumped when the loaded page changes, so rows re-read `getRow`.
  version: number;
  /// The event at oldest-first index `index`, or `null` outside the page.
  getRow: (index: number) => TimelineEvent | null;
  /// Ask for the page covering `[start, end)`.
  ensureVisible: (start: number, end: number) => void;
  /// ADR 0049: `false` while the host is still deriving episodes — the
  /// list shows what it has and keeps asking.
  complete: boolean;
}

export interface EventsPageOptions {
  /// Every project bus: the buses whose episodes join the list, and the
  /// names an episode's label carries.
  buses: readonly Bus[];
  /// The episode gap (`bus_error_episode_gap_s`).
  gapSeconds: number;
  /// The kinds the panel's filter shows.
  kinds: ReadonlySet<EventKind>;
  /// The panel's tag filter, as typed.
  tagQuery: string;
  /// Moves whenever something the list is made of may have changed
  /// outside this view's knowledge — the authored events, a bus's error
  /// count, the truncation point. The loaded page is re-fetched in place
  /// on the next refresh tick.
  changeSignal: number;
}

/// Page the Events panel's list. The filters and the gap are part of the
/// descriptor, so changing one drops the page and asks afresh.
export function useEventsPage({
  buses,
  gapSeconds,
  kinds,
  tagQuery,
  changeSignal,
}: EventsPageOptions): EventsPageQuery {
  const { epoch } = useTraceModel();
  const [complete, setComplete] = useState(true);
  // Bumped on each partial answer, so a list whose episodes are still
  // being derived (a restore, a long fault) keeps being asked even when
  // nothing else moves.
  const [partials, setPartials] = useState(0);

  const busIds = useMemo(() => buses.map((b) => b.id), [buses]);
  const busName = useMemo(() => {
    const names = new Map(buses.map((b) => [b.id, b.name]));
    return (id: string) => names.get(id) ?? id;
  }, [buses]);
  const kindList = useMemo(() => [...kinds].sort(), [kinds]);
  const busKey = busIds.join(",");
  const descriptor = `${epoch}:${busKey}:${gapSeconds}:${kindList.join(",")}:${tagQuery}`;

  const toEvent = useCallback(
    (r: EventsPageRowWire): TimelineEvent => {
      switch (r.row) {
        case "note":
          return noteToEvent(r);
        case "truncation":
          return truncationEvent(r.timestampNs);
        case "busError":
          return busErrorEpisodeEvents([r], busName)[0];
      }
    },
    [busName],
  );

  const fetchPage = useCallback(
    async (offset: number, limit: number, fromEnd: boolean): Promise<WindowPage<TimelineEvent>> => {
      const res = await invoke<EventsPageWire>("events_page", {
        buses: busIds,
        gapSeconds,
        offset: Math.max(0, offset),
        limit,
        fromEnd,
        kinds: kindList,
        tagQuery,
      });
      setComplete(res.complete);
      if (!res.complete) setPartials((n) => n + 1);
      return { total: res.count, start: res.start, rows: res.rows.map(toEvent) };
    },
    // `busKey` stands for `busIds`' contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busKey, gapSeconds, kindList, tagQuery, toEvent],
  );

  const { count, version, getRow, ensureVisible } = useWindowedQuery<TimelineEvent>({
    descriptor,
    fetchPage,
    // Rows change in place — an episode grows, an event is renamed — as
    // well as arriving at the end, so a refresh re-fetches the page the
    // view is on rather than moving it.
    followLive: true,
    refresh: "window",
    extentSignal: changeSignal + partials,
  });

  return { count, version, getRow, ensureVisible, complete };
}
