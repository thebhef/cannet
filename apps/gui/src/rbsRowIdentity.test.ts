// The RBS tree's per-row identity is interned, because the panel
// re-renders on a 500 ms value poll: the payloads move, the tree's shape
// does not. Rebuilding a row id — and, through it, a row's DOM id and
// click handler — for every row on every refresh is the panel's largest
// per-render allocation at this tree's size, and it buys nothing, since
// the answer is the same string every time.
//
// These assert *identity*, not equality: an equal-but-fresh string is
// exactly the regression these guard against.

import { describe, expect, it, vi } from "vitest";

import {
  buildVisibleTree,
  makeRbsRowIds,
  makeRbsRowSpace,
  makeRowGridPropsCache,
  messageRowId,
} from "./rbsRowIdentity";
import type { RbsView } from "./types";

function view(): RbsView {
  return {
    buses: [
      {
        key: "pack",
        busId: "pack",
        enabled: true,
        connected: true,
        ecus: [
          {
            name: "BMS",
            enabled: true,
            messages: [
              { key: "0x100", name: "PackStatus", enabled: true, running: true },
              { key: "0x102", name: "CellExtremes", enabled: true, running: true },
            ],
          },
        ],
      },
    ],
  } as unknown as RbsView;
}

describe("makeRbsRowIds", () => {
  it("hands back the same string instance for the same row", () => {
    const ids = makeRbsRowIds();
    expect(ids.message("pack", "0x100")).toBe(ids.message("pack", "0x100"));
    expect(ids.ecu("pack", "BMS")).toBe(ids.ecu("pack", "BMS"));
    expect(ids.bus("pack")).toBe(ids.bus("pack"));
  });

  it("still spells the ids the way the row-id functions do", () => {
    const ids = makeRbsRowIds();
    expect(ids.message("pack", "0x100")).toBe(messageRowId("pack", "0x100"));
  });

  it("keeps different rows apart", () => {
    const ids = makeRbsRowIds();
    expect(ids.message("pack", "0x100")).not.toBe(ids.message("pack", "0x102"));
    expect(ids.message("pack", "0x100")).not.toBe(ids.message("zonal", "0x100"));
  });
});

describe("buildVisibleTree", () => {
  it("reuses the ECU's own message array when no filter is narrowing", () => {
    const v = view();
    const tree = buildVisibleTree(v, makeRbsRowIds(), () => true, null);
    expect(tree[0].ecus[0].messages).toBe(v.buses[0].ecus[0].messages);
  });

  it("filters to the kept rows when one is", () => {
    const v = view();
    const ids = makeRbsRowIds();
    const keep = (id: string) => id !== ids.message("pack", "0x102");
    const tree = buildVisibleTree(v, ids, () => true, keep);
    expect(tree[0].ecus[0].messages.map((m) => m.key)).toEqual(["0x100"]);
  });

  it("drops a bus and an ECU the filter excludes", () => {
    const v = view();
    const ids = makeRbsRowIds();
    expect(buildVisibleTree(v, ids, () => true, (id) => id !== ids.bus("pack"))).toEqual([]);
    const noEcu = buildVisibleTree(v, ids, () => true, (id) => id !== ids.ecu("pack", "BMS"));
    expect(noEcu[0].ecus).toEqual([]);
  });
});

describe("makeRbsRowSpace", () => {
  it("hands back the same array when nothing structural moved", () => {
    const ids = makeRbsRowIds();
    const space = makeRbsRowSpace();
    const first = space(buildVisibleTree(view(), ids, () => true, null), ids);
    // A fresh view object with the same shape — what the value poll does.
    const second = space(buildVisibleTree(view(), ids, () => true, null), ids);
    expect(second).toBe(first);
    expect(first.map((r) => r.id)).toEqual([
      "b:pack",
      "e:pack/BMS",
      "m:pack/0x100",
      "m:pack/0x102",
    ]);
  });

  it("rebuilds when the shape does move", () => {
    const ids = makeRbsRowIds();
    const space = makeRbsRowSpace();
    const open = space(buildVisibleTree(view(), ids, () => true, null), ids);
    const shut = space(buildVisibleTree(view(), ids, (id) => id !== "e:pack/BMS", null), ids);
    expect(shut).not.toBe(open);
    expect(shut.map((r) => r.id)).toEqual(["b:pack", "e:pack/BMS"]);
  });
});

describe("makeRowGridPropsCache", () => {
  it("hands back the same props object for the same row", () => {
    const grid = {
      rowDomId: (id: string) => `p-${id}`,
      onRowClick: vi.fn(),
    };
    const rowProps = makeRowGridPropsCache({ current: grid } as never);
    expect(rowProps("m:pack/0x100")).toBe(rowProps("m:pack/0x100"));
    expect(rowProps("m:pack/0x100").id).toBe("p-m:pack/0x100");
  });

  it("routes the click to the live gridview, not the one it was built with", () => {
    const first = { rowDomId: (id: string) => id, onRowClick: vi.fn() };
    const ref = { current: first };
    const rowProps = makeRowGridPropsCache(ref as never);
    const props = rowProps("m:pack/0x100");
    const later = { rowDomId: (id: string) => id, onRowClick: vi.fn() };
    ref.current = later;
    props.onClick({ ctrlKey: true, metaKey: false, shiftKey: false } as never);
    expect(first.onRowClick).not.toHaveBeenCalled();
    expect(later.onRowClick).toHaveBeenCalledWith("m:pack/0x100", { mod: true, shift: false });
  });
});
