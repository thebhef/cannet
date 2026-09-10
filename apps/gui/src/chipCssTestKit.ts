/// Reading the app's own stylesheet from a jsdom test.
///
/// The chip language's central invariant is a *geometric* one — state
/// tints the hairline and nothing moves — and jsdom does no layout, so
/// there is no rendered box to measure. What there is instead is the
/// sheet itself: put `index.css` in the document, ask the DOM which of
/// its rules the element actually matches, and compare the geometry
/// declarations among them. A state rule that grew a padding, a border
/// weight or a height shows up as a difference.
///
/// This is a test helper rather than a per-file copy because the second
/// component to need it (the segmented group) would otherwise have
/// duplicated the rule walk, and two copies of "what counts as
/// geometry" is how the two drift.
///
/// The same walk answers a *colour* question, and has to: where a state
/// has no hairline of its own to tint — a chip inside a segment drops
/// its border to the group — colour is the whole of what says the state
/// is on, and "on and off resolve to nearly the same fill" is then a
/// bug no geometry check can see. {@link themeTokens} and
/// {@link contrastRatio} resolve a `var(--token)` per theme and say how
/// far apart two fills land.

/// Every property that would move something if it changed. Colour,
/// outline and animation are deliberately absent: those are exactly
/// what a state is allowed to change.
export const GEOMETRY = [
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-width",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-style",
  "border-radius",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "gap",
  "column-gap",
  "row-gap",
  "display",
  "position",
  "box-sizing",
  "flex",
  "transform",
];

/// Put the app's stylesheet in the document, so `geometryOf` has rules
/// to walk. Call it once, from `beforeAll`.
export function installStylesheet(css: string): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/// The paint a state is allowed to change. `box-shadow` is here rather
/// than in {@link GEOMETRY} on purpose: it is the one way to draw an
/// edge without a box model change, so a state that needs an edge and
/// must not move anything reaches for it. Read with
/// {@link declarationsOf} to check that two states of one element do
/// not land on the same colour.
export const PAINT = ["background", "background-color", "color", "box-shadow"];

/// The declarations an element actually resolves to under the installed
/// stylesheet, restricted to `props`: every matching rule's declarations
/// among them, in source order, later winning.
export function declarationsOf(el: Element, props: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const styleRule = rule as CSSStyleRule;
      if (typeof styleRule.selectorText !== "string") continue;
      let matches = false;
      try {
        matches = el.matches(styleRule.selectorText);
      } catch {
        // A selector jsdom cannot evaluate (`:focus-visible`) matches
        // nothing here — and it is a state, not a geometry, rule.
        continue;
      }
      if (!matches) continue;
      for (const prop of props) {
        const value = styleRule.style.getPropertyValue(prop);
        if (value !== "") out[prop] = value;
      }
    }
  }
  return out;
}

/// The geometry an element actually resolves to under the installed
/// stylesheet: every matching rule's geometry declarations, in source
/// order, later winning.
export function geometryOf(el: Element): Record<string, string> {
  return declarationsOf(el, GEOMETRY);
}

/// One theme's token table, read from the stylesheet's own `:root`
/// block — `null` for the default (dark) theme, otherwise the
/// `data-theme` value the theme setting writes on the root element.
///
/// A colour question is only answerable per theme: the rules hold
/// `var(--token)`, and which hex that is depends on which block is
/// live. This reads the block so a test can resolve one itself.
export function themeTokens(theme: string | null): Record<string, string> {
  const wanted = theme === null ? ":root" : `:root[data-theme="${theme}"]`;
  const out: Record<string, string> = {};
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const styleRule = rule as CSSStyleRule;
      if (styleRule.selectorText !== wanted) continue;
      for (const name of Array.from(styleRule.style)) {
        if (name.startsWith("--")) out[name] = styleRule.style.getPropertyValue(name).trim();
      }
    }
  }
  return out;
}

/// Resolve a declaration that is a bare `var(--token)` against a theme's
/// table, to the `#rrggbb` the theme actually paints.
export function resolveToken(value: string, tokens: Record<string, string>): string {
  const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!m) return value.trim();
  const resolved = tokens[m[1]];
  if (resolved === undefined) throw new Error(`no such token in this theme: ${m[1]}`);
  return resolved;
}

/// WCAG relative luminance of an `#rrggbb` colour.
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not an opaque hex colour: ${hex}`);
  const channel = (byte: number) => {
    const c = byte / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = parseInt(m[1], 16);
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  );
}

/// WCAG contrast ratio between two `#rrggbb` colours, 1 (identical) to
/// 21 (black on white). Two fills a user is meant to tell apart at a
/// glance need to be well clear of 1.
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
