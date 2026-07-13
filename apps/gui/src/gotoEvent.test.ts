import { describe, expect, it } from "vitest";

import { gotoEventItems } from "./gotoEvent";
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
