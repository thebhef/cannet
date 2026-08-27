// @vitest-environment jsdom
//
// Adding a database file to the project, from the project panel.
//
// This is the only place the app offers it outside the palette: the
// top bar's database control shows the Database *view*, and putting a
// file into the project is membership, which belongs where the
// project's databases are listed. The pin is here rather than in the
// toolbar test because removing a control from the bar is only safe
// while the action is still reachable — this is the other half of
// `Toolbar.dom.test.tsx`'s "opens no database file from the bar".

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
import { ElementRegistryContext, type ElementRegistry } from "./projectElements";
import { hydrateSettings } from "./hostSettings";

function renderPanel(opts: { dbcPaths?: readonly string[] } = {}) {
  const onAddDbc = vi.fn();
  const ctx = {
    projectPath: "C:/proj/bench.cannet_prj",
    dirty: false,
    dbcPaths: opts.dbcPaths ?? [],
    dbcBuses: {},
    buses: [],
    interfaceBindings: [],
    connectedAddresses: [],
    remoteConnected: false,
    connectedBusIds: [],
    blfPath: null,
    signalColors: {},
    busesWithPendingHwConfig: [],
    localVirtualBuses: [],
    onAddDbc,
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

  const props = {
    api: { updateParameters: vi.fn() },
    params: {},
    containerApi: {
      panels: [],
      onDidLayoutChange: () => ({ dispose: () => {} }),
      addPanel: vi.fn(),
    },
  } as unknown as IDockviewPanelProps;

  const view = render(
    <ProjectContext.Provider value={ctx}>
      <ElementRegistryContext.Provider value={registry}>
        <ProjectPanel {...props} />
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
  return { ...view, onAddDbc };
}

beforeEach(async () => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  await hydrateSettings();
});

afterEach(async () => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  await hydrateSettings();
});

describe("the project panel's databases section", () => {
  it("offers the add-a-database action with no database in the project yet", () => {
    // The empty project is the case that matters: this is where a user
    // with nothing loaded has to be able to start.
    const { onAddDbc } = renderPanel();
    const add = screen.getByRole("button", { name: "Add…" });
    fireEvent.click(add);
    expect(onAddDbc).toHaveBeenCalledTimes(1);
  });

  it("still offers it once the project holds databases", () => {
    const { onAddDbc } = renderPanel({ dbcPaths: ["C:/dbc/pack.dbc"] });
    fireEvent.click(screen.getByRole("button", { name: "Add…" }));
    expect(onAddDbc).toHaveBeenCalledTimes(1);
  });
});
