// The canvas half of the extrapolation rendering (ADR 0026), driven
// against a recording 2D context.
//
// `PlotPanel.dom.test.tsx` mocks uPlot to a stub with no canvas at all,
// so everything the draw hook paints has always been out of its reach —
// the fill, the tiles, the dashes. That is fine for what it does pin
// (the data uPlot is handed), but it leaves the styling untested, and
// the styling is the whole of this feature: a stretch that is blanked
// out of the stroke and then not re-drawn has been *deleted*, not
// labelled. So the two draw functions are exercised directly here, with
// a recorder standing in for the context and a hand-rolled uPlot whose
// only real job is a linear `valToPos`.

import { describe, expect, it, vi } from "vitest";
import type uPlot from "uplot";

import { drawEnumTiles, drawExtrapolatedSegments } from "./PlotArea";
import { mergeSeries, sampleColumns, splitExtrapolatedRows } from "./plotData";
import { EXTRAPOLATION_STRIPE_PERIOD_PX } from "./plotEnumLanes";
import { applySampleMarkerFilter } from "./plotPoints";
import { setActiveTheme, theme, type ThemeName } from "./theme";

/** One recorded canvas operation. */
type Op = {
  op: string;
  args: unknown[];
  dash: number[];
  stroke: string;
  fill: string;
  lineWidth: number;
};

/** A 2D context that records the calls that put ink on the canvas,
 * carrying the style state each one was made under — a dash set and
 * then reset two calls later tells you nothing unless you know which
 * stroke it was in force for. */
function recorder() {
  const ops: Op[] = [];
  const state = {
    dash: [] as number[],
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    font: "10px mono",
    shadowColor: "",
    shadowBlur: 0,
    textAlign: "left",
    textBaseline: "middle",
  };
  const saved: (typeof state)[] = [];
  const push = (op: string, ...args: unknown[]) =>
    ops.push({
      op,
      args,
      dash: [...state.dash],
      stroke: state.strokeStyle,
      fill: state.fillStyle,
      lineWidth: state.lineWidth,
    });
  const ctx = {
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get shadowColor() {
      return state.shadowColor;
    },
    set shadowColor(v: string) {
      state.shadowColor = v;
    },
    get shadowBlur() {
      return state.shadowBlur;
    },
    set shadowBlur(v: number) {
      state.shadowBlur = v;
    },
    font: state.font,
    textAlign: state.textAlign,
    textBaseline: state.textBaseline,
    setLineDash: (d: number[]) => {
      state.dash = [...d];
    },
    save: () => saved.push({ ...state }),
    restore: () => {
      const s = saved.pop();
      if (s) Object.assign(state, s);
    },
    beginPath: () => push("beginPath"),
    moveTo: (x: number, y: number) => push("moveTo", x, y),
    lineTo: (x: number, y: number) => push("lineTo", x, y),
    rect: (...a: number[]) => push("rect", ...a),
    clip: () => push("clip"),
    stroke: () => push("stroke"),
    fillRect: (...a: number[]) => push("fillRect", ...a),
    strokeRect: (...a: number[]) => push("strokeRect", ...a),
    fillText: (t: string, x: number, y: number) => {
      ops.push({
        op: "fillText",
        args: [t, x, y],
        dash: [...state.dash],
        stroke: state.strokeStyle,
        lineWidth: state.lineWidth,
        // Recorded specially: a shadow pass is the same `fillText` with
        // a shadow set, so the shadow is the only thing telling the
        // passes apart from the final one.
        fill: state.shadowColor ? `shadow:${state.shadowColor}` : state.fillStyle,
      });
    },
    measureText: (t: string) => ({ width: 6 * t.length }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops, state };
}

/** A uPlot stand-in with a linear `valToPos` (1 unit = 10 px in x,
 * y inverted over a 100 px box) so pixel assertions read as times. */
function fakeU(
  data: (number | (number | null)[])[],
  series: { show?: boolean; width?: number }[],
): uPlot {
  return {
    data,
    series: [{}, ...series],
    scales: { x: { min: -Infinity, max: Infinity } },
    valToPos: (v: number, axis: string) => (axis === "x" ? v * 10 : 100 - v),
  } as unknown as uPlot;
}

describe("drawExtrapolatedSegments", () => {
  it("re-strokes a blanked stretch dashed, in the series' own color and width", () => {
    // The stretch was blanked out of the row so uPlot's stroke stopped
    // at the data; this puts it back. Same color and width as the solid
    // half — the dash is the only difference, because the claim is
    // "this is the same series, drawn without data", not "this is
    // something else".
    const { ctx, ops } = recorder();
    const u = fakeU([[0, 1, 2, 3], [5, 6, null, null]], [{ width: 2 }]);
    drawExtrapolatedSegments(ctx, u, {
      segments: [[{ i0: 1, i1: 3 }]],
      signals: [{}],
      color: () => "#abcdef",
      ratio: 1,
    });
    const strokes = ops.filter((o) => o.op === "stroke");
    expect(strokes).toHaveLength(1);
    expect(strokes[0].dash).toEqual([6, 4]);
    expect(strokes[0].stroke).toBe("#abcdef");
    const move = ops.find((o) => o.op === "moveTo");
    const line = ops.find((o) => o.op === "lineTo");
    // From the last sample (x = 1 → 10 px, y = 6 → 94) out to the last
    // column (x = 3 → 30 px), **flat**: the far column carries no value,
    // which is what a past-the-end tail looks like.
    expect(move?.args).toEqual([10, 94]);
    expect(line?.args).toEqual([30, 94]);
  });

  it("scales the dash with the canvas pixel ratio", () => {
    // A hi-dpi canvas is drawn in device pixels, so a literal [6, 4]
    // would come out half-length on a 2× display.
    const { ctx, ops } = recorder();
    drawExtrapolatedSegments(ctx, fakeU([[0, 1], [5, null]], [{}]), {
      segments: [[{ i0: 0, i1: 1 }]],
      signals: [{}],
      color: () => "#fff",
      ratio: 2,
    });
    expect(ops.find((o) => o.op === "stroke")?.dash).toEqual([12, 8]);
  });

  it("draws nothing for a hidden series", () => {
    const { ctx, ops } = recorder();
    drawExtrapolatedSegments(ctx, fakeU([[0, 1], [5, null]], [{}]), {
      segments: [[{ i0: 0, i1: 1 }]],
      signals: [{ hidden: true }],
      color: () => "#fff",
      ratio: 1,
    });
    expect(ops.filter((o) => o.op === "stroke")).toHaveLength(0);
  });

  it("holds a tail at its last value rather than falling to zero", () => {
    // `??`, not `||`: a series holding 0 has a value, and treating it as
    // absent would draw the tail from 0 down to the axis floor.
    const { ctx, ops } = recorder();
    drawExtrapolatedSegments(ctx, fakeU([[0, 1], [0, null]], [{}]), {
      segments: [[{ i0: 0, i1: 1 }]],
      signals: [{}],
      color: () => "#fff",
      ratio: 1,
    });
    expect(ops.find((o) => o.op === "moveTo")?.args).toEqual([0, 100]);
    expect(ops.find((o) => o.op === "lineTo")?.args).toEqual([10, 100]);
  });
});

describe("drawEnumTiles extrapolation hatching", () => {
  const TABLE = [
    { raw: 0, label: "Idle" },
    { raw: 1, label: "Run" },
  ];

  function tileOpts(over: Record<string, unknown> = {}) {
    return {
      seriesIdx: 1,
      table: TABLE,
      target: null,
      resolveColor: vi.fn(),
      bandTop: 40,
      bandBot: 60,
      accent: "#ff0000",
      left: 0,
      width: 1000,
      ratio: 1,
      ...over,
    };
  }

  it("keeps the stale tile and hatches it instead of deleting it", () => {
    // A lane's held state is information whether or not the signal is
    // still arriving. Blanking the row the way a line's is would end the
    // run at the `null` and take the tile with it.
    const { ctx, ops } = recorder();
    const u = fakeU([[0, 10], [0, 0]], [{}]);
    drawEnumTiles(ctx, u, tileOpts({ extrapolated: [[4, 10] as const] }));
    // The tile itself still drew, full width.
    const fills = ops.filter((o) => o.op === "fillRect");
    expect(fills).toHaveLength(1);
    expect(fills[0].args).toEqual([0, 40, 100, 20]);
    // And the hatching landed, in the app background color.
    const hatch = ops.filter((o) => o.op === "stroke");
    expect(hatch).toHaveLength(1);
    expect(hatch[0].stroke).toBe(theme().background);
  });

  it("clips the hatching to the stale sub-stretch of a partly-stale tile", () => {
    const { ctx, ops } = recorder();
    const u = fakeU([[0, 10], [0, 0]], [{}]);
    drawEnumTiles(ctx, u, tileOpts({ extrapolated: [[4, 10] as const] }));
    // One clip rect, covering x = 4..10 (40..100 px) and the band —
    // not the whole tile, which starts at 0.
    const rects = ops.filter((o) => o.op === "rect");
    const clipRect = rects[rects.length - 1];
    expect(clipRect?.args).toEqual([40, 40, 60, 20]);
  });

  it("hatches at the ruling's period with exactly even bands", () => {
    const { ctx, ops } = recorder();
    const u = fakeU([[0, 10], [0, 0]], [{}]);
    drawEnumTiles(ctx, u, tileOpts({ extrapolated: [[0, 10] as const] }));
    const moves = ops.filter((o) => o.op === "moveTo");
    expect(moves.length).toBeGreaterThan(1);
    const starts = moves.map((o) => o.args[0] as number);
    expect(starts[1] - starts[0]).toBeCloseTo(EXTRAPOLATION_STRIPE_PERIOD_PX, 9);
    // Read off the stroke itself: the hatch block restores the context
    // afterwards, so the width is only observable while it is in force.
    const hatch = ops.find((o) => o.op === "stroke");
    expect(hatch?.lineWidth).toBeCloseTo(EXTRAPOLATION_STRIPE_PERIOD_PX / (2 * Math.SQRT2), 9);
  });

  it("draws no hatching on a tile the host did not flag", () => {
    const { ctx, ops } = recorder();
    const u = fakeU([[0, 10], [0, 0]], [{}]);
    drawEnumTiles(ctx, u, tileOpts({ extrapolated: [] }));
    expect(ops.filter((o) => o.op === "stroke")).toHaveLength(0);
    expect(ops.filter((o) => o.op === "fillRect")).toHaveLength(1);
  });

  it("halos a label that sits over hatching, and only then", () => {
    // The stripes are drawn in the background color and cut straight
    // through the glyphs, so a label over them needs a halo of the same
    // color. A label over a data-backed tile has nothing to be rescued
    // from and gets none.
    const striped = recorder();
    drawEnumTiles(
      striped.ctx,
      fakeU([[0, 10], [0, 0]], [{}]),
      tileOpts({ extrapolated: [[0, 10] as const] }),
    );
    const clean = recorder();
    drawEnumTiles(clean.ctx, fakeU([[0, 10], [0, 0]], [{}]), tileOpts({ extrapolated: [] }));

    const shadowPasses = (ops: Op[]) =>
      ops.filter((o) => o.op === "fillText" && String(o.fill).startsWith("shadow:")).length;
    const plainPasses = (ops: Op[]) =>
      ops.filter((o) => o.op === "fillText" && !String(o.fill).startsWith("shadow:")).length;

    expect(shadowPasses(clean.ops)).toBe(0);
    expect(plainPasses(clean.ops)).toBe(1);
    expect(shadowPasses(striped.ops)).toBe(theme().laneLabelShadowPasses);
    // The visible glyph is still drawn once on top, in the accent color.
    expect(plainPasses(striped.ops)).toBe(1);
    const texts = striped.ops.filter((o) => o.op === "fillText");
    expect(texts[texts.length - 1].fill).toBe("#ff0000");
  });

  it("marks every served sample, over the tiles rather than under them", () => {
    // The tiles are 65-75 % opaque and sit in front of the line by
    // design, so a marker drawn before them is a marker nobody sees.
    // Order is the whole assertion: every marker's fillRect comes after
    // the tile's.
    const { ctx, ops } = recorder();
    const ts = [0, 1, 2, 3];
    const u = fakeU([ts, [0, 0, 1, 1]], [{}]);
    drawEnumTiles(ctx, u, tileOpts({ sampleMarkers: true, sampleColumns: [0, 1, 2, 3] }));
    const rects = ops.filter((o) => o.op === "fillRect");
    // Two tiles (code 0 then code 1), then one marker per sample. Told
    // apart by height: a tile fills the band, a marker is 3 px square.
    const tiles = rects.filter((o) => (o.args[3] as number) > 3);
    const markers = rects.filter((o) => (o.args[3] as number) === 3);
    expect(tiles).toHaveLength(2);
    expect(markers).toHaveLength(ts.length);
    expect(rects.indexOf(markers[0])).toBeGreaterThan(rects.indexOf(tiles[tiles.length - 1]));
    // Each marker is centred on its sample's x and on the plotted lane
    // position, not on the tile band — it sits on the waveform.
    expect(markers[0].args).toEqual([-1.5, 98.5, 3, 3]);
    expect(markers[2].args).toEqual([18.5, 97.5, 3, 3]);
  });

  it("draws no sample markers when the panel's show-points is off", () => {
    const { ctx, ops } = recorder();
    const u = fakeU([[0, 1, 2, 3], [0, 0, 1, 1]], [{}]);
    drawEnumTiles(ctx, u, tileOpts({ sampleMarkers: false, sampleColumns: [0, 1, 2, 3] }));
    expect(ops.filter((o) => o.op === "fillRect" && (o.args[3] as number) === 3)).toHaveLength(0);
  });

  /** Times `from, from+period, …` up to and including `until`, rounded
   * the way the fixture's generator rounds them. */
  function ticks(period: number, until: number, from = 0): number[] {
    const out: number[] = [];
    for (let i = 0; from + i * period <= until + 1e-9; i++) {
      out.push(Number((from + i * period).toFixed(6)));
    }
    return out;
  }

  /** A lane arriving at `period` over `[from, until]`, all one code. */
  const laneSeries = (period: number, until: number, from = 0, code = 1) => {
    const t = ticks(period, until, from);
    return { t, v: t.map(() => code) };
  };

  /** The x (in the fake uPlot's 1 unit = 10 px world) each sample marker
   * was centred on. A marker is the 3 px square; a tile fills the band. */
  const markerTimes = (ops: Op[]) =>
    ops
      .filter((o) => o.op === "fillRect" && (o.args[3] as number) === 3)
      .map((o) => Number((((o.args[0] as number) + 1.5) / 10).toFixed(6)));

  it("marks a lane's own samples, not the columns a dense sibling contributes", () => {
    // The defect this pins: the markers were selected from `u.data[0]` —
    // the *merged* column grid — so a 5 Hz sibling on the same lanes axis
    // put a marker on this lane at every one of its columns, right across
    // the stretch where this lane had stopped arriving. The fixture's
    // `StoppedMode` (500 ms, silent after 6 s) beside `DenseMode`
    // (200 ms, the whole capture).
    const stopped = { ...laneSeries(0.5, 6), extrapolated: [[6, 20] as const] };
    const dense = laneSeries(0.2, 20, 0, 2);
    const merged = mergeSeries([stopped, dense]);
    const xs = merged[0] as number[];
    const cols = sampleColumns(xs, [stopped, dense]);
    const { ctx, ops } = recorder();
    const u = fakeU([xs, merged[1] as (number | null)[], merged[2] as (number | null)[]], [{}, {}]);
    drawEnumTiles(
      ctx,
      u,
      tileOpts({
        sampleMarkers: true,
        sampleColumns: cols[0],
        extrapolated: stopped.extrapolated,
      }),
    );
    expect(markerTimes(ops)).toEqual(stopped.t);
  });

  it("marks no sample inside a lane's stalled stretch, and both readings that bound it", () => {
    // The fixture's `StalledMode`: 200 ms throughout except 7 → 15 s,
    // which the host classifies as extrapolation. The stall's two ends
    // *are* readings and keep their markers — what has nothing behind it
    // is the stretch between them.
    const before = laneSeries(0.2, 7);
    const after = laneSeries(0.2, 20, 15);
    const stalled = {
      t: [...before.t, ...after.t],
      v: [...before.v, ...after.v],
      extrapolated: [[7, 15] as const],
    };
    const dense = laneSeries(0.2, 20, 0.1, 2);
    const merged = mergeSeries([stalled, dense]);
    const xs = merged[0] as number[];
    const { ctx, ops } = recorder();
    const u = fakeU([xs, merged[1] as (number | null)[], merged[2] as (number | null)[]], [{}, {}]);
    drawEnumTiles(
      ctx,
      u,
      tileOpts({
        sampleMarkers: true,
        sampleColumns: sampleColumns(xs, [stalled, dense])[0],
        extrapolated: stalled.extrapolated,
      }),
    );
    const times = markerTimes(ops);
    expect(times.filter((t) => t > 7 && t < 15)).toEqual([]);
    expect(times).toContain(7);
    expect(times).toContain(15);
    expect(times).toEqual(stalled.t);
  });

  it("halos about twice as hard on a light theme as on a dark one", () => {
    // Owner call after a side-by-side: a light theme's stripes carry far
    // more contrast against the tile fill and swallow a single pass.
    const passes = (name: ThemeName) => {
      const before = theme().name;
      setActiveTheme(name);
      const r = recorder();
      drawEnumTiles(
        r.ctx,
        fakeU([[0, 10], [0, 0]], [{}]),
        tileOpts({ extrapolated: [[0, 10] as const] }),
      );
      setActiveTheme(before);
      return r.ops.filter((o) => o.op === "fillText" && String(o.fill).startsWith("shadow:"))
        .length;
    };
    const dark = passes("dark");
    expect(dark).toBeGreaterThan(0);
    expect(passes("light")).toBe(dark * 2);
    expect(passes("lighthk")).toBe(dark * 2);
  });
});

describe("point markers on a numeric axis", () => {
  // uPlot's own point layer draws the indices its `points.filter`
  // returns, so which columns a line marks is decided there rather than
  // in a draw hook. The filter is installed on the constructed instance
  // (`applySampleMarkerFilter`), which is what this drives.

  function ticks(period: number, until: number, from = 0): number[] {
    const out: number[] = [];
    for (let i = 0; from + i * period <= until + 1e-9; i++) {
      out.push(Number((from + i * period).toFixed(6)));
    }
    return out;
  }

  const ramp = (t: number[]) => ({ t, v: t.map((x) => 50 + x) });

  /** Merge, blank the extrapolated stretches out (as the resample
   * does), install the filter, and return what it hands uPlot for
   * series `k` — plus the row uPlot would be drawing markers on. */
  function markedColumns(series: Parameters<typeof mergeSeries>[0], k: number) {
    const merged = mergeSeries(series);
    const xs = merged[0] as number[];
    const rows = merged.slice(1) as (number | null)[][];
    splitExtrapolatedRows(xs, rows, series);
    const cols = sampleColumns(xs, series);
    const u = fakeU([xs, ...rows], series.map(() => ({})));
    const points = series.map(() => ({}) as { filter?: uPlot.Series.Points["filter"] });
    applySampleMarkerFilter(
      [{}, ...points.map((p) => ({ points: p }))],
      (seriesIdx) => cols[seriesIdx - 1] ?? [],
    );
    const filter = points[k].filter;
    const idxs = typeof filter === "function" ? filter(u, k + 1, true, null) : filter;
    return { xs, row: rows[k], idxs, filter };
  }

  it("marks a one-sample series once, at its sample, and nowhere along its wings", () => {
    // The fixture's `OneShotLevel`: one frame at 10 s, drawn as a
    // horizontal line across the whole window (ADR 0026). The defect
    // this pins: every column that line runs through carried a value, so
    // the point layer drew a marker on each — a chain of dots claiming
    // 400 readings where there was one.
    const oneShot = {
      t: [10],
      v: [12],
      extrapolated: [[0, 10] as const, [10, 20] as const],
    };
    const { xs, row, idxs } = markedColumns([ramp(ticks(0.05, 20)), oneShot], 1);
    expect(idxs).toHaveLength(1);
    expect(xs[(idxs as number[])[0]]).toBe(10);
    // The row is not the source and could not be: even after the wings
    // are blanked out of the solid stroke it still carries a value at a
    // column that is nobody's sample (the wing's far end, which is where
    // the dash starts).
    expect(row.filter((v) => v != null).length).toBeGreaterThan(1);
  });

  it("marks no column inside a stalled stretch, and both readings that bound it", () => {
    // The fixture's `StalledLevel`: 100 ms, silent from 6 s to 13 s, on
    // an axis a 50 ms series fills with columns. Held values across the
    // stall are not readings; the samples at its ends are.
    const stalled = {
      t: [...ticks(0.1, 6), ...ticks(0.1, 20, 13)],
      v: [] as number[],
      extrapolated: [[6, 13] as const],
    };
    stalled.v = stalled.t.map((x) => 30 + x);
    const { xs, idxs } = markedColumns([ramp(ticks(0.05, 20)), stalled], 1);
    const times = (idxs as number[]).map((i) => xs[i]);
    expect(times.filter((t) => t > 6 && t < 13)).toEqual([]);
    expect(times).toEqual(stalled.t);
  });

  it("keeps every marker of a series that really is dense", () => {
    // The control. Nothing here is extrapolated and every column of this
    // series' own is a reading, so the honest answer is the one the plot
    // already drew.
    const dense = ramp(ticks(0.05, 20));
    const sparse = ramp(ticks(1, 20));
    const { xs, idxs } = markedColumns([dense, sparse], 0);
    expect((idxs as number[]).map((i) => xs[i])).toEqual(dense.t);
  });

  it("returns nothing at all when uPlot's own rule said not to draw", () => {
    // `drawSeries` draws points when `show || idxs`, so an index list
    // returned while `show` is false resurrects the markers the panel's
    // `off` mode — or uPlot's density rule under `auto` — just turned
    // down. The filter narrows what is drawn; it never decides that
    // something is.
    const { filter } = markedColumns([ramp(ticks(1, 20))], 0);
    const u = fakeU([[0, 1], [1, 2]], [{}]);
    expect(typeof filter === "function" ? filter(u, 1, false, null) : null).toBeNull();
  });
});
