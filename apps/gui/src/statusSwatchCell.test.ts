// The status swatch cells of the view-signals and RBS signals grids.
//
// Both grids say a row's status with a color chip alone — an empty
// element whose height comes entirely from CSS. The row grid
// top-aligns its cells, so the cell must stretch itself for the chip's
// own `align-self: stretch` to give it row height; without that chain
// the empty swatch collapses to a sliver ("a colorful underscore" —
// owner defect report, 2026-08-29).
//
// jsdom does no layout, so this reads the stylesheet as text, the way
// `gridviewFocusRing.test.ts` does.

import { describe, expect, it } from "vitest";

import css from "./index.css?raw";

/// The declarations of every rule whose selector list includes
/// `selector` as one of its comma-separated alternatives.
function declarations(selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
    if (sel === "" || sel.includes("@")) continue;
    if (sel.split(",").some((s) => s.trim() === selector)) out.push(m[2]);
  }
  return out.join(";");
}

describe("the status swatch cells", () => {
  it.each([".col-vs-status", ".col-rs-status"])(
    "%s stretches itself and its chip to row height",
    (cell) => {
      const decls = declarations(cell);
      expect(decls).toMatch(/display\s*:\s*flex/);
      expect(decls).toMatch(/align-self\s*:\s*stretch/);
      expect(decls).toMatch(/align-items\s*:\s*stretch/);
    },
  );

  it.each([".view-signals-chip", ".rbs-signals-chip"])(
    "%s fills the stretched cell",
    (chip) => {
      expect(declarations(chip)).toMatch(/align-self\s*:\s*stretch/);
    },
  );
});
