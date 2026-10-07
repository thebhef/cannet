// @vitest-environment jsdom
//
// The Events panel's bus-error section adapter: pages the host's episode
// list (`bus_error_episodes`) by offset through the shared windowed-source
// primitive (`useWindowedQuery`), re-derives on a gap change, and reports
// ADR 0049 partial answers. `invoke` is mocked, so this exercises the
// lifecycle in isolation from the host — the episodes themselves are
// `signal_cache.rs`'s tests.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// The refresh cadence is the `view_refresh_interval_ms` setting, so
// these tests need a host to hydrate it from — the same setup
// `useWindowedQuery.test.ts` uses.
let stored: Record<string, unknown> = {};
/// The host's episode list for the mocked serve, newest first, and
/// whether it says it is complete.
let hostEpisodes: { bus: string; lastOrdinal: number }[] = [];
let hostComplete = true;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_settings") return { ...stored };
    if (cmd === "bus_error_episodes") {
      const offset = Number(args?.offset ?? 0);
      const limit = Number(args?.limit ?? 0);
      return {
        count: hostEpisodes.length,
        start: offset,
        episodes: hostEpisodes.slice(offset, offset + limit).map((e, i) => ({
          bus: e.bus,
          firstT: 2_000 - offset - i,
          lastT: 2_000.5 - offset - i,
          count: 3,
          span: 0.5,
          rate: 6,
          lastOrdinal: e.lastOrdinal,
        })),
        complete: hostComplete,
      };
    }
    return null;
  }),
}));

const { invoke } = await import("@tauri-apps/api/core");
const mockInvoke = vi.mocked(invoke);
const { useBusErrorEvents } = await import("./useBusErrorEvents");
const { PAGE_ROWS } = await import("./useWindowedQuery");
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
  hostEpisodes = [];
  hostComplete = true;
  await hydrateSettings();
  // Cleared after hydration's own `get_settings` round-trip, so a
  // test's call-count assertions count only its own `bus_error_episodes`
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

/// `n` episodes, newest first, on `b1` — each ending on an ordinal that
/// falls going down the list, as the host's do.
function episodes(n: number) {
  return Array.from({ length: n }, (_, i) => ({ bus: "b1", lastOrdinal: 3 * (n - i) }));
}

function episodeCalls() {
  return mockInvoke.mock.calls.filter((c) => c[0] === "bus_error_episodes");
}

describe("useBusErrorEvents", () => {
  it("asks nothing and holds no rows for an empty bus list", async () => {
    const { result } = renderHook(() => useBusErrorEvents([], 5), { wrapper: wrapper() });
    await flush();
    expect(episodeCalls()).toHaveLength(0);
    expect(result.current.count).toBe(0);
  });

  it("pages the newest episodes first, at the configured gap", async () => {
    hostEpisodes = episodes(3);
    const { result } = renderHook(() => useBusErrorEvents(["b1"], 5), { wrapper: wrapper() });
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("bus_error_episodes", {
      buses: ["b1"],
      gapSeconds: 5,
      offset: 0,
      limit: PAGE_ROWS,
    });
    expect(result.current.count).toBe(3);
    expect(result.current.getRow(0)).toEqual({
      id: "bus-error:b1:9",
      bus: "b1",
      firstSeconds: 2_000,
      count: 3,
      spanSeconds: 0.5,
      rate: 6,
    });
    expect(result.current.getRow(2)?.id).toBe("bus-error:b1:3");
    expect(result.current.complete).toBe(true);
  });

  it("fetches a deeper page by offset, down to the oldest episode", async () => {
    hostEpisodes = episodes(5_000);
    const { result } = renderHook(() => useBusErrorEvents(["b1"], 1), { wrapper: wrapper() });
    await flush();
    expect(result.current.count).toBe(5_000);
    expect(result.current.getRow(4_999)).toBeNull();

    act(() => result.current.ensureVisible(4_990, 5_000));
    await flush();
    const last = episodeCalls()[episodeCalls().length - 1][1] as { offset: number };
    expect(last.offset).toBeGreaterThan(0);
    expect(last.offset).toBeLessThanOrEqual(4_990);
    // The oldest single episode: the capture's first three errors.
    expect(result.current.getRow(4_999)?.id).toBe("bus-error:b1:3");
  });

  it("re-derives from the top when the gap changes", async () => {
    hostEpisodes = episodes(10);
    const { result, rerender } = renderHook(({ gap }) => useBusErrorEvents(["b1"], gap), {
      wrapper: wrapper(),
      initialProps: { gap: 5 },
    });
    await flush();
    expect(result.current.count).toBe(10);

    hostEpisodes = episodes(40);
    rerender({ gap: 1 });
    await flush();
    expect(mockInvoke).toHaveBeenLastCalledWith("bus_error_episodes", {
      buses: ["b1"],
      gapSeconds: 1,
      offset: 0,
      limit: PAGE_ROWS,
    });
    expect(result.current.count).toBe(40);
  });

  it("shows what it has on a partial answer and keeps asking", async () => {
    hostEpisodes = episodes(2);
    hostComplete = false;
    const { result } = renderHook(() => useBusErrorEvents(["b1"], 5), { wrapper: wrapper() });
    await flush();
    expect(result.current.count).toBe(2);
    expect(result.current.complete).toBe(false);
    const asked = episodeCalls().length;

    // Nothing else marks a stopped capture stale; the partial answer
    // itself does, so the next refresh tick asks again.
    hostEpisodes = episodes(4);
    hostComplete = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(episodeCalls().length).toBeGreaterThan(asked);
    expect(result.current.count).toBe(4);
    expect(result.current.complete).toBe(true);
  });
});
