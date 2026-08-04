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
