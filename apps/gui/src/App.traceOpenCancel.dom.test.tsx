// @vitest-environment jsdom
//
// The trace-open busy launcher must stay busy until the load is
// actually done — not until the plot starts getting data — and both
// phases of that load must be stoppable from a control that says
// "Cancel".
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

/// Set to hold `scan_blf_channels` open, so a test can act while the
/// census is still walking — the phase that used to have no way out.
/// Production's census resolves on its own; these tests decide when.
let stalledCensus: { promise: Promise<unknown>; settle: (value: unknown) => void } | null = null;

function stallTheCensus() {
  let settle: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  stalledCensus = { promise, settle };
}

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
        if (stalledCensus) return stalledCensus.promise;
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
import { toolbarChip } from "./toolbarTestKit";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/// A button outside the toolbar. The toolbar's own controls are chips
/// with short labels — "Open" up there is the Open-project chip, not a
/// dialog's confirm — so they are excluded here and reached through
/// `toolbarChip` instead.
function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .filter((b) => b.closest(".toolbar") === null)
    .find((b) => b.textContent === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
}

function importButton(): HTMLButtonElement {
  return toolbarChip("Import");
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
          bus_load_percent: null,
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

function fireLoadProgress(payload: unknown) {
  return act(async () => {
    for (const h of listeners.get("load-progress") ?? []) h({ payload });
  });
}

function cancelButton(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(".trace-load-cancel");
  if (!btn) throw new Error("the status line has no Cancel button");
  return btn;
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeCalls.length = 0;
  stalledCensus = null;
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
    // The words are in the tooltip now: the chip says it on the
    // hairline, and its label does not change width under the pointer.
    expect(busy.getAttribute("title")).toMatch(/^Loading a capture/);
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector(".trace-scan-bar")).not.toBeNull();

    // Data starts streaming into the plot panel — this is exactly the
    // moment the old behavior dropped the busy feedback. It must not.
    await fireTraceGrew(500);
    busy = importButton();
    // The words are in the tooltip now: the chip says it on the
    // hairline, and its label does not change width under the pointer.
    expect(busy.getAttribute("title")).toMatch(/^Loading a capture/);
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector(".trace-scan-bar")).not.toBeNull();

    // Only the import's own completion ends it.
    await fireLogFinished({ status: "ok", total: 500 });
    const idle = importButton();
    expect(idle.getAttribute("title")).toMatch(/^Import trace…/);
    expect(idle).not.toHaveAttribute("aria-busy");
    expect(document.querySelector(".trace-scan-bar")).toBeNull();
  }, 30_000);
});

describe("cancelling the import phase", () => {
  it("cancels the running import from the Cancel button, cleans up, and leaves a later open working", async () => {
    await mountAndSeed();
    await openThroughToLoading();
    await fireTraceGrew(200);

    const clearCallsBeforeCancel = invokeCalls.filter((c) => c.cmd === "clear_trace_store").length;

    // The launcher itself is inert while a load runs — it is busy, it
    // is disabled, and it no longer carries a hidden second meaning.
    expect(importButton()).toBeDisabled();

    await act(async () => {
      fireEvent.click(cancelButton());
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
    expect(idle.getAttribute("title")).toMatch(/^Import trace…/);
    expect(idle).not.toHaveAttribute("aria-busy");
    expect(statusText()).not.toContain("Done:");
    expect(statusText()).toMatch(/Open a BLF log/);
    expect(document.querySelector(".trace-load-cancel")).toBeNull();

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

  it("leaves the capture alone when the import is let run to its end", async () => {
    // The control for the test above: the same load, nothing cancelling
    // it, keeps its frames and reports them — so "the cancel cleared the
    // partial capture" is about the cancel and not about every load
    // ending in a clear.
    await mountAndSeed();
    await openThroughToLoading();
    await fireTraceGrew(200);

    const clearsBefore = invokeCalls.filter((c) => c.cmd === "clear_trace_store").length;
    await fireLogFinished({ status: "ok", total: 137 });

    expect(invokeCalls.filter((c) => c.cmd === "clear_trace_store").length).toBe(clearsBefore);
    expect(statusText()).toContain("Done:");
  }, 30_000);
});

describe("cancelling the census phase", () => {
  it("stops a census that is still walking, and opens no mapping dialog", async () => {
    await mountAndSeed();
    stallTheCensus();

    await act(async () => {
      fireEvent.click(importButton());
    });
    await waitFor(() => {
      if (!invokeCalls.some((c) => c.cmd === "scan_blf_channels"))
        throw new Error("the census never started");
    });

    // The phase that used to be a plain-disabled wait now has a way out.
    const busy = importButton();
    // The words are in the tooltip now: the chip says it on the
    // hairline, and its label does not change width under the pointer.
    expect(busy.getAttribute("title")).toMatch(/^Loading a capture/);
    expect(busy).toBeDisabled();
    await act(async () => {
      fireEvent.click(cancelButton());
    });
    await waitFor(() => {
      if (!invokeCalls.some((c) => c.cmd === "cancel_import"))
        throw new Error("cancel_import was never invoked for the census");
    });

    // A cancelled census resolves with `null`: it produced nothing, so
    // there is no dialog to show and nothing to clean up.
    await act(async () => {
      stalledCensus?.settle(null);
      await Promise.resolve();
    });
    await waitFor(() => {
      if (importButton().disabled)
        throw new Error("the launcher never came back to idle");
    });
    expect(document.querySelector(".blf-channel-map-modal")).toBeNull();
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (b) => b.textContent === "Open" && b.closest(".toolbar") === null,
      ),
    ).toBe(false);
    expect(statusText()).not.toMatch(/error/i);
    expect(invokeCalls.some((c) => c.cmd === "open_log")).toBe(false);
  }, 30_000);

  it("opens the mapping dialog when the census is let finish", async () => {
    // The control: the same stalled census, resolved with a real scan
    // instead of `null`, does show its dialog.
    await mountAndSeed();
    stallTheCensus();

    await act(async () => {
      fireEvent.click(importButton());
    });
    await waitFor(() => {
      if (!invokeCalls.some((c) => c.cmd === "scan_blf_channels"))
        throw new Error("the census never started");
    });
    await act(async () => {
      stalledCensus?.settle({
        channels: [0],
        frame_count: 1,
        first_timestamp_ns: 1_000_000_000,
        last_timestamp_ns: 1_000_000_000,
        start_unix_nanos: 1_700_000_000_000_000_000,
        markers: [],
      });
      await Promise.resolve();
    });

    await waitFor(() => findButton("Open"));
  }, 30_000);
});

describe("determinate load progress", () => {
  it("shows the census as a fraction of the file, not an indeterminate chip", async () => {
    await mountAndSeed();
    stallTheCensus();

    await act(async () => {
      fireEvent.click(importButton());
    });
    await waitFor(() => {
      if (!invokeCalls.some((c) => c.cmd === "scan_blf_channels"))
        throw new Error("the census never started");
    });

    // Before the host has reported anything there is no honest
    // fraction, so the indeterminate chip stands.
    expect(document.querySelector(".trace-scan-bar")).not.toBeNull();
    expect(document.querySelector(".trace-progress-bar")).toBeNull();

    await fireLoadProgress({ phase: "census", bytes_read: 380, total_bytes: 1_000 });

    const bar = document.querySelector(".trace-progress-bar");
    expect(bar).not.toBeNull();
    expect(bar).toHaveAttribute("aria-valuenow", "38");
    expect(document.querySelector(".trace-scan-bar")).toBeNull();
    expect(document.querySelector(".trace-progress-readout")?.textContent).toBe("38 %");

    await act(async () => {
      stalledCensus?.settle(null);
      await Promise.resolve();
    });
  }, 30_000);

  it("shows the import as frames against the count the census returned", async () => {
    await mountAndSeed();
    await openThroughToLoading();

    // The census's count travels with the open, which is what gives the
    // pump a denominator at all.
    const open = invokeCalls.find((c) => c.cmd === "open_log");
    expect(open?.args.totalFrames).toBe(1);

    await fireLoadProgress({ phase: "import", frames: 250, total_frames: 1_000 });

    const bar = document.querySelector(".trace-progress-bar");
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(document.querySelector(".trace-progress-readout")?.textContent).toBe(
      `${(250).toLocaleString()} / ${(1_000).toLocaleString()} frames`,
    );

    // The next load starts from no report rather than inheriting this
    // one's last fraction.
    await fireLogFinished({ status: "ok", total: 250 });
    expect(document.querySelector(".trace-progress-bar")).toBeNull();
  }, 30_000);
});
