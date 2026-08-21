// @vitest-environment jsdom
//
// "Reload all from disk" re-reads each loaded DBC *in place*, through
// the same `add_dbc` swap the watcher's auto-reload performs — not
// through `clear_dbcs` + re-add, which would make every re-read look to
// the host like a first load and hide that it is replacing definitions
// something may be transmitting from (ADR 0053 §1).
//
// Mounts the REAL App with the Tauri IPC mocked and drives the project
// panel's own Add… / Reload all from disk buttons.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

/// What the host answers with once `a.dbc` is loaded.
const DBC_LIST = [{ dbc_path: "/tmp/a.dbc", message_count: 1, buses: ["p1"] }];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args: args ?? {} });
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
      case "add_dbc":
      case "remove_dbc":
        return DBC_LIST;
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
  open: vi.fn(async () => "/tmp/a.dbc"),
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

function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeCalls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Reload all from disk", () => {
  it("swaps each database in place instead of clearing the set", async () => {
    render(<App />);
    await waitFor(() => {
      if (!document.querySelector(".trace-panel .trace-status"))
        throw new Error("seeded layout not mounted yet");
    });
    await act(async () => {
      fireEvent.click(findButton("Add…"));
    });
    await waitFor(() => {
      if (!invokeCalls.some((c) => c.cmd === "add_dbc"))
        throw new Error("the database was never added");
    });

    invokeCalls.length = 0;
    await act(async () => {
      fireEvent.click(findButton("Reload all from disk"));
    });
    await waitFor(() => {
      if (!invokeCalls.some((c) => c.cmd === "add_dbc"))
        throw new Error("the database was never re-read");
    });

    expect(invokeCalls.filter((c) => c.cmd === "add_dbc").map((c) => c.args)).toEqual([
      { path: "/tmp/a.dbc" },
    ]);
    expect(invokeCalls.map((c) => c.cmd)).not.toContain("clear_dbcs");
    expect(invokeCalls.map((c) => c.cmd)).not.toContain("remove_dbc");
  }, 30_000);
});
