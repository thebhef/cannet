import { describe, expect, it } from "vitest";

import type { ProjectElement } from "./types";
import {
  buildColorResolver,
  colorMapLaneFill,
  colorMapTint,
  rulesFromValueTable,
} from "./colorMap";

function colormap(over: Partial<Extract<ProjectElement, { kind: "colormap" }>>): ProjectElement {
  return {
    kind: "colormap",
    id: "cm1",
    messageId: 0x100,
    extended: false,
    signalName: "Gear",
    rules: [],
    ...over,
  };
}

const target = (over: Partial<Parameters<ReturnType<typeof buildColorResolver>>[0]> = {}) => ({
  messageId: 0x100,
  extended: false,
  signalName: "Gear",
  busId: null as string | null,
  ...over,
});

describe("buildColorResolver", () => {
  it("returns null when no colormap targets the signal", () => {
    const resolve = buildColorResolver([colormap({ signalName: "Speed", rules: [{ min: 0, max: 0, color: "#f00" }] })]);
    expect(resolve(target(), 0)).toBeNull();
  });

  it("matches an enum value (degenerate [v, v] range)", () => {
    const resolve = buildColorResolver([
      colormap({
        rules: [
          { min: 0, max: 0, color: "#111" },
          { min: 1, max: 1, color: "#222" },
          { min: 2, max: 2, color: "#333" },
        ],
      }),
    ]);
    expect(resolve(target(), 0)).toBe("#111");
    expect(resolve(target(), 2)).toBe("#333");
    expect(resolve(target(), 3)).toBeNull(); // no rule covers it
  });

  it("matches an inclusive numeric range", () => {
    const resolve = buildColorResolver([
      colormap({ signalName: "Temp", rules: [{ min: 90, max: 120, color: "#f00" }] }),
    ]);
    const t = (v: number) => resolve(target({ signalName: "Temp" }), v);
    expect(t(89.9)).toBeNull();
    expect(t(90)).toBe("#f00");
    expect(t(120)).toBe("#f00");
    expect(t(120.1)).toBeNull();
  });

  it("requires message id and std/ext to match, not just the name", () => {
    const resolve = buildColorResolver([colormap({ rules: [{ min: 5, max: 5, color: "#abc" }] })]);
    expect(resolve(target({ messageId: 0x200 }), 5)).toBeNull();
    expect(resolve(target({ extended: true }), 5)).toBeNull();
    expect(resolve(target(), 5)).toBe("#abc");
  });

  it("honours an explicit bus scope; a null scope matches any bus", () => {
    const scoped = buildColorResolver([
      colormap({ busId: "chassis", rules: [{ min: 1, max: 1, color: "#aaa" }] }),
    ]);
    expect(scoped(target({ busId: "chassis" }), 1)).toBe("#aaa");
    expect(scoped(target({ busId: "powertrain" }), 1)).toBeNull();

    const anyBus = buildColorResolver([colormap({ rules: [{ min: 1, max: 1, color: "#bbb" }] })]);
    expect(anyBus(target({ busId: "powertrain" }), 1)).toBe("#bbb");
  });

  it("is first-match across maps and within a map's rules", () => {
    const resolve = buildColorResolver([
      colormap({ id: "a", rules: [{ min: 0, max: 10, color: "#first" }] }),
      colormap({ id: "b", rules: [{ min: 5, max: 5, color: "#second" }] }),
    ]);
    // Both maps cover value 5; the first listed wins.
    expect(resolve(target(), 5)).toBe("#first");
  });

  it("ignores non-colormap elements", () => {
    const resolve = buildColorResolver([
      { kind: "trace", id: "t", sources: ["*"] },
      colormap({ rules: [{ min: 7, max: 7, color: "#7" }] }),
    ]);
    expect(resolve(target(), 7)).toBe("#7");
  });
});

describe("colorMapTint", () => {
  it("converts a hex color to a low-opacity rgba", () => {
    // #abcdef → rgb(171, 205, 239) at alpha 0.3.
    expect(colorMapTint("#abcdef")).toBe("rgba(171, 205, 239, 0.3)");
    // Short hex expands; the leading # is optional.
    expect(colorMapTint("#0f0")).toBe("rgba(0, 255, 0, 0.3)");
  });

  it("passes a non-hex color through unchanged", () => {
    expect(colorMapTint("rebeccapurple")).toBe("rebeccapurple");
  });
});

describe("colorMapLaneFill", () => {
  it("darkens the color and applies 0.65 opacity so the line shows through", () => {
    // #abcdef → rgb(171, 205, 239) × 0.4 → (68, 82, 96) at alpha 0.65.
    expect(colorMapLaneFill("#abcdef")).toBe("rgba(68, 82, 96, 0.65)");
    expect(colorMapLaneFill("rebeccapurple")).toBe("rebeccapurple");
  });
});

describe("rulesFromValueTable", () => {
  it("turns enum entries into degenerate-range rules cycling a palette", () => {
    const rules = rulesFromValueTable([
      { raw: 0, label: "Park" },
      { raw: 1, label: "Reverse" },
      { raw: 2, label: "Drive" },
    ]);
    expect(rules.map((r) => [r.min, r.max])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    // Distinct colors, all hex.
    expect(new Set(rules.map((r) => r.color)).size).toBe(3);
    expect(rules.every((r) => /^#[0-9a-fA-F]{6}$/.test(r.color))).toBe(true);
  });
});
