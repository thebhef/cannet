// @vitest-environment jsdom
//
// The React half of the panel-edit stack: recording joins the
// interleaving log, a restore dispatches the step's ops in order
// without re-recording, and the chord's direction picks which side.

import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";

import { usePanelEditUndo } from "./usePanelEditUndo";
import { EMPTY_PANEL_EDIT_HISTORY, type PanelEditHistory, type PanelEditOp } from "./panelEditHistory";
import { EMPTY_UNDO_ORDER, type UndoOrder } from "./elementHistory";

const pick = (dbcPath: string): PanelEditOp => ({ kind: "pick", signal: "s", dbcPath });

function setup() {
  const dispatched: PanelEditOp[] = [];
  const { result } = renderHook(() => {
    const historyRef = useRef<PanelEditHistory>(EMPTY_PANEL_EDIT_HISTORY);
    const undoOrderRef = useRef<UndoOrder>(EMPTY_UNDO_ORDER);
    const undo = usePanelEditUndo({
      historyRef,
      undoOrderRef,
      gestureId: () => undefined,
      dispatch: (op) => dispatched.push(op),
    });
    return { undo, historyRef, undoOrderRef };
  });
  return { ...result.current, dispatched };
}

describe("usePanelEditUndo", () => {
  it("records into the shared order log and restores through dispatch, not re-record", () => {
    const { undo, historyRef, undoOrderRef, dispatched } = setup();
    undo.recordPanelEdit({ undo: [pick("old.dbc")], redo: [pick("new.dbc")] });
    expect(undoOrderRef.current.past).toEqual([{ stacks: ["edits"], gesture: undefined }]);
    expect(dispatched).toEqual([]); // recording never dispatches — the panel already wrote

    expect(undo.applyPanelEditHistory("undo")).toBe(true);
    expect(dispatched).toEqual([pick("old.dbc")]);
    expect(historyRef.current.past).toHaveLength(0); // moved to the redo side, not re-recorded

    expect(undo.applyPanelEditHistory("redo")).toBe(true);
    expect(dispatched).toEqual([pick("old.dbc"), pick("new.dbc")]);
    expect(undo.applyPanelEditHistory("redo")).toBe(false);
  });

  it("applies a multi-op step's ops in order as one restore", () => {
    const { undo, dispatched } = setup();
    undo.recordPanelEdit({ undo: [pick("a"), pick("b")], redo: [pick("c")] });
    undo.applyPanelEditHistory("undo");
    expect(dispatched).toEqual([pick("a"), pick("b")]);
  });
});

