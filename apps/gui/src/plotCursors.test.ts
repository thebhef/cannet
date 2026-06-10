import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEASUREMENTS,
  MEASUREMENT_QUANTITIES,
  centerWindowOn,
  indexAtOrBefore,
  isMeasurementKey,
  statsOver,
  valueAt,
} from "./plotCursors";

describe("indexAtOrBefore", () => {
  const t = [1, 3, 5, 7, 9];
  it("returns -1 before the first sample / when empty", () => {
    expect(indexAtOrBefore(t, 0)).toBe(-1);
    expect(indexAtOrBefore([], 5)).toBe(-1);
  });
  it("returns the index of the last sample <= x", () => {
    expect(indexAtOrBefore(t, 1)).toBe(0);
    expect(indexAtOrBefore(t, 4)).toBe(1);
    expect(indexAtOrBefore(t, 5)).toBe(2);
    expect(indexAtOrBefore(t, 100)).toBe(4);
  });
});

describe("valueAt", () => {
  const s = { t: [1, 3, 5], v: [10, 30, 50] };
  it("sample-and-holds", () => {
    expect(valueAt(s, 1)).toBe(10);
    expect(valueAt(s, 2)).toBe(10);
    expect(valueAt(s, 3)).toBe(30);
    expect(valueAt(s, 4.9)).toBe(30);
    expect(valueAt(s, 5)).toBe(50);
    expect(valueAt(s, 6)).toBe(50);
  });
  it("is null before the first sample / empty", () => {
    expect(valueAt(s, 0)).toBeNull();
    expect(valueAt({ t: [], v: [] }, 1)).toBeNull();
  });
});

describe("statsOver", () => {
  const s = { t: [0, 1, 2, 3, 4], v: [5, 1, 9, 3, 7] };
  it("computes min/max/mean/count over an inclusive span (order-insensitive)", () => {
    // [1, 3]: samples at t=1(1), t=2(9), t=3(3)
    const a = statsOver(s, 1, 3);
    expect(a.count).toBe(3);
    expect(a.min).toBe(1);
    expect(a.max).toBe(9);
    expect(a.mean).toBeCloseTo((1 + 9 + 3) / 3);
    expect(statsOver(s, 3, 1)).toEqual(a);
  });
  it("includes endpoints that fall exactly on samples", () => {
    const a = statsOver(s, 0, 0);
    expect(a).toEqual({ count: 1, min: 5, max: 5, mean: 5 });
  });
  it("returns empty stats when the span contains no samples", () => {
    expect(statsOver(s, 10, 20)).toEqual({ count: 0, min: null, max: null, mean: null });
    expect(statsOver(s, 1.1, 1.9)).toEqual({ count: 0, min: null, max: null, mean: null });
  });
});

describe("centerWindowOn", () => {
  it("preserves the current window width and centres on t", () => {
    expect(centerWindowOn(50, { min: 40, max: 60 }, 5)).toEqual([40, 60]);
    expect(centerWindowOn(100, { min: 10, max: 30 }, 5)).toEqual([90, 110]);
  });
  it("falls back to defaultWidth when current window is unset/degenerate", () => {
    expect(centerWindowOn(10, { min: null, max: null }, 4)).toEqual([8, 12]);
    expect(centerWindowOn(10, { min: 5, max: 5 }, 4)).toEqual([8, 12]);
  });
  it("clamps the left edge to >= 0 (preserves width by sliding right)", () => {
    expect(centerWindowOn(1, { min: 0, max: 10 }, 5)).toEqual([0, 10]);
    expect(centerWindowOn(-2, { min: 0, max: 4 }, 5)).toEqual([0, 4]);
  });
});

describe("measurement quantities", () => {
  it("default selection is all valid keys", () => {
    for (const k of DEFAULT_MEASUREMENTS) expect(isMeasurementKey(k)).toBe(true);
  });
  it("isMeasurementKey rejects unknowns", () => {
    expect(isMeasurementKey("nope")).toBe(false);
    expect(isMeasurementKey(42)).toBe(false);
    expect(isMeasurementKey(MEASUREMENT_QUANTITIES[0].key)).toBe(true);
  });
});
