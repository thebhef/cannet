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
  // Renders each node through its registered type component, so a
  // node's own markup (its title, its subtitle) is testable — without
  // that the panel's nodes never reach the DOM at all.
  const ReactFlow = ({
    children,
    nodes,
    nodeTypes,
  }: {
    children?: React.ReactNode;
    nodes?: { id: string; type?: string; data?: unknown }[];
    nodeTypes?: Record<string, (p: { data: unknown }) => React.ReactNode>;
  }) => (
    <div data-testid="reactflow">
      {(nodes ?? []).map((n) => {
        const C = n.type ? nodeTypes?.[n.type] : undefined;
        return C ? <div key={n.id}>{C({ data: n.data })}</div> : null;
      })}
      {children}
    </div>
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
import { LONG_MESSAGE_NAME, LONG_MESSAGE_TAIL, expectMiddleEllipsis } from "./longNameTestKit";

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
  onUpdateBus: noop,
  busesWithPendingHwConfig: [],
  onAddBinding: noop,
  onRemoveBinding: noop,
  onConnect: noop,
  onDisconnect: noop,
  localVirtualBuses: [],
  onAddVirtualBus: noop,
  onRemoveVirtualBus: noop,
  onUpdateVirtualBus: noop,
  signalColors: {},
  onSetSignalColor: noop,
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

function renderPanel(create: ReturnType<typeof vi.fn>, buses?: { id: string; name: string }[]) {
  const api = { updateParameters: vi.fn() };
  const props = { params: {}, api } as unknown as Parameters<typeof ProjectGraphPanel>[0];
  // Stub ResizeObserver — `@xyflow/react` (when not mocked) and a
  // few of our components observe size. Even with the module mocked,
  // some downstream code may pull it in.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class { observe() {} unobserve() {} disconnect() {} };
  render(
    <ProjectContext.Provider value={buses ? { ...projectCtx, buses } : projectCtx}>
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
    expect(screen.getByRole("button", { name: "Add Filter" })).toBeInTheDocument();
  });

  it("clicking '+ filter' calls registry.create('filter')", () => {
    const create = vi.fn(() => "f1");
    renderPanel(create);
    fireEvent.click(screen.getByRole("button", { name: "Add Filter" }));
    expect(create).toHaveBeenCalledWith("filter");
  });
});

describe("ProjectGraphPanel node names", () => {
  it("splits a long bus name and leaves a short one alone", () => {
    renderPanel(vi.fn(() => "f1"), [
      { id: "p", name: LONG_MESSAGE_NAME },
      { id: "q", name: "Powertrain" },
    ]);
    const titles = document.querySelectorAll(".graph-node-title");
    expect(titles.length).toBeGreaterThanOrEqual(2);
    expectMiddleEllipsis(titles[0], LONG_MESSAGE_NAME, LONG_MESSAGE_TAIL);
    expect(titles[1].querySelector(".name-text")).toBeNull();
    expect(titles[1].textContent).toBe("Powertrain");
  });
});
