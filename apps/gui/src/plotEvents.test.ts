import { describe, expect, it } from "vitest";

import { defaultVisibleKinds, type EventKind, type Note } from "./notes";
import { plotTimelineEvents } from "./plotEvents";

const KIND_COLOR = (k: EventKind) =>
  k === "truncation" ? "#amber" : k === "busError" ? "#red" : undefined;

const notes: Note[] = [
  { id: "n1", timestampNs: 2_000_000_000, label: "note" },
  { id: "e1", timestampNs: 1_000_000_000, label: "bus error x40", kind: "busError" },
];

describe("plotTimelineEvents", () => {
  it("has nowhere to draw before the panel has an origin", () => {
    expect(plotTimelineEvents(notes, null, null, defaultVisibleKinds(), KIND_COLOR)).toEqual([]);
  });

  it("leaves out the kinds this panel is not showing", () => {
    // A bus error is hidden by default, so it draws no cursor at all until
    // this panel is told to show it (ADR 0035).
    const shown = plotTimelineEvents(notes, null, 1, defaultVisibleKinds(), KIND_COLOR);
    expect(shown.map((e) => e.id)).toEqual(["n1"]);

    const withErrors = new Set<EventKind>([...defaultVisibleKinds(), "busError"]);
    const all = plotTimelineEvents(notes, null, 1, withErrors, KIND_COLOR);
    expect(all.map((e) => e.id)).toEqual(["e1", "n1"]);
    // ...in display-relative seconds against the origin, colored by kind.
    expect(all[0]).toEqual({ id: "e1", t: 0, label: "bus error x40", color: "#red" });
    expect(all[1].color).toBeUndefined();
  });

  it("treats the truncation marker as one more filterable kind", () => {
    const withTrunc = plotTimelineEvents([], 3_000_000_000, 1, defaultVisibleKinds(), KIND_COLOR);
    expect(withTrunc.map((e) => e.label)).toEqual(["history truncated here"]);
    expect(withTrunc[0].color).toBe("#amber");

    const hidden = new Set<EventKind>(["note"]);
    expect(plotTimelineEvents([], 3_000_000_000, 1, hidden, KIND_COLOR)).toEqual([]);
  });

  it("keeps an event's own color over the kind default", () => {
    const own: Note[] = [{ id: "n", timestampNs: 1_000_000_000, label: "x", color: "#123456" }];
    expect(plotTimelineEvents(own, null, 0, defaultVisibleKinds(), KIND_COLOR)[0].color).toBe(
      "#123456",
    );
  });
});
