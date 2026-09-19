import { describe, expect, it } from "vitest";

import {
  convertExtent,
  convertSeries,
  displayAffineOf,
  displayUnitOf,
  displayUnitsKey,
  seriesUnitSources,
  type SeriesDisplayUnit,
} from "./plotDisplayUnits";
import { signalRefKey, type SignalRef } from "./plotPanelConfig";
import type { MathSignalRecord, SignalDescriptorRecord } from "./types";

function s(name: string, unit: string, displayUnit?: SignalRef["displayUnit"]): SignalRef {
  return {
    busId: "b1",
    messageId: 100,
    extended: false,
    signalName: name,
    messageName: "Msg",
    unit,
    ...(displayUnit ? { displayUnit } : {}),
  };
}

const volts: SeriesDisplayUnit = {
  source: { base: "volt", prefix: "milli" },
  kind: "voltage",
  display: "V",
  affine: { gain: 0.001, offset: 0 },
};

describe("displayUnitsKey", () => {
  it("moves when a declared unit or a display choice does, and not otherwise", () => {
    const a = [s("Cell", "mV")];
    expect(displayUnitsKey(a)).toBe(displayUnitsKey([s("Cell", "mV")]));
    expect(displayUnitsKey(a)).not.toBe(displayUnitsKey([s("Cell", "V")]));
    expect(displayUnitsKey(a)).not.toBe(
      displayUnitsKey([s("Cell", "mV", { base: "volt" })]),
    );
    // A recolor is not a unit change.
    expect(displayUnitsKey(a)).toBe(
      displayUnitsKey([{ ...s("Cell", "mV"), colorPick: "#fff" }]),
    );
  });

  /// Reinterpreting a signal moves what the host answers without
  /// touching the spelling a saved layout stored, so the placed unit
  /// has to be part of the key or the panel would keep the old answer.
  it("moves when the placed unit does, with the spelling unchanged", () => {
    const a = [s("Cell", "C")];
    const asCharge = () => ({ base: "coulomb" });
    const asCelsius = () => ({ base: "degree-celsius" });
    expect(displayUnitsKey(a, asCharge)).not.toBe(displayUnitsKey(a));
    expect(displayUnitsKey(a, asCharge)).not.toBe(displayUnitsKey(a, asCelsius));
    expect(displayUnitsKey(a, asCharge)).toBe(displayUnitsKey([s("Cell", "C")], asCharge));
  });
});

describe("seriesUnitSources", () => {
  const descriptor = (name: string, unit_typed?: SignalDescriptorRecord["unit_typed"]) =>
    ({
      bus_id: "b1",
      message_id: 100,
      extended: false,
      message_name: "Msg",
      transmitter: null,
      signal_name: name,
      unit: "C",
      ...(unit_typed ? { unit_typed } : {}),
    }) as SignalDescriptorRecord;

  /// The host places the unit; this only carries it. `C` is the case
  /// that matters — the host refuses to read that spelling back, so a
  /// series read as a coulomb is only convertible if the identity
  /// travels with it.
  it("answers with the catalog's typed unit, whatever the spelling reads as", () => {
    const sourceOf = seriesUnitSources([descriptor("Cell", { base: "coulomb" })], []);
    expect(sourceOf(s("Cell", "C"))).toEqual({ base: "coulomb" });
  });

  it("places nothing for a signal neither list holds, and for one the host could not place", () => {
    expect(seriesUnitSources([descriptor("Cell")], [])(s("Cell", "C"))).toBeNull();
    expect(seriesUnitSources([], [])(s("Gone", "V"))).toBeNull();
  });

  it("answers a math series from its resolved unit, keyed by the host's identity", () => {
    const math = {
      id: "m1",
      identity: "*|m:0:m1",
      unitTyped: { base: "coulomb" },
    } as MathSignalRecord;
    const ref: SignalRef = {
      busId: null,
      messageId: 0,
      extended: false,
      signalName: "m1",
      messageName: "Computed",
      unit: "C",
      math: true,
    };
    expect(seriesUnitSources([], [math])(ref)).toEqual({ base: "coulomb" });
  });
});

describe("displayUnitOf", () => {
  const cell = s("Cell", "mV");
  const units = new Map([[signalRefKey(cell), volts]]);

  it("reads a converted series in the unit it was converted to", () => {
    expect(displayUnitOf(units, cell)).toBe("V");
  });

  it("reads an unanswered series as its database declared it", () => {
    expect(displayUnitOf(new Map(), cell)).toBe("mV");
  });
});

describe("displayAffineOf", () => {
  const cell = s("Cell", "mV");
  const key = signalRefKey(cell);

  it("hands back nothing for a series that converts by nothing", () => {
    expect(displayAffineOf(new Map(), key)).toBe(null);
    expect(
      displayAffineOf(new Map([[key, { ...volts, affine: { gain: 1, offset: 0 } }]]), key),
    ).toBe(null);
  });

  it("hands back the affine otherwise", () => {
    expect(displayAffineOf(new Map([[key, volts]]), key)).toEqual({ gain: 0.001, offset: 0 });
  });
});

describe("convertSeries", () => {
  const series = { t: [0, 1], v: [3712, 3800] };

  it("carries the values and leaves the time base alone", () => {
    const out = convertSeries(series, { gain: 0.001, offset: 0 });
    expect(out.v[0]).toBeCloseTo(3.712, 9);
    expect(out.v[1]).toBeCloseTo(3.8, 9);
    expect(out.t).toBe(series.t);
  });

  /// The common case must allocate nothing: every series in a panel
  /// nobody has converted goes through here on every fetch.
  it("hands back the very same object when nothing converts", () => {
    expect(convertSeries(series, null)).toBe(series);
  });

  it("keeps the extrapolation classification, which is about time", () => {
    const classified = { ...series, extrapolated: [[0, 1]] as const };
    expect(convertSeries(classified, { gain: 2, offset: 0 }).extrapolated).toBe(
      classified.extrapolated,
    );
  });
});

describe("convertExtent", () => {
  it("carries an axis's bounds through the same affine", () => {
    const out = convertExtent({ lo: 0, hi: 3800 }, { gain: 0.001, offset: 0 });
    expect(out.lo).toBe(0);
    expect(out.hi).toBeCloseTo(3.8, 9);
  });

  /// An extent is a pair of *bounds*: a negative gain swaps which is
  /// which, and an axis scaled to a reversed pair draws nothing.
  it("re-orders the ends under a negative gain", () => {
    expect(convertExtent({ lo: 0, hi: 100 }, { gain: -1, offset: 0 })).toEqual({
      lo: -100,
      hi: 0,
    });
  });

  it("hands back the very same object when nothing converts", () => {
    const extent = { lo: 1, hi: 2 };
    expect(convertExtent(extent, null)).toBe(extent);
  });
});
