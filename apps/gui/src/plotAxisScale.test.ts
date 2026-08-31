import { describe, expect, it } from "vitest";

import {
  axisScaleIsEmpty,
  axisScalesFromRaw,
  denormalizeOnAxis,
  enumTickLabels,
  enumTickSplits,
  logDecadeSplits,
  normalizeOnAxis,
  pruneAxisScales,
  resolveAxisRange,
  setAxisScale,
} from "./plotAxisScale";

describe("axisScalesFromRaw", () => {
  it("defaults to an empty dict for anything that isn't an object", () => {
    expect(axisScalesFromRaw(undefined)).toEqual({});
    expect(axisScalesFromRaw(null)).toEqual({});
    expect(axisScalesFromRaw(42)).toEqual({});
    expect(axisScalesFromRaw("x")).toEqual({});
  });

  it("keeps finite bounds and a true log flag, dropping junk", () => {
    expect(
      axisScalesFromRaw({
        a: { min: 0, max: 100 },
        b: { max: 5 },
        c: { log: true },
        d: { min: "3", max: NaN, log: "yes" },
        e: 7,
        f: null,
        g: { min: Infinity },
      }),
    ).toEqual({ a: { min: 0, max: 100 }, b: { max: 5 }, c: { log: true } });
  });

  it("drops an entry that carries no override at all", () => {
    expect(axisScalesFromRaw({ a: {}, b: { log: false } })).toEqual({});
  });
});

describe("setAxisScale", () => {
  it("creates an entry only where a bound is actually set", () => {
    expect(setAxisScale({}, "a", { max: 10 })).toEqual({ a: { max: 10 } });
  });

  it("merges into an existing entry", () => {
    expect(setAxisScale({ a: { max: 10 } }, "a", { min: 1 })).toEqual({ a: { min: 1, max: 10 } });
  });

  it("clearing the last field deletes the entry rather than storing empty", () => {
    expect(setAxisScale({ a: { max: 10 } }, "a", { max: null })).toEqual({});
    expect(setAxisScale({ a: { min: 1, max: 10 } }, "a", { min: null, max: null })).toEqual({});
  });

  it("keeps a held min while log is on, and restores it when log goes off", () => {
    const withLog = setAxisScale({ a: { min: 1, max: 10 } }, "a", { log: true });
    expect(withLog).toEqual({ a: { min: 1, max: 10, log: true } });
    expect(setAxisScale(withLog, "a", { log: false })).toEqual({ a: { min: 1, max: 10 } });
  });

  it("returns the same reference when nothing changes", () => {
    const store = { a: { max: 10 } };
    expect(setAxisScale(store, "a", { max: 10 })).toBe(store);
    expect(setAxisScale(store, "a", { log: false })).toBe(store);
    expect(setAxisScale(store, "b", { min: null })).toBe(store);
  });

  it("rejects a non-finite bound as a clear", () => {
    expect(setAxisScale({ a: { min: 1 } }, "a", { min: NaN })).toEqual({});
  });
});

describe("pruneAxisScales", () => {
  it("drops entries whose axis is gone", () => {
    expect(pruneAxisScales({ a: { max: 1 }, b: { max: 2 } }, ["a"])).toEqual({ a: { max: 1 } });
  });

  it("returns the same reference when nothing is removed", () => {
    const stored = { a: { max: 1 }, b: { max: 2 } };
    expect(pruneAxisScales(stored, ["a", "b"])).toBe(stored);
    expect(pruneAxisScales(stored, ["a", "b", "c"])).toBe(stored);
  });
});

describe("axisScaleIsEmpty", () => {
  it("is true only when no override is present", () => {
    expect(axisScaleIsEmpty({})).toBe(true);
    expect(axisScaleIsEmpty({ min: 0 })).toBe(false);
    expect(axisScaleIsEmpty({ log: true })).toBe(false);
  });
});

describe("resolveAxisRange (linear)", () => {
  const auto = { lo: 10, hi: 20 };

  it("passes the automatic range through when nothing is overridden", () => {
    expect(resolveAxisRange(auto, undefined, null)).toEqual({ lo: 10, hi: 20, log: false });
    expect(resolveAxisRange(auto, {}, null)).toEqual({ lo: 10, hi: 20, log: false });
  });

  it("lets either bound stand alone, leaving the other automatic", () => {
    expect(resolveAxisRange(auto, { max: 50 }, null)).toEqual({ lo: 10, hi: 50, log: false });
    expect(resolveAxisRange(auto, { min: -5 }, null)).toEqual({ lo: -5, hi: 20, log: false });
  });

  it("beats the automatic range on both sides when both are set", () => {
    expect(resolveAxisRange(auto, { min: 0, max: 1 }, null)).toEqual({ lo: 0, hi: 1, log: false });
  });

  it("has nothing to draw when a bound is manual and there is no automatic range", () => {
    expect(resolveAxisRange(null, { max: 5 }, null)).toBeNull();
    expect(resolveAxisRange(null, {}, null)).toBeNull();
  });

  it("draws from two manual bounds even with no data range", () => {
    expect(resolveAxisRange(null, { min: 0, max: 5 }, null)).toEqual({ lo: 0, hi: 5, log: false });
  });

  it("widens around the manual bound when the automatic side crosses it", () => {
    // Manual max below the data's own floor: the pair has no span, so
    // the axis takes the constant-signal band (±10 %) around the value
    // the user pinned rather than dividing by zero.
    expect(resolveAxisRange(auto, { max: 5 }, null)).toEqual({ lo: 4.5, hi: 5.5, log: false });
    expect(resolveAxisRange(auto, { min: 100 }, null)).toEqual({ lo: 90, hi: 110, log: false });
  });

  it("widens around the min when both manual bounds are inverted", () => {
    // An inverted pair is not rejected the way the visible-range input
    // rejects one, because the two fields of the y-axis menu commit
    // independently: typing a new min above the old max leaves the pair
    // inverted for as long as it takes to reach the other box. Refusing
    // it would blank the axis mid-edit. So the axis anchors on the min —
    // the bound the user just pinned — and takes the same ±10 % band a
    // constant signal gets, which keeps a readable axis on screen and
    // resolves itself the moment the max is typed.
    expect(resolveAxisRange(auto, { min: 10, max: 1 }, null)).toEqual({ lo: 9, hi: 11, log: false });
  });
});

describe("resolveAxisRange (log)", () => {
  it("derives the min from the smallest positive value present, snapped down a decade", () => {
    expect(resolveAxisRange({ lo: -5, hi: 700 }, { log: true }, 0.4)).toEqual({
      lo: 0.1,
      hi: 1000,
      log: true,
    });
  });

  it("ignores a held min — the min is not user-settable on a log axis", () => {
    expect(resolveAxisRange({ lo: -5, hi: 700 }, { min: 250, log: true }, 0.4)).toEqual({
      lo: 0.1,
      hi: 1000,
      log: true,
    });
  });

  it("keeps a manual max exactly, without snapping it to a decade", () => {
    expect(resolveAxisRange({ lo: 1, hi: 700 }, { max: 250, log: true }, 2)).toEqual({
      lo: 1,
      hi: 250,
      log: true,
    });
  });

  it("has nothing to draw when no positive value is present", () => {
    expect(resolveAxisRange({ lo: -20, hi: -1 }, { log: true }, null)).toBeNull();
    expect(resolveAxisRange(null, { log: true }, null)).toBeNull();
  });

  it("has nothing to draw when a manual max is itself non-positive", () => {
    expect(resolveAxisRange({ lo: 1, hi: 10 }, { max: -1, log: true }, 1)).toBeNull();
  });

  it("gives a collapsed log range a decade of height", () => {
    expect(resolveAxisRange({ lo: 100, hi: 100 }, { log: true }, 100)).toEqual({
      lo: 100,
      hi: 1000,
      log: true,
    });
  });
});

describe("resolveAxisRange (manual-range regression matrix)", () => {
  // Owner's 0.7.0 repro: a manual range set within a signal's own
  // 0.0-1.0 value band rendered offscreen — the bug's own account was a
  // raw-vs-normalised mismatch at this exact seam. Confirmed not to
  // reproduce on current code; these pin the seam's contract per value
  // shape so a regression here is caught. `resolveAxisRange` takes no
  // y-axis-mode argument — each derived axis (unified / per-unit /
  // individual) calls it identically regardless of mode — so the mode
  // dimension of the matrix is exercised at the DOM level instead
  // (`PlotPanel.dom.test.tsx`'s "PlotArea y-normalisation" suite).

  it("float: a manual range wider than the 0.0-1.0 data band is honoured in engineering units", () => {
    const auto = { lo: 0.2, hi: 0.8 };
    const resolved = resolveAxisRange(auto, { min: 0, max: 1 }, null);
    expect(resolved).toEqual({ lo: 0, hi: 1, log: false });
    expect(normalizeOnAxis(0.2, resolved!)).toBeCloseTo(0.2, 12);
    expect(normalizeOnAxis(0.5, resolved!)).toBeCloseTo(0.5, 12);
    expect(normalizeOnAxis(0.8, resolved!)).toBeCloseTo(0.8, 12);
  });

  it("uint: a manual range covering the full 0-255 band is honoured, not the narrower auto extent", () => {
    const auto = { lo: 50, hi: 200 };
    const resolved = resolveAxisRange(auto, { min: 0, max: 255 }, null);
    expect(resolved).toEqual({ lo: 0, hi: 255, log: false });
    expect(normalizeOnAxis(50, resolved!)).toBeCloseTo(50 / 255, 12);
    expect(normalizeOnAxis(200, resolved!)).toBeCloseTo(200 / 255, 12);
  });

  it("int: a manual range covering the full signed -128..127 band is honoured, not the narrower auto extent", () => {
    const auto = { lo: -100, hi: 100 };
    const resolved = resolveAxisRange(auto, { min: -128, max: 127 }, null);
    expect(resolved).toEqual({ lo: -128, hi: 127, log: false });
    expect(normalizeOnAxis(-100, resolved!)).toBeCloseTo(28 / 255, 12);
    expect(normalizeOnAxis(0, resolved!)).toBeCloseTo(128 / 255, 12);
    expect(normalizeOnAxis(100, resolved!)).toBeCloseTo(228 / 255, 12);
  });
});

describe("normalizeOnAxis / denormalizeOnAxis", () => {
  it("maps a linear range onto [0, 1] and back", () => {
    const r = { lo: 10, hi: 20, log: false };
    expect(normalizeOnAxis(15, r)).toBeCloseTo(0.5, 12);
    expect(denormalizeOnAxis(0.5, r)).toBeCloseTo(15, 12);
  });

  it("maps a log range by decades", () => {
    const r = { lo: 1, hi: 1000, log: true };
    expect(normalizeOnAxis(1, r)).toBeCloseTo(0, 12);
    expect(normalizeOnAxis(10, r)).toBeCloseTo(1 / 3, 12);
    expect(normalizeOnAxis(1000, r)).toBeCloseTo(1, 12);
    expect(denormalizeOnAxis(2 / 3, r)).toBeCloseTo(100, 9);
  });

  it("drops a non-positive point on a log axis rather than clamping it", () => {
    const r = { lo: 1, hi: 1000, log: true };
    expect(normalizeOnAxis(0, r)).toBeNull();
    expect(normalizeOnAxis(-3, r)).toBeNull();
  });
});

describe("logDecadeSplits", () => {
  it("puts a split on each decade boundary, in normalised positions", () => {
    expect(logDecadeSplits({ lo: 1, hi: 1000, log: true })).toEqual([0, 1 / 3, 2 / 3, 1]);
  });

  it("keeps the split count bounded over a wide range", () => {
    const splits = logDecadeSplits({ lo: 1e-6, hi: 1e12, log: true });
    expect(splits.length).toBeLessThanOrEqual(10);
    expect(splits[0]).toBeCloseTo(0, 12);
  });

  it("falls back to even splits off a log axis", () => {
    expect(logDecadeSplits({ lo: 0, hi: 1, log: false })).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});

describe("enumTickSplits", () => {
  const raws = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("keeps every raw value when uPlot's increment is finer than they are spaced", () => {
    // A three-code table on a 400 px axis: uPlot's own increment over
    // the pinned -0.5..2.5 scale is a quarter, so nothing is crowded.
    expect(enumTickSplits(raws(3), -0.5, 2.5, 0.25)).toEqual([0, 1, 2]);
  });

  it("thins a several-hundred-value table to uPlot's own tick density", () => {
    // The defect: one tick per table row, however many rows there are.
    // uPlot's chosen increment over -0.5..299.5 at 400 px is 25, and the
    // ticks it would draw at that increment are what fits.
    const splits = enumTickSplits(raws(300), -0.5, 299.5, 25);
    expect(splits.length).toBeLessThanOrEqual(Math.floor(300 / 25) + 1);
    expect(splits.length).toBeGreaterThan(1);
    expect(splits[0]).toBe(0);
    expect(splits.every((v) => raws(300).includes(v))).toBe(true);
  });

  it("drops crowded raws rather than striding blindly through a sparse table", () => {
    // 0, 1, 2 and a far-off sentinel. Every fourth entry would keep all
    // four and stack three labels on top of each other at the bottom of
    // the axis; spacing by value keeps the two that are legibly apart.
    expect(enumTickSplits([0, 1, 2, 255], -0.5, 255.5, 20)).toEqual([0, 255]);
  });

  it("sorts, and answers only what the current scale covers", () => {
    // A `VAL_` table arrives in whatever order the DBC wrote it, and a
    // splits callback owes uPlot ticks inside the scale it was handed.
    expect(enumTickSplits([5, 0, 9, 2], 1, 8, 1)).toEqual([2, 5]);
  });
});

describe("enumTickLabels", () => {
  const table = [
    { raw: 0, label: "Idle" },
    { raw: 1, label: "Arming" },
    { raw: 4, label: "Fault" },
  ];

  it("speaks the table's words, not its numbers (owner ruling 2026-08-28)", () => {
    // The individual enum axis is the reader's key to the drawn codes,
    // so its ticks read the `VAL_` names — a bare code on the gutter
    // says nothing the tile overlay doesn't already say better.
    expect(enumTickLabels([0, 1, 4], table)).toEqual(["Idle", "Arming", "Fault"]);
  });

  it("falls back to the code alone where the table names none", () => {
    expect(enumTickLabels([0, 3], table)).toEqual(["Idle", "3"]);
  });
});
