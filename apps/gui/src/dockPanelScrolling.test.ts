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

describe("project panel", () => {
  it("is bounded by the dock group so its overflow scrolls", () => {
    const d = declarations(".project-panel");
    expect(d).toMatch(/\boverflow:\s*auto\b/);
    expect(d).toMatch(/\bheight:\s*100%/);
  });
});

describe("colour-map panel", () => {
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
