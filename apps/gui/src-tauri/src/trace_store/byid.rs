//! The latest-by-id and per-signal (multiplexor) snapshot views.
//!
//! These read the incrementally-maintained newest-per-key state
//! ([`super::Inner`]'s `latest` / `latest_frame` / `rates` and the mux
//! `latest_mux` / `mux_rates` maps, all updated `O(1)` by
//! [`TraceStore::append`]) so the by-id grid and the per-signal
//! latest-value view never walk the whole buffer. A bounded window
//! (paused / scrolled into history) or a late-installed mux extractor
//! falls back to a chunked backward scan over the raw store.

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

use super::{FrameKey, MuxKey, MuxSelectorFn, RawTraceFrame, TraceStore};

/// How many frames [`TraceStore::latest_mux_in_window`]'s backward scan
/// examines before giving up on a selector group (which then reads as
/// blank). Generous enough to cover several seconds of a busy bus while
/// keeping a cold-index page fetch bounded.
const MUX_SCAN_BOUND: usize = 262_144;

/// Chunk size for this module's backward scans — the unit over which the
/// inner mutex is held, mirroring the filtered-trace scan's chunking so a
/// history walk never starves `append`.
const SCAN_CHUNK: usize = 65_536;

/// A row of the latest-by-id snapshot: the frame's index in the buffer,
/// the frame, the id's current message rate, and the total number of
/// frames seen for that id over the session.
#[derive(Debug, Clone)]
pub struct LatestById {
    pub index: usize,
    pub frame: RawTraceFrame,
    pub rate: f64,
    pub count: u64,
}

impl TraceStore {
    /// For each distinct `FrameKey` whose most recent occurrence is at
    /// index `>= since`: that index, a clone of the frame, and the id's
    /// current message rate — sorted by key (channel, then id, then
    /// standard-before-extended). A thin alias for
    /// [`Self::latest_in_window`] over `[since, tip]`.
    #[must_use]
    pub fn latest_since(&self, since: usize) -> Vec<LatestById> {
        self.latest_in_window(since, usize::MAX)
    }

    /// Latest-by-id snapshot bounded to the window `[start, end)`: for
    /// each distinct `FrameKey` with an occurrence in the window, its
    /// *last* occurrence **within the window** — a clone of the frame
    /// paired with the id's current message rate and total session count,
    /// sorted by key (bus, then channel, then id, then
    /// standard-before-extended).
    ///
    /// Unlike a global latest-by-id, this never looks past `end`: it is
    /// the by-id snapshot *of the window*, the by-id counterpart of the
    /// filtered trace's `[scan_start, scan_end)` slice (ADR 0025). For a
    /// paused/stopped trace whose window ends below the buffer tip that
    /// matters — a frame received after the window must not leak into the
    /// snapshot.
    ///
    /// When `end` covers the buffer tip (the running, follow-live case)
    /// the maintained `latest` map already holds each key's last index,
    /// all in-window, so this takes that O(keys) fast path. A bounded
    /// window (paused / scrolled into history) walks instead — backward
    /// from `end`, in chunks, stopping as soon as every key the store has
    /// seen at or above `start` has turned up, and never holding the
    /// append mutex across the walk.
    #[must_use]
    pub fn latest_in_window(&self, start: usize, end: usize) -> Vec<LatestById> {
        self.latest_in_window_where(start, end, |_| true)
    }

    /// The current key-set generation — bumped whenever a new
    /// `FrameKey` is first seen, or the map is rebuilt (session start,
    /// scratch reopen). Callers that derive something from "which ids
    /// exist" memoise on it instead of recomputing per request.
    #[must_use]
    pub fn key_generation(&self) -> u64 {
        self.lock_inner().key_generation
    }

    /// [`Self::latest_in_window`] restricted to the keys `keep` accepts.
    ///
    /// The unrestricted form materialises one `FrameKey` clone and one
    /// frame-payload clone per distinct id in the capture, under the
    /// append lock. Callers that want a handful of streams — the signal
    /// view's page, the DBC panel's value column — pay the whole id space
    /// for a viewport, on every refresh tick. Filtering at the source
    /// keeps that proportional to what was asked for.
    #[must_use]
    pub fn latest_in_window_where(
        &self,
        start: usize,
        end: usize,
        keep: impl Fn(&FrameKey) -> bool,
    ) -> Vec<LatestById> {
        let now = Instant::now();
        // (key, last-in-window index, frame). When the window reaches the
        // tip (the running follow-live case), the maintained `latest` index
        // and the eager overlay already hold each key's newest frame — serve
        // the frame from the overlay, not a raw read, so a row whose index
        // has evicted below the low-water mark still resolves (ADR 0002
        // DS-8).
        let (end, tip_rows, candidates) = {
            let inner = self.lock_inner();
            let len = inner.raw.len();
            let end = end.min(len);
            if start >= end {
                return Vec::new();
            }
            let live = inner
                .per_key
                .iter()
                .filter(|(key, e)| e.last_index >= start && keep(key));
            if end == len {
                let rows: Vec<(FrameKey, usize, RawTraceFrame)> = live
                    .map(|(key, e)| (key.clone(), e.last_index, e.last_frame.clone()))
                    .collect();
                (end, Some(rows), 0)
            } else {
                // A key present in the window has an occurrence at some
                // index at or above `start`, so its *global* last index is
                // at or above `start` too: this count is an upper bound on
                // the distinct keys the window can hold, and so the backward
                // scan's stopping condition.
                (end, None, live.count())
            }
        };
        let mut rows = match tip_rows {
            Some(rows) => rows,
            // A bounded window (paused / scrolled into history) has no
            // maintained answer and must walk. Chunked, so the append mutex
            // is taken per chunk and never across the walk — the
            // whole-buffer lock-hold that starves `append` and every other
            // command with it — and backward, so a snapshot over a long
            // stopped capture stops at the suffix that holds every id
            // instead of reading the capture out.
            None => self.scan_last_by_key(start, end, candidates, &keep),
        };
        rows.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        let inner = self.lock_inner();
        rows.into_iter()
            .map(|(key, idx, frame)| {
                let est = inner.per_key.get(&key).map(|e| &e.rate);
                LatestById {
                    index: idx,
                    frame,
                    rate: est.map_or(0.0, |r| r.rate(now)),
                    count: est.map_or(0, |r| r.count),
                }
            })
            .collect()
    }

    /// The chunked backward walk behind [`Self::latest_in_window_where`]'s
    /// bounded-window path: for each key `keep` accepts, its last
    /// occurrence within `[start, end)`, materialised.
    ///
    /// Walks back a chunk at a time — the inner mutex is held per chunk,
    /// never across the walk (see [`TraceStore::scan_chunk`]) — taking the
    /// first occurrence it meets of each key, which going backward is the
    /// last one in the window. Stops early once `candidates` distinct keys
    /// have turned up: that bounds the keys the store has seen at or above
    /// `start`, so nothing new can appear further back.
    fn scan_last_by_key(
        &self,
        start: usize,
        end: usize,
        candidates: usize,
        keep: &impl Fn(&FrameKey) -> bool,
    ) -> Vec<(FrameKey, usize, RawTraceFrame)> {
        let mut last: HashMap<FrameKey, usize> = HashMap::new();
        let mut chunk_end = end;
        while chunk_end > start && last.len() < candidates {
            let chunk_start = chunk_end.saturating_sub(SCAN_CHUNK).max(start);
            // The scan reports the indices it accepted; this collects the
            // key read at each one, in the same order, so the two zip. Every
            // stored frame carries a bus (`TraceStore::append` drops one
            // that does not), so the `None` arm is not a filter.
            let keys: RefCell<Vec<FrameKey>> = RefCell::new(Vec::new());
            let idxs = self.scan_chunk(chunk_start, chunk_end, |f| {
                let Some(bus) = f.bus_id.clone() else {
                    return false;
                };
                let key: FrameKey = (bus, f.channel, f.id, f.extended);
                if !keep(&key) {
                    return false;
                }
                keys.borrow_mut().push(key);
                true
            });
            for (idx, key) in idxs.into_iter().zip(keys.into_inner()).rev() {
                last.entry(key).or_insert(idx);
            }
            chunk_end = chunk_start;
        }
        let mut keyed: Vec<(FrameKey, usize)> = last.into_iter().collect();
        keyed.sort_unstable();
        let idxs: Vec<usize> = keyed.iter().map(|(_, idx)| *idx).collect();
        // Matched by index, not by position. The walk released the lock
        // between chunks, so eviction may have front-trimmed a row out
        // from under it (ADR 0002 DS-8) — `frames_at` then returns fewer
        // frames than indices, and a positional pairing would hand every
        // key after the gap the wrong frame. A row that has gone is
        // dropped; a frame has exactly one key, so no index repeats here.
        let mut frames: HashMap<usize, RawTraceFrame> = self.frames_at(&idxs).into_iter().collect();
        keyed
            .into_iter()
            .filter_map(|(key, idx)| frames.remove(&idx).map(|frame| (key, idx, frame)))
            .collect()
    }

    /// Install (or clear, with `None`) the multiplexor-selector
    /// extractor. Called whenever the loaded-DBC set changes; the mux
    /// index and its statistics reset — selector groups may mean
    /// something different under the new DBCs — and coverage restarts
    /// at the current tip (`super::Inner::mux_index_from`); history below
    /// it is served by [`Self::latest_mux_in_window`]'s backward scan.
    pub fn set_mux_extractor(&self, extractor: Option<std::sync::Arc<MuxSelectorFn>>) {
        let mut inner = self.lock_inner();
        inner.mux_selector_of = extractor;
        inner.latest_mux = HashMap::new();
        inner.mux_rates = HashMap::new();
        inner.mux_index_from = inner.raw.len();
    }

    /// Latest `(index, frame)` within `[start, end)` for each requested
    /// selector group of one message stream — the per-signal analog of
    /// [`Self::latest_in_window`]: a mux signal's latest value is the
    /// last frame *whose selector matched its group*, so decoding only
    /// the message's latest frame would blank every other group.
    ///
    /// Selectors whose group has no frame in the window are absent from
    /// the result (the caller renders a blank row). Served from the
    /// incrementally-maintained index where it covers the window;
    /// otherwise by a backward scan over the raw store bounded to
    /// `MUX_SCAN_BOUND` frames — a group further back than that reads
    /// as blank (the documented give-up). Scan hits at the buffer tip
    /// are backfilled into the index so repeated live queries converge
    /// to the O(groups) path. Returns empty with no extractor installed
    /// (nothing can classify frames into groups).
    #[must_use]
    pub fn latest_mux_in_window(
        &self,
        bus_id: Option<&str>,
        id: u32,
        extended: bool,
        selectors: &[u64],
        start: usize,
        end: usize,
    ) -> HashMap<u64, (usize, RawTraceFrame)> {
        let mut out = HashMap::new();
        // A query naming no bus is the legacy any-bus series, and no
        // stored frame is on "no bus" — so it selects nothing, exactly
        // as it did when a bus-less frame was merely rare.
        let Some(bus_id) = bus_id else { return out };
        let mut missing: Vec<u64> = Vec::new();
        let (len, extractor) = {
            let inner = self.lock_inner();
            let len = inner.raw.len();
            let end = end.min(len);
            if start >= end {
                return out;
            }
            let Some(extractor) = inner.mux_selector_of.clone() else {
                return out;
            };
            let covered = inner.mux_index_from <= start;
            for &sel in selectors {
                let mkey: MuxKey = (bus_id.to_string(), id, extended, sel);
                match inner.latest_mux.get(&mkey) {
                    // A map entry is the group's latest at the tip. If it
                    // sits inside the window it is also the latest within
                    // the window (nothing newer exists at all, so nothing
                    // newer exists below `end` either).
                    Some((idx, f)) if *idx >= start && *idx < end => {
                        out.insert(sel, (*idx, f.clone()));
                    }
                    // Entry below the window with full coverage: any
                    // in-window match would have overwritten it → none.
                    Some((idx, _)) if *idx < start && covered => {}
                    // Entry past the window end, or no entry: the map
                    // can't answer; scan — unless coverage proves absence.
                    None if covered => {}
                    _ => missing.push(sel),
                }
            }
            (len, extractor)
        };
        if !missing.is_empty() {
            let end = end.min(len);
            let found =
                self.scan_latest_mux(bus_id, id, extended, &missing, start, end, &extractor);
            // Tip-window hits are "latest at the tip" — backfill them so
            // the next live query takes the O(groups) path. (Bounded
            // windows below the tip stay scan-served; their result is
            // not the tip's latest.)
            if end == len && !found.is_empty() {
                let mut inner = self.lock_inner();
                for (sel, (idx, frame)) in &found {
                    let mkey: MuxKey = (bus_id.to_string(), id, extended, *sel);
                    // Never regress an entry a concurrent append advanced.
                    match inner.latest_mux.get(&mkey) {
                        Some((have, _)) if *have >= *idx => {}
                        _ => {
                            inner.latest_mux.insert(mkey, (*idx, frame.clone()));
                        }
                    }
                }
            }
            out.extend(found);
        }
        out
    }

    /// The bounded backward scan behind [`Self::latest_mux_in_window`]:
    /// walk `[start, end)` from the back in chunks (the inner mutex is
    /// held per chunk, never across the walk), classify matching frames
    /// with `extractor`, and record the first (= latest) hit per wanted
    /// selector. Stops when every selector is found, the window is
    /// exhausted, or [`MUX_SCAN_BOUND`] frames have been examined.
    #[allow(clippy::too_many_arguments)] // internal helper mirroring the public query's key
    fn scan_latest_mux(
        &self,
        bus_id: &str,
        id: u32,
        extended: bool,
        selectors: &[u64],
        start: usize,
        end: usize,
        extractor: &std::sync::Arc<MuxSelectorFn>,
    ) -> HashMap<u64, (usize, RawTraceFrame)> {
        let mut found = HashMap::new();
        let mut wanted: Vec<u64> = selectors.to_vec();
        let floor = start.max(end.saturating_sub(MUX_SCAN_BOUND));
        let mut chunk_end = end;
        while chunk_end > floor && !wanted.is_empty() {
            let chunk_start = chunk_end.saturating_sub(SCAN_CHUNK).max(floor);
            let want = wanted.clone();
            let ext = extractor.clone();
            let hits = self.scan_chunk(chunk_start, chunk_end, move |f| {
                f.id == id
                    && f.extended == extended
                    && f.bus_id.as_deref() == Some(bus_id)
                    && ext(f).is_some_and(|s| want.contains(&s))
            });
            // Materialise from the back in small batches — the newest
            // hit per selector wins, so most hits are never cloned.
            for batch in hits.rchunks(64) {
                for (idx, frame) in self.frames_at(batch).into_iter().rev() {
                    let Some(sel) = extractor(&frame) else {
                        continue;
                    };
                    if wanted.contains(&sel) {
                        wanted.retain(|s| *s != sel);
                        found.insert(sel, (idx, frame));
                    }
                }
                if wanted.is_empty() {
                    break;
                }
            }
            chunk_end = chunk_start;
        }
        found
    }

    /// Update statistics for one selector group: `(rate, count)` — the
    /// per-signal counterparts of the by-id view's msg/s and count
    /// columns, counting only frames whose selector matched. `None`
    /// until the group has been observed (which also means: counted
    /// from extractor installation onward, not retroactively).
    #[must_use]
    pub fn mux_stats(
        &self,
        bus_id: Option<&str>,
        id: u32,
        extended: bool,
        selector: u64,
    ) -> Option<(f64, u64)> {
        let now = Instant::now();
        // As in `latest_mux_in_window`: a query on no bus matches no
        // stored frame, so it has no statistics.
        let bus_id = bus_id?;
        let inner = self.lock_inner();
        let mkey: MuxKey = (bus_id.to_string(), id, extended, selector);
        inner.mux_rates.get(&mkey).map(|r| (r.rate(now), r.count))
    }

    /// The distinct `(bus_id, id, extended)` keys seen this session, from
    /// the maintained newest-per-key map (so it is id-space-bounded, not a
    /// capture walk). The filter-index candidate resolver
    /// (`filter::resolve_candidates`) reads it to turn a `bus` predicate
    /// into the ids on that bus and an `id_range` into the ids that
    /// actually occurred. Channels are collapsed: a `(bus, id, extended)`
    /// is reported once regardless of how many wire channels carried it.
    #[must_use]
    pub fn seen_bus_ids(&self) -> Vec<(String, u32, bool)> {
        let inner = self.lock_inner();
        let mut out: Vec<(String, u32, bool)> = inner
            .per_key
            .keys()
            .map(|(bus, _ch, id, ext)| (bus.clone(), *id, *ext))
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;
    use crate::trace_store::test_support::{dummy, dummy_on_bus, TEST_BUS};
    use cannet_core::CanFramePayload;

    #[test]
    fn latest_since_keeps_one_frame_per_id_above_the_cutoff() {
        let store = TraceStore::new();
        for id in [1u32, 2, 1, 3, 2] {
            store.append(dummy(0, id)); // indices 0..5
        }
        // From the start, sorted by id: 1@2, 2@4, 3@3.
        assert_eq!(
            store
                .latest_since(0)
                .iter()
                .map(|l| (l.index, l.frame.id))
                .collect::<Vec<_>>(),
            vec![(2, 1), (4, 2), (3, 3)],
        );
        // Cutoff at index 3 drops id 1 (its latest is at index 2).
        assert_eq!(
            store
                .latest_since(3)
                .iter()
                .map(|l| (l.index, l.frame.id))
                .collect::<Vec<_>>(),
            vec![(4, 2), (3, 3)],
        );
        store.start_session(0);
        assert!(store.latest_since(0).is_empty());
    }

    #[test]
    fn latest_in_window_where_serves_only_the_keys_asked_for() {
        // The unrestricted snapshot clones a key and a frame payload per
        // distinct id in the capture — the whole id space — for a caller
        // that wants a page's worth of streams. Both paths through the
        // function have to honour the restriction: the tip fast path over
        // the maintained key map, and the bounded-window scan.
        let store = TraceStore::new();
        for id in [1u32, 2, 3, 2, 1] {
            store.append(dummy(0, id));
        }
        let only_two = |k: &FrameKey| k.2 == 2;
        // Tip fast path (`end == len`).
        assert_eq!(
            store
                .latest_in_window_where(0, store.len(), only_two)
                .iter()
                .map(|l| (l.index, l.frame.id))
                .collect::<Vec<_>>(),
            vec![(3, 2)],
        );
        // Bounded window (paused / scrolled into history).
        assert_eq!(
            store
                .latest_in_window_where(0, 3, only_two)
                .iter()
                .map(|l| (l.index, l.frame.id))
                .collect::<Vec<_>>(),
            vec![(1, 2)],
        );
        // …and it is the same answer the unrestricted form gives, filtered.
        assert_eq!(
            store
                .latest_in_window_where(0, store.len(), |_| true)
                .iter()
                .filter(|l| l.frame.id == 2)
                .map(|l| (l.index, l.frame.id))
                .collect::<Vec<_>>(),
            vec![(3, 2)],
        );
    }

    /// A window that spans several [`SCAN_CHUNK`]s, with one key whose
    /// only occurrence is at the very start (so the walk cannot stop
    /// early) and one that exists only past the window's end.
    fn multi_chunk_store(n: usize) -> Arc<TraceStore> {
        let store = Arc::new(TraceStore::new());
        store.append(dummy(0, 7));
        for _ in 1..n {
            store.append(dummy(0, 1));
        }
        store.append(dummy(0, 9));
        store
    }

    #[test]
    fn latest_in_window_walks_a_multi_chunk_window_backwards() {
        // The bounded-window path walks in chunks from the end. A key
        // whose last in-window occurrence sits chunks back from that end
        // must still be found, and a key that exists only past the end
        // must not leak in.
        let n = SCAN_CHUNK * 2 + 1_000;
        let store = multi_chunk_store(n);
        assert_eq!(
            store
                .latest_in_window_where(0, n, |_| true)
                .iter()
                .map(|l| (l.frame.id, l.index))
                .collect::<Vec<_>>(),
            vec![(1, n - 1), (7, 0)],
        );
    }

    #[test]
    fn a_bounded_window_scan_leaves_append_free_to_run() {
        // The lock-hold this exists to prevent: the bounded-window
        // snapshot used to clone and walk the whole window under the
        // inner mutex, so over a long stopped capture every command —
        // and the health sampler — queued behind one descriptor change.
        // Chunked, appends land *during* the walk rather than after it.
        let n = SCAN_CHUNK * 3;
        let store = multi_chunk_store(n);

        let started = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let landed = Arc::new(AtomicUsize::new(0));
        let appender = {
            let (store, started, done, landed) = (
                Arc::clone(&store),
                Arc::clone(&started),
                Arc::clone(&done),
                Arc::clone(&landed),
            );
            std::thread::spawn(move || {
                while !started.load(Ordering::Relaxed) {
                    std::thread::yield_now();
                }
                while !done.load(Ordering::Relaxed) {
                    store.append(dummy(0, 1));
                    // Only an append that *returned* before the walk
                    // finished counts: one that blocked on the mutex for
                    // the whole walk is exactly the starvation under test.
                    if !done.load(Ordering::Relaxed) {
                        landed.fetch_add(1, Ordering::Relaxed);
                    }
                }
            })
        };

        let signal = Arc::clone(&started);
        let rows = store.latest_in_window_where(0, n, move |_| {
            signal.store(true, Ordering::Relaxed);
            true
        });
        done.store(true, Ordering::Relaxed);
        appender.join().unwrap();

        assert_eq!(rows.len(), 2);
        assert!(
            landed.load(Ordering::Relaxed) > 0,
            "no append completed while the window scan was walking",
        );
    }

    #[test]
    fn key_generation_moves_only_when_the_key_set_does() {
        // The invalidation signal for anything derived from "which ids
        // exist" — the filtered trace's candidate resolution memoises on
        // it, so a repeat of a known id must not disturb it and a new id
        // must.
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        let after_first = store.key_generation();
        store.append(dummy(1, 1)); // same key again
        assert_eq!(store.key_generation(), after_first);
        store.append(dummy(2, 2)); // new id
        assert_ne!(store.key_generation(), after_first);
        let after_two = store.key_generation();
        store.start_session(0); // the map is rebuilt empty
        assert_ne!(store.key_generation(), after_two);
    }

    #[test]
    fn latest_in_window_bounds_to_the_window_end() {
        // Snapshot-correctness: a paused/stopped window must reflect the
        // window it shows, not the live tip. id 1 recurs after the window
        // closes; bounding to `end` keeps its in-window latest.
        let store = TraceStore::new();
        for id in [1u32, 2, 1, 2, 1] {
            store.append(dummy(0, id)); // indices: 0=1,1=2,2=1,3=2,4=1
        }
        // Window past the tip == global latest: id1@4, id2@3.
        assert_eq!(
            store
                .latest_in_window(0, store.len())
                .iter()
                .map(|l| (l.frame.id, l.index))
                .collect::<Vec<_>>(),
            vec![(1, 4), (2, 3)],
        );
        // Bounded to [0, 3): id1's last in-window frame is @2 (not @4).
        assert_eq!(
            store
                .latest_in_window(0, 3)
                .iter()
                .map(|l| (l.frame.id, l.index))
                .collect::<Vec<_>>(),
            vec![(1, 2), (2, 1)],
        );
        // start >= end → empty.
        assert!(store.latest_in_window(5, 3).is_empty());
    }

    // --- mux-group latest index (signal snapshot backing) ---

    /// A classic frame whose first payload byte doubles as the mux
    /// selector under [`byte0_extractor`].
    fn muxed(ts_ns: u64, id: u32, sel: u8) -> RawTraceFrame {
        RawTraceFrame {
            payload: CanFramePayload::Classic(vec![sel]),
            ..dummy(ts_ns, id)
        }
    }

    /// Test extractor: payload byte 0 is the selector; empty payload =
    /// not a mux message.
    fn byte0_extractor() -> std::sync::Arc<MuxSelectorFn> {
        std::sync::Arc::new(|f: &RawTraceFrame| f.payload.data().first().copied().map(u64::from))
    }

    #[test]
    fn mux_latest_tracks_per_selector_on_append() {
        let store = TraceStore::new();
        store.set_mux_extractor(Some(byte0_extractor()));
        store.append(muxed(1_000, 0x10, 0)); // idx 0
        store.append(muxed(2_000, 0x10, 1)); // idx 1
        store.append(muxed(3_000, 0x10, 0)); // idx 2
        store.append(dummy(4_000, 0x20)); // other id, no payload → no selector
        let got =
            store.latest_mux_in_window(Some(TEST_BUS), 0x10, false, &[0, 1, 2], 0, usize::MAX);
        assert_eq!(
            got.get(&0).map(|(i, f)| (*i, f.timestamp_ns)),
            Some((2, 3_000))
        );
        assert_eq!(
            got.get(&1).map(|(i, f)| (*i, f.timestamp_ns)),
            Some((1, 2_000))
        );
        // Selector 2 never appeared — absent, not blank-with-a-row here.
        assert!(!got.contains_key(&2));
        // Per-group update statistics.
        assert_eq!(
            store
                .mux_stats(Some(TEST_BUS), 0x10, false, 0)
                .map(|(_, c)| c),
            Some(2)
        );
        assert_eq!(
            store
                .mux_stats(Some(TEST_BUS), 0x10, false, 1)
                .map(|(_, c)| c),
            Some(1)
        );
        assert_eq!(store.mux_stats(Some(TEST_BUS), 0x10, false, 2), None);
    }

    #[test]
    fn mux_latest_bounds_to_the_window_end() {
        // A paused window must not leak a selector's later frame in.
        let store = TraceStore::new();
        store.set_mux_extractor(Some(byte0_extractor()));
        store.append(muxed(1_000, 0x10, 0)); // idx 0
        store.append(muxed(2_000, 0x10, 1)); // idx 1
        store.append(muxed(3_000, 0x10, 0)); // idx 2
        let got = store.latest_mux_in_window(Some(TEST_BUS), 0x10, false, &[0, 1], 0, 2);
        assert_eq!(got.get(&0).map(|(i, _)| *i), Some(0)); // not idx 2
        assert_eq!(got.get(&1).map(|(i, _)| *i), Some(1));
        // Window [0, 1): selector 1 hasn't appeared yet.
        let got = store.latest_mux_in_window(Some(TEST_BUS), 0x10, false, &[0, 1], 0, 1);
        assert_eq!(got.get(&0).map(|(i, _)| *i), Some(0));
        assert!(!got.contains_key(&1));
    }

    #[test]
    fn mux_latest_backfills_when_the_extractor_arrives_late() {
        // Frames appended before the extractor is installed (DBC
        // attached mid-session, BLF imported first) aren't in the
        // incremental map — the query must find them by the bounded
        // backward scan, and later appends must keep them current.
        let store = TraceStore::new();
        store.append(muxed(1_000, 0x10, 0)); // idx 0
        store.append(muxed(2_000, 0x10, 1)); // idx 1
        store.set_mux_extractor(Some(byte0_extractor()));
        let got = store.latest_mux_in_window(Some(TEST_BUS), 0x10, false, &[0, 1], 0, usize::MAX);
        assert_eq!(got.get(&0).map(|(i, _)| *i), Some(0));
        assert_eq!(got.get(&1).map(|(i, _)| *i), Some(1));
        // A post-install append updates the group incrementally.
        store.append(muxed(3_000, 0x10, 1)); // idx 2
        let got = store.latest_mux_in_window(Some(TEST_BUS), 0x10, false, &[0, 1], 0, usize::MAX);
        assert_eq!(got.get(&0).map(|(i, _)| *i), Some(0));
        assert_eq!(got.get(&1).map(|(i, _)| *i), Some(2));
    }

    #[test]
    fn mux_latest_is_scoped_per_bus() {
        let store = TraceStore::new();
        store.set_mux_extractor(Some(byte0_extractor()));
        let mut on_a = muxed(1_000, 0x10, 0);
        on_a.bus_id = Some("a".into());
        store.append(on_a); // idx 0
        store.append(muxed(2_000, 0x10, 0)); // idx 1, on TEST_BUS
        let a = store.latest_mux_in_window(Some("a"), 0x10, false, &[0], 0, usize::MAX);
        assert_eq!(a.get(&0).map(|(i, _)| *i), Some(0));
        let other = store.latest_mux_in_window(Some(TEST_BUS), 0x10, false, &[0], 0, usize::MAX);
        assert_eq!(other.get(&0).map(|(i, _)| *i), Some(1));
        // A query naming no bus is the legacy any-bus series: no stored
        // frame is on "no bus", so it selects nothing.
        assert!(store
            .latest_mux_in_window(None, 0x10, false, &[0], 0, usize::MAX)
            .is_empty());
    }

    #[test]
    fn start_session_clears_the_mux_index_but_keeps_the_extractor() {
        let store = TraceStore::new();
        store.set_mux_extractor(Some(byte0_extractor()));
        store.append(muxed(1_000, 0x10, 0));
        store.start_session(0);
        assert!(store
            .latest_mux_in_window(Some(TEST_BUS), 0x10, false, &[0], 0, usize::MAX)
            .is_empty());
        assert_eq!(store.mux_stats(Some(TEST_BUS), 0x10, false, 0), None);
        // The extractor survives the clear — the DBC set didn't change.
        store.append(muxed(2_000, 0x10, 0));
        let got = store.latest_mux_in_window(Some(TEST_BUS), 0x10, false, &[0], 0, usize::MAX);
        assert_eq!(got.get(&0).map(|(i, _)| *i), Some(0));
        assert_eq!(
            store
                .mux_stats(Some(TEST_BUS), 0x10, false, 0)
                .map(|(_, c)| c),
            Some(1)
        );
    }

    #[test]
    fn latest_since_keeps_one_row_per_bus_for_the_same_wire_channel_and_id() {
        // Multi-server regression: two servers both reporting wire
        // channel 0 with arbitration id 0x100, each bound to a
        // different logical bus. The per-id snapshot must surface
        // both — historically `FrameKey = (channel, id, extended)`
        // collapsed them into one entry.
        let store = TraceStore::new();
        store.append(dummy_on_bus(0, 0x100, "p"));
        store.append(dummy_on_bus(1_000, 0x100, "c"));
        store.append(dummy_on_bus(2_000, 0x100, "p")); // newer "p" frame
        let rows = store.latest_since(0);
        let by_bus: Vec<(Option<&str>, u64)> = rows
            .iter()
            .map(|r| (r.frame.bus_id.as_deref(), r.frame.timestamp_ns))
            .collect();
        // One row per (bus, channel, id) with each bus's latest frame.
        assert_eq!(by_bus, vec![(Some("c"), 1_000), (Some("p"), 2_000)],);
    }

    #[test]
    fn latest_since_reports_per_id_frame_count() {
        // Each `FrameKey` (bus, channel, id, extended) accumulates a
        // total frame count over the session — what the per-id view's
        // `#` column displays. Distinct buses count independently.
        let store = TraceStore::new();
        for _ in 0..3 {
            store.append(dummy_on_bus(0, 0x100, "a"));
        }
        store.append(dummy_on_bus(0, 0x200, "a"));
        store.append(dummy_on_bus(0, 0x100, "b"));
        store.append(dummy_on_bus(0, 0x100, "b"));
        let rows = store.latest_since(0);
        let mut counts: Vec<(Option<&str>, u32, u64)> = rows
            .iter()
            .map(|r| (r.frame.bus_id.as_deref(), r.frame.id, r.count))
            .collect();
        counts.sort();
        assert_eq!(
            counts,
            vec![
                (Some("a"), 0x100, 3),
                (Some("a"), 0x200, 1),
                (Some("b"), 0x100, 2),
            ],
        );
    }

    #[test]
    fn latest_since_keeps_each_bus_distinct() {
        // Edge case: two frames sharing a wire channel and id but
        // arriving on different buses are different rows — neither
        // overwrites the other.
        let store = TraceStore::new();
        store.append(dummy_on_bus(0, 0x200, "b"));
        store.append(dummy_on_bus(1_000, 0x200, "a"));
        let rows = store.latest_since(0);
        let buses: Vec<Option<&str>> = rows.iter().map(|r| r.frame.bus_id.as_deref()).collect();
        assert_eq!(buses, vec![Some("a"), Some("b")]);
    }

    #[test]
    fn seen_bus_ids_reports_distinct_bus_id_keys_collapsing_channels() {
        let store = TraceStore::new();
        store.append(dummy_on_bus(0, 0x100, "pt"));
        store.append(dummy_on_bus(1, 0x100, "pt")); // same key — collapses
        store.append(dummy_on_bus(2, 0x200, "pt"));
        store.append(dummy_on_bus(3, 0x100, "body")); // same id, other bus
        let seen = store.seen_bus_ids();
        assert_eq!(
            seen,
            vec![
                ("body".to_string(), 0x100, false),
                ("pt".to_string(), 0x100, false),
                ("pt".to_string(), 0x200, false),
            ],
        );
    }
}
