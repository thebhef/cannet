// @vitest-environment jsdom
//
// "Clear project colors" (palette command, behind a confirm dialog).
// Its scope is the whole point of the test: it discards the two
// *cosmetic identity* populations — each bus's `color` field and the
// project's `signal_colors` overrides — and leaves color-map rules
// alone, because a rule says what a value *means* and is authored data.
// Drives the REAL App: open a project through the mocked host, run the
// command through the real palette chord, then save and inspect the
// project handed back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

/// A project with both color populations filled in, plus a color-map
/// element whose rules must survive.
const OPEN_PROJECT = {
  schema_version: 7,
  layout: { grid: {}, panels: {} },
  elements: [
    {
      kind: "colormap",
      id: "cm1",
      name: "Gear",
      busId: null,
      messageId: 512,
      extended: false,
      signalName: "GearState",
      rules: [
        { min: 1, max: 1, color: "#aa0000" },
        { min: 2, max: 2, color: "#00bb00" },
      ],
    },
  ],
  buses: [
    { id: "b1", name: "B1", color: "#111111" },
    { id: "b2", name: "B2", color: "#222222" },
    // Already uncustomized: the command must leave it that way rather
    // than write a derived color in.
    { id: "b3", name: "B3" },
  ],
  interface_bindings: [],
  dbcs: [],
  remote_address: null,
  local_virtual_buses: [],
  signal_colors: { "b1|s:256:EngineSpeed": "#abcdef", "b2|s:256:EngineTemp": "#fedcba" },
};

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
    switch (cmd) {
      case "open_project":
        return OPEN_PROJECT;
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
  open: vi.fn(async () => "C:/tmp/colors.cannet_prj"),
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
import type { Bus, ColorRule, Project, ProjectElement } from "./types";

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

async function mountAndOpen(): Promise<void> {
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
  await act(async () => {
    fireEvent.click(findButton("Open…"));
  });
  await waitFor(() => {
    if (!invokeMock.mock.calls.some((c) => c[0] === "open_project"))
      throw new Error("project not opened yet");
  });
}

/// Run the command the way a user reaches it: the palette chord, then
/// the entry. Returns once the confirmation is up.
async function runClearColorsCommand(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document.body, { key: "P", ctrlKey: true, shiftKey: true });
  });
  const item = await waitFor(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(".palette-item")).find(
      (li) => li.textContent?.startsWith("Clear project colors"),
    );
    if (!el) throw new Error("the palette does not offer Clear project colors…");
    return el;
  });
  await act(async () => {
    fireEvent.click(item);
  });
  await waitFor(() => {
    if (!document.querySelector('[role="dialog"]')) throw new Error("no confirmation yet");
  });
}

/// The project the host was last handed.
async function saveAndReadProject(): Promise<Project> {
  const before = invokeMock.mock.calls.length;
  await act(async () => {
    fireEvent.click(findButton("Save project"));
  });
  const isSave = (c: unknown[]) => c[0] === "save_project" || c[0] === "save_project_as";
  await waitFor(() => {
    if (!invokeMock.mock.calls.slice(before).some(isSave))
      throw new Error("project not saved yet");
  });
  const call = invokeMock.mock.calls.slice(before).reverse().find(isSave);
  return (call?.[1] as { project: Project }).project;
}

/// `Project.elements` is host-opaque (`unknown[]`), so narrow it here.
function colormapRules(project: Project): ColorRule[] {
  const el = (project.elements as ProjectElement[]).find((e) => e.kind === "colormap");
  if (el == null || el.kind !== "colormap") throw new Error("the colormap element is gone");
  return el.rules;
}

function busColors(project: Project): (string | null | undefined)[] {
  return (project.buses as Bus[]).map((b) => b.color);
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

describe("project.clearColors", () => {
  it("clears both stored color populations and spares the color maps", async () => {
    await mountAndOpen();
    // The project arrived with colors on it.
    const opened = await saveAndReadProject();
    expect(busColors(opened)).toEqual(["#111111", "#222222", undefined]);
    expect(Object.keys(opened.signal_colors ?? {})).toHaveLength(2);

    await runClearColorsCommand();
    await act(async () => {
      fireEvent.click(findButton("Clear colors"));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const cleared = await saveAndReadProject();
    // Every bus loses its `color` key outright — not reset to a derived
    // value, which would store what the theme already derives.
    expect(busColors(cleared)).toEqual([undefined, undefined, undefined]);
    expect(cleared.buses.every((b) => !("color" in b))).toBe(true);
    expect(cleared.signal_colors).toEqual({});
    // Authored data, untouched.
    expect(colormapRules(cleared)).toEqual([
      { min: 1, max: 1, color: "#aa0000" },
      { min: 2, max: 2, color: "#00bb00" },
    ]);
  }, 30_000);

  it("does nothing when the confirmation is cancelled", async () => {
    await mountAndOpen();
    await runClearColorsCommand();
    await act(async () => {
      fireEvent.click(findButton("Cancel"));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const after = await saveAndReadProject();
    expect(busColors(after)).toEqual(["#111111", "#222222", undefined]);
    expect(after.signal_colors).toEqual(OPEN_PROJECT.signal_colors);
  }, 30_000);

  it("escapes out of the confirmation without clearing", async () => {
    await mountAndOpen();
    await runClearColorsCommand();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const after = await saveAndReadProject();
    expect(busColors(after)).toEqual(["#111111", "#222222", undefined]);
  }, 30_000);
});
