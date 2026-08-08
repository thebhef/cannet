// @vitest-environment jsdom
//
// Component tests for the signal view's user-authored sections: header
// rows arriving as page rows, the disclosure fold and its params
// round-trip, and the section edits (create / rename / delete / assign)
// reaching the element config and the host query.
//
// The arrangement itself is host-side (Rust tests over
// `arrange_sections`); the mocked host here just replays whatever page
// a test wants, so these assert the panel's wiring: what it renders,
// what it sends, and what it persists.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { SignalPageRow, SignalSectionsWire } from "./types";

function signalRow(name: string, id: number): SignalPageRow {
  return {
    kind: "signal",
    bus_id: "p",
    transmitter: "EngineEcu",
    message_id: id,
    extended: false,
    message_name: "EngineData",
    signal_name: name,
    unit: "",
    is_enum: false,
    value: 1,
    raw: 1,
    rate: null,
    count: null,
    time_seconds: null,
  };
}

function headerRow(name: string, signalCount: number): SignalPageRow {
  return { kind: "section_header", name, signal_count: signalCount };
}

let ROWS: SignalPageRow[] = [];
const invokeCalls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args });
    if (cmd === "list_signals") return [];
    if (cmd === "fetch_signal_page") return { count: ROWS.length, start: 0, rows: ROWS };
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { SignalsPanel } from "./SignalsPanel";
import { TraceDataProvider, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ElementRegistryContext, type ElementRegistry } from "./projectElements";
import { freshTrace } from "./trace";
import { SignalCatalogProvider } from "./signalCatalogContext";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type TS = ReturnType<typeof freshTrace>;
type Entry = { element: { kind: "signals"; id: string; config?: Record<string, unknown> }; trace: TS };
function makeRegistry(): ElementRegistry {
  const map = new Map<string, Entry>();
  const entry = (id: string, config?: Record<string, unknown>): Entry => ({
    element: { kind: "signals", id, config },
    trace: freshTrace(0),
  });
  return {
    get entries() {
      return [...map.values()];
    },
    get: (id: string) => map.get(id),
    create: () => {
      const id = Math.random().toString(36).slice(2);
      map.set(id, entry(id));
      return id;
    },
    ensure: (id: string) => {
      if (!map.has(id)) map.set(id, entry(id));
    },
    update: (id: string, patch: { config?: Record<string, unknown> }) => {
      const e = map.get(id);
      if (e) map.set(id, { ...e, element: { ...e.element, ...patch } });
    },
    updateTrace: (id: string, updater: (s: TS) => TS) => {
      const e = map.get(id);
      if (e) map.set(id, { ...e, trace: updater(e.trace) });
    },
    remove: (id: string) => {
      map.delete(id);
    },
  } as unknown as ElementRegistry;
}

const traceData: TraceData = {
  count: 100,
  firstIndex: 0,
  truncationTsNs: null,
  sessionStartSeconds: 0,
  epoch: 0,
  fetchRange: async () => [],
  liveTail: { start: 0, rows: [] },
};
const projectCtx = {
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
  onNewProject: () => {},
  onOpenProject: () => {},
  onSaveProject: () => {},
  onSaveProjectAs: () => {},
  onAddDbc: () => {},
  onRemoveDbc: () => {},
  onReloadDbc: () => {},
  onSetDbcBuses: () => {},
  onAddBus: () => {},
  onRemoveBus: () => {},
  onUpdateBus: () => {},
  busesWithPendingHwConfig: [],
  onAddBinding: () => {},
  onRemoveBinding: () => {},
  onConnect: () => {},
  onDisconnect: () => {},
  localVirtualBuses: [],
  onAddVirtualBus: () => {},
  onRemoveVirtualBus: () => {},
  onUpdateVirtualBus: () => {},
  signalColors: {},
  onSetSignalColor: () => {},
} as unknown as ProjectContextValue;

function renderPanel(opts?: { params?: Record<string, unknown> }) {
  const api = { updateParameters: vi.fn() };
  const props = { params: opts?.params ?? {}, api } as unknown as Parameters<typeof SignalsPanel>[0];
  const registry = makeRegistry();
  const view = render(
    <TraceDataProvider value={traceData}>
      <ProjectContext.Provider value={projectCtx}>
        <SignalCatalogProvider>
          <ElementRegistryContext.Provider value={registry}>
            <SignalsPanel {...props} />
          </ElementRegistryContext.Provider>
        </SignalCatalogProvider>
      </ProjectContext.Provider>
    </TraceDataProvider>,
  );
  return { api, registry, view };
}

/// The `sections` argument of the most recent host query.
function lastSections(): SignalSectionsWire | undefined {
  const last = [...invokeCalls].reverse().find((c) => c.cmd === "fetch_signal_page");
  return last?.args?.sections as SignalSectionsWire | undefined;
}

/// The `folded` array of the most recent `updateParameters` write.
function lastParams(api: { updateParameters: ReturnType<typeof vi.fn> }) {
  const calls = api.updateParameters.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
}

/// The section config the panel last mirrored onto its element.
function elementSections(registry: ElementRegistry) {
  const el = registry.entries[0]?.element as { config?: { sections?: SignalSectionsWire } };
  return el?.config?.sections;
}

const ENGINE_KEY = "p|s:256:EngineSpeed";

// jsdom does no layout, so the rows container measures 0 and the
// viewport would render two rows. Stub it tall enough that a section's
// header *and* its rows are all on screen.
let restoreHeight: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const prev = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 440 });
  restoreHeight = () => Object.defineProperty(Element.prototype, "clientHeight", prev!);
  invokeCalls.length = 0;
  ROWS = [signalRow("EngineSpeed", 256), signalRow("Coolant", 257)];
});
afterEach(() => {
  cleanup();
  restoreHeight?.();
  vi.unstubAllGlobals();
});

describe("SignalsPanel sections", () => {
  it("sends no sections and renders no headers for a view that has none", async () => {
    renderPanel();
    await screen.findByText(/EngineSpeed/);
    expect(lastSections()).toEqual({ names: [], assignments: {}, patterns: {}, folded: [] });
    expect(document.querySelector(".signals-section-header")).toBeNull();
  });

  it("renders a section header row with its name, count and disclosure", async () => {
    ROWS = [
      headerRow("", 1),
      signalRow("Coolant", 257),
      headerRow("Pack", 1),
      signalRow("EngineSpeed", 256),
    ];
    renderPanel({ params: { sections: { names: ["Pack"], assignments: { [ENGINE_KEY]: "Pack" } } } });
    await screen.findByText(/EngineSpeed/);
    expect(screen.getByText("Pack")).toBeInTheDocument();
    // The implicit section reads as unsectioned rather than blank.
    expect(screen.getByText("Unsectioned")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Pack section" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll(".signals-section-header")).toHaveLength(2);
  });

  it("folds a section from its disclosure, into the params and the query", async () => {
    ROWS = [headerRow("Pack", 1), signalRow("EngineSpeed", 256)];
    const { api } = renderPanel({ params: { sections: { names: ["Pack"], assignments: {} } } });
    await screen.findByText("Pack");
    fireEvent.click(screen.getByRole("button", { name: "Pack section" }));
    await waitFor(() => {
      expect(lastSections()?.folded).toEqual(["Pack"]);
    });
    expect(lastParams(api)?.folded).toEqual(["Pack"]);
    expect(screen.getByRole("button", { name: "Pack section" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // Unfolding takes it back out — the set is sparse.
    fireEvent.click(screen.getByRole("button", { name: "Pack section" }));
    await waitFor(() => {
      expect(lastSections()?.folded).toEqual([]);
    });
    expect(lastParams(api)?.folded).toEqual([]);
  });

  it("restores the fold set from the panel params, tolerating junk", async () => {
    ROWS = [headerRow("Pack", 1)];
    renderPanel({
      params: {
        sections: { names: ["Pack"], assignments: {} },
        folded: ["Pack", 7, null],
      },
    });
    await screen.findByText("Pack");
    expect(screen.getByRole("button", { name: "Pack section" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(lastSections()?.folded).toEqual(["Pack"]);
  });

  it("keeps the fold in the workspace params and the sections on the element", async () => {
    // Sections describe what the view *means* (project data); a fold is
    // workspace state. The element config must never carry the fold.
    ROWS = [headerRow("Pack", 0)];
    const { api, registry } = renderPanel({
      params: { sections: { names: ["Pack"], assignments: {} } },
    });
    await screen.findByText("Pack");
    fireEvent.click(screen.getByRole("button", { name: "Pack section" }));
    await waitFor(() => {
      expect(lastParams(api)?.folded).toEqual(["Pack"]);
    });
    const config = (registry.entries[0]?.element as { config?: Record<string, unknown> }).config;
    expect(config?.folded).toBeUndefined();
    expect(elementSections(registry)?.names).toEqual(["Pack"]);
  });

  it("keeps the move control out of the clipped name cell, and the row still drags whole", async () => {
    // THE REOPENED DEFECT. The control shipped inside `.signals-name`,
    // a fixed-width grid cell that `.trace-row span { overflow: hidden }`
    // clips. jsdom does no layout, so the original tests found the
    // button either way; the structural fact is what the real WebView
    // acted on — the real intent is that the button is reachable, not
    // that the row can't be a drag source. Task 54 widened the drag
    // source to the whole row (ADR 0045), so `.trace-row` is legitimately
    // `[draggable="true"]` now; what must still hold is that the button
    // sits outside the clipped name cell, in its own column, and that
    // dragging is still wired to the row rather than the button.
    renderPanel();
    const btn = await screen.findByRole("button", { name: "move EngineSpeed to section" });
    expect(btn.closest(".signals-name")).toBeNull();
    expect(btn.closest(".col-signal")).toBeNull();
    // It lives in its own column, so nothing variable-width precedes it.
    expect(btn.closest(".col-section")).not.toBeNull();
    const row = btn.closest(".trace-row") as HTMLElement;
    expect(row).toHaveAttribute("draggable", "true");
  });

  it("shows each signal's current section in the section column", async () => {
    // The section a row sits in is stamped by the host, not looked up
    // in the assignment map — a pattern-claimed row has no assignment.
    ROWS = [
      { ...signalRow("EngineSpeed", 256), section: "Pack" } as SignalPageRow,
      signalRow("Coolant", 257),
    ];
    renderPanel({
      params: { sections: { names: ["Pack"], assignments: { [ENGINE_KEY]: "Pack" } } },
    });
    await screen.findByText(/EngineSpeed/);
    expect(screen.getByRole("button", { name: "move EngineSpeed to section" })).toHaveTextContent(
      "Pack",
    );
    // An unassigned signal reads as unsectioned, not as blank.
    expect(screen.getByRole("button", { name: "move Coolant to section" })).toHaveTextContent("—");
  });

  it("creates a section immediately with a starter name, in edit mode", async () => {
    // Correction: no name-first control. The section exists straight
    // away and its header opens in the inline editor.
    ROWS = [headerRow("Section 1", 0)];
    const { registry } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "add section" }));
    await waitFor(() => {
      expect(lastSections()?.names).toEqual(["Section 1"]);
    });
    expect(elementSections(registry)?.names).toEqual(["Section 1"]);
    // The header that arrives is already editing.
    const input = await screen.findByLabelText("section name");
    expect((input as HTMLInputElement).value).toBe("Section 1");
    // The old name-first control is gone.
    expect(screen.queryByLabelText("new section name")).toBeNull();
  });

  it("gives each new section a starter name that does not collide", async () => {
    ROWS = [];
    renderPanel({ params: { sections: { names: ["Section 1"], assignments: {} } } });
    fireEvent.click(screen.getByRole("button", { name: "add section" }));
    await waitFor(() => {
      expect(lastSections()?.names).toEqual(["Section 1", "Section 2"]);
    });
  });

  it("moves a signal into a section from its row menu", async () => {
    const { registry } = renderPanel({
      params: { sections: { names: ["Pack"], assignments: {} } },
    });
    await screen.findByText(/EngineSpeed/);
    fireEvent.click(screen.getByRole("button", { name: "move EngineSpeed to section" }));
    fireEvent.click(screen.getByRole("button", { name: "move to Pack" }));
    await waitFor(() => {
      expect(lastSections()?.assignments).toEqual({ [ENGINE_KEY]: "Pack" });
    });
    expect(elementSections(registry)?.assignments).toEqual({ [ENGINE_KEY]: "Pack" });
    // …and back out again.
    fireEvent.click(screen.getByRole("button", { name: "move EngineSpeed to section" }));
    fireEvent.click(screen.getByRole("button", { name: "move to Unsectioned" }));
    // Written as the *explicit* implicit-section assignment, not by
    // deleting the entry: a deletion reads as "never touched", which a
    // section pattern would immediately re-claim.
    await waitFor(() => {
      expect(lastSections()?.assignments).toEqual({ [ENGINE_KEY]: "" });
    });
  });

  it("creates a section from the row menu's 'new section…' and assigns the row to it", async () => {
    renderPanel();
    await screen.findByText(/EngineSpeed/);
    fireEvent.click(screen.getByRole("button", { name: "move EngineSpeed to section" }));
    fireEvent.click(screen.getByRole("button", { name: "new section…" }));
    await waitFor(() => {
      expect(lastSections()).toMatchObject({
        names: ["Section 1"],
        assignments: { [ENGINE_KEY]: "Section 1" },
      });
    });
  });

  it("gives a section its own patterns, and sends them with the query", async () => {
    ROWS = [headerRow("Pack", 0)];
    const { registry } = renderPanel({
      params: { sections: { names: ["Pack"], assignments: {} } },
    });
    await screen.findByText("Pack");
    fireEvent.click(screen.getByRole("button", { name: "patterns for section Pack" }));
    const input = screen.getByPlaceholderText(/regex, Enter to add/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "^Powertrain/Bms/" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(lastSections()?.patterns).toEqual({ Pack: ["^Powertrain/Bms/"] });
    });
    expect(elementSections(registry)?.patterns).toEqual({ Pack: ["^Powertrain/Bms/"] });
  });

  it("carries a section's patterns across a rename, and leaves them dormant on delete", async () => {
    ROWS = [headerRow("Pack", 0)];
    const { registry } = renderPanel({
      params: {
        sections: { names: ["Pack"], assignments: {}, patterns: { Pack: ["Bms"] } },
      },
    });
    await screen.findByText("Pack");
    // The header the host sends back after the rename.
    ROWS = [headerRow("Battery", 0)];
    fireEvent.click(screen.getByRole("button", { name: "rename section Pack" }));
    const input = screen.getByLabelText("section name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Battery" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(lastSections()?.patterns).toEqual({ Battery: ["Bms"] });
    });
    // Delete stays a `names` edit and nothing else: the patterns go
    // dormant with the assignments (the host only reads patterns for
    // live sections), so re-creating the name is a full undo.
    const del = await screen.findByRole("button", { name: "delete section Battery" });
    fireEvent.click(del);
    await waitFor(() => {
      expect(lastSections()?.names).toEqual([]);
    });
    expect(elementSections(registry)?.patterns).toEqual({ Battery: ["Bms"] });
  });

  it("renames a section and carries its members across", async () => {
    ROWS = [headerRow("Pack", 1), signalRow("EngineSpeed", 256)];
    renderPanel({
      params: { sections: { names: ["Pack"], assignments: { [ENGINE_KEY]: "Pack" } } },
    });
    await screen.findByText("Pack");
    fireEvent.click(screen.getByRole("button", { name: "rename section Pack" }));
    const input = screen.getByLabelText("section name") as HTMLInputElement;
    expect(input.value).toBe("Pack");
    fireEvent.change(input, { target: { value: "Battery" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(lastSections()).toMatchObject({
        names: ["Battery"],
        assignments: { [ENGINE_KEY]: "Battery" },
      });
    });
  });

  it("abandons a rename on Escape", async () => {
    ROWS = [headerRow("Pack", 0)];
    renderPanel({ params: { sections: { names: ["Pack"], assignments: {} } } });
    await screen.findByText("Pack");
    fireEvent.click(screen.getByRole("button", { name: "rename section Pack" }));
    const input = screen.getByLabelText("section name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nonsense" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => {
      expect(screen.getByText("Pack")).toBeInTheDocument();
    });
    expect(lastSections()?.names).toEqual(["Pack"]);
  });

  it("deletes a section without touching the selection, keeping the assignment dormant", async () => {
    ROWS = [headerRow("Pack", 1), signalRow("EngineSpeed", 256)];
    const { registry } = renderPanel({
      params: {
        selection: { keys: [{ busId: "p", messageId: 256, extended: false, signalName: "EngineSpeed" }], patterns: [] },
        sections: { names: ["Pack"], assignments: { [ENGINE_KEY]: "Pack" } },
      },
    });
    await screen.findByText("Pack");
    fireEvent.click(screen.getByRole("button", { name: "delete section Pack" }));
    await waitFor(() => {
      expect(lastSections()?.names).toEqual([]);
    });
    // The signal is still selected — deleting a section unassigns, it
    // does not remove rows from the view.
    const sel = [...invokeCalls].reverse().find((c) => c.cmd === "fetch_signal_page")?.args
      ?.selection as { keys: unknown[] };
    expect(sel.keys).toHaveLength(1);
    // The assignment stays, dormant: re-creating "Pack" restores it.
    expect(elementSections(registry)?.assignments).toEqual({ [ENGINE_KEY]: "Pack" });
  });
});
