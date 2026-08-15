// @vitest-environment jsdom
//
// What a bus row says when the server it is bound to is not one this
// machine can reach without asking. A project carries `host:port`
// references and nothing else (ADR 0032), so opening it on a machine
// that has never accepted that server has to say so — before Connect
// fails at the certificate, and in words that point at the fix.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { BusServerTrustNotice, busServerTrust } from "./ConnectionManagement";
import { ServerTrustDialogs } from "./ServerTrustDialog";
import {
  SERVER_LIST_CHANGED_EVENT,
  useAddressesNeedingTrust,
  type ServerRow,
} from "./serverList";
import type { Bus, InterfaceBinding } from "./types";

const BENCH_ADDRESS = "192.168.1.10:50051";
const BUS1: Bus = { id: "b1", name: "Powertrain" };

function serverRow(patch: Partial<ServerRow> & { address: string }): ServerRow {
  return {
    name: null,
    host: null,
    version: null,
    online: true,
    trust: "new",
    fingerprint: null,
    hasToken: false,
    insecure: false,
    manual: false,
    prompt: null,
    clock: null,
    ...patch,
  };
}

const bound = (server: string): InterfaceBinding => ({
  kind: "remote",
  server,
  interface: "can0",
  bus_id: "b1",
});

describe("what a bus's binding says about its server", () => {
  it("names a server the machine has no record of at all", () => {
    const state = busServerTrust(bound(BENCH_ADDRESS), [], new Set([BENCH_ADDRESS]));
    expect(state).toEqual({ kind: "unknown", address: BENCH_ADDRESS });
  });

  it("distinguishes a server it can see but has not accepted", () => {
    const state = busServerTrust(
      bound(BENCH_ADDRESS),
      [serverRow({ address: BENCH_ADDRESS, name: "bench-rig" })],
      new Set([BENCH_ADDRESS]),
    );
    expect(state).toEqual({ kind: "untrusted", address: BENCH_ADDRESS });
  });

  it("says nothing about a server the host reaches without asking", () => {
    // The loopback case: nothing is stored for a `--bind 127.0.0.1`
    // proxy and nothing ever will be, because it is never asked about.
    // The host's answer is what decides — an address absent from the
    // list is not on its own a problem.
    expect(busServerTrust(bound("127.0.0.1:50051"), [], new Set())).toEqual({
      kind: "ok",
    });
  });

  it("says nothing about a trusted server", () => {
    expect(
      busServerTrust(
        bound(BENCH_ADDRESS),
        [serverRow({ address: BENCH_ADDRESS, trust: "trusted" })],
        new Set(),
      ),
    ).toEqual({ kind: "ok" });
  });

  it("flags a changed identity even though no decision is pending", () => {
    // A pin carries the connection through, so the host does not ask —
    // but the certificate that came back was not the pinned one, and
    // the connection was refused. That is the loudest thing a bus row
    // can have to say.
    expect(
      busServerTrust(
        bound(BENCH_ADDRESS),
        [serverRow({ address: BENCH_ADDRESS, trust: "fingerprintChanged" })],
        new Set(),
      ),
    ).toEqual({ kind: "changed", address: BENCH_ADDRESS });
  });

  it("flags a token the server refused, which the trust state cannot carry", () => {
    // The pin is still good, so the host's trust state is `trusted` and
    // says nothing. The question it is waiting on is the fact, and a
    // bus bound to that server is where the project notices it.
    expect(
      busServerTrust(
        bound(BENCH_ADDRESS),
        [
          serverRow({
            address: BENCH_ADDRESS,
            trust: "trusted",
            hasToken: true,
            prompt: { kind: "tokenRefused" },
          }),
        ],
        new Set(),
      ),
    ).toEqual({ kind: "tokenRefused", address: BENCH_ADDRESS });
  });

  it("says nothing about a question that is only about reaching the server", () => {
    // A server that is simply not answering is the connection state's
    // to report, not the trust notice's.
    expect(
      busServerTrust(
        bound(BENCH_ADDRESS),
        [
          serverRow({
            address: BENCH_ADDRESS,
            trust: "trusted",
            prompt: { kind: "noProtection", detail: "connection reset" },
          }),
        ],
        new Set(),
      ),
    ).toEqual({ kind: "ok" });
  });

  it("matches the address the way the host keys its trust store", () => {
    expect(
      busServerTrust(
        bound(`HTTPS://${BENCH_ADDRESS.toUpperCase()}`),
        [serverRow({ address: BENCH_ADDRESS, trust: "trusted" })],
        new Set(),
      ),
    ).toEqual({ kind: "ok" });
  });

  it("says nothing about a bus with no binding, the local driver, or a virtual bus", () => {
    expect(busServerTrust(null, [], new Set())).toEqual({ kind: "ok" });
    expect(
      busServerTrust({ server: "local", interface: "can0", bus_id: "b1" }, [], new Set()),
    ).toEqual({ kind: "ok" });
    expect(
      busServerTrust(
        {
          kind: "local-virtual-bus",
          server: "local-vbus://vbus1",
          interface: "bus",
          bus_id: "b1",
        },
        [],
        new Set(["local-vbus://vbus1"]),
      ),
    ).toEqual({ kind: "ok" });
  });
});

describe("the notice on the bus row", () => {
  afterEach(cleanup);

  it("names the server and points at the panel, with a way in", () => {
    const onManageServers = vi.fn();
    render(
      <BusServerTrustNotice
        bus={BUS1}
        state={{ kind: "unknown", address: BENCH_ADDRESS }}
        onManageServers={onManageServers}
      />,
    );
    const notice = screen.getByTestId("bus-server-trust-b1");
    expect(notice).toHaveTextContent(`unknown server ${BENCH_ADDRESS}`);
    expect(notice).toHaveTextContent(/trust it in the Servers panel/i);
    fireEvent.click(screen.getByRole("button", { name: "Manage servers…" }));
    expect(onManageServers).toHaveBeenCalledTimes(1);
  });

  it("does not call a server it can see unknown", () => {
    render(
      <BusServerTrustNotice
        bus={BUS1}
        state={{ kind: "untrusted", address: BENCH_ADDRESS }}
        onManageServers={() => {}}
      />,
    );
    const notice = screen.getByTestId("bus-server-trust-b1");
    expect(notice).toHaveTextContent(/is not trusted on this machine/i);
    expect(notice).not.toHaveTextContent("unknown server");
  });

  it("says a changed identity has to be looked at, and opens nothing", () => {
    // The project view's half of the indicator ruling: the bus row says
    // what happened and points at the panel; the app's one trust dialog
    // stays shut, because nobody asked for this connection.
    render(
      <>
        <BusServerTrustNotice
          bus={BUS1}
          state={{ kind: "changed", address: BENCH_ADDRESS }}
          onManageServers={() => {}}
        />
        <ServerTrustDialogs />
      </>,
    );
    expect(screen.getByTestId("bus-server-trust-b1")).toHaveTextContent(
      /identity/i,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says a refused token has to be looked at", () => {
    render(
      <BusServerTrustNotice
        bus={BUS1}
        state={{ kind: "tokenRefused", address: BENCH_ADDRESS }}
        onManageServers={() => {}}
      />,
    );
    expect(screen.getByTestId("bus-server-trust-b1")).toHaveTextContent(
      /refused the access token/i,
    );
  });

  it("renders nothing when there is nothing to say", () => {
    render(
      <BusServerTrustNotice
        bus={BUS1}
        state={{ kind: "ok" }}
        onManageServers={() => {}}
      />,
    );
    expect(screen.queryByTestId("bus-server-trust-b1")).not.toBeInTheDocument();
  });
});

describe("asking the host which addresses need a decision", () => {
  let listeners: Record<string, (e: { payload: unknown }) => void> = {};
  let asked: string[][] = [];
  let answer: string[] = [];

  beforeEach(() => {
    listeners = {};
    asked = [];
    answer = [BENCH_ADDRESS];
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "addresses_needing_trust") {
          asked.push(args.addresses as string[]);
          return answer;
        }
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

  function Harness({ addresses }: { addresses: string[] }) {
    const needing = useAddressesNeedingTrust(addresses);
    return <span data-testid="needing">{[...needing].join(",")}</span>;
  }

  it("hands the host the addresses and renders its answer", async () => {
    render(<Harness addresses={[BENCH_ADDRESS, "127.0.0.1:50051"]} />);
    await waitFor(() =>
      expect(screen.getByTestId("needing")).toHaveTextContent(BENCH_ADDRESS),
    );
    expect(asked).toEqual([[BENCH_ADDRESS, "127.0.0.1:50051"]]);
  });

  it("re-asks when the merged list moves, which is what a trust write does", async () => {
    render(<Harness addresses={[BENCH_ADDRESS]} />);
    await waitFor(() => expect(asked).toHaveLength(1));
    answer = [];
    act(() => listeners[SERVER_LIST_CHANGED_EVENT]?.({ payload: { servers: [] } }));
    await waitFor(() =>
      expect(screen.getByTestId("needing")).toHaveTextContent(""),
    );
    expect(asked).toHaveLength(2);
  });

  it("asks nothing when no bus names a server", async () => {
    render(<Harness addresses={[]} />);
    await waitFor(() => expect(listeners[SERVER_LIST_CHANGED_EVENT]).toBeDefined());
    expect(asked).toEqual([]);
  });
});
