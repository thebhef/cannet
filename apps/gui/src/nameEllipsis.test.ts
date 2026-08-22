import { describe, expect, it } from "vitest";

import { DBC_IDENTIFIER_LIMIT, splitName } from "./nameEllipsis";

describe("splitName", () => {
  it("leaves a name within the DBC identifier limit whole", () => {
    // The control: a short name must come back as one string, so a
    // caller renders exactly the text node it renders today.
    for (const n of ["PackVoltage", "A", "x".repeat(DBC_IDENTIFIER_LIMIT)]) {
      expect(splitName(n)).toEqual({ head: n, tail: "" });
    }
  });

  it("splits one character past the limit", () => {
    const n = "x".repeat(DBC_IDENTIFIER_LIMIT + 1);
    const { head, tail } = splitName(n);
    expect(tail).not.toBe("");
    expect(head + tail).toBe(n);
  });

  it("keeps the whole name across the two parts", () => {
    for (const n of [
      "HighVoltageBatteryPackCoolantInletTemperature",
      "BatteryPackThermalDerateRequestingSubsystem",
      "BMS_Pack_Current_Filtered_HighResolution",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]) {
      const { head, tail } = splitName(n);
      expect(head + tail).toBe(n);
    }
  });

  it("cuts on a word boundary so the tail reads as a word", () => {
    expect(splitName("HighVoltageBatteryPackCoolantInletTemperature").tail).toBe("Temperature");
    expect(splitName("BMS_Pack_Current_Filtered_HighResolution").tail).toBe("Resolution");
    expect(splitName("PackCurrentFilteredMeasured_HighRes").tail).toBe("_HighRes");
    // Searched outward, so a boundary just *past* the preferred cut
    // wins over one far short of it.
    expect(splitName("CentralComputeThermalDerateAdvisoryBroadcast").tail).toBe("Broadcast");
    expect(splitName("PropulsionInverterThermalDerateRequestLevel").tail).toBe("RequestLevel");
  });

  it("keeps the part that tells two same-prefixed names apart", () => {
    // The failure end-truncation produces, stated as a test: these two
    // differ only in their last six characters.
    const a = splitName("BmsPackCurrentFilteredMeasuredHighRes");
    const b = splitName("BmsPackCurrentFilteredMeasuredLowRes");
    expect(a.tail).not.toBe(b.tail);
  });

  it("falls back to a character count when there is no boundary", () => {
    const n = "a".repeat(50);
    expect(splitName(n)).toEqual({ head: "a".repeat(40), tail: "a".repeat(10) });
  });
});

describe("splitName on an absurd name", () => {
  it("caps the head at what no column could show, keeping the tail", () => {
    // Nothing refuses a length — the tail is still the tail and the
    // caller still has the whole name for the tooltip. The cap is only
    // about how much text the engine is asked to shape behind an
    // `overflow: hidden` edge.
    const name = "Bms" + "Segment".repeat(2000);
    const { head, tail } = splitName(name);
    expect(head.length).toBe(200);
    expect(name.startsWith(head)).toBe(true);
    expect(name.endsWith(tail)).toBe(true);
    // The control: a realistic long name is not capped, so its two
    // halves still reconstruct it exactly.
    const real = splitName("HighVoltageBatteryPackCoolantInletTemperature");
    expect(real.head + real.tail).toBe("HighVoltageBatteryPackCoolantInletTemperature");
  });
});
