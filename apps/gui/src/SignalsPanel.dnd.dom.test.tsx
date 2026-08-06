// @vitest-environment jsdom
//
// Drag and drop in and out of the signal view (ADR 0045): what a grab
// means (a row, a selection, a section header, a pattern chip), and
// what the panel does with a payload dropped on a section, on another
// section header, or on itself.
//
// The payload encoding itself is unit-tested (`dragSignals.test.ts`);
// these drive the real `DataTransfer` round trip through the panel, so
// a gesture is asserted end to end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { SignalPageRow, SignalSectionsWire } from "./types";
import { SIGNAL_DND_MIME, parseSignalDragData } from "./dragSignals";

function signalRow(name: string, id: number, section?: string): SignalPageRow {
  return {
    kind: "signal",
    bus_id: "p",
    transmitter: "EngineEcu",
    message_id: id,
    extended: false,
    message_name: "EngineData",
    signal_name: name,
    unit: "rpm",
    is_enum: false,
    value: 1,
    raw: 1,
    rate: null,
    count: null,
    time_seconds: null,
    ...(section == null ? {} : { section }),
  } as SignalPageRow;
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
  render(
    <TraceDataProvider value={traceData}>
      <ProjectContext.Provider value={projectCtx}>
        <SignalCatalogProvider>
          <ElementRegistryContext.Provider value={makeRegistry()}>
            <SignalsPanel {...props} />
          </ElementRegistryContext.Provider>
        </SignalCatalogProvider>
      </ProjectContext.Provider>
    </TraceDataProvider>,
  );
}

/// A `DataTransfer` stand-in. Every event of one gesture must be handed
/// the *same* object — that is what makes the round trip real.
function fakeTransfer() {
  const store = new Map<string, string>();
  return {
    setData: (t: string, v: string) => store.set(t, v),
    getData: (t: string) => store.get(t) ?? "",
    get types() {
      return [...store.keys()];
    },
    effectAllowed: "",
    dropEffect: "",
  } as unknown as DataTransfer;
}

/// Seed a transfer with a payload from *outside* the panel, the way the
/// DBC panel or a trace row does.
function externalTransfer(payload: { signals?: unknown[]; patterns?: string[] }) {
  const dt = fakeTransfer();
  dt.setData(SIGNAL_DND_MIME, JSON.stringify({ signals: [], patterns: [], ...payload }));
  return dt;
}

const ENGINE = {
  busId: "p",
  messageId: 256,
  extended: false,
  signalName: "EngineSpeed",
  messageName: "EngineData",
  unit: "rpm",
};
const ENGINE_KEY = "p|s:256:EngineSpeed";
const COOLANT_KEY = "p|s:257:Coolant";

function lastSections(): SignalSectionsWire | undefined {
  const last = [...invokeCalls].reverse().find((c) => c.cmd === "fetch_signal_page");
  return last?.args?.sections as SignalSectionsWire | undefined;
}
function lastKeys(): string[] {
  const last = [...invokeCalls].reverse().find((c) => c.cmd === "fetch_signal_page");
  const sel = last?.args?.selection as { keys: { signalName: string }[] } | undefined;
  return (sel?.keys ?? []).map((k) => k.signalName);
}

const nameCell = (signal: string) => screen.getByText(new RegExp(signal)) as HTMLElement;
/// A section header's label — its drag grip. By class, not by text: a
/// row's section cell carries the same name.
const sectionLabel = (name: string): HTMLElement => {
  const el = [...document.querySelectorAll(".signals-section-label")].find(
    (n) => n.textContent === name,
  );
  if (!el) throw new Error(`no section header named ${name}`);
  return el as HTMLElement;
};
const headerOf = (name: string) =>
  sectionLabel(name).closest(".signals-section-header") as HTMLElement;

let restoreHeight: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const prev = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 440 });
  restoreHeight = () => Object.defineProperty(Element.prototype, "clientHeight", prev!);
  invokeCalls.length = 0;
  ROWS = [
    headerRow("", 1),
    signalRow("Coolant", 257),
    headerRow("Pack", 1),
    signalRow("EngineSpeed", 256, "Pack"),
  ];
});
afterEach(() => {
  cleanup();
  restoreHeight?.();
  vi.unstubAllGlobals();
});

const SECTIONED = {
  params: { sections: { names: ["Pack"], assignments: { [ENGINE_KEY]: "Pack" } } },
};

describe("what a grab means", () => {
  it("drags the one concrete signal a row names", async () => {
    renderPanel(SECTIONED);
    await screen.findByText(/EngineSpeed/);
    const dt = fakeTransfer();
    fireEvent.dragStart(nameCell("EngineSpeed"), { dataTransfer: dt });
    const payload = parseSignalDragData(dt.getData(SIGNAL_DND_MIME));
    expect(payload.signals.map((s) => s.signalName)).toEqual(["EngineSpeed"]);
    expect(payload.patterns).toEqual([]);
    expect(payload.sourcePanelId).not.toBeNull();
  });

  it("drags the whole selection when the grabbed row is in it", async () => {
    renderPanel(SECTIONED);
    await screen.findByText(/EngineSpeed/);
    fireEvent.click(nameCell("Coolant"));
    fireEvent.click(nameCell("EngineSpeed"), { ctrlKey: true });
    const dt = fakeTransfer();
    fireEvent.dragStart(nameCell("EngineSpeed"), { dataTransfer: dt });
    const payload = parseSignalDragData(dt.getData(SIGNAL_DND_MIME));
    expect(payload.signals.map((s) => s.signalName).sort()).toEqual(["Coolant", "EngineSpeed"]);
  });

  it("drags a section header as the whole unit: its signals and its patterns", async () => {
    renderPanel({
      params: {
        sections: {
          names: ["Pack"],
          assignments: { [ENGINE_KEY]: "Pack" },
          patterns: { Pack: ["^Powertrain/"] },
        },
      },
    });
    await screen.findByText(/EngineSpeed/);
    const dt = fakeTransfer();
    fireEvent.dragStart(sectionLabel("Pack"), { dataTransfer: dt });
    const payload = parseSignalDragData(dt.getData(SIGNAL_DND_MIME));
    expect(payload.signals.map((s) => s.signalName)).toEqual(["EngineSpeed"]);
    expect(payload.patterns).toEqual(["^Powertrain/"]);
  });

  it("drags a pattern chip, live, and selects it alongside the rows", async () => {
    renderPanel({
      params: {
        selection: { keys: [], patterns: [] },
        sections: { names: ["Pack"], assignments: {}, patterns: { Pack: ["^Powertrain/"] } },
      },
    });
    await screen.findByRole("button", { name: "patterns for section Pack" });
    fireEvent.click(screen.getByRole("button", { name: "patterns for section Pack" }));
    const grip = document.querySelector(".pattern-editor-grip") as HTMLElement;
    expect(grip).not.toBeNull();
    const dt = fakeTransfer();
    fireEvent.dragStart(grip, { dataTransfer: dt });
    const payload = parseSignalDragData(dt.getData(SIGNAL_DND_MIME));
    expect(payload.patterns).toEqual(["^Powertrain/"]);
    expect(payload.signals).toEqual([]);
    // …and it joins the same selection set the rows live in, so one
    // grab can carry both kinds.
    fireEvent.click(nameCell("Coolant"));
    fireEvent.click(grip, { ctrlKey: true });
    const mixed = fakeTransfer();
    fireEvent.dragStart(grip, { dataTransfer: mixed });
    const both = parseSignalDragData(mixed.getData(SIGNAL_DND_MIME));
    expect(both.patterns).toEqual(["^Powertrain/"]);
    expect(both.signals.map((s) => s.signalName)).toEqual(["Coolant"]);
  });
});

describe("dropping inside the panel", () => {
  it("assigns signals dropped on a section header to that section", async () => {
    renderPanel({ params: { sections: { names: ["Pack"], assignments: {} } } });
    await screen.findByText(/EngineSpeed/);
    const dt = externalTransfer({ signals: [ENGINE] });
    fireEvent.dragOver(headerOf("Pack"), { dataTransfer: dt });
    fireEvent.drop(headerOf("Pack"), { dataTransfer: dt });
    await waitFor(() => {
      expect(lastSections()?.assignments).toEqual({ [ENGINE_KEY]: "Pack" });
    });
    // It arrived from outside, so it also joins the manual picks.
    expect(lastKeys()).toEqual(["EngineSpeed"]);
  });

  it("assigns signals dropped anywhere in a section's row span", async () => {
    // The header is not the only target: the rows under it are the
    // section too, which is what makes the gesture usable at scale.
    renderPanel({ params: { sections: { names: ["Pack"], assignments: {} } } });
    await screen.findByText(/EngineSpeed/);
    const dt = externalTransfer({ signals: [{ ...ENGINE, messageId: 999, signalName: "Brake" }] });
    const row = nameCell("EngineSpeed").closest(".trace-row") as HTMLElement;
    fireEvent.drop(row, { dataTransfer: dt });
    await waitFor(() => {
      expect(lastSections()?.assignments).toEqual({ "p|s:999:Brake": "Pack" });
    });
  });

  it("merges patterns dropped on a section into that section", async () => {
    renderPanel({
      params: { sections: { names: ["Pack"], assignments: {}, patterns: { Pack: ["a"] } } },
    });
    await screen.findByRole("button", { name: "patterns for section Pack" });
    const dt = externalTransfer({ patterns: ["b"] });
    fireEvent.drop(headerOf("Pack"), { dataTransfer: dt });
    await waitFor(() => {
      expect(lastSections()?.patterns).toEqual({ Pack: ["a", "b"] });
    });
  });

  it("makes a new section for patterns dropped on the panel itself", async () => {
    renderPanel();
    await screen.findByText(/EngineSpeed/);
    const dt = externalTransfer({ patterns: ["^Powertrain/Bms/"] });
    fireEvent.drop(document.querySelector(".signals-panel")!, { dataTransfer: dt });
    await waitFor(() => {
      expect(lastSections()?.patterns).toEqual({ "Section 1": ["^Powertrain/Bms/"] });
    });
    expect(lastSections()?.names).toEqual(["Section 1"]);
  });

  it("reorders the sections when a header is dropped on another header", async () => {
    ROWS = [headerRow("Pack", 0), headerRow("Chassis", 0), headerRow("Body", 0)];
    renderPanel({
      params: { sections: { names: ["Pack", "Chassis", "Body"], assignments: {} } },
    });
    await screen.findByRole("button", { name: "patterns for section Body" });
    const dt = fakeTransfer();
    fireEvent.dragStart(sectionLabel("Body"), { dataTransfer: dt });
    fireEvent.dragOver(headerOf("Pack"), { dataTransfer: dt });
    fireEvent.drop(headerOf("Pack"), { dataTransfer: dt });
    await waitFor(() => {
      // The claim tie-break follows this order host-side, which is what
      // makes the gesture an edit of priority and not just of layout.
      expect(lastSections()?.names).toEqual(["Body", "Pack", "Chassis"]);
    });
  });

  it("adds no duplicate when a drop overlaps what is already there", async () => {
    // D11: one drop lands each signal at most once, whether the payload
    // overlaps itself or the target's existing content.
    renderPanel({
      params: {
        selection: {
          keys: [{ busId: "p", messageId: 256, extended: false, signalName: "EngineSpeed" }],
          patterns: [],
        },
        sections: { names: ["Pack"], assignments: {} },
      },
    });
    await screen.findByText(/EngineSpeed/);
    const dt = externalTransfer({
      signals: [ENGINE, { ...ENGINE }, { ...ENGINE, messageId: 257, signalName: "Coolant" }],
    });
    fireEvent.drop(headerOf("Pack"), { dataTransfer: dt });
    await waitFor(() => {
      expect(lastSections()?.assignments).toEqual({
        [ENGINE_KEY]: "Pack",
        [COOLANT_KEY]: "Pack",
      });
    });
    expect(lastKeys()).toEqual(["EngineSpeed", "Coolant"]);
  });
});
