// @vitest-environment jsdom
//
// Recent projects, against the REAL App. Two properties decide whether
// the list is any use, and neither is visible from the pure MRU helpers:
//
// - **It is user-scope state** (ADR 0042 §3), the sibling of
//   `last_project` — so it must survive the very project switch that
//   resets the project-scoped Recent-captures list. A list scoped to a
//   project could never name the project you want to get back to.
// - **An entry leaves only when opening it fails.** Nothing stats the
//   filesystem to prune ahead of time.
//
// The mock below is the routing that makes the first testable: a user
// "disk" and a per-workspace one, with `get_state` / `set_state`
// splitting keys across them exactly as the host's scope table does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

/// `state.json` in the OS config dir — the keys that follow the person.
let userDisk: { last_project: string | null; recent_projects: string[] } = {
  last_project: null,
  recent_projects: [],
};
/// Workspace key → that project's `.cannet/state.json` recent BLFs.
const workspaceDisk = new Map<string, string[]>();
/// The project directory the host is rooted in right now.
let workspace = "unsaved";
/// What the mocked file dialog hands back.
let dialogPath: string | null = null;
/// Paths `open_project` refuses, as a project that has been moved away
/// would be.
const missing = new Set<string>();

const PROJECT_A = "C:/jobs/pack/pack.cannet_prj";
const PROJECT_B = "C:/jobs/rig/rig.cannet_prj";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_state":
        return {
          last_project: userDisk.last_project,
          recent_projects: [...userDisk.recent_projects],
          layout: null,
          recent_blfs: workspaceDisk.get(workspace) ?? [],
          recent_commands: [],
          blf_channel_maps: {},
        };
      case "set_state": {
        const state = args?.state as {
          last_project: string | null;
          recent_projects?: string[];
          recent_blfs?: string[];
        };
        userDisk = {
          last_project: state.last_project,
          recent_projects: [...(state.recent_projects ?? [])],
        };
        workspaceDisk.set(workspace, [...(state.recent_blfs ?? [])]);
        return null;
      }
      case "open_project": {
        const path = String(args?.path);
        if (missing.has(path)) throw new Error(`no such project: ${path}`);
        workspace = path;
        return {
          schema_version: 7,
          buses: [],
          interface_bindings: [],
          dbcs: [],
          local_virtual_buses: [],
          elements: [],
          layout: null,
        };
      }
      case "close_project":
        workspace = "unsaved";
        return null;
      case "restore_scratch_capture":
        return { count: 0, first_index: 0, first_index_ts_ns: null, session_start_seconds: 0 };
      case "fetch_system_log":
      case "fetch_notes":
      case "fetch_trace_range":
      case "list_transmit_frames":
      case "list_signals":
      case "rbs_dirty":
      case "get_interfaces":
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
  open: vi.fn(async () => dialogPath),
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
import { toolbarChip } from "./toolbarTestKit";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function mountApp() {
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
}

/// Open the project at `path` through the toolbar's Open chip.
async function openProject(path: string): Promise<void> {
  dialogPath = path;
  await act(async () => {
    fireEvent.click(toolbarChip("Open"));
    await new Promise((r) => setTimeout(r, 50));
  });
}

/// The paths the Recent-projects menu is currently offering.
async function projectsShown(): Promise<string[]> {
  const chip = document.querySelector(".recent-projects > button");
  if (!chip) return [];
  await act(async () => {
    fireEvent.click(chip);
  });
  const shown = Array.from(document.querySelectorAll(".recent-projects-menu button")).map(
    (b) => b.textContent ?? "",
  );
  await act(async () => {
    fireEvent.click(chip);
  });
  return shown;
}

/// The command palette's labels, filtered by `query`.
async function paletteMatches(query: string): Promise<string[]> {
  await act(async () => {
    fireEvent.keyDown(document.body, { key: "P", ctrlKey: true, shiftKey: true });
  });
  const input = document.querySelector<HTMLInputElement>(".palette input.palette-input");
  if (!input) throw new Error("command palette did not open");
  await act(async () => {
    fireEvent.change(input, { target: { value: query } });
  });
  const labels = Array.from(document.querySelectorAll(".palette-item-label")).map(
    (e) => e.textContent ?? "",
  );
  await act(async () => {
    fireEvent.keyDown(input, { key: "Escape" });
  });
  return labels;
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  workspaceDisk.clear();
  missing.clear();
  dialogPath = null;
  workspace = "unsaved";
  userDisk = { last_project: null, recent_projects: [] };
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("recent projects", () => {
  it("records each project opened, most recent first, and keeps it across a switch", async () => {
    await mountApp();
    // Nothing opened yet: no menu at all rather than an empty one.
    expect(document.querySelector(".recent-projects")).toBeNull();

    await openProject(PROJECT_A);
    expect(userDisk.recent_projects).toEqual([PROJECT_A]);

    await openProject(PROJECT_B);
    expect(userDisk.recent_projects).toEqual([PROJECT_B, PROJECT_A]);
    // Still offering the project we are *not* in — the whole point of
    // the list being user-scope rather than workspace-scope.
    expect(await projectsShown()).toEqual([PROJECT_B, PROJECT_A]);

    // Re-opening the older one lifts it back to the front.
    await openProject(PROJECT_A);
    expect(userDisk.recent_projects).toEqual([PROJECT_A, PROJECT_B]);
  }, 30_000);

  it("forgets an entry only when opening it actually fails", async () => {
    userDisk = { last_project: null, recent_projects: [PROJECT_A, PROJECT_B] };
    await hydrateState();
    await mountApp();
    expect(await projectsShown()).toEqual([PROJECT_A, PROJECT_B]);

    // A path that is simply gone stays on the list until something
    // tries it: nothing probes the filesystem to draw the menu.
    missing.add(PROJECT_A);
    expect(await projectsShown()).toEqual([PROJECT_A, PROJECT_B]);

    await openProject(PROJECT_A);
    expect(userDisk.recent_projects).toEqual([PROJECT_B]);
    expect(await projectsShown()).toEqual([PROJECT_B]);
  }, 30_000);

  it("offers the same list in the palette, one entry per project", async () => {
    userDisk = { last_project: null, recent_projects: [PROJECT_A] };
    await hydrateState();
    await mountApp();
    expect(await paletteMatches("recent project")).toContain(
      "Open recent project: pack.cannet_prj",
    );
  }, 30_000);

  it("renames the fresh-project command honestly, and keeps the old name findable", async () => {
    await mountApp();
    // The action has always started a new project; the palette used to
    // spell it "Close project".
    expect(await paletteMatches("New project")).toContain("New project");
    expect(await paletteMatches("Close project")).toContain("New project");
  }, 30_000);
});
