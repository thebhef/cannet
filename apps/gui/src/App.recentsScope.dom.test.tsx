// @vitest-environment jsdom
//
// "Recent captures" is project-scoped state (ADR 0042 §3: `recent_blfs`
// lives in the project's own `.cannet/state.json`), so one job's list
// must not bleed into the next. The bleed is upstream of storage: the
// list the app shows is a frontend MRU seeded from the host cache, and
// the host resolves the workspace scope from whichever project
// directory the session is rooted in — so both halves have to follow a
// project switch.
//
// The mock below is a stand-in for that routing: a per-workspace
// "disk", a current workspace the host commands move between, and reads
// and writes that go to whichever workspace is in force. The sequence
// the tests walk is the reported one — import into a project, New
// project, import again, reopen the first project.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

/// Workspace key → that project's `recent_blfs`, i.e. the contents of
/// each project directory's `.cannet/state.json`.
const disk = new Map<string, string[]>();
/// The project directory the host is rooted in right now.
let workspace = "project-a";
/// What the mocked file dialog hands back.
let dialogPath: string | null = null;

const PROJECT_A = "C:/jobs/a/a.cannet_prj";
/// The auto-located directory a session with no project file gets.
const UNSAVED = "unsaved";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_state":
        return {
          last_project: null,
          layout: null,
          recent_blfs: disk.get(workspace) ?? [],
          recent_commands: [],
          blf_channel_maps: {},
        };
      case "set_state":
        disk.set(workspace, [...((args?.state as { recent_blfs: string[] }).recent_blfs ?? [])]);
        return null;
      case "open_project":
        workspace = String(args?.path);
        return {
          schema_version: 7,
          buses: [],
          interface_bindings: [],
          dbcs: [],
          local_virtual_buses: [],
          elements: [],
          layout: null,
        };
      case "close_project":
        workspace = UNSAVED;
        return null;
      case "scan_blf_channels":
      case "scan_mdf_channels":
        return {
          channels: [0],
          frame_count: 1,
          first_timestamp_ns: 1_000_000_000,
          last_timestamp_ns: 1_000_000_000,
          start_unix_nanos: 1_700_000_000_000_000_000,
          markers: [],
          unfinalized: false,
          signal_group_count: 0,
          signal_count: 0,
          decoded_message_groups: [],
        };
      case "open_log":
        return { blf_path: String(args?.blfPath) };
      case "import_mdf":
        return { mdf_path: String(args?.mdfPath) };
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

/// The paths the Recent-captures menu is currently offering.
async function recentsShown(): Promise<string[]> {
  const summary = document.querySelector(".recent-captures > button");
  if (!summary) return [];
  await act(async () => {
    fireEvent.click(summary);
  });
  const shown = Array.from(
    document.querySelectorAll(".recent-captures-menu button"),
  ).map((b) => b.textContent ?? "");
  await act(async () => {
    fireEvent.click(summary);
  });
  return shown;
}

/// Import a capture through the toolbar's single entry point, all the
/// way through the channel-map dialog's Open, then the host's own
/// `log-finished` the pump emits once it's done — the launcher stays
/// busy (`state.kind === "loading"`) until that arrives (task 75 item
/// 2(a)), so a scope test that imports twice needs it fired to get back
/// to an idle "Import trace…" button between imports.
async function importCapture(path: string): Promise<void> {
  dialogPath = path;
  await act(async () => {
    fireEvent.click(findButton("Import trace…"));
  });
  await waitFor(() => findButton("Open"));
  await act(async () => {
    fireEvent.click(findButton("Open"));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  await act(async () => {
    for (const h of listeners.get("log-finished") ?? []) h({ payload: { status: "ok", total: 1 } });
  });
}

async function mountApp() {
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  disk.clear();
  dialogPath = null;
  workspace = PROJECT_A;
  disk.set(PROJECT_A, ["/jobs/a/first.blf"]);
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("recent captures are project-scoped", () => {
  it("does not carry one project's list into the next", async () => {
    await mountApp();
    expect(await recentsShown()).toEqual(["/jobs/a/first.blf"]);

    await importCapture("/jobs/a/second.blf");
    expect(disk.get(PROJECT_A)).toEqual(["/jobs/a/second.blf", "/jobs/a/first.blf"]);

    // New project: an unsaved project is a project of its own
    // (ADR 0042 §1/§7), so it starts with an empty list and writes to
    // its own directory.
    await act(async () => {
      fireEvent.click(findButton("New"));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(await recentsShown()).toEqual([]);

    await importCapture("/elsewhere/run.mf4");
    expect(disk.get(UNSAVED)).toEqual(["/elsewhere/run.mf4"]);
    expect(disk.get(PROJECT_A)).toEqual(["/jobs/a/second.blf", "/jobs/a/first.blf"]);

    // Back to the first project: its own two captures, and nothing the
    // unsaved project imported.
    dialogPath = PROJECT_A;
    await act(async () => {
      fireEvent.click(findButton("Open…"));
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(await recentsShown()).toEqual(["/jobs/a/second.blf", "/jobs/a/first.blf"]);

    await importCapture("/jobs/a/third.blf");
    expect(disk.get(PROJECT_A)).toEqual([
      "/jobs/a/third.blf",
      "/jobs/a/second.blf",
      "/jobs/a/first.blf",
    ]);
  }, 30_000);
});
