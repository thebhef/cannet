import { describe, expect, it } from "vitest";
import {
  AXIS_MIN_PX,
  AXIS_WEIGHT_DEFAULT,
  applySplitterDelta,
  axisWeightsFromRaw,
  equalizePair,
  pruneAxisWeights,
  resolveAxisWeights,
} from "./plotAreaLayout";

describe("axisWeightsFromRaw", () => {
  it("non-object input → empty record", () => {
    expect(axisWeightsFromRaw(undefined)).toEqual({});
    expect(axisWeightsFromRaw(null)).toEqual({});
    expect(axisWeightsFromRaw(42)).toEqual({});
    expect(axisWeightsFromRaw("x")).toEqual({});
  });

  it("keeps only positive finite numeric entries", () => {
    const out = axisWeightsFromRaw({
      a: 2,
      b: 0.5,
      c: 0, // non-positive dropped
      d: -3, // negative dropped
      e: Number.NaN, // NaN dropped
      f: Number.POSITIVE_INFINITY, // infinite dropped
      g: "3", // wrong type dropped
    });
    expect(out).toEqual({ a: 2, b: 0.5 });
  });
});

describe("resolveAxisWeights", () => {
  it("fills every id, defaulting missing/invalid to the default", () => {
    const out = resolveAxisWeights(["x", "y", "z"], { x: 3, y: -1 });
    expect(out).toEqual({ x: 3, y: AXIS_WEIGHT_DEFAULT, z: AXIS_WEIGHT_DEFAULT });
  });

  it("ignores stored ids that are no longer live", () => {
    const out = resolveAxisWeights(["x"], { x: 2, stale: 9 });
    expect(out).toEqual({ x: 2 });
  });
});

describe("pruneAxisWeights", () => {
  it("drops entries whose id is not live", () => {
    expect(pruneAxisWeights({ a: 2, b: 3 }, ["a"])).toEqual({ a: 2 });
  });

  it("returns the same reference when nothing is removed", () => {
    const stored = { a: 2, b: 3 };
    expect(pruneAxisWeights(stored, ["a", "b"])).toBe(stored);
    expect(pruneAxisWeights(stored, ["a", "b", "c"])).toBe(stored);
  });
});

describe("applySplitterDelta", () => {
  // Two neighbours, weights proportional to their measured pixels
  // (the flex invariant the panel always satisfies).
  it("moves weight from below to above when dragged down, conserving the pair sum", () => {
    const w = { a: 1, b: 1 };
    // 200px each; drag the separator down 50px.
    const out = applySplitterDelta(w, "a", "b", 50, 200, 200);
    expect(out.a + out.b).toBeCloseTo(2);
    expect(out.a).toBeGreaterThan(1);
    expect(out.b).toBeLessThan(1);
    // 250/150 of the 400px pair → weights 1.25 / 0.75.
    expect(out.a).toBeCloseTo(1.25);
    expect(out.b).toBeCloseTo(0.75);
  });

  it("clamps so neither neighbour drops below AXIS_MIN_PX", () => {
    const w = { a: 1, b: 1 };
    // Drag far past b's floor; b pins at AXIS_MIN_PX.
    const out = applySplitterDelta(w, "a", "b", 1000, 200, 200);
    const pairW = out.a + out.b;
    expect(pairW).toBeCloseTo(2);
    // b at 48px of 400px pair → weight 48/400 * 2 = 0.24.
    expect(out.b).toBeCloseTo((AXIS_MIN_PX / 400) * 2);
  });

  it("returns the same reference on a zero-delta no-op", () => {
    const w = { a: 1, b: 1 };
    expect(applySplitterDelta(w, "a", "b", 0, 200, 200)).toBe(w);
  });

  it("returns the same reference when already pinned and pushed further", () => {
    const w = { a: 1, b: 1 };
    const pinned = applySplitterDelta(w, "a", "b", 1000, 200, 200);
    expect(applySplitterDelta(pinned, "a", "b", 1000, 352, 48)).toBe(pinned);
  });

  it("no-ops when the pair cannot fit two floors", () => {
    const w = { a: 1, b: 1 };
    expect(applySplitterDelta(w, "a", "b", 10, 40, 40)).toBe(w);
  });
});

describe("equalizePair", () => {
  it("sets both neighbours to their average, conserving the sum", () => {
    const out = equalizePair({ a: 3, b: 1, c: 5 }, "a", "b");
    expect(out).toEqual({ a: 2, b: 2, c: 5 });
  });

  it("returns the same reference when the pair is already equal", () => {
    const w = { a: 2, b: 2 };
    expect(equalizePair(w, "a", "b")).toBe(w);
  });
});
