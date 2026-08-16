// @vitest-environment jsdom
//
// The diagnostic machinery is measurement equipment that ships in the
// product binary, so the standard it has to meet is "not scheduled,
// registered or installed at all" on a launch that didn't ask for it —
// not "runs but does nothing". These tests are that standard, written as
// assertions: with diagnostics off nothing counts, nothing observes,
// nothing logs, and the capture entry point isn't on `window`.
//
// The one thing that must survive the gate is the 1 Hz heartbeat — the
// host reads its arrival as proof the renderer's main thread is turning
// (`crash.rs`), so it is a product feature riding the same timer, not
// instrumentation. `diag.heartbeat.test.ts` owns its cadence; here we
// only check the gate didn't take it down.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { invoke } from "@tauri-apps/api/core";

import {
  beginDiagCapture,
  diagCount,
  diagCounts,
  diagGauge,
  diagTime,
  isDiagEnabled,
  setDiagEnabled,
  startDiagReporter,
} from "./diag";

const KEY = "gate.probe";
const counter = () => diagCounts().get(KEY) ?? 0;

/// A stand-in for the browser's `PerformanceObserver` (jsdom has none),
/// recording every construction so "was an observer registered at all?"
/// is an assertable fact rather than an inference.
let observersConstructed = 0;

beforeEach(() => {
  observersConstructed = 0;
  (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = class {
    constructor(_cb: unknown) {
      observersConstructed += 1;
    }
    observe() {}
    disconnect() {}
  };
  // The suite as a whole runs with diagnostics armed (vitest.setup.ts) so
  // the render-count regression guards keep measuring; these tests are
  // about the shipped default, so they start from it.
  setDiagEnabled(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(invoke).mockClear();
  delete (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;
  setDiagEnabled(false);
});

describe("with diagnostics off (the shipped default)", () => {
  it("is off unless something arms it", () => {
    expect(isDiagEnabled()).toBe(false);
  });

  it("counts nothing, so no Map traffic reaches a render path", () => {
    const before = counter();
    for (let i = 0; i < 10; i += 1) diagCount(KEY);
    expect(counter()).toBe(before);
  });

  it("does not fire the burst logger, whose work is inline in diagCount", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Well past BURST_EVERY (5000) — armed, this would log twice.
      for (let i = 0; i < 12_000; i += 1) diagCount(KEY);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("records no gauges, and times nothing around an invoke", async () => {
    diagGauge("gate.gauge", 5);
    const now = vi.spyOn(performance, "now");
    try {
      expect(await diagTime("gate.timed", Promise.resolve(7))).toBe(7);
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("registers no longtask observer and logs no console line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    const stop = startDiagReporter();
    try {
      vi.advanceTimersByTime(3_000);
      expect(observersConstructed).toBe(0);
      expect(log).not.toHaveBeenCalled();
    } finally {
      stop();
      log.mockRestore();
    }
  });

  it("still beats the UI-liveness heartbeat every second", () => {
    vi.useFakeTimers();
    const stop = startDiagReporter();
    try {
      vi.advanceTimersByTime(3_000);
      expect(
        vi.mocked(invoke).mock.calls.filter((c) => c[0] === "report_js_heap").length,
      ).toBe(3);
    } finally {
      stop();
    }
  });

  it("puts no capture entry point on window", () => {
    const stop = startDiagReporter();
    try {
      expect(window.__cannetPerf).toBeUndefined();
    } finally {
      stop();
    }
  });
});

describe("once armed", () => {
  it("counts, gauges, observes long tasks and logs its line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    setDiagEnabled(true);
    const stop = startDiagReporter();
    try {
      const before = counter();
      diagCount(KEY);
      expect(counter()).toBe(before + 1);
      expect(observersConstructed).toBe(1);
      vi.advanceTimersByTime(1_000);
      expect(
        log.mock.calls.some((c) => String(c[0]).includes("[diag] lag=")),
      ).toBe(true);
      expect(window.__cannetPerf).toBeDefined();
    } finally {
      stop();
      log.mockRestore();
    }
  });

  it("takes the observer and the window surface back down when disarmed", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      setDiagEnabled(true);
      expect(window.__cannetPerf).toBeDefined();
      setDiagEnabled(false);
      expect(window.__cannetPerf).toBeUndefined();
      const before = counter();
      diagCount(KEY);
      expect(counter()).toBe(before);
    } finally {
      log.mockRestore();
    }
  });

  it("arms itself when a capture starts, so a report is never empty", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(isDiagEnabled()).toBe(false);
      await beginDiagCapture("manual");
      expect(isDiagEnabled()).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
