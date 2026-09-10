// @vitest-environment jsdom
//
// DOM tests for the Database panel's **Computed** branch: the catalog
// surface for math signals (`docs/CONTEXT.md`). What is pinned here is
// the branch itself — the listing, creation from the tree's context
// menu, and that expanding a definition opens the editor *in place* on
// the invoking surface (there is no read-only detail step, and no
// dialog). The editor's own behaviour is
// `MathSignalEditor.dom.test.tsx`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type {
  Bus,
  DbcContentRecord,
  MathSignalRecord,
  SignalDescriptorRecord,
} from "./types";

const SIGNAL_DEFAULTS = {
  startBit: 0,
  length: 8,
  byteOrder: "little" as const,
  signed: false,
  factor: 1,
  offset: 0,
  min: 0,
  max: 0,
  mux: { kind: "plain" as const },
  floatKind: "integer" as const,
  attributes: [],
  valueTable: [],
  comment: "",
};
const DBC_CONTENT: DbcContentRecord[] = [
  {
    dbcPath: "/tmp/bms.dbc",
    messages: [
      {
        messageId: 0x120,
        extended: false,
        name: "BMS_Cells",
        transmitter: "BMS",
        comment: "",
        attributes: [],
        expectedLen: 8,
        isFd: false,
        brs: false,
        usesExtendedMux: false,
        signals: [
          { ...SIGNAL_DEFAULTS, name: "Cell01", unit: "V" },
          { ...SIGNAL_DEFAULTS, name: "Cell02", unit: "V" },
        ],
      },
    ],
  },
];

const CATALOG: SignalDescriptorRecord[] = [
  {
    bus_id: "bus-a",
    message_id: 0x120,
    extended: false,
    message_name: "BMS_Cells",
    transmitter: "BMS",
    signal_name: "Cell01",
    unit: "V",
  },
  {
    bus_id: "bus-a",
    message_id: 0x120,
    extended: false,
    message_name: "BMS_Cells",
    transmitter: "BMS",
    signal_name: "Cell02",
    unit: "V",
  },
];

function mathRecord(over: Partial<MathSignalRecord> = {}): MathSignalRecord {
  return {
    id: "m1",
    name: "median(Cell\d+)",
    unit: null,
    function: { kind: "median" },
    operands: { picks: [], patterns: ["Cell\\d+"] },
    identity: "*|m:0:m1",
    kind: "median",
    arity: "set",
    resolvedOperands: [
      { busId: "bus-a", messageId: 0x120, extended: false, signalName: "Cell01" },
      { busId: "bus-a", messageId: 0x120, extended: false, signalName: "Cell02" },
    ],
    operandPaths: ["CAN1/BMS/BMS_Cells/Cell01", "CAN1/BMS/BMS_Cells/Cell02"],
    unitResolved: "V",
    busIds: ["bus-a"],
    invalid: null,
    ...over,
  };
}

/// The snapshot row the host serves for `m1` — the shape `select_math`
/// emits: no bus, message id 0, the *id* in the signal slot and the
/// display name in the message slot, `math` set.
const MATH_SNAPSHOT = {
  bus_id: null,
  transmitter: null,
  message_id: 0,
  extended: false,
  message_name: "median(Cell\\d+)",
  signal_name: "m1",
  unit: "V",
  is_enum: false,
  display_hex: false,
  math: true,
  file_backed: false,
  value: 3.71,
  raw: null,
  label: null,
  rate: null,
  count: 12,
  time_seconds: 4,
};

/// What `list_math_signals` answers with; a test swaps it to model the
/// registry moving underneath the panel.
let mathSignals: MathSignalRecord[] = [];
const invoked: { cmd: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    if (cmd === "list_dbc_content") return DBC_CONTENT;
    if (cmd === "list_file_backed_content") return [];
    if (cmd === "list_math_signals") return mathSignals;
    if (cmd === "list_dbc_collisions") return [];
    // The value column's keyed lookup. The host answers only for the
    // keys it was asked for, so a row reaches the panel exactly when the
    // panel named it — provenance flag included.
    if (cmd === "fetch_signal_page") {
      const sel = args.selection as { keys: { signalName: string; math?: boolean }[] };
      const asked = sel.keys.some((k) => k.signalName === "m1" && k.math === true);
      return { count: asked ? 1 : 0, start: 0, rows: asked ? [MATH_SNAPSHOT] : [] };
    }
    // The registry stands in for the host's: it accepts an unfinished
    // definition and lists it back, which is what makes creation a
    // single step.
    if (cmd === "define_math_signal") {
      const d = args.definition as MathSignalRecord;
      mathSignals = [
        ...mathSignals,
        {
          ...d,
          identity: `*|m:0:${d.id}`,
          kind: d.function.kind,
          arity: "set",
          resolvedOperands: [],
          operandPaths: [],
          unitResolved: "",
          busIds: [],
          invalid: "name it — names aren't derived from selections",
        },
      ];
    }
    if (cmd === "delete_math_signal") {
      mathSignals = mathSignals.filter((m) => m.id !== args.id);
    }
    return undefined;
  }),
}));
const mockListeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    const set = mockListeners.get(event) ?? new Set();
    set.add(handler);
    mockListeners.set(event, set);
    return () => set.delete(handler);
  }),
}));
function emitHostEvent(event: string, payload: unknown = null) {
  for (const h of mockListeners.get(event) ?? []) h({ payload });
}

import { DatabasePanel } from "./DatabasePanel";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ElementRegistryContext, type ElementRegistry } from "./projectElements";
import { PanelEditRecorderContext } from "./panelEditRecorder";
import type { PanelEditStep } from "./panelEditHistory";
import { SignalCatalogContext } from "./signalCatalogContext";
import { parseSignalDragData, SIGNAL_DND_MIME } from "./dragSignals";
import { MathSignalsProvider } from "./mathSignalsContext";

const emptyRegistry = { entries: [] } as unknown as ElementRegistry;
const projectCtx = {
  projectPath: null,
  dirty: false,
  dbcPaths: ["/tmp/bms.dbc"],
  dbcBuses: { "/tmp/bms.dbc": ["bus-a"] },
  buses: [{ id: "bus-a", name: "CAN1" }] as Bus[],
  interfaceBindings: [],
  connectedAddresses: [],
  connectedBusIds: [],
  remoteConnected: false,
  blfPath: null,
  localVirtualBuses: [],
  busesWithPendingHwConfig: [],
  signalColors: {},
} as unknown as ProjectContextValue;

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/// Undo steps the panel recorded during a test — the app's recorder
/// stands in for `usePanelEditUndo`'s.
const recorded: PanelEditStep[] = [];

function renderPanel() {
  const api = {
    updateParameters: vi.fn(),
    isVisible: true,
    onDidVisibilityChange: () => ({ dispose: () => {} }),
  };
  const props = { params: {}, api } as unknown as Parameters<typeof DatabasePanel>[0];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <SignalCatalogContext.Provider value={{ catalog: CATALOG }}>
        <MathSignalsProvider>
          <ElementRegistryContext.Provider value={emptyRegistry}>
            <PanelEditRecorderContext.Provider value={(step) => recorded.push(step)}>
              <DatabasePanel {...props} />
            </PanelEditRecorderContext.Provider>
          </ElementRegistryContext.Provider>
        </MathSignalsProvider>
      </SignalCatalogContext.Provider>
    </ProjectContext.Provider>,
  );
}

const computedRow = () => screen.getByText("Computed").closest(".dbc-row")!;
const mathRow = (name: string) => screen.getByText(name).closest(".dbc-row")!;
const chevronOf = (row: Element) => row.querySelector(".dbc-row-chevron") as HTMLElement;
const editors = () => document.querySelectorAll(".math-editor");
const editor = () => document.querySelector(".math-editor");
const tree = () => document.querySelector(".dbc-panel-tree")!;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  mockListeners.clear();
  invoked.length = 0;
  recorded.length = 0;
  mathSignals = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the Computed branch", () => {
  it("stands beside the database branches even with nothing computed yet", async () => {
    renderPanel();
    // It is where math signals are created, so it is there before the
    // first one is.
    await waitFor(() => expect(screen.getByText("Computed")).toBeInTheDocument());
    expect(computedRow()).toHaveTextContent("0 signals");
  });

  it("asks the host for the listing with the project's bus names", async () => {
    renderPanel();
    await waitFor(() =>
      expect(invoked.some((c) => c.cmd === "list_math_signals")).toBe(true),
    );
    // A pattern is anchored on the bus *name*; the host has no standing
    // record of one, so every math command carries the map.
    const call = invoked.find((c) => c.cmd === "list_math_signals")!;
    expect(call.args.busNames).toEqual([["bus-a", "CAN1"]]);
  });

  it("lists each definition by name and unit", async () => {
    mathSignals = [mathRecord(), mathRecord({ id: "m2", name: "PackPower", unitResolved: "W" })];
    renderPanel();
    await waitFor(() => expect(screen.getByText("median(Cell\d+)")).toBeInTheDocument());
    expect(mathRow("median(Cell\d+)")).toHaveTextContent("[V]");
    expect(mathRow("PackPower")).toHaveTextContent("[W]");
    expect(computedRow()).toHaveTextContent("2 signals");
  });

  it("marks a definition the host calls unusable", async () => {
    mathSignals = [
      mathRecord({ invalid: "median needs at least one signal or a pattern, got 0" }),
    ];
    renderPanel();
    await screen.findByText("median(Cell\d+)");
    // The host's own words, not a re-derived verdict.
    expect(mathRow("median(Cell\d+)")).toHaveTextContent(
      "median needs at least one signal or a pattern, got 0",
    );
  });

  it("discloses through the app's standard disclosure control", async () => {
    mathSignals = [mathRecord()];
    renderPanel();
    await screen.findByText("median(Cell\d+)");
    // The shared `DisclosureToggle` every other expandable row uses —
    // no bespoke arrow of its own.
    expect(chevronOf(mathRow("median(Cell\d+)"))).toHaveClass("disclosure-toggle");
  });

  it("refetches when the host says the definitions moved", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Computed")).toBeInTheDocument());
    mathSignals = [mathRecord()];
    emitHostEvent("math-signals-changed");
    expect(await screen.findByText("median(Cell\d+)")).toBeInTheDocument();
  });
});

/// A computed signal is a signal on this surface too: with the Values
/// column on, its row shows a live value in the same cell a
/// database-defined row does. The panel asked for neither the key nor
/// the cell for math rows, so the column was blank for the whole
/// Computed branch.
describe("the live value column", () => {
  const values = () => screen.getByLabelText(/values/i);

  it("asks for a math row's value under its math-provenance key", async () => {
    mathSignals = [mathRecord()];
    renderPanel();
    await screen.findByText("median(Cell\d+)");
    fireEvent.click(values());
    await waitFor(() => {
      const calls = invoked.filter((c) => c.cmd === "fetch_signal_page");
      expect(calls.length).toBeGreaterThan(0);
      const sel = calls[calls.length - 1].args.selection as {
        keys: { busId: string | null; messageId: number; signalName: string; math?: boolean }[];
      };
      // The **id**, never the display name, and keyed as math — a math
      // series has no bus and no message, so nothing else keeps its
      // `0` out of the message-id namespace.
      expect(sel.keys).toContainEqual(
        expect.objectContaining({
          busId: null,
          messageId: 0,
          extended: false,
          signalName: "m1",
          math: true,
        }),
      );
    });
  });

  it("renders the answer in the row's value cell, like any other signal", async () => {
    mathSignals = [mathRecord()];
    renderPanel();
    await screen.findByText("median(Cell\d+)");
    fireEvent.click(values());
    const shown = await screen.findByText("3.71");
    expect(shown.closest(".signal-value-cell")).toHaveTextContent(/^3\.71\s*V$/);
    // In the row's own value cell, the same slot a DBC-backed row uses.
    expect(mathRow("median(Cell\d+)").querySelector(".dbc-row-value")).toContainElement(shown);
  });

  it("leaves the Computed branch row itself valueless", async () => {
    mathSignals = [mathRecord()];
    renderPanel();
    await screen.findByText("Computed");
    fireEvent.click(values());
    await screen.findByText("3.71");
    expect(computedRow().querySelector(".dbc-row-value")).toBeNull();
  });
});

describe("expanding a definition", () => {
  it("opens its editor in place — one stage, no read-only detail", async () => {
    mathSignals = [mathRecord()];
    renderPanel();
    await screen.findByText("median(Cell\d+)");
    fireEvent.click(chevronOf(mathRow("median(Cell\d+)")));
    const open = editor()!;
    expect(open).toHaveTextContent("Median of set");
    // The stored definition, pattern and all.
    expect(screen.getByLabelText("Name")).toHaveValue("median(Cell\d+)");
    expect(screen.getByRole("group", { name: "Signals operands" })).toHaveTextContent(
      "2 signals",
    );
    // In place: inside the tree, under the row that invoked it — not a
    // floating layer over the panel.
    expect(tree().contains(open)).toBe(true);
    expect(open.closest(".modal, [role=dialog]")).toBeNull();
    expect(document.querySelector(".dbc-row-details")).toBeNull();
  });

  it("collapses it again", async () => {
    mathSignals = [mathRecord()];
    renderPanel();
    await screen.findByText("median(Cell\d+)");
    fireEvent.click(chevronOf(mathRow("median(Cell\d+)")));
    expect(editor()).not.toBeNull();
    fireEvent.click(chevronOf(mathRow("median(Cell\d+)")));
    expect(editor()).toBeNull();
  });

  it("gives each expanded definition its own editor", async () => {
    mathSignals = [mathRecord(), mathRecord({ id: "m2", name: "PackPower" })];
    renderPanel();
    await screen.findByText("PackPower");
    fireEvent.click(chevronOf(mathRow("median(Cell\d+)")));
    fireEvent.click(chevronOf(mathRow("PackPower")));
    expect(editors()).toHaveLength(2);
  });
});

describe("deleting one", () => {
  it("takes one click, and the undo step carries the definition back", async () => {
    mathSignals = [mathRecord()];
    renderPanel();
    await screen.findByText("median(Cell\d+)");
    const row = mathRow("median(Cell\d+)") as HTMLElement;
    const remove = within(row).getByRole("button", { name: /^delete / });
    fireEvent.click(remove);
    await waitFor(() =>
      expect(invoked.find((c) => c.cmd === "delete_math_signal")?.args).toEqual({
        id: "m1",
      }),
    );
    await waitFor(() => expect(screen.queryByText("median(Cell\d+)")).toBeNull());
    // Undo is what makes one click the right number: the step the panel
    // recorded restores the whole definition, not just its name.
    const step = recorded[recorded.length - 1];
    expect(step.redo).toEqual([{ kind: "mathDelete", id: "m1" }]);
    const back = step.undo[0];
    expect(back).toMatchObject({
      kind: "mathDefine",
      definition: {
        id: "m1",
        name: "median(Cell\d+)",
        unit: null,
        function: { kind: "median" },
        operands: { picks: [], patterns: ["Cell\\d+"] },
      },
    });
    // Replay it the way the app's dispatcher does (`mathDefine` →
    // `define_math_signal`) and the row is listed again.
    if (back.kind !== "mathDefine") throw new Error("expected a mathDefine step");
    const core = await import("@tauri-apps/api/core");
    await core.invoke("define_math_signal", {
      definition: back.definition,
      busNames: back.busNames,
    });
    emitHostEvent("math-signals-changed");
    expect(await screen.findByText("median(Cell\d+)")).toBeInTheDocument();
  });

  it("pins the delete to the end of the name", async () => {
    mathSignals = [mathRecord()];
    renderPanel();
    await screen.findByText("median(Cell\d+)");
    const row = mathRow("median(Cell\d+)") as HTMLElement;
    const remove = within(row).getByRole("button", { name: /^delete / });
    // It travels with the name rather than floating at the row's far
    // end, which moved under the cursor on every resize (owner ruling).
    expect(row.querySelector(".dbc-row-label")!.nextElementSibling).toBe(remove);
    expect(remove).toHaveClass("dbc-row-delete");
    // The disclosure still leads the row, so the two are not adjacent.
    expect([...row.querySelectorAll("button")][0]).toHaveClass("dbc-row-chevron");
  });
});

describe("creating one", () => {
  it("offers every function on the tree's context menu", async () => {
    renderPanel();
    await screen.findByText("Computed");
    fireEvent.contextMenu(tree());
    const menu = screen.getByRole("menu", { name: /math/i });
    expect(within(menu).getByRole("menuitem", { name: "Sum" })).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "Statistic (over capture)" }),
    ).toBeInTheDocument();
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(16);
  });

  it("materializes the definition at once and expands its editor in place", async () => {
    renderPanel();
    await screen.findByText("Computed");
    fireEvent.contextMenu(tree());
    fireEvent.click(screen.getByRole("menuitem", { name: "Difference (A − B)" }));
    // Written immediately, unfinished — there is no staging step
    // between picking a function and having one.
    await waitFor(() => expect(invoked.some((c) => c.cmd === "define_math_signal")).toBe(true));
    const definition = invoked.find((c) => c.cmd === "define_math_signal")!.args
      .definition as MathSignalRecord;
    expect(definition.name).toBe("");
    expect(definition.function).toEqual({ kind: "difference" });
    const open = (await waitFor(() => {
      const e = editor();
      expect(e).not.toBeNull();
      return e;
    }))!;
    expect(tree().contains(open)).toBe(true);
    expect(open.closest(".modal, [role=dialog]")).toBeNull();
    expect(screen.getByRole("group", { name: "A operands" })).toBeInTheDocument();
  });

  it("shows an unfinished definition as unnamed, with the host's reason", async () => {
    renderPanel();
    await screen.findByText("Computed");
    fireEvent.contextMenu(tree());
    fireEvent.click(screen.getByRole("menuitem", { name: "Sum" }));
    expect(await screen.findByText("(unnamed)")).toBeInTheDocument();
    expect(mathRow("(unnamed)")).toHaveTextContent("name it");
  });
});

describe("dragging one out", () => {
  /// Minimal `DataTransfer` stand-in for jsdom — the same shape the
  /// panel's other drag tests use.
  function fakeTransfer(): DataTransfer {
    const store: Record<string, string> = {};
    return {
      setData: (t: string, d: string) => {
        store[t] = d;
      },
      getData: (t: string) => store[t] ?? "",
      get types() {
        return Object.keys(store);
      },
      effectAllowed: "none",
    } as unknown as DataTransfer;
  }

  it("drags as a signal carrying its math provenance and its stable id", async () => {
    mathSignals = [mathRecord()];
    renderPanel();
    await screen.findByText("median(Cell\d+)");
    const row = mathRow("median(Cell\d+)") as HTMLElement;
    expect(row).toHaveAttribute("draggable", "true");
    const dt = fakeTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    const refs = parseSignalDragData(dt.getData(SIGNAL_DND_MIME)).signals;
    expect(refs).toHaveLength(1);
    // The **id**, never the display name: a rename must leave every
    // reference to the definition alone.
    expect(refs[0].signalName).toBe("m1");
    expect(refs[0].math).toBe(true);
    expect(refs[0].busId).toBeNull();
    expect(refs[0].unit).toBe("V");
  });

  it("leaves the Computed branch itself undraggable", async () => {
    mathSignals = [mathRecord()];
    renderPanel();
    await screen.findByText("Computed");
    expect(computedRow()).not.toHaveAttribute("draggable", "true");
  });
});

describe("the set section's pattern popover", () => {
  it("opens from the expanded editor, viewport-positioned at the button", async () => {
    mathSignals = [mathRecord()];
    renderPanel();
    await screen.findByText("median(Cell\d+)");
    fireEvent.click(chevronOf(mathRow("median(Cell\d+)")));
    const btn = screen.getByRole("button", { name: "patterns for Signals" });
    fireEvent.click(btn);
    const pop = screen.queryByRole("group", { name: "patterns in Signals" });
    expect(pop).not.toBeNull();
    // Fixed viewport coordinates, not anchored: an anchored popover is
    // clipped by the hosting panel's scroll container and reads as the
    // button doing nothing.
    expect(pop!.style.left).not.toBe("");
    expect(pop!.style.top).not.toBe("");
    // …and portalled to <body>: rendered in place, the hosts' GPU-layer
    // containers (will-change / translate3d) become the containing
    // block for `position: fixed`, and the viewport coordinates land
    // offset down into the panel.
    expect(pop!.parentElement).toBe(document.body);
  });
});
