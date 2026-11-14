// @vitest-environment jsdom
//
// The trace-window mirror: the host holds every element's window, the
// frontend hydrates once and then follows the change event's payload,
// and a run control is a host command — the frontend computes no window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
let hostWindows: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_trace_windows") return hostWindows;
    if (cmd === "get_settings") return {};
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    return () => {};
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  TRACE_WINDOWS_CHANGED_EVENT,
  controlTraceWindow,
  syncTraceWindows,
  useTraceWindows,
} from "./traceWindows";

beforeEach(() => {
  listeners.clear();
  hostWindows = {};
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useTraceWindows", () => {
  it("hydrates from the host, then follows the change event's map", async () => {
    hostWindows = { a: { start: 0, end: null, isPaused: false } };
    const { result } = renderHook(() => useTraceWindows());
    await waitFor(() => expect(result.current.a).toEqual({ start: 0, end: null, isPaused: false }));
    await waitFor(() => expect(listeners.get(TRACE_WINDOWS_CHANGED_EVENT)?.length).toBe(1));
    act(() => {
      for (const h of listeners.get(TRACE_WINDOWS_CHANGED_EVENT) ?? []) {
        h({ payload: { a: { start: 0, end: 40, isPaused: true } } });
      }
    });
    expect(result.current).toEqual({ a: { start: 0, end: 40, isPaused: true } });
  });
});

describe("trace-window commands", () => {
  it("a run control names the element and the action, nothing else", async () => {
    await controlTraceWindow("el-1", "pause");
    expect(invoke).toHaveBeenCalledWith("trace_window_control", {
      elementId: "el-1",
      action: "pause",
    });
  });

  it("the registry's id set is handed to the host whole", async () => {
    await syncTraceWindows(["a", "b"]);
    expect(invoke).toHaveBeenCalledWith("sync_trace_windows", { elementIds: ["a", "b"] });
  });
});
