// @vitest-environment jsdom
//
// The Events panel's bus-error section adapter: pages `bus_error_series`
// through the shared windowed-source primitive (`useWindowedQuery`),
// merges and sorts episodes across buses, grows its point budget on
// request, and reports ADR 0049 partial answers. `invoke` is mocked, so
// this exercises the lifecycle in isolation from the host — the episode
// math itself is `plotEvents.test.ts`'s job.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// The refresh cadence is the `view_refresh_interval_ms` setting, so
// these tests need a host to hydrate it from — the same setup
// `useWindowedQuery.test.ts` uses.
let stored: Record<string, unknown> = {};
let busErrorFixture: unknown = { series: [], complete: true };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_settings") return { ...stored };
    if (cmd === "bus_error_series") return busErrorFixture;
    return null;
  }),
}));

const { invoke } = await import("@tauri-apps/api/core");
const mockInvoke = vi.mocked(invoke);
const {
  useBusErrorEvents,
  BUS_ERROR_INITIAL_BUDGET,
  BUS_ERROR_MAX_BUDGET,
} = await import("./useBusErrorEvents");
const { hydrateSettings } = await import("./hostSettings");
const { TraceDataProvider } = await import("./traceData");
type TraceData = import("./traceData").TraceData;

const traceData: TraceData = {
  count: 0,
  firstIndex: 0,
  truncationTsNs: null,
  sessionStartSeconds: 1_000,
  epoch: 0,
  fetchRange: async () => [],
  liveTail: { start: 0, rows: [] },
};

function wrapper(data: TraceData = traceData) {
  return ({ children }: { children: ReactNode }) => TraceDataProvider({ value: data, children });
}

beforeEach(async () => {
  stored = {};
  busErrorFixture = { series: [], complete: true };
  await hydrateSettings();
  // Cleared after hydration's own `get_settings` round-trip, so a
  // test's call-count assertions count only its own `bus_error_series`
  // invocations.
  mockInvoke.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useBusErrorEvents", () => {
  it("asks nothing and holds no rows for an empty bus list", async () => {
    const { result } = renderHook(() => useBusErrorEvents([]), { wrapper: wrapper() });
    await flush();
    expect(mockInvoke).not.toHaveBeenCalledWith("bus_error_series", expect.anything());
    expect(result.current.rows).toEqual([]);
  });

  it("fetches the session start through the live edge at the initial budget", async () => {
    busErrorFixture = { series: [{ t: [1_000, 1_002], v: [1, 2] }], complete: true };
    const { result } = renderHook(() => useBusErrorEvents(["b1"]), { wrapper: wrapper() });
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("bus_error_series", {
      buses: ["b1"],
      fromSeconds: 1_000,
      toSeconds: Number.MAX_SAFE_INTEGER,
      maxPoints: BUS_ERROR_INITIAL_BUDGET,
    });
    expect(result.current.rows).toEqual([
      { id: "bus-error:b1:2", bus: "b1", timestampNs: 1_002_000_000_000, count: 1, spanSeconds: 2 },
    ]);
    expect(result.current.complete).toBe(true);
  });

  it("merges and sorts episodes chronologically across buses", async () => {
    busErrorFixture = {
      series: [
        { t: [1_000, 1_005], v: [1, 2] },
        { t: [1_000, 1_001, 1_003], v: [4, 5, 6] },
      ],
      complete: true,
    };
    const { result } = renderHook(() => useBusErrorEvents(["b1", "b2"]), { wrapper: wrapper() });
    await flush();

    expect(result.current.rows.map((r) => r.id)).toEqual([
      "bus-error:b2:5",
      "bus-error:b2:6",
      "bus-error:b1:2",
    ]);
  });

  it("shows what it has quietly on a partial (`complete: false`) answer", async () => {
    busErrorFixture = { series: [{ t: [1_000, 1_001], v: [1, 2] }], complete: false };
    const { result } = renderHook(() => useBusErrorEvents(["b1"]), { wrapper: wrapper() });
    await flush();

    expect(result.current.rows).toHaveLength(1);
    expect(result.current.complete).toBe(false);
  });

  it("grows the point budget on request, up to the ceiling", async () => {
    busErrorFixture = { series: [{ t: [1_000, 1_001], v: [1, 2] }], complete: true };
    const { result } = renderHook(() => useBusErrorEvents(["b1"]), { wrapper: wrapper() });
    await flush();
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    act(() => result.current.growBudget());
    await flush();
    expect(mockInvoke).toHaveBeenLastCalledWith("bus_error_series", {
      buses: ["b1"],
      fromSeconds: 1_000,
      toSeconds: Number.MAX_SAFE_INTEGER,
      maxPoints: BUS_ERROR_INITIAL_BUDGET * 2,
    });

    // Growing repeatedly never exceeds the ceiling.
    for (let i = 0; i < 20; i++) {
      act(() => result.current.growBudget());
      await flush();
    }
    const lastCall = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
    expect((lastCall[1] as { maxPoints: number }).maxPoints).toBe(BUS_ERROR_MAX_BUDGET);
  });

  it("reports full resolution once a served window answers under budget", async () => {
    // Two episodes served against a budget of 100 — the host had
    // nothing more to coarsen, so growing further would repeat the
    // query for the same answer.
    busErrorFixture = { series: [{ t: [1_000, 1_001], v: [1, 2] }], complete: true };
    const { result } = renderHook(() => useBusErrorEvents(["b1"]), { wrapper: wrapper() });
    await flush();
    expect(result.current.atFullResolution).toBe(true);
  });
});
