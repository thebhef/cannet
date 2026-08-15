// @vitest-environment jsdom
//
// Picking a BLF starts a header-only census walk over the *whole* file
// before the channel-mapping dialog has anything to show. That walk is
// seconds on a large log (and tens of seconds in a dev build), so
// without a notice the pick lands on an app that appears to have done
// nothing. Pinned here by stalling the scan command and watching the
// status line.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

// Resolved by the test when it wants the census to finish.
let releaseScan: (() => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "fetch_system_log":
      case "fetch_notes":
      case "fetch_trace_range":
      case "list_transmit_frames":
      case "list_signals":
      case "rbs_dirty":
      case "get_interfaces":
        return [];
      case "scan_blf_channels":
        await new Promise<void>((resolve) => {
          releaseScan = resolve;
        });
        return {
          channels: [0],
          frame_count: 1,
          first_timestamp_ns: 1_000_000_000,
          last_timestamp_ns: 1_000_000_000,
          start_unix_nanos: 1_700_000_000_000_000_000,
          markers: [],
        };
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
  open: vi.fn(async () => "/logs/huge-capture.blf"),
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

function statusText(): string {
  return document.querySelector(".status")?.textContent ?? "";
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  releaseScan = null;
});

afterEach(() => {
  releaseScan?.();
  cleanup();
  vi.unstubAllGlobals();
});

describe("BLF census feedback", () => {
  it("says it is scanning from the pick until the mapping dialog opens", async () => {
    render(<App />);
    await waitFor(() => {
      if (!document.querySelector(".trace-panel .trace-status"))
        throw new Error("seeded layout not mounted yet");
    });

    await act(async () => {
      fireEvent.click(findButton("Import trace…"));
    });

    // The census is still walking: the notice is up and the dialog is
    // not — which is exactly the window the user was staring at.
    await waitFor(() => {
      if (!statusText().includes("Scanning huge-capture.blf"))
        throw new Error(`no scan notice, status was: ${statusText()}`);
    });
    expect(
      Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Open"),
    ).toBe(false);

    // Let it finish: the dialog takes over and the notice goes away.
    await act(async () => {
      releaseScan?.();
      releaseScan = null;
    });
    await waitFor(() => findButton("Open"));
    expect(statusText()).not.toContain("Scanning");
  }, 30_000);
});
