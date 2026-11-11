// @vitest-environment jsdom
//
// An uncaught exception or an unhandled rejection in the webview used to
// reach nowhere but the devtools console, which a field machine never
// has open. These forward each to `cannet.log` at `warn` through the
// host's system-log command — rate-limited, because the failure worth
// logging is often one a render loop repeats a thousand times a second.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { invoke } from "@tauri-apps/api/core";

import {
  FORWARD_MAX_PER_WINDOW,
  forwardWarn,
  installFailureForwarding,
  makeWindowLimiter,
  resetForwardLimits,
} from "./frontendFailures";

const forwarded = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter((c) => c[0] === "gui_emit_system_log")
    .map((c) => c[1] as { level: string; source: string; message: string });

afterEach(() => {
  vi.mocked(invoke).mockClear();
  resetForwardLimits();
});

describe("makeWindowLimiter", () => {
  it("admits a fixed number per window and counts what it held back", () => {
    const admit = makeWindowLimiter(2, 1_000);
    expect(admit(0)).toEqual({ ok: true, suppressed: 0 });
    expect(admit(10)).toEqual({ ok: true, suppressed: 0 });
    expect(admit(20)).toEqual({ ok: false, suppressed: 0 });
    expect(admit(30)).toEqual({ ok: false, suppressed: 0 });
    // A new window opens, and its first admission carries the count of
    // what the last one dropped so the file says a burst happened.
    expect(admit(1_000)).toEqual({ ok: true, suppressed: 2 });
    expect(admit(1_001)).toEqual({ ok: true, suppressed: 0 });
  });
});

describe("failure forwarding", () => {
  it("writes an uncaught error and an unhandled rejection to the host log at warn", () => {
    const stop = installFailureForwarding(window);
    try {
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "boom",
          filename: "App.tsx",
          lineno: 12,
          colno: 3,
          error: new Error("boom"),
        }),
      );
      const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
      rejection.reason = new Error("nope");
      window.dispatchEvent(rejection);
    } finally {
      stop();
    }
    const lines = forwarded();
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.level === "warn" && l.source === "frontend")).toBe(true);
    expect(lines[0].message).toMatch(/^uncaught error: boom \(App\.tsx:12:3\)/);
    expect(lines[1].message).toMatch(/^unhandled rejection: .*nope/);
  });

  it("rate-limits a burst and says how many it dropped", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      for (let i = 0; i < FORWARD_MAX_PER_WINDOW + 5; i++) forwardWarn("error", `e${i}`);
      expect(forwarded()).toHaveLength(FORWARD_MAX_PER_WINDOW);
      now.mockReturnValue(60_000);
      forwardWarn("error", "later");
      expect(forwarded().slice(-1)[0]?.message).toBe("later (5 similar suppressed)");
    } finally {
      now.mockRestore();
    }
  });

  it("keeps a separate budget per kind, so lag reports cannot hide an error", () => {
    for (let i = 0; i < FORWARD_MAX_PER_WINDOW + 3; i++) forwardWarn("lag", "slow");
    forwardWarn("error", "boom");
    expect(forwarded().slice(-1)[0]?.message).toBe("boom");
  });

  it("removes its listeners when stopped", () => {
    installFailureForwarding(window)();
    window.dispatchEvent(new ErrorEvent("error", { message: "after" }));
    expect(forwarded()).toHaveLength(0);
  });
});
