import { describe, expect, it } from "vitest";

import type { ByIdSnapshotRecord, TraceFrameRecord } from "./types";
import {
  COLUMN_DEFS,
  MIN_COLUMN_WIDTH,
  columnsFromParams,
  defaultColumns,
  gridTemplateColumns,
  nextSort,
  resizeColumn,
  sortRows,
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

describe("nextSort / sortRows", () => {
  it("cycles a column: unsorted → asc → desc → unsorted", () => {
    expect(nextSort(null, "id")).toEqual({ key: "id", dir: "asc" });
    expect(nextSort({ key: "id", dir: "asc" }, "id")).toEqual({ key: "id", dir: "desc" });
    expect(nextSort({ key: "id", dir: "desc" }, "id")).toBeNull();
    // Clicking a different column starts that one ascending.
    expect(nextSort({ key: "id", dir: "desc" }, "ch")).toEqual({ key: "ch", dir: "asc" });
  });

  function row(id: number, channel: number, rate = 0): ByIdSnapshotRecord {
    const frame: TraceFrameRecord = {
      index: 0,
      timestamp_seconds: 0,
      channel,
      id,
      extended: false,
      direction: "Rx",
      kind: { kind: "classic" },
      data: [],
      decoded: null,
    };
    return { frame, rate };
  }

  it("sorts by a column, stable, and is a no-op for null", () => {
    const rows = [row(0x200, 1), row(0x100, 0), row(0x100, 2)];
    expect(sortRows(rows, null)).toEqual(rows);
    expect(sortRows(rows, null)).not.toBe(rows); // a copy
    expect(
      sortRows(rows, { key: "id", dir: "asc" }).map((r) => [r.frame.id, r.frame.channel]),
    ).toEqual([
      [0x100, 0],
      [0x100, 2],
      [0x200, 1],
    ]);
    expect(sortRows(rows, { key: "id", dir: "desc" }).map((r) => r.frame.id)).toEqual([
      0x200, 0x100, 0x100,
    ]);
  });

  it("sorts by the per-id message rate", () => {
    const rows = [row(0x100, 0, 5), row(0x200, 0, 50), row(0x300, 0, 0.5)];
    expect(sortRows(rows, { key: "rate", dir: "asc" }).map((r) => r.rate)).toEqual([0.5, 5, 50]);
    expect(sortRows(rows, { key: "rate", dir: "desc" }).map((r) => r.rate)).toEqual([50, 5, 0.5]);
  });
});
