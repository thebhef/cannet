// @vitest-environment jsdom
//
// DOM tests for **math signals** (`docs/CONTEXT.md`) on the signal view
// panel — the third surface the shared editor mounts on, after the
// Database panel's Computed branch and a plot's side list.
//
// What is pinned here is the row: it names its definition, wears a chip
// per bus feeding it, drags out carrying its provenance, and expands
// *in place* into the editor (never a dialog, and never behind a
// read-only stage). The editor's own behaviour is
// `MathSignalEditor.dom.test.tsx`; the host's row synthesis is
// `signal_snapshot.rs`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { MathSignalRecord, SignalSnapshotRecord } from "./types";

const MATH_ROW: SignalSnapshotRecord = {
  bus_id: null,
  transmitter: null,
  message_id: 0,
  extended: false,
  // The host puts the *display* name here; the id is in `signal_name`.
  message_name: "CellSpread",
  signal_name: "m1",
  unit: "V",
  is_enum: false,
  value: 1.25,
  raw: null,
  rate: null,
  count: 17,
  time_seconds: 4.5,
  math: true,
};

const PLAIN_ROW: SignalSnapshotRecord = {
  bus_id: "p",
  transmitter: "EngineEcu",
  message_id: 256,
  extended: false,
  message_name: "EngineData",
  signal_name: "EngineSpeed",
  unit: "rpm",
  is_enum: false,
  value: 1165,
  raw: 4660,
  rate: 10,
  count: 42,
  time_seconds: 1.5,
};

function mathRecord(over: Partial<MathSignalRecord> = {}): MathSignalRecord {
  return {
    id: "m1",
    name: "CellSpread",
    unit: null,
    function: { kind: "range" },
    operands: { picks: [], patterns: ["Cell\\d+"] },
    identity: "*|m:0:m1",
    kind: "range",
    arity: "set",
    resolvedOperands: [],
    operandPaths: [],
    operandAffines: [],
    unconverted: [],
    unitResolved: "V",
    busIds: ["p"],
    invalid: null,
    ...over,
  };
}

let ROWS: SignalSnapshotRecord[] = [];
let MATH: MathSignalRecord[] = [];
const invokeCalls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args });
    if (cmd === "list_signals") return [];
    if (cmd === "list_math_signals") return MATH;
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
import { parseSignalDragData, SIGNAL_DND_MIME } from "./dragSignals";
import { SignalCatalogProvider } from "./signalCatalogContext";
import { MathSignalsProvider } from "./mathSignalsContext";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type TS = ReturnType<typeof freshTrace>;
type Entry = { element: { kind: "signals"; id: string; config?: Record<string, unknown> }; trace: TS };
function makeRegistry(): ElementRegistry {
  const map = new Map<string, Entry>();
  const entry = (id: string): Entry => ({
    element: { kind: "signals", id },
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
  buses: [
    { id: "p", name: "Powertrain" },
    { id: "z", name: "Zonal" },
  ],
  interfaceBindings: [],
  connectedAddresses: [],
  connectedBusIds: [],
  remoteConnected: false,
  blfPath: null,
  localVirtualBuses: [],
  busesWithPendingHwConfig: [],
  signalColors: {},
  onSetSignalColor: () => {},
} as unknown as ProjectContextValue;

function renderPanel() {
  const api = { updateParameters: vi.fn() };
  const props = { params: {}, api } as unknown as Parameters<typeof SignalsPanel>[0];
  render(
    <TraceDataProvider value={traceData}>
      <ProjectContext.Provider value={projectCtx}>
        <SignalCatalogProvider>
          <MathSignalsProvider>
            <ElementRegistryContext.Provider value={makeRegistry()}>
              <SignalsPanel {...props} />
            </ElementRegistryContext.Provider>
          </MathSignalsProvider>
        </SignalCatalogProvider>
      </ProjectContext.Provider>
    </TraceDataProvider>,
  );
  return { api };
}

const mathRowEl = () => document.querySelector(".trace-row.math") as HTMLElement | null;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  invokeCalls.length = 0;
  ROWS = [MATH_ROW, PLAIN_ROW];
  MATH = [mathRecord()];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("a math signal's row", () => {
  it("names the definition and shows its computed value", async () => {
    renderPanel();
    await waitFor(() => expect(mathRowEl()).not.toBeNull());
    expect(mathRowEl()!).toHaveTextContent("CellSpread");
    // The stable id identifies the series; it is not what the row reads
    // as, so a rename leaves every reference to it alone.
    expect(mathRowEl()!).not.toHaveTextContent("m1");
    expect(mathRowEl()!).toHaveTextContent("1.25");
  });

  it("wears one bus chip per contributing bus and says so when several do", async () => {
    renderPanel();
    await waitFor(() => expect(mathRowEl()).not.toBeNull());
    expect(mathRowEl()!.querySelectorAll(".plot-bus-swatch")).toHaveLength(1);
    expect(mathRowEl()!).toHaveTextContent("Powertrain · Math");

    MATH = [mathRecord({ busIds: ["p", "z"] })];
    cleanup();
    renderPanel();
    await waitFor(() => expect(mathRowEl()).not.toBeNull());
    await waitFor(() =>
      expect(mathRowEl()!.querySelectorAll(".plot-bus-swatch")).toHaveLength(2),
    );
    expect(mathRowEl()!).toHaveTextContent("Math - Multiple Busses");
  });

  it("expands in place into the editor, and nothing stands in front of it", async () => {
    renderPanel();
    await waitFor(() => expect(mathRowEl()).not.toBeNull());
    expect(document.querySelector(".math-editor")).toBeNull();
    const disclosure = mathRowEl()!.querySelector(".disclosure-toggle") as HTMLElement;
    expect(disclosure).not.toBeNull();
    fireEvent.click(disclosure);
    const editor = await waitFor(() => {
      const e = document.querySelector(".math-editor");
      expect(e).not.toBeNull();
      return e!;
    });
    expect(editor.closest("[role=dialog], .modal")).toBeNull();
    // Its own block, disclosed under the row that opened it.
    expect(document.querySelector(".signals-math-detail")!.contains(editor)).toBe(true);
    fireEvent.click(disclosure);
    await waitFor(() => expect(document.querySelector(".math-editor")).toBeNull());
  });

  it("leaves an ordinary row with no disclosure at all", async () => {
    renderPanel();
    await waitFor(() => expect(mathRowEl()).not.toBeNull());
    const plain = [...document.querySelectorAll(".trace-row")].find(
      (r) => !r.classList.contains("math") && r.textContent?.includes("EngineSpeed"),
    )!;
    expect(plain.querySelector(".disclosure-toggle")).toBeNull();
  });

  it("drags out carrying its provenance and its stable id", async () => {
    renderPanel();
    await waitFor(() => expect(mathRowEl()).not.toBeNull());
    const store: Record<string, string> = {};
    const dt = {
      setData: (t: string, d: string) => {
        store[t] = d;
      },
      getData: (t: string) => store[t] ?? "",
      get types() {
        return Object.keys(store);
      },
      effectAllowed: "none",
    } as unknown as DataTransfer;
    fireEvent.dragStart(mathRowEl()!, { dataTransfer: dt });
    const refs = parseSignalDragData(dt.getData(SIGNAL_DND_MIME)).signals;
    expect(refs).toEqual([
      expect.objectContaining({ signalName: "m1", math: true, busId: null }),
    ]);
  });

  it("asks the host for it by its own provenance", async () => {
    renderPanel();
    // A drop puts the reference in the selection; here the panel starts
    // empty, so what is pinned is the shape the wire selection takes
    // once one is there. Drop one and read the next page request.
    const MIME = SIGNAL_DND_MIME;
    const payload = JSON.stringify({
      signals: [
        {
          busId: null,
          messageId: 0,
          extended: false,
          signalName: "m2",
          messageName: "Math",
          unit: "",
          math: true,
        },
      ],
      patterns: [],
    });
    const dt = {
      types: [MIME, "application/x-cannet-drag-signals"],
      getData: (t: string) => (t === MIME ? payload : ""),
      dropEffect: "",
    };
    const panel = document.querySelector(".signals-panel")!;
    fireEvent.dragOver(panel, { dataTransfer: dt });
    fireEvent.drop(panel, { dataTransfer: dt });
    await waitFor(() => {
      const page = invokeCalls
        .filter((c) => c.cmd === "fetch_signal_page")
        .map((c) => c.args?.selection as { keys?: Record<string, unknown>[] })
        .filter((s) => (s?.keys ?? []).some((k) => k.signalName === "m2"));
      expect(page.length).toBeGreaterThan(0);
      expect(page[page.length - 1].keys![0]).toEqual(
        expect.objectContaining({ signalName: "m2", math: true }),
      );
    });
  });
});
