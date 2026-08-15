/// Pure geometry for the Database panel's row-list virtualization.
///
/// Split out of `DatabasePanel.tsx` so the offset arithmetic (row stacking,
/// scrollTop ↔ row-index mapping) can be unit-tested without a DOM.
/// `DatabasePanel.tsx` owns the React/scroll glue; this module owns the
/// numbers.
///
/// Unlike the trace table, DBC rows are not all the same height: with
/// the panel's "details" toggle on, a message / signal row carries a
/// detail block whose height is a fixed line height times the number of
/// `dt`/`dd` lines it renders. So the window is derived from a prefix
/// table of row tops rather than a single row height.
///
/// **The constants below are pinned by `index.css`** (`.dbc-row`'s
/// fixed `height`, `.dbc-details-grid`'s zero row-gap and fixed
/// `line-height`, `.dbc-row-details`'s bottom padding + rule). If the
/// stylesheet and these numbers drift, the rendered rows stop lining up
/// with the spacer they are positioned against.

/// Pixel height of one DBC tree row.
export const ROW_HEIGHT = 20;

/// Pixel height of one `dt`/`dd` line inside a row's details block.
export const DETAIL_LINE_HEIGHT = 16;

/// The details block's own vertical chrome: bottom padding plus the
/// separator rule under it.
export const DETAIL_CHROME = 4;

/// Rows rendered above and below the viewport so a brisk scroll doesn't
/// bottom out into blanks before the next paint.
export const OVERSCAN = 8;

/// Viewport height assumed while the container measures zero — before
/// the first `ResizeObserver` tick lands, or when the panel is
/// collapsed. A screenful, so the first paint isn't a single row.
export const ASSUMED_VIEWPORT_HEIGHT = 600;

/// Height of one row given how many detail lines it renders (`0` for a
/// row with no details block: a container row, or any row while the
/// "details" toggle is off).
export function rowHeight(detailLines: number): number {
  if (detailLines <= 0) return ROW_HEIGHT;
  return ROW_HEIGHT + DETAIL_CHROME + detailLines * DETAIL_LINE_HEIGHT;
}

/// Prefix table of row tops: `offsets[i]` is the pixel offset of row
/// `i` from the top of the list, and the final entry is the list's
/// total height. Always `count + 1` long, so `offsets[i + 1]` is row
/// `i`'s bottom edge.
export function buildOffsets(
  count: number,
  detailLinesAt: (index: number) => number,
): number[] {
  const offsets = new Array<number>(count + 1);
  let top = 0;
  for (let i = 0; i < count; i += 1) {
    offsets[i] = top;
    top += rowHeight(detailLinesAt(i));
  }
  offsets[count] = top;
  return offsets;
}

/// Total height of the list — the scroll spacer's height.
export function totalHeight(offsets: readonly number[]): number {
  return offsets[offsets.length - 1] ?? 0;
}

/// Index of the row the pixel offset `y` falls in: the last row whose
/// top is at or above `y`. Binary search over the prefix table.
/// Clamped to the row range at both ends.
function indexAt(offsets: readonly number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 2; // last real row
  if (hi <= 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/// The half-open row range `[first, last)` to render for a given scroll
/// position, padded by [`OVERSCAN`] on each side and clamped to the
/// list.
export function visibleRange(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
): { first: number; last: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { first: 0, last: 0 };
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportHeight);
  return {
    first: Math.max(0, indexAt(offsets, top) - OVERSCAN),
    last: Math.min(count, indexAt(offsets, bottom) + 1 + OVERSCAN),
  };
}

/// The `scrollTop` that brings row `index` fully into view. Returns the
/// current `scrollTop` unchanged when the row already is — so arrowing
/// within the viewport doesn't move the scroll position.
export function scrollToShow(
  offsets: readonly number[],
  index: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const top = offsets[index];
  const bottom = offsets[index + 1];
  if (top === undefined || bottom === undefined) return scrollTop;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight;
  return scrollTop;
}
