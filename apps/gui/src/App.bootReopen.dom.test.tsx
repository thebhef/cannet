// @vitest-environment jsdom
//
// Startup behaviour: `reopen_last_project` decides whether the boot path
// resumes the project the app was last working in. On (the default) is
// what launching has always done; off launches with nothing open, with
// the `last_project` pointer left exactly as it was so turning the
// setting back on resumes it.
//
// The host makes the matching decision for the *project directory*
// (`settings::project_to_reopen`, covered in `settings.rs`); this is the
// frontend half — whether the boot path calls `open_project` at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const openProjectCalls: string[] = [];
const stateWrites: unknown[] = [];
// Per-test knobs (the mock is hoisted, so config rides in mutable state).
const knobs = { reopen: true, lastProject: "C:/fake/last.cannet_prj" as string | null };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      // Not armed: the boot path falls through to the last-opened
      // pointer, which is what this file is about.
      case "diag_autostart":
        return null;
      case "get_state":
        return {
          last_project: knobs.lastProject,
          layout: null,
          recent_blfs: [],
          recent_commands: [],
          blf_channel_maps: {},
        };
      case "set_state":
        stateWrites.push(args?.state);
        return null;
      case "get_settings":
        return { reopen_last_project: knobs.reopen };
      case "open_project":
        openProjectCalls.push(String(args?.path));
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
import { hostState, hydrateState } from "./hostState";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/// Render the app and let the boot open (an async IIFE behind
/// dockview's `onReady`) settle.
async function boot(): Promise<void> {
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  openProjectCalls.length = 0;
  stateWrites.length = 0;
  knobs.reopen = true;
  knobs.lastProject = "C:/fake/last.cannet_prj";
  await hydrateState();
  await hydrateSettings();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("boot reopen", () => {
  it("resumes the last project by default", async () => {
    await boot();
    expect(openProjectCalls).toEqual(["C:/fake/last.cannet_prj"]);
  });

  it("opens nothing when reopen_last_project is off", async () => {
    knobs.reopen = false;
    await hydrateSettings();
    await boot();
    expect(openProjectCalls).toEqual([]);
  });

  it("keeps the last-project pointer when it is not resuming it", async () => {
    // Turning the setting back on has to resume where the pointer still
    // says, so a launch that skipped the reopen must not clear it — and
    // must not report an empty project as "the one you last opened"
    // either.
    knobs.reopen = false;
    await hydrateSettings();
    await boot();
    expect(hostState().last_project).toBe("C:/fake/last.cannet_prj");
    for (const written of stateWrites) {
      expect((written as { last_project: string | null }).last_project).toBe(
        "C:/fake/last.cannet_prj",
      );
    }
  });
});
