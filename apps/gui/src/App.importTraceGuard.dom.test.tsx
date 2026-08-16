// @vitest-environment jsdom
//
// One trace-open at a time. Picking a capture starts a census walk over
// the whole file before the channel-mapping dialog has anything to
// show — seconds on a large log — and every second invocation launched
// during that window used to walk its own census and pop its own
// mapping dialog, so a user who clicked again because "nothing was
// happening" got prompted repeatedly. Pinned here by stalling the scan
// command and driving every entry point into the flow: the toolbar
// button, the command palette, and the Recent-captures list.
//
// The busy feedback the guard replaces the second dialog with is
// pinned in the same file: the launcher itself goes busy while the
// census walks, and clears when it finishes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

/// Every stalled census, in call order — the test releases them one at
/// a time, so a queued second scan is visible as a second entry.
let scanReleases: Array<() => void> = [];
let scanCalls = 0;
let seededRecents: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "fetch_system_log":
      case "fetch_notes":
      case "fetch_trace_range":
      case "list_transmit_frames":
      case "list_signals":
      case "rbs_dirty":
      case "get_interfaces":
        return [];
      case "get_state":
        return {
          last_project: null,
          layout: null,
          recent_blfs: seededRecents,
          recent_commands: [],
          blf_channel_maps: {},
        };
      case "scan_blf_channels":
        scanCalls += 1;
        await new Promise<void>((resolve) => {
          scanReleases.push(resolve);
        });
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

/// How many channel-mapping dialogs are up right now (its confirm
/// button is the marker the other import tests use).
function mappingDialogs(): number {
  return Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "Open")
    .length;
}

async function mountAndSeed() {
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
}

/// Start an import from the toolbar and wait until its census is
/// stalled inside the mocked host.
async function startStalledImport() {
  await act(async () => {
    fireEvent.click(importButton());
  });
  await waitFor(() => {
    if (scanReleases.length === 0) throw new Error("census never started");
  });
}

/// Release every stalled census and let the resulting renders settle.
async function releaseAllScans() {
  await act(async () => {
    for (const release of scanReleases.splice(0)) release();
    await Promise.resolve();
  });
}

/// Release just the oldest stalled census — the order the queued
/// dialogs came back in.
async function releaseOneScan() {
  await act(async () => {
    scanReleases.shift()?.();
    await Promise.resolve();
  });
}

/// Run `trace.import` the way the command palette does: Ctrl+Shift+P,
/// type, Enter.
async function runImportFromPalette() {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "P",
      ctrlKey: true,
      shiftKey: true,
    });
  });
  const input = document.querySelector<HTMLInputElement>(".palette input.palette-input");
  if (!input) throw new Error("command palette did not open");
  await act(async () => {
    fireEvent.change(input, { target: { value: "Import trace" } });
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
}

/// Open the Recent-captures dropdown and click its first entry.
async function runImportFromRecents() {
  const summary = document.querySelector(".recent-captures > button");
  if (!summary) throw new Error("recent-captures dropdown is not rendered");
  await act(async () => {
    fireEvent.click(summary);
  });
  const entry = document.querySelector<HTMLButtonElement>(".recent-captures-menu button");
  if (!entry) throw new Error("no recent capture to click");
  await act(async () => {
    fireEvent.click(entry);
  });
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  scanReleases = [];
  scanCalls = 0;
  seededRecents = ["/logs/huge-capture.blf"];
  await hydrateState();
});

afterEach(() => {
  for (const release of scanReleases.splice(0)) release();
  cleanup();
  vi.unstubAllGlobals();
});

describe("one trace-open at a time", () => {
  it("blocks the palette command while a census is walking", async () => {
    await mountAndSeed();
    await startStalledImport();

    await runImportFromPalette();
    expect(scanCalls).toBe(1);
  }, 30_000);

  it("blocks a Recent-captures entry while a census is walking", async () => {
    await mountAndSeed();
    await startStalledImport();

    await runImportFromRecents();
    expect(scanCalls).toBe(1);
  }, 30_000);

  it("blocks the toolbar button while a census is walking", async () => {
    await mountAndSeed();
    await startStalledImport();

    await act(async () => {
      fireEvent.click(importButton());
    });
    expect(scanCalls).toBe(1);
  }, 30_000);

  it("blocks a further open while the mapping dialog is up", async () => {
    await mountAndSeed();
    await startStalledImport();
    await releaseAllScans();
    await waitFor(() => findButton("Open"));

    await runImportFromPalette();
    await runImportFromRecents();
    expect(scanCalls).toBe(1);
    expect(mappingDialogs()).toBe(1);
  }, 30_000);

  it("never queues a second dialog behind the first (the reported symptom)", async () => {
    await mountAndSeed();
    await startStalledImport();
    // "Nothing was happening", so the user goes again — twice.
    await runImportFromPalette();
    await runImportFromRecents();

    // Each census finishes in its own time, so the dialogs arrive one
    // after another — dismissing the first used to hand the user the
    // next one.
    await releaseOneScan();
    await waitFor(() => findButton("Open"));
    expect(mappingDialogs()).toBe(1);

    // Dismiss it: the flow is over, and nothing pops back up.
    await act(async () => {
      fireEvent.click(findButton("Cancel"));
    });
    await releaseOneScan();
    await releaseOneScan();
    expect(mappingDialogs()).toBe(0);
  }, 30_000);

  it("re-opens normally once the first open has finished", async () => {
    await mountAndSeed();
    await startStalledImport();
    await releaseAllScans();
    await waitFor(() => findButton("Open"));
    await act(async () => {
      fireEvent.click(findButton("Cancel"));
    });

    await startStalledImport();
    expect(scanCalls).toBe(2);
  }, 30_000);
});

describe("census busy feedback", () => {
  it("puts the launcher itself in a busy state until the dialog opens", async () => {
    await mountAndSeed();
    expect(importButton()).not.toBeDisabled();
    expect(document.querySelector(".trace-scan-bar")).toBeNull();

    await startStalledImport();

    // The affordance that launched it says so — a subtler signal than
    // this is what got clicked through in the first place.
    const busy = importButton();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toBeDisabled();
    expect(busy.textContent).toBe("Loading trace…");
    // …alongside an indeterminate progress affordance in the header.
    expect(document.querySelector(".trace-scan-bar")).not.toBeNull();

    await releaseAllScans();
    await waitFor(() => findButton("Open"));
    const idle = importButton();
    expect(idle).not.toHaveAttribute("aria-busy");
    expect(idle).not.toBeDisabled();
    expect(idle.textContent).toBe("Import trace…");
    expect(document.querySelector(".trace-scan-bar")).toBeNull();
  }, 30_000);
});
