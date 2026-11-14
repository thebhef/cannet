// @vitest-environment jsdom
//
// Trace windows are host state (`trace_windows.rs`): the registry hands
// the host its element ids, mirrors the host's map, and moves no window
// itself — not on a run control, not on Clear, not when an import ends.
//
// An import that has finished leaves every window *stopped* at the
// count the pump reports: the frames are all in the store and nothing
// more is coming, so a window left "running" reports a state the
// session is not in, and every plot area over it keeps its self-paced
// resample loop alive for a picture that cannot change. The host does
// the freeze (at the store's own length, tested there); the frontend
// takes the count from the same event, because the `trace-grew` sampler
// is up to a tick behind the pump and a window paged against its number
// loses the tail.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let dialogPath: string | null = null;

/// The element ids the registry last handed the host.
function syncedIds(): string[] {
  const syncs = invokeCalls.filter((c) => c.cmd === "sync_trace_windows");
  return (syncs[syncs.length - 1]?.args.elementIds as string[] | undefined) ?? [];
}

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
      case "sync_trace_windows":
      case "trace_window_control":
        return null;
      case "get_trace_windows":
        return {};
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

/// The host publishing its map: every synced element gets `window`.
function hostWindows(window: { start: number; end: number | null; isPaused: boolean }) {
  emit(
    "trace-windows-changed",
    Object.fromEntries(syncedIds().map((id) => [id, window])),
  );
}
const RUNNING = { start: 0, end: null, isPaused: false };

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
    // The import's session start ran every window from 0, host-side.
    hostWindows(RUNNING);
  });
  return finalCount;
}

describe("the registry mirrors the host's trace windows", () => {
  it("hands the host every element id, and shows whatever window the host publishes", async () => {
    render(<App />);
    await waitFor(() => {
      if (!document.querySelector(".trace-panel .trace-status"))
        throw new Error("seeded layout not mounted yet");
    });
    await waitFor(() => expect(syncedIds().length).toBeGreaterThan(0));
    // Until the host answers, a view reads an empty stopped window.
    expect(statuses().every((s) => s === "stopped")).toBe(true);
    await act(async () => hostWindows(RUNNING));
    expect(statuses().every((s) => s === "running")).toBe(true);
    await act(async () => hostWindows({ start: 0, end: 5, isPaused: true }));
    expect(statuses().every((s) => s === "paused")).toBe(true);
  });

  it("Clear restarts the windows host-side: the frontend moves none itself", async () => {
    render(<App />);
    await waitFor(() => expect(syncedIds().length).toBeGreaterThan(0));
    // A session holding frames enables the toolbar Clear.
    await act(async () => {
      emit("trace-grew", traceGrew(9));
      hostWindows({ start: 0, end: 5, isPaused: true });
    });
    await act(async () => {
      fireEvent.click(toolbarChip("Clear"));
    });
    await waitFor(() => {
      if (!invokeCalls.some((c) => c.cmd === "clear_trace_store")) throw new Error("no clear");
    });
    // The windows are still what the host last said, until it says
    // otherwise.
    expect(statuses().every((s) => s === "paused")).toBe(true);
  });
});

describe("a finished import leaves the trace stopped", () => {
  it("every trace element reads stopped once the host freezes the windows", async () => {
    const total = await importBlf(9);
    expect(statuses().every((s) => s === "running")).toBe(true);
    await act(async () => {
      emit("log-finished", { status: "ok", total, count: total });
    });
    // The frontend freezes nothing itself…
    expect(statuses().every((s) => s === "running")).toBe(true);
    // …the host does, and the mirror shows it.
    await act(async () => hostWindows({ start: 0, end: total, isPaused: false }));
    expect(statuses()).not.toHaveLength(0);
    expect(statuses().every((s) => s === "stopped")).toBe(true);
  });
});

describe("the frozen window is the pump's count, not the sampler's", () => {
  it("keeps the frames appended since the last trace-grew tick", async () => {
    // `trace-grew` runs on a timer, so the count it last reported is
    // behind the pump's own by up to a tick — on a fast import, tens of
    // thousands of frames. The host freezes the windows at the store's
    // real length; the frontend has to page against that length too,
    // which the event carries for exactly this.
    await importBlf(4);
    await act(async () => {
      emit("log-finished", { status: "ok", total: 9, count: 9 });
      hostWindows({ start: 0, end: 9, isPaused: false });
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
