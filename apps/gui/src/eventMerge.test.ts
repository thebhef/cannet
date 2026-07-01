import { describe, expect, it } from "vitest";

import { buildEventMerge } from "./eventMerge";
import type { TimelineEvent } from "./notes";

function ev(id: string): TimelineEvent {
  return { id, timestampNs: 0, label: id, kind: "note", color: null, editable: true };
}

describe("buildEventMerge", () => {
  it("is the identity over frames when there are no events", () => {
    const m = buildEventMerge([], [], 0, 5);
    expect(m.displayCount).toBe(5);
    expect([0, 1, 2, 3, 4].map((d) => m.rowAt(d))).toEqual([
      { row: "frame", localIndex: 0 },
      { row: "frame", localIndex: 1 },
      { row: "frame", localIndex: 2 },
      { row: "frame", localIndex: 3 },
      { row: "frame", localIndex: 4 },
    ]);
  });

  it("splices one event at its anchor, shifting later frames down", () => {
    // offset 0, frameCount 5, event anchored at absolute frame 2.
    const m = buildEventMerge([ev("a")], [2], 0, 5);
    expect(m.displayCount).toBe(6);
    expect(m.rowAt(0)).toEqual({ row: "frame", localIndex: 0 });
    expect(m.rowAt(1)).toEqual({ row: "frame", localIndex: 1 });
    expect(m.rowAt(2)).toEqual({ row: "event", event: ev("a") });
    expect(m.rowAt(3)).toEqual({ row: "frame", localIndex: 2 }); // frame 2 pushed to display 3
    expect(m.rowAt(5)).toEqual({ row: "frame", localIndex: 4 });
  });

  it("applies the window offset to absolute anchors", () => {
    // Window starts at absolute 100; an event anchored at absolute 102 lands
    // at local frame 2.
    const m = buildEventMerge([ev("a")], [102], 100, 5);
    expect(m.rowAt(2)).toEqual({ row: "event", event: ev("a") });
  });

  it("drops events whose anchor falls outside the window", () => {
    // Anchors below the window start and past its end are not shown here.
    const m = buildEventMerge([ev("before"), ev("after")], [50, 200], 100, 5);
    expect(m.displayCount).toBe(5); // neither placed
    expect(m.rowAt(0)).toEqual({ row: "frame", localIndex: 0 });
  });

  it("places multiple events at the same anchor consecutively", () => {
    const m = buildEventMerge([ev("a"), ev("b")], [2, 2], 0, 5);
    expect(m.displayCount).toBe(7);
    expect(m.rowAt(2)).toEqual({ row: "event", event: ev("a") });
    expect(m.rowAt(3)).toEqual({ row: "event", event: ev("b") });
    expect(m.rowAt(4)).toEqual({ row: "frame", localIndex: 2 }); // both events before frame 2
  });

  it("allows an event anchored at frameCount (after the last frame)", () => {
    const m = buildEventMerge([ev("tail")], [5], 0, 5);
    expect(m.displayCount).toBe(6);
    expect(m.rowAt(5)).toEqual({ row: "event", event: ev("tail") });
    expect(m.rowAt(4)).toEqual({ row: "frame", localIndex: 4 });
  });

  it("maps a frame to its display row (the goto inverse), accounting for events", () => {
    // Two events at local frames 2 and 4 (offset 0, frameCount 10).
    const m = buildEventMerge([ev("a"), ev("b")], [2, 4], 0, 10);
    // Frame 0/1 sit above both events — unshifted.
    expect(m.frameToDisplay(0)).toBe(0);
    expect(m.frameToDisplay(1)).toBe(1);
    // Event "a" renders at display 2 (anchor 2), so frame 2 shifts to 3.
    expect(m.rowAt(2)).toEqual({ row: "event", event: ev("a") });
    expect(m.frameToDisplay(2)).toBe(3);
    expect(m.frameToDisplay(3)).toBe(4);
    // Past event "b" (anchor 4) both events precede the frame: +2.
    expect(m.frameToDisplay(4)).toBe(6); // event "b" at display 5, frame 4 at 6
    expect(m.frameToDisplay(9)).toBe(11);
    // Round-trips against rowAt for every frame row.
    for (let fi = 0; fi < 10; fi++) {
      expect(m.rowAt(m.frameToDisplay(fi))).toEqual({ row: "frame", localIndex: fi });
    }
  });

  it("frameToDisplay is the identity when there are no events", () => {
    const m = buildEventMerge([], [], 0, 5);
    expect([0, 2, 4].map((f) => m.frameToDisplay(f))).toEqual([0, 2, 4]);
  });

  it("translates a display range to its frame range for prefetch", () => {
    // One event at local 2 → frames after it shift by one in display space.
    const m = buildEventMerge([ev("a")], [2], 0, 10);
    // display [0,3) covers frames 0..2 (the event at d=2 contributes none).
    expect(m.frameRange(0, 3)).toEqual([0, 2]);
    // display [3,6) is frames 2..5.
    expect(m.frameRange(3, 6)).toEqual([2, 5]);
  });
});
