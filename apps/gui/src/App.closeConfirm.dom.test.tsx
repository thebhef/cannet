// @vitest-environment jsdom
//
// Closing the window with unsaved work prompts (Save & close / Discard &
// close / Cancel — ADR 0028 folds dirty `.cannet_rbs` files into the same
// prompt). The prompt is unconditional: there is no setting that
// suppresses it, and a `settings.json` that still carries the removed
// `confirm_unsaved_on_exit` key does not resurrect one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

/// The `onCloseRequested` callback the app registers, captured so a test
/// can drive a close attempt without a real window.
let closeRequested: ((event: { preventDefault: () => void }) => unknown) | null = null;

const knobs = { staleOptOut: false, rbsDirty: true };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "get_settings":
        // A file left over from the build that had the opt-out. The
        // host ignores an unknown key; nothing may read it back.
        return knobs.staleOptOut ? { confirm_unsaved_on_exit: false } : {};
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
  knobs.staleOptOut = false;
  knobs.rbsDirty = true;
  await hydrateState();
  await hydrateSettings();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("unsaved-changes prompt on close", () => {
  it("prompts when there is unsaved work", async () => {
    await boot();
    const preventDefault = await requestClose();
    expect(preventDefault).toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes to the project/i)).toBeInTheDocument();
  });

  // The suppression knob was removed at the user's direction, and
  // removed means removed: a stale key in a file written by an older
  // build is an unknown field, not a way back to a silent close.
  it("prompts even when the file still carries the removed opt-out", async () => {
    knobs.staleOptOut = true;
    await hydrateSettings();
    await boot();
    const preventDefault = await requestClose();
    expect(preventDefault).toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes to the project/i)).toBeInTheDocument();
  });
});
