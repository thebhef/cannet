import { describe, expect, it } from "vitest";

import { clampToSignalRange, isOutOfSignalRange, signalPhysicalRange } from "./rbsValueClamp";

const ENGINE_SPEED = { min: 0, max: 8000, factor: 1, offset: 0, size: 16, signed: false };

describe("signalPhysicalRange", () => {
  it("uses the declared min/max verbatim when they differ", () => {
    expect(signalPhysicalRange(ENGINE_SPEED)).toEqual({ min: 0, max: 8000 });
  });

  it("derives an unsigned fallback from the raw width when min == max", () => {
    const sig = { min: 0, max: 0, factor: 0.1, offset: 0, size: 8, signed: false };
    // 8-bit unsigned raw spans 0..255; physical = raw * 0.1.
    expect(signalPhysicalRange(sig)).toEqual({ min: 0, max: 25.5 });
  });

  it("derives a signed fallback from the raw width when min == max", () => {
    const sig = { min: 5, max: 5, factor: 1, offset: 0, size: 8, signed: true };
    // 8-bit signed raw spans -128..127.
    expect(signalPhysicalRange(sig)).toEqual({ min: -128, max: 127 });
  });

  it("orders the fallback low/high even when factor is negative", () => {
    const sig = { min: 0, max: 0, factor: -1, offset: 0, size: 4, signed: false };
    // Raw 0..15, physical -15..0 once negated — min/max must still
    // come out low-to-high, not raw-order.
    expect(signalPhysicalRange(sig)).toEqual({ min: -15, max: 0 });
  });
});

describe("isOutOfSignalRange", () => {
  it("is false inside the range and true outside it, at both ends", () => {
    expect(isOutOfSignalRange(4000, ENGINE_SPEED)).toBe(false);
    expect(isOutOfSignalRange(0, ENGINE_SPEED)).toBe(false);
    expect(isOutOfSignalRange(8000, ENGINE_SPEED)).toBe(false);
    expect(isOutOfSignalRange(-1, ENGINE_SPEED)).toBe(true);
    expect(isOutOfSignalRange(9000, ENGINE_SPEED)).toBe(true);
  });

  it("never flags a non-finite value as out of range", () => {
    expect(isOutOfSignalRange(Number.NaN, ENGINE_SPEED)).toBe(false);
    expect(isOutOfSignalRange(Number.POSITIVE_INFINITY, ENGINE_SPEED)).toBe(false);
  });
});

describe("clampToSignalRange", () => {
  it("passes a value already in range through unchanged", () => {
    expect(clampToSignalRange(4000, ENGINE_SPEED)).toBe(4000);
  });

  it("clamps to the high and low bounds", () => {
    expect(clampToSignalRange(9000, ENGINE_SPEED)).toBe(8000);
    expect(clampToSignalRange(-500, ENGINE_SPEED)).toBe(0);
  });

  it("leaves a non-finite value alone rather than clamping it to a bound", () => {
    expect(clampToSignalRange(Number.NaN, ENGINE_SPEED)).toBe(Number.NaN);
  });
});
