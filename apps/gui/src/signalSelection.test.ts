// Pure-logic tests for the shared signal-selection model (ADR 0038):
// the canonical-path regex subject `bus/ecu/message/signal`, invalid
// patterns as data (not crashes), pattern↔manual dedup, and
// stable-by-identity colours for pattern-matched signals.

import { describe, expect, it } from "vitest";

import {
  applyAreaSelections,
  catalogPath,
  effectiveSourceBuses,
  resolvePatterns,
  scopeCatalog,
  signalPath,
  signalsFromPatterns,
  type FilterSignalRef,
  type SelectableArea,
} from "./signalSelection";
import { signalKey } from "./plotData";
import { stableSignalColor } from "./palette";
import type { SignalDescriptorRecord } from "./types";

const CATALOG: SignalDescriptorRecord[] = [
  {
    bus_id: "bus-a",
    message_id: 256,
    extended: false,
    transmitter: "Vcu",
    message_name: "EngineData",
    signal_name: "EngineSpeed",
    unit: "rpm",
    is_enum: false,
  },
  {
    bus_id: "bus-a",
    message_id: 256,
    extended: false,
    transmitter: "Vcu",
    message_name: "EngineData",
    signal_name: "EngineTemp",
    unit: "degC",
    is_enum: false,
  },
  {
    bus_id: "bus-b",
    message_id: 512,
    extended: false,
    transmitter: null,
    message_name: "GearState",
    signal_name: "Mode",
    unit: "",
    is_enum: true,
  },
  {
    bus_id: null,
    message_id: 768,
    extended: false,
    transmitter: null,
    message_name: "Unassigned",
    signal_name: "Lonely",
    unit: "",
    is_enum: false,
  },
];

const BUSES = new Map<string, string>([
  ["bus-a", "powertrain"],
  ["bus-b", "chassis"],
]);

describe("signalPath / catalogPath", () => {
  it("is bus/ecu/message/signal with empty segments kept in place", () => {
    expect(signalPath("powertrain", "Vcu", "EngineData", "EngineSpeed")).toBe(
      "powertrain/Vcu/EngineData/EngineSpeed",
    );
    // Missing bus / transmitter: segment positions stay fixed.
    expect(signalPath(null, null, "M", "S")).toBe("//M/S");
  });

  it("resolves the bus segment to the project bus name, id as fallback", () => {
    expect(catalogPath(CATALOG[0], BUSES)).toBe("powertrain/Vcu/EngineData/EngineSpeed");
    expect(catalogPath(CATALOG[0], new Map())).toBe("bus-a/Vcu/EngineData/EngineSpeed");
    expect(catalogPath(CATALOG[3], BUSES)).toBe("//Unassigned/Lonely");
  });
});

describe("resolvePatterns", () => {
  it("matches segment-anchored patterns against the canonical path", () => {
    const [res] = resolvePatterns(["^powertrain/[^/]*/EngineData/"], CATALOG, BUSES);
    expect(res.valid).toBe(true);
    expect(res.matches.map((s) => s.signal_name).sort()).toEqual(["EngineSpeed", "EngineTemp"]);
  });

  it("selects by transmitter segment", () => {
    const [res] = resolvePatterns(["/Vcu/"], CATALOG, BUSES);
    expect(res.matches).toHaveLength(2);
  });

  it("flags an invalid pattern instead of crashing", () => {
    const [bad, good] = resolvePatterns(["(", "^chassis/"], CATALOG, BUSES);
    expect(bad.valid).toBe(false);
    expect(bad.matches).toEqual([]);
    expect(good.valid).toBe(true);
    expect(good.matches.map((s) => s.signal_name)).toEqual(["Mode"]);
  });
});

describe("signalsFromPatterns", () => {
  it("OR-combines patterns and dedupes overlapping matches", () => {
    const out = signalsFromPatterns(["EngineSpeed", "^powertrain/"], CATALOG, BUSES);
    expect(out.map((s) => s.signalName).sort()).toEqual(["EngineSpeed", "EngineTemp"]);
  });

  it("skips signals already picked manually (manual wins)", () => {
    const manual: FilterSignalRef = {
      busId: "bus-a",
      messageId: 256,
      extended: false,
      signalName: "EngineSpeed",
      messageName: "EngineData",
      unit: "rpm",
      color: "#ff0",
    };
    const out = signalsFromPatterns(["^powertrain/"], CATALOG, BUSES, [manual]);
    expect(out.map((s) => s.signalName)).toEqual(["EngineTemp"]);
  });

  it("colours matches stable-by-identity, independent of match order", () => {
    const wide = signalsFromPatterns(["."], CATALOG, BUSES);
    const narrow = signalsFromPatterns(["EngineTemp"], CATALOG, BUSES);
    const temp = (list: FilterSignalRef[]) => list.find((s) => s.signalName === "EngineTemp");
    expect(temp(wide)?.color).toBe(temp(narrow)?.color);
    expect(temp(wide)?.color).toBe(
      stableSignalColor(signalKey("bus-a", 256, false, "EngineTemp")),
    );
  });
});

describe("effectiveSourceBuses / scopeCatalog", () => {
  const BUS_IDS = ["bus-a", "bus-b"];
  const FILTERS = new Map<string, readonly string[]>([
    ["flt-1", ["bus-b"]],
    ["flt-wild", ["*"]],
    ["flt-loop", ["flt-loop", "bus-a"]],
  ]);

  it("wildcard, empty, and unwired mean every bus", () => {
    expect(effectiveSourceBuses(["*"], BUS_IDS, FILTERS)).toBeNull();
    expect(effectiveSourceBuses([], BUS_IDS, FILTERS)).toBeNull();
    expect(effectiveSourceBuses(undefined, BUS_IDS, FILTERS)).toBeNull();
  });

  it("resolves bus ids and filter elements transitively", () => {
    expect(effectiveSourceBuses(["bus-a"], BUS_IDS, FILTERS)).toEqual(new Set(["bus-a"]));
    expect(effectiveSourceBuses(["flt-1"], BUS_IDS, FILTERS)).toEqual(new Set(["bus-b"]));
    // A wildcard upstream of a filter opens everything.
    expect(effectiveSourceBuses(["flt-wild"], BUS_IDS, FILTERS)).toBeNull();
    // Self-referencing filter wiring terminates.
    expect(effectiveSourceBuses(["flt-loop"], BUS_IDS, FILTERS)).toEqual(new Set(["bus-a"]));
    // Stale ids contribute nothing.
    expect(effectiveSourceBuses(["gone"], BUS_IDS, FILTERS)).toEqual(new Set());
  });

  it("scopes the catalog, dropping null-bus entries when restricted", () => {
    const scoped = scopeCatalog(CATALOG, new Set(["bus-a"]));
    expect(scoped.map((s) => s.signal_name).sort()).toEqual(["EngineSpeed", "EngineTemp"]);
    expect(scopeCatalog(CATALOG, null)).toHaveLength(CATALOG.length);
  });
});

describe("applyAreaSelections", () => {
  const manual: FilterSignalRef = {
    busId: "bus-b",
    messageId: 512,
    extended: false,
    signalName: "Mode",
    messageName: "GearState",
    unit: "",
    color: "#ff0",
  };
  const area: SelectableArea = { id: "area-1", signals: [manual] };

  it("leaves an area without patterns untouched", () => {
    const out = applyAreaSelections([area], CATALOG, BUSES);
    expect(out[0]).toBe(area);
  });

  it("appends pattern matches after the manual picks, deduped", () => {
    const withPatterns: SelectableArea = {
      ...area,
      patterns: ["^chassis/", "^powertrain/[^/]*/EngineData/EngineTemp$"],
    };
    const out = applyAreaSelections([withPatterns], CATALOG, BUSES);
    // Manual "Mode" keeps its slot and colour; the chassis pattern's
    // duplicate of it is dropped; the temp match lands after.
    expect(out[0].signals.map((s) => s.signalName)).toEqual(["Mode", "EngineTemp"]);
    expect(out[0].signals[0].color).toBe("#ff0");
  });

  it("does not mutate the source area object", () => {
    const withPatterns: SelectableArea = { ...area, patterns: ["."] };
    const before = withPatterns.signals.length;
    applyAreaSelections([withPatterns], CATALOG, BUSES);
    expect(withPatterns.signals.length).toBe(before);
  });
});
