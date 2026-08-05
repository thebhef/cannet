import { describe, expect, it } from "vitest";

import {
  MAX_SCROLL_HEIGHT_PX,
  ROW_HEIGHT,
  SIGNAL_LINE_HEIGHT,
  anchorFromScroll,
  buildPlacements,
  expandedExtraHeight,
  expandedExtraHeightOf,
  expandedRowHeight,
  maxAnchorRow,
  maxScrollTop,
  maxWheelRows,
  rowFromScroll,
  scaledHeight,
  scrollForAnchor,
  scrollForRow,
  tailAnchorRow,
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

describe("scaledHeight / maxScrollTop with expanded rows", () => {
  it("carries the expanded rows' extra height into the scroll extent", () => {
    // Without this the scrollbar only ever represents plain rows, so the
    // pixels an expanded row adds are past the end of the scroll range.
    const extra = 10 * SIGNAL_LINE_HEIGHT;
    expect(scaledHeight(100, VH, extra)).toBe(100 * ROW_HEIGHT + extra);
    expect(maxScrollTop(100, VH, extra)).toBe(100 * ROW_HEIGHT + extra - VH);
  });

  it("lets a snapshot that only overflows once expanded scroll at all", () => {
    // 20 rows (440 px) fit in the 660 px viewport; expanding one row with
    // 20 signals does not.
    const extra = 20 * SIGNAL_LINE_HEIGHT;
    expect(maxScrollTop(20, VH, 0)).toBe(1); // the "nothing to scroll" floor
    expect(maxScrollTop(20, VH, extra)).toBe(20 * ROW_HEIGHT + extra - VH);
  });

  it("still caps at the browser-safe maximum", () => {
    expect(scaledHeight(100_000_000, VH, 5_000)).toBe(MAX_SCROLL_HEIGHT_PX);
  });
});

describe("expandedExtraHeight", () => {
  const plain = () => ROW_HEIGHT;

  it("is zero when every row is a plain row", () => {
    expect(expandedExtraHeight(500, plain)).toBe(0);
  });

  it("sums what the expanded rows add over the plain-row baseline", () => {
    const heights = (i: number) =>
      i === 3 ? expandedRowHeight(4) : i === 40 ? expandedRowHeight(9) : ROW_HEIGHT;
    expect(expandedExtraHeight(100, heights)).toBe(13 * SIGNAL_LINE_HEIGHT);
  });

  it("is zero for an empty snapshot", () => {
    expect(expandedExtraHeight(0, plain)).toBe(0);
  });
});

describe("tailAnchorRow", () => {
  const plain = () => ROW_HEIGHT;

  it("puts the last row fully inside the viewport", () => {
    const count = 100;
    expect(tailAnchorRow(count, VH, plain)).toBe(count - Math.floor(VH / ROW_HEIGHT));
  });

  it("starts later when the rows at the end are expanded", () => {
    const withBigTail = (i: number) => (i === 99 ? expandedRowHeight(10) : ROW_HEIGHT);
    const fits = Math.floor((VH - expandedRowHeight(10)) / ROW_HEIGHT) + 1;
    expect(tailAnchorRow(100, VH, withBigTail)).toBe(100 - fits);
  });

  it("stays at zero while the whole snapshot fits", () => {
    expect(tailAnchorRow(10, VH, plain)).toBe(0);
    expect(tailAnchorRow(0, VH, plain)).toBe(0);
  });

  it("never leaves the last row unrenderable, even taller than the viewport", () => {
    // A single expanded row taller than the panel: the anchor stops on it
    // rather than past it, and the sticky viewport slides to reveal the
    // rest (see `ByIdTable`).
    const huge = (i: number) => (i === 9 ? expandedRowHeight(80) : ROW_HEIGHT);
    expect(tailAnchorRow(10, VH, huge)).toBe(9);
  });
});

describe("anchorFromScroll", () => {
  it("maps the ends of the scroll range to the first and last anchor", () => {
    expect(anchorFromScroll(0, 40, 800)).toBe(0);
    expect(anchorFromScroll(800, 40, 800)).toBe(40);
    expect(anchorFromScroll(400, 40, 800)).toBe(20);
  });

  it("clamps out-of-range scroll positions", () => {
    expect(anchorFromScroll(-50, 40, 800)).toBe(0);
    expect(anchorFromScroll(9_999, 40, 800)).toBe(40);
  });

  it("pins to row 0 when there is nowhere to scroll", () => {
    expect(anchorFromScroll(999, 0, 1)).toBe(0);
  });
});

describe("visibleRowCount / maxAnchorRow", () => {
  it("pads the visible window by two rows", () => {
    expect(visibleRowCount(VH)).toBe(32);
    expect(visibleRowCount(0)).toBe(2);
  });

  it("clamps the anchor to zero when the whole trace fits", () => {
    expect(maxAnchorRow(10, VH)).toBe(0);
    expect(maxAnchorRow(Math.floor(VH / ROW_HEIGHT), VH)).toBe(0);
    expect(maxAnchorRow(Math.floor(VH / ROW_HEIGHT) + 7, VH)).toBe(7);
  });

  // The render pad and the anchor bound are two different facts, and
  // conflating them is what put the last two rows of the chronological
  // trace out of reach: `visibleRowCount`'s two-row pad exists so the
  // partial rows at the viewport's edges are drawn, but subtracting it
  // from `count` bounds the anchor two whole rows *past* the end.
  it("is the plain-row case of tailAnchorRow, not the render pad", () => {
    const plain = () => ROW_HEIGHT;
    for (const count of [0, 1, 30, 31, 100, 10_000]) {
      expect(maxAnchorRow(count, VH)).toBe(tailAnchorRow(count, VH, plain));
    }
  });

  it("leaves the last row on screen when anchored at the bound", () => {
    for (const count of [100, 10_000, 250_000]) {
      const rowsBelow = count - maxAnchorRow(count, VH);
      expect(rowsBelow * ROW_HEIGHT).toBeLessThanOrEqual(VH);
    }
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

describe("expandedRowHeight", () => {
  it("is the message row plus one signal line per signal, uncapped", () => {
    expect(expandedRowHeight(1)).toBe(ROW_HEIGHT + SIGNAL_LINE_HEIGHT);
    expect(expandedRowHeight(40)).toBe(ROW_HEIGHT + 40 * SIGNAL_LINE_HEIGHT);
  });

  it("degrades to a plain row for zero signals (unloaded frame)", () => {
    expect(expandedRowHeight(0)).toBe(ROW_HEIGHT);
  });
});

const noSignals = () => 0;

describe("buildPlacements", () => {
  it("stacks contiguous rows from the top of the viewport", () => {
    const p = buildPlacements(100, 1_000, 4, new Set(), noSignals);
    expect(p).toEqual([
      { posKey: 0, absIdx: 100, top: 0, isExpanded: false, height: ROW_HEIGHT },
      { posKey: 1, absIdx: 101, top: ROW_HEIGHT, isExpanded: false, height: ROW_HEIGHT },
      { posKey: 2, absIdx: 102, top: 2 * ROW_HEIGHT, isExpanded: false, height: ROW_HEIGHT },
      { posKey: 3, absIdx: 103, top: 3 * ROW_HEIGHT, isExpanded: false, height: ROW_HEIGHT },
    ]);
  });

  it("stops at the end of the trace", () => {
    const p = buildPlacements(8, 10, 5, new Set(), noSignals);
    expect(p.map((r) => r.absIdx)).toEqual([8, 9]);
  });

  it("returns nothing for an empty trace", () => {
    expect(buildPlacements(0, 0, 5, new Set(), noSignals)).toEqual([]);
  });

  it("an expanded row pushes the rows below it down by one line per signal", () => {
    const p = buildPlacements(0, 100, 3, new Set([1]), (abs) => (abs === 1 ? 4 : 7));
    expect(p.map((r) => r.top)).toEqual([
      0,
      ROW_HEIGHT,
      ROW_HEIGHT + expandedRowHeight(4),
    ]);
    expect(p.map((r) => r.isExpanded)).toEqual([false, true, false]);
    expect(p.map((r) => r.height)).toEqual([ROW_HEIGHT, expandedRowHeight(4), ROW_HEIGHT]);
  });

  it("an expanded row whose frame isn't loaded yet takes a plain row's height", () => {
    const p = buildPlacements(0, 100, 2, new Set([0]), noSignals);
    expect(p.map((r) => r.top)).toEqual([0, ROW_HEIGHT]);
    expect(p[0].height).toBe(ROW_HEIGHT);
  });
});

describe("expandedExtraHeightOf", () => {
  // The chronological trace's form: its expansion set is keyed by
  // absolute row index, so the extra height can be summed over the
  // *set*. `expandedExtraHeight` has to walk `count` because the by-id
  // table's set is keyed by a stable row key — and `count` here is the
  // whole capture, which reaches millions.
  const expanded = new Set([3, 40]);
  const heights = (i: number) =>
    i === 3 ? expandedRowHeight(4) : i === 40 ? expandedRowHeight(9) : ROW_HEIGHT;

  it("agrees with the walking form", () => {
    expect(expandedExtraHeightOf(expanded, 100, heights)).toBe(
      expandedExtraHeight(100, heights),
    );
    expect(expandedExtraHeightOf(expanded, 100, heights)).toBe(13 * SIGNAL_LINE_HEIGHT);
  });

  it("costs the expanded set, not the trace", () => {
    let asked = 0;
    const counted = (i: number) => {
      asked++;
      return heights(i);
    };
    expandedExtraHeightOf(expanded, 5_000_000, counted);
    expect(asked).toBe(expanded.size);
  });

  it("ignores indices past the end of a trace that shrank", () => {
    expect(expandedExtraHeightOf(new Set([3, 999]), 100, heights)).toBe(
      4 * SIGNAL_LINE_HEIGHT,
    );
    expect(expandedExtraHeightOf(new Set(), 100, heights)).toBe(0);
  });
});

describe("anchorFromScroll / scrollForAnchor", () => {
  // The two directions of the mapping, given the same bound and range.
  // A view that derives one direction from expanded heights and the
  // other from plain ones sends the bottom of the scrollbar to a row
  // short of the end — which is how the chronological trace's expanded
  // tail became unreachable.
  it("round-trips through any bound and range", () => {
    for (const [anchorMax, range] of [
      [40, 800],
      [985, 22_108],
      [700_000, 16_000_000],
    ]) {
      for (const row of [0, 1, Math.floor(anchorMax / 3), anchorMax - 1, anchorMax]) {
        expect(anchorFromScroll(scrollForAnchor(row, anchorMax, range), anchorMax, range)).toBe(
          row,
        );
      }
    }
  });

  it("puts the last anchor at exactly the end of the range", () => {
    expect(scrollForAnchor(40, 40, 800)).toBe(800);
    expect(scrollForAnchor(0, 40, 800)).toBe(0);
  });

  it("clamps an out-of-range row, and pins to 0 with nowhere to go", () => {
    expect(scrollForAnchor(99, 40, 800)).toBe(800);
    expect(scrollForAnchor(-5, 40, 800)).toBe(0);
    expect(scrollForAnchor(7, 0, 800)).toBe(0);
  });
});

describe("the tail bound over expanded rows", () => {
  // The invariant the chronological view was breaking: whatever the
  // bound is, the rows stacked from it must fit in the viewport, or the
  // ones past the fold are unreachable — the sticky viewport clips and
  // the scrollbar is already at its end.
  const tailExpanded = (i: number) => (i >= 97 ? expandedRowHeight(2) : ROW_HEIGHT);
  const stackFrom = (anchor: number, count: number, h: (i: number) => number) => {
    let used = 0;
    for (let i = anchor; i < count; i++) used += h(i);
    return used;
  };

  it("fits the stack in the viewport when the tail rows are expanded", () => {
    const anchor = tailAnchorRow(100, VH, tailExpanded);
    expect(stackFrom(anchor, 100, tailExpanded)).toBeLessThanOrEqual(VH);
  });

  it("the plain-row bound does not — which is what the view was using", () => {
    // 3 rows of `expandedRowHeight(2)` over a 660 px viewport: the
    // plain bound leaves 3 * (58 - 22) = 108 px past the fold.
    expect(stackFrom(maxAnchorRow(100, VH), 100, tailExpanded)).toBe(VH + 108);
  });

  it("carries the same extra height into the scroll range", () => {
    // …and the range has to grow by it too, or there is no scroll
    // position past the one the user is already on.
    const extra = expandedExtraHeightOf(new Set([97, 98, 99]), 100, tailExpanded);
    expect(extra).toBe(108);
    expect(maxScrollTop(100, VH, extra) - maxScrollTop(100, VH)).toBe(108);
  });
});
