// Session-scoped React context holding the live notes list and
// edit dispatchers. One instance per App tree;
// initialised in App.tsx; consumed by every PlotPanel.

import { createContext, useCallback, useContext } from "react";

import type { SubjectChip } from "./eventSubjects";
import { withoutSubject } from "./eventSubjects";
import type { EventSubject, Note, TimelineEvent } from "./notes";

export interface NotesContextValue {
  /// Current chronological list — host snapshot kept live by the
  /// `notes-changed` event.
  notes: Note[];
  /// Add a fully-formed note — mint it with `authorEvent`, the one
  /// constructor every authoring gesture shares. The host's
  /// add command emits `notes-changed` so the list updates for every
  /// panel; the caller's local optimistic state, if any, reconciles on
  /// the event.
  ///
  /// The whole note travels, rather than a positional argument per
  /// field, because an event now carries subjects (ADR 0056) and a
  /// gesture that authors one must be able to say so in the same call
  /// the host already accepts — `add_note` takes the struct.
  addNote: (note: Note) => void;
  /// Update a note's label.
  renameNote: (id: string, label: string) => void;
  /// Set or clear a note's color (`#RRGGBB`, or `null` for the view
  /// default) — ADR 0035.
  recolorNote: (id: string, color: string | null) => void;
  /// Set or clear a note's description body (`null` clears) — ADR 0035.
  describeNote: (id: string, description: string | null) => void;
  /// Set or clear a note's user-defined tag (`null` clears) — ADR 0035.
  retagNote: (id: string, tag: string | null) => void;
  /// Remove a note by id.
  removeNote: (id: string) => void;
  /// Link two events (ADR 0056). The host stores the reference **once**,
  /// on `a`, and every reader answers over both directions; a pair that
  /// is already linked is a no-op.
  linkEvents: (a: string, b: string) => void;
  /// Drop the link between two events, from whichever side stored it.
  unlinkEvents: (a: string, b: string) => void;
  /// Replace an event's subject list (ADR 0056) — what removing one of
  /// its structural chips hands back.
  setNoteSubjects: (id: string, subjects: EventSubject[]) => void;
}

const fallback: NotesContextValue = {
  notes: [],
  addNote: () => {},
  renameNote: () => {},
  recolorNote: () => {},
  describeNote: () => {},
  retagNote: () => {},
  removeNote: () => {},
  linkEvents: () => {},
  unlinkEvents: () => {},
  setNoteSubjects: () => {},
};

export const NotesContext = createContext<NotesContextValue>(fallback);

export function useNotes(): NotesContextValue {
  return useContext(NotesContext);
}

/// Whether a chip may be removed from `event` at all.
///
/// A structural reference lives on the event's own subject list, so
/// only an editable event can lose one — a host-derived event's
/// subjects are what the host computed. A **link is a pair**, stored on
/// one side but true of both (ADR 0056), so either end may drop it: a
/// note linked to a bus-error event is unlinked from whichever row the
/// reader happens to be looking at.
export function chipRemovable(event: TimelineEvent, chip: SubjectChip): boolean {
  return chip.remove.kind === "unlink" || event.editable;
}

/// Drop what one of an event's chips references. The one implementation
/// both event-bearing views use, so an `×` means the same thing in the
/// trace as it does in the events panel.
export function useRemoveChip(): (event: TimelineEvent, chip: SubjectChip) => void {
  const { unlinkEvents, setNoteSubjects } = useNotes();
  return useCallback(
    (event: TimelineEvent, chip: SubjectChip) => {
      if (!chipRemovable(event, chip)) return;
      if (chip.remove.kind === "unlink") {
        unlinkEvents(event.id, chip.remove.otherId);
        return;
      }
      setNoteSubjects(event.id, withoutSubject(event.subjects, chip.remove.subject));
    },
    [unlinkEvents, setNoteSubjects],
  );
}
