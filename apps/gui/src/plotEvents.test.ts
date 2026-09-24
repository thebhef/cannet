import { describe, expect, it } from "vitest";

import { defaultVisibleKinds, type EventKind, type Note } from "./notes";
import {
  busErrorMarkerLabel,
  busErrorTimelineEvents,
  plotEventExtents,
  plotEventsFromTimeline,
  plotTimelineEvents,
  litLast,
  subjectsForSelection,
  wrapMarkerLabel,
  type BusErrorSeries,
} from "./plotEvents";
import { signalRefKey, type SignalRef } from "./plotPanelConfig";

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
    // A panel that has turned the Diagnostics row off draws no cursor
    // for a bus error (ADR 0035).
    const notesOnly = new Set<EventKind>(["note", "messageBound"]);
    const shown = plotTimelineEvents(notes, null, 1, notesOnly, KIND_COLOR);
    expect(shown.map((e) => e.id)).toEqual(["n1"]);

    const all = plotTimelineEvents(notes, null, 1, defaultVisibleKinds(), KIND_COLOR);
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

describe("busErrorTimelineEvents", () => {
  it("skips the boundary sample and marks every delta after it", () => {
    // t in seconds, v the running count — the boundary (t=0, v=10) only
    // supplies the first delta.
    const series: BusErrorSeries[] = [{ bus: "b1", t: [0, 1, 3, 3.5], v: [10, 11, 14, 15] }];
    const events = busErrorTimelineEvents(series);
    expect(events.map((e) => e.id)).toEqual([
      "bus-error:b1:11",
      "bus-error:b1:14",
      "bus-error:b1:15",
    ]);
    expect(events.map((e) => e.timestampNs)).toEqual([1e9, 3e9, 3.5e9]);
    expect(events.every((e) => e.kind === "busError" && !e.editable)).toBe(true);
  });

  it("has nothing to mark for a single served point (nothing in the window)", () => {
    expect(busErrorTimelineEvents([{ bus: "b1", t: [5], v: [3] }])).toEqual([]);
    expect(busErrorTimelineEvents([{ bus: "b1", t: [], v: [] }])).toEqual([]);
  });

  it("keeps each bus's ordinals separate — the id names the bus", () => {
    const series: BusErrorSeries[] = [
      { bus: "b1", t: [0, 1], v: [1, 2] },
      { bus: "b2", t: [0, 1], v: [1, 2] },
    ];
    expect(busErrorTimelineEvents(series).map((e) => e.id)).toEqual([
      "bus-error:b1:2",
      "bus-error:b2:2",
    ]);
  });
});

describe("busErrorMarkerLabel", () => {
  it("carries count, span and rate", () => {
    expect(busErrorMarkerLabel(5, 2)).toBe("5 bus errors over 2 s (2.5/s)");
  });

  it("reads singular for one error", () => {
    expect(busErrorMarkerLabel(1, 1)).toBe("1 bus error over 1 s (1.0/s)");
  });

  it("has nothing to divide by when two errors land at once", () => {
    expect(busErrorMarkerLabel(2, 0)).toBe("2 bus errors over 0 s (—)");
  });
});

describe("plotEventsFromTimeline", () => {
  const events = busErrorTimelineEvents([{ bus: "b1", t: [0, 2], v: [1, 3] }]);

  it("has nowhere to draw before the panel has an origin", () => {
    expect(plotEventsFromTimeline(events, null, defaultVisibleKinds(), KIND_COLOR)).toEqual([]);
  });

  it("projects onto display-relative seconds, colored by kind", () => {
    const [marker] = plotEventsFromTimeline(events, 0, defaultVisibleKinds(), KIND_COLOR);
    expect(marker.id).toBe("bus-error:b1:3");
    expect(marker.t).toBe(2);
    expect(marker.color).toBe("#red");
  });

  it("leaves it out when the kind is hidden", () => {
    const notesOnly = new Set<EventKind>(["note", "messageBound"]);
    expect(plotEventsFromTimeline(events, 0, notesOnly, KIND_COLOR)).toEqual([]);
  });
});

describe("subjectsForSelection", () => {
  const ref = (over: Partial<SignalRef>): SignalRef => ({
    busId: "bus-a",
    messageId: 0x180,
    extended: false,
    signalName: "PackCurrent",
    messageName: "BMS_Status",
    unit: "A",
    ...over,
  });
  const keys = (...rs: SignalRef[]) => new Set(rs.map(signalRefKey));

  it("turns the selected rows into signal subjects, in the area's order", () => {
    const a = ref({});
    const b = ref({ signalName: "ContactorState" });
    expect(subjectsForSelection([a, b], keys(b, a))).toEqual([
      { kind: "signal", messageId: 0x180, extended: false, signalName: "PackCurrent" },
      { kind: "signal", messageId: 0x180, extended: false, signalName: "ContactorState" },
    ]);
  });

  it("names only what is selected", () => {
    const a = ref({});
    const b = ref({ signalName: "ContactorState" });
    expect(subjectsForSelection([a, b], keys(b))).toEqual([
      { kind: "signal", messageId: 0x180, extended: false, signalName: "ContactorState" },
    ]);
    expect(subjectsForSelection([a, b], new Set())).toEqual([]);
  });

  it("keeps the extended flag, which is half of message identity", () => {
    const x = ref({ extended: true });
    expect(subjectsForSelection([x], keys(x))).toEqual([
      { kind: "signal", messageId: 0x180, extended: true, signalName: "PackCurrent" },
    ]);
  });

  it("collapses the same signal selected on two buses into one subject", () => {
    // A subject stores no bus (ADR 0056), so two rows differing only in
    // their bus are one structural reference — not a duplicate chip.
    const a = ref({ busId: "bus-a" });
    const b = ref({ busId: "bus-b" });
    expect(subjectsForSelection([a, b], keys(a, b))).toEqual([
      { kind: "signal", messageId: 0x180, extended: false, signalName: "PackCurrent" },
    ]);
  });

  it("drops a file-backed series, which has no message to reference", () => {
    // Its `messageId` is a signal channel group index, not an
    // arbitration id, so writing it as a message reference would name a
    // message that does not exist.
    const f = ref({ fileBacked: true, busId: null, signalName: "Torque" });
    const s = ref({});
    expect(subjectsForSelection([f], keys(f))).toEqual([]);
    expect(subjectsForSelection([f, s], keys(f, s))).toEqual([
      { kind: "signal", messageId: 0x180, extended: false, signalName: "PackCurrent" },
    ]);
  });
});

describe("plotEventExtents", () => {
  const extents = [
    { startNs: 1_000_000_000, endNs: 3_000_000_000, color: "#ff0000", kind: "note" as const, key: "a b" },
    { startNs: 4_000_000_000, endNs: 4_000_000_000, color: null, kind: "busError" as const, key: "c d" },
  ];

  it("has nowhere to draw before the panel has an origin", () => {
    expect(plotEventExtents(extents, null, KIND_COLOR)).toEqual([]);
  });

  it("projects onto the same origin and colors the same way as the marker lines", () => {
    expect(plotEventExtents(extents, 1, KIND_COLOR)).toEqual([
      { key: "a b", t0: 0, t1: 2, color: "#ff0000" },
      // A zero-width band is honest: two events at one instant.
      { key: "c d", t0: 3, t1: 3, color: "#red" },
    ]);
  });

  it("draws nothing when nothing is being acted on", () => {
    expect(plotEventExtents([], 1, KIND_COLOR)).toEqual([]);
  });
});

describe("wrapMarkerLabel", () => {
  // One "px" per character keeps the arithmetic readable: a width of 10
  // holds ten characters.
  const measure = (t: string) => t.length;

  it("leaves a label that already fits on one line", () => {
    expect(wrapMarkerLabel("brake on", measure, 20, 2)).toEqual(["brake on"]);
  });

  it("wraps at a space rather than mid-word", () => {
    expect(wrapMarkerLabel("brake pedal pressed", measure, 12, 2)).toEqual([
      "brake pedal",
      "pressed",
    ]);
  });

  it("ellipsises the last line once it runs out of lines", () => {
    // Three words that need three lines, capped at two: the second line
    // carries the ellipsis, so the label reads as continuing.
    const out = wrapMarkerLabel("brake pedal pressed hard again", measure, 12, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("brake pedal");
    expect(out[1].endsWith("…")).toBe(true);
    expect(measure(out[1])).toBeLessThanOrEqual(12);
  });

  it("breaks a single word too long for a line", () => {
    // No space to wrap at — a long DBC-ish identifier still has to fit.
    const out = wrapMarkerLabel("HighVoltageBatteryOverTemperature", measure, 10, 2);
    expect(out).toHaveLength(2);
    expect(out.every((l) => measure(l) <= 10)).toBe(true);
    expect(out[1].endsWith("…")).toBe(true);
  });

  it("keeps one line when asked for one", () => {
    const out = wrapMarkerLabel("brake pedal pressed", measure, 12, 1);
    expect(out).toHaveLength(1);
    expect(out[0].endsWith("…")).toBe(true);
  });

  it("returns nothing for an empty label", () => {
    expect(wrapMarkerLabel("", measure, 12, 2)).toEqual([]);
    expect(wrapMarkerLabel("   ", measure, 12, 2)).toEqual([]);
  });

  it("still emits something when the width cannot hold one character", () => {
    // A degenerate plot width must not produce an empty chip that looks
    // like a marker with no name.
    const out = wrapMarkerLabel("brake", measure, 0, 2);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(2);
    expect(out[0].length).toBeGreaterThan(0);
  });
});

describe("litLast", () => {
  const evs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("leaves the order alone when nothing is being acted on", () => {
    // At rest every marker is equally lit, so nothing may move — the
    // stacking a reader has learned is the one they keep.
    expect(litLast(evs, new Set()).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("puts the lit marker last, so it draws over the quiet ones", () => {
    expect(litLast(evs, new Set(["b"])).map((e) => e.id)).toEqual(["a", "c", "d", "b"]);
  });

  it("keeps a lit pair in its own order", () => {
    expect(litLast(evs, new Set(["c", "a"])).map((e) => e.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("changes nothing when everything is lit", () => {
    expect(litLast(evs, new Set(["a", "b", "c", "d"])).map((e) => e.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("ignores a lit id the plot does not hold", () => {
    expect(litLast(evs, new Set(["zz"])).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });
});
