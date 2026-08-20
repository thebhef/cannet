import { describe, expect, it } from "vitest";

import {
  DRAG_PATTERNS_MIME,
  DRAG_SIGNALS_MIME,
  dedupeSignalRefs,
  dragHasPatterns,
  dragHasSignals,
  fanOutByBus,
  isDraggableSignalRef,
  parseSignalDragData,
  setSignalDragPayload,
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
    it("parses the array form a multi-signal drag emits", () => {
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
      const empty = { signals: [], patterns: [], sourcePanelId: null };
      expect(parseSignalDragData("not json")).toEqual(empty);
      expect(parseSignalDragData("")).toEqual(empty);
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

    it("emits one ref per bus the DBC is assigned to", () => {
      const out = fanOutByBus(base, ["bus-a", "bus-b"]);
      expect(out).toHaveLength(2);
      expect(out.map((r) => r.busId)).toEqual(["bus-a", "bus-b"]);
    });

    it("emits nothing for a DBC assigned to no bus", () => {
      // Bus assignment governs decode: such a database answers for no
      // frame on any bus, so there is no series to drop. The old
      // `busId: null` ref would have asked the sampler for whatever
      // some other database on some other bus supplied.
      expect(fanOutByBus(base, [])).toEqual([]);
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
    it("keeps a file-backed signal apart from a message that shares its number", () => {
      // A file-backed ref's `messageId` is a channel-group index — an
      // unrelated namespace (ADR 0052) that may collide numerically.
      // Collapsing the two would drop one of them from a mixed drag.
      const fileBacked: DraggableSignalRef = {
        busId: null,
        messageId: 256,
        extended: false,
        signalName: "EngineSpeed",
        messageName: "Analog",
        unit: "rpm",
        fileBacked: true,
      };
      const out = dedupeSignalRefs([{ ...SAMPLE, busId: null }, fileBacked, fileBacked]);
      expect(out).toHaveLength(2);
      expect(out.filter((r) => r.fileBacked)).toHaveLength(1);
    });
  });

  // ADR 0045: one payload carries signals and/or patterns, and the
  // *kind* rides in the mime list because `dragover` cannot read data.
  describe("the combined payload", () => {
    function fakeTransfer() {
      const data = new Map<string, string>();
      return {
        setData: (t: string, v: string) => data.set(t, v),
        getData: (t: string) => data.get(t) ?? "",
        get types() {
          return [...data.keys()];
        },
        effectAllowed: "none",
      } as unknown as DataTransfer;
    }

    it("round-trips signals and patterns together", () => {
      const dt = fakeTransfer();
      setSignalDragPayload(
        { dataTransfer: dt },
        { signals: [SAMPLE], patterns: ["^bus/ecu/"], sourcePanelId: "panel-1" },
      );
      const out = parseSignalDragData(dt.getData(SIGNAL_DND_MIME));
      expect(out.signals).toHaveLength(1);
      expect(out.patterns).toEqual(["^bus/ecu/"]);
      expect(out.sourcePanelId).toBe("panel-1");
    });

    it("dedupes at the payload edge, signals and patterns alike (D11)", () => {
      const dt = fakeTransfer();
      setSignalDragPayload(
        { dataTransfer: dt },
        { signals: [SAMPLE, { ...SAMPLE }], patterns: ["a", "a", "b"] },
      );
      const out = parseSignalDragData(dt.getData(SIGNAL_DND_MIME));
      expect(out.signals).toHaveLength(1);
      expect(out.patterns).toEqual(["a", "b"]);
    });

    it("announces each half it carries as its own mime", () => {
      const signalsOnly = fakeTransfer();
      setSignalDragPayload({ dataTransfer: signalsOnly }, { signals: [SAMPLE], patterns: [] });
      expect(dragHasSignals(signalsOnly.types)).toBe(true);
      expect(dragHasPatterns(signalsOnly.types)).toBe(false);

      const patternsOnly = fakeTransfer();
      setSignalDragPayload({ dataTransfer: patternsOnly }, { signals: [], patterns: ["x"] });
      expect(patternsOnly.types).toContain(DRAG_PATTERNS_MIME);
      expect(dragHasPatterns(patternsOnly.types)).toBe(true);
      // A target that only understands concrete signals — the transmit
      // panel — must reject this one during dragover.
      expect(dragHasSignals(patternsOnly.types)).toBe(false);

      const both = fakeTransfer();
      setSignalDragPayload({ dataTransfer: both }, { signals: [SAMPLE], patterns: ["x"] });
      expect(both.types).toEqual(
        expect.arrayContaining([SIGNAL_DND_MIME, DRAG_SIGNALS_MIME, DRAG_PATTERNS_MIME]),
      );
    });

    it("reads a payload that declares no kind at all as signals", () => {
      // Every pre-ADR-0045 source wrote the payload mime alone; those
      // drags are concrete signals and must keep landing.
      expect(dragHasSignals([SIGNAL_DND_MIME])).toBe(true);
      expect(dragHasPatterns([SIGNAL_DND_MIME])).toBe(false);
      expect(dragHasSignals(["text/plain"])).toBe(false);
    });
  });
});
