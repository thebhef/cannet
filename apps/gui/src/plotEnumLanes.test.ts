import { describe, expect, it, vi } from "vitest";
import {
  type Band,
  laneBands,
  laneBandsForVisible,
  laneLabels,
  laneTileBand,
  laneValueRange,
  stripeOverlay,
  stripedOverlap,
  EXTRAPOLATION_STRIPE_PERIOD_PX,
  fitTileLabel,
  measureTileLabel,
  normalizeIntoLane,
  tileLabelX,
} from "./plotEnumLanes";

const span = (b: Band) => b.hi - b.lo;

describe("laneBands", () => {
  it("degenerate counts: 0 → none, 1 → one non-empty band inside [0,1]", () => {
    expect(laneBands(0)).toEqual([]);
    const one = laneBands(1);
    expect(one).toHaveLength(1);
    expect(one[0].lo).toBeGreaterThanOrEqual(0);
    expect(one[0].hi).toBeLessThanOrEqual(1);
    expect(span(one[0])).toBeGreaterThan(0);
  });

  it("N lanes are top-first, ordered, non-overlapping, and inside [0,1]", () => {
    const bands = laneBands(3);
    expect(bands).toHaveLength(3);
    // Top-first: lane 0 is highest (largest hi), strictly descending.
    expect(bands[0].hi).toBeGreaterThan(bands[1].hi);
    expect(bands[1].hi).toBeGreaterThan(bands[2].hi);
    for (const b of bands) {
      expect(b.lo).toBeGreaterThanOrEqual(0);
      expect(b.hi).toBeLessThanOrEqual(1);
      expect(span(b)).toBeGreaterThan(0);
    }
    // Non-overlapping with a positive gap between adjacent lanes.
    expect(bands[0].lo).toBeGreaterThan(bands[1].hi);
    expect(bands[1].lo).toBeGreaterThan(bands[2].hi);
  });

  it("lanes are equal height", () => {
    const bands = laneBands(4);
    const h0 = span(bands[0]);
    for (const b of bands) expect(span(b)).toBeCloseTo(h0);
  });
});

describe("laneBandsForVisible", () => {
  it("with nothing hidden it is exactly laneBands(n)", () => {
    expect(laneBandsForVisible([false, false, false])).toEqual(laneBands(3));
  });

  it("a hidden lane drops out and its space goes to the rest", () => {
    // Three signals, the middle one hidden: the two survivors must lay
    // out as a *two*-lane axis, not keep their three-lane slots with a
    // hole where the hidden one was.
    const got = laneBandsForVisible([false, true, false]);
    const two = laneBands(2);
    expect(got[0]).toEqual(two[0]);
    expect(got[1]).toBeNull();
    expect(got[2]).toEqual(two[1]);
    // Each survivor is taller than it would have been at three lanes.
    expect(span(got[0]!)).toBeGreaterThan(span(laneBands(3)[0]));
  });

  it("keeps input order — the visible lanes stack top-first", () => {
    const got = laneBandsForVisible([true, false, false, true, false]);
    const three = laneBands(3);
    expect(got).toEqual([null, three[0], three[1], null, three[2]]);
  });

  it("all hidden → all null, with no NaN band and no lanes to divide by", () => {
    const got = laneBandsForVisible([true, true]);
    expect(got).toEqual([null, null]);
    expect(laneBandsForVisible([])).toEqual([]);
  });
});

describe("laneValueRange", () => {
  it("pads the table's raw min/max by half a code", () => {
    const r = laneValueRange([{ raw: 0 }, { raw: 3 }, { raw: 1 }]);
    expect(r.lo).toBeCloseTo(-0.5);
    expect(r.hi).toBeCloseTo(3.5);
  });

  it("a single-value table still has a non-zero span", () => {
    const r = laneValueRange([{ raw: 7 }]);
    expect(span(r)).toBeCloseTo(1);
    expect(r.lo).toBeCloseTo(6.5);
    expect(r.hi).toBeCloseTo(7.5);
  });

  it("an empty table falls back to a non-degenerate range", () => {
    expect(span(laneValueRange([]))).toBeGreaterThan(0);
  });
});

describe("normalizeIntoLane", () => {
  const range: Band = { lo: -0.5, hi: 2.5 };
  const band: Band = { lo: 0.2, hi: 0.4 };

  it("maps range endpoints onto the band endpoints", () => {
    expect(normalizeIntoLane(-0.5, range, band)).toBeCloseTo(0.2);
    expect(normalizeIntoLane(2.5, range, band)).toBeCloseTo(0.4);
  });

  it("maps the range midpoint to the band midpoint", () => {
    expect(normalizeIntoLane(1, range, band)).toBeCloseTo(0.3);
  });

  it("clamps values outside the range into the band", () => {
    expect(normalizeIntoLane(-10, range, band)).toBeCloseTo(0.2);
    expect(normalizeIntoLane(10, range, band)).toBeCloseTo(0.4);
  });

  it("a zero-width range maps to the band midpoint", () => {
    expect(normalizeIntoLane(5, { lo: 5, hi: 5 }, band)).toBeCloseTo(0.3);
  });
});

describe("tileLabelX", () => {
  // A 400 px wide plot region starting at x = 100.
  const vis: Band = { lo: 100, hi: 500 };
  const TW = 40; // text width
  const PAD = 4;

  /** Midpoint of the drawn label, for readability of the expectations. */
  const mid = (seg: Band) => tileLabelX(seg, vis, TW, PAD)! + TW / 2;

  it("centres the label on a fully visible tile", () => {
    expect(mid({ lo: 200, hi: 300 })).toBeCloseTo(250, 0);
  });

  it("centres in the part you can see, however far the tile runs off", () => {
    // The host widens every fetched slice by two boundary points each
    // side, so a tile is clipped by construction — and zoomed in far
    // enough those points are whole screens away. Only the visible part
    // is a trustworthy anchor.
    expect(mid({ lo: -1100, hi: 400 })).toBeCloseTo(250, 0);
    expect(mid({ lo: 200, hi: 9000 })).toBeCloseTo(350, 0);
    expect(mid({ lo: -9e6, hi: 9e6 })).toBeCloseTo(300, 0);
  });

  it("ignores where the tile's off-screen edges land", () => {
    // Those edges are boundary points re-fetched every round trip. If
    // they moved the label, it would jitter once per fetch.
    const a = tileLabelX({ lo: -900, hi: 4000 }, vis, TW, PAD);
    const b = tileLabelX({ lo: -3000, hi: 90000 }, vis, TW, PAD);
    expect(a).toBe(b);
  });

  it("returns null when the visible part cannot hold the text", () => {
    // Visible width 40 < 40 + 2·4.
    expect(tileLabelX({ lo: 200, hi: 240 }, vis, TW, PAD)).toBeNull();
    // Entirely off-screen either side.
    expect(tileLabelX({ lo: -500, hi: -100 }, vis, TW, PAD)).toBeNull();
    expect(tileLabelX({ lo: 600, hi: 800 }, vis, TW, PAD)).toBeNull();
  });

  it("lands on whole pixels so glyphs are not re-rasterised each frame", () => {
    const x = tileLabelX({ lo: 200.37, hi: 400 }, vis, TW, PAD);
    expect(x).toBe(Math.round(x!));
  });

  it("holds a viewport-spanning tile's label dead still while it scrolls", () => {
    // Follow-live, held value: the tile spans the whole viewport and
    // scrolls under it. Neither edge is on screen, so the label is dead
    // centre and completely still — the case where a moving label is
    // most distracting. The off-screen edges are re-fetched boundary
    // points, so they also jitter; that must not reach the label.
    const xs = new Set<number>();
    for (let k = 0; k < 40; k++) {
      const jitter = (k % 3) * 37; // boundary points land differently each fetch
      xs.add(tileLabelX({ lo: -800 - k * 7 - jitter, hi: 1400 - k * 7 + jitter }, vis, TW, PAD)!);
    }
    expect(xs.size).toBe(1);
  });

  it("tracks a real edge smoothly when one is on screen", () => {
    // A transition inside the viewport is a real edge, so the label
    // does follow it — at half the scroll rate, since the other side of
    // the visible box is the fixed screen edge. Accepted residual: it
    // glides, monotonically and never faster than half a scroll step,
    // rather than jumping.
    const STEP = 6;
    const xs: number[] = [];
    for (let k = 0; k < 30; k++) {
      // Run ends at a transition scrolling left across the viewport;
      // starts off-screen left.
      xs.push(tileLabelX({ lo: -5000, hi: 480 - k * STEP }, vis, TW, PAD)!);
    }
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      expect(d).toBeLessThanOrEqual(0); // no reversals
      expect(Math.abs(d)).toBeLessThanOrEqual(Math.ceil(STEP / 2));
    }
  });
});

describe("laneTileBand", () => {
  const band: Band = { lo: 0.2, hi: 0.6 }; // 0.4 tall

  it("is centered within the lane and a fraction of its height", () => {
    const t = laneTileBand(band, 200, 0.5, 10);
    // 0.5 of a 0.4-tall lane → 0.2 tall, centered on 0.4.
    expect((t.lo + t.hi) / 2).toBeCloseTo(0.4);
    expect(span(t)).toBeCloseTo(0.2);
  });

  it("floors the tile at minPx worth of the lane", () => {
    // lane is 100px, tileFraction 0.1 → 10px < 40px floor → 40px = 0.4 of lane.
    const t = laneTileBand(band, 100, 0.1, 40);
    expect(span(t)).toBeCloseTo(0.4 * 0.4); // 0.4 of the 0.4-tall lane band
  });

  it("caps the tile at the full lane band", () => {
    const t = laneTileBand(band, 200, 5, 10);
    expect(t.lo).toBeCloseTo(band.lo);
    expect(t.hi).toBeCloseTo(band.hi);
  });
});

describe("laneLabels", () => {
  const table = [
    { raw: 0, label: "Sleep" },
    { raw: 3, label: "Drive" },
  ];

  it("resolves a code to its label, and an unlisted code to its number", () => {
    const labels = laneLabels(table);
    expect(labels(0)).toBe("Sleep");
    expect(labels(3)).toBe("Drive");
    expect(labels(7)).toBe("7");
  });

  it("first raw wins on a duplicate, matching a linear scan of the table", () => {
    const labels = laneLabels([
      { raw: 1, label: "first" },
      { raw: 1, label: "second" },
    ]);
    expect(labels(1)).toBe("first");
  });

  it("reuses one lookup per table, so a draw does not rebuild it per segment", () => {
    // The tile draw walks every visible segment; a per-segment linear
    // `table.find` is what made a long capture's lane expensive.
    expect(laneLabels(table)).toBe(laneLabels(table));
  });
});

describe("measureTileLabel", () => {
  /// A 2d context stand-in that counts real measurements.
  function ctx(width = 12) {
    const measureText = vi.fn((s: string) => ({ width: width * s.length }));
    return { font: "10px mono", measureText } as unknown as CanvasRenderingContext2D & {
      measureText: ReturnType<typeof vi.fn>;
    };
  }

  it("measures a (label, font) pair once and serves the rest from the memo", () => {
    const c = ctx();
    expect(measureTileLabel(c, "Drive")).toBe(60);
    expect(measureTileLabel(c, "Drive")).toBe(60);
    expect(measureTileLabel(c, "Drive")).toBe(60);
    expect(c.measureText).toHaveBeenCalledTimes(1);
  });

  it("re-measures when the font changes — a memo keyed on the label alone would lie", () => {
    const c = ctx();
    measureTileLabel(c, "Fault");
    c.font = "bold 14px mono";
    measureTileLabel(c, "Fault");
    expect(c.measureText).toHaveBeenCalledTimes(2);
  });
});

describe("stripeOverlay", () => {
  const rect = { x0: 100, x1: 200, yTop: 10, yBot: 30 };

  it("makes the painted and unpainted bands exactly even", () => {
    // The whole point of the geometry note in the ruling. A 45° stroke
    // of width w covers w·√2 horizontally, so the naive period/2 paints
    // period/√2 ≈ 71 % of each period and the hatching reads as a
    // repaint of the tile. Even bands need period/(2·√2).
    const { lineWidth } = stripeOverlay(rect, 20);
    expect(lineWidth).toBeCloseTo(20 / (2 * Math.SQRT2), 12);
    // Stated as the property rather than the formula: the horizontal
    // footprint of one stroke is exactly half the period.
    expect(lineWidth * Math.SQRT2).toBeCloseTo(20 / 2, 12);
    // And the naive value it is not.
    expect(lineWidth).not.toBeCloseTo(10, 3);
  });

  it("runs the stripes at 45° and covers the whole rectangle", () => {
    const { lines } = stripeOverlay(rect, 20);
    const h = rect.yBot - rect.yTop;
    for (const l of lines) {
      expect(l.x1 - l.x0).toBeCloseTo(h, 12); // 45°: dx = dy
      expect(l.y0).toBe(rect.yTop);
      expect(l.y1).toBe(rect.yBot);
    }
    // A line starting at `xt` covers [xt, xt + h] somewhere in the band,
    // so the set must reach one height left of the rectangle and past
    // its right edge, or the corners come out unpainted.
    const starts = lines.map((l) => l.x0);
    expect(Math.min(...starts)).toBeLessThanOrEqual(rect.x0 - h);
    expect(Math.max(...starts)).toBeGreaterThanOrEqual(rect.x1);
    // Evenly spaced by the period, with none missing in between.
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeCloseTo(20, 12);
    }
  });

  it("anchors the pattern to the canvas, not to the rectangle", () => {
    // Two tiles that meet must continue one another's stripes. Anchored
    // to each rectangle instead, both would restart at their shared
    // edge and put a double-width band on every join.
    const left = stripeOverlay({ ...rect, x0: 100, x1: 150 }, 20);
    const right = stripeOverlay({ ...rect, x0: 150, x1: 200 }, 20);
    for (const l of [...left.lines, ...right.lines]) {
      expect(l.x0 % 20).toBeCloseTo(0, 12);
    }
  });

  it("returns no lines for a rectangle with no area", () => {
    expect(stripeOverlay({ x0: 100, x1: 100, yTop: 10, yBot: 30 }, 20).lines).toEqual([]);
    expect(stripeOverlay({ x0: 100, x1: 200, yTop: 10, yBot: 10 }, 20).lines).toEqual([]);
    expect(stripeOverlay(rect, 0).lines).toEqual([]);
  });

  it("ships the ruling's 20 px period", () => {
    expect(EXTRAPOLATION_STRIPE_PERIOD_PX).toBe(20);
  });
});

describe("stripedOverlap", () => {
  it("stripes only the stale part of a partly-extrapolated tile", () => {
    // A tile is a run of one held code and a stretch of extrapolation is
    // a run of silence; neither divides the other. A tile that went
    // stale halfway through shows both halves in one picture.
    expect(stripedOverlap(0, 10, [4, 20])).toEqual({ from: 4, to: 10 });
    expect(stripedOverlap(0, 10, [-5, 4])).toEqual({ from: 0, to: 4 });
    expect(stripedOverlap(0, 10, [3, 7])).toEqual({ from: 3, to: 7 });
    expect(stripedOverlap(0, 10, [-5, 20])).toEqual({ from: 0, to: 10 });
  });

  it("is null when the tile and the stretch do not meet", () => {
    expect(stripedOverlap(0, 10, [10, 20])).toBeNull();
    expect(stripedOverlap(0, 10, [-5, 0])).toBeNull();
    expect(stripedOverlap(0, 10, [20, 30])).toBeNull();
  });
});

describe("fitTileLabel", () => {
  /// A 2d context stand-in, 10 px a character, with a font unique per
  /// call so `measureTileLabel`'s memo can't serve another test's
  /// widths.
  let fonts = 0;
  function ctx(): CanvasRenderingContext2D {
    return {
      font: `10px fit-${fonts++}`,
      measureText: (s: string) => ({ width: 10 * s.length }),
    } as unknown as CanvasRenderingContext2D;
  }

  it("returns a label that fits unchanged", () => {
    // The control: no ellipsis where none is needed, so an ellipsis
    // below reads as the width and not as the helper.
    expect(fitTileLabel(ctx(), "Drive", 100)).toEqual({ text: "Drive", width: 50 });
    // Exactly filling the space still fits.
    expect(fitTileLabel(ctx(), "Drive", 50)).toEqual({ text: "Drive", width: 50 });
  });

  it("cuts the end and marks it, never wider than what it was given", () => {
    const got = fitTileLabel(ctx(), "TractionInverterStatorWinding", 95)!;
    expect(got.text).toBe("Traction…");
    expect(got.width).toBe(90);
    expect(got.width).toBeLessThanOrEqual(95);
  });

  it("keeps as many characters as the width allows, not one fewer", () => {
    // 10 px a character and one for the ellipsis: 80 px is 7 characters
    // plus the mark.
    expect(fitTileLabel(ctx(), "abcdefghijkl", 80)!.text).toBe("abcdefg…");
  });

  it("gives up only when not even one character and the mark fit", () => {
    expect(fitTileLabel(ctx(), "abcdefghijkl", 19)).toBeNull();
    expect(fitTileLabel(ctx(), "abcdefghijkl", 20)!.text).toBe("a…");
    expect(fitTileLabel(ctx(), "abcdefghijkl", 0)).toBeNull();
    expect(fitTileLabel(ctx(), "abcdefghijkl", -5)).toBeNull();
  });
});
