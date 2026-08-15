import { describe, expect, it } from "vitest";
import type uPlot from "uplot";

import {
  applyAutoPointFloor,
  AUTO_POINT_MARKER_FLOOR,
  capPointMarkers,
  laneSampleMarkerIndices,
  MAX_POINT_MARKERS,
  showPointsFromRaw,
  showPointsToUplot,
} from "./plotPoints";

/** Minimal stub shaped like the bit of a uPlot instance the filter reads:
 * one visible series with an `idxs` span. */
function fakeU(i0: number | null, i1: number | null): uPlot {
  return { series: [{}, { idxs: [i0, i1] }] } as unknown as uPlot;
}

describe("showPointsFromRaw", () => {
  it("keeps on/off and defaults everything else to auto", () => {
    expect(showPointsFromRaw("on")).toBe("on");
    expect(showPointsFromRaw("off")).toBe("off");
    expect(showPointsFromRaw("auto")).toBe("auto");
    expect(showPointsFromRaw(undefined)).toBe("auto");
    expect(showPointsFromRaw("garbage")).toBe("auto");
  });
});

describe("showPointsToUplot", () => {
  it("maps the tri-state to a uPlot points spec", () => {
    expect(showPointsToUplot("off")).toEqual({ show: false });
    expect(showPointsToUplot("auto")).toEqual({});
    const on = showPointsToUplot("on");
    expect(on.show).toBe(true);
    // `on` carries the thinning filter so it can't overdraw.
    expect(typeof on.filter).toBe("function");
  });
});

describe("capPointMarkers", () => {
  it("is a no-op when the in-view points already fit the cap", () => {
    // Right at the cap: every point is marked (null = draw all).
    expect(capPointMarkers(fakeU(0, MAX_POINT_MARKERS - 1), 1)).toBeNull();
  });

  it("strides down to the flat cap when dense, keeping the last point", () => {
    // 10× the cap visible → stride ≈ 10, output bounded by the cap.
    const last = MAX_POINT_MARKERS * 10 - 1;
    const out = capPointMarkers(fakeU(0, last), 1);
    expect(out).not.toBeNull();
    const idxs = out as number[];
    // Bounded by the cap (+1 for the forced last index).
    expect(idxs.length).toBeLessThanOrEqual(MAX_POINT_MARKERS + 1);
    expect(idxs.length).toBeGreaterThan(MAX_POINT_MARKERS / 2);
    // Strided from the first in-view index, last index forced in.
    expect(idxs[0]).toBe(0);
    expect(idxs[idxs.length - 1]).toBe(last);
    // Within the visible span and strictly ascending.
    expect(idxs.every((v, k) => v >= 0 && v <= last && (k === 0 || v > idxs[k - 1]))).toBe(true);
  });

  it("is independent of canvas width — a wider plot still caps at the max", () => {
    // The cap is flat: 100k visible points stride to ~MAX regardless.
    const out = capPointMarkers(fakeU(0, 100_000), 1) as number[];
    expect(out.length).toBeLessThanOrEqual(MAX_POINT_MARKERS + 1);
  });

  it("respects a non-zero start index", () => {
    const last = 200 + MAX_POINT_MARKERS * 4 - 1;
    const out = capPointMarkers(fakeU(200, last), 1) as number[];
    expect(out[0]).toBe(200);
    expect(out[out.length - 1]).toBe(last);
    expect(out.every((v) => v >= 200 && v <= last)).toBe(true);
  });

  it("returns null when the series has no visible range", () => {
    expect(capPointMarkers(fakeU(null, null), 1)).toBeNull();
    const noIdxs = { series: [{}, {}] } as unknown as uPlot;
    expect(capPointMarkers(noIdxs, 1)).toBeNull();
  });
});

describe("applyAutoPointFloor", () => {
  /// A series list shaped like a constructed uPlot's, with uPlot's own
  /// density answer standing in as a constant.
  type FakeSeries = { points?: { show?: uPlot.Series.Points["show"] } };
  const seriesWith = (dense: boolean, n = 2): FakeSeries[] => [
    {},
    ...Array.from({ length: n }, () => ({ points: { show: () => !dense } })),
  ];

  it("keeps markers on a series at or below the floor, however dense the axis", () => {
    const series = seriesWith(true);
    applyAutoPointFloor(series, () => AUTO_POINT_MARKER_FLOOR);
    const show = series[1].points!.show as (...a: unknown[]) => boolean;
    expect(show(null, 1, 0, 5000)).toBe(true);
  });

  it("defers to uPlot's own answer above the floor", () => {
    const series = seriesWith(true);
    applyAutoPointFloor(series, () => AUTO_POINT_MARKER_FLOOR + 1);
    const show = series[1].points!.show as (...a: unknown[]) => boolean;
    expect(show(null, 1, 0, 5000)).toBe(false);
    // …in both directions: a sparse-on-screen series still gets markers
    // from uPlot, which is what `auto` has always meant.
    const sparse = seriesWith(false);
    applyAutoPointFloor(sparse, () => AUTO_POINT_MARKER_FLOOR + 1);
    const sparseShow = sparse[1].points!.show as (...a: unknown[]) => boolean;
    expect(sparseShow(null, 1, 0, 3)).toBe(true);
  });

  it("asks per series, not once for the axis", () => {
    const series = seriesWith(true, 2);
    applyAutoPointFloor(series, (i) => (i === 1 ? 3 : 1000));
    const s1 = series[1].points!.show as (...a: unknown[]) => boolean;
    const s2 = series[2].points!.show as (...a: unknown[]) => boolean;
    expect(s1(null, 1, 0, 5000)).toBe(true);
    expect(s2(null, 2, 0, 5000)).toBe(false);
  });

  it("leaves the x series and a forced on/off series alone", () => {
    const series: FakeSeries[] = [
      {},
      { points: { show: true } },
      { points: { show: false } },
      {},
    ];
    applyAutoPointFloor(series, () => 1);
    expect(series[1].points!.show).toBe(true);
    expect(series[2].points!.show).toBe(false);
    expect(series[0]).toEqual({});
  });
});

describe("laneSampleMarkerIndices", () => {
  it("marks every served sample inside the view", () => {
    // The whole point: a lane's tiles show its transitions, so without
    // a marker per sample there is nothing on screen distinguishing a
    // state held through many samples from one held through none.
    expect(laneSampleMarkerIndices([0, 1, 2, 3, 4], 0, 4)).toEqual([0, 1, 2, 3, 4]);
  });

  it("drops samples outside the visible window", () => {
    // The serve is widened past the window by two boundary points a
    // side, and those sit off-canvas.
    expect(laneSampleMarkerIndices([0, 1, 2, 3, 4], 1, 3)).toEqual([1, 2, 3]);
    expect(laneSampleMarkerIndices([0, 1, 2], 5, 9)).toEqual([]);
    expect(laneSampleMarkerIndices([], 0, 9)).toEqual([]);
  });

  it("thins to the marker cap and always keeps the newest sample", () => {
    // A marker per sample costs the same on a lane as on a line, so the
    // same flat cap applies. The last in-view sample is kept whatever
    // the stride lands on, so a lane's leading edge is always marked —
    // it is the one position a reader is checking.
    const ts = Array.from({ length: 1234 }, (_, i) => i);
    const out = laneSampleMarkerIndices(ts, 0, 1233);
    expect(out.length).toBeLessThanOrEqual(MAX_POINT_MARKERS + 1);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(1233);
    // Evenly strided, so the thinning does not bunch the markers.
    expect(out[1] - out[0]).toBe(Math.ceil(1234 / MAX_POINT_MARKERS));
  });
});
