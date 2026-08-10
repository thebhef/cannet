// The plot panel's solo model: one regex dialect with the area
// patterns — the canonical `bus/ecu/message/signal` path, case-
// sensitive — the match list in panel order, the visible subset (all
// matches, or a stepped / checked selection of them), and the sparse
// persisted shape.

import { describe, expect, it } from "vitest";

import {
  SOLO_OFF,
  soloFromRaw,
  soloMaskKey,
  soloMaskSignals,
  soloMatchedAreaIds,
  soloMatches,
  soloPathResolver,
  soloPositionLabel,
  soloRegex,
  soloToParams,
  soloVisibleKeys,
  stepSolo,
  toggleSoloIndex,
} from "./plotSolo";
import { catalogPath, resolvePatterns } from "./signalSelection";
import { signalRefKey, type PlotAreaConfig, type SignalRef } from "./plotPanelConfig";
import type { SignalDescriptorRecord } from "./types";

function sig(signalName: string, hidden?: boolean): SignalRef {
  return {
    busId: "bus-a",
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

/// A catalog entry for one of the {@link AREAS} names, so the resolver
/// has a transmitter and a bus to build a full path from.
function desc(signalName: string): SignalDescriptorRecord {
  return {
    bus_id: "bus-a",
    message_id: 256,
    extended: false,
    message_name: "Pack",
    transmitter: "BmsEcu",
    signal_name: signalName,
    unit: "V",
  };
}

const BUS_NAMES = new Map([["bus-a", "Vehicle"]]);
/// The panel's resolver, with `Cell16` catalogued and everything else
/// missing — the two paths a plotted series can take to a subject.
const pathOf = soloPathResolver([desc("Cell16")], BUS_NAMES);
/// Everything catalogued, for the grouping / stepping fixtures.
const fullPathOf = soloPathResolver(
  ["Cell1", "Cell16", "PackVoltage", "cell16b", "Current"].map(desc),
  BUS_NAMES,
);

describe("soloPathResolver", () => {
  it("resolves a catalogued series to the ADR 0038 canonical path", () => {
    expect(pathOf(sig("Cell16"))).toBe("Vehicle/BmsEcu/Pack/Cell16");
    expect(pathOf(sig("Cell16"))).toBe(catalogPath(desc("Cell16"), BUS_NAMES));
  });

  it("falls back to empty segments for a series the catalog doesn't carry", () => {
    // Same shape as the shared helper's missing-segment rule: the
    // positions stay put so a path pattern still lines up — only the
    // ecu, which nothing but the catalog knows, goes blank.
    expect(pathOf(sig("Cell1"))).toBe("Vehicle//Pack/Cell1");
  });
});

describe("soloRegex", () => {
  it("is case-sensitive — the area patterns' dialect, not a second one", () => {
    const re = soloRegex(".?Cell16.?")!;
    expect(re.test("Cell16x")).toBe(true);
    expect(re.test("xcell16y")).toBe(false);
    expect(re.flags).toBe("");
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
    expect(soloMatches(AREAS, "Cell", fullPathOf).map((m) => m.name)).toEqual([
      "Cell1",
      "Cell16",
    ]);
    expect(soloMatches(AREAS, "Cell", fullPathOf).map((m) => m.areaId)).toEqual(["a1", "a1"]);
  });

  it("matches the whole path, so a bus / ecu / message fragment selects too", () => {
    expect(soloMatches(AREAS, "BmsEcu/Pack/Current", fullPathOf).map((m) => m.name)).toEqual([
      "Current",
    ]);
    expect(soloMatches(AREAS, "^Vehicle/", fullPathOf).map((m) => m.name)).toEqual([
      "Cell1",
      "Cell16",
      "PackVoltage",
      "cell16b",
      "Current",
    ]);
  });

  it("still matches a bare name as the path's tail", () => {
    expect(soloMatches(AREAS, "cell16b$", fullPathOf).map((m) => m.name)).toEqual(["cell16b"]);
  });

  it("carries the matched path so grouping can read the captures off it", () => {
    expect(soloMatches(AREAS, "Cell16$", fullPathOf).map((m) => m.path)).toEqual([
      "Vehicle/BmsEcu/Pack/Cell16",
    ]);
  });

  it("agrees with the area patterns' own resolution — one dialect, one subject", () => {
    // The same regex, run through the solo matcher and through
    // `resolvePatterns` (what an area's `patterns` list uses), picks the
    // same signals.
    const catalog = ["Cell1", "Cell16", "PackVoltage", "cell16b", "Current"].map(desc);
    for (const pattern of ["Cell1", "^Vehicle/BmsEcu/", "cell16b$", "Pack/[Cc]ell"]) {
      const viaSolo = soloMatches(AREAS, pattern, fullPathOf).map((m) => m.name);
      const viaPatterns = resolvePatterns([pattern], catalog, BUS_NAMES)[0].matches.map(
        (s) => s.signal_name,
      );
      expect(viaSolo).toEqual(viaPatterns);
    }
  });

  it("is empty for an invalid or empty pattern", () => {
    expect(soloMatches(AREAS, "Cell(", fullPathOf)).toEqual([]);
    expect(soloMatches(AREAS, "", fullPathOf)).toEqual([]);
  });
});

describe("soloMatchedAreaIds", () => {
  it("names only the areas holding at least one match", () => {
    expect([...soloMatchedAreaIds(soloMatches(AREAS, "Cell16$", fullPathOf))]).toEqual(["a1"]);
    expect([...soloMatchedAreaIds(soloMatches(AREAS, "[Cc]ell16", fullPathOf))]).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("is empty when nothing matches — solo then scopes to no area at all", () => {
    expect(soloMatchedAreaIds(soloMatches(AREAS, "Nope", fullPathOf)).size).toBe(0);
  });
});

describe("soloVisibleKeys", () => {
  const matches = soloMatches(AREAS, "[Cc]ell", fullPathOf);

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
    const ms = soloMatches(both, "Cell16", fullPathOf);
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
