// @vitest-environment jsdom
//
// DOM tests for the Database panel: tree render from a
// `list_dbc_content` payload, expand-collapse, per-ECU grouping,
// fuzzy-search behavior (matched set, auto-expand of ancestors,
// hiding of non-matches), and keyboard navigation.
// fzf runs for real here — the panel's interesting behavior is the
// interaction between fzf's match set and the tree-render rules, so
// faking the matcher would defeat the test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type {
  DbcContentRecord,
  Bus,
  FileBackedContentRecord,
  InterfaceBinding,
} from "./types";
import { SIGNAL_DND_MIME, parseSignalDragData } from "./dragSignals";
// The drop side of the drag, so a payload is proven against what a real
// target reads rather than against the producer's own assumptions.
import { parseDroppedSignals, signalRefKey } from "./plotPanelConfig";
import { signalKey } from "./plotData";

/// Defaults for the rich signal fields so the test
/// fixtures stay concise while satisfying the full `DbcSignalContentRecord`
/// shape.
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
};
const MESSAGE_DEFAULTS = {
  expectedLen: 8,
  isFd: false,
  brs: false,
  usesExtendedMux: false,
  transmitter: null,
};

import {
  LONG_MESSAGE_NAME,
  LONG_MESSAGE_TAIL,
  LONG_SIGNAL_NAME,
  LONG_SIGNAL_TAIL,
  expectMiddleEllipsis,
} from "./longNameTestKit";

const DBC_CONTENT: DbcContentRecord[] = [
  {
    dbcPath: "/tmp/powertrain.dbc",
    messages: [
      {
        ...MESSAGE_DEFAULTS,
        messageId: 256,
        extended: false,
        name: "EngineData",
        transmitter: "EngineEcu",
        comment: "Periodic engine state.",
        attributes: [{ name: "GenMsgCycleTime", value: "100" }],
        signals: [
          {
            ...SIGNAL_DEFAULTS,
            name: "EngineSpeed",
            length: 16,
            factor: 0.25,
            unit: "rpm",
            comment: "Crankshaft RPM.",
            attributes: [],
            valueTable: [],
          },
          {
            ...SIGNAL_DEFAULTS,
            name: "EngineTemp",
            startBit: 16,
            unit: "degC",
            comment: "Coolant temperature.",
            attributes: [],
            valueTable: [],
          },
        ],
      },
      {
        ...MESSAGE_DEFAULTS,
        messageId: 512,
        extended: false,
        name: "GearState",
        comment: "",
        attributes: [],
        signals: [
          {
            ...SIGNAL_DEFAULTS,
            name: "Mode",
            unit: "",
            comment: "Selected gear.",
            attributes: [],
            valueTable: [
              { raw: 0, label: "Park" },
              { raw: 1, label: "Drive" },
            ],
          },
        ],
      },
    ],
  },
];

/// One imported capture file's signal definitions — the other format
/// the Database view carries (ADR 0052). Names deliberately disjoint
/// from the DBC fixture's so a query names exactly one row.
const FILE_CONTENT: FileBackedContentRecord[] = [
  {
    sourcePath: "/logs/drive.mf4",
    groups: [
      {
        group: 1,
        label: "Analog",
        signals: [
          { name: "AmbientTemp", unit: "degC" },
          { name: "CabinHumidity", unit: "%" },
        ],
      },
      { group: 2, label: "group 2", signals: [{ name: "Ignition", unit: "" }] },
    ],
  },
];

/// What `list_file_backed_content` answers with; a test swaps it to
/// model a capture whose file-backed set changed.
let fileContent: FileBackedContentRecord[] = FILE_CONTENT;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "list_dbc_content") return DBC_CONTENT;
    if (cmd === "list_file_backed_content") return fileContent;
    return undefined;
  }),
}));
// `listen` is what the panel hooks up for `dbc-changed` (the host's
// filesystem watcher), `file-signals-changed` (the capture's
// file-backed set moved) and `trace-grew` (the dirty gate under the
// live value poll). The mock keeps the handlers so a test can fire any.
const mockListeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    const set = mockListeners.get(event) ?? new Set();
    set.add(handler);
    mockListeners.set(event, set);
    return () => set.delete(handler);
  }),
}));
/// Deliver a host event to whatever the panel subscribed.
function emitHostEvent(event: string, payload: unknown = null) {
  for (const h of mockListeners.get(event) ?? []) h({ payload });
}

import { DatabasePanel } from "./DatabasePanel";
import {
  ASSUMED_VIEWPORT_HEIGHT,
  OVERSCAN,
  ROW_HEIGHT,
} from "./dbcPanelViewport";
import { diagCounts } from "./diag";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ElementRegistryContext, type ElementRegistry } from "./projectElements";
import { PanelCommandsContext, createPanelCommandRegistry } from "./panelCommands";
import { DBC_PANEL_ID } from "./dockLayout";

/// Minimal registry stub — the panel only reads `entries` (for the
/// ambient colormap resolver behind the value column).
const emptyRegistry = { entries: [] } as unknown as ElementRegistry;

const projectCtx: ProjectContextValue = {
  projectPath: null,
  dirty: false,
  dbcPaths: ["/tmp/powertrain.dbc"],
  dbcBuses: {},
  buses: [] as Bus[],
  interfaceBindings: [] as InterfaceBinding[],
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
};

/// The slice of dockview's panel API the Database panel touches:
/// `updateParameters` for the persisted layout params, plus the
/// visibility signal the live-value poll is gated on. `setVisible`
/// drives the registered listener so a test can hide the panel.
function fakePanelApi() {
  const listeners = new Set<(e: { isVisible: boolean }) => void>();
  return {
    updateParameters: vi.fn(),
    isVisible: true,
    onDidVisibilityChange(fn: (e: { isVisible: boolean }) => void) {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    setVisible(isVisible: boolean) {
      for (const fn of listeners) fn({ isVisible });
    },
  };
}

function renderPanel() {
  const api = fakePanelApi();
  const props = { params: {}, api } as unknown as Parameters<typeof DatabasePanel>[0];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <ElementRegistryContext.Provider value={emptyRegistry}>
        <DatabasePanel {...props} />
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
  return api;
}

// The panel virtualizes its row list, so it observes its container.
// jsdom reports a zero `clientHeight`, which the panel reads as
// "not laid out yet" and falls back to `ASSUMED_VIEWPORT_HEIGHT`.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  mockListeners.clear();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fileContent = FILE_CONTENT;
  // Restore the default content for tests that swapped in their own
  // fixture via `mockImplementation` (clearAllMocks clears call
  // history, not implementations).
  const core = await import("@tauri-apps/api/core");
  (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
    if (cmd === "list_dbc_content") return DBC_CONTENT;
    if (cmd === "list_file_backed_content") return fileContent;
    return undefined;
  });
});

/// Minimal `DataTransfer` stand-in for jsdom. Only `setData` /
/// `getData` / `types` / `effectAllowed` are read by our drag code,
/// so the polyfill stops there — anything else throws if a test
/// reaches for it, which is the signal to add it.
function makeFakeDataTransfer(): DataTransfer {
  const store: Record<string, string> = {};
  const dt = {
    setData(type: string, data: string) {
      store[type] = data;
    },
    getData(type: string) {
      return store[type] ?? "";
    },
    get types() {
      return Object.keys(store);
    },
    effectAllowed: "none" as DataTransfer["effectAllowed"],
    dropEffect: "none" as DataTransfer["dropEffect"],
  };
  return dt as unknown as DataTransfer;
}

function expectRowSelected(text: string) {
  const row = screen.getByText(text).closest(".dbc-row");
  expect(row).toHaveClass("dbc-row-selected");
}
function expectRowNotSelected(text: string) {
  const row = screen.getByText(text).closest(".dbc-row");
  expect(row).not.toHaveClass("dbc-row-selected");
}

describe("DatabasePanel", () => {
  it("renders one root per loaded DBC with the file's basename", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("powertrain.dbc")).toBeInTheDocument());
  });

  it("auto-expands each DBC root on first load so messages are visible", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("EngineData")).toBeInTheDocument());
    expect(screen.getByText("GearState")).toBeInTheDocument();
  });

  it("expands a message to show its signals on chevron click", async () => {
    renderPanel();
    const msg = await screen.findByText("EngineData");
    // Signals are hidden until the message's chevron is clicked.
    // Plain row click selects (multi-select), so expand
    // requires the chevron specifically.
    expect(screen.queryByText("EngineSpeed")).not.toBeInTheDocument();
    const chevron = msg.closest(".dbc-row")?.querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(chevron);
    expect(await screen.findByText("EngineSpeed")).toBeInTheDocument();
    expect(screen.getByText("EngineTemp")).toBeInTheDocument();
  });

  it("auto-expands ancestors of a matched signal when typing", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search database content");
    fireEvent.change(search, { target: { value: "EngineSpeed" } });
    // EngineSpeed is a child of the collapsed EngineData; the search
    // must force-expand the ancestor so the match is visible.
    expect(await screen.findByText("EngineSpeed")).toBeInTheDocument();
  });

  it("hides rows outside the match set when the search is active", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search database content");
    fireEvent.change(search, { target: { value: "EngineSpeed" } });
    await screen.findByText("EngineSpeed");
    // GearState has no match anywhere under it — the row is removed
    // from the tree, not dimmed (its "(no transmitter)" ECU group
    // goes with it).
    expect(screen.queryByText("GearState")).not.toBeInTheDocument();
    expect(screen.queryByText("(no transmitter)")).not.toBeInTheDocument();
    // The path to the match stays: DBC root, ECU group, message.
    expect(screen.getByText("powertrain.dbc")).toBeInTheDocument();
    expect(screen.getByText("EngineEcu")).toBeInTheDocument();
    expect(screen.getByText("EngineData")).toBeInTheDocument();
  });

  it("collapses non-matching siblings of a matched message", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search database content");
    // Match the message via its comment ("Periodic engine state.") —
    // a text its signals don't carry (a message-*name* query would
    // legitimately match the signals too, through the dotted
    // `Message.Signal` haystack). The matched message renders
    // collapsed; its non-matching signals stay hidden.
    fireEvent.change(search, { target: { value: "Periodic" } });
    await screen.findByText("EngineData");
    expect(screen.queryByText("EngineSpeed")).not.toBeInTheDocument();
    // Expanding the matched message by chevron reveals its signals
    // even while the filter is active.
    const chevron = screen
      .getByText("EngineData")
      .closest(".dbc-row")
      ?.querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(chevron);
    expect(await screen.findByText("EngineSpeed")).toBeInTheDocument();
  });

  it("matches on hex message id", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search database content");
    // 0x100 = 256 = EngineData. The filter settles after a debounce, so
    // wait on the *hiding* — the visible change this query makes.
    fireEvent.change(search, { target: { value: "0x100" } });
    // GearState (id 0x200) doesn't match — hidden.
    await waitFor(() =>
      expect(screen.queryByText("GearState")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("EngineData")).toBeInTheDocument();
  });

  it("matches on value-table labels", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search database content");
    fireEvent.change(search, { target: { value: "Park" } });
    // Mode has a `Park` value-table label — its ancestor GearState
    // must auto-expand so the signal is visible.
    expect(await screen.findByText("Mode")).toBeInTheDocument();
  });

  it("shows match count when filter is active", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search database content");
    fireEvent.change(search, { target: { value: "EngineSpeed" } });
    await screen.findByText(/match/i);
  });

  it("plain click selects a signal row; second plain click replaces selection", async () => {
    renderPanel();
    const msg = await screen.findByText("EngineData");
    fireEvent.click(msg);
    // The signals become visible only after the message row is
    // expanded — which is what a chevron click does. The row click
    // selects; expand happens via the chevron.
    expectRowSelected("EngineData");
    expectRowNotSelected("GearState");
    // Plain click on a different row replaces selection.
    fireEvent.click(screen.getByText("GearState"));
    expectRowSelected("GearState");
    expectRowNotSelected("EngineData");
  });

  it("Cmd/Ctrl-click toggles a row's membership in the selection", async () => {
    renderPanel();
    const eng = await screen.findByText("EngineData");
    fireEvent.click(eng);
    expectRowSelected("EngineData");
    fireEvent.click(screen.getByText("GearState"), { metaKey: true });
    // Both are now selected.
    expectRowSelected("EngineData");
    expectRowSelected("GearState");
    // Cmd-click EngineData again to drop it.
    fireEvent.click(eng, { metaKey: true });
    expectRowNotSelected("EngineData");
    expectRowSelected("GearState");
  });

  it("Ctrl+Shift-click adds the range from the anchor over visible rows", async () => {
    // ADR 0044's multiselect: Ctrl/Cmd+Shift+click is the *additive*
    // range, so what was selected outside it stays.
    renderPanel();
    await screen.findByText("EngineData");
    fireEvent.click(screen.getByText("EngineData")); // anchor
    fireEvent.click(screen.getByText("GearState"), { metaKey: true, shiftKey: true });
    expectRowSelected("EngineData");
    expectRowSelected("GearState");
  });

  it("Shift-click replaces the selection with the range from the anchor", async () => {
    // The file-explorer gesture, over the same anchor Ctrl+Shift+click
    // uses. Containers aren't selectable, so the range walks the
    // message and signal rows only.
    renderPanel();
    const msg = await screen.findByText("EngineData");
    const chevron = msg.closest(".dbc-row")?.querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(chevron); // reveal EngineSpeed / EngineTemp
    await screen.findByText("EngineSpeed");
    fireEvent.click(screen.getByText("EngineData")); // anchor
    fireEvent.click(screen.getByText("EngineTemp"), { shiftKey: true });
    expectRowSelected("EngineData");
    expectRowSelected("EngineSpeed");
    expectRowSelected("EngineTemp");
    expectRowNotSelected("GearState");
    // A second Shift+click re-ranges from the same anchor rather than
    // extending from the last target.
    fireEvent.click(screen.getByText("EngineSpeed"), { shiftKey: true });
    expectRowSelected("EngineData");
    expectRowSelected("EngineSpeed");
    expectRowNotSelected("EngineTemp");
    // And it replaces: a row selected outside the new range goes.
    fireEvent.click(screen.getByText("GearState"), { metaKey: true }); // re-anchors
    fireEvent.click(screen.getByText("EngineTemp"), { shiftKey: true });
    expectRowNotSelected("EngineData");
    expectRowNotSelected("EngineSpeed");
    expectRowSelected("EngineTemp");
    expectRowSelected("GearState");
  });

  it("Ctrl/Cmd+A selects every selectable row and leaves the containers out", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    fireEvent.keyDown(screen.getByRole("tree"), { key: "a", ctrlKey: true });
    expectRowSelected("EngineData");
    expectRowSelected("GearState");
    expect(screen.getByText("powertrain.dbc").closest(".dbc-row")).not.toHaveClass(
      "dbc-row-selected",
    );
  });

  it("Home / End take the cursor to the first and last row", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "End" });
    // Rows on load: (All DBCs) → powertrain.dbc → EngineEcu → EngineData
    // → (no transmitter) → GearState, then the file-backed branch
    // drive.mf4 → Analog → group 2. One row space across both formats,
    // so End lands on the last row of the last branch.
    expect(screen.getByText("group 2").closest(".dbc-row")).toHaveClass(
      "dbc-row-active",
    );
    fireEvent.keyDown(tree, { key: "Home" });
    expect(screen.getByText(/All DBCs/i).closest(".dbc-row")).toHaveClass(
      "dbc-row-active",
    );
    // The container row can hold the cursor but not the selection, so
    // the row the End press had picked up is dropped.
    expectRowNotSelected("GearState");
  });

  it("takes the keyboard when a row is clicked", async () => {
    // Without this the tree never holds focus in a mouse-then-keyboard
    // session: focus stays on `<body>`, where the arrows and Tab are
    // dead until the user happens to click the container's border.
    renderPanel();
    await screen.findByText("EngineData");
    fireEvent.click(screen.getByText("EngineData").closest(".dbc-row") as HTMLElement);
    expect(document.activeElement).toBe(screen.getByRole("tree"));
  });

  it("marks its tree as a gridview so the global dispatcher stays off its keys", async () => {
    // ADR 0044's D10 suppression: the marker on the container is what
    // the capture-phase dispatcher reads. (The end-to-end assertion over
    // the real `useCommands` lives in `SignalsPanel.gridview.dom.test`.)
    renderPanel();
    await screen.findByText("EngineData");
    expect(screen.getByRole("tree")).toHaveAttribute("data-gridview");
  });

  it("the disclosure is a real control, not a glyph span", async () => {
    // ADR 0044's hit-target rule — a glyph-sized target is what shipped
    // as a defect. The row keeps its own `aria-expanded`; the control
    // carries one too and stays out of the Tab order.
    renderPanel();
    const eng = await screen.findByText("EngineData");
    const chevron = eng.closest(".dbc-row")?.querySelector(".dbc-row-chevron");
    expect(chevron?.tagName).toBe("BUTTON");
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(chevron).toHaveAttribute("tabindex", "-1");
  });

  it("chevron click toggles expand without changing selection", async () => {
    renderPanel();
    const eng = await screen.findByText("EngineData");
    fireEvent.click(eng); // select it
    expectRowSelected("EngineData");
    // The chevron is the first child span of the row.
    const row = eng.closest(".dbc-row");
    const chevron = row?.querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(chevron);
    // Signals appear; row stays selected.
    expect(await screen.findByText("EngineSpeed")).toBeInTheDocument();
    expectRowSelected("EngineData");
  });

  it("DBC root rows are not selectable; clicking them toggles expansion", async () => {
    renderPanel();
    const dbcRoot = await screen.findByText("powertrain.dbc");
    expect(screen.getByText("EngineData")).toBeInTheDocument();
    fireEvent.click(dbcRoot);
    // Auto-expanded on load; click collapses.
    await waitFor(() => expect(screen.queryByText("EngineData")).not.toBeInTheDocument());
    const row = dbcRoot.closest(".dbc-row");
    expect(row).not.toHaveClass("dbc-row-selected");
  });

  it("drag from a signal row emits a single SignalRef payload", async () => {
    renderPanel();
    const msg = await screen.findByText("EngineData");
    const chevron = msg.closest(".dbc-row")?.querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(chevron);
    const signalRow = (await screen.findByText("EngineSpeed")).closest(
      ".dbc-row",
    ) as HTMLElement;
    const dt = makeFakeDataTransfer();
    fireEvent.dragStart(signalRow, { dataTransfer: dt });
    const refs = parseSignalDragData(dt.getData(SIGNAL_DND_MIME)).signals;
    expect(refs).toHaveLength(1);
    expect(refs[0].signalName).toBe("EngineSpeed");
    expect(refs[0].messageName).toBe("EngineData");
    expect(refs[0].messageId).toBe(256);
  });

  it("drag from a message row emits every signal in that message", async () => {
    renderPanel();
    const msg = await screen.findByText("EngineData");
    const row = msg.closest(".dbc-row") as HTMLElement;
    const dt = makeFakeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    const refs = parseSignalDragData(dt.getData(SIGNAL_DND_MIME)).signals;
    expect(refs.map((r) => r.signalName).sort()).toEqual([
      "EngineSpeed",
      "EngineTemp",
    ]);
  });

  it("drag from a row in the multi-selection drags the whole selection", async () => {
    renderPanel();
    const eng = await screen.findByText("EngineData");
    fireEvent.click(eng);
    fireEvent.click(screen.getByText("GearState"), { metaKey: true });
    // Dragstart from EngineData (which is in the selection) should
    // carry both messages' signals.
    const dt = makeFakeDataTransfer();
    fireEvent.dragStart(eng.closest(".dbc-row") as HTMLElement, { dataTransfer: dt });
    const refs = parseSignalDragData(dt.getData(SIGNAL_DND_MIME)).signals;
    expect(refs.map((r) => r.signalName).sort()).toEqual([
      "EngineSpeed",
      "EngineTemp",
      "Mode",
    ]);
  });

  it("drag from a row NOT in the selection drags just that row", async () => {
    renderPanel();
    const eng = await screen.findByText("EngineData");
    fireEvent.click(eng);
    // Selection is just EngineData. Drag from GearState — outside
    // the selection — should carry only GearState's signals.
    const dt = makeFakeDataTransfer();
    fireEvent.dragStart(screen.getByText("GearState").closest(".dbc-row") as HTMLElement, {
      dataTransfer: dt,
    });
    const refs = parseSignalDragData(dt.getData(SIGNAL_DND_MIME)).signals;
    expect(refs.map((r) => r.signalName)).toEqual(["Mode"]);
  });

  it("drag from a per-bus tree row carries that bus's id", async () => {
    // With per-bus tree grouping (slice 6) + slice-7 fix: the
    // bus context of the *visual* row is what determines the drag
    // payload's `busId`. A DBC scoped to two buses renders under
    // each bus group; dragging from bus-a's instance produces one
    // ref with busId="bus-a" (not a fanned-out pair).
    const buses: Bus[] = [
      { id: "bus-a", name: "A" },
      { id: "bus-b", name: "B" },
    ];
    const scopedCtx: ProjectContextValue = {
      ...projectCtx,
      buses,
      dbcBuses: { "/tmp/powertrain.dbc": ["bus-a", "bus-b"] },
    };
    const api = fakePanelApi();
    const props = { params: {}, api } as unknown as Parameters<typeof DatabasePanel>[0];
    render(
      <ProjectContext.Provider value={scopedCtx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <DatabasePanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    const allEng = await screen.findAllByText("EngineData");
    expect(allEng.length).toBe(2);
    // Expand the first EngineData (under bus-a) so we can drag its
    // signal.
    const chevron = allEng[0]
      .closest(".dbc-row")
      ?.querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(chevron);
    const allEngineSpeed = await screen.findAllByText("EngineSpeed");
    const signalRow = allEngineSpeed[0].closest(".dbc-row") as HTMLElement;
    const dt = makeFakeDataTransfer();
    fireEvent.dragStart(signalRow, { dataTransfer: dt });
    const refs = parseSignalDragData(dt.getData(SIGNAL_DND_MIME)).signals;
    expect(refs).toHaveLength(1);
    expect(refs[0].busId).toBe("bus-a");
  });

  it("drag from an unassigned DBC's row carries no bus id", async () => {
    // A database assigned to no bus decodes nothing, so it renders once
    // — under the `(Unassigned)` group — rather than under every real
    // bus group. Dragging from there is the legacy "any bus" ref: there
    // is no bus context to carry.
    const buses: Bus[] = [
      { id: "bus-a", name: "powertrain" },
      { id: "bus-b", name: "chassis" },
    ];
    const ctx: ProjectContextValue = {
      ...projectCtx,
      buses,
      // No scoping → unassigned, appears once under `(Unassigned)`.
      dbcBuses: {},
    };
    const api = fakePanelApi();
    const props = { params: {}, api } as unknown as Parameters<typeof DatabasePanel>[0];
    render(
      <ProjectContext.Provider value={ctx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <DatabasePanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    const allEng = await screen.findAllByText("EngineData");
    expect(allEng.length).toBe(1);
    const chevron = allEng[0]
      .closest(".dbc-row")
      ?.querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(chevron);
    const signalRow = (await screen.findByText("EngineSpeed")).closest(
      ".dbc-row",
    ) as HTMLElement;
    const dt = makeFakeDataTransfer();
    fireEvent.dragStart(signalRow, { dataTransfer: dt });
    const refs = parseSignalDragData(dt.getData(SIGNAL_DND_MIME)).signals;
    expect(refs).toHaveLength(1);
    expect(refs[0].busId).toBeNull();
  });

  it("'details' toggle reveals bit layout, scale, range, value table for each signal", async () => {
    renderPanel();
    const eng = await screen.findByText("EngineData");
    // Expand the message so the signals (and their detail blocks)
    // are visible.
    const chevron = eng.closest(".dbc-row")?.querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(chevron);
    // No details block until the toggle is checked.
    expect(screen.queryByText(/^bits 0/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/details/i));
    // EngineSpeed: 16 bits at 0, factor 0.25 — the formatter prints
    // "bits 0–15 (16)@1+" and "(0.25, 0)".
    expect(await screen.findByText("bits 0–15 (16)@1+")).toBeInTheDocument();
    expect(screen.getByText("(0.25, 0)")).toBeInTheDocument();
    // Mode signal's value-table entries show up.
    // Expand GearState first.
    const gearChevron = screen
      .getByText("GearState")
      .closest(".dbc-row")
      ?.querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(gearChevron);
    expect(screen.getByText("0=Park")).toBeInTheDocument();
    expect(screen.getByText("1=Drive")).toBeInTheDocument();
  });

  it("clicking a row's detail block leaves the row it belongs to open", async () => {
    // The rule the trace views now keep: a click inside what a row
    // disclosed acts on that content, never on the row that disclosed
    // it. Here the detail block is a sibling of the row element and
    // only container rows toggle — this pins both.
    renderPanel();
    const eng = await screen.findByText("EngineData");
    const row = eng.closest(".dbc-row") as HTMLElement;
    fireEvent.click(row.querySelector(".dbc-row-chevron") as HTMLElement);
    fireEvent.click(screen.getByLabelText(/details/i));
    fireEvent.click(await screen.findByText("bits 0–15 (16)@1+"));
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("EngineSpeed")).toBeInTheDocument();
  });

  it("'details' toggle reveals message length / id / attributes", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    fireEvent.click(screen.getByLabelText(/details/i));
    // EngineData id row: "0x100 (256)". Both messages have length
    // "8 B" so look at the attribute-bearing message specifically.
    expect(screen.getAllByText(/8 B/).length).toBeGreaterThanOrEqual(1);
    // "0x100" appears both in the row meta (always) and in the
    // details block — finding it twice is fine, finding it at all
    // is what the toggle actually changes.
    expect(screen.getAllByText(/0x100/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\(256\)/)).toBeInTheDocument();
    // The GenMsgCycleTime attribute is surfaced.
    expect(screen.getByText("GenMsgCycleTime", { exact: false })).toBeInTheDocument();
  });

  it("search can match by bus name (e.g. 'chassis.brake')", async () => {
    const ctx: ProjectContextValue = {
      ...projectCtx,
      buses: [
        { id: "bus-a", name: "powertrain" },
        { id: "bus-b", name: "chassis" },
      ],
      // powertrain.dbc scoped to bus-a only — so EngineData only
      // lives under the 'powertrain' bus group, and a search for
      // 'chassis' should NOT match it.
      dbcBuses: { "/tmp/powertrain.dbc": ["bus-a"] },
    };
    const api = fakePanelApi();
    const props = { params: {}, api } as unknown as Parameters<typeof DatabasePanel>[0];
    render(
      <ProjectContext.Provider value={ctx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <DatabasePanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    await screen.findByText("powertrain");
    const search = screen.getByLabelText("search database content");
    // 'powertrain.engine' → EngineData under bus-a matches.
    fireEvent.change(search, { target: { value: "powertrain.engine" } });
    await waitFor(() =>
      expect(screen.getByText("EngineData")).toBeInTheDocument(),
    );
    // 'chassis.engine' → no chassis-scoped EngineData → the message
    // is hidden entirely.
    fireEvent.change(search, { target: { value: "chassis.engine" } });
    await waitFor(() =>
      expect(screen.queryByText("EngineData")).not.toBeInTheDocument(),
    );
  });

  it("groups the tree by bus when project buses are configured", async () => {
    const ctx: ProjectContextValue = {
      ...projectCtx,
      buses: [
        { id: "bus-a", name: "powertrain" },
        { id: "bus-b", name: "chassis" },
      ],
      // powertrain.dbc is unassigned here — it decodes nothing, so it
      // must NOT appear under either real bus group.
      dbcBuses: {},
    };
    const api = fakePanelApi();
    const props = { params: {}, api } as unknown as Parameters<typeof DatabasePanel>[0];
    render(
      <ProjectContext.Provider value={ctx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <DatabasePanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    // Both bus group rows are visible at the top.
    expect(await screen.findByText("powertrain")).toBeInTheDocument();
    expect(screen.getByText("chassis")).toBeInTheDocument();
    // Unassigned DBC appears exactly once, under `(Unassigned)` — not
    // duplicated across bus groups, and not claiming "applies to all
    // buses" (false under this rule: it decodes nothing).
    expect(screen.getAllByText("powertrain.dbc").length).toBe(1);
    expect(screen.queryByText(/applies to all buses/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not assigned to a bus — decodes nothing/i)).toBeInTheDocument();
    expect(screen.getByText(/\(Unassigned/i)).toBeInTheDocument();
  });

  it("collapses to '(All DBCs)' when the project has no buses configured", async () => {
    renderPanel(); // projectCtx.buses === []
    expect(await screen.findByText(/All DBCs/i)).toBeInTheDocument();
  });

  it("warns on a duplicate id, naming which database wins", async () => {
    // Two databases both assigned to bus-a, both defining EngineData /
    // EngineSpeed — a weird case the panel warns about rather than
    // silently picking one. The host names the winner
    // (`list_dbc_collisions`); the panel does not re-derive it.
    const secondDbc: DbcContentRecord = {
      dbcPath: "/tmp/powertrain2.dbc",
      messages: DBC_CONTENT[0].messages,
    };
    const ctx: ProjectContextValue = {
      ...projectCtx,
      dbcPaths: ["/tmp/powertrain.dbc", "/tmp/powertrain2.dbc"],
      buses: [{ id: "bus-a", name: "powertrain" }],
      dbcBuses: {
        "/tmp/powertrain.dbc": ["bus-a"],
        "/tmp/powertrain2.dbc": ["bus-a"],
      },
    };
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === "list_dbc_content") return [DBC_CONTENT[0], secondDbc];
      if (cmd === "list_file_backed_content") return [];
      if (cmd === "list_dbc_collisions")
        return [
          {
            busId: "bus-a",
            messageId: 256,
            extended: false,
            signalName: "EngineSpeed",
            winnerPath: "/tmp/powertrain.dbc",
            loserPath: "/tmp/powertrain2.dbc",
          },
        ];
      return undefined;
    });
    const api = fakePanelApi();
    const props = { params: {}, api } as unknown as Parameters<typeof DatabasePanel>[0];
    render(
      <ProjectContext.Provider value={ctx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <DatabasePanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    await screen.findByText("powertrain.dbc");
    expect(screen.getByText("powertrain2.dbc")).toBeInTheDocument();
    // The winner's row carries no warning; the loser's names it.
    expect(
      screen.getByText(/duplicate id.*powertrain\.dbc wins EngineSpeed/i),
    ).toBeInTheDocument();
  });

  it("groups messages under their transmitter ECU", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    // EngineData sits under its transmitter; GearState (no BO_
    // transmitter) under the "(no transmitter)" fallback group —
    // the same label the RBS view uses.
    expect(screen.getByText("EngineEcu")).toBeInTheDocument();
    expect(screen.getByText("(no transmitter)")).toBeInTheDocument();
    // The ECU row sits between the DBC root and the message: its
    // aria-level is DBC (2) + 1, the message's is + 2.
    const ecuRow = screen.getByText("EngineEcu").closest(".dbc-row");
    const msgRow = screen.getByText("EngineData").closest(".dbc-row");
    expect(ecuRow).toHaveAttribute("aria-level", "3");
    expect(msgRow).toHaveAttribute("aria-level", "4");
  });

  it("search by ECU name reveals that ECU's messages and hides the rest", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search database content");
    fireEvent.change(search, { target: { value: "EngineEcu" } });
    await waitFor(() =>
      expect(screen.queryByText("GearState")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("EngineData")).toBeInTheDocument();
  });

  it("ArrowDown / ArrowUp move the active row, and the selection follows it", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const tree = screen.getByRole("tree");
    // Rows on load: (All DBCs) bus → powertrain.dbc → EngineEcu →
    // EngineData → (no transmitter) → GearState.
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByText(/All DBCs/i).closest(".dbc-row")).toHaveClass(
      "dbc-row-active",
    );
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByText("EngineData").closest(".dbc-row")).toHaveClass(
      "dbc-row-active",
    );
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    expect(screen.getByText("EngineEcu").closest(".dbc-row")).toHaveClass(
      "dbc-row-active",
    );
    // ADR 0044: the cursor carries the selection with it
    // (single-select-follows-focus), and Enter ships unbound.
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expectRowSelected("EngineData");
    fireEvent.keyDown(tree, { key: "Enter" });
    expectRowSelected("EngineData");
  });

  it("ArrowRight expands the active row, ArrowLeft collapses / walks to the parent", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const tree = screen.getByRole("tree");
    // Walk down to EngineData.
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByText("EngineData").closest(".dbc-row")).toHaveClass(
      "dbc-row-active",
    );
    // Expand: signals appear.
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(await screen.findByText("EngineSpeed")).toBeInTheDocument();
    // A second ArrowRight steps into the first child.
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByText("EngineSpeed").closest(".dbc-row")).toHaveClass(
      "dbc-row-active",
    );
    // ArrowLeft from a leaf walks back to the parent…
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.getByText("EngineData").closest(".dbc-row")).toHaveClass(
      "dbc-row-active",
    );
    // …and from an expanded row collapses it.
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.queryByText("EngineSpeed")).not.toBeInTheDocument();
  });

  /// Rows the virtualizer can have in the DOM at once: the assumed
  /// viewport's worth (jsdom measures zero height) plus the partial row
  /// at the bottom edge plus the overscan margin on each side.
  const WINDOW_BOUND =
    Math.ceil(ASSUMED_VIEWPORT_HEIGHT / ROW_HEIGHT) + 1 + 2 * OVERSCAN;

  /// A tree at the reference project's shape: `messages` messages
  /// spread over 5 ECUs in one DBC, the first carrying 600 multiplexed
  /// signals.
  function bigTree(messageCount: number) {
    const bigSignals = Array.from({ length: 600 }, (_, i) => ({
      ...SIGNAL_DEFAULTS,
      name: `CellVoltage${String(i + 1).padStart(3, "0")}`,
      unit: "V",
      comment: "",
      attributes: [],
      valueTable: [],
      mux: { kind: "multiplexed" as const, selector: i % 25 },
    }));
    return Array.from({ length: messageCount }, (_, i) => ({
      ...MESSAGE_DEFAULTS,
      messageId: 0x100 + i,
      extended: false,
      name: `PackMessage${String(i + 1).padStart(3, "0")}`,
      transmitter: `Ecu${i % 5}`,
      comment: "",
      attributes: [],
      signals:
        i === 0
          ? bigSignals
          : [
              {
                ...SIGNAL_DEFAULTS,
                name: `PackSignal${String(i + 1).padStart(3, "0")}`,
                unit: "",
                comment: "",
                attributes: [],
                valueTable: [],
              },
            ],
    }));
  }

  /// Serve `messages` as the one loaded DBC's content.
  async function mockContent(messages: unknown[]) {
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === "list_file_backed_content") return [];
      if (cmd === "list_dbc_content")
        return [{ dbcPath: "/tmp/pack.dbc", messages }];
      return undefined;
    });
  }

  it("bounds the rendered rows at ev-zonal scale: collapsed by default, match-set-bounded when filtering", async () => {
    // Synthetic content at the ev-zonal fixture's scale: 150
    // messages across 5 ECUs, one message carrying 600 multiplexed
    // signals. The responsiveness rule: the unfiltered tree renders
    // no signal rows (messages stay collapsed); a
    // narrow filter renders only the match and its ancestor path.
    await mockContent(bigTree(150));
    renderPanel();
    await screen.findByText("PackMessage001");
    expect(screen.queryByText("CellVoltage001")).not.toBeInTheDocument();
    // A narrow filter: one signal match -> exactly the path to it
    // (bus, dbc, ecu, message) + the signal row.
    const search = screen.getByLabelText("search database content");
    fireEvent.change(search, { target: { value: "CellVoltage600" } });
    await screen.findByText("CellVoltage600");
    expect(document.querySelectorAll(".dbc-row").length).toBe(5);
  });

  it("renders only a viewport-bounded slice of the row list, however large the tree", async () => {
    // DOM row count tracks the viewport, not the DBC size. 2,000
    // messages (+ bus + dbc + 5 ECU rows) is a
    // 2,007-row list; the DOM holds a screenful.
    await mockContent(bigTree(2000));
    renderPanel();
    await screen.findByText("PackMessage001");
    const rendered = document.querySelectorAll(".dbc-row").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThanOrEqual(WINDOW_BOUND);
  });

  it("re-renders only the rows whose props changed when the keyboard cursor moves", async () => {
    // Moving the cursor one row down changes the `active` prop of
    // exactly two rows; without `memo` on `DbcRow` every row in the
    // window re-executes.
    await mockContent(bigTree(150));
    renderPanel();
    await screen.findByText("PackMessage001");
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" }); // cursor onto row 0
    const windowSize = document.querySelectorAll(".dbc-row").length;
    expect(windowSize).toBeGreaterThan(10); // a full window is rendered
    const before = diagCounts().get("dbcpanel.rowRender") ?? 0;
    fireEvent.keyDown(tree, { key: "ArrowDown" }); // row 0 -> row 1
    const rendered = (diagCounts().get("dbcpanel.rowRender") ?? 0) - before;
    expect(rendered).toBeLessThan(windowSize);
    expect(rendered).toBeLessThanOrEqual(4);
  });

  it("filters once the search input settles, not once per keystroke", async () => {
    await mockContent(bigTree(150));
    renderPanel();
    await screen.findByText("PackMessage001");
    const search = screen.getByLabelText("search database content");
    const before = diagCounts().get("dbcpanel.rowRender") ?? 0;
    // Type a query one character at a time. The tree is unchanged
    // through the burst — only the input re-renders.
    for (const q of ["P", "Pa", "Pac", "Pack", "PackM", "PackMe"]) {
      fireEvent.change(search, { target: { value: q } });
    }
    expect(diagCounts().get("dbcpanel.rowRender") ?? 0).toBe(before);
    // Once it settles the filter does apply.
    await waitFor(() =>
      expect(screen.getByText(/match/i)).toBeInTheDocument(),
    );
  });

  it("builds the search index on the first query and reuses it after", async () => {
    // The haystack index (one string per message and signal, value
    // tables inlined) and fzf's preprocessing of it are only worth
    // paying for once the user searches — and only once.
    await mockContent(bigTree(150));
    const builds = () => diagCounts().get("gridview.filterIndexBuild") ?? 0;
    const before = builds();
    renderPanel();
    await screen.findByText("PackMessage001");
    expect(builds()).toBe(before); // nothing typed yet — nothing built
    const search = screen.getByLabelText("search database content");
    fireEvent.change(search, { target: { value: "PackMessage007" } });
    await screen.findByText(/match/i);
    expect(builds()).toBe(before + 1);
    // Refining the query reuses the same matcher.
    fireEvent.change(search, { target: { value: "PackMessage042" } });
    await waitFor(() =>
      expect(screen.getByText("PackMessage042")).toBeInTheDocument(),
    );
    expect(builds()).toBe(before + 1);
  });

  it("scrolling the tree swaps in the rows at the new offset", async () => {
    await mockContent(bigTree(150));
    renderPanel();
    await screen.findByText("PackMessage001");
    // Rows: bus, dbc, then 5 ECU groups of 30 messages each. The last
    // row is Ecu4's highest-numbered message.
    expect(screen.queryByText("PackMessage150")).not.toBeInTheDocument();
    const tree = screen.getByRole("tree");
    // 157 rows tall, minus a viewport — scrolled to the bottom.
    fireEvent.scroll(tree, {
      target: { scrollTop: 157 * ROW_HEIGHT - ASSUMED_VIEWPORT_HEIGHT },
    });
    expect(await screen.findByText("PackMessage150")).toBeInTheDocument();
    expect(screen.queryByText("PackMessage001")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".dbc-row").length).toBeLessThanOrEqual(
      WINDOW_BOUND,
    );
  });

  it("ECU-qualified queries match through the dotted ancestry (bus.ecu.message)", async () => {
    // The user-reported case: typing an ECU name directly followed by
    // a message-name fragment ("bmsstatus" against BMS's PackStatus).
    // The transmitter must sit inside the dotted ancestry, before the
    // message name, for the subsequence to line up.
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search database content");
    fireEvent.change(search, { target: { value: "engineecu.engine" } });
    await waitFor(() =>
      expect(screen.queryByText("GearState")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("EngineData")).toBeInTheDocument();
  });

  it("prunes scattered low-quality fuzzy matches", async () => {
    // The user-reported case: searching 'pressure' surfaced messages
    // whose text merely contains p-r-e-s-s-u-r-e as a scattered
    // subsequence. fzf scores such matches far below a contiguous
    // hit; the panel drops results below a fraction of the top score.
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === "list_file_backed_content") return [];
      if (cmd === "list_dbc_content")
        return [
          {
            dbcPath: "/tmp/pack.dbc",
            messages: [
              {
                ...MESSAGE_DEFAULTS,
                messageId: 1,
                extended: false,
                name: "BrakeStatus",
                transmitter: "Brake",
                comment: "",
                attributes: [],
                signals: [
                  {
                    ...SIGNAL_DEFAULTS,
                    name: "CaliperPressure",
                    unit: "bar",
                    comment: "",
                    attributes: [],
                    valueTable: [],
                  },
                ],
              },
              {
                // Replica of the reported junk match: a BMS module
                // summary whose text contains p-r-e-s-s-u-r-e only as
                // a subsequence scattered across several words.
                ...MESSAGE_DEFAULTS,
                messageId: 2,
                extended: false,
                name: "Module01Summary",
                transmitter: "PackSensorFront",
                comment: "Module 01 summary (cells 1-8).",
                attributes: [],
                signals: [],
              },
            ],
          },
        ];
      return undefined;
    });
    renderPanel();
    await screen.findByText("BrakeStatus");
    const search = screen.getByLabelText("search database content");
    fireEvent.change(search, { target: { value: "pressure" } });
    await screen.findByText("CaliperPressure");
    expect(screen.queryByText("Module01Summary")).not.toBeInTheDocument();
  });

  it("renders an empty-state message when no DBCs are loaded", async () => {
    const api = fakePanelApi();
    const props = { params: {}, api } as unknown as Parameters<typeof DatabasePanel>[0];
    const noDbcCtx: ProjectContextValue = { ...projectCtx, dbcPaths: [] };
    // Override the mock to return an empty list this time — for both
    // catalogs, so the panel really has nothing to show.
    fileContent = [];
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async () => []);
    render(
      <ProjectContext.Provider value={noDbcCtx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <DatabasePanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    expect(await screen.findByText(/Nothing to browse yet/i)).toBeInTheDocument();
  });
  it("the values toggle fetches and renders live values for rendered signal rows", async () => {
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === "list_file_backed_content") return [];
      if (cmd === "list_dbc_content") return DBC_CONTENT;
      if (cmd === "fetch_signal_page") {
        return {
          count: 2,
          start: 0,
          rows: [
            {
              bus_id: null,
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
              count: 3,
              time_seconds: 1,
            },
          ],
        };
      }
      return undefined;
    });
    renderPanel();
    // Expand EngineData so its signal rows render.
    const msg = await screen.findByText("EngineData");
    fireEvent.click(msg);
    const row = msg.closest(".dbc-row")!;
    fireEvent.click(row.querySelector(".dbc-row-chevron")!);
    await screen.findByText("EngineSpeed");
    // Toggle the live value column on.
    fireEvent.click(screen.getByLabelText(/values/i));
    // The shared value renderer shows the fetched value with its unit;
    // the not-yet-seen sibling stays blank.
    // Value and unit are their own elements inside the one cell.
    const shown = await screen.findByText("1165");
    expect(shown.closest(".signal-value-cell")).toHaveTextContent(/^1165\s*rpm$/);
    const calls = (core.invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "fetch_signal_page",
    );
    expect(calls.length).toBeGreaterThan(0);
    const sel = (calls[0][1] as { selection: { keys: { signalName: string }[] } }).selection;
    expect(sel.keys.map((k) => k.signalName).sort()).toEqual(["EngineSpeed", "EngineTemp"]);
  });

  it("polls for values only when the capture has grown", async () => {
    // The poll had no dirty gate: it re-fetched every 500 ms whether or
    // not a frame had arrived — with no capture running at all, forever,
    // and each tick a whole-id-space snapshot host-side. `trace-grew`
    // already goes quiet when the capture does, so gate on it.
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === "list_file_backed_content") return [];
      if (cmd === "list_dbc_content") return DBC_CONTENT;
      if (cmd === "fetch_signal_page") return { count: 0, start: 0, rows: [] };
      return undefined;
    });
    renderPanel();
    const msg = await screen.findByText("EngineData");
    fireEvent.click(msg.closest(".dbc-row")!.querySelector(".dbc-row-chevron")!);
    await screen.findByText("EngineSpeed");
    fireEvent.click(screen.getByLabelText(/values/i));
    const pageCalls = () =>
      (core.invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === "fetch_signal_page",
      ).length;
    await waitFor(() => expect(pageCalls()).toBeGreaterThan(0));

    // Nothing is capturing: several poll intervals must cost nothing.
    const settled = pageCalls();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(pageCalls()).toBe(settled);

    // A `trace-grew` means a value may have moved — exactly one refetch.
    await act(async () => {
      emitHostEvent("trace-grew");
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(pageCalls()).toBe(settled + 1);
  });

  it("stops polling for values while the panel is hidden", async () => {
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === "list_file_backed_content") return [];
      if (cmd === "list_dbc_content") return DBC_CONTENT;
      if (cmd === "fetch_signal_page") return { count: 0, start: 0, rows: [] };
      return undefined;
    });
    const api = renderPanel();
    const msg = await screen.findByText("EngineData");
    fireEvent.click(msg.closest(".dbc-row")!.querySelector(".dbc-row-chevron")!);
    await screen.findByText("EngineSpeed");
    fireEvent.click(screen.getByLabelText(/values/i));
    const pageCalls = () =>
      (core.invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === "fetch_signal_page",
      ).length;
    await waitFor(() => expect(pageCalls()).toBeGreaterThan(0));
    // Send the panel to a background tab: the standing poll must stop.
    act(() => api.setVisible(false));
    const whileHidden = pageCalls();
    await new Promise((r) => setTimeout(r, 700)); // > one poll interval
    expect(pageCalls()).toBe(whileHidden);
    // Coming back into view resumes it.
    act(() => api.setVisible(true));
    await waitFor(() => expect(pageCalls()).toBeGreaterThan(whileHidden));
  });
});

/// The file-backed half of the catalog (ADR 0052): one branch per
/// source capture file, organised the way the file organises signals —
/// beside the DBC branches, never folded into them.
describe("DatabasePanel file-backed branches", () => {
  /// Open a branch/group row by its disclosure (a plain row click on a
  /// container also toggles, but the chevron is the explicit gesture).
  function expandRow(label: string) {
    const chevron = screen
      .getByText(label)
      .closest(".dbc-row")
      ?.querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(chevron);
  }

  it("renders one branch per source file, labelled with the filename", async () => {
    renderPanel();
    // The file's basename, not its machine-local path.
    const file = await screen.findByText("drive.mf4");
    expect(file.closest(".dbc-row")).toHaveClass("dbc-row-file");
    // Auto-expanded to its groups on first load, like a DBC branch is
    // to its ECUs; the groups themselves stay closed.
    expect(await screen.findByText("Analog")).toBeInTheDocument();
    expect(screen.queryByText("AmbientTemp")).not.toBeInTheDocument();
    // Beside the DBC branch, not inside it.
    expect(screen.getByText("powertrain.dbc")).toBeInTheDocument();
  });

  it("shows each group's signals as name + unit, with no sample counts", async () => {
    renderPanel();
    await screen.findByText("Analog");
    expandRow("Analog");
    const row = (await screen.findByText("AmbientTemp")).closest(".dbc-row") as HTMLElement;
    expect(row).toHaveClass("dbc-row-filesignal");
    expect(row.textContent).toContain("[degC]");
    expect(row.textContent).not.toMatch(/\d+\s*samples?/);
    expect(screen.getByText("CabinHumidity")).toBeInTheDocument();
  });

  it("branches vanish when the capture's file-backed set empties", async () => {
    renderPanel();
    await screen.findByText("drive.mf4");
    // The capture went away (Clear, or an import carrying none): the
    // host says so and the catalog comes back empty.
    fileContent = [];
    act(() => emitHostEvent("file-signals-changed"));
    await waitFor(() => expect(screen.queryByText("drive.mf4")).not.toBeInTheDocument());
    expect(screen.queryByText("Analog")).not.toBeInTheDocument();
    // The DBC branches — project members, a different lifecycle — stay.
    expect(screen.getByText("powertrain.dbc")).toBeInTheDocument();
  });

  it("file-backed rows participate in the panel's search", async () => {
    renderPanel();
    await screen.findByText("drive.mf4");
    const search = screen.getByLabelText("search database content");
    fireEvent.change(search, { target: { value: "CabinHumidity" } });
    // The match's own path force-expands (file → group), and the DBC
    // half of the tree is gone from the render.
    expect(await screen.findByText("CabinHumidity")).toBeInTheDocument();
    expect(screen.getByText("drive.mf4")).toBeInTheDocument();
    expect(screen.getByText("Analog")).toBeInTheDocument();
    expect(screen.queryByText("AmbientTemp")).not.toBeInTheDocument();
    expect(screen.queryByText("powertrain.dbc")).not.toBeInTheDocument();
  });

  it("shows a file-backed row's value in the live value column", async () => {
    // The panel's value column covered DBC-backed rows only: a
    // file-backed row was left out of the keys it asked for and out of
    // the cell it renders, though `fetch_signal_page` serves such keys
    // (the host's file-backed half is selected by the same manual key,
    // with the provenance flag on it).
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (cmd: string, args?: unknown) => {
        if (cmd === "list_dbc_content") return DBC_CONTENT;
        if (cmd === "list_file_backed_content") return fileContent;
        if (cmd === "fetch_signal_page") {
          const sel = (args as { selection: { keys: { signalName: string; fileBacked?: boolean }[] } })
            .selection;
          // The host only answers for what it was asked: a row appears
          // when the key naming it — provenance included — is in the
          // selection.
          const asked = sel.keys.some((k) => k.signalName === "AmbientTemp" && k.fileBacked === true);
          return {
            count: asked ? 1 : 0,
            start: 0,
            rows: asked
              ? [
                  {
                    bus_id: null,
                    transmitter: null,
                    message_id: 1,
                    extended: false,
                    message_name: "Analog",
                    signal_name: "AmbientTemp",
                    unit: "degC",
                    is_enum: false,
                    file_backed: true,
                    value: 21.5,
                    raw: null,
                    rate: null,
                    count: 26,
                    time_seconds: 3,
                  },
                ]
              : [],
          };
        }
        return undefined;
      },
    );
    renderPanel();
    await screen.findByText("Analog");
    expandRow("Analog");
    await screen.findByText("AmbientTemp");
    fireEvent.click(screen.getByLabelText(/values/i));

    // The ask: the visible file-backed row is in the selection, keyed by
    // its provenance (group index in the message slot, `fileBacked` set).
    await waitFor(() => {
      const calls = (core.invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === "fetch_signal_page",
      );
      expect(calls.length).toBeGreaterThan(0);
      const sel = (calls[calls.length - 1][1] as {
        selection: { keys: { messageId: number; signalName: string; fileBacked?: boolean }[] };
      }).selection;
      expect(sel.keys).toContainEqual(
        expect.objectContaining({ messageId: 1, signalName: "AmbientTemp", fileBacked: true }),
      );
    });

    // …and the answer reaches the row's cell.
    const shown = await screen.findByText("21.5");
    expect(shown.closest(".signal-value-cell")).toHaveTextContent(/^21\.5\s*degC$/);
  });

  it("drag from a file-backed row carries the provenance-keyed reference", async () => {
    renderPanel();
    await screen.findByText("Analog");
    expandRow("Analog");
    const row = (await screen.findByText("AmbientTemp")).closest(".dbc-row") as HTMLElement;
    const dt = makeFakeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });

    // What a drop target reads: the same payload shape every other
    // drag source sets, with the group index in the message slot and
    // the provenance flag that keeps it out of the message-id
    // namespace.
    const { refs } = parseDroppedSignals(dt.getData(SIGNAL_DND_MIME));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      busId: null,
      messageId: 1,
      extended: false,
      signalName: "AmbientTemp",
      messageName: "Analog",
      unit: "degC",
      fileBacked: true,
    });
    // …and therefore the identity the host is asked for: the `f` slot,
    // not the `s`/`x` a DBC-backed signal on message id 1 would take.
    expect(signalRefKey(refs[0])).toBe(
      signalKey(null, 1, false, "AmbientTemp", true),
    );
  });
});

describe("DatabasePanel command registration (panel.find)", () => {
  function renderWithCommands() {
    const api = fakePanelApi();
    const commands = createPanelCommandRegistry();
    const props = { params: {}, api } as unknown as Parameters<typeof DatabasePanel>[0];
    render(
      <ProjectContext.Provider value={projectCtx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <PanelCommandsContext.Provider value={commands}>
            <DatabasePanel {...props} />
          </PanelCommandsContext.Provider>
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    return commands;
  }

  it("focuses and selects the search box", async () => {
    const commands = renderWithCommands();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search database content") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "EngineSpeed" } });
    expect(document.activeElement).not.toBe(search);
    act(() => {
      commands.invoke(DBC_PANEL_ID, "panel.find");
    });
    expect(document.activeElement).toBe(search);
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe(search.value.length);
  });
});

describe("DatabasePanel with long names", () => {
  it("splits a long message and signal name, and leaves a short one alone", async () => {
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === "list_file_backed_content") return [];
      if (cmd === "list_dbc_content")
        return [
          {
            dbcPath: "/tmp/zonal.dbc",
            messages: [
              {
                ...DBC_CONTENT[0].messages[0],
                name: LONG_MESSAGE_NAME,
                signals: [
                  { ...DBC_CONTENT[0].messages[0].signals[0], name: LONG_SIGNAL_NAME },
                  { ...DBC_CONTENT[0].messages[0].signals[1], name: "DerateActive" },
                ],
              },
            ],
          },
        ];
      return undefined;
    });
    renderPanel();
    // The name is split across two spans, so it is reachable by its
    // tooltip rather than by its text — which is the point: the
    // tooltip is what keeps the full name available.
    const msgName = await screen.findByTitle(LONG_MESSAGE_NAME);
    expectMiddleEllipsis(msgName, LONG_MESSAGE_NAME, LONG_MESSAGE_TAIL);
    const chevron = msgName
      .closest(".dbc-row")!
      .querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(chevron);
    const sigName = await screen.findByTitle(LONG_SIGNAL_NAME);
    expectMiddleEllipsis(sigName, LONG_SIGNAL_NAME, LONG_SIGNAL_TAIL);
    // The control: the short signal beside it stays a plain text node.
    const short = screen.getByText("DerateActive");
    expect(short.querySelector(".name-text")).toBeNull();
  });
});
