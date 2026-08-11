// @vitest-environment jsdom
//
// Closing the window with unsaved work prompts (Save & close / Discard &
// close / Cancel — ADR 0028 folds dirty `.cannet_rbs` files into the same
// prompt). A `settings.json` that still carries the removed
// `confirm_unsaved_on_exit` key does not resurrect a suppressed prompt —
// that opt-out is gone for good.
//
// `autosave_on_exit` is a narrower, later addition: enabled, it replaces
// the prompt with a silent save, but only when the session's active
// project directory is one the user pointed cannet at explicitly (not
// auto-located, and not a never-saved session) — checked host-side via
// `active_project_is_auto_located` at the moment of close, never guessed
// from `projectPath` in JS. Off (the default) or against an auto-located
// directory, the prompt behaves exactly as it always has.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

/// The `onCloseRequested` callback the app registers, captured so a test
/// can drive a close attempt without a real window.
let closeRequested: ((event: { preventDefault: () => void }) => unknown) | null = null;

const knobs = {
  staleOptOut: false,
  rbsDirty: true,
  // Autosave-on-exit knobs. `lastProject` set + `reopen` true reopens a
  // project at boot (giving `projectPath` a real value, the same way an
  // explicit-dir project always gets one — by being opened or Saved As);
  // `autoLocated` is what the host reports for the session's *active*
  // project directory, independent of whether a project file happens to
  // be open.
  autosaveOnExit: false,
  autoLocated: true,
  reopen: true,
  lastProject: null as string | null,
};

/// Commands the silent-save path drives, tracked so a test can tell a
/// save actually ran (as opposed to the prompt being skipped for no
/// reason).
const saveCalls: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "get_state":
        return {
          last_project: knobs.lastProject,
          layout: null,
          recent_blfs: [],
          recent_commands: [],
          blf_channel_maps: {},
        };
      case "get_settings":
        return {
          // A file left over from the build that had the opt-out. The
          // host ignores an unknown key; nothing may read it back.
          ...(knobs.staleOptOut ? { confirm_unsaved_on_exit: false } : {}),
          autosave_on_exit: knobs.autosaveOnExit,
          reopen_last_project: knobs.reopen,
        };
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
      case "active_project_is_auto_located":
        return knobs.autoLocated;
      case "save_project":
      case "save_project_as":
      case "rbs_save":
        saveCalls.push(cmd);
        return "project-id";
      // Unsaved work, without needing to drive the project dirty flag:
      // ADR 0028 puts a dirty RBS through the same prompt (and the same
      // silent-save path).
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

const windowDestroy = vi.fn(async () => {});
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
    destroy: windowDestroy,
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
    // 100ms, not 50: the autosave tests reopen a project at boot
    // (`open_project` + `applyProject` + `restore_scratch_capture`),
    // which needs more settle time than the plain-rbsDirty tests did.
    await new Promise((r) => setTimeout(r, 100));
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
  knobs.autosaveOnExit = false;
  knobs.autoLocated = true;
  knobs.reopen = true;
  knobs.lastProject = null;
  saveCalls.length = 0;
  windowDestroy.mockClear();
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

describe("autosave_on_exit", () => {
  it("saves silently and closes, no prompt, for a dirty explicit-dir project", async () => {
    knobs.lastProject = "C:/fake/project.cannet_prj"; // reopened at boot — projectPath is real
    knobs.autosaveOnExit = true;
    knobs.autoLocated = false; // the host says this directory is not auto-located
    await hydrateSettings();
    await hydrateState(); // re-read `last_project` — beforeEach cached it null
    await boot();

    const preventDefault = await requestClose();

    expect(preventDefault).toHaveBeenCalled(); // native close is still deferred to async work
    expect(screen.queryByText(/unsaved changes to the project/i)).not.toBeInTheDocument();
    expect(saveCalls.length).toBeGreaterThan(0); // the silent save actually ran
    expect(windowDestroy).toHaveBeenCalled(); // and the window closed on its own
  });

  // Auto-located covers both an auto-located project directory (a loose
  // project file) and a session with nothing ever opened — `resolve`
  // (`project_dir.rs`) hands back the same auto-located answer for
  // both, so one knob covers both cases.
  it("still prompts for an auto-located / never-saved session, even with autosave enabled", async () => {
    knobs.autosaveOnExit = true;
    knobs.autoLocated = true; // no project was opened; the host default
    await hydrateSettings();
    await boot();

    const preventDefault = await requestClose();

    expect(preventDefault).toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes to the project/i)).toBeInTheDocument();
    expect(saveCalls).toHaveLength(0);
    expect(windowDestroy).not.toHaveBeenCalled();
  });

  it("still prompts for a dirty explicit-dir project when autosave is disabled", async () => {
    knobs.lastProject = "C:/fake/project.cannet_prj";
    knobs.autosaveOnExit = false; // the default — off
    knobs.autoLocated = false;
    await hydrateSettings();
    await hydrateState();
    await boot();

    const preventDefault = await requestClose();

    expect(preventDefault).toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes to the project/i)).toBeInTheDocument();
    expect(saveCalls).toHaveLength(0);
    expect(windowDestroy).not.toHaveBeenCalled();
  });
});
