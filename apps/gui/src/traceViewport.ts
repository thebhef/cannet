/// Pure geometry for the trace view's scaled-scrollbar virtualization.
///
/// Split out of `TraceView.tsx` so the off-by-one-prone arithmetic
/// (scrollTop ↔ row-index mapping, row stacking) can be unit-tested
/// without a DOM. `TraceView.tsx` owns the React/scroll glue; this
/// module owns the numbers.

/// Pixel height of one trace row.
export const ROW_HEIGHT = 22;

/// Pixel height of one decoded-signal sub-row inside an expanded row.
/// The signal lines set this as an inline style (see `DecodedSignalCell`
/// in `TraceView.tsx` / `ByIdTable.tsx`) so the CSS can't drift from
/// the placement arithmetic.
export const SIGNAL_LINE_HEIGHT = 18;

/// Pixel height of a row whose decoded signals are expanded: the
/// message line plus one sub-row per signal, uncapped. A frame that
/// isn't loaded yet has no signals to count — `0` degrades to a plain
/// row's height.
export function expandedRowHeight(signalCount: number): number {
  return ROW_HEIGHT + signalCount * SIGNAL_LINE_HEIGHT;
}

/// Cap on the rendered scroll-container height. Browsers cap CSS
/// dimensions around 17M (Firefox) – 33M (WebKit/Chromium) px; 16M is
/// safely under both. Past ~730k rows the scrollbar represents the
/// trace at a compressed scale (each scrollbar pixel covers several
/// rows), so the thumb is a coarse seek and a fixed-pixel wheel notch
/// would jump many rows; in that regime `TraceView` stops the native
/// scroll and steps the view by a bounded row count instead (see
/// [`wheelDeltaPx`] / [`maxWheelRows`]).
export const MAX_SCROLL_HEIGHT_PX = 16_000_000;

/// Rows the viewport can show, plus a 2-row pad for the partial rows
/// at the top and bottom edges. Assumes `ROW_HEIGHT` rows; an expanded
/// row in the window eats extra vertical space and pushes the tail
/// rows past the fold (acceptable — expansion is a deliberate, rare
/// action).
export function visibleRowCount(viewportHeight: number): number {
  return Math.ceil(viewportHeight / ROW_HEIGHT) + 2;
}

/// Height of the scroll spacer: the trace at its full extent, but never
/// shorter than the viewport and never taller than the browser cap.
export function scaledHeight(count: number, viewportHeight: number): number {
  return Math.max(
    viewportHeight,
    Math.min(count * ROW_HEIGHT, MAX_SCROLL_HEIGHT_PX),
  );
}

/// The scrollable distance: spacer height minus the viewport, floored
/// at 1 so callers can divide by it unconditionally.
export function maxScrollTop(count: number, viewportHeight: number): number {
  return Math.max(1, scaledHeight(count, viewportHeight) - viewportHeight);
}

/// The largest valid first-visible-row index — the row that sits at the
/// top of the viewport when scrolled all the way to the bottom.
export function maxAnchorRow(count: number, viewportHeight: number): number {
  return Math.max(0, count - visibleRowCount(viewportHeight));
}

/// Map a scrollTop to the first visible row index.
export function rowFromScroll(
  scrollTop: number,
  count: number,
  viewportHeight: number,
): number {
  const anchorMax = maxAnchorRow(count, viewportHeight);
  if (anchorMax === 0) return 0;
  const fraction = Math.min(
    1,
    Math.max(0, scrollTop / maxScrollTop(count, viewportHeight)),
  );
  return Math.min(anchorMax, Math.round(fraction * anchorMax));
}

/// Inverse of `rowFromScroll`: the scrollTop that puts `row` at the top
/// of the viewport. `rowFromScroll(scrollForRow(r, …), …) === r` for
/// any in-range `r`.
export function scrollForRow(
  row: number,
  count: number,
  viewportHeight: number,
): number {
  const anchorMax = maxAnchorRow(count, viewportHeight);
  if (anchorMax === 0) return 0;
  const clamped = Math.min(anchorMax, Math.max(0, row));
  return (clamped / anchorMax) * maxScrollTop(count, viewportHeight);
}

/// Largest number of rows a single wheel event may move the view. A
/// normal mouse notch maps to a handful of rows; this caps pathological
/// inputs — a "scroll one screen at a time" mouse, or a `deltaMode` of
/// pages, or the compressed scaled-scrollbar regime at huge `count` —
/// so one notch can never blow past a screenful of rows. Scales with
/// the viewport so a small panel takes small steps.
export function maxWheelRows(viewportHeight: number): number {
  return Math.max(1, Math.ceil(visibleRowCount(viewportHeight) / 3));
}

/// A wheel event's `deltaY` translated to pixels of content scroll,
/// honouring the three `deltaMode`s: pixels (pass through — the common
/// case), lines (one row's worth each), pages (a viewport's worth).
/// Used to predict how far the browser's native scroll would carry the
/// view so `TraceView` can decide whether to let it through.
export function wheelDeltaPx(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number,
): number {
  if (deltaMode === 1) return deltaY * ROW_HEIGHT;
  if (deltaMode === 2) return deltaY * viewportHeight;
  return deltaY;
}

export interface RowPlacement {
  /// React key: the row's slot in the viewport, not its absolute index,
  /// so the DOM node stays put as the visible window shifts — only its
  /// content changes.
  posKey: number;
  /// Absolute index of the frame this slot displays.
  absIdx: number;
  /// Top offset within the sticky viewport element, in px.
  top: number;
  isExpanded: boolean;
  /// The row's own height, in px — `expandedRowHeight(signals)` when
  /// expanded, `ROW_HEIGHT` otherwise. Carried on the placement so the
  /// row renderer and the stacking arithmetic can't disagree.
  height: number;
}

/// Build the list of rows to render, stacked from the top of the
/// sticky viewport. Stops at the end of the trace; an expanded row
/// contributes [`expandedRowHeight`] of its `signalCount(absIdx)`
/// decoded signals to the running offset (`0` — e.g. an unloaded
/// frame — degrades to a plain row).
export function buildPlacements(
  firstVisibleRow: number,
  count: number,
  rowsToRender: number,
  expanded: ReadonlySet<number>,
  signalCount: (absIdx: number) => number,
): RowPlacement[] {
  const placements: RowPlacement[] = [];
  let top = 0;
  for (let pos = 0; pos < rowsToRender; pos++) {
    const absIdx = firstVisibleRow + pos;
    if (absIdx >= count) break;
    const isExpanded = expanded.has(absIdx);
    const height = isExpanded ? expandedRowHeight(signalCount(absIdx)) : ROW_HEIGHT;
    placements.push({ posKey: pos, absIdx, top, isExpanded, height });
    top += height;
  }
  return placements;
}
