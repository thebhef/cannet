// The undo *transaction*: what turns one user gesture into one undo
// step, however many writes and however many stacks it takes.
//
// `App` owns the implementation (it owns both history stacks — the
// dockview layout and the element registry) and publishes it here;
// panels reach it through the context rather than through the registry,
// because a gesture is about history, not about elements, and because a
// panel rendered outside `App` (every panel test) must keep working
// without one. Hence the no-op default: an unwrapped panel writes
// exactly as it did before.
//
// Two shapes, for the two shapes a gesture has:
//
// - {@link UndoGesture.transact} for a gesture that lands in one call —
//   removing an element (its panel closes with it), inserting a filter
//   upstream (three writes and a new element).
// - {@link UndoGesture.begin} / {@link UndoGesture.end} for one that
//   spans events — a drag, which persists on every mouse move, or a
//   text edit that writes on every keystroke (an inline rename, opened
//   on focus and closed on blur). Both must still cost a single undo.
//
// An open gesture is also closed by the next press anywhere, because
// the event that would have ended it can go missing — a pointer
// released outside the window delivers no mouseup at all.
//
// The boundary is ADR 0050's: grouping changes what one chord reverses,
// never what a chord is allowed to touch.

import { createContext, useContext } from "react";

export interface UndoGesture {
  /// Run `write`, grouping everything it changes into one undo step.
  transact(write: () => void): void;
  /// Open a gesture that spans several events. Writes until
  /// {@link end} fold into a single step.
  begin(): void;
  /// Close the gesture opened by {@link begin}. A write still in flight
  /// belongs to it; anything after is a step of its own.
  end(): void;
}

/// The default: no history to group into, so a write is just a write.
const NO_GESTURE: UndoGesture = {
  transact: (write) => write(),
  begin: () => {},
  end: () => {},
};

export const UndoGestureContext = createContext<UndoGesture>(NO_GESTURE);

export function useUndoGesture(): UndoGesture {
  return useContext(UndoGestureContext);
}
