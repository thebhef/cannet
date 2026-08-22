// @vitest-environment jsdom
//
// Reaching the Servers panel from the project view.
//
// The bus rows already offer "Manage servers…", but only from inside a
// logical bus's interface combo or its trust notice — affordances that
// exist once a bus does. The Connection section carries the same
// launcher unconditionally, so a project with nothing configured yet
// still has a way in.
//
// Asserted through the dock API the launcher drives, not through a
// spy on the launcher: what matters is that the Servers panel opens,
// and that a second press focuses the open one rather than adding a
// second copy of a singleton.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => [] as unknown[]),
  listenMock: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import type { IDockviewPanelProps } from "dockview";

import { ProjectPanel } from "./ProjectPanel";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
} from "./projectElements";
import { hydrateSettings } from "./hostSettings";
import { SERVERS_PANEL_ID } from "./dockLayout";
import type { Bus, InterfaceBinding } from "./types";

const REMOTE = "10.0.0.5:50051";

function renderPanel(
  opts: {
    buses?: readonly Bus[];
    bindings?: readonly InterfaceBinding[];
    openPanels?: readonly { id: string; setActive: () => void }[];
  } = {},
) {
  const ctx = {
    projectPath: "C:/proj/bench.cannet_prj",
    dirty: false,
    dbcPaths: [],
    dbcBuses: {},
    buses: opts.buses ?? [],
    interfaceBindings: opts.bindings ?? [],
    connectedAddresses: [],
    remoteConnected: false,
    connectedBusIds: [],
    blfPath: null,
    signalColors: {},
    busesWithPendingHwConfig: [],
    localVirtualBuses: [],
  } as unknown as ProjectContextValue;

  const registry = {
    entries: [],
    get: () => undefined,
    create: () => "",
    ensure: () => {},
    updateTrace: () => {},
    update: vi.fn(),
    remove: vi.fn(),
  } as unknown as ElementRegistry;

  const addPanel = vi.fn();
  const props = {
    api: { updateParameters: vi.fn() },
    params: {},
    containerApi: {
      panels: (opts.openPanels ?? []).map((p) => ({
        id: p.id,
        api: { setActive: p.setActive },
      })),
      onDidLayoutChange: () => ({ dispose: () => {} }),
      addPanel,
    },
  } as unknown as IDockviewPanelProps;

  const view = render(
    <ProjectContext.Provider value={ctx}>
      <ElementRegistryContext.Provider value={registry}>
        <ProjectPanel {...props} />
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
  return { ...view, addPanel };
}

/// The Connection section's launcher. Scoped to that section so a bus
/// row's combo option of the same name cannot satisfy the assertion.
function launcher(): HTMLElement {
  return screen.getByTestId("manage-servers");
}

describe("reaching the Servers panel from the project view", () => {
  beforeEach(async () => {
    invokeMock.mockClear();
    invokeMock.mockImplementation((async () => []) as never);
    listenMock.mockClear();
    await hydrateSettings();
  });
  afterEach(cleanup);

  it("offers the launcher on an empty project, before any bus exists", () => {
    renderPanel();
    expect(launcher()).toBeInTheDocument();
  });

  it("offers the launcher alongside Connect once a bus is bound", () => {
    renderPanel({
      buses: [{ id: "b1", name: "Bus 1" } as Bus],
      bindings: [{ kind: "remote", server: REMOTE, interface: "can0", bus_id: "b1" }],
    });
    expect(launcher()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect all" })).toBeInTheDocument();
  });

  it("opens the Servers panel", () => {
    const { addPanel } = renderPanel();
    fireEvent.click(launcher());
    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel.mock.calls[0][0]).toMatchObject({ id: SERVERS_PANEL_ID });
  });

  it("focuses the Servers panel it already opened instead of adding a second", () => {
    const setActive = vi.fn();
    const { addPanel } = renderPanel({
      openPanels: [{ id: SERVERS_PANEL_ID, setActive }],
    });
    fireEvent.click(launcher());
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(addPanel).not.toHaveBeenCalled();
  });
});
