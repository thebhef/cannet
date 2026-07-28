import { describe, expect, it } from "vitest";

import {
  DETAIL_CHROME,
  DETAIL_LINE_HEIGHT,
  OVERSCAN,
  ROW_HEIGHT,
  buildOffsets,
  rowHeight,
  scrollToShow,
  totalHeight,
  visibleRange,
} from "./dbcPanelViewport";

/// A list of `n` plain rows (no details block) — the panel's default
/// shape, where every row is [`ROW_HEIGHT`] tall.
function plainOffsets(n: number): number[] {
  return buildOffsets(n, () => 0);
}

describe("rowHeight", () => {
  it("is the plain row height when the row has no details block", () => {
    expect(rowHeight(0)).toBe(ROW_HEIGHT);
  });

  it("adds one detail line height per line plus the block's chrome", () => {
    expect(rowHeight(3)).toBe(ROW_HEIGHT + DETAIL_CHROME + 3 * DETAIL_LINE_HEIGHT);
  });
});

describe("buildOffsets", () => {
  it("stacks uniform rows and ends with the total height", () => {
    const offsets = plainOffsets(4);
    expect(offsets).toEqual([0, ROW_HEIGHT, 2 * ROW_HEIGHT, 3 * ROW_HEIGHT, 4 * ROW_HEIGHT]);
    expect(totalHeight(offsets)).toBe(4 * ROW_HEIGHT);
  });

  it("stacks mixed-height rows so each top is the previous bottom", () => {
    // Row 1 carries a 2-line details block; its neighbours don't.
    const offsets = buildOffsets(3, (i) => (i === 1 ? 2 : 0));
    const tall = rowHeight(2);
    expect(offsets).toEqual([0, ROW_HEIGHT, ROW_HEIGHT + tall, ROW_HEIGHT + tall + ROW_HEIGHT]);
  });

  it("is a single zero entry for an empty list", () => {
    expect(plainOffsets(0)).toEqual([0]);
    expect(totalHeight(plainOffsets(0))).toBe(0);
  });
});

describe("visibleRange", () => {
  it("is empty for an empty list", () => {
    expect(visibleRange(plainOffsets(0), 0, 600)).toEqual({ first: 0, last: 0 });
  });

  it("covers the viewport plus the overscan margin on both sides", () => {
    const offsets = plainOffsets(1000);
    const viewport = 10 * ROW_HEIGHT;
    const { first, last } = visibleRange(offsets, 50 * ROW_HEIGHT, viewport);
    expect(first).toBe(50 - OVERSCAN);
    expect(last).toBe(60 + 1 + OVERSCAN);
  });

  it("clamps to the list at both ends", () => {
    const offsets = plainOffsets(20);
    expect(visibleRange(offsets, 0, 10 * ROW_HEIGHT).first).toBe(0);
    expect(visibleRange(offsets, 1_000_000, 10 * ROW_HEIGHT).last).toBe(20);
  });

  it("renders a viewport-bounded slice however long the list is", () => {
    // The exit criterion: the window is a function of the viewport, not
    // of the model size. 33k rows (the reference project's fully
    // expanded signal count) still yields a screenful.
    const viewport = 600;
    const window = visibleRange(plainOffsets(33_000), 0, viewport);
    const rendered = window.last - window.first;
    expect(rendered).toBeLessThanOrEqual(
      Math.ceil(viewport / ROW_HEIGHT) + 1 + 2 * OVERSCAN,
    );
  });

  it("accounts for tall detail rows when mapping scrollTop to an index", () => {
    // Every row carries a 4-line details block, so a fixed-row-height
    // mapping would land four rows too far down.
    const detail = rowHeight(4);
    const offsets = buildOffsets(100, () => 4);
    const { first } = visibleRange(offsets, 30 * detail, 100);
    expect(first).toBe(30 - OVERSCAN);
  });
});

describe("scrollToShow", () => {
  const offsets = plainOffsets(100);
  const viewport = 10 * ROW_HEIGHT;

  it("leaves the scroll position alone when the row is already visible", () => {
    expect(scrollToShow(offsets, 5, 0, viewport)).toBe(0);
  });

  it("scrolls up so a row above the viewport sits at its top", () => {
    expect(scrollToShow(offsets, 3, 20 * ROW_HEIGHT, viewport)).toBe(3 * ROW_HEIGHT);
  });

  it("scrolls down so a row below the viewport sits at its bottom", () => {
    expect(scrollToShow(offsets, 30, 0, viewport)).toBe(31 * ROW_HEIGHT - viewport);
  });

  it("leaves the scroll position alone for an out-of-range index", () => {
    expect(scrollToShow(offsets, 500, 7, viewport)).toBe(7);
  });
});
