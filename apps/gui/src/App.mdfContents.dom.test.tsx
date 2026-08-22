// @vitest-environment jsdom
//
// An MF4 holds two independent kinds of content, and the import dialog
// offers a checkbox per kind. This pins the wire end of that: what the
// user leaves checked is what `import_mdf` is told to bring in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

/// Every `invoke` the render makes, so the test can read back the
/// arguments the import was launched with.
const calls: { cmd: string; args: Record<string, unknown> }[] = [];

/// What `scan_mdf_channels` answers — the file shape under test. The
/// owner's default: frames *and* signal content, the second of which is
/// mostly per-message decoded groups. A test that is about a different
/// file shape reassigns it before rendering.
const MIXED_SCAN = {
  channels: [0],
  frame_count: 15_285,
  first_timestamp_ns: 1_000_000_000,
  last_timestamp_ns: 1_080_000_000,
  start_unix_nanos: 1_700_000_000_000_000_000,
  markers: [],
  unfinalized: false,
  signal_group_count: 61,
  signal_count: 172,
  decoded_message_groups: [
    {
      source_path: "CAN1.CAN_DataFrame.ID=0x310 EXT=False",
      name: "CAN1 message ID=0x310 EXT=False",
      signal_count: 24,
    },
  ],
};

/// A file with signal groups and no bus-logging group at all: the census
/// reports no channels and no frames, so there is no CAN-message content
/// to offer.
const SIGNAL_ONLY_SCAN = {
  ...MIXED_SCAN,
  channels: [],
  frame_count: 0,
  first_timestamp_ns: null,
  last_timestamp_ns: null,
  signal_group_count: 2,
  signal_count: 3,
  decoded_message_groups: [],
};

let mdfScan: Record<string, unknown> = MIXED_SCAN;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    switch (cmd) {
      case "fetch_system_log":
      case "fetch_notes":
      case "fetch_trace_range":
      case "list_transmit_frames":
      case "list_signals":
      case "rbs_dirty":
      case "get_interfaces":
        return [];
      case "scan_mdf_channels":
        return mdfScan;
      case "import_mdf":
        return { mdf_path: "/logs/capture.mf4" };
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
  open: vi.fn(async () => "/logs/capture.mf4"),
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

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  calls.length = 0;
  mdfScan = MIXED_SCAN;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MDF import contents", () => {
  async function openTheDialog() {
    render(<App />);
    await waitFor(() => {
      if (!document.querySelector(".trace-panel .trace-status"))
        throw new Error("seeded layout not mounted yet");
    });
    await act(async () => {
      fireEvent.click(toolbarChip("Import"));
    });
    await waitFor(() => findButton("Open"));
  }

  function importArgs(): Record<string, unknown> {
    const call = calls.find((c) => c.cmd === "import_mdf");
    if (!call) throw new Error("import_mdf was never invoked");
    return call.args;
  }

  function checkbox(label: RegExp): HTMLInputElement {
    const el = Array.from(document.querySelectorAll<HTMLLabelElement>("label.blf-map-content"))
      .find((l) => label.test(l.textContent ?? ""));
    if (!el) throw new Error(`no content checkbox matching ${label}`);
    return el.querySelector("input") as HTMLInputElement;
  }

  function hasCheckbox(label: RegExp): boolean {
    return Array.from(document.querySelectorAll<HTMLLabelElement>("label.blf-map-content")).some(
      (l) => label.test(l.textContent ?? ""),
    );
  }

  it("imports the file's signals and leaves its frames alone by default", async () => {
    await openTheDialog();
    expect(checkbox(/^Signals/).checked).toBe(true);
    expect(checkbox(/^CAN messages/).checked).toBe(false);

    await act(async () => {
      fireEvent.click(findButton("Open"));
    });
    await waitFor(() => importArgs());
    expect(importArgs().importSignals).toBe(true);
    expect(importArgs().importMessages).toBe(false);
  }, 30_000);

  it("imports the frames too once the CAN messages box is ticked", async () => {
    await openTheDialog();
    await act(async () => {
      fireEvent.click(checkbox(/^CAN messages/));
    });
    await act(async () => {
      fireEvent.click(findButton("Open"));
    });
    await waitFor(() => importArgs());
    expect(importArgs().importSignals).toBe(true);
    expect(importArgs().importMessages).toBe(true);
  }, 30_000);

  it("offers only Signals for a file with no frames in it", async () => {
    mdfScan = SIGNAL_ONLY_SCAN;
    await openTheDialog();
    expect(checkbox(/^Signals/).checked).toBe(true);
    expect(hasCheckbox(/^CAN messages/)).toBe(false);

    await act(async () => {
      fireEvent.click(findButton("Open"));
    });
    await waitFor(() => importArgs());
    expect(importArgs().importSignals).toBe(true);
    expect(importArgs().importMessages).toBe(false);
    expect(importArgs().channelBusMapping).toEqual([]);
  }, 30_000);
});
