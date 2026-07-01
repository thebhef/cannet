import { describe, expect, it } from "vitest";

import type { Bus } from "./types";
import {
  COLUMN_DEFS,
  DEFAULT_SORT,
  MIN_COLUMN_WIDTH,
  busDisplayName,
  busLookup,
  columnsFromParams,
  defaultColumns,
  gridTemplateColumns,
  nextSort,
  reorderColumn,
  resizeColumn,
  toggleColumn,
  visibleColumns,
} from "./traceColumns";

const minmaxCount = (t: string) => (t.match(/minmax\(/g) ?? []).length;

describe("defaultColumns", () => {
  it("is every column, in canonical order at its default width", () => {
    const cols = defaultColumns();
    expect(cols.map((c) => c.key)).toEqual(COLUMN_DEFS.map((d) => d.key));
    expect(cols.map((c) => c.width)).toEqual(COLUMN_DEFS.map((d) => d.defaultWidth));
  });

  it("hides only the columns flagged defaultHidden (just `type`)", () => {
    const cols = defaultColumns();
    expect(cols.find((c) => c.key === "kind")?.visible).toBe(false);
    expect(cols.filter((c) => !c.visible).map((c) => c.key)).toEqual(["kind"]);
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
    const hidden = toggleColumn(toggleColumn(defaultColumns(), "bus"), "dir");
    const t = gridTemplateColumns(hidden);
    expect(t).not.toContain("100px"); // bus default width
    expect(t).not.toContain("40px"); // dir default width
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

  it("honours a saved reordering (any permutation of the columns)", () => {
    const reordered = reorderColumn(defaultColumns(), "data", "idx");
    expect(columnsFromParams(reordered)).toEqual(reordered);
    // A full reversal is a valid permutation too — preserved verbatim.
    const reversed = defaultColumns().slice().reverse();
    expect(columnsFromParams(reversed)).toEqual(reversed);
  });

  it("falls back to defaults for anything malformed", () => {
    expect(columnsFromParams(undefined)).toEqual(defaultColumns());
    expect(columnsFromParams(null)).toEqual(defaultColumns());
    expect(columnsFromParams("nope")).toEqual(defaultColumns());
    expect(columnsFromParams([])).toEqual(defaultColumns());
    expect(columnsFromParams(defaultColumns().slice(0, 3))).toEqual(defaultColumns());
    expect(columnsFromParams([{ key: "idx", width: "x", visible: true }])).toEqual(defaultColumns());
    // Right length but a duplicate key (and so a missing one): rejected.
    const dup = defaultColumns().map((c) => ({ ...c, key: "idx" as const }));
    expect(columnsFromParams(dup)).toEqual(defaultColumns());
    // Right length but an unknown key: rejected.
    const unknown = defaultColumns().slice();
    unknown[0] = { ...unknown[0], key: "bogus" as unknown as typeof unknown[0]["key"] };
    expect(columnsFromParams(unknown)).toEqual(defaultColumns());
  });
});

describe("reorderColumn", () => {
  const keys = (cs: readonly { key: string }[]) => cs.map((c) => c.key);

  it("moves a column to before another", () => {
    const cols = reorderColumn(defaultColumns(), "data", "idx");
    expect(keys(cols)).toEqual(["data", "idx", "time", "rate", "bus", "id", "msg", "len", "dir", "kind"]);
  });

  it("moves a column to the end when beforeKey is null", () => {
    const cols = reorderColumn(defaultColumns(), "idx", null);
    expect(keys(cols)[keys(cols).length - 1]).toBe("idx");
    expect(keys(cols)[0]).toBe("time");
  });

  it("preserves width and visibility of the moved column", () => {
    const start = toggleColumn(resizeColumn(defaultColumns(), "id", 200), "id");
    const moved = reorderColumn(start, "id", null).find((c) => c.key === "id");
    expect(moved?.width).toBe(200);
    expect(moved?.visible).toBe(false);
  });

  it("is a copy / no-op for an unknown key or a self-move", () => {
    const before = defaultColumns();
    expect(reorderColumn(before, "idx", "idx")).toEqual(before);
    // @ts-expect-error -- exercising the runtime guard with a bad key
    expect(reorderColumn(before, "nope", "idx")).toEqual(before);
  });
});

describe("toggleColumn", () => {
  it("flips visibility", () => {
    // `dir` ships visible by default (unlike `kind`, which starts hidden).
    const hidden = toggleColumn(defaultColumns(), "dir");
    expect(hidden.find((c) => c.key === "dir")?.visible).toBe(false);
    expect(toggleColumn(hidden, "dir").find((c) => c.key === "dir")?.visible).toBe(true);
  });

  it("refuses to hide the last visible column", () => {
    // Force every column visible first so this exercises the last-one
    // guard independent of which columns ship hidden by default.
    let cols = defaultColumns().map((c) => ({ ...c, visible: true }));
    for (const d of COLUMN_DEFS.slice(0, -1)) cols = toggleColumn(cols, d.key);
    expect(visibleColumns(cols).length).toBe(1);
    const last = COLUMN_DEFS[COLUMN_DEFS.length - 1].key;
    expect(visibleColumns(toggleColumn(cols, last)).length).toBe(1);
  });
});

// The by-id sort itself runs host-side now (`sort_by_id` in
// apps/gui/src-tauri/src/lib.rs, unit-tested there). The panel only
// computes the next `SortState` from a header click; that stays here.
describe("nextSort", () => {
  it("defaults to ascending by id", () => {
    expect(DEFAULT_SORT).toEqual({ key: "id", dir: "asc" });
  });

  it("cycles a column: unsorted → asc → desc → unsorted", () => {
    expect(nextSort(null, "id")).toEqual({ key: "id", dir: "asc" });
    expect(nextSort({ key: "id", dir: "asc" }, "id")).toEqual({ key: "id", dir: "desc" });
    expect(nextSort({ key: "id", dir: "desc" }, "id")).toBeNull();
    // Clicking a different column starts that one ascending.
    expect(nextSort({ key: "id", dir: "desc" }, "bus")).toEqual({ key: "bus", dir: "asc" });
  });
});

describe("busLookup / busDisplayName", () => {
  const buses: Bus[] = [
    { id: "p", name: "Powertrain" },
    { id: "c", name: "Chassis" },
  ];
  const lookup = busLookup(buses);

  it("returns the bus name for a known id", () => {
    expect(busDisplayName("p", lookup)).toBe("Powertrain");
    expect(busDisplayName("c", lookup)).toBe("Chassis");
  });

  it("returns 'unassigned' for null or undefined", () => {
    expect(busDisplayName(null, lookup)).toBe("unassigned");
    expect(busDisplayName(undefined, lookup)).toBe("unassigned");
  });

  it("falls back to the raw id when no bus has that id", () => {
    expect(busDisplayName("x9", lookup)).toBe("x9");
  });
});

describe("columnsFromParams — 'ch' → 'bus' rename", () => {
  it("migrates a legacy 'ch' key in saved params to 'bus', preserving width / visibility", () => {
    // Simulate the persisted pre-rename shape: same array shape, but
    // the bus slot's key is the old "ch" literal.
    const saved = defaultColumns().map((c) =>
      c.key === "bus" ? { ...c, key: "ch", width: 120, visible: false } : c,
    );
    const migrated = columnsFromParams(saved);
    const busCol = migrated.find((c) => c.key === "bus");
    expect(busCol).toBeDefined();
    expect(busCol?.width).toBe(120);
    expect(busCol?.visible).toBe(false);
    // The rest stays at default.
    expect(migrated.find((c) => c.key === "id")?.width).toBe(96);
  });
});
