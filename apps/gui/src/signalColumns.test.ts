// Pins the signal view's default column order and visibility (the
// shared column arithmetic is covered by traceColumns.test.ts).

import { describe, expect, it } from "vitest";

import { defaultSignalColumns } from "./signalColumns";

describe("defaultSignalColumns", () => {
  it("orders time first, identity/value columns visible, stats and bus hidden", () => {
    const cols = defaultSignalColumns();
    expect(cols.map((c) => c.key)).toEqual([
      "time",
      "count",
      "rate",
      "bus",
      "ecu",
      "msg",
      "signal",
      "value",
      "unit",
    ]);
    expect(cols.filter((c) => !c.visible).map((c) => c.key)).toEqual(["count", "rate", "bus"]);
  });
});
