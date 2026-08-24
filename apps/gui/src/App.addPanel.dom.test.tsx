// @vitest-environment jsdom
//
// The toolbar's six "Add …" buttons all route through the single
// `addPanel(kind)` handler over the `elementPanelComponent` kind→
// component registry. Each opens a dockview panel whose tab carries the
// element's model-owned default name (ADR 0019). Mounts the REAL App
// with the Tauri IPC mocked and clicks each button through the real
// toolbar path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

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
import { addPanelChip } from "./toolbarTestKit";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function tabTitles(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".dv-default-tab-content"),
  ).map((el) => el.textContent ?? "");
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("addPanel(kind) over the panel registry", () => {
  // Add-menu entry → the model-owned default name the new element's tab
  // should show (the seed layout already has a "Trace 1", so an added
  // trace is "Trace 2").
  const cases: Array<[string, string]> = [
    ["Trace", "Trace 2"],
    ["Plot Panel", "Plot 1"],
    ["Signal View", "Signals 1"],
    ["Transmit Panel", "Transmit 1"],
    ["RBS Panel", "RBS 1"],
    ["Color Map", "Color Map 1"],
  ];

  it("each Add-menu entry opens a panel with the right default tab", async () => {
    render(<App />);
    // Wait for the seeded default layout (one trace panel) to mount.
    await waitFor(() => {
      if (!document.querySelector(".trace-panel .trace-status"))
        throw new Error("seeded layout not mounted yet");
    });
    expect(tabTitles()).toContain("Trace 1");

    for (const [label, expectedTitle] of cases) {
      // eslint-disable-next-line no-await-in-loop -- one add at a time
      await act(async () => {
        fireEvent.click(addPanelChip(label));
      });
      // eslint-disable-next-line no-await-in-loop -- assert before next add
      await waitFor(() => {
        if (!tabTitles().includes(expectedTitle))
          throw new Error(`tab "${expectedTitle}" not present after "${label}"`);
      });
    }
  }, 30_000);
});
