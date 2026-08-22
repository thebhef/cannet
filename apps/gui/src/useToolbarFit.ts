/// Measuring a bar, so {@link planToolbarFit} can be asked what fits
/// (ADR 0055).
///
/// {@link planToolbarFit} is pure arithmetic over widths; getting those
/// widths out of the DOM is the fiddly half, and it is the same fiddle
/// on every bar. One hook, not a copy per bar — the same rule the
/// planner itself follows.
///
/// What it gets right, each of which was a bug first:
///
/// - **A dropped item's width is remembered.** An item that is off the
///   bar cannot be measured, and its last measured width is exactly
///   what says whether it would fit again. Forget it and the bar either
///   never puts anything back or flaps between two arrangements.
/// - **The gap is part of an item's cost.** A row laid out with
///   `column-gap` charges for the space in front of every item after
///   the first; planning without it fits one item too many.
/// - **What never gives way is subtracted, not planned.** A lead
///   cluster is not a run whose items might drop — it is width the
///   runs never had. {@link UseToolbarFitInput.reserve} takes it off
///   the top.
///
/// And one rule the hook cannot enforce, because it lives in the
/// stylesheet: **the bar must not be `overflow: hidden`**. It looks
/// like the companion to `nowrap`, and it makes the bar swallow its own
/// absolutely-positioned overflow menu. Fit comes from removing items,
/// never from clipping them.
///
/// A bar opts an item into measurement by putting the item's key in a
/// `data-toolbar-fit` attribute on the element whose width is the
/// item's cost; the overflow control uses the key
/// {@link TOOLBAR_FIT_OVERFLOW_KEY}. The hook re-measures after every
/// render (content changes width as much as the window does) and
/// whenever the bar itself is resized.

import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";

import { planToolbarFit, type ToolbarFit } from "./toolbarFit";

/// The attribute a bar marks a measurable item with. Its value is the
/// item's key.
export const TOOLBAR_FIT_ATTR = "data-toolbar-fit";

/// The key the overflow control is measured under. It belongs to no
/// run — it is charged once, by the planner, as soon as anything is
/// inside it.
export const TOOLBAR_FIT_OVERFLOW_KEY = "overflow";

/// One measurable item of a run.
export interface ToolbarFitItem {
  /// Stable across renders, and the value of the item's
  /// `data-toolbar-fit` attribute. Two items must not share one.
  key: string;
  /// Width to assume before this item has ever been measured. Zero —
  /// the default — means "assume it is free", which is right when the
  /// item is on the bar to begin with and so gets measured on the very
  /// first pass.
  fallback?: number;
  /// The cluster this item belongs to, per {@link planToolbarFit}'s
  /// contract: consecutive items sharing an id are one unbreakable
  /// unit.
  cluster?: string;
}

/// One run of a bar, as the hook takes it. The planner's own
/// `ToolbarRun` is this with the widths filled in.
export interface ToolbarFitRun {
  id: string;
  items: readonly ToolbarFitItem[];
  /// Removed items collapse into the `…` menu rather than dropping off
  /// the bar. See {@link planToolbarFit}.
  overflow?: boolean;
}

export interface UseToolbarFitInput {
  /// The runs, in their left-to-right order.
  runs: readonly ToolbarFitRun[];
  /// Width to assume for the overflow control before it has ever been
  /// rendered — it is charged as soon as the first item collapses,
  /// which is before there is one on screen to measure.
  overflowFallback?: number;
  /// Width, in px, that the runs never get: a lead cluster that never
  /// gives way, a notice guaranteed its own space. Read at measure
  /// time, so it may look at refs the caller owns.
  reserve?: () => number;
}

export interface UseToolbarFitResult<E extends HTMLElement> {
  /// Attach to the bar itself — the element whose `clientWidth` is the
  /// room there is, and the root the measured items are looked up
  /// under.
  barRef: MutableRefObject<E | null>;
  /// How many items of each run stay, counted from the left. Before the
  /// first measurement this is everything, so a bar does not flash
  /// empty on mount.
  fit: ToolbarFit;
}

function allKept(runs: readonly ToolbarFitRun[]): ToolbarFit {
  const full: Record<string, number> = {};
  for (const run of runs) full[run.id] = run.items.length;
  return full;
}

function sameFit(a: ToolbarFit, b: ToolbarFit): boolean {
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) return false;
  return keys.every((key) => a[key] === b[key]);
}

export function useToolbarFit<E extends HTMLElement = HTMLDivElement>({
  runs,
  overflowFallback = 0,
  reserve,
}: UseToolbarFitInput): UseToolbarFitResult<E> {
  const barRef = useRef<E | null>(null);
  // Last measured natural width of every item, kept across the renders
  // in which the item is not on screen — a dropped item cannot be
  // measured, and its last width is what says whether it would fit
  // again.
  const widthsRef = useRef(new Map<string, number>());
  const [fit, setFit] = useState<ToolbarFit>(() => allKept(runs));

  const measure = useCallback(() => {
    const bar = barRef.current;
    if (bar === null) return;
    const widths = widthsRef.current;
    for (const el of bar.querySelectorAll<HTMLElement>(`[${TOOLBAR_FIT_ATTR}]`)) {
      widths.set(el.dataset.toolbarFit as string, el.offsetWidth);
    }
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    const width = (key: string, fallback: number) => {
      const w = widths.get(key);
      return (w === undefined || w === 0 ? fallback : w) + gap;
    };
    const next = planToolbarFit({
      available: bar.clientWidth - (reserve?.() ?? 0),
      runs: runs.map((run) => ({
        id: run.id,
        widths: run.items.map((item) => width(item.key, item.fallback ?? 0)),
        clusters: run.items.some((item) => item.cluster !== undefined)
          ? run.items.map((item) => item.cluster)
          : undefined,
        overflow: run.overflow,
      })),
      overflowWidth: width(TOOLBAR_FIT_OVERFLOW_KEY, overflowFallback),
    });
    setFit((prev) => (sameFit(prev, next) ? prev : next));
  }, [runs, overflowFallback, reserve]);

  // Re-measure after every render — content changes width as much as
  // the window does — and whenever the bar itself is resized. The
  // observer is set up once and reaches the current measurement through
  // a ref, so a re-rendering bar does not churn observers.
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useLayoutEffect(() => {
    measureRef.current();
  });
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureRef.current());
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  return { barRef, fit };
}
