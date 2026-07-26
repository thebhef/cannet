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
import { cleanup, render } from "@testing-library/react";

import { useTraceViewport } from "./useTraceViewport";
import { ROW_HEIGHT, maxAnchorRow, scaledHeight, visibleRowCount } from "./traceViewport";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function Harness({ count, anchoredRow }: { count: number; anchoredRow: number }) {
  const { containerRef, viewportHeight, rows, spacerHeight, anchorMax, firstVisibleRow, lastVisibleRow } =
    useTraceViewport(count, anchoredRow);
  return (
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

  it("floors a negative anchoredRow at 0", () => {
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(220);
    const { getByTestId } = render(<Harness count={1000} anchoredRow={-4} />);
    expect(getByTestId("scaffold").dataset.firstVisibleRow).toBe("0");
  });
});
