import { describe, expect, it } from "vitest";

import {
  FD_DATA_BITRATE_PRESETS_BPS,
  NOMINAL_BITRATE_PRESETS_BPS,
  formatBitrate,
  parseBitrateInput,
  withDefaultBitrate,
} from "./busHardwareConfig";
import type { Bus } from "./types";

describe("formatBitrate", () => {
  it("renders megabit-aligned values with the M suffix", () => {
    expect(formatBitrate(1_000_000)).toBe("1M");
    expect(formatBitrate(2_000_000)).toBe("2M");
  });

  it("renders kilobit-aligned values with the k suffix", () => {
    expect(formatBitrate(125_000)).toBe("125k");
    expect(formatBitrate(500_000)).toBe("500k");
  });

  it("falls back to a raw integer for values that don't divide cleanly", () => {
    expect(formatBitrate(83_333)).toBe("83333");
  });
});

describe("parseBitrateInput", () => {
  it("accepts raw decimal integers", () => {
    expect(parseBitrateInput("500000")).toBe(500_000);
  });

  it("accepts k / K shorthand", () => {
    expect(parseBitrateInput("500k")).toBe(500_000);
    expect(parseBitrateInput("125K")).toBe(125_000);
  });

  it("accepts m / M shorthand including decimals", () => {
    expect(parseBitrateInput("1M")).toBe(1_000_000);
    expect(parseBitrateInput("1.5m")).toBe(1_500_000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseBitrateInput("  500k  ")).toBe(500_000);
  });

  it("returns null on empty / malformed / non-positive input", () => {
    expect(parseBitrateInput("")).toBeNull();
    expect(parseBitrateInput("abc")).toBeNull();
    expect(parseBitrateInput("0")).toBeNull();
    expect(parseBitrateInput("-500k")).toBeNull();
  });

  it("round-trips every formatted preset", () => {
    for (const bps of [
      ...NOMINAL_BITRATE_PRESETS_BPS,
      ...FD_DATA_BITRATE_PRESETS_BPS,
    ]) {
      expect(parseBitrateInput(formatBitrate(bps))).toBe(bps);
    }
  });
});

describe("withDefaultBitrate", () => {
  const BUS: Bus = { id: "b1", name: "Bus 1" };

  it("leaves a new bus unset when no default is configured", () => {
    // What Add bus produced before the setting existed: no bitrate key
    // at all, so the wire's `0 = unset` stands and the adapter's own
    // default applies. `null` is the field's default, so an untouched
    // install adds exactly the bus it always did.
    expect(withDefaultBitrate(BUS, null)).toEqual(BUS);
    expect("speed_bps" in withDefaultBitrate(BUS, null)).toBe(false);
  });

  it("seeds a new bus with the configured default", () => {
    expect(withDefaultBitrate(BUS, 250_000).speed_bps).toBe(250_000);
  });

  it("never overrides a bitrate the bus already names", () => {
    // The setting seeds a *new* bus. A bus that arrives with a rate —
    // from a project, or a caller that worked one out — keeps it, which
    // is the same rule every other `default`-tagged setting follows.
    const configured: Bus = { ...BUS, speed_bps: 125_000 };
    expect(withDefaultBitrate(configured, 250_000).speed_bps).toBe(125_000);
  });
});
