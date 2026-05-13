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
//! The store keeps a rolling window of `(Instant, total_count)`
//! samples, one taken at most every [`RATE_SAMPLE_INTERVAL`] — a
//! sample *per appended frame* would balloon the deque at high replay
//! rates for no extra signal, since [`Self::frames_per_second`] only
//! reads the window's endpoints. The window is pruned to
//! [`RATE_WINDOW`] on each touch; the rate is the count delta over the
//! wall time the surviving samples span, or `0.0` if there isn't yet
//! enough signal to estimate.

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
/// channel, the arbitration id, and whether it's an extended id (a
/// standard and an extended id with the same numeric value are
/// distinct frames).
type FrameKey = (u8, u32, bool);

/// Identifies a frame by arbitration id alone (id value + addressing
/// mode, channel-independent) — what signal sampling keys on, since a
/// DBC message id isn't channel-scoped.
type IdKey = (u32, bool);

/// Per-id message-rate estimate: the time of the last frame for this
/// key and an exponential moving average of the inter-arrival time
/// (`<= 0` until a second frame has been seen).
#[derive(Debug, Clone, Copy)]
struct RateEstimate {
    last: Instant,
    ema_dt_secs: f64,
}

impl RateEstimate {
    fn first_seen(now: Instant) -> Self {
        Self { last: now, ema_dt_secs: 0.0 }
    }

    /// Fold in a new frame at `now`.
    fn observe(&mut self, now: Instant) {
        let dt = now.duration_since(self.last).as_secs_f64();
        if self.ema_dt_secs <= 0.0 {
            if dt > 0.0 {
                self.ema_dt_secs = dt;
            }
        } else if dt > 0.0 {
            self.ema_dt_secs = PER_ID_RATE_ALPHA * dt + (1.0 - PER_ID_RATE_ALPHA) * self.ema_dt_secs;
        }
        self.last = now;
    }

    /// Messages/second as of `now` — `0.0` until two frames have been
    /// seen, and decaying toward `0` once frames stop arriving (the
    /// effective interval grows with the time since the last one).
    fn rate(&self, now: Instant) -> f64 {
        if self.ema_dt_secs <= 0.0 {
            return 0.0;
        }
        let since = now.duration_since(self.last).as_secs_f64();
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
#[derive(Debug, Clone)]
pub struct RawTraceFrame {
    pub timestamp_ns: u64,
    pub channel: u8,
    pub id: u32,
    pub extended: bool,
    pub direction: Direction,
    pub payload: CanFramePayload,
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
        }
    }
}

/// The trace model. Single producer (per pump thread) is typical but
/// not required; multiple producers serialise on the inner mutex.
pub struct TraceStore {
    inner: Mutex<Inner>,
}

struct Inner {
    frames: Vec<RawTraceFrame>,
    rate_samples: VecDeque<(Instant, usize)>,
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
        let key = (frame.channel, frame.id, frame.extended);
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        let id_key = (frame.id, frame.extended);
        inner.frames.push(frame);
        let count = inner.frames.len();
        inner.latest.insert(key, count - 1);
        inner.by_id.entry(id_key).or_default().push(count - 1);
        inner
            .rates
            .entry(key)
            .or_insert_with(|| RateEstimate::first_seen(now))
            .observe(now);
        let due = match inner.rate_samples.back() {
            Some(&(last, _)) => now.duration_since(last) >= RATE_SAMPLE_INTERVAL,
            None => true,
        };
        if due {
            inner.rate_samples.push_back((now, count));
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
            .filter_map(|(&key, &idx)| (idx >= since).then_some((key, idx)))
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

fn prune_rate_samples(samples: &mut VecDeque<(Instant, usize)>, now: Instant) {
    while let Some(&(t, _)) = samples.front() {
        if now.duration_since(t) > RATE_WINDOW {
            samples.pop_front();
        } else {
            break;
        }
    }
}

fn rate_from_samples(samples: &VecDeque<(Instant, usize)>) -> f64 {
    let (Some(&(t0, c0)), Some(&(t1, c1))) = (samples.front(), samples.back()) else {
        return 0.0;
    };
    let dt = t1.duration_since(t0).as_secs_f64();
    if dt <= 0.0 {
        return 0.0;
    }
    #[allow(clippy::cast_precision_loss)]
    let delta = (c1.saturating_sub(c0)) as f64;
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
        }
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
    #[allow(clippy::float_cmp)] // 0.0 is the exact "no estimate yet" sentinel.
    fn per_id_rate_is_zero_until_two_frames_then_estimates_and_decays() {
        let t0 = Instant::now();
        let mut r = RateEstimate::first_seen(t0);
        assert_eq!(r.rate(t0), 0.0); // one frame: no estimate yet
        let t1 = t0 + Duration::from_millis(100);
        r.observe(t1);
        assert!((r.rate(t1) - 10.0).abs() < 1e-6); // 100 ms apart -> ~10 /s
        // No further frames: a second later the estimate decays toward 1/s.
        assert!((r.rate(t1 + Duration::from_secs(1)) - 1.0).abs() < 1e-3);
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
