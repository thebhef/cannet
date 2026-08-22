// @vitest-environment jsdom
//
// The by-ID view on the gridview base (ADR 0044). Its rows are
// leaf-with-content: expanding one grows the row in place and adds no
// rows, so Right / Left disclose and retract the decoded block rather
// than walking a tree. The cursor, the D3 key table, the D4 mouse-built
// selection and the D9 row-drags-the-message rule all bind to the row
// space of stable `byIdRowKey`s.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

let storedSettings: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...storedSettings } : null)),
}));

import { hydrateSettings } from "./hostSettings";
import { ByIdTable, byIdRowKey } from "./ByIdTable";
import { defaultColumns } from "./traceColumns";
import { SIGNAL_DND_MIME } from "./dragSignals";
import { toggleInSet } from "./toggleSet";
import type { ByIdSnapshotRecord, TraceFrameRecord } from "./types";

function makeFrame(id: number, name: string, signals: string[]): TraceFrameRecord {
  return {
    index: 0,
    timestamp_seconds: 0,
    channel: 0,
    id,
    extended: false,
    direction: "Rx",
    kind: { kind: "classic" },
    data: [2],
    decoded:
      signals.length === 0
        ? null
        : {
            name,
            signals: signals.map((s, i) => ({ name: s, value: i, unit: "km/h", label: null })),
          },
    bus_id: "b1",
  } as unknown as TraceFrameRecord;
}

const ROWS: ByIdSnapshotRecord[] = [
  { frame: makeFrame(0x100, "GearBox", ["Gear", "Ratio"]), rate: 0, count: 1 },
  { frame: makeFrame(0x101, "PackState", ["Soc"]), rate: 0, count: 1 },
  { frame: makeFrame(0x102, "Raw", []), rate: 0, count: 1 },
];
const gearBox = byIdRowKey(ROWS[0].frame);
const packState = byIdRowKey(ROWS[1].frame);
const raw = byIdRowKey(ROWS[2].frame);

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Minimal stand-in for the DataTransfer the drag events carry. */
function fakeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
    get types() {
      return Object.keys(store);
    },
    effectAllowed: "",
    dropEffect: "",
  };
}

/// The table with its own fold state, the way `TracePanel` owns it.
function Harness({ initial = [] as string[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(initial));
  return (
    <ByIdTable
      count={ROWS.length}
      version={0}
      getRow={(i) => ROWS[i] ?? null}
      ensureVisible={() => {}}
      columns={defaultColumns()}
      onColumnResize={() => {}}
      onColumnToggle={() => {}}
      onColumnReorder={() => {}}
      resolveColor={null}
      sort={null}
      onSortColumn={() => {}}
      baseTimestamp={0}
      busLookup={new Map([["b1", "Chassis"]])}
      expanded={expanded}
      onToggleExpand={(rowKey) => setExpanded((prev) => toggleInSet(prev, rowKey))}
    />
  );
}

function grid(): HTMLElement {
  const el = document.querySelector(".trace-rows");
  if (!el) throw new Error("no rows container");
  return el as HTMLElement;
}

/// The row `aria-activedescendant` names, resolved through the DOM id
/// the row actually carries.
function activeRow(): HTMLElement | null {
  const id = grid().getAttribute("aria-activedescendant");
  return id == null ? null : document.getElementById(id);
}

const msgOf = (el: HTMLElement | null) => el?.querySelector(".col-msg")?.textContent ?? null;

/// The signal a disclosed row shows.
const nameOf = (el: HTMLElement | null) => el?.querySelector(".signal-name")?.textContent ?? null;

/// The rows the open messages disclosed, in display order.
const contentNames = (): (string | null)[] =>
  [...document.querySelectorAll<HTMLElement>(".trace-content-row")].map(nameOf);

function rowFor(name: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>(".trace-row")].find(
    (r) => r.querySelector(".col-msg")?.textContent === name,
  );
  if (!el) throw new Error(`no row for ${name}`);
  return el;
}

function selectedMessages(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.trace-row[aria-selected="true"]')].map(
    (el) => el.querySelector(".col-msg")?.textContent ?? "",
  );
}

let restoreHeight: (() => void) | null = null;

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  // jsdom does no layout, so the viewport would report zero rows and the
  // window would render two of the three.
  const prev = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 440 });
  restoreHeight = () => Object.defineProperty(Element.prototype, "clientHeight", prev!);
  storedSettings = {};
  await hydrateSettings();
});
afterEach(() => {
  cleanup();
  restoreHeight?.();
  vi.unstubAllGlobals();
});

describe("by-id cursor", () => {
  it("marks the rows viewport as a gridview and names the active row there", () => {
    render(<Harness />);
    expect(grid()).toHaveAttribute("data-gridview");
    expect(grid()).toHaveAttribute("tabindex", "0");
    expect(activeRow()).toBeNull();
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(msgOf(activeRow())).toBe("GearBox");
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(msgOf(activeRow())).toBe("PackState");
    fireEvent.keyDown(grid(), { key: "End" });
    expect(activeRow()).toBe(rowFor(""));
    fireEvent.keyDown(grid(), { key: "Home" });
    expect(msgOf(activeRow())).toBe("GearBox");
  });

  it("discloses the row's content with Right and retracts it with Left", () => {
    // Leaf-with-content: what it discloses are rows of the space
    // (ADR 0044), so Right steps into them.
    render(<Harness />);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(rowFor("GearBox")).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    expect(rowFor("GearBox")).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll(".trace-row")).toHaveLength(ROWS.length);
    expect(contentNames()).toEqual(["Gear", "Ratio"]);
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    expect(nameOf(activeRow())).toBe("Gear");
    // Left walks back out to the row that disclosed it, and again
    // retracts it.
    fireEvent.keyDown(grid(), { key: "ArrowLeft" });
    expect(msgOf(activeRow())).toBe("GearBox");
    fireEvent.keyDown(grid(), { key: "ArrowLeft" });
    expect(rowFor("GearBox")).toHaveAttribute("aria-expanded", "false");
    // …and Left on a closed top-level row has no parent to walk out to.
    fireEvent.keyDown(grid(), { key: "ArrowLeft" });
    expect(msgOf(activeRow())).toBe("GearBox");
  });

  it("selects a disclosed signal rather than collapsing the message", () => {
    render(<Harness initial={[gearBox]} />);
    const line = document.querySelectorAll<HTMLElement>(".trace-content-row")[1];
    fireEvent.click(line);
    expect(rowFor("GearBox")).toHaveAttribute("aria-expanded", "true");
    expect(line).toHaveAttribute("aria-selected", "true");
    expect(selectedMessages()).toEqual([]);
    expect(activeRow()).toBe(line);
  });

  it("still collapses the message when the message line is clicked", () => {
    render(<Harness initial={[gearBox]} />);
    fireEvent.click(rowFor("GearBox").querySelector(".col-id")!);
    expect(rowFor("GearBox")).toHaveAttribute("aria-expanded", "false");
    expect(contentNames()).toEqual([]);
  });

  it("leaves a row with nothing to disclose alone", () => {
    render(<Harness />);
    fireEvent.keyDown(grid(), { key: "End" }); // the undecoded row
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    expect(rowFor("")).not.toHaveAttribute("aria-expanded");
    expect(document.querySelectorAll(".trace-row.expanded")).toHaveLength(0);
  });
});

describe("by-id selection", () => {
  it("replaces on a plain click and follows the cursor", () => {
    render(<Harness />);
    fireEvent.click(rowFor("PackState"));
    expect(selectedMessages()).toEqual(["PackState"]);
    fireEvent.keyDown(grid(), { key: "Home" });
    expect(selectedMessages()).toEqual(["GearBox"]);
  });

  it("toggles with Ctrl+click, builds a range with Ctrl+Shift+click, and takes all on Ctrl+A", () => {
    render(<Harness />);
    fireEvent.click(rowFor("GearBox"));
    fireEvent.click(rowFor("PackState"), { ctrlKey: true });
    expect(selectedMessages()).toEqual(["GearBox", "PackState"]);
    fireEvent.click(rowFor("PackState"), { ctrlKey: true });
    expect(selectedMessages()).toEqual(["GearBox"]);
    fireEvent.click(rowFor(""), { ctrlKey: true, shiftKey: true });
    expect(selectedMessages()).toHaveLength(3);
    fireEvent.click(rowFor("GearBox"));
    expect(selectedMessages()).toEqual(["GearBox"]);
    fireEvent.keyDown(grid(), { key: "a", ctrlKey: true });
    expect(selectedMessages()).toHaveLength(3);
  });
});

describe("by-id drag identity (D9)", () => {
  it("drags the message from the row itself", () => {
    render(<Harness />);
    const row = rowFor("GearBox");
    expect(row).toHaveAttribute("draggable", "true");
    const dt = fakeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    const payload = JSON.parse(dt.getData(SIGNAL_DND_MIME));
    expect(payload.signals.map((s: { signalName: string }) => s.signalName)).toEqual([
      "Gear",
      "Ratio",
    ]);
    expect(payload.signals[0]).toMatchObject({
      busId: "b1",
      messageId: 0x100,
      extended: false,
      messageName: "GearBox",
      unit: "km/h",
    });
    expect(payload.patterns).toEqual([]);
  });

  it("drags the whole selection when the grabbed row is in it, each signal once", () => {
    render(<Harness />);
    fireEvent.click(rowFor("GearBox"));
    fireEvent.click(rowFor("PackState"), { ctrlKey: true });
    const dt = fakeDataTransfer();
    fireEvent.dragStart(rowFor("PackState"), { dataTransfer: dt });
    const payload = JSON.parse(dt.getData(SIGNAL_DND_MIME));
    expect(payload.signals.map((s: { signalName: string }) => s.signalName)).toEqual([
      "Gear",
      "Ratio",
      "Soc",
    ]);
  });

  it("drags only the grabbed row when it is outside the selection", () => {
    render(<Harness />);
    fireEvent.click(rowFor("GearBox"));
    const dt = fakeDataTransfer();
    fireEvent.dragStart(rowFor("PackState"), { dataTransfer: dt });
    const payload = JSON.parse(dt.getData(SIGNAL_DND_MIME));
    expect(payload.signals.map((s: { signalName: string }) => s.signalName)).toEqual(["Soc"]);
  });

  it("still drags one signal from a line inside the expanded block", () => {
    render(<Harness initial={[gearBox]} />);
    const line = document.querySelectorAll<HTMLElement>(".trace-content-row")[1];
    const dt = fakeDataTransfer();
    fireEvent.dragStart(line, { dataTransfer: dt });
    const payload = JSON.parse(dt.getData(SIGNAL_DND_MIME));
    expect(payload.signals.map((s: { signalName: string }) => s.signalName)).toEqual(["Ratio"]);
  });

  it("carries no payload from a row with nothing decoded", () => {
    render(<Harness />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(rowFor(""), { dataTransfer: dt });
    expect(JSON.parse(dt.getData(SIGNAL_DND_MIME)).signals).toEqual([]);
  });
});

// The keys are the row ids the panel persists — this file only needs
// them to seed a fold, but naming them keeps the fixture honest.
void [packState, raw];
