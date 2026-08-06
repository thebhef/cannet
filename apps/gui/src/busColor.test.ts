import { describe, expect, it } from "vitest";

import { defaultBusColor, effectiveBusColor } from "./busColor";
import { theme } from "./theme";
import type { Bus } from "./types";

const bus = (id: string, color?: string): Bus => ({ id, name: id, color });

describe("defaultBusColor", () => {
  it("cycles the theme's bus wheel by list position", () => {
    const wheel = theme().busWheel;
    expect(defaultBusColor(0)).toBe(wheel[0]);
    expect(defaultBusColor(wheel.length - 1)).toBe(wheel[wheel.length - 1]);
    expect(defaultBusColor(wheel.length)).toBe(wheel[0]);
    expect(defaultBusColor(wheel.length + 2)).toBe(wheel[2]);
  });
});

describe("effectiveBusColor", () => {
  it("derives an uncustomized bus's color from its position", () => {
    const buses = [bus("a"), bus("b"), bus("c")];
    expect(effectiveBusColor("a", buses)).toBe(defaultBusColor(0));
    expect(effectiveBusColor("c", buses)).toBe(defaultBusColor(2));
  });

  it("renders a stored color verbatim, whatever the theme's wheel says", () => {
    // A color in the project is the user's choice — no wheel slot, no
    // contrast clamp.
    const buses = [bus("a", "#123456"), bus("b")];
    expect(effectiveBusColor("a", buses)).toBe("#123456");
    // …and it doesn't disturb what its neighbours derive.
    expect(effectiveBusColor("b", buses)).toBe(defaultBusColor(1));
  });

  it("greys a bus id that isn't in the list", () => {
    expect(effectiveBusColor("gone", [bus("a")])).toBe(theme().busUnknown);
  });
});
