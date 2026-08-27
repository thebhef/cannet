// @vitest-environment jsdom
//
// An import that has finished leaves the trace elements *stopped*, at
// the count the pump reports.
//
// The frames are all in the store and nothing more is coming, so a
// trace element that stayed "running" is reporting a state the session
// is not in — and every plot area over it keeps its self-paced resample
// loop alive for a picture that cannot change. The count matters as
// much as the freeze: the `trace-grew` sampler is up to a tick behind
// the pump, and a window frozen at its number loses the tail.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let dialogPath: string | null = null;

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
      case "get_interfaces":
        return [];
      case "fetch_filtered_trace":
      case "fetch_by_id_page":
        return { count: 0, start: 0, rows: [] };
      case "get_state":
        return {
          last_project: null,
          layout: null,
          recent_blfs: [],
          recent_commands: [],
          blf_channel_maps: {},
        };
      case "set_state":
      case "clear_trace_store":
        return null;
      case "scan_blf_channels":
        return {
          channels: [0],
          frame_count: 9,
          first_timestamp_ns: 1_000_000_000,
          last_timestamp_ns: 2_000_000_000,
          start_unix_nanos: 1_700_000_000_000_000_000,
          markers: [],
        };
      case "open_log":
        return { blf_path: String(args?.blfPath) };
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
  open: vi.fn(async () => dialogPath),
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
import { toolbarChip } from "./toolbarTestKit";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function emit(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h({ payload });
}

function traceGrew(count: number) {
  return {
    count,
    first_index: 0,
    first_index_ts_ns: 1_000_000_000,
    frames_per_second: 0,
    frames_per_second_rx: 0,
    frames_per_second_tx: 0,
    frames_per_second_by_bus: [],
    bus_load_percent: null,
    frames_dropped_before_session: 0,
    session_start_seconds: 1_700_000_000,
    buffer_seconds: 1,
    scratch_bytes: null,
    mem_bytes: null,
    tail: [],
  };
}

function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .filter((b) => b.closest(".toolbar") === null)
    .find((b) => b.textContent === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
}

function statuses(): string[] {
  return Array.from(document.querySelectorAll(".trace-status")).map((e) => e.textContent ?? "");
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  invokeCalls.length = 0;
  dialogPath = "/logs/one.blf";
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/// Import a BLF end to end: pick the path, confirm the channel map, let
/// the host report the frames it appended, then finish the pump.
async function importBlf(finalCount: number) {
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
  await act(async () => {
    fireEvent.click(toolbarChip("Import"));
  });
  await waitFor(() => findButton("Open"));
  await act(async () => {
    fireEvent.click(findButton("Open"));
  });
  await waitFor(() => {
    if (!invokeCalls.some((c) => c.cmd === "open_log")) throw new Error("open_log not called");
  });
  await act(async () => {
    emit("trace-grew", traceGrew(finalCount));
  });
  return finalCount;
}

describe("a finished import leaves the trace stopped", () => {
  it("every trace element reads stopped once the pump reports it is done", async () => {
    const total = await importBlf(9);
    expect(statuses().every((s) => s === "running")).toBe(true);
    await act(async () => {
      emit("log-finished", { status: "ok", total, count: total });
    });
    expect(statuses()).not.toHaveLength(0);
    expect(statuses().every((s) => s === "stopped")).toBe(true);
  });
});

describe("the frozen window is the pump's count, not the sampler's", () => {
  it("keeps the frames appended since the last trace-grew tick", async () => {
    // `trace-grew` runs on a timer, so the count it last reported is
    // behind the pump's own by up to a tick — on a fast import, tens of
    // thousands of frames. Freezing the window there would drop them,
    // and `reanchorToSession` would then make the shorter window
    // permanent. The event carries the store's real length for exactly
    // this.
    await importBlf(4);
    await act(async () => {
      emit("log-finished", { status: "ok", total: 9, count: 9 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    const scans = invokeCalls
      .filter((c) => c.cmd === "fetch_by_id_page")
      .map((c) => c.args.scanEnd);
    expect(scans[scans.length - 1]).toBe(9);
  });
});
