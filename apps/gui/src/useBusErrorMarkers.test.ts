// @vitest-environment jsdom
//
// The bus-error marker windowed query's fetch lifecycle: single-flight
// with newest-wins, a memoised no-op for a request identical to the
// last *complete* answer, and quiet retention of the last markers
// across a failed or partial fetch (ADR 0049). `invoke` is mocked, so
// this exercises the lifecycle in isolation from the host — the marker
// projection itself is `plotEvents.test.ts`'s job.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";
import { useBusErrorMarkers, type BusErrorMarkerRequest } from "./useBusErrorMarkers";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

beforeEach(() => mockInvoke.mockReset());
afterEach(() => vi.restoreAllMocks());

function req(over: Partial<BusErrorMarkerRequest> = {}): BusErrorMarkerRequest {
  return { buses: ["b1"], fromSeconds: 0, toSeconds: 10, gapSeconds: 5, maxMarkers: 43, ...over };
}

/// One episode on `b1`, as the host serves it.
function ep(firstT: number) {
  return { bus: "b1", firstT, lastT: firstT + 1, count: 3, span: 1, rate: 3, lastOrdinal: 3 };
}

/// A `bus_error_episodes_in_window` answer holding `firstTs`' episodes.
function reply(firstTs: number[], complete = true) {
  return { episodes: firstTs.map(ep), gapSeconds: 5, errorCount: 3 * firstTs.length, complete };
}

/// Resolve every `invoke` call currently pending, letting the hook's own
/// `.then`/`.finally` chain settle before the next assertion.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useBusErrorMarkers", () => {
  it("starts empty and complete — nothing queried yet", () => {
    const { result } = renderHook(() => useBusErrorMarkers());
    expect(result.current.state).toEqual({
      episodes: [],
      gapSeconds: null,
      errorCount: 0,
      complete: true,
    });
  });

  it("asks nothing for a null or bus-less request", async () => {
    const { result } = renderHook(() => useBusErrorMarkers());
    act(() => result.current.request(null));
    act(() => result.current.request(req({ buses: [] })));
    await flush();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("fetches and fills state with the host's episodes, gap and count", async () => {
    mockInvoke.mockResolvedValue(reply([1, 2]));
    const { result } = renderHook(() => useBusErrorMarkers());

    act(() => result.current.request(req()));
    await waitFor(() => expect(result.current.state.episodes.length).toBeGreaterThan(0));

    expect(result.current.state).toEqual({
      episodes: [ep(1), ep(2)],
      gapSeconds: 5,
      errorCount: 6,
      complete: true,
    });
    expect(mockInvoke).toHaveBeenCalledWith("bus_error_episodes_in_window", {
      buses: ["b1"],
      fromSeconds: 0,
      toSeconds: 10,
      gapSeconds: 5,
      maxMarkers: 43,
    });
  });

  it("makes no round-trip for a request identical to the last complete answer", async () => {
    mockInvoke.mockResolvedValue(reply([1]));
    const { result } = renderHook(() => useBusErrorMarkers());

    act(() => result.current.request(req()));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));

    act(() => result.current.request(req()));
    await flush();
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // A changed window is a different request and does re-fetch.
    act(() => result.current.request(req({ toSeconds: 20 })));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
  });

  it("keeps asking while the answer is incomplete (ADR 0049)", async () => {
    mockInvoke.mockResolvedValue(reply([1], false));
    const { result } = renderHook(() => useBusErrorMarkers());

    act(() => result.current.request(req()));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    expect(result.current.state.complete).toBe(false);

    // Same request again — since the last answer was partial, this is
    // not memoised and asks again.
    act(() => result.current.request(req()));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
  });

  it("single-flights: a request while one is in flight supersedes any other pending one", async () => {
    let resolveFirst: ((v: unknown) => void) | null = null;
    mockInvoke.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    mockInvoke.mockResolvedValueOnce(reply([9]));
    const { result } = renderHook(() => useBusErrorMarkers());

    act(() => result.current.request(req({ toSeconds: 10 })));
    // Two more requests land before the first resolves — only the
    // newest of these should ever reach the host.
    act(() => result.current.request(req({ toSeconds: 20 })));
    act(() => result.current.request(req({ toSeconds: 30 })));
    expect(mockInvoke).toHaveBeenCalledTimes(1); // the first is still in flight

    resolveFirst!(reply([1]));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
    // The superseded middle request (toSeconds: 20) never went out.
    expect(mockInvoke).toHaveBeenLastCalledWith("bus_error_episodes_in_window", {
      buses: ["b1"],
      fromSeconds: 0,
      toSeconds: 30,
      gapSeconds: 5,
      maxMarkers: 43,
    });
  });

  it("keeps the last markers on a failed fetch rather than clearing them", async () => {
    mockInvoke.mockResolvedValueOnce(reply([1]));
    const { result } = renderHook(() => useBusErrorMarkers());
    act(() => result.current.request(req()));
    await waitFor(() => expect(result.current.state.episodes.length).toBeGreaterThan(0));

    mockInvoke.mockRejectedValueOnce(new Error("host unreachable"));
    act(() => result.current.request(req({ toSeconds: 99 })));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
    await flush();

    expect(result.current.state).toEqual({
      episodes: [ep(1)],
      gapSeconds: 5,
      errorCount: 3,
      complete: true,
    });
  });
});
