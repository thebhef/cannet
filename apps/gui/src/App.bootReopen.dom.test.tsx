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
//
// The same decision governs the *layout*: a launch that resumes a
// project restores a layout, a launch that opens nothing starts from the
// default seed and persists nothing (window geometry is a separate,
// plugin-owned track).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const openProjectCalls: string[] = [];
const stateWrites: unknown[] = [];
// Per-test knobs (the mock is hoisted, so config rides in mutable state).
const knobs = {
  reopen: true,
  lastProject: "C:/fake/last.cannet_prj" as string | null,
  /// What `get_state` reports as the persisted layout snapshot.
  savedLayout: null as unknown,
  /// What `open_project` reports as the project's own layout blob.
  projectLayout: null as unknown,
};

/// A minimal-but-real dockview layout holding a single shortcuts panel
/// under `title` — enough for `fromJSON` to mount it and for a test to
/// spot the title on the resulting tab. Shaped like what dockview itself
/// serializes under jsdom (a 100×100 container), since `fromJSON`
/// rejects a grid whose sizes don't add up. The panel is deliberately a
/// singleton rather than an element-backed one: element-backed tab
/// titles are re-synced from the model name (ADR 0019), so a marker
/// title would not survive on one.
function layoutWithTab(title: string, id = "p1"): unknown {
  return {
    grid: {
      root: {
        type: "branch",
        data: [{ type: "leaf", data: { views: [id], activeView: id, id: "1" }, size: 100 }],
        size: 100,
      },
      width: 100,
      height: 100,
      orientation: "HORIZONTAL",
    },
    panels: {
      [id]: {
        id,
        contentComponent: "shortcuts",
        tabComponent: "props.defaultTabComponent",
        title,
      },
    },
    activeGroup: "1",
  };
}

/// The titles dockview is currently showing on its tabs.
function tabTitles(): string[] {
  return Array.from(document.querySelectorAll(".dv-tab")).map((t) => t.textContent ?? "");
}

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
          layout: knobs.savedLayout,
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
          layout: knobs.projectLayout,
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

/// Click the toolbar's "Add trace" — a layout change after the boot has
/// settled, so what it does or doesn't write is the write gate's doing.
async function addTracePanel(): Promise<void> {
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Add trace",
  );
  if (!btn) throw new Error('no "Add trace" button');
  await act(async () => {
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 20));
  });
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  openProjectCalls.length = 0;
  stateWrites.length = 0;
  knobs.reopen = true;
  knobs.lastProject = "C:/fake/last.cannet_prj";
  knobs.savedLayout = null;
  knobs.projectLayout = null;
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

describe("boot layout restore", () => {

  it("does not restore a scratch session's layout", async () => {
    // Nothing to reopen: last session had no project open, so the view
    // state it happened to leave behind is not what this launch resumes
    // — it comes up on the default seed. (Window size/position do
    // resume; the window-state plugin owns that track.)
    knobs.lastProject = null;
    knobs.savedLayout = layoutWithTab("Scratch Layout");
    await hydrateState();
    await boot();
    expect(tabTitles()).not.toContain("Scratch Layout");
    expect(tabTitles()).toContain("Trace 1");
  });

  it("does not persist a scratch session's layout", async () => {
    // Nothing written means nothing to restore next launch — the write
    // gate is the other half of the seed above.
    knobs.lastProject = null;
    await hydrateState();
    await boot();
    stateWrites.length = 0;
    await addTracePanel();
    for (const written of stateWrites) {
      expect((written as { layout?: unknown }).layout ?? null).toBeNull();
    }
  });

  it("still restores a reopened project's layout", async () => {
    // The other direction: a project session's layout arrives with the
    // project and is applied over whatever the boot seeded.
    knobs.projectLayout = layoutWithTab("Project Layout");
    await boot();
    expect(openProjectCalls).toEqual(["C:/fake/last.cannet_prj"]);
    expect(tabTitles()).toContain("Project Layout");
  });

  it("heals a singleton's stale tab title on both restore paths", async () => {
    // A singleton panel's title is code-defined, not state — so a
    // workspace saved before the panel was renamed must come back
    // wearing the current name, not the one in the blob. The stand-in
    // here is the shortcuts panel (a singleton with an inert mount);
    // `dockLayout.dom.test.ts` covers the retitle itself, on the panel
    // that was actually renamed.
    knobs.savedLayout = layoutWithTab("Shortcut Keys", "shortcuts");
    knobs.projectLayout = null;
    await hydrateState();
    await boot();
    expect(tabTitles()).toEqual(["Keyboard shortcuts"]);

    cleanup();
    knobs.savedLayout = null;
    knobs.projectLayout = layoutWithTab("Shortcut Keys", "shortcuts");
    await hydrateState();
    await boot();
    expect(tabTitles()).toEqual(["Keyboard shortcuts"]);
  });

  it("persists the layout once a project is open", async () => {
    // A project session keeps its working-layout snapshot: the panel
    // arrangement it is left in is the one it resumes.
    knobs.projectLayout = layoutWithTab("Project Layout");
    await boot();
    stateWrites.length = 0;
    await addTracePanel();
    expect(stateWrites.some((w) => (w as { layout?: unknown }).layout != null)).toBe(true);
  });
});
