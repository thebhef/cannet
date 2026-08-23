import { describe, expect, it } from "vitest";

import {
  defaultVisibleKinds,
  EVENT_KIND_META,
  EVENT_KINDS,
  noteToEvent,
  visibleEvents,
  type EventKind,
  noteNsFromDisplay,
  noteSecondsFromWindow,
  sortNotesChronologically,
  timelineEvents,
  TRUNCATION_EVENT_ID,
  truncationEvent,
  linkedEventIds,
  authorEvent,
  type EventSubject,
  type Note,
} from "./notes";

import { wheelColor } from "./palette";

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
  it("maps notes to editable events, defaulting kind and color", () => {
    const [e] = timelineEvents([note("a", 1_000, "hi")], null);
    expect(e).toMatchObject({
      id: "a", kind: "note", color: null, editable: true, label: "hi",
    });
  });

  it("carries an explicit color/kind through unchanged", () => {
    const colored: Note = { id: "a", timestampNs: 1, label: "x", kind: "note", color: "#ff8800" };
    expect(timelineEvents([colored], null)[0].color).toBe("#ff8800");
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

describe("event kinds", () => {
  it("gives every kind a category, and the category fixes the lifecycle", () => {
    expect(EVENT_KIND_META.note.category).toBe("userAuthored");
    expect(EVENT_KIND_META.busError.category).toBe("hostDerived");
    expect(EVENT_KIND_META.truncation.category).toBe("frontendDerived");
    // Only the user's own events are editable.
    expect(EVENT_KINDS.filter((k) => EVENT_KIND_META[k].editable)).toEqual([
      "note",
      "messageBound",
    ]);
  });

  it("declares which kinds are noise until asked for", () => {
    expect(EVENT_KIND_META.busError.visibleByDefault).toBe(false);
    expect(defaultVisibleKinds().has("busError")).toBe(false);
    expect(defaultVisibleKinds().has("note")).toBe(true);
    expect(defaultVisibleKinds().has("truncation")).toBe(true);
  });

  it("names the BLF record a kind round-trips as, or none", () => {
    expect(EVENT_KIND_META.note.blfRecord).toBe("GLOBAL_MARKER");
    expect(EVENT_KIND_META.messageBound.blfRecord).toBe("EVENT_COMMENT");
    expect(EVENT_KIND_META.busError.blfRecord).toBe(null);
    expect(EVENT_KIND_META.truncation.blfRecord).toBe(null);
  });

  it("marks a host-derived event uneditable on the way in", () => {
    expect(noteToEvent({ id: "e", timestampNs: 1, label: "bus error", kind: "busError" }).editable)
      .toBe(false);
    expect(noteToEvent(note("n", 1)).editable).toBe(true);
  });

  it("hides the kinds a view has not enabled, keeping the rest chronological", () => {
    const all = timelineEvents(
      [note("n", 2_000), { id: "e", timestampNs: 1_000, label: "bus error", kind: "busError" }],
      3_000,
    );
    expect(all.map((e) => e.id)).toEqual(["e", "n", TRUNCATION_EVENT_ID]);
    expect(visibleEvents(all, defaultVisibleKinds()).map((e) => e.id)).toEqual([
      "n",
      TRUNCATION_EVENT_ID,
    ]);
    const withErrors = new Set<EventKind>([...defaultVisibleKinds(), "busError"]);
    expect(visibleEvents(all, withErrors).map((e) => e.id)).toEqual(["e", "n", TRUNCATION_EVENT_ID]);
  });
});

describe("event subjects", () => {
  const signal: EventSubject = {
    kind: "signal",
    messageId: 0x180,
    extended: false,
    signalName: "PackCurrent",
  };
  const message: EventSubject = { kind: "message", messageId: 0x18da00f1, extended: true };

  it("carries the host's subject list onto the rendered event", () => {
    const e = noteToEvent({
      id: "a",
      timestampNs: 1,
      label: "n",
      subjects: [signal, message, { kind: "event", id: "b" }],
    });
    expect(e.subjects).toEqual([signal, message, { kind: "event", id: "b" }]);
  });

  it("gives an event with no subjects an empty list, never undefined", () => {
    expect(noteToEvent(note("a", 1)).subjects).toEqual([]);
    expect(truncationEvent(5).subjects).toEqual([]);
  });

  it("reads a link from either end, wherever it is stored", () => {
    const events = timelineEvents(
      [
        { id: "a", timestampNs: 1, label: "a", subjects: [{ kind: "event", id: "b" }] },
        note("b", 2),
      ],
      null,
    );
    expect(linkedEventIds(events, "a")).toEqual(["b"]);
    expect(linkedEventIds(events, "b")).toEqual(["a"]);
  });

  it("names both ends of a chain from its middle", () => {
    const events = timelineEvents(
      [
        note("a", 1),
        { id: "b", timestampNs: 2, label: "b", subjects: [{ kind: "event", id: "a" }] },
        { id: "c", timestampNs: 3, label: "c", subjects: [{ kind: "event", id: "b" }] },
      ],
      null,
    );
    expect(linkedEventIds(events, "b")).toEqual(["a", "c"]);
  });

  it("leaves an unresolved reference out of the link list without dropping it", () => {
    const events = timelineEvents(
      [{ id: "a", timestampNs: 1, label: "a", subjects: [{ kind: "event", id: "gone" }, signal] }],
      null,
    );
    expect(linkedEventIds(events, "a")).toEqual([]);
    expect(events[0].subjects).toHaveLength(2);
  });
});

describe("authoring an event (ADR 0056)", () => {
  const sig: EventSubject = {
    kind: "signal",
    messageId: 0x180,
    extended: false,
    signalName: "PackCurrent",
  };
  const msg: EventSubject = { kind: "message", messageId: 0x2a1, extended: false };

  it("mints an event at the given time carrying the given subjects", () => {
    const e = authorEvent(1_234, [sig], 0);
    expect(e.timestampNs).toBe(1_234);
    expect(e.subjects).toEqual([sig]);
    expect(e.id).toBeTruthy();
  });

  it("numbers the label and takes the wheel color from the existing count", () => {
    expect(authorEvent(1, [], 0).label).toBe("note 1");
    expect(authorEvent(1, [], 2).label).toBe("note 3");
    expect(authorEvent(1, [], 2).color).toBe(wheelColor(2));
  });

  it("gives every event a distinct id", () => {
    expect(authorEvent(1, [], 0).id).not.toBe(authorEvent(1, [], 0).id);
  });

  it("records nothing about which gesture made it", () => {
    // Provenance-agnostic: two gestures, one resulting shape. An event
    // authored from a plot selection and one authored from a trace row
    // differ only in their subjects and their time — never in a field
    // that says where they came from.
    const fromPlot = authorEvent(9, [sig], 4);
    const fromTrace = authorEvent(9, [msg], 4);
    expect(Object.keys(fromPlot).sort()).toEqual(Object.keys(fromTrace).sort());
    expect({ ...fromPlot, id: "", subjects: [] }).toEqual({ ...fromTrace, id: "", subjects: [] });
  });

  it("is the same shape the existing subject-less note path produced", () => {
    // The plot's note cursor authors through this too, so an
    // unsubjected event is exactly what it always was, plus an empty
    // subject list the host defaults anyway.
    const e = authorEvent(7, [], 1);
    expect(e).toEqual({
      id: e.id,
      timestampNs: 7,
      label: "note 2",
      color: wheelColor(1),
      subjects: [],
    });
  });
});
