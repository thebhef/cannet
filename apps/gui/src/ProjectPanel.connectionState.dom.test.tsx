// @vitest-environment jsdom
//
// Connect / disconnect / configure feedback, inline in the project
// panel: each logical-bus row carries a connection marker mirroring its
// single binding's host-side state, each bound interface row under the
// Connection section carries the same state, and a connected bus echoes
// the configuration the host actually put on the wire.
//
// The state itself is the host's model — these tests feed it in through
// `get_connection_states` / `connection-states-changed`, exactly as the
// host does, and assert only that the panel renders it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => [] as unknown[]),
  listenMock: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import type { IDockviewPanelProps } from "dockview";

import { ProjectPanel } from "./ProjectPanel";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
} from "./projectElements";
import { hydrateSettings } from "./hostSettings";
import {
  describeAppliedConfig,
  describeBusConnState,
} from "./connectionStates";
import type { Bus, BusConnStates, InterfaceBinding } from "./types";

const LIVE_LOCAL = "127.0.0.1:43891";

/// Answer the panel's boot invokes the way the host would, with
/// `get_connection_states` returning `states`.
function seedHost(states: BusConnStates, interfaces: unknown[] = []) {
  invokeMock.mockImplementation((async (cmd: string) => {
    if (cmd === "get_connection_states") return states;
    if (cmd === "get_sidecar_status") {
      return { phase: "ready", address: LIVE_LOCAL };
    }
    if (cmd === "get_interfaces" || cmd === "refresh_interfaces") {
      return interfaces;
    }
    return [];
  }) as never);
}

function renderPanel(opts: {
  buses?: readonly Bus[];
  bindings?: readonly InterfaceBinding[];
} = {}) {
  const ctx = {
    projectPath: null,
    dirty: false,
    dbcPaths: [],
    dbcBuses: {},
    buses: opts.buses ?? [],
    interfaceBindings: opts.bindings ?? [],
    connectedAddresses: [],
    remoteConnected: false,
    connectedBusIds: [],
    blfPath: null,
    signalColors: {},
    busesWithPendingHwConfig: [],
    localVirtualBuses: [],
    onUpdateBus: () => {},
    onRemoveBus: () => {},
    onAddBus: () => {},
    onAddBinding: () => {},
    onRemoveBinding: () => {},
  } as unknown as ProjectContextValue;
  const registry = {
    entries: [],
    get: () => undefined,
    create: () => "",
    ensure: () => {},
    updateTrace: () => {},
    update: vi.fn(),
    remove: vi.fn(),
  } as unknown as ElementRegistry;
  const props = {
    api: { updateParameters: vi.fn() },
    params: {},
    containerApi: {
      panels: [],
      onDidLayoutChange: () => ({ dispose: () => {} }),
      addPanel: () => {},
    },
  } as unknown as IDockviewPanelProps;
  return render(
    <ProjectContext.Provider value={ctx}>
      <ElementRegistryContext.Provider value={registry}>
        <ProjectPanel {...props} />
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
}

beforeEach(async () => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  listenMock.mockReset();
  listenMock.mockResolvedValue(() => {});
  await hydrateSettings();
});

afterEach(async () => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  await hydrateSettings();
});

describe("describeBusConnState", () => {
  it("reads a bus with no binding as unbound", () => {
    expect(describeBusConnState(undefined, false)).toMatchObject({
      text: "unbound",
      tone: "muted",
    });
  });

  it("reads a bound bus the host has no session for as not connected", () => {
    expect(describeBusConnState(undefined, true)).toMatchObject({
      text: "not connected",
      tone: "muted",
    });
  });

  it("shows the in-flight state while the subscribe is outstanding", () => {
    expect(describeBusConnState({ kind: "connecting" }, true)).toMatchObject({
      text: "connecting…",
      tone: "muted",
    });
  });

  it("carries the short reason on an error, in the row text", () => {
    expect(
      describeBusConnState(
        { kind: "error", reason: "not exposed by 10.0.0.5:50051" },
        true,
      ),
    ).toMatchObject({
      text: "error: not exposed by 10.0.0.5:50051",
      tone: "errored",
    });
  });

  it("puts the applied config in a connected row's tooltip", () => {
    expect(
      describeBusConnState(
        {
          kind: "connected",
          applied: {
            speedBps: 250_000,
            fdEnabled: false,
            fdDataSpeedBps: null,
          },
        },
        true,
      ),
    ).toMatchObject({ text: "connected", detail: "connected — 250k" });
  });
});

describe("describeAppliedConfig", () => {
  it("says nothing for a bus with no controller (in-process vbus)", () => {
    expect(describeAppliedConfig(null)).toBeNull();
  });

  it("names the driver default when no ConfigureBus was sent", () => {
    // The trap the panel used to hide: the bitrate input's greyed
    // placeholder is not what the controller is running.
    expect(
      describeAppliedConfig({
        speedBps: null,
        fdEnabled: false,
        fdDataSpeedBps: null,
      }),
    ).toBe("driver default (nothing sent)");
  });

  it("echoes a classic bus's nominal rate", () => {
    expect(
      describeAppliedConfig({
        speedBps: 500_000,
        fdEnabled: false,
        fdDataSpeedBps: null,
      }),
    ).toBe("500k");
  });

  it("echoes the FD data rate the host resolved", () => {
    expect(
      describeAppliedConfig({
        speedBps: 500_000,
        fdEnabled: true,
        fdDataSpeedBps: 2_000_000,
      }),
    ).toBe("500k · FD data 2M");
  });

  it("does not render a wire zero as a bitrate", () => {
    // FD ticked, bitrate left blank: the wire carries 0, which the
    // sidecar reads as "unset".
    expect(
      describeAppliedConfig({
        speedBps: 0,
        fdEnabled: true,
        fdDataSpeedBps: 0,
      }),
    ).toBe("driver default · FD");
  });
});

describe("logical-bus row marker", () => {
  it("mirrors the host's state for the bus, including unbound", async () => {
    seedHost({ b1: { kind: "connected", applied: null } });
    renderPanel({
      buses: [
        { id: "b1", name: "Powertrain" },
        { id: "b2", name: "Body" },
      ],
      bindings: [{ server: "local", interface: "can0", bus_id: "b1" }],
    });
    await waitFor(() =>
      expect(screen.getByTestId("bus-conn-state-b1")).toHaveTextContent(
        "connected",
      ),
    );
    expect(screen.getByTestId("bus-conn-state-b2")).toHaveTextContent(
      "unbound",
    );
  });

  it("shows the failure reason inline on the bus that failed", async () => {
    seedHost({
      b1: { kind: "error", reason: "open vector:VN1780(ch:1) failed" },
    });
    renderPanel({
      buses: [{ id: "b1", name: "Powertrain" }],
      bindings: [
        { server: "local", interface: "vector:VN1780(ch:1)", bus_id: "b1" },
      ],
    });
    await waitFor(() =>
      expect(screen.getByTestId("bus-conn-state-b1")).toHaveTextContent(
        "error: open vector:VN1780(ch:1) failed",
      ),
    );
  });

  it("echoes what went on the wire under a connected bus", async () => {
    seedHost({
      b1: {
        kind: "connected",
        applied: { speedBps: 250_000, fdEnabled: false, fdDataSpeedBps: null },
      },
    });
    renderPanel({
      buses: [{ id: "b1", name: "Powertrain", speed_bps: 250_000 }],
      bindings: [{ server: "local", interface: "can0", bus_id: "b1" }],
    });
    await waitFor(() =>
      expect(screen.getByTestId("bus-applied-b1")).toHaveTextContent(
        "live: 250k",
      ),
    );
  });

  it("has nothing to echo for a bus that is not connected", async () => {
    seedHost({ b1: { kind: "connecting" } });
    renderPanel({
      buses: [{ id: "b1", name: "Powertrain" }],
      bindings: [{ server: "local", interface: "can0", bus_id: "b1" }],
    });
    await waitFor(() =>
      expect(screen.getByTestId("bus-conn-state-b1")).toHaveTextContent(
        "connecting…",
      ),
    );
    expect(screen.queryByTestId("bus-applied-b1")).not.toBeInTheDocument();
  });

  it("follows the host's change event without a refetch", async () => {
    seedHost({ b1: { kind: "connecting" } });
    let push: ((e: { payload: BusConnStates }) => void) | undefined;
    listenMock.mockImplementation((async (name: string, cb: unknown) => {
      if (name === "connection-states-changed") {
        push = cb as (e: { payload: BusConnStates }) => void;
      }
      return () => {};
    }) as never);

    renderPanel({
      buses: [{ id: "b1", name: "Powertrain" }],
      bindings: [{ server: "local", interface: "can0", bus_id: "b1" }],
    });
    await waitFor(() =>
      expect(screen.getByTestId("bus-conn-state-b1")).toHaveTextContent(
        "connecting…",
      ),
    );
    await waitFor(() => expect(push).toBeDefined());

    act(() => {
      push!({
        payload: {
          b1: {
            kind: "connected",
            applied: {
              speedBps: 500_000,
              fdEnabled: false,
              fdDataSpeedBps: null,
            },
          },
        },
      });
    });
    expect(screen.getByTestId("bus-conn-state-b1")).toHaveTextContent(
      "connected",
    );
    expect(screen.getByTestId("bus-applied-b1")).toHaveTextContent("live: 500k");
  });
});

describe("per-interface state in the Connection section", () => {
  it("gives each channel of one device its own state", async () => {
    // The VN17xx incident: channels 1, 3 and 4 up, channel 2 refused.
    // One device, four bindings, four independent rows.
    const channels = [0, 1, 2, 3].map((i) => ({
      id: `vector:VN1780(ch:${i})`,
      display_name: `Vector VN1780 ch${i}`,
      fd_capable: true,
    }));
    seedHost(
      {
        b1: { kind: "connected", applied: null },
        b2: { kind: "error", reason: "open failed" },
        b3: { kind: "connected", applied: null },
        b4: { kind: "connected", applied: null },
      },
      channels,
    );
    renderPanel({
      buses: [1, 2, 3, 4].map((n) => ({ id: `b${n}`, name: `Bus ${n}` })),
      bindings: [0, 1, 2, 3].map((i) => ({
        server: "local",
        interface: `vector:VN1780(ch:${i})`,
        bus_id: `b${i + 1}`,
      })),
    });

    // Both the bus rows and the interface rows carry the state; the
    // interface rows are what make "which channel is down" answerable
    // at a glance.
    await waitFor(() =>
      expect(screen.getAllByTestId("binding-state-b2").length).toBeGreaterThan(
        0,
      ),
    );
    for (const bus of ["b1", "b3", "b4"]) {
      for (const el of screen.getAllByTestId(`binding-state-${bus}`)) {
        expect(el).toHaveTextContent("connected");
      }
    }
    for (const el of screen.getAllByTestId("binding-state-b2")) {
      expect(el).toHaveTextContent("error: open failed");
    }
  });
});
