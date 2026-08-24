import { describe, expect, it } from "vitest";

import {
  EMPTY_LINK_HISTORY,
  LINK_HISTORY_CAP,
  inverseOf,
  linkStoredOn,
  recordLink,
  redoLink,
  undoLink,
} from "./eventLinkHistory";
import type { Note } from "./notes";

const step = (stores: string, other: string, linked: boolean) =>
  ({ kind: "link", stores, other, linked }) as const;

describe("recordLink", () => {
  it("pushes onto the past and clears the redo side", () => {
    const h = recordLink(
      { past: [step("a", "b", true)], future: [step("c", "d", false)] },
      step("e", "f", true),
    );
    expect(h.past).toEqual([step("a", "b", true), step("e", "f", true)]);
    expect(h.future).toEqual([]);
  });

  it("is bounded, dropping the oldest step", () => {
    let h = EMPTY_LINK_HISTORY;
    for (let i = 0; i < LINK_HISTORY_CAP + 5; i++) h = recordLink(h, step(`a${i}`, "b", true));
    expect(h.past).toHaveLength(LINK_HISTORY_CAP);
    expect(h.past[0]).toMatchObject({ stores: "a5" });
  });
});

describe("inverseOf", () => {
  it("reverses the direction and keeps the pair, storing side included", () => {
    // Which side holds the reference is part of the state being
    // restored: putting it back on the other event would reorder that
    // event's chips for no reason the reader asked for.
    expect(inverseOf(step("a", "b", true))).toEqual(step("a", "b", false));
    expect(inverseOf(step("a", "b", false))).toEqual(step("a", "b", true));
  });
});

describe("inverseOf — subject lists", () => {
  const MSG = { kind: "message", messageId: 0x1a2, extended: false } as const;
  const SIG = { kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" } as const;

  it("swaps the two lists, so a removal and its undo are one shape", () => {
    const s = { kind: "subjects", eventId: "n1", before: [MSG, SIG], after: [MSG] } as const;
    expect(inverseOf(s)).toEqual({ kind: "subjects", eventId: "n1", before: [MSG], after: [MSG, SIG] });
  });

  it("round-trips", () => {
    const s = { kind: "subjects", eventId: "n1", before: [MSG], after: [] } as const;
    expect(inverseOf(inverseOf(s))).toEqual(s);
  });
});

describe("undoLink / redoLink", () => {
  it("hands back the operation that reverses the last step", () => {
    const h = recordLink(EMPTY_LINK_HISTORY, step("a", "b", true));
    const r = undoLink(h)!;
    expect(r.apply).toEqual(step("a", "b", false));
    expect(r.history.past).toEqual([]);
    expect(r.history.future).toEqual([step("a", "b", true)]);
  });

  it("redo re-applies the step as it was made", () => {
    const h = undoLink(recordLink(EMPTY_LINK_HISTORY, step("a", "b", true)))!.history;
    const r = redoLink(h)!;
    expect(r.apply).toEqual(step("a", "b", true));
    expect(r.history.past).toEqual([step("a", "b", true)]);
    expect(r.history.future).toEqual([]);
  });

  it("round-trips an unlink the same way", () => {
    const h = recordLink(EMPTY_LINK_HISTORY, step("a", "b", false));
    const undone = undoLink(h)!;
    expect(undone.apply).toEqual(step("a", "b", true));
    expect(redoLink(undone.history)!.apply).toEqual(step("a", "b", false));
  });

  it("walks a run of steps newest-first and back again", () => {
    let h = EMPTY_LINK_HISTORY;
    h = recordLink(h, step("a", "b", true));
    h = recordLink(h, step("c", "d", true));
    const first = undoLink(h)!;
    expect(first.apply).toEqual(step("c", "d", false));
    const second = undoLink(first.history)!;
    expect(second.apply).toEqual(step("a", "b", false));
    expect(undoLink(second.history)).toBeNull();
    expect(redoLink(second.history)!.apply).toEqual(step("a", "b", true));
  });

  it("is null at either end", () => {
    expect(undoLink(EMPTY_LINK_HISTORY)).toBeNull();
    expect(redoLink(EMPTY_LINK_HISTORY)).toBeNull();
  });
});

describe("linkStoredOn", () => {
  const note = (id: string, links: string[] = []): Note => ({
    id,
    timestampNs: 0,
    label: id,
    subjects: links.map((l) => ({ kind: "event", id: l })),
  });

  it("names the side that holds the reference", () => {
    const notes = [note("a"), note("b", ["a"])];
    expect(linkStoredOn(notes, "a", "b")).toBe("b");
    expect(linkStoredOn(notes, "b", "a")).toBe("b");
  });

  it("prefers the first argument when neither side holds it yet", () => {
    // The link is about to be made: `link_events(a, b)` stores it on
    // `a`, so that is the side the step has to remember.
    expect(linkStoredOn([note("a"), note("b")], "a", "b")).toBe("a");
  });

  it("prefers the first argument when both sides hold one", () => {
    // A duplicate the host would collapse anyway; the answer just has
    // to be stable.
    const notes = [note("a", ["b"]), note("b", ["a"])];
    expect(linkStoredOn(notes, "a", "b")).toBe("a");
  });

  it("ignores a subject that is not an event link", () => {
    const notes: Note[] = [
      { id: "a", timestampNs: 0, label: "a", subjects: [{ kind: "message", messageId: 1, extended: false }] },
      note("b"),
    ];
    expect(linkStoredOn(notes, "a", "b")).toBe("a");
  });

  it("ignores a link to some third event", () => {
    expect(linkStoredOn([note("a", ["z"]), note("b", ["z"])], "a", "b")).toBe("a");
  });
});
