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
import { EXTRAPOLATION_STRIPE_PERIOD_PX } from "./plotEnumLanes";
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
    drawEnumTiles(ctx, u, tileOpts({ sampleMarkers: true }));
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
    drawEnumTiles(ctx, u, tileOpts({ sampleMarkers: false }));
    expect(ops.filter((o) => o.op === "fillRect" && (o.args[3] as number) === 3)).toHaveLength(0);
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
