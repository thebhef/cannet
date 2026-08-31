// The panel-edit recorder and its restore dispatcher — the React half
// of `panelEditHistory.ts`, shaped on `useEventLinkUndo.ts`.
//
// A panel builds the whole step itself (it is the one looking at the
// row, so it holds the inverse — the previous decoder, enable or
// override — *before* the write erases the evidence) and hands it
// here; this layer records it into the interleaving log and leaves the
// panel's own dispatch untouched. A restore applies the step's ops
// through the same commands, without re-recording.

import { useCallback, type MutableRefObject } from "react";

import {
  recordPanelEdit,
  redoPanelEdit,
  undoPanelEdit,
  type PanelEditHistory,
  type PanelEditOp,
  type PanelEditStep,
} from "./panelEditHistory";
import { recordStep, type UndoOrder } from "./elementHistory";

export interface PanelEditUndo {
  /// Record one gesture's edit. The caller dispatches its own write —
  /// recording is additive, so a panel rendered outside `App` (a test,
  /// a future standalone host) still functions with the no-op default.
  recordPanelEdit: (step: PanelEditStep) => void;
  /// Step the edits stack and apply the resulting ops. Returns whether
  /// there was a step to take.
  applyPanelEditHistory: (dir: "undo" | "redo") => boolean;
}

export function usePanelEditUndo(opts: {
  historyRef: MutableRefObject<PanelEditHistory>;
  /// The interleaving log, so one chord reverses the most recent change
  /// whichever stack it lives on.
  undoOrderRef: MutableRefObject<UndoOrder>;
  /// The open undo transaction's id, if a gesture is in flight.
  gestureId: () => number | undefined;
  /// Send one op to the host.
  dispatch: (op: PanelEditOp) => void;
}): PanelEditUndo {
  const { historyRef, undoOrderRef, gestureId, dispatch } = opts;

  const record = useCallback(
    (step: PanelEditStep) => {
      historyRef.current = recordPanelEdit(historyRef.current, step);
      undoOrderRef.current = recordStep(undoOrderRef.current, "edits", gestureId());
    },
    [historyRef, undoOrderRef, gestureId],
  );

  const applyPanelEditHistory = useCallback(
    (dir: "undo" | "redo"): boolean => {
      const r =
        dir === "undo" ? undoPanelEdit(historyRef.current) : redoPanelEdit(historyRef.current);
      if (r === null) return false;
      historyRef.current = r.history;
      // Dispatched without re-recording: a restore is not a new step.
      for (const op of r.apply) dispatch(op);
      return true;
    },
    [historyRef, dispatch],
  );

  return { recordPanelEdit: record, applyPanelEditHistory };
}
