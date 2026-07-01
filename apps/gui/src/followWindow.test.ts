import { describe, expect, it } from "vitest";

import { followXWindow } from "./followWindow";

const DEFAULT = 10;

describe("followXWindow", () => {
  it("slides a trailing default-width window on a running follow-live trace", () => {
    expect(followXWindow(true, true, null, null, 579, DEFAULT, 0)).toEqual({ min: 569, max: 579 });
  });

  it("keeps the user's zoom width while following a running trace", () => {
    // Window was [100, 130] (width 30); live edge now 579.
    expect(followXWindow(true, true, 100, 130, 579, DEFAULT, 0)).toEqual({ min: 549, max: 579 });
  });

  it("pins the left edge at the window start until the capture exceeds the window width", () => {
    // A trace cleared at session-elapsed 30 s has its first frame at 30,
    // not 0 — the window floors at its own start, never below it (ADR
    // 0024: a Clear doesn't re-zero the display). A fresh session start
    // makes windowStart 0, the original behaviour.
    expect(followXWindow(true, true, null, null, 4, DEFAULT, 0)).toEqual({ min: 0, max: 4 });
    expect(followXWindow(true, true, null, null, 34, DEFAULT, 30)).toEqual({ min: 30, max: 34 });
  });

  it("fits the full span once on a restored stopped trace even with follow-live on", () => {
    // The reload bug: follow-live is on (default), but the trace is
    // stopped (not running) and no window is set yet — fit
    // [windowStart, ext], never a trailing 10 s slice.
    expect(followXWindow(true, false, null, null, 579, DEFAULT, 30)).toEqual({ min: 30, max: 579 });
  });

  it("leaves a zoomed stopped trace's window untouched", () => {
    expect(followXWindow(true, false, 100, 130, 579, DEFAULT, 30)).toBeNull();
    expect(followXWindow(false, false, 100, 130, 579, DEFAULT, 30)).toBeNull();
  });

  it("fits the full span from the window start when not following and no window is set", () => {
    expect(followXWindow(false, false, null, null, 579, DEFAULT, 30)).toEqual({ min: 30, max: 579 });
  });
});
