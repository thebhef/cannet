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

/// The geometry an element actually resolves to under the installed
/// stylesheet: every matching rule's geometry declarations, in source
/// order, later winning.
export function geometryOf(el: Element): Record<string, string> {
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
      for (const prop of GEOMETRY) {
        const value = styleRule.style.getPropertyValue(prop);
        if (value !== "") out[prop] = value;
      }
    }
  }
  return out;
}
