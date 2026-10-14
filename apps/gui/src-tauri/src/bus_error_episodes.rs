//! Bus-error **episodes**: a bus's error frames grouped into bursts at a
//! gap the reader chooses (ADR 0035).
//!
//! An episode is a run of errors on one bus in which every error follows
//! the one before it by **less than the episode gap**; a silence of at
//! least the gap ends it, and the next error starts a new one. An episode
//! is known by its first and last error — their times and their ordinals
//! on the bus — so it carries its own count, span and rate. Individual
//! errors are not listed: at a fault's frame rate they are thousands a
//! second and say nothing one at a time.
//!
//! The list is derived from the bus's error series in the signal cache
//! ([`crate::signal_cache::SignalCacheStore::with_episodes`]), whose
//! level-0 sample for the `n`th error on the bus is `(its time, n)`. It is
//! folded one sample at a time (`EpisodeList::push`), so the live edge
//! appends without rescanning, and it is **bounded by capture time ÷
//! gap**: two episodes' first errors are at least a gap apart.
//!
//! A plot asks for the episodes that intersect its window at no more
//! markers than fit (`fit_window`). Episodes at gap `2g` are exactly
//! the gap-`g` episodes merged wherever one ends less than `2g` before
//! the next begins — an error inside a gap-`g` episode already follows
//! its predecessor by less than `g` — so a window holding too many is
//! answered by merging its slice of the list at a doubled gap, again
//! until it fits, never by refolding the errors.
//!
//! The Events panel lists every episode among the authored events, by
//! time (`events_page`).
//!
//! This module is the pure part — the fold and the window fit. Where the list lives, how it is caught up and when it
//! is rebuilt is the signal cache's.

use std::ops::Range;

/// One episode: the first and last error of a burst on one bus.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Episode {
    /// The first error's frame time, in absolute seconds.
    pub first_t: f64,
    /// The last error's frame time, in absolute seconds.
    pub last_t: f64,
    /// The first error's ordinal on the bus (1-based: the bus's `n`th
    /// error frame).
    pub first_n: u64,
    /// The last error's ordinal on the bus. A real level-0 sample of the
    /// bus's error series, so it names the episode stably across zoom
    /// levels, restores and gap changes that leave the episode's end
    /// where it was.
    pub last_n: u64,
}

impl Episode {
    /// How many error frames the episode holds.
    #[must_use]
    pub fn count(&self) -> u64 {
        self.last_n - self.first_n + 1
    }

    /// Seconds from the first error to the last; `0` for a single error.
    #[must_use]
    pub fn span(&self) -> f64 {
        self.last_t - self.first_t
    }

    /// Errors per second over the span, or `None` when the span is zero
    /// (a single error, or a burst the clock could not separate) and a
    /// rate would be a division by nothing.
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn rate(&self) -> Option<f64> {
        let span = self.span();
        (span > 0.0).then(|| self.count() as f64 / span)
    }
}

/// One bus's episodes at one gap, oldest first, and how far into the
/// bus's level-0 error series they have been folded.
#[derive(Debug)]
pub(crate) struct EpisodeList {
    gap: f64,
    /// The next level-0 slot of the error series to fold. Absolute, like
    /// the series' own slot numbering, so a front-trim of the series does
    /// not disturb it.
    pub(crate) next_slot: usize,
    episodes: Vec<Episode>,
}

impl EpisodeList {
    /// An empty list at `gap` seconds, folded from the series' first slot.
    pub(crate) fn new(gap: f64) -> Self {
        Self {
            gap,
            next_slot: 0,
            episodes: Vec::new(),
        }
    }

    /// The gap, in seconds, this list was derived at.
    pub(crate) fn gap(&self) -> f64 {
        self.gap
    }

    /// The episodes, oldest first — ascending in both first and last time.
    pub(crate) fn episodes(&self) -> &[Episode] {
        &self.episodes
    }

    /// Fold the `n`th error on the bus, at `t` seconds: it extends the
    /// newest episode when it follows that episode's last error by less
    /// than the gap, and starts a new episode otherwise.
    pub(crate) fn push(&mut self, t: f64, n: u64) {
        match self.episodes.last_mut() {
            Some(e) if t - e.last_t < self.gap => {
                e.last_t = t;
                e.last_n = n;
            }
            _ => self.episodes.push(Episode {
                first_t: t,
                last_t: t,
                first_n: n,
                last_n: n,
            }),
        }
    }

    /// Drop the episodes that ended before `ts_seconds` — the series'
    /// front-trim, followed. An episode the trim cuts through is kept
    /// whole: its first error is gone from the series, but what the
    /// episode says about it is still true.
    pub(crate) fn trim_below(&mut self, ts_seconds: f64) {
        let gone = self.episodes.partition_point(|e| e.last_t < ts_seconds);
        self.episodes.drain(..gone);
    }
}

/// The episodes of `list` that intersect `[from, to]` seconds: those
/// that end at or after `from` and begin at or before `to`. `list` is
/// ascending in both first and last time, so both ends are a binary
/// search.
pub(crate) fn in_window(list: &[Episode], from: f64, to: f64) -> Range<usize> {
    let lo = list.partition_point(|e| e.last_t < from);
    let hi = list.partition_point(|e| e.first_t <= to);
    lo..hi.max(lo)
}

/// One episode covering `a` and the later `b`.
fn merged(a: Episode, b: Episode) -> Episode {
    Episode {
        first_t: a.first_t,
        first_n: a.first_n,
        last_t: b.last_t,
        last_n: b.last_n,
    }
}

/// `episodes` (chronological, folded at a gap no wider than `gap`) as
/// they fold at `gap`: each joins the one before when it begins less
/// than `gap` after that one ended.
fn merge_at(episodes: &[Episode], gap: f64) -> Vec<Episode> {
    let mut out: Vec<Episode> = Vec::with_capacity(episodes.len());
    for &e in episodes {
        match out.last_mut() {
            Some(prev) if e.first_t - prev.last_t < gap => *prev = merged(*prev, e),
            _ => out.push(e),
        }
    }
    out
}

/// Widen `r`, a window's slice of `list`, by the neighbours a fold at
/// `gap` joins to it — so the slice's merge is the whole of every
/// episode at `gap` that intersects the window, not just its part
/// inside. An empty slice between two episodes that join at `gap` takes
/// both: the episode they make spans the window.
fn widen(list: &[Episode], mut r: Range<usize>, gap: f64) -> Range<usize> {
    let joins = |i: usize| list[i].first_t - list[i - 1].last_t < gap;
    if r.is_empty() {
        if r.start == 0 || r.start >= list.len() || !joins(r.start) {
            return r;
        }
        r = r.start - 1..r.start + 1;
    }
    while r.start > 0 && joins(r.start) {
        r.start -= 1;
    }
    while r.end < list.len() && joins(r.end) {
        r.end += 1;
    }
    r
}

/// What [`fit_window`] answers.
#[derive(Debug, PartialEq)]
pub(crate) struct FittedWindow {
    /// `(index into lists, episode)`, chronological by first time, ties
    /// to the lower list index.
    pub(crate) episodes: Vec<(usize, Episode)>,
    /// The gap the episodes are folded at: the lists' own, or that
    /// doubled as often as it took to fit.
    pub(crate) gap: f64,
}

/// The episodes of several buses' lists, each folded at `gap`, that
/// intersect `[from, to]` — at most `max_markers` of them.
///
/// When more intersect than fit, the gap doubles and each bus's slice
/// is merged at the new gap, together with the neighbours outside the
/// window that the wider gap joins to it, until the count fits or every
/// bus is down to one episode (a budget below the bus count cannot be
/// met, and is answered one episode a bus). The answer at a doubled gap
/// equals a fold of the errors at that gap, restricted to the window.
///
/// Costs `O(log n)` per bus to find the window, then `O(slice)` per
/// doubling — at most `log2(window span ÷ gap)` of them.
pub(crate) fn fit_window(
    lists: &[&[Episode]],
    gap: f64,
    from: f64,
    to: f64,
    max_markers: usize,
) -> FittedWindow {
    let mut ranges: Vec<Range<usize>> = lists.iter().map(|l| in_window(l, from, to)).collect();
    let mut per_bus: Vec<Vec<Episode>> = lists
        .iter()
        .zip(&ranges)
        .map(|(l, r)| l[r.clone()].to_vec())
        .collect();
    let mut gap = gap;
    while per_bus.iter().map(Vec::len).sum::<usize>() > max_markers
        && per_bus.iter().any(|m| m.len() > 1)
    {
        gap *= 2.0;
        for (b, list) in lists.iter().enumerate() {
            ranges[b] = widen(list, ranges[b].clone(), gap);
            per_bus[b] = merge_at(&list[ranges[b].clone()], gap);
        }
    }
    let mut episodes: Vec<(usize, Episode)> = per_bus
        .into_iter()
        .enumerate()
        .flat_map(|(b, m)| m.into_iter().map(move |e| (b, e)))
        .collect();
    // Stable, so equal first times keep the lower list index first.
    episodes.sort_by(|x, y| x.1.first_t.total_cmp(&y.1.first_t));
    FittedWindow { episodes, gap }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold(gap: f64, errors: &[f64]) -> Vec<Episode> {
        let mut list = EpisodeList::new(gap);
        for (i, &t) in errors.iter().enumerate() {
            list.push(t, i as u64 + 1);
        }
        list.episodes().to_vec()
    }

    #[test]
    fn errors_closer_than_the_gap_are_one_episode_and_a_gap_of_silence_ends_it() {
        // 0, 1, 2 then silence of exactly 5 (the gap) → a new episode;
        // 7 → 11.5 is under the gap, so it extends.
        let got = fold(5.0, &[0.0, 1.0, 2.0, 7.0, 11.5, 30.0]);
        assert_eq!(
            got,
            vec![
                Episode {
                    first_t: 0.0,
                    last_t: 2.0,
                    first_n: 1,
                    last_n: 3
                },
                Episode {
                    first_t: 7.0,
                    last_t: 11.5,
                    first_n: 4,
                    last_n: 5
                },
                Episode {
                    first_t: 30.0,
                    last_t: 30.0,
                    first_n: 6,
                    last_n: 6
                },
            ],
        );
        assert_eq!(got[0].count(), 3);
        assert!((got[1].span() - 4.5).abs() < 1e-12);
        assert!((got[1].rate().unwrap() - 2.0 / 4.5).abs() < 1e-12);
        assert_eq!(got[2].rate(), None, "a single error has no rate");
    }

    #[test]
    fn a_silence_just_under_the_gap_does_not_split() {
        let got = fold(1.0, &[10.0, 10.999, 11.998]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].count(), 3);
    }

    #[test]
    fn trimming_drops_the_episodes_that_ended_before_the_mark() {
        let mut list = EpisodeList::new(1.0);
        for (i, t) in [0.0, 0.5, 5.0, 5.5, 10.0].into_iter().enumerate() {
            list.push(t, i as u64 + 1);
        }
        list.trim_below(5.2);
        let firsts: Vec<f64> = list.episodes().iter().map(|e| e.first_t).collect();
        assert_eq!(
            firsts,
            vec![5.0, 10.0],
            "the cut-through episode stays whole"
        );
    }

    #[test]
    fn the_window_is_the_episodes_that_intersect_it() {
        // [0,1] [3,4] [6,7] [9,10]
        let list: Vec<Episode> = [0.0, 3.0, 6.0, 9.0]
            .map(|t| Episode {
                first_t: t,
                last_t: t + 1.0,
                first_n: 1,
                last_n: 1,
            })
            .to_vec();
        assert_eq!(in_window(&list, 3.5, 6.0), 1..3, "touching an end counts");
        assert_eq!(in_window(&list, 1.0, 3.0), 0..2);
        assert_eq!(in_window(&list, 1.5, 2.5), 1..1, "between two: none");
        assert_eq!(in_window(&list, -5.0, 50.0), 0..4);
        assert_eq!(in_window(&list, 11.0, 12.0), 4..4);
        // Every window the search answers matches a linear filter.
        for from in 0..24 {
            for to in from..24 {
                let (from, to) = (f64::from(from) * 0.5, f64::from(to) * 0.5);
                let want: Vec<usize> = (0..list.len())
                    .filter(|&i| list[i].last_t >= from && list[i].first_t <= to)
                    .collect();
                let got: Vec<usize> = in_window(&list, from, to).collect();
                assert_eq!(got, want, "[{from}, {to}]");
            }
        }
    }

    /// A window's slice of the gap-`g` list merged at `2g`, `4g` and
    /// `8g` equals a direct fold of the errors at that gap restricted to
    /// the window — the neighbours outside it that the wider gap joins
    /// included.
    #[test]
    fn merging_at_a_doubled_gap_equals_folding_the_errors_at_it() {
        // Bursts of three errors 0.1 s apart; the silences between them
        // walk through 0.5 .. 9.5 s, so every doubling joins some.
        let mut errors = Vec::new();
        let mut t = 0.0;
        for i in 0..40 {
            for _ in 0..3 {
                errors.push(t);
                t += 0.1;
            }
            t += 0.5 + f64::from(i % 10);
        }
        let base = fold(1.0, &errors);
        for gap in [2.0, 4.0, 8.0] {
            let direct = fold(gap, &errors);
            let mut from = -1.0;
            while from < t {
                let to = from + 7.3;
                let want: Vec<Episode> = direct
                    .iter()
                    .filter(|e| e.last_t >= from && e.first_t <= to)
                    .copied()
                    .collect();
                let slice = widen(&base, in_window(&base, from, to), gap);
                assert_eq!(
                    merge_at(&base[slice], gap),
                    want,
                    "gap {gap} [{from}, {to}]"
                );
                from += 1.3;
            }
        }
    }

    #[test]
    #[allow(clippy::float_cmp)] // a gap is exact: the asked-for one, doubled
    fn a_fifty_thousand_error_burst_is_one_episode() {
        let errors: Vec<f64> = (0..50_000).map(|i| 100.0 + f64::from(i) * 0.0004).collect();
        let list = fold(5.0, &errors);
        let got = fit_window(&[&list], 5.0, 90.0, 130.0, 300);
        assert_eq!(got.gap, 5.0);
        assert_eq!(got.episodes.len(), 1);
        let (_, e) = got.episodes[0];
        assert_eq!((e.first_n, e.last_n, e.count()), (1, 50_000, 50_000));
        assert!((e.span() - 49_999.0 * 0.0004).abs() < 1e-9);
    }

    /// 400 one-second episodes, 2 s apart start to start: at a 300-marker
    /// budget the gap doubles (silences of 1 s join at 2 s) and the answer
    /// is under budget, at the doubled gap, and what a direct fold at that
    /// gap gives.
    #[test]
    #[allow(clippy::float_cmp)] // a gap is exact: the asked-for one, doubled
    fn too_many_episodes_for_the_budget_double_the_gap_until_they_fit() {
        let mut errors = Vec::new();
        for i in 0..400 {
            let start = f64::from(i) * 2.0;
            errors.extend([start, start + 0.5, start + 1.0]);
        }
        let list = fold(1.0, &errors);
        assert_eq!(list.len(), 400);
        let got = fit_window(&[&list], 1.0, 0.0, 800.0, 300);
        assert!(got.episodes.len() <= 300, "{} markers", got.episodes.len());
        assert_eq!(got.gap, 2.0, "one doubling joins every 1 s silence");
        let direct = fold(got.gap, &errors);
        let got_eps: Vec<Episode> = got.episodes.iter().map(|(_, e)| *e).collect();
        assert_eq!(got_eps, direct);
        // Under budget at the lists' own gap, nothing changes.
        let roomy = fit_window(&[&list], 1.0, 0.0, 800.0, 400);
        assert_eq!((roomy.gap, roomy.episodes.len()), (1.0, 400));
    }

    #[test]
    fn a_fit_across_buses_is_chronological_and_stops_at_one_episode_a_bus() {
        let a = fold(1.0, &[0.0, 10.0, 20.0]);
        let b = fold(1.0, &[5.0, 15.0]);
        let got = fit_window(&[&a, &b], 1.0, 0.0, 30.0, 5);
        let order: Vec<(usize, f64)> = got.episodes.iter().map(|(b, e)| (*b, e.first_t)).collect();
        assert_eq!(
            order,
            vec![(0, 0.0), (1, 5.0), (0, 10.0), (1, 15.0), (0, 20.0)]
        );
        // A budget below the bus count cannot be met: one episode a bus.
        let tight = fit_window(&[&a, &b], 1.0, 0.0, 30.0, 1);
        assert_eq!(tight.episodes.len(), 2);
        assert_eq!(tight.episodes[0].1.count(), 3);
        assert_eq!(tight.episodes[1].1.count(), 2);
    }
}
