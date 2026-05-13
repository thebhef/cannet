import { describe, expect, it } from "vitest";

import { decimatePoints, mergeSeries, signalKey } from "./plotData";

describe("mergeSeries", () => {
  it("returns an empty data set with no series", () => {
    expect(mergeSeries([])).toEqual([[]]);
  });

  it("uses each series' own timestamps when aligned", () => {
    const merged = mergeSeries([{ t: [1, 2, 3], v: [10, 20, 30] }]);
    expect(merged).toEqual([
      [1, 2, 3],
      [10, 20, 30],
    ]);
  });

  it("builds the sorted union of timestamps and sample-and-holds", () => {
    // A samples at 1 and 3; B samples at 2 and 4.
    const merged = mergeSeries([
      { t: [1, 3], v: [10, 30] },
      { t: [2, 4], v: [200, 400] },
    ]);
    expect(merged[0]).toEqual([1, 2, 3, 4]);
    // A: 10 at t=1, still 10 at t=2, 30 at t=3, still 30 at t=4
    expect(merged[1]).toEqual([10, 10, 30, 30]);
    // B: null before its first sample (t=1), 200 at t=2, still 200 at t=3, 400 at t=4
    expect(merged[2]).toEqual([null, 200, 200, 400]);
  });

  it("dedupes shared timestamps", () => {
    const merged = mergeSeries([
      { t: [1, 2], v: [1, 2] },
      { t: [1, 2], v: [9, 8] },
    ]);
    expect(merged[0]).toEqual([1, 2]);
    expect(merged[1]).toEqual([1, 2]);
    expect(merged[2]).toEqual([9, 8]);
  });
});

describe("signalKey", () => {
  it("distinguishes standard and extended ids", () => {
    expect(signalKey(256, false, "Speed")).not.toBe(signalKey(256, true, "Speed"));
    expect(signalKey(256, false, "Speed")).toBe(signalKey(256, false, "Speed"));
  });
});

describe("decimatePoints", () => {
  it("returns a copy unchanged when it already fits (or decimation off)", () => {
    expect(decimatePoints([1, 2, 3], [4, 5, 6], 10)).toEqual({ t: [1, 2, 3], v: [4, 5, 6] });
    expect(decimatePoints([1, 2, 3], [4, 5, 6], 0)).toEqual({ t: [1, 2, 3], v: [4, 5, 6] });
  });

  it("keeps each bucket's min and max value in time order", () => {
    // 6 points, 3 buckets of 2: [4,1] -> max@0,min@1 -> emit 1 then 4? no: time
    // order = index order, so emit index 0 (4) then index 1 (1). bucket [9,2] ->
    // emit 9 then 2. bucket [5,5] -> single point.
    const { t, v } = decimatePoints([0, 1, 2, 3, 4, 5], [4, 1, 9, 2, 5, 5], 3);
    expect(t).toEqual([0, 1, 2, 3, 4]);
    expect(v).toEqual([4, 1, 9, 2, 5]);
  });

  it("bounds the output to at most 2*maxBuckets points", () => {
    const n = 1000;
    const t = Array.from({ length: n }, (_, i) => i);
    const v = Array.from({ length: n }, (_, i) => Math.sin(i));
    const out = decimatePoints(t, v, 50);
    expect(out.t.length).toBeLessThanOrEqual(100);
    expect(out.t.length).toBeGreaterThan(0);
    expect(out.t).toEqual([...out.t].sort((a, b) => a - b));
  });
});
