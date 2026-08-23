import { describe, expect, it } from "vitest";

import type { RbsSignalRow } from "./types";
import {
  RBS_SIGNAL_PROBLEM_STATUSES,
  applyRbsSignalFilters,
  isRbsProblemFilter,
  rbsSignalBusOptions,
  rbsSignalDisplayStatus,
} from "./rbsSignalsFilter";

function row(over: Partial<RbsSignalRow> = {}): RbsSignalRow {
  return {
    id: "id",
    busKey: "Powertrain",
    busId: "p1",
    ecuName: "BMS",
    messageKey: "0x100",
    messageName: "EngineData",
    messageId: 0x100,
    extended: false,
    signalName: "EngineSpeed",
    unit: "rpm",
    status: "default",
    value: null,
    label: null,
    overridden: false,
    overrideText: null,
    calcRole: null,
    factor: 1,
    offset: 0,
    min: 0,
    max: 8000,
    size: 16,
    signed: false,
    hasValueTable: false,
    detail: "",
    ...over,
  };
}

describe("rbsSignalDisplayStatus", () => {
  it("upgrades an applied override outside the signal's range to out-of-range", () => {
    const r = row({ status: "override", value: 9000, overridden: true });
    expect(rbsSignalDisplayStatus(r)).toBe("out-of-range");
  });

  it("leaves an in-range override as override", () => {
    const r = row({ status: "override", value: 4000, overridden: true });
    expect(rbsSignalDisplayStatus(r)).toBe("override");
  });

  it("never upgrades a non-override status even if value happens to be out of declared range", () => {
    // A DBC default is not user state; nothing here is "caught" by
    // clamp-on-entry because there's no entry — only overrides pass
    // through the frontend's own input.
    const r = row({ status: "default", value: 9000 });
    expect(rbsSignalDisplayStatus(r)).toBe("default");
  });

  it("passes through a row with no decoded value", () => {
    const r = row({ status: "not-encoded", value: null });
    expect(rbsSignalDisplayStatus(r)).toBe("not-encoded");
  });
});

describe("applyRbsSignalFilters", () => {
  const rows = [
    row({ id: "a", busKey: "Powertrain", status: "default" }),
    row({ id: "b", busKey: "Zonal", status: "not-encoded" }),
    row({ id: "c", busKey: "Powertrain", status: "override", value: 9000 }),
    row({ id: "d", busKey: "Battery", status: "muted" }),
  ];

  it("is the identity when nothing is selected", () => {
    expect(applyRbsSignalFilters(rows, new Set(), new Set())).toEqual(rows);
  });

  it("filters to exactly the selected statuses (display status, not host status)", () => {
    const result = applyRbsSignalFilters(rows, new Set(["out-of-range"]), new Set());
    expect(result.map((r) => r.id)).toEqual(["c"]);
  });

  it("unions several selected statuses", () => {
    const result = applyRbsSignalFilters(rows, new Set(["not-encoded", "muted"]), new Set());
    expect(result.map((r) => r.id)).toEqual(["b", "d"]);
  });

  it("filters by bus independently of status, ANDed together", () => {
    const result = applyRbsSignalFilters(rows, new Set(["default"]), new Set(["Powertrain"]));
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("rbsSignalBusOptions", () => {
  it("lists every bus key referenced, ascending, with per-bus counts", () => {
    const rows = [row({ busKey: "Zonal" }), row({ busKey: "Powertrain" }), row({ busKey: "Zonal" })];
    expect(rbsSignalBusOptions(rows)).toEqual([
      { key: "Powertrain", count: 1 },
      { key: "Zonal", count: 2 },
    ]);
  });
});

describe("isRbsProblemFilter", () => {
  it("is true only for exactly the problem-status set, order independent", () => {
    expect(isRbsProblemFilter(new Set(RBS_SIGNAL_PROBLEM_STATUSES))).toBe(true);
    expect(isRbsProblemFilter(new Set([...RBS_SIGNAL_PROBLEM_STATUSES].reverse()))).toBe(true);
    expect(isRbsProblemFilter(new Set(["not-encoded"]))).toBe(false);
    expect(isRbsProblemFilter(new Set())).toBe(false);
  });
});
