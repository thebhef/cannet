// @vitest-environment jsdom
//
// The signal view on the gridview base (ADR 0044) — the reference
// migration. Section headers are branch rows, signal rows are plain
// leaves, and the whole thing is one paged, host-arranged row space of
// stable ids: the cursor, the D3 key table and the D4 mouse-built
// selection all bind to it.
//
// The last describe is the end-to-end half of D10 that the base slice
// could not write: a globally-bound arrow chord, dispatched by the REAL
// `useCommands` listener, must not fire while focus is inside this
// panel's grid.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { SignalPageRow } from "./types";

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
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
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
import { useCommands } from "./useCommands";

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
  localVirtualBuses: [],
  onAddVirtualBus: () => {},
  onRemoveVirtualBus: () => {},
  onUpdateVirtualBus: () => {},
  signalColors: {},
  onSetSignalColor: () => {},
  onSetSignalColors: () => {},
} as unknown as ProjectContextValue;

function Providers({
  children,
  projectCtxOverride,
}: {
  children: React.ReactNode;
  projectCtxOverride?: Partial<ProjectContextValue>;
}) {
  const ctx = projectCtxOverride ? { ...projectCtx, ...projectCtxOverride } : projectCtx;
  return (
    <TraceDataProvider value={traceData}>
      <ProjectContext.Provider value={ctx}>
        <SignalCatalogProvider>
          <ElementRegistryContext.Provider value={makeRegistry()}>
            {children}
          </ElementRegistryContext.Provider>
        </SignalCatalogProvider>
      </ProjectContext.Provider>
    </TraceDataProvider>
  );
}

function renderPanel(opts?: {
  params?: Record<string, unknown>;
  projectCtxOverride?: Partial<ProjectContextValue>;
}) {
  const api = { updateParameters: vi.fn() };
  const props = { params: opts?.params ?? {}, api } as unknown as Parameters<typeof SignalsPanel>[0];
  return render(
    <Providers projectCtxOverride={opts?.projectCtxOverride}>
      <SignalsPanel {...props} />
    </Providers>,
  );
}

/// The gridview container — the rows viewport, which is what holds
/// focus (rows are recycled by the paged viewport, so focus can't live
/// on one).
function grid(): HTMLElement {
  const el = document.querySelector(`.trace-rows`);
  if (!el) throw new Error("no rows container");
  return el as HTMLElement;
}

/// The row `aria-activedescendant` names, resolved through the DOM id
/// the row actually carries.
function activeRow(): HTMLElement | null {
  const id = grid().getAttribute("aria-activedescendant");
  return id == null ? null : document.getElementById(id);
}

function selectedText(): string[] {
  return Array.from(document.querySelectorAll('.trace-row[aria-selected="true"]')).map(
    (el) => (el as HTMLElement).textContent ?? "",
  );
}

let restoreHeight: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const prev = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 440 });
  restoreHeight = () => Object.defineProperty(Element.prototype, "clientHeight", prev!);
  ROWS = [
    headerRow("", 1),
    signalRow("Coolant", 257),
    headerRow("Pack", 1),
    signalRow("EngineSpeed", 256),
  ];
});
afterEach(() => {
  cleanup();
  restoreHeight?.();
  vi.unstubAllGlobals();
});

const SECTIONED = { params: { sections: { names: ["Pack"], assignments: {} } } };

describe("signal view cursor", () => {
  it("marks the rows viewport as a gridview and names the active row there", async () => {
    renderPanel(SECTIONED);
    await screen.findByText(/EngineSpeed/);
    expect(grid()).toHaveAttribute("data-gridview");
    expect(grid()).toHaveAttribute("tabindex", "0");
    expect(activeRow()).toBeNull();
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toHaveTextContent("Unsectioned");
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toHaveTextContent("Coolant");
    fireEvent.keyDown(grid(), { key: "End" });
    expect(activeRow()).toHaveTextContent("EngineSpeed");
  });

  it("walks a signal row out to its section header and back in", async () => {
    // The headers are branches and the signal rows sit one level under
    // them, so D3's Left/Right tree moves work on the host's row space
    // without the panel keeping a parent pointer.
    renderPanel(SECTIONED);
    await screen.findByText(/EngineSpeed/);
    fireEvent.keyDown(grid(), { key: "End" });
    expect(activeRow()).toHaveTextContent("EngineSpeed");
    fireEvent.keyDown(grid(), { key: "ArrowLeft" });
    expect(activeRow()).toHaveTextContent("Pack");
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    expect(activeRow()).toHaveTextContent("EngineSpeed");
  });

  it("folds and unfolds a section from the cursor", async () => {
    renderPanel(SECTIONED);
    await screen.findByText(/EngineSpeed/);
    fireEvent.keyDown(grid(), { key: "End" });
    fireEvent.keyDown(grid(), { key: "ArrowLeft" }); // onto the header
    fireEvent.keyDown(grid(), { key: "ArrowLeft" }); // …which closes it
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Pack section" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Pack section" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });
  });

  it("clicking a signal inside a section leaves the section open", async () => {
    // The defect the trace views had: a click on what a row disclosed
    // must act on the row clicked, not on the one that disclosed it.
    // Here a section's signals are already rows of the space, each its
    // own element — this pins that they stay that way.
    renderPanel(SECTIONED);
    await screen.findByText(/EngineSpeed/);
    const section = () => screen.getByRole("button", { name: "Pack section" });
    expect(section()).toHaveAttribute("aria-expanded", "true");
    const row = screen.getByText(/EngineSpeed/).closest(".trace-row") as HTMLElement;
    fireEvent.click(row);
    expect(section()).toHaveAttribute("aria-expanded", "true");
    expect(selectedText().join()).toContain("EngineSpeed");
  });

  it("moves the cursor with no sections at all, over a flat row space", async () => {
    ROWS = [signalRow("Coolant", 257), signalRow("EngineSpeed", 256)];
    renderPanel();
    await screen.findByText(/EngineSpeed/);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(activeRow()).toHaveTextContent("Coolant");
    // Nothing to walk out to: a flat space has no parent row.
    fireEvent.keyDown(grid(), { key: "ArrowLeft" });
    expect(activeRow()).toHaveTextContent("Coolant");
  });
});

describe("signal view selection", () => {
  it("replaces on a plain click and follows the cursor", async () => {
    renderPanel(SECTIONED);
    await screen.findByText(/EngineSpeed/);
    fireEvent.click(screen.getByText(/EngineSpeed/));
    expect(selectedText().join()).toContain("EngineSpeed");
    fireEvent.keyDown(grid(), { key: "Home" });
    expect(selectedText().join()).toContain("Unsectioned");
    expect(selectedText()).toHaveLength(1);
  });

  it("toggles a row with Ctrl+click and builds a range with Ctrl+Shift+click", async () => {
    renderPanel(SECTIONED);
    await screen.findByText(/EngineSpeed/);
    fireEvent.click(screen.getByText(/Coolant/));
    fireEvent.click(screen.getByText(/EngineSpeed/), { ctrlKey: true });
    expect(selectedText()).toHaveLength(2);
    fireEvent.click(screen.getByText(/EngineSpeed/), { ctrlKey: true });
    expect(selectedText()).toHaveLength(1);
    // …and the additive range from the anchor takes everything between.
    fireEvent.click(screen.getByText(/Coolant/));
    fireEvent.click(screen.getByText(/EngineSpeed/), { ctrlKey: true, shiftKey: true });
    expect(selectedText()).toHaveLength(3);
  });

  it("takes every row on Ctrl+A", async () => {
    renderPanel(SECTIONED);
    await screen.findByText(/EngineSpeed/);
    fireEvent.keyDown(grid(), { key: "a", ctrlKey: true });
    expect(selectedText()).toHaveLength(4);
  });
});

/// The name's own color-picker input (`ColorChip` with `hideBox`),
/// reached through the row's `.signals-name` span — right-clicking
/// that span opens it (`SignalsPanel.tsx`).
function nameSpan(signal: string): HTMLElement {
  const el = screen.getByText(new RegExp(signal)).closest(".signals-name");
  if (!el) throw new Error(`no .signals-name for ${signal}`);
  return el as HTMLElement;
}
function colorInputFor(signal: string): HTMLInputElement {
  const input = nameSpan(signal).querySelector('input[type="color"]');
  if (!input) throw new Error(`no color input for ${signal}`);
  return input as HTMLInputElement;
}

describe("signal view color pick over a selection", () => {
  it("colours every selected row from one pick, in one project change", async () => {
    ROWS = [signalRow("Coolant", 257), signalRow("EngineSpeed", 256), signalRow("OilTemp", 258)];
    const onSetSignalColors = vi.fn();
    renderPanel({ projectCtxOverride: { onSetSignalColors } });
    await screen.findByText(/OilTemp/);
    fireEvent.click(screen.getByText(/Coolant/));
    fireEvent.click(screen.getByText(/EngineSpeed/), { ctrlKey: true });
    fireEvent.click(screen.getByText(/OilTemp/), { ctrlKey: true });
    expect(selectedText()).toHaveLength(3);

    // Right-click a name already in the selection, then pick.
    fireEvent.contextMenu(nameSpan("Coolant"));
    fireEvent.change(colorInputFor("Coolant"), { target: { value: "#123456" } });

    expect(onSetSignalColors).toHaveBeenCalledTimes(1);
    const entries = onSetSignalColors.mock.calls[0][0] as { key: string; color: string }[];
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.color === "#123456")).toBe(true);
    // The right-clicked row was already selected, so the selection
    // itself is untouched.
    expect(selectedText()).toHaveLength(3);
  });

  it("an unselected row's pick recolours it alone and makes it the selection", async () => {
    ROWS = [signalRow("Coolant", 257), signalRow("EngineSpeed", 256), signalRow("OilTemp", 258)];
    const onSetSignalColors = vi.fn();
    renderPanel({ projectCtxOverride: { onSetSignalColors } });
    await screen.findByText(/OilTemp/);
    fireEvent.click(screen.getByText(/Coolant/));
    fireEvent.click(screen.getByText(/EngineSpeed/), { ctrlKey: true });
    expect(selectedText()).toHaveLength(2);

    // OilTemp is outside the selection — the right-click replaces it.
    fireEvent.contextMenu(nameSpan("OilTemp"));
    expect(selectedText()).toHaveLength(1);
    expect(selectedText()[0]).toContain("OilTemp");
    fireEvent.change(colorInputFor("OilTemp"), { target: { value: "#abcdef" } });

    expect(onSetSignalColors).toHaveBeenCalledTimes(1);
    const entries = onSetSignalColors.mock.calls[0][0] as { key: string; color: string }[];
    expect(entries).toHaveLength(1);
    expect(entries[0].color).toBe("#abcdef");
  });

  it("skips a pattern chip carried along in the selection", async () => {
    // Default ROWS (from beforeEach): an unsectioned Coolant and a
    // "Pack" section holding EngineSpeed. Give Pack a live pattern so
    // it has a chip to select.
    const onSetSignalColors = vi.fn();
    renderPanel({
      params: {
        sections: { names: ["Pack"], assignments: {}, patterns: { Pack: ["^Powertrain/"] } },
      },
      projectCtxOverride: { onSetSignalColors },
    });
    await screen.findByRole("button", { name: "patterns for section Pack" });
    fireEvent.click(screen.getByRole("button", { name: "patterns for section Pack" }));
    const grip = document.querySelector(".pattern-editor-grip") as HTMLElement;
    expect(grip).not.toBeNull();

    fireEvent.click(screen.getByText(/Coolant/));
    fireEvent.click(grip, { ctrlKey: true });

    fireEvent.contextMenu(nameSpan("Coolant"));
    fireEvent.change(colorInputFor("Coolant"), { target: { value: "#112233" } });

    expect(onSetSignalColors).toHaveBeenCalledTimes(1);
    const entries = onSetSignalColors.mock.calls[0][0] as { key: string; color: string }[];
    // Only Coolant — the pattern chip in the same selection carries no
    // signal key, so it drops out silently (ADR 0045).
    expect(entries).toHaveLength(1);
    expect(entries[0].color).toBe("#112233");
  });
});

describe("D10 end to end", () => {
  /// `useCommands` itself — the capture-phase document listener, the
  /// real binding resolution — with the migrated panel inside it. The
  /// base slice could only drive a hand-wired copy of this.
  function CommandsHarness({ chord, onFired }: { chord: string; onFired: () => void }) {
    const nullRef = { current: null } as React.MutableRefObject<never | null>;
    const commands = useCommands({
      dockApiRef: nullRef,
      focusHistoryRef: { current: { entries: [], index: -1 } },
      layoutHistoryRef: { current: { entries: [], index: -1 } },
      applyingLayoutRef: { current: false },
      registry: [],
      activePanel: null,
      projectPath: null,
      hasMaximizedView: false,
      notes: { notes: [], add: () => {}, update: () => {}, remove: () => {} },
      firstIndex: 0,
      firstIndexTsNs: null,
      sessionStartSeconds: 0,
      renameElement: () => {},
      appCommands: { "capture.clear": onFired },
      recentCaptures: [],
      openRecentCapture: () => {},
      recentProjects: [],
      openRecentProject: () => {},
    } as unknown as Parameters<typeof useCommands>[0]);
    return (
      <>
        <button
          type="button"
          data-testid="bind"
          onClick={() => commands.keybindings.setUser([{ chord, commandId: "capture.clear" }])}
        >
          bind
        </button>
        <div data-testid="outside" />
        <SignalsPanel
          {...({ params: {}, api: { updateParameters: vi.fn() } } as unknown as Parameters<
            typeof SignalsPanel
          >[0])}
        />
      </>
    );
  }

  it("does not fire a globally-bound arrow chord while focus is in the grid", async () => {
    ROWS = [signalRow("Coolant", 257), signalRow("EngineSpeed", 256)];
    const fired = vi.fn();
    render(
      <Providers>
        <CommandsHarness chord="ArrowDown" onFired={fired} />
      </Providers>,
    );
    await screen.findByText(/EngineSpeed/);
    fireEvent.click(screen.getByTestId("bind"));

    // Outside the grid the chord is a normal global binding.
    fireEvent.keyDown(screen.getByTestId("outside"), { key: "ArrowDown" });
    await waitFor(() => expect(fired).toHaveBeenCalledTimes(1));

    // Inside it the dispatcher stands down and the grid navigates.
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(fired).toHaveBeenCalledTimes(1);
    expect(activeRow()).toHaveTextContent("Coolant");
  });
});
