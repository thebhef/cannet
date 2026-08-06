// The gridview's mouse-built selection model (ADR 0044): click
// replaces, Ctrl/Cmd+click toggles, Shift+click replaces with the range
// from the click anchor, Ctrl+Shift+click adds that range, Ctrl/Cmd+A
// takes every selectable row, and a cursor move collapses the selection
// to the cursor.

import { describe, expect, it } from "vitest";

import { arrayRowSpace, type GridviewRow } from "./gridviewRows";
import {
  EMPTY_SELECTION,
  collapseToCursor,
  selectAll,
  selectOnClick,
  selectableIdsInOrder,
  type GridviewSelection,
} from "./gridviewSelection";

const ORDER = ["a", "b", "c", "d", "e"];

function selection(ids: readonly string[], anchor: string | null): GridviewSelection {
  return { ids: new Set(ids), anchor };
}

/// The selected ids in display order, so assertions read as rows rather
/// than as whatever order the set happens to iterate in.
function selected(s: GridviewSelection, order: readonly string[] = ORDER): string[] {
  return order.filter((id) => s.ids.has(id));
}

const PLAIN = { mod: false, shift: false };
const MOD = { mod: true, shift: false };
const MOD_SHIFT = { mod: true, shift: true };
const SHIFT = { mod: false, shift: true };

describe("selectable rows", () => {
  const rows: GridviewRow[] = [
    { id: "bus", kind: "branch", expandable: true, depth: 0 },
    { id: "msg", kind: "branch", expandable: true, depth: 1 },
    { id: "sig", kind: "leaf", expandable: false, depth: 2 },
  ];
  it("walks the row space in display order, keeping only what the adapter allows", () => {
    const space = arrayRowSpace(rows, () => true);
    expect(selectableIdsInOrder(space, (r) => r.id !== "bus")).toEqual(["msg", "sig"]);
    expect(selectableIdsInOrder(space, () => true)).toEqual(["bus", "msg", "sig"]);
    expect(selectableIdsInOrder(space, () => false)).toEqual([]);
  });
});

describe("click", () => {
  it("replaces the selection and re-anchors", () => {
    const next = selectOnClick(selection(["a", "b"], "a"), "d", PLAIN, ORDER);
    expect(selected(next)).toEqual(["d"]);
    expect(next.anchor).toBe("d");
  });

  it("leaves an unselectable row alone", () => {
    const before = selection(["a"], "a");
    expect(selectOnClick(before, "zz", PLAIN, ORDER)).toBe(before);
    expect(selectOnClick(before, "zz", MOD, ORDER)).toBe(before);
  });

});

describe("Shift+click", () => {
  it("replaces the selection with the anchor→target range", () => {
    const next = selectOnClick(selection(["a"], "a"), "d", SHIFT, ORDER);
    expect(selected(next)).toEqual(["a", "b", "c", "d"]);
  });

  it("drops what was selected outside the range", () => {
    const next = selectOnClick(selection(["a", "e"], "b"), "c", SHIFT, ORDER);
    expect(selected(next)).toEqual(["b", "c"]);
  });

  it("ranges upward as readily as downward", () => {
    const next = selectOnClick(selection(["d"], "d"), "b", SHIFT, ORDER);
    expect(selected(next)).toEqual(["b", "c", "d"]);
  });

  it("keeps the anchor, so a second Shift+click re-ranges from the same point", () => {
    const first = selectOnClick(selection(["b"], "b"), "d", SHIFT, ORDER);
    expect(first.anchor).toBe("b");
    const second = selectOnClick(first, "c", SHIFT, ORDER);
    expect(selected(second)).toEqual(["b", "c"]);
    expect(second.anchor).toBe("b");
  });

  it("shares the anchor with Ctrl+Shift+click", () => {
    // Ctrl+click anchors; the additive range extends from there, and a
    // plain Shift+click that follows ranges from the same anchor —
    // replacing, so the additive range's earlier rows go.
    const anchored = selectOnClick(selection(["a"], "a"), "c", MOD, ORDER);
    const added = selectOnClick(anchored, "e", MOD_SHIFT, ORDER);
    expect(selected(added)).toEqual(["a", "c", "d", "e"]);
    const replaced = selectOnClick(added, "d", SHIFT, ORDER);
    expect(selected(replaced)).toEqual(["c", "d"]);
    expect(replaced.anchor).toBe("c");
  });

  it("falls back to a plain click when there is no anchor yet", () => {
    const next = selectOnClick(EMPTY_SELECTION, "c", SHIFT, ORDER);
    expect(selected(next)).toEqual(["c"]);
    expect(next.anchor).toBe("c");
  });

  it("falls back to a plain click when the anchor has left the row space", () => {
    const next = selectOnClick(selection(["a"], "gone"), "c", SHIFT, ORDER);
    expect(selected(next)).toEqual(["c"]);
    expect(next.anchor).toBe("c");
  });
});

describe("Ctrl/Cmd+click", () => {
  it("adds a row and re-anchors on it", () => {
    const next = selectOnClick(selection(["a"], "a"), "c", MOD, ORDER);
    expect(selected(next)).toEqual(["a", "c"]);
    expect(next.anchor).toBe("c");
  });

  it("removes a row that was already selected", () => {
    const next = selectOnClick(selection(["a", "c"], "a"), "c", MOD, ORDER);
    expect(selected(next)).toEqual(["a"]);
    expect(next.anchor).toBe("c");
  });
});

describe("Ctrl+Shift+click", () => {
  it("adds the range from the anchor, keeping what was already selected", () => {
    const next = selectOnClick(selection(["a", "c"], "c"), "e", MOD_SHIFT, ORDER);
    expect(selected(next)).toEqual(["a", "c", "d", "e"]);
  });

  it("ranges upward as readily as downward", () => {
    const next = selectOnClick(selection(["d"], "d"), "b", MOD_SHIFT, ORDER);
    expect(selected(next)).toEqual(["b", "c", "d"]);
  });

  it("keeps the anchor, so a second range replaces nothing and extends from the same point", () => {
    const first = selectOnClick(selection(["b"], "b"), "c", MOD_SHIFT, ORDER);
    expect(first.anchor).toBe("b");
    const second = selectOnClick(first, "e", MOD_SHIFT, ORDER);
    expect(selected(second)).toEqual(["b", "c", "d", "e"]);
    expect(second.anchor).toBe("b");
  });

  it("adds no duplicates when the range covers rows already selected", () => {
    const next = selectOnClick(selection(["b", "c", "d"], "b"), "d", MOD_SHIFT, ORDER);
    expect(next.ids.size).toBe(3);
    expect(selected(next)).toEqual(["b", "c", "d"]);
  });

  it("falls back to the clicked row when there is no anchor yet", () => {
    const next = selectOnClick(EMPTY_SELECTION, "c", MOD_SHIFT, ORDER);
    expect(selected(next)).toEqual(["c"]);
    expect(next.anchor).toBe("c");
  });

  it("re-anchors when the anchor has left the row space", () => {
    const next = selectOnClick(selection(["a"], "gone"), "c", MOD_SHIFT, ORDER);
    expect(selected(next)).toEqual(["a", "c"]);
    expect(next.anchor).toBe("c");
  });
});

describe("select all", () => {
  it("takes every selectable row and leaves the anchor where it was", () => {
    const next = selectAll(selection(["b"], "b"), ORDER);
    expect(selected(next)).toEqual(ORDER);
    expect(next.anchor).toBe("b");
  });
});

describe("collapse to cursor", () => {
  it("leaves the cursor's row selected and anchored", () => {
    const next = collapseToCursor("c");
    expect(selected(next)).toEqual(["c"]);
    expect(next.anchor).toBe("c");
  });

  it("clears the selection when the cursor's row cannot be selected", () => {
    const next = collapseToCursor(null);
    expect(next.ids.size).toBe(0);
    expect(next.anchor).toBeNull();
  });
});
