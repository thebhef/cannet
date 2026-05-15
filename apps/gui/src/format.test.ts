import { describe, expect, it } from "vitest";

import { formatSignalValue, formatSignalValueWithLabel } from "./format";

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
