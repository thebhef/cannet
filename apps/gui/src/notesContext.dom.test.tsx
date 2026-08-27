// @vitest-environment jsdom
//
// What a chip's `×` actually does. Two chips look the same on the row and
// go to two different host commands — a structural reference comes off
// the event's own subject list, a link is dropped as a pair (ADR 0056) —
// so the dispatch is worth pinning on its own, away from any view.

import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";

import { NotesContext, chipRemovable, useRemoveChip, type NotesContextValue } from "./notesContext";
import { noteToEvent, type Note, type TimelineEvent } from "./notes";
import type { SubjectChip } from "./eventSubjects";

function ctx(over: Partial<NotesContextValue> = {}): NotesContextValue {
  return {
    notes: [],
    addNote: vi.fn(),
    renameNote: vi.fn(),
    recolorNote: vi.fn(),
    describeNote: vi.fn(),
    retagNote: vi.fn(),
    removeNote: vi.fn(),
    linkEvents: vi.fn(),
    unlinkEvents: vi.fn(),
    setNoteSubjects: vi.fn(),
    ...over,
  };
}

function event(note: Partial<Note> & { id: string }): TimelineEvent {
  return noteToEvent({ timestampNs: 0, label: note.id, ...note });
}

const SIG = { kind: "signal", messageId: 0x1a2, extended: false, signalName: "PackCurrent" } as const;
const MSG = { kind: "message", messageId: 0x1a2, extended: false } as const;

const subjectChip = (subject: typeof SIG | typeof MSG): SubjectChip => ({
  key: "k",
  kind: subject.kind,
  label: "x",
  title: "x",
  resolved: true,
  color: null,
  remove: { kind: "subject", subject },
});

const linkChip = (otherId: string): SubjectChip => ({
  key: `event:${otherId}`,
  kind: "event",
  label: otherId,
  title: `linked event — ${otherId}`,
  resolved: true,
  color: null,
  remove: { kind: "unlink", otherId },
});

/// Render `useRemoveChip` against a stub context and hand back the
/// callback it produced.
function removerWith(value: NotesContextValue): (e: TimelineEvent, c: SubjectChip) => void {
  let remove!: (e: TimelineEvent, c: SubjectChip) => void;
  function Probe() {
    remove = useRemoveChip();
    return null;
  }
  render(
    <NotesContext.Provider value={value}>
      <Probe />
    </NotesContext.Provider>,
  );
  return remove;
}

describe("useRemoveChip", () => {
  it("hands the subject list back minus the one the chip named", () => {
    const setNoteSubjects = vi.fn();
    const e = event({ id: "n1", subjects: [SIG, MSG] });
    removerWith(ctx({ setNoteSubjects }))(e, subjectChip(SIG));
    expect(setNoteSubjects).toHaveBeenCalledWith("n1", [MSG]);
  });

  it("unlinks a pair rather than editing either side's subject list", () => {
    const unlinkEvents = vi.fn();
    const setNoteSubjects = vi.fn();
    const e = event({ id: "n1", subjects: [{ kind: "event", id: "n2" }] });
    removerWith(ctx({ unlinkEvents, setNoteSubjects }))(e, linkChip("n2"));
    expect(unlinkEvents).toHaveBeenCalledWith("n1", "n2");
    expect(setNoteSubjects).not.toHaveBeenCalled();
  });

  it("unlinks from the end that stores nothing — a link is true of both", () => {
    const unlinkEvents = vi.fn();
    // `n1` holds no subject at all; the reference lives on `n2`.
    const e = event({ id: "n1" });
    removerWith(ctx({ unlinkEvents }))(e, linkChip("n2"));
    expect(unlinkEvents).toHaveBeenCalledWith("n1", "n2");
  });

  it("refuses to edit a host-derived event's subject list", () => {
    const setNoteSubjects = vi.fn();
    const derived = { ...event({ id: "d1", subjects: [SIG] }), editable: false };
    removerWith(ctx({ setNoteSubjects }))(derived, subjectChip(SIG));
    expect(setNoteSubjects).not.toHaveBeenCalled();
  });

  it("still unlinks from a host-derived event", () => {
    const unlinkEvents = vi.fn();
    const derived = { ...event({ id: "d1" }), editable: false };
    removerWith(ctx({ unlinkEvents }))(derived, linkChip("n2"));
    expect(unlinkEvents).toHaveBeenCalledWith("d1", "n2");
  });
});

describe("chipRemovable", () => {
  it("allows a link from either end, editable or not", () => {
    expect(chipRemovable({ ...event({ id: "a" }), editable: false }, linkChip("b"))).toBe(true);
  });

  it("allows a subject only on an event whose list the reader owns", () => {
    expect(chipRemovable(event({ id: "a" }), subjectChip(SIG))).toBe(true);
    expect(chipRemovable({ ...event({ id: "a" }), editable: false }, subjectChip(SIG))).toBe(false);
  });
});
