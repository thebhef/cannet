// The Events panel's bus-error section (ADR 0035 amended, ADR 0044): the
// host's **episodes** — bursts of errors on one bus, split wherever the bus
// fell silent for at least the episode gap — paged by offset, newest
// first, through the shared windowed-source primitive
// (`useWindowedQuery`), like the trace and by-id views. The host derives
// and holds the episode list (`bus_error_episodes`); this view holds one
// page of it and never counts anything itself (CLAUDE.md § GUI
// architecture).

import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useTraceLive, useTraceModel } from "./traceData";
import { useWindowedQuery, type WindowPage } from "./useWindowedQuery";

/// One episode as `bus_error_episodes` serves it (`ipc.rs`'s
/// `BusErrorEpisode`).
interface BusErrorEpisodeWire {
  bus: string;
  firstT: number;
  lastT: number;
  count: number;
  span: number;
  rate: number | null;
  lastOrdinal: number;
}

/// `bus_error_episodes`' answer (`ipc.rs`'s `BusErrorEpisodePage`).
interface BusErrorEpisodePageWire {
  count: number;
  start: number;
  episodes: BusErrorEpisodeWire[];
  complete: boolean;
}

/// One row of the section: an episode, as the host derived it.
export interface BusErrorEpisodeRow {
  /// `bus-error:{bus}:{n}`, `n` the ordinal of the episode's last error
  /// — a real sample of the bus's error series, so the id is the one the
  /// plot's marker for that error carries and a link to it resolves the
  /// same way (ADR 0056).
  id: string;
  bus: string;
  /// The first error's time, absolute seconds.
  firstSeconds: number;
  count: number;
  spanSeconds: number;
  /// Errors per second over the span; `null` for a single error.
  rate: number | null;
}

export interface BusErrorEvents {
  /// Episodes in all, at the gap — the row space's extent.
  count: number;
  /// Bumped when the loaded page changes, so rows re-read `getRow`.
  version: number;
  /// The row at newest-first index `index`, or `null` outside the page.
  getRow: (index: number) => BusErrorEpisodeRow | null;
  /// Ask for the page covering `[start, end)`.
  ensureVisible: (start: number, end: number) => void;
  /// ADR 0049: `false` while the host is still building the series or
  /// its episode list — the section shows what it has and keeps asking.
  complete: boolean;
}

function toRow(e: BusErrorEpisodeWire): BusErrorEpisodeRow {
  return {
    id: `bus-error:${e.bus}:${e.lastOrdinal}`,
    bus: e.bus,
    firstSeconds: e.firstT,
    count: e.count,
    spanSeconds: e.span,
    rate: e.rate,
  };
}

/// Page `buses`' episodes at `gapSeconds`, newest first. No buses, or no
/// session to anchor on, makes the query inactive — every other windowed
/// view's `""` descriptor. The gap is part of the descriptor, so a change
/// to the setting drops the page and the host re-derives.
export function useBusErrorEvents(buses: readonly string[], gapSeconds: number): BusErrorEvents {
  const { epoch, sessionStartSeconds } = useTraceModel();
  const { count: liveCount } = useTraceLive();
  const [complete, setComplete] = useState(true);
  // Bumped on each partial answer, so a stopped capture whose episodes
  // are still being rebuilt (a restore) keeps being asked — the live
  // count alone would never mark it stale again.
  const [partials, setPartials] = useState(0);

  const busKey = buses.join(",");
  const active = buses.length > 0 && sessionStartSeconds != null;
  const descriptor = active ? `${epoch}:${busKey}:${gapSeconds}` : "";

  const fetchPage = useCallback(
    async (offset: number, limit: number): Promise<WindowPage<BusErrorEpisodeRow>> => {
      const res = await invoke<BusErrorEpisodePageWire>("bus_error_episodes", {
        buses: [...buses],
        gapSeconds,
        offset: Math.max(0, offset),
        limit,
      });
      setComplete(res.complete);
      if (!res.complete) setPartials((n) => n + 1);
      return { total: res.count, start: res.start, rows: res.episodes.map(toRow) };
    },
    // `busKey` stands for `buses`' contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busKey, gapSeconds],
  );

  const { count, version, getRow, ensureVisible } = useWindowedQuery<BusErrorEpisodeRow>({
    descriptor,
    fetchPage,
    followLive: true,
    // Newest first: new episodes arrive at the top and the newest one
    // grows in place, so a refresh re-fetches the page the view is on
    // rather than jumping it anywhere.
    refresh: "window",
    extentSignal: liveCount + partials,
  });

  return { count, version, getRow, ensureVisible, complete };
}
