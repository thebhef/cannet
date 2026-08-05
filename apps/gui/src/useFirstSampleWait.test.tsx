// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { FIRST_SAMPLE_INDICATOR_MS, useFirstSampleWait } from "./useFirstSampleWait";

describe("useFirstSampleWait", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("says nothing while a first sample lands inside the gate", () => {
    const { result } = renderHook(() => useFirstSampleWait("a|b"));
    expect(result.current.waiting).toBe(false);
    // The sample lands well before the gate elapses...
    act(() => vi.advanceTimersByTime(FIRST_SAMPLE_INDICATOR_MS - 100));
    act(() => result.current.settled());
    expect(result.current.waiting).toBe(false);
    // ...and the gate that was armed for it must never fire afterwards.
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.waiting).toBe(false);
  });

  it("says so once the first sample has not landed within the gate", () => {
    const { result } = renderHook(() => useFirstSampleWait("a|b"));
    act(() => vi.advanceTimersByTime(FIRST_SAMPLE_INDICATOR_MS - 1));
    expect(result.current.waiting).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.waiting).toBe(true);
  });

  it("stops saying so the moment the first sample lands", () => {
    const { result } = renderHook(() => useFirstSampleWait("a|b"));
    act(() => vi.advanceTimersByTime(FIRST_SAMPLE_INDICATOR_MS));
    expect(result.current.waiting).toBe(true);
    act(() => result.current.settled());
    expect(result.current.waiting).toBe(false);
  });

  it("an area with no signals never arms the gate", () => {
    const { result } = renderHook(() => useFirstSampleWait(null));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.waiting).toBe(false);
  });

  it("a changed signal set re-arms the gate", () => {
    // Every signal add re-anchors the cache and pays a whole-window
    // sample, so the wait is per signal *set*, not per area lifetime.
    const { result, rerender } = renderHook(({ k }: { k: string | null }) => useFirstSampleWait(k), {
      initialProps: { k: "a" as string | null },
    });
    act(() => result.current.settled());
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.waiting).toBe(false);

    rerender({ k: "a|b" });
    expect(result.current.waiting).toBe(false);
    act(() => vi.advanceTimersByTime(FIRST_SAMPLE_INDICATOR_MS));
    expect(result.current.waiting).toBe(true);
  });

  it("emptying the area clears an indication already on screen", () => {
    const { result, rerender } = renderHook(({ k }: { k: string | null }) => useFirstSampleWait(k), {
      initialProps: { k: "a" as string | null },
    });
    act(() => vi.advanceTimersByTime(FIRST_SAMPLE_INDICATOR_MS));
    expect(result.current.waiting).toBe(true);
    rerender({ k: null });
    expect(result.current.waiting).toBe(false);
  });
});
