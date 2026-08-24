// Undo/redo over event links (ADR 0056) — the third stack beside the
// dockview layout and the element registry, interleaved with them by the
// same order log in `elementHistory.ts`.
//
// Pure: no React, no host, no DOM. `App.tsx` records a step whenever it
// links or unlinks, and applies the operation a restore hands back.
//
// **Steps, not snapshots.** The other two stacks snapshot the state they
// cover, because a view has a great deal of it and no natural inverse. A
// link has exactly one inverse and carries three fields, so a snapshot
// of the whole notes list would be strictly more state to hold, strictly
// more to put back, and would quietly drag every other note edit into
// undo's scope on the way — which ADR 0050 does not cover.

import type { EventSubject, Note } from "./notes";

/// Bound on the stack, matching the other two histories'.
export const LINK_HISTORY_CAP = 50;

/// One change to what an event refers to, as the state it *established*.
///
/// Both shapes exist because ADR 0056's two kinds of reference are stored
/// differently, not because they are different acts to the reader: the ×
/// on a chip means the same thing whether the chip names a linked event
/// or a signal, so both belong on one stack.
export type LinkStep =
  | {
      kind: "link";
      /// The event the host stores the reference on. A link is read from
      /// both ends, but it lives on one of them, and which one decides
      /// whose chip list it appears in — so a restore puts it back where
      /// it was rather than on whichever end happens to be named first.
      stores: string;
      /// The other end of the pair.
      other: string;
      /// `true` for a link, `false` for an unlink.
      linked: boolean;
    }
  | {
      kind: "subjects";
      /// The event whose subject list changed.
      eventId: string;
      /// The list as it was, so the inverse is the same shape rather
      /// than a special case.
      before: readonly EventSubject[];
      /// The list this step established.
      after: readonly EventSubject[];
    };

export interface LinkHistory {
  past: readonly LinkStep[];
  future: readonly LinkStep[];
}

export const EMPTY_LINK_HISTORY: LinkHistory = { past: [], future: [] };

/// The operation that reverses `step`.
///
/// A link flips direction; a subject-list edit swaps its two lists. The
/// whole list, not a delta: `set_note_subjects` replaces the list, so
/// the list *is* the state, and a restore that rebuilt it from a delta
/// would be reconstructing what the step already knows.
export function inverseOf(step: LinkStep): LinkStep {
  return step.kind === "link"
    ? { ...step, linked: !step.linked }
    : { ...step, before: step.after, after: step.before };
}

/// Note that a link operation just happened. Like any undo record, a new
/// step clears the redo side.
export function recordLink(history: LinkHistory, step: LinkStep): LinkHistory {
  return { past: [...history.past, step].slice(-LINK_HISTORY_CAP), future: [] };
}

/// Step back: the operation to apply, and the history after it.
export function undoLink(history: LinkHistory): { history: LinkHistory; apply: LinkStep } | null {
  const last = history.past[history.past.length - 1];
  if (last === undefined) return null;
  return {
    history: { past: history.past.slice(0, -1), future: [last, ...history.future] },
    apply: inverseOf(last),
  };
}

/// Step forward: re-apply the operation exactly as it was made.
export function redoLink(history: LinkHistory): { history: LinkHistory; apply: LinkStep } | null {
  const next = history.future[0];
  if (next === undefined) return null;
  return {
    history: { past: [...history.past, next], future: history.future.slice(1) },
    apply: next,
  };
}

/// Which of `a` / `b` holds the reference between them right now.
///
/// Answers `a` when neither does — the state a `link_events(a, b)` is
/// about to create — and when both do, which is a duplicate the host
/// collapses anyway; the answer only has to be stable.
export function linkStoredOn(notes: readonly Note[], a: string, b: string): string {
  const holds = (from: string, to: string) =>
    notes.some(
      (n) => n.id === from && (n.subjects ?? []).some((s) => s.kind === "event" && s.id === to),
    );
  if (holds(a, b)) return a;
  if (holds(b, a)) return b;
  return a;
}
