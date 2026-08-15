// @vitest-environment jsdom
//
// "Add cannet-server to PATH" (palette command). The command is a pure
// hand-off: the host does the platform work and reports both outcomes
// to the System Messages panel itself, so what the frontend owes is
// exactly one invocation and no view state. This drives the REAL App
// and reaches the command the way a user does — the palette chord, then
// the entry — so a spec/handler/registration mismatch fails here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

/// `refusal` is flipped by the second test. A flag rather than
/// `mockImplementationOnce`, which would intercept whichever host call
/// the app happens to make first during mount.
const { invokeMock, refusal } = vi.hoisted(() => {
  const refusal = { on: false };
  const invokeMock = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
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
      case "add_server_to_path":
        if (refusal.on) throw new Error("this build carries no bundled cannet-server.exe");
        return "added C:\\Program Files\\cannet to your user PATH";
      default:
        return null;
    }
  });
  return { invokeMock, refusal };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

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

/// Run the command the way a user reaches it: the palette chord, then
/// the entry, matched on the label the palette actually renders.
async function runAddToPathCommand(): Promise<void> {
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
  await act(async () => {
    fireEvent.keyDown(document.body, { key: "P", ctrlKey: true, shiftKey: true });
  });
  const item = await waitFor(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(".palette-item")).find(
      (li) => li.textContent?.startsWith("Add cannet-server to PATH"),
    );
    if (!el) throw new Error("the palette does not offer Add cannet-server to PATH");
    return el;
  });
  await act(async () => {
    fireEvent.click(item);
  });
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeMock.mockClear();
  refusal.on = false;
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("server.addToPath", () => {
  it("asks the host once, with no arguments of its own", async () => {
    await runAddToPathCommand();
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter((c) => c[0] === "add_server_to_path");
      if (calls.length === 0) throw new Error("the host was never asked");
      expect(calls).toHaveLength(1);
      // The host resolves the directory from its own bundle; there is
      // nothing for the view to pass, and nothing for it to remember.
      expect(calls[0][1]).toBeUndefined();
    });
  }, 30_000);

  it("swallows a host refusal — the failure is reported through the system log", async () => {
    refusal.on = true;
    await runAddToPathCommand();
    await waitFor(() => {
      if (!invokeMock.mock.calls.some((c) => c[0] === "add_server_to_path"))
        throw new Error("the host was never asked");
    });
    // An unhandled rejection would fail the run; reaching here is the
    // assertion.
    expect(document.querySelector(".palette-item")).toBeNull();
  }, 30_000);
});
