// @vitest-environment jsdom
//
// One save gesture, two formats. The save dialog offers Vector BLF and
// ASAM MDF; whichever filter the user picks reaches the host as an
// explicit `format`, never as something the host infers from the path.
// Mounts the REAL App with the Tauri IPC mocked, drives a session with a
// synthetic `trace-grew` so Save Capture has something to save, and
// pins the arguments the command goes out with.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
function emitTauri(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h({ payload });
}

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

// What the dialog hands back — the test sets it per case, because the
// stamped extension is the only way an OS save dialog reports the filter
// the user chose.
let savedPath: string | null = null;
const saveOptions: Array<Record<string, unknown>> = [];

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async (opts?: Record<string, unknown>) => {
    saveOptions.push(opts ?? {});
    return savedPath;
  }),
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

import type { TraceGrew } from "./types";
import { App } from "./App";
import { toolbarChip } from "./toolbarTestKit";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function grew(count: number): TraceGrew {
  return {
    count,
    first_index: 0,
    first_index_ts_ns: null,
    frames_per_second: 0,
    frames_per_second_rx: 0,
    frames_per_second_tx: 0,
    frames_per_second_by_bus: [],
    bus_load_percent: null,
    frames_dropped_before_session: 0,
    session_start_seconds: 1000,
    buffer_seconds: 1,
    scratch_bytes: null,
    mem_bytes: null,
    tail: [],
  };
}

/// Mount the app, get a non-empty capture into it, and run Save Capture
/// through the real toolbar button.
async function saveThrough(path: string | null) {
  savedPath = path;
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
  await act(async () => {
    emitTauri("trace-grew", grew(1234));
  });
  await act(async () => {
    fireEvent.click(toolbarChip("Capture"));
  });
  await waitFor(() => {
    if (saveOptions.length === 0) throw new Error("save dialog not opened yet");
  });
}

function lastSaveCall() {
  const calls = invokeCalls.filter((c) => c.cmd === "save_capture");
  return calls[calls.length - 1];
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeCalls.length = 0;
  saveOptions.length = 0;
  savedPath = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Save Capture", () => {
  it("offers both capture formats in the dialog", async () => {
    await saveThrough(null);
    const filters = saveOptions[0].filters as Array<{ extensions: string[] }>;
    expect(filters.map((f) => f.extensions[0])).toEqual(["blf", "mf4"]);
  });

  it("sends the format the chosen filter implies, not the path", async () => {
    await saveThrough("/logs/run.mf4");
    await waitFor(() => {
      if (!lastSaveCall()) throw new Error("save_capture not invoked yet");
    });
    expect(lastSaveCall()?.args).toMatchObject({
      path: "/logs/run.mf4",
      format: "mdf",
    });
  });

  it("still saves BLF when the BLF filter is the one that stamped the path", async () => {
    await saveThrough("/logs/run.blf");
    await waitFor(() => {
      if (!lastSaveCall()) throw new Error("save_capture not invoked yet");
    });
    expect(lastSaveCall()?.args).toMatchObject({
      path: "/logs/run.blf",
      format: "blf",
    });
  });
});
