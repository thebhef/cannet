// @vitest-environment jsdom
//
// DOM tests for the shared math-signal editor — the one editing view
// every surface that shows a math signal mounts (the Database panel's
// Computed branch here; a signal panel row and a plot's side list
// later). What is pinned: the fixed prepopulated operand sections and
// their per-section validity, the three ways a section is filled
// (combobox, drag, pattern), the parameter fields, and the rule that
// makes all of it one component — **every field commits as it is
// left**, one host write and one undo step, with no Save to press.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { Bus, MathSignalRecord, SignalDescriptorRecord } from "./types";
import { SIGNAL_DND_MIME } from "./dragSignals";

const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
/// What the next write answers with — a rejection models the host
/// refusing an edit (a cycle or a duplicate id; nothing else refuses).
let hostRefusal: string | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    if (hostRefusal) throw hostRefusal;
    return undefined;
  }),
}));

import { MathSignalEditor } from "./MathSignalEditor";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { SignalCatalogContext } from "./signalCatalogContext";
import { PanelEditRecorderContext } from "./panelEditRecorder";
import type { PanelEditStep } from "./panelEditHistory";

const BUSES: Bus[] = [{ id: "bus-a", name: "CAN1" } as Bus];

const catalogEntry = (
  name: string,
  over: Partial<SignalDescriptorRecord> = {},
): SignalDescriptorRecord => ({
  bus_id: "bus-a",
  message_id: 0x120,
  extended: false,
  message_name: "BMS_Cells",
  transmitter: "BMS",
  signal_name: name,
  unit: "V",
  ...over,
});

const CATALOG: SignalDescriptorRecord[] = [
  catalogEntry("Cell01"),
  catalogEntry("Cell02"),
  catalogEntry("PackCurrent", {
    message_id: 0x121,
    message_name: "BMS_Pack",
    unit: "A",
  }),
];

const projectCtx = {
  buses: BUSES,
  dbcPaths: [],
  dbcBuses: {},
  signalColors: {},
} as unknown as ProjectContextValue;

const steps: PanelEditStep[] = [];

function mathRecord(over: Partial<MathSignalRecord> = {}): MathSignalRecord {
  return {
    id: "m1",
    name: "CellMedian",
    unit: null,
    function: { kind: "median" },
    operands: { picks: [], patterns: [] },
    identity: "*|m:0:m1",
    kind: "median",
    arity: "set",
    resolvedOperands: [],
    operandPaths: [],
    unitResolved: "V",
    busIds: ["bus-a"],
    invalid: null,
    ...over,
  };
}

function renderEditor(record: MathSignalRecord, definitions: MathSignalRecord[] = []) {
  render(
    <ProjectContext.Provider value={projectCtx}>
      <SignalCatalogContext.Provider value={{ catalog: CATALOG }}>
        <PanelEditRecorderContext.Provider value={(s) => steps.push(s)}>
          <MathSignalEditor record={record} definitions={definitions} />
        </PanelEditRecorderContext.Provider>
      </SignalCatalogContext.Provider>
    </ProjectContext.Provider>,
  );
}

/// Minimal `DataTransfer` stand-in — the same shape the Database
/// panel's drag tests use.
function fakeDataTransfer(payload: unknown): DataTransfer {
  const store: Record<string, string> = {
    [SIGNAL_DND_MIME]: JSON.stringify(payload),
    "application/x-cannet-drag-signals": "",
  };
  return {
    setData(type: string, data: string) {
      store[type] = data;
    },
    getData: (type: string) => store[type] ?? "",
    get types() {
      return Object.keys(store);
    },
    effectAllowed: "none",
    dropEffect: "none",
  } as unknown as DataTransfer;
}

const signalPayload = (...names: string[]) => ({
  signals: names.map((signalName) => ({
    busId: "bus-a",
    messageId: 0x120,
    extended: false,
    signalName,
    messageName: "BMS_Cells",
    unit: "V",
  })),
  patterns: [],
});

/// What a Computed row drags: no bus, no message, the definition's
/// **stable id** in the signal slot under the `math` flag.
const mathPayload = (id: string) => ({
  signals: [
    {
      busId: null,
      messageId: 0,
      extended: false,
      signalName: id,
      messageName: "Math",
      unit: "V",
      math: true,
    },
  ],
  patterns: [],
});

const section = (label: string) => screen.getByRole("group", { name: `${label} operands` });
const dbcRef = (name: string) => ({
  busId: "bus-a",
  messageId: 0x120,
  extended: false,
  signalName: name,
});
const mathRef = (id: string) => ({
  busId: null,
  messageId: 0,
  extended: false,
  signalName: id,
  math: true,
});
function lastWrite() {
  const write = invoked.filter((c) => c.cmd === "update_math_signal");
  return write[write.length - 1];
}
function writtenDefinition() {
  return lastWrite()!.args.definition as MathSignalRecord;
}

afterEach(() => {
  cleanup();
  invoked.length = 0;
  steps.length = 0;
  hostRefusal = null;
  vi.clearAllMocks();
});

describe("the fixed operand sections", () => {
  it("prepopulates A and B for a pair, each asking for one signal", () => {
    renderEditor(
      mathRecord({ kind: "difference", arity: "pair", function: { kind: "difference" } }),
    );
    expect(section("A")).toHaveTextContent("pick one");
    expect(section("B")).toHaveTextContent("pick one");
    // Fixed sections: nothing offers to add or remove one.
    expect(screen.queryByRole("button", { name: /add section/i })).not.toBeInTheDocument();
  });

  it("prepopulates one Signal section for a single-operand function", () => {
    renderEditor(
      mathRecord({
        kind: "expfilter",
        arity: "one",
        function: { kind: "expfilter", tau_seconds: 2 },
      }),
    );
    expect(section("Signal")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "A operands" })).not.toBeInTheDocument();
  });

  it("prepopulates one Signals section for a set, and none at all for hline", () => {
    renderEditor(mathRecord({ kind: "max", function: { kind: "max" } }));
    expect(section("Signals")).toHaveTextContent("needs ≥ 2");
    cleanup();
    renderEditor(
      mathRecord({ kind: "hline", arity: "none", function: { kind: "hline", value: 0 } }),
    );
    expect(screen.queryByRole("group", { name: /operands/ })).not.toBeInTheDocument();
  });
});

describe("filling a section", () => {
  const pairRecord = () =>
    mathRecord({ kind: "difference", arity: "pair", function: { kind: "difference" } });

  it("commits a pick made through the combobox, filtered fuzzily", async () => {
    renderEditor(pairRecord());
    fireEvent.click(screen.getByRole("combobox", { name: "A signal" }));
    const filter = screen.getByRole("textbox", { name: /A signal filter/ });
    fireEvent.change(filter, { target: { value: "pckur" } });
    // Fuzzy, over the whole path: the two cell signals drop out.
    expect(screen.queryByRole("option", { name: /Cell01/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /PackCurrent/ }));
    await waitFor(() => expect(lastWrite()).toBeDefined());
    expect(writtenDefinition().operands.picks).toEqual([
      { busId: "bus-a", messageId: 0x121, extended: false, signalName: "PackCurrent" },
    ]);
  });

  it("commits a signal dragged in from the database tree", async () => {
    renderEditor(
      mathRecord({ kind: "rms", arity: "one", function: { kind: "rms" } }),
    );
    fireEvent.drop(section("Signal"), {
      dataTransfer: fakeDataTransfer(signalPayload("Cell01")),
    });
    await waitFor(() => expect(lastWrite()).toBeDefined());
    expect(writtenDefinition().operands.picks).toEqual([dbcRef("Cell01")]);
  });

  it("commits a math signal dragged in from the Computed branch", async () => {
    // A math signal is a legal operand of another one, and the drag
    // payload carries the provenance flag that says so. Dropping one
    // has to keep the flag: without it the pick names a DBC identity
    // nothing decodes, and the operand reads back as missing.
    const other = mathRecord({ id: "m2", name: "PackRms", kind: "rms", arity: "one" });
    renderEditor(mathRecord({ kind: "rms", arity: "one", function: { kind: "rms" } }), [other]);
    fireEvent.drop(section("Signal"), {
      dataTransfer: fakeDataTransfer(mathPayload("m2")),
    });
    await waitFor(() => expect(lastWrite()).toBeDefined());
    expect(writtenDefinition().operands.picks).toEqual([mathRef("m2")]);
  });

  it("takes a whole set from one drag, in one write", async () => {
    renderEditor(mathRecord({ kind: "sum", function: { kind: "sum" } }));
    fireEvent.drop(section("Signals"), {
      dataTransfer: fakeDataTransfer(signalPayload("Cell01", "Cell02")),
    });
    await waitFor(() => expect(lastWrite()).toBeDefined());
    expect(writtenDefinition().operands.picks).toEqual([dbcRef("Cell01"), dbcRef("Cell02")]);
    expect(invoked.filter((c) => c.cmd === "update_math_signal")).toHaveLength(1);
  });

  it("shows what a section holds, with its live count", () => {
    renderEditor(
      mathRecord({
        kind: "sum",
        function: { kind: "sum" },
        operands: { picks: [dbcRef("Cell01"), dbcRef("Cell02")], patterns: [] },
        resolvedOperands: [dbcRef("Cell01"), dbcRef("Cell02")],
      }),
    );
    expect(section("Signals")).toHaveTextContent("Cell01");
    expect(section("Signals")).toHaveTextContent("Cell02");
    expect(section("Signals")).toHaveTextContent("2 signals");
  });

  it("commits an operand's removal", async () => {
    renderEditor(
      mathRecord({
        kind: "rms",
        arity: "one",
        function: { kind: "rms" },
        operands: { picks: [dbcRef("Cell01")], patterns: [] },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "remove Cell01" }));
    await waitFor(() => expect(lastWrite()).toBeDefined());
    expect(writtenDefinition().operands.picks).toEqual([]);
  });
});

describe("a set section's patterns", () => {
  const setRecord = (patterns: string[] = []) =>
    mathRecord({ kind: "max", function: { kind: "max" }, operands: { picks: [], patterns } });

  it("commits a pattern typed into the /…/ popover", async () => {
    renderEditor(setRecord());
    fireEvent.click(screen.getByRole("button", { name: "patterns for Signals" }));
    const input = await screen.findByPlaceholderText(/regex/i);
    fireEvent.change(input, { target: { value: "Cell\\d+" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(lastWrite()).toBeDefined());
    expect(writtenDefinition().operands.patterns).toEqual(["Cell\\d+"]);
  });

  it("shows a stored pattern's live matches under the picks", () => {
    renderEditor(setRecord(["Cell\\d+"]));
    expect(section("Signals")).toHaveTextContent("Cell01");
    expect(section("Signals")).toHaveTextContent("Cell02");
    expect(section("Signals")).toHaveTextContent("2 signals");
  });

  it("says so when the regex does not compile", () => {
    renderEditor(setRecord(["Cell("]));
    expect(section("Signals")).toHaveTextContent("bad regex");
  });

  it("offers no pattern editor where a pattern is not allowed", () => {
    renderEditor(
      mathRecord({ kind: "difference", arity: "pair", function: { kind: "difference" } }),
    );
    expect(screen.queryByRole("button", { name: /patterns for/ })).not.toBeInTheDocument();
  });
});

describe("parameters", () => {
  const dutyRecord = () =>
    mathRecord({
      kind: "duty",
      arity: "one",
      function: { kind: "duty", threshold: 0.5, window_seconds: 5 },
    });

  it("shows each function's own fields and commits one on blur", async () => {
    renderEditor(dutyRecord());
    expect(screen.getByLabelText("Threshold")).toHaveValue("0.5");
    const window = screen.getByLabelText("Window (s)");
    fireEvent.change(window, { target: { value: "10" } });
    // Nothing is written until the field is left.
    expect(lastWrite()).toBeUndefined();
    fireEvent.blur(window);
    await waitFor(() => expect(lastWrite()).toBeDefined());
    expect(writtenDefinition().function).toEqual({
      kind: "duty",
      threshold: 0.5,
      window_seconds: 10,
    });
  });

  it("abandons a field's edit on Escape", () => {
    renderEditor(dutyRecord());
    const window = screen.getByLabelText("Window (s)");
    fireEvent.change(window, { target: { value: "10" } });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.blur(window);
    expect(lastWrite()).toBeUndefined();
    expect(window).toHaveValue("5");
  });

  it("shows a statistic's percentile only when the statistic is one", async () => {
    renderEditor(
      mathRecord({
        kind: "statistic",
        arity: "one",
        function: { kind: "statistic", statistic: "mean", percentile: 95 },
      }),
    );
    // Hidden, not disabled: a field that cannot apply is not part of
    // the form the user is filling.
    expect(screen.queryByLabelText("Percentile")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "Statistic" }));
    fireEvent.click(screen.getByRole("option", { name: "percentile" }));
    await waitFor(() => expect(lastWrite()).toBeDefined());
    expect(writtenDefinition().function).toEqual({
      kind: "statistic",
      statistic: "percentile",
      percentile: 95,
    });
  });
});

describe("naming and units", () => {
  it("commits the name on blur", async () => {
    renderEditor(mathRecord({ kind: "sum", function: { kind: "sum" } }));
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "PackSum" } });
    fireEvent.blur(name);
    await waitFor(() => expect(lastWrite()).toBeDefined());
    expect(writtenDefinition().name).toBe("PackSum");
  });

  it("commits a unit, and a cleared one derives again", async () => {
    renderEditor(mathRecord({ unit: "mV" }));
    const unit = screen.getByLabelText("Units");
    expect(unit).toHaveValue("mV");
    fireEvent.change(unit, { target: { value: "" } });
    fireEvent.blur(unit);
    await waitFor(() => expect(lastWrite()).toBeDefined());
    expect(writtenDefinition().unit).toBeNull();
  });

  it("shows the host's derived unit as the placeholder", () => {
    renderEditor(mathRecord({ unitResolved: "V" }));
    expect(screen.getByLabelText("Units")).toHaveAttribute(
      "placeholder",
      "V (from the operands)",
    );
  });
});

describe("what the host says", () => {
  it("records the previous definition as the edit's inverse", async () => {
    const before = mathRecord({
      kind: "sum",
      function: { kind: "sum" },
      operands: { picks: [dbcRef("Cell01")], patterns: [] },
    });
    renderEditor(before);
    fireEvent.drop(section("Signals"), {
      dataTransfer: fakeDataTransfer(signalPayload("Cell02")),
    });
    await waitFor(() => expect(steps).toHaveLength(1));
    // Undo puts the definition back exactly as it stood.
    expect(steps[0].undo).toEqual([
      {
        kind: "mathUpdate",
        definition: {
          id: "m1",
          name: "CellMedian",
          unit: null,
          function: { kind: "sum" },
          operands: { picks: [dbcRef("Cell01")], patterns: [] },
        },
        busNames: [["bus-a", "CAN1"]],
      },
    ]);
    expect(
      (steps[0].redo[0] as { definition: { operands: { picks: unknown[] } } }).definition
        .operands.picks,
    ).toHaveLength(2);
  });

  it("carries the bus names on every write", async () => {
    renderEditor(mathRecord({ kind: "sum", function: { kind: "sum" } }));
    fireEvent.drop(section("Signals"), {
      dataTransfer: fakeDataTransfer(signalPayload("Cell01")),
    });
    // A pattern is anchored on the bus *name*, which the host has no
    // other record of.
    await waitFor(() => expect(lastWrite()?.args.busNames).toEqual([["bus-a", "CAN1"]]));
  });

  it("shows a refusal in the host's own words", async () => {
    hostRefusal = "that would make a cycle: m1 → m2 → m1";
    renderEditor(mathRecord({ kind: "sum", function: { kind: "sum" } }));
    fireEvent.drop(section("Signals"), {
      dataTransfer: fakeDataTransfer(signalPayload("Cell01")),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "that would make a cycle: m1 → m2 → m1",
    );
  });

  it("shows why an unfinished definition is not usable yet", () => {
    renderEditor(
      mathRecord({ invalid: "name it — names aren't derived from selections" }),
    );
    // The host's verdict, not a re-derived one.
    expect(screen.getByRole("status")).toHaveTextContent(
      "name it — names aren't derived from selections",
    );
  });

  it("says when an operand is gone rather than rendering a blank", () => {
    renderEditor(
      mathRecord({
        kind: "rms",
        arity: "one",
        function: { kind: "rms" },
        operands: {
          picks: [{ busId: "bus-x", messageId: 9, extended: false, signalName: "Gone" }],
          patterns: [],
        },
      }),
    );
    // A deleted operand keeps its reference by design; the editor says
    // so, and the user can repair it.
    expect(section("Signal")).toHaveTextContent("operand missing");
  });
});

describe("the editor's shape", () => {
  it("has no Save, Cancel or Remove — every field commits as it is left", () => {
    renderEditor(mathRecord({ kind: "sum", function: { kind: "sum" } }));
    const editor = document.querySelector(".math-editor") as HTMLElement;
    for (const label of ["Save", "Cancel", "Add", "Remove"]) {
      expect(within(editor).queryByRole("button", { name: label })).toBeNull();
    }
  });
});
