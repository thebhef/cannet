// @vitest-environment jsdom
//
// "Import trace…" (the single BLF+MDF entry point) and the unified
// "Recent captures" list it feeds. Pins the behavior the merge must
// preserve: a picked or recalled path routes to its format's own
// scan/import commands purely by extension (never by sniffing the
// file), a successful MDF import is recorded in the recents list the
// same way a BLF import always was, the list renders both kinds
// together, and a recents entry from before the merge (a bare `.blf`
// path — the storage shape never changed) still opens.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
const stateWrites: unknown[] = [];
// What the mocked open dialog hands back — set per test before the click.
let dialogPath: string | null = null;
// Seeded into `get_state`'s `recent_blfs` for tests that pre-populate
// the recents list.
let seededRecents: string[] = [];

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
          recent_blfs: seededRecents,
          recent_commands: [],
          blf_channel_maps: {},
        };
      case "set_state":
        stateWrites.push(args?.state);
        return null;
      case "clear_trace_store":
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
      case "scan_mdf_channels":
        return {
          channels: [0],
          frame_count: 1,
          first_timestamp_ns: 1_000_000_000,
          last_timestamp_ns: 1_000_000_000,
          start_unix_nanos: 1_700_000_000_000_000_000,
          markers: [],
          unfinalized: false,
          signal_group_count: 0,
          signal_count: 0,
          decoded_message_groups: [],
        };
      case "open_log":
        return { blf_path: String(args?.blfPath) };
      case "import_mdf":
        return { mdf_path: String(args?.mdfPath) };
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

const dialogOpenCalls: unknown[] = [];
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async (opts: unknown) => {
    dialogOpenCalls.push(opts);
    return dialogPath;
  }),
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

async function mountAndSeed() {
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  listeners.clear();
  invokeCalls.length = 0;
  stateWrites.length = 0;
  dialogOpenCalls.length = 0;
  dialogPath = null;
  seededRecents = [];
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Import trace — dialog routing by extension", () => {
  it("routes a picked .blf path to the BLF scan", async () => {
    dialogPath = "/logs/one.blf";
    await mountAndSeed();
    await act(async () => {
      fireEvent.click(toolbarChip("Import"));
    });
    await waitFor(() => findButton("Open"));
    expect(invokeCalls.some((c) => c.cmd === "scan_blf_channels")).toBe(true);
    expect(invokeCalls.some((c) => c.cmd === "scan_mdf_channels")).toBe(false);
  });

  it("routes a picked .mf4 path to the MDF scan", async () => {
    dialogPath = "/logs/one.mf4";
    await mountAndSeed();
    await act(async () => {
      fireEvent.click(toolbarChip("Import"));
    });
    await waitFor(() => findButton("Open"));
    expect(invokeCalls.some((c) => c.cmd === "scan_mdf_channels")).toBe(true);
    expect(invokeCalls.some((c) => c.cmd === "scan_blf_channels")).toBe(false);
  });

  it("offers one unified filter list, not per-format dialogs", async () => {
    dialogPath = "/logs/one.blf";
    await mountAndSeed();
    await act(async () => {
      fireEvent.click(toolbarChip("Import"));
    });
    await waitFor(() => expect(dialogOpenCalls.length).toBe(1));
    const opts = dialogOpenCalls[0] as { filters: { name: string; extensions: string[] }[] };
    const names = opts.filters.map((f) => f.name);
    expect(names).toContain("All supported traces");
    expect(names).toContain("Vector BLF");
    expect(names).toContain("ASAM MDF");
  });
});

describe("Recent captures", () => {
  it("records a successful MDF import the same way a BLF import always was", async () => {
    dialogPath = "/logs/fresh.mf4";
    await mountAndSeed();
    await act(async () => {
      fireEvent.click(toolbarChip("Import"));
    });
    await waitFor(() => findButton("Open"));
    await act(async () => {
      fireEvent.click(findButton("Open"));
    });
    await waitFor(() => {
      if (!invokeCalls.some((c) => c.cmd === "import_mdf")) throw new Error("import_mdf not called");
    });
    await waitFor(() => {
      const recorded = stateWrites.some((w) =>
        (w as { recent_blfs?: string[] }).recent_blfs?.includes("/logs/fresh.mf4"),
      );
      if (!recorded) throw new Error("MDF path never landed in recent_blfs");
    });
  });

  it("renders BLF and MDF entries together, and opens each by its own extension", async () => {
    seededRecents = ["/old/legacy.blf", "/new/fresh.mf4"];
    await hydrateState();
    await mountAndSeed();

    const summary = document.querySelector(".recent-captures > button");
    expect(summary?.getAttribute("aria-label")).toBe("Recent captures (2)");

    await act(async () => {
      fireEvent.click(summary as Element);
    });
    const items = Array.from(document.querySelectorAll(".recent-captures-menu button")).map(
      (b) => b.textContent,
    );
    expect(items).toEqual(["/old/legacy.blf", "/new/fresh.mf4"]);

    // Opening the MDF entry routes to the MDF scan, skips the dialog.
    const mdfEntry = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".recent-captures-menu button"),
    ).find((b) => b.textContent === "/new/fresh.mf4");
    await act(async () => {
      fireEvent.click(mdfEntry as HTMLButtonElement);
    });
    await waitFor(() => findButton("Open"));
    expect(invokeCalls.some((c) => c.cmd === "scan_mdf_channels")).toBe(true);
    expect(dialogOpenCalls.length).toBe(0);
  });

  it("still opens a pre-merge recents entry (a bare .blf path) with no migration", async () => {
    // The storage shape never changed — a path recorded before MDF
    // recents existed is indistinguishable from one recorded after.
    seededRecents = ["/old/legacy.blf"];
    await hydrateState();
    await mountAndSeed();
    const summary = document.querySelector(".recent-captures > button");
    await act(async () => {
      fireEvent.click(summary as Element);
    });
    const entry = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".recent-captures-menu button"),
    ).find((b) => b.textContent === "/old/legacy.blf");
    await act(async () => {
      fireEvent.click(entry as HTMLButtonElement);
    });
    await waitFor(() => findButton("Open"));
    expect(invokeCalls.some((c) => c.cmd === "scan_blf_channels")).toBe(true);
    expect(dialogOpenCalls.length).toBe(0);
  });
});

describe("Recent captures — dismissal like any other transient popup (click-outside, Escape)", () => {
  it("closes on an outside click, without opening anything", async () => {
    seededRecents = ["/old/legacy.blf"];
    await hydrateState();
    await mountAndSeed();
    const trigger = document.querySelector<HTMLButtonElement>(".recent-captures > button")!;
    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(document.querySelector(".recent-captures-menu")).not.toBeNull();

    await act(async () => {
      fireEvent.mouseDown(document.body);
    });
    expect(document.querySelector(".recent-captures-menu")).toBeNull();
    expect(invokeCalls.some((c) => c.cmd === "scan_blf_channels")).toBe(false);
  });

  it("closes on Escape, without opening anything", async () => {
    seededRecents = ["/old/legacy.blf"];
    await hydrateState();
    await mountAndSeed();
    const trigger = document.querySelector<HTMLButtonElement>(".recent-captures > button")!;
    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(document.querySelector(".recent-captures-menu")).not.toBeNull();

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(document.querySelector(".recent-captures-menu")).toBeNull();
    expect(invokeCalls.some((c) => c.cmd === "scan_blf_channels")).toBe(false);
  });

  it("a mousedown inside the menu does not dismiss it", async () => {
    seededRecents = ["/old/legacy.blf"];
    await hydrateState();
    await mountAndSeed();
    const trigger = document.querySelector<HTMLButtonElement>(".recent-captures > button")!;
    await act(async () => {
      fireEvent.click(trigger);
    });
    const entry = document.querySelector<HTMLButtonElement>(".recent-captures-menu button")!;
    await act(async () => {
      fireEvent.mouseDown(entry);
    });
    expect(document.querySelector(".recent-captures-menu")).not.toBeNull();
  });
});

describe("Recent captures — reachable from the command palette", () => {
  async function openCommandPalette() {
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "P",
        ctrlKey: true,
        shiftKey: true,
      });
    });
  }
  function paletteLabels(): string[] {
    return Array.from(document.querySelectorAll(".palette-item-label")).map(
      (el) => el.textContent ?? "",
    );
  }

  it("lists each recent capture as its own command", async () => {
    seededRecents = ["/old/legacy.blf", "/new/fresh.mf4"];
    await hydrateState();
    await mountAndSeed();
    await openCommandPalette();
    const labels = paletteLabels();
    expect(labels).toContain("Open recent: legacy.blf");
    expect(labels).toContain("Open recent: fresh.mf4");
  });

  it("finds a recent entry by a fragment of its full path, not just its filename", async () => {
    seededRecents = ["/old/legacy.blf", "/new/fresh.mf4"];
    await hydrateState();
    await mountAndSeed();
    await openCommandPalette();
    const input = document.querySelector<HTMLInputElement>(".palette input.palette-input")!;
    await act(async () => {
      fireEvent.change(input, { target: { value: "old" } });
    });
    const labels = paletteLabels();
    expect(labels).toContain("Open recent: legacy.blf");
    expect(labels).not.toContain("Open recent: fresh.mf4");
  });

  it("selecting a recent entry routes through the same open call the button uses", async () => {
    seededRecents = ["/old/legacy.blf"];
    await hydrateState();
    await mountAndSeed();
    await openCommandPalette();
    const input = document.querySelector<HTMLInputElement>(".palette input.palette-input")!;
    await act(async () => {
      fireEvent.change(input, { target: { value: "legacy" } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => findButton("Open"));
    expect(
      invokeCalls.some(
        (c) => c.cmd === "scan_blf_channels" && c.args.blfPath === "/old/legacy.blf",
      ),
    ).toBe(true);
    expect(dialogOpenCalls.length).toBe(0);
  });

  it("an empty recents list contributes no commands", async () => {
    seededRecents = [];
    await hydrateState();
    await mountAndSeed();
    await openCommandPalette();
    expect(paletteLabels().some((l) => l.startsWith("Open recent:"))).toBe(false);
  });
});
