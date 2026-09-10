// @vitest-environment jsdom
//
// The export gesture end to end, through the REAL App: the toolbar chip
// opens the export dialog, the dialog's Export... opens the OS picker
// seeded from the sticky state, and whichever filter stamped the
// returned path reaches the host as an explicit `format` - never as
// something the host infers from the path.
//
// Drives a session with a synthetic `trace-grew` so there is something
// to export, and pins the arguments `save_capture` goes out with,
// including the range (absent when neither bound was touched) and the
// status-bar chip the write reports through.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
function emitTauri(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h({ payload });
}

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args: args ?? {} });
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
      case "get_export_state":
        return exportState;
      case "capture_extent":
        return {
          firstNs: 1_000 * 1e9,
          liveEdgeNs: 1_060 * 1e9,
          sessionStartNs: 1_000 * 1e9,
          frameCount: 1234,
        };
      case "preview_export_template":
        return {
          resolved: "demo-20260905T091502-0600",
          error: null,
          startResolvedAsNow: false,
        };
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
    setTitle: async () => {},
    isMaximized: async () => false,
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    destroy: async () => {},
  }),
}));

/// The sticky state the host reports. A case overrides it to pin how the
/// remembered folder and format seed the picker.
let exportState = {
  folder: null as string | null,
  format: "blf" as "blf" | "mdf",
  nameTemplate: "{project}-{start}",
};

// What the dialog hands back — the test sets it per case, because the
// stamped extension is the only way an OS save dialog reports the filter
// the user chose.
let savedPath: string | null = null;
const saveOptions: Array<Record<string, unknown>> = [];

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async (opts?: Record<string, unknown>) => {
    saveOptions.push(opts ?? {});
    return savedPath;
  }),
}));

vi.mock("uplot", () => {
  class FakeUPlot {
    over = document.createElement("div");
    scales = { x: {}, y: {} };
    data: unknown = [[]];
    width = 600;
    constructor(_opts: unknown, data: unknown, el: HTMLElement) {
      this.data = data;
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

import type { TraceGrew } from "./types";
import { App } from "./App";
import { toolbarChip } from "./toolbarTestKit";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function grew(count: number): TraceGrew {
  return {
    count,
    first_index: 0,
    first_index_ts_ns: null,
    frames_per_second: 0,
    frames_per_second_rx: 0,
    frames_per_second_tx: 0,
    frames_per_second_by_bus: [],
    bus_load_percent: null,
    frames_dropped_before_session: 0,
    session_start_seconds: 1000,
    buffer_seconds: 1,
    scratch_bytes: null,
    mem_bytes: null,
    tail: [],
  };
}

/// Mount the app, get a non-empty capture into it, run Export through
/// the real toolbar chip, and accept the dialog's defaults.
async function saveThrough(path: string | null) {
  savedPath = path;
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
  await act(async () => {
    emitTauri("trace-grew", grew(1234));
  });
  await act(async () => {
    fireEvent.click(toolbarChip("Export"));
  });
  // The export dialog now stands between the gesture and the picker.
  const confirm = await screen.findByRole("button", { name: EXPORT_BUTTON });
  await waitFor(() => {
    if (confirm.hasAttribute("disabled")) throw new Error("preview not resolved yet");
  });
  await act(async () => {
    fireEvent.click(confirm);
  });
  await waitFor(() => {
    if (saveOptions.length === 0) throw new Error("save dialog not opened yet");
  });
}

/// The dialog's confirm button, spelled with the ellipsis it carries.
const EXPORT_BUTTON = "Export" + String.fromCharCode(0x2026);

/// Wait for the export command to have gone out.
async function waitForSave() {
  await waitFor(() => {
    if (!lastSaveCall()) throw new Error("save_capture not invoked yet");
  });
}

function lastSaveCall() {
  const calls = invokeCalls.filter((c) => c.cmd === "save_capture");
  return calls[calls.length - 1];
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeCalls.length = 0;
  saveOptions.length = 0;
  savedPath = null;
  exportState = { folder: null, format: "blf", nameTemplate: "{project}-{start}" };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Export capture", () => {
  it("offers both capture formats in the picker", async () => {
    await saveThrough(null);
    const filters = saveOptions[0].filters as Array<{ extensions: string[] }>;
    expect(filters.map((f) => f.extensions[0])).toEqual(["blf", "mf4"]);
  });

  it("seeds the picker with the resolved name, the sticky folder and format", async () => {
    exportState = {
      folder: "C:\\logs",
      format: "mdf",
      nameTemplate: "{project}-{start}",
    };
    await saveThrough(null);
    const filters = saveOptions[0].filters as Array<{ extensions: string[] }>;
    // The remembered format leads: an OS picker pre-selects whichever
    // filter it is handed first, and that is the only handle on it.
    expect(filters.map((f) => f.extensions[0])).toEqual(["mf4", "blf"]);
    expect(saveOptions[0].defaultPath).toBe("C:\\logs\\demo-20260905T091502-0600.mf4");
  });

  it("remembers the folder, format and template the export used", async () => {
    await saveThrough("/logs/run.mf4");
    await waitFor(() => {
      if (!invokeCalls.some((c) => c.cmd === "set_export_state"))
        throw new Error("sticky state not written yet");
    });
    expect(invokeCalls.find((c) => c.cmd === "set_export_state")?.args).toMatchObject({
      folder: "/logs",
      format: "mdf",
      nameTemplate: "{project}-{start}",
    });
  });

  it("sends no range when neither bound was touched", async () => {
    // An untouched range is "the whole capture", which the host spells
    // as no filter at all rather than as the full span.
    await saveThrough("/logs/run.blf");
    await waitForSave();
    expect(lastSaveCall()?.args.range).toBeNull();
  });

  it("reports the export in the status bar, and cancels it from there", async () => {
    await saveThrough("/logs/run.blf");
    await waitForSave();
    await act(async () => {
      emitTauri("export-progress", { written: 500, total: 1000 });
    });
    expect(await screen.findByTestId("export-chip")).toHaveTextContent("50%");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Cancel exporting/ }));
    });
    expect(invokeCalls.some((c) => c.cmd === "cancel_export")).toBe(true);
    // The host answers a cancel with its own terminal event; only then
    // does the chip go, because only then is the partial file gone.
    await act(async () => {
      emitTauri("export-finished", { status: "cancelled" });
    });
    expect(screen.queryByTestId("export-chip")).toBeNull();
  });

  it("settles into a done state when the export finishes", async () => {
    await saveThrough("/logs/run.blf");
    await waitForSave();
    await act(async () => {
      emitTauri("export-finished", {
        status: "ok",
        path: "/logs/run.blf",
        frameCount: 1234,
        byteSize: 4096,
      });
    });
    expect(await screen.findByTestId("export-chip")).toHaveTextContent("Exported run.blf");
  });

  it("sends the format the chosen filter implies, not the path", async () => {
    await saveThrough("/logs/run.mf4");
    await waitFor(() => {
      if (!lastSaveCall()) throw new Error("save_capture not invoked yet");
    });
    expect(lastSaveCall()?.args).toMatchObject({
      path: "/logs/run.mf4",
      format: "mdf",
    });
  });

  it("still saves BLF when the BLF filter is the one that stamped the path", async () => {
    await saveThrough("/logs/run.blf");
    await waitFor(() => {
      if (!lastSaveCall()) throw new Error("save_capture not invoked yet");
    });
    expect(lastSaveCall()?.args).toMatchObject({
      path: "/logs/run.blf",
      format: "blf",
    });
  });
});
