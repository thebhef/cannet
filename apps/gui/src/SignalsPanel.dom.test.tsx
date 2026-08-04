// @vitest-environment jsdom
//
// Component tests for the signal view panel: rows come from the mocked
// host `fetch_signal_page` (values, blank never-seen descriptors), and
// dropping a dragged signal adds it to the manual selection. The
// selection/sort/paging logic itself is host-side (Rust tests);
// this exercises the panel's React wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { SignalDescriptorRecord, SignalSnapshotRecord } from "./types";

const DEFAULT_ROWS: SignalSnapshotRecord[] = [
  {
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
  },
  {
    // Never seen in the window: the row still renders, blank.
    bus_id: "p",
    transmitter: "DeadEcu",
    message_id: 512,
    extended: false,
    message_name: "DeadMsg",
    signal_name: "DeadSignal",
    unit: "",
    is_enum: false,
    value: null,
    raw: null,
    rate: null,
    count: null,
    time_seconds: null,
  },
];

/// A raw bit field: unscaled, unitless, no `VAL_` table. The host flags
/// it and the value column renders the bits, not 16 decimal digits.
const RAW_FIELD_ROW: SignalSnapshotRecord = {
  bus_id: "p",
  transmitter: "EngineEcu",
  message_id: 257,
  extended: false,
  message_name: "EcuInfo",
  signal_name: "Serial",
  unit: "",
  is_enum: false,
  raw_field: true,
  value: 5124095576030430,
  raw: 5124095576030430,
  rate: 1,
  count: 3,
  time_seconds: 2.5,
};

// The rows the mocked host returns; a test can swap them (the jsdom
// viewport fits two).
let ROWS: SignalSnapshotRecord[] = DEFAULT_ROWS;

// The `list_signals` catalog. Empty by default; a test can set entries
// to exercise the "add signal" picker.
let SIGNALS: SignalDescriptorRecord[] = [];
const invokeCalls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args });
    if (cmd === "list_signals") return SIGNALS;
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
import { SIGNAL_DND_MIME } from "./dragSignals";
import { openCombobox } from "./comboboxTestKit";
import { SignalCatalogProvider } from "./signalCatalogContext";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type TS = ReturnType<typeof freshTrace>;
type Entry = { element: { kind: "signals"; id: string; config?: Record<string, unknown> }; trace: TS };
function makeRegistry(seed?: { id: string; config?: Record<string, unknown> }): ElementRegistry {
  const map = new Map<string, Entry>();
  const entry = (id: string, config?: Record<string, unknown>): Entry => ({
    element: { kind: "signals", id, config },
    trace: freshTrace(0),
  });
  if (seed) map.set(seed.id, entry(seed.id, seed.config));
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
};

function renderPanel(opts?: { params?: Record<string, unknown> }) {
  const api = { updateParameters: vi.fn() };
  const props = { params: opts?.params ?? {}, api } as unknown as Parameters<typeof SignalsPanel>[0];
  const registry = makeRegistry();
  render(
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
  return { api, registry };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  invokeCalls.length = 0;
  SIGNALS = [];
  ROWS = DEFAULT_ROWS;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SignalsPanel", () => {
  it("lists the DBC signal catalog in the 'add signal' picker, grouped by ECU/message", async () => {
    SIGNALS = [
      {
        bus_id: "p",
        message_id: 256,
        extended: false,
        message_name: "EngineData",
        transmitter: "EngineEcu",
        signal_name: "EngineSpeed",
        unit: "rpm",
        is_enum: false,
      },
    ];
    renderPanel();
    openCombobox(screen.getByLabelText("add signal"));
    const option = await waitFor(() => {
      const el = document.querySelector('[role="option"]');
      if (!el) throw new Error("option not yet rendered");
      return el as HTMLElement;
    });
    expect(option.textContent).toBe("EngineSpeed [rpm]");
    const headers = Array.from(document.querySelectorAll(".combobox-group")).map(
      (h) => h.textContent,
    );
    expect(headers).toContain("EngineEcu");
    expect(headers).toContain("EngineData");

    fireEvent.click(option);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /selection \(1\)/ })).toBeInTheDocument();
    });
  });

  it("renders one row per snapshot record, blanks included", async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/EngineSpeed/)).toBeInTheDocument();
    });
    // A live row shows its value; the count column defaults hidden.
    expect(screen.getByText("1165")).toBeInTheDocument();
    expect(screen.queryByText("42")).not.toBeInTheDocument();
    // A never-seen descriptor still gets a (blank) row.
    expect(screen.getByText(/DeadSignal/)).toBeInTheDocument();
    expect(screen.getByText("DeadEcu")).toBeInTheDocument();
  });

  it("renders a host-flagged raw bit field in hex", async () => {
    ROWS = [RAW_FIELD_ROW, DEFAULT_ROWS[0]];
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Serial/)).toBeInTheDocument();
    });
    expect(screen.getByText("0x123456789ABCDE")).toBeInTheDocument();
    expect(screen.queryByText("5124095576030430")).not.toBeInTheDocument();
    // A scaled, united signal is untouched.
    expect(screen.getByText("1165")).toBeInTheDocument();
  });

  it("dropping a dragged signal adds it to the manual selection", async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/EngineSpeed/)).toBeInTheDocument();
    });
    const payload = JSON.stringify({
      signals: [
        {
          busId: "p",
          messageId: 256,
          extended: false,
          signalName: "EngineSpeed",
          messageName: "EngineData",
          unit: "rpm",
        },
      ],
    });
    const panel = document.querySelector(".signals-panel")!;
    fireEvent.drop(panel, {
      dataTransfer: {
        types: [SIGNAL_DND_MIME],
        getData: (mime: string) => (mime === SIGNAL_DND_MIME ? payload : ""),
      },
    });
    // The toolbar's selection summary reflects the new manual pick…
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /selection \(1\)/ })).toBeInTheDocument();
    });
    // …and the next host fetch carries the key.
    await waitFor(() => {
      const last = [...invokeCalls].reverse().find((c) => c.cmd === "fetch_signal_page");
      const sel = last?.args?.selection as { keys: { signalName: string }[] } | undefined;
      expect(sel?.keys.map((k) => k.signalName)).toEqual(["EngineSpeed"]);
    });
  });
});
