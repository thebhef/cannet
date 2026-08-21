// @vitest-environment jsdom
//
// A database reloaded in place can change or remove the definitions an
// RBS element is transmitting from, so the host turns the element's Run
// off (ADR 0053 §1's swap exception). Run is the *project's* flag
// mirrored onto the host, so the project has to follow — otherwise the
// panel's Run control reads on while nothing is being sent.
//
// Mounts the REAL App with the Tauri IPC mocked, adds an RBS panel
// through the real toolbar, arms it through its real Run control, and
// then delivers the host's `rbs-run-stopped`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
function emitHost(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h({ payload });
}

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

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

/// Every `rbs_set_run` the App's reconciler has pushed, in order.
function runPushes(): Array<{ elementId: string; run: boolean }> {
  return invokeCalls
    .filter((c) => c.cmd === "rbs_set_run")
    .map((c) => c.args as unknown as { elementId: string; run: boolean });
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

describe("rbs-run-stopped", () => {
  it("turns the project element's Run off when the host stops it", async () => {
    render(<App />);
    await waitFor(() => {
      if (!document.querySelector(".trace-panel .trace-status"))
        throw new Error("seeded layout not mounted yet");
    });
    await act(async () => {
      fireEvent.click(findButton("Add RBS panel"));
    });
    const toggle = (await screen.findByLabelText("run simulation")) as HTMLInputElement;

    // Arm it through the control the user uses, so what the host stops
    // is a real project Run flag and not a fixture.
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      if (!runPushes().some((p) => p.run)) throw new Error("Run was never pushed to the host");
    });
    expect(toggle.checked).toBe(true);
    const elementId = runPushes().find((p) => p.run)?.elementId;
    expect(elementId).toBeTruthy();

    // The host reloaded a database this element was transmitting from,
    // cleared its Run and said which elements it cleared.
    await act(async () => {
      emitHost("rbs-run-stopped", [elementId]);
    });

    await waitFor(() => {
      if (toggle.checked) throw new Error("the Run control still reads on");
    });
    const pushes = runPushes();
    expect(pushes[pushes.length - 1]).toEqual({ elementId, run: false });
  }, 30_000);

  it("leaves another element's Run alone", async () => {
    render(<App />);
    await waitFor(() => {
      if (!document.querySelector(".trace-panel .trace-status"))
        throw new Error("seeded layout not mounted yet");
    });
    await act(async () => {
      fireEvent.click(findButton("Add RBS panel"));
    });
    const toggle = (await screen.findByLabelText("run simulation")) as HTMLInputElement;
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      if (!runPushes().some((p) => p.run)) throw new Error("Run was never pushed to the host");
    });

    await act(async () => {
      emitHost("rbs-run-stopped", ["rbs-some-other-element"]);
    });

    expect(toggle.checked).toBe(true);
    const pushes = runPushes();
    expect(pushes[pushes.length - 1].run).toBe(true);
  }, 30_000);
});
