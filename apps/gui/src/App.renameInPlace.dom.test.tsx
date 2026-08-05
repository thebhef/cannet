// @vitest-environment jsdom
//
// `panel.rename` renames in place, two ways. The command collects the
// new name in the palette's own second stage (ADR 0037 — the command
// stays the entry point, the palette stays open and becomes a text
// input), and a tab can be renamed directly by double-clicking it.
// Both write the model-owned name (ADR 0019); neither sends the user
// off to the project panel. Real App, real dockview, Tauri IPC mocked
// (same harness as the other App dom tests).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// ---- Tauri IPC mocks (same shape as App.viewActions.dom.test) ----

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
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

import { StrictMode } from "react";

import { App } from "./App";
import { hydrateState } from "./hostState";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/// The dockview tab element whose visible title matches.
function findTab(title: string): HTMLElement {
  const tab = Array.from(document.querySelectorAll<HTMLElement>(".dv-tab")).find(
    (t) => t.textContent === title,
  );
  if (!tab) throw new Error(`tab "${title}" not found`);
  return tab;
}

/// The tab currently showing a rename input, if any.
function renameInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(".dv-tab input.dock-tab-rename-input");
}

/// The palette's second-stage text input, if the palette is asking for
/// one.
function promptInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(".palette-prompt input.palette-input");
}

/// The project panel's inline-rename input for the seeded trace element
/// — the other view onto the same model-owned name.
function projectPanelNameInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('input[aria-label^="element "]');
  if (!el) throw new Error("project panel element-name input not found");
  return el;
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  // Reset hostState's module-level cache — the layout persisted by one
  // test must not be restored into the next test's mount.
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountApp() {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
}

/// Focus the seeded trace panel, then run `panel.rename` the way a user
/// reaches it: the command palette (Mod+Shift+P), pick the entry.
async function focusTraceAndRunRename() {
  await act(async () => {
    fireEvent.pointerDown(findTab("Trace 1"));
    fireEvent.click(findTab("Trace 1"));
  });
  await act(async () => {
    fireEvent.keyDown(document.body, { key: "P", ctrlKey: true, shiftKey: true });
  });
  const item = await waitFor(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(".palette-item")).find(
      (li) => li.textContent?.startsWith("Rename panel"),
    );
    if (!el) throw new Error("Rename panel… not offered by the palette");
    return el;
  });
  await act(async () => {
    fireEvent.click(item);
  });
}

describe("panel.rename", () => {
  it("collects the name in the palette's second stage and commits it on Enter", async () => {
    await mountApp();
    await focusTraceAndRunRename();

    // The palette stayed open and became a text input seeded with the
    // focused panel's name — no command list any more.
    const input = await waitFor(() => {
      const el = promptInput();
      if (!el) throw new Error("palette did not enter its second stage");
      return el;
    });
    expect(input.value).toBe("Trace 1");
    expect(document.querySelector(".palette-item")).toBeNull();
    // The user was left where they were: the trace panel's group is
    // still the active one, and the project panel was not brought up.
    const activeGroup = document.querySelector(".dv-active-group");
    expect(activeGroup?.contains(findTab("Trace 1"))).toBe(true);

    await act(async () => {
      fireEvent.change(input, { target: { value: "Cabin sweep" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    // The palette is gone, the tab carries the new title, and the model
    // (as seen through the project panel) took the rename.
    await waitFor(() => {
      if (promptInput()) throw new Error("palette still asking");
      findTab("Cabin sweep");
    });
    expect(projectPanelNameInput().value).toBe("Cabin sweep");
  }, 30_000);

  it("Escape leaves the name alone", async () => {
    await mountApp();
    await focusTraceAndRunRename();

    const input = await waitFor(() => {
      const el = promptInput();
      if (!el) throw new Error("palette did not enter its second stage");
      return el;
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: "Discarded" } });
      fireEvent.keyDown(input, { key: "Escape" });
    });

    await waitFor(() => {
      if (promptInput()) throw new Error("palette still asking");
      findTab("Trace 1");
    });
    expect(projectPanelNameInput().value).toBe("Trace 1");
  }, 30_000);
});

describe("tab rename", () => {
  it("double-clicking a tab edits it in place and commits on Enter", async () => {
    await mountApp();

    // A real double-click lands on the tab's content and bubbles; fire
    // it there rather than on dockview's outer `.dv-tab` wrapper.
    await act(async () => {
      fireEvent.doubleClick(findTab("Trace 1").querySelector(".dv-default-tab-content")!);
    });
    const input = await waitFor(() => {
      const el = renameInput();
      if (!el) throw new Error("tab did not enter rename mode");
      return el;
    });
    expect(input.value).toBe("Trace 1");

    await act(async () => {
      fireEvent.change(input, { target: { value: "Cabin sweep" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => {
      if (renameInput()) throw new Error("still editing");
      findTab("Cabin sweep");
    });
    expect(projectPanelNameInput().value).toBe("Cabin sweep");
  }, 30_000);
});
