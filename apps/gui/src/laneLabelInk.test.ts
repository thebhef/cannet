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
import { THEMES, type Theme, type ThemeName } from "./theme";

/** The tints the committed `examples/extrapolation` colormaps use — the
 * exact grounds the owner read "Idle / Standby / Closed / Arming /
 * Derate / Fault" off in the sign-off frames. */
const FIXTURE_TINTS = ["#6b7280", "#f59e0b", "#22c55e", "#3b82f6", "#ef4444"];

/** The fixture tints whose accent reads against a light theme's label
 * box, and the two pale ones that do not (yellow at 2.15:1 and green at
 * 2.28:1 on `light`, 1.87 and 1.98 on `lighthk`). */
const KEEPS_ACCENT_ON_A_BOX = ["#6b7280", "#3b82f6", "#ef4444"];
const FALLS_BACK_ON_A_BOX = ["#f59e0b", "#22c55e"];

/** The composited ground a tinted tile actually paints: the darkened,
 * 0.65-alpha lane fill over the theme's background. */
function tintGround(tint: string, background: string) {
  const fill = parseCssColor(colorMapLaneFill(tint));
  const bg = parseCssColor(background);
  if (!fill || !bg) throw new Error("unparseable fixture color");
  return compositeOver(fill, bg);
}

/** The ground the *label* is read against, which is the tile's only
 * where nothing is drawn between: the theme's label box composited over
 * the tile ground at {@link Theme.laneLabelBoxOpacity}. At 0 (dark) that
 * is the tile ground itself, unchanged. */
function labelGround(tint: string, t: Theme) {
  const box = parseCssColor(t.canvasChipFill);
  if (!box) throw new Error("unparseable chip fill");
  return compositeOver({ ...box, a: box.a * t.laneLabelBoxOpacity }, tintGround(tint, t.background));
}

/** The light theme as it would be with no label box — the shape a theme
 * that keeps the halo treatment has. Its **name is its own**: the memo
 * inside `laneLabelInk` keys on the theme name, so borrowing `light`'s
 * would answer out of the real light theme's cache. */
const LIGHT_NO_BOX: Theme = {
  ...THEMES.light,
  name: "light-no-box" as ThemeName,
  laneLabelBoxOpacity: 0,
};

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

  it("dark: measures against the tile, because its box paints nothing", () => {
    // The box the light themes label on is alpha-0 here, and compositing
    // at alpha 0 returns the ground untouched — so the theme the owner
    // reads fine keeps not just its answers but the numbers behind them.
    const t = THEMES.dark;
    for (const tint of FIXTURE_TINTS) {
      expect(labelGround(tint, t), tint).toEqual(tintGround(tint, t.background));
      expect(laneLabelInk(colorMapLaneFill(tint), tint, t).ink, tint).toBe(tint);
    }
  });

  it("light: keeps the accent the box rescues, and falls back only where it doesn't", () => {
    // The box is what changed the measurement: every one of these tints
    // had collapsed into its own tile fill (1.03-1.35:1), and on a
    // near-white plate the stronger three clear the bar in their own
    // color. Which is the point — the tile's color is the signal's
    // identity.
    for (const name of ["light", "lighthk"] as const) {
      const t = THEMES[name];
      for (const tint of KEEPS_ACCENT_ON_A_BOX) {
        const onTile = contrastRatio(parseCssColor(tint)!, tintGround(tint, t.background));
        const onBox = contrastRatio(parseCssColor(tint)!, labelGround(tint, t));
        expect(onTile, `${name} ${tint} on the tile`).toBeLessThan(LANE_LABEL_MIN_CONTRAST);
        expect(onBox, `${name} ${tint} on the box`).toBeGreaterThanOrEqual(LANE_LABEL_MIN_CONTRAST);
        expect(laneLabelInk(colorMapLaneFill(tint), tint, t).ink, `${name} ${tint}`).toBe(tint);
      }
      for (const tint of FALLS_BACK_ON_A_BOX) {
        const { ink } = laneLabelInk(colorMapLaneFill(tint), tint, t);
        expect(
          contrastRatio(parseCssColor(tint)!, labelGround(tint, t)),
          `${name} ${tint} on the box`,
        ).toBeLessThan(LANE_LABEL_MIN_CONTRAST);
        expect(ink, `${name} ${tint}`).not.toBe(tint);
        expect(
          contrastRatio(parseCssColor(ink)!, labelGround(tint, t)),
          `${name} ${tint} after`,
        ).toBeGreaterThanOrEqual(LANE_LABEL_MIN_CONTRAST);
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
      const inks = FALLS_BACK_ON_A_BOX.map((c) => laneLabelInk(colorMapLaneFill(c), c, t).ink);
      expect(new Set(inks), name).toEqual(new Set(["#000000"]));
    }
  });

  it("takes the other extreme only where the theme's own fails the threshold", () => {
    // A near-black tint in a light theme paints a dark ground, and a
    // black label on it measures 2.85:1 — under the bar. The rule is a
    // preference, not a constant. Measured on a light theme with no box,
    // because that dark ground is exactly what a box covers up.
    const t = LIGHT_NO_BOX;
    const ground = tintGround("#000000", t.background);
    expect(contrastRatio(parseCssColor("#000000")!, ground)).toBeLessThan(LANE_LABEL_MIN_CONTRAST);
    expect(laneLabelInk(colorMapLaneFill("#000000"), "#000000", t).ink).toBe("#ffffff");
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
    // glyph is no halo at all. On a theme with no label box, which is
    // where a halo is what carries the label at all.
    const { ink, halo } = laneLabelInk(colorMapLaneFill("#000000"), "#000000", LIGHT_NO_BOX);
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
        const ground = labelGround(tint, t);
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
