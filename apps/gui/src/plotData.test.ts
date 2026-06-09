import { describe, expect, it } from "vitest";

import { decimatePoints, decodeSignalsSample, groupScaleRanges, mergeSeries, signalKey } from "./plotData";

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
    expect(signalKey(null, 256, false, "Speed")).not.toBe(
      signalKey(null, 256, true, "Speed"),
    );
    expect(signalKey(null, 256, false, "Speed")).toBe(
      signalKey(null, 256, false, "Speed"),
    );
  });
  it("distinguishes the same signal on different buses", () => {
    expect(signalKey("p", 256, false, "Speed")).not.toBe(
      signalKey("c", 256, false, "Speed"),
    );
    // The legacy "any bus" path is distinct from any specific bus.
    expect(signalKey(null, 256, false, "Speed")).not.toBe(
      signalKey("p", 256, false, "Speed"),
    );
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

describe("decodeSignalsSample", () => {
  /** Mirror of `lib.rs::encode_signals_sample` — same layout — so the
   * test exercises the round-trip the actual host ↔ JS path uses. */
  function encode(
    fromS: number | null,
    lastS: number | null,
    sliceMs: number,
    decodeMs: number,
    series: { t: number[]; v: number[] }[],
  ): ArrayBuffer {
    const totalPts = series.reduce((s, p) => s + p.t.length, 0);
    const buf = new ArrayBuffer(8 + 32 + 4 + series.length * 4 + totalPts * 16);
    const view = new DataView(buf);
    const magic = [0x53, 0x49, 0x47, 0x53, 0x41, 0x4d, 0x50, 0x01];
    for (let i = 0; i < 8; i++) view.setUint8(i, magic[i]);
    let off = 8;
    view.setFloat64(off, fromS ?? NaN, true);
    off += 8;
    view.setFloat64(off, lastS ?? NaN, true);
    off += 8;
    view.setFloat64(off, sliceMs, true);
    off += 8;
    view.setFloat64(off, decodeMs, true);
    off += 8;
    view.setUint32(off, series.length, true);
    off += 4;
    for (const p of series) {
      view.setUint32(off, p.t.length, true);
      off += 4;
      for (const t of p.t) {
        view.setFloat64(off, t, true);
        off += 8;
      }
      for (const v of p.v) {
        view.setFloat64(off, v, true);
        off += 8;
      }
    }
    return buf;
  }

  it("round-trips a multi-signal sample", () => {
    const buf = encode(10.5, 20.5, 1.2, 3.4, [
      { t: [10, 11, 12], v: [100, 200, 300] },
      { t: [10.5, 11.5], v: [-1.5, -2.5] },
      { t: [], v: [] },
    ]);
    const out = decodeSignalsSample(buf);
    expect(out.from_seconds).toBe(10.5);
    expect(out.last_seconds).toBe(20.5);
    expect(out.slice_ms).toBe(1.2);
    expect(out.decode_ms).toBe(3.4);
    expect(out.series).toHaveLength(3);
    expect(out.series[0].t).toEqual([10, 11, 12]);
    expect(out.series[0].v).toEqual([100, 200, 300]);
    expect(out.series[1].v).toEqual([-1.5, -2.5]);
    expect(out.series[2].t).toEqual([]);
  });

  it("translates NaN sentinels back to null for the optional anchors", () => {
    const buf = encode(null, null, 0, 0, []);
    const out = decodeSignalsSample(buf);
    expect(out.from_seconds).toBeNull();
    expect(out.last_seconds).toBeNull();
    expect(out.series).toEqual([]);
  });

  it("throws on a wrong magic header", () => {
    const buf = new ArrayBuffer(44);
    new DataView(buf).setUint32(0, 0xdeadbeef, true);
    expect(() => decodeSignalsSample(buf)).toThrow(/bad magic/);
  });
});

describe("groupScaleRanges", () => {
  const ranges = (entries: Array<[string, { lo: number; hi: number }]>) => new Map(entries);

  it("same-unit signals share the union of their ranges", () => {
    const out = groupScaleRanges(
      [
        { key: "v1", unit: "V" },
        { key: "v2", unit: "V" },
      ],
      ranges([
        ["v1", { lo: 0, hi: 5 }],
        ["v2", { lo: 3, hi: 12 }],
      ]),
    );
    expect(out.get("v1")).toEqual({ lo: 0, hi: 12 });
    expect(out.get("v2")).toEqual({ lo: 0, hi: 12 });
  });

  it("different units scale independently", () => {
    const out = groupScaleRanges(
      [
        { key: "v", unit: "V" },
        { key: "i", unit: "A" },
      ],
      ranges([
        ["v", { lo: 0, hi: 400 }],
        ["i", { lo: -5, hi: 5 }],
      ]),
    );
    expect(out.get("v")).toEqual({ lo: 0, hi: 400 });
    expect(out.get("i")).toEqual({ lo: -5, hi: 5 });
  });

  it("unitless signals do not share a scale with each other", () => {
    const out = groupScaleRanges(
      [
        { key: "a", unit: "" },
        { key: "b", unit: "" },
      ],
      ranges([
        ["a", { lo: 0, hi: 1 }],
        ["b", { lo: 0, hi: 1000 }],
      ]),
    );
    expect(out.get("a")).toEqual({ lo: 0, hi: 1 });
    expect(out.get("b")).toEqual({ lo: 0, hi: 1000 });
  });

  it("a signal with no observed range gets no entry and doesn't poison its group", () => {
    const out = groupScaleRanges(
      [
        { key: "v1", unit: "V" },
        { key: "v2", unit: "V" },
      ],
      ranges([["v1", { lo: 1, hi: 2 }]]),
    );
    expect(out.get("v1")).toEqual({ lo: 1, hi: 2 });
    expect(out.has("v2")).toBe(false);
  });

  it("returns copies — mutating an output range does not affect group mates", () => {
    const out = groupScaleRanges(
      [
        { key: "v1", unit: "V" },
        { key: "v2", unit: "V" },
      ],
      ranges([
        ["v1", { lo: 0, hi: 1 }],
        ["v2", { lo: 0, hi: 2 }],
      ]),
    );
    out.get("v1")!.hi = 99;
    expect(out.get("v2")).toEqual({ lo: 0, hi: 2 });
  });
});
