// @vitest-environment jsdom
//
// The RBS signals grid as grid rows (ADR 0044). The panel already
// instantiated the layer, but its rows showed nothing of it: no cursor
// on screen, no way for a click to hand the keyboard back, and Space
// unbound. This file covers only that interaction half —
// `RbsSignalsPanel.dom.test.tsx` remains the panel's contract net for
// the host commands, the filters and the value cells.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { RbsSignalRow } from "./types";

let ROWS: RbsSignalRow[] | null = [];
const calls: Array<{ cmd: string; args: unknown }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    if (cmd === "rbs_signal_rows") return ROWS;
    if (cmd === "list_value_tables") return [];
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { RbsSignalsPanel } from "./RbsSignalsPanel";

function row(over: Partial<RbsSignalRow> = {}): RbsSignalRow {
  return {
    id: "Powertrain|0x100|EngineSpeed",
    busKey: "Powertrain",
    busId: "p1",
    ecuName: "BMS",
    messageKey: "0x100",
    messageName: "EngineData",
    messageId: 0x100,
    extended: false,
    signalName: "EngineSpeed",
    unit: "rpm",
    status: "default",
    value: 800,
    label: null,
    overridden: false,
    overrideText: null,
    calcRole: null,
    factor: 1,
    offset: 0,
    min: 0,
    max: 8000,
    size: 16,
    signed: false,
    hasValueTable: false,
    detail: "DBC start value",
    ...over,
  };
}

function renderPanel() {
  const api = { updateParameters: vi.fn() };
  const props = { params: { elementId: "el1" }, api } as unknown as Parameters<
    typeof RbsSignalsPanel
  >[0];
  return render(<RbsSignalsPanel {...props} />);
}

/// The gridview container: the one element in a gridview that holds
/// focus, and where every key press is aimed.
function rowsContainer(): HTMLElement {
  const el = document.querySelector(".rbs-signals-rows");
  if (!el) throw new Error("no rows container");
  return el as HTMLElement;
}

function rowOf(signal: string): HTMLElement {
  const el = screen.getByText(signal).closest(".rbs-signals-row");
  if (!el) throw new Error(`no row for ${signal}`);
  return el as HTMLElement;
}

const TWO_ROWS = [
  row(),
  row({
    id: "Powertrain|0x100|Gear",
    signalName: "Gear",
    unit: "",
    value: 2,
    detail: "DBC start value",
  }),
];

beforeEach(() => {
  calls.length = 0;
  ROWS = TWO_ROWS;
});
afterEach(cleanup);

describe("RbsSignalsPanel on the gridview", () => {
  it("shows where the cursor is, and moves it with the arrow keys", async () => {
    renderPanel();
    await screen.findByText("EngineSpeed");
    const rows = rowsContainer();
    // Rows sort by (bus, message, signal): EngineSpeed then Gear.
    fireEvent.keyDown(rows, { key: "ArrowDown" });
    expect(rowOf("EngineSpeed")).toHaveAttribute("data-active");
    expect(rowOf("Gear")).not.toHaveAttribute("data-active");
    fireEvent.keyDown(rows, { key: "ArrowDown" });
    expect(rowOf("Gear")).toHaveAttribute("data-active");
    expect(rowOf("EngineSpeed")).not.toHaveAttribute("data-active");
    // The container names it rather than focusing it — rows are not
    // focus targets in a gridview.
    expect(rows).toHaveAttribute("aria-activedescendant", rowOf("Gear").id);
  });

  it("takes the keyboard when a row is clicked, and leaves it to a control", async () => {
    // Without this a mouse-then-keyboard session leaves focus on
    // `<body>`, where the arrows are dead — which is what made these
    // rows awkward next to every other grid.
    renderPanel();
    await screen.findByText("EngineSpeed");
    fireEvent.click(rowOf("EngineSpeed"));
    expect(document.activeElement).toBe(rowsContainer());
    expect(rowOf("EngineSpeed")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(rowsContainer(), { key: "ArrowDown" });
    expect(rowOf("Gear")).toHaveAttribute("data-active");
  });

  it("Space deactivates the message the cursor's field belongs to", async () => {
    renderPanel();
    await screen.findByText("EngineSpeed");
    const rows = rowsContainer();
    fireEvent.keyDown(rows, { key: "ArrowDown" });
    fireEvent.keyDown(rows, { key: " " });
    expect(calls.filter((c) => c.cmd === "rbs_set_enabled").map((c) => c.args)).toEqual([
      { elementId: "el1", bus: "Powertrain", ecu: "BMS", message: "0x100", enabled: false },
    ]);
  });

  it("Space on a muted field activates its message again", async () => {
    ROWS = [row({ status: "muted", detail: "muted — not transmitted" })];
    renderPanel();
    await screen.findByText("EngineSpeed");
    const rows = rowsContainer();
    fireEvent.keyDown(rows, { key: "ArrowDown" });
    fireEvent.keyDown(rows, { key: " " });
    expect(calls.filter((c) => c.cmd === "rbs_set_enabled").map((c) => c.args)).toEqual([
      { elementId: "el1", bus: "Powertrain", ecu: "BMS", message: "0x100", enabled: true },
    ]);
  });

  it("leaves Space to the value editor when the cursor row is being edited", async () => {
    renderPanel();
    await screen.findByText("EngineSpeed");
    const rows = rowsContainer();
    fireEvent.keyDown(rows, { key: "ArrowDown" });
    const input = rowOf("EngineSpeed").querySelector("input") as HTMLElement;
    input.focus();
    fireEvent.keyDown(input, { key: " " });
    expect(calls.filter((c) => c.cmd === "rbs_set_enabled")).toEqual([]);
  });
});
