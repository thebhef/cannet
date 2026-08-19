// @vitest-environment jsdom
//
// The frontend's single subscription to the host's `dbc-changed`
// (ADR 0053 §3) and the coalescing it owns (§5). What is pinned here is
// the shape every consumer depends on: one fan-out per *set* change,
// however many announcements the host made getting there, and a batch
// that spans several host calls costing exactly one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

type Handler = () => void;
let handlers: Handler[] = [];
let unlistened = 0;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: Handler) => {
    handlers.push(handler);
    return () => {
      unlistened += 1;
      handlers = handlers.filter((h) => h !== handler);
    };
  }),
}));

import { DBC_CHANGE_COALESCE_MS, suppressDbcChanges, useDbcGeneration } from "./dbcChanged";

/// The host announcing a change, from the watcher's thread or a command.
function announce(): void {
  for (const h of [...handlers]) h();
}

beforeEach(() => {
  vi.useFakeTimers();
  handlers = [];
  unlistened = 0;
});
afterEach(() => {
  // Explicit: the module owns one process-wide listener, so a consumer
  // left mounted by the previous test would keep it (this suite has no
  // global auto-cleanup).
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/// Mount a consumer and wait for the (async) `listen` to be installed.
async function mountConsumer() {
  const hook = renderHook(() => useDbcGeneration());
  await act(async () => {});
  return hook;
}

async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(DBC_CHANGE_COALESCE_MS);
  });
}

describe("the DBC-change carrier", () => {
  it("bumps the generation once for one announcement", async () => {
    const { result } = await mountConsumer();
    const before = result.current;
    act(() => announce());
    expect(result.current).toBe(before); // still inside the coalesce window
    await settle();
    expect(result.current).toBe(before + 1);
  });

  it("coalesces one editor save's burst of announcements into one fan-out", async () => {
    // A save shows up as several filesystem events (atomic rename,
    // truncate-then-rewrite, temp+rename), each of which the host
    // re-reads, re-parses and re-announces by design.
    const { result } = await mountConsumer();
    const before = result.current;
    act(() => {
      announce();
      announce();
      announce();
    });
    await settle();
    expect(result.current).toBe(before + 1);
  });

  it("a suppressed batch costs exactly one fan-out, however many announcements it swallowed", async () => {
    // Opening a project is clear_dbcs + N x add_dbc + M x set_dbc_buses,
    // each of which announces — one set change, spread over host calls
    // that need not finish inside the debounce window.
    const { result } = await mountConsumer();
    const before = result.current;
    const release = suppressDbcChanges();
    for (let i = 0; i < 6; i += 1) {
      act(() => announce());
      // Each host call takes longer than the debounce window; without
      // the batch guard this is six fan-outs.
      await act(async () => {
        vi.advanceTimersByTime(DBC_CHANGE_COALESCE_MS * 2);
      });
    }
    expect(result.current).toBe(before);
    act(() => release());
    await settle();
    expect(result.current).toBe(before + 1);
  });

  it("a batch that swallowed nothing fans out nothing", async () => {
    const { result } = await mountConsumer();
    const before = result.current;
    act(() => suppressDbcChanges()());
    await settle();
    expect(result.current).toBe(before);
  });

  it("keeps one host listener for many consumers, and drops it with the last of them", async () => {
    const a = await mountConsumer();
    const b = await mountConsumer();
    expect(handlers).toHaveLength(1);
    const before = a.result.current;
    act(() => announce());
    await settle();
    expect(a.result.current).toBe(before + 1);
    expect(b.result.current).toBe(before + 1);

    a.unmount();
    expect(handlers).toHaveLength(1);
    b.unmount();
    expect(unlistened).toBe(1);
    expect(handlers).toHaveLength(0);
  });
});
