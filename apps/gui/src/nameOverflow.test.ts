// Every surface that shows an entity name or a `VAL_` label has to cope
// with one longer than the column: DBC's long-symbol extension lifts the
// classic 32-character identifier limit, and value-table labels never had
// one. jsdom does no layout and never loads the app's stylesheet, so no
// rendering test can see a name overflow its cell. This reads the
// stylesheet as text and asserts the declarations instead — the same
// idiom as `dockPanelScrolling.test.ts`.
//
// The failures this guards against were three different mistakes, not
// one: a box with no clipping at all (the name pushed its siblings out
// of the row), a box that clipped without `text-overflow` (the name was
// cut mid-glyph with nothing to say so), and a box that ellipsized at
// the *end* (the tail is where DBC symbols differ, so that hides the
// distinguishing part — `NameText` is the answer to that one).

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

const ALL = rules();

/// Every declaration block whose selector list names `selector`, or
/// `""` when the stylesheet has no such rule — which is itself one of
/// the failures this file catches, so it is reported alongside the
/// others rather than thrown from here.
function declarationsFor(selector: string): string {
  return ALL.filter(([s]) => s.split(",").some((part) => part.trim() === selector))
    .map(([, d]) => d)
    .join("\n");
}

function declares(selector: string, property: string, value: string): boolean {
  return declarationsFor(selector).includes(`${property}: ${value};`);
}

/// One surface that renders a name or a `VAL_` label.
interface Surface {
  /// What the reader sees there, for the failure message.
  what: string;
  /// The box that clips. Where a name sits in an inline span inside an
  /// already-clipping cell, this is the *cell* — the inline span has no
  /// overflow of its own to hide.
  clips: string;
  /// The rule supplying `white-space: nowrap`; the clipping rule itself
  /// unless an ancestor row already sets it for the whole line.
  nowrap?: string;
}

const SURFACES: Surface[] = [
  { what: "a trace row's message / signal columns", clips: ".trace-row span", nowrap: ".trace-row" },
  { what: "a trace column header", clips: ".trace-header > span", nowrap: ".trace-row" },
  { what: "a disclosed signal's name in an expanded trace row", clips: ".signal-name" },
  { what: "a disclosed signal's value and `VAL_` label", clips: ".signal-value" },
  { what: "the plot legend's signal name", clips: ".plot-signal-name" },
  { what: "the plot legend's message name", clips: ".plot-signal-message" },
  { what: "a plot area's axis label", clips: ".plot-area-axis-label" },
  { what: "the transmit panel's signal names", clips: ".tx-signal-row .tx-col-name" },
  { what: "the transmit panel's message name", clips: ".tx-row-identity .tx-dbc-name" },
  { what: "the RBS panel's per-signal table", clips: ".rbs-sig-name" },
  { what: "the Database panel's tree rows", clips: ".dbc-row-label", nowrap: ".dbc-row" },
  { what: "the Database panel's live value column", clips: ".dbc-row-value" },
  { what: "a dropdown's current selection", clips: ".combobox-trigger-label" },
  { what: "a dropdown's options", clips: ".combobox-option" },
  { what: "the project graph's node names", clips: ".graph-node-title" },
  { what: "the project graph's node subtitles", clips: ".graph-node-sub" },
  { what: "the colormap editor's enum labels", clips: ".colormap-enum-label" },
  { what: "the goto palette's entries", clips: ".palette-item-label" },
];

describe("every surface that renders an entity name or a VAL_ label", () => {
  it("clips it, and says so with an ellipsis", () => {
    const broken: string[] = [];
    for (const s of SURFACES) {
      const missing: string[] = [];
      if (!declares(s.clips, "overflow", "hidden")) missing.push("overflow: hidden");
      if (!declares(s.clips, "text-overflow", "ellipsis")) missing.push("text-overflow: ellipsis");
      if (!declares(s.nowrap ?? s.clips, "white-space", "nowrap")) {
        missing.push(`white-space: nowrap (on ${s.nowrap ?? s.clips})`);
      }
      if (missing.length > 0) {
        broken.push(`${s.clips} (${s.what}) is missing ${missing.join(", ")}`);
      }
    }
    expect(broken).toEqual([]);
  });

});
// The width these boxes take is *not* separately asserted, and that is
// deliberate rather than an omission. A flex or grid item's automatic
// minimum size (`min-width: auto`) is what would let a long name push
// its track wider than the column model asked for — and the CSS sizing
// rules make that minimum 0 for any item whose overflow is not
// `visible`. So the `overflow: hidden` the test above requires is the
// same declaration that stops the name deciding the width, and a second
// check for `min-width: 0` on every surface would demand a declaration
// the cascade already supplies. The one box that needs an explicit cap
// is `.name-text`, which is not a cell but sits inside one; that is
// asserted below.

describe("the long-name renderer", () => {
  it("ellipsizes only its head, so the tail always survives", () => {
    expect(declares(".name-text-head", "text-overflow", "ellipsis")).toBe(true);
    expect(declares(".name-text-head", "overflow", "hidden")).toBe(true);
    // The control: the tail must NOT ellipsize, or the middle-ellipsis
    // is just an end-ellipsis with extra steps.
    expect(declarationsFor(".name-text-tail")).not.toContain("text-overflow");
    expect(declares(".name-text-tail", "flex", "0 0 auto")).toBe(true);
  });

  it("is capped by its container, never by its content", () => {
    expect(declares(".name-text", "max-width", "100%")).toBe(true);
  });
});
