// Pins the signal view's default column order and visibility (the
// shared column arithmetic is covered by traceColumns.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

/// A fresh signal table's layout is the `signal_columns` setting.
let storedSettings: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...storedSettings } : null)),
}));

const { defaultSignalColumns, signalColumnsFromParams } = await import("./signalColumns");
const { hydrateSettings } = await import("./hostSettings");

beforeEach(async () => {
  storedSettings = {};
  await hydrateSettings();
});

describe("the configured signal layout", () => {
  it("seeds a fresh signal table, and has its own setting", async () => {
    // Two settings rather than one: the two tables have different
    // columns, so `bus` here is a different row from `bus` there.
    storedSettings = { signal_columns: [{ key: "bus", width: 150, visible: true }] };
    await hydrateSettings();
    const cols = signalColumnsFromParams(undefined);
    expect(cols.find((c) => c.key === "bus")).toEqual({
      key: "bus",
      width: 150,
      visible: true,
    });
    expect(defaultSignalColumns().find((c) => c.key === "bus")?.visible).toBe(false);
  });
});

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
      "section",
      "value",
      "unit",
    ]);
    expect(cols.filter((c) => !c.visible).map((c) => c.key)).toEqual(["count", "rate", "bus"]);
  });
});
