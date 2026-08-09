// @vitest-environment jsdom
//
// Element-registry undo/redo against the REAL App: a view change made
// inside a panel (the trace panel's mode toggle) reversed by actual
// Ctrl+Z / Ctrl+Y, and interleaved with a layout step so one chord
// always reverses the most recent change. Tauri IPC mocked, dockview
// real.

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

import { StrictMode } from "react";

import { App } from "./App";
import { hydrateState } from "./hostState";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
}

/// The trace panel's selected view mode, as its toolbar shows it.
function traceMode(): string {
  return Array.from(document.querySelectorAll(".trace-panel .mode-toggle button.active"))
    .map((b) => b.textContent?.replace(/\s+/g, " ").trim())
    .join();
}

/// Click one of the trace panel's mode buttons.
function clickMode(label: string): void {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".trace-panel .mode-toggle button"),
  ).find((b) => b.textContent?.replace(/\s+/g, " ").trim() === label);
  if (!btn) throw new Error(`mode button "${label}" not found`);
  fireEvent.click(btn);
}

const key = (init: KeyboardEventInit) => {
  fireEvent.keyDown(document.activeElement ?? document.body, init);
};

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

async function mountApp() {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
}

describe("element undo", () => {
  it("reverses a view change made inside a panel, and redoes it", async () => {
    await mountApp();
    // The seeded trace view opens by-ID; switching it writes the
    // element's config, which is what the history records.
    expect(traceMode()).toBe("by ID");
    await act(async () => {
      clickMode("trace");
    });
    expect(traceMode()).toBe("trace");

    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    // The panel repaints from the restored element (the rehydrate path).
    await waitFor(() => {
      if (traceMode() !== "by ID") throw new Error(`undo left mode "${traceMode()}"`);
    });

    await act(async () => {
      key({ key: "y", ctrlKey: true });
    });
    await waitFor(() => {
      if (traceMode() !== "trace") throw new Error(`redo left mode "${traceMode()}"`);
    });
  }, 30_000);

  it("adding a panel is one step — the panel's own config seed is not another", async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(findButton("Add plot panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("no plot panel yet");
    });
    // One chord, and the added panel is gone: the config the panel
    // persisted as it mounted must not have consumed the first undo.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (document.querySelector(".plot-panel"))
        throw new Error("plot panel still present after one undo");
    });
  }, 30_000);

  it("undoes the most recent change, whichever stack it lives on", async () => {
    await mountApp();
    await act(async () => {
      fireEvent.click(findButton("Add plot panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("no plot panel yet");
    });
    await act(async () => {
      clickMode("trace");
    });
    expect(traceMode()).toBe("trace");

    // Newest first: the view change, then the panel that preceded it.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (traceMode() !== "by ID") throw new Error(`undo left mode "${traceMode()}"`);
    });
    expect(document.querySelector(".plot-panel")).not.toBeNull();

    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (document.querySelector(".plot-panel"))
        throw new Error("plot panel still present after the second undo");
    });
    expect(traceMode()).toBe("by ID");

    // And back out again, oldest-undone first.
    await act(async () => {
      key({ key: "y", ctrlKey: true });
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("plot panel not restored");
    });
    expect(traceMode()).toBe("by ID");
    await act(async () => {
      key({ key: "y", ctrlKey: true });
    });
    await waitFor(() => {
      if (traceMode() !== "trace") throw new Error(`redo left mode "${traceMode()}"`);
    });
  }, 30_000);
});
