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
//! ([`crate::signal_cache::SignalCacheStore::bus_error_episodes`]), whose
//! level-0 sample for the `n`th error on the bus is `(its time, n)`. It is
//! folded one sample at a time (`EpisodeList::push`), so the live edge
//! appends without rescanning, and it is **bounded by capture time ÷
//! gap**: two episodes' first errors are at least a gap apart.
//!
//! This module is the pure part — the fold and the newest-first paging.
//! Where the list lives, how it is caught up and when it is rebuilt is
//! the signal cache's.

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

/// Rows `[offset, offset + limit)` of the **newest-first** merge of
/// several buses' episode lists, each `(index into lists, episode)`.
///
/// Newest first by first time, which never moves once an episode exists —
/// only the newest episode's end grows — so an offset names the same row
/// from one serve to the next except as new episodes arrive at the top.
/// Ties on first time go to the lower list index.
///
/// Costs `O(buses × log² episodes + limit × buses)`, whatever the offset:
/// the page's start is located by rank rather than by walking the rows
/// above it.
pub(crate) fn newest_first_page(
    lists: &[&[Episode]],
    offset: usize,
    limit: usize,
) -> Vec<(usize, Episode)> {
    let total: usize = lists.iter().map(|l| l.len()).sum();
    if limit == 0 || offset >= total {
        return Vec::new();
    }
    // How many of each list's newest episodes the page's first row has
    // above it.
    let mut above: Vec<usize> = cut_at(lists, offset);
    let mut page = Vec::with_capacity(limit.min(total - offset));
    while page.len() < limit {
        let mut next: Option<(usize, Episode)> = None;
        for (c, list) in lists.iter().enumerate() {
            let Some(i) = list.len().checked_sub(above[c] + 1) else {
                continue;
            };
            let e = list[i];
            // Strictly newer wins, so an equal first time stays with the
            // lower list index found first.
            if next.is_none_or(|(_, n)| e.first_t > n.first_t) {
                next = Some((c, e));
            }
        }
        let Some((c, e)) = next else { break };
        above[c] += 1;
        page.push((c, e));
    }
    page
}

/// For the row at merged position `offset`, how many of each list's
/// episodes precede it in the newest-first order.
fn cut_at(lists: &[&[Episode]], offset: usize) -> Vec<usize> {
    for (b, list) in lists.iter().enumerate() {
        // Rank falls as the index rises (older rows sit lower), so the
        // first index whose rank is at most `offset` is the only
        // candidate in this list.
        let mut lo = 0;
        let mut hi = list.len();
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if rank(lists, b, mid) <= offset {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        if lo < list.len() && rank(lists, b, lo) == offset {
            return (0..lists.len())
                .map(|c| {
                    if c == b {
                        list.len() - 1 - lo
                    } else {
                        preceding(lists[c], c, b, list[lo].first_t)
                    }
                })
                .collect();
        }
    }
    unreachable!("every position below the total is some row's rank")
}

/// The merged newest-first position of `lists[b][j]`.
fn rank(lists: &[&[Episode]], b: usize, j: usize) -> usize {
    let t = lists[b][j].first_t;
    let own = lists[b].len() - 1 - j;
    own + lists
        .iter()
        .enumerate()
        .filter(|&(c, _)| c != b)
        .map(|(c, list)| preceding(list, c, b, t))
        .sum::<usize>()
}

/// How many of list `c`'s episodes precede a row of list `b` whose first
/// time is `t`: the newer ones, and the equally new ones when `c` is the
/// lower index.
fn preceding(list: &[Episode], c: usize, b: usize, t: f64) -> usize {
    let older = if c < b {
        list.partition_point(|e| e.first_t < t)
    } else {
        list.partition_point(|e| e.first_t <= t)
    };
    list.len() - older
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

    fn ep(first_t: f64) -> Episode {
        Episode {
            first_t,
            last_t: first_t,
            first_n: 1,
            last_n: 1,
        }
    }

    /// Every page of the merge, at every offset and a few limits, matches
    /// a whole sort — ties across buses included.
    #[test]
    fn paging_by_offset_matches_a_whole_newest_first_sort() {
        let a: Vec<Episode> = [1.0, 3.0, 5.0, 7.0, 9.0].map(ep).to_vec();
        let b: Vec<Episode> = [2.0, 3.0, 8.0].map(ep).to_vec();
        let c: Vec<Episode> = Vec::new();
        let d: Vec<Episode> = [0.5, 9.0, 10.0, 11.0].map(ep).to_vec();
        let lists: Vec<&[Episode]> = vec![&a, &b, &c, &d];
        let mut whole: Vec<(usize, Episode)> = lists
            .iter()
            .enumerate()
            .flat_map(|(i, l)| l.iter().map(move |e| (i, *e)))
            .collect();
        whole.sort_by(|x, y| y.1.first_t.total_cmp(&x.1.first_t).then(x.0.cmp(&y.0)));
        for offset in 0..=whole.len() + 1 {
            for limit in [0, 1, 3, 100] {
                let want: Vec<(usize, Episode)> =
                    whole.iter().skip(offset).take(limit).copied().collect();
                assert_eq!(
                    newest_first_page(&lists, offset, limit),
                    want,
                    "offset {offset} limit {limit}",
                );
            }
        }
    }
}
