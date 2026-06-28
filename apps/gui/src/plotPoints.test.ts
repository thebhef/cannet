import { describe, expect, it } from "vitest";
import type uPlot from "uplot";

import { capPointMarkers, MAX_POINT_MARKERS, showPointsFromRaw, showPointsToUplot } from "./plotPoints";

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
