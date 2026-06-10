// @vitest-environment jsdom
//
// Tests for the per-bus interface combo and the inline "Add server…"
// form that together replace the old standalone "Interface bindings"
// section. The rest of `ProjectPanel` (project actions, element list,
// DBC scoping) is covered by the project / element-registry tests.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  AddServerInline,
  BusInterfaceCombo,
  LocalInterfaceList,
  uniqueRemoteServers,
} from "./ProjectPanel";
import { LOCAL_SERVER } from "./types";
import type { Bus, InterfaceBinding, InterfaceRecord } from "./types";

const BUS1: Bus = { id: "b1", name: "Bus 1" };
// The live address the sidecar is bound to *this* session. Discovery
// state is keyed by this; bindings persist `LOCAL_SERVER` instead so
// they survive a port re-roll.
const LIVE_LOCAL = "127.0.0.1:43891";

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
});

describe("uniqueRemoteServers", () => {
  it("returns first-seen distinct server addresses", () => {
    const bindings: InterfaceBinding[] = [
      { server: "10.0.0.1:50051", interface: "can0", bus_id: "b1" },
      { server: "10.0.0.2:50051", interface: "can0", bus_id: "b2" },
      { server: "10.0.0.1:50051", interface: "can1", bus_id: "b3" },
    ];
    expect(uniqueRemoteServers(bindings, null)).toEqual([
      "10.0.0.1:50051",
      "10.0.0.2:50051",
    ]);
  });

  it("hides the local-sidecar binding (it has its own dedicated row)", () => {
    const bindings: InterfaceBinding[] = [
      { server: LOCAL_SERVER, interface: "vector:ch0", bus_id: "b1" },
      { server: "10.0.0.1:50051", interface: "can0", bus_id: "b2" },
    ];
    expect(uniqueRemoteServers(bindings, LIVE_LOCAL)).toEqual([
      "10.0.0.1:50051",
    ]);
  });

  it("treats a legacy 127.0.0.1:<port> binding as a stale remote, not local", () => {
    // Pre-v5 projects persisted the live sidecar address as the
    // `server`. Those bindings now render under a stale remote-server
    // row (showing as offline) until the user re-picks the interface
    // from the live Local group — see the v4→v5 doc on
    // PROJECT_SCHEMA_VERSION.
    const bindings: InterfaceBinding[] = [
      { server: "127.0.0.1:43891", interface: "vector:ch0", bus_id: "b1" },
    ];
    expect(uniqueRemoteServers(bindings, LIVE_LOCAL)).toEqual([
      "127.0.0.1:43891",
    ]);
  });

  it("excludes local-virtual-bus bindings (URL scheme — in-process)", () => {
    // Vbus bindings store `local-vbus://<id>` in `server`; that URL
    // is the host's session-map index, not a remote address, so it
    // mustn't surface in the Connection panel's remote-server list.
    const bindings: InterfaceBinding[] = [
      {
        kind: "local-virtual-bus",
        server: "local-vbus://vbus1",
        interface: "bus",
        bus_id: "b1",
      },
      {
        kind: "local-virtual-bus",
        server: "local-vbus://vbus1",
        interface: "bus",
        bus_id: "b2",
      },
      { server: "10.0.0.1:50051", interface: "can0", bus_id: "b3" },
    ];
    expect(uniqueRemoteServers(bindings, null)).toEqual([
      "10.0.0.1:50051",
    ]);
  });
});

const REMOTE = "10.0.0.5:50051";

const REC_CAN0: InterfaceRecord = {
  id: "can0",
  display_name: "can0",
  fd_capable: false,
};
const REC_VCAN0: InterfaceRecord = {
  id: "vcan0",
  display_name: "vcan0",
  fd_capable: false,
};

const NO_OPS = {
  onPick: () => {},
  onAddServer: () => {},
  onAddVirtualBus: () => {},
};

describe("BusInterfaceCombo", () => {
  it("renders '— no interface —', local options, server optgroups, and '+ Add server…'", () => {
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{
          [LIVE_LOCAL]: { status: "ok", interfaces: [REC_CAN0, REC_VCAN0] },
          [REMOTE]: { status: "ok", interfaces: [REC_CAN0] },
        }}
        localVirtualBuses={[]}
        {...NO_OPS}
      />,
    );
    const combo = screen.getByLabelText("bus b1 interface") as HTMLSelectElement;
    const optionTexts = Array.from(combo.querySelectorAll("option")).map(
      (o) => o.textContent ?? "",
    );
    expect(optionTexts).toContain("— no interface —");
    expect(optionTexts).toContain("Local / can0");
    expect(optionTexts).toContain("Local / vcan0");
    expect(optionTexts).toContain(`${REMOTE} / can0`);
    expect(optionTexts).toContain("+ Add server…");
  });

  it("calls onPick with kind:remote on a hardware-interface selection", () => {
    const onPick = vi.fn();
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{
          [LIVE_LOCAL]: { status: "ok", interfaces: [REC_CAN0] },
        }}
        localVirtualBuses={[]}
        onPick={onPick}
        onAddServer={() => {}}
        onAddVirtualBus={() => {}}
      />,
    );
    const combo = screen.getByLabelText("bus b1 interface") as HTMLSelectElement;
    fireEvent.change(combo, { target: { value: `${LOCAL_SERVER}\x00can0` } });
    expect(onPick).toHaveBeenCalledWith({
      kind: "remote",
      server: LOCAL_SERVER,
      iface: "can0",
    });
  });

  it("lists virtual buses as a peer source and reports the right pick", () => {
    const onPick = vi.fn();
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{ [LIVE_LOCAL]: { status: "ok", interfaces: [] } }}
        localVirtualBuses={[{ id: "vbus1", name: "Bench" }]}
        onPick={onPick}
        onAddServer={() => {}}
        onAddVirtualBus={() => {}}
      />,
    );
    const combo = screen.getByLabelText("bus b1 interface") as HTMLSelectElement;
    const labels = Array.from(combo.querySelectorAll("option")).map(
      (o) => o.textContent ?? "",
    );
    expect(labels).toContain("Bench");
    expect(labels).toContain("+ Add virtual bus");
    fireEvent.change(combo, { target: { value: "vbus\x00vbus1" } });
    expect(onPick).toHaveBeenCalledWith({
      kind: "local-virtual-bus",
      virtual_bus_id: "vbus1",
    });
  });

  it("calls onAddVirtualBus when '+ Add virtual bus' is chosen", () => {
    const onAddVirtualBus = vi.fn();
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{ [LIVE_LOCAL]: { status: "ok", interfaces: [] } }}
        localVirtualBuses={[]}
        onPick={() => {}}
        onAddServer={() => {}}
        onAddVirtualBus={onAddVirtualBus}
      />,
    );
    fireEvent.change(screen.getByLabelText("bus b1 interface"), {
      target: { value: "__add_vbus__" },
    });
    expect(onAddVirtualBus).toHaveBeenCalledTimes(1);
  });

  it("calls onAddServer (not onPick) when '+ Add server…' is chosen", () => {
    const onPick = vi.fn();
    const onAddServer = vi.fn();
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{ [LIVE_LOCAL]: { status: "ok", interfaces: [REC_CAN0] } }}
        localVirtualBuses={[]}
        onPick={onPick}
        onAddServer={onAddServer}
        onAddVirtualBus={() => {}}
      />,
    );
    const combo = screen.getByLabelText("bus b1 interface");
    fireEvent.change(combo, { target: { value: "__add_server__" } });
    expect(onAddServer).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("calls onPick(null) when '— no interface —' is chosen", () => {
    const onPick = vi.fn();
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={{
          kind: "remote",
          server: LOCAL_SERVER,
          interface: "can0",
          bus_id: "b1",
        }}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{ [LIVE_LOCAL]: { status: "ok", interfaces: [REC_CAN0] } }}
        localVirtualBuses={[]}
        onPick={onPick}
        onAddServer={() => {}}
        onAddVirtualBus={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("bus b1 interface"), {
      target: { value: "" },
    });
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("shows a (discovering…) placeholder when a server has no discovery yet", () => {
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{
          [LIVE_LOCAL]: { status: "ok", interfaces: [] },
          [REMOTE]: { status: "pending" },
        }}
        localVirtualBuses={[]}
        {...NO_OPS}
      />,
    );
    expect(screen.getByText("(discovering…)")).toBeInTheDocument();
  });

  it("a 'local' binding still resolves to the live sidecar address even after a port change", () => {
    const NEW_LIVE = "127.0.0.1:55321";
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={{
          kind: "remote",
          server: LOCAL_SERVER,
          interface: "can0",
          bus_id: "b1",
        }}
        sidecarAddress={NEW_LIVE}
        discoveries={{ [NEW_LIVE]: { status: "ok", interfaces: [REC_CAN0] } }}
        localVirtualBuses={[]}
        {...NO_OPS}
      />,
    );
    expect(
      screen.queryByRole("option", { name: /\(offline\)/ }),
    ).not.toBeInTheDocument();
    const combo = screen.getByLabelText("bus b1 interface") as HTMLSelectElement;
    expect(combo.value).toBe(`${LOCAL_SERVER}\x00can0`);
  });

  it("renders an (offline) fallback option when the bound interface isn't in any discovery", () => {
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={{
          kind: "remote",
          server: REMOTE,
          interface: "can0",
          bus_id: "b1",
        }}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{
          [LIVE_LOCAL]: { status: "ok", interfaces: [] },
          [REMOTE]: { status: "err", error: "connection refused" },
        }}
        localVirtualBuses={[]}
        {...NO_OPS}
      />,
    );
    expect(
      screen.getByRole("option", { name: `${REMOTE} / can0 (offline)` }),
    ).toBeInTheDocument();
  });
});

describe("AddServerInline", () => {
  it("discovers interfaces and forwards onPick with the selection", async () => {
    invokeMock.mockResolvedValueOnce([REC_CAN0, REC_VCAN0]);
    const onPick = vi.fn();
    render(
      <AddServerInline
        busLabel="Bus 1"
        onCancel={() => {}}
        onPick={onPick}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discover" }));
    // Wait one microtask for the resolved invoke + state update.
    await Promise.resolve();
    await Promise.resolve();

    const ifaceSelect = await screen.findByLabelText("interface id");
    expect((ifaceSelect as HTMLSelectElement).value).toBe("can0");
    fireEvent.change(ifaceSelect, { target: { value: "vcan0" } });
    fireEvent.click(screen.getByRole("button", { name: "Bind to Bus 1" }));
    expect(onPick).toHaveBeenCalledWith({ server: "127.0.0.1:50051", iface: "vcan0" });
  });

  it("surfaces the error and stays open when Discover throws", async () => {
    invokeMock.mockRejectedValueOnce(new Error("nope"));
    render(
      <AddServerInline
        busLabel="Bus 1"
        onCancel={() => {}}
        onPick={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discover" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText(/nope/)).toBeInTheDocument();
  });

  it("Cancel triggers onCancel", () => {
    const onCancel = vi.fn();
    render(
      <AddServerInline
        busLabel="Bus 1"
        onCancel={onCancel}
        onPick={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("LocalInterfaceList", () => {
  const BUS2: Bus = { id: "b2", name: "Powertrain" };

  it("lists every discovered interface, tagging unbound ones as (unassigned)", () => {
    render(
      <LocalInterfaceList
        bindings={[
          { server: LOCAL_SERVER, interface: "can0", bus_id: "b1" },
        ]}
        buses={[BUS1, BUS2]}
        discoveries={{
          [LIVE_LOCAL]: {
            status: "ok",
            interfaces: [REC_CAN0, REC_VCAN0],
          },
        }}
        sidecarAddress={LIVE_LOCAL}
      />,
    );
    // Bound interface shows its bus name.
    expect(screen.getByText("Bus 1")).toBeInTheDocument();
    // Discovered-but-unbound interface still appears, tagged.
    expect(screen.getByText("(unassigned)")).toBeInTheDocument();
    // Both interface ids are visible.
    expect(screen.getByText("can0")).toBeInTheDocument();
    expect(screen.getByText("vcan0")).toBeInTheDocument();
  });

  it("shows orphan bindings (interface no longer in discovery) with a 'not currently present' note", () => {
    render(
      <LocalInterfaceList
        bindings={[
          { server: LOCAL_SERVER, interface: "legacy-can0", bus_id: "b1" },
        ]}
        buses={[BUS1]}
        discoveries={{
          [LIVE_LOCAL]: { status: "ok", interfaces: [REC_VCAN0] },
        }}
        sidecarAddress={LIVE_LOCAL}
      />,
    );
    expect(screen.getByText("legacy-can0")).toBeInTheDocument();
    expect(screen.getByText(/not currently present/)).toBeInTheDocument();
  });

  it("renders the empty state when nothing is discovered and nothing is bound", () => {
    render(
      <LocalInterfaceList
        bindings={[]}
        buses={[BUS1]}
        discoveries={{ [LIVE_LOCAL]: { status: "ok", interfaces: [] } }}
        sidecarAddress={LIVE_LOCAL}
      />,
    );
    expect(screen.getByText("(no local interfaces)")).toBeInTheDocument();
  });

  it("surfaces 'local driver offline' when the sidecar isn't ready", () => {
    render(
      <LocalInterfaceList
        bindings={[]}
        buses={[BUS1]}
        discoveries={{}}
        sidecarAddress={null}
      />,
    );
    expect(screen.getByText("(local driver offline)")).toBeInTheDocument();
  });
});
