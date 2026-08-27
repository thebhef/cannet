// @vitest-environment jsdom
//
// The panel renders the join, and — the thing it exists for — renders
// "we cannot know" differently from zero. A bus-off bus at 0 % is an
// alarm; a virtual bus with no configurable bitrate is not, and a panel
// that drew them alike would be worse than no panel.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type { BusHealthMap, BusConnStates } from "./types";

let health: BusHealthMap = {};
let connStates: BusConnStates = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_bus_health") return health;
    if (cmd === "get_connection_states") return connStates;
    if (cmd === "get_sidecar_status") return { phase: "ready", address: "127.0.0.1:1" };
    if (cmd === "get_interfaces") {
      return [
        { id: "pcan:1", display_name: "PEAK PCAN-USB FD (ch:1)", fd_capable: true },
      ];
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { BusHealthPanel } from "./BusHealthPanel";
import { ProjectContext, type ProjectContextValue } from "./projectContext";

afterEach(cleanup);

function projectCtx(): ProjectContextValue {
  return {
    buses: [
      { id: "b1", name: "Powertrain" },
      { id: "b2", name: "Body" },
      { id: "b3", name: "Sim" },
    ],
    interfaceBindings: [
      { server: "local", interface: "pcan:1", bus_id: "b1" },
      { server: "local", interface: "pcan:2", bus_id: "b2" },
      {
        kind: "local-virtual-bus",
        server: "local-vbus://v",
        interface: "bus",
        bus_id: "b3",
      },
    ],
  } as unknown as ProjectContextValue;
}

function renderPanel() {
  return render(
    <ProjectContext.Provider value={projectCtx()}>
      <BusHealthPanel />
    </ProjectContext.Provider>,
  );
}

/// The cells of the row whose first cell is `name`.
function cellsOf(name: string): string[] {
  const cell = [...document.querySelectorAll("td.bus-health-bus")].find(
    (c) => c.textContent === name,
  );
  if (!cell) throw new Error(`no row for ${name}`);
  return [...(cell.parentElement as HTMLTableRowElement).cells].map(
    (c) => c.textContent ?? "",
  );
}

describe("BusHealthPanel", () => {
  it("draws a bus-off bus at zero per cent and an unconfigurable one as absent", async () => {
    connStates = {
      b1: {
        kind: "connected",
        applied: { speedBps: 500000, fdEnabled: true, fdDataSpeedBps: 2000000 },
      },
      b2: {
        kind: "connected",
        applied: { speedBps: 250000, fdEnabled: false, fdDataSpeedBps: null },
      },
      b3: { kind: "connected", applied: null },
    };
    health = {
      b1: {
        controller: { state: "active", tec: 0, rec: 0 },
        loadPercent: 34,
        errorCount: 0,
        errorRate: 0,
      },
      b2: {
        controller: { state: "busOff", tec: 256, rec: 0 },
        loadPercent: 0,
        errorCount: 9471,
        errorRate: 2100,
      },
      b3: { errorCount: 0, errorRate: 0 },
    };
    renderPanel();

    await waitFor(() => expect(screen.getByText("Bus-off")).toBeInTheDocument());

    // Bus-off: a real zero, with the counters that explain it.
    const off = cellsOf("Body");
    expect(off[2]).toBe("0 %");
    expect(off[3]).toBe("256");
    expect(off[5]).toContain("9,471");
    expect(off[5]).toContain("2.1k/s");

    // The virtual bus: not a zero anywhere it cannot know.
    const sim = cellsOf("Sim");
    expect(sim[2]).toBe("—");
    expect(sim[3]).toBe("—");
    expect(sim[4]).toBe("—");
    // Its Adapter cell says there is no hardware, rather than showing
    // the canonical wire id every virtual binding carries.
    expect(sim[6]).toBe("virtual bus");

    // And the healthy one, with the adapter column in the project
    // panel's own words.
    expect(cellsOf("Powertrain")[2]).toBe("34 %");
    await waitFor(() =>
      expect(cellsOf("Powertrain")[6]).toBe("PEAK PCAN-USB FD (ch:1) 500k · FD data 2M"),
    );
  });

  it("reads a bus the host has said nothing about as absent, not idle", async () => {
    // The control for the row above: with no host entry every cell that
    // could be a number is an em dash, and none of them is a zero.
    connStates = {};
    health = {};
    renderPanel();
    await waitFor(() => expect(screen.getAllByText("Not connected").length).toBe(3));
    expect(cellsOf("Powertrain").slice(2, 6)).toEqual(["—", "—", "—", "—"]);
    await waitFor(() =>
      expect(cellsOf("Powertrain")[6]).toBe("PEAK PCAN-USB FD (ch:1)"),
    );
  });

  it("says so rather than drawing an empty grid for a project with no buses", async () => {
    connStates = {};
    health = {};
    render(
      <ProjectContext.Provider
        value={{ buses: [], interfaceBindings: [] } as unknown as ProjectContextValue}
      >
        <BusHealthPanel />
      </ProjectContext.Provider>,
    );
    expect(await screen.findByText(/no buses/)).toBeInTheDocument();
  });
});
