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

function renderPanel(
  opts: {
    dbcPaths?: readonly string[];
    dbcBuses?: Record<string, string[]>;
    captureDbcs?: readonly string[];
    buses?: { id: string; name: string }[];
  } = {},
) {
  const onAddDbc = vi.fn();
  const ctx = {
    projectPath: "C:/proj/bench.cannet_prj",
    dirty: false,
    dbcPaths: opts.dbcPaths ?? [],
    dbcBuses: opts.dbcBuses ?? {},
    captureDbcs: new Set(opts.captureDbcs ?? []),
    buses: opts.buses ?? [],
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
    controlTrace: () => {},
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

  it("says a database on no bus is on no bus", () => {
    // Assignment governs decode: a database assigned to nothing decodes
    // nothing, so the row must not read as though it decoded everything.
    renderPanel({
      dbcPaths: ["C:/dbc/pack.dbc", "C:/dbc/body.dbc"],
      dbcBuses: { "C:/dbc/body.dbc": ["p"] },
      buses: [{ id: "p", name: "Powertrain" }],
    });
    const rows = document.querySelectorAll(".project-dbc");
    expect(rows[0].querySelector(".project-dbc-scoping-label")).toHaveTextContent("no bus:");
    expect(rows[1].querySelector(".project-dbc-scoping-label")).toHaveTextContent("buses:");
    expect(screen.queryByText(/all buses/)).toBeNull();
  });

  it("lists a capture's database by its own name, marked as the capture's", () => {
    const capture = "C:\captures\run.mf4#body.dbc";
    renderPanel({
      dbcPaths: ["C:/dbc/pack.dbc", capture],
      captureDbcs: [capture],
      buses: [{ id: "p", name: "Powertrain" }],
    });
    const rows = document.querySelectorAll(".project-dbc");
    expect(rows[0].querySelector(".project-dbc-source")).toBeNull();
    expect(rows[1].querySelector(".project-dbc-name")).toHaveTextContent(/^body\.dbc$/);
    expect(rows[1].querySelector(".project-dbc-source")).toHaveTextContent("from the capture");
    // Assignable like any other.
    expect(rows[1].querySelector('input[type="checkbox"]')).not.toBeNull();
  });
});
