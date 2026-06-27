// @vitest-environment jsdom
//
// Consumption test for signal value→color maps (ADR 0029): an expanded
// by-id row tints its decoded signal-value cell when the resolver
// returns a color, and leaves it untinted otherwise. The resolver and
// tint string are unit-tested in colorMap.test.ts; this guards that the
// row renderer actually applies them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";

import { ByIdTable } from "./ByIdTable";
import { byIdRowKey } from "./ByIdTable";
import { defaultColumns } from "./traceColumns";
import type { ByIdSnapshotRecord, TraceFrameRecord } from "./types";
import type { ColorResolver } from "./colorMap";

const frame: TraceFrameRecord = {
  index: 0,
  timestamp_seconds: 0,
  channel: 0,
  id: 0x100,
  extended: false,
  direction: "Rx",
  kind: { kind: "classic" },
  data: [2],
  decoded: { name: "GearBox", signals: [{ name: "Gear", value: 2, unit: "", label: "Drive" }] },
  bus_id: "b1",
};
const row: ByIdSnapshotRecord = { frame, rate: 0, count: 1 };

// ByIdTable virtualizes (like TraceView), so it needs a ResizeObserver.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderTable(resolveColor: ColorResolver | null) {
  return render(
    <ByIdTable
      count={1}
      version={0}
      getRow={(i) => (i === 0 ? row : null)}
      ensureVisible={() => {}}
      columns={defaultColumns()}
      onColumnResize={() => {}}
      onColumnToggle={() => {}}
      onColumnReorder={() => {}}
      resolveColor={resolveColor}
      sort={null}
      onSortColumn={() => {}}
      baseTimestamp={0}
      busLookup={new Map([["b1", "Chassis"]])}
      expanded={new Set([byIdRowKey(frame)])}
      onToggleExpand={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ByIdTable color-map tint", () => {
  it("tints the signal-value cell when a colormap matches the value", () => {
    const resolve: ColorResolver = (t, v) =>
      t.signalName === "Gear" && v === 2 ? "#abcdef" : null;
    const { container } = renderTable(resolve);
    const value = container.querySelector(".signal-value") as HTMLElement;
    expect(value).toBeTruthy();
    // #abcdef → rgb(171, 205, 239) at low opacity.
    expect(value.style.background).toContain("rgba(171, 205, 239");
  });

  it("leaves the cell untinted when nothing matches", () => {
    const { container } = renderTable(() => null);
    const value = container.querySelector(".signal-value") as HTMLElement;
    expect(value.style.background).toBe("");
  });
});
