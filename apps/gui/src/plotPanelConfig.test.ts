import { beforeEach, describe, expect, it, vi } from "vitest";

// A new plot area takes its y-axis mode from `plot_y_axis_mode`, so
// these tests need a host to hydrate that setting from.
let storedSettings: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...storedSettings } : null)),
}));

const { signalWheel } = await import("./palette");
const TRACE_COLORS = signalWheel();

const {
  areasFromParams,
  cursorModeFromRaw,
  fmtCount,
  fmtFreq,
  fmtVal,
  isSignalRefCore,
  signalValueFormats,
  measKeysFromRaw,
  newPlotArea,
  signalRefKey,
  reorderAreas,
  signalsWidthFromRaw,
  withColor,
  yAxisModeFromRaw,
} = await import("./plotPanelConfig");
type SignalRef = import("./plotPanelConfig").SignalRef;
const { signalKey } = await import("./plotData");
const { hydrateSettings } = await import("./hostSettings");

beforeEach(async () => {
  storedSettings = {};
  await hydrateSettings();
});

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
  it("preserves a string color", () => {
    expect(withColor({ ...core, color: "#abcdef" }, 0).color).toBe("#abcdef");
  });
  it("seeds a wheel color by fallback index (wrapping) when absent", () => {
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

  it("filters malformed signals and colors the survivors", () => {
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

  it("still discards a v7-and-earlier `yMode`, and does not migrate it", () => {
    // The old per-*area* fixed range. The per-axis manual range that
    // replaced it is keyed by derived-axis ids that did not exist when
    // a `yMode` was written, so an old area's range has no axis to
    // migrate onto — it is dropped, as it has been since ADR 0026.
    const areas = areasFromParams([{ id: "a", signals: [], yMode: { min: 0, max: 100 } }]);
    expect(areas[0]).not.toHaveProperty("yMode");
    expect(Object.keys(areas[0]).sort()).toEqual(["id", "patterns", "primarySignalKey", "signals", "yAxisMode"]);
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

describe("the default y-axis mode", () => {
  it("seeds a new area from the setting, not from a literal", async () => {
    // `unified` is the built-in default, so a configured `per-unit`
    // proves the mode came from `settings.json`.
    storedSettings = { plot_y_axis_mode: "per-unit" };
    await hydrateSettings();
    expect(newPlotArea().yAxisMode).toBe("per-unit");
    // Same for the area a panel with no saved layout opens with.
    expect(areasFromParams(undefined)[0].yAxisMode).toBe("per-unit");
  });

  it("leaves an area that already has a mode alone", async () => {
    storedSettings = { plot_y_axis_mode: "individual" };
    await hydrateSettings();
    const areas = areasFromParams([{ id: "a", signals: [], yAxisMode: "per-unit" }]);
    expect(areas[0].yAxisMode).toBe("per-unit");
  });

  it("does not retro-fit an area saved before the field existed", async () => {
    // A saved area with no `yAxisMode` was drawn unified, and changing
    // the *creation* default must not silently re-lay-it-out. Only a
    // brand-new area reads the setting.
    storedSettings = { plot_y_axis_mode: "individual" };
    await hydrateSettings();
    const areas = areasFromParams([{ id: "a", signals: [] }]);
    expect(areas[0].yAxisMode).toBe("unified");
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
    // No signal facts: the float rule, which trims what `toPrecision`
    // used to pad ("0.500000").
    expect(fmtVal(0.5)).toBe("0.5");
  });

  it("fmtVal renders a fixed-precision signal at the decimals its factor implies", () => {
    const quarter = { decimals: 2, hex: false };
    expect(fmtVal(12.25, quarter)).toBe("12.25");
    expect(fmtVal(12, quarter)).toBe("12.00");
    expect(fmtVal(-0.5, quarter)).toBe("-0.50");
    // An integral factor (and a factor of 1 with an offset or a unit)
    // is fixed at zero decimals — an integer, rendered in base 10.
    expect(fmtVal(-42, { decimals: 0, hex: false })).toBe("-42");
  });

  it("renders a float through the shared magnitude rule", () => {
    // The rule itself is pinned in `floatFormat.test.ts`; what this
    // pins is that a signal with no declared precision goes *through*
    // it, at the readouts' six figures. A full six-figure mantissa
    // under 1.0 reads plainly — the case the old
    // more-than-five-decimals rule sent exponential.
    const float = { decimals: null, hex: false };
    expect(fmtVal(0.123456, float)).toBe("0.123456");
    expect(fmtVal(0.0001, float)).toBe("0.0001");
    expect(fmtVal(0.00001, float)).toBe("1.00000e-5");
    expect(fmtVal(-0.0000123, float)).toBe("-1.23000e-5");
    expect(fmtVal(1.23456789, float)).toBe("1.23457");
    expect(fmtVal(0, float)).toBe("0");
  });

  it("fmtVal follows a settings change without a reload", async () => {
    // The float case reads the rule live, so a settings change reaches
    // the readouts on the next render.
    storedSettings = { float_exponential_from: 1e3, float_mantissa_decimals: 2 };
    await hydrateSettings();
    expect(fmtVal(1234, { decimals: null, hex: false })).toBe("1.23e+3");
    // A signal with a declared precision is unaffected: the rule is the
    // fallback for a float, not an override of the DBC.
    expect(fmtVal(1234, { decimals: 1, hex: false })).toBe("1234.0");
  });

  it("fmtVal renders a raw bit field in base 10 unless its DBC asks for hex", () => {
    expect(fmtVal(3735928559, { decimals: 0, hex: false })).toBe("3735928559");
    expect(fmtVal(3735928559, { decimals: 0, hex: true })).toBe("0xDEADBEEF");
  });

  it("signalValueFormats keys the catalog's rendering facts by signal", () => {
    const formats = signalValueFormats([
      { bus_id: "a", message_id: 256, extended: false, message_name: "M", transmitter: null, signal_name: "Speed", unit: "rpm", decimals: 2 },
      { bus_id: "a", message_id: 256, extended: false, message_name: "M", transmitter: null, signal_name: "Serial", unit: "", decimals: 0, display_hex: true },
      { bus_id: "a", message_id: 256, extended: false, message_name: "M", transmitter: null, signal_name: "Lat", unit: "deg" },
    ]);
    expect(formats.get(signalKey("a", 256, false, "Speed"))).toEqual({ decimals: 2, hex: false });
    expect(formats.get(signalKey("a", 256, false, "Serial"))).toEqual({ decimals: 0, hex: true });
    // An absent `decimals` is the float rule, not zero decimals.
    expect(formats.get(signalKey("a", 256, false, "Lat"))).toEqual({ decimals: null, hex: false });
  });

  it("fmtCount abbreviates thousands / millions", () => {
    expect(fmtCount(42)).toBe("42");
    expect(fmtCount(1500)).toBe("1.5k");
    expect(fmtCount(2_500_000)).toBe("2.5M");
  });
});

describe("reorderAreas", () => {
  const ids = (as: { id: string }[]) => as.map((a) => a.id);
  const list = () => areasFromParams([{ id: "a" }, { id: "b" }, { id: "c" }]);

  it("drops a dragged area at the target's own position when dragging down", () => {
    // a onto c: a comes out, then goes back in where c was — i.e. after
    // c, which is where the pointer let go.
    expect(ids(reorderAreas(list(), "a", "c"))).toEqual(["b", "c", "a"]);
  });

  it("drops a dragged area before the target when dragging up", () => {
    expect(ids(reorderAreas(list(), "c", "a"))).toEqual(["c", "a", "b"]);
    expect(ids(reorderAreas(list(), "b", "a"))).toEqual(["b", "a", "c"]);
  });

  it("returns the same list (same reference) for a no-op reorder", () => {
    const before = list();
    expect(reorderAreas(before, "b", "b")).toBe(before);
    expect(reorderAreas(before, "zzz", "a")).toBe(before);
    expect(reorderAreas(before, "a", "zzz")).toBe(before);
  });

  it("carries each area's own config with it", () => {
    const areas = areasFromParams([
      { id: "a", signals: [{ ...core }] },
      { id: "b", patterns: ["rpm$"] },
    ]);
    const moved = reorderAreas(areas, "b", "a");
    expect(moved[0].id).toBe("b");
    expect(moved[0].patterns).toEqual(["rpm$"]);
    expect(moved[1].signals[0].signalName).toBe("Speed");
  });
});

// Type-only guard: SignalRef stays structurally usable here.
const _typed: SignalRef = { ...core, color: "#fff" };
void _typed;
