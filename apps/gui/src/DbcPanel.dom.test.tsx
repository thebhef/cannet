// @vitest-environment jsdom
//
// DOM tests for the Phase 12 DBC discovery panel: tree render from a
// `list_dbc_content` payload, expand-collapse, and fuzzy-search behavior
// (matched set, auto-expand of ancestors, dimming of non-matches).
// fzf runs for real here — the panel's interesting behavior is the
// interaction between fzf's match set and the tree-render rules, so
// faking the matcher would defeat the test.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { DbcContentRecord, Bus, InterfaceBinding } from "./types";
import { SIGNAL_DND_MIME, parseSignalDragData } from "./dragSignals";

/// Defaults for the Phase-12-polish rich signal fields so the test
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
  onAddBinding: () => {},
  onRemoveBinding: () => {},
  onConnect: () => {},
  onDisconnect: () => {},
};

function renderPanel() {
  const api = { updateParameters: vi.fn() };
  const props = { params: {}, api } as unknown as Parameters<typeof DbcPanel>[0];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <DbcPanel {...props} />
    </ProjectContext.Provider>,
  );
  return api;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
    // Plain row click selects (Phase 12 multi-select), so expand
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

  it("dims rows outside the match set when the search is active", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search DBC content");
    fireEvent.change(search, { target: { value: "EngineSpeed" } });
    await screen.findByText("EngineSpeed");
    // GearState shouldn't be dimmed away from the tree (it's still
    // shown — the DBC root forces it to render), but its row should
    // carry the dim class because nothing under it matches.
    const gearRow = screen.getByText("GearState").closest(".dbc-row");
    expect(gearRow).toHaveClass("dbc-row-dim");
    // The matching signal row is NOT dim.
    const speedRow = screen.getByText("EngineSpeed").closest(".dbc-row");
    expect(speedRow).not.toHaveClass("dbc-row-dim");
  });

  it("matches on hex message id", async () => {
    renderPanel();
    await screen.findByText("EngineData");
    const search = screen.getByLabelText("search DBC content");
    // 0x100 = 256 = EngineData
    fireEvent.change(search, { target: { value: "0x100" } });
    await waitFor(() => {
      const row = screen.getByText("EngineData").closest(".dbc-row");
      expect(row).not.toHaveClass("dbc-row-dim");
    });
    // GearState (id 0x200) doesn't match.
    const gearRow = screen.getByText("GearState").closest(".dbc-row");
    expect(gearRow).toHaveClass("dbc-row-dim");
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
        <DbcPanel {...props} />
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
        <DbcPanel {...props} />
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
        <DbcPanel {...props} />
      </ProjectContext.Provider>,
    );
    await screen.findByText("powertrain");
    const search = screen.getByLabelText("search DBC content");
    // 'powertrain.engine' → EngineData under bus-a matches.
    fireEvent.change(search, { target: { value: "powertrain.engine" } });
    await waitFor(() => {
      const row = screen.getByText("EngineData").closest(".dbc-row");
      expect(row).not.toHaveClass("dbc-row-dim");
    });
    // 'chassis.engine' → no chassis-scoped EngineData → message
    // row should be dim.
    fireEvent.change(search, { target: { value: "chassis.engine" } });
    await waitFor(() => {
      const row = screen.getByText("EngineData").closest(".dbc-row");
      expect(row).toHaveClass("dbc-row-dim");
    });
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
        <DbcPanel {...props} />
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

  it("renders an empty-state message when no DBCs are loaded", async () => {
    const api = { updateParameters: vi.fn() };
    const props = { params: {}, api } as unknown as Parameters<typeof DbcPanel>[0];
    const noDbcCtx: ProjectContextValue = { ...projectCtx, dbcPaths: [] };
    // Override the mock to return an empty list this time.
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => []);
    render(
      <ProjectContext.Provider value={noDbcCtx}>
        <DbcPanel {...props} />
      </ProjectContext.Provider>,
    );
    expect(await screen.findByText(/No DBC attached/i)).toBeInTheDocument();
  });
});
