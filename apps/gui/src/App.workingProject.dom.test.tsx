// @vitest-environment jsdom
//
// The working project — the project as the user has it right now, saved
// or not — is pushed to the host with its dirty flag on every project
// edit, debounced, so the host holds it (`working_project.rs`) and a
// frontend reload need not revert to the file. These pin the push's
// shape against the real App:
//
// - nothing is pushed before the boot has applied a project, so an
//   empty default document never lands over the host's copy;
// - an edit pushes the document and dirty;
// - a trace-window mirror update or a live count tick pushes nothing,
//   and an unchanged document is not pushed twice;
// - `pagehide` flushes a pending push, so a reload right after an edit
//   does not lose it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
function emitTauri(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h({ payload });
}

const PROJECT = "C:/fake/working.cannet_prj";
/// Every `set_working_project` the App sent, in order.
const pushes: Array<{ document: Record<string, unknown>; dirty: boolean }> = [];
/// The order pushes and `close_project` reached the host in.
const order: string[] = [];
/// Holds the boot's `open_project` answer until the test releases it.
let releaseOpen: () => void = () => {};
let openGate: Promise<void> = Promise.resolve();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "close_project":
        order.push("close");
        return null;
      case "set_working_project":
        order.push("push");
        pushes.push({
          document: args?.document as Record<string, unknown>,
          dirty: args?.dirty as boolean,
        });
        return null;
      case "diag_autostart":
        return null;
      case "get_state":
        return {
          last_project: PROJECT,
          layout: null,
          recent_blfs: [],
          recent_commands: [],
          blf_channel_maps: {},
        };
      case "get_settings":
        return { reopen_last_project: true };
      case "open_project":
        await openGate;
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
import { addPanelChip } from "./toolbarTestKit";
import { WORKING_PROJECT_PUSH_DELAY_MS } from "./workingProject";
import type { TraceGrew } from "./types";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/// Longer than the push debounce, so a scheduled push has gone.
const PAST_DEBOUNCE_MS = WORKING_PROJECT_PUSH_DELAY_MS + 200;

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function busNames(push: { document: Record<string, unknown> }): string[] {
  return (push.document.buses as Array<{ name: string }>).map((b) => b.name);
}

function elementIds(push: { document: Record<string, unknown> }): string[] {
  return (push.document.elements as Array<{ id: string }>).map((e) => e.id);
}

/// Render, release the boot's open, and wait for the push that follows
/// the applied project to settle.
async function bootWithProject(): Promise<void> {
  render(<App />);
  releaseOpen();
  await waitFor(() => expect(pushes.length).toBeGreaterThan(0), { timeout: 3000 });
  await wait(PAST_DEBOUNCE_MS);
}

/// Run a command palette entry.
async function runCommand(label: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "P",
      ctrlKey: true,
      shiftKey: true,
    });
  });
  const input = document.querySelector<HTMLInputElement>(".palette input.palette-input");
  if (!input) throw new Error("no command palette");
  await act(async () => {
    fireEvent.change(input, { target: { value: label } });
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 50));
  });
}

/// A layout change — the app's own route to an edit.
async function addTracePanel(): Promise<void> {
  await act(async () => {
    fireEvent.click(addPanelChip("Trace"));
  });
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
    tail: [],
  };
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  pushes.length = 0;
  order.length = 0;
  openGate = new Promise<void>((r) => {
    releaseOpen = r;
  });
  await hydrateState();
  await hydrateSettings();
});

afterEach(() => {
  releaseOpen();
  cleanup();
  vi.unstubAllGlobals();
});

describe("the working project push", () => {
  it("sends nothing before the boot has applied the project, then the applied project, clean", async () => {
    render(<App />);
    // The boot's open is held: the default seeded layout and empty
    // registry are all the App has. None of it may reach the host.
    await wait(PAST_DEBOUNCE_MS * 2);
    expect(pushes).toEqual([]);
    releaseOpen();
    await waitFor(() => expect(pushes.length).toBeGreaterThan(0), { timeout: 3000 });
    await wait(PAST_DEBOUNCE_MS);
    // Every push carries the applied project, never the seeded default.
    for (const p of pushes) expect(busNames(p)).toEqual(["Opened Bus"]);
    expect(pushes[pushes.length - 1].dirty).toBe(false);
  });

  it("an edit pushes the document and the dirty flag, once per debounce", async () => {
    await bootWithProject();
    const before = pushes.length;
    const idsBefore = elementIds(pushes[before - 1]);
    await addTracePanel();
    await wait(PAST_DEBOUNCE_MS);
    const after = pushes.slice(before);
    expect(after.length).toBe(1);
    expect(after[0].dirty).toBe(true);
    expect(elementIds(after[0]).length).toBe(idsBefore.length + 1);
  });

  it("a trace-window change, a live count tick, or an unchanged document pushes nothing", async () => {
    await bootWithProject();
    // An element, so the mirror has a window to move.
    await addTracePanel();
    await wait(PAST_DEBOUNCE_MS);
    const before = pushes.length;
    const ids = elementIds(pushes[before - 1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const end of [null, 500]) {
      // eslint-disable-next-line no-await-in-loop -- sequential mirror updates on purpose
      await act(async () => {
        emitTauri(
          "trace-windows-changed",
          Object.fromEntries(ids.map((id) => [id, { start: 0, end, isPaused: false }])),
        );
      });
    }
    for (let tick = 1; tick <= 3; tick++) {
      // eslint-disable-next-line no-await-in-loop -- sequential ticks on purpose
      await act(async () => {
        emitTauri("trace-grew", grew(tick * 1000));
      });
    }
    await wait(PAST_DEBOUNCE_MS);
    expect(pushes.slice(before)).toEqual([]);
  });

  it("pagehide flushes a pending push at once", async () => {
    await bootWithProject();
    const before = pushes.length;
    await addTracePanel();
    // Inside the debounce: nothing sent yet.
    expect(pushes.length).toBe(before);
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(pushes.length).toBe(before + 1);
    expect(pushes[before].dirty).toBe(true);
    // The flushed push is not sent again when the debounce would have
    // fired.
    await wait(PAST_DEBOUNCE_MS);
    expect(pushes.length).toBe(before + 1);
  });

  // `close_project` empties the host's copy; the unsaved project New
  // seeds must reach the host after it, every time.
  it("New project pushes the unsaved project after the host closed the old one, every time", async () => {
    await bootWithProject();
    for (let round = 0; round < 2; round++) {
      order.length = 0;
      // eslint-disable-next-line no-await-in-loop -- one New after another on purpose
      await runCommand("New project");
      // eslint-disable-next-line no-await-in-loop -- as above
      await wait(PAST_DEBOUNCE_MS);
      expect(order[0]).toBe("close");
      expect(order.slice(1)).toContain("push");
      const last = pushes[pushes.length - 1];
      // (Dirty either way: seeding the default layout is an edit, so a
      // fresh project is born unsaved — `App.windowTitle.dom.test.tsx`.)
      expect(busNames(last)).toEqual(["Bus 1"]);
    }
  });
});
