// @vitest-environment jsdom
//
// The virtualization scaffolding shared by TraceView and ByIdTable
// (task 0030 item #16): observed viewport height drives the
// rows-to-render / spacer height / anchor bounds derivation. Each
// view's own DOM tests (TraceView.signals.dom.test.tsx,
// ByIdTable.dom.test.tsx) already exercise the hook end to end; this
// is the canonical coverage for the shared arithmetic itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { useTraceViewport, type VariableRowHeights } from "./useTraceViewport";
import {
  ROW_HEIGHT,
  expandedRowHeight,
  maxAnchorRow,
  scaledHeight,
  tailAnchorRow,
  visibleRowCount,
} from "./traceViewport";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function Harness({
  count,
  anchoredRow,
  variable,
}: {
  count: number;
  anchoredRow: number;
  variable?: VariableRowHeights;
}) {
  const {
    containerRef,
    headerRef,
    viewportHeight,
    rows,
    spacerHeight,
    anchorMax,
    firstVisibleRow,
    lastVisibleRow,
  } = useTraceViewport(count, anchoredRow, undefined, variable);
  return (
    <>
      <div ref={headerRef} data-testid="header" />
      <div
        ref={containerRef}
        data-testid="scaffold"
        data-viewport-height={viewportHeight}
        data-rows={rows}
        data-spacer-height={spacerHeight}
        data-anchor-max={anchorMax}
        data-first-visible-row={firstVisibleRow}
        data-last-visible-row={lastVisibleRow}
      />
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useTraceViewport", () => {
  it("derives rows/spacer/anchor from the observed viewport height and count", () => {
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(220);
    const { getByTestId } = render(<Harness count={1000} anchoredRow={5} />);
    const el = getByTestId("scaffold");
    expect(el.dataset.viewportHeight).toBe("220");
    expect(Number(el.dataset.rows)).toBe(visibleRowCount(220));
    expect(Number(el.dataset.spacerHeight)).toBe(scaledHeight(1000, 220));
    expect(Number(el.dataset.anchorMax)).toBe(maxAnchorRow(1000, 220));
    expect(Number(el.dataset.firstVisibleRow)).toBe(5);
    expect(Number(el.dataset.lastVisibleRow)).toBe(5 + visibleRowCount(220));
  });

  it("clamps firstVisibleRow (and lastVisibleRow) to anchorMax when anchoredRow overshoots count", () => {
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(ROW_HEIGHT * 4);
    const { getByTestId } = render(<Harness count={3} anchoredRow={1000} />);
    const el = getByTestId("scaffold");
    expect(el.dataset.firstVisibleRow).toBe(el.dataset.anchorMax);
    expect(Number(el.dataset.lastVisibleRow)).toBe(3);
  });

  it("sizes the spacer and the anchor bound to the expanded rows when given their heights", () => {
    // A snapshot that fits in the viewport as plain rows but not once a
    // row is expanded: without the variable-height geometry the spacer
    // stops at the viewport height and the anchor is pinned to 0, so the
    // expanded row's signal lines are past the end of the scroll range.
    const vh = 220; // ten plain rows
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(vh);
    const rowHeightAt = (i: number) => (i === 2 ? expandedRowHeight(12) : ROW_HEIGHT);
    const extraHeight = expandedRowHeight(12) - ROW_HEIGHT;
    const { getByTestId } = render(
      <Harness count={12} anchoredRow={99} variable={{ extraHeight, rowHeightAt }} />,
    );
    const el = getByTestId("scaffold");
    expect(Number(el.dataset.spacerHeight)).toBe(scaledHeight(12, vh, extraHeight));
    expect(Number(el.dataset.spacerHeight)).toBeGreaterThan(vh);
    expect(Number(el.dataset.anchorMax)).toBe(tailAnchorRow(12, vh, rowHeightAt));
    expect(Number(el.dataset.anchorMax)).toBeGreaterThan(maxAnchorRow(12, vh));
    expect(el.dataset.firstVisibleRow).toBe(el.dataset.anchorMax);
  });

  it("floors a negative anchoredRow at 0", () => {
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(220);
    const { getByTestId } = render(<Harness count={1000} anchoredRow={-4} />);
    expect(getByTestId("scaffold").dataset.firstVisibleRow).toBe("0");
  });

  // The column header is a *sibling* of the rows' scroll container (it
  // must stay put when the rows scroll vertically), so nothing moves it
  // when they scroll horizontally — the header and the rows would come
  // apart by exactly `scrollLeft`. The scaffold mirrors the offset onto
  // the header as a negative margin.
  it("mirrors the container's horizontal scroll onto the header", () => {
    const { getByTestId } = render(<Harness count={1000} anchoredRow={0} />);
    const scroller = getByTestId("scaffold");
    const header = getByTestId("header");
    expect(header.style.marginLeft).toBe("0px");

    Object.defineProperty(scroller, "scrollLeft", { value: 314, writable: true });
    fireEvent.scroll(scroller);
    expect(header.style.marginLeft).toBe("-314px");

    scroller.scrollLeft = 0;
    fireEvent.scroll(scroller);
    expect(header.style.marginLeft).toBe("0px");
  });
});
