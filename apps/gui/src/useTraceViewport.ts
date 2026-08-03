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
import { maxAnchorRow, scaledHeight, visibleRowCount } from "./traceViewport";

export interface TraceViewportScaffold {
  containerRef: RefObject<HTMLDivElement>;
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
): TraceViewportScaffold {
  const containerRef = useRef<HTMLDivElement>(null);
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
  const spacerHeight = scaledHeight(count, viewportHeight);
  const anchorMax = maxAnchorRow(count, viewportHeight);
  const firstVisibleRow =
    anchoredRow == null ? anchorMax : Math.min(anchorMax, Math.max(0, anchoredRow));
  const lastVisibleRow = Math.min(count, firstVisibleRow + rows);

  return { containerRef, viewportHeight, rows, spacerHeight, anchorMax, firstVisibleRow, lastVisibleRow };
}
