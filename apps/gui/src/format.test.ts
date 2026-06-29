import { describe, expect, it } from "vitest";

import { formatFrameCount, formatSignalValue, formatSignalValueWithLabel } from "./format";

describe("formatFrameCount", () => {
  it("shows just the total before any eviction (floor at 0)", () => {
    expect(formatFrameCount(1234, 0)).toBe("1,234 frames");
  });

  it("shows retained of total once the windowed-ring floor has advanced", () => {
    // 9,412,008 appended, floor at 8,924,777 → 487,231 still retained.
    expect(formatFrameCount(9_412_008, 8_924_777)).toBe(
      "487,231 of 9,412,008 frames",
    );
  });

  it("clamps a floor at or past the total to zero retained", () => {
    // A stale floor (a Clear left it for a tick) must never go negative.
    expect(formatFrameCount(500, 600)).toBe("0 of 500 frames");
  });
});

describe("formatSignalValueWithLabel", () => {
  it("returns just the numeric formatted value when no label is given", () => {
    expect(formatSignalValueWithLabel(60, "degC", null)).toBe(
      formatSignalValue(60, "degC"),
    );
    expect(formatSignalValueWithLabel(60, "degC", undefined)).toBe(
      formatSignalValue(60, "degC"),
    );
  });

  it("appends the label in quotes when present", () => {
    expect(formatSignalValueWithLabel(3, "", "Drive")).toBe(`3 "Drive"`);
  });

  it("preserves the unit alongside the label", () => {
    expect(formatSignalValueWithLabel(1, "deg/s", "Forward")).toBe(
      `1 deg/s "Forward"`,
    );
  });
});
