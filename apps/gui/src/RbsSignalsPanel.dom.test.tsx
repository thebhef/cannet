// @vitest-environment jsdom
//
// Component tests for the RBS signals panel: a thin view over
// `rbs_signal_rows`, scoped to one element, editing through the same
// `RbsValueCell` the RBS panel's own tree uses. The Tauri
// bridge is mocked, so this asserts the contract: rows render as the
// host reports them, the toolbar filters narrow what's shown, and an
// edit routes through `rbs_set_signal` with the row's own
// bus/ecu/message target.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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
let eventHandlers: Array<(e: { payload: string }) => void> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (e: { payload: string }) => void) => {
    eventHandlers.push(handler);
    return () => {};
  }),
}));
function emitRbsChanged(payload = "*"): void {
  for (const h of [...eventHandlers]) h({ payload });
}

import { RbsSignalsPanel } from "./RbsSignalsPanel";
import {
  LONG_MESSAGE_NAME,
  LONG_MESSAGE_TAIL,
  LONG_SIGNAL_NAME,
  LONG_SIGNAL_TAIL,
  expectMiddleEllipsis,
} from "./longNameTestKit";

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
    defaultValue: 800,
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

beforeEach(() => {
  calls.length = 0;
  eventHandlers = [];
});
afterEach(() => cleanup());

describe("RbsSignalsPanel", () => {
  it("renders one row per field the host reports, with its status and detail", async () => {
    ROWS = [
      row({ id: "a", signalName: "EngineSpeed", status: "default", detail: "DBC start value" }),
      row({
        id: "b",
        signalName: "PackVoltage",
        status: "unknown-value",
        detail: 'no enum label "Sport"',
      }),
    ];
    renderPanel();
    expect(await screen.findByText("EngineSpeed")).toBeInTheDocument();
    expect(screen.getByText("PackVoltage")).toBeInTheDocument();
    expect(screen.getByText("DBC start value")).toBeInTheDocument();
    expect(screen.getByText('no enum label "Sport"')).toBeInTheDocument();
  });

  it("upgrades an applied override outside the signal's range to Out of Range in the status chip", async () => {
    ROWS = [row({ id: "a", status: "override", overridden: true, value: 9000 })];
    renderPanel();
    await screen.findByText("EngineSpeed");
    expect(await screen.findByText("Out of Range")).toBeInTheDocument();
  });

  it("paints no row background, and names every row's status in the status cell", async () => {
    // Row background belongs to the gridview — cursor and selection are
    // what paint a row (ADR 0044). A panel says per-row state in a
    // *cell*, so the status text is unconditional and there is no
    // toggle for turning it into a wash.
    ROWS = [
      row({ id: "a", signalName: "EngineSpeed", status: "not-encoded" }),
      row({ id: "b", signalName: "PackVoltage", status: "muted" }),
    ];
    renderPanel();
    await screen.findByText("EngineSpeed");
    expect(screen.getByText("Not Encoded")).toBeInTheDocument();
    expect(screen.getByText("Muted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Row Highlights" })).toBeNull();
    for (const el of document.querySelectorAll(".rbs-signals-row")) {
      expect(el.className).not.toMatch(/wash/);
    }
  });

  it("shows the DBC start value in the Default column, and `none` where there is none", async () => {
    ROWS = [
      row({ id: "a", signalName: "EngineSpeed", defaultValue: 812.5 }),
      row({ id: "b", signalName: "PackVoltage", defaultValue: null, detail: "" }),
    ];
    renderPanel();
    await screen.findByText("EngineSpeed");
    expect(screen.getByText("812.5")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("filters to exactly the selected status chip", async () => {
    ROWS = [
      row({ id: "a", signalName: "EngineSpeed", status: "default" }),
      row({ id: "b", signalName: "PackVoltage", status: "muted" }),
    ];
    renderPanel();
    await screen.findByText("EngineSpeed");
    fireEvent.click(screen.getByRole("button", { name: /^Muted/ }));
    expect(screen.queryByText("EngineSpeed")).toBeNull();
    expect(screen.getByText("PackVoltage")).toBeInTheDocument();
  });

  it("filters by bus through the fly-out", async () => {
    ROWS = [
      row({ id: "a", busKey: "Powertrain", signalName: "EngineSpeed" }),
      row({ id: "b", busKey: "Battery", signalName: "PackVoltage" }),
    ];
    renderPanel();
    await screen.findByText("EngineSpeed");
    fireEvent.click(screen.getByRole("button", { name: /^Bus:/ }));
    fireEvent.click(screen.getByLabelText("Battery", { exact: false }));
    expect(screen.queryByText("EngineSpeed")).toBeNull();
    expect(screen.getByText("PackVoltage")).toBeInTheDocument();
  });

  it("commits a clamped numeric edit through rbs_set_signal with the row's own bus/ecu/message target", async () => {
    ROWS = [row({ id: "a", busKey: "Powertrain", ecuName: "BMS", messageKey: "0x100" })];
    renderPanel();
    const input = await screen.findByRole("textbox", { name: "EngineSpeed value" });
    fireEvent.change(input, { target: { value: "9000" } });
    fireEvent.blur(input);
    const call = calls.find((c) => c.cmd === "rbs_set_signal");
    expect(call?.args).toEqual({
      elementId: "el1",
      target: { bus: "Powertrain", ecu: "BMS", message: "0x100" },
      signal: "EngineSpeed",
      value: 8000,
    });
  });

  it("clears an override through rbs_set_signal with a null value", async () => {
    ROWS = [row({ id: "a", overridden: true, overrideText: "500", status: "override" })];
    renderPanel();
    const clearBtn = await screen.findByTitle(/clear override/);
    fireEvent.click(clearBtn);
    const call = calls.find((c) => c.cmd === "rbs_set_signal");
    expect(call?.args).toMatchObject({ signal: "EngineSpeed", value: null });
  });

  it("refetches on rbs-changed for this element or a broadcast, not for another element", async () => {
    ROWS = [row({ id: "a", signalName: "EngineSpeed" })];
    renderPanel();
    await screen.findByText("EngineSpeed");
    const before = calls.filter((c) => c.cmd === "rbs_signal_rows").length;

    ROWS = [row({ id: "a", signalName: "EngineSpeed" }), row({ id: "b", signalName: "OilTemp" })];
    await act(async () => emitRbsChanged("some-other-element"));
    expect(screen.queryByText("OilTemp")).toBeNull();

    await act(async () => emitRbsChanged("el1"));
    expect(await screen.findByText("OilTemp")).toBeInTheDocument();
    const after = calls.filter((c) => c.cmd === "rbs_signal_rows").length;
    expect(after).toBeGreaterThan(before);
  });

  it("the footer shortcut toggles the problem-status filter", async () => {
    ROWS = [
      row({ id: "a", signalName: "EngineSpeed", status: "default" }),
      row({ id: "b", signalName: "PackVoltage", status: "not-encoded" }),
    ];
    renderPanel();
    await screen.findByText("EngineSpeed");
    fireEvent.click(screen.getByText(/need attention/));
    expect(screen.queryByText("EngineSpeed")).toBeNull();
    expect(screen.getByText("PackVoltage")).toBeInTheDocument();
  });
});

describe("RbsSignalsPanel with long names", () => {
  it("splits the signal and message names, and leaves a short one alone", async () => {
    ROWS = [
      row({ id: "a", signalName: LONG_SIGNAL_NAME, messageName: LONG_MESSAGE_NAME }),
      row({ id: "b", signalName: "PackVoltage", messageName: "BmsState" }),
    ];
    const { container } = renderPanel();
    await screen.findByText("PackVoltage");
    const rows = container.querySelectorAll(".trace-row");
    expectMiddleEllipsis(rows[0].querySelector(".col-rs-signal"), LONG_SIGNAL_NAME, LONG_SIGNAL_TAIL);
    expectMiddleEllipsis(rows[0].querySelector(".col-rs-msg"), LONG_MESSAGE_NAME, LONG_MESSAGE_TAIL);
    // The control: a short row keeps its plain text node.
    expect(rows[1].querySelector(".name-text")).toBeNull();
  });
});
