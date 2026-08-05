// A dock panel that scrolls its own content has to be *bounded* by the
// dockview group, or it has nothing to scroll inside.
//
// dockview mounts a panel's React root as `.dv-react-part` (inline
// `height: 100%`) inside `.dv-content-container` (a flex child with
// `min-height: 0`) inside `.dv-groupview` (`overflow: hidden`). A panel
// root left at the initial `height: auto` grows to its content, so its
// own `overflow: auto` never has anything to scroll — the content simply
// runs past the group, which clips it. Measured in Chromium (the engine
// behind the Tauri WebView2 host): with `height: auto` the panel's
// `scrollHeight` equals its `clientHeight` (655/655 in a 300 px group),
// `scrollTop` stays 0, and the last section sits 365 px below the
// group's bottom edge; pinning `height: 100%` gives 265/655 and the
// last section comes into reach.
//
// jsdom does no layout and the app's stylesheet is never loaded into it,
// so no rendering test can catch a regression here. This reads the
// stylesheet as text and asserts the declaration instead.

import { describe, expect, it } from "vitest";

import css from "./index.css?raw";

/// The declarations of the first top-level rule for `selector`.
function declarations(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `no \`${selector}\` rule in index.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

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

// The generic guard, and the reason this file is not just a list of the
// panels that were reported broken. Six surfaces had scroll defects
// through four different mechanisms before anyone looked at the set as
// a whole; two of them (the project panel and the colormap panel) were
// the *same* mistake — `overflow: auto` on a box with no definite size
// in the scroll axis, which never scrolls because it just grows to its
// content.
//
// A box can get that size three ways, and the app uses all three: an
// explicit `height` (a panel root pinned to its dock group), a
// `max-height` (a popup or modal), or `flex` in a column parent (a list
// filling what the toolbar above it leaves). So the invariant is not a
// shared class — the three cases need different declarations — it is
// that every scroll container declares *one* of them. This walks the
// whole stylesheet, so a panel added next year is covered without
// anyone remembering to add a case here.
describe("every scroll container", () => {
  // Bounded by an ancestor rather than by itself, verified in Chromium
  // rather than assumed. `.combobox-list` is a flex child of
  // `.combobox-pop`, whose `max-height: 40vh` is the bound; measured in
  // a 200 px pop with 40 options, `clientHeight` 160 against a
  // `scrollHeight` of 911 and `scrollTop` reaching 751.
  const BOUNDED_BY_ANCESTOR = new Set([".combobox-list"]);

  it("is bounded in the axis it scrolls", () => {
    const unbounded: string[] = [];
    for (const [selector, decls] of rules()) {
      if (!/\boverflow(-y)?\s*:\s*(auto|scroll)\b/.test(decls)) continue;
      if (BOUNDED_BY_ANCESTOR.has(selector)) continue;
      if (!/\b(height|max-height|flex)\s*:/.test(decls)) unbounded.push(selector);
    }
    expect(unbounded).toEqual([]);
  });
});

describe("project panel", () => {
  it("is bounded by the dock group so its overflow scrolls", () => {
    const d = declarations(".project-panel");
    expect(d).toMatch(/\boverflow:\s*auto\b/);
    expect(d).toMatch(/\bheight:\s*100%/);
  });
});

describe("color-map panel", () => {
  // The project panel's defect exactly: `overflow: auto` on a panel root
  // with no height. Measured in Chromium with the real stylesheets, a
  // 300 px group and 24 range rules: `clientHeight === scrollHeight ===
  // 794`, `scrollTop` stuck at 0, and the "+ range" button 485 px below
  // the group's bottom edge. `height: 100%` gives 300 / 794, `scrollTop`
  // reaching 494, and the button in reach.
  it("is bounded by the dock group so its overflow scrolls", () => {
    const d = declarations(".colormap-panel");
    expect(d).toMatch(/\boverflow:\s*auto\b/);
    expect(d).toMatch(/\bheight:\s*100%/);
  });
});

describe("transmit panel", () => {
  // Not a defect — a regression guard. Measured in Chromium against the
  // real panel markup (and in the WebView2 host itself, 40 frames, all
  // expanded): the list scrolls, `scrollHeight` 11260 against a
  // `clientHeight` of 1943, and the last frame reachable. It works
  // because these two declarations hold together: the panel root is
  // pinned to the group, and the list is a flex child whose non-visible
  // overflow zeroes its automatic minimum size so it can shrink to the
  // panel and scroll the rest. Drop either and it becomes the project
  // panel's bug.
  it("pins its root to the group and scrolls the frame list", () => {
    expect(declarations(".tx-panel")).toMatch(/\bheight:\s*100%/);
    const list = declarations(".tx-panel-list");
    expect(list).toMatch(/\bflex:\s*1 1 auto\b/);
    expect(list).toMatch(/\boverflow-y:\s*auto\b/);
  });
});

describe("trace table", () => {
  // The trace table's grid tracks are fixed px, so on a panel narrower
  // than their sum the columns past the right edge have to be
  // *scrolled* to. They were not: the rows are `position: absolute;
  // left: 0; right: 0` inside a sticky viewport that is `overflow:
  // hidden`, so each row's box was exactly the viewport width and the
  // grid's overflow was clipped rather than becoming scrollable overflow
  // of `.trace-rows`. Measured in the WebView2 host on a 972 px trace
  // panel with the default columns (1208 px of tracks): `.trace-rows`
  // reported `scrollWidth === clientWidth === 957` and `scrollLeft`
  // stuck at 0 while the row's own `scrollWidth` was 1218 — the `dir`
  // column sat 246 px beyond the panel's right edge, unreachable.
  //
  // Widening the scrolled content to the columns' own width fixes it
  // (Chromium, 700 px panel: `scrollWidth` 1227, `scrollLeft` reaching
  // 542, the last column fully in view). `--trace-content-width` is the
  // columns' total, set inline by each view; the stylesheet adds the
  // rows' own horizontal padding, which is its own fact.
  it("scrolls its rows to the full width of the columns", () => {
    const d = declarations(".trace-scroll-content");
    expect(d).toMatch(/\bmin-width:\s*calc\(/);
    expect(d).toContain("--trace-content-width");
    expect(d).toContain("--trace-row-padding-x");
  });

  // The header sits *outside* the rows' scroll container (it must not
  // scroll vertically with them), so each view mirrors the horizontal
  // scroll onto it as a negative margin. A stretched flex item absorbs
  // that margin into its width — measured in Chromium, the header grew
  // from 700 to 1242 px and its columns came 14.8 px out of line with
  // the rows'. An explicit width stops the stretch.
  it("keeps the header a definite width so the scroll mirror can shift it", () => {
    expect(declarations(".trace-header")).toMatch(/\bwidth:\s*100%/);
  });
});

describe("project graph panel", () => {
  // Found by the item-7 sweep, not previously reported. The canvas
  // hosts xyflow, which pans by transform and clips itself, so
  // `.graph-panel-canvas` declares no overflow — correct for the graph,
  // but the *empty* state is ordinary flow content in the same box and
  // was `height: 100%` + `justify-content: center` with nothing to
  // scroll. Measured in Chromium against the real stylesheets: in a
  // 140 px dock group the panel's three help paragraphs report
  // `scrollHeight` 137 against a `clientHeight` of 110, `scrollTop`
  // stuck at 0, and the last paragraph 27 px below the fold. (At the
  // 300 px group everything else here is measured at, it fits — which
  // is why nobody hit it.)
  //
  // `overflow: auto` alone is not the fix: a centered flex line that
  // overflows puts its start edge outside the scroll origin. Measured,
  // it reached the last paragraph (`maxScrollTop` 59) but left the
  // first one 27 px *above* row zero. With `safe center` as well,
  // `scrollHeight` is 228, `maxScrollTop` 118, and both ends are
  // reachable.
  it("scrolls its empty state instead of clipping it in a short panel", () => {
    const d = declarations(".graph-empty");
    expect(d).toMatch(/\boverflow:\s*auto\b/);
    expect(d).toMatch(/\bjustify-content:\s*safe center\b/);
  });
});

describe("system messages panel", () => {
  // The same *symptom* as the trace table (a long line cut off with no
  // scroll position that reaches it) but not the same mechanism — the
  // rows here are ordinary in-flow grids, not absolutely positioned ones
  // in a clipping viewport, and the list's `overflow-x` already computes
  // to `auto`. Nothing ever overflowed: the message track was `1fr`, so
  // it was sized to the leftover panel width, and `.system-messages-msg`
  // ellipsised whatever did not fit inside it (with the row's `overflow:
  // hidden` behind that as a second clip).
  //
  // Measured in headless Chromium (the engine behind the WebView2 host)
  // with the real `index.css`, a 600 x 300 dock group and a 162-character
  // message: `.system-messages-list` reported `scrollWidth ===
  // clientWidth === 585` with `scrollLeft` stuck at 0, while the message
  // span's own `scrollWidth` was 1112 against a rendered width of 241 —
  // 871 px of text unreachable. After: `scrollWidth` 1456 against a
  // `clientWidth` of 585, `scrollLeft` reaching 871, and the message
  // rendered at its full 1112 px.

  // `overflow-x` is never declared, and CSS Overflow's visible→auto
  // promotion (one axis non-visible makes the other `auto`) is what makes
  // the list scroll sideways at all. Measured: computed `overflow-x` is
  // already `auto` before the fix. Declaring `overflow-x: hidden` here
  // would silently re-break it.
  it("leaves the list's horizontal overflow scrollable", () => {
    const d = declarations(".system-messages-list");
    expect(d).toMatch(/\boverflow-y:\s*auto\b/);
    expect(d).not.toMatch(/\boverflow-x\s*:/);
  });

  // The message column has to be able to exceed the panel, and nothing
  // between it and the scroll container may clip it.
  it("lets the message column grow past the panel instead of clipping it", () => {
    const row = declarations(".system-messages-row");
    expect(row).toContain("minmax(max-content, 1fr)");
    expect(row).not.toMatch(/\boverflow:\s*hidden\b/);
    expect(declarations(".system-messages-msg")).not.toContain("ellipsis");
  });

  // Sizing the scrolled stack by `max-content` alone would measure only
  // the rows the virtualizer currently has mounted, so the scroll range
  // would collapse as soon as the long row scrolled off — and this is a
  // tail-following view, so that happens on every append. Measured with
  // `min-width: max-content` alone: scrolled to 800, swapping the long
  // row out took `scrollWidth` 1456 → 585 and snapped `scrollLeft` back
  // to 0. With the width published from the whole filtered set both hold
  // (1456 / 800). The count is a character count because the rows are
  // monospace, so one character is exactly `1ch`; `max-content` stays as
  // a floor for anything wider than the `ch` arithmetic predicts.
  it("sizes the scrolled stack to the longest message in the filtered set", () => {
    const d = declarations(".system-messages-scroll-content");
    expect(d).toContain("--system-messages-message-chars");
    expect(d).toContain("1ch");
    expect(d).toMatch(/\bmin-width:\s*max-content\b/);
    // ...but never narrower than the panel, or the rows' borders and
    // level colors stop short of the right edge when every message
    // already fits. Measured with a plain `calc()` and 15-character
    // messages in a 585 px list: the rows came out 447 px wide.
    expect(d).toMatch(/\bwidth:\s*max\(\s*100%/);
  });
});
