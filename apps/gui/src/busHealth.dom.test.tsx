// @vitest-environment jsdom
//
// `useBusHealth` as a host mirror. The join and the words it puts on a
// row are covered by `busHealth.test.ts`; this is the subscription —
// and specifically the launch race, which is the whole reason the
// shared `useHostMirror` exists: `listen` is async, so a health change
// the host emits between the first snapshot and the listener actually
// attaching is lost unless the hook fetches again once it has.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import type { BusHealthMap } from "./types";

let health: BusHealthMap | null = {};
let invokeFails = false;
const invokeMock = vi.fn(async (cmd: string) => {
  if (cmd !== "get_bus_health") return null;
  if (invokeFails) throw new Error("no such command");
  return health;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string) => invokeMock(cmd) }));

type Handler = (e: { payload: unknown }) => void;
let handlers: Handler[] = [];
/// Lets a test hold `listen`'s promise open — the attach gap, made
/// arbitrarily wide.
let attachListener: (() => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: Handler) =>
    new Promise<() => void>((resolve) => {
      handlers.push(handler);
      attachListener = () => resolve(() => {});
    }),
}));

import { useBusHealth } from "./busHealth";

const REPORTING: BusHealthMap = {
  b1: { controller: { state: "passive", tec: 130, rec: 4 }, errorCount: 7, errorRate: 0.2 },
};
const RECOVERED: BusHealthMap = {
  b1: { controller: { state: "active", tec: 0, rec: 0 }, errorCount: 7, errorRate: 0 },
};

beforeEach(() => {
  handlers = [];
  attachListener = undefined;
  health = {};
  invokeFails = false;
  invokeMock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useBusHealth", () => {
  it("takes the host's snapshot on mount", async () => {
    health = REPORTING;
    const { result } = renderHook(() => useBusHealth());
    act(() => attachListener?.());
    await waitFor(() => expect(result.current).toEqual(REPORTING));
  });

  it("does not lose a change the host emits in the listener's attach gap", async () => {
    // The launch race: the first snapshot says every bus is fine, the
    // host puts a bus into error-passive before the listener is
    // attached, and no event will ever be delivered for it.
    health = {};
    const { result } = renderHook(() => useBusHealth());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual({});

    health = REPORTING;
    act(() => attachListener?.());

    // Nothing else happens — no event, no poll. Only the refetch the
    // hook does once it knows it is listening can find this.
    await waitFor(() => expect(result.current).toEqual(REPORTING));
  });

  it("re-reads the map when the host says health moved", async () => {
    health = REPORTING;
    const { result } = renderHook(() => useBusHealth());
    act(() => attachListener?.());
    await waitFor(() => expect(result.current).toEqual(REPORTING));

    health = RECOVERED;
    act(() => handlers[0]?.({ payload: RECOVERED }));
    await waitFor(() => expect(result.current).toEqual(RECOVERED));
  });

  it("stays empty on a host that answers with nothing, or not at all", async () => {
    // An older build or a dev shell without the command: the panel
    // shows every bus as "no state reported", never crashes on a map
    // that is not there.
    invokeFails = true;
    const { result } = renderHook(() => useBusHealth());
    act(() => attachListener?.());
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(result.current).toEqual({});

    invokeFails = false;
    health = null;
    const second = renderHook(() => useBusHealth());
    act(() => attachListener?.());
    await waitFor(() => expect(second.result.current).toEqual({}));
  });
});
