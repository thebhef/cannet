import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatCanIdHex,
  formatData,
  formatDurationSeconds,
  formatElapsed,
  formatFrameCount,
  formatId,
  formatSignalValue,
  formatTimestamp,
  fracDigitsForSpan,
} from "./format";
import type { TraceFrameRecord } from "./types";

describe("formatCanIdHex", () => {
  it("pads a standard id to 3 hex digits", () => {
    expect(formatCanIdHex(0x100, false)).toBe("100");
    expect(formatCanIdHex(0, false)).toBe("000");
  });

  it("pads an extended id to 8 hex digits", () => {
    expect(formatCanIdHex(0x100, true)).toBe("00000100");
    expect(formatCanIdHex(0x1fffffff, true)).toBe("1FFFFFFF");
  });
});

describe("formatId", () => {
  it("prefixes a standard id with s: and 3 hex digits", () => {
    const frame = { id: 0x100, extended: false } as TraceFrameRecord;
    expect(formatId(frame, "hex")).toBe(`s:${formatCanIdHex(0x100, false)}`);
    expect(formatId(frame, "hex")).toBe("s:100");
  });

  it("prefixes an extended id with x: and 8 hex digits", () => {
    const frame = { id: 0x100, extended: true } as TraceFrameRecord;
    expect(formatId(frame, "hex")).toBe(`x:${formatCanIdHex(0x100, true)}`);
    expect(formatId(frame, "hex")).toBe("x:00000100");
  });

  it("renders the id in base ten when asked, unpadded", () => {
    // The `can_id_format` setting's other value. Decimal has no
    // natural width, so there is nothing to pad to.
    expect(formatId({ id: 0x100, extended: false } as TraceFrameRecord, "decimal")).toBe("s:256");
    expect(formatId({ id: 0x1fffffff, extended: true } as TraceFrameRecord, "decimal")).toBe(
      "x:536870911",
    );
  });

  it("keeps the s: / x: discriminator in both formats", () => {
    // 11-bit and 29-bit ids overlap numerically, so the prefix is the
    // only thing saying which frame a row is — it is not part of the
    // formatting choice.
    const std = { id: 0x100, extended: false } as TraceFrameRecord;
    const ext = { id: 0x100, extended: true } as TraceFrameRecord;
    for (const format of ["hex", "decimal"] as const) {
      expect(formatId(std, format).startsWith("s:")).toBe(true);
      expect(formatId(ext, format).startsWith("x:")).toBe(true);
      expect(formatId(std, format)).not.toBe(formatId(ext, format));
    }
  });
});

describe("formatBytes", () => {
  it("renders space-separated uppercase hex bytes", () => {
    expect(formatBytes([0, 0xab, 255])).toBe("00 AB FF");
  });

  it("renders an empty payload as an empty string", () => {
    expect(formatBytes([])).toBe("");
  });
});

describe("formatData", () => {
  it("formats a frame's payload the same way as formatBytes", () => {
    const frame = { data: [1, 2, 0xff] } as TraceFrameRecord;
    expect(formatData(frame)).toBe(formatBytes(frame.data));
    expect(formatData(frame)).toBe("01 02 FF");
  });
});

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

// The unit and the `VAL_` label are elements beside the value, not part
// of this string — that separation is asserted in
// `SignalValueCell.dom.test.tsx`.
describe("formatSignalValue", () => {
  it("renders a raw bit field in hex", () => {
    // The host flags raw fields (unscaled, unitless, no VAL_ table):
    // ids, serials, bit patterns — read as a bit pattern, not a number.
    expect(formatSignalValue(0xdeadbeef, true)).toBe("0xDEADBEEF");
    // A 64-bit raw field: what made the original report unreadable.
    expect(formatSignalValue(2 ** 62, true)).toBe("0x4000000000000000");
  });

  it("puts the sign outside the hex digits of a signed raw field", () => {
    expect(formatSignalValue(-5, true)).toBe("-0x5");
  });

  it("keeps a scaled signal in decimal", () => {
    // 1000 rpm must not read as 0x3E8.
    expect(formatSignalValue(1000)).toBe("1000");
    expect(formatSignalValue(1165.25)).toBe("1165.25");
  });

  it("never renders an exact integer in scientific notation", () => {
    // Digit-exact values stay digit-exact however large, hex flag or not.
    expect(formatSignalValue(12_345_678)).toBe("12345678");
    expect(formatSignalValue(9_000_000)).toBe("9000000");
    expect(formatSignalValue(2 ** 62)).toBe("4611686018427387904");
  });

  it("still uses scientific notation for extreme non-integers", () => {
    expect(formatSignalValue(1_234_567.5)).toBe("1.235e+6");
    expect(formatSignalValue(0.0001)).toBe("1.000e-4");
  });
});
