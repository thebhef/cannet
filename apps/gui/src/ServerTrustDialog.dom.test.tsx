// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ServerTrustDialog, ServerTrustDialogs } from "./ServerTrustDialog";
import type { ServerPrompts, TrustPrompt } from "./serverTrust";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

/// Every `invoke` this dialog makes, in order — the assertion surface
/// for "what did the host actually get told".
let calls: { cmd: string; args: Record<string, unknown> }[] = [];

beforeEach(() => {
  calls = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args: args ?? {} });
      if (cmd === "get_server_prompts") return {};
      return undefined;
    },
  );
  listenMock.mockReset();
  listenMock.mockImplementation(async () => () => {});
});

afterEach(cleanup);

function renderDialog(prompt: TrustPrompt, address = "bench.example.com:50051") {
  const onDismiss = vi.fn();
  render(
    <ServerTrustDialog address={address} prompt={prompt} onDismiss={onDismiss} />,
  );
  return { onDismiss };
}

describe("the trust-on-first-use dialog", () => {
  it("shows the fingerprint verbatim, in the form the server printed", () => {
    // Comparing this string against the server's console line *is* the
    // security check, so it must not be abbreviated or reformatted.
    const observed = "SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc";
    renderDialog({ kind: "acceptIdentity", observed });
    expect(screen.getByText(observed)).toBeInTheDocument();
    expect(screen.getByText("bench.example.com:50051")).toBeInTheDocument();
  });

  it("pins what was observed and stores the pasted token on accept", async () => {
    const observed = "SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc";
    renderDialog({ kind: "acceptIdentity", observed });

    fireEvent.change(screen.getByLabelText("access token"), {
      target: { value: "KMGqFEndqRji" },
    });
    fireEvent.click(screen.getByText("Accept and connect"));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      cmd: "accept_server_fingerprint",
      args: {
        address: "bench.example.com:50051",
        fingerprint: observed,
        token: "KMGqFEndqRji",
      },
    });
  });

  it("accepts an identity with no token when the field is left empty", async () => {
    renderDialog({ kind: "acceptIdentity", observed: "SHA256:aaa" });
    fireEvent.click(screen.getByText("Accept and connect"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].args.token).toBeNull();
  });

  it("stores nothing when the user cancels", async () => {
    const { onDismiss } = renderDialog({
      kind: "acceptIdentity",
      observed: "SHA256:aaa",
    });
    fireEvent.click(screen.getByText("Cancel"));
    expect(onDismiss).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("stores nothing when the user presses Escape", () => {
    const { onDismiss } = renderDialog({
      kind: "acceptIdentity",
      observed: "SHA256:aaa",
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe("the changed-identity warning", () => {
  const prompt: TrustPrompt = {
    kind: "identityChanged",
    expected: "SHA256:oldoldold",
    observed: "SHA256:newnewnew",
  };

  it("shows both fingerprints so the user can see what moved", () => {
    renderDialog(prompt);
    expect(screen.getByText("SHA256:oldoldold")).toBeInTheDocument();
    expect(screen.getByText("SHA256:newnewnew")).toBeInTheDocument();
  });

  it("re-accepting overwrites the pin with what was presented", async () => {
    renderDialog(prompt);
    fireEvent.click(screen.getByText("Accept the new identity"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].cmd).toBe("accept_server_fingerprint");
    expect(calls[0].args.fingerprint).toBe("SHA256:newnewnew");
  });

  it("offers no way to connect without re-accepting", () => {
    renderDialog(prompt);
    // The only two exits are re-accept and cancel — a mismatch never
    // falls back to plaintext or to the old pin.
    expect(screen.queryByText("Connect without protection")).toBeNull();
  });
});

describe("the refused-token dialog", () => {
  it("replaces the stored token and shows no fingerprint", async () => {
    renderDialog({ kind: "tokenRefused" });
    expect(screen.queryByText(/^SHA256:/)).toBeNull();

    fireEvent.change(screen.getByLabelText("access token"), {
      target: { value: "fresh-token" },
    });
    fireEvent.click(screen.getByText("Save token"));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      cmd: "set_server_token",
      args: { address: "bench.example.com:50051", token: "fresh-token" },
    });
  });
});

describe("the unprotected-connection choice", () => {
  const prompt: TrustPrompt = {
    kind: "noProtection",
    detail: "transport error: connection reset",
  };

  it("names the transport error and asks for an explicit choice", () => {
    renderDialog(prompt);
    expect(
      screen.getByText("transport error: connection reset"),
    ).toBeInTheDocument();
    expect(screen.getByText("Connect without protection")).toBeInTheDocument();
  });

  it("collects no token, because a credential must not ride plaintext", () => {
    renderDialog(prompt);
    expect(screen.queryByLabelText("access token")).toBeNull();
  });

  it("stores the choice only when the user makes it", async () => {
    const { onDismiss } = renderDialog(prompt);
    fireEvent.click(screen.getByText("Cancel"));
    expect(calls).toHaveLength(0);
    expect(onDismiss).toHaveBeenCalled();

    cleanup();
    renderDialog(prompt);
    fireEvent.click(screen.getByText("Connect without protection"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      cmd: "accept_server_insecure",
      args: { address: "bench.example.com:50051" },
    });
  });
});

describe("the dialog host", () => {
  /// Render `ServerTrustDialogs` with a host that answers the initial
  /// snapshot with `prompts` and hands back the change-event pusher.
  async function renderHost(prompts: ServerPrompts) {
    let push: ((e: { payload: ServerPrompts }) => void) | undefined;
    listenMock.mockImplementation((async (name: string, cb: unknown) => {
      if (name === "server-prompts-changed")
        push = cb as (e: { payload: ServerPrompts }) => void;
      return () => {};
    }) as never);
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        if (cmd === "get_server_prompts") return prompts;
        return undefined;
      },
    );
    render(<ServerTrustDialogs />);
    await waitFor(() => expect(push).toBeDefined());
    return (next: ServerPrompts) => act(() => push!({ payload: next }));
  }

  it("shows nothing when the host is waiting on no one", async () => {
    await renderHost({});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("raises the dialog for a question the host pushes", async () => {
    const push = await renderHost({});
    push({
      "bench:50051": { kind: "acceptIdentity", observed: "SHA256:aaa" },
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("SHA256:aaa")).toBeInTheDocument();
  });

  it("stops asking a question the user waved away, but keeps asking a new one", async () => {
    const push = await renderHost({
      "bench:50051": { kind: "acceptIdentity", observed: "SHA256:aaa" },
    });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();

    // A *different* question about the same server is not the one that
    // was dismissed, so it must reach the user.
    push({
      "bench:50051": {
        kind: "identityChanged",
        expected: "SHA256:aaa",
        observed: "SHA256:bbb",
      },
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("SHA256:bbb")).toBeInTheDocument();
  });
});
