import { describe, expect, it } from "vitest";

import { parseVisibleRangeInput, resolveVisibleRange } from "./plotVisibleRange";

describe("parseVisibleRangeInput", () => {
  it("parses two space-separated numbers as a min/max range", () => {
    expect(parseVisibleRangeInput("1 5")).toEqual({ ok: true, kind: "range", min: 1, max: 5 });
  });

  it("parses two comma-separated numbers as a min/max range", () => {
    expect(parseVisibleRangeInput("1,5")).toEqual({ ok: true, kind: "range", min: 1, max: 5 });
  });

  it("parses two numbers joined by .. as a min/max range", () => {
    expect(parseVisibleRangeInput("1..5")).toEqual({ ok: true, kind: "range", min: 1, max: 5 });
  });

  it("tolerates whitespace around the separator", () => {
    expect(parseVisibleRangeInput("1 , 5")).toEqual({ ok: true, kind: "range", min: 1, max: 5 });
    expect(parseVisibleRangeInput("1 .. 5")).toEqual({ ok: true, kind: "range", min: 1, max: 5 });
  });

  it("parses a single number as a width", () => {
    expect(parseVisibleRangeInput("5")).toEqual({ ok: true, kind: "width", width: 5 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseVisibleRangeInput("  5  ")).toEqual({ ok: true, kind: "width", width: 5 });
  });

  it("accepts negative bounds in a range (only their order matters)", () => {
    expect(parseVisibleRangeInput("-5 -1")).toEqual({ ok: true, kind: "range", min: -5, max: -1 });
  });

  it("rejects an empty value", () => {
    const r = parseVisibleRangeInput("");
    expect(r.ok).toBe(false);
  });

  it("rejects a non-numeric single value", () => {
    const r = parseVisibleRangeInput("wide");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/number/i);
  });

  it("rejects a non-numeric range", () => {
    const r = parseVisibleRangeInput("a b");
    expect(r.ok).toBe(false);
  });

  it("rejects a zero or negative width", () => {
    expect(parseVisibleRangeInput("0").ok).toBe(false);
    expect(parseVisibleRangeInput("-5").ok).toBe(false);
  });

  it("rejects an inverted range (min >= max)", () => {
    const r = parseVisibleRangeInput("5 1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/min/i);
  });

  it("rejects an empty (zero-width) range", () => {
    const r = parseVisibleRangeInput("5 5");
    expect(r.ok).toBe(false);
  });

  it("rejects more than two numbers", () => {
    expect(parseVisibleRangeInput("1 2 3").ok).toBe(false);
    expect(parseVisibleRangeInput("1,2,3").ok).toBe(false);
    expect(parseVisibleRangeInput("1..2..3").ok).toBe(false);
  });
});

describe("resolveVisibleRange", () => {
  it("passes an explicit range through verbatim", () => {
    expect(
      resolveVisibleRange({ ok: true, kind: "range", min: 2, max: 8 }, { min: 0, max: 100 }),
    ).toEqual([2, 8]);
  });

  it("centres a width on the current window's centre", () => {
    // current window [10, 20] -> centre 15; width 4 -> [13, 17]
    expect(
      resolveVisibleRange({ ok: true, kind: "width", width: 4 }, { min: 10, max: 20 }),
    ).toEqual([13, 17]);
  });

  it("returns null for a parse failure", () => {
    expect(
      resolveVisibleRange({ ok: false, error: "bad" }, { min: 0, max: 10 }),
    ).toBeNull();
  });
});
