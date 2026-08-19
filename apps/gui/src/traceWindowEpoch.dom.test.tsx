// @vitest-environment jsdom
//
// Every windowed source over the capture folds the trace model's
// re-anchor epoch into its descriptor (ADR 0053 §4, ADR 0025). The
// chronological window (`useTrace`) and the plot's decimated source
// already did; these two did not, and both render DBC-derived state —
// a by-id snapshot names messages out of the DBC set, and a filtered
// view's predicate is *decoded* against it. A live capture hid the gap
// by moving the window and re-keying them incidentally; a stopped one
// never does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// Row pages only: a parked window also issues *count-only* refreshes
// (`limit: 0`) on the shared primitive's throttled stale tick, and those
// say nothing about whether the view re-asked for its rows. A dropped
// and re-anchored window is a `limit > 0` fetch.
const rowPages: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (typeof args?.limit === "number" && args.limit > 0) rowPages.push(cmd);
    return { count: 0, start: 0, rows: [] };
  }),
}));

import { TraceDataProvider, type TraceData } from "./traceData";
import { useByIdView } from "./useByIdView";
import { useFilteredTrace } from "./useFilteredTrace";
import type { FilterPredicate } from "./types";

const baseData: TraceData = {
  count: 500,
  firstIndex: 0,
  truncationTsNs: null,
  sessionStartSeconds: 1000,
  epoch: 0,
  fetchRange: async () => [],
  liveTail: { start: 0, rows: [] },
};

/// A stopped panel: a window that does not move, over a capture that is
/// not growing — the case where nothing else re-keys the fetch.
function Harness({ epoch, children }: { epoch: number; children: ReactNode }) {
  return <TraceDataProvider value={{ ...baseData, epoch }}>{children}</TraceDataProvider>;
}

const FILTER: FilterPredicate = { sources: ["*"] } as unknown as FilterPredicate;

function FilteredProbe() {
  useFilteredTrace(true, 0, 500, FILTER, false, false);
  return null;
}

function ByIdProbe() {
  useByIdView(true, 0, 500, null, null, [], false);
  return null;
}

beforeEach(() => {
  rowPages.length = 0;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a windowed source over a stopped capture", () => {
  it("re-pages the filtered chronological view when the DBC set changes", async () => {
    const { rerender } = render(
      <Harness epoch={0}>
        <FilteredProbe />
      </Harness>,
    );
    await waitFor(() => expect(rowPages).toEqual(["fetch_filtered_trace"]));

    // A re-render that changes nothing must not re-page — the control
    // for the assertion below.
    await act(async () => {
      rerender(
        <Harness epoch={0}>
          <FilteredProbe />
        </Harness>,
      );
    });
    expect(rowPages).toEqual(["fetch_filtered_trace"]);

    // The DBC set changed: `App` bumped the model epoch. The window and
    // the predicate are untouched — and the predicate's answer is not.
    await act(async () => {
      rerender(
        <Harness epoch={1}>
          <FilteredProbe />
        </Harness>,
      );
    });
    await waitFor(() =>
      expect(rowPages).toEqual(["fetch_filtered_trace", "fetch_filtered_trace"]),
    );
  });

  it("re-pages the by-id snapshot when the DBC set changes", async () => {
    const { rerender } = render(
      <Harness epoch={0}>
        <ByIdProbe />
      </Harness>,
    );
    await waitFor(() => expect(rowPages).toEqual(["fetch_by_id_page"]));

    await act(async () => {
      rerender(
        <Harness epoch={0}>
          <ByIdProbe />
        </Harness>,
      );
    });
    expect(rowPages).toEqual(["fetch_by_id_page"]);

    await act(async () => {
      rerender(
        <Harness epoch={1}>
          <ByIdProbe />
        </Harness>,
      );
    });
    await waitFor(() => expect(rowPages).toEqual(["fetch_by_id_page", "fetch_by_id_page"]));
  });
});
