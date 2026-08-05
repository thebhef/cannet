// @vitest-environment jsdom
//
// The native window title is pushed to the OS chrome by an App effect.
// `windowTitle` / `captureLabel` cover the formatting; this covers the
// wiring — that the REAL App fetches `app_version`, builds a title from
// it, and hands it to `getCurrentWindow().setTitle`.

import { afterEach, beforeEach, describe, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const setTitle = vi.fn(async (_title: string) => {});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "fetch_system_log":
      case "fetch_notes":
      case "fetch_trace_range":
      case "list_transmit_frames":
      case "list_signals":
      case "list_value_tables":
      case "rbs_dirty":
        return [];
      case "fetch_filtered_trace":
      case "fetch_by_id_page":
        return { count: 0, start: 0, rows: [] };
      case "app_version":
        return "v9.9.9-test";
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
    setTitle,
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

import { App } from "./App";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  setTitle.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the window title effect", () => {
  // No project file and no capture, so only the app segment shows. The
  // bullet is not incidental: seeding the default layout is a model
  // edit, so a fresh session is already dirty — which is exactly the
  // flag the close prompt reads.
  it("titles the window with the host's version and the unsaved marker", async () => {
    render(<App />);
    await waitFor(() => {
      const titles = setTitle.mock.calls.map(([t]) => t);
      if (!titles.includes("• cannet 9.9.9-test"))
        throw new Error(`title never settled: ${JSON.stringify(titles)}`);
    });
  }, 30_000);
});
