// @vitest-environment jsdom
//
// A trace or plot view added *mid-session* must hook straight into the
// live session buffer — anchored at 0, spanning the existing frames,
// following live — exactly like a view that was present at session
// start. (It used to come up as an empty, stopped window; that special
// case is gone.) Mounts the REAL App with the Tauri IPC mocked, drives
// a session with synthetic `trace-grew` events, then adds new panels
// through the real toolbar buttons.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// ---- Tauri IPC mocks --------------------------------------------------

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
function emitTauri(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h({ payload });
}

// Commands with their args, so the test can assert *what window* a
// panel asked the host for, not just that it asked.
const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args: args ?? {} });
    switch (cmd) {
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

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    onResized: async () => () => {},
    setTitle: async () => {},
    isMaximized: async () => false,
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    destroy: async () => {},
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

// uPlot touches `matchMedia` at import time, which jsdom lacks — same
// stub the PlotPanel dom test uses.
vi.mock("uplot", () => {
  class FakeUPlot {
    over = document.createElement("div");
    scales = { x: {}, y: {} } as Record<string, { min?: number; max?: number }>;
    data: unknown = [[]];
    width = 600;
    constructor(_opts: unknown, data: unknown, el: HTMLElement) {
      this.data = data;
      el.appendChild(document.createElement("canvas"));
    }
    setData(d: unknown) {
      this.data = d;
    }
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

import { StrictMode } from "react";

import type { TraceFrameRecord, TraceGrew } from "./types";
import { App } from "./App";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function frame(index: number): TraceFrameRecord {
  return {
    index,
    timestamp_seconds: 1000 + index / 1000,
    channel: 0,
    id: 0x100 + (index % 16),
    extended: false,
    direction: "Rx",
    kind: "classic" as unknown as TraceFrameRecord["kind"],
    data: [index % 256, 0, 0, 0],
    decoded: null,
    bus_id: "b1",
  };
}

function grew(count: number): TraceGrew {
  const tailLen = Math.min(256, count);
  return {
    count,
    first_index: 0,
    first_index_ts_ns: null,
    frames_per_second: 1000,
    frames_per_second_rx: 1000,
    frames_per_second_tx: 0,
    frames_per_second_by_bus: [{ bus_id: null, frames_per_second: 1000 }],
    frames_dropped_before_session: 0,
    session_start_seconds: 1000,
    buffer_seconds: 1,
    scratch_bytes: null,
    mem_bytes: null,
    tail: Array.from({ length: tailLen }, (_, i) => frame(count - tailLen + i)),
  };
}

function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeCalls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("views created mid-session", () => {
  it("a trace panel added mid-session comes up live over the buffer", async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // Seeded default layout: one trace panel, created before any
    // session — it starts stopped and stays stopped even once the
    // session is live (a running session must not retroactively start
    // views the user stopped or never started).
    const seededStatus = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".trace-panel .trace-status");
      if (!el) throw new Error("seeded trace panel not mounted yet");
      return el;
    });
    expect(seededStatus).toHaveClass("trace-status-stopped");

    // Drive a live session: the host has 5000 frames buffered and is
    // still streaming.
    for (let tick = 0; tick < 3; tick++) {
      // eslint-disable-next-line no-await-in-loop -- sequential ticks on purpose
      await act(async () => {
        emitTauri("trace-grew", grew(5000 + tick * 100));
      });
    }
    expect(seededStatus).toHaveClass("trace-status-stopped");

    const callsBeforeAdd = invokeCalls.length;

    // Add a trace panel mid-session through the real toolbar path.
    await act(async () => {
      fireEvent.click(findButton("Add trace"));
    });

    // The new panel is *running*: its toolbar shows the running status
    // (Pause/Stop, not Start). `trace-status-running` renders only when
    // the element's TraceState has `end === null` — i.e. the window
    // follows the live buffer.
    await waitFor(() => {
      const running = document.querySelector(".trace-panel .trace-status-running");
      if (!running) throw new Error("new trace panel is not running");
    });

    // ...and its window is anchored at 0, spanning the whole existing
    // buffer: the by-id view (the new panel's mode) fetches its
    // snapshot with `scanStart` = the trace window's offset. A running
    // window snapshots to the live tip (`scanEnd` past-the-end). The
    // old behavior anchored at the current count (scanStart 5200,
    // scanEnd 5200, stopped) — that must not come back.
    await waitFor(() => {
      const fetches = invokeCalls
        .slice(callsBeforeAdd)
        .filter((c) => c.cmd === "fetch_by_id_page");
      const live = fetches.find(
        (c) => c.args.scanStart === 0 && c.args.scanEnd === Number.MAX_SAFE_INTEGER,
      );
      if (!live) throw new Error("no whole-buffer live fetch from the new panel yet");
    });
  }, 30_000);

  it("a plot panel added mid-session comes up live", async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await waitFor(() => {
      if (!document.querySelector(".trace-panel .trace-status"))
        throw new Error("seeded layout not mounted yet");
    });

    await act(async () => {
      emitTauri("trace-grew", grew(5000));
    });

    await act(async () => {
      fireEvent.click(findButton("Add plot panel"));
    });

    // The plot shares the trace window state (same registry entry shape,
    // same `create` path, same TraceControls): running means its window
    // follows the live buffer from index 0.
    await waitFor(() => {
      const status = document.querySelector<HTMLElement>(".plot-panel .trace-status");
      if (!status) throw new Error("plot panel not mounted yet");
      expect(status).toHaveClass("trace-status-running");
    });
  }, 30_000);
});
