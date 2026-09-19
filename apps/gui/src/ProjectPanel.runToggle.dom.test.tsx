// @vitest-environment jsdom
//
// The RBS row's play/stop toggle: it reads and writes exactly the
// same host `run` flag the RBS panel's own Run chip does
// (`rbs_view` / `rbs_set_run`, ADR 0028 — session state, never
// persisted). Both directions matter: a change made through the
// panel's own control must reach the row (the host event this hook
// already subscribes to), and a click on the row must reach the host
// through the very same command a panel-side click would use — so
// there is exactly one source of truth, not two copies that can
// disagree.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { RbsView } from "./types";

const calls: Array<{ cmd: string; args: unknown }> = [];
/// The tiny host stub: one RBS element's run flag and its buses'
/// connected state, mutated by `rbs_set_run` exactly as the real host
/// would, firing the same `rbs-changed` event the panel listens for.
let RUN = false;
let BUS_CONNECTED = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "rbs_view":
        return {
          elementId: String(args?.elementId ?? ""),
          path: null,
          fillBit: 0,
          dirty: false,
          changedOnDisk: false,
          run: RUN,
          buses: [{ key: "bus1", busId: "b1", connected: BUS_CONNECTED, enabled: true, ecus: [] }],
        } satisfies RbsView;
      case "rbs_set_run":
        RUN = args?.run === true;
        emitHost("rbs-changed", "*");
        return null;
      default:
        return undefined;
    }
  }),
}));

const handlers = new Map<string, Array<(e: { payload: string }) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: string }) => void) => {
    const forName = handlers.get(name) ?? [];
    forName.push(handler);
    handlers.set(name, forName);
    return () => {};
  }),
}));
function emitHost(name: string, payload = "*"): void {
  for (const h of [...(handlers.get(name) ?? [])]) h({ payload });
}

import { ElementRow } from "./ProjectPanel";
import type { ProjectElement } from "./types";

afterEach(() => {
  cleanup();
  calls.length = 0;
  handlers.clear();
  RUN = false;
  BUS_CONNECTED = true;
});

const rbsEl: ProjectElement = { kind: "rbs", id: "rbs-1", name: "RBS 1", path: null };

function renderRow() {
  return render(
    <ElementRow
      element={rbsEl}
      panel={undefined}
      connected={false}
      onOpen={() => {}}
      onRename={() => {}}
      onRemove={() => {}}
      onToggleLoggerEnabled={() => {}}
    />,
  );
}

describe("an RBS row's run toggle", () => {
  it("starts on 'start' (idle) before any view has loaded", async () => {
    renderRow();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "start" })).toBeInTheDocument();
    });
  });

  it("follows a run flag flipped elsewhere (the panel's own Run chip) to green", async () => {
    renderRow();
    await waitFor(() => screen.getByRole("button", { name: "start" }));

    // Simulate the RBS panel's own Run chip: the same command, fired
    // from outside this row.
    RUN = true;
    await act(async () => {
      emitHost("rbs-changed", "*");
    });
    await waitFor(() => {
      const toggle = screen.getByRole("button", { name: "stop (transmitting)" });
      expect(toggle.className).toMatch(/running/);
    });
  });

  it("reads armed (amber) when running but its own buses aren't connected", async () => {
    BUS_CONNECTED = false;
    renderRow();
    await waitFor(() => screen.getByRole("button", { name: "start" }));
    RUN = true;
    await act(async () => {
      emitHost("rbs-changed", "*");
    });
    await waitFor(() => {
      const toggle = screen.getByRole("button", { name: "stop (armed — starts on connect)" });
      expect(toggle.className).toMatch(/armed/);
    });
  });

  it("a click writes through rbs_set_run — the same command the panel's Run chip uses", async () => {
    renderRow();
    await waitFor(() => screen.getByRole("button", { name: "start" }));
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.cmd === "rbs_set_run" && (c.args as { run?: unknown } | undefined)?.run === true,
        ),
      ).toBe(true);
    });
    // And the row itself converges once the host's event lands, closing
    // the loop back to a running toggle — no second, disagreeing state.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "stop (transmitting)" })).toBeInTheDocument();
    });
  });
});
