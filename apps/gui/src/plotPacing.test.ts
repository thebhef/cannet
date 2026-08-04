import { describe, expect, it } from "vitest";

import {
  RESAMPLE_IDLE_RATIO,
  RESAMPLE_MAX_DELAY_MS,
  nextResampleDelayMs,
} from "./plotPacing";

describe("nextResampleDelayMs", () => {
  it("leaves the configured interval alone for a cheap tick", () => {
    // The ordinary case — a few series, a tick far shorter than the
    // interval — must be paced by the setting and nothing else.
    expect(nextResampleDelayMs(67, 0)).toBe(67);
    expect(nextResampleDelayMs(67, 1.2)).toBe(67);
    expect(nextResampleDelayMs(300, 12)).toBe(300);
  });

  it("bounds the UI-thread share once a tick outgrows the interval", () => {
    // 40 ms of synchronous work at a 67 ms interval is already 37 % of
    // the thread; the back-off has to take over from the interval.
    expect(nextResampleDelayMs(67, 40)).toBe(40 * RESAMPLE_IDLE_RATIO);
    // The invariant the whole thing exists for: idle ≥ ratio × busy, so
    // busy / (busy + idle) can never exceed 1 / (1 + ratio).
    for (const cost of [20, 40, 80, 160, 320]) {
      const delay = nextResampleDelayMs(67, cost);
      expect(cost / (cost + delay)).toBeLessThanOrEqual(1 / (1 + RESAMPLE_IDLE_RATIO) + 1e-9);
    }
  });

  it("caps the back-off so a pathological area still refreshes", () => {
    expect(nextResampleDelayMs(67, 5_000)).toBe(RESAMPLE_MAX_DELAY_MS);
  });

  it("never returns less than the interval, even at the cap", () => {
    expect(nextResampleDelayMs(5_000, 5_000)).toBe(5_000);
  });

  it("ignores a nonsense measurement rather than stalling the loop", () => {
    expect(nextResampleDelayMs(67, Number.NaN)).toBe(67);
    expect(nextResampleDelayMs(67, -5)).toBe(67);
  });
});
