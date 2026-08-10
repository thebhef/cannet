// The plot panel's solo model: one regex dialect with the area
// patterns — the canonical `bus/ecu/message/signal` path, case-
// sensitive — the match list in panel order, the groups its captures
// bucket the matches into, the page of groups on show, and the sparse
// persisted shape.

import { describe, expect, it } from "vitest";

import {
  SOLO_OFF,
  clampSoloPage,
  soloFromRaw,
  soloGroups,
  soloKeySlots,
  soloLabel,
  soloMaskKey,
  soloMaskSignals,
  soloMaskedKeys,
  soloMatchedAreaIds,
  soloMatches,
  soloPageCount,
  soloPageOfGroup,
  soloPathResolver,
  soloPatternPages,
  soloRegex,
  soloToParams,
  soloVisibleKeys,
  stepSoloPage,
  type SoloGroup,
} from "./plotSolo";
import { applyAreaSelection, catalogPath, resolvePatterns } from "./signalSelection";
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

  it("reads a pattern-provided row exactly like a manual pick of it", () => {
    // An area may define its rows by `patterns` rather than picking them
    // (ADR 0038); those rows are materialized from the same catalog the
    // resolver indexes. Solo therefore sees no difference between the
    // two kinds — same subject, same captures — whether or not the solo
    // pattern captures anything.
    const catalog = ["Cell1", "Cell16", "PackVoltage", "cell16b", "Current"].map(desc);
    const picked = area("a1", ["Cell1", "Cell16"]);
    const materialized = applyAreaSelection(
      { id: "a1", signals: [] as SignalRef[], patterns: ["Pack/Cell"] },
      catalog,
      BUS_NAMES,
    );
    expect(materialized.signals.map((s) => s.signalName)).toEqual(["Cell1", "Cell16"]);
    const read = (a: PlotAreaConfig, pattern: string) =>
      soloMatches([a], pattern, fullPathOf).map((m) => [m.name, m.path, [...m.captures]]);
    for (const pattern of ["Cell", "Cell(\\d+)$"]) {
      expect(read(materialized, pattern)).toEqual(read(picked, pattern));
    }
  });
});

describe("soloKeySlots", () => {
  const named = (pattern: string) => soloKeySlots(pattern).map((s) => s.name);

  it("has no slots for a pattern that captures nothing", () => {
    expect(soloKeySlots("Cell\\d+")).toEqual([]);
    expect(soloKeySlots("")).toEqual([]);
    expect(soloKeySlots("Cell(")).toEqual([]);
  });

  it("keeps unnamed groups in declaration order, with no display name", () => {
    expect(soloKeySlots("Bank(\\d)_Cell(\\d+)")).toEqual([
      { index: 1, name: null },
      { index: 2, name: null },
    ]);
  });

  it("carries a named group's name for display", () => {
    expect(named("Cell(?<cell>\\d+)")).toEqual(["cell"]);
  });

  it("skips a non-capturing group — `(?:…)` opts out of the key", () => {
    expect(soloKeySlots("(?:Pack|Bank)/Cell(\\d+)")).toEqual([{ index: 1, name: null }]);
    expect(soloKeySlots("(?:a)(?=b)(?!c)(?<=d)(?<!e)")).toEqual([]);
  });

  it("ignores a parenthesis that is escaped or inside a character class", () => {
    expect(soloKeySlots("Cell\\((\\d+)\\)")).toEqual([{ index: 1, name: null }]);
    expect(soloKeySlots("[(](\\d+)")).toEqual([{ index: 1, name: null }]);
  });

  it("reorders by a `$N` ordinal suffix and strips it for display", () => {
    // `bank$1` is declared second but is the primary key component.
    expect(soloKeySlots("Cell(?<cell$2>\\d+)_Bank(?<bank$1>\\d)")).toEqual([
      { index: 2, name: "bank" },
      { index: 1, name: "cell" },
    ]);
  });

  it("puts ordinal-less groups after the ordinal-carrying ones, in declaration order", () => {
    expect(soloKeySlots("(?<a>x)(?<b$2>y)(?<c>z)(?<d$1>w)")).toEqual([
      { index: 4, name: "d" },
      { index: 2, name: "b" },
      { index: 1, name: "a" },
      { index: 3, name: "c" },
    ]);
  });

  it("reads a bare `$N` name as an ordinal with nothing left to display", () => {
    expect(soloKeySlots("(?<$2>x)(?<$1>y)")).toEqual([
      { index: 2, name: null },
      { index: 1, name: null },
    ]);
  });
});

describe("soloPatternPages", () => {
  it("pages a pattern that captures — the captures are the index", () => {
    expect(soloPatternPages("Cell(\\d+)")).toBe(true);
    expect(soloPatternPages("Cell(?<cell>\\d+)")).toBe(true);
  });

  it("does not page a pattern with nothing to page by", () => {
    // No captures, no index — the pattern is a flat filter, so there is
    // no step sequence and no page to be on.
    expect(soloPatternPages("Cell")).toBe(false);
    expect(soloPatternPages("(?:Bank|Pack)/Cell")).toBe(false);
    expect(soloPatternPages("")).toBe(false);
    expect(soloPatternPages("Cell(")).toBe(false);
  });
});

describe("soloGroups", () => {
  /// One area of cell voltages, catalogued so the paths are complete.
  const cells = ["Cell1", "Cell2", "Cell10", "Bank1_Cell3", "Bank2_Cell3"];
  const CELL_AREAS: PlotAreaConfig[] = [area("a1", cells)];
  const cellPathOf = soloPathResolver(cells.map(desc), BUS_NAMES);
  const groupsFor = (pattern: string, areas = CELL_AREAS) =>
    soloGroups(soloMatches(areas, pattern, cellPathOf), soloKeySlots(pattern));

  it("makes every match its own group when the pattern captures nothing", () => {
    const gs = groupsFor("Cell\\d+$");
    // Positional: panel order, not a sorted key order, one member each.
    expect(gs.map((g) => g.label)).toEqual([
      "Cell1",
      "Cell2",
      "Cell10",
      "Bank1_Cell3",
      "Bank2_Cell3",
    ]);
    expect(gs.map((g) => g.members.length)).toEqual([1, 1, 1, 1, 1]);
    expect(gs.every((g) => g.key.length === 0)).toBe(true);
  });

  it("groups every match sharing a captured key, across areas", () => {
    const two = [area("a1", ["Cell3"]), area("a2", ["Bank1_Cell3", "Cell1"])];
    const pathOfTwo = soloPathResolver(["Cell3", "Bank1_Cell3", "Cell1"].map(desc), BUS_NAMES);
    const gs = soloGroups(
      soloMatches(two, "Cell(\\d+)$", pathOfTwo),
      soloKeySlots("Cell(\\d+)$"),
    );
    expect(gs.map((g) => g.label)).toEqual(['"1"', '"3"']);
    expect(gs.map((g) => g.members.length)).toEqual([1, 2]);
  });

  it("orders keys numerically, not lexically", () => {
    // Cell3 is captured off two differently-named rows, and lands
    // between 2 and 10 rather than after them.
    expect(groupsFor("Cell(\\d+)$").map((g) => g.key[0])).toEqual(["1", "2", "3", "10"]);
    expect(groupsFor("Cell(\\d+)$").map((g) => g.members.length)).toEqual([1, 1, 2, 1]);
  });

  it("labels a named group as `name=value`", () => {
    expect(groupsFor("Cell(?<cell>\\d+)$").map((g) => g.label)).toEqual([
      "cell=1",
      "cell=2",
      "cell=3",
      "cell=10",
    ]);
  });

  it("keys on the tuple of groups, in the slots' order", () => {
    const gs = groupsFor("Bank(?<bank>\\d)_Cell(?<cell>\\d+)$");
    expect(gs.map((g) => g.key)).toEqual([
      ["1", "3"],
      ["2", "3"],
    ]);
    expect(gs.map((g) => g.label)).toEqual(["bank=1,cell=3", "bank=2,cell=3"]);
  });

  it("sorts by the `$N`-declared primary component first", () => {
    // Declaration order is (cell, bank); the ordinals make bank primary,
    // so the two Cell3s sort apart by bank rather than together by cell.
    const gs = groupsFor("Bank(?<bank$2>\\d)_Cell(?<cell$1>\\d+)$");
    expect(gs.map((g) => g.label)).toEqual(["cell=3,bank=1", "cell=3,bank=2"]);
  });

  it("keeps a match whose group did not participate, under an empty component", () => {
    // An alternation the group sits outside of captures nothing. The
    // match is still a match, so it still belongs to a group — dropping
    // it would make it unreachable through every page.
    const gs = groupsFor("(?:Bank(\\d)_)?Cell(\\d+)$");
    expect(gs.map((g) => g.key)).toEqual([
      ["", "1"],
      ["", "2"],
      ["", "10"],
      ["1", "3"],
      ["2", "3"],
    ]);
    expect(gs[0].label).toBe('"","1"');
  });

  it("is empty when nothing matched", () => {
    expect(groupsFor("Nope(\\d+)")).toEqual([]);
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
  const groupsOf = (pattern: string, areas: PlotAreaConfig[] = AREAS) =>
    soloGroups(soloMatches(areas, pattern, fullPathOf), soloKeySlots(pattern));

  it("holds every match while the whole set is shown", () => {
    const gs = groupsOf("[Cc]ell");
    const vis = soloVisibleKeys(gs, null, 1);
    expect(vis.size).toBe(3);
  });

  it("holds only the page's groups", () => {
    const gs = groupsOf("[Cc]ell");
    expect(soloVisibleKeys(gs, 0, 1).size).toBe(1);
    expect(soloVisibleKeys(gs, 0, 2).size).toBe(2);
    // The last page is short when the groups don't divide evenly.
    expect(soloVisibleKeys(gs, 1, 2).size).toBe(1);
  });

  it("holds every member of a keyed group, across areas", () => {
    const both = [area("a1", ["Cell16"]), area("a2", ["Cell16"])];
    const gs = soloGroups(
      soloMatches(both, "Cell(16)", fullPathOf),
      soloKeySlots("Cell(16)"),
    );
    expect(gs.length).toBe(1);
    expect(soloVisibleKeys(gs, 0, 1).size).toBe(2);
  });

  it("keys by area *and* signal, so the same signal in two areas is two entries", () => {
    const both = [area("a1", ["Cell16"]), area("a2", ["Cell16"])];
    const ms = soloMatches(both, "Cell16", fullPathOf);
    // No captures, so each of the two rows is its own group.
    const gs = soloGroups(ms, soloKeySlots("Cell16"));
    expect(gs.length).toBe(2);
    const vis = soloVisibleKeys(gs, 0, 1);
    expect(vis.has(soloMaskKey("a1", ms[0].key))).toBe(true);
    expect(vis.has(soloMaskKey("a2", ms[1].key))).toBe(false);
  });

  it("is empty past the end of a shrunken group list", () => {
    expect(soloVisibleKeys(groupsOf("[Cc]ell"), 9, 1).size).toBe(0);
  });
});

describe("soloPageCount", () => {
  it("is the groups divided by the page size, rounded up", () => {
    expect(soloPageCount(12, 5)).toBe(3);
    expect(soloPageCount(10, 5)).toBe(2);
    expect(soloPageCount(3, 1)).toBe(3);
  });

  it("is zero with no groups — there is nothing to page through", () => {
    expect(soloPageCount(0, 5)).toBe(0);
  });

  it("treats a page size below one as one, so a page is never empty", () => {
    expect(soloPageCount(3, 0)).toBe(3);
    expect(soloPageCount(3, -4)).toBe(3);
  });
});

describe("clampSoloPage", () => {
  it("leaves the whole-set view alone", () => {
    expect(clampSoloPage(null, 3)).toBeNull();
  });

  it("pulls a restored page past the end back onto the last one", () => {
    expect(clampSoloPage(9, 3)).toBe(2);
  });

  it("falls back to the whole-set view when there are no pages at all", () => {
    expect(clampSoloPage(2, 0)).toBeNull();
  });

  it("keeps a page that is in range, and floors a negative one", () => {
    expect(clampSoloPage(1, 3)).toBe(1);
    expect(clampSoloPage(-2, 3)).toBe(0);
  });
});

describe("stepSoloPage", () => {
  it("cycles all -> page 1 -> ... -> page N -> all", () => {
    expect(stepSoloPage(null, 3, 1)).toBe(0);
    expect(stepSoloPage(0, 3, 1)).toBe(1);
    expect(stepSoloPage(1, 3, 1)).toBe(2);
    // Past the last page is the whole set again, not page 1.
    expect(stepSoloPage(2, 3, 1)).toBeNull();
  });

  it("cycles the same ring backwards", () => {
    expect(stepSoloPage(0, 3, -1)).toBeNull();
    expect(stepSoloPage(null, 3, -1)).toBe(2);
    expect(stepSoloPage(2, 3, -1)).toBe(1);
  });

  it("has nowhere to step with no pages", () => {
    expect(stepSoloPage(null, 0, 1)).toBeNull();
    expect(stepSoloPage(0, 0, -1)).toBeNull();
  });
});

describe("soloPageOfGroup", () => {
  it("is the page a group sits on", () => {
    expect(soloPageOfGroup(0, 5)).toBe(0);
    expect(soloPageOfGroup(4, 5)).toBe(0);
    expect(soloPageOfGroup(5, 5)).toBe(1);
    expect(soloPageOfGroup(7, 1)).toBe(7);
  });
});

describe("soloLabel", () => {
  /// `count` groups of one member each, labelled by their key.
  const fakeGroups = (labels: string[]): SoloGroup[] =>
    labels.map((label, i) => ({ key: [label], label, members: [`a1 m${i}`] }));

  it("says so when nothing matched", () => {
    expect(soloLabel([], null, 1, 0)).toBe("no matches");
    expect(soloLabel([], 0, 1, 0)).toBe("no matches");
  });

  it("counts the matches while the whole set is shown", () => {
    expect(soloLabel(fakeGroups(["1", "2"]), null, 1, 96)).toBe("all (96)");
  });

  it("names the page's group, its position and its share of the matches", () => {
    const gs: SoloGroup[] = [
      { key: ["06"], label: "cell=06", members: ["a1 x"] },
      { key: ["07"], label: "cell=07", members: ["a1 y", "a2 y"] },
    ];
    expect(soloLabel(gs, 1, 1, 96)).toBe("2/2 · cell=07 (2 of 96)");
  });

  it("reads an unnamed capture as the quoted text", () => {
    const gs: SoloGroup[] = [{ key: ["07"], label: '"07"', members: ["a1 y"] }];
    expect(soloLabel(gs, 0, 1, 96)).toBe('1/1 · "07" (1 of 96)');
  });

  it("reads a multi-group page as the range it spans", () => {
    const gs = fakeGroups(['"0"', '"1"', '"2"', '"3"', '"4"', '"5"']);
    expect(soloLabel(gs, 0, 5, 96)).toBe('1/2 · "0"–"4" (5 of 96)');
    // …and a short last page reads to its own end.
    expect(soloLabel(gs, 1, 5, 96)).toBe('2/2 · "5" (1 of 96)');
  });

  it("reads a page past the end as the last page", () => {
    expect(soloLabel(fakeGroups(["a", "b"]), 9, 1, 2)).toBe("2/2 · b (1 of 2)");
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

describe("soloMaskedKeys", () => {
  // Cell1 draws on its own; PackVoltage is already hidden by the user,
  // independent of solo.
  const cell1 = sig("Cell1");
  const packVoltage = sig("PackVoltage", true);
  const signals = [cell1, packVoltage];
  const allVisible = new Set(signals.map((s) => soloMaskKey("a1", signalRefKey(s))));

  it("is empty when nothing is masked", () => {
    expect(soloMaskedKeys("a1", signals, allVisible)).toEqual(new Set());
  });

  it("names only the signal solo pushed out of view, not one already hidden on its own", () => {
    // Neither is in the visible set, but only Cell1 was actually drawing
    // before solo — PackVoltage was already hidden, so solo isn't what
    // took it away, and it doesn't belong to solo's mask feedback.
    expect(soloMaskedKeys("a1", signals, new Set())).toEqual(new Set([signalRefKey(cell1)]));
  });
});

describe("solo persistence", () => {
  it("persists nothing while solo is off", () => {
    expect(soloToParams(SOLO_OFF)).toBeUndefined();
    expect(soloToParams({ pattern: "", page: 1 })).toBeUndefined();
  });

  it("persists the pattern alone while the whole set is shown", () => {
    expect(soloToParams({ pattern: "Cell", page: null })).toEqual({ pattern: "Cell" });
  });

  it("persists the page alongside the pattern", () => {
    expect(soloToParams({ pattern: "Cell(\\d)", page: 2 })).toEqual({
      pattern: "Cell(\\d)",
      page: 2,
    });
  });

  it("round-trips through the parser", () => {
    const state = { pattern: "Cell(\\d)", page: 2 };
    expect(soloFromRaw(soloToParams(state))).toEqual(state);
    expect(soloFromRaw(soloToParams({ pattern: "Cell", page: null }))).toEqual({
      pattern: "Cell",
      page: null,
    });
  });

  it("reads a stored page under a captureless pattern as the flat view", () => {
    // A captureless pattern has no pages at all, so a page stored
    // against one — by an older build, or by an edit that dropped the
    // capture group — names nothing. The pattern is what survives.
    expect(soloFromRaw({ pattern: "Cell", page: 2 })).toEqual({ pattern: "Cell", page: null });
  });

  it("reads a missing / malformed blob as solo off", () => {
    expect(soloFromRaw(undefined)).toEqual(SOLO_OFF);
    expect(soloFromRaw(null)).toEqual(SOLO_OFF);
    expect(soloFromRaw("Cell")).toEqual(SOLO_OFF);
    expect(soloFromRaw({ page: 1 })).toEqual(SOLO_OFF);
  });

  it("drops a junk page rather than rejecting the blob", () => {
    for (const page of ["x", -2, 3.5, null, {}]) {
      expect(soloFromRaw({ pattern: "Cell", page })).toEqual({ pattern: "Cell", page: null });
    }
  });

  it("reads a blob from before paging as the pattern, whole set shown", () => {
    // The old shape carried raw match indices, which index a list that
    // no longer exists; the pattern is the part still worth keeping.
    expect(soloFromRaw({ pattern: "Cell", indices: [2] })).toEqual({
      pattern: "Cell",
      page: null,
    });
  });
});
