import { describe, expect, it } from "vitest";

import {
  TRACE_COLORS,
  areasFromParams,
  cursorModeFromRaw,
  fmtCount,
  fmtFreq,
  fmtVal,
  isSignalRefCore,
  measKeysFromRaw,
  signalRefKey,
  signalsWidthFromRaw,
  withColor,
  yAxisModeFromRaw,
  type SignalRef,
} from "./plotPanelConfig";

const core = {
  busId: "b1",
  messageId: 0x123,
  extended: false,
  signalName: "Speed",
  messageName: "Msg",
  unit: "km/h",
};

describe("signalRefKey", () => {
  it("matches the canonical signalKey shape (bus + s/x id discriminator)", () => {
    expect(signalRefKey({ ...core, color: "#fff" })).toBe("b1|s:291:Speed");
    expect(signalRefKey({ ...core, extended: true, color: "#fff" })).toBe("b1|x:291:Speed");
  });
});

describe("isSignalRefCore", () => {
  it("accepts a well-formed core (busId string or null)", () => {
    expect(isSignalRefCore(core)).toBe(true);
    expect(isSignalRefCore({ ...core, busId: null })).toBe(true);
  });
  it("rejects malformed shapes", () => {
    expect(isSignalRefCore(null)).toBe(false);
    expect(isSignalRefCore({ ...core, messageId: "x" })).toBe(false);
    expect(isSignalRefCore({ ...core, busId: 7 })).toBe(false);
    expect(isSignalRefCore({ ...core, extended: undefined })).toBe(false);
  });
});

describe("withColor", () => {
  it("preserves a string colour", () => {
    expect(withColor({ ...core, color: "#abcdef" }, 0).color).toBe("#abcdef");
  });
  it("seeds a wheel colour by fallback index (wrapping) when absent", () => {
    expect(withColor(core, 0).color).toBe(TRACE_COLORS[0]);
    expect(withColor(core, TRACE_COLORS.length + 2).color).toBe(TRACE_COLORS[2]);
  });
  it("coerces a non-string busId to null", () => {
    expect(withColor({ ...core, busId: 5 as unknown as string }, 0).busId).toBeNull();
  });
});

describe("areasFromParams", () => {
  it("returns one empty area when the blob is not an array", () => {
    const areas = areasFromParams(undefined);
    expect(areas).toHaveLength(1);
    expect(areas[0].signals).toEqual([]);
    expect(areas[0].primarySignalKey).toBeNull();
  });

  it("filters malformed signals and colours the survivors", () => {
    const areas = areasFromParams([
      { id: "a", signals: [core, { bogus: true }] },
    ]);
    expect(areas).toHaveLength(1);
    expect(areas[0].signals).toHaveLength(1);
    expect(areas[0].signals[0].color).toBe(TRACE_COLORS[0]);
  });

  it("migrates a pre-patterns single `signalFilter` regex to a one-entry pattern list", () => {
    const areas = areasFromParams([{ id: "a", signals: [], signalFilter: "b1/.*/Msg/.*" }]);
    expect(areas[0].patterns).toEqual(["b1/.*/Msg/.*"]);
  });

  it("prefers an explicit patterns array over the legacy signalFilter", () => {
    const areas = areasFromParams([
      { id: "a", signals: [], patterns: ["p1", "p2"], signalFilter: "legacy" },
    ]);
    expect(areas[0].patterns).toEqual(["p1", "p2"]);
  });

  it("leaves patterns undefined when there are none", () => {
    const areas = areasFromParams([{ id: "a", signals: [] }]);
    expect(areas[0].patterns).toBeUndefined();
  });

  it("synthesizes an id when missing", () => {
    const areas = areasFromParams([{ signals: [] }]);
    expect(typeof areas[0].id).toBe("string");
    expect(areas[0].id.length).toBeGreaterThan(0);
  });
});

describe("scalar param parsers", () => {
  it("cursorModeFromRaw accepts known modes, defaults to off", () => {
    expect(cursorModeFromRaw("x")).toBe("x");
    expect(cursorModeFromRaw("y")).toBe("y");
    expect(cursorModeFromRaw("note")).toBe("note");
    expect(cursorModeFromRaw("bogus")).toBe("off");
    expect(cursorModeFromRaw(undefined)).toBe("off");
  });

  it("measKeysFromRaw keeps valid keys, else the default set", () => {
    expect(measKeysFromRaw(["a", "b"])).toEqual(["a", "b"]);
    expect(measKeysFromRaw(["a", "nope"])).toEqual(["a"]);
    expect(measKeysFromRaw([])).toEqual(measKeysFromRaw(undefined));
    expect(measKeysFromRaw("x").length).toBeGreaterThan(0);
  });

  it("signalsWidthFromRaw clamps to the pixel range and rounds", () => {
    expect(signalsWidthFromRaw(220)).toBe(220);
    expect(signalsWidthFromRaw(10)).toBe(120);
    expect(signalsWidthFromRaw(9999)).toBe(600);
    expect(signalsWidthFromRaw(221.6)).toBe(222);
    expect(signalsWidthFromRaw("x")).toBe(220);
  });

  it("yAxisModeFromRaw accepts the non-default modes, else unified", () => {
    expect(yAxisModeFromRaw("per-unit")).toBe("per-unit");
    expect(yAxisModeFromRaw("individual")).toBe("individual");
    expect(yAxisModeFromRaw("unified")).toBe("unified");
    expect(yAxisModeFromRaw("bogus")).toBe("unified");
  });
});

describe("formatters", () => {
  it("fmtFreq scales to Hz / kHz / MHz", () => {
    expect(fmtFreq(null)).toBe("—");
    expect(fmtFreq(2)).toBe("2.00 Hz");
    expect(fmtFreq(1500)).toBe("1.500 kHz");
    expect(fmtFreq(2_000_000)).toBe("2.000 MHz");
  });

  it("fmtVal renders 6 sig figs, em-dash for non-finite", () => {
    expect(fmtVal(null)).toBe("—");
    expect(fmtVal(Number.NaN)).toBe("—");
    expect(fmtVal(1.23456789)).toBe("1.23457");
  });

  it("fmtCount abbreviates thousands / millions", () => {
    expect(fmtCount(42)).toBe("42");
    expect(fmtCount(1500)).toBe("1.5k");
    expect(fmtCount(2_500_000)).toBe("2.5M");
  });
});

// Type-only guard: SignalRef stays structurally usable here.
const _typed: SignalRef = { ...core, color: "#fff" };
void _typed;
