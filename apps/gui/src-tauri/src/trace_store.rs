//! In-memory model for the trace view.
//!
//! The store is the model layer the trace UI is a view over. Pump
//! threads (BLF, remote) append frames as they arrive; the frontend
//! pulls slices on demand via the `fetch_trace_range` Tauri command,
//! sized to the virtualizer's visible window plus a small prefetch
//! pad. Decoding against the currently-attached DBC happens at fetch
//! time, so attaching or replacing a DBC just changes what subsequent
//! fetches return — there is no retro-decode walk through the whole
//! trace.
//!
//! ## What's in the store
//!
//! [`RawTraceFrame`] is the canonical undecoded shape. It owns its
//! payload bytes (no borrowing into a parent file or stream) so once
//! a frame is appended the source it came from is irrelevant. Append
//! is `O(1)` via [`Vec::push`]; slices clone out of the lock so the
//! decoder can run without holding it.
//!
//! ## Bounds and the future
//!
//! The Phase-2 store is `Vec<RawTraceFrame>`. For a long-running
//! session this grows unbounded — see `plans/backlog.md` for the
//! disk-spill follow-up. The interface here is shaped so that
//! evolution (windowed in-memory tail + on-disk overflow) can land
//! behind the same `append` / `len` / `slice` surface without
//! reshaping callers.
//!
//! ## Rate estimation
//!
//! Rates are computed from per-frame `timestamp_ns` (the bus-side
//! arrival time the driver stamped), not from when the frame was
//! appended to the store. The rx pump batches frames together — at the
//! store, every frame in a batch lands within microseconds of every
//! other one — so a wall-clock inter-arrival would oscillate between
//! near-zero (within a batch) and the batch cadence (between batches)
//! for a periodic signal that's actually arriving at a steady rate.
//! Keying off `timestamp_ns` makes the rate read what the bus is
//! actually doing.
//!
//! Wall-clock is still kept alongside, but only for stall behavior:
//! when no fresh frames arrive, [`RateEstimate::rate`] decays toward
//! zero on wall-clock elapsed since the last observation, and
//! [`Self::frames_per_second`]'s sample deque is pruned by wall time.
//! Without this, a stalled stream would show its last rate forever
//! (frame timestamps would have nothing to advance them).
//!
//! The store keeps a rolling window of
//! `(Instant, last_frame_ts_ns, total_count)` samples, one taken at
//! most every [`RATE_SAMPLE_INTERVAL`] — a sample *per appended frame*
//! would balloon the deque at high replay rates for no extra signal,
//! since [`Self::frames_per_second`] only reads the window's endpoints.
//! The window is pruned to [`RATE_WINDOW`] on each touch; the rate is
//! the count delta over the frame-time the surviving samples span,
//! falling back to `0.0` if there isn't yet enough signal to estimate.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cannet_core::{CanFrame, CanFramePayload, Direction};

/// How far back the rate estimator looks. One second is short enough
/// that a stalled stream registers immediately and long enough that
/// per-batch jitter (256-frame batches at 60+ fps) doesn't bounce the
/// reading around.
const RATE_WINDOW: Duration = Duration::from_secs(1);

/// Minimum spacing between rate samples. At a multi-thousand-frame/s
/// replay a per-frame sample would pile up tens of thousands of deque
/// entries each second; bounding the cadence caps the deque at roughly
/// `RATE_WINDOW / RATE_SAMPLE_INTERVAL` entries while still tracking
/// the rate closely enough for a status line.
const RATE_SAMPLE_INTERVAL: Duration = Duration::from_millis(20);

/// Smoothing factor for the per-id message-rate estimate (an EMA of the
/// inter-arrival time). Smaller = steadier, slower to react.
const PER_ID_RATE_ALPHA: f64 = 0.2;

/// Identifies a "kind of frame" for the latest-by-id view: the
/// logical bus (`None` = unassigned, a distinct bucket from any named
/// bus), the wire channel, the arbitration id, and whether it's an
/// extended id (a standard and an extended id with the same numeric
/// value are distinct frames). Keying on `bus_id` matters when two
/// servers report frames on the same wire channel — without it, the
/// per-id snapshot would collapse them into one row.
type FrameKey = (Option<String>, u8, u32, bool);

/// Identifies a frame by arbitration id alone (id value + addressing
/// mode, channel-independent) — what signal sampling keys on, since a
/// DBC message id isn't channel-scoped.
type IdKey = (u32, bool);

/// Per-id message-rate estimate. Tracks the EMA of the *frame-time*
/// inter-arrival (the bus-side cadence) plus the wall-clock time of
/// the last observation (so a stalled stream visibly decays to zero
/// even though frame timestamps stop advancing).
#[derive(Debug, Clone, Copy)]
struct RateEstimate {
    last_ts_ns: u64,
    last_wall: Instant,
    ema_dt_secs: f64,
}

impl RateEstimate {
    fn first_seen(ts_ns: u64, now: Instant) -> Self {
        Self {
            last_ts_ns: ts_ns,
            last_wall: now,
            ema_dt_secs: 0.0,
        }
    }

    /// Fold in a new frame stamped at `ts_ns` and appended at wall-time
    /// `now`.
    #[allow(clippy::cast_precision_loss)] // ns diffs fit comfortably in f64's mantissa.
    fn observe(&mut self, ts_ns: u64, now: Instant) {
        let dt = ts_ns.saturating_sub(self.last_ts_ns) as f64 / 1e9;
        if self.ema_dt_secs <= 0.0 {
            if dt > 0.0 {
                self.ema_dt_secs = dt;
            }
        } else if dt > 0.0 {
            self.ema_dt_secs = PER_ID_RATE_ALPHA * dt + (1.0 - PER_ID_RATE_ALPHA) * self.ema_dt_secs;
        }
        self.last_ts_ns = ts_ns;
        self.last_wall = now;
    }

    /// Messages/second as of wall-time `now` — `0.0` until two frames
    /// have been seen, and decaying toward `0` once frames stop
    /// arriving (the effective interval grows with the wall-time since
    /// the last one, so a stalled stream visibly drops).
    fn rate(&self, now: Instant) -> f64 {
        if self.ema_dt_secs <= 0.0 {
            return 0.0;
        }
        let since = now.duration_since(self.last_wall).as_secs_f64();
        let dt = since.max(self.ema_dt_secs);
        if dt > 0.0 { 1.0 / dt } else { 0.0 }
    }
}

/// A row of the latest-by-id snapshot: the frame's index in the buffer,
/// the frame, and the id's current message rate.
#[derive(Debug, Clone)]
pub struct LatestById {
    pub index: usize,
    pub frame: RawTraceFrame,
    pub rate: f64,
}

/// One row in the trace store. Owned, undecoded.
///
/// `bus_id` is the project's logical bus this frame was routed onto
/// (Phase 6) — `None` if no binding/mapping assigned one. Pump threads
/// stamp it before appending; per-bus DBC scoping and the filter
/// predicate both read it. `channel` keeps its meaning (the source's
/// 0-based channel number) and is what the user maps onto a `bus_id`
/// at import / connect time.
#[derive(Debug, Clone)]
pub struct RawTraceFrame {
    pub timestamp_ns: u64,
    pub channel: u8,
    pub id: u32,
    pub extended: bool,
    pub direction: Direction,
    pub payload: CanFramePayload,
    pub bus_id: Option<String>,
}

impl From<CanFrame> for RawTraceFrame {
    fn from(frame: CanFrame) -> Self {
        Self {
            timestamp_ns: frame.timestamp_ns,
            channel: frame.channel,
            id: frame.id.raw(),
            extended: frame.id.is_extended(),
            direction: frame.direction,
            payload: frame.payload,
            bus_id: None,
        }
    }
}

/// The trace model. Single producer (per pump thread) is typical but
/// not required; multiple producers serialise on the inner mutex.
pub struct TraceStore {
    inner: Mutex<Inner>,
}

/// One entry in the trace-wide rate-sample deque. `wall` is the
/// append's wall-clock time (used to prune the window so a stalled
/// stream visibly drops to zero); `ts_ns` is the frame's bus-side
/// timestamp (used to compute the rate, so batching jitter doesn't
/// bounce the reading); `count` is the running frame total at that
/// point.
#[derive(Debug, Clone, Copy)]
struct RateSample {
    wall: Instant,
    ts_ns: u64,
    count: usize,
}

struct Inner {
    frames: Vec<RawTraceFrame>,
    rate_samples: VecDeque<RateSample>,
    /// Index into `frames` of the most recent frame seen for each
    /// [`FrameKey`] — `O(1)` to maintain on append, and what the
    /// per-message-ID view reads instead of walking the whole buffer.
    latest: HashMap<FrameKey, usize>,
    /// Per-id message-rate estimate, also maintained `O(1)` on append.
    rates: HashMap<FrameKey, RateEstimate>,
    /// For each arbitration id ([`IdKey`]): the indices into `frames` of
    /// every frame with that id, in append (hence index-ascending)
    /// order. `O(1)` push on append; lets [`Self::slice_matching`] jump
    /// straight to a signal's frames in a window instead of scanning all
    /// of it — so a live plot of a sparse signal doesn't walk the whole
    /// capture each re-sample.
    by_id: HashMap<IdKey, Vec<usize>>,
}

impl TraceStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                frames: Vec::new(),
                rate_samples: VecDeque::new(),
                latest: HashMap::new(),
                rates: HashMap::new(),
                by_id: HashMap::new(),
            }),
        }
    }

    /// Append a frame to the tail of the trace. Updates the
    /// latest-by-key index and the per-id rate estimate, and records a
    /// rate sample if at least [`RATE_SAMPLE_INTERVAL`] has passed.
    pub fn append(&self, frame: RawTraceFrame) {
        let now = Instant::now();
        let ts_ns = frame.timestamp_ns;
        let key: FrameKey = (
            frame.bus_id.clone(),
            frame.channel,
            frame.id,
            frame.extended,
        );
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        let id_key = (frame.id, frame.extended);
        inner.frames.push(frame);
        let count = inner.frames.len();
        inner.latest.insert(key.clone(), count - 1);
        inner.by_id.entry(id_key).or_default().push(count - 1);
        inner
            .rates
            .entry(key)
            .or_insert_with(|| RateEstimate::first_seen(ts_ns, now))
            .observe(ts_ns, now);
        let due = match inner.rate_samples.back() {
            Some(last) => now.duration_since(last.wall) >= RATE_SAMPLE_INTERVAL,
            None => true,
        };
        if due {
            inner.rate_samples.push_back(RateSample {
                wall: now,
                ts_ns,
                count,
            });
            prune_rate_samples(&mut inner.rate_samples, now);
        }
    }

    /// Number of frames currently stored.
    #[must_use]
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("trace store mutex poisoned")
            .frames
            .len()
    }

    /// Cloned slice of frames in `[start, end)`. Clamped to the store's
    /// current bounds, so an over-large `end` returns whatever's
    /// available rather than erroring; an entirely out-of-range request
    /// returns an empty `Vec`.
    #[must_use]
    pub fn slice(&self, start: usize, end: usize) -> Vec<RawTraceFrame> {
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        let len = inner.frames.len();
        if start >= len {
            return Vec::new();
        }
        let end = end.min(len);
        inner.frames[start..end].to_vec()
    }

    /// First-and-last frame timestamps for the (clamped) range
    /// `[start, end)`, without cloning any frames. Used by
    /// `sample_signals` to anchor the x-axis at the window's first frame
    /// time and report the window's right edge — both independent of the
    /// per-signal decoded-sample slice the cache produces.
    #[must_use]
    pub fn frame_timestamps(&self, start: usize, end: usize) -> (Option<u64>, Option<u64>) {
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        let len = inner.frames.len();
        if start >= len {
            return (None, None);
        }
        let end = end.min(len);
        let first = inner.frames.get(start).map(|f| f.timestamp_ns);
        let last = end.checked_sub(1).and_then(|i| inner.frames.get(i)).map(|f| f.timestamp_ns);
        (first, last)
    }

    /// For one `(id, extended)` arbitration key: clone the matching
    /// frames in `[start, end)` **paired with their frame index in the
    /// store**. The per-id index ([`Inner::by_id`]) jumps straight to
    /// the matching frames, so the work is `O(matches + log n)` —
    /// what the host-side decoded-sample cache uses to map between
    /// frame indices and sample indices (a `[from_frame, to_frame)`
    /// query can then binary-search the cache).
    #[must_use]
    pub fn matching_frames_indexed(
        &self,
        id_raw: u32,
        extended: bool,
        start: usize,
        end: usize,
    ) -> Vec<(usize, RawTraceFrame)> {
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        let len = inner.frames.len();
        if start >= len {
            return Vec::new();
        }
        let end = end.min(len);
        match inner.by_id.get(&(id_raw, extended)) {
            Some(frame_idxs) => {
                let lo = frame_idxs.partition_point(|&i| i < start);
                let hi = frame_idxs.partition_point(|&i| i < end);
                frame_idxs[lo..hi].iter().map(|&i| (i, inner.frames[i].clone())).collect()
            }
            None => Vec::new(),
        }
    }

    /// Scan `[scan_start, scan_end)` (clamped), test each frame with
    /// `keep`, and return the total number of matches plus a windowed
    /// page of `(absolute index, cloned frame)` pairs — the matches at
    /// match-indices `[offset, offset + limit)`, or the last `limit`
    /// matches when `from_end`. Only the page's frames are cloned; the
    /// scan itself is by reference, so a filtered fetch never copies
    /// the whole window (which, on a multi-million-frame trace, dwarfed
    /// the predicate test). `limit == 0` returns the count alone.
    /// Backs `fetch_filtered_trace`.
    #[must_use]
    pub fn scan_window_filtered(
        &self,
        scan_start: usize,
        scan_end: usize,
        offset: u64,
        limit: u64,
        from_end: bool,
        keep: impl Fn(&RawTraceFrame) -> bool,
    ) -> (u64, Vec<(usize, RawTraceFrame)>) {
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        let len = inner.frames.len();
        if scan_start >= len {
            return (0, Vec::new());
        }
        let end = scan_end.min(len);
        let cap = usize::try_from(limit).unwrap_or(usize::MAX);
        let hi = offset.saturating_add(limit);
        let mut count: u64 = 0;
        let mut window: VecDeque<(usize, RawTraceFrame)> = VecDeque::new();
        for (i, frame) in inner.frames[scan_start..end].iter().enumerate() {
            if !keep(frame) {
                continue;
            }
            let match_idx = count;
            count += 1;
            if from_end {
                window.push_back((scan_start + i, frame.clone()));
                if window.len() > cap {
                    window.pop_front();
                }
            } else if match_idx >= offset && match_idx < hi {
                window.push_back((scan_start + i, frame.clone()));
            }
        }
        (count, window.into())
    }

    /// Drop every stored frame and release the backing allocations.
    ///
    /// `Vec::clear` / `VecDeque::clear` only reset the length — the
    /// (possibly enormous, after a long replay) buffers would stay
    /// resident. Replacing them with fresh empties hands the memory
    /// back to the allocator, so a small session after a large one
    /// doesn't carry the large session's footprint.
    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        inner.frames = Vec::new();
        inner.rate_samples = VecDeque::new();
        inner.latest = HashMap::new();
        inner.rates = HashMap::new();
        inner.by_id = HashMap::new();
    }

    /// For each distinct [`FrameKey`] whose most recent occurrence is at
    /// index `>= since`: that index, a clone of the frame, and the id's
    /// current message rate — sorted by key (channel, then id, then
    /// standard-before-extended). `since` is a trace window's start: for
    /// a *running* trace this is exactly "the latest frame of each id
    /// within the window"; for a paused/stopped trace whose end is below
    /// the buffer's tip it can include an id's later occurrence (fine
    /// for a live-values view).
    #[must_use]
    pub fn latest_since(&self, since: usize) -> Vec<LatestById> {
        let now = Instant::now();
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        let mut keyed: Vec<(FrameKey, usize)> = inner
            .latest
            .iter()
            .filter(|(_, &idx)| idx >= since)
            .map(|(key, &idx)| (key.clone(), idx))
            .collect();
        keyed.sort_unstable();
        keyed
            .into_iter()
            .map(|(key, idx)| LatestById {
                index: idx,
                frame: inner.frames[idx].clone(),
                rate: inner.rates.get(&key).map_or(0.0, |r| r.rate(now)),
            })
            .collect()
    }

    /// Estimated current append rate in frames per second.
    #[must_use]
    pub fn frames_per_second(&self) -> f64 {
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        prune_rate_samples(&mut inner.rate_samples, now);
        rate_from_samples(&inner.rate_samples)
    }
}

fn prune_rate_samples(samples: &mut VecDeque<RateSample>, now: Instant) {
    while let Some(front) = samples.front() {
        if now.duration_since(front.wall) > RATE_WINDOW {
            samples.pop_front();
        } else {
            break;
        }
    }
}

#[allow(clippy::cast_precision_loss)] // counts and ns diffs fit in f64's mantissa.
fn rate_from_samples(samples: &VecDeque<RateSample>) -> f64 {
    let (Some(first), Some(last)) = (samples.front(), samples.back()) else {
        return 0.0;
    };
    let dt = last.ts_ns.saturating_sub(first.ts_ns) as f64 / 1e9;
    if dt <= 0.0 {
        return 0.0;
    }
    let delta = (last.count.saturating_sub(first.count)) as f64;
    delta / dt
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_core::{CanId, Direction};

    fn dummy(ts_ns: u64, id: u32) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: ts_ns,
            channel: 0,
            id,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(vec![]),
            bus_id: None,
        }
    }

    fn dummy_on_bus(ts_ns: u64, id: u32, bus: &str) -> RawTraceFrame {
        let mut f = dummy(ts_ns, id);
        f.bus_id = Some(bus.into());
        f
    }

    fn dummy_canframe(ts_ns: u64, id: u32) -> CanFrame {
        CanFrame::classic(
            ts_ns,
            0,
            CanId::standard(id).unwrap(),
            Direction::Rx,
            vec![],
        )
        .unwrap()
    }

    #[test]
    fn append_then_slice() {
        let store = TraceStore::new();
        for i in 0u32..10 {
            store.append(dummy(u64::from(i) * 1_000, i));
        }
        assert_eq!(store.len(), 10);
        let slice = store.slice(2, 5);
        let ids: Vec<u32> = slice.iter().map(|f| f.id).collect();
        assert_eq!(ids, vec![2, 3, 4]);
    }

    #[test]
    fn slice_clamps_oversized_end() {
        let store = TraceStore::new();
        for i in 0u32..3 {
            store.append(dummy(0, i));
        }
        let slice = store.slice(1, 100);
        assert_eq!(slice.len(), 2);
    }


    #[test]
    fn matching_frames_indexed_returns_index_paired_clones() {
        let store = TraceStore::new();
        // ids:        7  3  7  3  7  9   (indices 0..6)
        for (i, id) in [7u32, 3, 7, 3, 7, 9].into_iter().enumerate() {
            store.append(dummy(u64::try_from(i).unwrap() * 1_000, id));
        }
        let pairs = store.matching_frames_indexed(7, false, 1, 5);
        assert_eq!(
            pairs.iter().map(|(i, f)| (*i, f.timestamp_ns)).collect::<Vec<_>>(),
            vec![(2, 2_000), (4, 4_000)],
        );
        // Out-of-range start: empty.
        assert!(store.matching_frames_indexed(7, false, 99, 200).is_empty());
        // Extended vs standard are distinct keys.
        assert!(store.matching_frames_indexed(7, true, 0, 6).is_empty());
        store.clear();
        assert!(store.matching_frames_indexed(7, false, 0, 6).is_empty());
    }

    #[test]
    fn scan_window_filtered_pages_matches_without_cloning_the_window() {
        let store = TraceStore::new();
        // id 256 on the even raw indices → 5 matches (raw 0, 2, 4, 6, 8).
        for i in 0u32..10 {
            store.append(dummy(0, if i % 2 == 0 { 256 } else { 999 }));
        }
        let keep = |f: &RawTraceFrame| f.id == 256;
        // Forward page [1, 3): match-indices 1, 2 → raw 2 and 4.
        let (count, page) = store.scan_window_filtered(0, 10, 1, 2, false, keep);
        assert_eq!(count, 5);
        assert_eq!(page.iter().map(|(i, _)| *i).collect::<Vec<_>>(), vec![2, 4]);
        // from_end, last 2 matches → raw 6 and 8.
        let (count, page) = store.scan_window_filtered(0, 10, 0, 2, true, keep);
        assert_eq!(count, 5);
        assert_eq!(page.iter().map(|(i, _)| *i).collect::<Vec<_>>(), vec![6, 8]);
        // Count-only (limit 0): the total, no rows cloned.
        let (count, page) = store.scan_window_filtered(0, 10, 0, 0, false, keep);
        assert_eq!(count, 5);
        assert!(page.is_empty());
    }

    #[test]
    fn frame_timestamps_returns_first_last_in_clamped_range() {
        let store = TraceStore::new();
        for i in 0u32..6 {
            store.append(dummy(u64::from(i) * 1_000, i));
        }
        assert_eq!(store.frame_timestamps(1, 4), (Some(1_000), Some(3_000)));
        assert_eq!(store.frame_timestamps(1, 100), (Some(1_000), Some(5_000)));
        assert_eq!(store.frame_timestamps(99, 200), (None, None));
    }

    #[test]
    fn slice_out_of_range_returns_empty() {
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        assert!(store.slice(10, 20).is_empty());
    }

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
        store.clear();
        assert!(store.latest_since(0).is_empty());
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
        assert_eq!(
            by_bus,
            vec![(Some("c"), 1_000), (Some("p"), 2_000)],
        );
    }

    #[test]
    fn latest_since_keeps_unassigned_distinct_from_a_named_bus() {
        // Edge case: an unassigned (`bus_id = None`) frame with the
        // same wire channel + id as a bus-tagged frame must not be
        // overwritten by it.
        let store = TraceStore::new();
        store.append(dummy(0, 0x200));
        store.append(dummy_on_bus(1_000, 0x200, "a"));
        let rows = store.latest_since(0);
        let buses: Vec<Option<&str>> =
            rows.iter().map(|r| r.frame.bus_id.as_deref()).collect();
        assert_eq!(buses, vec![None, Some("a")]);
    }

    #[test]
    #[allow(clippy::float_cmp)] // 0.0 is the exact "no estimate yet" sentinel.
    fn per_id_rate_is_zero_until_two_frames_then_estimates_and_decays() {
        let t0 = Instant::now();
        let mut r = RateEstimate::first_seen(0, t0);
        assert_eq!(r.rate(t0), 0.0); // one frame: no estimate yet
        // Second frame: 100 ms apart in *frame time*, but the wall clock
        // hasn't advanced at all (simulates batched arrival). Rate must
        // reflect the frame-time interval, not the wall-clock one.
        r.observe(100_000_000, t0);
        assert!((r.rate(t0) - 10.0).abs() < 1e-6);
        // No further frames: a second of wall time later the estimate
        // decays toward 1/s (stall behavior keyed off wall clock so a
        // dead stream visibly drops to zero).
        assert!((r.rate(t0 + Duration::from_secs(1)) - 1.0).abs() < 1e-3);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn per_id_rate_uses_frame_timestamp_not_batch_arrival() {
        // Regression: a periodic 100 Hz message that gets batched on
        // the rx pump arrives at the store with wall-clock intervals
        // close to zero (batches land tens of millis apart, each with
        // many frames inside). The bus-side cadence is 10 ms; the
        // rate must report that, not the batch shape.
        let store = TraceStore::new();
        for i in 0u64..20 {
            // Frame timestamps step 10 ms apart; wall clock barely
            // moves between appends (which the real pump does too).
            store.append(dummy(i * 10_000_000, 0x100));
        }
        let rows = store.latest_since(0);
        let rate = rows.iter().find(|r| r.frame.id == 0x100).unwrap().rate;
        // Allow a wide tolerance — EMA hasn't fully settled at 20 samples.
        assert!(
            (rate - 100.0).abs() < 10.0,
            "expected ~100/s from 10-ms frame-time gaps, got {rate}",
        );
    }

    #[test]
    fn clear_resets_len() {
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        store.append(dummy(0, 2));
        store.clear();
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn from_canframe_preserves_fields() {
        let frame = dummy_canframe(123_456, 0x10);
        let raw = RawTraceFrame::from(frame);
        assert_eq!(raw.timestamp_ns, 123_456);
        assert_eq!(raw.id, 0x10);
        assert!(!raw.extended);
        assert_eq!(raw.direction, Direction::Rx);
    }

    #[test]
    #[allow(clippy::float_cmp)] // 0.0 is the exact no-samples sentinel.
    fn rate_is_zero_with_no_samples() {
        let store = TraceStore::new();
        assert_eq!(store.frames_per_second(), 0.0);
    }
}
