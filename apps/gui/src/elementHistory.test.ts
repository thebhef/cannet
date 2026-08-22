import { describe, expect, it } from "vitest";

import {
  EMPTY_UNDO_ORDER,
  amendElements,
  initElementHistory,
  maskElements,
  popRedo,
  popUndo,
  recordElements,
  recordStep,
  redoElements,
  restoreElements,
  syncElements,
  undoElements,
} from "./elementHistory";
import type { ProjectElement } from "./types";

const plot = (id: string, config?: Record<string, unknown>): ProjectElement =>
  ({ kind: "plot", id, name: `Plot ${id}`, sources: ["*"], config }) as ProjectElement;

const rbs = (id: string, path: string | null): ProjectElement => ({
  kind: "rbs",
  id,
  name: "RBS 1",
  path,
});

const transmit = (id: string, frameIds: string[], sinks: string[]): ProjectElement => ({
  kind: "transmit",
  id,
  name: "Transmit 1",
  sinks,
  frameIds,
});

const filter = (id: string, sources: string[]): ProjectElement => ({
  kind: "filter",
  id,
  name: "Filter 1",
  sources,
  predicate: { bus: "b1" },
});

describe("the undo mask (ADR 0050)", () => {
  it("keeps the display and organizational fields of a view element", () => {
    const [masked] = maskElements([plot("p1", { areas: [{ signals: ["a"] }] })]);
    expect(masked).toEqual({
      id: "p1",
      kind: "plot",
      name: "Plot p1",
      sources: ["*"],
      config: { areas: [{ signals: ["a"] }] },
    });
  });

  it("drops an RBS element's path", () => {
    const [masked] = maskElements([rbs("r1", "/tmp/sim.cannet_rbs")]);
    expect(masked).toEqual({ id: "r1", kind: "rbs", name: "RBS 1" });
  });

  it("drops a transmit element's messages and sinks", () => {
    const [masked] = maskElements([transmit("t1", ["f1"], ["bus1"])]);
    expect(masked).toEqual({ id: "t1", kind: "transmit", name: "Transmit 1" });
  });

  it("keeps a filter's predicate and sources — the wiring family is undoable", () => {
    const [masked] = maskElements([filter("f1", ["bus1"])]);
    expect(masked).toEqual({
      id: "f1",
      kind: "filter",
      name: "Filter 1",
      sources: ["bus1"],
      predicate: { bus: "b1" },
    });
  });

  it("keeps colormap and generator rules", () => {
    const [colormap, generator] = maskElements([
      {
        kind: "colormap",
        id: "c1",
        name: "Map 1",
        busId: null,
        messageId: 7,
        extended: false,
        signalName: "Speed",
        rules: [{ min: 0, max: 1, color: "#fff" }],
      },
      { kind: "generator", id: "g1", name: "Gen 1", rules: [{ pattern: "x", enabled: true }] },
    ]);
    expect(colormap).toMatchObject({ signalName: "Speed", messageId: 7 });
    expect(generator).toMatchObject({ rules: [{ pattern: "x", enabled: true }] });
  });
});

describe("element history", () => {
  it("undo/redo roundtrips an allowlisted change", () => {
    const before = [plot("p1", { mode: "a" })];
    const after = [plot("p1", { mode: "b" })];
    let h = recordElements(initElementHistory(before), after);
    const undone = undoElements(h)!;
    expect(undone.snapshot).toEqual(maskElements(before));
    h = undone.history;
    expect(undoElements(h)).toBeNull();
    const redone = redoElements(h)!;
    expect(redone.snapshot).toEqual(maskElements(after));
    expect(redoElements(redone.history)).toBeNull();
  });

  it("a change to an excluded field is not a step", () => {
    const before = [rbs("r1", null), transmit("t1", [], ["b1"])];
    const after = [rbs("r1", "/tmp/sim.cannet_rbs"), transmit("t1", ["f1"], ["b2"])];
    const h = recordElements(initElementHistory(before), after);
    expect(undoElements(h)).toBeNull();
  });

  it("a value-equal rewrite is not a step", () => {
    // The persist effect rebuilds a fresh config blob every render; a
    // deep compare is what keeps that from becoming an undo step.
    const h = recordElements(initElementHistory([plot("p1", { areas: [] })]), [
      plot("p1", { areas: [] }),
    ]);
    expect(undoElements(h)).toBeNull();
  });

  it("an element's first config is a panel seeding itself, not a step", () => {
    // A freshly added panel persists its (empty) view config the moment
    // it mounts. One user gesture — "add a plot" — must not cost two
    // undos.
    const h = recordElements(initElementHistory([plot("p1")]), [plot("p1", { areas: [] })]);
    expect(undoElements(h)).toBeNull();
    // …and the seeded config is what the next step steps back to.
    const h2 = recordElements(h, [plot("p1", { areas: [{ signals: ["a"] }] })]);
    expect(undoElements(h2)?.snapshot).toEqual(maskElements([plot("p1", { areas: [] })]));
  });

  it("a seed alongside a real edit is still a step", () => {
    const h = recordElements(initElementHistory([plot("p1"), plot("p2", { areas: [] })]), [
      plot("p1", { areas: [] }),
      plot("p2", { areas: [{ signals: ["a"] }] }),
    ]);
    expect(undoElements(h)).not.toBeNull();
  });

  it("a rename is a step", () => {
    const before = [plot("p1", {})];
    const after = [{ ...plot("p1", {}), name: "Speeds" } as ProjectElement];
    const h = recordElements(initElementHistory(before), after);
    expect(undoElements(h)?.snapshot).toEqual(maskElements(before));
  });

  it("a change clears the redo future", () => {
    const a = [plot("p1", { mode: "a" })];
    const b = [plot("p1", { mode: "b" })];
    const c = [plot("p1", { mode: "c" })];
    const undone = undoElements(recordElements(initElementHistory(a), b))!;
    const h = recordElements(undone.history, c);
    expect(redoElements(h)).toBeNull();
    expect(undoElements(h)?.snapshot).toEqual(maskElements(a));
  });

  it("caps the undo depth, dropping the oldest snapshots", () => {
    let h = initElementHistory([plot("p1", { n: 0 })]);
    for (let i = 1; i <= 60; i++) h = recordElements(h, [plot("p1", { n: i })]);
    let undos = 0;
    for (let r = undoElements(h); r; r = undoElements(h)) {
      h = r.history;
      undos++;
    }
    expect(undos).toBe(50);
  });
});

describe("syncElements", () => {
  it("follows a change nobody claimed as an edit without making a step", () => {
    // Element creation, project open, session churn: the present has to
    // keep up, but none of it is a user edit.
    const h = syncElements(initElementHistory([plot("p1", {})]), [plot("p1", {}), plot("p2", {})]);
    expect(undoElements(h)).toBeNull();
    const h2 = recordElements(h, [plot("p1", {}), plot("p2", { mode: "b" })]);
    expect(undoElements(h2)?.snapshot).toEqual(maskElements([plot("p1", {}), plot("p2", {})]));
  });

  it("keeps the redo future — a sync is not an edit", () => {
    const undone = undoElements(
      recordElements(initElementHistory([plot("p1", { mode: "a" })]), [plot("p1", { mode: "b" })]),
    )!;
    const h = syncElements(undone.history, [plot("p1", { mode: "a" }), plot("p2", {})]);
    expect(redoElements(h)).not.toBeNull();
  });

  it("returns the same history when nothing masked changed", () => {
    const h = initElementHistory([rbs("r1", null)]);
    expect(syncElements(h, [rbs("r1", "/tmp/sim.cannet_rbs")])).toBe(h);
  });

  it("grafts an element created outside a step into the stored snapshots", () => {
    // No step created `p2`, so no step may delete it: it belongs to
    // every timeline, including the ones taken before it existed.
    const h = recordElements(initElementHistory([plot("p1", { mode: "a" })]), [
      plot("p1", { mode: "b" }),
    ]);
    const synced = syncElements(h, [plot("p1", { mode: "b" }), plot("p2", {})]);
    const undone = undoElements(synced)!;
    expect(undone.snapshot).toEqual(maskElements([plot("p1", { mode: "a" }), plot("p2", {})]));
    expect(restoreElements(undone.snapshot, [plot("p1", { mode: "b" }), plot("p2", {})]).removes)
      .toEqual([]);
  });
});

describe("restoreElements", () => {
  const patches = (target: ProjectElement[], current: ProjectElement[]) =>
    restoreElements(maskElements(target), current).patches;

  it("patches only the fields that differ", () => {
    expect(
      patches([plot("p1", { mode: "a" }), plot("p2", { mode: "x" })], [
        plot("p1", { mode: "b" }),
        plot("p2", { mode: "x" }),
      ]),
    ).toEqual([{ id: "p1", patch: { config: { mode: "a" } } }]);
  });

  it("never carries an excluded field (ADR 0050)", () => {
    // The snapshot was taken while the RBS was stopped and the transmit
    // empty; both have since been armed. Restoring it must not disarm
    // them — the mask means those fields aren't even in the snapshot.
    expect(
      patches(
        [rbs("r1", null), transmit("t1", [], [])],
        [rbs("r1", "/tmp/sim.cannet_rbs"), transmit("t1", ["f1"], ["b1"])],
      ),
    ).toEqual([]);
  });

  it("restores a rename", () => {
    const current = [{ ...plot("p1", {}), name: "Speeds" } as ProjectElement];
    expect(patches([plot("p1", {})], current)).toEqual([{ id: "p1", patch: { name: "Plot p1" } }]);
  });

  it("says nothing about a field the snapshot has no value for", () => {
    // A snapshot taken before an element had a config carries `config:
    // undefined`; that is an absence of information, not an instruction
    // to wipe the config the element has since acquired.
    expect(patches([plot("p1")], [plot("p1", { mode: "b" })])).toEqual([]);
  });

  it("skips an id whose kind was replaced under it", () => {
    expect(
      patches([plot("p1", { mode: "a" })], [
        { ...plot("p1", { mode: "b" }), kind: "trace" } as ProjectElement,
      ]),
    ).toEqual([]);
  });

  it("re-creates an element the snapshot has and the registry no longer does", () => {
    // Undoing a removal. The masked element is all a restore may bring
    // back (ADR 0050) — its host state is not the view stack's to
    // resurrect.
    const target = maskElements([plot("p1", {}), filter("f1", ["*"]), plot("p2", {})]);
    const plan = restoreElements(target, [plot("p1", {}), plot("p2", {})]);
    expect(plan.creates).toEqual([{ index: 1, element: maskElements([filter("f1", ["*"])])[0] }]);
    expect(plan.removes).toEqual([]);
  });

  it("removes an element the snapshot never had", () => {
    // Undoing "insert a filter upstream": the filter the gesture created
    // goes with it.
    const target = maskElements([plot("p1", {})]);
    const plan = restoreElements(target, [plot("p1", {}), filter("f1", ["*"])]);
    expect(plan.removes).toEqual(["f1"]);
    expect(plan.creates).toEqual([]);
  });
});

describe("amendElements", () => {
  it("folds a change into the step already open instead of making another", () => {
    // One drag of a splitter persists on every mouse move; the gesture
    // takes the first as its step and amends it with the rest.
    let h = recordElements(initElementHistory([plot("p1", { w: 1 })]), [plot("p1", { w: 2 })]);
    h = amendElements(h, [plot("p1", { w: 3 })]);
    h = amendElements(h, [plot("p1", { w: 4 })]);
    const undone = undoElements(h)!;
    expect(undone.snapshot).toEqual(maskElements([plot("p1", { w: 1 })]));
    expect(undoElements(undone.history)).toBeNull();
    expect(redoElements(undone.history)?.snapshot).toEqual(maskElements([plot("p1", { w: 4 })]));
  });
});

describe("undo order", () => {
  const always = () => true;

  it("undoes the most recent step, whichever stack it lives on", () => {
    let order = recordStep(recordStep(EMPTY_UNDO_ORDER, "layout"), "element");
    const first = popUndo(order, always)!;
    expect(first.stacks).toEqual(["element"]);
    order = first.order;
    const second = popUndo(order, always)!;
    expect(second.stacks).toEqual(["layout"]);
    expect(popUndo(second.order, always)).toBeNull();
  });

  it("redoes in the order it undid", () => {
    let order = recordStep(recordStep(EMPTY_UNDO_ORDER, "layout"), "element");
    order = popUndo(order, always)!.order;
    order = popUndo(order, always)!.order;
    const first = popRedo(order, always)!;
    expect(first.stacks).toEqual(["layout"]);
    const second = popRedo(first.order, always)!;
    expect(second.stacks).toEqual(["element"]);
    expect(popRedo(second.order, always)).toBeNull();
  });

  it("a new step clears the redo side", () => {
    let order = recordStep(EMPTY_UNDO_ORDER, "layout");
    order = popUndo(order, always)!.order;
    order = recordStep(order, "element");
    expect(popRedo(order, always)).toBeNull();
  });

  it("skips a stack that has nothing left to undo", () => {
    // Each stack drops its oldest snapshot at its own cap, so an order
    // entry can outlive the step it names.
    const order = recordStep(recordStep(EMPTY_UNDO_ORDER, "layout"), "element");
    const r = popUndo(order, (stack) => stack === "layout")!;
    expect(r.stacks).toEqual(["layout"]);
    expect(popUndo(r.order, (stack) => stack === "layout")).toBeNull();
  });

  it("caps the log", () => {
    let order = EMPTY_UNDO_ORDER;
    for (let i = 0; i < 500; i++) order = recordStep(order, "layout");
    expect(order.past.length).toBe(100);
  });
});

describe("undo order, transactions", () => {
  const always = () => true;

  it("makes one entry of the two stacks a single gesture touched", () => {
    // An element removal: the panel closes (layout) and the element
    // goes (element), one gesture, one entry.
    let order = recordStep(EMPTY_UNDO_ORDER, "layout", 7);
    order = recordStep(order, "element", 7);
    expect(order.past.length).toBe(1);
    const r = popUndo(order, always)!;
    expect(r.stacks).toEqual(["layout", "element"]);
    expect(popUndo(r.order, always)).toBeNull();
  });

  it("keeps a repeated stack in the same gesture to one mention", () => {
    let order = recordStep(EMPTY_UNDO_ORDER, "element", 3);
    order = recordStep(order, "element", 3);
    expect(popUndo(order, always)!.stacks).toEqual(["element"]);
  });

  it("separates gestures, and separates an untagged step from a gesture", () => {
    let order = recordStep(EMPTY_UNDO_ORDER, "element", 1);
    order = recordStep(order, "element", 2);
    order = recordStep(order, "element");
    expect(order.past.length).toBe(3);
  });

  it("does not merge into an entry that redo has already moved on from", () => {
    // The gesture's first half was undone, so its entry is on the redo
    // side; a late write must start a new entry rather than reopening it.
    let order = recordStep(EMPTY_UNDO_ORDER, "layout", 9);
    order = popUndo(order, always)!.order;
    order = recordStep(order, "element", 9);
    expect(order.past.length).toBe(1);
    expect(popUndo(order, always)!.stacks).toEqual(["element"]);
  });

  it("redoes the whole gesture as one entry", () => {
    let order = recordStep(EMPTY_UNDO_ORDER, "layout", 4);
    order = recordStep(order, "element", 4);
    order = popUndo(order, always)!.order;
    const r = popRedo(order, always)!;
    expect(r.stacks).toEqual(["layout", "element"]);
    expect(popRedo(r.order, always)).toBeNull();
  });
});
