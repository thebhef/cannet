// @vitest-environment jsdom
//
// One collapsible section per trusted server in the Connection
// section, a sibling of "Local interfaces". A section stands open
// while one of its interfaces is chosen and is folded away otherwise,
// so the panel shows the servers a project is actually using without
// hiding the rest.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  ServerSection,
  bindingsForServer,
  keptOverrides,
  useServerSections,
} from "./ConnectionManagement";
import type { ServerRow } from "./serverList";
import type { Bus, InterfaceBinding, InterfaceRecord } from "./types";

afterEach(cleanup);

const BENCH_ADDRESS = "192.168.1.10:50051";
const DYNO_ADDRESS = "192.168.1.44:50051";

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
    manual: false,
    prompt: null,
    ...patch,
  };
}

const BENCH = serverRow({
  address: BENCH_ADDRESS,
  name: "bench-rig",
  host: "bench-rig.local",
  version: "v0.8.1",
});

const REC_CAN0: InterfaceRecord = {
  id: "can0",
  display_name: "can0 (SocketCAN)",
  fd_capable: false,
};
const REC_CAN1: InterfaceRecord = {
  id: "can1",
  display_name: "can1 (SocketCAN)",
  fd_capable: false,
};

const BUS1: Bus = { id: "b1", name: "Powertrain" };

const BOUND: InterfaceBinding = {
  kind: "remote",
  server: BENCH_ADDRESS,
  interface: "can0",
  bus_id: "b1",
};

function renderSection(over: Partial<Parameters<typeof ServerSection>[0]> = {}) {
  const props = {
    server: BENCH,
    connected: false,
    bindings: [] as readonly InterfaceBinding[],
    buses: [BUS1],
    discoveries: {
      [BENCH_ADDRESS]: {
        status: "ok" as const,
        interfaces: [REC_CAN0, REC_CAN1],
      },
    },
    connStates: {},
    expanded: true,
    onToggle: () => {},
    onRefresh: () => {},
    ...over,
  };
  return render(<ServerSection {...props} />);
}

describe("a trusted server's section", () => {
  it("names the server, the machine it runs on, and its address", () => {
    renderSection();
    expect(screen.getByText("bench-rig")).toBeInTheDocument();
    expect(screen.getByText("bench-rig.local")).toBeInTheDocument();
    expect(screen.getByText(BENCH_ADDRESS)).toBeInTheDocument();
  });

  it("lists the server's interfaces, tagging the unbound ones", () => {
    renderSection({ bindings: [BOUND] });
    expect(screen.getByText("can0 (SocketCAN)")).toBeInTheDocument();
    expect(screen.getByText("Powertrain")).toBeInTheDocument();
    expect(screen.getByText("can1 (SocketCAN)")).toBeInTheDocument();
    expect(screen.getByText("(unassigned)")).toBeInTheDocument();
  });

  it("shows no interface rows while it is collapsed", () => {
    renderSection({ bindings: [BOUND], expanded: false });
    expect(screen.queryByText("can0 (SocketCAN)")).not.toBeInTheDocument();
    // The header still says which server it is, and stands ready to open.
    expect(screen.getByText("bench-rig")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `interfaces on ${BENCH_ADDRESS}` }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("greys a trusted server that is switched off, with a note and no rows", () => {
    const { container } = renderSection({
      server: serverRow({ address: BENCH_ADDRESS, name: "bench-rig", online: false }),
      discoveries: {},
    });
    expect(container.querySelector(".project-server.offline")).not.toBeNull();
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(screen.getByText(/not advertising/)).toBeInTheDocument();
    expect(screen.queryByText("can0 (SocketCAN)")).not.toBeInTheDocument();
    // Nothing to ask an unreachable server for.
    expect(
      screen.queryByRole("button", { name: `discover interfaces on ${BENCH_ADDRESS}` }),
    ).not.toBeInTheDocument();
  });

  it("says a live connection is live, and re-asks on Discover", () => {
    const onRefresh = vi.fn();
    renderSection({ connected: true, onRefresh });
    expect(screen.getByText("connected")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: `discover interfaces on ${BENCH_ADDRESS}` }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("surfaces a server that answered with an error rather than going blank", () => {
    renderSection({
      discoveries: { [BENCH_ADDRESS]: { status: "err", error: "connection refused" } },
    });
    // In the header, and again where the interfaces would have been.
    expect(screen.getByText("unreachable: connection refused")).toBeInTheDocument();
    expect(screen.getByText("(unreachable: connection refused)")).toBeInTheDocument();
  });
});

describe("which bindings belong to a server", () => {
  it("matches the address the way the host keys its trust store", () => {
    const bindings: InterfaceBinding[] = [
      BOUND,
      { kind: "remote", server: `https://${BENCH_ADDRESS.toUpperCase()}`, interface: "can1", bus_id: "b2" },
      { kind: "remote", server: DYNO_ADDRESS, interface: "can0", bus_id: "b3" },
      { server: "local", interface: "can0", bus_id: "b4" },
    ];
    expect(
      bindingsForServer(bindings, BENCH_ADDRESS).map((b) => b.bus_id),
    ).toEqual(["b1", "b2"]);
  });
});

/// A section list driven by the chosen-interface rule, the way the
/// project panel drives it.
function Harness({ chosen }: { chosen: Record<string, boolean> }) {
  const sections = useServerSections(chosen);
  return (
    <>
      {[BENCH, serverRow({ address: DYNO_ADDRESS, name: "dyno-cell" })].map((server) => (
        <ServerSection
          key={server.address}
          server={server}
          connected={false}
          bindings={[]}
          buses={[BUS1]}
          discoveries={{
            [server.address]: { status: "ok", interfaces: [REC_CAN0] },
          }}
          connStates={{}}
          expanded={sections.expanded(server.address)}
          onToggle={() => sections.toggle(server.address)}
          onRefresh={() => {}}
        />
      ))}
    </>
  );
}

function toggleFor(address: string): HTMLElement {
  return screen.getByRole("button", { name: `interfaces on ${address}` });
}

describe("the chosen-interface rule", () => {
  it("opens the sections whose interfaces a bus uses, and folds the rest", () => {
    render(<Harness chosen={{ [BENCH_ADDRESS]: true, [DYNO_ADDRESS]: false }} />);
    expect(toggleFor(BENCH_ADDRESS)).toHaveAttribute("aria-expanded", "true");
    expect(toggleFor(DYNO_ADDRESS)).toHaveAttribute("aria-expanded", "false");
  });

  it("lets the user fold a chosen section, and keeps it folded", () => {
    const chosen = { [BENCH_ADDRESS]: true, [DYNO_ADDRESS]: false };
    const { rerender } = render(<Harness chosen={chosen} />);
    fireEvent.click(toggleFor(BENCH_ADDRESS));
    expect(toggleFor(BENCH_ADDRESS)).toHaveAttribute("aria-expanded", "false");
    // A re-render with the same answer must not undo the user's fold.
    rerender(<Harness chosen={{ ...chosen }} />);
    expect(toggleFor(BENCH_ADDRESS)).toHaveAttribute("aria-expanded", "false");
  });

  it("hands the section back to the rule when the rule's own answer moves", () => {
    const { rerender } = render(
      <Harness chosen={{ [BENCH_ADDRESS]: true, [DYNO_ADDRESS]: false }} />,
    );
    fireEvent.click(toggleFor(BENCH_ADDRESS));
    expect(toggleFor(BENCH_ADDRESS)).toHaveAttribute("aria-expanded", "false");
    // The bus lets go of the interface: the manual fold has nothing
    // left to override.
    rerender(<Harness chosen={{ [BENCH_ADDRESS]: false, [DYNO_ADDRESS]: false }} />);
    expect(toggleFor(BENCH_ADDRESS)).toHaveAttribute("aria-expanded", "false");
    // …and choosing one again opens it, rather than restoring the fold.
    rerender(<Harness chosen={{ [BENCH_ADDRESS]: true, [DYNO_ADDRESS]: false }} />);
    expect(toggleFor(BENCH_ADDRESS)).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a folded-away section on demand", () => {
    render(<Harness chosen={{ [BENCH_ADDRESS]: false, [DYNO_ADDRESS]: false }} />);
    fireEvent.click(toggleFor(DYNO_ADDRESS));
    expect(toggleFor(DYNO_ADDRESS)).toHaveAttribute("aria-expanded", "true");
  });
});

describe("keptOverrides", () => {
  it("keeps an override while its server's answer holds still", () => {
    const overrides = { a: false };
    expect(keptOverrides(overrides, { a: true }, { a: true })).toBe(overrides);
  });

  it("drops the override for a server whose answer moved, and no other", () => {
    expect(
      keptOverrides({ a: false, b: true }, { a: true, b: false }, { a: false, b: false }),
    ).toEqual({ b: true });
  });

  it("forgets a server that is no longer listed", () => {
    expect(keptOverrides({ a: false }, { a: true }, {})).toEqual({});
  });
});
