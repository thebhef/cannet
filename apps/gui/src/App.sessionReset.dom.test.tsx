// @vitest-environment jsdom
//
// The session (re)start sequence — clear the host trace store, then
// reset the frontend's derived session state — is shared by Clear,
// Connect, BLF-map confirm, and New project, but each site's error
// policy when the host clear FAILS is deliberately different:
//
//   - Clear   : continue — reset the session anyway.
//   - Connect : abort    — surface the error, don't touch the session.
//   - BLF-map : abort    — surface the error (+ drop the recent entry),
//                          don't run the import.
//   - New     : fire-and-forget — swallow the failure, reset anyway.
//
// These tests pin those four policies by driving the REAL App with the
// host `clear_trace_store` command rigged to reject.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
function emitTauri(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h({ payload });
}

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
// Flipped per-test to make the host trace-store clear reject.
const rig = { failClear: false };
// Project handed back by `open_project` (test 2 seeds bindings).
let openProjectResult: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args: args ?? {} });
    if (cmd === "clear_trace_store" && rig.failClear) {
      throw new Error("boom");
    }
    switch (cmd) {
      case "fetch_system_log":
      case "fetch_notes":
      case "fetch_trace_range":
      case "list_transmit_frames":
      case "list_signals":
      case "rbs_dirty":
      case "get_interfaces":
        return [];
      case "scan_blf_channels":
        return {
          channels: [0],
          frame_count: 1,
          first_timestamp_ns: 1_000_000_000,
          last_timestamp_ns: 1_000_000_000,
          start_unix_nanos: 1_700_000_000_000_000_000,
          markers: [],
        };
      case "fetch_filtered_trace":
      case "fetch_by_id_page":
        return { count: 0, start: 0, rows: [] };
      case "open_project":
        return openProjectResult;
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
    setTitle: async () => {},
    isMaximized: async () => false,
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    destroy: async () => {},
  }),
}));

// The BLF-open flow reaches for the dialog `open`; return a path so the
// channel-map modal shows.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => "/cap.blf"),
  save: vi.fn(async () => null),
}));

// uPlot touches `matchMedia` at import time, which jsdom lacks.
vi.mock("uplot", () => {
  class FakeUPlot {
    over = document.createElement("div");
    scales = { x: {}, y: {} } as Record<string, { min?: number; max?: number }>;
    data: unknown = [[]];
    width = 600;
    constructor(_opts: unknown, data: unknown, el: HTMLElement) {
      this.data = data;
      el.appendChild(document.createElement("canvas"));
    }
    setData(d: unknown) {
      this.data = d;
    }
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
import type { TraceFrameRecord, TraceGrew } from "./types";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function frame(index: number): TraceFrameRecord {
  return {
    index,
    timestamp_seconds: 1000 + index / 1000,
    channel: 0,
    id: 0x100,
    extended: false,
    direction: "Rx",
    kind: "classic" as unknown as TraceFrameRecord["kind"],
    data: [0],
    decoded: null,
    bus_id: "b1",
  };
}

function grew(count: number): TraceGrew {
  return {
    count,
    first_index: 0,
    first_index_ts_ns: null,
    frames_per_second: 1000,
    frames_per_second_rx: 1000,
    frames_per_second_tx: 0,
    frames_per_second_by_bus: [{ bus_id: "b1", frames_per_second: 1000 }],
    bus_load_percent: null,
    frames_dropped_before_session: 0,
    session_start_seconds: 1000,
    buffer_seconds: 1,
    scratch_bytes: null,
    mem_bytes: null,
    tail: [frame(count - 1)],
  };
}

/// The connection control: a status chip in the bar rather than a
/// toolbar button, so it is found by its own class and its state reads
/// off its accessible name.
function connectionChip(): HTMLButtonElement {
  const chip = document.querySelector<HTMLButtonElement>("button.status-chip--connection");
  if (!chip) throw new Error("no connection chip");
  return chip;
}

function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
}

function statusText(): string {
  return document.querySelector(".status")?.textContent ?? "";
}

async function mountAndSeed() {
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
}

async function driveSession(count: number) {
  await act(async () => {
    emitTauri("trace-grew", grew(count));
  });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeCalls.length = 0;
  rig.failClear = false;
  openProjectResult = {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("session-reset error policies", () => {
  it("Clear continues past a failed host clear (session still resets)", async () => {
    await mountAndSeed();
    await driveSession(5000);
    // A live session enables the toolbar Clear button.
    expect(findButton("Clear")).not.toBeDisabled();

    rig.failClear = true;
    await act(async () => {
      fireEvent.click(findButton("Clear"));
    });

    // The failure surfaces...
    await waitFor(() => {
      if (!statusText().includes("boom")) throw new Error("clear error not shown");
    });
    // ...but the session reset still ran: count is back to 0, so Clear
    // (and Save capture) disable again. Continue, not abort.
    await waitFor(() => {
      if (!findButton("Clear").disabled) throw new Error("Clear did not disable — session not reset");
    });
  }, 30_000);

  it("Connect aborts on a failed host clear (session untouched, no connect call)", async () => {
    // Seed a project with one bus + a remote binding so Connect is live.
    openProjectResult = {
      schema_version: 4,
      project_id: "p1",
      layout: { grid: {}, panels: {} },
      elements: [],
      buses: [{ id: "b1", name: "B1" }],
      interface_bindings: [{ server: "127.0.0.1:9", interface: "if0", bus_id: "b1" }],
      dbcs: [],
      remote_address: null,
      local_virtual_buses: [],
      signal_colors: {},
    };
    await mountAndSeed();
    await act(async () => {
      fireEvent.click(findButton("Open…"));
    });
    // Connect enables once the project's binding lands in state.
    await waitFor(() => {
      if (connectionChip().disabled) throw new Error("Connect still disabled");
    });
    await driveSession(5000);

    rig.failClear = true;
    const callsBefore = invokeCalls.length;
    await act(async () => {
      fireEvent.click(connectionChip());
    });

    await waitFor(() => {
      if (!statusText().includes("boom")) throw new Error("connect clear error not shown");
    });
    // Abort: the connect never reached the host, and the session was NOT
    // reset (Clear stays enabled — count still 5000).
    const connectCalls = invokeCalls
      .slice(callsBefore)
      .filter((c) => c.cmd === "connect_remote_server");
    expect(connectCalls).toHaveLength(0);
    expect(findButton("Clear")).not.toBeDisabled();
  }, 30_000);

  it("BLF-map confirm aborts on a failed host clear (no import runs)", async () => {
    await mountAndSeed();
    await act(async () => {
      fireEvent.click(findButton("Import trace…"));
    });
    // The channel-map modal's confirm button.
    await waitFor(() => findButton("Open"));

    rig.failClear = true;
    const callsBefore = invokeCalls.length;
    await act(async () => {
      fireEvent.click(findButton("Open"));
    });

    await waitFor(() => {
      if (!statusText().includes("boom")) throw new Error("blf-map clear error not shown");
    });
    // Abort: open_log never ran.
    const opens = invokeCalls.slice(callsBefore).filter((c) => c.cmd === "open_log");
    expect(opens).toHaveLength(0);
  }, 30_000);

  it("New project fire-and-forgets a failed host clear (no error surfaced)", async () => {
    await mountAndSeed();
    await driveSession(5000);
    expect(findButton("Clear")).not.toBeDisabled();

    rig.failClear = true;
    await act(async () => {
      fireEvent.click(findButton("New"));
    });

    // Fire-and-forget: the session still resets (Clear disables)...
    await waitFor(() => {
      if (!findButton("Clear").disabled) throw new Error("New did not reset the session");
    });
    // ...and the swallowed clear failure never reaches the status bar.
    expect(statusText()).not.toContain("boom");
  }, 30_000);
});
