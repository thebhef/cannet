import { describe, expect, it, vi } from "vitest";

import {
  areaAxisScales,
  claimPlotArea,
  copyOfArea,
  insertAreaAt,
  onPlotAreaClaimed,
  parsePlotAreaDragData,
  rekeyAxisScales,
  setPlotAreaDragData,
  type PlotAreaDragPayload,
} from "./plotAreaTransfer";
import { PLOT_AREA_DND_MIME, type PlotAreaConfig } from "./plotPanelConfig";

const sig = (signalName: string, unit = "V") => ({
  busId: null,
  messageId: 256,
  extended: false,
  signalName,
  messageName: "Pack",
  unit,
  color: "#123456",
});

const area = (over?: Partial<PlotAreaConfig>): PlotAreaConfig => ({
  id: "a1",
  signals: [sig("Cell1")],
  yAxisMode: "per-unit",
  primarySignalKey: null,
  ...over,
});

/// The `DataTransfer` stand-in a drag gesture writes to and the drop
/// reads back — the same object throughout, as in the browser.
function transfer() {
  const store = new Map<string, string>();
  const types: string[] = [];
  return {
    types,
    effectAllowed: "" as string,
    setData(t: string, v: string) {
      store.set(t, v);
      if (!types.includes(t)) types.push(t);
    },
    getData: (t: string) => store.get(t) ?? "",
  };
}

describe("plot-area drag payload", () => {
  it("round-trips the area config, its manual ranges, and the source panel", () => {
    const dt = transfer();
    const payload: PlotAreaDragPayload = {
      area: area({ collapsed: true, patterns: ["Cell\\d+"], primarySignalKey: "k" }),
      axisScales: { a1: { max: 10 }, "a1/u:unit:V": { log: true } },
      sourcePanelId: "plot-src",
    };
    setPlotAreaDragData({ dataTransfer: dt as unknown as DataTransfer }, payload);
    expect(dt.types).toContain(PLOT_AREA_DND_MIME);

    const back = parsePlotAreaDragData(dt.getData(PLOT_AREA_DND_MIME));
    expect(back).not.toBeNull();
    expect(back!.sourcePanelId).toBe("plot-src");
    expect(back!.area.id).toBe("a1");
    expect(back!.area.signals.map((s) => s.signalName)).toEqual(["Cell1"]);
    expect(back!.area.yAxisMode).toBe("per-unit");
    expect(back!.area.primarySignalKey).toBe("k");
    expect(back!.area.patterns).toEqual(["Cell\\d+"]);
    expect(back!.area.collapsed).toBe(true);
    expect(back!.axisScales).toEqual({ a1: { max: 10 }, "a1/u:unit:V": { log: true } });
  });

  it("allows either drop effect, so a copy cursor is offered", () => {
    const dt = transfer();
    setPlotAreaDragData(
      { dataTransfer: dt as unknown as DataTransfer },
      { area: area(), axisScales: {}, sourcePanelId: "plot-src" },
    );
    expect(dt.effectAllowed).toBe("copyMove");
  });

  it("rejects a payload that is not one", () => {
    expect(parsePlotAreaDragData("")).toBeNull();
    expect(parsePlotAreaDragData("not json")).toBeNull();
    expect(parsePlotAreaDragData("null")).toBeNull();
    // No source panel: the receiver could not tell move from add.
    expect(parsePlotAreaDragData(JSON.stringify({ area: area() }))).toBeNull();
    expect(parsePlotAreaDragData(JSON.stringify({ sourcePanelId: "p" }))).toBeNull();
  });
});

describe("axis-scale keys of one area", () => {
  const scales = {
    a1: { max: 10 },
    "a1/u:unit:V": { min: 0 },
    "a1/i:0|256|s|Cell1": { log: true },
    a12: { max: 1 },
    a2: { max: 2 },
  };

  it("selects the area's own keys, unified id and derived alike", () => {
    expect(areaAxisScales(scales, "a1")).toEqual({
      a1: { max: 10 },
      "a1/u:unit:V": { min: 0 },
      "a1/i:0|256|s|Cell1": { log: true },
    });
  });

  it("keeps an area whose id merely prefixes another's out of it", () => {
    expect(areaAxisScales(scales, "a12")).toEqual({ a12: { max: 1 } });
  });

  it("re-keys onto a new area id, unified id and derived suffixes alike", () => {
    expect(rekeyAxisScales(areaAxisScales(scales, "a1"), "a1", "b9")).toEqual({
      b9: { max: 10 },
      "b9/u:unit:V": { min: 0 },
      "b9/i:0|256|s|Cell1": { log: true },
    });
  });
});

describe("copying an area", () => {
  it("mints a fresh id and keeps everything else", () => {
    const src = area({ collapsed: true, patterns: ["Cell\\d+"] });
    const copy = copyOfArea(src);
    expect(copy.id).not.toBe(src.id);
    expect(copy.id.length).toBeGreaterThan(0);
    expect(copy.signals).toEqual(src.signals);
    expect(copy.signals).not.toBe(src.signals);
    expect(copy.yAxisMode).toBe(src.yAxisMode);
    expect(copy.collapsed).toBe(true);
    expect(copy.patterns).toEqual(["Cell\\d+"]);
    expect(copy.patterns).not.toBe(src.patterns);
  });
});

describe("inserting a transferred area", () => {
  const a = area({ id: "a" });
  const b = area({ id: "b" });
  const incoming = area({ id: "x" });

  it("lands at the drop target's position", () => {
    expect(insertAreaAt([a, b], incoming, "b").map((z) => z.id)).toEqual(["a", "x", "b"]);
    expect(insertAreaAt([a, b], incoming, "a").map((z) => z.id)).toEqual(["x", "a", "b"]);
  });

  it("appends when the target is gone", () => {
    expect(insertAreaAt([a, b], incoming, "nope").map((z) => z.id)).toEqual(["a", "b", "x"]);
  });
});

describe("claiming a moved area from its source panel", () => {
  it("delivers the claim to the registered source panel only", () => {
    const src = vi.fn();
    const other = vi.fn();
    const offSrc = onPlotAreaClaimed("plot-src", src);
    const offOther = onPlotAreaClaimed("plot-other", other);
    try {
      expect(claimPlotArea("plot-src", "a1")).toBe(true);
      expect(src).toHaveBeenCalledWith("a1");
      expect(other).not.toHaveBeenCalled();
    } finally {
      offSrc();
      offOther();
    }
  });

  it("is inert when the source panel is gone — nothing to remove from", () => {
    expect(claimPlotArea("plot-closed", "a1")).toBe(false);
  });

  it("stops delivering once the source panel unsubscribes", () => {
    const src = vi.fn();
    onPlotAreaClaimed("plot-src", src)();
    expect(claimPlotArea("plot-src", "a1")).toBe(false);
    expect(src).not.toHaveBeenCalled();
  });
});
