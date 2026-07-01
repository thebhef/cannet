// @vitest-environment jsdom
//
// Layer-A lifecycle of the shared windowed source (ADR 0025): one
// window over a host-paged model, plus the rules that keep re-fetch
// cost bounded to actual viewport change rather than ingest rate.
// `fetchPage` is injected, so this exercises the lifecycle in isolation
// from any host command.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useWindowedQuery, type WindowPage } from "./useWindowedQuery";

/// A fake host page source over a contiguous integer "model" of
/// `total` rows: row at index `i` is the string `r{i}`. Counts calls so
/// tests can assert when a re-fetch did or did not happen.
function fakeSource(total: number) {
  const fetchPage = vi.fn(
    async (
      offset: number,
      limit: number,
      fromEnd: boolean,
    ): Promise<WindowPage<string>> => {
      if (limit === 0) return { total, start: 0, rows: [] }; // count-only
      const start = fromEnd ? Math.max(0, total - limit) : offset;
      const end = Math.min(total, start + limit);
      const rows: string[] = [];
      for (let i = start; i < end; i++) rows.push(`r${i}`);
      return { total, start, rows };
    },
  );
  return { fetchPage };
}

const base = {
  followLive: false,
  extentSignal: 0,
  pageSize: 100,
  refreshMs: 50,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/// Let the immediate load's promise resolve and state settle.
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useWindowedQuery", () => {
  it("loads the first page for a non-empty descriptor and serves rows by index", async () => {
    const { fetchPage } = fakeSource(1000);
    const { result } = renderHook(() =>
      useWindowedQuery({ ...base, descriptor: "cap1", extent: 1000, fetchPage }),
    );
    await flush();

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.current.count).toBe(1000);
    expect(result.current.getRow(0)).toBe("r0");
    expect(result.current.getRow(99)).toBe("r99");
    // Outside the loaded window → placeholder, not a stale row.
    expect(result.current.getRow(500)).toBeNull();
  });

  it("does not re-fetch when the descriptor is unchanged across re-renders", async () => {
    const { fetchPage } = fakeSource(1000);
    const { rerender } = renderHook(
      (p: { extentSignal: number }) =>
        useWindowedQuery({
          ...base,
          descriptor: "cap1",
          extent: 1000,
          fetchPage,
          extentSignal: p.extentSignal,
        }),
      { initialProps: { extentSignal: 0 } },
    );
    await flush();
    expect(fetchPage).toHaveBeenCalledTimes(1);

    // A pure re-render with the same descriptor and extent must not refetch.
    rerender({ extentSignal: 0 });
    await flush();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("re-anchors (fetches a new window) when ensureVisible leaves the loaded page", async () => {
    const { fetchPage } = fakeSource(1000);
    const { result } = renderHook(() =>
      useWindowedQuery({ ...base, descriptor: "cap1", extent: 1000, fetchPage }),
    );
    await flush();
    expect(fetchPage).toHaveBeenCalledTimes(1);

    // Scroll far past the loaded [0,100) window.
    act(() => result.current.ensureVisible(600, 640));
    await flush();

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.current.getRow(620)).toBe("r620");
    // Inside the new window: another ensureVisible is a no-op fetch.
    act(() => result.current.ensureVisible(610, 650));
    await flush();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("drops the window and re-anchors on a descriptor change", async () => {
    const { fetchPage: f1 } = fakeSource(1000);
    const { fetchPage: f2 } = fakeSource(20);
    const { result, rerender } = renderHook(
      (p: { descriptor: string; extent: number; fetchPage: typeof f1 }) =>
        useWindowedQuery({ ...base, ...p }),
      {
        initialProps: { descriptor: "cap1", extent: 1000, fetchPage: f1 },
      },
    );
    await flush();
    expect(result.current.getRow(0)).toBe("r0");
    expect(result.current.count).toBe(1000);

    // New capture (Clear / Connect): different descriptor, smaller extent.
    rerender({ descriptor: "cap2", extent: 20, fetchPage: f2 });
    await flush();

    expect(f2).toHaveBeenCalledTimes(1);
    expect(result.current.count).toBe(20);
    expect(result.current.getRow(0)).toBe("r0");
    // The old window is gone — nothing past the new extent is served.
    expect(result.current.getRow(500)).toBeNull();
  });

  it("known extent: an extent advance alone updates count but does not re-fetch a parked window", async () => {
    const src = fakeSource(1000);
    const { result, rerender } = renderHook(
      (p: { extent: number; extentSignal: number }) =>
        useWindowedQuery({
          ...base,
          descriptor: "cap1",
          followLive: false,
          fetchPage: src.fetchPage,
          extent: p.extent,
          extentSignal: p.extentSignal,
        }),
      { initialProps: { extent: 1000, extentSignal: 0 } },
    );
    await flush();
    expect(src.fetchPage).toHaveBeenCalledTimes(1);

    // Capture grew while parked in history: bump extent + signal.
    rerender({ extent: 1500, extentSignal: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(base.refreshMs * 2);
    });

    // Scrollbar tracks the new total; the history page is NOT re-fetched
    // (extent is known, so no count-only round-trip either).
    expect(result.current.count).toBe(1500);
    expect(src.fetchPage).toHaveBeenCalledTimes(1);
  });

  it("unknown extent: a parked stale tick does a count-only refresh, leaving rows intact", async () => {
    // No `extent` → the count comes from the host (filtered-trace shape):
    // a parked refresh must re-count without re-paging.
    let total = 30;
    const fetchPage = vi.fn(
      async (
        offset: number,
        limit: number,
        fromEnd: boolean,
      ): Promise<WindowPage<string>> => {
        if (limit === 0) return { total, start: 0, rows: [] };
        const start = fromEnd ? Math.max(0, total - limit) : offset;
        const rows: string[] = [];
        for (let i = start; i < Math.min(total, start + limit); i++)
          rows.push(`r${i}`);
        return { total, start, rows };
      },
    );
    const { result, rerender } = renderHook(
      (p: { extentSignal: number }) =>
        useWindowedQuery({
          ...base,
          descriptor: "filt",
          followLive: false,
          fetchPage,
          extentSignal: p.extentSignal,
        }),
      { initialProps: { extentSignal: 0 } },
    );
    await flush();
    expect(result.current.count).toBe(30);
    const callsAfterLoad = fetchPage.mock.calls.length;

    // More matches arrived; mark stale.
    total = 42;
    rerender({ extentSignal: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(base.refreshMs * 2);
    });

    // A count-only fetch ran (limit 0) and updated the total; the loaded
    // rows are untouched.
    expect(result.current.count).toBe(42);
    const countOnly = fetchPage.mock.calls
      .slice(callsAfterLoad)
      .filter((c) => c[1] === 0);
    expect(countOnly.length).toBeGreaterThanOrEqual(1);
    expect(result.current.getRow(0)).toBe("r0");
  });

  it("is inactive for an empty descriptor: no fetch, no rows", async () => {
    const { fetchPage } = fakeSource(1000);
    const { result } = renderHook(() =>
      useWindowedQuery({ ...base, descriptor: "", fetchPage }),
    );
    await flush();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.current.count).toBe(0);
    expect(result.current.getRow(0)).toBeNull();
  });

  it("follow-live overlays the live tail past the loaded page", async () => {
    // The page fetched `fromEnd` covers [900,1000); frames 1000/1001
    // arrived via `trace-grew` before the next throttled re-page.
    const { fetchPage } = fakeSource(1000);
    const { result } = renderHook(() =>
      useWindowedQuery({
        ...base,
        descriptor: "cap1",
        extent: 1002,
        followLive: true,
        fetchPage,
        liveTail: { start: 1000, rows: ["t1000", "t1001"] },
      }),
    );
    await flush();
    expect(result.current.getRow(999)).toBe("r999"); // from the page
    // Past the loaded page, the overlay answers so the live edge never
    // shows a placeholder between throttled re-pages.
    expect(result.current.getRow(1001)).toBe("t1001");
  });
});
