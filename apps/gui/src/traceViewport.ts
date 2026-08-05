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
/// `extraPx` is the height expanded rows add over the plain-row
/// baseline (see [`expandedExtraHeight`]) — without it the scroll range
/// stops short of the expanded content and no scroll position reaches
/// the rows below it.
export function scaledHeight(
  count: number,
  viewportHeight: number,
  extraPx = 0,
): number {
  return Math.max(
    viewportHeight,
    Math.min(count * ROW_HEIGHT + extraPx, MAX_SCROLL_HEIGHT_PX),
  );
}

/// The scrollable distance: spacer height minus the viewport, floored
/// at 1 so callers can divide by it unconditionally.
export function maxScrollTop(
  count: number,
  viewportHeight: number,
  extraPx = 0,
): number {
  return Math.max(
    1,
    scaledHeight(count, viewportHeight, extraPx) - viewportHeight,
  );
}

/// Total height the expanded rows add over the plain-row baseline, for
/// [`scaledHeight`]'s `extraPx`. Walks the whole row range, so callers
/// should skip it when nothing is expanded (the answer is then `0`);
/// `rowHeightAt` reads `ROW_HEIGHT` for rows outside the loaded page, so
/// an expanded row that hasn't landed yet contributes nothing until it
/// does.
///
/// The walk is why this form is only for views bounded by *id* space
/// (the by-id table): its expansion set is keyed by a stable row key,
/// so there is no way to ask which indices are expanded without asking
/// every index. Where the set is keyed by absolute index, use
/// [`expandedExtraHeightOf`] instead — a chronological trace's `count`
/// reaches millions and this would walk all of them on every render.
export function expandedExtraHeight(
  count: number,
  rowHeightAt: (absIdx: number) => number,
): number {
  let extra = 0;
  for (let i = 0; i < count; i++) extra += rowHeightAt(i) - ROW_HEIGHT;
  return extra;
}

/// [`expandedExtraHeight`] for a view whose expansion set is keyed by
/// absolute row index: it iterates the *set*, so the cost is the number
/// of expanded rows rather than the length of the trace. Indices past
/// the end (a trace that shrank under a stale set) contribute nothing.
export function expandedExtraHeightOf(
  expanded: ReadonlySet<number>,
  count: number,
  rowHeightAt: (absIdx: number) => number,
): number {
  let extra = 0;
  for (const i of expanded) {
    if (i < 0 || i >= count) continue;
    extra += rowHeightAt(i) - ROW_HEIGHT;
  }
  return extra;
}

/// The largest valid first-visible-row index: the earliest row whose
/// stack, walked back from the end, still fits in `viewportHeight`.
/// Anchoring here leaves the last row fully inside the viewport. When a
/// single row is taller than the viewport the anchor stops on it rather
/// than past it; the renderer's sticky viewport grows to the row's
/// height so the scroll still reaches its bottom.
///
/// Walks back from the end, so it costs one iteration per row that fits
/// — a viewport's worth, not the whole trace. [`maxAnchorRow`] is the
/// plain-row case.
export function tailAnchorRow(
  count: number,
  viewportHeight: number,
  rowHeightAt: (absIdx: number) => number,
): number {
  let used = 0;
  let i = count - 1;
  for (; i >= 0; i--) {
    const h = rowHeightAt(i);
    if (used + h > viewportHeight) break;
    used += h;
  }
  return Math.max(0, Math.min(count - 1, i + 1));
}

/// Map a scroll position to an anchor row: the scrollbar's fraction of
/// `scrollRange` is the anchor's fraction of `anchorMax`.
export function anchorFromScroll(
  scrollTop: number,
  anchorMax: number,
  scrollRange: number,
): number {
  if (anchorMax === 0) return 0;
  const fraction = Math.min(1, Math.max(0, scrollTop / scrollRange));
  return Math.min(anchorMax, Math.round(fraction * anchorMax));
}

/// The largest valid first-visible-row index — the row that sits at the
/// top of the viewport when scrolled all the way to the bottom — for a
/// view whose rows are all [`ROW_HEIGHT`]: [`tailAnchorRow`]'s plain-row
/// case.
///
/// **Not `count - visibleRowCount(…)`.** That is the render pad, not the
/// anchor bound: [`visibleRowCount`] adds two rows so the partial rows
/// at the viewport's edges are drawn, and subtracting it stops the
/// anchor two whole rows *past* the end — the last two rows then stack
/// below the sticky viewport's fold with no scroll position that
/// reaches them.
export function maxAnchorRow(count: number, viewportHeight: number): number {
  return tailAnchorRow(count, viewportHeight, () => ROW_HEIGHT);
}

/// Map a scrollTop to the first visible row index.
export function rowFromScroll(
  scrollTop: number,
  count: number,
  viewportHeight: number,
): number {
  return anchorFromScroll(
    scrollTop,
    maxAnchorRow(count, viewportHeight),
    maxScrollTop(count, viewportHeight),
  );
}

/// Inverse of [`anchorFromScroll`]: the scroll position that puts
/// `row` at the top of the viewport, given the same bound and range the
/// forward mapping was given. `anchorFromScroll(scrollForAnchor(r, …),
/// …) === r` for any in-range `r`.
///
/// Taking the bound and the range as arguments — rather than deriving
/// them from `count` and the viewport — is what lets a view with
/// variable row heights map both ways through *its* geometry. A view
/// that derives one direction from expanded heights and the other from
/// plain ones sends the bottom of the scrollbar to a row short of the
/// end.
export function scrollForAnchor(
  row: number,
  anchorMax: number,
  scrollRange: number,
): number {
  if (anchorMax === 0) return 0;
  return (Math.min(anchorMax, Math.max(0, row)) / anchorMax) * scrollRange;
}

/// Inverse of `rowFromScroll` for a view whose rows are all
/// [`ROW_HEIGHT`]: the scrollTop that puts `row` at the top of the
/// viewport. `rowFromScroll(scrollForRow(r, …), …) === r` for any
/// in-range `r`.
export function scrollForRow(
  row: number,
  count: number,
  viewportHeight: number,
): number {
  return scrollForAnchor(
    row,
    maxAnchorRow(count, viewportHeight),
    maxScrollTop(count, viewportHeight),
  );
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
