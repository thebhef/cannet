/// What the status bar gives up when it runs out of room.
///
/// The bar is one row and never wraps: a header that grows a second
/// line reflows every panel beneath it, so running out of room is
/// handled by removing things rather than by taking more space. Two
/// different things give way, and they give way differently, because
/// they have different stakes — a hidden number is an inconvenience, a
/// hidden alert is a defect:
///
/// - a **metric** drops off the right of the metric run, and its value
///   is still in the tooltip every metric label carries;
/// - a **pinned chip** collapses off the right of the chip run into the
///   overflow menu, which is badged with the sum of the counts inside
///   it, so something demanding attention can only ever become one
///   click away.
///
/// They alternate: the rightmost metric, then the rightmost chip, then
/// the next metric, and so on, continuing with whichever run still has
/// something in it once the other is empty.
///
/// This is pure arithmetic over measured widths so the policy can be
/// driven to any width in a test rather than only observed at whatever
/// width a browser happened to give.

export type StatusBarRemoval = "metric" | "chip";

/// The order things are given up in, longest bar first. Each entry
/// removes one item from the right of its own run.
export function statusBarRemovalOrder(
  metricCount: number,
  chipCount: number,
): StatusBarRemoval[] {
  const order: StatusBarRemoval[] = [];
  let metrics = metricCount;
  let chips = chipCount;
  let metricTurn = true;
  while (metrics > 0 || chips > 0) {
    if (metricTurn && metrics > 0) {
      metrics -= 1;
      order.push("metric");
    } else if (!metricTurn && chips > 0) {
      chips -= 1;
      order.push("chip");
    } else if (metrics > 0) {
      metrics -= 1;
      order.push("metric");
    } else {
      chips -= 1;
      order.push("chip");
    }
    metricTurn = !metricTurn;
  }
  return order;
}

export interface StatusBarFitInput {
  /// Space the metric run, the chip run and the overflow control may
  /// occupy between them, in px. Zero or less means "not measured yet".
  available: number;
  /// Natural widths of the metrics, in the ruled left-to-right order
  /// (`f/s`, `bus load`, `frames`, `elapsed`, `RAM`, `cache`), each
  /// including the gap that precedes it.
  metricWidths: readonly number[];
  /// Natural widths of the pinned chips, in the ruled left-to-right
  /// order (System messages, Signal mapping, RBS mapping), each
  /// including the gap that precedes it.
  chipWidths: readonly number[];
  /// Width of the overflow control, charged only once a chip is inside
  /// it.
  overflowWidth: number;
}

export interface StatusBarFit {
  /// How many metrics stay, counted from the left.
  metrics: number;
  /// How many chips stay in the bar, counted from the left. The rest
  /// are in the overflow menu.
  chips: number;
}

/// The widest arrangement that fits, or the narrowest one there is when
/// nothing does.
export function planStatusBarFit(input: StatusBarFitInput): StatusBarFit {
  const { available, metricWidths, chipWidths, overflowWidth } = input;
  const full: StatusBarFit = { metrics: metricWidths.length, chips: chipWidths.length };
  // Before the first layout there is no width to read, and a bar that
  // collapsed itself on that would flash empty on every mount.
  if (!(available > 0)) return full;

  const widthOf = (fit: StatusBarFit): number => {
    let width = 0;
    for (let i = 0; i < fit.metrics; i += 1) width += metricWidths[i];
    for (let i = 0; i < fit.chips; i += 1) width += chipWidths[i];
    if (fit.chips < chipWidths.length) width += overflowWidth;
    return width;
  };

  let fit = full;
  if (widthOf(fit) <= available) return fit;
  for (const removal of statusBarRemovalOrder(metricWidths.length, chipWidths.length)) {
    fit =
      removal === "metric"
        ? { metrics: fit.metrics - 1, chips: fit.chips }
        : { metrics: fit.metrics, chips: fit.chips - 1 };
    if (widthOf(fit) <= available) return fit;
  }
  return fit;
}
