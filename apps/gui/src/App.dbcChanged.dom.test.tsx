// @vitest-environment jsdom
//
// The seam between the host's announcement and the frontend's carrier
// (ADR 0053 §3): `App` subscribes to `dbc-changed` once, through the
// shared subscription, and re-anchors the trace model. Every windowed
// view and the plot's decimated source fold that epoch into their fetch
// descriptors, so this one translation is what carries a DBC edited on
// *disk* to all of them — the path the frontend cannot know about. The
// plot's own resample loop learned to follow the model epoch on a
// frontend-initiated DBC change, but nothing translated the watcher's
// `dbc-changed` into that same epoch bump, so an on-disk edit still left
// the plot on the old decode until this seam closed the gap.
//
// Mounts the REAL App with the Tauri IPC mocked, drives a session with
// synthetic `trace-grew` events, adds a trace panel through the real
// toolbar and stops it — a stopped window is the case where nothing
// else re-keys the fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// ---- Tauri IPC mocks --------------------------------------------------

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
function emitTauri(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h({ payload });
}

// Commands with their args, so the test can assert *what window* a
// panel asked the host for, not just that it asked.
const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
// Row-page fetches only (`limit > 0`). A parked window still issues
// count-only refreshes on the shared primitive's stale tick, and those
// say nothing about whether the view re-asked for its rows.
const rowPages: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args: args ?? {} });
    if (typeof args?.limit === "number" && args.limit > 0) rowPages.push(cmd);
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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

// uPlot touches `matchMedia` at import time, which jsdom lacks — same
// stub the PlotPanel dom test uses.
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

import { StrictMode } from "react";

import type { TraceFrameRecord, TraceGrew } from "./types";
import { App } from "./App";
import { DBC_CHANGE_COALESCE_MS } from "./dbcChanged";

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
    id: 0x100 + (index % 16),
    extended: false,
    direction: "Rx",
    kind: "classic" as unknown as TraceFrameRecord["kind"],
    data: [index % 256, 0, 0, 0],
    decoded: null,
    bus_id: "b1",
  };
}

function grew(count: number): TraceGrew {
  const tailLen = Math.min(256, count);
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
    tail: Array.from({ length: tailLen }, (_, i) => frame(count - tailLen + i)),
  };
}

function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeCalls.length = 0;
  rowPages.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a DBC changed on disk", () => {
  it("re-anchors the trace model, so a stopped view re-asks the host", async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await waitFor(() => {
      if (!document.querySelector(".trace-panel .trace-status"))
        throw new Error("seeded layout not mounted yet");
    });

    // A session with history, and a panel over it: added mid-session it
    // comes up running and anchored at 0 (see App.midSessionCreate).
    await act(async () => {
      emitTauri("trace-grew", grew(5000));
    });
    await act(async () => {
      fireEvent.click(findButton("Add trace"));
    });
    await waitFor(() => {
      if (!rowPages.includes("fetch_by_id_page"))
        throw new Error("the new panel has not paged its window yet");
    });

    // Stop it. A running view re-pages on its own refresh tick, which
    // would answer the question by accident; a stopped one re-pages only
    // when the identity of what it fetches changes.
    const running = document.querySelectorAll<HTMLElement>(
      ".trace-panel .trace-status-running",
    );
    expect(running.length).toBe(1);
    const panel = running[0].closest(".trace-panel") as HTMLElement;
    const stop = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "Stop",
    );
    if (!stop) throw new Error("no Stop button on the running panel");
    await act(async () => {
      fireEvent.click(stop);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, DBC_CHANGE_COALESCE_MS * 2));
    });
    const settled = rowPages.length;

    // The host's filesystem watcher picked up an edit and announced it.
    await act(async () => {
      emitTauri("dbc-changed", "/tmp/pack.dbc");
    });
    await waitFor(
      () => {
        if (rowPages.length <= settled)
          throw new Error("the stopped view never re-asked the host");
      },
      { timeout: 5000 },
    );
    // Every open view re-pages on a re-anchor, so what one announcement
    // costs is a round of them — the seeded panel's window and the added
    // one's.
    const perReAnchor = rowPages.length - settled;

    // One editor save is a burst: the watcher re-reads and re-announces
    // per filesystem event, and the app must re-anchor once for it
    // (ADR 0053 §5). Un-coalesced this is one full re-page per event.
    const afterFirst = rowPages.length;
    await act(async () => {
      for (let i = 0; i < 5; i += 1) emitTauri("dbc-changed", "/tmp/pack.dbc");
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, DBC_CHANGE_COALESCE_MS * 4));
    });
    expect(rowPages.length).toBe(afterFirst + perReAnchor);
  }, 30_000);
});
