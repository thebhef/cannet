// The gridview's filter slot (ADR 0044): one fzf-over-client-rows
// implementation — query → matching rows plus their ancestors. The DBC
// panel's hand-rolled copy was the spec, so these tests pin the two
// properties it had that a naive `fzf.find` does not: the index is built
// lazily (nothing is paid for until the user types) and the results are
// cut at a relative score floor (fzf accepts any subsequence, so a large
// database "matches" a lot of noise).

import { describe, expect, it, vi } from "vitest";

import {
  type GridviewFilterEntry,
  gridviewMatches,
  lazyGridviewMatcher,
} from "./gridviewFilter";

const ENTRIES: GridviewFilterEntry[] = [
  { id: "sig:speed", ancestors: ["bus", "dbc", "msg"], haystack: "chassis.Brake.VehicleSpeed km/h" },
  { id: "sig:press", ancestors: ["bus", "dbc", "msg"], haystack: "chassis.Brake.BrakePressure bar" },
  // The user-reported junk match: a module summary whose text contains
  // p-r-e-s-s-u-r-e only as a subsequence scattered across several
  // words, which fzf scores far below a contiguous hit.
  {
    id: "sig:junk",
    ancestors: ["bus", "dbc", "other"],
    haystack: "chassis.PackSensorFront.Module01Summary Module 01 summary (cells 1-8).",
  },
];

describe("lazyGridviewMatcher", () => {
  it("builds nothing until it is forced", () => {
    const build = vi.fn(() => ENTRIES);
    lazyGridviewMatcher(build);
    expect(build).not.toHaveBeenCalled();
  });

  it("builds once and reuses the index across queries", () => {
    const build = vi.fn(() => ENTRIES);
    const matcher = lazyGridviewMatcher(build);
    gridviewMatches(matcher, "speed");
    gridviewMatches(matcher, "pressure");
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe("gridviewMatches", () => {
  it("returns nothing for an empty query without forcing the matcher", () => {
    const build = vi.fn(() => ENTRIES);
    const matcher = lazyGridviewMatcher(build);
    const { matchSet, ancestorsOfMatches } = gridviewMatches(matcher, "   ");
    expect(matchSet.size).toBe(0);
    expect(ancestorsOfMatches.size).toBe(0);
    expect(build).not.toHaveBeenCalled();
  });

  it("yields the matched row and every ancestor on the path to it", () => {
    const matcher = lazyGridviewMatcher(() => ENTRIES);
    const { matchSet, ancestorsOfMatches } = gridviewMatches(matcher, "VehicleSpeed");
    expect([...matchSet]).toEqual(["sig:speed"]);
    expect([...ancestorsOfMatches].sort()).toEqual(["bus", "dbc", "msg"]);
  });

  it("cuts scattered low-quality subsequence matches at the relative floor", () => {
    const matcher = lazyGridviewMatcher(() => ENTRIES);
    const { matchSet } = gridviewMatches(matcher, "pressure");
    expect(matchSet.has("sig:press")).toBe(true);
    expect(matchSet.has("sig:junk")).toBe(false);
  });
});
