// The link/unlink dispatchers, with their undo steps — the React half
// of `eventLinkHistory.ts`.
//
// Its own module rather than more of `App.tsx` because the interesting
// part is small and easy to get wrong: which end of the pair the host
// stores the reference on has to be read *before* the write, since an
// unlink is about to erase the evidence, and a restore has to put the
// reference back where it was rather than on whichever end the caller
// named first.

import { useCallback, type MutableRefObject } from "react";

import {
  linkStoredOn,
  recordLink,
  redoLink,
  undoLink,
  type LinkHistory,
  type LinkStep,
} from "./eventLinkHistory";
import { recordStep, type UndoOrder } from "./elementHistory";
import type { EventSubject, Note } from "./notes";

export interface EventLinkUndo {
  /// Link two events and record the step. The host stores the
  /// reference on `a` when neither end holds one already.
  linkEvents: (a: string, b: string) => void;
  /// Drop the link between two events and record the step.
  unlinkEvents: (a: string, b: string) => void;
  /// Replace what an event is about, and record the step. The list as
  /// it stands is read here rather than by the caller — it is the
  /// inverse, and only this layer knows a step is being taken.
  setNoteSubjects: (id: string, subjects: EventSubject[]) => void;
  /// Step the link stack and apply the resulting operation. Returns
  /// whether there was a step to take.
  applyEventLinkHistory: (dir: "undo" | "redo") => boolean;
}

export function useEventLinkUndo(opts: {
  /// The notes as of now — read to find which end holds the reference.
  notesRef: MutableRefObject<Note[]>;
  linkHistoryRef: MutableRefObject<LinkHistory>;
  /// The interleaving log, so one chord reverses the most recent change
  /// whichever stack it lives on.
  undoOrderRef: MutableRefObject<UndoOrder>;
  /// The open undo transaction's id, if a gesture is in flight.
  gestureId: () => number | undefined;
  /// Send the operation to the host.
  dispatch: (step: LinkStep) => void;
}): EventLinkUndo {
  const { notesRef, linkHistoryRef, undoOrderRef, gestureId, dispatch } = opts;

  /// Resolve the pair onto (storing side, other end), record the step,
  /// and send it. One path for both directions — they differ only in
  /// the flag.
  const write = useCallback(
    (a: string, b: string, linked: boolean) => {
      const stores = linkStoredOn(notesRef.current, a, b);
      const step: LinkStep = { kind: "link", stores, other: stores === a ? b : a, linked };
      linkHistoryRef.current = recordLink(linkHistoryRef.current, step);
      undoOrderRef.current = recordStep(undoOrderRef.current, "events", gestureId());
      dispatch(step);
    },
    [notesRef, linkHistoryRef, undoOrderRef, gestureId, dispatch],
  );

  const linkEvents = useCallback((a: string, b: string) => write(a, b, true), [write]);
  const unlinkEvents = useCallback((a: string, b: string) => write(a, b, false), [write]);

  const setNoteSubjects = useCallback(
    (id: string, subjects: EventSubject[]) => {
      const before = notesRef.current.find((n) => n.id === id)?.subjects ?? [];
      const step: LinkStep = { kind: "subjects", eventId: id, before, after: subjects };
      linkHistoryRef.current = recordLink(linkHistoryRef.current, step);
      undoOrderRef.current = recordStep(undoOrderRef.current, "events", gestureId());
      dispatch(step);
    },
    [notesRef, linkHistoryRef, undoOrderRef, gestureId, dispatch],
  );

  const applyEventLinkHistory = useCallback(
    (dir: "undo" | "redo"): boolean => {
      const r = dir === "undo" ? undoLink(linkHistoryRef.current) : redoLink(linkHistoryRef.current);
      if (r === null) return false;
      linkHistoryRef.current = r.history;
      // Dispatched without re-recording: a restore is not a new step.
      dispatch(r.apply);
      return true;
    },
    [linkHistoryRef, dispatch],
  );

  return { linkEvents, unlinkEvents, setNoteSubjects, applyEventLinkHistory };
}
