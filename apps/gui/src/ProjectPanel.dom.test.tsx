// @vitest-environment jsdom
//
// Tests for the per-bus interface combo — the one place a bus's source
// is picked, offering the local driver's interfaces, the trusted
// servers' interfaces grouped per server, and the project's virtual
// buses. The rest of `ProjectPanel` (project actions, element list, DBC
// scoping) is covered by the project / element-registry tests.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  comboboxOptionLabels,
  comboboxValue,
  openCombobox,
  pickCombobox,
} from "./comboboxTestKit";

const { invokeMock } = vi.hoisted(() => ({
  // Typed with the command name the production code passes, so a test
  // can answer per command instead of per call order.
  invokeMock: vi.fn(async (_cmd: string) => [] as unknown[]),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import type { IDockviewPanel } from "dockview";

import { ElementRow } from "./ProjectPanel";
import { BusInterfaceCombo, LocalInterfaceList } from "./ConnectionManagement";
import { hydrateSettings } from "./hostSettings";
import type { ServerRow } from "./serverList";
import { LOCAL_SERVER } from "./types";
import type { Bus, InterfaceRecord, ProjectElement } from "./types";

const BUS1: Bus = { id: "b1", name: "Bus 1" };
// The live address the sidecar is bound to *this* session. Discovery
// state is keyed by this; bindings persist `LOCAL_SERVER` instead so
// they survive a port re-roll.
const LIVE_LOCAL = "127.0.0.1:43891";

afterEach(async () => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  // The settings cache is module-global, so a test that seeds one must
  // not leave it seeded for the next.
  await hydrateSettings();
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

/// A trusted server as the host's merged list hands it over.
function serverRow(patch: Partial<ServerRow> & { address: string }): ServerRow {
  return {
    name: null,
    host: null,
    version: null,
    online: true,
    trust: "trusted",
    fingerprint: null,
    hasToken: false,
    insecure: false,
    prompt: null,
    ...patch,
  };
}

const BENCH = serverRow({
  address: REMOTE,
  name: "bench-rig",
  host: "bench-rig.local",
  version: "v0.8.1",
  fingerprint: "SHA256:aaa",
  hasToken: true,
});

const NO_OPS = {
  onPick: () => {},
  onManageServers: () => {},
  onAddVirtualBus: () => {},
};

describe("BusInterfaceCombo", () => {
  it("renders '— no interface —', local options, a group per trusted server, and 'Manage servers…'", () => {
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{
          [LIVE_LOCAL]: { status: "ok", interfaces: [REC_CAN0, REC_VCAN0] },
          [REMOTE]: { status: "ok", interfaces: [REC_CAN0] },
        }}
        servers={[BENCH]}
        localVirtualBuses={[]}
        {...NO_OPS}
      />,
    );
    const combo = screen.getByLabelText("bus b1 interface");
    openCombobox(combo);
    const optionTexts = comboboxOptionLabels();
    expect(optionTexts).toContain("— no interface —");
    expect(optionTexts).toContain("Local / can0");
    expect(optionTexts).toContain("Local / vcan0");
    // The server's interfaces sit under a header naming the server, so
    // the row itself is just the interface.
    expect(optionTexts).toContain("can0");
    expect(screen.getByText("bench-rig")).toBeInTheDocument();
    expect(optionTexts).toContain("Manage servers…");
    // The bus row no longer knows how to add a server.
    expect(optionTexts).not.toContain("+ Add server…");
  });

  it("offers nothing from a server this machine has not trusted", () => {
    // The caller passes the trusted rows only; a merely-advertising
    // server is trusted in the Servers panel first.
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{
          [LIVE_LOCAL]: { status: "ok", interfaces: [] },
          [REMOTE]: { status: "ok", interfaces: [REC_CAN0] },
        }}
        servers={[]}
        localVirtualBuses={[]}
        {...NO_OPS}
      />,
    );
    openCombobox(screen.getByLabelText("bus b1 interface"));
    expect(screen.queryByText("bench-rig")).not.toBeInTheDocument();
    expect(comboboxOptionLabels()).not.toContain("can0");
  });

  it("calls onPick with the server's address on a remote-interface selection", async () => {
    const onPick = vi.fn();
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{
          [LIVE_LOCAL]: { status: "ok", interfaces: [] },
          [REMOTE]: { status: "ok", interfaces: [REC_CAN0] },
        }}
        servers={[BENCH]}
        localVirtualBuses={[]}
        {...NO_OPS}
        onPick={onPick}
      />,
    );
    await pickCombobox(
      screen.getByLabelText("bus b1 interface"),
      `${REMOTE}\x00can0`,
    );
    expect(onPick).toHaveBeenCalledWith({
      kind: "remote",
      server: REMOTE,
      iface: "can0",
    });
  });

  it("shows a trusted server that is switched off as (offline), with nothing to pick", () => {
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{ [LIVE_LOCAL]: { status: "ok", interfaces: [] } }}
        servers={[serverRow({ address: REMOTE, name: "bench-rig", online: false })]}
        localVirtualBuses={[]}
        {...NO_OPS}
      />,
    );
    openCombobox(screen.getByLabelText("bus b1 interface"));
    expect(screen.getByText("(offline)")).toBeInTheDocument();
  });

  it("calls onPick with kind:remote on a local-interface selection", async () => {
    const onPick = vi.fn();
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{
          [LIVE_LOCAL]: { status: "ok", interfaces: [REC_CAN0] },
        }}
        servers={[]}
        localVirtualBuses={[]}
        {...NO_OPS}
        onPick={onPick}
      />,
    );
    const combo = screen.getByLabelText("bus b1 interface");
    await pickCombobox(combo, `${LOCAL_SERVER}\x00can0`);
    expect(onPick).toHaveBeenCalledWith({
      kind: "remote",
      server: LOCAL_SERVER,
      iface: "can0",
    });
  });

  it("lists virtual buses as a peer source and reports the right pick", async () => {
    const onPick = vi.fn();
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{ [LIVE_LOCAL]: { status: "ok", interfaces: [] } }}
        servers={[]}
        localVirtualBuses={[{ id: "vbus1", name: "Bench" }]}
        {...NO_OPS}
        onPick={onPick}
      />,
    );
    const combo = screen.getByLabelText("bus b1 interface");
    openCombobox(combo);
    const labels = comboboxOptionLabels();
    expect(labels).toContain("Bench");
    expect(labels).toContain("+ Add virtual bus");
    await pickCombobox(combo, "vbus\x00vbus1");
    expect(onPick).toHaveBeenCalledWith({
      kind: "local-virtual-bus",
      virtual_bus_id: "vbus1",
    });
  });

  it("calls onAddVirtualBus when '+ Add virtual bus' is chosen", async () => {
    const onAddVirtualBus = vi.fn();
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{ [LIVE_LOCAL]: { status: "ok", interfaces: [] } }}
        servers={[]}
        localVirtualBuses={[]}
        {...NO_OPS}
        onAddVirtualBus={onAddVirtualBus}
      />,
    );
    await pickCombobox(screen.getByLabelText("bus b1 interface"), "__add_vbus__");
    expect(onAddVirtualBus).toHaveBeenCalledTimes(1);
  });

  it("calls onManageServers (not onPick) when 'Manage servers…' is chosen", async () => {
    // The bus keeps whatever it was bound to: this option is a jump to
    // the panel, not a source.
    const onPick = vi.fn();
    const onManageServers = vi.fn();
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{ [LIVE_LOCAL]: { status: "ok", interfaces: [REC_CAN0] } }}
        servers={[]}
        localVirtualBuses={[]}
        {...NO_OPS}
        onPick={onPick}
        onManageServers={onManageServers}
      />,
    );
    const combo = screen.getByLabelText("bus b1 interface");
    await pickCombobox(combo, "__manage_servers__");
    expect(onManageServers).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("calls onPick(null) when '— no interface —' is chosen", async () => {
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
        servers={[]}
        localVirtualBuses={[]}
        {...NO_OPS}
        onPick={onPick}
      />,
    );
    await pickCombobox(screen.getByLabelText("bus b1 interface"), "");
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("shows a (discovering…) placeholder when a trusted server has no discovery yet", () => {
    render(
      <BusInterfaceCombo
        bus={BUS1}
        binding={null}
        sidecarAddress={LIVE_LOCAL}
        discoveries={{
          [LIVE_LOCAL]: { status: "ok", interfaces: [] },
          [REMOTE]: { status: "pending" },
        }}
        servers={[BENCH]}
        localVirtualBuses={[]}
        {...NO_OPS}
      />,
    );
    openCombobox(screen.getByLabelText("bus b1 interface"));
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
        servers={[]}
        localVirtualBuses={[]}
        {...NO_OPS}
      />,
    );
    const combo = screen.getByLabelText("bus b1 interface");
    openCombobox(combo);
    expect(
      screen.queryByRole("option", { name: /\(offline\)/ }),
    ).not.toBeInTheDocument();
    expect(comboboxValue(combo)).toBe(`${LOCAL_SERVER}\x00can0`);
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
        servers={[]}
        localVirtualBuses={[]}
        {...NO_OPS}
      />,
    );
    openCombobox(screen.getByLabelText("bus b1 interface"));
    expect(
      screen.getByRole("option", { name: `${REMOTE} / can0 (offline)` }),
    ).toBeInTheDocument();
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

describe("ElementRow", () => {
  const traceEl: ProjectElement = {
    kind: "trace",
    id: "el-1",
    name: "Trace 1",
    sources: ["*"],
  };

  it("shows an inline-rename input holding the name", () => {
    render(
      <ElementRow
        element={traceEl}
        panel={undefined}
        onOpen={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByLabelText("element el-1 name")).toHaveValue("Trace 1");
    // The kind isn't repeated on the row — the row sits under its
    // kind's group header in the Elements inventory.
    expect(screen.queryByText("Trace")).not.toBeInTheDocument();
  });

  it("typing in the input fires onRename with the new name", () => {
    const onRename = vi.fn();
    render(
      <ElementRow
        element={traceEl}
        panel={undefined}
        onOpen={() => {}}
        onRename={onRename}
        onRemove={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("element el-1 name"), {
      target: { value: "Cabin sweep" },
    });
    expect(onRename).toHaveBeenCalledWith("Cabin sweep");
  });

  it("offers Open when no panel exists and Focus when one does", () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <ElementRow
        element={traceEl}
        panel={undefined}
        onOpen={onOpen}
        onRename={() => {}}
        onRemove={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalled();

    const setActive = vi.fn();
    rerender(
      <ElementRow
        element={traceEl}
        panel={{ api: { setActive } } as unknown as IDockviewPanel}
        onOpen={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(setActive).toHaveBeenCalled();
  });
});
