// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { isTabMiddlePress } from "./dockLayout";

describe("isTabMiddlePress", () => {
  const tab = document.createElement("div");
  tab.className = "dv-tab";
  const inner = document.createElement("span");
  tab.appendChild(inner);
  document.body.appendChild(tab);
  const outside = document.createElement("div");
  document.body.appendChild(outside);

  it("matches a middle press on a tab or anything inside it", () => {
    expect(isTabMiddlePress(1, tab)).toBe(true);
    expect(isTabMiddlePress(1, inner)).toBe(true);
  });

  it("ignores other buttons and non-tab targets", () => {
    expect(isTabMiddlePress(0, tab)).toBe(false);
    expect(isTabMiddlePress(2, tab)).toBe(false);
    expect(isTabMiddlePress(1, outside)).toBe(false);
    expect(isTabMiddlePress(1, null)).toBe(false);
  });
});
