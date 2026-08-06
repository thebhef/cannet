// @vitest-environment jsdom
//
// The startup splash covers the app until `max(5 s, boot settled)`, and
// the boot settles on *every* path — including a `restore_scratch_capture`
// that throws. A splash that only lifts on the happy path leaves the app
// permanently unusable, so the failing restore is the case pinned here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "diag_autostart":
        return {
          project: "C:/fake/auto.cannet_prj",
          connectOnStart: false,
          captureSecs: null,
          out: null,
          label: null,
        };
      case "open_project":
        return {
          schema_version: 7,
          project_id: "11111111-2222-3333-4444-555555555555",
          buses: [],
          interface_bindings: [],
          dbcs: [],
          local_virtual_buses: [],
          elements: [],
          layout: null,
        };
      case "restore_scratch_capture":
        throw new Error("scratch capture unreadable");
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
import { SPLASH_MIN_MS } from "./SplashOverlay";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("startup splash", () => {
  it("covers the app at boot and still lifts when the restore fails", async () => {
    render(<App />);
    // Up from the first paint, disclaimer and all.
    expect(screen.getByTestId("splash-overlay")).toBeInTheDocument();
    expect(
      screen.getByText(/safe state to have its CAN traffic disrupted/i),
    ).toBeInTheDocument();
    // The boot errored out of `restore_scratch_capture`; the splash must
    // still come down once the floor elapses.
    await waitFor(
      () => expect(screen.queryByTestId("splash-overlay")).not.toBeInTheDocument(),
      { timeout: SPLASH_MIN_MS + 3000 },
    );
  });
});
