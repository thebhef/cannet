// @vitest-environment jsdom
//
// The icon registry is meant to be "reviewable as a set": adding or
// removing an icon should be a deliberate, visible change, not a side
// effect of drawing one new glyph. The second test below pins the exact
// set by name, independent of whatever `ICON_NAMES` says at the time —
// so a silent rename or drop, even one the compiler wouldn't catch (e.g.
// changing a name consistently in both `ICON_NAMES` and `ICON_REGISTRY`),
// still fails here.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ICON_NAMES, Icon } from "./Icon";

afterEach(cleanup);

describe("Icon registry", () => {
  it("renders every registered icon with drawable shape data", () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg, `icon "${name}" rendered no <svg>`).not.toBeNull();
      expect(svg!.children.length, `icon "${name}" has no shapes`).toBeGreaterThan(0);
      unmount();
    }
  });

  it("pins the icon set itself — copied from the prototype's full inventory", () => {
    // Copied from the design prototype's "The icon set — full inventory"
    // section. Changing this list is changing the reviewable set, not an
    // incidental effect of adding one icon somewhere else.
    const expected = [
      "folder",
      "save",
      "import",
      "export",
      "clock",
      "db",
      "db-add",
      "bus",
      "plug",
      "clear",
      "plus",
      "rows",
      "chart",
      "signals",
      "send",
      "loop",
      "palette",
      "wave",
      "eye",
      "graph",
      "flag",
      "tree",
      "bell",
      "play",
      "pause",
      "stop",
      "fit-x",
      "fit-y",
      "search",
      "cursors",
      "cursor-x",
      "cursor-y",
      "note",
      "goto",
      "edit",
      "link",
      "x",
    ];
    expect([...ICON_NAMES].sort()).toEqual([...expected].sort());
  });
});
