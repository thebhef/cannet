// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";

import { SPLASH_MIN_MS, SplashOverlay, useSplashVisible } from "./SplashOverlay";

describe("useSplashVisible", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("holds the splash for the whole floor even when boot settles first", () => {
    const { result } = renderHook(({ settled }) => useSplashVisible(settled), {
      initialProps: { settled: true },
    });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(SPLASH_MIN_MS - 1));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
  });

  it("holds the splash past the floor until boot settles", () => {
    const { result, rerender } = renderHook(({ settled }) => useSplashVisible(settled), {
      initialProps: { settled: false },
    });
    act(() => vi.advanceTimersByTime(SPLASH_MIN_MS * 4));
    expect(result.current).toBe(true);
    rerender({ settled: true });
    expect(result.current).toBe(false);
  });

  it("dismisses at the later of the two when boot settles mid-floor", () => {
    const { result, rerender } = renderHook(({ settled }) => useSplashVisible(settled), {
      initialProps: { settled: false },
    });
    act(() => vi.advanceTimersByTime(SPLASH_MIN_MS / 2));
    rerender({ settled: true });
    // Boot is done, but the floor is not.
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(SPLASH_MIN_MS / 2));
    expect(result.current).toBe(false);
  });
});

describe("SplashOverlay", () => {
  afterEach(cleanup);

  it("carries the safety disclaimer", () => {
    render(<SplashOverlay />);
    expect(
      screen.getByText(/safe state to have its CAN traffic disrupted/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/can make unsafe changes to network traffic/i),
    ).toBeInTheDocument();
  });
});
