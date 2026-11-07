// @vitest-environment jsdom
//
// A relaunch over a prior capture says it is restoring it.
//
// The reload behind `restore_scratch_capture` maps every segment file of
// the prior capture and its signal caches before it returns — seconds
// on a large capture, with empty views and nothing else on screen. The
// host reports each phase's file count as `restore-progress` (ADR 0002
// DS-7); the chip exists from the first report to the command's return,
// so an open with nothing to restore — no report at all — shows nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

/// `restore_scratch_capture` stays pending until the test settles it,
/// the way a reload over thousands of segment files does.
let settleRestore: ((value: unknown) => void) | null = null;
let failRestore: ((err: unknown) => void) | null = null;

const RESTORED = {
  count: 5000,
  first_index: 0,
  first_index_ts_ns: 9_000,
  session_start_seconds: 1000,
  pyramids_rebuilding: false,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "diag_autostart":
        return null;
      case "get_state":
        return {
          last_project: "C:/fake/last.cannet_prj",
          layout: null,
          recent_blfs: [],
          recent_commands: [],
          blf_channel_maps: {},
        };
      case "get_settings":
        return { reopen_last_project: true };
      case "open_project":
        return {
          schema_version: 7,
          buses: [],
          interface_bindings: [],
          dbcs: [],
          local_virtual_buses: [],
          elements: [],
          layout: null,
        };
      case "restore_scratch_capture":
        return new Promise((resolve, reject) => {
          settleRestore = resolve;
          failRestore = reject;
        });
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
import { hydrateSettings } from "./hostSettings";
import { hydrateState } from "./hostState";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/// Render the app and let the boot open run up to the pending restore.
async function boot(): Promise<void> {
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  expect(settleRestore).not.toBeNull();
}

function fireRestoreProgress(payload: unknown) {
  return act(async () => {
    for (const h of listeners.get("restore-progress") ?? []) h({ payload });
  });
}

async function finishRestore(value: unknown = RESTORED) {
  await act(async () => {
    settleRestore?.(value);
    await new Promise((r) => setTimeout(r, 0));
  });
}

/// The restore chip, or `null` when nothing is being announced.
function chip(): HTMLElement | null {
  return document.querySelector(".restore-progress");
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  settleRestore = null;
  failRestore = null;
  await hydrateState();
  await hydrateSettings();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Restoring a prior capture — feedback", () => {
  it("shows the chip from the first report until the restore returns", async () => {
    await boot();
    // Nothing reported yet: nothing is known to be restoring.
    expect(chip()).toBeNull();

    // The host's first report of a phase is 0 of N: the chip appears,
    // determinate from the start.
    await fireRestoreProgress({ phase: "capture_index", files_opened: 0, total_files: 2_452 });
    expect(chip()?.textContent).toContain("Restoring prior capture…");
    expect(chip()?.querySelector(".trace-progress-bar")).toHaveAttribute("aria-valuenow", "0");

    await fireRestoreProgress({
      phase: "capture_index",
      files_opened: 1_226,
      total_files: 2_452,
    });
    expect(chip()?.querySelector(".trace-progress-bar")).toHaveAttribute("aria-valuenow", "50");
    expect(chip()?.querySelector(".trace-progress-readout")?.textContent).toBe(
      `capture index ${(1_226).toLocaleString()} / ${(2_452).toLocaleString()} files`,
    );

    await fireRestoreProgress({ phase: "signal_caches", files_opened: 129, total_files: 129 });
    expect(chip()?.querySelector(".trace-progress-readout")?.textContent).toBe(
      "signal caches 129 / 129 files",
    );
    // Nothing to offer beside it: the restore is not cancellable.
    expect(chip()?.querySelector("button")).toBeNull();

    await finishRestore();
    expect(chip()).toBeNull();
  });

  it("takes the chip down when the restore fails", async () => {
    await boot();
    await fireRestoreProgress({ phase: "capture_frames", files_opened: 3, total_files: 10 });
    expect(chip()).not.toBeNull();
    await act(async () => {
      failRestore?.(new Error("scratch unreadable"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(chip()).toBeNull();
  });

  it("ignores a report that arrives after the restore returned", async () => {
    // The last paced report can race the command's return; the return
    // wins, or the chip would stand forever over a finished restore.
    await boot();
    await fireRestoreProgress({ phase: "signal_caches", files_opened: 64, total_files: 129 });
    await finishRestore();
    await fireRestoreProgress({ phase: "signal_caches", files_opened: 129, total_files: 129 });
    expect(chip()).toBeNull();
  });

  it("shows nothing when there is nothing to restore", async () => {
    // The host reports nothing for an empty restore, and the command
    // returns a zero count: no chip at any point.
    await boot();
    expect(chip()).toBeNull();
    await finishRestore({ ...RESTORED, count: 0 });
    expect(chip()).toBeNull();
  });
});
