// The plot panel's solo model: a case-insensitive partial-match regex
// over the series display name, the match list in panel order, the
// visible subset (all matches, or a stepped / checked selection of
// them), and the sparse persisted shape.

import { describe, expect, it } from "vitest";

import {
  SOLO_OFF,
  soloFromRaw,
  soloMaskKey,
  soloMaskSignals,
  soloMatches,
  soloPositionLabel,
  soloRegex,
  soloToParams,
  soloVisibleKeys,
  stepSolo,
  toggleSoloIndex,
} from "./plotSolo";
import { signalRefKey, type PlotAreaConfig, type SignalRef } from "./plotPanelConfig";

function sig(signalName: string, hidden?: boolean): SignalRef {
  return {
    busId: null,
    messageId: 256,
    extended: false,
    signalName,
    messageName: "Pack",
    unit: "V",
    ...(hidden ? { hidden: true } : {}),
  };
}

function area(id: string, names: string[]): PlotAreaConfig {
  return { id, signals: names.map((n) => sig(n)) };
}

const AREAS: PlotAreaConfig[] = [
  area("a1", ["Cell1", "Cell16", "PackVoltage"]),
  area("a2", ["cell16b", "Current"]),
];

describe("soloRegex", () => {
  it("is a case-insensitive partial match", () => {
    const re = soloRegex(".?Cell16.?")!;
    expect(re.test("Cell16")).toBe(true);
    expect(re.test("xcell16y")).toBe(true);
    expect(re.test("Cell1")).toBe(false);
  });

  it("matches partially — an unanchored fragment is enough", () => {
    expect(soloRegex("ell1")!.test("Cell16")).toBe(true);
  });

  it("is null for an empty pattern (solo off) and for an invalid one", () => {
    expect(soloRegex("")).toBeNull();
    expect(soloRegex("Cell(")).toBeNull();
    expect(soloRegex("[")).toBeNull();
  });

  it("never throws on an invalid pattern — it is inert", () => {
    expect(() => soloRegex("*")).not.toThrow();
    expect(soloRegex("*")).toBeNull();
  });
});

describe("soloMatches", () => {
  it("lists matches in area order, then row order within each area", () => {
    expect(soloMatches(AREAS, "cell").map((m) => m.name)).toEqual([
      "Cell1",
      "Cell16",
      "cell16b",
    ]);
    expect(soloMatches(AREAS, "cell").map((m) => m.areaId)).toEqual(["a1", "a1", "a2"]);
  });

  it("matches the display name only, not the message or bus", () => {
    expect(soloMatches(AREAS, "Pack").map((m) => m.name)).toEqual(["PackVoltage"]);
  });

  it("is empty for an invalid or empty pattern", () => {
    expect(soloMatches(AREAS, "Cell(")).toEqual([]);
    expect(soloMatches(AREAS, "")).toEqual([]);
  });
});

describe("soloVisibleKeys", () => {
  const matches = soloMatches(AREAS, "cell");

  it("holds every match when no subset is chosen", () => {
    const vis = soloVisibleKeys(matches, null);
    expect(vis.size).toBe(3);
    for (const m of matches) expect(vis.has(soloMaskKey(m.areaId, m.key))).toBe(true);
  });

  it("holds just the chosen indices in step / subset mode", () => {
    const vis = soloVisibleKeys(matches, [1]);
    expect(vis.size).toBe(1);
    expect(vis.has(soloMaskKey(matches[1].areaId, matches[1].key))).toBe(true);
  });

  it("keys by area *and* signal, so the same signal in two areas is two entries", () => {
    const both = [area("a1", ["Cell16"]), area("a2", ["Cell16"])];
    const ms = soloMatches(both, "Cell16");
    expect(ms.length).toBe(2);
    const vis = soloVisibleKeys(ms, [0]);
    expect(vis.has(soloMaskKey("a1", ms[0].key))).toBe(true);
    expect(vis.has(soloMaskKey("a2", ms[1].key))).toBe(false);
  });

  it("ignores an index past the end of a shrunken match list", () => {
    expect(soloVisibleKeys(matches, [9]).size).toBe(0);
  });
});

describe("stepSolo", () => {
  it("enters step mode at the first match going forward, the last going back", () => {
    expect(stepSolo(null, 17, 1)).toEqual([0]);
    expect(stepSolo(null, 17, -1)).toEqual([16]);
  });

  it("steps one match at a time", () => {
    expect(stepSolo([2], 17, 1)).toEqual([3]);
    expect(stepSolo([3], 17, -1)).toEqual([2]);
  });

  it("wraps at both ends", () => {
    expect(stepSolo([16], 17, 1)).toEqual([0]);
    expect(stepSolo([0], 17, -1)).toEqual([16]);
  });

  it("steps off the edge of a checked subset — forward from its last, back from its first", () => {
    expect(stepSolo([1, 4], 17, 1)).toEqual([5]);
    expect(stepSolo([1, 4], 17, -1)).toEqual([0]);
  });

  it("has nowhere to step with no matches", () => {
    expect(stepSolo(null, 0, 1)).toEqual([]);
  });
});

describe("toggleSoloIndex", () => {
  it("unchecks one out of the all-visible view, leaving the rest", () => {
    expect(toggleSoloIndex(null, 3, 1)).toEqual([0, 2]);
  });

  it("adds and removes from a checked subset, keeping it ordered", () => {
    expect(toggleSoloIndex([2], 3, 0)).toEqual([0, 2]);
    expect(toggleSoloIndex([0, 2], 3, 2)).toEqual([0]);
  });

  it("allows an empty subset — nothing visible until something is re-checked", () => {
    expect(toggleSoloIndex([1], 3, 1)).toEqual([]);
  });
});

describe("soloPositionLabel", () => {
  it("reads as a position in step mode", () => {
    expect(soloPositionLabel([2], 17)).toBe("3/17");
  });

  it("is a bare count when every match is visible — there is no position", () => {
    expect(soloPositionLabel(null, 17)).toBe("17");
  });

  it("counts the checked subset when several are visible", () => {
    expect(soloPositionLabel([1, 4, 9], 17)).toBe("3/17");
  });

  it("reads 0 with no matches", () => {
    expect(soloPositionLabel(null, 0)).toBe("0");
  });
});

describe("soloMaskSignals", () => {
  const signals = [sig("Cell1"), sig("Cell16", true)];
  const allVisible = new Set(signals.map((s) => soloMaskKey("a1", signalRefKey(s))));

  it("returns the input array itself when nothing is masked", () => {
    expect(soloMaskSignals("a1", signals, allVisible)).toBe(signals);
  });

  it("hides the signals outside the visible set", () => {
    const visible = new Set([soloMaskKey("a1", signalRefKey(signals[0]))]);
    expect(soloMaskSignals("a1", signals, visible).map((s) => !!s.hidden)).toEqual([false, true]);
  });

  it("never un-hides a signal the user hid — solo composes on top of `hidden`", () => {
    expect(soloMaskSignals("a1", signals, allVisible)[1].hidden).toBe(true);
  });
});

describe("solo persistence", () => {
  it("persists nothing while solo is off", () => {
    expect(soloToParams(SOLO_OFF)).toBeUndefined();
    expect(soloToParams({ pattern: "", indices: [1] })).toBeUndefined();
  });

  it("persists the pattern alone in the matches-only view", () => {
    expect(soloToParams({ pattern: "Cell", indices: null })).toEqual({ pattern: "Cell" });
  });

  it("persists the chosen indices alongside the pattern", () => {
    expect(soloToParams({ pattern: "Cell", indices: [2] })).toEqual({
      pattern: "Cell",
      indices: [2],
    });
  });

  it("round-trips through the parser", () => {
    const state = { pattern: "Cell", indices: [2] };
    expect(soloFromRaw(soloToParams(state))).toEqual(state);
    expect(soloFromRaw(soloToParams({ pattern: "Cell", indices: null }))).toEqual({
      pattern: "Cell",
      indices: null,
    });
  });

  it("reads a missing / malformed blob as solo off", () => {
    expect(soloFromRaw(undefined)).toEqual(SOLO_OFF);
    expect(soloFromRaw(null)).toEqual(SOLO_OFF);
    expect(soloFromRaw("Cell")).toEqual(SOLO_OFF);
    expect(soloFromRaw({ indices: [1] })).toEqual(SOLO_OFF);
  });

  it("drops junk index entries rather than rejecting the blob", () => {
    expect(soloFromRaw({ pattern: "Cell", indices: [1, "x", -2, 3.5] })).toEqual({
      pattern: "Cell",
      indices: [1],
    });
  });
});

describe("stepSolo page size", () => {
  it("moves a page at a time once step mode is entered", () => {
    // Entering always lands on the first match — a page size must not
    // skip the start of the list — and the moves after it page.
    expect(stepSolo(null, 10, 1, 4)).toEqual([0]);
    expect(stepSolo([0], 10, 1, 4)).toEqual([4]);
    expect(stepSolo([4], 10, 1, 4)).toEqual([8]);
    // …wrapping like a single step does.
    expect(stepSolo([8], 10, 1, 4)).toEqual([2]);
    expect(stepSolo([2], 10, -1, 4)).toEqual([8]);
  });

  it("enters backwards on the last match whatever the page size", () => {
    expect(stepSolo(null, 10, -1, 4)).toEqual([9]);
  });

  it("treats a page below one as one, so the key is never a no-op", () => {
    expect(stepSolo([3], 10, 1, 0)).toEqual([4]);
    expect(stepSolo([3], 10, 1, -5)).toEqual([4]);
  });
});
