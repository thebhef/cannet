import { describe, expect, it } from "vitest";

import {
  EMPTY_FOCUS_HISTORY,
  initLayoutHistory,
  navigateFocus,
  recordFocus,
  recordLayout,
  redoLayout,
  undoLayout,
  type FocusHistory,
} from "./viewHistory";

const record = (ids: string[]): FocusHistory =>
  ids.reduce((h, id) => recordFocus(h, id), EMPTY_FOCUS_HISTORY);

describe("focus history", () => {
  it("records focused panels in order", () => {
    const h = record(["a", "b", "c"]);
    expect(h.stack).toEqual(["a", "b", "c"]);
    expect(h.index).toBe(2);
  });

  it("ignores a re-focus of the current panel", () => {
    const h = recordFocus(record(["a", "b"]), "b");
    expect(h.stack).toEqual(["a", "b"]);
    expect(h.index).toBe(1);
  });

  it("walks back and forward", () => {
    const allOpen = () => true;
    const h = record(["a", "b", "c"]);
    const back = navigateFocus(h, -1, allOpen);
    expect(back?.panelId).toBe("b");
    const back2 = navigateFocus(back!.history, -1, allOpen);
    expect(back2?.panelId).toBe("a");
    expect(navigateFocus(back2!.history, -1, allOpen)).toBeNull();
    const fwd = navigateFocus(back2!.history, 1, allOpen);
    expect(fwd?.panelId).toBe("b");
  });

  it("recording after back truncates the forward entries", () => {
    const h = record(["a", "b", "c"]);
    const back = navigateFocus(h, -1, () => true)!;
    const h2 = recordFocus(back.history, "d");
    expect(h2.stack).toEqual(["a", "b", "d"]);
    expect(h2.index).toBe(2);
    expect(navigateFocus(h2, 1, () => true)).toBeNull();
  });

  it("skips entries whose panel has since closed", () => {
    const h = record(["a", "b", "c"]);
    const isOpen = (id: string) => id !== "b";
    const back = navigateFocus(h, -1, isOpen);
    expect(back?.panelId).toBe("a");
    expect(navigateFocus(h, -1, () => false)).toBeNull();
  });

  it("caps the stack length, dropping the oldest entries", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `p${i}`);
    const h = record(ids);
    expect(h.stack.length).toBe(50);
    expect(h.stack[0]).toBe("p10");
    expect(h.index).toBe(49);
  });
});

// Minimal layout shapes: the real ones are dockview's SerializedDockview;
// the history only cares about JSON text and the scrubbed structural key.
const layout = (views: string[], extras: Record<string, unknown> = {}): string =>
  JSON.stringify({
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: { views, activeView: views[0] ?? "", id: "g1" },
            size: 200,
          },
        ],
      },
      width: 800,
      height: 600,
      orientation: "HORIZONTAL",
    },
    panels: Object.fromEntries(
      views.map((v) => [
        v,
        { id: v, contentComponent: "trace", title: v, params: { q: "" } },
      ]),
    ),
    activeGroup: "g1",
    ...extras,
  });

describe("layout history", () => {
  it("undo/redo roundtrips a structural change", () => {
    const a = layout(["p1", "p2"]);
    const b = layout(["p1"]); // p2 closed
    let h = recordLayout(initLayoutHistory(a), b);
    const undone = undoLayout(h)!;
    expect(undone.layout).toBe(a);
    h = undone.history;
    expect(undoLayout(h)).toBeNull();
    const redone = redoLayout(h)!;
    expect(redone.layout).toBe(b);
    expect(redoLayout(redone.history)).toBeNull();
  });

  it("a focus-, size-, maximize-, or params-only change updates present without a step", () => {
    const a = layout(["p1", "p2"]);
    const parsed = JSON.parse(a);
    parsed.grid.root.data[0].data.activeView = "p2";
    parsed.grid.root.data[0].size = 300;
    parsed.grid.maximizedNode = { location: [0] };
    parsed.panels.p1.params.q = "search text";
    const focusOnly = JSON.stringify(parsed);
    const h = recordLayout(initLayoutHistory(a), focusOnly);
    expect(undoLayout(h)).toBeNull();
    // The latest (focus-updated) layout is what present holds.
    const h2 = recordLayout(h, layout(["p1"]));
    expect(undoLayout(h2)?.layout).toBe(focusOnly);
  });

  it("object key order is irrelevant — a reserialized layout is not a step", () => {
    // After fromJSON (an undo, a project open) dockview rebuilds its
    // internal group order from the grid walk, so the next toJSON can
    // emit the same layout with reordered record keys. That must not
    // read as a structural change — it cleared the redo future.
    const a = layout(["p1", "p2"]);
    const parsed = JSON.parse(a);
    parsed.panels = Object.fromEntries(Object.entries(parsed.panels).reverse());
    const reordered = JSON.stringify(parsed);
    expect(reordered).not.toBe(a);
    const h = recordLayout(initLayoutHistory(a), reordered);
    expect(undoLayout(h)).toBeNull();
  });

  it("a structural change clears the redo future", () => {
    const a = layout(["p1", "p2"]);
    const b = layout(["p1"]);
    const c = layout(["p1", "p3"]);
    const h = recordLayout(initLayoutHistory(a), b);
    const undone = undoLayout(h)!;
    const h2 = recordLayout(undone.history, c);
    expect(redoLayout(h2)).toBeNull();
    expect(undoLayout(h2)?.layout).toBe(a);
  });

  it("caps the undo depth, dropping the oldest snapshots", () => {
    let h = initLayoutHistory(layout(["p0"]));
    for (let i = 1; i <= 60; i++) {
      h = recordLayout(h, layout([`p${i}`]));
    }
    let undos = 0;
    for (let r = undoLayout(h); r; r = undoLayout(h)) {
      h = r.history;
      undos++;
    }
    expect(undos).toBe(50);
  });
});
