import { describe, expect, it } from "vitest";

import { gotoEventItems, parseTimeInTrace, timeInTraceTargetNs } from "./gotoEvent";
import { TRUNCATION_EVENT_ID, type Note } from "./notes";

const note = (id: string, timestampNs: number, label: string): Note => ({
  id,
  timestampNs,
  label,
});

describe("gotoEventItems", () => {
  it("carries each event's absolute ns as the item id (for the goto bus)", () => {
    const items = gotoEventItems([note("a", 2_000_000_000, "brake")], null, 0);
    expect(items).toEqual([{ id: "2000000000", label: "brake", hint: "2.000 s" }]);
  });

  it("hints time relative to the session start", () => {
    const items = gotoEventItems([note("a", 5_500_000_000, "x")], null, 5);
    expect(items[0].hint).toBe("0.500 s");
  });

  it("includes the derived truncation marker and sorts chronologically", () => {
    const items = gotoEventItems(
      [note("a", 3_000_000_000, "late")],
      1_000_000_000,
      0,
    );
    expect(items.map((i) => i.label)).toEqual(["history truncated here", "late"]);
    expect(items[0].id).toBe(String(1_000_000_000));
    // The truncation marker's id must round-trip to the same ns the events
    // view broadcasts, not the synthetic event id.
    expect(items[0].id).not.toBe(TRUNCATION_EVENT_ID);
  });

  it("tolerates a null session start (absolute seconds)", () => {
    const items = gotoEventItems([note("a", 4_000_000_000, "x")], null, null);
    expect(items[0].hint).toBe("4.000 s");
  });
});

describe("gotoEventItems and hidden kinds", () => {
  it("offers every kind a view shows by default, bus errors included", () => {
    // The palette goes where the views go. Nothing is filtered out until
    // a view says so, so a coalesced bus error is reachable from here.
    const items = gotoEventItems(
      [
        { id: "n", timestampNs: 1_000_000_000, label: "brake" },
        { id: "e", timestampNs: 2_000_000_000, label: "bus error x40", kind: "busError" },
      ],
      null,
      0,
    );
    expect(items.map((i) => i.label)).toEqual(["brake", "bus error x40"]);
  });
});

describe("parseTimeInTrace", () => {
  it("accepts a non-negative number", () => {
    expect(parseTimeInTrace("12.5")).toEqual({ ok: true, seconds: 12.5 });
  });

  it("accepts zero (the session start itself)", () => {
    expect(parseTimeInTrace("0")).toEqual({ ok: true, seconds: 0 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseTimeInTrace("  3  ")).toEqual({ ok: true, seconds: 3 });
  });

  it("rejects an empty value", () => {
    const r = parseTimeInTrace("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/enter/i);
  });

  it("rejects a non-numeric value", () => {
    const r = parseTimeInTrace("soon");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/number/i);
  });

  it("rejects a negative value (owner ruling: a validation error, not a pre-session seek)", () => {
    const r = parseTimeInTrace("-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/zero or later/i);
  });
});

describe("timeInTraceTargetNs", () => {
  it("adds the parsed seconds onto the session start, in ns", () => {
    expect(timeInTraceTargetNs(100, 2.5)).toBe(102_500_000_000);
  });

  it("treats a null session start as zero (same tolerance as gotoEventItems' hint)", () => {
    expect(timeInTraceTargetNs(null, 2)).toBe(2_000_000_000);
  });
});
