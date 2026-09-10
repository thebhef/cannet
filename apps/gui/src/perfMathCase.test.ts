import { describe, expect, it } from "vitest";

import type { SignalDescriptorRecord } from "./types";
import { perfMathDefinitions, withPerfMathCase } from "./perfMathCase";

function sig(
  busId: string,
  messageId: number,
  messageName: string,
  signalName: string,
): SignalDescriptorRecord {
  return {
    bus_id: busId,
    message_id: messageId,
    extended: false,
    message_name: messageName,
    transmitter: "Ecu",
    signal_name: signalName,
    unit: "V",
  };
}

/// A catalog shaped like the baseline project's: one wide numbered
/// family (the cell block) and a couple of unrelated messages.
const CATALOG: SignalDescriptorRecord[] = [
  sig("pack", 0x100, "PackState", "PackVolts"),
  sig("pack", 0x100, "PackState", "PackAmps"),
  ...Array.from({ length: 12 }, (_, i) =>
    sig("pack", 0x120, "BmsCellDetail", `CellVolt${String(i).padStart(2, "0")}`),
  ),
  sig("zonal", 0x200, "Wheels", "WheelSpeedFl"),
];

describe("the harness's math case", () => {
  const defs = perfMathDefinitions(CATALOG);

  it("covers a set function over a pattern, an expfilter and a statistic", () => {
    const kinds = defs.map((d) => d.function.kind);
    expect(kinds).toContain("max");
    expect(kinds).toContain("expfilter");
    expect(kinds).toContain("statistic");
  });

  it("defines the set by a live pattern, not by materialised picks", () => {
    const set = defs.find((d) => d.function.kind === "max")!;
    expect(set.operands.picks).toEqual([]);
    expect(set.operands.patterns).toHaveLength(1);
    // Anchored on the numbered family, so it selects the wide message
    // rather than half the database.
    expect(new RegExp(set.operands.patterns[0]).test("pack/Ecu/BmsCellDetail/CellVolt07")).toBe(
      true,
    );
    expect(new RegExp(set.operands.patterns[0]).test("zonal/Ecu/Wheels/WheelSpeedFl")).toBe(false);
  });

  it("picks the busiest message's signal as the single-operand seed", () => {
    const filter = defs.find((d) => d.function.kind === "expfilter" && d.id.endsWith("expfilter"))!;
    expect(filter.operands.picks[0]).toMatchObject({ busId: "pack", messageId: 0x120 });
  });

  it("orders a math-on-math definition after the one it reads", () => {
    const ids = defs.map((d) => d.id);
    expect(ids.indexOf("perf-math-on-math")).toBeGreaterThan(
      ids.indexOf("perf-math-max-family"),
    );
  });

  it("is stable across calls, so two runs measure the same case", () => {
    expect(perfMathDefinitions(CATALOG)).toEqual(defs);
  });

  it("drops the chain rather than dangling it when the set cannot be built", () => {
    // A catalog with nothing wide enough to pattern over: the set is not
    // defined, so neither is the definition that would have read it.
    const thin = [sig("pack", 0x100, "PackState", "A"), sig("pack", 0x101, "Other", "B")];
    const out = perfMathDefinitions(thin);
    expect(out.map((d) => d.id)).not.toContain("perf-math-max-family");
    expect(out.map((d) => d.id)).not.toContain("perf-math-on-math");
  });
});

/// Defining a math signal costs nothing on its own — a math pyramid is
/// built by a **serve** — so the case is only a case once the open
/// views ask for the series.
describe("mounting the case in the open views", () => {
  const ids = ["m-a", "m-b"];

  it("adds the series to a plot's first area, and only the first", () => {
    const cfg = withPerfMathCase(
      "plot",
      { areas: [{ id: "a1", signals: [] }, { id: "a2", signals: [] }] },
      ids,
    )!;
    const areas = cfg.areas as { id: string; signals: { signalName: string; math?: boolean }[] }[];
    expect(areas[0].signals.map((s) => s.signalName)).toEqual(ids);
    expect(areas[0].signals.every((s) => s.math)).toBe(true);
    expect(areas[1].signals).toEqual([]);
  });

  it("adds them to a signal view's manual selection", () => {
    const cfg = withPerfMathCase("signals", { selection: { keys: [], patterns: [] } }, ids)!;
    const sel = cfg.selection as { keys: { signalName: string; math?: boolean }[] };
    expect(sel.keys.map((k) => k.signalName)).toEqual(ids);
  });

  it("is idempotent, so a second pass does not duplicate the case", () => {
    const once = withPerfMathCase("plot", { areas: [{ id: "a1", signals: [] }] }, ids)!;
    expect(withPerfMathCase("plot", once, ids)).toBeNull();
  });

  it("leaves every other kind of element alone", () => {
    expect(withPerfMathCase("trace", {}, ids)).toBeNull();
    expect(withPerfMathCase("rbs", {}, ids)).toBeNull();
    // A plot with no areas has nowhere to put them.
    expect(withPerfMathCase("plot", { areas: [] }, ids)).toBeNull();
  });
});
