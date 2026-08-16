import { describe, expect, it } from "vitest";

import {
  LANE_LABEL_MIN_CONTRAST,
  compositeOver,
  contrastRatio,
  laneLabelInk,
  parseCssColor,
  relativeLuminance,
} from "./laneLabelInk";
import { colorMapLaneFill } from "./colorMap";
import { THEMES } from "./theme";

/** The tints the committed `examples/extrapolation` colormaps use — the
 * exact grounds the owner read "Idle / Standby / Closed / Arming /
 * Derate / Fault" off in the sign-off frames. */
const FIXTURE_TINTS = ["#6b7280", "#f59e0b", "#22c55e", "#3b82f6", "#ef4444"];

/** The composited ground a tinted tile actually paints: the darkened,
 * 0.65-alpha lane fill over the theme's background. */
function tintGround(tint: string, background: string) {
  const fill = parseCssColor(colorMapLaneFill(tint));
  const bg = parseCssColor(background);
  if (!fill || !bg) throw new Error("unparseable fixture color");
  return compositeOver(fill, bg);
}

describe("parseCssColor", () => {
  it("reads the two spellings the tile fill is written in", () => {
    // `theme.ts` writes hex; `colorMapLaneFill` and `laneFillDefault`
    // write `rgba()`. Both reach this module as the tile's fill.
    expect(parseCssColor("#abcdef")).toEqual({ r: 171, g: 205, b: 239, a: 1 });
    expect(parseCssColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseCssColor("rgba(226, 232, 240, 0.75)")).toEqual({
      r: 226,
      g: 232,
      b: 240,
      a: 0.75,
    });
    expect(parseCssColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  });

  it("returns null for a color it cannot resolve without a document", () => {
    // A named color reaches here whenever a colormap rule carries one:
    // `colorMapLaneFill` passes non-hex through unchanged.
    expect(parseCssColor("rebeccapurple")).toBeNull();
    expect(parseCssColor("")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("agrees with WCAG's two anchors", () => {
    const black = parseCssColor("#000")!;
    const white = parseCssColor("#fff")!;
    expect(contrastRatio(black, white)).toBeCloseTo(21, 6);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 6);
  });

  it("is symmetric", () => {
    const a = parseCssColor("#3b82f6")!;
    const b = parseCssColor("#f4f5f7")!;
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 12);
  });

  it("uses the sRGB linearisation, not the raw channel values", () => {
    // Mid-grey is far darker than half of white in luminance terms; a
    // naive average would put it at 0.5.
    expect(relativeLuminance(parseCssColor("#808080")!)).toBeCloseTo(0.2159, 3);
  });
});

describe("compositeOver", () => {
  it("mixes by alpha, which is what the canvas painted", () => {
    const fill = parseCssColor("rgba(0, 0, 0, 0.5)")!;
    const bg = parseCssColor("#ffffff")!;
    expect(compositeOver(fill, bg)).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
  });

  it("leaves an opaque fill alone", () => {
    const fill = parseCssColor("#123456")!;
    expect(compositeOver(fill, parseCssColor("#ffffff")!)).toEqual({ r: 18, g: 52, b: 86 });
  });
});

describe("laneLabelInk", () => {
  // The defect: the ink was *always* the accent, and the fill is a tint
  // of that same accent. On a dark theme the accent is light and the
  // tint is dark, so the two separate; on a light theme the accent is
  // darkened and the tint is a mid-tone of itself, so they collapse.
  it("dark: keeps the accent on every fixture tint", () => {
    const t = THEMES.dark;
    for (const tint of FIXTURE_TINTS) {
      const fill = colorMapLaneFill(tint);
      expect(laneLabelInk(fill, tint, t).ink, tint).toBe(tint);
      // …and it keeps it because it earns it, not by default.
      expect(
        contrastRatio(parseCssColor(tint)!, tintGround(tint, t.background)),
        tint,
      ).toBeGreaterThanOrEqual(LANE_LABEL_MIN_CONTRAST);
    }
  });

  it("dark: keeps the accent on the default (untinted) lane fill", () => {
    const t = THEMES.dark;
    for (const accent of t.signalWheel) {
      expect(laneLabelInk(t.laneFillDefault, accent, t).ink).toBe(accent);
    }
  });

  it("light: keeps the accent on the default lane fill", () => {
    // Only the *tinted* tile collapsed. A light lane with no colormap
    // fills near-white, which the wheel was tuned against.
    for (const name of ["light", "lighthk"] as const) {
      const t = THEMES[name];
      for (const accent of t.signalWheel) {
        expect(laneLabelInk(t.laneFillDefault, accent, t).ink, `${name} ${accent}`).toBe(accent);
      }
    }
  });

  it("light: replaces an accent that has collapsed into its own tint", () => {
    for (const name of ["light", "lighthk"] as const) {
      const t = THEMES[name];
      for (const tint of FIXTURE_TINTS) {
        const ground = tintGround(tint, t.background);
        const before = contrastRatio(parseCssColor(tint)!, ground);
        const { ink } = laneLabelInk(colorMapLaneFill(tint), tint, t);
        const after = contrastRatio(parseCssColor(ink)!, ground);
        expect(before, `${name} ${tint} before`).toBeLessThan(LANE_LABEL_MIN_CONTRAST);
        expect(ink, `${name} ${tint}`).not.toBe(tint);
        expect(after, `${name} ${tint} after`).toBeGreaterThanOrEqual(LANE_LABEL_MIN_CONTRAST);
      }
    }
  });

  it("replaces with one ink per theme, not one per tile", () => {
    // Not "whichever extreme measures highest": on these grounds the two
    // land within 5 % of each other and the winner alternates by tint,
    // which would put one theme's lanes in two different inks on a
    // margin that means nothing. The theme's own polarity decides.
    for (const name of ["light", "lighthk"] as const) {
      const t = THEMES[name];
      const inks = FIXTURE_TINTS.map((c) => laneLabelInk(colorMapLaneFill(c), c, t).ink);
      expect(new Set(inks), name).toEqual(new Set(["#000000"]));
    }
  });

  it("takes the other extreme only where the theme's own fails the threshold", () => {
    // A near-black tint in a light theme paints a dark ground, and a
    // black label on it measures 2.95:1 — under the bar. The rule is a
    // preference, not a constant.
    const light = THEMES.light;
    const ground = tintGround("#000000", light.background);
    expect(contrastRatio(parseCssColor("#000000")!, ground)).toBeLessThan(
      LANE_LABEL_MIN_CONTRAST,
    );
    expect(laneLabelInk(colorMapLaneFill("#000000"), "#000000", light).ink).toBe("#ffffff");
  });

  it("halos with the app background whenever the background reads against the ink", () => {
    // The halo's job is to survive the stripes, which are painted in the
    // background color — so the background is the halo wherever it can
    // be, and the dark theme's appearance is exactly what it was.
    const dark = THEMES.dark;
    for (const tint of FIXTURE_TINTS) {
      expect(laneLabelInk(colorMapLaneFill(tint), tint, dark).halo).toBe(dark.background);
    }
    const light = THEMES.light;
    for (const tint of FIXTURE_TINTS) {
      expect(laneLabelInk(colorMapLaneFill(tint), tint, light).halo).toBe(light.background);
    }
  });

  it("flips the halo when the ink and the background are the same side", () => {
    // The case the previous rule could not cover: a near-black tint in a
    // light theme takes a white ink, and a near-white halo around a white
    // glyph is no halo at all.
    const light = THEMES.light;
    const { ink, halo } = laneLabelInk(colorMapLaneFill("#000000"), "#000000", light);
    expect(ink).toBe("#ffffff");
    expect(halo).toBe("#000000");
    expect(
      contrastRatio(parseCssColor(ink)!, parseCssColor(halo)!),
    ).toBeGreaterThanOrEqual(LANE_LABEL_MIN_CONTRAST);
  });

  it("every theme's answer holds the threshold against the ground it was measured on", () => {
    for (const t of Object.values(THEMES)) {
      for (const tint of FIXTURE_TINTS) {
        const { ink, halo } = laneLabelInk(colorMapLaneFill(tint), tint, t);
        const ground = tintGround(tint, t.background);
        expect(
          contrastRatio(parseCssColor(ink)!, ground),
          `${t.name} ${tint} ink vs ground`,
        ).toBeGreaterThanOrEqual(LANE_LABEL_MIN_CONTRAST);
        expect(
          contrastRatio(parseCssColor(ink)!, parseCssColor(halo)!),
          `${t.name} ${tint} ink vs halo`,
        ).toBeGreaterThanOrEqual(LANE_LABEL_MIN_CONTRAST);
      }
    }
  });

  it("keeps the accent when it cannot measure the fill", () => {
    // A colormap rule may carry any CSS color; `colorMapLaneFill` passes
    // a name straight through. Guessing is worse than leaving the tile
    // exactly as it renders today.
    const t = THEMES.light;
    expect(laneLabelInk("rebeccapurple", "#3b82f6", t)).toEqual({
      ink: "#3b82f6",
      halo: t.background,
    });
    expect(laneLabelInk(colorMapLaneFill("#3b82f6"), "rebeccapurple", t)).toEqual({
      ink: "rebeccapurple",
      halo: t.background,
    });
  });

  it("answers the same thing twice (the memo does not change the answer)", () => {
    const t = THEMES.light;
    const fill = colorMapLaneFill("#22c55e");
    expect(laneLabelInk(fill, "#22c55e", t)).toEqual(laneLabelInk(fill, "#22c55e", t));
    // Keyed on the theme too — the same fill and accent answer
    // differently under a different background.
    expect(laneLabelInk(fill, "#22c55e", THEMES.dark).ink).not.toBe(
      laneLabelInk(fill, "#22c55e", t).ink,
    );
  });
});
