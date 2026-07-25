import { describe, expect, it } from "vitest";
import {
  type Band,
  laneBands,
  laneTileBand,
  laneValueRange,
  normalizeIntoLane,
} from "./plotEnumLanes";

const span = (b: Band) => b.hi - b.lo;

describe("laneBands", () => {
  it("degenerate counts: 0 → none, 1 → one non-empty band inside [0,1]", () => {
    expect(laneBands(0)).toEqual([]);
    const one = laneBands(1);
    expect(one).toHaveLength(1);
    expect(one[0].lo).toBeGreaterThanOrEqual(0);
    expect(one[0].hi).toBeLessThanOrEqual(1);
    expect(span(one[0])).toBeGreaterThan(0);
  });

  it("N lanes are top-first, ordered, non-overlapping, and inside [0,1]", () => {
    const bands = laneBands(3);
    expect(bands).toHaveLength(3);
    // Top-first: lane 0 is highest (largest hi), strictly descending.
    expect(bands[0].hi).toBeGreaterThan(bands[1].hi);
    expect(bands[1].hi).toBeGreaterThan(bands[2].hi);
    for (const b of bands) {
      expect(b.lo).toBeGreaterThanOrEqual(0);
      expect(b.hi).toBeLessThanOrEqual(1);
      expect(span(b)).toBeGreaterThan(0);
    }
    // Non-overlapping with a positive gap between adjacent lanes.
    expect(bands[0].lo).toBeGreaterThan(bands[1].hi);
    expect(bands[1].lo).toBeGreaterThan(bands[2].hi);
  });

  it("lanes are equal height", () => {
    const bands = laneBands(4);
    const h0 = span(bands[0]);
    for (const b of bands) expect(span(b)).toBeCloseTo(h0);
  });
});

describe("laneValueRange", () => {
  it("pads the table's raw min/max by half a code", () => {
    const r = laneValueRange([{ raw: 0 }, { raw: 3 }, { raw: 1 }]);
    expect(r.lo).toBeCloseTo(-0.5);
    expect(r.hi).toBeCloseTo(3.5);
  });

  it("a single-value table still has a non-zero span", () => {
    const r = laneValueRange([{ raw: 7 }]);
    expect(span(r)).toBeCloseTo(1);
    expect(r.lo).toBeCloseTo(6.5);
    expect(r.hi).toBeCloseTo(7.5);
  });

  it("an empty table falls back to a non-degenerate range", () => {
    expect(span(laneValueRange([]))).toBeGreaterThan(0);
  });
});

describe("normalizeIntoLane", () => {
  const range: Band = { lo: -0.5, hi: 2.5 };
  const band: Band = { lo: 0.2, hi: 0.4 };

  it("maps range endpoints onto the band endpoints", () => {
    expect(normalizeIntoLane(-0.5, range, band)).toBeCloseTo(0.2);
    expect(normalizeIntoLane(2.5, range, band)).toBeCloseTo(0.4);
  });

  it("maps the range midpoint to the band midpoint", () => {
    expect(normalizeIntoLane(1, range, band)).toBeCloseTo(0.3);
  });

  it("clamps values outside the range into the band", () => {
    expect(normalizeIntoLane(-10, range, band)).toBeCloseTo(0.2);
    expect(normalizeIntoLane(10, range, band)).toBeCloseTo(0.4);
  });

  it("a zero-width range maps to the band midpoint", () => {
    expect(normalizeIntoLane(5, { lo: 5, hi: 5 }, band)).toBeCloseTo(0.3);
  });
});

describe("laneTileBand", () => {
  const band: Band = { lo: 0.2, hi: 0.6 }; // 0.4 tall

  it("is centered within the lane and a fraction of its height", () => {
    const t = laneTileBand(band, 200, 0.5, 10);
    // 0.5 of a 0.4-tall lane → 0.2 tall, centered on 0.4.
    expect((t.lo + t.hi) / 2).toBeCloseTo(0.4);
    expect(span(t)).toBeCloseTo(0.2);
  });

  it("floors the tile at minPx worth of the lane", () => {
    // lane is 100px, tileFraction 0.1 → 10px < 40px floor → 40px = 0.4 of lane.
    const t = laneTileBand(band, 100, 0.1, 40);
    expect(span(t)).toBeCloseTo(0.4 * 0.4); // 0.4 of the 0.4-tall lane band
  });

  it("caps the tile at the full lane band", () => {
    const t = laneTileBand(band, 200, 5, 10);
    expect(t.lo).toBeCloseTo(band.lo);
    expect(t.hi).toBeCloseTo(band.hi);
  });
});
