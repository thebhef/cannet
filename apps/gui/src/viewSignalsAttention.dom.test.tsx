// @vitest-environment jsdom
//
// The launcher badge's live count (task 89 phase 3): it must be
// correct on mount, refetch on `view-signals-changed`, and refetch on
// the DBC-change generation (ADR 0053) — the same two triggers
// `ViewSignalsPanel` itself refetches on — with no panel mounted at
// all, since the whole point is that it is live whether or not the
// panel is open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

let ATTENTION_COUNT = 0;
const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "list_view_signals") {
      return { rows: [], attentionCount: ATTENTION_COUNT, total: ATTENTION_COUNT };
    }
    return undefined;
  }),
}));

type Handler = () => void;
const mockListeners = new Map<string, Set<Handler>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    const set = mockListeners.get(event) ?? new Set();
    set.add(handler);
    mockListeners.set(event, set);
    return () => set.delete(handler);
  }),
}));
function emitHostEvent(event: string) {
  for (const h of mockListeners.get(event) ?? []) h();
}

import { useViewSignalsAttentionCount } from "./viewSignalsAttention";
import { DBC_CHANGE_COALESCE_MS } from "./dbcChanged";

function listCalls() {
  return calls.filter((c) => c.cmd === "list_view_signals");
}

beforeEach(() => {
  ATTENTION_COUNT = 0;
  calls.length = 0;
  mockListeners.clear();
});
afterEach(() => {
  // `dbcChanged.ts` holds one module-level subscription to `dbc-changed`,
  // registered the first time any hook in this test file subscribes and
  // torn down only once every subscriber has unmounted. Without this,
  // a later test's `mockListeners.clear()` would wipe the entry the
  // singleton already registered, and it would never re-register (it
  // thinks it is still listening) — so it must actually unmount here.
  cleanup();
  vi.restoreAllMocks();
});

describe("useViewSignalsAttentionCount", () => {
  it("fetches the count on mount, with no panel mounted", async () => {
    ATTENTION_COUNT = 3;
    const { result } = renderHook(() => useViewSignalsAttentionCount());
    await waitFor(() => expect(result.current).toBe(3));
    expect(listCalls().length).toBeGreaterThan(0);
  });

  it("is zero when nothing needs attention", async () => {
    ATTENTION_COUNT = 0;
    const { result } = renderHook(() => useViewSignalsAttentionCount());
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(result.current).toBe(0);
  });

  it("refetches on view-signals-changed", async () => {
    const { result } = renderHook(() => useViewSignalsAttentionCount());
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    ATTENTION_COUNT = 5;
    await act(async () => emitHostEvent("view-signals-changed"));
    await waitFor(() => expect(result.current).toBe(5));
  });

  it("refetches on a DBC-change generation bump, with the panel never mounted", async () => {
    const { result } = renderHook(() => useViewSignalsAttentionCount());
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    const before = listCalls().length;
    ATTENTION_COUNT = 7;
    await act(async () => {
      emitHostEvent("dbc-changed");
      await new Promise((r) => setTimeout(r, DBC_CHANGE_COALESCE_MS * 2));
    });
    await waitFor(() => expect(result.current).toBe(7));
    expect(listCalls().length).toBeGreaterThan(before);
  });
});
