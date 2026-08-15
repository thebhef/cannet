// @vitest-environment jsdom
//
// Task 75 item 2, refinements (a) + (b): the trace-open busy launcher
// must stay busy until the import is actually done — not until the
// plot starts getting data — and clicking it while busy with an import
// in flight cancels that import.
//
// `open_log`/`import_mdf` themselves resolve as soon as the host's pump
// thread is spawned (`Ok(result)` right after `.spawn(...)` — see
// `capture.rs`); the frontend's `state.kind` stays `"loading"` from
// that point until the pump's own `log-finished` event arrives, however
// long the pump actually takes. So these tests don't stall `open_log` —
// they let it resolve immediately, the way production does, and instead
// hold off firing `log-finished` to represent "still importing".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

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
      case "get_interfaces":
        return [];
      case "fetch_filtered_trace":
      case "fetch_by_id_page":
        return { count: 0, start: 0, rows: [] };
      case "get_state":
        return {
          last_project: null,
          layout: null,
          recent_blfs: [],
          recent_commands: [],
          blf_channel_maps: {},
        };
      case "set_state":
      case "clear_trace_store":
      case "cancel_import":
        return null;
      case "scan_blf_channels":
        return {
          channels: [0],
          frame_count: 1,
          first_timestamp_ns: 1_000_000_000,
          last_timestamp_ns: 1_000_000_000,
          start_unix_nanos: 1_700_000_000_000_000_000,
          markers: [],
        };
      case "open_log":
        return { blf_path: String(args?.blfPath) };
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
  open: vi.fn(async () => "/logs/huge-capture.blf"),
  save: vi.fn(async () => null),
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

function importButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>(".toolbar > button")).find(
    (b) => b.textContent === "Import trace…" || b.textContent === "Loading trace…",
  );
  if (!btn) throw new Error("the Import trace… toolbar button is gone");
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

/// Pick the BLF, let its (unstalled) census resolve, and confirm the
/// mapping dialog — the same sequence `App.importTrace.dom.test.tsx`
/// pins for the confirm path. Leaves `state.kind === "loading"`: the
/// pump is "running" until this test fires `log-finished` itself.
async function openThroughToLoading() {
  await act(async () => {
    fireEvent.click(importButton());
  });
  await waitFor(() => findButton("Open"));
  await act(async () => {
    fireEvent.click(findButton("Open"));
  });
  await waitFor(() => {
    if (!invokeCalls.some((c) => c.cmd === "open_log")) throw new Error("open_log not called");
  });
}

function fireLogFinished(payload: { status: "ok"; total: number } | { status: "error"; message: string }) {
  return act(async () => {
    for (const h of listeners.get("log-finished") ?? []) h({ payload });
  });
}

function fireTraceGrew(count: number) {
  return act(async () => {
    for (const h of listeners.get("trace-grew") ?? []) {
      h({
        payload: {
          count,
          first_index: 0,
          first_index_ts_ns: 1_000_000_000,
          frames_per_second: 100,
          frames_per_second_rx: 100,
          frames_per_second_tx: 0,
          frames_per_second_by_bus: [],
          frames_dropped_before_session: 0,
          session_start_seconds: 1_700_000_000,
          buffer_seconds: 1,
          scratch_bytes: null,
          mem_bytes: null,
          tail: [],
        },
      });
    }
  });
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeCalls.length = 0;
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("import busy feedback persists past first data", () => {
  it("stays busy once the pump is running, through data arriving, until log-finished", async () => {
    await mountAndSeed();
    await openThroughToLoading();

    // The pump is "running" (no log-finished yet): the launcher must
    // already read the busy state, not the idle one — this is the
    // window that used to be silent (state.kind stays "loading" the
    // whole time; nothing before this pinned it).
    let busy = importButton();
    expect(busy.textContent).toBe("Loading trace…");
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector(".trace-scan-bar")).not.toBeNull();

    // Data starts streaming into the plot panel — this is exactly the
    // moment the old behavior dropped the busy feedback. It must not.
    await fireTraceGrew(500);
    busy = importButton();
    expect(busy.textContent).toBe("Loading trace…");
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector(".trace-scan-bar")).not.toBeNull();

    // Only the import's own completion ends it.
    await fireLogFinished({ status: "ok", total: 500 });
    const idle = importButton();
    expect(idle.textContent).toBe("Import trace…");
    expect(idle).not.toHaveAttribute("aria-busy");
    expect(document.querySelector(".trace-scan-bar")).toBeNull();
  }, 30_000);
});

describe("click-to-cancel", () => {
  it("cancels the running import, cleans up, and leaves a later open working", async () => {
    await mountAndSeed();
    await openThroughToLoading();
    await fireTraceGrew(200);

    const clearCallsBeforeCancel = invokeCalls.filter((c) => c.cmd === "clear_trace_store").length;

    // Click the busy launcher itself — it doubles as Cancel while an
    // import is actually running (not merely censusing).
    await act(async () => {
      fireEvent.click(importButton());
    });
    await waitFor(() => {
      if (!invokeCalls.some((c) => c.cmd === "cancel_import"))
        throw new Error("cancel_import was never invoked");
    });
    // A second import must not have started from the same click.
    expect(invokeCalls.filter((c) => c.cmd === "open_log").length).toBe(1);

    // The host's pump ends through its ordinary clean-exit path even
    // when cancelled (`log-finished: Ok`) — the frontend is what tells
    // the cancellation apart, since it's the one that asked for it.
    await fireLogFinished({ status: "ok", total: 137 });

    // Partial state cleaned up: the host trace store gets cleared again
    // (on top of the clear that ran before the pump started), and the
    // UI reads idle, not "Done: 137 frames".
    await waitFor(() => {
      const clearedAgain =
        invokeCalls.filter((c) => c.cmd === "clear_trace_store").length > clearCallsBeforeCancel;
      if (!clearedAgain) throw new Error("cancelled import never cleared the partial trace store");
    });
    const idle = importButton();
    expect(idle.textContent).toBe("Import trace…");
    expect(idle).not.toHaveAttribute("aria-busy");
    expect(statusText()).not.toContain("Done:");
    expect(statusText()).toMatch(/Open a BLF log/);

    // A subsequent open works: the guard isn't left wedged by the
    // cancellation.
    const scansBefore = invokeCalls.filter((c) => c.cmd === "scan_blf_channels").length;
    await act(async () => {
      fireEvent.click(importButton());
    });
    await waitFor(() => {
      if (invokeCalls.filter((c) => c.cmd === "scan_blf_channels").length <= scansBefore)
        throw new Error("a later Import trace… click was blocked after the cancel");
    });
  }, 30_000);
});
