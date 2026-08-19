// @vitest-environment jsdom
//
// An RBS element's `.cannet_rbs` changed on disk (ADR 0053 §1).
//
// Unlike the project, the apply-or-notify decision is the *host's*:
// both facts it reads — whether the element has unsaved overrides, and
// whether it is transmitting — are host state. So a clean, stopped
// element never reaches the panel at all (the host has already run the
// load path), and what the panel renders is the other branch: the
// pending flag `rbs_view` carries, the explicit Apply anyway that runs
// the load path, and the Dismiss that leaves memory alone.
//
// The notice is host state rather than panel state on purpose: it
// cannot outlive what it refers to, because the load, the save and the
// dismiss all clear it host-side and the panel re-fetches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, fireEvent, waitFor } from "@testing-library/react";

import type { RbsView } from "./types";

let VIEW: RbsView | null = null;
const calls: Array<{ cmd: string; args: unknown }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "rbs_view":
        return VIEW;
      case "rbs_crc_algorithms":
        return [];
      case "list_value_tables":
        return [];
      default:
        return undefined;
    }
  }),
}));
// Handlers per event name, so a test can deliver the host's
// `rbs-changed` exactly as the host does after a load / save / dismiss.
const handlers = new Map<string, Array<(e: { payload: string }) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: string }) => void) => {
    const forName = handlers.get(name) ?? [];
    forName.push(handler);
    handlers.set(name, forName);
    return () => {};
  }),
}));
function emitHost(name: string, payload = "el"): void {
  for (const h of [...(handlers.get(name) ?? [])]) h({ payload });
}
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

import { RbsPanel } from "./RbsPanel";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import type { ProjectElement } from "./types";
import type { TraceState } from "./trace";

const PATH = "/tmp/sim.cannet_rbs";

const projectCtx = {
  buses: [{ id: "p1", name: "Powertrain" }],
  connectedBusIds: [],
} as unknown as ProjectContextValue;

/// The smallest view the panel renders: no buses, only the element's
/// own state.
function view(changedOnDisk: boolean): RbsView {
  return {
    elementId: "el",
    path: PATH,
    fillBit: 0,
    dirty: false,
    changedOnDisk,
    run: false,
    killSwitch: false,
    buses: [],
  };
}

function renderPanel() {
  const fakeTrace = {} as TraceState;
  const element: ProjectElement = { kind: "rbs", id: "el", path: PATH, run: false };
  const registry = {
    get entries() {
      return [{ element, trace: fakeTrace }] as RegistryEntry[];
    },
    get: (id: string) =>
      id === "el" ? ({ element, trace: fakeTrace } as RegistryEntry) : undefined,
    create: () => "el",
    ensure: () => {},
    updateTrace: () => {},
    update: () => {},
    remove: () => {},
  } as unknown as ElementRegistry;
  const api = { updateParameters: vi.fn() };
  const props = { params: { elementId: "el" }, api } as unknown as Parameters<
    typeof RbsPanel
  >[0];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <ElementRegistryContext.Provider value={registry}>
        <RbsPanel {...props} />
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  );
}

function lastCall(cmd: string) {
  return [...calls].reverse().find((c) => c.cmd === cmd);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

beforeEach(() => {
  calls.length = 0;
  handlers.clear();
  VIEW = null;
});

afterEach(() => {
  cleanup();
});

describe("an RBS file changing on disk", () => {
  it("says nothing while the host has nothing pending", async () => {
    VIEW = view(false);
    renderPanel();
    await waitFor(() => expect(document.body.textContent).toContain("Kill-switch"));
    expect(document.body.textContent).not.toContain("changed on disk");
  });

  it("shows the host's pending change with an explicit Apply anyway", async () => {
    VIEW = view(true);
    renderPanel();
    await waitFor(() =>
      expect(document.body.textContent).toContain("RBS file changed on disk"),
    );
    expect(button("Apply anyway")).toBeInTheDocument();
  });

  it("applies through the load path, which is what preserves run state", async () => {
    VIEW = view(true);
    renderPanel();
    await waitFor(() => expect(button("Apply anyway")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(button("Apply anyway")!);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(lastCall("rbs_load")?.args).toEqual({ elementId: "el", path: PATH });
  });

  it("dismisses through the host, because the flag it clears is the host's", async () => {
    // A panel-local dismiss would come straight back on the next
    // `rbs_view` — the notice is a view over host state, not state.
    VIEW = view(true);
    renderPanel();
    await waitFor(() => expect(button("Apply anyway")).toBeInTheDocument());
    const dismiss = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss the RBS changed-on-disk notice"]',
    );
    expect(dismiss).not.toBeNull();
    await act(async () => {
      fireEvent.click(dismiss!);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(lastCall("rbs_dismiss_disk_change")?.args).toEqual({ elementId: "el" });
    expect(lastCall("rbs_load")).toBeUndefined();
  });

  it("stops showing the notice once the host says it is resolved", async () => {
    // The staleness rule, from the host's side: whatever resolved it —
    // the apply, a save, the dismiss — clears the flag, the panel
    // re-fetches, and the statement goes with it.
    VIEW = view(true);
    renderPanel();
    await waitFor(() =>
      expect(document.body.textContent).toContain("RBS file changed on disk"),
    );
    VIEW = view(false);
    await act(async () => {
      fireEvent.click(button("Apply anyway")!);
      await new Promise((r) => setTimeout(r, 20));
    });
    // What the host does at the end of the load path.
    await act(async () => {
      emitHost("rbs-changed");
      await new Promise((r) => setTimeout(r, 20));
    });
    await settle();
    await waitFor(() =>
      expect(document.body.textContent).not.toContain("RBS file changed on disk"),
    );
  });
});
