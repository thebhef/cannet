import { describe, expect, it } from "vitest";

import {
  decodeSignalsSample,
  enumSegments,
  groupScaleRanges,
  mergeSeries,
  signalKey,
} from "./plotData";

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

describe("decodeSignalsSample", () => {
  /** Mirror of `lib.rs::encode_signals_sample` — same layout — so the
   * test exercises the round-trip the actual host ↔ JS path uses. */
  function encode(
    fromS: number | null,
    lastS: number | null,
    sliceMs: number,
    decodeMs: number,
    series: { t: number[]; v: number[] }[],
    complete = true,
  ): ArrayBuffer {
    const totalPts = series.reduce((s, p) => s + p.t.length, 0);
    const buf = new ArrayBuffer(8 + 32 + 8 + series.length * 4 + totalPts * 16);
    const view = new DataView(buf);
    const magic = [0x53, 0x49, 0x47, 0x53, 0x41, 0x4d, 0x50, 0x02];
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
    view.setUint32(off, complete ? 1 : 0, true);
    off += 4;
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
    expect(out.complete).toBe(true);
  });

  it("carries the host's completeness token", () => {
    // A serve is bounded in time, so a cold one answers with the prefix
    // it decoded and says so. The points look no different — the flag is
    // the only thing that distinguishes "this is the series" from "this
    // is the series so far", which is why it is on the wire at all.
    const partial = decodeSignalsSample(
      encode(0, 2, 0, 0, [{ t: [0, 1, 2], v: [1, 2, 3] }], false),
    );
    expect(partial.complete).toBe(false);
    expect(partial.series[0].v).toEqual([1, 2, 3]);
  });

  it("decodes f64 runs at non-8-aligned offsets (DataView-direct path)", () => {
    // A first signal with an odd point count pushes the *second*
    // signal's f64 run to a 4-byte- (not 8-byte-) aligned offset — the
    // case the dropped `buf.slice()` aligned-copy used to handle. The
    // `DataView.getFloat64` reads must decode it correctly without a copy.
    const buf = encode(0, 0, 0, 0, [
      { t: [1], v: [9] }, // 1 pt shifts the next run off 8-alignment
      { t: [2.25, 3.5, 4.75], v: [-2.25, -3.5, -4.75] },
    ]);
    const out = decodeSignalsSample(buf);
    expect(out.series[1].t).toEqual([2.25, 3.5, 4.75]);
    expect(out.series[1].v).toEqual([-2.25, -3.5, -4.75]);
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

  it("a group with no span gets a ±10 % minimum range around its value", () => {
    // A signal that never moves has a degenerate extent, and a group
    // made only of such signals has no span at all. Without a minimum
    // range it cannot be normalised, so it drew on the bare 0–1 canvas
    // with the trace on the midline — an axis that says nothing about
    // the value it holds.
    const out = groupScaleRanges([{ key: "i", unit: "A" }], ranges([["i", { lo: 3000, hi: 3000 }]]));
    expect(out.get("i")).toEqual({ lo: 2700, hi: 3300 });
  });

  it("the minimum range follows the sign of a negative constant", () => {
    const out = groupScaleRanges([{ key: "i", unit: "A" }], ranges([["i", { lo: -50, hi: -50 }]]));
    expect(out.get("i")).toEqual({ lo: -55, hi: -45 });
  });

  it("a constant at exactly zero falls back to an absolute ±1", () => {
    // A proportional band collapses at zero, so the fraction cannot be
    // the rule there.
    const out = groupScaleRanges([{ key: "i", unit: "A" }], ranges([["i", { lo: 0, hi: 0 }]]));
    expect(out.get("i")).toEqual({ lo: -1, hi: 1 });
  });

  it("a constant that shares its group with a moving signal keeps the plain union", () => {
    // The minimum range applies to the *group*, not to each member: a
    // union that already has a span is a measurement and is left alone.
    const out = groupScaleRanges(
      [
        { key: "nominal", unit: "A" },
        { key: "effective", unit: "A" },
      ],
      ranges([
        ["nominal", { lo: 3000, hi: 3000 }],
        ["effective", { lo: 400, hi: 500 }],
      ]),
    );
    expect(out.get("nominal")).toEqual({ lo: 400, hi: 3000 });
    expect(out.get("effective")).toEqual({ lo: 400, hi: 3000 });
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

describe("enumSegments", () => {
  it("returns empty for empty input", () => {
    expect(enumSegments([], [])).toEqual([]);
  });

  it("a single-segment series ends at its last sample (no next sample to step to)", () => {
    expect(enumSegments([0, 1, 2, 3], [1, 1, 1, 1])).toEqual([
      { t0: 0, tEnd: 3, v: 1 },
    ]);
  });

  it("a transition extends the prior segment's tEnd to the transition timestamp", () => {
    // 1 holds samples 0..3 (t=0..3); the value visibly switches at t=4
    // so the box reaches t=4, not t=3. Then 2 holds samples 4..6 and
    // ends at its last sample (no further transition).
    expect(enumSegments([0, 1, 2, 3, 4, 5, 6], [1, 1, 1, 1, 2, 2, 2])).toEqual([
      { t0: 0, tEnd: 4, v: 1 },
      { t0: 4, tEnd: 6, v: 2 },
    ]);
  });

  it("single-sample segments still mark the next transition as tEnd", () => {
    expect(enumSegments([0, 1, 2], [1, 2, 1])).toEqual([
      { t0: 0, tEnd: 1, v: 1 },
      { t0: 1, tEnd: 2, v: 2 },
      { t0: 2, tEnd: 2, v: 1 }, // last segment has no successor
    ]);
  });

  it("null samples break the run without emitting a label", () => {
    // A gap should not get a labelled box; the segments on either side
    // do. The held value's tEnd reaches the gap's first timestamp
    // (where the held value visually stops).
    expect(enumSegments([0, 1, 2, 3], [1, null, null, 2])).toEqual([
      { t0: 0, tEnd: 1, v: 1 },
      { t0: 3, tEnd: 3, v: 2 },
    ]);
  });

  it("tolerates mismatched array lengths by walking the shorter one", () => {
    // Defensive: the renderer reads u.data[0] and u.data[1] which
    // should always align, but a corrupt frame shouldn't crash.
    expect(enumSegments([0, 1, 2, 3], [1, 1])).toEqual([{ t0: 0, tEnd: 1, v: 1 }]);
  });
});
