// @vitest-environment jsdom
//
// Wiring test for drag-to-reorder column headers. The pure move logic
// lives in `traceColumns.ts` (`reorderColumn`, unit-tested there); this
// guards that a header drag/drop translates a drop position into the
// right `onColumnReorder(key, beforeKey)` call. jsdom's
// `getBoundingClientRect` reports a zero-width rect and synthetic drag
// events don't carry a `clientX`, so a drop lands on the target's left
// half — i.e. before it. (The left/right-half split that picks
// before-vs-after is a UX detail exercised by hand.)

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { TraceHeader } from "./traceTable";
import { defaultColumns } from "./traceColumns";

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

afterEach(cleanup);

function renderHeader() {
  const onColumnReorder = vi.fn();
  const { container } = render(
    <TraceHeader
      columns={defaultColumns()}
      onColumnResize={() => {}}
      onColumnToggle={() => {}}
      onColumnReorder={onColumnReorder}
      byId
    />,
  );
  const cell = (cls: string) => container.querySelector(`.${cls}`) as HTMLElement;
  return { onColumnReorder, cell };
}

describe("TraceHeader drag-to-reorder", () => {
  it("dropping on a header's left half moves the dragged column before it", () => {
    const { onColumnReorder, cell } = renderHeader();
    const dt = fakeDataTransfer();
    fireEvent.dragStart(cell("col-data"), { dataTransfer: dt });
    fireEvent.drop(cell("col-idx"), { dataTransfer: dt, clientX: 0 });
    expect(onColumnReorder).toHaveBeenCalledWith("data", "idx");
  });

  it("ignores a drop with no column payload", () => {
    const { onColumnReorder, cell } = renderHeader();
    fireEvent.drop(cell("col-idx"), { dataTransfer: fakeDataTransfer(), clientX: 0 });
    expect(onColumnReorder).not.toHaveBeenCalled();
  });
});
