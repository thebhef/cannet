// @vitest-environment jsdom
//
// The RBS panel on the shared gridview (ADR 0044). The tree is a
// headless single-column instance: buses and ECUs are branches, a
// message row is a leaf whose signals are **rows of the space** — each
// with its own id, a place in the order, and a share of the cursor and
// the selection. Search runs through the layer's filter slot, which
// replaced the panel's own fzf copy.
//
// `RbsPanel.dom.test.tsx` remains the panel's contract net (the host
// commands, the value cells, the menus); this file covers only what the
// migration added.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { RbsMessageView, RbsView } from "./types";

let VIEW: RbsView | null = null;
const calls: Array<{ cmd: string; args: unknown }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    if (cmd === "rbs_view") return VIEW;
    if (cmd === "list_value_tables") return [];
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

import { RbsPanel } from "./RbsPanel";
import { PanelEditRecorderContext } from "./panelEditRecorder";
import type { PanelEditStep } from "./panelEditHistory";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
} from "./projectElements";
import type { ProjectElement } from "./types";
import type { TraceState } from "./trace";

const projectCtx = {
  buses: [{ id: "p1", name: "Powertrain" }],
  connectedBusIds: ["p1"],
} as unknown as ProjectContextValue;

function message(key: string, name: string, signal: string): RbsMessageView {
  return {
    key,
    messageId: Number(key),
    extended: false,
    name,
    inFile: true,
    enabled: true,
    running: false,
    status: "stopped",
    statusDetail: "the element's Run is off",
    periodMs: 100,
    periodOverridden: false,
    isFd: false,
    expectedLen: 8,
    data: [0, 0, 0, 0, 0, 0, 0, 0],
    counter: null,
    counterOverridden: false,
    crc: null,
    crcOverridden: false,
    transmitterMismatch: null,
    signals: [
      {
        name: signal,
        unit: "",
        value: 0,
        label: null,
        overridden: false,
        overrideText: null,
        calcRole: null,
        factor: 1,
        offset: 0,
        min: 0,
        max: 255,
        size: 8,
        signed: false,
        floatKind: "integer",
        hasValueTable: false,
      },
    ],
  };
}

/// Two ECUs under one bus, so a filter has something to prune and the
/// cursor has a tree to walk.
function treeView(): RbsView {
  return {
    elementId: "el",
    path: "/tmp/sim.cannet_rbs",
    fillBit: 0,
    dirty: false,
    changedOnDisk: false,
    run: false,
    buses: [
      {
        key: "Powertrain",
        busId: "p1",
        connected: true,
        enabled: true,
        ecus: [
          {
            name: "BMS",
            enabled: true,
            messages: [message("0x100", "PackStatus", "PackVoltage")],
          },
          {
            name: "Inverter",
            enabled: true,
            messages: [message("0x200", "TorqueRequest", "TorqueNm")],
          },
        ],
      },
    ],
  };
}

function renderPanel() {
  const fakeTrace = {} as TraceState;
  let element: ProjectElement = { kind: "rbs", id: "el", path: "/tmp/sim.cannet_rbs" };
  const registry = {
    get entries() {
      return [{ element, trace: fakeTrace }] as RegistryEntry[];
    },
    get: () => ({ element, trace: fakeTrace }) as RegistryEntry,
    create: () => "el",
    ensure: () => {},
    updateTrace: () => {},
    update: (_id: string, patch: Partial<ProjectElement>) => {
      element = { ...element, ...patch } as ProjectElement;
    },
    remove: () => {},
  } as unknown as ElementRegistry;
  const props = {
    params: { elementId: "el" },
    api: { updateParameters: vi.fn() },
  } as unknown as Parameters<typeof RbsPanel>[0];
  const recorded: PanelEditStep[] = [];
  render(
    <ProjectContext.Provider value={projectCtx}>
      <ElementRegistryContext.Provider value={registry}>
        <PanelEditRecorderContext.Provider value={(step) => recorded.push(step)}>
          <RbsPanel {...props} />
        </PanelEditRecorderContext.Provider>
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
  return { recorded };
}

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest("[role=treeitem]");
  if (!row) throw new Error(`no row for ${text}`);
  return row as HTMLElement;
}

beforeEach(() => {
  VIEW = treeView();
  calls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RbsPanel on the gridview", () => {
  it("walks the tree with the arrow keys and carries the selection to message rows only", async () => {
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    // Row space: Powertrain → BMS → 0x100 → Inverter → 0x200.
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("Powertrain")).toHaveAttribute("data-active");
    // A bus is structure — it can hold the cursor but not the selection.
    expect(rowOf("Powertrain")).not.toHaveAttribute("aria-selected");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("PackStatus")).toHaveAttribute("data-active");
    expect(rowOf("PackStatus")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tree, { key: "End" });
    expect(rowOf("TorqueRequest")).toHaveAttribute("data-active");
  });

  it("Left collapses a branch and removes its subtree; Right opens it again", async () => {
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" }); // onto the bus
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.queryByText("BMS")).not.toBeInTheDocument();
    expect(screen.queryByText("PackStatus")).not.toBeInTheDocument();
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByText("BMS")).toBeInTheDocument();
  });

  it("Right on a message row discloses its signals as rows the cursor reaches", async () => {
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    const rowsBefore = document.querySelectorAll("[role=treeitem]").length;
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("PackStatus")).toHaveAttribute("data-active");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    // The signals appear, and each is a row of the space (ADR 0044).
    expect(screen.getByLabelText("PackVoltage value")).toBeInTheDocument();
    expect(document.querySelectorAll("[role=treeitem]").length).toBe(rowsBefore + 1);
    // Right again steps onto the first of them; Left walks back out to
    // the message that disclosed it.
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(rowOf("PackVoltage")).toHaveAttribute("data-active");
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(rowOf("PackStatus")).toHaveAttribute("data-active");
    // Down from the message walks into the signal, not past it.
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("PackVoltage")).toHaveAttribute("data-active");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("Inverter")).toHaveAttribute("data-active");

    fireEvent.keyDown(tree, { key: "Home" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.queryByLabelText("PackVoltage value")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[role=treeitem]").length).toBe(rowsBefore);
  });

  it("Tab from a signal row lands in that signal's own cell", async () => {
    // The cursor reaching a signal row is only half of it: Tab has to
    // go into *that* row's controls, not the message's (ADR 0044).
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    tree.focus();
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("PackVoltage")).toHaveAttribute("data-active");
    fireEvent.keyDown(tree, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByLabelText("PackVoltage value"));
  });

  it("Space and Enter on a signal row land in its value cell — neither sends part of a message", async () => {
    // A signal row's primary action is its value (owner ruling
    // 2026-08-28, superseding "Space on a signal row is inert"): the
    // press makes the same landing Tab makes, so the edit or the enum
    // combobox is one keystroke away. It still toggles nothing — not
    // the message's enable either.
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    tree.focus();
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("PackVoltage")).toHaveAttribute("data-active");
    fireEvent.keyDown(tree, { key: " " });
    expect(document.activeElement).toBe(screen.getByLabelText("PackVoltage value"));
    expect(calls.filter((c) => c.cmd === "rbs_set_enabled")).toEqual([]);

    tree.focus();
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(document.activeElement).toBe(screen.getByLabelText("PackVoltage value"));
    expect(calls.filter((c) => c.cmd === "rbs_set_enabled")).toEqual([]);
  });

  it("Enter toggles a message row exactly as Space does", async () => {
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("PackStatus")).toHaveAttribute("data-active");
    fireEvent.keyDown(tree, { key: "Enter" });
    const toggles = calls.filter((c) => c.cmd === "rbs_set_enabled");
    expect(toggles).toHaveLength(1);
    expect(toggles[0].args).toMatchObject({ message: "0x100", enabled: false });
  });

  it("Shift+Tab from a signal's cell hands the keyboard back to the tree, like Escape", async () => {
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    tree.focus();
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "Tab" });
    const cell = screen.getByLabelText("PackVoltage value");
    expect(document.activeElement).toBe(cell);
    fireEvent.keyDown(cell, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(tree);
    // The cursor is where it was, so navigation resumes straight away.
    expect(rowOf("PackVoltage")).toHaveAttribute("data-active");
  });

  // task 129: every edit the panel makes records an undo step whose
  // inverse was read from the tree before the write.
  it("records an enable toggle with its inverse (task 129)", async () => {
    const { recorded } = renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: " " });
    expect(recorded).toEqual([
      {
        undo: [
          { kind: "rbsEnable", elementId: "el", bus: "Powertrain", ecu: "BMS", message: "0x100", enabled: true },
        ],
        redo: [
          { kind: "rbsEnable", elementId: "el", bus: "Powertrain", ecu: "BMS", message: "0x100", enabled: false },
        ],
      },
    ]);
  });

  it("records a value override whose inverse is the clear, and a clear on nothing not at all", async () => {
    const { recorded } = renderPanel();
    await screen.findByText("PackStatus");
    fireEvent.click(screen.getByLabelText("toggle 0x100"));
    const cell = (await screen.findByLabelText("PackVoltage value")) as HTMLInputElement;
    fireEvent.change(cell, { target: { value: "42" } });
    fireEvent.blur(cell); // ValidatedInput commits when the edit ends
    expect(recorded).toEqual([
      {
        undo: [
          {
            kind: "rbsSignal",
            elementId: "el",
            target: { bus: "Powertrain", ecu: "BMS", message: "0x100" },
            signal: "PackVoltage",
            value: null,
          },
        ],
        redo: [
          {
            kind: "rbsSignal",
            elementId: "el",
            target: { bus: "Powertrain", ecu: "BMS", message: "0x100" },
            signal: "PackVoltage",
            value: 42,
          },
        ],
      },
    ]);
  });

  it("clicking inside a disclosed signal table leaves the message open", async () => {
    // The defect the trace views had: the toggle must be the message's
    // own line, never the footprint of what it disclosed. Here the
    // table is a sibling of the row rather than a child of it, so the
    // click has nothing to bubble into — this pins that.
    renderPanel();
    await screen.findByText("PackStatus");
    fireEvent.click(screen.getByLabelText("toggle 0x100"));
    const name = await screen.findByText("PackVoltage");
    expect(rowOf("PackStatus")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(name);
    expect(rowOf("PackStatus")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("PackVoltage value")).toBeInTheDocument();
  });

  it("a value input inside a row keeps its own keys", async () => {
    // ADR 0044's editable-target exemption: without it the grid's
    // navigation keys would swallow the caret movement inside the cell.
    renderPanel();
    await screen.findByText("PackStatus");
    fireEvent.click(screen.getByLabelText("toggle 0x100"));
    const input = await screen.findByLabelText("PackVoltage value");
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" }); // cursor onto the bus
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // The press inside the field did not move the grid's cursor.
    expect(rowOf("Powertrain")).toHaveAttribute("data-active");
  });

  it("Tab from the tree enters the cursor row's own controls", async () => {
    // ADR 0044's Tab rule, end to end and keyboard-only: with the tree
    // focused and the cursor on a message, Tab has to land inside that
    // row — not on the first tab stop of the whole tree.
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    tree.focus();
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("PackStatus")).toHaveAttribute("data-active");
    fireEvent.keyDown(tree, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByLabelText("0x100 enabled"));
    // Shift+Tab from the container is the mirror: the row's last control.
    tree.focus();
    fireEvent.keyDown(tree, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText("0x100 period"));
  });

  it("hands the keyboard back to the tree when a value cell ends its edit", async () => {
    // The value cells blur themselves on Enter and Escape. Left alone
    // that drops focus on `<body>`, so the next Tab restarts from the
    // top of the document and the arrows are dead.
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    tree.focus();
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" }); // disclose the signals
    const input = await screen.findByLabelText("PackVoltage value");
    input.focus();
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).toBe(tree);
    // …and the cursor is still where it was, so the arrows work again —
    // onto the first of the signal rows the message disclosed.
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("PackVoltage")).toHaveAttribute("data-active");
  });

  it("takes the keyboard when a row is clicked, and leaves it to a control", async () => {
    // Without this the tree never holds focus in a mouse-then-keyboard
    // session: focus stays on `<body>`, where the arrows and Tab are
    // dead until the user happens to click the container's border.
    renderPanel();
    await screen.findByText("PackStatus");
    fireEvent.click(rowOf("PackStatus"));
    expect(document.activeElement).toBe(screen.getByRole("tree"));
    const period = screen.getByLabelText("0x100 period") as HTMLElement;
    period.focus();
    fireEvent.click(period);
    expect(document.activeElement).toBe(period);
  });

  it("filters through the shared slot: matches keep their bus and ECU, the rest go", async () => {
    vi.useFakeTimers();
    renderPanel();
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("filter"), {
      target: { value: "TorqueRequest" },
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("TorqueRequest")).toBeInTheDocument();
    expect(screen.getByText("Inverter")).toBeInTheDocument();
    expect(screen.getByText("Powertrain")).toBeInTheDocument();
    // The non-matching ECU is removed entirely, not dimmed.
    expect(screen.queryByText("BMS")).not.toBeInTheDocument();
    expect(screen.queryByText("PackStatus")).not.toBeInTheDocument();
  });

  it("a match's ancestors read as expanded even when the user closed them", async () => {
    vi.useFakeTimers();
    renderPanel();
    await act(async () => {});
    // Close the bus by hand.
    fireEvent.click(screen.getByLabelText("toggle Powertrain"));
    expect(screen.queryByText("Inverter")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("filter"), {
      target: { value: "TorqueRequest" },
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("TorqueRequest")).toBeInTheDocument();
  });

  // Space is the layer's primary action on the cursor's row (ADR 0044).
  // The RBS tree shipped on the gridview without binding it, so the
  // press fell through to the scroll container and scrolled — these are
  // the tests that would have caught it.
  it("Space activates and deactivates the cursor row at whichever level it is", async () => {
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    const enables = () => calls.filter((c) => c.cmd === "rbs_set_enabled").map((c) => c.args);

    fireEvent.keyDown(tree, { key: "ArrowDown" }); // the bus
    fireEvent.keyDown(tree, { key: " " });
    fireEvent.keyDown(tree, { key: "ArrowDown" }); // the ECU
    fireEvent.keyDown(tree, { key: " " });
    fireEvent.keyDown(tree, { key: "ArrowDown" }); // the message
    fireEvent.keyDown(tree, { key: " " });

    expect(enables()).toEqual([
      { elementId: "el", bus: "Powertrain", ecu: null, message: null, enabled: false },
      { elementId: "el", bus: "Powertrain", ecu: "BMS", message: null, enabled: false },
      { elementId: "el", bus: "Powertrain", ecu: "BMS", message: "0x100", enabled: false },
    ]);
  });

  it("Space turns a disabled message back on", async () => {
    VIEW = treeView();
    VIEW.buses[0].ecus[0].messages[0].enabled = false;
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: " " });
    expect(calls.filter((c) => c.cmd === "rbs_set_enabled").map((c) => c.args)).toEqual([
      { elementId: "el", bus: "Powertrain", ecu: "BMS", message: "0x100", enabled: true },
    ]);
  });

  it("Space does nothing on a row whose checkbox the mouse cannot press either", async () => {
    VIEW = treeView();
    VIEW.buses[0].ecus[0].messages[0].name = null;
    renderPanel();
    await screen.findByText("0x100");
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: " " });
    expect(calls.filter((c) => c.cmd === "rbs_set_enabled")).toEqual([]);
  });

  it("leaves Space to a focused enable checkbox, which activates on it itself", async () => {
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    const box = screen.getByLabelText("0x100 enabled") as HTMLElement;
    box.focus();
    fireEvent.keyDown(box, { key: " " });
    // The browser toggles the checkbox; the grid must not also fire, or
    // the press lands twice and cancels itself out.
    expect(calls.filter((c) => c.cmd === "rbs_set_enabled")).toEqual([]);
  });

  it("marks its tree as a gridview so the global dispatcher stays off its keys", async () => {
    renderPanel();
    await screen.findByText("PackStatus");
    expect(screen.getByRole("tree")).toHaveAttribute("data-gridview");
  });
});
