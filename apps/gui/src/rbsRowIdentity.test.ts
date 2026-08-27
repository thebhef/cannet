// The RBS tree's per-row identity is interned, because the panel
// re-renders on a 500 ms value poll: the payloads move, the tree's shape
// does not. Rebuilding a row id — and, through it, a row's DOM id and
// click handler — for every row on every refresh is the panel's largest
// per-render allocation at this tree's size, and it buys nothing, since
// the answer is the same string every time.
//
// These assert *identity*, not equality: an equal-but-fresh string is
// exactly the regression these guard against.

import { describe, expect, it } from "vitest";

import {
  buildVisibleTree,
  findRbsEnableToggle,
  makeRbsRowIds,
  makeRbsRowSpace,
  messageRowId,
} from "./rbsRowIdentity";
import { contentRowId } from "./gridviewContentRows";
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
              {
                key: "0x100",
                name: "PackStatus",
                enabled: true,
                running: true,
                signals: [{ name: "PackVoltage" }, { name: "PackCurrent" }],
              },
              {
                key: "0x102",
                name: "CellExtremes",
                enabled: true,
                running: true,
                signals: [{ name: "CellMax" }],
              },
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
  /// Buses and ECUs are open; no message is, which is the panel's own
  /// default (a message's signal table starts shut).
  const treeOpen = (ids: ReturnType<typeof makeRbsRowIds>) =>
    buildVisibleTree(view(), ids, (id) => !id.startsWith("m:"), null);

  it("hands back the same array when nothing structural moved", () => {
    const ids = makeRbsRowIds();
    const space = makeRbsRowSpace();
    const shut = (id: string) => !id.startsWith("m:");
    const first = space(treeOpen(ids), ids, shut);
    // A fresh view object with the same shape — what the value poll does.
    const second = space(treeOpen(ids), ids, shut);
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
    const shut = (id: string) => !id.startsWith("m:");
    const open = space(treeOpen(ids), ids, shut);
    const closed = space(
      buildVisibleTree(view(), ids, (id) => id !== "e:pack/BMS" && shut(id), null),
      ids,
      shut,
    );
    expect(closed).not.toBe(open);
    expect(closed.map((r) => r.id)).toEqual(["b:pack", "e:pack/BMS"]);
  });

  it("splices an open message's signals in as rows one level deeper", () => {
    // ADR 0044's node model: a leaf whose content is a *list* discloses
    // rows, not a block — so the cursor reaches each signal.
    const ids = makeRbsRowIds();
    const space = makeRbsRowSpace();
    const rows = space(treeOpen(ids), ids, (id) => id !== "m:pack/0x102");
    expect(rows.map((r) => r.id)).toEqual([
      "b:pack",
      "e:pack/BMS",
      "m:pack/0x100",
      "m:pack/0x100/PackVoltage",
      "m:pack/0x100/PackCurrent",
      "m:pack/0x102",
    ]);
    const sig = rows.find((r) => r.id === "m:pack/0x100/PackVoltage");
    expect(sig).toEqual({
      id: "m:pack/0x100/PackVoltage",
      kind: "leaf",
      expandable: false,
      depth: 3,
    });
    // …and the message that disclosed them is one shallower, which is
    // what makes Left walk out of a signal onto it.
    expect(rows.find((r) => r.id === "m:pack/0x100")?.depth).toBe(2);
  });

  it("spells a signal row's id through the shared content-row naming", () => {
    const ids = makeRbsRowIds();
    const rows = makeRbsRowSpace()(treeOpen(ids), ids, (id) => id === "m:pack/0x100");
    expect(rows.map((r) => r.id)).toContain(
      contentRowId(messageRowId("pack", "0x100"), "PackVoltage"),
    );
  });
});

describe("findRbsEnableToggle", () => {
  const ids = makeRbsRowIds();
  const tree = () => buildVisibleTree(view(), ids, () => true, null);

  it("inverts the enable of whichever level the row is", () => {
    expect(findRbsEnableToggle(tree(), ids, ids.bus("pack"))).toEqual({
      bus: "pack",
      ecu: null,
      message: null,
      enabled: false,
    });
    expect(findRbsEnableToggle(tree(), ids, ids.ecu("pack", "BMS"))).toEqual({
      bus: "pack",
      ecu: "BMS",
      message: null,
      enabled: false,
    });
    // A message names the ECU it hangs under: `rbs_set_enabled` files
    // the entry there, and the row id alone does not carry it.
    expect(findRbsEnableToggle(tree(), ids, ids.message("pack", "0x100"))).toEqual({
      bus: "pack",
      ecu: "BMS",
      message: "0x100",
      enabled: false,
    });
  });

  it("turns a disabled level back on", () => {
    const v = view();
    v.buses[0].ecus[0].messages[0].enabled = false;
    const t = buildVisibleTree(v, ids, () => true, null);
    expect(findRbsEnableToggle(t, ids, ids.message("pack", "0x100"))?.enabled).toBe(true);
  });

  it("has nothing to toggle on an inert row, the way the checkbox has nothing to press", () => {
    const unresolved = view();
    (unresolved.buses[0] as { busId: string | null }).busId = null;
    const ut = buildVisibleTree(unresolved, ids, () => true, null);
    expect(findRbsEnableToggle(ut, ids, ids.bus("pack"))).toBeNull();
    expect(findRbsEnableToggle(ut, ids, ids.message("pack", "0x100"))).toBeNull();

    const unknown = view();
    (unknown.buses[0].ecus[0].messages[0] as { name: string | null }).name = null;
    const kt = buildVisibleTree(unknown, ids, () => true, null);
    expect(findRbsEnableToggle(kt, ids, ids.message("pack", "0x100"))).toBeNull();
    expect(findRbsEnableToggle(kt, ids, ids.message("pack", "0x102"))).not.toBeNull();
  });

  it("answers null for a row that is not in the tree", () => {
    expect(findRbsEnableToggle(tree(), ids, "m:pack/0xFFF")).toBeNull();
  });
});
