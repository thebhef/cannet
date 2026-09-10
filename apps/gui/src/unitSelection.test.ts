import { describe, expect, it } from "vitest";

import {
  COMPOSED_ENTRY_ID,
  DERIVED_ENTRY_ID,
  formatScaleFactor,
  pickerEntries,
  rebase,
  sameUnit,
  scaleFor,
  selectedEntryId,
  unitDisplay,
} from "./unitSelection";
import type { UnitPickerEntry } from "./unitLibrary";

const volt: UnitPickerEntry = {
  id: "volt",
  display: "V",
  dimension: "voltage",
  dimensionLabel: "voltage",
  scales: [
    { unit: { base: "volt", prefix: "milli" }, label: "m", display: "mV", exponent: -3 },
    { unit: { base: "volt" }, label: "", display: "V", exponent: 0 },
    { unit: { base: "volt", prefix: "kilo" }, label: "k", display: "kV", exponent: 3 },
  ],
};

const celsius: UnitPickerEntry = {
  id: "degree-celsius",
  display: "°C",
  dimension: "temperature",
  dimensionLabel: "temperature",
  scales: [{ unit: { base: "degree-celsius" }, label: "", display: "°C", exponent: null }],
};

const ampere: UnitPickerEntry = {
  id: "ampere",
  display: "A",
  dimension: "current",
  dimensionLabel: "current",
  scales: [
    { unit: { base: "ampere", prefix: "milli" }, label: "m", display: "mA", exponent: -3 },
    { unit: { base: "ampere" }, label: "", display: "A", exponent: 0 },
  ],
};

const ampereHour: UnitPickerEntry = {
  id: "ampere-hour",
  display: "Ah",
  dimension: "charge",
  dimensionLabel: "charge",
  scales: [
    { unit: { base: "ampere-hour", prefix: "nano" }, label: "n", display: "nAh", exponent: -9 },
    { unit: { base: "ampere-hour" }, label: "", display: "Ah", exponent: 0 },
  ],
};

const model = [volt, ampere, ampereHour, celsius];

describe("sameUnit", () => {
  it("treats an absent prefix and an explicit none as one unit", () => {
    expect(sameUnit({ base: "volt" }, { base: "volt", prefix: "none" })).toBe(true);
    expect(sameUnit({ base: "volt" }, { base: "volt", prefix: "milli" })).toBe(false);
    expect(sameUnit(null, null)).toBe(true);
    expect(sameUnit(null, { base: "volt" })).toBe(false);
  });
});

describe("pickerEntries", () => {
  it("offers everything when no kind is named — reinterpretation may cross kinds", () => {
    expect(pickerEntries(model, null).map((e) => e.id)).toEqual([
      "volt",
      "ampere",
      "ampere-hour",
      "degree-celsius",
    ]);
  });

  it("offers only the locked kind where units are applied", () => {
    expect(pickerEntries(model, "current").map((e) => e.id)).toEqual(["ampere"]);
  });

  /// A composition the table names — `A · h` is the ampere-hour — is
  /// already a row of its dimension, so it is offered once. Picking it
  /// is how the override is cleared; that is the editor's rule, not a
  /// second row here.
  it("adds no row for a composition its dimension already lists", () => {
    const entries = pickerEntries(model, "charge", {
      label: "Ah",
      unit: { base: "ampere-hour" },
    });
    expect(entries.map((e) => e.id)).toEqual(["ampere-hour"]);
  });

  /// `Ah/s` is dimensionally a current but is no named unit, so the
  /// only way back to the derivation is a row of its own — and picking
  /// it commits nothing, which is what "derived" is.
  it("adds a row for a composition nothing names, and it commits nothing", () => {
    const entries = pickerEntries(model, "current", { label: "Ah/s", unit: null });
    expect(entries.map((e) => e.id)).toEqual([COMPOSED_ENTRY_ID, "ampere"]);
    expect(entries[0].display).toBe("Ah/s");
    expect(entries[0].scales).toHaveLength(1);
    expect(entries[0].scales[0].unit).toBe(null);
  });

  /// A set whose members are mixed dimensions derives nothing at all,
  /// so there is no composition to offer — and an override picked
  /// against it would have no row to clear it with. `clearable` is the
  /// caller saying one is in force, and the row that commits nothing
  /// appears for it.
  it("offers a derived row where an override is set and nothing composed one", () => {
    const entries = pickerEntries(model, null, undefined, true);
    expect(entries.map((e) => e.id)).toEqual([
      DERIVED_ENTRY_ID,
      "volt",
      "ampere",
      "ampere-hour",
      "degree-celsius",
    ]);
    expect(entries[0].scales).toHaveLength(1);
    expect(entries[0].scales[0].unit).toBe(null);
  });

  it("offers no derived row while nothing is overridden", () => {
    expect(pickerEntries(model, null).some((e) => e.id === DERIVED_ENTRY_ID)).toBe(false);
    expect(
      pickerEntries(model, null, undefined, false).some((e) => e.id === DERIVED_ENTRY_ID),
    ).toBe(false);
  });

  /// Never two ways to say the same thing: a composition already
  /// carries the row that commits nothing, and a composition the table
  /// names is cleared by picking it.
  it("adds no derived row where a composition already answers for one", () => {
    expect(
      pickerEntries(model, "current", { label: "Ah/s", unit: null }, true).map((e) => e.id),
    ).toEqual([COMPOSED_ENTRY_ID, "ampere"]);
    expect(
      pickerEntries(model, "charge", { label: "Ah", unit: { base: "ampere-hour" } }, true).map(
        (e) => e.id,
      ),
    ).toEqual(["ampere-hour"]);
  });
});

describe("selectedEntryId", () => {
  it("finds the base row a unit sits on, prefix or none", () => {
    const entries = pickerEntries(model, null);
    expect(selectedEntryId(entries, { base: "volt", prefix: "milli" })).toBe("volt");
    expect(selectedEntryId(entries, { base: "degree-celsius" })).toBe("degree-celsius");
    expect(selectedEntryId(entries, { base: "nothing" })).toBe(null);
  });

  it("selects the composition row where nothing is set", () => {
    const entries = pickerEntries(model, "current", { label: "Ah/s", unit: null });
    expect(selectedEntryId(entries, null)).toBe(COMPOSED_ENTRY_ID);
    expect(selectedEntryId(pickerEntries(model, null), null)).toBe(null);
  });
});

describe("rebase", () => {
  it("keeps the current prefix when the new base offers it", () => {
    expect(rebase(ampere, { base: "volt", prefix: "milli" })).toEqual({
      base: "ampere",
      prefix: "milli",
    });
  });

  it("falls back to the base's own unprefixed rung when it does not", () => {
    expect(rebase(celsius, { base: "volt", prefix: "milli" })).toEqual({
      base: "degree-celsius",
    });
  });

  it("takes the unprefixed rung from nothing at all", () => {
    expect(rebase(volt, null)).toEqual({ base: "volt" });
  });
});

describe("scaleFor", () => {
  it("returns the scale row a unit is", () => {
    expect(scaleFor(volt, { base: "volt", prefix: "kilo" })?.display).toBe("kV");
    expect(scaleFor(volt, { base: "ampere" })).toBe(undefined);
  });
});

describe("unitDisplay", () => {
  it("reads back the host's spelling for a typed unit", () => {
    expect(unitDisplay(model, { base: "ampere-hour", prefix: "nano" })).toBe("nAh");
    expect(unitDisplay(model, { base: "volt" })).toBe("V");
  });

  it("spells nothing it was not given a spelling for", () => {
    expect(unitDisplay(model, { base: "furlong" })).toBe(undefined);
    expect(unitDisplay(model, null)).toBe(undefined);
  });
});

describe("formatScaleFactor", () => {
  it("spells the power of ten a prefix row carries", () => {
    expect(formatScaleFactor(0)).toBe("×1");
    expect(formatScaleFactor(-3)).toBe("×10⁻³");
    expect(formatScaleFactor(24)).toBe("×10²⁴");
  });

  it("says nothing for a scale that is not one", () => {
    expect(formatScaleFactor(null)).toBe("");
    expect(formatScaleFactor(undefined)).toBe("");
  });
});
