// @vitest-environment jsdom
//
// The browsed-server list inside the "Add server…" form: what the host's
// mDNS browse found, beside the field where an address is typed. The
// two are one path — picking a row fills the same field and runs the
// same interface pull — because discovery is convenience only
// (ADR 0040) and must not become a second way to reach a server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { AddServerInline } from "./ConnectionManagement";
import { DISCOVERED_SERVERS_CHANGED_EVENT } from "./serverDiscovery";
import type { DiscoveredServer } from "./serverDiscovery";
import type { InterfaceRecord } from "./types";

const BENCH: DiscoveredServer = {
  fullname: "bench-rig._cannet._tcp.local.",
  name: "bench-rig",
  address: "192.168.1.10:50051",
  version: "v0.8.1",
};
const DYNO: DiscoveredServer = {
  fullname: "dyno-cell._cannet._tcp.local.",
  name: "dyno-cell",
  address: "192.168.1.44:50051",
  version: "v0.8.0",
};
const REC_CAN0: InterfaceRecord = {
  id: "can0",
  display_name: "can0 (SocketCAN)",
  fd_capable: false,
};

/// Every `invoke` the form made, in order.
let calls: { cmd: string; args: Record<string, unknown> }[] = [];
/// The registered listeners, so a test can push a host event.
let listeners: Record<string, (e: { payload: unknown }) => void> = {};

function emit(event: string, payload: unknown) {
  act(() => listeners[event]?.({ payload }));
}

beforeEach(() => {
  calls = [];
  listeners = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args: args ?? {} });
      if (cmd === "get_discovered_servers") return [BENCH, DYNO];
      if (cmd === "refresh_interfaces") return [REC_CAN0];
      return undefined;
    },
  );
  listenMock.mockReset();
  listenMock.mockImplementation(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      listeners[event] = handler;
      return () => {
        delete listeners[event];
      };
    },
  );
});

afterEach(cleanup);

function renderForm() {
  const onPick = vi.fn();
  render(<AddServerInline busLabel="Bus 1" onCancel={() => {}} onPick={onPick} />);
  return { onPick };
}

describe("the browsed-server list beside manual entry", () => {
  it("lists what the host browsed, with its address and version", async () => {
    renderForm();
    const row = await screen.findByRole("button", { name: /bench-rig/ });
    expect(row).toHaveTextContent("192.168.1.10:50051");
    expect(row).toHaveTextContent("v0.8.1");
    expect(screen.getByRole("button", { name: /dyno-cell/ })).toBeInTheDocument();
  });

  it("follows the host's change event rather than polling", async () => {
    renderForm();
    await screen.findByRole("button", { name: /bench-rig/ });
    // A server shut down and a new one appeared: the host pushes the
    // whole list and the view renders exactly it.
    emit(DISCOVERED_SERVERS_CHANGED_EVENT, [DYNO]);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /bench-rig/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /dyno-cell/ })).toBeInTheDocument();
    // Nothing re-asked the host for the list.
    expect(calls.filter((c) => c.cmd === "get_discovered_servers")).toHaveLength(1);
  });

  it("filters the list with a fuzzy search over names and addresses", async () => {
    renderForm();
    await screen.findByRole("button", { name: /bench-rig/ });
    fireEvent.change(screen.getByLabelText("search discovered servers"), {
      target: { value: "dyno" },
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /bench-rig/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /dyno-cell/ })).toBeInTheDocument();
  });

  it("picking a server fills the address field and pulls its interfaces", async () => {
    // The point of the whole surface: a discovered server enters the
    // form as an address, so everything downstream — including the
    // trust flow — is identical to having typed it.
    const { onPick } = renderForm();
    fireEvent.click(await screen.findByRole("button", { name: /bench-rig/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("server address")).toHaveValue(BENCH.address),
    );
    expect(
      calls.some(
        (c) => c.cmd === "refresh_interfaces" && c.args.address === BENCH.address,
      ),
    ).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Bind to Bus 1" }));
    expect(onPick).toHaveBeenCalledWith({ server: BENCH.address, iface: "can0" });
  });

  it("says manual entry is still the way when nothing is advertising", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      calls.push({ cmd, args: {} });
      if (cmd === "get_discovered_servers") return [];
      return undefined;
    });
    renderForm();
    // A server beyond this subnet never appears in a browse, and one
    // that was killed lingers up to its TTL — the field above is the
    // answer to both, and the empty state has to say so.
    expect(await screen.findByText(/type its address above/i)).toBeInTheDocument();
    expect(
      screen.queryByLabelText("search discovered servers"),
    ).not.toBeInTheDocument();
  });
});
