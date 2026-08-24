// The gridview container's focus ring (ADR 0044).
//
// A gridview container is the one element of the grid that holds DOM
// focus — the rows are recycled or absent in the paged viewports, so
// the active row is *named* by `aria-activedescendant` rather than
// focused. The container is therefore `tabindex="0"`, and a UA draws
// its focus ring around the whole box: the entire scroll viewport, not
// the row the cursor is on. On a press that moves the cursor the row
// indicator moves with it and the box ring reads as chrome; on a press
// that moves nothing — Left on a top-level row, Right on a plain leaf —
// the box ring is the only thing on screen that changed, and it reads
// as "the whole panel got highlighted".
//
// So while the container names an active descendant, the row is the
// focus indication and the box ring is suppressed. While it names
// none — focus arrived by Tab and the cursor has not moved yet — the
// ring is all a keyboard user has, and it stays.
//
// jsdom does no layout and never loads the app's stylesheet, so no
// rendering test can see a focus ring. This reads the stylesheet as
// text, the way `dockPanelScrolling.test.ts` does.

import { describe, expect, it } from "vitest";

import css from "./index.css?raw";

/// Every rule in the stylesheet, as `[selector, declarations]`. Naive
/// on purpose — the file has no nesting, and at-rule wrappers are
/// dropped by the `@` filter.
function rules(): [string, string][] {
  const out: [string, string][] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
    if (selector === "" || selector.includes("@")) continue;
    out.push([selector, m[2]]);
  }
  return out;
}

const GRIDVIEW_ATTR_SELECTOR = "[data-gridview]";

/// Selectors that suppress the outline, split into their comma-separated
/// alternatives.
function outlineSuppressors(): string[] {
  return rules()
    .filter(([, decls]) => /(^|[;{\s])outline\s*:\s*none\b/.test(decls))
    .flatMap(([selector]) => selector.split(",").map((s) => s.trim()));
}

describe("the gridview container's focus ring", () => {
  it("is suppressed for a container that names an active row", () => {
    // Keyed on the attribute the layer stamps on every gridview
    // container, so a panel that adopts the layer next year is covered
    // without anyone remembering this file.
    const matching = outlineSuppressors().filter(
      (s) => s.includes(GRIDVIEW_ATTR_SELECTOR) && s.includes("[aria-activedescendant]"),
    );
    expect(matching, "no rule drops the UA ring on a gridview naming an active row").not.toEqual(
      [],
    );
    // …and only while focused: a gridview at rest never had a ring to
    // drop, and a blanket suppression would also cover the case below.
    for (const s of matching) expect(s).toMatch(/:focus(-visible)?\b/);
  });

  it("is kept for a container that names none", () => {
    // The keyboard-accessibility half, and the reason the rule above is
    // guarded by the attribute rather than written flat. Focus arrives
    // on the container by Tab before the cursor has moved anywhere; with
    // no active row to point at, the box ring is the only thing that
    // says where focus is, and dropping it would strand a keyboard user.
    const unguarded = outlineSuppressors().filter(
      (s) => s.includes(GRIDVIEW_ATTR_SELECTOR) && !s.includes("[aria-activedescendant]"),
    );
    expect(unguarded, "a gridview container with no cursor must keep its focus ring").toEqual([]);
  });

  it("leaves every panel's row-level cursor indicator standing", () => {
    // What the rule above trades the box ring for. Each gridview panel
    // draws the cursor on the row itself — the ones whose rows are all
    // selectable let the selection carry it (the cursor collapses the
    // selection onto itself), the ones with unselectable rows mark the
    // cursor row directly. Delete one of these and that panel's keyboard
    // user is left with no focus indication at all, which is the failure
    // the attribute guard exists to prevent; so the set is named here
    // rather than left to each panel's own tests.
    const indicators = new Map<string, string>([
      [".trace-row.selected", "chronological trace, by-id table, signals, view signals"],
      [".trace-event-focused", "timeline event rows, which are not selectable"],
      [".tx-frame-row[data-active]", "transmit panel"],
      [".dbc-row-active", "database panel, whose group rows are not selectable"],
      [".rbs-message-row[data-active]", "RBS tree, whose bus and ECU rows are not selectable"],
      [".rbs-signals-row[data-active]", "RBS signals panel"],
      [".blf-map-marker-row.active", "BLF channel-map marker list"],
    ]);
    const visible = rules()
      .filter(([, decls]) => /(^|[;{\s])(outline|background|box-shadow)\s*:/.test(decls))
      .flatMap(([selector]) => selector.split(",").map((t) => t.trim()));
    for (const [selector, panel] of indicators) {
      expect(visible, `${panel}: no visible rule for \`${selector}\``).toContain(selector);
    }
  });
});
