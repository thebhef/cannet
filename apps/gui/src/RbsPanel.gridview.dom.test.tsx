// @vitest-environment jsdom
//
// The RBS panel on the shared gridview (ADR 0044). The tree is a
// headless single-column instance: buses and ECUs are branches, a
// message row is a leaf whose signal table is disclosed content — an
// editor face rather than a list of rows, so it is a block below the
// row and not rows of the space (ADR 0044). Search runs through the
// layer's filter slot, which replaced the panel's own fzf copy.
//
// `RbsPanel.dom.test.tsx` remains the panel's contract net (the host
// commands, the value cells, the menus); this file covers only what the
// migration added.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { RbsMessageView, RbsView } from "./types";

let VIEW: RbsView | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
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
    killSwitch: false,
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
  let element: ProjectElement = { kind: "rbs", id: "el", path: "/tmp/sim.cannet_rbs", run: false };
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
  render(
    <ProjectContext.Provider value={projectCtx}>
      <ElementRegistryContext.Provider value={registry}>
        <RbsPanel {...props} />
      </ElementRegistryContext.Provider>
    </ProjectContext.Provider>,
  );
}

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest("[role=treeitem]");
  if (!row) throw new Error(`no row for ${text}`);
  return row as HTMLElement;
}

beforeEach(() => {
  VIEW = treeView();
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

  it("Right on a message row discloses its signal table in place, adding no rows", async () => {
    renderPanel();
    await screen.findByText("PackStatus");
    const tree = screen.getByRole("tree");
    const rowsBefore = document.querySelectorAll("[role=treeitem]").length;
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("PackStatus")).toHaveAttribute("data-active");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    // The content block appears…
    expect(screen.getByLabelText("PackVoltage value")).toBeInTheDocument();
    // …and the row space is unchanged: this content is an editor face,
    // reached by Tab, so it is a block rather than rows (ADR 0044).
    expect(document.querySelectorAll("[role=treeitem]").length).toBe(rowsBefore);
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.queryByLabelText("PackVoltage value")).not.toBeInTheDocument();
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
    // …and the cursor is still where it was, so the arrows work again.
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowOf("Inverter")).toHaveAttribute("data-active");
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

  it("marks its tree as a gridview so the global dispatcher stays off its keys", async () => {
    renderPanel();
    await screen.findByText("PackStatus");
    expect(screen.getByRole("tree")).toHaveAttribute("data-gridview");
  });
});
