// @vitest-environment jsdom
//
// The chronological view's anchor: which absolute row sits at the top
// of the viewport, and what it costs to keep it there. While the view
// is pinned to the live tail the anchor is *derived* from the row
// count, not stored — storing it made every `trace-grew` tick render
// twice (once against the stale anchor, discarded, then again). These
// tests pin both the cost and the behaviour that pays for it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { TraceView } from "./TraceView";
import { columnDef, contentWidth, defaultColumns } from "./traceColumns";
import { diagCounts } from "./diag";
import { ROW_HEIGHT, maxAnchorRow, maxScrollTop } from "./traceViewport";

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/// The absolute row currently drawn at the top of the viewport, read
/// off the rendered `index` column (which shows `absoluteIndex + 1`,
/// grouped). Read from the DOM rather than from `getRow` calls so it
/// reflects only the *committed* render.
function anchorShown(container: HTMLElement): number {
  const cell = container.querySelector(".trace-row .col-idx");
  return Number(cell?.textContent?.replace(/\D/g, "")) - 1;
}

const noop = () => {};

function view(count: number, autoScroll: boolean, onAutoScrollDisabled = noop) {
  return (
    <TraceView
      count={count}
      version={0}
      autoScroll={autoScroll}
      baseTimestampSeconds={0}
      columns={defaultColumns()}
      onColumnResize={noop}
      onColumnToggle={noop}
      onColumnReorder={noop}
      resolveColor={null}
      busLookup={new Map()}
      getRow={() => null}
      ensureVisible={noop}
      onAutoScrollDisabled={onAutoScrollDisabled}
    />
  );
}

/// Renders of `TraceView` so far — the counter the component bumps on
/// every render pass.
const renderCount = () => diagCounts().get("render.TraceView") ?? 0;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TraceView anchoring", () => {
  it("renders once per live tick while pinned to the tail", () => {
    const { rerender } = render(view(1_000, true));

    const before = renderCount();
    rerender(view(1_100, true));

    expect(renderCount() - before).toBe(1);
  });

  it("keeps the tail row on screen as the trace grows", () => {
    const { container, rerender } = render(view(1_000, true));
    rerender(view(1_100, true));

    // jsdom reports a zero-height viewport, so the tail anchor is
    // `count - visibleRowCount(0)`.
    expect(anchorShown(container)).toBe(maxAnchorRow(1_100, 0));
  });

  it("freezes where it is when auto-scroll is switched off from the toolbar", () => {
    // The toolbar checkbox is the one path that turns auto-scroll off
    // without also naming an anchor, so the view has to fill one in —
    // at the tail it was already showing, not back at row 0.
    const { container, rerender } = render(view(1_000, true));
    const tail = maxAnchorRow(1_000, 0);

    rerender(view(1_000, false));
    rerender(view(1_400, false)); // the capture keeps growing underneath

    expect(anchorShown(container)).toBe(tail);
  });

  it("takes the anchor from a user scroll that dropped auto-scroll", () => {
    // Scrolling away while pinned reports the row the user landed on;
    // the toolbar-edge fill-in must not overwrite it with the tail. The
    // wrapper models the real wiring — the panel owns `autoScroll`, so
    // the view's report and its own re-anchor land in one render.
    function Harness({ count }: { count: number }) {
      const [autoScroll, setAutoScroll] = useState(true);
      return view(count, autoScroll, () => setAutoScroll(false));
    }
    const { container, rerender } = render(<Harness count={1_000} />);
    const rowsEl = container.querySelector(".trace-rows") as HTMLElement;
    Object.defineProperty(rowsEl, "scrollTop", { value: 0, writable: true });
    Object.defineProperty(rowsEl, "scrollHeight", { value: 22_000, writable: true });
    Object.defineProperty(rowsEl, "clientHeight", { value: 0, writable: true });
    // The first event is the mount re-pin's own scroll, which the view
    // swallows; the second is the user dragging back to the top.
    fireEvent.scroll(rowsEl);
    rowsEl.scrollTop = 0;
    fireEvent.scroll(rowsEl);

    rerender(<Harness count={1_000} />);

    expect(anchorShown(container)).toBe(0); // scrolled to the top, and it stuck
  });

  it("returns to the tail when auto-scroll is switched back on", () => {
    const { container, rerender } = render(view(1_000, false));
    rerender(view(1_000, true));
    rerender(view(1_200, true));

    expect(anchorShown(container)).toBe(maxAnchorRow(1_200, 0));
  });
});

describe("TraceView tail reachability", () => {
  // Reviewing a captured trace, the last rows could not be reached:
  // the anchor bound subtracted `visibleRowCount`, whose two-row render
  // pad puts the bound two rows *past* the end, so the final rows were
  // stacked below the sticky viewport's fold with no scroll position
  // that brought them up.
  //
  // jsdom does no layout, so the viewport height is stubbed and the
  // assertion is on the arithmetic the view commits: the anchor it
  // lands on plus the rows that fit must cover the last row. The
  // sticky viewport is `overflow: hidden` at exactly `viewportHeight`,
  // so a row stacked past that is rendered but invisible.
  const VH = 440; // exactly 20 rows
  const onScreen = VH / ROW_HEIGHT;
  let restore: (() => void) | null = null;

  beforeEach(() => {
    const prev = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
    expect(prev, "jsdom defines clientHeight on Element.prototype").toBeTruthy();
    Object.defineProperty(Element.prototype, "clientHeight", {
      configurable: true,
      get: () => VH,
    });
    restore = () => Object.defineProperty(Element.prototype, "clientHeight", prev!);
  });
  afterEach(() => restore?.());

  it("reaches the last row of a captured trace", () => {
    const count = 1_000;
    const { container } = render(view(count, false));
    const rowsEl = container.querySelector(".trace-rows") as HTMLElement;
    Object.defineProperty(rowsEl, "scrollTop", { value: 0, writable: true });
    Object.defineProperty(rowsEl, "scrollHeight", {
      value: count * ROW_HEIGHT,
      writable: true,
    });

    rowsEl.scrollTop = maxScrollTop(count, VH); // drag the thumb to the bottom
    fireEvent.scroll(rowsEl);

    expect(anchorShown(container) + onScreen).toBeGreaterThanOrEqual(count);
  });

  it("keeps the last row on screen while pinned to the live tail", () => {
    const count = 1_000;
    const { container } = render(view(count, true));

    expect(anchorShown(container) + onScreen).toBeGreaterThanOrEqual(count);
  });

  it("does not move the tail when auto-scroll is toggled off and on", () => {
    // The two paths derive the same anchor from the same bound, so a
    // toggle at the tail is a no-op rather than a two-row jump.
    const count = 1_000;
    const { container, rerender } = render(view(count, true));
    const tail = anchorShown(container);

    rerender(view(count, false));
    expect(anchorShown(container)).toBe(tail);
    rerender(view(count, true));
    expect(anchorShown(container)).toBe(tail);
    expect(tail + onScreen).toBeGreaterThanOrEqual(count);
  });
});

describe("TraceView horizontal extent", () => {
  // The rows are absolutely positioned against the sticky viewport, so
  // they are only ever as wide as the scrolled content is — and the
  // viewport clips (`overflow: hidden`). The scrolled content therefore
  // has to carry the columns' own total width, or the columns past the
  // panel's right edge are cut off with no scroll position that reaches
  // them. jsdom does no layout: this asserts the width the view
  // *publishes*; `dockPanelScrolling.test.ts` asserts the stylesheet
  // half, and only Chromium shows the two combining into a scrollbar.
  it("publishes the columns' total width to the rows' scrolled content", () => {
    const { container } = render(view(1_000, true));
    const content = container.querySelector(".trace-scroll-content") as HTMLElement;
    expect(content).toBeTruthy();
    // The chronological view drops the by-id-only columns.
    const shown = defaultColumns().filter((c) => !columnDef(c.key).byIdOnly);
    expect(content.style.getPropertyValue("--trace-content-width")).toBe(
      `${contentWidth(shown)}px`,
    );
  });
});
