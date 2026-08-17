import { describe, expect, it } from "vitest";

import type { DbcMessageContentRecord, DbcSignalContentRecord, DbcSignalMux } from "./types";
import { groupByMux, muxArmLabel } from "./DatabasePanel";

const SIGNAL_DEFAULTS = {
  unit: "",
  comment: "",
  startBit: 0,
  length: 8,
  byteOrder: "little" as const,
  signed: false,
  factor: 1,
  offset: 0,
  min: 0,
  max: 0,
  floatKind: "integer" as const,
  attributes: [],
  valueTable: [],
};

function sig(
  name: string,
  mux: DbcSignalMux,
  valueTable: { raw: number; label: string }[] = [],
): DbcSignalContentRecord {
  return { ...SIGNAL_DEFAULTS, name, mux, valueTable };
}

function msg(
  signals: DbcSignalContentRecord[],
  opts: { usesExtendedMux?: boolean } = {},
): DbcMessageContentRecord {
  return {
    messageId: 1018,
    extended: false,
    name: "ServiceEvent",
    comment: "",
    expectedLen: 8,
    isFd: false,
    brs: false,
    usesExtendedMux: opts.usesExtendedMux ?? false,
    attributes: [],
    transmitter: null,
    signals,
  };
}

/// The shape the real BMS event message has: one multiplexor carrying
/// a `VAL_` table naming each event, and arms declared out of selector
/// order (the DBC lists signals by descending start bit, which
/// interleaves them). Selector 3 is the only one carrying two signals;
/// 1 and 2 are single-signal arms, which the grouping flattens.
const EVENT_TYPE_VALUES = [
  { raw: 1, label: "BootInit" },
  { raw: 2, label: "NVMemory" },
  { raw: 3, label: "CellVoltageStatus" },
];
const INTERLEAVED = msg([
  sig("EventType", { kind: "multiplexor" }, EVENT_TYPE_VALUES),
  sig("CellStatusVoltage", { kind: "multiplexed", selector: 3 }),
  sig("NVFailureCode", { kind: "multiplexed", selector: 2 }),
  sig("CellStatusPosition", { kind: "multiplexed", selector: 3 }),
  sig("BootInitStage", { kind: "multiplexed", selector: 1 }),
]);

describe("groupByMux", () => {
  it("returns null for a message with no multiplexed signals", () => {
    expect(groupByMux(msg([sig("EngineSpeed", { kind: "plain" })]))).toBeNull();
  });

  it("returns null for a lone multiplexor with no arms", () => {
    expect(groupByMux(msg([sig("EventType", { kind: "multiplexor" })]))).toBeNull();
  });

  it("returns null for an extended-mux message — selector namespaces are per-multiplexor and unresolvable here", () => {
    const grouped = groupByMux(
      msg(
        [
          sig("Outer", { kind: "multiplexor" }),
          sig("Inner", { kind: "multiplexor_and_multiplexed", selector: 2 }),
          sig("Leaf", { kind: "multiplexed", selector: 2 }),
        ],
        { usesExtendedMux: true },
      ),
    );
    expect(grouped).toBeNull();
  });

  it("groups only selectors carrying two or more signals, ascending, declared order within an arm", () => {
    const grouped = groupByMux(INTERLEAVED);
    expect(grouped).not.toBeNull();
    expect(grouped!.arms.map((a) => a.selector)).toEqual([3]);
    expect(grouped!.arms[0].signals.map((s) => s.name)).toEqual([
      "CellStatusVoltage",
      "CellStatusPosition",
    ]);
  });

  it("flattens single-signal arms into common, preserving declared order", () => {
    const grouped = groupByMux(INTERLEAVED);
    expect(grouped!.common.map((s) => s.name)).toEqual([
      "EventType",
      "NVFailureCode",
      "BootInitStage",
    ]);
  });

  it("records the flattened arms' identities for the search haystack", () => {
    const grouped = groupByMux(INTERLEAVED);
    expect(grouped!.flatArms.get("NVFailureCode")).toMatchObject({
      selector: 2,
      label: "NVMemory",
    });
    expect(grouped!.flatArms.get("BootInitStage")).toMatchObject({
      selector: 1,
      label: "BootInit",
    });
    expect(grouped!.flatArms.has("EventType")).toBe(false);
  });

  it("flattens an all-single-arm message to a shape with no arm rows at all", () => {
    // The CT-style indexed-series shape: one signal per selector, the
    // name already carrying the index. No arm level survives.
    const grouped = groupByMux(
      msg([
        sig("CellIndex", { kind: "multiplexor" }),
        sig("Cell01_DeltaSOC", { kind: "multiplexed", selector: 0 }),
        sig("Cell02_DeltaSOC", { kind: "multiplexed", selector: 1 }),
        sig("Cell03_DeltaSOC", { kind: "multiplexed", selector: 2 }),
      ]),
    );
    expect(grouped!.arms).toEqual([]);
    expect(grouped!.nestUnder).toBeNull();
    expect(grouped!.common.map((s) => s.name)).toEqual([
      "CellIndex",
      "Cell01_DeltaSOC",
      "Cell02_DeltaSOC",
      "Cell03_DeltaSOC",
    ]);
  });

  it("labels a grouped arm from the multiplexor's value table", () => {
    const grouped = groupByMux(INTERLEAVED);
    expect(grouped!.arms[0].label).toBe("CellVoltageStatus");
  });

  it("leaves the label null when the multiplexor declares no VAL_ entry for the selector", () => {
    const grouped = groupByMux(
      msg([
        sig("EventType", { kind: "multiplexor" }, [{ raw: 1, label: "BootInit" }]),
        sig("BootStageA", { kind: "multiplexed", selector: 1 }),
        sig("BootStageB", { kind: "multiplexed", selector: 1 }),
        sig("NVFailureCode", { kind: "multiplexed", selector: 2 }),
        sig("NVFailureDetail", { kind: "multiplexed", selector: 2 }),
      ]),
    );
    expect(grouped!.arms.map((a) => a.label)).toEqual(["BootInit", null]);
  });

  it("treats an empty-string VAL_ label as unnamed", () => {
    const grouped = groupByMux(
      msg([
        sig("EventType", { kind: "multiplexor" }, [{ raw: 1, label: "" }]),
        sig("A", { kind: "multiplexed", selector: 1 }),
        sig("B", { kind: "multiplexed", selector: 1 }),
      ]),
    );
    expect(grouped!.arms[0].label).toBeNull();
    expect(grouped!.nestUnder).toBeNull();
  });

  it("nests arms under the multiplexor when it names them via VAL_", () => {
    expect(groupByMux(INTERLEAVED)!.nestUnder).toBe("EventType");
  });

  it("keeps arms at message level when the multiplexor has no VAL_ table", () => {
    const grouped = groupByMux(
      msg([
        sig("ObjectIndex", { kind: "multiplexor" }),
        sig("Obj00DistX", { kind: "multiplexed", selector: 0 }),
        sig("Obj00DistY", { kind: "multiplexed", selector: 0 }),
      ]),
    );
    expect(grouped!.arms).toHaveLength(1);
    expect(grouped!.nestUnder).toBeNull();
  });

  it("groups arms even when the DBC declares no multiplexor at all", () => {
    const grouped = groupByMux(
      msg([
        sig("OrphanA", { kind: "multiplexed", selector: 4 }),
        sig("OrphanB", { kind: "multiplexed", selector: 4 }),
      ]),
    );
    expect(grouped!.common).toEqual([]);
    expect(grouped!.nestUnder).toBeNull();
    expect(grouped!.arms.map((a) => [a.selector, a.label])).toEqual([[4, null]]);
  });
});

describe("muxArmLabel", () => {
  it("is the bare VAL_ name when the selector is named", () => {
    expect(muxArmLabel({ selector: 3, label: "CellVoltageStatus", signals: [] })).toBe(
      "CellVoltageStatus",
    );
  });

  it("falls back to the DBC's m<N> notation when it is not", () => {
    expect(muxArmLabel({ selector: 7, label: null, signals: [] })).toBe("m7");
  });
});
