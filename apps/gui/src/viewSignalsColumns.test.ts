import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIEW_SIGNAL_SORT,
  VIEW_SIGNAL_COLUMN_DEFS,
  VIEW_SIGNAL_UNSORTABLE,
  defaultViewSignalColumns,
  viewSignalColumnsFromParams,
} from "./viewSignalsColumns";

describe("viewSignalsColumns", () => {
  it("defaults to every column visible, sorted by bus", () => {
    expect(DEFAULT_VIEW_SIGNAL_SORT).toEqual({ key: "bus", dir: "asc" });
    const cols = defaultViewSignalColumns();
    expect(cols).toHaveLength(VIEW_SIGNAL_COLUMN_DEFS.length);
    expect(cols.every((c) => c.visible)).toBe(true);
  });

  it("marks source and detail as unsortable — the panel's onSortColumn no-ops for them", () => {
    expect(VIEW_SIGNAL_UNSORTABLE.has("source")).toBe(true);
    expect(VIEW_SIGNAL_UNSORTABLE.has("detail")).toBe(true);
    expect(VIEW_SIGNAL_UNSORTABLE.has("status")).toBe(false);
    expect(VIEW_SIGNAL_UNSORTABLE.has("bus")).toBe(false);
  });

  it("falls back to the built-in layout for a malformed saved value", () => {
    expect(viewSignalColumnsFromParams("garbage")).toEqual(defaultViewSignalColumns());
    expect(viewSignalColumnsFromParams(undefined)).toEqual(defaultViewSignalColumns());
  });

  it("round-trips a saved permutation", () => {
    const saved = defaultViewSignalColumns().slice().reverse();
    expect(viewSignalColumnsFromParams(saved).map((c) => c.key)).toEqual(
      saved.map((c) => c.key),
    );
  });
});
