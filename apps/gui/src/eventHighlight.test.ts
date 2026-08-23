import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activeEventIds,
  eventHighlight,
  highlightsMessage,
  highlightsSeries,
  hoverEvent,
  messageSubjectKey,
  resetEventHighlight,
  selectEvents,
  signalSubjectKey,
  subscribeEventHighlight,
} from "./eventHighlight";
import { noteToEvent, type Note, type TimelineEvent } from "./notes";

function ev(n: Note): TimelineEvent {
  return noteToEvent(n);
}

const A = ev({
  id: "a",
  timestampNs: 1_000_000_000,
  label: "contactor open",
  color: "#ff0000",
  subjects: [
    { kind: "signal", messageId: 0x180, extended: false, signalName: "PackCurrent" },
    { kind: "message", messageId: 0x2a1, extended: false },
  ],
});
const B = ev({
  id: "b",
  timestampNs: 3_000_000_000,
  label: "fault",
  color: "#00ff00",
  subjects: [{ kind: "event", id: "a" }],
});
const C = ev({ id: "c", timestampNs: 5_000_000_000, label: "unrelated" });
const EVENTS = [A, B, C];

afterEach(() => resetEventHighlight());

describe("the highlight channel", () => {
  it("is at rest until something acts on an event", () => {
    expect(activeEventIds()).toEqual([]);
    expect(eventHighlight(EVENTS, activeEventIds())).toBeNull();
  });

  it("carries a hover, and lets it go", () => {
    hoverEvent("a");
    expect(activeEventIds()).toEqual(["a"]);
    hoverEvent(null);
    expect(activeEventIds()).toEqual([]);
  });

  it("carries a selection, which outlives the pointer", () => {
    selectEvents(["a", "b"]);
    expect(activeEventIds()).toEqual(["a", "b"]);
    hoverEvent("c");
    // A hover replaces the selection while it lasts...
    expect(activeEventIds()).toEqual(["c"]);
    hoverEvent(null);
    // ...and hands it back on the way out.
    expect(activeEventIds()).toEqual(["a", "b"]);
  });

  it("notifies subscribers only when what is active actually moves", () => {
    const fn = vi.fn();
    const off = subscribeEventHighlight(fn);
    hoverEvent("a");
    expect(fn).toHaveBeenCalledTimes(1);
    hoverEvent("a");
    expect(fn).toHaveBeenCalledTimes(1);
    hoverEvent("b");
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    hoverEvent(null);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keeps one snapshot identity at rest, so a reader sees no churn", () => {
    const first = activeEventIds();
    hoverEvent("a");
    hoverEvent(null);
    expect(activeEventIds()).toBe(first);
  });

  it("takes a copy of the selection it is handed", () => {
    const ids = ["a"];
    selectEvents(ids);
    ids.push("b");
    expect(activeEventIds()).toEqual(["a"]);
  });
});

describe("eventHighlight", () => {
  it("draws nothing at rest, and nothing for an id no event answers to", () => {
    expect(eventHighlight(EVENTS, [])).toBeNull();
    expect(eventHighlight(EVENTS, ["gone"])).toBeNull();
  });

  it("names the messages and the fields the event is about", () => {
    const h = eventHighlight(EVENTS, ["a"])!;
    expect([...h.messages]).toEqual([messageSubjectKey(0x2a1, false)]);
    expect([...h.signals]).toEqual([signalSubjectKey(0x180, false, "PackCurrent")]);
    // A field's frames are its message's frames, so both messages are
    // touched even though only one is a subject in its own right.
    expect([...h.touchedMessages].sort()).toEqual(
      [messageSubjectKey(0x180, false), messageSubjectKey(0x2a1, false)].sort(),
    );
  });

  it("tells an extended reference from the standard id of the same number", () => {
    const x = ev({
      id: "x",
      timestampNs: 1,
      label: "x",
      subjects: [{ kind: "message", messageId: 0x180, extended: true }],
    });
    const h = eventHighlight([x], ["x"])!;
    expect(highlightsMessage(h, 0x180, true)).toBe(true);
    expect(highlightsMessage(h, 0x180, false)).toBe(false);
  });

  it("lights a whole message's series, and only the named field otherwise", () => {
    const h = eventHighlight(EVENTS, ["a"])!;
    // 0x2a1 is named whole: every series decoded from it is a subject.
    expect(highlightsSeries(h, 0x2a1, false, "AnyField")).toBe(true);
    // 0x180 is named by one field only.
    expect(highlightsSeries(h, 0x180, false, "PackCurrent")).toBe(true);
    expect(highlightsSeries(h, 0x180, false, "PackVoltage")).toBe(false);
  });

  it("lights the linked event from either end", () => {
    // The reference is stored on `b`; both ends light both.
    expect([...eventHighlight(EVENTS, ["b"])!.events].sort()).toEqual(["a", "b"]);
    expect([...eventHighlight(EVENTS, ["a"])!.events].sort()).toEqual(["a", "b"]);
  });

  it("draws a pair's extent from either end, identically", () => {
    const fromA = eventHighlight(EVENTS, ["a"])!.extents;
    const fromB = eventHighlight(EVENTS, ["b"])!.extents;
    expect(fromA).toEqual(fromB);
    expect(fromA).toEqual([
      {
        startNs: 1_000_000_000,
        endNs: 3_000_000_000,
        // The earlier event's color, from whichever end you touch.
        color: "#ff0000",
        kind: "note",
        key: "a b",
      },
    ]);
  });

  it("draws a pair's extent once when both its ends are active", () => {
    expect(eventHighlight(EVENTS, ["a", "b"])!.extents).toHaveLength(1);
  });

  it("draws no extent for an event that is linked to nothing", () => {
    expect(eventHighlight(EVENTS, ["c"])!.extents).toEqual([]);
  });

  it("draws no extent for a link whose other end this view does not hold", () => {
    // A reference the event set cannot resolve is unresolved, not broken
    // (ADR 0056) — there is simply nothing to draw between.
    const lone = ev({
      id: "l",
      timestampNs: 1,
      label: "lone",
      subjects: [{ kind: "event", id: "elsewhere" }],
    });
    const h = eventHighlight([lone], ["l"])!;
    expect(h.extents).toEqual([]);
    expect([...h.events]).toEqual(["l"]);
  });

  it("takes the color from the earlier end even when it has none of its own", () => {
    const early = ev({ id: "e", timestampNs: 1, label: "early", kind: "busError" });
    const late = ev({
      id: "l",
      timestampNs: 2,
      label: "late",
      color: "#123456",
      subjects: [{ kind: "event", id: "e" }],
    });
    const [extent] = eventHighlight([early, late], ["l"])!.extents;
    expect(extent.color).toBeNull();
    expect(extent.kind).toBe("busError");
  });

  it("unions several active events", () => {
    const other = ev({
      id: "o",
      timestampNs: 9,
      label: "other",
      subjects: [{ kind: "message", messageId: 0x400, extended: false }],
    });
    const h = eventHighlight([...EVENTS, other], ["a", "o"])!;
    expect([...h.touchedMessages].sort()).toEqual(
      [
        messageSubjectKey(0x180, false),
        messageSubjectKey(0x2a1, false),
        messageSubjectKey(0x400, false),
      ].sort(),
    );
  });

  it("answers false for every question when nothing is highlighted", () => {
    expect(highlightsMessage(null, 0x180, false)).toBe(false);
    expect(highlightsSeries(null, 0x180, false, "PackCurrent")).toBe(false);
  });
});
