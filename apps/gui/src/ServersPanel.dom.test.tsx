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
import { ServerTrustDialogs } from "./ServerTrustDialog";
import { clearServerTrust } from "./serverTrust";
import type { ServerPrompts, TrustPrompt } from "./serverTrust";
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

afterEach(() => {
  clearServerTrust();
  cleanup();
});

function renderPanel() {
  render(<ServersPanel {...({} as IDockviewPanelProps)} />);
}

/// The panel beside the app-wide trust dialog, which is where every
/// question the panel raises is answered — the shape `App.tsx` mounts.
function renderWithDialog() {
  render(
    <>
      <ServersPanel {...({} as IDockviewPanelProps)} />
      <ServerTrustDialogs />
    </>,
  );
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

  it("asks nothing about a server it reaches without asking, but still acts on it", async () => {
    // The host reaches loopback in the clear, so there is no identity
    // to accept and the row wears no *Trust…*. Every other action is
    // still on it: a row the user can see is a row the user can act on,
    // whatever the store happens to hold for it.
    snapshot = list([row({ address: "127.0.0.1:50051", trust: "trusted" })]);
    renderPanel();
    await screen.findByText("127.0.0.1:50051");
    const local = within(rowFor("127.0.0.1:50051"));
    expect(local.queryByRole("button", { name: /^trust/ })).not.toBeInTheDocument();
    expect(local.getByRole("button", { name: /^set token/ })).toBeInTheDocument();
    expect(local.getByRole("button", { name: /^forget/ })).toBeInTheDocument();
  });

  it("keeps two servers of the same name apart on their own rows", async () => {
    // Ambiguity is not acceptable: DNS name, address and fingerprint
    // are all on the row, so two servers advertising one name are still
    // two rows saying which is which.
    snapshot = list([
      row({
        address: "10.0.0.1:50051",
        name: "bench-rig",
        host: "bench-a.local",
        trust: "trusted",
        fingerprint: "SHA256:aaa",
      }),
      row({
        address: "10.0.0.2:50051",
        name: "bench-rig",
        host: "bench-b.local",
        trust: "trusted",
        fingerprint: "SHA256:bbb",
      }),
    ]);
    renderPanel();
    await screen.findByText("10.0.0.1:50051");
    expect(screen.getAllByText("bench-rig")).toHaveLength(2);
    const first = rowFor("10.0.0.1:50051");
    const second = rowFor("10.0.0.2:50051");
    expect(first).not.toBe(second);
    expect(first).toHaveTextContent("bench-a.local");
    expect(first).toHaveTextContent("SHA256:aaa");
    expect(second).toHaveTextContent("bench-b.local");
    expect(second).toHaveTextContent("SHA256:bbb");
    // …and every action on a row is addressed by that row's server.
    expect(
      within(first).getByRole("button", { name: "forget 10.0.0.1:50051" }),
    ).toBeInTheDocument();
    expect(
      within(second).getByRole("button", { name: "forget 10.0.0.2:50051" }),
    ).toBeInTheDocument();
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

  it("dials the typed address and leaves nothing behind until it is accepted", async () => {
    // Discovery is multicast, so a server on another subnet reaches the
    // panel only this way: the address is dialled and the attempt is
    // refused at the certificate. The question that raised is the trust
    // dialog's (it is mounted app-wide, over every question the host is
    // waiting on) — the list stays what is advertising plus what has
    // been accepted, so an unanswered address is in neither.
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
    emit(SERVER_LIST_CHANGED_EVENT, list([BENCH]));
    expect(screen.queryByText("bench.example.com:50051")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // …and the field is clear, because retrying is typing it again.
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));
    expect(await screen.findByLabelText("server address")).toHaveValue("");
  });

  it("puts the question the typed address raised in the app-wide dialog", async () => {
    // Typing an address and pressing Add is direct user input, so the
    // question it raises is one the user is waiting on — the one case a
    // modal is for.
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        if (cmd === "get_server_list") return snapshot;
        if (cmd === "add_server") return "bench.example.com:50051";
        if (cmd === "get_server_prompts")
          return {
            "bench.example.com:50051": {
              kind: "acceptIdentity",
              observed: "SHA256:ddd",
            },
          } satisfies ServerPrompts;
        return undefined;
      },
    );
    renderWithDialog();
    await screen.findByText("192.168.1.10:50051");
    await add("bench.example.com:50051");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("SHA256:ddd");
    expect(dialog).toHaveTextContent("bench.example.com:50051");
  });

  it("shows the server once its identity has been accepted", async () => {
    // Accepting the question the dial raised is what stores anything,
    // and the store is what the row is made of.
    renderPanel();
    await screen.findByText("192.168.1.10:50051");
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
          trust: "trusted",
          fingerprint: "SHA256:ccc",
        }),
      ]),
    );
    const added = rowFor("bench.example.com:50051");
    expect(added).toHaveTextContent("trusted");
    expect(added).toHaveTextContent("SHA256:ccc");
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
    // never something remembered from an earlier look. The host is
    // waiting on nothing until the dial is refused, so the panel dials
    // and then asks what that raised.
    let prompts: ServerPrompts = {};
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        if (cmd === "get_server_list") return snapshot;
        if (cmd === "get_server_prompts") return prompts;
        if (cmd === "refresh_interfaces") {
          prompts = {
            "192.168.1.10:50051": {
              kind: "acceptIdentity",
              observed: "SHA256:bbb",
            },
          };
          throw "the server's identity has not been accepted";
        }
        return undefined;
      },
    );
    renderWithDialog();
    await screen.findByText("192.168.1.10:50051");
    fireEvent.click(screen.getByLabelText("trust 192.168.1.10:50051"));
    const dialog = await screen.findByRole("dialog");
    expect(
      calls.some(
        (c) =>
          c.cmd === "refresh_interfaces" &&
          c.args.address === "192.168.1.10:50051",
      ),
    ).toBe(true);
    expect(dialog).toHaveTextContent("SHA256:bbb");
    expect(dialog).toHaveTextContent("192.168.1.10:50051");
  });

  it("reviews a row's question in the one app-wide dialog, without re-dialling", async () => {
    // The re-raise path. The question the host is already waiting on is
    // a real observation from the attempt that made it, so reviewing it
    // must not depend on the server still being reachable — and there
    // is exactly one dialog on screen, because there is one mount.
    const prompt: TrustPrompt = {
      kind: "identityChanged",
      expected: "SHA256:aaa",
      observed: "SHA256:bbb",
    };
    snapshot = list([
      row({
        address: "rippy:50051",
        trust: "fingerprintChanged",
        fingerprint: "SHA256:aaa",
        prompt,
      }),
    ]);
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        if (cmd === "get_server_list") return snapshot;
        if (cmd === "get_server_prompts") return { "rippy:50051": prompt };
        return undefined;
      },
    );
    renderWithDialog();
    await screen.findByText("rippy:50051");
    expect(rowFor("rippy:50051")).toHaveTextContent("identity changed");
    fireEvent.click(screen.getByLabelText("review rippy:50051"));
    const dialogs = await screen.findAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveTextContent("SHA256:aaa");
    expect(dialogs[0]).toHaveTextContent("SHA256:bbb");
    expect(calls.some((c) => c.cmd === "refresh_interfaces")).toBe(false);
  });

  it("mounts no dialog of its own", async () => {
    // One dialog implementation, one mount: the panel raises the
    // app-wide one, so two modals over the same question are impossible
    // by construction rather than by care.
    const prompt: TrustPrompt = {
      kind: "identityChanged",
      expected: "SHA256:aaa",
      observed: "SHA256:bbb",
    };
    snapshot = list([
      row({ address: "rippy:50051", trust: "fingerprintChanged", prompt }),
    ]);
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        if (cmd === "get_server_list") return snapshot;
        if (cmd === "get_server_prompts") return { "rippy:50051": prompt };
        return undefined;
      },
    );
    renderPanel();
    await screen.findByText("rippy:50051");
    fireEvent.click(screen.getByLabelText("review rippy:50051"));
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "get_server_prompts")).toBe(true),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

  it("forgets a server", async () => {
    snapshot = list([BENCH, PINNED]);
    renderPanel();
    await screen.findByText("rippy:50051");
    fireEvent.click(screen.getByLabelText("forget rippy:50051"));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.cmd === "forget_server" && c.args.address === "rippy:50051",
        ),
      ).toBe(true),
    );
    expect(screen.queryByText(/Nothing was stored/)).not.toBeInTheDocument();
  });

  it("changes the token on a row that has one without a pin", async () => {
    // A token stored against a server whose certificate was never
    // accepted: the store holds a credential, and gating the token
    // field on the fingerprint left no way to replace or clear it.
    snapshot = list([row({ address: "rippy:50051", hasToken: true })]);
    renderPanel();
    await screen.findByText("rippy:50051");
    fireEvent.click(screen.getByLabelText("set token for rippy:50051"));
    fireEvent.change(await screen.findByLabelText("access token for rippy:50051"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByLabelText("save token for rippy:50051"));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.cmd === "set_server_token" &&
            c.args.address === "rippy:50051" &&
            c.args.token === "",
        ),
      ).toBe(true),
    );
  });

  it("says what keeps a row in the list when forgetting it stored nothing", async () => {
    // A server a session is connected to, with nothing stored behind it
    // — the operator's own loopback proxy, reached in the clear and so
    // never asked about. Forgetting is offered (no row is a dead end)
    // and it answers rather than silently doing nothing.
    snapshot = list([
      row({
        address: "127.0.0.1:50051",
        name: null,
        host: null,
        version: null,
        online: false,
        trust: "trusted",
        clock: { offsetNs: 739_200_000, warn: true, stale: false },
      }),
    ]);
    renderPanel();
    await screen.findByText("127.0.0.1:50051");
    fireEvent.click(screen.getByLabelText("forget 127.0.0.1:50051"));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.cmd === "forget_server" && c.args.address === "127.0.0.1:50051",
        ),
      ).toBe(true),
    );
    const note = await screen.findByText(/Nothing was stored for 127.0.0.1:50051/);
    expect(note).toHaveTextContent(/session is connected to it/);
  });

  it("says an advertising row is held by the network, not the store", async () => {
    snapshot = list([BENCH]);
    renderPanel();
    await screen.findByText("192.168.1.10:50051");
    fireEvent.click(screen.getByLabelText("forget 192.168.1.10:50051"));
    const note = await screen.findByText(/Nothing was stored for 192.168.1.10:50051/);
    expect(note).toHaveTextContent(/advertising on this network/);
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
