// The plot side panel's per-area signal selection: plain click
// replaces, Ctrl/Cmd+click toggles, Shift+click takes the range from
// the anchor, and a click in another area starts that area's selection
// fresh — a selection never spans two plot areas.

import { describe, expect, it } from "vitest";

import {
  NO_PLOT_SIGNAL_SELECTION,
  selectPlotSignal,
  type PlotSignalSelection,
} from "./plotAreaSelection";

const A_ORDER = ["a1", "a2", "a3", "a4"];
const B_ORDER = ["b1", "b2"];

const PLAIN = { mod: false, shift: false };
const MOD = { mod: true, shift: false };
const SHIFT = { mod: false, shift: true };

/// The selected keys in the area's own order, so assertions read as
/// rows rather than as whatever order the set happens to iterate in.
function selected(s: PlotSignalSelection, order: readonly string[] = A_ORDER): string[] {
  return order.filter((k) => s.ids.has(k));
}

function clickA(
  current: PlotSignalSelection,
  key: string,
  modifiers: { mod: boolean; shift: boolean },
): PlotSignalSelection {
  return selectPlotSignal(current, "area-a", key, modifiers, A_ORDER);
}

describe("plot area signal selection", () => {
  it("starts empty, belonging to no area", () => {
    expect(NO_PLOT_SIGNAL_SELECTION.areaId).toBeNull();
    expect(NO_PLOT_SIGNAL_SELECTION.ids.size).toBe(0);
    expect(NO_PLOT_SIGNAL_SELECTION.anchor).toBeNull();
  });

  it("selects one row on a plain click and anchors there", () => {
    const s = clickA(NO_PLOT_SIGNAL_SELECTION, "a2", PLAIN);
    expect(s.areaId).toBe("area-a");
    expect(selected(s)).toEqual(["a2"]);
    expect(s.anchor).toBe("a2");
  });

  it("replaces the selection on a second plain click", () => {
    let s = clickA(NO_PLOT_SIGNAL_SELECTION, "a2", PLAIN);
    s = clickA(s, "a4", PLAIN);
    expect(selected(s)).toEqual(["a4"]);
    expect(s.anchor).toBe("a4");
  });

  it("toggles membership on Ctrl+click, both ways", () => {
    let s = clickA(NO_PLOT_SIGNAL_SELECTION, "a1", PLAIN);
    s = clickA(s, "a3", MOD);
    expect(selected(s)).toEqual(["a1", "a3"]);
    s = clickA(s, "a1", MOD);
    expect(selected(s)).toEqual(["a3"]);
    expect(s.anchor).toBe("a1");
  });

  it("range-selects from the anchor on Shift+click, in either direction", () => {
    let s = clickA(NO_PLOT_SIGNAL_SELECTION, "a3", PLAIN);
    s = clickA(s, "a1", SHIFT);
    expect(selected(s)).toEqual(["a1", "a2", "a3"]);
    // The anchor stays put, so a follow-up range extends from the same
    // row rather than from the previous target.
    expect(s.anchor).toBe("a3");
    s = clickA(s, "a4", SHIFT);
    expect(selected(s)).toEqual(["a3", "a4"]);
  });

  it("falls back to a single select when Shift+click has no anchor", () => {
    const s = clickA(NO_PLOT_SIGNAL_SELECTION, "a2", SHIFT);
    expect(selected(s)).toEqual(["a2"]);
    expect(s.anchor).toBe("a2");
  });

  it("clears the other area's selection when a click lands in a new area", () => {
    let s = clickA(NO_PLOT_SIGNAL_SELECTION, "a1", PLAIN);
    s = clickA(s, "a3", MOD);
    expect(selected(s)).toEqual(["a1", "a3"]);

    s = selectPlotSignal(s, "area-b", "b2", PLAIN, B_ORDER);
    expect(s.areaId).toBe("area-b");
    expect(selected(s, B_ORDER)).toEqual(["b2"]);
    expect(selected(s)).toEqual([]);
  });

  it("does not carry an anchor across areas", () => {
    // Ctrl+click in a fresh area is a toggle-on of one row, not an
    // extension of the previous area's set.
    let s = clickA(NO_PLOT_SIGNAL_SELECTION, "a1", PLAIN);
    s = selectPlotSignal(s, "area-b", "b2", MOD, B_ORDER);
    expect(selected(s, B_ORDER)).toEqual(["b2"]);
    // …and a Shift+click there has nothing to range from, so it selects
    // the clicked row alone.
    let t = clickA(NO_PLOT_SIGNAL_SELECTION, "a1", PLAIN);
    t = selectPlotSignal(t, "area-b", "b2", SHIFT, B_ORDER);
    expect(selected(t, B_ORDER)).toEqual(["b2"]);
    expect(t.anchor).toBe("b2");
  });

  it("leaves the selection untouched — same object — for a key the area does not hold", () => {
    const before = clickA(NO_PLOT_SIGNAL_SELECTION, "a1", PLAIN);
    expect(clickA(before, "gone", PLAIN)).toBe(before);
    expect(selectPlotSignal(before, "area-b", "gone", PLAIN, B_ORDER)).toBe(before);
  });
});
