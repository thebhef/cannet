import { describe, expect, it } from "vitest";

import { defaultVisibleKinds, type EventKind, type Note } from "./notes";
import { plotTimelineEvents, subjectsForSelection } from "./plotEvents";
import { signalRefKey, type SignalRef } from "./plotPanelConfig";

const KIND_COLOR = (k: EventKind) =>
  k === "truncation" ? "#amber" : k === "busError" ? "#red" : undefined;

const notes: Note[] = [
  { id: "n1", timestampNs: 2_000_000_000, label: "note" },
  { id: "e1", timestampNs: 1_000_000_000, label: "bus error x40", kind: "busError" },
];

describe("plotTimelineEvents", () => {
  it("has nowhere to draw before the panel has an origin", () => {
    expect(plotTimelineEvents(notes, null, null, defaultVisibleKinds(), KIND_COLOR)).toEqual([]);
  });

  it("leaves out the kinds this panel is not showing", () => {
    // A bus error is hidden by default, so it draws no cursor at all until
    // this panel is told to show it (ADR 0035).
    const shown = plotTimelineEvents(notes, null, 1, defaultVisibleKinds(), KIND_COLOR);
    expect(shown.map((e) => e.id)).toEqual(["n1"]);

    const withErrors = new Set<EventKind>([...defaultVisibleKinds(), "busError"]);
    const all = plotTimelineEvents(notes, null, 1, withErrors, KIND_COLOR);
    expect(all.map((e) => e.id)).toEqual(["e1", "n1"]);
    // ...in display-relative seconds against the origin, colored by kind.
    expect(all[0]).toEqual({ id: "e1", t: 0, label: "bus error x40", color: "#red" });
    expect(all[1].color).toBeUndefined();
  });

  it("treats the truncation marker as one more filterable kind", () => {
    const withTrunc = plotTimelineEvents([], 3_000_000_000, 1, defaultVisibleKinds(), KIND_COLOR);
    expect(withTrunc.map((e) => e.label)).toEqual(["history truncated here"]);
    expect(withTrunc[0].color).toBe("#amber");

    const hidden = new Set<EventKind>(["note"]);
    expect(plotTimelineEvents([], 3_000_000_000, 1, hidden, KIND_COLOR)).toEqual([]);
  });

  it("keeps an event's own color over the kind default", () => {
    const own: Note[] = [{ id: "n", timestampNs: 1_000_000_000, label: "x", color: "#123456" }];
    expect(plotTimelineEvents(own, null, 0, defaultVisibleKinds(), KIND_COLOR)[0].color).toBe(
      "#123456",
    );
  });
});

describe("subjectsForSelection", () => {
  const ref = (over: Partial<SignalRef>): SignalRef => ({
    busId: "bus-a",
    messageId: 0x180,
    extended: false,
    signalName: "PackCurrent",
    messageName: "BMS_Status",
    unit: "A",
    ...over,
  });
  const keys = (...rs: SignalRef[]) => new Set(rs.map(signalRefKey));

  it("turns the selected rows into signal subjects, in the area's order", () => {
    const a = ref({});
    const b = ref({ signalName: "ContactorState" });
    expect(subjectsForSelection([a, b], keys(b, a))).toEqual([
      { kind: "signal", messageId: 0x180, extended: false, signalName: "PackCurrent" },
      { kind: "signal", messageId: 0x180, extended: false, signalName: "ContactorState" },
    ]);
  });

  it("names only what is selected", () => {
    const a = ref({});
    const b = ref({ signalName: "ContactorState" });
    expect(subjectsForSelection([a, b], keys(b))).toEqual([
      { kind: "signal", messageId: 0x180, extended: false, signalName: "ContactorState" },
    ]);
    expect(subjectsForSelection([a, b], new Set())).toEqual([]);
  });

  it("keeps the extended flag, which is half of message identity", () => {
    const x = ref({ extended: true });
    expect(subjectsForSelection([x], keys(x))).toEqual([
      { kind: "signal", messageId: 0x180, extended: true, signalName: "PackCurrent" },
    ]);
  });

  it("collapses the same signal selected on two buses into one subject", () => {
    // A subject stores no bus (ADR 0056), so two rows differing only in
    // their bus are one structural reference — not a duplicate chip.
    const a = ref({ busId: "bus-a" });
    const b = ref({ busId: "bus-b" });
    expect(subjectsForSelection([a, b], keys(a, b))).toEqual([
      { kind: "signal", messageId: 0x180, extended: false, signalName: "PackCurrent" },
    ]);
  });

  it("drops a file-backed series, which has no message to reference", () => {
    // Its `messageId` is a signal channel group index, not an
    // arbitration id, so writing it as a message reference would name a
    // message that does not exist.
    const f = ref({ fileBacked: true, busId: null, signalName: "Torque" });
    const s = ref({});
    expect(subjectsForSelection([f], keys(f))).toEqual([]);
    expect(subjectsForSelection([f, s], keys(f, s))).toEqual([
      { kind: "signal", messageId: 0x180, extended: false, signalName: "PackCurrent" },
    ]);
  });
});
