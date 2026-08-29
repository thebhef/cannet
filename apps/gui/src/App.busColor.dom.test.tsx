// @vitest-environment jsdom
//
// Bus colors persist only when the user picks one. A bus added through
// the project panel stores nothing: it renders the theme's bus wheel
// entry for its list position, and the project written to the host
// carries no `color` field for it. Picking a color in the row's swatch
// is what makes it project data. Drives the REAL App through the
// toolbar, with the Tauri IPC mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (cmd: string, _args?: unknown) => {
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
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

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
  save: vi.fn(async () => "C:/tmp/colors.cannet_prj"),
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
import { hydrateState } from "./hostState";
import { defaultBusColor } from "./busColor";
import type { Bus } from "./types";
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

function busSwatches(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(".project-bus-color"));
}

/// The bus list of the last project handed to the host.
async function saveAndReadBuses(): Promise<Bus[]> {
  const before = invokeMock.mock.calls.length;
  await act(async () => {
    fireEvent.click(toolbarChip("Save"));
  });
  await waitFor(() => {
    const call = invokeMock.mock.calls
      .slice(before)
      .find((c) => c[0] === "save_project" || c[0] === "save_project_as");
    if (!call) throw new Error("project not saved yet");
  });
  const call = invokeMock.mock.calls
    .slice(before)
    .reverse()
    .find((c) => c[0] === "save_project" || c[0] === "save_project_as");
  const args = call?.[1] as { project: { buses: Bus[] } };
  return args.project.buses;
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeMock.mockClear();
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("bus colors persist only when customized", () => {
  it("stores no color for an added bus, and derives one to render it", async () => {
    render(<App />);
    await waitFor(() => {
      if (!document.querySelector(".trace-panel .trace-status"))
        throw new Error("seeded layout not mounted yet");
    });

    await act(async () => {
      fireEvent.click(toolbarChip("Project"));
    });
    await waitFor(() => {
      if (!document.querySelector(".project-panel")) throw new Error("no project panel yet");
    });

    await act(async () => {
      fireEvent.click(findButton("Add bus"));
    });
    await waitFor(() => {
      if (busSwatches().length !== 1) throw new Error("bus row not rendered yet");
    });

    // Rendered from the theme's bus wheel by list position …
    expect(busSwatches()[0].value).toBe(defaultBusColor(0));
    // … and nothing about it is project data.
    const saved = await saveAndReadBuses();
    expect(saved).toHaveLength(1);
    expect(saved[0].color).toBeUndefined();

    // An explicit pick is a user choice, and does persist.
    await act(async () => {
      fireEvent.change(busSwatches()[0], { target: { value: "#123456" } });
    });
    expect(busSwatches()[0].value).toBe("#123456");
    const resaved = await saveAndReadBuses();
    expect(resaved[0].color).toBe("#123456");
  }, 30_000);
});
