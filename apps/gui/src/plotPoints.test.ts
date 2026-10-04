import { describe, expect, it } from "vitest";
import type uPlot from "uplot";

import {
  applyAutoPointFloor,
  applySampleMarkerFilter,
  AUTO_POINT_MARKER_FLOOR,
  collapseMarkerSquares,
  hoverMarkerColumn,
  sampleMarkerColumns,
  setShowPointsOverride,
  showPointsFromRaw,
  showPointsOverride,
  showPointsToUplot,
  squareMarkerPaths,
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
    expect(showPointsToUplot("off")).toMatchObject({ show: false, width: 0 });
    expect(showPointsToUplot("auto").show).toBeUndefined();
    const on = showPointsToUplot("on");
    expect(on.show).toBe(true);
    // *Which* columns are marked is not this function's call — one
    // filter, installed on the instance, answers that for every mode.
    expect(on.filter).toBeUndefined();
  });

  it("asks for a fill-only marker in every mode", () => {
    // uPlot builds the marker path fresh on every repaint and then
    // fills *and* strokes it; at width 0 its path builder hands back no
    // stroke path, so the second pass over every marker of every series
    // is skipped. The drawn size is unchanged — the radius is
    // `(size - width) / 2` — so this is ink saved, not size.
    for (const mode of ["auto", "off", "on"] as const) {
      expect(showPointsToUplot(mode).width).toBe(0);
    }
  });

  it("builds the marker path itself in every mode", () => {
    // The other half of the same cost: uPlot's own builder puts a
    // `moveTo` and an `arc` per marker into the path it rebuilds every
    // repaint. Ours puts one pixel-snapped `rect`, after collapsing the
    // markers that would paint the same pixels twice.
    for (const mode of ["auto", "off", "on"] as const) {
      expect(showPointsToUplot(mode).paths).toBe(squareMarkerPaths);
    }
  });
});

describe("showPointsOverride", () => {
  it("is unset until a launch arms it, and clears back to unset", () => {
    // The ordinary launch reads `null` and every panel keeps its own
    // mode; a measurement run pins one for the process without the
    // project ever learning about it.
    expect(showPointsOverride()).toBeNull();
    setShowPointsOverride("on");
    expect(showPointsOverride()).toBe("on");
    setShowPointsOverride(null);
    expect(showPointsOverride()).toBeNull();
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

  it("marks every sample of a long series, with no cap and no stride", () => {
    // The `Points: On` defect in miniature. A flat 500-marker cap used
    // to thin this to an even stride, which aliases onto one leg of a
    // min/max envelope — a run of dots hugging one side of a line that
    // oscillates through both, which reads as extrapolation. There is
    // no cap: every served sample in view carries a marker.
    const grid = Array.from({ length: 2468 }, (_, i) => i / 2);
    const cols = Array.from({ length: 1234 }, (_, i) => i * 2);
    const out = sampleMarkerColumns(cols, grid, 0, 1233);
    expect(out).toEqual(cols);
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

describe("collapseMarkerSquares", () => {
  // Flat `[x0, y0, x1, y1, …]` in, flat `[left0, top0, …]` out — one
  // allocation per repaint each way rather than one per marker. The
  // tests read as tables of pairs; these two turn them.
  const centres = (...pts: readonly (readonly [number, number])[]): number[] =>
    pts.flatMap(([x, y]) => [x, y]);
  const corners = (flat: readonly number[]): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  };
  const SIDE = 5;

  it("draws a held column's four served points once", () => {
    // The serve gives a pixel column its first, last, min and max
    // sample. On a held signal those are the same value, so they land on
    // the same device pixel and four squares would be painted exactly on
    // top of each other.
    const held = centres([100, 200], [100, 200], [100, 200], [100, 200]);
    expect(corners(collapseMarkerSquares(held, SIDE))).toEqual([[98, 198]]);
  });

  it("draws a noisy column twice — its min and its max, each on a sample", () => {
    // Same four points on a column the signal swings across: the first
    // and last samples sit within a marker's side of the extreme they
    // are nearest, so they are already covered; the two extremes are
    // not, and both are drawn.
    const noisy = centres([100, 202], [100, 200], [100, 260], [100, 258]);
    expect(corners(collapseMarkerSquares(noisy, SIDE))).toEqual([
      [98, 200],
      [98, 258],
    ]);
  });

  it("never collapses across pixel columns, however close the extremes", () => {
    // The falsifiable half of the rule above: the collapse is scoped to
    // one device-pixel column. Two neighbouring columns whose extremes
    // are a single pixel apart overlap as squares, and still draw twice
    // — collapsing them would be thinning, and thinning is what left a
    // column's extreme bare.
    const adjacent = centres([100, 200], [101, 201]);
    expect(corners(collapseMarkerSquares(adjacent, SIDE))).toEqual([
      [98, 198],
      [99, 199],
    ]);
  });

  it("marks every sample of a series sparser than the columns it is drawn on", () => {
    // No two of these share a column, so nothing is collapsed: a slow
    // signal keeps one marker per reading, which is the whole point of
    // `Points: On` for it.
    const sparse = centres([100, 200], [140, 210], [180, 190], [220, 250], [260, 205]);
    expect(corners(collapseMarkerSquares(sparse, SIDE))).toEqual([
      [98, 198],
      [138, 208],
      [178, 188],
      [218, 248],
      [258, 203],
    ]);
  });

  it("snaps every corner to an integer device pixel", () => {
    // A rect on a fractional boundary is anti-aliased along all four
    // edges — the cost the disc was paying at every marker. Integer
    // corners plus an integer side put the square on whole pixels.
    const fractional = centres([100.4, 200.6], [140.5, 210.2]);
    for (const [x, y] of corners(collapseMarkerSquares(fractional, SIDE))) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    }
  });

  it("has nothing to draw for a series with no visible samples", () => {
    expect(collapseMarkerSquares([], SIDE)).toEqual([]);
  });
});
