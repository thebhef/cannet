import { describe, expect, it } from "vitest";

import {
  emptyJankMeter,
  jankPercent,
  jankPixels,
  observeScroll,
  scrollStepMs,
  type JankMeter,
} from "./scrollJank";

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

  // --- What the percentage actually measures ---
  //
  // The reading sat between 37 % and 87 % through a connect run that was
  // subjectively smooth, so the question is whether it grades smoothness
  // at all. These feed the meter a scroll whose misplacement is *known
  // in pixels* and read both numbers back. If the percentage graded
  // smoothness, the same pixel error would score the same however the
  // run was configured.

  /** A uniform scroll of `rate` data-s per wall-s, repainted every
   * `dtMs`, whose position alternates ±`jitterS` seconds around where
   * uniform motion would put it. */
  function jittered(jitterS: number, dtMs: number, rate = 1, n = 200) {
    return Array.from({ length: n }, (_, k) => {
      const wobble = (k % 2 === 0 ? 1 : -1) * jitterS;
      return [100 + (k * dtMs * rate) / 1000 + wobble, 1000 + k * dtMs] as [number, number];
    });
  }

  it("reads back a known misplacement in pixels", () => {
    // 1000 px of plot across a 1.3 s window → 769 px/s. A ±1 px wobble
    // is ±1/769 s of position; the alternating pattern makes each step
    // land 2 px from uniform, so that is what the reading must be.
    const pxPerSecond = 1000 / 1.3;
    const onePx = 1 / pxPerSecond;
    // The EMA damps a strictly alternating input by ~8 % (each new
    // sample pulls the average toward itself before the deviation is
    // taken), so the reading lands just under the geometric 2 px.
    const m = run(jittered(onePx, 16));
    expect(jankPixels(m, pxPerSecond)!).toBeGreaterThan(1.7);
    expect(jankPixels(m, pxPerSecond)!).toBeLessThan(2.1);
    // Nothing to misplace when the scroll is uniform.
    expect(jankPixels(run(perfect(60)), pxPerSecond)!).toBeLessThan(0.01);
  });

  it("the percentage rises with repaint rate for an unchanged misplacement", () => {
    // Same ±1 px wobble, sampled every 16 ms vs every 66 ms. The pixels
    // on screen are identical; the percentage quadruples, because it
    // divides a fixed positional error by a rate measured over a
    // shorter interval. A gate on the percentage would therefore fire
    // on a change to the plot fetch interval alone.
    const pxPerSecond = 1000 / 1.3;
    const onePx = 1 / pxPerSecond;
    const fast = run(jittered(onePx, 16));
    const slow = run(jittered(onePx, 66));
    expect(jankPixels(fast, pxPerSecond)!).toBeCloseTo(jankPixels(slow, pxPerSecond)!, 1);
    expect(jankPercent(fast)!).toBeGreaterThan(jankPercent(slow)! * 3);
    // For the record: ~16 % at 16 ms, ~4 % at 66 ms, for one pixel.
    expect(jankPercent(fast)!).toBeGreaterThan(10);
    expect(jankPercent(slow)!).toBeLessThan(6);
  });

  it("the percentage rises with zoom for an unchanged misplacement", () => {
    // The same ±1 px wobble at a 1.3 s window and at a 13 s window. Same
    // pixels, ten times the percentage — the reading is normalised by
    // the scroll *rate*, and rate is in data-seconds, so zooming in
    // shrinks the denominator's worth of pixels without changing
    // anything about the render path.
    const zoomedIn = 1000 / 1.3;
    const zoomedOut = 1000 / 13;
    const tight = run(jittered(1 / zoomedIn, 16));
    const wide = run(jittered(1 / zoomedOut, 16));
    expect(jankPixels(tight, zoomedIn)!).toBeCloseTo(jankPixels(wide, zoomedOut)!, 1);
    expect(jankPercent(wide)!).toBeGreaterThan(jankPercent(tight)! * 5);
  });

  it("reports the cadence the window moves at, not the repaint rate", () => {
    // The window steps once per 66 ms fetch while the plot repaints
    // between steps. Reading either jank number without knowing which
    // of those two the interval is makes it uninterpretable.
    const samples: Array<[number, number]> = [];
    let x = 100;
    for (let tick = 0; tick < 40; tick++) {
      const tickMs = 1000 + tick * 66;
      samples.push([x, tickMs + 10], [x, tickMs + 30], [x, tickMs + 50]);
      x += 0.066;
      samples.push([x, tickMs + 66]);
    }
    expect(scrollStepMs(run(samples))!).toBeCloseTo(66, 0);
    expect(scrollStepMs(run(perfect(60)))!).toBeCloseTo(16, 0);
  });

  it("reports nothing while the window is stationary", () => {
    // Paused or zoomed: there is no scroll to be smooth about, and
    // dividing by a ~zero rate would manufacture a huge reading.
    const still: Array<[number, number]> = Array.from({ length: 60 }, (_, k) => [100, 1000 + k * 16]);
    expect(jankPercent(run(still))).toBeNull();
  });
});
