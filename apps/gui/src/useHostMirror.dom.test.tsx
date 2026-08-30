// @vitest-environment jsdom
//
// Canonical coverage for the shared host-mirror pattern: initial
// snapshot fetch, change-event refetch (with an
// optional payload filter), the post-listener refetch that closes the
// `listen`-is-async launch race, and poll-while-condition. Each
// panel's own DOM test (TransmitPanel.dom.test.tsx,
// RbsPanel.dom.test.tsx) covers its own integration; this is the
// hook's own contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

type Handler = (e: { payload: unknown }) => void;
let eventHandlers: Handler[] = [];
let releaseListen: (() => void) | undefined;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (_name: string, handler: Handler) =>
      new Promise<() => void>((resolve) => {
        eventHandlers.push(handler);
        releaseListen = () => resolve(() => {});
      }),
  ),
}));

import type { listen } from "@tauri-apps/api/event";
import { useHostMirror } from "./useHostMirror";

beforeEach(() => {
  eventHandlers = [];
  releaseListen = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useHostMirror", () => {
  it("fetches a snapshot on mount", async () => {
    const fetch = vi.fn(async () => 42);
    const { result } = renderHook(() =>
      useHostMirror({ fetch, fallback: 0, event: "changed" }),
    );
    await waitFor(() => expect(result.current.value).toBe(42));
  });

  it("falls back on a rejected fetch", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("nope");
    });
    const { result } = renderHook(() =>
      useHostMirror({ fetch, fallback: -1, event: "changed" }),
    );
    await waitFor(() => expect(result.current.value).toBe(-1));
  });

  it("re-fetches once the listener is attached, so a change in the attach gap isn't lost", async () => {
    let snapshot = 1;
    const fetch = vi.fn(async () => snapshot);
    renderHook(() => useHostMirror({ fetch, fallback: 0, event: "changed" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    // The host publishes a change in the gap before the listener attaches.
    snapshot = 2;
    act(() => releaseListen?.());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("re-fetches on a matching event and skips a non-matching one", async () => {
    let snapshot = 1;
    const fetch = vi.fn(async () => snapshot);
    renderHook(() =>
      useHostMirror({
        fetch,
        fallback: 0,
        event: "changed",
        matches: (payload: string) => payload === "a" || payload === "*",
      }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    act(() => releaseListen?.());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    snapshot = 3;
    act(() => eventHandlers[0]?.({ payload: "b" })); // non-matching — skipped
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch).toHaveBeenCalledTimes(2);

    act(() => eventHandlers[0]?.({ payload: "a" })); // matching — refetches
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });

  it("takes the value from the payload where the event carries it, without refetching", async () => {
    // Some host events publish the whole new state rather than a nudge
    // to re-read it. Refetching would still be correct, but it costs a
    // round trip and lands a render later — and a consumer that reads
    // the payload is what kept this pattern hand-rolled.
    const fetch = vi.fn(async () => 1);
    const { result } = renderHook(() =>
      useHostMirror<number, number>({
        fetch,
        fallback: 0,
        event: "changed",
        fromPayload: (p) => p,
      }),
    );
    await waitFor(() => expect(result.current.value).toBe(1));
    const fetches = fetch.mock.calls.length;

    act(() => eventHandlers.forEach((h) => h({ payload: 7 })));
    expect(result.current.value).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(fetches);
  });

  it("still closes the launch race when the value comes from the payload", async () => {
    // The payload only reaches a listener that exists. The snapshot
    // pair is what covers the gap before it does, so `fromPayload`
    // must not replace it.
    let snapshot = 1;
    const fetch = vi.fn(async () => snapshot);
    const { result } = renderHook(() =>
      useHostMirror<number, number>({
        fetch,
        fallback: 0,
        event: "changed",
        fromPayload: (p) => p,
      }),
    );
    await waitFor(() => expect(result.current.value).toBe(1));
    snapshot = 5;
    await act(async () => {
      releaseListen?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.value).toBe(5));
  });

  it("polls at pollIntervalMs while pollWhile(value) is true, and stops once it's false", async () => {
    vi.useFakeTimers();
    let snapshot = { running: true, n: 0 };
    const fetch = vi.fn(async () => snapshot);
    const { result } = renderHook(() =>
      useHostMirror({
        fetch,
        fallback: { running: false, n: -1 },
        event: "changed",
        pollWhile: (v) => v.running,
        pollIntervalMs: 500,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    snapshot = { running: true, n: 1 };
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.value.n).toBe(1);

    // Once the snapshot stops running, the interval should not fire again.
    snapshot = { running: false, n: 2 };
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(3); // the tick that delivered running:false
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(3); // no further ticks

    vi.useRealTimers();
  });

  it("unsubscribes the listener and clears the poll timer on unmount", async () => {
    vi.useFakeTimers();
    const unlisten = vi.fn();
    vi.mocked((await import("@tauri-apps/api/event")).listen).mockImplementationOnce(
      ((_name: string, handler: Handler) => {
        eventHandlers.push(handler);
        return Promise.resolve(unlisten);
      }) as unknown as typeof listen,
    );
    const fetch = vi.fn(async () => ({ running: true }));
    const { unmount } = renderHook(() =>
      useHostMirror({
        fetch,
        fallback: { running: false },
        event: "changed",
        pollWhile: (v) => v.running,
        pollIntervalMs: 500,
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(unlisten).toHaveBeenCalledTimes(1);

    const callsBeforeAdvance = fetch.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(fetch.mock.calls.length).toBe(callsBeforeAdvance);
    vi.useRealTimers();
  });
});
