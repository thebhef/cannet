// @vitest-environment jsdom
//
// The trace time column's hover tooltip: the column renders elapsed time
// since the session origin (ADR 0024), and hovering a row's time cell
// reads the same instant a second way — that message's local date and
// time. Both trace surfaces share the time cell, so both are guarded
// here. The formatting itself is unit-tested in `format.test.ts`; these
// assert the wiring — that the cell is fed the row's *own* absolute
// timestamp, and that a session with no wall-clock origin gets no
// tooltip at all rather than an invented one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

let storedSettings: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...storedSettings } : null)),
}));

import { hydrateSettings } from "./hostSettings";
import { ByIdTable } from "./ByIdTable";
import { TraceView } from "./TraceView";
import { formatLocalTimestamp } from "./format";
import { defaultColumns } from "./traceColumns";
import type { ByIdSnapshotRecord, TraceFrameRecord } from "./types";

/// The session origin (2023-11-14T22:06:40Z) and a frame 200.25 s into it.
const SESSION_START = 1_699_999_600;
const FRAME_SECONDS = SESSION_START + 200.25;

const frame: TraceFrameRecord = {
  index: 0,
  timestamp_seconds: FRAME_SECONDS,
  channel: 0,
  id: 0x100,
  extended: false,
  direction: "Rx",
  kind: { kind: "classic" },
  data: [2],
  decoded: null,
  bus_id: "b1",
};

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const noop = () => {};

function renderTraceView(base: number | null) {
  return render(
    <TraceView
      count={1}
      version={0}
      autoScroll={false}
      baseTimestampSeconds={base}
      columns={defaultColumns()}
      onColumnResize={noop}
      onColumnToggle={noop}
      onColumnReorder={noop}
      resolveColor={null}
      busLookup={new Map([["b1", "Chassis"]])}
      getRow={(i) => (i === 0 ? { row: "frame", frame } : null)}
      ensureVisible={noop}
      onAutoScrollDisabled={noop}
    />,
  ).container;
}

function renderByIdTable(base: number | null) {
  const row: ByIdSnapshotRecord = { frame, rate: 0, count: 1 };
  return render(
    <ByIdTable
      count={1}
      version={0}
      getRow={(i) => (i === 0 ? row : null)}
      ensureVisible={noop}
      columns={defaultColumns()}
      onColumnResize={noop}
      onColumnToggle={noop}
      onColumnReorder={noop}
      resolveColor={null}
      sort={null}
      onSortColumn={noop}
      baseTimestamp={base}
      busLookup={new Map([["b1", "Chassis"]])}
      expanded={new Set()}
      onToggleExpand={noop}
    />,
  ).container;
}

/// The rendered time cell, hovered. React 18 synthesises `mouseEnter`
/// from the bubbling `mouseover`, which is what a pointer arriving on
/// the cell dispatches.
function hoverTimeCell(container: HTMLElement): HTMLElement {
  const cell = container.querySelector(".trace-row .col-time") as HTMLElement;
  fireEvent.mouseOver(cell);
  return cell;
}

const surfaces = [
  ["the chronological trace", renderTraceView],
  ["the by-id trace", renderByIdTable],
] as const;

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  storedSettings = {};
  await hydrateSettings();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(surfaces)("%s time column", (_name, renderSurface) => {
  it("shows the row's local date and time on hover", () => {
    const container = renderSurface(SESSION_START);
    const cell = hoverTimeCell(container);

    // Still elapsed time on screen (ADR 0024) — the tooltip is the
    // second reading, not a second origin.
    expect(cell.textContent).toBe("3:20.2500");
    expect(cell).toHaveAttribute("title", formatLocalTimestamp(FRAME_SECONDS, SESSION_START)!);
    // Not the session origin's own instant: the row's.
    expect(cell.getAttribute("title")).not.toBe(
      formatLocalTimestamp(SESSION_START, SESSION_START),
    );
  });

  it("drops the tooltip when the pointer leaves", () => {
    const container = renderSurface(SESSION_START);
    const cell = hoverTimeCell(container);
    expect(cell).toHaveAttribute("title");

    fireEvent.mouseOut(cell);
    expect(cell).not.toHaveAttribute("title");
  });

  it("shows no tooltip at all when the session has no wall-clock origin", () => {
    const container = renderSurface(null);
    const cell = hoverTimeCell(container);

    expect(cell).not.toHaveAttribute("title");
  });

  it("shows no tooltip when the origin is a capture-relative timeline", () => {
    // A BLF carrying no measurement start time: the session is anchored
    // on the file's own zero, so there is no absolute instant to name.
    const container = renderSurface(0);
    const cell = hoverTimeCell(container);

    expect(cell).not.toHaveAttribute("title");
  });
});
