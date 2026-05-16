import { describe, expect, it } from "vitest";

import {
  noteNsFromDisplay,
  noteSecondsFromWindow,
  sortNotesChronologically,
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
