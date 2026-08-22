// @vitest-environment jsdom
//
// Rendering test for the rows an expanded row discloses: one indented
// row per decoded signal (name, value+unit, enum label), stacked at
// `SIGNAL_LINE_HEIGHT` under the message line so the block is
// `expandedRowHeight` tall, each one a drag source carrying the plot
// drag-drop payload. The placement arithmetic is unit-tested in
// traceViewport.test.ts; this guards that the renderer actually draws
// the disclosed rows and wires the drag.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

/// The `id` column's format is the `can_id_format` setting, so this
/// file needs a host to hydrate it from.
let storedSettings: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...storedSettings } : null)),
}));

import { hydrateSettings } from "./hostSettings";
import { TraceView } from "./TraceView";
import { defaultColumns } from "./traceColumns";
import { SIGNAL_DND_MIME } from "./dragSignals";
import { ROW_HEIGHT, SIGNAL_LINE_HEIGHT, expandedRowHeight } from "./traceViewport";
import type { TraceFrameRecord } from "./types";
import {
  LONG_MESSAGE_NAME,
  LONG_MESSAGE_TAIL,
  LONG_SIGNAL_NAME,
  LONG_SIGNAL_TAIL,
  expectMiddleEllipsis,
} from "./longNameTestKit";

const defaultFrame: TraceFrameRecord = {
  index: 0,
  timestamp_seconds: 0,
  channel: 0,
  id: 0x100,
  extended: false,
  direction: "Rx",
  kind: { kind: "classic" },
  data: [2, 54],
  decoded: {
    name: "GearBox",
    signals: [
      { name: "Speed", value: 54.5, unit: "km/h", label: null },
      { name: "Gear", value: 2, unit: "", label: "Drive" },
    ],
  },
  bus_id: "b1",
};

// TraceView virtualizes, so it needs a ResizeObserver.
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

function renderExpandedRow(frame: TraceFrameRecord = defaultFrame) {
  const { container } = render(
    <TraceView
      count={1}
      version={0}
      autoScroll={false}
      baseTimestampSeconds={0}
      columns={defaultColumns()}
      onColumnResize={() => {}}
      onColumnToggle={() => {}}
      onColumnReorder={() => {}}
      resolveColor={null}
      busLookup={new Map([["b1", "Chassis"]])}
      getRow={(i) => (i === 0 ? { row: "frame", frame } : null)}
      ensureVisible={() => {}}
      onAutoScrollDisabled={() => {}}
    />,
  );
  const row = container.querySelector(".trace-row") as HTMLElement;
  fireEvent.click(row); // expand
  return { container, row };
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  storedSettings = {};
  await hydrateSettings();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TraceView id column", () => {
  const idCell = (container: HTMLElement) =>
    container.querySelector(".trace-row .col-id")?.textContent;

  it("spells the arbitration id the way can_id_format says", async () => {
    // Hex is the default, so decimal proves the column read the
    // setting rather than the old hex-only formatter.
    storedSettings = { can_id_format: "decimal" };
    await hydrateSettings();
    const { container } = renderExpandedRow();
    expect(idCell(container)).toBe("s:256");
  });

  it("repaints already-rendered rows when the format changes", async () => {
    // The rows are memoised, so the setting has to reach them as a
    // changed prop — reading it inside the cell renderer would leave
    // the visible window showing the old format.
    const { container } = renderExpandedRow();
    expect(idCell(container)).toBe("s:100");
    storedSettings = { can_id_format: "decimal" };
    await act(async () => {
      await hydrateSettings();
    });
    expect(idCell(container)).toBe("s:256");
  });
});

describe("TraceView disclosed signal rows", () => {
  it("renders one signal line per decoded signal with name, value+unit, and label", () => {
    const { container } = renderExpandedRow();
    const lines = container.querySelectorAll(".trace-content-row");
    expect(lines).toHaveLength(2);
    expect(lines[0].querySelector(".signal-name")).toHaveTextContent("Speed");
    // Value and unit are separate elements, so the unit doesn't read as
    // part of the number (see SignalValueCell.dom.test.tsx).
    expect(lines[0].querySelector(".signal-value-number")).toHaveTextContent("54.5");
    expect(lines[0].querySelector(".signal-value-unit")).toHaveTextContent("km/h");
    expect(lines[1].querySelector(".signal-name")).toHaveTextContent("Gear");
    expect(lines[1].querySelector(".signal-value-number")).toHaveTextContent("2");
    expect(lines[1].querySelector(".signal-value-label")).toHaveTextContent('"Drive"');
  });

  it("reads a raw bit field in base 10, and in hex only where the DBC asks", () => {
    const { container } = renderExpandedRow({
      ...defaultFrame,
      decoded: {
        name: "Ident",
        signals: [
          { name: "Plain", value: 0xdeadbeef, unit: "", raw_field: true, label: null },
          {
            name: "Serial",
            value: 0xdeadbeef,
            unit: "",
            raw_field: true,
            display_hex: true,
            label: null,
          },
        ],
      },
    });
    const lines = container.querySelectorAll(".trace-content-row");
    // Base 10 — and digit-exact, never scientific, however large.
    expect(lines[0].querySelector(".signal-value-number")).toHaveTextContent("3735928559");
    expect(lines[1].querySelector(".signal-value-number")).toHaveTextContent("0xDEADBEEF");
  });

  it("keeps the message line one row tall and stacks the disclosed rows under it", () => {
    const { container, row } = renderExpandedRow();
    // The message line is a row like any other; the block it and its
    // disclosed rows make together is `expandedRowHeight` tall.
    expect(row.style.height).toBe(`${ROW_HEIGHT}px`);
    expect(expandedRowHeight(2)).toBe(ROW_HEIGHT + 2 * SIGNAL_LINE_HEIGHT);
    const lines = [...container.querySelectorAll<HTMLElement>(".trace-content-row")];
    for (const line of lines) {
      expect(line.style.height).toBe(`${SIGNAL_LINE_HEIGHT}px`);
    }
    expect(lines.map((l) => l.style.top)).toEqual([
      `${ROW_HEIGHT}px`,
      `${ROW_HEIGHT + SIGNAL_LINE_HEIGHT}px`,
    ]);
    const last = lines[lines.length - 1]!;
    expect(Number.parseFloat(last.style.top) + SIGNAL_LINE_HEIGHT).toBe(expandedRowHeight(2));
  });

  it("each signal line is a drag source carrying the plot drop payload", () => {
    const { container } = renderExpandedRow();
    const line = container.querySelectorAll(".trace-content-row")[0] as HTMLElement;
    expect(line).toHaveAttribute("draggable", "true");
    const dt = fakeDataTransfer();
    fireEvent.dragStart(line, { dataTransfer: dt });
    const payload = JSON.parse(dt.getData(SIGNAL_DND_MIME));
    expect(payload.signals).toEqual([
      {
        busId: "b1",
        messageId: 0x100,
        extended: false,
        signalName: "Speed",
        messageName: "GearBox",
        unit: "km/h",
      },
    ]);
  });
});

describe("TraceView frame row disclosure", () => {
  // The row is the disclosure control (matching ByIdTable's settled
  // call): its expansion state belongs on the row itself, and there is
  // no separate decorative glyph.
  it("exposes aria-expanded on an expandable frame row, tracking open/closed", () => {
    const { container } = render(
      <TraceView
        count={1}
        version={0}
        autoScroll={false}
        baseTimestampSeconds={0}
        columns={defaultColumns()}
        onColumnResize={() => {}}
        onColumnToggle={() => {}}
        onColumnReorder={() => {}}
        resolveColor={null}
        busLookup={new Map([["b1", "Chassis"]])}
        getRow={(i) => (i === 0 ? { row: "frame", frame: defaultFrame } : null)}
        ensureVisible={() => {}}
        onAutoScrollDisabled={() => {}}
      />,
    );
    const row = container.querySelector(".trace-row") as HTMLElement;
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
  });

  it("carries no aria-expanded on a row with nothing to disclose (no decode)", () => {
    const { container } = render(
      <TraceView
        count={1}
        version={0}
        autoScroll={false}
        baseTimestampSeconds={0}
        columns={defaultColumns()}
        onColumnResize={() => {}}
        onColumnToggle={() => {}}
        onColumnReorder={() => {}}
        resolveColor={null}
        busLookup={new Map()}
        getRow={(i) => (i === 0 ? { row: "frame", frame: { ...defaultFrame, decoded: null } } : null)}
        ensureVisible={() => {}}
        onAutoScrollDisabled={() => {}}
      />,
    );
    const row = container.querySelector(".trace-row") as HTMLElement;
    expect(row).not.toHaveAttribute("aria-expanded");
  });

  it("renders no decorative caret in the message cell", () => {
    const { row } = renderExpandedRow();
    expect(row.querySelector(".disclosure-toggle-glyph")).toBeNull();
    expect(row.querySelector(".col-msg")).toHaveTextContent("GearBox");
  });
});

describe("TraceView with long names", () => {
  const longFrame: TraceFrameRecord = {
    ...defaultFrame,
    decoded: {
      name: LONG_MESSAGE_NAME,
      signals: [
        { name: LONG_SIGNAL_NAME, value: 21.5, unit: "degC", label: null },
        // The control: a short name in the same row must stay a plain
        // text node, so the split reads as a response to length.
        { name: "Gear", value: 2, unit: "", label: "Drive" },
      ],
    },
  };

  it("splits the message column's name so its tail survives", () => {
    const { row } = renderExpandedRow(longFrame);
    expectMiddleEllipsis(row.querySelector(".col-msg"), LONG_MESSAGE_NAME, LONG_MESSAGE_TAIL);
  });

  it("splits a disclosed signal's name, and leaves a short one alone", () => {
    const { container } = renderExpandedRow(longFrame);
    const lines = container.querySelectorAll(".trace-content-row");
    expectMiddleEllipsis(
      lines[0].querySelector(".signal-name"),
      LONG_SIGNAL_NAME,
      LONG_SIGNAL_TAIL,
    );
    expect(lines[1].querySelector(".signal-name")!.querySelector(".name-text")).toBeNull();
    expect(lines[1].querySelector(".signal-name")).toHaveTextContent("Gear");
  });
});
