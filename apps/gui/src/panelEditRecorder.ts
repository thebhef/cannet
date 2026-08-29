// How a panel hands its undo step to the app (task 129). The default
// is a no-op, like `UndoGestureContext`'s: a panel rendered on its own
// (a DOM test, a storybook) still writes to the host exactly as before
// — recording is additive, never load-bearing for the edit itself.

import { createContext, useContext } from "react";

import type { PanelEditStep } from "./panelEditHistory";

export const PanelEditRecorderContext = createContext<(step: PanelEditStep) => void>(() => {});

/// The recorder for the panel's host edits. Call it with the whole
/// step — the inverse read from the row *before* dispatching the write.
export function usePanelEditRecorder(): (step: PanelEditStep) => void {
  return useContext(PanelEditRecorderContext);
}
