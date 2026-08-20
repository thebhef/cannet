import { describe, expect, it } from "vitest";

import {
  UNBOUND_BUS_KEY,
  VIEW_SIGNAL_ATTENTION_STATUSES,
  applyViewSignalFilters,
  busFilterKey,
  isAttentionFilter,
  viewSignalBusOptions,
} from "./viewSignalsFilter";
import type { ViewSignalRow, ViewSignalStatus } from "./types";

function row(over: Partial<ViewSignalRow> = {}): ViewSignalRow {
  return {
    id: "id",
    status: "decoded",
    busId: "power",
    busName: "Powertrain",
    messageId: 0x100,
    extended: false,
    messageName: "Chassis",
    signalName: "VehicleSpeed",
    unit: "km/h",
    servingDbc: "powertrain.dbc",
    usedBy: ["Plot 1"],
    candidates: [],
    diffs: [],
    ...over,
  };
}

describe("applyViewSignalFilters", () => {
  const rows = [
    row({ id: "a", status: "decoded", busId: "power", busName: "Powertrain" }),
    row({ id: "b", status: "not-decoded", busId: "body", busName: "Body" }),
    row({ id: "c", status: "scale", busId: "power", busName: "Powertrain" }),
    row({ id: "d", status: "ambiguous", busId: null, busName: null }),
  ];

  it("nothing selected in either filter shows every row", () => {
    expect(applyViewSignalFilters(rows, new Set(), new Set())).toHaveLength(4);
  });

  it("one status selected shows only that status", () => {
    const out = applyViewSignalFilters(rows, new Set<ViewSignalStatus>(["scale"]), new Set());
    expect(out.map((r) => r.id)).toEqual(["c"]);
  });

  it("several statuses selected is their union", () => {
    const out = applyViewSignalFilters(
      rows,
      new Set<ViewSignalStatus>(["decoded", "scale"]),
      new Set(),
    );
    expect(out.map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  it("the bus filter ANDs with the status filter", () => {
    const out = applyViewSignalFilters(
      rows,
      new Set<ViewSignalStatus>(["decoded", "scale"]),
      new Set(["body"]),
    );
    expect(out).toHaveLength(0);
  });

  it("a bus filter selects the unbound sentinel too", () => {
    const out = applyViewSignalFilters(rows, new Set(), new Set([UNBOUND_BUS_KEY]));
    expect(out.map((r) => r.id)).toEqual(["d"]);
  });
});

describe("busFilterKey / viewSignalBusOptions", () => {
  it("keys a null bus with the unbound sentinel", () => {
    expect(busFilterKey(null)).toBe(UNBOUND_BUS_KEY);
    expect(busFilterKey("power")).toBe("power");
  });

  it("lists distinct buses referenced by the rows, counted, sorted, unbound last", () => {
    const rows = [
      row({ id: "a", busId: "body", busName: "Body" }),
      row({ id: "b", busId: "power", busName: "Powertrain" }),
      row({ id: "c", busId: "power", busName: "Powertrain" }),
      row({ id: "d", busId: null, busName: null }),
    ];
    expect(viewSignalBusOptions(rows)).toEqual([
      { key: "body", label: "Body", count: 1 },
      { key: "power", label: "Powertrain", count: 2 },
      { key: UNBOUND_BUS_KEY, label: "(no bus)", count: 1 },
    ]);
  });

  it("is empty for no rows", () => {
    expect(viewSignalBusOptions([])).toEqual([]);
  });
});

describe("isAttentionFilter", () => {
  it("is true exactly for the attention set, any order", () => {
    expect(isAttentionFilter(new Set(VIEW_SIGNAL_ATTENTION_STATUSES))).toBe(true);
    expect(isAttentionFilter(new Set([...VIEW_SIGNAL_ATTENTION_STATUSES].reverse()))).toBe(true);
  });

  it("is false for a subset, a superset, or an unrelated set", () => {
    expect(isAttentionFilter(new Set(["scale"]))).toBe(false);
    expect(isAttentionFilter(new Set([...VIEW_SIGNAL_ATTENTION_STATUSES, "decoded"]))).toBe(
      false,
    );
    expect(isAttentionFilter(new Set())).toBe(false);
    expect(isAttentionFilter(new Set(["decoded", "stale"]))).toBe(false);
  });
});
