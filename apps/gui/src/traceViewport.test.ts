import { describe, expect, it } from "vitest";

import {
  EXPANDED_ROW_HEIGHT,
  MAX_SCROLL_HEIGHT_PX,
  ROW_HEIGHT,
  buildPlacements,
  maxAnchorRow,
  maxWheelRows,
  rowFromScroll,
  scaledHeight,
  scrollForRow,
  visibleRowCount,
  wheelDeltaPx,
} from "./traceViewport";

const VH = 660; // 30 rows tall; visibleRowCount === 32

describe("scaledHeight", () => {
  it("is the natural height for a small trace", () => {
    expect(scaledHeight(100, VH)).toBe(100 * ROW_HEIGHT);
  });

  it("never falls below the viewport height", () => {
    expect(scaledHeight(0, VH)).toBe(VH);
    expect(scaledHeight(5, VH)).toBe(VH);
  });

  it("caps at the browser-safe maximum for huge traces", () => {
    expect(scaledHeight(100_000_000, VH)).toBe(MAX_SCROLL_HEIGHT_PX);
  });
});

describe("visibleRowCount / maxAnchorRow", () => {
  it("pads the visible window by two rows", () => {
    expect(visibleRowCount(VH)).toBe(32);
    expect(visibleRowCount(0)).toBe(2);
  });

  it("clamps the anchor to zero when the whole trace fits", () => {
    expect(maxAnchorRow(10, VH)).toBe(0);
    expect(maxAnchorRow(visibleRowCount(VH), VH)).toBe(0);
    expect(maxAnchorRow(visibleRowCount(VH) + 7, VH)).toBe(7);
  });
});

describe("rowFromScroll / scrollForRow", () => {
  it("pin to row 0 when the trace fits in the viewport", () => {
    expect(rowFromScroll(0, 10, VH)).toBe(0);
    expect(rowFromScroll(999_999, 10, VH)).toBe(0);
    expect(scrollForRow(5, 10, VH)).toBe(0);
  });

  it("map the ends of the scrollbar to the first and last anchor", () => {
    const count = 10_000;
    const anchorMax = maxAnchorRow(count, VH);
    expect(rowFromScroll(0, count, VH)).toBe(0);
    expect(rowFromScroll(scaledHeight(count, VH), count, VH)).toBe(anchorMax);
  });

  it("clamp out-of-range scroll positions and rows", () => {
    const count = 10_000;
    const anchorMax = maxAnchorRow(count, VH);
    expect(rowFromScroll(-100, count, VH)).toBe(0);
    expect(rowFromScroll(Number.MAX_SAFE_INTEGER, count, VH)).toBe(anchorMax);
    expect(scrollForRow(-5, count, VH)).toBe(0);
    expect(scrollForRow(anchorMax + 1000, count, VH)).toBe(
      scrollForRow(anchorMax, count, VH),
    );
  });

  it("round-trip: scrollForRow then rowFromScroll is identity", () => {
    // Includes the capped regime, where the scrollbar is compressed and
    // rounding could in principle drift.
    for (const count of [5_000, 250_000, 5_000_000, 168_000_000]) {
      const anchorMax = maxAnchorRow(count, VH);
      for (const row of [0, 1, 42, Math.floor(anchorMax / 3), anchorMax - 1, anchorMax]) {
        expect(rowFromScroll(scrollForRow(row, count, VH), count, VH)).toBe(row);
      }
    }
  });
});

describe("wheelDeltaPx / maxWheelRows", () => {
  it("passes pixel deltas through unchanged", () => {
    expect(wheelDeltaPx(100, 0, VH)).toBe(100);
    expect(wheelDeltaPx(-37, 0, VH)).toBe(-37);
  });

  it("reads line deltas as a row each and page deltas as a viewport", () => {
    expect(wheelDeltaPx(3, 1, VH)).toBe(3 * ROW_HEIGHT);
    expect(wheelDeltaPx(1, 2, VH)).toBe(VH);
    expect(wheelDeltaPx(-2, 2, VH)).toBe(-2 * VH);
  });

  it("caps a stepped wheel move below a screenful so a notch can't skip a window", () => {
    for (const vh of [120, VH, 1200]) {
      expect(maxWheelRows(vh)).toBeGreaterThanOrEqual(1);
      expect(maxWheelRows(vh)).toBeLessThan(visibleRowCount(vh));
    }
  });
});

describe("buildPlacements", () => {
  it("stacks contiguous rows from the top of the viewport", () => {
    const p = buildPlacements(100, 1_000, 4, new Set());
    expect(p).toEqual([
      { posKey: 0, absIdx: 100, top: 0, isExpanded: false },
      { posKey: 1, absIdx: 101, top: ROW_HEIGHT, isExpanded: false },
      { posKey: 2, absIdx: 102, top: 2 * ROW_HEIGHT, isExpanded: false },
      { posKey: 3, absIdx: 103, top: 3 * ROW_HEIGHT, isExpanded: false },
    ]);
  });

  it("stops at the end of the trace", () => {
    const p = buildPlacements(8, 10, 5, new Set());
    expect(p.map((r) => r.absIdx)).toEqual([8, 9]);
  });

  it("returns nothing for an empty trace", () => {
    expect(buildPlacements(0, 0, 5, new Set())).toEqual([]);
  });

  it("an expanded row pushes the rows below it down by the extra height", () => {
    const p = buildPlacements(0, 100, 3, new Set([1]));
    expect(p.map((r) => r.top)).toEqual([
      0,
      ROW_HEIGHT,
      ROW_HEIGHT + EXPANDED_ROW_HEIGHT,
    ]);
    expect(p.map((r) => r.isExpanded)).toEqual([false, true, false]);
  });
});
