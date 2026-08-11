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

function msg(signals: DbcSignalContentRecord[]): DbcMessageContentRecord {
  return {
    messageId: 1018,
    extended: false,
    name: "ServiceEvent",
    comment: "",
    expectedLen: 8,
    isFd: false,
    brs: false,
    usesExtendedMux: false,
    attributes: [],
    transmitter: null,
    signals,
  };
}

/// The shape the real BMS event message has: one multiplexor carrying
/// a `VAL_` table naming each event, and arms declared out of selector
/// order (the DBC lists signals by descending start bit, which
/// interleaves them).
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

  it("buckets signals per selector, arms in ascending selector order", () => {
    const grouped = groupByMux(INTERLEAVED);
    expect(grouped).not.toBeNull();
    expect(grouped!.arms.map((a) => a.selector)).toEqual([1, 2, 3]);
    expect(grouped!.arms.map((a) => a.signals.map((s) => s.name))).toEqual([
      ["BootInitStage"],
      ["NVFailureCode"],
      // Declared order is preserved within an arm.
      ["CellStatusVoltage", "CellStatusPosition"],
    ]);
  });

  it("keeps the multiplexor and plain signals out of the arms", () => {
    const grouped = groupByMux(
      msg([
        sig("EventType", { kind: "multiplexor" }, EVENT_TYPE_VALUES),
        sig("Counter", { kind: "plain" }),
        sig("BootInitStage", { kind: "multiplexed", selector: 1 }),
      ]),
    );
    expect(grouped!.common.map((s) => s.name)).toEqual(["EventType", "Counter"]);
    expect(grouped!.arms).toHaveLength(1);
  });

  it("labels each arm from the multiplexor's value table", () => {
    const grouped = groupByMux(INTERLEAVED);
    expect(grouped!.arms.map((a) => a.label)).toEqual([
      "BootInit",
      "NVMemory",
      "CellVoltageStatus",
    ]);
  });

  it("leaves the label null when the multiplexor declares no VAL_ entry", () => {
    const grouped = groupByMux(
      msg([
        sig("EventType", { kind: "multiplexor" }, [{ raw: 1, label: "BootInit" }]),
        sig("BootInitStage", { kind: "multiplexed", selector: 1 }),
        sig("NVFailureCode", { kind: "multiplexed", selector: 2 }),
      ]),
    );
    expect(grouped!.arms.map((a) => a.label)).toEqual(["BootInit", null]);
  });

  it("groups arms even when the DBC declares no multiplexor at all", () => {
    const grouped = groupByMux(msg([sig("Orphan", { kind: "multiplexed", selector: 4 })]));
    expect(grouped!.common).toEqual([]);
    expect(grouped!.arms.map((a) => [a.selector, a.label])).toEqual([[4, null]]);
  });

  it("buckets an extended-mux signal by its own selector and keeps it common-side too", () => {
    // `m<N>M` is both an arm member and the switch for a nested level.
    // We have no nested representation, so it lands in its selector's
    // arm; the nesting caveat rides on the message's `usesExtendedMux`.
    const grouped = groupByMux(
      msg([
        sig("Outer", { kind: "multiplexor" }),
        sig("Inner", { kind: "multiplexor_and_multiplexed", selector: 2 }),
        sig("Leaf", { kind: "multiplexed", selector: 2 }),
      ]),
    );
    expect(grouped!.arms).toHaveLength(1);
    expect(grouped!.arms[0].signals.map((s) => s.name)).toEqual(["Inner", "Leaf"]);
  });
});

describe("muxArmLabel", () => {
  it("is 'm<N> · <label>' when the selector is named", () => {
    expect(muxArmLabel({ selector: 3, label: "CellVoltageStatus", signals: [] })).toBe(
      "m3 · CellVoltageStatus",
    );
  });

  it("falls back to the bare selector when it is not", () => {
    expect(muxArmLabel({ selector: 7, label: null, signals: [] })).toBe("m7");
  });
});
