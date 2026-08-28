// @vitest-environment jsdom
//
// REPRO: `log-finished` arriving before the `open_log` invoke resolves
// leaves the app stuck in "loading" — the import status never clears
// and Cancel does nothing (the host's cancel flag is already gone).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let dialogPath: string | null = null;

function emit(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h({ payload });
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
        // A small file's pump can finish — and emit `log-finished` —
        // before the frontend has processed this command's resolution.
        // Model that ordering: the event lands first.
        emit("log-finished", { status: "ok", total: 9, count: 9 });
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

function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .filter((b) => b.closest(".toolbar") === null)
    .find((b) => b.textContent === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
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

describe("log-finished racing the open_log resolution", () => {
  it("still clears the import status", async () => {
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
    // Let everything settle: the pump already finished before the
    // command resolution was processed, so no further event is coming.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // The import is over — the loading chip and its Cancel must be gone.
    expect(document.querySelector(".trace-load")).toBeNull();

    // And a Cancel click in this state is a no-op host-side (the pump's
    // flag is already cleared), so it must not be the required way out.
    const cancel = document.querySelector<HTMLButtonElement>(".trace-load-cancel");
    if (cancel) {
      await act(async () => {
        fireEvent.click(cancel);
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(document.querySelector(".trace-load")).toBeNull();
    }
  });
});
