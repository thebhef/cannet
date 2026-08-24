// Session-scoped React context holding the live notes list and
// edit dispatchers. One instance per App tree;
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
  /// reconciles on the event. `color` (a `#RRGGBB` picked at creation)
  /// is optional — omitted falls back to the view's default note color.
  addNote: (id: string, timestampNs: number, label: string, color?: string) => void;
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
};

export const NotesContext = createContext<NotesContextValue>(fallback);

export function useNotes(): NotesContextValue {
  return useContext(NotesContext);
}
