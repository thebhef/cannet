import { describe, expect, it } from "vitest";

import { emptyJankMeter, jankPercent, observeScroll, type JankMeter } from "./scrollJank";

const ALPHA = 0.15;

/** Feed a run of (position, time) samples and read the meter. */
function run(samples: Array<[number, number]>): JankMeter {
  let m = emptyJankMeter();
  for (const [x, ms] of samples) m = observeScroll(m, x, ms, ALPHA);
  return m;
}

/** A window advancing at exactly real time, repainted every `dtMs`. */
function perfect(n: number, dtMs = 16): Array<[number, number]> {
  return Array.from({ length: n }, (_, k) => [100 + (k * dtMs) / 1000, 1000 + k * dtMs]);
}

describe("observeScroll / jankPercent", () => {
  it("reads nothing until there are enough samples", () => {
    expect(jankPercent(emptyJankMeter())).toBeNull();
    expect(jankPercent(run(perfect(5)))).toBeNull();
  });

  it("reads ~0 for a perfectly uniform scroll", () => {
    expect(jankPercent(run(perfect(60)))!).toBeLessThan(0.01);
  });

  it("reads worse the more the rate wobbles", () => {
    // Same average advance, delivered in increasingly uneven steps —
    // which is exactly what stepping the window to data arrival does.
    const uneven = (amp: number) =>
      run(
        Array.from({ length: 60 }, (_, k) => {
          const wobble = (k % 2 === 0 ? amp : -amp) * 0.016;
          return [100 + (k * 16) / 1000 + wobble, 1000 + k * 16] as [number, number];
        }),
      );
    const mild = jankPercent(uneven(0.2))!;
    const bad = jankPercent(uneven(1))!;
    expect(mild).toBeGreaterThan(0);
    expect(bad).toBeGreaterThan(mild * 2);
  });

  it("is comparable across zoom levels and repaint rates", () => {
    // The reading is normalised by the scroll rate, so the same relative
    // unevenness scores the same whether repaints are 16 ms or 66 ms
    // apart. Without that, a change measured at one setting couldn't be
    // compared against a run at another.
    const wobbly = (dtMs: number) =>
      run(
        Array.from({ length: 60 }, (_, k) => {
          const wobble = (k % 2 === 0 ? 0.3 : -0.3) * (dtMs / 1000);
          return [100 + (k * dtMs) / 1000 + wobble, 1000 + k * dtMs] as [number, number];
        }),
      );
    expect(jankPercent(wobbly(16))!).toBeCloseTo(jankPercent(wobbly(66))!, 0);
  });

  it("ignores gaps that are not jank", () => {
    // A backgrounded window produces one enormous interval. Folding it
    // in would swamp the average with a single outlier and make the
    // reading useless for the following minute.
    const withStall: Array<[number, number]> = perfect(60);
    withStall.push([100 + 5, 1000 + 60 * 16 + 5000]); // 5 s gap
    withStall.push([100 + 5.016, 1000 + 60 * 16 + 5016]);
    expect(jankPercent(run(withStall))!).toBeLessThan(0.01);
  });

  it("reports nothing for a stationary window, however it is nudged", () => {
    // A capture with follow-live off produced mean 1144%, max 2640%.
    // A stationary window still drifts by float noise, and dividing by
    // a rate that *is* that noise manufactures huge readings. Anything
    // below a real scroll rate has to read as "not scrolling".
    const noisy: Array<[number, number]> = Array.from({ length: 200 }, (_, k) => [
      100 + (k % 2 === 0 ? 1e-12 : -1e-12),
      1000 + k * 16,
    ]);
    expect(jankPercent(run(noisy))).toBeNull();
    // A slow but genuine crawl is still below the scroll floor.
    const crawl: Array<[number, number]> = Array.from({ length: 200 }, (_, k) => [
      100 + k * 0.0001,
      1000 + k * 16,
    ]);
    expect(jankPercent(run(crawl))).toBeNull();
  });

  it("measures window movement, not how often we repaint", () => {
    // The window advances once per resample tick but the plot repaints
    // more often. Counting every repaint as a rate sample would see
    // 0, 0, 0, step, 0, 0, 0, step — huge apparent unevenness that is
    // purely an artefact of the sampling rate. Perfectly regular steps
    // sampled by irregular repaints must still read ~0.
    const samples: Array<[number, number]> = [];
    let x = 100;
    for (let tick = 0; tick < 40; tick++) {
      const tickMs = 1000 + tick * 66;
      // Repaints between steps see an unchanged window.
      samples.push([x, tickMs + 10]);
      samples.push([x, tickMs + 30]);
      samples.push([x, tickMs + 50]);
      x += 0.066; // the step, exactly one tick's worth of data
      samples.push([x, tickMs + 66]);
    }
    expect(jankPercent(run(samples))!).toBeLessThan(1);
  });

  it("forgets a scroll once the window has been stopped a while", () => {
    // Pausing must not leave the last live reading on display.
    const live = perfect(60);
    const m = run(live);
    expect(jankPercent(m)).not.toBeNull();
    const paused: Array<[number, number]> = [...live];
    const lastX = live[live.length - 1][0];
    const lastMs = live[live.length - 1][1];
    for (let k = 1; k < 10; k++) paused.push([lastX, lastMs + k * 600]);
    expect(jankPercent(run(paused))).toBeNull();
  });

  it("reports nothing while the window is stationary", () => {
    // Paused or zoomed: there is no scroll to be smooth about, and
    // dividing by a ~zero rate would manufacture a huge reading.
    const still: Array<[number, number]> = Array.from({ length: 60 }, (_, k) => [100, 1000 + k * 16]);
    expect(jankPercent(run(still))).toBeNull();
  });
});
