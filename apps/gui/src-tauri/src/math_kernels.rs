//! The arithmetic behind [`crate::math_signals`]: the shared timeline
//! operands are resampled onto, and one kernel per function.
//!
//! ## The shared timeline
//!
//! Operands are separate series with separate sample times, so a
//! function of several of them needs one timeline to evaluate on.
//! [`merge_hold`] builds the **union of the operands' sample times**,
//! each operand holding its last value between its own samples — the
//! host analogue of the plot's `mergeSeries` (`plotData.ts`), so a math
//! series and the same signals drawn beside it agree about what was
//! true when.
//!
//! Two rules make that sound for a series that is still growing:
//!
//! - **The watermark.** A block ends at the *earliest* of the
//!   operands' newest sample times. Emitting past it would mean
//!   emitting an output row that a later-arriving sample from a slower
//!   operand belongs *inside* of, and a pyramid's levels have to stay
//!   non-decreasing in time.
//! - **No row before every operand has a value.** A row is emitted only
//!   once every operand has produced at least one sample at or before
//!   it, so a kernel never sees a hole. The one exception is an operand
//!   the caller marks **absent** — never produced, and with nowhere
//!   left to look (a pattern member the capture has never carried): it
//!   is excluded from both rules, and its column carries NaN, which the
//!   set kernels read as "not a member at this row".
//!
//! ## Why the columns are `Vec<f64>`
//!
//! Every pointwise function then runs over **contiguous, aligned
//! slices** — `&[f64]` in, `Vec<f64>` out, one loop, no branch on the
//! operand count inside it. That is what lets the compiler vectorize
//! them; benchmarking put the auto-vectorized form within measurement
//! noise of an explicit SIMD crate, so there is none (see
//! `technology-inventory.md`).
//!
//! ## The five that are not pointwise
//!
//! [`MathFunction::ExpFilter`] is a sequential recurrence, and
//! [`MathFunction::Integration`] an accumulation: both carry state from
//! one sample to the next, which is why they must run over the raw
//! level-0 series. Run over a decimated one, their output would depend
//! on the zoom the caller happened to ask at.
//! [`MathFunction::Duty`] and [`MathFunction::Frequency`] read a
//! trailing window, which they ride as running sums so the per-sample
//! cost stays constant however long the window is.
//! [`MathFunction::Statistic`] reduces the whole capture to one number
//! and so is not computed here at all — see [`statistic`].
//!
//! All four carry their state in [`MathCarry`], which the fill keeps
//! beside the series between blocks.

use std::collections::VecDeque;

use crate::math_signals::{MathFunction, Statistic};
use crate::signal_sampler::SamplePoint;
use crate::units::Affine;

/// The operands resampled onto one timeline: `t[i]` is a sample time
/// and `columns[k][i]` operand `k`'s value there.
///
/// Column-major rather than row-major because the kernels are
/// column-wise: a pointwise function reads one contiguous `&[f64]` per
/// operand, which is the shape that vectorizes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MergedBlock {
    pub t: Vec<f64>,
    pub columns: Vec<Vec<f64>>,
}

impl MergedBlock {
    #[must_use]
    pub fn len(&self) -> usize {
        self.t.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.t.is_empty()
    }
}

/// What one merge consumed and left behind.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Merged {
    pub block: MergedBlock,
    /// How many of each operand's input samples the block consumed —
    /// what the fill adds to its per-operand cursor.
    pub consumed: Vec<usize>,
}

/// Merge `new` — one slice of newly available samples per operand, each
/// non-decreasing in time — onto the operands' shared timeline.
///
/// `held` carries each operand's last value across calls (`None` until
/// it has produced one) and is advanced in place, so consecutive calls
/// over consecutive slices give the same answer as one call over their
/// concatenation.
///
/// Samples strictly after the watermark — the earliest of the
/// operands' newest sample times — are left for the next call. An
/// operand with nothing new pins the watermark at its own last sample,
/// which is the point: a row emitted past it could need a row inserted
/// before it later.
///
/// `carried_watermark` is the newest time each operand has *ever*
/// produced, for the operands whose `new` slice is empty. The fill
/// knows it; this function would otherwise think a quiet operand had
/// ended at the last block.
#[must_use]
pub fn merge_hold(
    new: &[&[SamplePoint]],
    held: &mut Vec<Option<f64>>,
    carried_watermark: &[Option<f64>],
    absent: &[bool],
) -> Merged {
    held.resize(new.len(), None);
    let mut consumed = vec![0usize; new.len()];
    let is_absent = |k: usize| absent.get(k).copied().unwrap_or(false);
    // The block may not run past the earliest operand's newest sample.
    let mut watermark = f64::INFINITY;
    for (k, samples) in new.iter().enumerate() {
        let newest = samples
            .last()
            .map(|s| s.t_seconds)
            .or(carried_watermark.get(k).copied().flatten());
        match newest {
            // An operand marked **absent** — never produced, and its
            // fill has nowhere left to look — is excluded: it neither
            // pins the watermark nor blocks a row. Its column is NaN
            // until it produces (a set kernel skips it; see [`apply`]).
            // An operand that has merely not produced *yet* still
            // blocks everything: a row emitted without it could need a
            // row inserted before it later.
            None if is_absent(k) => {}
            None => return Merged::default(),
            Some(t) => watermark = watermark.min(t),
        }
    }
    // Every operand absent (or none at all): nothing to put on a
    // timeline.
    if watermark == f64::INFINITY {
        return Merged::default();
    }
    let mut cursor = vec![0usize; new.len()];
    let mut block = MergedBlock {
        t: Vec::new(),
        columns: vec![Vec::new(); new.len()],
    };
    loop {
        // The next timestamp on the shared timeline: the earliest
        // unconsumed sample across the operands, within the watermark.
        let mut next = f64::INFINITY;
        let mut any = false;
        for (k, samples) in new.iter().enumerate() {
            if let Some(s) = samples.get(cursor[k]) {
                if s.t_seconds <= watermark && s.t_seconds < next {
                    next = s.t_seconds;
                    any = true;
                }
            }
        }
        if !any {
            break;
        }
        // Every operand's samples *at* this time are folded in — a
        // duplicate timestamp within one operand yields one row, taking
        // the last value, so the merged timeline stays strictly
        // increasing.
        for (k, samples) in new.iter().enumerate() {
            while let Some(s) = samples.get(cursor[k]) {
                if s.t_seconds > next {
                    break;
                }
                held[k] = Some(s.value);
                cursor[k] += 1;
                consumed[k] += 1;
            }
        }
        // A row is emitted only once every *present* operand has a
        // value; before that the row would have a hole no kernel could
        // read. An absent operand's column carries NaN — the set
        // kernels' "not a member at this row" marker.
        if held
            .iter()
            .enumerate()
            .any(|(k, h)| h.is_none() && !is_absent(k))
        {
            continue;
        }
        block.t.push(next);
        for (k, column) in block.columns.iter_mut().enumerate() {
            column.push(held[k].unwrap_or(f64::NAN));
        }
    }
    Merged { block, consumed }
}

/// Apply `affine` to `values` in place — the operand scaling that runs
/// **before** the function, and the output scaling that runs after it
/// ([`crate::math_signals`]).
///
/// The identity returns without touching the slice, which is the
/// overwhelmingly common case: a definition that scales nothing pays one
/// comparison per block, not one multiply per sample. NaN — the marker
/// [`merge_hold`] writes for an absent set member — stays NaN through
/// the multiply, so scaling cannot make an absent member look present.
pub fn scale(values: &mut [f64], affine: Affine) {
    if affine.is_identity() {
        return;
    }
    for v in values {
        *v = affine.apply(*v);
    }
}

/// State a stateful kernel keeps between blocks.
///
/// One struct for every function rather than one per kind: the fill
/// stores exactly one of these per math series and does not care which
/// fields the function it drives happens to read. A function that is
/// purely pointwise leaves all of it untouched.
#[derive(Debug, Clone, Default)]
pub struct MathCarry {
    /// The exponential filter's running output.
    filtered: Option<f64>,
    /// The integrator's accumulator.
    integral: f64,
    /// The previous sample's time and value — what the held-value
    /// integral and the threshold crossing are measured against.
    previous: Option<(f64, f64)>,
    /// Running totals at each retained sample, for the trailing-window
    /// functions: `(t, value, seconds above threshold so far, rising
    /// crossings so far)`.
    ///
    /// Trimmed to the window on every sample, so its length is bounded
    /// by the window's duration times the operand's rate rather than by
    /// the capture — and each sample costs one push, one running-sum
    /// update and an amortized-constant trim, whatever the window is.
    window: VecDeque<(f64, f64, f64, f64)>,
    above_seconds: f64,
    crossings: f64,
}

impl MathCarry {
    /// The per-operand last values [`merge_hold`] holds between blocks.
    /// Kept beside the kernel state because they are the same kind of
    /// thing — what this series remembers about the block before.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

/// Evaluate `function` over one merged block, advancing `carry`.
///
/// The result is index-parallel with `block.t`. A block whose column
/// count does not match the function's arity yields nothing rather than
/// panicking — the definition is the user's, and a set that has lost
/// its last member is a state the editor shows, not a crash.
///
/// [`MathFunction::Statistic`] and [`MathFunction::HLine`] are not
/// evaluated here: neither is a function of a block. See [`statistic`]
/// and [`crate::math_signals::MathFunction::HLine`].
#[must_use]
pub fn apply(function: &MathFunction, block: &MergedBlock, carry: &mut MathCarry) -> Vec<f64> {
    let n = block.len();
    let columns = &block.columns;
    let arity_met = match function {
        MathFunction::Difference => columns.len() == 2,
        MathFunction::HLine { .. } => true,
        MathFunction::Scale { .. }
        | MathFunction::ExpFilter { .. }
        | MathFunction::Integration
        | MathFunction::Duty { .. }
        | MathFunction::Frequency { .. }
        | MathFunction::Statistic { .. }
        | MathFunction::Rms => columns.len() == 1,
        _ => !columns.is_empty(),
    };
    if !arity_met || block.is_empty() {
        return Vec::new();
    }
    // The set kernels treat a NaN cell as "not a member at this row" —
    // the marker [`merge_hold`] writes for an absent operand — rather
    // than letting it poison the fold. `f64::min`/`f64::max` already
    // skip NaN by definition; the accumulating folds skip it
    // explicitly, and the mean divides by each row's present count.
    match function {
        MathFunction::Sum => {
            fold_columns(columns, n, 0.0, |a, b| if b.is_nan() { a } else { a + b })
        }
        MathFunction::Product => {
            fold_columns(columns, n, 1.0, |a, b| if b.is_nan() { a } else { a * b })
        }
        MathFunction::Min => fold_columns(columns, n, f64::INFINITY, f64::min),
        MathFunction::Max => fold_columns(columns, n, f64::NEG_INFINITY, f64::max),
        MathFunction::Average => {
            let mut out = fold_columns(columns, n, 0.0, |a, b| if b.is_nan() { a } else { a + b });
            let counts = present_counts(columns, n);
            for (v, k) in out.iter_mut().zip(&counts) {
                *v /= k;
            }
            out
        }
        MathFunction::Range => {
            let lo = fold_columns(columns, n, f64::INFINITY, f64::min);
            let hi = fold_columns(columns, n, f64::NEG_INFINITY, f64::max);
            hi.iter().zip(&lo).map(|(h, l)| h - l).collect()
        }
        MathFunction::Median => median_of_set(columns, n),
        MathFunction::Difference => {
            let (a, b) = (&columns[0], &columns[1]);
            a.iter().zip(b).map(|(a, b)| a - b).collect()
        }
        MathFunction::Scale { gain, offset } => columns[0]
            .iter()
            .map(|v| gain.mul_add(*v, *offset))
            .collect(),
        MathFunction::Rms => columns[0].iter().map(|v| v.abs()).collect(),
        MathFunction::ExpFilter { tau_seconds } => {
            exp_filter(&block.t, &columns[0], *tau_seconds, carry)
        }
        MathFunction::Integration => integrate(&block.t, &columns[0], carry),
        MathFunction::Duty {
            threshold,
            window_seconds,
        } => windowed(
            &block.t,
            &columns[0],
            *threshold,
            *window_seconds,
            carry,
            true,
        ),
        MathFunction::Frequency {
            threshold,
            window_seconds,
        } => windowed(
            &block.t,
            &columns[0],
            *threshold,
            *window_seconds,
            carry,
            false,
        ),
        // Neither is a function of a block: `hline` has no operands and
        // `statistic` reduces the whole capture. The fill produces both
        // directly.
        MathFunction::HLine { value } => vec![*value; n],
        MathFunction::Statistic { .. } => Vec::new(),
    }
}

/// Reduce the columns pointwise with `f`, starting from `init`.
///
/// The inner loop is one contiguous `&[f64]` against one contiguous
/// accumulator with no bounds check surviving the slice — the shape
/// that auto-vectorizes. Folding column by column rather than row by
/// row is what makes it that shape: a row-wise loop would stride across
/// `columns.len()` separate allocations per output point.
fn fold_columns(
    columns: &[Vec<f64>],
    n: usize,
    init: f64,
    f: impl Fn(f64, f64) -> f64,
) -> Vec<f64> {
    let mut out = vec![init; n];
    for column in columns {
        let column = &column[..n];
        for (o, v) in out.iter_mut().zip(column) {
            *o = f(*o, *v);
        }
    }
    out
}

/// How many of the columns are present (non-NaN) at each row. At least
/// one always is — [`merge_hold`] emits no row otherwise.
fn present_counts(columns: &[Vec<f64>], n: usize) -> Vec<f64> {
    let mut counts = vec![0.0f64; n];
    for column in columns {
        let column = &column[..n];
        for (c, v) in counts.iter_mut().zip(column) {
            if !v.is_nan() {
                *c += 1.0;
            }
        }
    }
    counts
}

/// How many operands a pointwise median sorts on the stack before it
/// falls back to a heap allocation. A set of math signals is a handful
/// of cells or a pack's worth; 32 covers every set anyone has drawn and
/// keeps the per-point k-select allocation-free.
const MEDIAN_STACK: usize = 32;

/// The pointwise median of the set: for each output point, the middle
/// of the operands' values there, or the mean of the two middle ones
/// for an even membership.
///
/// A per-point selection rather than a sort of the whole block, because
/// the set is small (a handful of operands) and the block is long: `k`
/// values are gathered into a fixed buffer, sorted, and read.
fn median_of_set(columns: &[Vec<f64>], n: usize) -> Vec<f64> {
    let k = columns.len();
    let mut stack = [0.0f64; MEDIAN_STACK];
    let mut heap = Vec::new();
    if k > MEDIAN_STACK {
        heap = vec![0.0f64; k];
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let buf: &mut [f64] = if k > MEDIAN_STACK {
            &mut heap
        } else {
            &mut stack[..k]
        };
        for (slot, column) in buf.iter_mut().zip(columns) {
            *slot = column[i];
        }
        // Absent members are NaN ([`merge_hold`]); `total_cmp` sorts
        // (positive) NaN after every number, so the present members are
        // the sorted prefix and the median is taken over them alone.
        buf.sort_unstable_by(f64::total_cmp);
        let p = buf.partition_point(|v| !v.is_nan());
        out.push(if p % 2 == 1 {
            buf[p / 2]
        } else {
            f64::midpoint(buf[p / 2 - 1], buf[p / 2])
        });
    }
    out
}

/// First-order exponential filter over irregular sample times:
/// `y += (x − y)·(1 − e^(−Δt/τ))`.
///
/// The continuous-time form rather than a fixed per-sample coefficient,
/// because a CAN series' sample interval is not fixed: a message that
/// slows down would otherwise be filtered *harder* per unit time, and a
/// burst would be filtered less. The first sample seeds the filter, so
/// the output starts on the data rather than at zero.
fn exp_filter(t: &[f64], x: &[f64], tau_seconds: f64, carry: &mut MathCarry) -> Vec<f64> {
    let mut out = Vec::with_capacity(t.len());
    for (t, x) in t.iter().zip(x) {
        let y = match (carry.filtered, carry.previous) {
            (Some(y), Some((prev_t, _))) => {
                let dt = (t - prev_t).max(0.0);
                let alpha = 1.0 - (-dt / tau_seconds).exp();
                y + (x - y) * alpha
            }
            // The first sample the series has ever seen seeds it.
            _ => *x,
        };
        carry.filtered = Some(y);
        carry.previous = Some((*t, *x));
        out.push(y);
    }
    out
}

/// Running integral of the held signal: over `[t_{i-1}, t_i)` the
/// series held `x_{i-1}`, so the exact integral of what the plot draws
/// is `Σ x_{i-1}·Δt`.
///
/// The left rectangle is not an approximation here — it is the integral
/// of the sample-and-hold series every other view of these samples
/// shows. A trapezoid would integrate a linear interpolation nothing
/// else draws.
fn integrate(t: &[f64], x: &[f64], carry: &mut MathCarry) -> Vec<f64> {
    let mut out = Vec::with_capacity(t.len());
    for (t, x) in t.iter().zip(x) {
        if let Some((prev_t, prev_x)) = carry.previous {
            carry.integral += prev_x * (t - prev_t).max(0.0);
        }
        carry.previous = Some((*t, *x));
        out.push(carry.integral);
    }
    out
}

/// Duty cycle (`duty`) or rising-crossing rate (`!duty`) over the
/// trailing `window_seconds`.
///
/// Both ride **running sums**: seconds spent above the threshold, and
/// rising crossings, each accumulated once per sample and read as a
/// difference across the window. So the per-sample cost is constant in
/// the window length, where a re-scan of the window would be linear in
/// it — and at a five-second window over a 100 Hz signal that is the
/// difference between one subtraction and five hundred.
///
/// The window is clamped to the data: before `window_seconds` of
/// capture exists, the answer is over what there is, so the series
/// starts at a real value instead of a ramp out of zero.
fn windowed(
    t: &[f64],
    x: &[f64],
    threshold: f64,
    window_seconds: f64,
    carry: &mut MathCarry,
    duty: bool,
) -> Vec<f64> {
    let mut out = Vec::with_capacity(t.len());
    for (t, x) in t.iter().zip(x) {
        if let Some((prev_t, prev_x)) = carry.previous {
            let dt = (t - prev_t).max(0.0);
            if prev_x > threshold {
                carry.above_seconds += dt;
            }
            if prev_x <= threshold && *x > threshold {
                carry.crossings += 1.0;
            }
        }
        carry.previous = Some((*t, *x));
        carry
            .window
            .push_back((*t, *x, carry.above_seconds, carry.crossings));
        // Keep exactly one retained sample at or before the window's
        // left edge — it is what the running totals are interpolated
        // from.
        let edge = t - window_seconds;
        while carry.window.len() > 1 && carry.window[1].0 <= edge {
            carry.window.pop_front();
        }
        let (base_t, base_x, base_above, base_crossings) =
            *carry.window.front().expect("just pushed");
        // The left edge, clamped to the oldest sample there is.
        let from = edge.max(base_t);
        let span = t - from;
        if span <= 0.0 {
            // A single sample spans no time; nothing has happened yet.
            out.push(0.0);
            continue;
        }
        if duty {
            // The retained base sample held its value from `base_t`, so
            // the seconds above between `base_t` and `from` are exactly
            // that stretch when the held value was above.
            let skipped = if base_x > threshold {
                from - base_t
            } else {
                0.0
            };
            let above = carry.above_seconds - base_above - skipped;
            out.push(100.0 * (above / span).clamp(0.0, 1.0));
        } else {
            // Crossings are counted at the sample they occur on, so
            // everything after the base sample is inside the window.
            out.push((carry.crossings - base_crossings) / span);
        }
    }
    out
}

/// One statistic over a whole series — [`MathFunction::Statistic`]'s
/// kernel, and the one function that is not computed blockwise.
///
/// `values` is consumed and reordered rather than borrowed: the
/// order-statistics use `select_nth_unstable`, which is linear where a
/// sort is `n log n`, and the caller has no use for the series
/// afterwards.
///
/// Median and percentile share one rule — median *is* the 50th
/// percentile — so the two can never disagree. The rank is
/// nearest-rank over the sorted samples.
#[must_use]
pub fn statistic(mut values: Vec<f64>, statistic: Statistic, percentile: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let n = values.len();
    Some(match statistic {
        Statistic::Min => values.iter().copied().fold(f64::INFINITY, f64::min),
        Statistic::Max => values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        #[allow(clippy::cast_precision_loss)]
        Statistic::Mean => values.iter().sum::<f64>() / n as f64,
        Statistic::Median | Statistic::Percentile => {
            let fraction = if statistic == Statistic::Median {
                0.5
            } else {
                (percentile / 100.0).clamp(0.0, 1.0)
            };
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_precision_loss,
                clippy::cast_sign_loss
            )]
            let rank = (fraction * (n - 1) as f64).round() as usize;
            let rank = rank.min(n - 1);
            *values.select_nth_unstable_by(rank, f64::total_cmp).1
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn points(pairs: &[(f64, f64)]) -> Vec<SamplePoint> {
        pairs
            .iter()
            .map(|&(t_seconds, value)| SamplePoint { t_seconds, value })
            .collect()
    }

    /// Merge whole series in one call — the shape most kernel tests
    /// want, with no carried watermark to think about.
    fn merge(series: &[Vec<SamplePoint>]) -> MergedBlock {
        let refs: Vec<&[SamplePoint]> = series.iter().map(Vec::as_slice).collect();
        let carried = vec![None; series.len()];
        let mut held = Vec::new();
        merge_hold(&refs, &mut held, &carried, &[]).block
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn an_absent_operand_neither_blocks_nor_pins_and_its_column_is_nan() {
        // The pattern-membership case: B has never produced and its
        // fill has nowhere left to look. Strictly it would return no
        // rows at all; marked absent it is excluded — A's rows emit,
        // B's column carries NaN.
        let a = points(&[(0.0, 1.0), (1.0, 2.0)]);
        let mut held = Vec::new();
        let strict = merge_hold(&[&a, &[]], &mut held, &[None, None], &[]);
        assert!(strict.block.is_empty(), "strict: no rows without B");
        let mut held = Vec::new();
        let merged = merge_hold(&[&a, &[]], &mut held, &[None, None], &[false, true]);
        assert_eq!(merged.block.t, vec![0.0, 1.0]);
        assert_eq!(merged.block.columns[0], vec![1.0, 2.0]);
        assert!(merged.block.columns[1].iter().all(|v| v.is_nan()));
        assert_eq!(merged.consumed, vec![2, 0]);
        // The set kernels read the NaN column as "not a member here".
        let mut carry = MathCarry::new();
        assert_eq!(
            apply(&MathFunction::Sum, &merged.block, &mut carry),
            vec![1.0, 2.0]
        );
        assert_eq!(
            apply(&MathFunction::Average, &merged.block, &mut carry),
            vec![1.0, 2.0]
        );
        assert_eq!(
            apply(&MathFunction::Median, &merged.block, &mut carry),
            vec![1.0, 2.0]
        );
        assert_eq!(
            apply(&MathFunction::Range, &merged.block, &mut carry),
            vec![0.0, 0.0]
        );
        assert_eq!(
            apply(&MathFunction::Product, &merged.block, &mut carry),
            vec![1.0, 2.0]
        );
        assert_eq!(
            apply(&MathFunction::Min, &merged.block, &mut carry),
            vec![1.0, 2.0]
        );
        assert_eq!(
            apply(&MathFunction::Max, &merged.block, &mut carry),
            vec![1.0, 2.0]
        );
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn an_absent_operand_joins_when_it_finally_produces() {
        // Round one: B absent, A's rows emit. Round two: B has come
        // alive at a later time — its samples join the timeline in
        // order, and from there it is a full member.
        let a_all = points(&[(0.0, 1.0), (1.0, 2.0), (2.0, 3.0)]);
        let b_late = points(&[(2.0, 10.0)]);
        let mut held = Vec::new();
        let first = merge_hold(
            &[&a_all[..2], &[]],
            &mut held,
            &[None, None],
            &[false, true],
        );
        assert_eq!(first.block.t, vec![0.0, 1.0]);
        let second = merge_hold(
            &[&a_all[2..], &b_late],
            &mut held,
            &[Some(1.0), None],
            &[false, false],
        );
        assert_eq!(second.block.t, vec![2.0]);
        assert_eq!(second.block.columns[0], vec![3.0]);
        assert_eq!(second.block.columns[1], vec![10.0]);
    }

    #[test]
    fn a_wholly_absent_set_yields_nothing() {
        let mut held = Vec::new();
        let merged = merge_hold(&[&[], &[]], &mut held, &[None, None], &[true, true]);
        assert!(merged.block.is_empty());
        assert_eq!(merged.consumed.iter().sum::<usize>(), 0);
    }

    fn one(values: &[(f64, f64)]) -> MergedBlock {
        merge(&[points(values)])
    }

    fn run(function: &MathFunction, block: &MergedBlock) -> Vec<f64> {
        apply(function, block, &mut MathCarry::new())
    }

    fn close(a: &[f64], b: &[f64]) {
        assert_eq!(a.len(), b.len(), "{a:?} vs {b:?}");
        for (a, b) in a.iter().zip(b) {
            assert!((a - b).abs() < 1e-9, "{a:?} vs {b:?}");
        }
    }

    #[test]
    fn the_merged_timeline_is_the_union_holding_each_operand() {
        let block = merge(&[
            points(&[(0.0, 1.0), (2.0, 3.0)]),
            points(&[(0.0, 10.0), (1.0, 20.0), (2.0, 30.0)]),
        ]);
        assert_eq!(block.t, [0.0, 1.0, 2.0]);
        // A holds 1.0 across t = 1, where it has no sample of its own.
        assert_eq!(block.columns[0], [1.0, 1.0, 3.0]);
        assert_eq!(block.columns[1], [10.0, 20.0, 30.0]);
    }

    #[test]
    fn no_row_is_emitted_before_every_operand_has_a_value() {
        let block = merge(&[
            points(&[(5.0, 1.0), (6.0, 2.0)]),
            points(&[(0.0, 10.0), (5.0, 20.0), (6.0, 30.0)]),
        ]);
        // B alone is live at t = 0; the series starts where A does.
        assert_eq!(block.t, [5.0, 6.0]);
    }

    #[test]
    fn a_block_stops_at_the_slowest_operands_newest_sample() {
        let block = merge(&[
            points(&[(0.0, 1.0), (1.0, 2.0)]),
            points(&[(0.0, 10.0), (1.0, 20.0), (2.0, 30.0), (3.0, 40.0)]),
        ]);
        // A ends at t = 1, so nothing past it may be emitted: a later
        // A sample at t = 1.5 would have to be inserted before it.
        assert_eq!(block.t, [0.0, 1.0]);
    }

    #[test]
    fn merging_two_blocks_matches_merging_their_concatenation() {
        let a_all = points(&[(0.0, 1.0), (1.0, 2.0), (2.0, 3.0), (3.0, 4.0)]);
        let b_all = points(&[(0.0, 10.0), (1.5, 20.0), (3.0, 30.0)]);
        let whole = merge(&[a_all.clone(), b_all.clone()]);

        let mut held = Vec::new();
        let first = merge_hold(&[&a_all[..2], &b_all[..2]], &mut held, &[None, None], &[]);
        // What the first call left behind is where the second starts.
        let second = merge_hold(
            &[&a_all[first.consumed[0]..], &b_all[first.consumed[1]..]],
            &mut held,
            &[None, None],
            &[],
        );
        let mut t = first.block.t.clone();
        t.extend(&second.block.t);
        assert_eq!(t, whole.t);
        for k in 0..2 {
            let mut column = first.block.columns[k].clone();
            column.extend(&second.block.columns[k]);
            assert_eq!(column, whole.columns[k], "operand {k}");
        }
    }

    #[test]
    fn a_quiet_operand_still_lets_the_other_advance_to_its_own_tip() {
        let a = points(&[(0.0, 1.0), (5.0, 2.0)]);
        let b = points(&[(0.0, 10.0), (1.0, 20.0)]);
        let mut held = Vec::new();
        let first = merge_hold(&[&a, &b], &mut held, &[None, None], &[]);
        assert_eq!(first.block.t, [0.0, 1.0]);
        // B produces nothing new, but the fill knows it reached t = 1,
        // so the block cannot pass it.
        let second = merge_hold(
            &[&a[first.consumed[0]..], &[]],
            &mut held,
            &[None, Some(1.0)],
            &[],
        );
        assert!(second.block.is_empty(), "{:?}", second.block);
    }

    #[test]
    fn duplicate_timestamps_within_an_operand_collapse_to_one_row() {
        let block = merge(&[points(&[(0.0, 1.0), (0.0, 2.0), (1.0, 3.0)])]);
        assert_eq!(block.t, [0.0, 1.0]);
        assert_eq!(block.columns[0], [2.0, 3.0]);
    }

    #[test]
    fn sum_product_and_difference_are_pointwise() {
        let block = merge(&[
            points(&[(0.0, 1.0), (1.0, 2.0)]),
            points(&[(0.0, 10.0), (1.0, 20.0)]),
        ]);
        assert_eq!(run(&MathFunction::Sum, &block), [11.0, 22.0]);
        assert_eq!(run(&MathFunction::Product, &block), [10.0, 40.0]);
        assert_eq!(run(&MathFunction::Difference, &block), [-9.0, -18.0]);
    }

    #[test]
    fn the_set_functions_are_pointwise_over_the_membership() {
        let block = merge(&[
            points(&[(0.0, 1.0), (1.0, 9.0)]),
            points(&[(0.0, 5.0), (1.0, 3.0)]),
            points(&[(0.0, 3.0), (1.0, 6.0)]),
        ]);
        assert_eq!(run(&MathFunction::Min, &block), [1.0, 3.0]);
        assert_eq!(run(&MathFunction::Max, &block), [5.0, 9.0]);
        assert_eq!(run(&MathFunction::Average, &block), [3.0, 6.0]);
        assert_eq!(run(&MathFunction::Median, &block), [3.0, 6.0]);
        assert_eq!(run(&MathFunction::Range, &block), [4.0, 6.0]);
    }

    #[test]
    fn an_even_membership_takes_the_mean_of_the_two_middles() {
        let block = merge(&[
            points(&[(0.0, 1.0)]),
            points(&[(0.0, 2.0)]),
            points(&[(0.0, 4.0)]),
            points(&[(0.0, 8.0)]),
        ]);
        assert_eq!(run(&MathFunction::Median, &block), [3.0]);
    }

    #[test]
    fn a_median_over_more_operands_than_the_stack_buffer_still_works() {
        let series: Vec<Vec<SamplePoint>> = (0..MEDIAN_STACK + 3)
            .map(|k| points(&[(0.0, f64::from(u32::try_from(k).expect("small")))]))
            .collect();
        let block = merge(&series);
        let k = MEDIAN_STACK + 3;
        #[allow(clippy::cast_precision_loss)]
        let expected = (k / 2) as f64;
        assert_eq!(run(&MathFunction::Median, &block), [expected]);
    }

    #[test]
    fn scale_is_gain_times_x_plus_offset_and_rms_is_the_magnitude() {
        let block = one(&[(0.0, -2.0), (1.0, 3.0)]);
        assert_eq!(
            run(
                &MathFunction::Scale {
                    gain: 2.0,
                    offset: 1.0
                },
                &block
            ),
            [-3.0, 7.0]
        );
        assert_eq!(run(&MathFunction::Rms, &block), [2.0, 3.0]);
    }

    #[test]
    fn hline_is_its_value_at_every_point() {
        let block = one(&[(0.0, 99.0), (1.0, -99.0)]);
        assert_eq!(run(&MathFunction::HLine { value: 3.5 }, &block), [3.5, 3.5]);
    }

    #[test]
    fn the_exponential_filter_seeds_on_the_first_sample_and_converges() {
        let block = one(&[(0.0, 0.0), (1.0, 10.0), (2.0, 10.0), (3.0, 10.0)]);
        let out = run(&MathFunction::ExpFilter { tau_seconds: 1.0 }, &block);
        assert!((out[0] - 0.0).abs() < 1e-12, "seeded on the data: {out:?}");
        let alpha = 1.0 - (-1.0f64).exp();
        close(
            &out,
            &[
                0.0,
                10.0 * alpha,
                10.0 * alpha + (10.0 - 10.0 * alpha) * alpha,
                {
                    let y = 10.0 * alpha + (10.0 - 10.0 * alpha) * alpha;
                    y + (10.0 - y) * alpha
                },
            ],
        );
    }

    #[test]
    fn the_exponential_filter_weights_by_elapsed_time_not_by_sample_count() {
        // The same step, reached in one long interval or two short ones,
        // must land in the same place — that is what makes it a time
        // constant rather than a per-sample coefficient.
        let slow = run(
            &MathFunction::ExpFilter { tau_seconds: 1.0 },
            &one(&[(0.0, 0.0), (2.0, 10.0)]),
        );
        let fast = run(
            &MathFunction::ExpFilter { tau_seconds: 1.0 },
            &one(&[(0.0, 0.0), (1.0, 10.0), (2.0, 10.0)]),
        );
        close(&[slow[1]], &[fast[2]]);
    }

    #[test]
    fn the_exponential_filter_is_the_same_across_a_block_boundary() {
        let all = points(&[(0.0, 0.0), (1.0, 10.0), (2.0, 5.0), (3.0, 7.0)]);
        let function = MathFunction::ExpFilter { tau_seconds: 2.0 };
        let whole = run(&function, &merge(std::slice::from_ref(&all)));

        let mut carry = MathCarry::new();
        let mut split = apply(&function, &merge(&[all[..2].to_vec()]), &mut carry);
        // A second block continues the recurrence rather than reseeding.
        let mut held = vec![Some(10.0)];
        let second = merge_hold(&[&all[2..]], &mut held, &[None], &[]);
        split.extend(apply(&function, &second.block, &mut carry));
        close(&split, &whole);
    }

    #[test]
    fn integration_accumulates_the_held_value_over_elapsed_time() {
        // Held at 2 for one second, then at 4 for two.
        let block = one(&[(0.0, 2.0), (1.0, 4.0), (3.0, 0.0)]);
        close(&run(&MathFunction::Integration, &block), &[0.0, 2.0, 10.0]);
    }

    #[test]
    fn integration_carries_across_a_block_boundary() {
        let all = points(&[(0.0, 2.0), (1.0, 4.0), (3.0, 0.0)]);
        let mut carry = MathCarry::new();
        let mut split = apply(
            &MathFunction::Integration,
            &merge(&[all[..2].to_vec()]),
            &mut carry,
        );
        let mut held = vec![Some(4.0)];
        let second = merge_hold(&[&all[2..]], &mut held, &[None], &[]);
        split.extend(apply(&MathFunction::Integration, &second.block, &mut carry));
        close(&split, &[0.0, 2.0, 10.0]);
    }

    #[test]
    fn duty_is_the_percentage_of_the_trailing_window_spent_above() {
        // 1 for one second, then 0 for one second, in a two-second
        // window: half the window was spent above.
        let block = one(&[(0.0, 1.0), (1.0, 0.0), (2.0, 0.0)]);
        let out = run(
            &MathFunction::Duty {
                threshold: 0.5,
                window_seconds: 2.0,
            },
            &block,
        );
        // t=0: no elapsed time yet. t=1: the whole first second was
        // above. t=2: one of the two seconds was.
        close(&out, &[0.0, 100.0, 50.0]);
    }

    #[test]
    fn duty_forgets_what_fell_out_of_the_window() {
        // Above for the first second, then flat below for four.
        let mut pairs = vec![(0.0, 1.0)];
        for i in 1..=8 {
            pairs.push((f64::from(i) * 0.5, 0.0));
        }
        let out = run(
            &MathFunction::Duty {
                threshold: 0.5,
                window_seconds: 2.0,
            },
            &one(&pairs),
        );
        // By t = 4 the second spent above is two seconds out of window.
        assert!(out.last().copied().expect("points") < 1e-9, "{out:?}");
    }

    #[test]
    fn frequency_counts_rising_crossings_per_second_of_window() {
        // Four rising edges in four seconds, window four seconds.
        let mut pairs = Vec::new();
        for i in 0..8 {
            pairs.push((f64::from(i) * 0.5, if i % 2 == 0 { 0.0 } else { 1.0 }));
        }
        let out = run(
            &MathFunction::Frequency {
                threshold: 0.5,
                window_seconds: 4.0,
            },
            &one(&pairs),
        );
        // The last point sees four crossings across the 3.5 s of data
        // that exists, and the window is clamped to what there is.
        let last = out.last().copied().expect("points");
        close(&[last], &[4.0 / 3.5]);
    }

    #[test]
    fn a_windowed_function_is_the_same_across_a_block_boundary() {
        let all: Vec<SamplePoint> = points(
            &(0..12)
                .map(|i| (f64::from(i) * 0.5, if i % 2 == 0 { 0.0 } else { 1.0 }))
                .collect::<Vec<_>>(),
        );
        let function = MathFunction::Duty {
            threshold: 0.5,
            window_seconds: 2.0,
        };
        let whole = run(&function, &merge(std::slice::from_ref(&all)));

        let mut carry = MathCarry::new();
        let mut split = apply(&function, &merge(&[all[..5].to_vec()]), &mut carry);
        let mut held = vec![Some(all[4].value)];
        let second = merge_hold(&[&all[5..]], &mut held, &[None], &[]);
        split.extend(apply(&function, &second.block, &mut carry));
        close(&split, &whole);
    }

    #[test]
    fn statistic_reduces_a_series_to_one_number() {
        let values = vec![4.0, 1.0, 3.0, 2.0, 5.0];
        assert_eq!(statistic(values.clone(), Statistic::Min, 0.0), Some(1.0));
        assert_eq!(statistic(values.clone(), Statistic::Max, 0.0), Some(5.0));
        assert_eq!(statistic(values.clone(), Statistic::Mean, 0.0), Some(3.0));
        assert_eq!(statistic(values.clone(), Statistic::Median, 0.0), Some(3.0));
        assert_eq!(
            statistic(values.clone(), Statistic::Percentile, 100.0),
            Some(5.0)
        );
        assert_eq!(statistic(values, Statistic::Percentile, 0.0), Some(1.0));
    }

    #[test]
    fn a_median_is_the_fiftieth_percentile() {
        let values: Vec<f64> = (1..=10).map(f64::from).collect();
        assert_eq!(
            statistic(values.clone(), Statistic::Median, 0.0),
            statistic(values, Statistic::Percentile, 50.0)
        );
    }

    #[test]
    fn a_statistic_over_nothing_is_nothing() {
        assert_eq!(statistic(Vec::new(), Statistic::Mean, 0.0), None);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn scaling_leaves_the_identity_and_an_absent_member_alone() {
        let original = vec![1.0, -2.0, f64::NAN];
        let mut values = original.clone();
        scale(&mut values, Affine::IDENTITY);
        assert_eq!(values[..2], original[..2]);
        assert!(values[2].is_nan());
        scale(&mut values, Affine::new(2.0, 1.0));
        assert_eq!(values[..2], [3.0, -3.0]);
        // NaN is `merge_hold`'s "not a member at this row" marker, and
        // it has to survive the multiply or scaling would conjure a
        // member out of an absent one.
        assert!(values[2].is_nan());
    }

    #[test]
    fn a_block_whose_arity_is_wrong_yields_nothing_rather_than_panicking() {
        let block = one(&[(0.0, 1.0)]);
        // A difference needs two columns and has one.
        assert!(run(&MathFunction::Difference, &block).is_empty());
        // A set that has lost every member has none.
        let empty = MergedBlock::default();
        assert!(run(&MathFunction::Sum, &empty).is_empty());
    }
}
