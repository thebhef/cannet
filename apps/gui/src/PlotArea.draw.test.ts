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

import { drawEnumTiles, drawExtrapolatedSegments, drawHoverMarkers } from "./PlotArea";
import { mergeSeries, sampleColumns, splitExtrapolatedRows } from "./plotData";
import { EXTRAPOLATION_STRIPE_PERIOD_PX } from "./plotEnumLanes";
import { applySampleMarkerFilter } from "./plotPoints";
import { THEMES, setActiveTheme, theme, type ThemeName } from "./theme";

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
    globalAlpha: 1,
    textAlign: "left",
    textBaseline: "middle",
  };
  const saved: (typeof state)[] = [];
  // A call made at `globalAlpha` 0 is recorded as what it is: nothing. A
  // source-over composite at alpha 0 leaves every pixel exactly as it
  // was, so a draw made under it is indistinguishable — in a screenshot
  // and here — from one that never happened. That is what lets the
  // label box take a single unconditional draw path across themes.
  const inked = () => state.globalAlpha !== 0;
  const push = (op: string, ...args: unknown[]) => {
    if (!inked()) return;
    ops.push({
      op,
      args,
      dash: [...state.dash],
      stroke: state.strokeStyle,
      fill: state.fillStyle,
      lineWidth: state.lineWidth,
    });
  };
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
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
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
    arc: (...a: number[]) => push("arc", ...a),
    fill: () => push("fill"),
    moveTo: (x: number, y: number) => push("moveTo", x, y),
    lineTo: (x: number, y: number) => push("lineTo", x, y),
    rect: (...a: number[]) => push("rect", ...a),
    clip: () => push("clip"),
    stroke: () => push("stroke"),
    fillRect: (...a: number[]) => push("fillRect", ...a),
    strokeRect: (...a: number[]) => push("strokeRect", ...a),
    fillText: (t: string, x: number, y: number) => {
      if (!inked()) return;
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

  it("keeps every marker of a lane that really is arriving", () => {
    // The control, from the other side of the same axis: `DenseMode`
    // has a sample at every one of its columns, so the honest answer for
    // it is the one the lane already drew.
    const stopped = { ...laneSeries(0.5, 6), extrapolated: [[6, 20] as const] };
    const dense = laneSeries(0.2, 20, 0, 2);
    const merged = mergeSeries([stopped, dense]);
    const xs = merged[0] as number[];
    const { ctx, ops } = recorder();
    const u = fakeU([xs, merged[1] as (number | null)[], merged[2] as (number | null)[]], [{}, {}]);
    drawEnumTiles(
      ctx,
      u,
      tileOpts({
        seriesIdx: 2,
        sampleMarkers: true,
        sampleColumns: sampleColumns(xs, [stopped, dense])[1],
      }),
    );
    expect(markerTimes(ops)).toEqual(dense.t);
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

  it("spends halo passes only where no solid box already carries the label", () => {
    // The halo exists to keep a label off the stripes. A theme that
    // draws a solid box behind the label has already put an opaque plate
    // between the two, so the passes would paint background over
    // background — and their blur would fringe out past the box's edge
    // onto the tile. Dark, which draws no box, keeps its passes exactly.
    //
    // Two things hold a boxed theme at zero: this draw guard, and the
    // theme's own count, which `theme.test.ts` pins at 0 wherever the box
    // is solid. So what this asserts is the drawn outcome, not which of
    // the two produced it; the guard is the rule for a theme that set
    // both.
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
    expect(passes("dark")).toBe(THEMES.dark.laneLabelShadowPasses);
    expect(passes("light")).toBe(0);
    expect(passes("lighthk")).toBe(0);
  });
});

describe("enum tile label legibility", () => {
  // The owner's report off the light-theme sign-off frame: "light mode
  // legibility is quite poor basically everywhere in the capture. Dark
  // mode legibility is good." The ink was the accent and the fill is a
  // tint of that same accent, so on a light theme the label was drawn in
  // a color a hair off the plate it sits on (1.03-1.80:1 on the
  // fixture's own colormaps). `laneLabelInk` measures instead.

  const TABLE = [{ raw: 1, label: "Running" }];

  /** Draw one tinted tile under `name` and hand back the recorded ops.
   * The tint reaches the tile the way the fixture's colormaps do — the
   * accent *is* the tint, which is the whole of the defect. */
  function tintedTile(name: ThemeName, tint: string, extrapolated: (readonly [number, number])[]) {
    const before = theme().name;
    setActiveTheme(name);
    const r = recorder();
    drawEnumTiles(r.ctx, fakeU([[0, 10], [1, 1]], [{}]), {
      seriesIdx: 1,
      table: TABLE,
      target: { messageId: 513, extended: false, signalName: "StoppedMode", busId: null },
      resolveColor: () => tint,
      bandTop: 40,
      bandBot: 60,
      accent: tint,
      left: 0,
      width: 1000,
      ratio: 1,
      extrapolated,
    });
    setActiveTheme(before);
    return r.ops;
  }

  /** The color the visible glyph (the last, un-shadowed pass) was in. */
  const inkOf = (ops: Op[]) => {
    const texts = ops.filter((o) => o.op === "fillText");
    return String(texts[texts.length - 1].fill);
  };
  /** The color the halo passes were in. */
  const haloOf = (ops: Op[]) => {
    const shadows = ops.filter((o) => o.op === "fillText" && String(o.fill).startsWith("shadow:"));
    return [...new Set(shadows.map((o) => String(o.fill).slice("shadow:".length)))];
  };

  it("light: keeps the accent the box rescues, and replaces the pale tints", () => {
    // The label box is what the ink is now measured against, so the
    // accent survives on the tints that read against a near-white plate
    // — the tile's color is the signal's identity — and the two pale
    // ones (amber 2.15:1, green 2.28:1 on `light`) fall back exactly as
    // the shipped rule already made them.
    for (const tint of ["#6b7280", "#3b82f6", "#ef4444"]) {
      expect(inkOf(tintedTile("light", tint, [])), tint).toBe(tint);
      expect(inkOf(tintedTile("lighthk", tint, [])), tint).toBe(tint);
    }
    for (const tint of ["#f59e0b", "#22c55e"]) {
      expect(inkOf(tintedTile("light", tint, [])), tint).toBe("#000000");
      expect(inkOf(tintedTile("lighthk", tint, [])), tint).toBe("#000000");
    }
  });

  it("dark: draws exactly what it drew before", () => {
    // The pin. The owner reads the dark theme fine, so every one of the
    // fixture's tints must still label in its own accent.
    for (const tint of ["#6b7280", "#f59e0b", "#22c55e", "#3b82f6", "#ef4444"]) {
      expect(inkOf(tintedTile("dark", tint, [])), tint).toBe(tint);
    }
  });

  it("keeps the tile's border in the accent whichever ink the label takes", () => {
    // The border is read against the plot background *outside* the tile,
    // where the accent has all the contrast it needs — and it is what
    // carries the signal's identity once the label has stopped.
    const ops = tintedTile("light", "#22c55e", []);
    const border = ops.find((o) => o.op === "strokeRect");
    expect(border?.stroke).toBe("#22c55e");
  });

  it("halos in the background wherever the background reads against the ink", () => {
    // The stripes are painted in the background, so a background halo is
    // what stops them cutting the glyphs — and it is what the dark theme
    // already had. (Which color the halo takes when the ink lands on the
    // background's own side is `laneLabelInk`'s, and measured there: no
    // shipping theme both draws no box and inks that way.)
    const dark = tintedTile("dark", "#3b82f6", [[0, 10]]);
    expect(haloOf(dark)).toEqual([THEMES.dark.background]);
  });
});

describe("the lane label's background box", () => {
  // The owner's call off the phase-9 frames: "having a background box
  // around the text would be better. Dark doesn't need it but I think
  // having it for light...". One draw path, a per-theme opacity — so
  // dark's box is the same call at alpha 0, which paints nothing.

  const TABLE = [{ raw: 1, label: "Running" }];

  /** Draw one untinted tile under `name` and hand back the recorded ops.
   * `seg` is the tile's own extent and `vis` the plot box's, in the fake
   * uPlot's 1 unit = 10 px world. */
  function tile(
    name: ThemeName,
    seg: [number, number] = [0, 10],
    vis: { left: number; width: number } = { left: 0, width: 1000 },
  ) {
    const before = theme().name;
    setActiveTheme(name);
    const r = recorder();
    drawEnumTiles(r.ctx, fakeU([seg, [1, 1]], [{}]), {
      seriesIdx: 1,
      table: TABLE,
      target: null,
      resolveColor: vi.fn(),
      bandTop: 40,
      bandBot: 60,
      accent: "#3b82f6",
      ratio: 1,
      ...vis,
    });
    setActiveTheme(before);
    return r.ops;
  }

  /** The box: a `fillRect` in the theme's chip fill. The tile's own fill
   * is `laneFillDefault`, so the two never collide. */
  const boxes = (ops: Op[], name: ThemeName) =>
    ops.filter((o) => o.op === "fillRect" && o.fill === THEMES[name].canvasChipFill);

  it("light: backs the label with a solid box in the chip fill", () => {
    const ops = tile("light");
    // `Running` measures 42 px in the stand-in, centred in a 100 px tile
    // at x = 29; the box is that plus the label's own 4 px padding
    // either side, 13 px tall on the band's centre line — the geometry
    // the canvas chips (cursor labels, Δ readouts) already use.
    expect(boxes(ops, "light").map((o) => o.args)).toEqual([[25, 43.5, 50, 13]]);
    // Under the glyph, not over it.
    const box = boxes(ops, "light")[0];
    const text = ops.find((o) => o.op === "fillText");
    expect(ops.indexOf(box)).toBeLessThan(ops.indexOf(text!));
  });

  it("dark: paints no box at all", () => {
    // The pin, at the draw tier: the theme the owner reads fine is left
    // holding exactly the calls it held before — one fill for the tile
    // and one for nothing else.
    const ops = tile("dark");
    expect(boxes(ops, "dark")).toEqual([]);
    expect(ops.filter((o) => o.op === "fillRect")).toHaveLength(1);
    expect(ops.filter((o) => o.op === "fillText")).toHaveLength(1);
  });

  it("keeps the box inside the tile's visible part, like the label itself", () => {
    // A tile running off both edges of a narrow plot box: the label
    // centres on what is visible (`tileLabelX`), and the box follows it
    // rather than the tile's own midpoint, which is 90 px to the left.
    const ops = tile("light", [-10, 10], { left: 20, width: 60 });
    const [x, , w] = boxes(ops, "light")[0].args as number[];
    expect(x).toBeGreaterThanOrEqual(20);
    expect(x + w).toBeLessThanOrEqual(80);
  });

  it("draws no box on a tile too narrow to label", () => {
    // A segment narrower than its label draws the colored tile and
    // nothing else (ADR 0026); a box with no text in it would be a
    // blank plate over the tile's own color.
    const ops = tile("light", [0, 3]);
    expect(ops.filter((o) => o.op === "fillText")).toEqual([]);
    expect(boxes(ops, "light")).toEqual([]);
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

describe("hover markers", () => {
  // The x these are drawn at is the *panel's*, not this area's: it is
  // folded from whichever area the pointer is in and handed to every
  // area, the same value the crosshair is drawn at. So every case here
  // drives the function the way a **non-hovered** area is driven — a
  // hover x and no pointer of its own — which is the cross-area claim
  // at this tier. (The panel tier pins that the value really does reach
  // the other areas.)

  function ticks(period: number, until: number, from = 0): number[] {
    const out: number[] = [];
    for (let i = 0; from + i * period <= until + 1e-9; i++) {
      out.push(Number((from + i * period).toFixed(6)));
    }
    return out;
  }

  const ramp = (t: number[]) => ({ t, v: t.map((x) => 50 + x) });

  /** Draw what an area holding `series` would draw at `hoverX`.
   * `blank` is what a line axis does to its rows (the extrapolated
   * stretches are cut out of the solid stroke) and what a tile axis
   * deliberately does not — a lane keeps its row whole. */
  function hovered(
    series: Parameters<typeof mergeSeries>[0],
    hoverX: number | null,
    o?: { blank?: boolean; signals?: { hidden?: boolean }[]; left?: number; width?: number },
  ) {
    const merged = mergeSeries(series);
    const xs = merged[0] as number[];
    const rows = merged.slice(1) as (number | null)[][];
    if (o?.blank !== false) splitExtrapolatedRows(xs, rows, series);
    const u = fakeU([xs, ...rows], series.map(() => ({})));
    const { ctx, ops } = recorder();
    drawHoverMarkers(ctx, u, {
      hoverX,
      signals: o?.signals ?? series.map(() => ({})),
      sampleColumns: sampleColumns(xs, series),
      color: (i) => ["#aa0000", "#00bb00"][i] ?? "#ffffff",
      ratio: 1,
      left: o?.left ?? 0,
      width: o?.width ?? 1000,
    });
    const marks = ops
      .filter((op) => op.op === "arc")
      .map((op) => ({
        t: Number((((op.args[0] as number) / 10)).toFixed(6)),
        y: op.args[1] as number,
        r: op.args[2] as number,
        fill: op.fill,
      }));
    return { xs, ops, marks };
  }

  it("marks each series' own nearest sample, in an area the pointer is not in", () => {
    // Two cadences that do not share a column near the pointer, so
    // "each series' own" is falsifiable: a single shared answer would
    // put both markers at the same x.
    const a = ramp(ticks(0.5, 10));
    const b = ramp(ticks(1, 10, 0.4));
    const { marks } = hovered([a, b], 3.2);
    expect(marks.map((m) => m.t)).toEqual([3, 3.4]);
    expect(marks.map((m) => m.fill)).toEqual(["#aa0000", "#00bb00"]);
    // Drawn as a disc, wider than the 3 px square a sample marker is.
    expect(marks.every((m) => m.r === 3)).toBe(true);
  });

  it("keeps a stopped series' marker on its last reading rather than under the pointer", () => {
    // The honesty rule, at the hover seam: the merged row carries a
    // held value at the pointer's column — that is what the per-series
    // hover point this replaces snapped to — but the series has no
    // reading there. Its last one is at 6 s and that is where the
    // marker stays, beside the dashed stretch that says why.
    const stopped = { ...ramp(ticks(0.5, 6)), extrapolated: [[6, 20] as const] };
    const dense = ramp(ticks(0.2, 20));
    const { marks } = hovered([stopped, dense], 12);
    expect(marks.map((m) => m.t)).toEqual([6, 12]);
  });

  it("marks a lane the same way, over a row that was deliberately kept whole", () => {
    // A tile axis never blanks its row (a lane's held state is
    // information), so every column of a stale lane carries a value and
    // the merged grid alone would have marked the pointer's. The
    // sample columns are what stops it — the same seam, the same
    // answer, on the renderer that had no hover marker at all.
    const stale = { t: ticks(0.5, 6), v: ticks(0.5, 6).map(() => 1), extrapolated: [[6, 20] as const] };
    const dense = { t: ticks(0.2, 20), v: ticks(0.2, 20).map(() => 2) };
    const { marks } = hovered([stale, dense], 12, { blank: false });
    expect(marks.map((m) => m.t)).toEqual([6, 12]);
    // On the lane's own plotted position (y = 1 → 99 px in the stand-in),
    // not on the pointer's column and not on the tile band.
    expect(marks[0].y).toBe(99);
    expect(marks[1].y).toBe(98);
  });

  it("marks nothing inside a stall, and the reading on whichever side is nearer", () => {
    const stalled = {
      t: [...ticks(0.2, 7), ...ticks(0.2, 20, 15)],
      v: [] as number[],
      extrapolated: [[7, 15] as const],
    };
    stalled.v = stalled.t.map((x) => 30 + x);
    const dense = ramp(ticks(0.2, 20));
    expect(hovered([stalled, dense], 9).marks[0].t).toBe(7);
    expect(hovered([stalled, dense], 13).marks[0].t).toBe(15);
  });

  it("draws nothing at all once the pointer has left the panel", () => {
    const { marks } = hovered([ramp(ticks(0.5, 10))], null);
    expect(marks).toEqual([]);
  });

  it("draws nothing for a hidden series", () => {
    const { marks } = hovered([ramp(ticks(0.5, 10))], 3.2, { signals: [{ hidden: true }] });
    expect(marks).toEqual([]);
  });

  it("does not draw a marker that would land outside the plot box", () => {
    // A series whose nearest sample is off to the left of the visible
    // window: the crosshair is in frame, its reading is not, and a
    // marker clamped to the edge would claim a sample at the edge.
    const stopped = { ...ramp(ticks(0.5, 6)), extrapolated: [[6, 20] as const] };
    const dense = ramp(ticks(0.2, 20));
    const { marks } = hovered([stopped, dense], 12, { left: 100, width: 200 });
    expect(marks.map((m) => m.t)).toEqual([12]);
  });
});
