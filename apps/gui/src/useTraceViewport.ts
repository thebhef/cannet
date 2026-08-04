/// Shared virtualization scaffolding for `TraceView` and `ByIdTable`:
/// tracks the container's pixel height via `ResizeObserver` and derives
/// the rows-to-render / scaled spacer height / anchor bounds / visible
/// row window from it, `count`, and the caller's `anchoredRow` (`null`
/// = pinned to the tail, so the anchor is derived rather than held) — the
/// rows/spacer/anchor arithmetic and the resize effect were identical
/// between the two views. Everything past that (scroll handling,
/// auto-scroll, wheel stepping) stays in each view: `TraceView`'s
/// auto-scroll suppression is a genuine behavioural difference from
/// `ByIdTable`'s plain sorted-snapshot scrolling, so it is deliberately
/// not folded in here.

import { type RefObject, useEffect, useRef, useState } from "react";

import { diagCount } from "./diag";
import {
  maxAnchorRow,
  scaledHeight,
  tailAnchorRow,
  visibleRowCount,
} from "./traceViewport";

/// Row heights for a view whose rows are not all `ROW_HEIGHT` — the
/// by-id table, where an expanded row carries a line per decoded
/// signal. Without it the scaffold sizes everything as plain rows, and
/// the pixels the expanded rows add fall past the end of the scroll
/// range.
export interface VariableRowHeights {
  /// Total height the expanded rows add over the plain-row baseline
  /// (`expandedExtraHeight`).
  extraHeight: number;
  /// The rendered height of the row at `absIdx`.
  rowHeightAt: (absIdx: number) => number;
}

/// Mirrors a rows-container's horizontal scroll onto the table's column
/// header, returning the ref to put on the header.
///
/// The header can't live inside the scroll container — it has to stay
/// put while the rows scroll vertically — so nothing else moves it, and
/// once the rows scroll sideways the two come apart by exactly
/// `scrollLeft`. A negative margin rather than a transform: the header
/// hosts the show/hide column menu, which is `position: fixed` at the
/// pointer, and a transformed ancestor would become its containing
/// block. Written straight to the DOM — view geometry, not state, and it
/// has to keep up with the scroll.
export function useHeaderScrollSync(
  containerRef: RefObject<HTMLDivElement>,
): RefObject<HTMLDivElement> {
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => {
      if (headerRef.current) headerRef.current.style.marginLeft = `${-el.scrollLeft}px`;
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    return () => el.removeEventListener("scroll", sync);
  }, [containerRef]);
  return headerRef;
}

export interface TraceViewportScaffold {
  containerRef: RefObject<HTMLDivElement>;
  /// Put this on the table's column header — see [`useHeaderScrollSync`].
  headerRef: RefObject<HTMLDivElement>;
  viewportHeight: number;
  rows: number;
  spacerHeight: number;
  anchorMax: number;
  firstVisibleRow: number;
  lastVisibleRow: number;
}

export function useTraceViewport(
  count: number,
  /// The absolute row to put at the top of the viewport, or `null` for
  /// "pin to the tail" — the anchor is then *derived* from `anchorMax`,
  /// so a caller following the live edge holds no state that has to be
  /// rewritten after every render as the row count grows.
  anchoredRow: number | null,
  /// Diag counter key bumped on every resize-observed update, or
  /// omitted to stay silent (`ByIdTable` has never carried one;
  /// `TraceView` passes `"traceview.resizeObserver"`).
  resizeDiagKey?: string,
  /// Row heights, when the view has rows taller than `ROW_HEIGHT`.
  /// Omitted (the chronological view) every row is a plain row.
  variable?: VariableRowHeights,
): TraceViewportScaffold {
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useHeaderScrollSync(containerRef);
  const [viewportHeight, setViewportHeight] = useState(600);

  // Observe viewport size so the visible-row count tracks resizes.
  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      if (resizeDiagKey) diagCount(resizeDiagKey); // DIAG
      if (containerRef.current) setViewportHeight(containerRef.current.clientHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [resizeDiagKey]);

  const rows = visibleRowCount(viewportHeight);
  const spacerHeight = scaledHeight(count, viewportHeight, variable?.extraHeight ?? 0);
  // With variable heights the bound is the row that puts the *last* row
  // fully in the viewport; `maxAnchorRow`'s two-row pad would leave the
  // tail stacked below the fold with no scroll position that reaches it.
  const anchorMax = variable
    ? tailAnchorRow(count, viewportHeight, variable.rowHeightAt)
    : maxAnchorRow(count, viewportHeight);
  const firstVisibleRow =
    anchoredRow == null ? anchorMax : Math.min(anchorMax, Math.max(0, anchoredRow));
  const lastVisibleRow = Math.min(count, firstVisibleRow + rows);

  return {
    containerRef,
    headerRef,
    viewportHeight,
    rows,
    spacerHeight,
    anchorMax,
    firstVisibleRow,
    lastVisibleRow,
  };
}
