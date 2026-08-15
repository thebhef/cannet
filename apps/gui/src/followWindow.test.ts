import { describe, expect, it } from "vitest";

import { advanceLiveEdge, liveEdgeAt, type LiveEdge, followXWindow } from "./followWindow";

const DEFAULT = 10;

describe("advanceLiveEdge", () => {
  const TUNING = {
    maxLagSeconds: 2,
    tauSeconds: 0.25,
    targetLagSeconds: 0,
  };
  const adv = (e: LiveEdge | null, ext: number, nowMs: number, t = TUNING) =>
    advanceLiveEdge(e, ext, nowMs, t);
  const spread = (xs: number[]) => {
    const steps = xs.slice(1).map((v, i) => v - xs[i]);
    return Math.max(...steps) - Math.min(...steps);
  };

  it("anchors on the data edge when there is no edge yet", () => {
    const e = adv(null, 42, 1000);
    expect(liveEdgeAt(e, 1000)).toBeCloseTo(42);
  });

  it("advances at real-time rate between anchors", () => {
    const e = adv(null, 42, 1000);
    expect(liveEdgeAt(e, 1500)).toBeCloseTo(42.5);
    expect(liveEdgeAt(e, 2000)).toBeCloseTo(43);
  });

  /** One tick of a live bus: `dtMs` of real time, `dtMs` of data, plus
   * the arrival jitter a bus + a self-paced resample loop produce. */
  function runLive(jitter: number[], dtMs = 66) {
    let edge: LiveEdge | null = null;
    let ext = 100;
    const painted: number[] = [];
    const raw: number[] = [];
    const gap: number[] = [];
    for (let k = 0; k < jitter.length; k++) {
      const nowMs = 1000 + k * dtMs;
      ext += dtMs / 1000 + jitter[k]; // real-time rate, lurching arrival
      edge = adv(edge, ext, nowMs);
      painted.push(liveEdgeAt(edge, nowMs));
      raw.push(ext);
      gap.push(liveEdgeAt(edge, nowMs) - ext);
    }
    return { painted, raw, gap };
  }
  const JITTER = [0.02, -0.015, 0.031, -0.02, 0.005, 0.044, -0.03, 0.012, -0.01, 0.028,
    -0.022, 0.019, 0.0, -0.018, 0.026, -0.012, 0.033, -0.025, 0.008, 0.015];

  it("is unchanged by extra calls for the same instant", () => {
    // The panel calls this once per plot area per tick. Filtering
    // against elapsed time (not per call) makes that idempotent —
    // otherwise every extra area would pull the edge again and the
    // correction would scale with how many areas you happen to have.
    const base = adv(adv(null, 100, 1000), 100.5, 1066);
    let many = base;
    for (let i = 0; i < 6; i++) many = adv(many, 100.5, 1066);
    expect(liveEdgeAt(many, 1066)).toBeCloseTo(liveEdgeAt(base, 1066), 9);
  });

  it("keeps real time when several areas report the same tick a few ms apart", () => {
    // The panel calls this once per plot area, milliseconds apart, and
    // only whichever call raises the shared max carries new data. The
    // others must be true no-ops. Re-anchoring the clock on them throws
    // away the elapsed time since the previous call — which *rewinds*
    // the displayed edge by that much — so on a panel with N axes the
    // edge loses (N-1)/N of every tick and creeps instead of tracking.
    const AREAS = 4;
    const TICK = 66;
    const TICKS = 60;
    let edge: LiveEdge | null = null;
    let ext = 100;
    let nowMs = 1000;
    let firstAt = 0;
    let firstMs = 0;
    for (let k = 0; k < TICKS; k++) {
      nowMs = 1000 + k * TICK;
      ext += TICK / 1000; // real-time rate
      edge = adv(edge, ext, nowMs); // the area whose fetch raised the max
      for (let a = 1; a < AREAS; a++) {
        nowMs = 1000 + k * TICK + a * 4;
        edge = adv(edge, ext, nowMs); // ...and the rest, same max
      }
      if (k === 0) {
        firstAt = liveEdgeAt(edge, nowMs);
        firstMs = nowMs;
      }
    }
    // Real time elapsed must equal edge travelled: it's a clock.
    expect(liveEdgeAt(edge!, nowMs) - firstAt).toBeCloseTo((nowMs - firstMs) / 1000, 1);
  });

  it("smooths jittery data arrival into far steadier motion", () => {
    // The judder: stepping straight to the data edge translates the plot
    // by whatever arrived since the last repaint. Filtering has to cut
    // that variation hard — it is what every gridline and tile rides on.
    // Measured attenuation at GAIN 0.25 is ~5x; assert 4x so the test
    // pins real filtering without being a tripwire on the exact gain.
    const { painted, raw } = runLive(JITTER);
    expect(spread(painted)).toBeLessThan(spread(raw) / 4);
  });

  it("keeps the data at a steady place in the window", () => {
    // The other half: a clock corrected only at the extremes is free to
    // wander anywhere inside that tolerance, so the trace's leading edge
    // drifts around in the window and reads as "not keeping up". On a
    // live bus the offset must decay toward zero and stay there.
    const { gap } = runLive(JITTER);
    const settled = gap.slice(10);
    for (const g of settled) expect(Math.abs(g)).toBeLessThan(0.05);
  });

  it("never strands the window ahead of the data", () => {
    // The half-empty-plot bug: zoomed to ~1.5 s, a lead of even a few
    // hundred ms is a visible chunk of blank plot. Nothing — burst,
    // stall, or resume — may leave a lead that large standing.
    const stalls = [0, 0, 0.3, 0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const { gap } = runLive(stalls.map((s, i) => (i % 3 === 0 ? -s : s)));
    for (const g of gap.slice(6)) expect(g).toBeLessThan(0.15);
  });

  it("holds the window's edge behind the data when a target lag is set", () => {
    // The leading-edge dropout: with no lag the window's right edge
    // converges onto the newest sample, so the strip covering the time
    // since the last fetch is empty and refills each fetch. A lag keeps
    // the trace running past the right edge, so the plot is always full.
    const LAGGED = { ...TUNING, targetLagSeconds: 0.15 };
    let edge: LiveEdge | null = null;
    let ext = 100;
    const gaps: number[] = [];
    for (let k = 0; k < 30; k++) {
      const nowMs = 1000 + k * 66;
      ext += 0.066 + JITTER[k % JITTER.length];
      edge = adv(edge, ext, nowMs, LAGGED);
      gaps.push(liveEdgeAt(edge, nowMs) - ext);
    }
    // Settled behind the data, and never once ahead of it.
    for (const g of gaps.slice(10)) {
      expect(g).toBeLessThan(0);
      expect(g).toBeGreaterThan(-0.35);
    }
  });

  it("never moves backwards while the data edge only grows", () => {
    let edge: LiveEdge | null = null;
    let prev = -Infinity;
    let ext = 10;
    for (let k = 0; k < 60; k++) {
      const nowMs = 1000 + k * 16;
      ext += k % 4 === 0 ? 0.09 : 0; // long stalls, then a lurch
      edge = adv(edge, ext, nowMs);
      const v = liveEdgeAt(edge, nowMs);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("comes to rest on the newest frame once the data edge has stopped", () => {
    // Disconnect with the trace still running: nothing stops the trace,
    // so the resample loop keeps ticking and keeps handing the clock
    // the same live edge. Where the prediction is allowed to run to is
    // therefore exactly where the plot stops scrolling.
    //
    // It may coast the lag it was tracking behind — the prediction
    // between fetches is what keeps the motion smooth, and "no new
    // data" also describes an extra plot area reporting the same tick —
    // and must then hold *exactly*, on the last frame. Ceiling the
    // prediction with `maxLagSeconds` instead (the tolerance for a
    // clock that has fallen *behind*) let it keep scrolling at
    // real-time rate for that whole budget and come to rest out past
    // its own data.
    const LAGGED = { ...TUNING, targetLagSeconds: 0.3 };
    let edge = adv(null, 10, 1000, LAGGED);
    // Tracking behind the newest frame, as the target lag asks.
    expect(liveEdgeAt(edge, 1000)).toBeCloseTo(9.7, 9);
    for (let k = 1; k < 200; k++) edge = adv(edge, 10, 1000 + k * 66, LAGGED);
    const held = liveEdgeAt(edge, 1000 + 199 * 66);
    // Coasted the lag, and no further: the window rests with the last
    // frame on its right edge, not in the blank strip past it.
    expect(held).toBeCloseTo(10, 9);
    // ...and it stays there, however long the dead stream is polled.
    for (let k = 200; k < 400; k++) edge = adv(edge, 10, 1000 + k * 66, LAGGED);
    expect(liveEdgeAt(edge, 1000 + 399 * 66)).toBeCloseTo(held, 9);
  });

  it("still advances smoothly once data resumes", () => {
    // The ceiling must not wedge the window: after a quiet spell, new
    // data has to pull it forward and re-lock onto the live edge.
    let edge = adv(null, 10, 1000);
    for (let k = 1; k < 20; k++) edge = adv(edge, 10, 1000 + k * 66);
    const stalled = liveEdgeAt(edge, 1000 + 19 * 66);
    let ext = 10;
    for (let k = 20; k < 60; k++) {
      ext += 0.066;
      edge = adv(edge, ext, 1000 + k * 66);
    }
    const endMs = 1000 + 59 * 66;
    expect(liveEdgeAt(edge, endMs)).toBeGreaterThan(stalled);
    // Re-locked onto the data — not left trailing, not stuck at the cap.
    expect(liveEdgeAt(edge, endMs)).toBeCloseTo(ext, 1);
  });

  it("catches up when the clock has fallen behind the data", () => {
    // Backgrounded tab / a stalled resample loop: resync instead of
    // crawling forward from far behind.
    let edge = adv(null, 10, 1000);
    edge = adv(edge, 30, 1100); // data is 20 s ahead of a 0.1 s clock step
    expect(liveEdgeAt(edge, 1100)).toBeCloseTo(30);
  });

  it("resyncs hard when the capture re-anchors backwards", () => {
    // Buffer clear: the data edge genuinely moves back.
    let edge = adv(null, 500, 1000);
    edge = adv(edge, 3, 1016);
    expect(liveEdgeAt(edge, 1016)).toBeCloseTo(3);
  });
});

describe("followXWindow", () => {
  it("slides a trailing default-width window on a running follow-live trace", () => {
    expect(followXWindow(true, true, null, null, 579, DEFAULT, 0)).toEqual({ min: 569, max: 579 });
  });

  it("keeps the user's zoom width while following a running trace", () => {
    // The user zoomed to a 30 s wide window; live edge now 579. The
    // width is passed in on its own — the panel keeps it in a ref only
    // gestures write, so a programmatic slide can't become "the width
    // the user chose" (`PlotPanel.userXWidthRef`).
    expect(followXWindow(true, true, 30, 130, 579, DEFAULT, 0)).toEqual({ min: 549, max: 579 });
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

  it("keeps a chosen zoom width when the capture is shorter than it", () => {
    // Reconnecting restarts the session, so the capture is briefly much
    // shorter than the window. Fitting to the data there doesn't just
    // look wrong — the width is only ever remembered as the current
    // window's span, so the user's zoom is destroyed rather than
    // restored once data catches up.
    expect(followXWindow(true, true, 30, 130, 2, DEFAULT, 0)).toEqual({ min: 0, max: 30 });
    // Once the capture outgrows the width, it slides normally.
    expect(followXWindow(true, true, 30, 130, 90, DEFAULT, 0)).toEqual({ min: 60, max: 90 });
  });

  it("refuses to produce an inverted or empty window", () => {
    // Observed on connect: a just-started session had ext 0.8 and a
    // window start of 0.8, and a live edge tracking 0.3 s behind the
    // newest frame landed at 0.5 — before the start. That produced
    // {min: 0.8, max: 0.5}, which uPlot normalised to [0.5, 0.8]; the
    // normalised value no longer matched what the panel had recorded,
    // so the echo read as a user pan, dropped follow-live, and left the
    // window exactly as wide as the lag.
    expect(followXWindow(true, true, null, null, 0.5, DEFAULT, 0.8)).toBeNull();
    // Degenerate (zero-width) is refused too — nothing useful to show.
    expect(followXWindow(true, true, null, null, 0.8, DEFAULT, 0.8)).toBeNull();
    // Once the capture outgrows the start, it slides normally again.
    expect(followXWindow(true, true, null, null, 5, DEFAULT, 0.8)).toEqual({ min: 0.8, max: 5 });
    // With a chosen width the window can't invert at all: `max` comes
    // from `min + width`, never from a live edge that sits behind it.
    expect(followXWindow(true, true, 30, 130, 0.5, DEFAULT, 0.8)).toEqual({ min: 0.8, max: 30.8 });
  });

  it("leaves a zoomed stopped trace's window untouched", () => {
    expect(followXWindow(true, false, 30, 130, 579, DEFAULT, 30)).toBeNull();
    expect(followXWindow(false, false, 30, 130, 579, DEFAULT, 30)).toBeNull();
  });

  it("fits the full span from the window start when not following and no window is set", () => {
    expect(followXWindow(false, false, null, null, 579, DEFAULT, 30)).toEqual({ min: 30, max: 579 });
  });
});
