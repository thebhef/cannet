// @vitest-environment jsdom
//
// The gridview's column framework (ADR 0044): the panel declares the
// column set, the layer renders the header and the row template so a
// row's cells land in their header's tracks by construction. A header
// is optional and one column is legal — the shape the tree-like panels
// migrate onto.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { GridviewHeader, GridviewRow } from "./gridviewColumns";
import {
  COLUMN_DEFS,
  defaultColumns,
  defaultColumnsFor,
  toggleColumn,
  visibleColumns,
  type ColumnDef,
} from "./traceColumns";

afterEach(cleanup);

type Key = "a" | "b" | "c";

const DEFS: readonly ColumnDef<Key>[] = [
  { key: "a", label: "A", className: "col-a", defaultWidth: 50 },
  { key: "b", label: "B", className: "col-b", defaultWidth: 60 },
  { key: "c", label: "C", className: "col-c", defaultWidth: 70, flex: true },
];

const NOOP = { onColumnResize: () => {}, onColumnToggle: () => {} };

describe("row template", () => {
  it("puts one cell per visible column, in header order, in the header's tracks", () => {
    const columns = toggleColumn(defaultColumnsFor(DEFS), "b");
    const view = render(
      <div>
        <GridviewHeader defs={DEFS} columns={columns} {...NOOP} />
        <GridviewRow
          defs={DEFS}
          columns={visibleColumns(columns)}
          className="trace-row"
          renderCell={(key, className) => <span className={className}>{key}</span>}
        />
      </div>,
    );
    const header = view.container.querySelector(".trace-header") as HTMLElement;
    const row = view.container.querySelector(".trace-row") as HTMLElement;
    expect(Array.from(row.children).map((c) => c.className)).toEqual(["col-a", "col-c"]);
    expect(Array.from(row.children).map((c) => c.textContent)).toEqual(["a", "c"]);
    // The hidden column is in neither, and the two agree on the tracks.
    expect(header.querySelector(".col-b")).toBeNull();
    expect(row.style.gridTemplateColumns).toBe(header.style.gridTemplateColumns);
    expect(row.style.gridTemplateColumns).toBe("50px minmax(70px, 1fr)");
  });

  it("keeps the panel's own row attributes and appends its content block", () => {
    const columns = visibleColumns(defaultColumnsFor(DEFS));
    const view = render(
      <GridviewRow
        defs={DEFS}
        columns={columns}
        className="trace-row expanded"
        style={{ position: "absolute", top: 40 }}
        aria-expanded
        title="a row"
        renderCell={(key, className) => <span className={className}>{key}</span>}
      >
        <div className="signals">content</div>
      </GridviewRow>,
    );
    const row = view.container.firstElementChild as HTMLElement;
    expect(row).toHaveAttribute("title", "a row");
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(row.style.position).toBe("absolute");
    expect(row.style.top).toBe("40px");
    // The layer's tracks survive the panel's own style.
    expect(row.style.gridTemplateColumns).toBe("50px 60px minmax(70px, 1fr)");
    expect(row.lastElementChild).toHaveClass("signals");
  });

  it("is legal with a single column and no header at all", () => {
    const only: readonly ColumnDef<"only">[] = [
      { key: "only", label: "", className: "col-only", defaultWidth: 100, flex: true },
    ];
    const view = render(
      <GridviewRow
        defs={only}
        columns={visibleColumns(defaultColumnsFor(only))}
        className="trace-row"
        renderCell={(_key, className) => <span className={className}>whatever a panel likes</span>}
      />,
    );
    const row = view.container.firstElementChild as HTMLElement;
    expect(view.container.querySelector(".trace-header")).toBeNull();
    expect(row.children).toHaveLength(1);
    expect(row.style.gridTemplateColumns).toBe("minmax(100px, 1fr)");
  });
});

describe("header", () => {
  it("labels each column from the panel's defs, and through an override when given", () => {
    const columns = defaultColumnsFor(DEFS);
    const view = render(
      <div>
        <GridviewHeader defs={DEFS} columns={columns} {...NOOP} />
        <GridviewHeader
          defs={DEFS}
          columns={columns}
          label={(def) => `${def.label}!`}
          {...NOOP}
        />
      </div>,
    );
    const [plain, overridden] = Array.from(view.container.querySelectorAll(".trace-header"));
    expect(Array.from(plain.children).map((c) => c.textContent)).toEqual(["A", "B", "C"]);
    expect(Array.from(overridden.children).map((c) => c.textContent)).toEqual(["A!", "B!", "C!"]);
  });
});

// Drag-to-reorder wiring, moved here with the header itself. The pure
// move logic lives in `traceColumns.ts` (`reorderColumn`, unit-tested
// there); this guards that a header drag/drop translates a drop
// position into the right `onColumnReorder(key, beforeKey)` call.
// jsdom's `getBoundingClientRect` reports a zero-width rect and
// synthetic drag events don't carry a `clientX`, so a drop lands on the
// target's left half — i.e. before it. (The left/right-half split that
// picks before-vs-after is a UX detail exercised by hand.)

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

describe("header drag-to-reorder", () => {
  function renderHeader() {
    const onColumnReorder = vi.fn();
    const { container } = render(
      <GridviewHeader
        defs={COLUMN_DEFS}
        columns={defaultColumns()}
        onColumnResize={() => {}}
        onColumnToggle={() => {}}
        onColumnReorder={onColumnReorder}
      />,
    );
    const cell = (cls: string) => container.querySelector(`.${cls}`) as HTMLElement;
    return { onColumnReorder, cell };
  }

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
