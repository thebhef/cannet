// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TrustedServersList } from "./TrustedServersList";
import type { TrustedServer } from "./serverTrust";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

let rows: TrustedServer[] = [];
let calls: { cmd: string; args: Record<string, unknown> }[] = [];

beforeEach(() => {
  calls = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args: args ?? {} });
      if (cmd === "list_trusted_servers") return rows;
      if (cmd === "forget_server") {
        rows = rows.filter((r) => r.address !== args.address);
        return undefined;
      }
      return undefined;
    },
  );
});

afterEach(cleanup);

describe("the trusted-servers list", () => {
  it("says so when nothing has been accepted", async () => {
    rows = [];
    render(<TrustedServersList />);
    await waitFor(() =>
      expect(
        screen.getByText(/No server identities accepted yet/),
      ).toBeInTheDocument(),
    );
  });

  it("shows the same fingerprint string the accept dialog showed", async () => {
    // Not an abbreviation: the whole point of the list is that a
    // fingerprint compared once can be compared again.
    rows = [
      {
        address: "bench:50051",
        fingerprint: "SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc",
        hasToken: true,
        insecure: false,
      },
    ];
    render(<TrustedServersList />);
    await waitFor(() =>
      expect(
        screen.getByText("SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("token stored")).toBeInTheDocument();
  });

  it("says whether a token is stored without ever showing one", async () => {
    rows = [
      {
        address: "bench:50051",
        fingerprint: "SHA256:aaa",
        hasToken: false,
        insecure: false,
      },
    ];
    render(<TrustedServersList />);
    await waitFor(() =>
      expect(screen.getByText("no token")).toBeInTheDocument(),
    );
  });

  it("marks a server the user chose to reach unprotected", async () => {
    rows = [
      {
        address: "old-rig:50051",
        fingerprint: null,
        hasToken: false,
        insecure: true,
      },
    ];
    render(<TrustedServersList />);
    await waitFor(() =>
      expect(
        screen.getByText("connects without protection"),
      ).toBeInTheDocument(),
    );
  });

  it("forgets a server and re-reads the list from the host", async () => {
    rows = [
      {
        address: "bench:50051",
        fingerprint: "SHA256:aaa",
        hasToken: true,
        insecure: false,
      },
    ];
    render(<TrustedServersList />);
    await waitFor(() =>
      expect(screen.getByText("SHA256:aaa")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("Forget"));

    await waitFor(() =>
      expect(
        screen.getByText(/No server identities accepted yet/),
      ).toBeInTheDocument(),
    );
    expect(calls.map((c) => c.cmd)).toEqual([
      "list_trusted_servers",
      "forget_server",
      "list_trusted_servers",
    ]);
    expect(calls[1].args).toEqual({ address: "bench:50051" });
  });
});
