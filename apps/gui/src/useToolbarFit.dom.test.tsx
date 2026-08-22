// @vitest-environment jsdom
//
// The shared toolbar measurement, driven to widths a browser would have
// to be resized to reach. jsdom does no layout, so every width here is
// supplied: what is under test is the *arithmetic the hook does with a
// measurement*, not the measurement itself. Nothing here can prove the
// hook reads a real rendered box — only a browser can.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useMemo } from "react";

import { useToolbarFit, type ToolbarFitItem } from "./useToolbarFit";

// --- stubbed layout -------------------------------------------------
//
// The bar answers `clientWidth` from `layout.bar`; every item answers
// `offsetWidth` from its own `data-toolbar-fit` key.
const layout: Record<string, number> = {};
let gap = 0;

function sizeOf(el: HTMLElement): number {
  const key = el.dataset.toolbarFit;
  if (key !== undefined) return layout[key] ?? 0;
  if (el.classList.contains("test-bar")) return layout.bar ?? 0;
  return 0;
}

let resizeCallbacks: (() => void)[] = [];

class ControllableResizeObserver {
  constructor(private readonly cb: () => void) {
    resizeCallbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb);
  }
}

/// Set the bar's own width and let it re-measure, the way a window
/// resize would.
function resizeBarTo(width: number): void {
  layout.bar = width;
  act(() => {
    for (const cb of resizeCallbacks) cb();
  });
}

let realGetComputedStyle: typeof window.getComputedStyle;

beforeEach(() => {
  for (const key of Object.keys(layout)) delete layout[key];
  gap = 0;
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
  for (const prop of ["offsetWidth", "clientWidth"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return sizeOf(this);
      },
    });
  }
  // Only the bar's own `column-gap` is consulted; everything else keeps
  // jsdom's answer.
  realGetComputedStyle = window.getComputedStyle;
  vi.stubGlobal("getComputedStyle", (el: Element, pseudo?: string | null) =>
    el instanceof HTMLElement && el.classList.contains("test-bar")
      ? ({ columnGap: `${gap}px` } as CSSStyleDeclaration)
      : realGetComputedStyle.call(window, el, pseudo),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const prop of ["offsetWidth", "clientWidth"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      value: 0,
    });
  }
});

// --- the bar under test ---------------------------------------------

/// Three items, each of which the caller sizes through `layout`.
const KEYS = ["a", "b", "c"] as const;

function Bar({
  fallback = 0,
  reserve,
  overflow = false,
  overflowFallback = 0,
}: {
  fallback?: number;
  reserve?: number;
  overflow?: boolean;
  overflowFallback?: number;
}) {
  const items = useMemo<ToolbarFitItem[]>(() => KEYS.map((key) => ({ key, fallback })), [fallback]);
  const runs = useMemo(() => [{ id: "items", items, overflow }], [items, overflow]);
  const reserveFn = useMemo(() => (reserve === undefined ? undefined : () => reserve), [reserve]);
  const { barRef, fit } = useToolbarFit<HTMLDivElement>({
    runs,
    overflowFallback,
    reserve: reserveFn,
  });
  const kept = fit.items ?? 0;
  return (
    <div className="test-bar" ref={barRef}>
      {KEYS.slice(0, kept).map((key) => (
        <span key={key} data-toolbar-fit={key}>
          {key}
        </span>
      ))}
      {overflow && kept < KEYS.length && (
        <span data-toolbar-fit="overflow" className="test-overflow">
          …
        </span>
      )}
    </div>
  );
}

function shown(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".test-bar > [data-toolbar-fit]"))
    .map((el) => el.dataset.toolbarFit!)
    .filter((key) => key !== "overflow");
}

describe("useToolbarFit", () => {
  it("keeps everything when the bar is roomy", () => {
    for (const key of KEYS) layout[key] = 100;
    layout.bar = 1000;
    render(<Bar />);
    expect(shown()).toEqual(["a", "b", "c"]);
  });

  it("remembers what a dropped item measured, so it can come back", () => {
    // The whole reason there is a width map. A dropped item is not in
    // the DOM, so this render cannot measure it — and if the hook
    // forgets, the only width left is the fallback. Here the fallback
    // is deliberately absurd, so a forgetful hook can never bring the
    // item back and stays stuck at one: the failure is stable, not a
    // flap that settles on the right answer anyway.
    for (const key of KEYS) layout[key] = 100;
    layout.bar = 1000;
    render(<Bar fallback={1000} />);
    expect(shown()).toEqual(["a", "b", "c"]);

    resizeBarTo(150);
    expect(shown()).toEqual(["a"]);

    // 3 × 100 = 300, and nothing on the bar to measure them from.
    resizeBarTo(305);
    expect(shown()).toEqual(["a", "b", "c"]);
  });

  it("charges every item for the gap in front of it", () => {
    // 3 × 100 is 300 and fits in 320; 3 × (100 + 10) is 330 and does
    // not. A bar laid out with `column-gap` really does spend that
    // space, so planning without it fits one item too many.
    for (const key of KEYS) layout[key] = 100;
    gap = 10;
    layout.bar = 320;
    render(<Bar />);
    expect(shown()).toEqual(["a", "b"]);
  });

  it("takes the reserved lead off the top rather than planning it", () => {
    // 330 of bar less a 100-wide lead that never gives way is 230 —
    // two items. Without the subtraction all three would look like
    // they fit.
    for (const key of KEYS) layout[key] = 100;
    layout.bar = 330;
    render(<Bar reserve={100} />);
    expect(shown()).toEqual(["a", "b"]);
  });

  it("charges the overflow control at its measured width once anything collapses", () => {
    for (const key of KEYS) layout[key] = 100;
    layout.overflow = 50;
    layout.bar = 250;
    render(<Bar overflow overflowFallback={50} />);
    // 200 of items + the 50 the control costs.
    expect(shown()).toEqual(["a", "b"]);
    expect(document.querySelector(".test-overflow")).not.toBeNull();

    // A fatter control pushes another item into it.
    layout.overflow = 150;
    resizeBarTo(250);
    expect(shown()).toEqual(["a"]);
  });
});
