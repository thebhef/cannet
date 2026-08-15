// @vitest-environment jsdom
//
// Task 75 item 6 — a cold pyramid rebuild announces itself, and offers a
// way out.
//
// When a boot/project-open restore finds the persisted signal pyramids
// invalid (ADR 0047's validity key), it discards them and every plotted
// signal is decoded again from frame zero — minutes on a large capture,
// and previously silent, which read as the app being broken. The host is
// what knows this (`restore_scratch_capture`'s `pyramids_rebuilding`,
// and the `signal_pyramids_rebuilding` query behind it); the frontend
// announces it and never infers it.
//
// The offramp beside the chip drops the restored capture through the
// *same* session clear a fresh open runs — one deletion path — leaving a
// clean empty session with the project, its DBCs and the layout intact.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const invokeCalls: string[] = [];
/// Every window title the app has set — the observable proof of which
/// project (and capture) the session is on.
const windowTitles: string[] = [];

/// Per-test knobs (the mock is hoisted, so config rides in mutable state).
const knobs = {
  /// What `restore_scratch_capture` reports back.
  restored: {
    count: 5000,
    first_index: 120,
    first_index_ts_ns: 9_000,
    session_start_seconds: 1000,
    pyramids_rebuilding: true,
  },
  /// What the host answers when the chip polls it.
  stillRebuilding: true,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    invokeCalls.push(cmd);
    switch (cmd) {
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
          buses: [],
          interface_bindings: [],
          dbcs: [],
          local_virtual_buses: [],
          elements: [],
          layout: null,
        };
      case "restore_scratch_capture":
        return knobs.restored;
      case "signal_pyramids_rebuilding":
        return knobs.stillRebuilding;
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
    setTitle: async (t: string) => {
      windowTitles.push(t);
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

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/// Render the app and let the boot open (an async IIFE behind
/// dockview's `onReady`) settle, restore included.
async function boot(): Promise<void> {
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
}

/// The rebuild chip, or `null` when nothing is being announced.
function chip(): HTMLElement | null {
  return document.querySelector(".cache-rebuild");
}

function toolbarButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`no "${label}" button`);
  return btn as HTMLButtonElement;
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  invokeCalls.length = 0;
  windowTitles.length = 0;
  knobs.restored = {
    count: 5000,
    first_index: 120,
    first_index_ts_ns: 9_000,
    session_start_seconds: 1000,
    pyramids_rebuilding: true,
  };
  knobs.stillRebuilding = true;
  await hydrateState();
  await hydrateSettings();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Cold pyramid rebuild — feedback (task 75 item 6)", () => {
  it("announces the rebuild the restore forced", async () => {
    await boot();
    const bar = chip();
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain("Rebuilding signal caches…");
    // The same indeterminate chip the trace-open census uses.
    expect(bar?.querySelector(".trace-scan-bar")).not.toBeNull();
  });

  it("says nothing when the restore reused its pyramids", async () => {
    // The fast path — the whole point of ADR 0047 — must be silent.
    knobs.restored = { ...knobs.restored, pyramids_rebuilding: false };
    await boot();
    expect(chip()).toBeNull();
  });

  it("says nothing when there was no capture to restore", async () => {
    knobs.restored = { ...knobs.restored, count: 0, pyramids_rebuilding: true };
    await boot();
    expect(chip()).toBeNull();
  });

  it("takes the chip down when the host says the caches have caught up", async () => {
    // The end signal is the host's completeness token, not a timeout and
    // not a guess: the chip stays up while the host still says the
    // rebuild is owed, and goes when it stops saying so.
    await boot();
    expect(chip()).not.toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(chip()).not.toBeNull();
    expect(invokeCalls).toContain("signal_pyramids_rebuilding");

    knobs.stillRebuilding = false;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(chip()).toBeNull();
  });

  it("polls nothing on a session that is not rebuilding", async () => {
    knobs.restored = { ...knobs.restored, pyramids_rebuilding: false };
    await boot();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(invokeCalls).not.toContain("signal_pyramids_rebuilding");
  });
});

describe("Cold pyramid rebuild — discard offramp (task 75 item 6)", () => {
  it("drops the restored capture and leaves a clean empty session", async () => {
    await boot();
    // A capture is loaded: the capture-scoped toolbar actions are live.
    expect(toolbarButton("Clear").disabled).toBe(false);
    expect(toolbarButton("Save capture…").disabled).toBe(false);

    const discard = chip()?.querySelector("button");
    expect(discard).not.toBeNull();
    invokeCalls.length = 0;
    await act(async () => {
      fireEvent.click(discard as HTMLButtonElement);
      await new Promise((r) => setTimeout(r, 50));
    });

    // Dropped through the session clear a fresh open runs — not a second
    // deletion path of its own.
    expect(invokeCalls).toContain("clear_trace_store");
    // …and the session is empty, not half-deleted: no frames, so nothing
    // capture-scoped is offered.
    expect(toolbarButton("Clear").disabled).toBe(true);
    expect(toolbarButton("Save capture…").disabled).toBe(true);
    // The announcement is over with the capture it was about.
    expect(chip()).toBeNull();
  });

  it("stops polling the host once the capture is discarded", async () => {
    // Nothing is rebuilding any more, so nothing keeps asking — even
    // though the host would still answer `true` if it were asked.
    await boot();
    await act(async () => {
      fireEvent.click(chip()?.querySelector("button") as HTMLButtonElement);
      await new Promise((r) => setTimeout(r, 50));
    });
    invokeCalls.length = 0;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(invokeCalls).not.toContain("signal_pyramids_rebuilding");
  });

  it("keeps the project the capture belonged to", async () => {
    // The offramp drops capture-scoped state only. The project was
    // opened by the boot and stays open — discarding a capture is not
    // closing a project.
    await boot();
    await act(async () => {
      fireEvent.click(chip()?.querySelector("button") as HTMLButtonElement);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(invokeCalls).not.toContain("close_project");
    // The window still names the project it was opened on — the title's
    // leading segment is the project file (`windowTitle.ts`).
    expect(windowTitles[windowTitles.length - 1] ?? "").toMatch(/^last\b/);
  });
});
