import { describe, expect, it } from "vitest";

import {
  noteNsFromDisplay,
  noteSecondsFromWindow,
  sortNotesChronologically,
  timelineEvents,
  TRUNCATION_EVENT_ID,
  truncationEvent,
  type Note,
} from "./notes";

function note(id: string, ts: number, label = "n"): Note {
  return { id, timestampNs: ts, label };
}

describe("notes helpers", () => {
  it("sorts chronologically by absolute ns", () => {
    const out = sortNotesChronologically([note("c", 3_000), note("a", 1_000), note("b", 2_000)]);
    expect(out.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("converts absolute ns to window-relative seconds", () => {
    expect(noteSecondsFromWindow(1_500_000_000, 1_000_000_000)).toBeCloseTo(0.5, 9);
    expect(noteSecondsFromWindow(NaN, 0)).toBeNull();
    expect(noteSecondsFromWindow(1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("converts display-relative seconds back to absolute ns and rounds", () => {
    expect(noteNsFromDisplay(0.5, 1_000_000_000)).toBe(1_500_000_000);
    // Sub-ns precision in the display gets rounded.
    expect(noteNsFromDisplay(0.5 + 1e-12, 1_000_000_000)).toBe(1_500_000_000);
    expect(noteNsFromDisplay(NaN, 0)).toBeNull();
  });
});

describe("timeline events (ADR 0035)", () => {
  it("maps notes to editable events, defaulting kind and colour", () => {
    const [e] = timelineEvents([note("a", 1_000, "hi")], null);
    expect(e).toMatchObject({
      id: "a", kind: "note", color: null, editable: true, label: "hi",
    });
  });

  it("carries an explicit colour/kind through unchanged", () => {
    const coloured: Note = { id: "a", timestampNs: 1, label: "x", kind: "note", color: "#ff8800" };
    expect(timelineEvents([coloured], null)[0].color).toBe("#ff8800");
  });

  it("appends a derived, non-editable truncation marker when a ts is given", () => {
    const evs = timelineEvents([note("a", 3_000)], 1_000);
    // Sorted chronologically: truncation (1_000) before the note (3_000).
    expect(evs.map((e) => e.id)).toEqual([TRUNCATION_EVENT_ID, "a"]);
    expect(evs[0]).toMatchObject({ kind: "truncation", editable: false });
    expect(evs[0].label).toMatch(/truncated/);
  });

  it("omits the truncation marker when no eviction has happened (null ts)", () => {
    expect(timelineEvents([note("a", 3_000)], null).map((e) => e.id)).toEqual(["a"]);
  });

  it("truncationEvent is the synthetic id and non-editable", () => {
    expect(truncationEvent(5)).toMatchObject({
      id: TRUNCATION_EVENT_ID, kind: "truncation", editable: false, color: null,
    });
  });
});
