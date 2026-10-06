//! Bus-error **episodes**: a bus's error frames grouped into bursts at a
//! gap the reader chooses (ADR 0035), built from the episodes the
//! sidecar reports (ADR 0060).
//!
//! An episode is a run of errors on one bus in which every error follows
//! the one before it by **less than the episode gap**; a silence of at
//! least the gap ends it, and the next error starts a new one. An episode
//! is known by its first and last error — their times and their ordinals
//! on the bus — so it carries its own count, span and rate. Individual
//! errors are not listed: at a fault's frame rate they are thousands a
//! second and say nothing one at a time.
//!
//! **Where the errors come from.** The sidecar counts a bus's error frames
//! into episodes of its own at a 1 s gap and reports each one — its first
//! and latest error, its counts by kind and direction, the error counters
//! — while it is open and once more when it closes (ADR 0060 rule 1).
//! Only the first few error frames of each become trace rows (the
//! error-row cap, rule 2), so the rows cannot be counted for the total;
//! the reports are. `BusErrorReports` folds them per bus: each report
//! contributes the bus's running error total at its first and last error
//! to the bus's **error series** in the signal cache, which therefore
//! still never decreases and still gives an exact count and span between
//! any two of its points. A report for a later episode closes whatever
//! episode the bus still held open, since the sidecar may fold an
//! episode's own closing report into its successor (ADR 0060 rule 3).
//!
//! An imported capture has no sidecar, so its error records go through
//! `EpisodeBuilder` — the sidecar's rule restated over a file: an
//! episode opens at an error and closes after 1 s without one, the first
//! N errors of each become rows and the rest are only counted, and each
//! episode is reported once as it opens and once as it closes. Those
//! reports take the same path into `BusErrorReports` the live ones do,
//! so a file reads as the session that recorded it did — and a file
//! saved before the cap existed, with a row per error frame, reads as
//! episodes plus at most N rows each.
//!
//! **What the views read.** The reader's episodes are folded from the
//! error series ([`crate::signal_cache::SignalCacheStore::with_episodes`]),
//! whose level-0 samples are `(time, the bus's running total)`. The fold
//! runs one sample at a time (`EpisodeList::push`), so the live edge
//! appends without rescanning, and it is **bounded by capture time ÷
//! gap**: two episodes' first errors are at least a gap apart. Because
//! the reader's gap is never finer than the sidecar's 1 s, a reader's
//! episode is a whole number of reported ones, and
//! `BusErrorReports::detail` sums their counts by kind and direction
//! and takes the counters of the last.
//!
//! **What outlives a relaunch.** The series alone holds only the running
//! total, so each reported episode's own record (`ReportedEpisode`:
//! its span, count, kinds — sparse, only those counted — directions and
//! counters) is kept beside the series in the signal cache and persisted
//! in the same manifest row (ADR 0047). A scratch restore starts the
//! report store from them (`BusErrorReports::restore`), all closed, so
//! `detail` answers for a restored capture as it did live.
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
//! This module is the pure part — the fold, the window fit, the report
//! store and the import builder. Where the series lives, how it is caught
//! up and when it is rebuilt is the signal cache's; where the reports come
//! from is the bus-health poll's (`crate::bus_health`) and the import
//! pump's (`crate::session::run_pump`).

use std::collections::BTreeMap;
use std::ops::Range;

use cannet_client::episodes::{BusErrorEpisode, ErrorKindCounts};
use serde::{Deserialize, Serialize};

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

/// How long a bus must be free of error frames before its episode
/// closes — the sidecar's own grain (ADR 0060 rule 1), which the import
/// builder restates so a file reads as the live session did.
pub(crate) const EPISODE_CLOSE_AFTER_NS: u64 = 1_000_000_000;

/// The error-row cap's default: how many error frames of each episode
/// become trace rows when nobody has said otherwise (ADR 0060 rule 2,
/// Vector's precedent).
pub(crate) const DEFAULT_ERROR_ROW_CAP: u32 = 16;

/// A kind of error frame, as ADR 0060 rule 1 names them. Ordered as the
/// rule lists them, which is also the tie-break when two kinds count the
/// same.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ErrorKind {
    Ack,
    Bit,
    Form,
    Stuff,
    Crc,
    Other,
    Unknown,
}

/// An episode's error frames by kind, **sparse**: only the kinds it
/// counted any of. One kind is the usual case — a pulled cable is all
/// `ack` — so the host keeps, persists and serves a map rather than a
/// row of seven counters that are mostly zero.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ErrorKinds(BTreeMap<ErrorKind, u64>);

impl ErrorKind {
    /// The kind's name, as ADR 0060 rule 1 spells it.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Ack => "ack",
            Self::Bit => "bit",
            Self::Form => "form",
            Self::Stuff => "stuff",
            Self::Crc => "crc",
            Self::Other => "other",
            Self::Unknown => "unknown",
        }
    }
}

impl ErrorKinds {
    /// Add `other`'s counts to these, kind by kind.
    fn add(&mut self, other: &Self) {
        for (kind, n) in &other.0 {
            *self.0.entry(*kind).or_insert(0) += n;
        }
    }

    /// Every kind counted, largest first; a tie keeps [`ErrorKind`]'s
    /// order. How the bus-health row and an event's text list them.
    pub(crate) fn largest_first(&self) -> Vec<(ErrorKind, u64)> {
        let mut kinds: Vec<(ErrorKind, u64)> = self.0.iter().map(|(k, n)| (*k, *n)).collect();
        kinds.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        kinds
    }
}

impl From<ErrorKindCounts> for ErrorKinds {
    fn from(k: ErrorKindCounts) -> Self {
        Self(
            [
                (ErrorKind::Ack, k.ack),
                (ErrorKind::Bit, k.bit),
                (ErrorKind::Form, k.form),
                (ErrorKind::Stuff, k.stuff),
                (ErrorKind::Crc, k.crc),
                (ErrorKind::Other, k.other),
                (ErrorKind::Unknown, k.unknown),
            ]
            .into_iter()
            .filter(|(_, n)| *n > 0)
            .collect(),
        )
    }
}

/// One episode as the sidecar reported it, and as the host keeps it: its
/// first and latest error (on the host's timeline), its counts, the
/// counters as of its latest error, and where it starts in the bus's
/// running error total.
///
/// **Persisted with the bus's error series** (ADR 0047): every field but
/// `open` rides the series' manifest row in the pyramid scratch
/// ([`crate::signal_cache::SignalCacheStore::record_bus_error_episode`]),
/// so a capture restored after a relaunch reads the same episode it
/// showed live (ADR 0060 rule 2). `open` is not: nothing is ongoing after
/// a relaunch, so a restored episode is closed. In the manifest's JSON a
/// record is about 150 bytes — a pulled cable's
/// `{"first_ns":…,"last_ns":…,"count":3412,"kinds":{"ack":3412},
/// "tx_count":3412,"rx_count":0,"tec":128,"rec":0,"base":0}` — and a bus
/// holds at most one per second of capture.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ReportedEpisode {
    pub(crate) first_ns: u64,
    pub(crate) last_ns: u64,
    pub(crate) count: u64,
    pub(crate) kinds: ErrorKinds,
    pub(crate) tx_count: u64,
    pub(crate) rx_count: u64,
    pub(crate) tec: u32,
    pub(crate) rec: u32,
    /// Not yet closed: no closing report, and no later episode, has
    /// arrived for it. Never persisted.
    #[serde(skip)]
    pub(crate) open: bool,
    /// The bus's running error total before this episode's first error —
    /// unique per episode on its bus, so it is also the episode's key.
    pub(crate) base: u64,
}

impl ReportedEpisode {
    /// Errors per second over the episode's own span, or `0.0` for one
    /// that has not yet spanned any time — a count, not a rate.
    #[allow(clippy::cast_precision_loss)]
    pub(crate) fn rate(&self) -> f64 {
        let span = self.last_ns.saturating_sub(self.first_ns) as f64 / 1e9;
        if span <= 0.0 {
            return 0.0;
        }
        self.count as f64 / span
    }
}

/// What a reader's episode — one or more reported ones merged at the
/// reader's gap — says beyond its count and span.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EpisodeDetail {
    /// The reported episodes' counts by kind, summed.
    pub(crate) kinds: ErrorKinds,
    pub(crate) tx_count: u64,
    pub(crate) rx_count: u64,
    /// The counters as of the last error.
    pub(crate) tec: u32,
    pub(crate) rec: u32,
    /// The last reported episode in it is still open.
    pub(crate) ongoing: bool,
}

/// One bus's reported episodes, oldest first.
#[derive(Debug, Default)]
struct BusReports {
    /// Every error frame the bus's reports have counted.
    total: u64,
    episodes: Vec<ReportedEpisode>,
    /// Which source's which episode the newest one is — so a republish
    /// of it updates it, and anything else starts the next one.
    current: Option<(String, u64)>,
}

/// Every bus's reported episodes — the host's record of what the
/// sidecar (or, for an import, [`EpisodeBuilder`]) counted. Bounded by
/// capture time ÷ 1 s per bus: an episode closes only after a second
/// without an error.
#[derive(Debug, Default)]
pub(crate) struct BusErrorReports {
    buses: BTreeMap<String, BusReports>,
}

/// An absolute ns time as the seconds the error series is in.
#[allow(clippy::cast_precision_loss)]
fn seconds(ns: u64) -> f64 {
    ns as f64 / 1e9
}

impl BusErrorReports {
    /// Fold one report for `bus` from `source` (a session's interface, or
    /// an import), its times already on the host's timeline. Returns the
    /// points it adds to the bus's error series — `(seconds, running
    /// total)`, non-decreasing in both — which the caller appends.
    ///
    /// A report for the episode `source` last reported on this bus is a
    /// fresh reading of it: it moves the episode's end and counts and
    /// adds one point at its latest error, if anything grew. Any other
    /// report starts the bus's next episode and **closes the one before**,
    /// whether or not that one's own closing report ever came (ADR 0060
    /// rule 3); it adds a point at its first error and one at its latest.
    /// A report older than the one `source` last reported is stale and
    /// adds nothing.
    #[allow(clippy::cast_precision_loss)]
    pub(crate) fn apply(
        &mut self,
        bus: &str,
        source: &str,
        report: &BusErrorEpisode,
    ) -> Vec<(f64, f64)> {
        let b = self.buses.entry(bus.to_string()).or_default();
        if let Some((current_source, current_seq)) = &b.current {
            if current_source == source && report.seq < *current_seq {
                return Vec::new();
            }
            if current_source == source && report.seq == *current_seq {
                let Some(e) = b.episodes.last_mut() else {
                    return Vec::new();
                };
                if report.count < e.count {
                    return Vec::new();
                }
                let grew = report.count > e.count || report.last_ns > e.last_ns;
                e.last_ns = e.last_ns.max(report.last_ns);
                e.count = report.count;
                e.kinds = report.count_by_kind.into();
                e.tx_count = report.tx_count;
                e.rx_count = report.rx_count;
                e.tec = report.tec;
                e.rec = report.rec;
                e.open = report.open;
                b.total = e.base + e.count;
                return if grew {
                    vec![(seconds(e.last_ns), b.total as f64)]
                } else {
                    Vec::new()
                };
            }
        }
        if report.count == 0 {
            return Vec::new();
        }
        // The series is non-decreasing in time: a report stamped before
        // the bus's previous episode ended (a clock step between them)
        // is placed at that end rather than behind it.
        let floor = b.episodes.last().map_or(0, |e| e.last_ns);
        if let Some(previous) = b.episodes.last_mut() {
            previous.open = false;
        }
        let first_ns = report.first_ns.max(floor);
        let last_ns = report.last_ns.max(first_ns);
        let base = b.total;
        b.episodes.push(ReportedEpisode {
            first_ns,
            last_ns,
            count: report.count,
            kinds: report.count_by_kind.into(),
            tx_count: report.tx_count,
            rx_count: report.rx_count,
            tec: report.tec,
            rec: report.rec,
            open: report.open,
            base,
        });
        b.total = base + report.count;
        b.current = Some((source.to_string(), report.seq));
        let mut points = vec![(seconds(first_ns), (base + 1) as f64)];
        if report.count > 1 || last_ns > first_ns {
            points.push((seconds(last_ns), b.total as f64));
        }
        points
    }

    /// Start `bus` at `total()` errors if it has no reports yet: a
    /// capture restored with its error series has already counted that
    /// many, and the series must not step back.
    pub(crate) fn seed(&mut self, bus: &str, total: impl FnOnce() -> u64) {
        if !self.buses.contains_key(bus) {
            self.buses.insert(
                bus.to_string(),
                BusReports {
                    total: total(),
                    ..BusReports::default()
                },
            );
        }
    }

    /// Start `bus` from what a capture restored with its error series
    /// persisted beside it: `total` errors counted, and the reported
    /// episodes the series kept (all closed — nothing is ongoing after a
    /// relaunch). A bus that already has reports is left alone, as
    /// [`Self::seed`] leaves it.
    pub(crate) fn restore(&mut self, bus: &str, total: u64, episodes: Vec<ReportedEpisode>) {
        self.buses
            .entry(bus.to_string())
            .or_insert_with(|| BusReports {
                total,
                episodes,
                current: None,
            });
    }

    /// Close every episode `source` still holds open — its session has
    /// ended, so nothing more will come for them.
    pub(crate) fn close_source(&mut self, source: &str) {
        for b in self.buses.values_mut() {
            if b.current.as_ref().is_some_and(|(s, _)| s == source) {
                if let Some(e) = b.episodes.last_mut() {
                    e.open = false;
                }
            }
        }
    }

    /// The sources whose newest episode on some bus is still open.
    pub(crate) fn open_sources(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .buses
            .values()
            .filter(|b| b.episodes.last().is_some_and(|e| e.open))
            .filter_map(|b| b.current.as_ref().map(|(s, _)| s.clone()))
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Every error the reports have counted on `bus`.
    pub(crate) fn total(&self, bus: &str) -> u64 {
        self.buses.get(bus).map_or(0, |b| b.total)
    }

    /// `bus`'s newest reported episode.
    pub(crate) fn latest(&self, bus: &str) -> Option<&ReportedEpisode> {
        self.buses.get(bus)?.episodes.last()
    }

    /// The buses that have reported an episode, in order.
    pub(crate) fn buses(&self) -> impl Iterator<Item = &str> {
        self.buses.keys().map(String::as_str)
    }

    /// What the reported episodes that begin within `[first_t, last_t]`
    /// seconds on `bus` say together — a reader's episode, which is a
    /// whole number of reported ones — or `None` when no report covers
    /// it (a series restored from a scratch written before the reports
    /// were persisted beside it).
    pub(crate) fn detail(&self, bus: &str, first_t: f64, last_t: f64) -> Option<EpisodeDetail> {
        let episodes = &self.buses.get(bus)?.episodes;
        let lo = episodes.partition_point(|e| seconds(e.first_ns) < first_t);
        let hi = episodes.partition_point(|e| seconds(e.first_ns) <= last_t);
        let covered = episodes.get(lo..hi).filter(|c| !c.is_empty())?;
        let last = &covered[covered.len() - 1];
        Some(EpisodeDetail {
            kinds: covered.iter().fold(ErrorKinds::default(), |mut acc, e| {
                acc.add(&e.kinds);
                acc
            }),
            tx_count: covered.iter().map(|e| e.tx_count).sum(),
            rx_count: covered.iter().map(|e| e.rx_count).sum(),
            tec: last.tec,
            rec: last.rec,
            ongoing: last.open,
        })
    }

    pub(crate) fn clear(&mut self) {
        self.buses.clear();
    }
}

/// One episode [`EpisodeBuilder`] is still building on a bus.
#[derive(Debug)]
struct Building {
    seq: u64,
    first_ns: u64,
    last_ns: u64,
    count: u64,
}

impl Building {
    fn report(&self, open: bool) -> BusErrorEpisode {
        BusErrorEpisode {
            seq: self.seq,
            first_ns: self.first_ns,
            last_ns: self.last_ns,
            count: self.count,
            // A file's error record carries nothing this builder reads
            // about the kind or the direction of the error.
            count_by_kind: ErrorKindCounts {
                unknown: self.count,
                ..ErrorKindCounts::default()
            },
            tx_count: 0,
            rx_count: 0,
            tec: 0,
            rec: 0,
            open,
        }
    }
}

/// What [`EpisodeBuilder::observe`] decides about one error frame.
#[derive(Debug, PartialEq)]
pub(crate) struct Observed {
    /// The frame is among the first N of its episode, so it is a row.
    pub(crate) keep_row: bool,
    /// Reports to fold, oldest first: the previous episode's close and
    /// this one's opening, when the frame starts an episode.
    pub(crate) reports: Vec<BusErrorEpisode>,
}

/// The sidecar's episode rule over an imported capture's error records
/// (ADR 0060 rule 2, "imports behave as live"): per bus, an episode
/// opens at an error frame and closes after [`EPISODE_CLOSE_AFTER_NS`]
/// without one; the first `cap` frames of each are rows and the rest are
/// counted. Bounded by the bus count.
#[derive(Debug)]
pub(crate) struct EpisodeBuilder {
    cap: u64,
    buses: BTreeMap<String, Building>,
}

impl EpisodeBuilder {
    /// A builder keeping the first `cap` error frames of each episode.
    pub(crate) fn new(cap: u32) -> Self {
        Self {
            cap: u64::from(cap),
            buses: BTreeMap::new(),
        }
    }

    /// Fold one error frame on `bus` at `ts_ns`. A frame stamped before
    /// the episode's latest error (a file need not be in order) joins the
    /// episode rather than opening another.
    pub(crate) fn observe(&mut self, bus: &str, ts_ns: u64) -> Observed {
        if let Some(b) = self.buses.get_mut(bus) {
            if ts_ns < b.last_ns.saturating_add(EPISODE_CLOSE_AFTER_NS) {
                b.count += 1;
                b.last_ns = b.last_ns.max(ts_ns);
                return Observed {
                    keep_row: b.count <= self.cap,
                    reports: Vec::new(),
                };
            }
        }
        let mut reports = Vec::new();
        let seq = match self.buses.get(bus) {
            Some(closed) => {
                reports.push(closed.report(false));
                closed.seq + 1
            }
            None => 1,
        };
        let opened = Building {
            seq,
            first_ns: ts_ns,
            last_ns: ts_ns,
            count: 1,
        };
        reports.push(opened.report(true));
        self.buses.insert(bus.to_string(), opened);
        Observed {
            keep_row: self.cap >= 1,
            reports,
        }
    }

    /// The closing report of every episode still open — the file has
    /// ended, so each is as long as it will get. `(bus, report)` pairs.
    pub(crate) fn finish(self) -> Vec<(String, BusErrorEpisode)> {
        self.buses
            .into_iter()
            .map(|(bus, b)| (bus, b.report(false)))
            .collect()
    }
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

    const S: u64 = 1_000_000_000;

    fn report(seq: u64, first_ns: u64, last_ns: u64, count: u64, open: bool) -> BusErrorEpisode {
        BusErrorEpisode {
            seq,
            first_ns,
            last_ns,
            count,
            count_by_kind: ErrorKindCounts {
                ack: count,
                ..ErrorKindCounts::default()
            },
            tx_count: count,
            rx_count: 0,
            tec: 128,
            rec: 0,
            open,
        }
    }

    #[test]
    fn a_report_adds_the_running_total_at_its_first_and_latest_error() {
        // ADR 0060 rule 2: the series is fed by the reports, each giving
        // the bus's running total at its first and last error, so it
        // never decreases and two points still give an exact count.
        let mut r = BusErrorReports::default();
        assert_eq!(
            r.apply("b", "s", &report(1, 10 * S, 10 * S, 1, true)),
            vec![(10.0, 1.0)]
        );
        // The open episode republished at the state cadence.
        assert_eq!(
            r.apply("b", "s", &report(1, 10 * S, 11 * S, 3_600, true)),
            vec![(11.0, 3_600.0)]
        );
        // A republish that moved nothing adds nothing.
        assert!(r
            .apply("b", "s", &report(1, 10 * S, 11 * S, 3_600, true))
            .is_empty());
        // The next blast starts where the last one's total left off.
        assert_eq!(
            r.apply("b", "s", &report(2, 20 * S, 21 * S, 10, false)),
            vec![(20.0, 3_601.0), (21.0, 3_610.0)]
        );
        assert_eq!(r.total("b"), 3_610);
    }

    #[test]
    fn a_report_for_a_later_episode_closes_the_one_still_open() {
        // The sidecar may fold a closed episode's own closing report into
        // its successor (ADR 0060 rule 3), so seq 2 arriving is all the
        // host will hear of seq 1 ending.
        let mut r = BusErrorReports::default();
        let _ = r.apply("b", "s", &report(1, 10 * S, 11 * S, 50, true));
        assert!(r.latest("b").unwrap().open);
        let _ = r.apply("b", "s", &report(2, 20 * S, 20 * S, 1, true));
        let d = r.detail("b", 10.0, 11.0).unwrap();
        assert!(!d.ongoing, "seq 1 is closed by seq 2's report");
        assert!(r.detail("b", 20.0, 20.0).unwrap().ongoing);
        // A stale reading of seq 1 afterwards changes nothing.
        assert!(r
            .apply("b", "s", &report(1, 10 * S, 12 * S, 60, true))
            .is_empty());
        assert_eq!(r.total("b"), 51);
        // A session that ends closes what it held open.
        r.close_source("s");
        assert!(!r.latest("b").unwrap().open);
        assert!(r.open_sources().is_empty());
    }

    #[test]
    fn a_readers_episode_sums_the_reported_ones_it_covers() {
        let mut r = BusErrorReports::default();
        let mut first = report(1, 10 * S, 11 * S, 40, false);
        first.count_by_kind = ErrorKindCounts {
            ack: 30,
            bit: 10,
            ..ErrorKindCounts::default()
        };
        first.rx_count = 5;
        let _ = r.apply("b", "s", &first);
        let mut second = report(2, 13 * S, 14 * S, 20, true);
        second.tec = 255;
        let _ = r.apply("b", "s", &second);
        // Merged at a 5 s gap the two are one reader's episode.
        let d = r.detail("b", 10.0, 14.0).unwrap();
        assert_eq!(
            d.kinds.largest_first(),
            vec![(ErrorKind::Ack, 50), (ErrorKind::Bit, 10)]
        );
        assert_eq!((d.tx_count, d.rx_count), (60, 5));
        assert_eq!((d.tec, d.ongoing), (255, true), "the last one's counters");
        assert_eq!(r.detail("b", 30.0, 40.0), None);
        assert_eq!(r.detail("other", 10.0, 14.0), None);
    }

    #[test]
    fn kinds_are_kept_sparse_and_listed_largest_first() {
        // Owner ruling 2026-10-05: a pulled cable is all `ack`, so the
        // host keeps only the kinds counted, and lists them largest
        // first; a tie keeps ADR 0060's own order.
        let one: ErrorKinds = ErrorKindCounts {
            ack: 3_412,
            ..ErrorKindCounts::default()
        }
        .into();
        assert_eq!(serde_json::to_string(&one).unwrap(), r#"{"ack":3412}"#);
        let mixed: ErrorKinds = ErrorKindCounts {
            ack: 2,
            bit: 3_410,
            crc: 2,
            ..ErrorKindCounts::default()
        }
        .into();
        assert_eq!(
            mixed.largest_first(),
            vec![
                (ErrorKind::Bit, 3_410),
                (ErrorKind::Ack, 2),
                (ErrorKind::Crc, 2)
            ]
        );
        assert!(ErrorKinds::from(ErrorKindCounts::default())
            .largest_first()
            .is_empty());
    }

    /// An imported capture's error records, through the import builder
    /// and into the report store and the series, read as the live session
    /// did: two blasts are two episodes with their whole counts, and only
    /// the first `cap` frames of each are rows.
    #[test]
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // the totals are whole counts
    fn an_import_folds_its_error_records_into_episodes_and_keeps_the_first_n_as_rows() {
        let mut builder = EpisodeBuilder::new(16);
        let mut reports = BusErrorReports::default();
        let mut series = EpisodeList::new(1.0);
        let mut rows = 0;
        let mut feed = |reports: &mut BusErrorReports, rs: &[BusErrorEpisode]| {
            for rep in rs {
                for (t, n) in reports.apply("b", "import", rep) {
                    series.push(t, n as u64);
                }
            }
        };
        // 40 errors 1 ms apart, 2 s of silence, then 3 more.
        let times = (0..40u64)
            .map(|i| 100 * S + i * 1_000_000)
            .chain((0..3u64).map(|i| 103 * S + i * 1_000_000));
        for ts in times {
            let seen = builder.observe("b", ts);
            rows += usize::from(seen.keep_row);
            feed(&mut reports, &seen.reports);
        }
        let closing: Vec<BusErrorEpisode> = builder.finish().into_iter().map(|(_, r)| r).collect();
        feed(&mut reports, &closing);
        assert_eq!(
            rows,
            16 + 3,
            "the first 16 of the first blast, all 3 of the second"
        );
        assert_eq!(reports.total("b"), 43, "every error is counted");
        let got: Vec<(u64, u64)> = series
            .episodes()
            .iter()
            .map(|e| (e.count(), e.first_n))
            .collect();
        assert_eq!(got, vec![(40, 1), (3, 41)]);
        assert!(!reports.latest("b").unwrap().open, "the file has ended");
    }

    #[test]
    fn an_out_of_order_record_joins_its_episode_and_a_cap_of_zero_keeps_no_row() {
        let mut builder = EpisodeBuilder::new(0);
        let a = builder.observe("b", 10 * S);
        let b = builder.observe("b", 10 * S - 1_000);
        assert!(!a.keep_row && !b.keep_row);
        assert_eq!(a.reports.len(), 1, "the opening report");
        assert!(b.reports.is_empty(), "it joined the open episode");
        let done = builder.finish();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].1.count, 2);
    }
}
