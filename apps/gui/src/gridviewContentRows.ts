/// Disclosed content is *rows*, not a blob inside one row.
///
/// A row that discloses content — a trace row's decoded signals — puts
/// those lines in the row space: each gets a stable id, a place in the
/// order, and takes part in the cursor and the selection like any other
/// row (ADR 0044). This module is the arithmetic between the base space
/// a view indexes (frames, by-id snapshot rows) and the space the
/// gridview navigates.
///
/// Pure: no DOM, no React. Everything here is indexes; the ids are
/// [`contentRowId`]'s job.

/// A row that is open, and how many rows it discloses. The runs are
/// **ascending by `index`** — every caller builds them by walking its
/// rows in display order — and the arithmetic below binary-searches
/// them on that assumption.
export interface OpenContentRun {
  /// The disclosing row's index in the base space.
  index: number;
  /// How many rows it discloses. `0` is legal (a row whose content has
  /// not landed yet) and contributes nothing.
  content: number;
}

/// A position in the combined space: a base row, or one of the rows a
/// base row discloses.
export interface ContentRowPos {
  /// The base-space index of the row — of the *disclosing* row when
  /// `content` names one of its lines.
  index: number;
  /// Which of that row's content rows this is, or `null` for the
  /// disclosing row itself.
  content: number | null;
}

/// The base space with every open row's content spliced in after it.
export interface ContentRowSpace {
  /// Rows in the combined space: the base rows plus every disclosed one.
  count: number;
  /// What sits at `gridIndex`, or `null` when it is out of range.
  at(gridIndex: number): ContentRowPos | null;
  /// Where `pos` sits in the combined space, or `-1` when it isn't in
  /// it (a content row of a row that isn't open, or past its last
  /// line).
  indexOf(pos: ContentRowPos): number;
}

/// Splice `open`'s disclosed rows into a base space of `baseCount`
/// rows.
///
/// The runs a caller can supply are the ones it can *locate*, which in
/// a host-paged view is the loaded window — the same rows the cursor
/// and the clicks reach, since an id outside the window resolves to
/// nothing anyway. An open row scrolled out of the window keeps
/// contributing its height through the view's own geometry; it just
/// doesn't shift indexes it isn't near.
export function contentRowSpace(
  baseCount: number,
  open: readonly OpenContentRun[],
): ContentRowSpace {
  // `starts[i]`: where run `i`'s own row sits in the combined space.
  // `before[i]`: how many disclosed rows precede it.
  const starts: number[] = [];
  const before: number[] = [];
  let disclosed = 0;
  for (const run of open) {
    before.push(disclosed);
    starts.push(run.index + disclosed);
    disclosed += run.content;
  }
  const count = baseCount + disclosed;

  /// The last run starting at or before `gridIndex`, or `-1`.
  const runBefore = (gridIndex: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= gridIndex) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };
  /// The run disclosing the base row `index`, or `-1`.
  const runOf = (index: number): number => {
    let lo = 0;
    let hi = open.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (open[mid].index === index) return mid;
      if (open[mid].index < index) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };
  /// The last run strictly above the base row `index`, or `-1`.
  const runAbove = (index: number): number => {
    let lo = 0;
    let hi = open.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (open[mid].index < index) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  return {
    count,
    at(gridIndex) {
      if (gridIndex < 0 || gridIndex >= count) return null;
      const i = runBefore(gridIndex);
      if (i < 0) return { index: gridIndex, content: null };
      const offset = gridIndex - starts[i];
      if (offset === 0) return { index: open[i].index, content: null };
      if (offset <= open[i].content) return { index: open[i].index, content: offset - 1 };
      // Past this run's content: a plain base row, shifted by every
      // disclosed row above it.
      return { index: gridIndex - before[i] - open[i].content, content: null };
    },
    indexOf({ index, content }) {
      if (index < 0 || index >= baseCount) return -1;
      if (content == null) {
        // A base row sits after every row disclosed above it.
        const k = runAbove(index);
        return index + (k < 0 ? 0 : before[k] + open[k].content);
      }
      const i = runOf(index);
      if (i < 0 || content < 0 || content >= open[i].content) return -1;
      return starts[i] + 1 + content;
    },
  };
}

/// The id of a content row, from its disclosing row's id and the
/// content's own name (a decoded signal's name). `/` separates them: a
/// row id is built from bus ids, arbitration ids and frame indexes and
/// a signal name is a database identifier, so neither half can carry
/// one — the id stays unambiguous, and readable in the DOM.
export function contentRowId(rowId: string, name: string): string {
  return `${rowId}/${name}`;
}
