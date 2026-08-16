// @vitest-environment jsdom
//
// Go-to-view (Mod+P, ADR 0018/0037) against the REAL App: the palette
// this chord opens is a *different* list from the command palette's, so
// an alias that lets an old name still find a renamed view has to be
// carried on both. The Database panel is the case that matters — it was
// the "DBC panel" before it grew every other signal-defining format
// (ADR 0052) — and typing its old name here must land on it.

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
    return () => {};
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
    constructor(_opts: unknown, _data: unknown, el: HTMLElement) {
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
  listeners.clear();
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountApp() {
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
}

/// Open go-to-view (Mod+P) and type `query` into it; returns the
/// labels the palette is offering.
async function gotoMatches(query: string): Promise<string[]> {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "p", ctrlKey: true });
  });
  const input = document.querySelector<HTMLInputElement>(".palette input.palette-input");
  if (!input) throw new Error("go-to-view palette did not open");
  expect(input.placeholder).toBe("Go to view…");
  await act(async () => {
    fireEvent.change(input, { target: { value: query } });
  });
  return Array.from(document.querySelectorAll(".palette-item-label")).map(
    (e) => e.textContent ?? "",
  );
}

describe("go-to-view palette", () => {
  it("finds the Database panel by its old name", async () => {
    await mountApp();
    expect(await gotoMatches("DBC")).toContain("Database");
  }, 30_000);

  it("still finds it by its current name", async () => {
    await mountApp();
    expect(await gotoMatches("Database")).toContain("Database");
  }, 30_000);
});
