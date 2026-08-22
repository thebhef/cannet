// What gives way when the status bar runs out of room.
//
// The bar is one row and never wraps, so fit is guaranteed by removing
// things. Two different things give way and they give way differently:
// a metric *drops* (its number is still in the label tooltip), a
// pinned chip *collapses* into the overflow menu (a hidden alert would
// be a defect, so it can only ever become one click away).

import { describe, expect, it } from "vitest";

import { planStatusBarFit, statusBarRemovalOrder } from "./statusBarFit";

// Six metrics in the ruled left-to-right order and three pinned chips
// in theirs, each 100 wide, with a 50-wide overflow control.
const METRICS = [100, 100, 100, 100, 100, 100];
const CHIPS = [100, 100, 100];
const OVERFLOW = 50;

function fit(available: number) {
  return planStatusBarFit({
    available,
    metricWidths: METRICS,
    chipWidths: CHIPS,
    overflowWidth: OVERFLOW,
  });
}

describe("statusBarRemovalOrder", () => {
  it("alternates a metric off the right with a chip off the right", () => {
    // The order the prototype's three widths illustrate: cache, RBS,
    // RAM, Signal mapping, elapsed, System messages, frames, bus load,
    // f/s. Metrics are indexed from the right of the metric list,
    // chips from the right of the chip list.
    expect(statusBarRemovalOrder(6, 3)).toEqual([
      "metric",
      "chip",
      "metric",
      "chip",
      "metric",
      "chip",
      "metric",
      "metric",
      "metric",
    ]);
  });

  it("keeps going with whichever list still has something in it", () => {
    expect(statusBarRemovalOrder(1, 3)).toEqual(["metric", "chip", "chip", "chip"]);
    expect(statusBarRemovalOrder(3, 0)).toEqual(["metric", "metric", "metric"]);
  });
});

describe("planStatusBarFit", () => {
  it("keeps everything when everything fits", () => {
    // 6 metrics + 3 chips, no overflow control needed.
    expect(fit(900)).toEqual({ metrics: 6, chips: 3 });
  });

  it("drops the rightmost metric first — cache goes before any chip collapses", () => {
    expect(fit(899)).toEqual({ metrics: 5, chips: 3 });
  });

  it("collapses the rightmost chip next, and the overflow control costs its own width", () => {
    // 5 metrics + 2 chips + overflow = 750.
    expect(fit(799)).toEqual({ metrics: 5, chips: 2 });
    expect(fit(750)).toEqual({ metrics: 5, chips: 2 });
    expect(fit(749)).toEqual({ metrics: 4, chips: 2 });
  });

  it("reproduces the prototype's tighter bar: RAM and cache dropped, RBS collapsed", () => {
    // 4 metrics + 2 chips + overflow = 650.
    expect(fit(650)).toEqual({ metrics: 4, chips: 2 });
  });

  it("reproduces the prototype's narrow bar: only f/s and bus load survive, all three chips collapsed", () => {
    // 2 metrics + 0 chips + overflow = 250.
    expect(fit(250)).toEqual({ metrics: 2, chips: 0 });
  });

  it("gives up the last metric rather than the row", () => {
    expect(fit(0.5)).toEqual({ metrics: 0, chips: 0 });
  });

  it("puts back exactly what fits again when the bar widens", () => {
    // The control that discriminates: the same widths, read upwards.
    expect(fit(250)).toEqual({ metrics: 2, chips: 0 });
    expect(fit(350)).toEqual({ metrics: 3, chips: 0 });
    expect(fit(450)).toEqual({ metrics: 3, chips: 1 });
    expect(fit(550)).toEqual({ metrics: 4, chips: 1 });
    expect(fit(650)).toEqual({ metrics: 4, chips: 2 });
    expect(fit(750)).toEqual({ metrics: 5, chips: 2 });
    expect(fit(900)).toEqual({ metrics: 6, chips: 3 });
  });

  it("treats an unmeasured bar as roomy rather than collapsing everything", () => {
    // Before the first layout there is no width to read, and a bar
    // that collapsed itself on that would flash empty on every mount.
    expect(fit(0)).toEqual({ metrics: 6, chips: 3 });
  });

  it("still shows the overflow control when there are chips but no room at all", () => {
    const plan = planStatusBarFit({
      available: 1,
      metricWidths: [],
      chipWidths: CHIPS,
      overflowWidth: OVERFLOW,
    });
    expect(plan).toEqual({ metrics: 0, chips: 0 });
  });
});
