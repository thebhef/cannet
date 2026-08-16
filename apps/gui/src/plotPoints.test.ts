import { describe, expect, it } from "vitest";
import type uPlot from "uplot";

import {
  applyAutoPointFloor,
  applySampleMarkerFilter,
  AUTO_POINT_MARKER_FLOOR,
  hoverMarkerColumn,
  MAX_POINT_MARKERS,
  sampleMarkerColumns,
  showPointsFromRaw,
  showPointsToUplot,
} from "./plotPoints";

/** Minimal stub shaped like the bit of a uPlot instance the filter
 * reads: the merged x column grid and the visible x range. */
function fakeU(xs: number[], from = -Infinity, to = Infinity): uPlot {
  return { data: [xs], scales: { x: { min: from, max: to } } } as unknown as uPlot;
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
    // *Which* columns are marked is not this function's call — one
    // filter, installed on the instance, answers that for every mode.
    expect(on.filter).toBeUndefined();
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


describe("sampleMarkerColumns", () => {
  // `columns` are the merged columns the series has a *sample* at — the
  // only columns a marker may sit on. Here the grid is twice as dense as
  // the series, which is what any shared axis looks like.
  const xs = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
  const own = [0, 2, 4, 6, 8];

  it("marks every one of the series' own samples inside the view", () => {
    // The whole point: a marker per reading, and none anywhere else.
    expect(sampleMarkerColumns(own, xs, 0, 4)).toEqual(own);
  });

  it("marks nothing at a column the series is merely held across", () => {
    // The held columns (1, 3, 5, 7) are the neighbour's readings, and on
    // a stopped or stalled series they are the *only* thing out there.
    expect(sampleMarkerColumns(own, xs, 0, 4).some((c) => c % 2 === 1)).toBe(false);
    expect(sampleMarkerColumns([], xs, 0, 4)).toEqual([]);
  });

  it("drops samples outside the visible window", () => {
    // The serve is widened past the window by a couple of boundary
    // points a side, and those sit off-canvas.
    expect(sampleMarkerColumns(own, xs, 1, 3)).toEqual([2, 4, 6]);
    expect(sampleMarkerColumns(own, xs, 9, 10)).toEqual([]);
  });

  it("thins to the marker cap and always keeps the newest sample", () => {
    // A marker per sample costs the same here as it ever did, so the
    // same flat cap applies. The last in-view sample is kept whatever
    // the stride lands on, so a series' leading edge is always marked —
    // it is the one position a reader is checking.
    const grid = Array.from({ length: 2468 }, (_, i) => i / 2);
    const cols = Array.from({ length: 1234 }, (_, i) => i * 2);
    const out = sampleMarkerColumns(cols, grid, 0, 1233);
    expect(out.length).toBeLessThanOrEqual(MAX_POINT_MARKERS + 1);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(2466);
    // Evenly strided, so the thinning does not bunch the markers.
    expect(out[1] - out[0]).toBe(2 * Math.ceil(1234 / MAX_POINT_MARKERS));
  });
});

describe("applySampleMarkerFilter", () => {
  type FakeSeries = { points?: { filter?: uPlot.Series.Points["filter"] } };
  const seriesWith = (n = 2): FakeSeries[] => [
    {},
    ...Array.from({ length: n }, () => ({ points: {} as { filter?: uPlot.Series.Points["filter"] } })),
  ];
  const call = (s: FakeSeries, u: uPlot, idx: number, show: boolean) => {
    const f = s.points!.filter;
    return typeof f === "function" ? f(u, idx, show, null) : f;
  };

  it("hands uPlot the series' own sample columns", () => {
    const series = seriesWith();
    applySampleMarkerFilter(series, (i) => (i === 1 ? [0, 2] : [1]));
    const u = fakeU([0, 1, 2]);
    expect(call(series[1], u, 1, true)).toEqual([0, 2]);
    expect(call(series[2], u, 2, true)).toEqual([1]);
  });

  it("returns nothing when uPlot's own rule said not to draw", () => {
    // `drawSeries` draws the point layer when `show || idxs`, so an
    // index list returned under a false `show` would resurrect the
    // markers `off` — or the density rule under `auto` — turned down.
    const series = seriesWith(1);
    applySampleMarkerFilter(series, () => [0, 1]);
    expect(call(series[1], fakeU([0, 1]), 1, false)).toBeNull();
  });

  it("reads the columns per draw, not once at install", () => {
    // A fetch changes a series' samples without rebuilding the instance.
    let cols = [0];
    const series = seriesWith(1);
    applySampleMarkerFilter(series, () => cols);
    const u = fakeU([0, 1, 2]);
    expect(call(series[1], u, 1, true)).toEqual([0]);
    cols = [0, 1, 2];
    expect(call(series[1], u, 1, true)).toEqual([0, 1, 2]);
  });

  it("leaves the x series alone and skips a series with no points spec", () => {
    const series: FakeSeries[] = [{}, {}, { points: {} }];
    applySampleMarkerFilter(series, () => [0]);
    expect(series[0]).toEqual({});
    expect(series[1]).toEqual({});
    expect(typeof series[2].points!.filter).toBe("function");
  });
});

describe("hoverMarkerColumn", () => {
  // The merged grid a hover lands on carries every series' columns; the
  // answer must come from the hovered series' own ones. `xs` here is
  // that grid, `columns` the subset one series has a sample at.
  const xs = [0, 0.5, 1, 1.5, 2, 2.5, 3];
  const mine = [0, 2, 6]; // t = 0, 1 and 3

  it("takes the nearest of the series' own sample columns", () => {
    expect(hoverMarkerColumn(mine, xs, 0.9)).toBe(2);
    expect(hoverMarkerColumn(mine, xs, 1.4)).toBe(2);
    expect(hoverMarkerColumn(mine, xs, 2.4)).toBe(6);
  });

  it("answers past both ends rather than going blank", () => {
    // A pointer beyond a series' last sample is the stopped-series case:
    // the marker stays on the last reading while the pointer moves on,
    // which is what the dashed stretch between them is saying.
    expect(hoverMarkerColumn(mine, xs, -5)).toBe(0);
    expect(hoverMarkerColumn(mine, xs, 99)).toBe(6);
  });

  it("has nothing to answer with for a series that has no samples", () => {
    expect(hoverMarkerColumn([], xs, 1)).toBeNull();
    expect(hoverMarkerColumn(mine, xs, Number.NaN)).toBeNull();
  });

  it("is not a function of the columns the series does not own", () => {
    // The falsifiable half: the same hover over the same grid gives a
    // different column for a different series, so nothing here can be
    // reading the grid alone.
    expect(hoverMarkerColumn([1, 3, 5], xs, 0.9)).toBe(1);
    expect(hoverMarkerColumn(mine, xs, 0.9)).toBe(2);
  });
});
