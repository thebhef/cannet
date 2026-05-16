// Session-scoped React context holding the live notes list and
// edit dispatchers (Phase 9). One instance per App tree;
// initialised in App.tsx; consumed by every PlotPanel.

import { createContext, useContext } from "react";

import type { Note } from "./notes";

export interface NotesContextValue {
  /// Current chronological list — host snapshot kept live by the
  /// `notes-changed` event.
  notes: Note[];
  /// Drop a note at the given absolute trace ns timestamp. The
  /// host's add command emits `notes-changed` so the list updates
  /// for every panel; the caller's local optimistic state, if any,
  /// reconciles on the event.
  addNote: (id: string, timestampNs: number, label: string) => void;
  /// Update a note's label.
  renameNote: (id: string, label: string) => void;
  /// Remove a note by id.
  removeNote: (id: string) => void;
}

const fallback: NotesContextValue = {
  notes: [],
  addNote: () => {},
  renameNote: () => {},
  removeNote: () => {},
};

export const NotesContext = createContext<NotesContextValue>(fallback);

export function useNotes(): NotesContextValue {
  return useContext(NotesContext);
}
