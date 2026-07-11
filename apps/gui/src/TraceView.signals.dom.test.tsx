// @vitest-environment jsdom
//
// Rendering test for the expanded-row decoded signals: one indented
// sub-row per signal (name, value+unit, enum label), stacked at
// `SIGNAL_LINE_HEIGHT` inside a row sized by `expandedRowHeight`, each
// line a drag source carrying the plot drag-drop payload. The placement
// arithmetic is unit-tested in traceViewport.test.ts; this guards that
// the row renderer actually draws the sub-rows and wires the drag.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { TraceView } from "./TraceView";
import { defaultColumns } from "./traceColumns";
import { SIGNAL_DND_MIME } from "./dragSignals";
import { ROW_HEIGHT, SIGNAL_LINE_HEIGHT, expandedRowHeight } from "./traceViewport";
import type { TraceFrameRecord } from "./types";

const frame: TraceFrameRecord = {
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

function renderExpandedRow() {
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

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TraceView expanded-row signal sub-rows", () => {
  it("renders one signal line per decoded signal with name, value+unit, and label", () => {
    const { container } = renderExpandedRow();
    const lines = container.querySelectorAll(".signals .signal");
    expect(lines).toHaveLength(2);
    expect(lines[0].querySelector(".signal-name")).toHaveTextContent("Speed");
    expect(lines[0].querySelector(".signal-value")).toHaveTextContent("54.5 km/h");
    expect(lines[1].querySelector(".signal-name")).toHaveTextContent("Gear");
    expect(lines[1].querySelector(".signal-value")).toHaveTextContent('2 "Drive"');
  });

  it("sizes the row for one line per signal and each line at SIGNAL_LINE_HEIGHT", () => {
    const { container, row } = renderExpandedRow();
    expect(row.style.height).toBe(`${expandedRowHeight(2)}px`);
    expect(expandedRowHeight(2)).toBe(ROW_HEIGHT + 2 * SIGNAL_LINE_HEIGHT);
    for (const line of container.querySelectorAll(".signals .signal")) {
      expect((line as HTMLElement).style.height).toBe(`${SIGNAL_LINE_HEIGHT}px`);
    }
  });

  it("each signal line is a drag source carrying the plot drop payload", () => {
    const { container } = renderExpandedRow();
    const line = container.querySelectorAll(".signals .signal")[0] as HTMLElement;
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
