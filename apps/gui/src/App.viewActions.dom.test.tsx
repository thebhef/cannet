// @vitest-environment jsdom
//
// View-action commands (Task-35 keys) against the REAL App: layout
// undo/redo driven through actual Ctrl+Z / Ctrl+Y keydowns with panel
// focus churn and window blur/focus in between, and middle-click
// closing a tab. Tauri IPC mocked, dockview real.

import { afterEach, beforeEach, describe, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// ---- Tauri IPC mocks (same shape as App.midSessionCreate.dom.test) ----

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
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
}

/// The dockview tab element whose visible title matches.
function findTab(title: string): HTMLElement {
  const tab = Array.from(document.querySelectorAll<HTMLElement>(".dv-tab")).find(
    (t) => t.textContent === title,
  );
  if (!tab) throw new Error(`tab "${title}" not found`);
  return tab;
}

const key = (init: KeyboardEventInit) => {
  fireEvent.keyDown(document.activeElement ?? document.body, init);
};

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  // Reset hostState's module-level cache — the layout persisted by one
  // test must not be restored into the next test's mount.
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

describe("view actions", () => {
  it("undo/redo of an added panel survives focus churn and window blur/focus", async () => {
    await mountApp();

    await act(async () => {
      fireEvent.click(findButton("Add plot panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("no plot panel yet");
    });

    // Focus churn: activate another panel, blur/refocus the window.
    await act(async () => {
      fireEvent.pointerDown(findTab("Trace 1"));
      fireEvent.click(findTab("Trace 1"));
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });

    // Ctrl+Z: the added plot panel goes away.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (document.querySelector(".plot-panel"))
        throw new Error("plot panel still present after undo");
    });

    // More churn, then Ctrl+Y: it comes back.
    await act(async () => {
      fireEvent.pointerDown(findTab("Trace 1"));
      fireEvent.click(findTab("Trace 1"));
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      key({ key: "y", ctrlKey: true });
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel"))
        throw new Error("plot panel not restored by redo");
    });

    // And Mod+Shift+Z undone again — both redo chords work.
    await act(async () => {
      key({ key: "z", ctrlKey: true });
    });
    await waitFor(() => {
      if (document.querySelector(".plot-panel"))
        throw new Error("plot panel still present after second undo");
    });
    await act(async () => {
      key({ key: "Z", ctrlKey: true, shiftKey: true });
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel"))
        throw new Error("plot panel not restored by Mod+Shift+Z redo");
    });
  }, 30_000);

  it("middle-click on a tab closes the view", async () => {
    await mountApp();

    await act(async () => {
      fireEvent.click(findButton("Add plot panel"));
    });
    await waitFor(() => {
      if (!document.querySelector(".plot-panel")) throw new Error("no plot panel yet");
    });

    // Target the tab's content (what a real click lands on) — the
    // middle-click handler is the React default tab's, on the content
    // element inside the `.dv-tab` wrapper.
    const tab = findTab("Plot 1").querySelector<HTMLElement>(".dv-default-tab");
    if (!tab) throw new Error("plot tab content not found");
    // jsdom has no PointerEvent, and fireEvent's fallback drops the
    // `button` field — dispatch MouseEvents with pointer types so the
    // middle button survives.
    const press = (type: string) =>
      tab.dispatchEvent(new MouseEvent(type, { button: 1, bubbles: true, cancelable: true }));
    await act(async () => {
      press("pointerdown");
      press("pointerup");
    });
    await waitFor(() => {
      if (document.querySelector(".plot-panel"))
        throw new Error("plot panel still open after middle-click");
    });
  }, 30_000);
});
