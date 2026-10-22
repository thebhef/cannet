//! The Events panel's **one list** (ADR 0035): the authored events and
//! every bus's bus-error episodes, merged by time, oldest first, served a
//! page at a time. "Authored" here is the notes store's whole durable
//! list, which also holds the dropped-frames gaps the host recorded from
//! a peer's report (ADR 0060) — durable like a note, and listed as one.
//!
//! The two halves are held differently. The authored events are the notes
//! store's whole list — bounded by what the user wrote and by the gaps
//! a peer reported. The episodes are
//! each bus's list in the signal cache at the episode gap
//! ([`crate::signal_cache::SignalCacheStore::with_episodes`]) — bounded by
//! capture time ÷ gap, but not something to copy per page. So the merge
//! never builds the whole list: a page's first row is located by **rank**
//! (a binary search per list, [`chronological_page`]), and the page is a
//! k-way merge from there. A page costs `O(lists² × log² n + limit ×
//! lists)` at any offset.
//!
//! **Order.** By time — an authored event's timestamp, an episode's first
//! error. At equal times the lists rank in a fixed order: the authored
//! events, then the truncation marker, then the buses in the order asked.
//! Within one list the list's own order holds.
//!
//! **Filters are the query's, not the view's.** The kind filter picks the
//! lists; a tag query keeps the authored events whose tag contains it,
//! case-insensitively, and drops everything that carries no tag — the
//! truncation marker and every episode. The count is the filtered one.
//!
//! **The truncation marker** is placed here by its time — the oldest
//! retained frame, read off the trace store — and nothing else: the
//! frontend draws it, as it draws it on every other surface.

use serde::Deserialize;

use crate::bus_error_episodes::Episode;
use crate::notes::{EventKind, Note, NotesStore};
use crate::signal_cache::SignalCacheStore;
use crate::trace_store::TraceStore;

/// A kind the Events panel's filter can show or hide — the host's
/// [`EventKind`]s plus the truncation marker, which the host only
/// places.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ListedKind {
    Note,
    MessageBound,
    BusError,
    DroppedFrames,
    Truncation,
}

/// One row of the merged list.
#[derive(Debug, Clone, PartialEq)]
pub enum EventsRow {
    /// An authored event.
    Note(Note),
    /// The truncation marker, at the oldest retained frame's time (ns).
    Truncation(u64),
    /// A bus-error episode: the index of its bus in the buses asked
    /// about, and the episode.
    BusError(usize, Episode),
}

/// One page of the merged list.
#[derive(Debug, Clone, PartialEq)]
pub struct EventsPage {
    /// Rows in the filtered list, in all.
    pub count: usize,
    /// The merged position of `rows[0]`.
    pub start: usize,
    pub rows: Vec<EventsRow>,
    /// `false` while an episode list is still behind the capture (ADR
    /// 0049): the page is then drawn from what has been derived so far.
    pub complete: bool,
    /// Moves whenever the list could have changed under a view: an
    /// authored edit, an episode appended or grown, a gap change, a trim
    /// or a clear. Two answers with the same version list the same rows.
    pub version: u64,
}

/// What the page is asked for.
pub struct EventsQuery<'a> {
    /// The buses whose episodes join the list, in tie-break order.
    pub buses: &'a [&'a str],
    /// The episode gap, in seconds (already held to the setting's bounds).
    pub gap_seconds: f64,
    pub kinds: &'a [ListedKind],
    pub tag_query: &'a str,
    pub offset: usize,
    pub limit: usize,
    /// Serve the last `limit` rows instead of the ones at `offset`.
    pub from_end: bool,
}

/// Serve one page of the merged list.
pub fn events_page(
    notes: &NotesStore,
    caches: &SignalCacheStore,
    trace: &TraceStore,
    query: &EventsQuery<'_>,
) -> EventsPage {
    let tag = query.tag_query.trim().to_lowercase();
    let shows = |k: ListedKind| query.kinds.contains(&k);
    let authored: Vec<Note> = notes
        .events()
        .into_iter()
        .filter(|n| match n.kind {
            EventKind::Note => shows(ListedKind::Note),
            EventKind::MessageBound => shows(ListedKind::MessageBound),
            EventKind::DroppedFrames => shows(ListedKind::DroppedFrames),
            EventKind::BusError => false,
        })
        .filter(|n| {
            tag.is_empty()
                || n.tag
                    .as_deref()
                    .is_some_and(|t| t.to_lowercase().contains(&tag))
        })
        .collect();
    // Nothing untagged survives a tag query.
    let untagged = tag.is_empty();
    let truncation = if untagged && shows(ListedKind::Truncation) {
        let (_, first_index, first_ts) = trace.len_and_low_water();
        first_ts.filter(|_| first_index > 0)
    } else {
        None
    };
    let page = |episodes: &[&[Episode]], complete: bool| {
        let (count, start, rows) = merge_page(&authored, truncation, episodes, query);
        (count, start, rows, complete)
    };
    let (count, start, rows, complete) =
        if untagged && shows(ListedKind::BusError) && !query.buses.is_empty() {
            caches.with_episodes(query.buses, query.gap_seconds, page)
        } else {
            page(&[], true)
        };
    EventsPage {
        count,
        start,
        rows,
        complete,
        version: notes.revision() + caches.episodes_version(),
    }
}

/// The page of the merge of `authored` (chronological), the truncation
/// marker and each bus's episode list (chronological) that `query`'s
/// offset, limit and `from_end` name: `(count, start, rows)`.
fn merge_page(
    authored: &[Note],
    truncation: Option<u64>,
    episodes: &[&[Episode]],
    query: &EventsQuery<'_>,
) -> (usize, usize, Vec<EventsRow>) {
    let note_t: Vec<f64> = authored.iter().map(|n| seconds(n.timestamp_ns)).collect();
    let trunc_t: Vec<f64> = truncation.map(seconds).into_iter().collect();
    let mut lists: Vec<&dyn Timeline> = vec![&note_t, &trunc_t];
    lists.extend(episodes.iter().map(|l| l as &dyn Timeline));
    let count: usize = lists.iter().map(|l| l.len()).sum();
    let start = if query.from_end {
        count.saturating_sub(query.limit)
    } else {
        query.offset.min(count)
    };
    let rows = chronological_page(&lists, start, query.limit)
        .into_iter()
        .map(|(list, i)| match list {
            0 => EventsRow::Note(authored[i].clone()),
            1 => EventsRow::Truncation(truncation.unwrap_or_default()),
            bus => EventsRow::BusError(bus - 2, episodes[bus - 2][i]),
        })
        .collect();
    (count, start, rows)
}

/// An absolute ns timestamp as the seconds an episode's times are in —
/// the same conversion the error series makes of a frame's time, so an
/// event and an episode at the same frame time compare equal.
#[allow(clippy::cast_precision_loss)]
fn seconds(ns: u64) -> f64 {
    ns as f64 / 1e9
}

/// A list sorted by time, ascending — what [`chronological_page`] merges.
pub(crate) trait Timeline {
    fn len(&self) -> usize;
    /// The time of item `i`, in seconds.
    fn t(&self, i: usize) -> f64;
}

impl Timeline for Vec<f64> {
    fn len(&self) -> usize {
        Vec::len(self)
    }
    fn t(&self, i: usize) -> f64 {
        self[i]
    }
}

impl Timeline for &[Episode] {
    fn len(&self) -> usize {
        <[Episode]>::len(self)
    }
    /// An episode sits at its first error.
    fn t(&self, i: usize) -> f64 {
        self[i].first_t
    }
}

/// Rows `[offset, offset + limit)` of the **oldest-first** merge of
/// `lists`, each `(list index, index in that list)`. At equal times the
/// lower list index comes first.
pub(crate) fn chronological_page(
    lists: &[&dyn Timeline],
    offset: usize,
    limit: usize,
) -> Vec<(usize, usize)> {
    let total: usize = lists.iter().map(|l| l.len()).sum();
    if limit == 0 || offset >= total {
        return Vec::new();
    }
    let mut next = cut_at(lists, offset);
    let mut page = Vec::with_capacity(limit.min(total - offset));
    while page.len() < limit {
        let mut best: Option<(usize, f64)> = None;
        for (c, list) in lists.iter().enumerate() {
            if next[c] >= list.len() {
                continue;
            }
            let t = list.t(next[c]);
            // Strictly older wins, so an equal time stays with the lower
            // list index found first.
            if best.is_none_or(|(_, b)| t < b) {
                best = Some((c, t));
            }
        }
        let Some((c, _)) = best else { break };
        page.push((c, next[c]));
        next[c] += 1;
    }
    page
}

/// For the row at merged position `offset`, how many of each list's
/// items precede it.
fn cut_at(lists: &[&dyn Timeline], offset: usize) -> Vec<usize> {
    for (b, list) in lists.iter().enumerate() {
        // Rank rises with the index, so the first index whose rank
        // reaches `offset` is this list's only candidate.
        let j = first_index(list.len(), |j| rank(lists, b, j) >= offset);
        if j < list.len() && rank(lists, b, j) == offset {
            let t = list.t(j);
            return (0..lists.len())
                .map(|c| {
                    if c == b {
                        j
                    } else {
                        preceding(lists[c], c, b, t)
                    }
                })
                .collect();
        }
    }
    unreachable!("every position below the total is some row's rank")
}

/// The merged oldest-first position of item `j` of list `b`.
fn rank(lists: &[&dyn Timeline], b: usize, j: usize) -> usize {
    let t = lists[b].t(j);
    j + lists
        .iter()
        .enumerate()
        .filter(|&(c, _)| c != b)
        .map(|(c, list)| preceding(*list, c, b, t))
        .sum::<usize>()
}

/// How many of list `c`'s items precede an item of list `b` at time `t`:
/// the older ones, and the equally old ones when `c` is the lower index.
fn preceding(list: &dyn Timeline, c: usize, b: usize, t: f64) -> usize {
    if c < b {
        first_index(list.len(), |i| list.t(i) > t)
    } else {
        first_index(list.len(), |i| list.t(i) >= t)
    }
}

/// The first index in `0..len` at which the monotone `pred` holds, or
/// `len` when it never does.
fn first_index(len: usize, pred: impl Fn(usize) -> bool) -> usize {
    let (mut lo, mut hi) = (0, len);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if pred(mid) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace_store::RawTraceFrame;
    use cannet_core::{CanFramePayload, Direction};
    use tempfile::TempDir;

    const S: u64 = 1_000_000_000;
    const MS: u64 = 1_000_000;
    const BUSES: [&str; 2] = ["ea", "eb"];
    const ALL: [ListedKind; 5] = [
        ListedKind::Note,
        ListedKind::MessageBound,
        ListedKind::BusError,
        ListedKind::DroppedFrames,
        ListedKind::Truncation,
    ];

    /// Record `frames`' errors into their buses' error series, one point
    /// each — `(its time, its ordinal on the bus)` — as the episode
    /// reports would at their finest (ADR 0060).
    #[allow(clippy::cast_precision_loss)]
    fn record(caches: &SignalCacheStore, frames: &[RawTraceFrame]) {
        let mut totals: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for f in frames {
            let bus = f.bus_id.clone().unwrap();
            let n = totals
                .entry(bus.clone())
                .or_insert_with(|| caches.bus_error_total(&bus));
            *n += 1;
            caches.record_bus_errors(&bus, &[(seconds(f.timestamp_ns), *n as f64)]);
        }
    }

    fn err_frame(ts_ns: u64, bus: &str) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: ts_ns,
            channel: 0,
            id: 0,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Error,
            bus_id: Some(bus.to_string()),
        }
    }

    fn note(id: &str, ts: u64, tag: Option<&str>) -> Note {
        Note {
            id: id.into(),
            timestamp_ns: ts,
            label: id.into(),
            kind: EventKind::Note,
            color: None,
            description: None,
            tag: tag.map(Into::into),
            commented_event_type: None,
            subjects: Vec::new(),
            unknown_block_lines: Vec::new(),
        }
    }

    fn query<'a>(
        kinds: &'a [ListedKind],
        tag: &'a str,
        offset: usize,
        limit: usize,
    ) -> EventsQuery<'a> {
        EventsQuery {
            buses: &BUSES,
            gap_seconds: 1.0,
            kinds,
            tag_query: tag,
            offset,
            limit,
            from_end: false,
        }
    }

    /// A short name per row: a note's id, `T` for the truncation marker,
    /// `bus:lastOrdinal` for an episode.
    fn names(rows: &[EventsRow]) -> Vec<String> {
        rows.iter()
            .map(|r| match r {
                EventsRow::Note(n) => n.id.clone(),
                EventsRow::Truncation(_) => "T".into(),
                EventsRow::BusError(b, e) => format!("{}:{}", BUSES[*b], e.last_n),
            })
            .collect()
    }

    struct Fixture {
        notes: NotesStore,
        caches: SignalCacheStore,
        trace: TraceStore,
        _dir: TempDir,
    }

    fn fixture(frames: &[RawTraceFrame], notes: &[Note]) -> Fixture {
        let dir = TempDir::new().unwrap();
        let caches = SignalCacheStore::new_unbounded(dir.path());
        record(&caches, frames);
        let store = NotesStore::new();
        for n in notes {
            let _ = store.add(n.clone());
        }
        Fixture {
            notes: store,
            caches,
            trace: TraceStore::new(),
            _dir: dir,
        }
    }

    impl Fixture {
        fn page(&self, q: &EventsQuery<'_>) -> EventsPage {
            events_page(&self.notes, &self.caches, &self.trace, q)
        }
    }

    #[test]
    fn the_merge_is_chronological_across_notes_and_two_buses_with_ties_stable() {
        // ea: episodes at 1 s and 5 s; eb: one at 3 s and one at 5 s,
        // the same time as ea's second and as note "n5".
        let frames = vec![
            err_frame(S, "ea"),
            err_frame(3 * S, "eb"),
            err_frame(5 * S, "ea"),
            err_frame(5 * S, "eb"),
        ];
        let f = fixture(
            &frames,
            &[
                note("n0", 0, None),
                note("n4", 4 * S, None),
                note("n5", 5 * S, None),
            ],
        );
        let page = f.page(&query(&ALL, "", 0, 100));
        assert_eq!(page.count, 7);
        assert!(page.complete);
        // At 5 s: the note, then the lower bus, then the higher.
        assert_eq!(
            names(&page.rows),
            ["n0", "ea:1", "eb:1", "n4", "n5", "ea:2", "eb:2"],
        );
    }

    #[test]
    fn paging_by_offset_over_400_episodes_and_5_notes_is_the_whole_list_in_pieces() {
        // 400 one-error episodes, alternating buses 2 s apart; five notes
        // spread among them, one on an episode's own time.
        let frames: Vec<RawTraceFrame> = (0..400u64)
            .map(|i| err_frame(10 * S + i * 2 * S, BUSES[usize::try_from(i % 2).unwrap()]))
            .collect();
        let notes: Vec<Note> = (0..5u64)
            .map(|k| {
                note(
                    &format!("n{k}"),
                    10 * S + k * 160 * S + 500 * MS * (k % 2),
                    None,
                )
            })
            .collect();
        let f = fixture(&frames, &notes);
        let whole = f.page(&query(&ALL, "", 0, usize::MAX));
        assert_eq!(whole.count, 405);
        assert_eq!(whole.rows.len(), 405);
        let time = |r: &EventsRow| match r {
            EventsRow::Note(n) => seconds(n.timestamp_ns),
            EventsRow::Truncation(ns) => seconds(*ns),
            EventsRow::BusError(_, e) => e.first_t,
        };
        assert!(whole.rows.windows(2).all(|w| time(&w[0]) <= time(&w[1])));

        for limit in [1, 7, 64] {
            let mut paged = Vec::new();
            let mut offset = 0;
            loop {
                let page = f.page(&query(&ALL, "", offset, limit));
                assert_eq!((page.count, page.start), (405, offset.min(405)));
                assert!(page.complete);
                if page.rows.is_empty() {
                    break;
                }
                offset += page.rows.len();
                paged.extend(page.rows);
            }
            assert_eq!(paged, whole.rows, "pages of {limit}");
        }
        // The live tail: the last page, wherever it starts.
        let tail = f.page(&EventsQuery {
            from_end: true,
            ..query(&ALL, "", 0, 10)
        });
        assert_eq!(tail.start, 395);
        assert_eq!(tail.rows, whole.rows[395..]);
    }

    #[test]
    fn a_page_is_partial_while_the_episodes_still_fold() {
        let frames: Vec<RawTraceFrame> = (0..40_000u64)
            .map(|i| err_frame(S + i * 2 * S, "ea"))
            .collect();
        let dir = TempDir::new().unwrap();
        let trace = TraceStore::new();
        let notes = NotesStore::new();
        let caches = SignalCacheStore::new_chunk_at_a_time(dir.path());
        record(&caches, &frames);
        let first = events_page(&notes, &caches, &trace, &query(&ALL, "", 0, 10));
        assert!(!first.complete);
        assert!(first.count < 40_000, "{} so far", first.count);
        let last = loop {
            let p = events_page(&notes, &caches, &trace, &query(&ALL, "", 0, 10));
            if p.complete {
                break p;
            }
        };
        assert_eq!(last.count, 40_000);
    }

    #[test]
    fn a_note_edit_an_episode_append_and_a_gap_change_each_move_the_version() {
        let f = fixture(&[err_frame(S, "ea")], &[note("n", 2 * S, None)]);
        let v0 = f.page(&query(&ALL, "", 0, 10)).version;
        assert_eq!(f.page(&query(&ALL, "", 0, 10)).version, v0, "nothing moved");

        let _ = f.notes.rename("n", "renamed");
        let v1 = f.page(&query(&ALL, "", 0, 10)).version;
        assert_ne!(v1, v0, "a note edit");

        record(&f.caches, &[err_frame(10 * S, "ea")]);
        let v2 = f.page(&query(&ALL, "", 0, 10)).version;
        assert_ne!(v2, v1, "an episode append");

        let at_five = f.page(&EventsQuery {
            gap_seconds: 5.0,
            ..query(&ALL, "", 0, 10)
        });
        assert_ne!(at_five.version, v2, "a gap change");
    }

    #[test]
    fn the_kind_filter_picks_the_lists() {
        let frames = vec![err_frame(S, "ea"), err_frame(3 * S, "eb")];
        let mut comment = note("c", 2 * S, None);
        comment.kind = EventKind::MessageBound;
        let f = fixture(&frames, &[note("n", 4 * S, None), comment]);
        let no_errors = f.page(&query(
            &[
                ListedKind::Note,
                ListedKind::MessageBound,
                ListedKind::Truncation,
            ],
            "",
            0,
            10,
        ));
        assert_eq!(names(&no_errors.rows), ["c", "n"]);
        assert_eq!(no_errors.count, 2);
        let only_errors = f.page(&query(&[ListedKind::BusError], "", 0, 10));
        assert_eq!(names(&only_errors.rows), ["ea:1", "eb:1"]);
    }

    #[test]
    fn a_dropped_frames_gap_is_listed_among_the_authored_events_under_its_own_kind() {
        let mut gap = note("gap", 2 * S, None);
        gap.kind = EventKind::DroppedFrames;
        let f = fixture(&[err_frame(S, "ea")], &[gap, note("n", 3 * S, None)]);
        assert_eq!(
            names(&f.page(&query(&ALL, "", 0, 10)).rows),
            ["ea:1", "gap", "n"]
        );
        let without = f.page(&query(&[ListedKind::Note, ListedKind::BusError], "", 0, 10));
        assert_eq!(names(&without.rows), ["ea:1", "n"]);
    }

    #[test]
    fn a_tag_query_keeps_matching_authored_events_and_drops_every_episode() {
        let frames = vec![err_frame(S, "ea"), err_frame(3 * S, "eb")];
        let f = fixture(
            &frames,
            &[
                note("fault", 2 * S, Some("Fault")),
                note("other", 4 * S, Some("contactor")),
                note("bare", 5 * S, None),
            ],
        );
        let page = f.page(&query(&ALL, " fau ", 0, 10));
        assert_eq!(names(&page.rows), ["fault"]);
        assert_eq!(page.count, 1);
        assert_eq!(f.page(&query(&ALL, "", 0, 10)).count, 5);
    }

    #[test]
    fn the_truncation_marker_takes_its_place_by_time() {
        let authored = [note("a", S, None), note("b", 3 * S, None)];
        let e = Episode {
            first_t: 2.0,
            last_t: 2.0,
            first_n: 1,
            last_n: 1,
        };
        let ea = [e];
        let (count, _, rows) = merge_page(&authored, Some(2 * S), &[&ea], &query(&ALL, "", 0, 10));
        assert_eq!(count, 4);
        // At 2 s the marker ranks before the bus.
        assert_eq!(names(&rows), ["a", "T", "ea:1", "b"]);
    }

    /// Every page of the merge, at every offset and a few limits, matches
    /// a whole stable sort — ties across lists included.
    #[test]
    fn paging_by_offset_matches_a_whole_stable_sort() {
        let a: Vec<f64> = vec![1.0, 3.0, 5.0, 7.0, 9.0];
        let b: Vec<f64> = vec![2.0, 3.0, 8.0];
        let c: Vec<f64> = Vec::new();
        let d: Vec<f64> = vec![0.5, 9.0, 9.0, 10.0, 11.0];
        let lists: Vec<&dyn Timeline> = vec![&a, &b, &c, &d];
        let mut whole: Vec<(usize, usize)> = lists
            .iter()
            .enumerate()
            .flat_map(|(l, list)| (0..list.len()).map(move |i| (l, i)))
            .collect();
        whole.sort_by(|x, y| {
            lists[x.0]
                .t(x.1)
                .total_cmp(&lists[y.0].t(y.1))
                .then(x.0.cmp(&y.0))
                .then(x.1.cmp(&y.1))
        });
        for offset in 0..=whole.len() + 1 {
            for limit in [0, 1, 3, 100] {
                let want: Vec<(usize, usize)> =
                    whole.iter().skip(offset).take(limit).copied().collect();
                assert_eq!(
                    chronological_page(&lists, offset, limit),
                    want,
                    "offset {offset} limit {limit}",
                );
            }
        }
    }
}
