// @vitest-environment jsdom
//
// The project panel's six sections fold, and its Elements inventory is
// grouped by element type with the type groups folding the same way.
// Collapse state rides the dockview panel params, so it lands in the
// layout blob the workspace scope persists (ADR 0042 §3) — the same
// channel the Database panel's expanded-node set uses.
//
// This is the first test to render the whole `ProjectPanel`, so it
// stubs the two things that kept the existing file to leaf components:
// `containerApi` and the sidecar status command.

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
  type RegistryEntry,
} from "./projectElements";
import { hydrateSettings } from "./hostSettings";
import type { ProjectElement } from "./types";

const SECTIONS = [
  "Project",
  "Elements",
  "Logical buses",
  "Virtual buses",
  "Connection",
  "DBC",
];

const projectCtx = {
  projectPath: "C:/proj/bench.cannet_prj",
  dirty: false,
  dbcPaths: [],
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
} as unknown as ProjectContextValue;

function element(kind: ProjectElement["kind"], id: string, name: string): ProjectElement {
  return { kind, id, name, sources: ["*"] } as ProjectElement;
}

function renderPanel(opts: {
  elements?: readonly ProjectElement[];
  collapsed?: readonly string[];
} = {}) {
  const entries: RegistryEntry[] = (opts.elements ?? []).map(
    (el) => ({ element: el }) as unknown as RegistryEntry,
  );
  const registry = {
    entries,
    get: (id: string) => entries.find((e) => e.element.id === id),
    create: () => "",
    ensure: () => {},
    updateTrace: () => {},
    update: vi.fn(),
    remove: vi.fn(),
  } as unknown as ElementRegistry;

  const updateParameters = vi.fn();
  const params: Record<string, unknown> =
    opts.collapsed ? { collapsed: [...opts.collapsed] } : {};
  const props = {
    api: { updateParameters },
    params,
    containerApi: {
      panels: [],
      onDidLayoutChange: () => ({ dispose: () => {} }),
      addPanel: () => {},
    },
  } as unknown as IDockviewPanelProps;

  const view = render(
    <ProjectContext.Provider value={projectCtx}>
      <ElementRegistryContext.Provider value={registry}>
        <ProjectPanel {...props} />
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
  return { ...view, updateParameters };
}

/// The disclosure button carrying `name`, whatever heading level it
/// sits in.
function header(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name}$`) });
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

describe("collapsible sections", () => {
  it("gives every section an expanded disclosure header", () => {
    renderPanel();
    for (const name of SECTIONS) {
      expect(header(name), name).toHaveAttribute("aria-expanded", "true");
    }
  });

  it("folds a section's body away when its header is clicked", () => {
    renderPanel({ elements: [element("trace", "el-1", "Trace 1")] });
    expect(screen.getByLabelText("element el-1 name")).toBeInTheDocument();

    fireEvent.click(header("Elements"));

    expect(header("Elements")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("element el-1 name")).not.toBeInTheDocument();
    // Its neighbours are untouched.
    expect(header("DBC")).toHaveAttribute("aria-expanded", "true");
  });

  it("unfolds again on a second click", () => {
    renderPanel({ elements: [element("trace", "el-1", "Trace 1")] });
    fireEvent.click(header("Elements"));
    fireEvent.click(header("Elements"));
    expect(header("Elements")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("element el-1 name")).toBeInTheDocument();
  });

  it("writes the folded sections into the panel params", () => {
    const { updateParameters } = renderPanel();
    fireEvent.click(header("DBC"));
    expect(updateParameters).toHaveBeenLastCalledWith(
      expect.objectContaining({ collapsed: ["dbc"] }),
    );
    fireEvent.click(header("Connection"));
    expect(updateParameters).toHaveBeenLastCalledWith(
      expect.objectContaining({ collapsed: ["dbc", "connection"] }),
    );
    // Unfolding takes the key back out — nothing is persisted for a
    // panel the user never folded.
    fireEvent.click(header("DBC"));
    expect(updateParameters).toHaveBeenLastCalledWith(
      expect.objectContaining({ collapsed: ["connection"] }),
    );
  });

  it("comes back folded from the params a saved layout restored", () => {
    renderPanel({
      elements: [element("trace", "el-1", "Trace 1")],
      collapsed: ["elements"],
    });
    expect(header("Elements")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("element el-1 name")).not.toBeInTheDocument();
    expect(header("Project")).toHaveAttribute("aria-expanded", "true");
  });

  it("survives an unmount / remount through the params round-trip", () => {
    const first = renderPanel();
    fireEvent.click(header("Logical buses"));
    const calls = first.updateParameters.mock.calls;
    const written = calls[calls.length - 1][0] as { collapsed: string[] };
    cleanup();

    renderPanel({ collapsed: written.collapsed });
    expect(header("Logical buses")).toHaveAttribute("aria-expanded", "false");
  });

  it("ignores junk in the params rather than throwing", () => {
    renderPanel({ collapsed: [42 as unknown as string, "dbc"] });
    expect(header("DBC")).toHaveAttribute("aria-expanded", "false");
    expect(header("Project")).toHaveAttribute("aria-expanded", "true");
  });
});

describe("elements grouped by type", () => {
  const elements = [
    element("plot", "el-p", "Plot 1"),
    element("trace", "el-t1", "Trace 1"),
    element("signals", "el-s", "Signals 1"),
    element("trace", "el-t2", "Trace 2"),
  ];

  it("renders one group per kind, in the kind-label order", () => {
    renderPanel({ elements });
    const groups = screen
      .getAllByRole("button")
      .map((b) => b.textContent?.replace(/^[▾▸]\s*/, "") ?? "")
      .filter((t) => ["Trace", "Plot", "Signals"].includes(t));
    expect(groups).toEqual(["Trace", "Plot", "Signals"]);
  });

  it("puts each element under its own kind's group", () => {
    renderPanel({ elements });
    fireEvent.click(header("Plot"));
    expect(screen.queryByLabelText("element el-p name")).not.toBeInTheDocument();
    // The other kinds are unaffected.
    expect(screen.getByLabelText("element el-t1 name")).toBeInTheDocument();
    expect(screen.getByLabelText("element el-t2 name")).toBeInTheDocument();
    expect(screen.getByLabelText("element el-s name")).toBeInTheDocument();
  });

  it("persists a folded group under an elements/ key", () => {
    const { updateParameters } = renderPanel({ elements });
    fireEvent.click(header("Trace"));
    expect(updateParameters).toHaveBeenLastCalledWith(
      expect.objectContaining({ collapsed: ["elements/trace"] }),
    );
  });

  it("folds the whole Elements section over its groups", () => {
    renderPanel({ elements });
    fireEvent.click(header("Elements"));
    expect(screen.queryByRole("button", { name: /^Trace$/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("element el-t1 name")).not.toBeInTheDocument();
  });

  it("keeps the empty state when there are no elements", () => {
    renderPanel();
    expect(screen.getByText("No elements.")).toBeInTheDocument();
  });
});
