// What gives way when a toolbar runs out of room.
//
// A bar is one row and never wraps, so fit is guaranteed by removing
// things. Two different things give way and they give way differently:
// an item in a run that does not overflow *drops* (the status bar's
// metrics — the number is still in the label tooltip), an item in a run
// that does overflow *collapses* into the overflow menu (a hidden alert
// would be a defect, so it can only ever become one click away).
//
// The third rule is the one panel bars need: items may be tied into an
// unbreakable cluster, which is removed whole or not at all.

import { describe, expect, it } from "vitest";

import { planToolbarFit, toolbarRemovalOrder, type ToolbarRun } from "./toolbarFit";

// The status bar's own arrangement: six metrics in the ruled
// left-to-right order and three pinned chips in theirs, each 100 wide,
// with a 50-wide overflow control.
const METRICS = [100, 100, 100, 100, 100, 100];
const CHIPS = [100, 100, 100];
const OVERFLOW = 50;

function fit(available: number) {
  return planToolbarFit({
    available,
    runs: [
      { id: "metrics", widths: METRICS, overflow: false },
      { id: "chips", widths: CHIPS, overflow: true },
    ],
    overflowWidth: OVERFLOW,
  });
}

describe("toolbarRemovalOrder", () => {
  it("alternates an item off the right of one run with an item off the right of the next", () => {
    // The order the status bar's three widths illustrate: cache, RBS,
    // RAM, Signal mapping, elapsed, System messages, frames, bus load,
    // f/s. Metrics are indexed from the right of the metric list,
    // chips from the right of the chip list.
    expect(
      toolbarRemovalOrder([
        { id: "metrics", units: 6 },
        { id: "chips", units: 3 },
      ]),
    ).toEqual([
      "metrics",
      "chips",
      "metrics",
      "chips",
      "metrics",
      "chips",
      "metrics",
      "metrics",
      "metrics",
    ]);
  });

  it("keeps going with whichever run still has something in it", () => {
    expect(
      toolbarRemovalOrder([
        { id: "metrics", units: 1 },
        { id: "chips", units: 3 },
      ]),
    ).toEqual(["metrics", "chips", "chips", "chips"]);
    expect(
      toolbarRemovalOrder([
        { id: "metrics", units: 3 },
        { id: "chips", units: 0 },
      ]),
    ).toEqual(["metrics", "metrics", "metrics"]);
  });

  it("gives up the whole of a single run when that is all there is", () => {
    // The shape every panel toolbar has: one run, everything in it
    // collapsing right to left.
    expect(toolbarRemovalOrder([{ id: "items", units: 3 }])).toEqual([
      "items",
      "items",
      "items",
    ]);
  });
});

describe("planToolbarFit", () => {
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

  it("reproduces the status bar's tighter arrangement: RAM and cache dropped, RBS collapsed", () => {
    // 4 metrics + 2 chips + overflow = 650.
    expect(fit(650)).toEqual({ metrics: 4, chips: 2 });
  });

  it("reproduces the status bar's narrow arrangement: only f/s and bus load survive, all three chips collapsed", () => {
    // 2 metrics + 0 chips + overflow = 250.
    expect(fit(250)).toEqual({ metrics: 2, chips: 0 });
  });

  it("gives up the last item rather than the row", () => {
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
    const plan = planToolbarFit({
      available: 1,
      runs: [
        { id: "metrics", widths: [], overflow: false },
        { id: "chips", widths: CHIPS, overflow: true },
      ],
      overflowWidth: OVERFLOW,
    });
    expect(plan).toEqual({ metrics: 0, chips: 0 });
  });
});

// The plot toolbar's solo cluster — a field, its paging and its clear —
// is one control wearing three hats. Half of it on the bar and half in
// the overflow is worse than all of it in either place.
describe("planToolbarFit with an unbreakable cluster", () => {
  // Five items of 100, of which the middle three are one cluster.
  const CLUSTERED: ToolbarRun = {
    id: "items",
    widths: [100, 100, 100, 100, 100],
    clusters: [undefined, "solo", "solo", "solo", undefined],
    overflow: true,
  };
  const clustered = (available: number) =>
    planToolbarFit({ available, runs: [CLUSTERED], overflowWidth: OVERFLOW }).items;

  it("never leaves part of a cluster on the bar, at any width", () => {
    // The whole point: keeping 2 or 3 items would leave the cluster
    // half on the bar, so no width may ever produce them. 0, 1, 4 and 5
    // each land on a cluster boundary.
    const reachable = new Set<number>();
    for (let available = 1; available <= 700; available += 1) {
      reachable.add(clustered(available));
    }
    expect([...reachable].sort((a, b) => a - b)).toEqual([0, 1, 4, 5]);
  });

  it("takes the whole cluster in one step once the item to its right has gone", () => {
    // 5 items and no overflow control = 500.
    expect(clustered(500)).toBe(5);
    // 4 items + overflow = 450 — the un-clustered item on the right
    // goes first.
    expect(clustered(499)).toBe(4);
    // 450 is the last width that arrangement fits in; below it the
    // cluster goes whole, straight to the one item left of it.
    expect(clustered(450)).toBe(4);
    expect(clustered(449)).toBe(1);
    // 1 item + overflow = 150.
    expect(clustered(150)).toBe(1);
    expect(clustered(149)).toBe(0);
  });

  it("spills a cluster placed left only once everything to its right has gone", () => {
    // The plot bar's arrangement: the solo cluster first, the rest of
    // the controls to its right.
    const run: ToolbarRun = {
      id: "items",
      widths: [100, 100, 100, 100, 100],
      clusters: ["solo", "solo", "solo", undefined, undefined],
      overflow: true,
    };
    const kept = (available: number) =>
      planToolbarFit({ available, runs: [run], overflowWidth: OVERFLOW }).items;
    expect(kept(500)).toBe(5);
    expect(kept(499)).toBe(4);
    expect(kept(449)).toBe(3);
    // Below the cluster's own width plus the overflow control, the
    // cluster goes whole and the bar is left with nothing.
    expect(kept(349)).toBe(0);
  });

  it("treats a run with no clusters as one unit per item", () => {
    const run: ToolbarRun = { id: "items", widths: [100, 100, 100], overflow: true };
    const kept = (available: number) =>
      planToolbarFit({ available, runs: [run], overflowWidth: OVERFLOW }).items;
    expect(kept(300)).toBe(3);
    expect(kept(299)).toBe(2);
    expect(kept(249)).toBe(1);
    expect(kept(149)).toBe(0);
  });
});
