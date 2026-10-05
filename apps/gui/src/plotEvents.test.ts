import { describe, expect, it } from "vitest";

import { defaultVisibleKinds, type EventKind, type Note } from "./notes";
import {
  busErrorEpisodeEvents,
  busErrorEpisodeExtents,
  busErrorMarkerLabel,
  plotEventExtents,
  plotEventsFromTimeline,
  plotTimelineEvents,
  litLast,
  subjectsForSelection,
  wrapMarkerLabel,
} from "./plotEvents";
import type { BusErrorEpisodeWire } from "./useBusErrorMarkers";
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

/// An episode on `bus` from `firstT` to `lastT` holding `count` errors,
/// its last the bus's `lastOrdinal`th.
function episode(
  bus: string,
  firstT: number,
  lastT: number,
  count: number,
  lastOrdinal: number,
  over: Partial<BusErrorEpisodeWire> = {},
): BusErrorEpisodeWire {
  const span = lastT - firstT;
  return {
    bus,
    firstT,
    lastT,
    count,
    span,
    rate: span > 0 ? count / span : null,
    lastOrdinal,
    ...over,
  };
}

const BUS_NAME = (bus: string) => (bus === "b1" ? "Bus 1" : bus);

describe("busErrorEpisodeEvents", () => {
  it("is one busError event per episode, at its first error, labelled with its bus", () => {
    const events = busErrorEpisodeEvents(
      [episode("b1", 1, 21, 50_000, 50_000), episode("b2", 30, 30, 1, 7)],
      BUS_NAME,
    );
    expect(events.map((e) => e.id)).toEqual(["bus-error:b1:50000", "bus-error:b2:7"]);
    expect(events.map((e) => e.timestampNs)).toEqual([1e9, 30e9]);
    expect(events.map((e) => e.label)).toEqual([
      "Bus 1: 50000 bus errors over 20 s (2500/s)",
      "b2: 1 bus error over 0 s (—)",
    ]);
    expect(events.every((e) => e.kind === "busError" && !e.editable && e.color === null)).toBe(
      true,
    );
  });

  it("marks an ongoing episode's label, and keys it on its bus and first error rather than its moving ordinal", () => {
    // An ordinal-keyed id (the finalised case above) moves every time an
    // open episode grows — it is a report count, not an identity — so
    // the plot's and the Events panel's selection must not key on it
    // while the episode is still open (0163 phase 6 side effect (d)).
    const open = episode("b1", 1, 21, 50_000, 50_000, { ongoing: true });
    const [ev] = busErrorEpisodeEvents([open], BUS_NAME);
    expect(ev.id).toBe("bus-error:b1:open:1");
    expect(ev.label.endsWith(" — ongoing")).toBe(true);

    // The same episode reported again, grown — same bus, same first
    // error, a different (larger) lastOrdinal — keeps the same id.
    const grown = episode("b1", 1, 25, 60_000, 60_000, { ongoing: true });
    expect(busErrorEpisodeEvents([grown], BUS_NAME)[0].id).toBe(ev.id);
  });

  it("finalises back onto the ordinal id, unmarked, once the episode closes", () => {
    const closed = episode("b1", 1, 21, 50_000, 50_000, { ongoing: false });
    const [ev] = busErrorEpisodeEvents([closed], BUS_NAME);
    expect(ev.id).toBe("bus-error:b1:50000");
    expect(ev.label.endsWith(" — ongoing")).toBe(false);
  });

  it("carries the host's own text block through as the description, verbatim", () => {
    // Never recomposed from `detail` here — ADR 0060's host already
    // worded it (`event_text.rs::bus_error_text`).
    const withText = episode("b1", 1, 21, 50_000, 50_000, {
      text: "50000 error frames on b1 over 20.000 s: ack 49998, bit 2.\n\ncannet-event/1\nid: bus-error:b1:50000\nkind: busError",
    });
    const [ev] = busErrorEpisodeEvents([withText], BUS_NAME);
    expect(ev.description).toBe(withText.text);
  });

  it("reads no description for a peer too old to send the text block", () => {
    const [ev] = busErrorEpisodeEvents([episode("b1", 1, 21, 50_000, 50_000)], BUS_NAME);
    expect(ev.description).toBeNull();
  });
});

describe("busErrorEpisodeExtents", () => {
  const eps = [episode("b1", 1, 21, 50_000, 50_000), episode("b1", 40, 41, 2, 50_002)];

  it("draws nothing at rest", () => {
    expect(busErrorEpisodeExtents(eps, new Set())).toEqual([]);
  });

  it("is a lit episode's first error to its last, as a pair's extent", () => {
    expect(busErrorEpisodeExtents(eps, new Set(["bus-error:b1:50002", "n1"]))).toEqual([
      { startNs: 40e9, endNs: 41e9, color: null, kind: "busError", key: "bus-error:b1:50002" },
    ]);
  });

  it("keys an ongoing episode's extent the same stable way its event id is keyed", () => {
    const open = episode("b1", 40, 41, 2, 50_002, { ongoing: true });
    expect(busErrorEpisodeExtents([open], new Set(["bus-error:b1:open:40"]))).toEqual([
      { startNs: 40e9, endNs: 41e9, color: null, kind: "busError", key: "bus-error:b1:open:40" },
    ]);
  });
});

describe("busErrorMarkerLabel", () => {
  it("carries count, span and the host's own rate", () => {
    // The rate is passed straight through, not recomputed from count and
    // span — `2.5` here is deliberately not `5 / 2`, so a test that
    // silently went back to local division would still fail.
    expect(busErrorMarkerLabel(5, 2, 2.5)).toBe("5 bus errors over 2 s (2.5/s)");
  });

  it("reads singular for one error", () => {
    expect(busErrorMarkerLabel(1, 1, 1)).toBe("1 bus error over 1 s (1.0/s)");
  });

  it("shows no rate when the host sent none — a zero span, not a local divide-by-zero", () => {
    expect(busErrorMarkerLabel(2, 0, null)).toBe("2 bus errors over 0 s (—)");
  });
});

describe("plotEventsFromTimeline", () => {
  const events = busErrorEpisodeEvents([episode("b1", 2, 3, 2, 3)], BUS_NAME);

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
