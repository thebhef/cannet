import { describe, expect, it } from "vitest";

import {
  COLUMN_DEFS,
  MIN_COLUMN_WIDTH,
  columnsFromParams,
  defaultColumns,
  gridTemplateColumns,
  resizeColumn,
  toggleColumn,
  visibleColumns,
} from "./traceColumns";

const minmaxCount = (t: string) => (t.match(/minmax\(/g) ?? []).length;

describe("defaultColumns", () => {
  it("is every column, visible, in canonical order at its default width", () => {
    const cols = defaultColumns();
    expect(cols.map((c) => c.key)).toEqual(COLUMN_DEFS.map((d) => d.key));
    expect(cols.every((c) => c.visible)).toBe(true);
    expect(cols.map((c) => c.width)).toEqual(COLUMN_DEFS.map((d) => d.defaultWidth));
  });
});

describe("gridTemplateColumns", () => {
  it("emits a px track per fixed column and one minmax track for the flex one", () => {
    const t = gridTemplateColumns(defaultColumns());
    expect(t).toContain("64px"); // idx
    expect(t).toContain("minmax(360px, 1fr)"); // data (the flex column)
    expect(minmaxCount(t)).toBe(1);
  });

  it("only includes visible columns", () => {
    const hidden = toggleColumn(toggleColumn(defaultColumns(), "ch"), "dir");
    const t = gridTemplateColumns(hidden);
    expect(t).not.toContain("40px"); // ch / dir default width
    expect(minmaxCount(t)).toBe(1); // data still visible
    expect(t.length).toBeLessThan(gridTemplateColumns(defaultColumns()).length);
  });

  it("falls back to a single track when nothing is visible", () => {
    const cols = defaultColumns().map((c) => ({ ...c, visible: false }));
    expect(gridTemplateColumns(cols)).toBe("1fr");
  });

  it("reflects a resized width", () => {
    expect(gridTemplateColumns(resizeColumn(defaultColumns(), "idx", 200))).toContain("200px");
  });
});

describe("resizeColumn", () => {
  it("sets the given column's width and leaves the rest", () => {
    const cols = resizeColumn(defaultColumns(), "id", 200);
    expect(cols.find((c) => c.key === "id")?.width).toBe(200);
    expect(cols.find((c) => c.key === "time")?.width).toBe(110);
  });

  it("clamps to the minimum and rounds", () => {
    const tiny = resizeColumn(defaultColumns(), "id", 5).find((c) => c.key === "id");
    expect(tiny?.width).toBe(MIN_COLUMN_WIDTH);
    const fractional = resizeColumn(defaultColumns(), "id", 123.7).find((c) => c.key === "id");
    expect(fractional?.width).toBe(124);
  });

  it("is a no-op for an unknown key", () => {
    const before = defaultColumns();
    // @ts-expect-error -- exercising the runtime guard with a bad key
    expect(resizeColumn(before, "nope", 9)).toEqual(before);
  });
});

describe("columnsFromParams", () => {
  it("accepts a well-formed (resized / toggled) column array", () => {
    const saved = toggleColumn(resizeColumn(defaultColumns(), "id", 180), "kind");
    expect(columnsFromParams(saved)).toEqual(saved);
    expect(columnsFromParams(saved)).not.toBe(saved); // a copy
  });

  it("falls back to defaults for anything malformed", () => {
    expect(columnsFromParams(undefined)).toEqual(defaultColumns());
    expect(columnsFromParams(null)).toEqual(defaultColumns());
    expect(columnsFromParams("nope")).toEqual(defaultColumns());
    expect(columnsFromParams([])).toEqual(defaultColumns());
    expect(columnsFromParams(defaultColumns().slice(0, 3))).toEqual(defaultColumns());
    expect(columnsFromParams([{ key: "idx", width: "x", visible: true }])).toEqual(defaultColumns());
    // Right length, wrong order:
    expect(columnsFromParams(defaultColumns().slice().reverse())).toEqual(defaultColumns());
  });
});

describe("toggleColumn", () => {
  it("flips visibility", () => {
    const hidden = toggleColumn(defaultColumns(), "kind");
    expect(hidden.find((c) => c.key === "kind")?.visible).toBe(false);
    expect(toggleColumn(hidden, "kind").find((c) => c.key === "kind")?.visible).toBe(true);
  });

  it("refuses to hide the last visible column", () => {
    let cols = defaultColumns();
    for (const d of COLUMN_DEFS.slice(0, -1)) cols = toggleColumn(cols, d.key);
    expect(visibleColumns(cols).length).toBe(1);
    const last = COLUMN_DEFS[COLUMN_DEFS.length - 1].key;
    expect(visibleColumns(toggleColumn(cols, last)).length).toBe(1);
  });
});
