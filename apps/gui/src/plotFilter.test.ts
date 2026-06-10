// Pure-logic tests for the Phase 12 filter-defined plot area helpers
// (ADR 0020). Verifies the regex target shape `${busName}.${messageName}.${signalName}`,
// the `(unassigned)` prefix for null-bus signals, and that applying a
// filter to an area produces the computed signal list without mutating
// the stored manual signals.

import { describe, expect, it } from "vitest";

import {
  applyAreaFilters,
  signalsFromFilter,
  type FilterableArea,
  type FilterSignalRef,
} from "./plotFilter";
import type { SignalDescriptorRecord } from "./types";

const CATALOG: SignalDescriptorRecord[] = [
  {
    bus_id: "bus-a",
    message_id: 256,
    extended: false,
    message_name: "EngineData",
    signal_name: "EngineSpeed",
    unit: "rpm",
  },
  {
    bus_id: "bus-a",
    message_id: 256,
    extended: false,
    message_name: "EngineData",
    signal_name: "EngineTemp",
    unit: "degC",
  },
  {
    bus_id: "bus-b",
    message_id: 512,
    extended: false,
    message_name: "GearState",
    signal_name: "Mode",
    unit: "",
  },
  {
    bus_id: null,
    message_id: 768,
    extended: false,
    message_name: "Unassigned",
    signal_name: "Lonely",
    unit: "",
  },
];

const BUSES = new Map<string, string>([
  ["bus-a", "powertrain"],
  ["bus-b", "chassis"],
]);

describe("signalsFromFilter", () => {
  it("matches against ${busName}.${messageName}.${signalName}", () => {
    const out = signalsFromFilter("^powertrain\\.EngineData\\.", CATALOG, BUSES, 0);
    expect(out.map((s) => s.signalName).sort()).toEqual([
      "EngineSpeed",
      "EngineTemp",
    ]);
  });

  it("(unassigned) is the bus prefix for null-bus signals", () => {
    const out = signalsFromFilter("^\\(unassigned\\)\\.", CATALOG, BUSES, 0);
    expect(out.map((s) => s.signalName)).toEqual(["Lonely"]);
  });

  it("scopes by bus name in the regex prefix", () => {
    const out = signalsFromFilter("^chassis\\.", CATALOG, BUSES, 0);
    expect(out.map((s) => s.signalName)).toEqual(["Mode"]);
  });

  it("falls back to bus id when the bus name isn't in the lookup", () => {
    const out = signalsFromFilter("^bus-a\\.", CATALOG, new Map(), 0);
    // With an empty name map, the bus prefix is the raw id —
    // both EngineData signals match.
    expect(out).toHaveLength(2);
  });

  it("returns [] for an invalid regex (no panel crash)", () => {
    const out = signalsFromFilter("(", CATALOG, BUSES, 0);
    expect(out).toEqual([]);
  });

  it("assigns deterministic colours per (offset, match-index)", () => {
    const a = signalsFromFilter(".", CATALOG, BUSES, 0);
    const b = signalsFromFilter(".", CATALOG, BUSES, 0);
    // Two calls with the same offset give identical colours per row
    // — that's what keeps a signal's series colour stable across
    // re-evaluations.
    expect(a.map((s) => s.color)).toEqual(b.map((s) => s.color));
  });
});

describe("applyAreaFilters", () => {
  const baseSignal: FilterSignalRef = {
    busId: "bus-a",
    messageId: 256,
    extended: false,
    signalName: "ManuallyPicked",
    messageName: "EngineData",
    unit: "rpm",
    color: "#ff0",
  };
  const area: FilterableArea = {
    id: "area-1",
    signals: [baseSignal],
  };

  it("leaves a manual area untouched (no signalFilter)", () => {
    const out = applyAreaFilters([area], CATALOG, BUSES);
    expect(out[0].signals).toEqual(area.signals);
  });

  it("replaces signals on a filter-mode area with the regex match set", () => {
    const filterArea: FilterableArea = {
      ...area,
      signalFilter: "^powertrain\\.EngineData\\.Engine(Speed|Temp)$",
    };
    const out = applyAreaFilters([filterArea], CATALOG, BUSES);
    expect(out[0].signals.map((s) => s.signalName).sort()).toEqual([
      "EngineSpeed",
      "EngineTemp",
    ]);
  });

  it("does not mutate the source area object", () => {
    const filterArea: FilterableArea = {
      ...area,
      signalFilter: ".",
    };
    const before = filterArea.signals.length;
    applyAreaFilters([filterArea], CATALOG, BUSES);
    expect(filterArea.signals.length).toBe(before);
  });
});
