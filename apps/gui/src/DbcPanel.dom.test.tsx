// @vitest-environment jsdom
//
// DOM tests for the DBC discovery panel: tree render from a
// `list_dbc_content` payload, expand-collapse, per-ECU grouping,
// fuzzy-search behavior (matched set, auto-expand of ancestors,
// hiding of non-matches), and keyboard navigation.
// fzf runs for real here — the panel's interesting behavior is the
// interaction between fzf's match set and the tree-render rules, so
// faking the matcher would defeat the test.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { DbcContentRecord, Bus, InterfaceBinding } from "./types";
import { SIGNAL_DND_MIME, parseSignalDragData } from "./dragSignals";

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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "list_dbc_content") return DBC_CONTENT;
    return undefined;
  }),
}));
// `listen` is what the panel hooks up to receive `dbc-changed`
// events from the host's filesystem watcher. The mock returns a
// resolved no-op unsubscriber so the cleanup path runs cleanly.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { DbcPanel } from "./DbcPanel";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { ElementRegistryContext, type ElementRegistry } from "./projectElements";

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
  onRenameBus: () => {},
  onSetBusColor: () => {},
  onSetBusSpeed: () => {},
  onSetBusFd: () => {},
  onSetBusFdDataSpeed: () => {},
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

function renderPanel() {
  const api = { updateParameters: vi.fn() };
  const props = { params: {}, api } as unknown as Parameters<typeof DbcPanel>[0];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <ElementRegistryContext.Provider value={emptyRegistry}>
        <DbcPanel {...props} />
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
  return api;
}

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  // Restore the default content for tests that swapped in their own
  // fixture via `mockImplementation` (clearAllMocks clears call
  // history, not implementations).
  const core = await import("@tauri-apps/api/core");
  (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
    if (cmd === "list_dbc_content") return DBC_CONTENT;
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

describe("DbcPanel", () => {
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
    const search = screen.getByLabelText("search DBC content");
    fireEvent.change(search, { target: { value: "EngineSpeed" } });
    // EngineSpeed is a child of the collapsed EngineData; the search
    // must force-expand the ancestor so the match is visible.
    expect(await screen.findByText("EngineSpeed")).toBeInTheDocument();
  });

  it("hides rows outside the match set when the search is active", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search DBC content");
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
    const search = screen.getByLabelText("search DBC content");
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
    const search = screen.getByLabelText("search DBC content");
    // 0x100 = 256 = EngineData
    fireEvent.change(search, { target: { value: "0x100" } });
    await waitFor(() =>
      expect(screen.getByText("EngineData")).toBeInTheDocument(),
    );
    // GearState (id 0x200) doesn't match — hidden.
    expect(screen.queryByText("GearState")).not.toBeInTheDocument();
  });

  it("matches on value-table labels", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search DBC content");
    fireEvent.change(search, { target: { value: "Park" } });
    // Mode has a `Park` value-table label — its ancestor GearState
    // must auto-expand so the signal is visible.
    expect(await screen.findByText("Mode")).toBeInTheDocument();
  });

  it("shows match count when filter is active", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search DBC content");
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

  it("Shift-click range-extends from the anchor over visible rows", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    // Click to set anchor, then shift-click on the second row to
    // grab both.
    fireEvent.click(screen.getByText("EngineData"));
    fireEvent.click(screen.getByText("GearState"), { shiftKey: true });
    expectRowSelected("EngineData");
    expectRowSelected("GearState");
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
    const api = { updateParameters: vi.fn() };
    const props = { params: {}, api } as unknown as Parameters<typeof DbcPanel>[0];
    render(
      <ProjectContext.Provider value={scopedCtx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <DbcPanel {...props} />
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

  it("drag from an unscoped DBC's bus-group row carries that bus's id", async () => {
    // The bug the user hit: an unscoped DBC's signal previously
    // dropped as `busId: null` (legacy any-bus). With the per-bus
    // tree the user is dragging from a specific bus group's view —
    // the drag should carry THAT bus's id, not null.
    const buses: Bus[] = [
      { id: "bus-a", name: "powertrain" },
      { id: "bus-b", name: "chassis" },
    ];
    const ctx: ProjectContextValue = {
      ...projectCtx,
      buses,
      // No scoping → unscoped DBC, appears under every bus group.
      dbcBuses: {},
    };
    const api = { updateParameters: vi.fn() };
    const props = { params: {}, api } as unknown as Parameters<typeof DbcPanel>[0];
    render(
      <ProjectContext.Provider value={ctx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <DbcPanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    const allEng = await screen.findAllByText("EngineData");
    expect(allEng.length).toBe(2);
    // Drag from the second one (under bus-b / "chassis"). Bus-b
    // should be the resulting busId.
    const chevron = allEng[1]
      .closest(".dbc-row")
      ?.querySelector(".dbc-row-chevron") as HTMLElement;
    fireEvent.click(chevron);
    // Only bus-b's EngineData was expanded; its signal row is the
    // only EngineSpeed in the DOM.
    const signalRow = (await screen.findByText("EngineSpeed")).closest(
      ".dbc-row",
    ) as HTMLElement;
    const dt = makeFakeDataTransfer();
    fireEvent.dragStart(signalRow, { dataTransfer: dt });
    const refs = parseSignalDragData(dt.getData(SIGNAL_DND_MIME)).signals;
    expect(refs).toHaveLength(1);
    expect(refs[0].busId).toBe("bus-b");
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
    const api = { updateParameters: vi.fn() };
    const props = { params: {}, api } as unknown as Parameters<typeof DbcPanel>[0];
    render(
      <ProjectContext.Provider value={ctx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <DbcPanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    await screen.findByText("powertrain");
    const search = screen.getByLabelText("search DBC content");
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
      // powertrain.dbc is unscoped here — it should appear under
      // BOTH bus groups, marked "applies to all buses".
      dbcBuses: {},
    };
    const api = { updateParameters: vi.fn() };
    const props = { params: {}, api } as unknown as Parameters<typeof DbcPanel>[0];
    render(
      <ProjectContext.Provider value={ctx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <DbcPanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    // Both bus group rows are visible at the top.
    expect(await screen.findByText("powertrain")).toBeInTheDocument();
    expect(screen.getByText("chassis")).toBeInTheDocument();
    // Unscoped DBC appears under both bus groups.
    expect(screen.getAllByText("powertrain.dbc").length).toBe(2);
    // The unscoped scope-label is rendered on each occurrence.
    expect(screen.getAllByText(/applies to all buses/i).length).toBe(2);
  });

  it("collapses to '(All DBCs)' when the project has no buses configured", async () => {
    renderPanel(); // projectCtx.buses === []
    expect(await screen.findByText(/All DBCs/i)).toBeInTheDocument();
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
    const search = screen.getByLabelText("search DBC content");
    fireEvent.change(search, { target: { value: "EngineEcu" } });
    await waitFor(() =>
      expect(screen.queryByText("GearState")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("EngineData")).toBeInTheDocument();
  });

  it("ArrowDown / ArrowUp move the active row; Enter selects it", async () => {
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
    // Enter on a message row selects it.
    fireEvent.keyDown(tree, { key: "ArrowDown" });
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

  it("bounds the rendered rows at ev-zonal scale: collapsed by default, match-set-bounded when filtering", async () => {
    // Synthetic content at the ev-zonal fixture's scale: 150
    // messages across 5 ECUs, one message carrying 600 multiplexed
    // signals. The responsiveness rule (task 33): the unfiltered
    // tree renders no signal rows (messages stay collapsed); a
    // narrow filter renders only the match and its ancestor path.
    const bigSignals = Array.from({ length: 600 }, (_, i) => ({
      ...SIGNAL_DEFAULTS,
      name: `CellVoltage${String(i + 1).padStart(3, "0")}`,
      unit: "V",
      comment: "",
      attributes: [],
      valueTable: [],
      mux: { kind: "multiplexed" as const, selector: i % 25 },
    }));
    const messages = Array.from({ length: 150 }, (_, i) => ({
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
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === "list_dbc_content")
        return [{ dbcPath: "/tmp/pack.dbc", messages }];
      return undefined;
    });
    renderPanel();
    await screen.findByText("PackMessage001");
    // Unfiltered: bus + dbc + 5 ECU rows + 150 messages, no signals.
    expect(document.querySelectorAll(".dbc-row").length).toBe(157);
    expect(screen.queryByText("CellVoltage001")).not.toBeInTheDocument();
    // A narrow filter: one signal match -> exactly the path to it
    // (bus, dbc, ecu, message) + the signal row.
    const search = screen.getByLabelText("search DBC content");
    fireEvent.change(search, { target: { value: "CellVoltage600" } });
    await screen.findByText("CellVoltage600");
    expect(document.querySelectorAll(".dbc-row").length).toBe(5);
  });

  it("ECU-qualified queries match through the dotted ancestry (bus.ecu.message)", async () => {
    // The user-reported case: typing an ECU name directly followed by
    // a message-name fragment ("bmsstatus" against BMS's PackStatus).
    // The transmitter must sit inside the dotted ancestry, before the
    // message name, for the subsequence to line up.
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search DBC content");
    fireEvent.change(search, { target: { value: "engineecu.engine" } });
    await waitFor(() =>
      expect(screen.getByText("EngineData")).toBeInTheDocument(),
    );
    expect(screen.queryByText("GearState")).not.toBeInTheDocument();
  });

  it("prunes scattered low-quality fuzzy matches", async () => {
    // The user-reported case: searching 'pressure' surfaced messages
    // whose text merely contains p-r-e-s-s-u-r-e as a scattered
    // subsequence. fzf scores such matches far below a contiguous
    // hit; the panel drops results below a fraction of the top score.
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
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
    const search = screen.getByLabelText("search DBC content");
    fireEvent.change(search, { target: { value: "pressure" } });
    await screen.findByText("CaliperPressure");
    expect(screen.queryByText("Module01Summary")).not.toBeInTheDocument();
  });

  it("renders an empty-state message when no DBCs are loaded", async () => {
    const api = { updateParameters: vi.fn() };
    const props = { params: {}, api } as unknown as Parameters<typeof DbcPanel>[0];
    const noDbcCtx: ProjectContextValue = { ...projectCtx, dbcPaths: [] };
    // Override the mock to return an empty list this time.
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => []);
    render(
      <ProjectContext.Provider value={noDbcCtx}>
        <ElementRegistryContext.Provider value={emptyRegistry}>
          <DbcPanel {...props} />
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>,
    );
    expect(await screen.findByText(/No DBC attached/i)).toBeInTheDocument();
  });
  it("the values toggle fetches and renders live values for rendered signal rows", async () => {
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
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
    expect(await screen.findByText(/1165 rpm/)).toBeInTheDocument();
    const calls = (core.invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "fetch_signal_page",
    );
    expect(calls.length).toBeGreaterThan(0);
    const sel = (calls[0][1] as { selection: { keys: { signalName: string }[] } }).selection;
    expect(sel.keys.map((k) => k.signalName).sort()).toEqual(["EngineSpeed", "EngineTemp"]);
  });
});
