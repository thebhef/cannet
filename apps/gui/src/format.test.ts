import { describe, expect, it } from "vitest";

import {
  formatDurationSeconds,
  formatElapsed,
  formatFrameCount,
  formatSignalValue,
  formatSignalValueWithLabel,
  formatTimestamp,
  fracDigitsForSpan,
} from "./format";

describe("formatElapsed", () => {
  it("shows only seconds (no leading zero) below a minute, 4 decimals", () => {
    expect(formatElapsed(0)).toBe("0.0000");
    expect(formatElapsed(5.871)).toBe("5.8710");
    expect(formatElapsed(59.99991)).toBe("59.9999");
  });

  it("adds minutes once past 60s, zero-padding the seconds", () => {
    expect(formatElapsed(65.5)).toBe("1:05.5000");
    expect(formatElapsed(600)).toBe("10:00.0000");
  });

  it("adds hours and days only when the magnitude needs them", () => {
    expect(formatElapsed(3661.5)).toBe("1:01:01.5000");
    expect(formatElapsed(90061.5)).toBe("1:01:01:01.5000");
  });

  it("carries fractional rounding instead of emitting a 60s segment", () => {
    // 59.99996 → 60.0000 would be wrong; it must roll to 1:00.0000.
    expect(formatElapsed(59.99996)).toBe("1:00.0000");
  });

  it("renders a (defensive) negative elapsed with a leading minus", () => {
    expect(formatElapsed(-1.25)).toBe("-1.2500");
  });

  it("renders the requested number of fractional digits", () => {
    expect(formatElapsed(5.871, 6)).toBe("5.871000");
    expect(formatElapsed(65.5, 5)).toBe("1:05.50000");
    expect(formatElapsed(0.1234567, 7)).toBe("0.1234567");
    expect(formatElapsed(0, 9)).toBe("0.000000000");
  });

  it("carries fractional rounding into the minutes segment at any precision", () => {
    expect(formatElapsed(59.9999996, 6)).toBe("1:00.000000");
    expect(formatElapsed(59.9999999996, 9)).toBe("1:00.000000000");
  });
});

describe("fracDigitsForSpan", () => {
  it("keeps the trace's 4-digit default for spans of a second or more", () => {
    expect(fracDigitsForSpan(1)).toBe(4);
    expect(fracDigitsForSpan(60)).toBe(4);
    expect(fracDigitsForSpan(86_400)).toBe(4);
  });

  it("adds one digit per decade of zoom below a 1 s span", () => {
    expect(fracDigitsForSpan(0.5)).toBe(5);
    expect(fracDigitsForSpan(0.1)).toBe(5);
    expect(fracDigitsForSpan(0.05)).toBe(6);
    expect(fracDigitsForSpan(0.001)).toBe(7);
  });

  it("caps at 9 digits (nanosecond resolution)", () => {
    expect(fracDigitsForSpan(1e-7)).toBe(9);
  });

  it("falls back to 4 for degenerate spans", () => {
    expect(fracDigitsForSpan(0)).toBe(4);
    expect(fracDigitsForSpan(-5)).toBe(4);
    expect(fracDigitsForSpan(NaN)).toBe(4);
    expect(fracDigitsForSpan(Infinity)).toBe(4);
  });
});

describe("formatDurationSeconds", () => {
  it("renders plain seconds with trailing zeros trimmed — no SI scaling", () => {
    expect(formatDurationSeconds(0.05)).toBe("0.05 s");
    expect(formatDurationSeconds(0.00003)).toBe("0.00003 s");
    expect(formatDurationSeconds(1.5)).toBe("1.5 s");
  });

  it("drops the decimal point for whole seconds", () => {
    expect(formatDurationSeconds(2)).toBe("2 s");
    expect(formatDurationSeconds(0)).toBe("0 s");
  });

  it("keeps seconds even for long durations (no mm:ss segments)", () => {
    expect(formatDurationSeconds(90.25)).toBe("90.25 s");
  });

  it("renders a signed duration as-is", () => {
    expect(formatDurationSeconds(-0.25)).toBe("-0.25 s");
  });

  it("rounds at nanosecond resolution", () => {
    expect(formatDurationSeconds(0.1234567894)).toBe("0.123456789 s");
  });

  it("renders a dash for missing values", () => {
    expect(formatDurationSeconds(null)).toBe("—");
    expect(formatDurationSeconds(undefined)).toBe("—");
    expect(formatDurationSeconds(NaN)).toBe("—");
  });
});

describe("formatTimestamp", () => {
  it("renders elapsed seconds since the base origin", () => {
    expect(formatTimestamp(125.5, 100)).toBe("25.5000");
    expect(formatTimestamp(100, 100)).toBe("0.0000");
  });

  it("falls back to the raw timestamp when there is no base yet", () => {
    expect(formatTimestamp(7.5, null)).toBe("7.5000");
  });
});

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
