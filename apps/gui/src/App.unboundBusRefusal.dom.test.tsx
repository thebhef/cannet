// @vitest-environment jsdom
//
// Connect refuses when any project bus carries no interface binding —
// even a bus that isn't the only one, so a silently-dead bus doesn't
// slip through a project where some other bus does have a binding.
// And a new project starts with one bus, named the way the project
// panel's own Add bus control already names them.
//
// These drive the real App: the guard lives in `handleConnect`, and
// the point is that it's actually wired in, not just that the pure
// function it calls (`unboundBusError`, pinned in `unboundBus.test.ts`)
// reads right in isolation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
// Project handed back by `open_project`.
let openProjectResult: Record<string, unknown> = {};
// The host's per-bus connection map, as `get_connection_states` answers
// it — static per test rather than simulated through a real connect
// round-trip, the same simplification `ProjectPanel.connectionState.
// dom.test.tsx` uses.
let connectionStatesResult: Record<string, unknown> = {};

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
      case "open_project":
        return openProjectResult;
      case "app_version":
        return "0.0.0-test";
      case "get_sidecar_status":
        return { phase: "offline", address: null };
      case "get_connection_states":
        return connectionStatesResult;
      case "connect_remote_server":
        return { address: String(args?.address), interfaces: [], subscriptions: [] };
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
  open: vi.fn(async () => "/bench.cannet"),
  save: vi.fn(async () => null),
}));

// uPlot touches `matchMedia` at import time, which jsdom lacks.
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

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/// The connection control: a status chip in the bar rather than a
/// toolbar button, so it is found by its own class and its state reads
/// off its accessible name.
function connectionChip(): HTMLButtonElement {
  const chip = document.querySelector<HTMLButtonElement>("button.status-chip--connection");
  if (!chip) throw new Error("no connection chip");
  return chip;
}

/// A button outside the toolbar. The toolbar's own controls are chips
/// with short labels, so they are excluded here.
function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .filter((b) => b.closest(".toolbar") === null)
    .find((b) => b.textContent === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
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

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeCalls.length = 0;
  openProjectResult = {};
  connectionStatesResult = {};
  // `hostState`'s cache is a module-global (ADR 0032/0034): a prior
  // test's real Open sets `last_project` in it, and a later test would
  // otherwise auto-reopen that stale path — via `get_state`, which
  // this file doesn't mock, so it resets to empty.
  await hydrateState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Connect refuses an unbound bus", () => {
  it("blocks the whole connect and names the unbound bus, leaving the bound one out of it", async () => {
    openProjectResult = {
      schema_version: 4,
      project_id: "p1",
      layout: { grid: {}, panels: {} },
      elements: [],
      buses: [
        { id: "b1", name: "Chassis" },
        { id: "b2", name: "Body" },
      ],
      interface_bindings: [{ server: "127.0.0.1:9", interface: "if0", bus_id: "b1" }],
      dbcs: [],
      remote_address: null,
      local_virtual_buses: [],
      signal_colors: {},
    };
    await mountAndSeed();
    await act(async () => {
      fireEvent.click(findButton("Open…"));
    });
    // Chassis carries a binding, so the chip is live — this is the gap
    // the old all-or-nothing `interfaceBindings.length === 0` guard
    // missed: Body has no binding at all, and nothing said so.
    await waitFor(() => {
      if (connectionChip().disabled) throw new Error("Connect still disabled");
    });

    const callsBefore = invokeCalls.length;
    await act(async () => {
      fireEvent.click(connectionChip());
    });

    await waitFor(() => {
      if (!statusText().includes("Body")) throw new Error("unbound bus not named");
    });
    expect(statusText()).not.toContain("Chassis");
    const connectCalls = invokeCalls
      .slice(callsBefore)
      .filter((c) => c.cmd === "connect_remote_server");
    expect(connectCalls).toHaveLength(0);

    // Every attempt is loud (owner, 2026-08-28): the refusal lands in
    // the System Messages log too, once per press — the status label
    // alone cannot show that a second identical refusal happened.
    const refusalLogs = () =>
      invokeCalls
        .slice(callsBefore)
        .filter(
          (c) =>
            c.cmd === "gui_emit_system_log" &&
            (c.args as { level: string; message: string }).level === "error" &&
            (c.args as { message: string }).message.includes("Body"),
        );
    expect(refusalLogs()).toHaveLength(1);
    await act(async () => {
      fireEvent.click(connectionChip());
    });
    expect(refusalLogs()).toHaveLength(2);
    expect(statusText()).toContain("Body");
  }, 30_000);
});

describe("Connect succeeds with a bus explicitly set to no interface", () => {
  it("connects the bound bus, reads the other as unbound, and counts it 1 / 1", async () => {
    // Starts with no host connection state at all — the chip must read
    // "connect", not "disconnect", or the press below would tear a
    // session down instead of opening one.
    connectionStatesResult = {};
    openProjectResult = {
      schema_version: 7,
      project_id: "p2",
      layout: { grid: {}, panels: {} },
      elements: [],
      buses: [
        { id: "b1", name: "Chassis" },
        { id: "b2", name: "Body" },
      ],
      interface_bindings: [
        { server: "127.0.0.1:9", interface: "if0", bus_id: "b1" },
        { kind: "no-interface", server: "", interface: "", bus_id: "b2" },
      ],
      dbcs: [],
      remote_address: null,
      local_virtual_buses: [],
      signal_colors: {},
    };
    await mountAndSeed();
    await act(async () => {
      fireEvent.click(findButton("Open…"));
    });
    await waitFor(() => {
      if (connectionChip().disabled) throw new Error("Connect still disabled");
    });

    const callsBefore = invokeCalls.length;
    await act(async () => {
      fireEvent.click(connectionChip());
    });

    // The no-interface bus does not refuse the connect, and does not
    // reach the wire: `connect_remote_server` is called once, for the
    // bound bus only.
    await waitFor(() => {
      const calls = invokeCalls
        .slice(callsBefore)
        .filter((c) => c.cmd === "connect_remote_server");
      if (calls.length === 0) throw new Error("connect_remote_server not called yet");
    });
    const connectCalls = invokeCalls
      .slice(callsBefore)
      .filter((c) => c.cmd === "connect_remote_server");
    expect(connectCalls).toHaveLength(1);
    const bindings = connectCalls[0].args.bindings as Array<{ busId: string }>;
    expect(bindings.map((b) => b.busId)).toEqual(["b1"]);

    const refusalLogs = invokeCalls
      .slice(callsBefore)
      .filter(
        (c) =>
          c.cmd === "gui_emit_system_log" &&
          (c.args as { level: string }).level === "error",
      );
    expect(refusalLogs).toHaveLength(0);
    expect(statusText()).not.toContain("Body");

    // The host settles the bound bus as connected — a real host would
    // emit this once its own subscribe lands; simulated here the same
    // way `ProjectPanel.connectionState.dom.test.tsx` drives it.
    await act(async () => {
      const handlers = listeners.get("connection-states-changed") ?? [];
      for (const h of handlers) {
        h({ payload: { b1: { kind: "connected", applied: null } } });
      }
    });

    // The chip counts only the bound bus, names the no-interface one
    // in its tooltip.
    await waitFor(() => {
      expect(connectionChip().textContent).toContain("1 / 1");
    });
    expect(connectionChip().title).toContain("Body: unbound");
    expect(connectionChip().title).not.toContain("Chassis: unbound");
  }, 30_000);
});

describe("New project's default bus", () => {
  it("starts with exactly one bus, named Bus 1", async () => {
    await mountAndSeed();
    await act(async () => {
      fireEvent.click(findButton("New"));
    });
    await waitFor(() => {
      if (document.querySelectorAll(".project-bus-row").length === 0)
        throw new Error("no bus row yet");
    });
    const rows = document.querySelectorAll(".project-bus-row");
    expect(rows).toHaveLength(1);
    const input = rows[0].querySelector<HTMLInputElement>(".project-bus-name-input");
    expect(input?.value).toBe("Bus 1");
  }, 30_000);
});
