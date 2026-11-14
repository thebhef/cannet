// @vitest-environment jsdom
//
// A reloaded frontend rejoins the session the host holds (ADR 0063): the
// boot asks `session_status` first, and when the host already holds a
// project it opens nothing and pushes nothing — it applies the working
// document, mirrors the trace windows, and reads the session's other
// facts back. These pin that against the real App:
//
// - a held project: none of the open path's host calls, none of the
//   mount-time pushes that would stop loggers or re-resolve RBS, no id
//   set that drops a held window; the working document's elements,
//   layout and buses applied; dirty as the host says; the connection,
//   the buffer's count and every window (running, paused, stopped) as
//   the host holds them;
// - nothing held: the fresh path, unchanged;
// - an unsaved project with no document yet: the New seed, no crash;
// - a rejoin while disconnected keeps the capture and the windows, and
//   an import in flight still reads as loading.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

/// Every host call the App made, in order.
const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
/// Every title the App set on the native window.
const titles: string[] = [];
/// What `session_status` answers this test (`null`: no host answer).
let status: unknown = null;

const RUNNING = "e-running";
const PAUSED = "e-paused";
const STOPPED = "e-stopped";
const WINDOWS = {
  [RUNNING]: { start: 0, end: null, isPaused: false },
  [PAUSED]: { start: 0, end: 4000, isPaused: true },
  [STOPPED]: { start: 1000, end: 3000, isPaused: false },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "session_status":
        return status;
      case "get_trace_windows":
        return WINDOWS;
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
          buses: [{ id: "b1", name: "Opened Bus" }],
          interface_bindings: [],
          dbcs: [],
          local_virtual_buses: [],
          elements: [],
          layout: null,
        };
      case "restore_scratch_capture":
        return {
          count: 0,
          first_index: 0,
          first_index_ts_ns: null,
          session_start_seconds: 0,
        };
      case "fetch_system_log":
      case "fetch_notes":
      case "fetch_trace_range":
      case "list_transmit_frames":
      case "list_signals":
      case "rbs_dirty":
      case "get_interfaces":
      case "get_logger_statuses":
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
    setTitle: async (t: string) => {
      titles.push(t);
    },
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
import type { TraceGrew } from "./types";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/// Host calls a rejoin must never make: the open path's, the session's,
/// and the mount-time pushes that would stop a logger, re-resolve a
/// running RBS element or re-read its file.
const FORBIDDEN_ON_REJOIN = [
  "open_project",
  "close_project",
  "clear_dbcs",
  "add_dbc",
  "set_dbc_buses",
  "replay_local_virtual_buses",
  "restore_scratch_capture",
  "set_loggers",
  "clear_trace_store",
  "rbs_load",
  "rbs_init",
  "rbs_unload",
  "rbs_sync_project_buses",
  "clear_transmit_frames",
  "connect_remote_server",
  "disconnect_remote_server",
  "trace_window_control",
  "diag_autostart",
];

/// Three trace panels, one per group, so each one's run controls render.
function threeTraceLayout(): unknown {
  const ids = [RUNNING, PAUSED, STOPPED];
  return {
    grid: {
      root: {
        type: "branch",
        data: ids.map((id, i) => ({
          type: "leaf",
          data: {
            views: [`trace-${id}`],
            activeView: `trace-${id}`,
            id: String(i + 1),
          },
          size: i === 2 ? 34 : 33,
        })),
        size: 100,
      },
      width: 100,
      height: 100,
      orientation: "HORIZONTAL",
    },
    panels: Object.fromEntries(
      ids.map((id) => [
        `trace-${id}`,
        {
          id: `trace-${id}`,
          contentComponent: "trace",
          tabComponent: "props.defaultTabComponent",
          title: id,
          params: { elementId: id, mode: "by-id" },
        },
      ]),
    ),
    activeGroup: "1",
  };
}

function grew(count: number, fps: number): TraceGrew {
  return {
    count,
    first_index: 0,
    first_index_ts_ns: null,
    frames_per_second: fps,
    frames_per_second_rx: fps,
    frames_per_second_tx: 0,
    frames_per_second_by_bus: [],
    bus_load_percent: null,
    frames_dropped_before_session: 0,
    session_start_seconds: 1000,
    buffer_seconds: 5,
    scratch_bytes: null,
    mem_bytes: null,
    tail: [],
  };
}

/// A trace view's config as its panel seeds it, so mounting the panel
/// writes nothing back (a config-less element is seeded on mount, which
/// is an edit and would mark the project dirty whenever it lands).
const TRACE_CONFIG = {
  mode: "by-id",
  autoScroll: true,
  columns: [
    { key: "idx", width: 64, visible: true },
    { key: "time", width: 110, visible: true },
    { key: "rate", width: 64, visible: true },
    { key: "bus", width: 100, visible: true },
    { key: "ecu", width: 110, visible: true },
    { key: "id", width: 96, visible: true },
    { key: "msg", width: 220, visible: true },
    { key: "len", width: 44, visible: true },
    { key: "data", width: 360, visible: true },
    { key: "dir", width: 40, visible: true },
    { key: "kind", width: 110, visible: false },
  ],
  collapseErrorFrames: true,
  expanded: [],
};

/// What a host holding a project and a connected session answers.
function heldStatus(over: Record<string, unknown> = {}): unknown {
  return {
    held: true,
    path: "C:/fake/rejoined.cannet_prj",
    document: {
      schema_version: 7,
      layout: threeTraceLayout(),
      elements: [
        {
          kind: "trace",
          id: RUNNING,
          name: "Running view",
          sources: ["*"],
          config: TRACE_CONFIG,
        },
        {
          kind: "trace",
          id: PAUSED,
          name: "Paused view",
          sources: ["*"],
          config: TRACE_CONFIG,
        },
        {
          kind: "trace",
          id: STOPPED,
          name: "Stopped view",
          sources: ["*"],
          config: TRACE_CONFIG,
        },
        { kind: "rbs", id: "e-rbs", name: "Sim", path: "sim.cannet_rbs" },
        {
          kind: "logger",
          id: "e-log",
          name: "Log",
          enabled: true,
          folder: "logs",
          file: "run.blf",
          format: "blf",
          maxFileSizeMb: 100,
        },
      ],
      buses: [{ id: "b1", name: "Edited Bus" }],
      interface_bindings: [
        { bus_id: "b1", server: "local", interface: "pcan:1" },
      ],
      dbcs: [{ path: "a.dbc", buses: ["b1"] }],
      local_virtual_buses: [],
      signal_colors: {},
    },
    dirty: true,
    trace: grew(5000, 1000),
    sessions: [
      {
        result: {
          address: "127.0.0.1:50051",
          interfaces: [{ id: "pcan:1", display_name: "PCAN Rejoined" }],
          subscriptions: [{ interface_id: "pcan:1", channel: 0 }],
        },
        bindings: [
          {
            interface: "pcan:1",
            busId: "b1",
            speedBps: 500000,
            fd: null,
            fdDataSpeedBps: null,
          },
        ],
      },
    ],
    dbcs: [{ dbc_path: "C:/fake/a.dbc", message_count: 3, buses: ["b1"] }],
    pyramids_rebuilding: false,
    importing: null,
    ...over,
  };
}

function called(cmd: string): Array<Record<string, unknown> | undefined> {
  return calls.filter((c) => c.cmd === cmd).map((c) => c.args);
}

/// The boot has finished: it says so on the system log.
async function bootSettled(): Promise<void> {
  render(<App />);
  await waitFor(
    () =>
      expect(
        called("gui_emit_system_log").some((a) =>
          String(a?.message).startsWith("startup:"),
        ),
      ).toBe(true),
    { timeout: 3000 },
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
}

function statuses(): string[] {
  return Array.from(document.querySelectorAll(".trace-status")).map(
    (e) => e.textContent ?? "",
  );
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  calls.length = 0;
  titles.length = 0;
  status = null;
  await hydrateState();
  await hydrateSettings();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a boot when the host already holds a project", () => {
  it("rejoins: opens nothing, pushes nothing, and keeps every window", async () => {
    status = heldStatus();
    await bootSettled();

    for (const cmd of FORBIDDEN_ON_REJOIN)
      expect([cmd, called(cmd).length]).toEqual([cmd, 0]);
    // No id set that would drop a window the host holds.
    for (const args of called("sync_trace_windows")) {
      expect(args?.elementIds).toEqual(
        expect.arrayContaining([RUNNING, PAUSED, STOPPED]),
      );
    }
    // The working document's views, each with the host's window.
    await waitFor(() =>
      expect(statuses().sort()).toEqual(["paused", "running", "stopped"]),
    );
    expect(document.body.textContent).toContain("Running view");
    expect(document.body.textContent).toContain("Stopped view");
    // Dirty as the host says; the connected interface and the project
    // name as the session has them.
    const title = titles[titles.length - 1];
    expect(title.startsWith("• ")).toBe(true);
    expect(title).toContain("rejoined");
    expect(title).toContain("PCAN Rejoined");
    // What the App now holds of the project — read back through the
    // working-project push its layout echo schedules — is the host's:
    // the document's buses and bindings, the host's loaded DBC set.
    await waitFor(() =>
      expect(called("set_working_project").length).toBeGreaterThan(0),
    );
    const pushed = called("set_working_project").slice(-1)[0];
    const doc = pushed?.document as Record<string, unknown>;
    expect(doc.buses).toEqual([{ id: "b1", name: "Edited Bus" }]);
    expect(doc.dbcs).toEqual([{ path: "a.dbc", buses: ["b1"] }]);
    expect(doc.interface_bindings).toEqual([
      { bus_id: "b1", server: "local", interface: "pcan:1" },
    ]);
    expect(pushed?.dirty).toBe(true);
    // The buffer's count, from the host's picture rather than a tick.
    expect(document.body.textContent).toMatch(/5[,.\u202f\u00a0]?000/);
  });

  it("shows a pyramid rebuild the host still owes", async () => {
    status = heldStatus({ pyramids_rebuilding: true });
    await bootSettled();
    expect(document.body.textContent).toContain("Rebuilding signal caches");
  });

  it("keeps the capture and the windows while disconnected, and is clean when the host is", async () => {
    status = heldStatus({ dirty: false, sessions: [], trace: grew(7300, 0) });
    await bootSettled();

    for (const cmd of FORBIDDEN_ON_REJOIN)
      expect([cmd, called(cmd).length]).toEqual([cmd, 0]);
    await waitFor(() =>
      expect(statuses().sort()).toEqual(["paused", "running", "stopped"]),
    );
    expect(document.body.textContent).toMatch(/7[,.\u202f\u00a0]?300/);
    const title = titles[titles.length - 1];
    expect(title.startsWith("• ")).toBe(false);
    expect(title).not.toContain("PCAN");
  });

  it("an import in flight still reads as loading", async () => {
    status = heldStatus({
      sessions: [],
      importing: { blf_path: "C:/caps/drive.blf" },
    });
    await bootSettled();
    expect(titles[titles.length - 1]).toContain("drive.blf");
  });

  it("an unsaved project the host holds with no document yet comes back as New seeds it", async () => {
    status = heldStatus({
      path: null,
      document: null,
      dirty: false,
      sessions: [],
      dbcs: [],
      trace: grew(0, 0),
    });
    await bootSettled();
    for (const cmd of FORBIDDEN_ON_REJOIN)
      expect([cmd, called(cmd).length]).toEqual([cmd, 0]);
    expect(document.querySelectorAll(".trace-status").length).toBe(1);
    expect(titles[titles.length - 1].startsWith("• ")).toBe(false);
  });
});

describe("a boot when the host holds nothing", () => {
  it("takes the fresh path, unchanged", async () => {
    status = heldStatus({
      held: false,
      document: null,
      path: null,
      sessions: [],
      dbcs: [],
    });
    await bootSettled();
    expect(called("open_project")).toEqual([
      { path: "C:/fake/last.cannet_prj" },
    ]);
    expect(called("diag_autostart").length).toBe(1);
    await waitFor(() =>
      expect(called("restore_scratch_capture").length).toBe(1),
    );
    expect(called("set_loggers").length).toBeGreaterThan(0);
    expect(called("rbs_sync_project_buses").length).toBeGreaterThan(0);
  });
});
