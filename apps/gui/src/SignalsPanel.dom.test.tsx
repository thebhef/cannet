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

import type { SignalSnapshotRecord } from "./types";

import {
  LONG_MESSAGE_NAME,
  LONG_MESSAGE_TAIL,
  LONG_SIGNAL_NAME,
  LONG_SIGNAL_TAIL,
  expectMiddleEllipsis,
} from "./longNameTestKit";

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

/// A raw bit field: unscaled, unitless, no `VAL_` table, whose DBC asks
/// for hex (`display_hex`) — the value column renders the bits.
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
  display_hex: true,
  value: 5124095576030430,
  raw: 5124095576030430,
  rate: 1,
  count: 3,
  time_seconds: 2.5,
};

// The rows the mocked host returns; a test can swap them (the jsdom
// viewport fits two).
let ROWS: SignalSnapshotRecord[] = DEFAULT_ROWS;

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
import { SIGNAL_DND_MIME } from "./dragSignals";
import { SignalCatalogProvider } from "./signalCatalogContext";
import { signalKey } from "./plotData";
import { stableSignalColor } from "./palette";

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

function renderPanel(opts?: {
  params?: Record<string, unknown>;
  signalColors?: Record<string, string>;
}) {
  const api = { updateParameters: vi.fn() };
  const props = { params: opts?.params ?? {}, api } as unknown as Parameters<typeof SignalsPanel>[0];
  const registry = makeRegistry();
  const ctx = opts?.signalColors ? { ...projectCtx, signalColors: opts.signalColors } : projectCtx;
  render(
    <TraceDataProvider value={traceData}>
      <ProjectContext.Provider value={ctx}>
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
  ROWS = DEFAULT_ROWS;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SignalsPanel", () => {
  it("marks a file-backed row by source and labels it with its channel group", async () => {
    // A file-backed signal (docs/CONTEXT.md) has no message and no ECU,
    // so the message column carries its source channel group plus a
    // badge saying the row is not decoded from frames. Trace views
    // never show it; this grid does.
    ROWS = [
      {
        bus_id: null,
        transmitter: null,
        message_id: 1,
        extended: false,
        message_name: "Analog",
        signal_name: "EngineSpeed",
        unit: "rpm",
        is_enum: false,
        value: 1037.5,
        raw: null,
        rate: 83.3,
        count: 20,
        time_seconds: 0.228,
        file_backed: true,
      },
      DEFAULT_ROWS[0],
    ];
    renderPanel();
    const badge = await waitFor(() => {
      const el = document.querySelector(".signal-source-badge");
      if (!el) throw new Error("badge not yet rendered");
      return el as HTMLElement;
    });
    expect(badge.textContent).toBe("file");
    expect(badge.getAttribute("title")).toMatch(/not decoded from frames/);
    expect(screen.getByText(/Analog/)).toBeInTheDocument();
    // The DBC-backed row beside it wears no badge.
    expect(document.querySelectorAll(".signal-source-badge")).toHaveLength(1);
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

  it("colors a signal name through the shared resolver: the project pick, else the identity hash", async () => {
    // ADR 0026's one wheel, one resolution point: the signal view reads
    // the same precedence (pick → generator → hash) the plot does. An
    // unpicked signal is colored by its identity alone, so it keeps that
    // color across sorts, views and sessions with nothing stored.
    const picked = signalKey("p", 256, false, "EngineSpeed");
    const unpicked = signalKey("p", 512, false, "DeadSignal");
    renderPanel({ signalColors: { [picked]: "#ff00ff" } });
    await waitFor(() => {
      expect(screen.getByText(/EngineSpeed/)).toBeInTheDocument();
    });
    expect(screen.getByText(/EngineSpeed/)).toHaveStyle({ color: "#ff00ff" });
    expect(screen.getByText(/DeadSignal/)).toHaveStyle({
      color: stableSignalColor(unpicked),
    });
  });

  it("renders a raw bit field in hex only when the DBC asked for it", async () => {
    ROWS = [RAW_FIELD_ROW, DEFAULT_ROWS[0]];
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Serial/)).toBeInTheDocument();
    });
    expect(screen.getByText("0x123456789ABCDE")).toBeInTheDocument();
    expect(screen.queryByText("5124095576030430")).not.toBeInTheDocument();
    // A scaled, united signal is untouched.
    expect(screen.getByText("1165")).toBeInTheDocument();

    // The same raw field without the DBC's opt-in reads base 10 — and
    // digit-exact, not 5.12e+15.
    cleanup();
    ROWS = [{ ...RAW_FIELD_ROW, display_hex: false }, DEFAULT_ROWS[0]];
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("5124095576030430")).toBeInTheDocument();
    });
    expect(screen.queryByText("0x123456789ABCDE")).not.toBeInTheDocument();
  });

  it("edits an existing pattern in place and re-queries the host with it", async () => {
    // A pattern used to be removable and re-typable only. Editing the
    // row must reach the host — the signal view evaluates the selection
    // host-side, so the proof is the next `fetch_signal_page` carrying
    // the new pattern in the same slot.
    renderPanel({ params: { selection: { keys: [], patterns: ["EngineSpeed"] } } });
    fireEvent.click(screen.getByRole("button", { name: /Selection \(0 \+ 1 Patterns\)/ }));
    const input = screen.getByLabelText("pattern 1") as HTMLInputElement;
    expect(input.value).toBe("EngineSpeed");
    fireEvent.change(input, { target: { value: "EngineTemp" } });
    fireEvent.blur(input);
    await waitFor(() => {
      const last = [...invokeCalls].reverse().find((c) => c.cmd === "fetch_signal_page");
      const sel = last?.args?.selection as { patterns: string[] } | undefined;
      expect(sel?.patterns).toEqual(["EngineTemp"]);
    });
    // Edited in place: still one pattern, not removed-and-re-added.
    expect(screen.getByRole("button", { name: /Selection \(0 \+ 1 Patterns\)/ })).toBeInTheDocument();
  });

  it("abandons a pattern edit on Escape", async () => {
    renderPanel({ params: { selection: { keys: [], patterns: ["EngineSpeed"] } } });
    fireEvent.click(screen.getByRole("button", { name: /Selection \(0 \+ 1 Patterns\)/ }));
    const input = screen.getByLabelText("pattern 1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nonsense" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    await waitFor(() => {
      expect((screen.getByLabelText("pattern 1") as HTMLInputElement).value).toBe("EngineSpeed");
    });
    const last = [...invokeCalls].reverse().find((c) => c.cmd === "fetch_signal_page");
    const sel = last?.args?.selection as { patterns: string[] } | undefined;
    expect(sel?.patterns).toEqual(["EngineSpeed"]);
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
      expect(screen.getByRole("button", { name: /Selection \(1\)/ })).toBeInTheDocument();
    });
    // …and the next host fetch carries the key.
    await waitFor(() => {
      const last = [...invokeCalls].reverse().find((c) => c.cmd === "fetch_signal_page");
      const sel = last?.args?.selection as { keys: { signalName: string }[] } | undefined;
      expect(sel?.keys.map((k) => k.signalName)).toEqual(["EngineSpeed"]);
    });
  });

  describe("view-signals push", () => {
    it("pushes its manual selection on mount, and un-pushes on unmount", async () => {
      renderPanel({ params: { elementId: "el-view-signals" } });
      await waitFor(() => {
        expect(
          invokeCalls.some(
            (c) =>
              c.cmd === "set_view_signals" &&
              c.args?.viewId === "el-view-signals" &&
              Array.isArray(c.args?.signals) &&
              (c.args?.signals as unknown[]).length === 0,
          ),
        ).toBe(true);
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
      await waitFor(() => {
        const last = [...invokeCalls]
          .reverse()
          .find((c) => c.cmd === "set_view_signals" && c.args?.viewId === "el-view-signals");
        expect(last?.args?.signals).toEqual([
          {
            busId: "p",
            messageId: 256,
            extended: false,
            signalName: "EngineSpeed",
            fileBacked: undefined,
            messageName: "EngineData",
            unit: "rpm",
          },
        ]);
      });

      cleanup();
      expect(
        invokeCalls.some(
          (c) => c.cmd === "remove_view_signals" && c.args?.viewId === "el-view-signals",
        ),
      ).toBe(true);
    });
  });
});

describe("SignalsPanel toolbar", () => {
  // The Selection chip and the Add Section chip are two different chips
  // with two different effects — one opens an in-panel editor, the
  // other creates a section — so a test that only checks "something
  // changed" cannot tell one wired to the other's handler.
  it("opens and closes the selection editor from its own chip, leaving no section behind", () => {
    renderPanel();
    const selectionChip = () => screen.getByRole("button", { name: /^Selection \(/ });
    expect(document.querySelector(".signals-selection-editor")).toBeNull();
    fireEvent.click(selectionChip());
    expect(document.querySelector(".signals-selection-editor")).not.toBeNull();
    expect(selectionChip()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(selectionChip());
    expect(document.querySelector(".signals-selection-editor")).toBeNull();
    // Toggling the editor never touches the section list.
    expect(document.querySelector(".signals-section-header")).toBeNull();
  });
});

describe("SignalsPanel tail reachability", () => {
  // The panel used to hand-roll `useTraceViewport`'s arithmetic, and its
  // copy carried the same defect the chronological trace had: the anchor
  // bound subtracted `visibleRowCount`, whose two-row render pad stops
  // the bound two rows past the end, so the last rows stacked below the
  // sticky viewport's fold with no scroll position that reached them.
  //
  // jsdom does no layout, so the viewport height is stubbed and the
  // assertion is on the offset the view *writes*: the sticky viewport
  // is `overflow: hidden` at exactly `viewportHeight`, so a row placed
  // past it is rendered and invisible.
  const VH = 440; // exactly 20 rows
  let restore: (() => void) | null = null;

  beforeEach(() => {
    const prev = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
    Object.defineProperty(Element.prototype, "clientHeight", {
      configurable: true,
      get: () => VH,
    });
    restore = () => Object.defineProperty(Element.prototype, "clientHeight", prev!);
    ROWS = Array.from({ length: 200 }, (_, i) => ({
      ...DEFAULT_ROWS[0],
      message_id: 256 + i,
      signal_name: `Sig${i}`,
    }));
  });
  afterEach(() => restore?.());

  it("scrolls to its last row", async () => {
    renderPanel();
    await screen.findByTitle(/^Sig0 —/);
    const rowsEl = document.querySelector(".trace-rows") as HTMLElement;
    Object.defineProperty(rowsEl, "scrollTop", { value: 0, writable: true });

    rowsEl.scrollTop = 200 * 22 - VH; // the thumb, all the way down
    fireEvent.scroll(rowsEl);

    const last = await screen.findByTitle(/^Sig199 —/);
    const row = last.closest(".trace-row") as HTMLElement;
    expect(Number.parseFloat(row.style.top)).toBeLessThan(VH);
  });
});

describe("SignalsPanel with long names", () => {
  it("splits the signal and message names, and leaves a short one alone", async () => {
    ROWS = [
      { ...DEFAULT_ROWS[0], signal_name: LONG_SIGNAL_NAME, message_name: LONG_MESSAGE_NAME },
      { ...DEFAULT_ROWS[0], signal_name: "EngineSpeed", message_name: "EngineData" },
    ];
    renderPanel();
    await waitFor(() => expect(document.querySelectorAll(".trace-row")).toHaveLength(2));
    const rows = document.querySelectorAll(".trace-row");
    expectMiddleEllipsis(rows[0].querySelector(".col-signal"), LONG_SIGNAL_NAME, LONG_SIGNAL_TAIL);
    expectMiddleEllipsis(rows[0].querySelector(".col-msg"), LONG_MESSAGE_NAME, LONG_MESSAGE_TAIL);
    // The name's own tooltip keeps the drag/recolor hint the column
    // already carried, so the affordance is not traded for the name.
    expect(
      rows[0].querySelector(".col-signal .name-text")!.getAttribute("title"),
    ).toBe(`${LONG_SIGNAL_NAME} — drag to a plot; right-click to recolor`);
    expect(rows[1].querySelector(".name-text")).toBeNull();
  });
});
