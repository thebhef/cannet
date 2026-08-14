// @vitest-environment jsdom
//
// The Servers panel: one merged list over the host's model, and the
// trust lifecycle over it (ADR 0041). The panel renders what
// `server_list.rs` computed — badges, offline greying, browse health —
// and never re-derives any of it, so these tests feed host snapshots
// and assert on what reaches the screen.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { ServersPanel } from "./ServersPanel";
import {
  SERVER_LIST_CHANGED_EVENT,
  type BrowseStatus,
  type ServerList,
  type ServerRow,
} from "./serverList";

const row = (over: Partial<ServerRow>): ServerRow => ({
  address: "192.168.1.10:50051",
  name: "bench-rig",
  host: "bench-rig.local",
  version: "v0.8.1",
  online: true,
  trust: "new",
  fingerprint: null,
  hasToken: false,
  insecure: false,
  manual: false,
  prompt: null,
  clock: null,
  ...over,
});

const BENCH = row({});
const DYNO = row({
  address: "192.168.1.44:50051",
  name: "dyno-cell",
  host: "dyno-cell.local",
  version: "v0.8.0",
});
const PINNED = row({
  address: "rippy:50051",
  trust: "trusted",
  fingerprint: "SHA256:qF3RmA",
  hasToken: true,
});
const OFFLINE = row({
  address: "spare:50051",
  name: null,
  host: null,
  version: null,
  online: false,
  trust: "trusted",
  fingerprint: "SHA256:zzz",
});

/// Every `invoke` the panel made, in order.
let calls: { cmd: string; args: Record<string, unknown> }[] = [];
/// The registered listeners, so a test can push a host event.
let listeners: Record<string, (e: { payload: unknown }) => void> = {};
/// What `get_server_list` answers with.
let snapshot: ServerList;

function emit(event: string, payload: unknown) {
  act(() => listeners[event]?.({ payload }));
}

function list(servers: ServerRow[], browse: BrowseStatus = { state: "running" }) {
  return { servers, browse };
}

beforeEach(() => {
  calls = [];
  listeners = {};
  snapshot = list([BENCH, DYNO]);
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args: args ?? {} });
      if (cmd === "get_server_list") return snapshot;
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

function renderPanel() {
  render(<ServersPanel {...({} as IDockviewPanelProps)} />);
}

/// The row element for `address`, found through the button that always
/// exists on it.
function rowFor(address: string): HTMLElement {
  const node = screen.getByText(address).closest(".server-row");
  if (!node) throw new Error(`no row for ${address}`);
  return node as HTMLElement;
}

describe("the merged server list", () => {
  it("shows what the host merged: name, host name, address, version, badge", async () => {
    renderPanel();
    await screen.findByText("192.168.1.10:50051");
    const bench = rowFor("192.168.1.10:50051");
    expect(bench).toHaveTextContent("bench-rig");
    expect(bench).toHaveTextContent("bench-rig.local");
    expect(bench).toHaveTextContent("v0.8.1");
    expect(bench).toHaveTextContent("new");
  });

  it("follows the host's change event rather than polling", async () => {
    renderPanel();
    await screen.findByText("192.168.1.10:50051");
    emit(SERVER_LIST_CHANGED_EVENT, list([DYNO]));
    await waitFor(() =>
      expect(screen.queryByText("192.168.1.10:50051")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("192.168.1.44:50051")).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "get_server_list")).toHaveLength(1);
  });

  it("greys a trusted server that is not advertising instead of hiding it", async () => {
    // Forgetting a server must not require waiting for it to come back.
    snapshot = list([BENCH, OFFLINE]);
    renderPanel();
    await screen.findByText("spare:50051");
    expect(rowFor("spare:50051")).toHaveClass("offline");
    expect(rowFor("192.168.1.10:50051")).not.toHaveClass("offline");
  });

  it("shows the accepted fingerprint verbatim, so it can be compared again", async () => {
    snapshot = list([PINNED]);
    renderPanel();
    await screen.findByText("rippy:50051");
    const pinned = rowFor("rippy:50051");
    expect(pinned).toHaveTextContent("SHA256:qF3RmA");
    expect(pinned).toHaveTextContent("trusted");
    expect(pinned).toHaveTextContent("token stored");
  });

  it("says a server accepted without protection is unprotected, not trusted", async () => {
    snapshot = list([
      row({ address: "open:50051", trust: "trusted", insecure: true }),
    ]);
    renderPanel();
    await screen.findByText("open:50051");
    const open = rowFor("open:50051");
    expect(open).toHaveTextContent("unprotected");
    expect(open).toHaveTextContent("connects without protection");
  });

  it("offers no trust actions on a server that is reached without asking", async () => {
    // The host reaches loopback in the clear and never asks about it,
    // so its row is trusted with nothing stored: there is no identity
    // to accept, no token that would ever be presented, and nothing to
    // forget.
    snapshot = list([row({ address: "127.0.0.1:50051", trust: "trusted" })]);
    renderPanel();
    await screen.findByText("127.0.0.1:50051");
    const local = within(rowFor("127.0.0.1:50051"));
    expect(local.queryByRole("button", { name: /^trust/ })).not.toBeInTheDocument();
    expect(
      local.queryByRole("button", { name: /^set token/ }),
    ).not.toBeInTheDocument();
    expect(local.queryByRole("button", { name: /^forget/ })).not.toBeInTheDocument();
  });

  it("filters with a fuzzy search over names, host names, and addresses", async () => {
    renderPanel();
    await screen.findByText("192.168.1.10:50051");
    fireEvent.change(screen.getByLabelText("search servers"), {
      target: { value: "dyno" },
    });
    await waitFor(() =>
      expect(screen.queryByText("192.168.1.10:50051")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("192.168.1.44:50051")).toBeInTheDocument();
  });
});

describe("what an empty list is saying", () => {
  it("distinguishes a quiet network from a browse that never started", async () => {
    snapshot = list([], { state: "running" });
    renderPanel();
    expect(await screen.findByText(/No servers are advertising/)).toBeInTheDocument();

    cleanup();
    snapshot = list([], { state: "failed", detail: "address in use" });
    renderPanel();
    const failed = await screen.findByRole("status");
    expect(failed).toHaveTextContent("could not start");
    expect(failed).toHaveTextContent("address in use");
    // The reassuring "nothing is advertising" line must not appear
    // under a browse that is not listening at all.
    expect(screen.queryByText(/No servers are advertising/)).not.toBeInTheDocument();
  });

  it("says discovery may be blocked when the browse reported an error", async () => {
    snapshot = list([], { state: "degraded", detail: "send failed on eth0" });
    renderPanel();
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("blocked");
    expect(notice).toHaveTextContent("send failed on eth0");
    expect(notice).toHaveClass("servers-notice-warn");
  });
});

describe("adding a server by address", () => {
  /// Open the add form and submit `address` through it.
  async function add(address: string) {
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));
    fireEvent.change(await screen.findByLabelText("server address"), {
      target: { value: address },
    });
    fireEvent.click(screen.getByLabelText("add this server"));
  }

  it("dials the typed address and answers the question that comes back", async () => {
    // Discovery is multicast, so a server on another subnet reaches the
    // panel only this way: the address is dialled, the attempt is
    // refused at the certificate, and the question it raised is what the
    // host puts on the new row.
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        if (cmd === "get_server_list") return snapshot;
        if (cmd === "add_server") return "bench.example.com:50051";
        return undefined;
      },
    );
    renderPanel();
    await screen.findByText("192.168.1.10:50051");
    await add("bench.example.com:50051");

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.cmd === "add_server" &&
            c.args.address === "bench.example.com:50051",
        ),
      ).toBe(true),
    );
    emit(
      SERVER_LIST_CHANGED_EVENT,
      list([
        BENCH,
        row({
          address: "bench.example.com:50051",
          name: null,
          host: null,
          version: null,
          online: false,
          prompt: { kind: "acceptIdentity", observed: "SHA256:ccc" },
        }),
      ]),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("SHA256:ccc");
    expect(dialog).toHaveTextContent("bench.example.com:50051");
  });

  it("says what went wrong when the address could not be added", async () => {
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        if (cmd === "get_server_list") return snapshot;
        if (cmd === "add_server") throw "transport error: connection refused";
        return undefined;
      },
    );
    renderPanel();
    await screen.findByText("192.168.1.10:50051");
    await add("bench.example.com:50051");

    expect(await screen.findByText(/connection refused/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("refuses an address that is not host:port without dialling anything", async () => {
    renderPanel();
    await screen.findByText("192.168.1.10:50051");
    await add("bench.example.com");

    expect(await screen.findByText(/host:port/)).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "add_server")).toBe(false);
  });

  it("points at the row a server already has instead of adding it twice", async () => {
    renderPanel();
    await screen.findByText("192.168.1.10:50051");
    await add("https://192.168.1.10:50051");

    await waitFor(() =>
      expect(rowFor("192.168.1.10:50051")).toHaveClass("highlight"),
    );
    expect(screen.getByText(/already in the list/)).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "add_server")).toBe(false);
  });

  it("keeps a server that is reached without any question in the list", async () => {
    // A loopback proxy started --no-mdns: nothing advertises it and
    // nothing is ever asked about it, so the operator's act of adding it
    // is the only thing keeping it there — and the only thing to undo.
    snapshot = list([
      row({
        address: "127.0.0.1:50052",
        name: null,
        host: null,
        version: null,
        online: false,
        trust: "trusted",
        manual: true,
      }),
    ]);
    renderPanel();
    await screen.findByText("127.0.0.1:50052");
    const local = rowFor("127.0.0.1:50052");
    expect(local).toHaveClass("offline");
    expect(local).toHaveTextContent("trusted");
    expect(
      within(local).getByRole("button", { name: /^forget/ }),
    ).toBeInTheDocument();
  });
});

describe("the trust lifecycle from a row", () => {
  it("trusting dials the server first, then shows what it presented", async () => {
    // The fingerprint pinned has to be the one this attempt observed —
    // never something remembered from an earlier look.
    renderPanel();
    await screen.findByText("192.168.1.10:50051");
    fireEvent.click(screen.getByLabelText("trust 192.168.1.10:50051"));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.cmd === "refresh_interfaces" &&
            c.args.address === "192.168.1.10:50051",
        ),
      ).toBe(true),
    );
    // The refused attempt left a question on the row; the panel raises
    // the same dialog the connect flow would have.
    emit(
      SERVER_LIST_CHANGED_EVENT,
      list([
        row({ prompt: { kind: "acceptIdentity", observed: "SHA256:bbb" } }),
        DYNO,
      ]),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("SHA256:bbb");
    expect(dialog).toHaveTextContent("192.168.1.10:50051");
  });

  it("offers to review a row whose identity changed, with both fingerprints", async () => {
    snapshot = list([
      row({
        address: "rippy:50051",
        trust: "fingerprintChanged",
        fingerprint: "SHA256:aaa",
        prompt: {
          kind: "identityChanged",
          expected: "SHA256:aaa",
          observed: "SHA256:bbb",
        },
      }),
    ]);
    renderPanel();
    await screen.findByText("rippy:50051");
    expect(rowFor("rippy:50051")).toHaveTextContent("identity changed");
    fireEvent.click(screen.getByLabelText("trust rippy:50051"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("SHA256:aaa");
    expect(dialog).toHaveTextContent("SHA256:bbb");
  });

  it("stores a replacement token for a trusted server", async () => {
    snapshot = list([PINNED]);
    renderPanel();
    await screen.findByText("rippy:50051");
    fireEvent.click(screen.getByLabelText("set token for rippy:50051"));
    fireEvent.change(await screen.findByLabelText("access token for rippy:50051"), {
      target: { value: "chug-pruning-unclad-hazard-morphine" },
    });
    fireEvent.click(screen.getByLabelText("save token for rippy:50051"));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.cmd === "set_server_token" &&
            c.args.address === "rippy:50051" &&
            c.args.token === "chug-pruning-unclad-hazard-morphine",
        ),
      ).toBe(true),
    );
  });

  it("forgets a server, and offers that only where something is stored", async () => {
    snapshot = list([BENCH, PINNED]);
    renderPanel();
    await screen.findByText("rippy:50051");
    expect(
      within(rowFor("192.168.1.10:50051")).queryByRole("button", { name: /forget/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("forget rippy:50051"));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.cmd === "forget_server" && c.args.address === "rippy:50051",
        ),
      ).toBe(true),
    );
  });

  it("reports a refused write instead of pretending it landed", async () => {
    snapshot = list([PINNED]);
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        if (cmd === "get_server_list") return snapshot;
        if (cmd === "forget_server") throw "servers.json is read-only";
        return undefined;
      },
    );
    renderPanel();
    await screen.findByText("rippy:50051");
    fireEvent.click(screen.getByLabelText("forget rippy:50051"));
    expect(await screen.findByText(/read-only/)).toBeInTheDocument();
  });
});
