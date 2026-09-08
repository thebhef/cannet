import { describe, expect, it } from "vitest";

import type { MathSignalRecord } from "./types";
import {
  MATH_FUNCTIONS,
  definitionOf,
  mathFunctionSpec,
  newMathDefinition,
  operandSections,
  parameterEnabled,
  setValidity,
  slotValidity,
  withParam,
  mathBusLabel,
  withPatterns,
  withPick,
  withoutPick,
  withOperandScaling,
  withOutputScaling,
} from "./mathSignals";

const dbcRef = (name: string) => ({
  busId: "bus-a",
  messageId: 0x120,
  extended: false,
  signalName: name,
});

function record(over: Partial<MathSignalRecord> = {}): MathSignalRecord {
  return {
    id: "m1",
    name: "CellMedian",
    unit: null,
    function: { kind: "median" },
    operands: { picks: [dbcRef("Cell01")], patterns: ["Cell\\d+"] },
    identity: "*|m:0:m1",
    kind: "median",
    arity: "set",
    resolvedOperands: [dbcRef("Cell01"), dbcRef("Cell02")],
    operandPaths: ["CAN1/BMS/Cells/Cell01", "CAN1/BMS/Cells/Cell02"],
    operandAffines: [],
    unconverted: [],
    unitResolved: "V",
    unitKind: null,
    recognition: [],
    busIds: ["bus-a"],
    invalid: null,
    ...over,
  };
}

describe("the function set", () => {
  it("offers every function the host defines", () => {
    // The kinds `math_signals::MathFunction::kind` spells. A function
    // the host computes but the editor cannot offer is unreachable.
    expect(MATH_FUNCTIONS.map((f) => f.kind)).toEqual([
      "sum",
      "difference",
      "product",
      "scale",
      "min",
      "max",
      "average",
      "median",
      "range",
      "expfilter",
      "integration",
      "duty",
      "frequency",
      "statistic",
      "rms",
      "hline",
    ]);
  });

  it("prepopulates the operand sections each arity fixes", () => {
    expect(operandSections(mathFunctionSpec("difference")).map((s) => s.label)).toEqual([
      "A",
      "B",
    ]);
    expect(operandSections(mathFunctionSpec("expfilter")).map((s) => s.label)).toEqual([
      "Signal",
    ]);
    expect(operandSections(mathFunctionSpec("median")).map((s) => s.label)).toEqual([
      "Signals",
    ]);
    expect(operandSections(mathFunctionSpec("hline"))).toEqual([]);
  });

  it("gates a percentile on the statistic the function holds", () => {
    const spec = mathFunctionSpec("statistic");
    const percentile = spec.params.find((p) => p.key === "percentile")!;
    const fn = newMathDefinition("statistic", "m1").function;
    expect(parameterEnabled(percentile, fn)).toBe(false);
    expect(parameterEnabled(percentile, { ...fn, statistic: "percentile" })).toBe(true);
  });
});

describe("a definition the creation menu mints", () => {
  it("is blank, unnamed, and carries the function's default parameters", () => {
    // Stored as it stands: the host holds an unfinished definition and
    // marks it invalid rather than refusing it, because there is no
    // staging area between picking a function and having one.
    expect(newMathDefinition("scale", "m7")).toEqual({
      id: "m7",
      name: "",
      unit: null,
      function: { kind: "scale", gain: 1, offset: 0 },
      operands: { picks: [], patterns: [] },
    });
    expect(newMathDefinition("statistic", "m8").function).toEqual({
      kind: "statistic",
      statistic: "mean",
      percentile: 95,
    });
  });
});

describe("the stored half of a listing record", () => {
  it("is what an edit rewrites — the resolved half never travels back", () => {
    expect(definitionOf(record())).toEqual({
      id: "m1",
      name: "CellMedian",
      unit: null,
      function: { kind: "median" },
      // The *stored* selection: the second resolved operand arrived
      // through the pattern and is not a pick.
      operands: { picks: [dbcRef("Cell01")], patterns: ["Cell\\d+"] },
    });
  });

  it("carries the output scalars, so an unrelated edit does not drop them", () => {
    expect(definitionOf(record({ outputGain: 2, outputOffset: -1 }))).toMatchObject({
      outputGain: 2,
      outputOffset: -1,
    });
    // Absent when unset, so a definition that scales nothing writes the
    // JSON it always did.
    expect(definitionOf(record())).not.toHaveProperty("outputGain");
    expect(definitionOf(record())).not.toHaveProperty("outputOffset");
  });
});

describe("scaling an operand", () => {
  const set = () =>
    withPick(withPick(newMathDefinition("sum", "m1"), "set", dbcRef("Cell01")), "set", dbcRef("Cell02"));

  it("writes one operand's gain, offset and source unit, leaving the others alone", () => {
    const before = set();
    const after = withOperandScaling(before, 1, {
      gain: 2,
      offset: -0.5,
      sourceUnit: "milliampere",
    });
    expect(after.operands.picks[1]).toEqual({
      ...dbcRef("Cell02"),
      gain: 2,
      offset: -0.5,
      sourceUnit: "milliampere",
    });
    expect(after.operands.picks[0]).toEqual(dbcRef("Cell01"));
    // Pure — the caller still holds the inverse its undo step needs.
    expect(before.operands.picks[1]).toEqual(dbcRef("Cell02"));
  });

  it("omits a scalar that scales nothing rather than storing an identity", () => {
    const scaled = withOperandScaling(set(), 0, { gain: 2, offset: 3 });
    const back = withOperandScaling(scaled, 0, { gain: 1, offset: 0 });
    expect(back.operands.picks[0]).toEqual(dbcRef("Cell01"));
  });

  it("clears a source-unit override with the empty choice", () => {
    const overridden = withOperandScaling(set(), 0, { sourceUnit: "milliampere" });
    const cleared = withOperandScaling(overridden, 0, { sourceUnit: "" });
    expect(cleared.operands.picks[0]).toEqual(dbcRef("Cell01"));
  });

  it("ignores an index no pick answers", () => {
    const before = set();
    expect(withOperandScaling(before, 7, { gain: 2 })).toBe(before);
  });
});

describe("scaling the output", () => {
  it("writes the definition's own gain and offset, and omits an identity", () => {
    const scaled = withOutputScaling(newMathDefinition("sum", "m1"), {
      outputGain: 10,
      outputOffset: 1,
    });
    expect(scaled).toMatchObject({ outputGain: 10, outputOffset: 1 });
    const back = withOutputScaling(scaled, { outputGain: 1, outputOffset: 0 });
    expect(back).not.toHaveProperty("outputGain");
    expect(back).not.toHaveProperty("outputOffset");
  });
});

describe("one field's commit", () => {
  it("writes a parameter as the number the variant expects", () => {
    const spec = mathFunctionSpec("duty");
    const before = newMathDefinition("duty", "m1");
    const after = withParam(before, spec.params[1], "10");
    expect(after.function).toEqual({ kind: "duty", threshold: 0.5, window_seconds: 10 });
    // Pure: the definition it was given is untouched, so the caller
    // still holds the inverse its undo step needs.
    expect(before.function.window_seconds).toBe(5);
  });

  it("fills a slot, replaces it, and clears it", () => {
    const one = newMathDefinition("rms", "m1");
    const filled = withPick(one, 0, dbcRef("Cell01"));
    expect(filled.operands.picks).toEqual([dbcRef("Cell01")]);
    expect(withPick(filled, 0, dbcRef("Cell02")).operands.picks).toEqual([dbcRef("Cell02")]);
    expect(withoutPick(filled, 0).operands.picks).toEqual([]);
  });

  it("lands a pair's first pick in A whichever slot it was made in", () => {
    // The picks are an ordered list with no room for a hole, and A is
    // whichever operand comes first.
    const pair = newMathDefinition("difference", "m1");
    expect(withPick(pair, 1, dbcRef("Cell01")).operands.picks).toEqual([dbcRef("Cell01")]);
  });

  it("appends to a set, and ignores a signal it already collects", () => {
    const set = newMathDefinition("sum", "m1");
    const one = withPick(set, "set", dbcRef("Cell01"));
    const two = withPick(one, "set", dbcRef("Cell02"));
    expect(two.operands.picks).toEqual([dbcRef("Cell01"), dbcRef("Cell02")]);
    expect(withPick(two, "set", dbcRef("Cell01"))).toBe(two);
  });

  it("replaces a section's patterns", () => {
    expect(
      withPatterns(newMathDefinition("max", "m1"), ["Cell\\d+"]).operands.patterns,
    ).toEqual(["Cell\\d+"]);
  });
});

describe("per-section validity", () => {
  it("asks a single slot for exactly one signal", () => {
    expect(slotValidity(null)).toEqual({ ok: false, message: "pick one" });
    expect(slotValidity(dbcRef("Cell01")).ok).toBe(true);
  });

  it("counts a set's picks and its live matches together", () => {
    expect(setValidity([dbcRef("Cell01")], [{ valid: true, matches: 3 }])).toEqual({
      ok: true,
      message: "4 signals",
    });
    expect(setValidity([dbcRef("Cell01")], [])).toEqual({
      ok: false,
      message: "needs ≥ 2",
    });
    expect(setValidity([], [{ valid: false, matches: 0 }])).toEqual({
      ok: false,
      message: "bad regex",
    });
  });
});

/// A math series has no bus of its own, so what a row shows beside it
/// is where its input comes from — the host answers *which* buses
/// (transitively); this is only how they are worded.
describe("the bus line a math row wears", () => {
  const names = new Map([
    ["pack", "Pack"],
    ["zonal", "Zonal"],
  ]);
  it("says only Math when nothing feeds it yet", () => {
    expect(mathBusLabel([], names)).toBe("Math");
  });
  it("names the one bus its input comes from", () => {
    expect(mathBusLabel(["pack"], names)).toBe("Pack · Math");
  });
  it("says Multiple Busses once there is more than one", () => {
    expect(mathBusLabel(["pack", "zonal"], names)).toBe("Math - Multiple Busses");
  });
  it("falls back to the bus id when the project has no name for it", () => {
    expect(mathBusLabel(["ghost"], names)).toBe("ghost · Math");
  });
});
