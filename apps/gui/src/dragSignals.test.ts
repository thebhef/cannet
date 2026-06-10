import { describe, expect, it } from "vitest";

import {
  dedupeSignalRefs,
  fanOutByBus,
  isDraggableSignalRef,
  parseSignalDragData,
  SIGNAL_DND_MIME,
  type DraggableSignalRef,
} from "./dragSignals";

const SAMPLE: DraggableSignalRef = {
  busId: "bus-a",
  messageId: 256,
  extended: false,
  signalName: "EngineSpeed",
  messageName: "EngineData",
  unit: "rpm",
};

describe("dragSignals", () => {
  it("exposes the standard mime constant", () => {
    expect(SIGNAL_DND_MIME).toBe("application/x-cannet-plot-signal");
  });

  describe("parseSignalDragData", () => {
    it("parses the array form a Phase-12 multi-signal drag emits", () => {
      const raw = JSON.stringify({ signals: [SAMPLE, { ...SAMPLE, signalName: "EngineTemp" }] });
      const out = parseSignalDragData(raw);
      expect(out.signals).toHaveLength(2);
      expect(out.signals[0].signalName).toBe("EngineSpeed");
      expect(out.signals[1].signalName).toBe("EngineTemp");
      expect(out.sourcePanelId).toBeNull();
    });

    it("carries sourcePanelId when set (used by plot-panel internal drags)", () => {
      const raw = JSON.stringify({ signals: [SAMPLE], sourcePanelId: "panel-xyz" });
      const out = parseSignalDragData(raw);
      expect(out.sourcePanelId).toBe("panel-xyz");
    });

    it("falls back to single-ref form for legacy plot-panel internal drags", () => {
      const raw = JSON.stringify(SAMPLE);
      const out = parseSignalDragData(raw);
      expect(out.signals).toHaveLength(1);
      expect(out.signals[0].signalName).toBe("EngineSpeed");
      // Legacy form can't carry a sourcePanelId — receiver treats
      // it as external.
      expect(out.sourcePanelId).toBeNull();
    });

    it("returns empty for an unparseable payload", () => {
      expect(parseSignalDragData("not json")).toEqual({ signals: [], sourcePanelId: null });
      expect(parseSignalDragData("")).toEqual({ signals: [], sourcePanelId: null });
    });

    it("drops entries that fail the shape check", () => {
      const raw = JSON.stringify({
        signals: [SAMPLE, { messageId: "not a number" }],
      });
      expect(parseSignalDragData(raw).signals).toHaveLength(1);
    });
  });

  describe("isDraggableSignalRef", () => {
    it("accepts a busId of null (no-project-buses legacy path)", () => {
      expect(isDraggableSignalRef({ ...SAMPLE, busId: null })).toBe(true);
    });
    it("rejects missing required fields", () => {
      expect(isDraggableSignalRef({})).toBe(false);
      expect(isDraggableSignalRef({ ...SAMPLE, signalName: 42 })).toBe(false);
    });
  });

  describe("fanOutByBus", () => {
    const base: Omit<DraggableSignalRef, "busId"> = {
      messageId: 256,
      extended: false,
      signalName: "EngineSpeed",
      messageName: "EngineData",
      unit: "rpm",
    };

    it("emits one ref per scoped bus when the DBC is scoped", () => {
      const out = fanOutByBus(base, ["bus-a", "bus-b"]);
      expect(out).toHaveLength(2);
      expect(out.map((r) => r.busId)).toEqual(["bus-a", "bus-b"]);
    });

    it("emits a single null-bus ref when the DBC is unscoped (no project-bus fan-out)", () => {
      // An unscoped DBC drops as one ref with `busId: null` — the
      // legacy "any bus" sampling path. We deliberately do NOT
      // multiply by project buses here; doing so would manufacture
      // N copies of every signal on a drop and surprise the user
      // (they never picked a bus). This is asymmetric with
      // `list_signals`, which does fan unscoped DBCs across project
      // buses for the picker dropdown.
      const out = fanOutByBus(base, []);
      expect(out).toEqual([{ ...base, busId: null }]);
    });
  });

  describe("dedupeSignalRefs", () => {
    it("collapses repeats of the same (busId, messageId, extended, signalName)", () => {
      const out = dedupeSignalRefs([SAMPLE, SAMPLE, { ...SAMPLE, signalName: "EngineTemp" }]);
      expect(out).toHaveLength(2);
    });
    it("treats the same signal on different buses as distinct", () => {
      const out = dedupeSignalRefs([SAMPLE, { ...SAMPLE, busId: "bus-b" }]);
      expect(out).toHaveLength(2);
    });
  });
});
