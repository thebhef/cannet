import { describe, expect, it } from "vitest";

import { signalWheel, stableSignalColor, wheelColor } from "./palette";
import { THEMES } from "./theme";

const SIGNAL_WHEEL = signalWheel();

/// WCAG 2.x relative luminance of an sRGB hex color.
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/// WCAG contrast ratio between two colors.
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/// The color's hue in degrees, or `null` when it has none (a grey).
function hue(hex: string): number | null {
  const [r, g, b] = [0, 1, 2].map((i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return null;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/// Distance between two hues on the color circle, in degrees.
function hueDistance(a: string, b: string): number {
  const [ha, hb] = [hue(a), hue(b)];
  if (ha == null || hb == null) return 0;
  const d = Math.abs(ha - hb) % 360;
  return d > 180 ? 360 - d : d;
}

// Thresholds match usage: a signal color renders text (WCAG AA, 4.5:1);
// a bus color is a stroke or a chip (WCAG 1.4.11 non-text, 3:1). Each
// theme is read against its own background — a wheel is only legible on
// the surface it was tuned for.
describe.each(Object.values(THEMES))("$name wheels", (t) => {
  it("signal wheel: every slot holds AA contrast against the background", () => {
    for (const c of t.signalWheel) {
      expect(contrast(c, t.background), `${c} vs ${t.background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("bus wheel: every slot holds non-text contrast against the background", () => {
    for (const c of t.busWheel) {
      expect(contrast(c, t.background), `${c} vs ${t.background}`).toBeGreaterThanOrEqual(3);
    }
  });
});

// Slot-matched wheels: the light variants keep the dark wheels' hues
// slot for slot, retuned only in saturation and lightness. That is what
// lets a hash or a list position mean the same thing in both — a signal
// keeps its hue identity across a theme change rather than becoming a
// different-colored signal. Without this the two wheels could both pass
// their contrast tests while being unrelated palettes.
describe("wheels are slot-matched across themes", () => {
  const themes = Object.values(THEMES);
  const reference = THEMES.dark;

  it.each(themes.filter((t) => t !== reference))("$name keeps dark's hue per slot", (t) => {
    for (const key of ["signalWheel", "busWheel"] as const) {
      expect(t[key].length, `${t.name} ${key} length`).toBe(reference[key].length);
      t[key].forEach((c, i) => {
        const ref = reference[key][i];
        expect(
          hueDistance(c, ref),
          `${t.name} ${key}[${i}] ${c} vs dark ${ref}`,
        ).toBeLessThanOrEqual(8);
      });
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

  it("pins the hash: known keys keep their color across releases", () => {
    // Changing the hash silently recolors every non-overridden signal
    // in existing projects — if this fails, that's what just happened.
    expect(stableSignalColor("p|s:256:EngineSpeed")).toBe(SIGNAL_WHEEL[10]);
    expect(stableSignalColor("*|x:512:ModeA")).toBe(SIGNAL_WHEEL[11]);
  });
});
