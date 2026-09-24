// The Events panel's bus-error section (ADR 0035 amended, ADR 0044): a
// paged gridview over the level-0 series, read through the shared
// windowed-source primitive (`useWindowedQuery`) against
// `bus_error_series` — a time window and a point budget derived from the
// section's own row space, so the panel never holds the whole series
// (CLAUDE.md § GUI architecture).
//
// Unlike the chronological trace or the by-id snapshot, the host has no
// index-addressable view of this series — only a time-windowed,
// point-budgeted one (`sampling::bus_error_series`). So the "page" here
// is the whole answer to one `[sessionStart, now)` query at the current
// point budget: every row the section renders is a real served point
// (never approximated — see `plotEvents.ts::busErrorEpisodes`), and
// asking for more means requesting the *same* window at a larger budget,
// which the pyramid serves at finer resolution — the same "zoom in to
// resolve" the plot's own markers already do (phase 2), just reached by
// growing the section instead of panning a plot.

import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { busErrorEpisodes, type BusErrorEpisode, type BusErrorSeries } from "./plotEvents";
import { useTraceLive, useTraceModel } from "./traceData";
import { useWindowedQuery, type WindowPage } from "./useWindowedQuery";

/// The initial point budget per bus — comfortably more than a section's
/// visible rows, so an ordinary capture resolves to real episodes
/// without the reader ever having to ask for more.
export const BUS_ERROR_INITIAL_BUDGET = 100;

/// The ceiling `growBudget` can reach. Bounded, so a reader who keeps
/// scrolling to the section's edge on a capture with far more episodes
/// than this cannot force an ever-larger fetch — CLAUDE.md's paged-view
/// rule applies to the growth path too, not only the initial page.
export const BUS_ERROR_MAX_BUDGET = 4000;

/// `bus_error_series`'s wire shape (`ipc.rs`'s `BusErrorWindows`).
interface BusErrorWindowsWire {
  series: { t: number[]; v: number[] }[];
  complete: boolean;
}

export interface BusErrorEventsPage {
  /// Every bus's episodes in the current window, merged and sorted
  /// chronologically — never the whole series, only what the current
  /// point budget resolved.
  rows: readonly BusErrorEpisode[];
  /// ADR 0049: `false` while any bus's series is still catching up with
  /// the capture — the section shows what it has and keeps asking.
  complete: boolean;
  /// Ask for more resolution: doubles the point budget (bounded by
  /// `BUS_ERROR_MAX_BUDGET`) and re-queries the same window at it,
  /// resolving coarser rows into their individual episodes.
  growBudget: () => void;
  /// True once `growBudget` would change nothing — the budget is
  /// already at the ceiling, or the last answer already came back under
  /// budget (the host had every episode in the window to give and
  /// coarsened none of them).
  atFullResolution: boolean;
}

/// Page the bus-error series into the Events panel's own section:
/// `[sessionStartSeconds, now)` at a point budget that starts small and
/// grows on request, merged across `buses` and sorted chronologically.
/// `buses` empty (no session yet) or no session start (nothing to anchor
/// on) makes the query inactive, the same as every other windowed view's
/// `""` descriptor.
export function useBusErrorEvents(buses: readonly string[]): BusErrorEventsPage {
  const { epoch, sessionStartSeconds } = useTraceModel();
  const { count: liveCount } = useTraceLive();
  const [budget, setBudget] = useState(BUS_ERROR_INITIAL_BUDGET);

  const busKey = buses.join(",");
  const active = buses.length > 0 && sessionStartSeconds != null;
  const descriptor = active ? `${epoch}:${busKey}:${budget}` : "";

  const [complete, setComplete] = useState(true);

  const fetchPage = useCallback(
    async (): Promise<WindowPage<BusErrorEpisode>> => {
      const res = await invoke<BusErrorWindowsWire>("bus_error_series", {
        buses: [...buses],
        fromSeconds: sessionStartSeconds ?? 0,
        // No live tip is tracked client-side — a time isn't a model fact
        // this view derives (CLAUDE.md). A bound past any real capture
        // clips to the series' own live edge host-side
        // (`SampleSeries::window`'s `level_points`), so this asks for
        // "everything so far" without knowing where "so far" ends.
        toSeconds: Number.MAX_SAFE_INTEGER,
        maxPoints: budget,
      });
      setComplete(res.complete);
      const series: BusErrorSeries[] = buses.map((bus, i) => ({
        bus,
        t: res.series[i]?.t ?? [],
        v: res.series[i]?.v ?? [],
      }));
      const rows = [...busErrorEpisodes(series)].sort((a, b) => a.timestampNs - b.timestampNs);
      return { total: rows.length, start: 0, rows };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busKey, sessionStartSeconds, budget],
  );

  const { count, getRow } = useWindowedQuery<BusErrorEpisode>({
    descriptor,
    fetchPage,
    followLive: true,
    refresh: "window",
    extentSignal: liveCount,
  });

  const rows = useMemo(() => {
    const out: BusErrorEpisode[] = [];
    for (let i = 0; i < count; i++) {
      const r = getRow(i);
      if (r != null) out.push(r);
    }
    return out;
  }, [count, getRow]);

  const growBudget = useCallback(() => {
    setBudget((b) => Math.min(BUS_ERROR_MAX_BUDGET, b * 2));
  }, []);

  // Once a served window's row count falls under the budget that asked
  // for it, the host had every episode in the window to give and
  // coarsened nothing — growing further would repeat the same query for
  // the same answer.
  const atFullResolution = rows.length < budget || budget >= BUS_ERROR_MAX_BUDGET;

  return { rows, complete, growBudget, atFullResolution };
}
