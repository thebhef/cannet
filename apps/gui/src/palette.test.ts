import { describe, expect, it } from "vitest";

import { SIGNAL_WHEEL, stableSignalColor, wheelColor } from "./palette";

/// The app background from index.css — the surface every wheel colour
/// must read against.
const APP_BACKGROUND = "#0e1116";

/// WCAG 2.x relative luminance of an sRGB hex colour.
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/// WCAG contrast ratio between two colours.
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("SIGNAL_WHEEL", () => {
  it("is 16 distinct colours", () => {
    expect(SIGNAL_WHEEL.length).toBe(16);
    expect(new Set(SIGNAL_WHEEL).size).toBe(16);
    for (const c of SIGNAL_WHEEL) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("every colour holds AA contrast against the app background", () => {
    for (const c of SIGNAL_WHEEL) {
      expect(contrast(c, APP_BACKGROUND), `${c} vs ${APP_BACKGROUND}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("wheelColor", () => {
  it("wraps around the wheel, negative-safe", () => {
    expect(wheelColor(0)).toBe(SIGNAL_WHEEL[0]);
    expect(wheelColor(16)).toBe(SIGNAL_WHEEL[0]);
    expect(wheelColor(17)).toBe(SIGNAL_WHEEL[1]);
    expect(wheelColor(-1)).toBe(SIGNAL_WHEEL[15]);
  });
});

describe("stableSignalColor", () => {
  it("is deterministic per key and spreads across the wheel", () => {
    const keys = Array.from({ length: 64 }, (_, i) => `bus|s:${256 + i}:Sig${i}`);
    for (const k of keys) expect(stableSignalColor(k)).toBe(stableSignalColor(k));
    const used = new Set(keys.map(stableSignalColor));
    // 64 hashed keys over 16 slots: expect broad coverage, not one hue.
    expect(used.size).toBeGreaterThan(8);
  });

  it("pins the hash: known keys keep their colour across releases", () => {
    // Changing the hash silently recolours every non-overridden signal
    // in existing projects — if this fails, that's what just happened.
    expect(stableSignalColor("p|s:256:EngineSpeed")).toBe(SIGNAL_WHEEL[10]);
    expect(stableSignalColor("*|x:512:ModeA")).toBe(SIGNAL_WHEEL[11]);
  });
});
