import { describe, expect, it } from "vitest";

import type { RbsSignalRow } from "./types";
import { DEFAULT_RBS_SIGNAL_SORT, sortRbsSignalRows } from "./rbsSignalsColumns";

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
    defaultValue: null,
    detail: "",
    ...over,
  };
}

describe("sortRbsSignalRows", () => {
  it("returns a copy in the host's own order when there's no sort", () => {
    const rows = [row({ id: "a" }), row({ id: "b" })];
    const sorted = sortRbsSignalRows(rows, null);
    expect(sorted).toEqual(rows);
    expect(sorted).not.toBe(rows);
  });

  it("sorts by bus ascending by default", () => {
    const rows = [row({ id: "a", busKey: "Zonal" }), row({ id: "b", busKey: "Battery" })];
    const sorted = sortRbsSignalRows(rows, DEFAULT_RBS_SIGNAL_SORT);
    expect(sorted.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("reverses on desc", () => {
    const rows = [row({ id: "a", busKey: "Battery" }), row({ id: "b", busKey: "Zonal" })];
    const sorted = sortRbsSignalRows(rows, { key: "bus", dir: "desc" });
    expect(sorted.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("sorts by severity order on the status column, folding out-of-range in", () => {
    const rows = [
      row({ id: "override-in-range", status: "override", value: 100 }),
      row({ id: "out-of-range", status: "override", value: 9000 }),
      row({ id: "not-encoded", status: "not-encoded" }),
      row({ id: "muted", status: "muted" }),
    ];
    const sorted = sortRbsSignalRows(rows, { key: "status", dir: "asc" });
    expect(sorted.map((r) => r.id)).toEqual([
      "not-encoded",
      "out-of-range",
      "override-in-range",
      "muted",
    ]);
  });

  it("leaves ties in the host's own (bus, message, signal) order", () => {
    const rows = [
      row({ id: "a", busKey: "Powertrain", signalName: "A" }),
      row({ id: "b", busKey: "Powertrain", signalName: "B" }),
    ];
    const sorted = sortRbsSignalRows(rows, { key: "bus", dir: "asc" });
    expect(sorted.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
