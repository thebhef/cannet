// @vitest-environment jsdom
//
// Perf-harness connect robustness (ADR 0031). A capture launched with
// `--connect-on-start --perf-capture-secs <n>` used to silently skip
// `handleConnect` when readiness timed out (or leave a failed connect
// unretried), then run the capture window anyway and write a normal-
// shaped fps-0 report indistinguishable from real idle data. These tests
// pin the failure contract: a never-connected capture writes no report
// (`diag_capture_start` / `diag_capture_finish` are never invoked) and
// exits non-zero via the host's `exit_process` command, with the cause
// logged to the system log. A plain `--connect-on-start` (no capture)
// still just connects once, unretried.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const invokeOrder: string[] = [];
const systemLogCalls: { level: string; source: string; message: string }[] = [];
const exitCalls: number[] = [];
let connectRemoteServerCalls = 0;

// Per-test knobs (the mock is hoisted, so config rides in mutable state).
const knobs = {
  connectOnStart: false,
  captureSecs: null as number | null,
  // Empty bindings never satisfy the automation readiness predicate —
  // this is how a test forces the `!ready` branch without a real 30s
  // wait (combined with fake timers).
  bindings: [] as Record<string, unknown>[],
  // When set, `connect_remote_server` rejects every call, so no session
  // ever reaches "running" — this is how a test forces the retry budget
  // to exhaust.
  connectAlwaysFails: false,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeOrder.push(cmd);
    switch (cmd) {
      case "diag_autostart":
        return {
          project: "C:/fake/auto.cannet_prj",
          connectOnStart: knobs.connectOnStart,
          captureSecs: knobs.captureSecs,
          out: null,
          label: null,
          interact: null,
        };
      case "open_project":
        return {
          schema_version: 7,
          project_id: "11111111-2222-3333-4444-555555555555",
          buses: [{ id: "b1", name: "B1" }],
          interface_bindings: knobs.bindings,
          dbcs: [],
          local_virtual_buses: [],
          elements: [],
          layout: null,
        };
      case "connect_remote_server":
        connectRemoteServerCalls += 1;
        if (knobs.connectAlwaysFails) {
          throw new Error("ECONNREFUSED");
        }
        return {
          address: "127.0.0.1:9999",
          interfaces: [],
          subscriptions: [{ interface_id: "if0", channel: 0 }],
        };
      case "gui_emit_system_log":
        systemLogCalls.push({
          level: String(args?.level),
          source: String(args?.source),
          message: String(args?.message),
        });
        return null;
      case "exit_process":
        exitCalls.push(Number(args?.code));
        return null;
      case "clear_dbcs":
        return null;
      case "restore_scratch_capture":
        return { count: 0, first_index: 0, first_index_ts_ns: null, session_start_seconds: 0 };
      case "fetch_system_log":
      case "fetch_notes":
      case "fetch_trace_range":
      case "list_transmit_frames":
      case "list_signals":
      case "rbs_dirty":
        return [];
      case "fetch_filtered_trace":
      case "fetch_by_id_page":
        return { count: 0, start: 0, rows: [] };
      case "app_version":
        return "0.0.0-test";
      case "get_sidecar_status":
        return { phase: "offline", address: null };
      default:
        return null;
    }
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    const arr = listeners.get(event) ?? [];
    arr.push(handler);
    listeners.set(event, arr);
    return () => {
      const a = listeners.get(event) ?? [];
      const i = a.indexOf(handler);
      if (i >= 0) a.splice(i, 1);
    };
  }),
}));

const windowDestroy = vi.fn(async () => {});
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    onResized: async () => () => {},
    setTitle: async () => {},
    isMaximized: async () => false,
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    destroy: windowDestroy,
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

vi.mock("uplot", () => {
  class FakeUPlot {
    over = document.createElement("div");
    scales = { x: {}, y: {} };
    data: unknown = [[]];
    width = 600;
    constructor(_opts: unknown, data: unknown, el: HTMLElement) {
      this.data = data;
      el.appendChild(document.createElement("canvas"));
    }
    setData() {}
    setScale() {}
    setSeries() {}
    setSelect() {}
    setSize() {}
    redraw() {}
    destroy() {}
    posToVal() {
      return 0;
    }
    valToPos() {
      return 0;
    }
  }
  return { default: FakeUPlot };
});
vi.mock("uplot/dist/uPlot.min.css", () => ({}));

import { App } from "./App";
import { hydrateState } from "./hostState";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeOrder.length = 0;
  systemLogCalls.length = 0;
  exitCalls.length = 0;
  connectRemoteServerCalls = 0;
  windowDestroy.mockClear();
  knobs.connectOnStart = false;
  knobs.captureSecs = null;
  knobs.bindings = [];
  knobs.connectAlwaysFails = false;
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Drains the automation effect's chain of `setTimeout`-based polls
// (readiness, per-attempt confirm, inter-retry delay) without a real
// multi-second wait.
async function runAutomationTimers(totalMs: number) {
  const STEP_MS = 200;
  let remaining = totalMs;
  while (remaining > 0) {
    const step = Math.min(STEP_MS, remaining);
    remaining -= step;
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
  }
}

// The automation effect's `waitUntil` bounds its poll loop with
// `performance.now()`, not `Date.now()` — vitest's fake-timer default
// doesn't fake `performance`, which otherwise leaves the elapsed-time
// check reading real (near-zero) wall-clock time forever and the loop
// never times out no matter how far the mocked clock is advanced.
function useAutomationFakeTimers() {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "performance",
    ],
  });
}

describe("perf-harness connect robustness", () => {
  it("a capture that never becomes ready logs the cause, writes no report, and exits non-zero", async () => {
    useAutomationFakeTimers();
    knobs.connectOnStart = true;
    knobs.captureSecs = 5;
    knobs.bindings = []; // never satisfies the readiness predicate

    render(<App />);
    // AUTOMATION_READY_TIMEOUT_MS is 30s.
    await runAutomationTimers(31000);

    expect(
      systemLogCalls.some(
        (c) => c.level === "error" && c.message.includes("not ready"),
      ),
    ).toBe(true);
    expect(invokeOrder).not.toContain("diag_capture_start");
    expect(invokeOrder).not.toContain("diag_capture_finish");
    expect(exitCalls).toEqual([1]);
    expect(windowDestroy).not.toHaveBeenCalled();
  });

  it("retries a bounded number of times, then fails loudly when connect never establishes a session", async () => {
    useAutomationFakeTimers();
    knobs.connectOnStart = true;
    knobs.captureSecs = 5;
    knobs.bindings = [
      { kind: "remote", server: "127.0.0.1:9999", interface: "if0", bus_id: "b1" },
    ];
    knobs.connectAlwaysFails = true;

    render(<App />);
    // Readiness is near-instant (bindings present); the retry budget is
    // 3 attempts * up to 3s confirm + 2 * 1s inter-retry delay.
    await runAutomationTimers(15000);

    expect(connectRemoteServerCalls).toBe(3);
    expect(
      systemLogCalls.some(
        (c) => c.level === "warn" && c.message.includes("did not"),
      ),
    ).toBe(true);
    expect(
      systemLogCalls.some(
        (c) => c.level === "error" && c.message.includes("failed to connect"),
      ),
    ).toBe(true);
    expect(invokeOrder).not.toContain("diag_capture_start");
    expect(invokeOrder).not.toContain("diag_capture_finish");
    expect(exitCalls).toEqual([1]);
    expect(windowDestroy).not.toHaveBeenCalled();
  });

  it("a plain --connect-on-start (no capture) logs but does not retry or exit when never ready", async () => {
    useAutomationFakeTimers();
    knobs.connectOnStart = true;
    knobs.captureSecs = null;
    knobs.bindings = [];

    render(<App />);
    await runAutomationTimers(31000);

    expect(
      systemLogCalls.some(
        (c) => c.level === "error" && c.message.includes("not ready"),
      ),
    ).toBe(true);
    expect(connectRemoteServerCalls).toBe(0);
    expect(exitCalls).toEqual([]);
    expect(windowDestroy).not.toHaveBeenCalled();
  });
});
