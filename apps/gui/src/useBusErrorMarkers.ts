// The bus-error marker windowed query (ADR 0035 amended, ADR 0025): a
// per-plot fetch of `bus_error_series` over the visible window plus a
// prefetch margin, single-flighted with newest-wins like every other
// windowed fetch in this app (`useDecimatedRange`, `useWindowedQuery`).
//
// `PlotPanel` drives `request` from `onAreaResampled` — the same
// per-area resample cadence the plot's series fetch already runs at —
// rather than running a poller of its own (CLAUDE.md § GUI
// architecture: fetch only the visible slice plus margin, no
// unbounded accumulation).

import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { BusErrorSeries } from "./plotEvents";

/// Everything that determines one fetch's answer.
export interface BusErrorMarkerRequest {
  /// The buses to serve, in request order — the answer comes back
  /// positional (`BusErrorWindows.series`), so this order is what
  /// `BusErrorMarkerState.series` inherits.
  buses: readonly string[];
  fromSeconds: number;
  toSeconds: number;
  maxPoints: number;
}

export interface BusErrorMarkerState {
  /// One entry per requested bus, in request order. Empty until the
  /// first successful fetch — never cleared on a failed or superseded
  /// one, so a transient host hiccup leaves the last markers on screen
  /// rather than flashing empty.
  series: readonly BusErrorSeries[];
  /// ADR 0049: `false` while any bus's series is still catching up with
  /// the capture — the caller keeps asking; the view shows what it has
  /// rather than an empty state.
  complete: boolean;
}

const EMPTY_STATE: BusErrorMarkerState = { series: [], complete: true };

/// The wire shape `bus_error_series` answers with (`ipc.rs`'s
/// `BusErrorWindows` / `BusErrorPoints`).
interface BusErrorWindowsWire {
  series: { t: number[]; v: number[] }[];
  complete: boolean;
}

export interface BusErrorMarkerQuery {
  state: BusErrorMarkerState;
  /// Ask for `req`. `null` (or an empty bus list) is a no-op — there is
  /// nothing to query yet (no window, or no session buses). A request
  /// that lands while one is already in flight supersedes any other
  /// still-pending request, so only the newest ever reaches the host
  /// next; a request identical to the last *complete* answer makes no
  /// round-trip at all.
  request: (req: BusErrorMarkerRequest | null) => void;
}

export function useBusErrorMarkers(): BusErrorMarkerQuery {
  const [state, setState] = useState<BusErrorMarkerState>(EMPTY_STATE);
  const ctl = useRef({
    fetching: false,
    pending: null as BusErrorMarkerRequest | null,
    lastKey: "",
    lastComplete: false,
  });

  const request = useCallback((req: BusErrorMarkerRequest | null) => {
    if (req === null || req.buses.length === 0) return;
    const key = `${req.buses.join(",")}:${req.fromSeconds}:${req.toSeconds}:${req.maxPoints}`;
    const c = ctl.current;
    if (c.lastKey === key && c.lastComplete) return;
    if (c.fetching) {
      c.pending = req;
      return;
    }
    c.fetching = true;
    const buses = [...req.buses];
    void invoke<BusErrorWindowsWire>("bus_error_series", {
      buses,
      fromSeconds: req.fromSeconds,
      toSeconds: req.toSeconds,
      maxPoints: req.maxPoints,
    })
      .then((res) => {
        c.lastKey = key;
        c.lastComplete = res.complete;
        setState({
          series: buses.map((bus, i) => ({
            bus,
            t: res.series[i]?.t ?? [],
            v: res.series[i]?.v ?? [],
          })),
          complete: res.complete,
        });
      })
      .catch(() => {
        /* host unreachable — keep the last markers; a later tick retries */
      })
      .finally(() => {
        c.fetching = false;
        if (c.pending) {
          const next = c.pending;
          c.pending = null;
          request(next);
        }
      });
  }, []);

  return { state, request };
}
