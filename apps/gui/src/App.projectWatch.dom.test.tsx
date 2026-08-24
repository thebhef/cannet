// @vitest-environment jsdom
//
// The project file changed on disk (ADR 0053 §1). The host watches the
// `.cannet_prj` and announces `project-changed`; it applies nothing,
// because whether applying is safe reads two facts the frontend holds —
// whether the in-memory project is dirty, and whether a session is up.
//
// Applying is `open_project`, the existing open path, which re-roots the
// session (ADR 0042) and drops the connection. So:
//
// - clean, nothing connected → apply silently, no interruption;
// - anything of the user's at risk → a dismissible notice carrying an
//   explicit Reload, which is the only way it is applied.
//
// Boots through the last-project pointer, which is the cheapest way to
// reach a *clean* open project (opening one is what clears the dirty
// bit); "Add trace" is the layout change that dirties it again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
function emitTauri(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h({ payload });
}

const PROJECT = "C:/fake/last.cannet_prj";
const SERVER = "1.2.3.4:9000";
const openProjectCalls: string[] = [];
/// Per-test knobs (the mock is hoisted, so config rides in mutable state).
const knobs = {
  /// A bus bound to a remote server, so the test can put a session up.
  bound: false,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
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
        openProjectCalls.push(String(args?.path));
        return {
          schema_version: 7,
          buses: knobs.bound ? [{ id: "b1", name: "B1" }] : [],
          interface_bindings: knobs.bound
            ? [{ kind: "remote", server: SERVER, interface: "can0", bus_id: "b1" }]
            : [],
          dbcs: [],
          local_virtual_buses: [],
          elements: [],
          layout: null,
        };
      case "connect_remote_server":
        return { address: SERVER, interfaces: [], subscriptions: [] };
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
import { addPanelChip, toolbarChip } from "./toolbarTestKit";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/// Render the app and let the boot open (an async IIFE behind
/// dockview's `onReady`) settle, leaving a clean open project.
async function bootWithProject(): Promise<void> {
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  await waitFor(() => expect(openProjectCalls).toEqual([PROJECT]));
  openProjectCalls.length = 0;
}

/// The connection control: a status chip in the bar rather than a
/// toolbar button, so it is found by its own class and its state reads
/// off its accessible name.
function connectionChip(): HTMLButtonElement {
  const chip = document.querySelector<HTMLButtonElement>("button.status-chip--connection");
  if (!chip) throw new Error("no connection chip");
  return chip;
}

/// A button outside the toolbar; the toolbar's own controls are chips
/// reached through `toolbarChip`.
function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .filter((b) => b.closest(".toolbar") === null)
    .find((b) => b.textContent === label);
}

/// A layout change after the boot has settled — the app's own route to
/// unsaved changes, no test-only hatch into the dirty flag.
async function dirtyTheProject(): Promise<void> {
  const btn = addPanelChip("Trace");
  await act(async () => {
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function announceDiskChange(): Promise<void> {
  await act(async () => {
    emitTauri("project-changed", PROJECT);
    await new Promise((r) => setTimeout(r, 50));
  });
}

/// Open the command palette, the way Close project is reached.
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

/// Bring a session up through the toolbar's own Connect, so the state
/// the policy reads is the state a real connect produces.
async function connect(): Promise<void> {
  const btn = connectionChip();
  await act(async () => {
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 50));
  });
  // The chip is the control and the readout at once: once a session is
  // up, pressing it disconnects, and its accessible name says so.
  await waitFor(() =>
    expect(connectionChip().getAttribute("aria-label")).toMatch(/— Disconnect$/),
  );
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  knobs.bound = false;
  openProjectCalls.length = 0;
  await hydrateState();
  await hydrateSettings();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the project file changing on disk", () => {
  it("applies silently when the project is clean and nothing is connected", async () => {
    await bootWithProject();
    await announceDiskChange();
    expect(openProjectCalls).toEqual([PROJECT]);
    expect(document.body.textContent).not.toContain("changed on disk");
  });

  it("notifies instead of applying when the project has unsaved changes", async () => {
    await bootWithProject();
    await dirtyTheProject();
    await announceDiskChange();
    // Nothing applied: the user's edits are still theirs.
    expect(openProjectCalls).toEqual([]);
    expect(document.body.textContent).toContain("Project changed on disk");
    expect(button("Reload")).toBeInTheDocument();
  });

  // ADR 0053 §1 states this as a precondition, not a weight against
  // dirtiness: the reload re-roots the session (ADR 0042) and drops the
  // connection, so a *clean* project reloaded under a live session still
  // ends the capture the user is watching.
  it("notifies rather than applying while a session is up, clean or not", async () => {
    knobs.bound = true;
    await bootWithProject();
    await connect();
    await announceDiskChange();
    expect(openProjectCalls).toEqual([]);
    expect(document.body.textContent).toContain("Project changed on disk");
  });

  it("applies on the notice's explicit Reload, and the notice goes", async () => {
    await bootWithProject();
    await dirtyTheProject();
    await announceDiskChange();
    const reload = button("Reload");
    if (!reload) throw new Error("no Reload action on the notice");
    await act(async () => {
      fireEvent.click(reload);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(openProjectCalls).toEqual([PROJECT]);
    expect(document.body.textContent).not.toContain("Project changed on disk");
  });

  // A notice refers to something. When that something is gone — saved
  // over, or closed — the statement is no longer true and its Reload
  // would act on a file the user has already dealt with. So the notice
  // goes with it, rather than sitting there until someone dismisses it.
  it("goes away when the project is saved over the file's new contents", async () => {
    await bootWithProject();
    await dirtyTheProject();
    await announceDiskChange();
    expect(document.body.textContent).toContain("Project changed on disk");
    const saveBtn = toolbarChip("Save");
    await act(async () => {
      fireEvent.click(saveBtn);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.body.textContent).not.toContain("Project changed on disk");
  });

  it("goes away when the project is closed", async () => {
    await bootWithProject();
    await dirtyTheProject();
    await announceDiskChange();
    expect(document.body.textContent).toContain("Project changed on disk");
    await runCommand("Close project");
    expect(document.body.textContent).not.toContain("Project changed on disk");
  });

  it("dismisses without applying", async () => {
    await bootWithProject();
    await dirtyTheProject();
    await announceDiskChange();
    const dismiss = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss the project-changed notice"]',
    );
    if (!dismiss) throw new Error("no dismiss action on the notice");
    await act(async () => {
      fireEvent.click(dismiss);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(openProjectCalls).toEqual([]);
    expect(document.body.textContent).not.toContain("Project changed on disk");
  });
});
