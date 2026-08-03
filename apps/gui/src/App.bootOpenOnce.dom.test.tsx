// @vitest-environment jsdom
//
// The boot project-open (dockview `onReady` → `open_project` →
// `applyProject`) must run exactly once. Dockview re-initializes under
// StrictMode, so `onReady` fires twice; without a latch the second run
// re-opens the project and re-adds every DBC, and the resulting
// dbc-changed refresh storm lands mid-boot — observed as a blank app
// when it races live streaming (self-driving automation runs).
// Regression for the double "opened project" boot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const openProjectCalls: string[] = [];
// Every invoke, in call order — the ordering test asserts the project
// has fully applied before automation connects.
const invokeOrder: string[] = [];
// Per-test knobs (the mock is hoisted, so config rides in mutable state).
const knobs = {
  connectOnStart: false,
  dbcDelayMs: 0,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeOrder.push(cmd);
    switch (cmd) {
      case "diag_autostart":
        // Automation names a project — the boot path must open it.
        return {
          project: "C:/fake/auto.cannet_prj",
          connectOnStart: knobs.connectOnStart,
          captureSecs: null,
          out: null,
          label: null,
        };
      case "open_project":
        openProjectCalls.push(String(args?.path));
        return {
          schema_version: 7,
          project_id: "11111111-2222-3333-4444-555555555555",
          buses: [{ id: "b1", name: "B1" }],
          interface_bindings: [
            { kind: "remote", server: "127.0.0.1:9999", interface: "if0", bus_id: "b1" },
          ],
          dbcs: [],
          local_virtual_buses: [],
          elements: [],
          layout: null,
        };
      case "connect_remote_server":
        return {
          address: "127.0.0.1:9999",
          interfaces: [],
          subscriptions: [{ interface_id: "if0", channel: 0 }],
        };
      case "clear_dbcs":
        // Deliberately slow: models the real ~1 s DBC parse inside
        // `loadDbcSet`. Automation must not connect while the project
        // is still applying — a connect here flips views live and the
        // later `setRegistry(clearedTrace)` stomps them back to stopped.
        if (knobs.dbcDelayMs > 0)
          await new Promise((r) => setTimeout(r, knobs.dbcDelayMs));
        return null;
      case "restore_scratch_capture":
        return { count: 0, first_index: 0, first_index_ts_ns: null, session_start_seconds: 0 };
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

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  openProjectCalls.length = 0;
  invokeOrder.length = 0;
  knobs.connectOnStart = false;
  knobs.dbcDelayMs = 0;
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("boot project open", () => {
  it("opens the automation project exactly once under StrictMode", async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await waitFor(() => {
      expect(openProjectCalls.length).toBeGreaterThan(0);
    });
    // Let any second (buggy) boot pass land before counting.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(openProjectCalls).toEqual(["C:/fake/auto.cannet_prj"]);
    // The layout still mounts (the latched open applied the project).
    await waitFor(() => {
      if (!document.querySelector(".dv-tab")) throw new Error("no dockview tabs yet");
    });
  });

  it("automation connects only after the project has fully applied", async () => {
    // Views born before the capture-start event come up stopped — the
    // observed symptom when connect raced a still-applying project. The
    // last applyProject step (restore_scratch_capture) is made slow;
    // connect must still come after it.
    knobs.connectOnStart = true;
    knobs.dbcDelayMs = 600;
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await waitFor(
      () => {
        expect(invokeOrder).toContain("connect_remote_server");
      },
      { timeout: 5000 },
    );
    const restoreAt = invokeOrder.indexOf("restore_scratch_capture");
    const connectAt = invokeOrder.indexOf("connect_remote_server");
    expect(restoreAt).toBeGreaterThanOrEqual(0);
    expect(connectAt).toBeGreaterThan(restoreAt);
  });
});
