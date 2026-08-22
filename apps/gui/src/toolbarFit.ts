/// What a toolbar gives up when it runs out of room (ADR 0055).
///
/// One planner for every bar in the app — the header's status bar, the
/// plot and trace toolbars, the panel toolbars — because a second copy
/// is a second set of edge cases to get wrong. A bar is one row and
/// never wraps: a header that grows a second line reflows every panel
/// beneath it, and a panel toolbar that wraps eats the view it sits
/// over. Running out of room is handled by removing things rather than
/// by taking more space.
///
/// A bar is described as one or more **runs** of items, left to right.
/// A run says what happens to the items removed from it, and the two
/// answers have different stakes — a hidden number is an
/// inconvenience, a hidden alert is a defect:
///
/// - a run that does not overflow **drops** its rightmost item, which
///   is right when the value survives somewhere else (the status bar's
///   metrics, whose numbers stay in the tooltip every metric label
///   carries);
/// - a run that does overflow **collapses** its rightmost item into the
///   `…` menu, so something demanding attention can only ever become
///   one click away. The overflow control is charged for once, as soon
///   as anything is inside it.
///
/// Runs give way in turn: the rightmost item of the first run, then the
/// rightmost of the second, and so on, continuing with whichever run
/// still has something in it once the others are empty.
///
/// **A cluster is never split.** Items tied together by a cluster id
/// are one control wearing several hats — the plot toolbar's solo box
/// is a field, its paging and its clear — and half of it on the bar
/// with the other half in the overflow is worse than all of it in
/// either place. A cluster is removed whole, in one step, so what stays
/// always lands on a cluster boundary.
///
/// This is pure arithmetic over measured widths so the policy can be
/// driven to any width in a test rather than only observed at whatever
/// width a browser happened to give.

/// One run of items on a bar.
export interface ToolbarRun {
  /// Names the run in the plan this produces, and in the removal order.
  id: string;
  /// Natural widths of the run's items, in their left-to-right order,
  /// each including the gap that precedes it.
  widths: readonly number[];
  /// Cluster id per item, index-parallel to {@link widths}. Consecutive
  /// items sharing an id are one unbreakable unit; `undefined` is an
  /// item that stands alone. Two spans of the same id with something
  /// else between them are two units — a cluster is a contiguous thing.
  clusters?: readonly (string | undefined)[];
  /// Whether items removed from this run go into the overflow menu —
  /// and so charge its width — rather than simply dropping off the bar.
  overflow?: boolean;
}

/// How many items of each run stay, counted from the left, keyed by the
/// run's id. Everything past that is dropped or in the overflow,
/// according to the run.
export type ToolbarFit = Readonly<Record<string, number>>;

/// How many removable units each run has, for {@link toolbarRemovalOrder}.
export interface ToolbarRunUnits {
  id: string;
  units: number;
}

/// The order runs give way in, longest bar first: one entry per unit,
/// naming the run that gives that unit up. Each entry removes one unit
/// from the right of its own run.
export function toolbarRemovalOrder(runs: readonly ToolbarRunUnits[]): string[] {
  const left = runs.map((r) => r.units);
  const order: string[] = [];
  let turn = 0;
  let remaining = left.reduce((a, b) => a + b, 0);
  while (remaining > 0) {
    // Whichever run's turn it is, skipping the ones already empty.
    while (left[turn] === 0) turn = (turn + 1) % runs.length;
    left[turn] -= 1;
    remaining -= 1;
    order.push(runs[turn].id);
    turn = (turn + 1) % runs.length;
  }
  return order;
}

export interface ToolbarFitInput {
  /// Space the runs and the overflow control may occupy between them,
  /// in px. Zero or less means "not measured yet".
  available: number;
  /// The runs, in their left-to-right order.
  runs: readonly ToolbarRun[];
  /// Width of the overflow control, charged only once something is
  /// inside it.
  overflowWidth: number;
}

/// How many items of a run stay when its first `n` units stay: the
/// index the next unit starts at.
function unitStarts(run: ToolbarRun): number[] {
  const starts: number[] = [];
  for (let i = 0; i < run.widths.length; i += 1) {
    const cluster = run.clusters?.[i];
    // A new unit begins at every item that is not the continuation of
    // the cluster the item before it belongs to.
    if (cluster === undefined || i === 0 || run.clusters?.[i - 1] !== cluster) starts.push(i);
  }
  return starts;
}

/// The widest arrangement that fits, or the narrowest one there is when
/// nothing does.
export function planToolbarFit(input: ToolbarFitInput): ToolbarFit {
  const { available, runs, overflowWidth } = input;
  const full: Record<string, number> = {};
  for (const run of runs) full[run.id] = run.widths.length;
  // Before the first layout there is no width to read, and a bar that
  // collapsed itself on that would flash empty on every mount.
  if (!(available > 0)) return full;

  const widthOf = (fit: Record<string, number>): number => {
    let width = 0;
    let overflowed = false;
    for (const run of runs) {
      const kept = fit[run.id];
      for (let i = 0; i < kept; i += 1) width += run.widths[i];
      if (run.overflow && kept < run.widths.length) overflowed = true;
    }
    return overflowed ? width + overflowWidth : width;
  };

  const starts = new Map(runs.map((run) => [run.id, unitStarts(run)]));
  const unitsLeft = new Map(runs.map((run) => [run.id, starts.get(run.id)!.length]));

  let fit = full;
  if (widthOf(fit) <= available) return fit;
  for (const id of toolbarRemovalOrder(runs.map((r) => ({ id: r.id, units: unitsLeft.get(r.id)! })))) {
    const remaining = unitsLeft.get(id)! - 1;
    unitsLeft.set(id, remaining);
    // Whatever the unit that just went started at is what is left of
    // the run — so a cluster goes whole, never half.
    fit = { ...fit, [id]: starts.get(id)![remaining] };
    if (widthOf(fit) <= available) return fit;
  }
  return fit;
}
