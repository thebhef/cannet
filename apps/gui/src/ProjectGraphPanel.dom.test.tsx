// @vitest-environment jsdom
//
// Smoke-tests for the project-graph panel's toolbar. The toolbar is
// the entry point for creating filter elements; deeper graph rendering
// is covered by the pure `projectGraph.test.ts`.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// `@xyflow/react`'s exports import a `.css` file; vitest doesn't
// parse CSS imports out of the box. Stub the whole module with the
// shapes ProjectGraphPanel uses.
vi.mock("@xyflow/react", () => {
  const Position = { Left: "left", Right: "right", Top: "top", Bottom: "bottom" } as const;
  const MarkerType = { ArrowClosed: "arrowclosed" } as const;
  const Handle = () => null;
  const Background = () => null;
  const Controls = () => null;
  const ReactFlow = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="reactflow">{children}</div>
  );
  const ReactFlowProvider = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const applyNodeChanges = (_changes: unknown, nodes: unknown) => nodes;
  const applyEdgeChanges = (_changes: unknown, edges: unknown) => edges;
  return {
    Position,
    MarkerType,
    Handle,
    Background,
    Controls,
    ReactFlow,
    ReactFlowProvider,
    applyNodeChanges,
    applyEdgeChanges,
  };
});
vi.mock("@xyflow/react/dist/style.css", () => ({}));

import { ProjectGraphPanel } from "./ProjectGraphPanel";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ElementRegistryContext, type ElementRegistry } from "./projectElements";
import { freshTrace } from "./trace";

afterEach(cleanup);

const noop = () => {};

const projectCtx: ProjectContextValue = {
  projectPath: null,
  dirty: false,
  dbcPaths: [],
  dbcBuses: {},
  buses: [{ id: "p", name: "Powertrain" }],
  interfaceBindings: [],
  connectedAddresses: [],
  connectedBusIds: [],
  remoteConnected: false,
  blfPath: null,
  onNewProject: noop,
  onOpenProject: noop,
  onSaveProject: noop,
  onSaveProjectAs: noop,
  onAddDbc: noop,
  onRemoveDbc: noop,
  onReloadDbc: noop,
  onSetDbcBuses: noop,
  onAddBus: noop,
  onRemoveBus: noop,
  onRenameBus: noop,
  onSetBusColor: noop,
  onSetBusSpeed: noop,
  onSetBusFd: noop,
  onSetBusFdDataSpeed: noop,
  busesWithPendingHwConfig: [],
  onAddBinding: noop,
  onRemoveBinding: noop,
  onConnect: noop,
  onDisconnect: noop,
  localVirtualBuses: [],
  onAddVirtualBus: noop,
  onRemoveVirtualBus: noop,
  onUpdateVirtualBus: noop,
};

function makeRegistry(create: ReturnType<typeof vi.fn>): ElementRegistry {
  return {
    entries: [],
    get: () => undefined,
    create,
    ensure: noop,
    updateTrace: noop,
    update: noop,
    remove: noop,
  } as unknown as ElementRegistry;
}

function renderPanel(create: ReturnType<typeof vi.fn>) {
  const api = { updateParameters: vi.fn() };
  const props = { params: {}, api } as unknown as Parameters<typeof ProjectGraphPanel>[0];
  // Stub ResizeObserver — `@xyflow/react` (when not mocked) and a
  // few of our components observe size. Even with the module mocked,
  // some downstream code may pull it in.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class { observe() {} unobserve() {} disconnect() {} };
  render(
    <ProjectContext.Provider value={projectCtx}>
      <ElementRegistryContext.Provider value={makeRegistry(create)}>
        <ProjectGraphPanel {...props} />
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
  // `freshTrace` is referenced by the registry mocks elsewhere; keep
  // the import alive in case the wider test environment expects it.
  void freshTrace;
}

describe("ProjectGraphPanel", () => {
  it("renders a toolbar with a New filter button", () => {
    const create = vi.fn(() => "f1");
    renderPanel(create);
    expect(screen.getByRole("button", { name: /\+ filter/i })).toBeInTheDocument();
  });

  it("clicking '+ filter' calls registry.create('filter')", () => {
    const create = vi.fn(() => "f1");
    renderPanel(create);
    fireEvent.click(screen.getByRole("button", { name: /\+ filter/i }));
    expect(create).toHaveBeenCalledWith("filter");
  });
});
