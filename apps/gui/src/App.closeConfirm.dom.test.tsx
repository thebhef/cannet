// @vitest-environment jsdom
//
// Closing the window with unsaved work prompts (Save & close / Discard &
// close / Cancel — ADR 0028 folds dirty `.cannet_rbs` files into the same
// prompt). `confirm_unsaved_on_exit` is the opt-out: off, the close is
// let through and the unsaved work goes with it.
//
// The prompt is the app's only confirmation dialog, so this one field is
// the whole of Stage 5's "confirmation-prompt suppression".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

/// The `onCloseRequested` callback the app registers, captured so a test
/// can drive a close attempt without a real window.
let closeRequested: ((event: { preventDefault: () => void }) => unknown) | null = null;

const knobs = { confirm: true, rbsDirty: true };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "get_settings":
        return { confirm_unsaved_on_exit: knobs.confirm };
      // Unsaved work, without needing to drive the project dirty flag:
      // ADR 0028 puts a dirty RBS through the same prompt.
      case "rbs_dirty":
        return knobs.rbsDirty ? [{ elementId: "e1", path: "C:/fake/a.cannet_rbs" }] : [];
      case "diag_autostart":
        return null;
      case "restore_scratch_capture":
        return { count: 0, first_index: 0, first_index_ts_ns: null, session_start_seconds: 0 };
      case "fetch_system_log":
      case "fetch_notes":
      case "fetch_trace_range":
      case "list_transmit_frames":
      case "list_signals":
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
    onCloseRequested: async (cb: (event: { preventDefault: () => void }) => unknown) => {
      closeRequested = cb;
      return () => {};
    },
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
import { hydrateSettings } from "./hostSettings";
import { hydrateState } from "./hostState";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function boot(): Promise<void> {
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/// Ask the window to close. Returns the `preventDefault` spy: called
/// means the app held the close open for its prompt.
async function requestClose(): Promise<ReturnType<typeof vi.fn>> {
  const preventDefault = vi.fn();
  await act(async () => {
    // Deliberately not awaited: when the app prompts, the handler stays
    // parked on the user's choice and never settles.
    void closeRequested?.({ preventDefault });
    await new Promise((r) => setTimeout(r, 50));
  });
  return preventDefault;
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  closeRequested = null;
  knobs.confirm = true;
  knobs.rbsDirty = true;
  await hydrateState();
  await hydrateSettings();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("unsaved-changes prompt on close", () => {
  it("prompts by default when there is unsaved work", async () => {
    await boot();
    const preventDefault = await requestClose();
    expect(preventDefault).toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes to the project/i)).toBeInTheDocument();
  });

  it("lets the close through when confirm_unsaved_on_exit is off", async () => {
    knobs.confirm = false;
    await hydrateSettings();
    await boot();
    const preventDefault = await requestClose();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByText(/unsaved changes to the project/i)).not.toBeInTheDocument();
  });

  it("reads the setting at the moment of the close, not at mount", async () => {
    // The close handler is registered once, with no dependencies. It
    // has to read the current value rather than the one captured when
    // it was installed, or turning the prompt off would need a
    // relaunch — which is the one thing the setting cannot ask for.
    await boot();
    knobs.confirm = false;
    await hydrateSettings();
    const preventDefault = await requestClose();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
