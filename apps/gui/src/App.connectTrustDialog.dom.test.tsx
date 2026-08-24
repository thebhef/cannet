// @vitest-environment jsdom
//
// When a trust question becomes a modal, in the real App.
//
// Two rules, one mount. A question the host raises on its own — a
// background interface watch finding a known server's certificate
// changed — never opens a dialog; it is an indicator on the rows. A
// connection the *user* asked for, blocked by that same question, opens
// exactly one, because there is one dialog implementation mounted once.
//
// These drive the whole App rather than the dialog host alone: the
// wiring under test is which call sites raise, and a panel-level test
// cannot see that.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();

const BENCH = "bench:50051";
/// The question the host is waiting on, and whether a connect attempt
/// to the bench is refused. Flags rather than `mockImplementationOnce`,
/// which would intercept whichever host call the mount makes first.
const { invokeMock, rig } = vi.hoisted(() => {
  const rig = { prompts: {} as Record<string, unknown>, refuseConnect: false };
  const invokeMock = vi.fn(
    async (cmd: string, _args?: unknown): Promise<unknown> => {
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
        case "app_version":
          return "0.0.0-test";
        case "get_sidecar_status":
          return { phase: "offline", address: null };
        case "get_server_prompts":
          return rig.prompts;
        case "open_project":
          return {
            schema_version: 4,
            project_id: "p1",
            layout: { grid: {}, panels: {} },
            elements: [],
            buses: [{ id: "b1", name: "B1" }],
            interface_bindings: [
              { server: BENCH, interface: "if0", bus_id: "b1" },
            ],
            dbcs: [],
            remote_address: null,
            local_virtual_buses: [],
            signal_colors: {},
          };
        case "connect_remote_server":
          if (rig.refuseConnect) {
            throw new Error("the server's identity is not the accepted one");
          }
          return { subscribed: [] };
        default:
          return null;
      }
    },
  );
  return { invokeMock, rig };
});
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
  open: vi.fn(async () => "/bench.cannet"),
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
import { hydrateState } from "./hostState";
import { clearServerTrust } from "./serverTrust";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const IDENTITY_CHANGED = {
  kind: "identityChanged",
  expected: "SHA256:oldoldold",
  observed: "SHA256:newnewnew",
};

/// The connection control: a status chip in the bar rather than a
/// toolbar button, so it is found by its own class and its state reads
/// off its accessible name.
function connectionChip(): HTMLButtonElement {
  const chip = document.querySelector<HTMLButtonElement>("button.status-chip--connection");
  if (!chip) throw new Error("no connection chip");
  return chip;
}

function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn;
}

/// Mount the App and open a project whose one bus is bound to the
/// bench, so Connect is live.
async function mountWithBenchProject() {
  render(<App />);
  await waitFor(() => {
    if (!document.querySelector(".trace-panel .trace-status"))
      throw new Error("seeded layout not mounted yet");
  });
  await act(async () => {
    fireEvent.click(findButton("Open…"));
  });
  await waitFor(() => {
    if (connectionChip().disabled) throw new Error("Connect still disabled");
  });
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  localStorage.clear();
  listeners.clear();
  invokeMock.mockClear();
  rig.prompts = {};
  rig.refuseConnect = false;
  await hydrateState();
});

afterEach(() => {
  clearServerTrust();
  cleanup();
  vi.unstubAllGlobals();
});

describe("when a trust question becomes a modal", () => {
  it("opens nothing while the user is not trying to connect", async () => {
    // The host is waiting on a changed identity for a server this
    // project names — found by the interface watch, with nobody asking
    // for a connection. The window must not be interrupted.
    rig.prompts = { [BENCH]: IDENTITY_CHANGED };
    await mountWithBenchProject();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Stronger than "no dialog": nothing even asked the host what it is
    // waiting on, because nothing raised.
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "get_server_prompts"),
    ).toBe(false);
  }, 30_000);

  it("opens exactly one dialog when it blocks a connect the user asked for", async () => {
    rig.prompts = { [BENCH]: IDENTITY_CHANGED };
    rig.refuseConnect = true;
    await mountWithBenchProject();
    await act(async () => {
      fireEvent.click(connectionChip());
    });
    const dialogs = await screen.findAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveTextContent("SHA256:oldoldold");
    expect(dialogs[0]).toHaveTextContent("SHA256:newnewnew");
    expect(dialogs[0]).toHaveTextContent(BENCH);
  }, 30_000);

  it("opens nothing when the connect failed for some other reason", async () => {
    // A refused connection that raised no question leaves nothing
    // armed — so the next question the host asks on its own cannot be
    // caught by a stale request from this attempt.
    rig.refuseConnect = true;
    await mountWithBenchProject();
    await act(async () => {
      fireEvent.click(connectionChip());
    });
    await waitFor(() => {
      if (!invokeMock.mock.calls.some((c) => c[0] === "get_server_prompts"))
        throw new Error("the host was never asked what it is waiting on");
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  }, 30_000);
});
