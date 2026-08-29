// The panel-edit undo stack (task 129): host-owned edits the Signal and
// RBS panels make — a mapping pick, an RBS enable, a value override —
// as step/inverse pairs like the event-link stack, never snapshots.

import { describe, expect, it } from "vitest";

import {
  EMPTY_PANEL_EDIT_HISTORY,
  PANEL_EDIT_HISTORY_CAP,
  recordPanelEdit,
  redoPanelEdit,
  undoPanelEdit,
  type PanelEditStep,
} from "./panelEditHistory";

const pick = (dbcPath: string) => ({ kind: "pick" as const, signal: "b1|0x100|Soc", dbcPath });

const step: PanelEditStep = { undo: [pick("a.dbc")], redo: [pick("b.dbc")] };

describe("panelEditHistory", () => {
  it("undo hands back the step's own inverse ops; redo re-applies its forward ops", () => {
    const h = recordPanelEdit(EMPTY_PANEL_EDIT_HISTORY, step);
    const u = undoPanelEdit(h);
    expect(u?.apply).toEqual([pick("a.dbc")]);
    const r = redoPanelEdit(u!.history);
    expect(r?.apply).toEqual([pick("b.dbc")]);
    // And the round trip leaves the step undoable again.
    expect(undoPanelEdit(r!.history)?.apply).toEqual([pick("a.dbc")]);
  });

  it("a new step clears the redo side, like every other stack", () => {
    const h = recordPanelEdit(EMPTY_PANEL_EDIT_HISTORY, step);
    const u = undoPanelEdit(h)!;
    const h2 = recordPanelEdit(u.history, { undo: [pick("x.dbc")], redo: [pick("y.dbc")] });
    expect(redoPanelEdit(h2)).toBeNull();
  });

  it("has nothing to step at the ends", () => {
    expect(undoPanelEdit(EMPTY_PANEL_EDIT_HISTORY)).toBeNull();
    expect(redoPanelEdit(EMPTY_PANEL_EDIT_HISTORY)).toBeNull();
  });

  it("caps the stack at the shared bound", () => {
    let h = EMPTY_PANEL_EDIT_HISTORY;
    for (let i = 0; i < PANEL_EDIT_HISTORY_CAP + 10; i++) {
      h = recordPanelEdit(h, step);
    }
    expect(h.past.length).toBe(PANEL_EDIT_HISTORY_CAP);
  });

  it("a multi-op step applies as one unit, ops in recorded order", () => {
    // A remap touches several stores; its undo is one chord.
    const multi: PanelEditStep = {
      undo: [pick("a.dbc"), { kind: "rbsEnable", elementId: "e", bus: "B", ecu: null, message: null, enabled: true }],
      redo: [pick("b.dbc"), { kind: "rbsEnable", elementId: "e", bus: "B", ecu: null, message: null, enabled: false }],
    };
    const h = recordPanelEdit(EMPTY_PANEL_EDIT_HISTORY, multi);
    expect(undoPanelEdit(h)?.apply.map((o) => o.kind)).toEqual(["pick", "rbsEnable"]);
  });
});
