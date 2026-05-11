/// Pure geometry for the trace view's scaled-scrollbar virtualization.
///
/// Split out of `TraceView.tsx` so the off-by-one-prone arithmetic
/// (scrollTop ↔ row-index mapping, row stacking) can be unit-tested
/// without a DOM. `TraceView.tsx` owns the React/scroll glue; this
/// module owns the numbers.

/// Pixel height of one trace row.
export const ROW_HEIGHT = 22;

/// Pixel height of a row whose decoded signals are expanded: the
/// message line plus a fixed six lines of signal grid (see `.signals`
/// in `index.css`). Messages with more signals get clipped — tracked
/// in `plans/backlog.md` (signals-on-their-own-lines).
export const EXPANDED_ROW_HEIGHT = ROW_HEIGHT + 18 * 6;

/// Cap on the rendered scroll-container height. Browsers cap CSS
/// dimensions around 17M (Firefox) – 33M (WebKit/Chromium) px; 16M is
/// safely under both. Past ~730k rows the scrollbar represents the
/// trace at a compressed scale (each scrollbar pixel covers several
/// rows); the mouse wheel still resolves finely because it moves
/// scrollTop by a fixed pixel count regardless of the scale.
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
}

/// Build the list of rows to render, stacked from the top of the
/// sticky viewport. Stops at the end of the trace; an expanded row
/// contributes `EXPANDED_ROW_HEIGHT` to the running offset.
export function buildPlacements(
  firstVisibleRow: number,
  count: number,
  rowsToRender: number,
  expanded: ReadonlySet<number>,
): RowPlacement[] {
  const placements: RowPlacement[] = [];
  let top = 0;
  for (let pos = 0; pos < rowsToRender; pos++) {
    const absIdx = firstVisibleRow + pos;
    if (absIdx >= count) break;
    const isExpanded = expanded.has(absIdx);
    placements.push({ posKey: pos, absIdx, top, isExpanded });
    top += isExpanded ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT;
  }
  return placements;
}
