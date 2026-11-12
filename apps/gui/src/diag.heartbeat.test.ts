// @vitest-environment jsdom
//
// The 1 Hz reporter doubles as the host's UI-liveness heartbeat
// (`crash.rs`): it runs on the renderer's main thread, so its arrival is
// the host's only evidence that thread is still turning. That makes its
// cadence a contract, not a detail — in particular it must not be
// conditional on `performance.memory`, which only Chromium `WebView`s
// have.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { invoke } from "@tauri-apps/api/core";

import { startDiagReporter } from "./diag";

const heartbeats = () =>
  vi.mocked(invoke).mock.calls.filter((c) => c[0] === "report_js_heap");

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(invoke).mockClear();
});

describe("the diag reporter's UI heartbeat", () => {
  it("reports in every second even where the JS-heap reading is unavailable", () => {
    // jsdom has no `performance.memory` — the same shape as WebKitGTK and
    // WKWebView. The heap number is then unknown (`0`, which the host
    // reads as "no reading"), but the beat itself must still land, or the
    // frontend-hang watchdog is inert on every non-Chromium host.
    expect(
      (performance as { memory?: unknown }).memory,
      "fixture assumes no performance.memory",
    ).toBeUndefined();
    vi.useFakeTimers();
    const stop = startDiagReporter();
    try {
      vi.advanceTimersByTime(3_000);
      expect(heartbeats().length).toBe(3);
      expect(heartbeats()[0][1]).toEqual({ bytes: 0 });
    } finally {
      stop();
    }
  });

  it("forwards a timer lag of a second or more to the host log, and not less", () => {
    // `--diag` is off on a field machine, so the lag the 1 Hz line
    // prints never reaches `cannet.log` from there. A tick that fires a
    // second or more late is forwarded on its own at `warn`.
    vi.useFakeTimers();
    let t = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => t);
    const stop = startDiagReporter();
    try {
      t = 1_400; // 400 ms late: ordinary jank, not logged
      vi.advanceTimersByTime(1_000);
      t = 3_900; // 1500 ms late
      vi.advanceTimersByTime(1_000);
      const lags = vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === "gui_emit_system_log")
        .map((c) => c[1] as { level: string; message: string });
      expect(lags).toEqual([{ level: "warn", source: "frontend", message: "timer lag 1500 ms" }]);
    } finally {
      stop();
      clock.mockRestore();
    }
  });
});

