import { describe, expect, it } from "vitest";

import { subjectChips, subjectIndexFor, withoutSubject } from "./eventSubjects";
import { noteToEvent, type Note, type TimelineEvent } from "./notes";
import type { SignalDescriptorRecord } from "./types";

function record(
  messageId: number,
  extended: boolean,
  messageName: string,
  signalName: string,
): SignalDescriptorRecord {
  return {
    bus_id: "bus-a",
    message_id: messageId,
    extended,
    message_name: messageName,
    transmitter: null,
    signal_name: signalName,
    unit: "",
  };
}

const CATALOG: SignalDescriptorRecord[] = [
  record(0x1a2, false, "BMS_Status", "PackCurrent"),
  record(0x1a2, false, "BMS_Status", "ContactorState"),
  record(0x18da00f1, true, "DiagResponse", "Payload"),
];

function event(note: Partial<Note> & { id: string }): TimelineEvent {
  return noteToEvent({ timestampNs: 0, label: note.id, ...note });
}

const index = () => subjectIndexFor(CATALOG);

describe("subjectIndexFor", () => {
  it("answers the same index for the same catalog, so a row does not rebuild it", () => {
    expect(subjectIndexFor(CATALOG)).toBe(subjectIndexFor(CATALOG));
  });

  it("builds a different index for a different catalog", () => {
    expect(subjectIndexFor([...CATALOG])).not.toBe(subjectIndexFor(CATALOG));
  });
});

describe("subjectChips — messages", () => {
  it("names a message an assigned database defines", () => {
    const e = event({
      id: "a",
      subjects: [{ kind: "message", messageId: 0x1a2, extended: false }],
    });
    expect(subjectChips(e, [e], index(), "hex")).toEqual([
      {
        key: "message:s:1A2",
        kind: "message",
        label: "s:1A2 BMS_Status",
        title: "message s:1A2 BMS_Status",
        resolved: true,
        color: null,
        remove: { kind: "subject", subject: { kind: "message", messageId: 0x1a2, extended: false } },
      },
    ]);
  });

  it("still shows what an unresolvable message reference points at", () => {
    const e = event({
      id: "a",
      subjects: [{ kind: "message", messageId: 0x2a1, extended: false }],
    });
    const [chip] = subjectChips(e, [e], index(), "hex");
    expect(chip.resolved).toBe(false);
    expect(chip.label).toBe("s:2A1");
    expect(chip.title).toContain("no assigned database");
  });

  it("renders the id in the view's own id format", () => {
    const e = event({
      id: "a",
      subjects: [{ kind: "message", messageId: 0x1a2, extended: false }],
    });
    expect(subjectChips(e, [e], index(), "decimal")[0].label).toBe("s:418 BMS_Status");
  });

  it("keeps an extended reference distinct from the standard id of the same number", () => {
    const e = event({
      id: "a",
      subjects: [{ kind: "message", messageId: 0x1a2, extended: true }],
    });
    const [chip] = subjectChips(e, [e], index(), "hex");
    expect(chip.resolved).toBe(false);
    expect(chip.label).toBe("x:000001A2");
  });
});

describe("subjectChips — signals", () => {
  it("names a signal an assigned database defines", () => {
    const e = event({
      id: "a",
      subjects: [
        { kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" },
      ],
    });
    expect(subjectChips(e, [e], index(), "hex")).toEqual([
      {
        key: "signal:s:1A2:PackCurrent",
        kind: "signal",
        label: "PackCurrent",
        title: "signal s:1A2 BMS_Status.PackCurrent",
        resolved: true,
        color: null,
        remove: {
          kind: "subject",
          subject: {
            kind: "signal",
            messageId: 0x1a2,
            extended: false,
            signalName: "PackCurrent",
          },
        },
      },
    ]);
  });

  it("is unresolved when the message resolves but the field does not", () => {
    const e = event({
      id: "a",
      subjects: [{ kind: "signal", messageId: 0x1a2, extended: false, signalName: "TorqueReq" }],
    });
    const [chip] = subjectChips(e, [e], index(), "hex");
    expect(chip.resolved).toBe(false);
    // The structural reference is still legible: the id it is under and
    // the field it names.
    expect(chip.label).toBe("TorqueReq");
    expect(chip.title).toContain("s:1A2");
    expect(chip.title).toContain("no assigned database");
  });
});

describe("subjectChips — event links", () => {
  it("names the linked event, from the end that stores the link", () => {
    const a = event({ id: "a", label: "fault" });
    const b = event({ id: "b", label: "contactor open", subjects: [{ kind: "event", id: "a" }] });
    expect(subjectChips(b, [a, b], index(), "hex")).toEqual([
      {
        key: "event:a",
        kind: "event",
        label: "fault",
        title: "linked event — fault",
        resolved: true,
        color: null,
        remove: { kind: "unlink", otherId: "a" },
      },
    ]);
  });

  it("names it from the other end too — a link is read from both (ADR 0056)", () => {
    const a = event({ id: "a", label: "fault" });
    const b = event({ id: "b", label: "contactor open", subjects: [{ kind: "event", id: "a" }] });
    expect(subjectChips(a, [a, b], index(), "hex").map((c) => c.label)).toEqual([
      "contactor open",
    ]);
  });

  it("shows no chip for a link whose event this set does not hold", () => {
    const b = event({ id: "b", subjects: [{ kind: "event", id: "gone" }] });
    expect(subjectChips(b, [b], index(), "hex")).toEqual([]);
  });
});

describe("subjectChips — order", () => {
  it("keeps the subject list's order, with the links after the structural refs", () => {
    const a = event({ id: "a", label: "fault" });
    const b = event({
      id: "b",
      subjects: [
        { kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" },
        { kind: "event", id: "a" },
        { kind: "message", messageId: 0x1a2, extended: false },
      ],
    });
    expect(subjectChips(b, [a, b], index(), "hex").map((c) => c.kind)).toEqual([
      "signal",
      "message",
      "event",
    ]);
  });

  it("gives every chip a distinct key", () => {
    const a = event({ id: "a", label: "fault" });
    const b = event({
      id: "b",
      subjects: [
        { kind: "message", messageId: 0x1a2, extended: false },
        { kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" },
        { kind: "event", id: "a" },
      ],
    });
    const keys = subjectChips(b, [a, b], index(), "hex").map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has nothing to say about an event with no subjects", () => {
    const e = event({ id: "a" });
    expect(subjectChips(e, [e], index(), "hex")).toEqual([]);
  });
});

describe("subjectChips — removal descriptors", () => {
  it("says which subject a structural chip's × drops", () => {
    const sig = { kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" } as const;
    const msg = { kind: "message", messageId: 0x1a2, extended: false } as const;
    const e = event({ id: "a", subjects: [sig, msg] });
    expect(subjectChips(e, [e], index(), "hex").map((c) => c.remove)).toEqual([
      { kind: "subject", subject: sig },
      { kind: "subject", subject: msg },
    ]);
  });

  it("names the other end for a link chip, from whichever side stores it", () => {
    const a = event({ id: "a", label: "fault" });
    const b = event({ id: "b", label: "open", subjects: [{ kind: "event", id: "a" }] });
    // The chip on `a` — which stores nothing — still knows to unlink `b`.
    expect(subjectChips(a, [a, b], index(), "hex")[0].remove).toEqual({
      kind: "unlink",
      otherId: "b",
    });
    expect(subjectChips(b, [a, b], index(), "hex")[0].remove).toEqual({
      kind: "unlink",
      otherId: "a",
    });
  });
});

describe("subjectChips — link chip colour", () => {
  it("takes the linked event's own colour, so chip and marker read as one", () => {
    const a = event({ id: "a", label: "fault", color: "#ff8800" });
    const b = event({ id: "b", label: "open", subjects: [{ kind: "event", id: "a" }] });
    expect(subjectChips(b, [a, b], index(), "hex")[0].color).toBe("#ff8800");
  });

  it("leaves a colourless linked event on the kind's default", () => {
    const a = event({ id: "a", label: "fault" });
    const b = event({ id: "b", label: "open", subjects: [{ kind: "event", id: "a" }] });
    expect(subjectChips(b, [a, b], index(), "hex")[0].color).toBeNull();
  });

  it("gives a structural chip no colour of its own", () => {
    const e = event({ id: "a", subjects: [{ kind: "message", messageId: 0x1a2, extended: false }] });
    expect(subjectChips(e, [e], index(), "hex")[0].color).toBeNull();
  });
});

describe("withoutSubject", () => {
  const sig = { kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" } as const;
  const msg = { kind: "message", messageId: 0x1a2, extended: false } as const;
  const other = { kind: "message", messageId: 0x1a2, extended: true } as const;

  it("drops the matching subject and keeps the rest in order", () => {
    expect(withoutSubject([sig, msg, other], msg)).toEqual([sig, other]);
  });

  it("matches structurally, not by reference", () => {
    expect(withoutSubject([msg], { ...msg })).toEqual([]);
  });

  it("distinguishes standard from extended, and one signal from another", () => {
    expect(withoutSubject([msg, other], other)).toEqual([msg]);
    expect(withoutSubject([sig], { ...sig, signalName: "ContactorState" })).toEqual([sig]);
  });

  it("drops only the first of a duplicated pair", () => {
    expect(withoutSubject([msg, msg], msg)).toEqual([msg]);
  });

  it("leaves the list alone when nothing matches", () => {
    expect(withoutSubject([sig], msg)).toEqual([sig]);
  });
});
