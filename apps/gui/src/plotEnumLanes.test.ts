import { describe, expect, it, vi } from "vitest";
import {
  type Band,
  laneBands,
  laneBandsForVisible,
  laneLabels,
  laneTileBand,
  laneValueRange,
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
