// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useTransientStatus } from "./useTransientStatus";
import type { TransientStatus } from "./statusLine";

const DWELL = 3000;

describe("useTransientStatus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the resting line when there is no transient", () => {
    const emit = vi.fn();
    const { result } = renderHook(() => useTransientStatus("resting", null, emit, DWELL));
    expect(result.current).toBe("resting");
    expect(emit).not.toHaveBeenCalled();
  });

  it("freezes a transient, emits it once, then reverts to resting after the dwell", () => {
    const emit = vi.fn();
    const err: TransientStatus = { text: "Error: boom", level: "error" };
    const { result, rerender } = renderHook(
      ({ t }: { t: TransientStatus | null }) => useTransientStatus("resting", t, emit, DWELL),
      { initialProps: { t: err as TransientStatus | null } },
    );
    // Frozen + emitted once.
    expect(result.current).toBe("Error: boom");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(err);

    // Resting keeps updating underneath while frozen — still shows the notice.
    rerender({ t: err });
    expect(result.current).toBe("Error: boom");
    expect(emit).toHaveBeenCalledTimes(1); // unchanged notice logs once

    // After the dwell it reverts to the (live) resting line.
    act(() => vi.advanceTimersByTime(DWELL));
    expect(result.current).toBe("resting");
  });

  it("an identical notice with a bumped seq re-fires — a repeated attempt is loud", () => {
    // The connect refusals set the same message on every press; the
    // per-attempt `seq` is what makes press two re-freeze the label
    // and re-log, instead of silently changing nothing (owner,
    // 2026-08-28).
    const emit = vi.fn();
    const first: TransientStatus = { text: "Error: unbound", level: "error", seq: 1 };
    const second: TransientStatus = { text: "Error: unbound", level: "error", seq: 2 };
    const { result, rerender } = renderHook(
      ({ t }: { t: TransientStatus | null }) => useTransientStatus("resting", t, emit, DWELL),
      { initialProps: { t: first as TransientStatus | null } },
    );
    expect(emit).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(DWELL));
    expect(result.current).toBe("resting");
    rerender({ t: second });
    expect(result.current).toBe("Error: unbound");
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("a different notice re-fires and re-freezes", () => {
    const emit = vi.fn();
    const a: TransientStatus = { text: "Error: a", level: "error" };
    const b: TransientStatus = { text: "Error: b", level: "error" };
    const { result, rerender } = renderHook(
      ({ t }: { t: TransientStatus | null }) => useTransientStatus("resting", t, emit, DWELL),
      { initialProps: { t: a as TransientStatus | null } },
    );
    expect(emit).toHaveBeenCalledTimes(1);
    rerender({ t: b });
    expect(result.current).toBe("Error: b");
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("still reverts when the transient source clears before the dwell elapses", () => {
    // Regression: a short-lived notice (e.g. "1 connecting." while a
    // session transitions to running within the dwell window) must still
    // flash for its full dwell and then revert. The revert timer must not
    // be cancelled just because the underlying transient went null early.
    const emit = vi.fn();
    const notice: TransientStatus = { text: "1 connecting.", level: "info" };
    const { result, rerender } = renderHook(
      ({ t }: { t: TransientStatus | null }) => useTransientStatus("resting", t, emit, DWELL),
      { initialProps: { t: notice as TransientStatus | null } },
    );
    expect(result.current).toBe("1 connecting.");
    // The source clears before the dwell elapses (session went running).
    rerender({ t: null });
    // Still flashing during the dwell...
    expect(result.current).toBe("1 connecting.");
    // ...but it MUST revert once the dwell elapses.
    act(() => vi.advanceTimersByTime(DWELL));
    expect(result.current).toBe("resting");
  });

  it("an identical notice re-fires only after the bar returns to rest", () => {
    const emit = vi.fn();
    const err: TransientStatus = { text: "Error: boom", level: "error" };
    const { rerender } = renderHook(
      ({ t }: { t: TransientStatus | null }) => useTransientStatus("resting", t, emit, DWELL),
      { initialProps: { t: err as TransientStatus | null } },
    );
    expect(emit).toHaveBeenCalledTimes(1);
    // Back to rest, then the same notice recurs — logs again.
    rerender({ t: null });
    rerender({ t: err });
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
