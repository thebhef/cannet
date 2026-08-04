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
//! a frame is appended the source it came from is irrelevant.
//!
//! ## Facade over a swappable raw store
//!
//! `TraceStore` is a thin facade: the raw frame bytes — the part that
//! grows with capture length — live behind the
//! [`cannet_spill::RawStore`] trait, while the small, id-space-bounded
//! *derived* state (per-id rates, newest-per-id, per-bus / per-direction
//! throughput) stays here in RAM. Two raw stores implement the trait: the
//! in-RAM [`cannet_spill::MemRawStore`] test double and the disk-spill
//! [`cannet_spill::DiskRawStore`] production store
//! ([ADR 0002](../../../docs/adr/0002-disk-spill-store.md)). Swapping one
//! for the other never reshapes callers — the accessor surface
//! (`append` / `len` / `slice` / `scan_chunk` / …) is store-independent
//! ([ADR 0025](../../../docs/adr/0025-frontend-windowed-source-contract.md)).
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
//! every sample deque (aggregate and per-id alike) is pruned by wall
//! time, and a per-id estimate whose window has emptied falls back to
//! its last inter-frame delta, decaying on wall-clock silence
//! ([`RateEstimate::rate`]). Without this, a stalled stream would show
//! its last rate forever (frame timestamps would have nothing to
//! advance them).
//!
//! The store keeps a rolling window of
//! `(Instant, last_frame_ts_ns, total_count)` samples, one taken at
//! most every [`RATE_SAMPLE_INTERVAL`] — a sample *per appended frame*
//! would balloon the deque at high replay rates for no extra signal,
//! since [`Self::frames_per_second`] only reads the window's endpoints.
//! The window is pruned to [`RATE_WINDOW`](rate::RATE_WINDOW) on each touch; the rate is
//! the count delta over the frame-time the surviving samples span,
//! falling back to `0.0` if there isn't yet enough signal to estimate.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use cannet_core::Direction;
use cannet_spill::{CandidateSource, DiskRawStore, FilterIndex, MemRawStore, RawStore};

use crate::filter::CandidateSet;

mod byid;
mod flush;
mod rate;
mod scratch;

use rate::{RateEstimate, RateTrack};

/// One coherent read of a trace window's x-axis anchors. See
/// [`TraceStore::window_anchors`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowAnchors {
    /// Timestamp of the frame the window starts at — the x-axis origin
    /// floor (ADR 0024). `None` when the window starts past the end.
    pub first_ns: Option<u64>,
    /// The capture's newest timestamp. `None` when the store is empty.
    pub live_edge_ns: Option<u64>,
    /// Store length at the same instant as the two above.
    pub len: usize,
}

pub use byid::LatestById;
pub use cannet_spill::RawTraceFrame;
pub use scratch::ScratchBreakdown;

pub(crate) use flush::{read_json, write_json};

/// Identifies a "kind of frame" for the latest-by-id view: the
/// logical bus (`None` = unassigned, a distinct bucket from any named
/// bus), the wire channel, the arbitration id, and whether it's an
/// extended id (a standard and an extended id with the same numeric
/// value are distinct frames). Keying on `bus_id` matters when two
/// servers report frames on the same wire channel — without it, the
/// per-id snapshot would collapse them into one row.
type FrameKey = (Option<String>, u8, u32, bool);

/// Identifies one multiplexor-selector group of a message stream for
/// the per-signal latest-value view: the logical bus, the arbitration
/// id + addressing mode, and the selector value. Unlike [`FrameKey`]
/// there is no wire-channel component — signal identity is
/// `(bus, message id, extended)` (the descriptor key), matching the
/// per-signal decoded-sample cache.
type MuxKey = (Option<String>, u32, bool, u64);

/// Extracts a frame's multiplexor-selector value, or `None` when the
/// frame's message has no multiplexor (or no DBC decodes it). Injected
/// by the host ([`TraceStore::set_mux_extractor`]) so the store stays
/// DBC-free; the host builds it over the loaded DBC set
/// (`Database::decode_mux_selector` — a couple of bit reads, cheap
/// enough for the append path).
pub type MuxSelectorFn = dyn Fn(&RawTraceFrame) -> Option<u64> + Send + Sync;

/// The newest-per-[`FrameKey`] state the by-id view reads, all maintained
/// `O(1)` on append. One keyed struct rather than three parallel
/// `HashMap<FrameKey, _>` — index, frame, and rate advance together for the
/// same key, so they share one entry and one hash lookup per append.
struct PerKey {
    /// Frame index of the most recent frame seen for this key — what the
    /// per-message-ID view reads instead of walking the whole buffer.
    last_index: usize,
    /// The newest *frame* seen for this key — the eager retention overlay
    /// (ADR 0002 DS-8, one frame clone per append). The global latest-by-id
    /// read serves frame content from here instead of reading the maintained
    /// index back from the raw store, so a row whose newest frame has been
    /// evicted below the low-water mark still shows its last value. Persisted
    /// in `derived.json`, so the last value survives a reopen across an
    /// eviction.
    last_frame: RawTraceFrame,
    /// Per-id message-rate estimate.
    rate: RateEstimate,
}

/// The trace model. Single producer (per pump thread) is typical but
/// not required; multiple producers serialise on the inner mutex.
pub struct TraceStore {
    inner: Mutex<Inner>,
}

struct Inner {
    /// Session-start timestamp in nanoseconds (the same Unix-epoch ns
    /// axis frames use). The trace UI displays everything relative to
    /// this — and [`Self::append`] silently drops any frame whose
    /// timestamp predates it. That drop is what isolates a clear-and-
    /// restart from frames that were in flight through the recv
    /// pipeline (sidecar queue, gRPC stream, packer thread) at the
    /// moment of clear: those frames now arrive with stale timestamps
    /// and would otherwise display as negative offsets from a base
    /// captured off the next real frame. Zero means "no session start
    /// configured yet" — every frame is accepted (used at construction
    /// and during tests that don't care).
    session_start_ns: u64,
    /// The raw frame bytes — `Vec`-backed in tests, disk-spilled in
    /// production. Owns the always-on `by-id` index too (on disk for the
    /// disk store), so it serves [`Self::matching_frames_indexed`].
    raw: Box<dyn RawStore>,
    /// Aggregate append-rate tracker: the running total-frame count and its
    /// rolling rate-sample window, folded in by [`Self::append`] and read by
    /// [`Self::frames_per_second`]. A [`RateTrack`] like the per-bus and
    /// per-direction buckets, so all four share one sampling path.
    agg_rate: RateTrack,
    /// The newest-per-[`FrameKey`] state — index, frame, and rate estimate —
    /// maintained `O(1)` on append and bounded by id-space, not capture
    /// length. See [`PerKey`]; the by-id view reads it instead of walking the
    /// whole buffer.
    per_key: HashMap<FrameKey, PerKey>,
    /// Bumped whenever the *set of keys* in `per_key` changes — a new id
    /// seen, or the map rebuilt by a session start / scratch reopen. It is
    /// the invalidation signal for anything derived from "which ids exist"
    /// (the filtered trace's candidate resolution), which would otherwise
    /// be recomputed on every page fetch.
    key_generation: u64,
    /// The host-injected multiplexor-selector extractor, or `None`
    /// while no loaded DBC declares a multiplexor. Swapped whenever the
    /// DBC set changes ([`TraceStore::set_mux_extractor`]).
    mux_selector_of: Option<std::sync::Arc<MuxSelectorFn>>,
    /// Newest `(index, frame)` per [`MuxKey`] — the per-selector-group
    /// analog of `latest` + `latest_frame`, backing the per-signal
    /// latest-value view (a mux signal's "latest" is the last frame
    /// whose selector matched its group, not the message's last frame).
    /// Maintained `O(1)` on append while an extractor is installed;
    /// entries found by [`TraceStore::latest_mux_in_window`]'s backward
    /// scan are backfilled here. Bounded by (id × selector) space. Not
    /// persisted in `derived.json` — a reopened session rebuilds lazily
    /// via the bounded scan.
    latest_mux: HashMap<MuxKey, (usize, RawTraceFrame)>,
    /// Per-selector-group update statistics — what the signal view's
    /// count / msg-per-s columns show for mux signals. Counted from
    /// extractor installation onward (frames appended before a DBC
    /// arrived aren't retro-counted).
    mux_rates: HashMap<MuxKey, RateEstimate>,
    /// Append index from which `latest_mux` is complete: every frame at
    /// `>= mux_index_from` passed through the current extractor. Below
    /// it the map may be missing groups (extractor installed
    /// mid-session), so a query over an uncovered window falls back to
    /// the bounded backward scan.
    mux_index_from: usize,
    /// Per-bus rate state, keyed by the frame's logical bus (`None` =
    /// unassigned, its own bucket). Maintained `O(1)` on append; backs
    /// [`TraceStore::frames_per_second_by_bus`], the per-bus throughput
    /// readout used to localise where a high-rate stream is slowing.
    per_bus: HashMap<Option<String>, RateTrack>,
    /// Append rate split by [`Direction`]: received frames and
    /// transmit-confirmed frames tracked separately, so a stall on one
    /// direction is visible even when the aggregate looks healthy.
    /// Maintained `O(1)` on append; backs
    /// [`TraceStore::frames_per_second_by_direction`].
    rx_rate: RateTrack,
    tx_rate: RateTrack,
    /// Frames rejected by the session-start guard ([`Self::append`]
    /// returning `None`). Counted so that silent path is visible in the
    /// diagnostic readout.
    dropped_before_session: u64,
    /// The disk-spill scratch directory, when this store is disk-backed
    /// (`None` for the in-RAM test double). The home for the reopen
    /// manifest (in the raw store) plus the host-side identity and derived
    /// files this facade writes (ADR 0002 DS-7).
    scratch_dir: Option<PathBuf>,
    /// Windowed-ring cap (ADR 0002 DS-8): the maximum total `current/`
    /// footprint in bytes before a flush sheds the oldest raw history.
    /// `None` (the default) is unbounded — the scratch grows with the
    /// capture. Set from `settings.json` (`scratch_cap_bytes`) at launch
    /// and on each settings change.
    scratch_cap_bytes: Option<u64>,
    /// Total `current/` scratch footprint in bytes as of the last flush —
    /// the figure the status readout shows. Measured on the flush cadence
    /// (the dir walk is too costly for the ~10 Hz status tick), so a
    /// growing capture's reported size lags real growth by at most one
    /// flush. `0` for the in-RAM double (no scratch dir).
    footprint_bytes: u64,
}

impl TraceStore {
    /// Construct over an in-RAM [`MemRawStore`] — the test double. Used by
    /// unit tests and the perf harness; production uses [`Self::new_disk`].
    pub fn new() -> Self {
        Self::with_raw(Box::new(MemRawStore::new()), None)
    }

    /// Construct over the disk-spill [`DiskRawStore`] rooted at `dir` (the
    /// production path, ADR 0002). The directory must already exist. The
    /// store opens **empty without wiping** `dir`, so a prior session's
    /// files survive until the gate reloads them or a capture clears them
    /// (ADR 0002 DS-7) — [`Self::try_reload`] is what brings a matching
    /// prior session back.
    pub fn new_disk(dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        let raw = Box::new(DiskRawStore::open_empty(&dir)?);
        Ok(Self::with_raw(raw, Some(dir)))
    }

    /// Lock the inner state, recovering from poisoning. A thread that
    /// panics while holding this mutex (a pump mid-append, say) must
    /// cost at most its own load: treating poison as fatal here turned
    /// one ingest panic into an app-wide cascade — every accessor
    /// panicking in turn, and finally a main-thread abort when the user
    /// started the next session. Worst case after recovery is a
    /// partially applied update from the panicking critical section
    /// (e.g. a frame in the raw store missing from the newest-per-id
    /// index), which the next session start wipes.
    fn lock_inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn with_raw(raw: Box<dyn RawStore>, scratch_dir: Option<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                session_start_ns: 0,
                raw,
                agg_rate: RateTrack::default(),
                per_key: HashMap::new(),
                key_generation: 0,
                mux_selector_of: None,
                latest_mux: HashMap::new(),
                mux_rates: HashMap::new(),
                mux_index_from: 0,
                per_bus: HashMap::new(),
                rx_rate: RateTrack::default(),
                tx_rate: RateTrack::default(),
                dropped_before_session: 0,
                scratch_dir,
                scratch_cap_bytes: None,
                footprint_bytes: 0,
            }),
        }
    }

    /// The windowed-ring low-water mark and the timestamp (seconds) of the
    /// oldest live row (ADR 0002 DS-8). The host trims the derived caches
    /// (pyramids, filter index) and the trace view's live window to these
    /// after an eviction. The mark is `0` and the timestamp the whole-buffer
    /// start until eviction first advances them.
    pub fn low_water(&self) -> (usize, Option<f64>) {
        let inner = self.lock_inner();
        let mark = inner.raw.first_index();
        #[allow(clippy::cast_precision_loss)]
        let ts = inner.raw.first_last_ts().0.map(|ns| ns as f64 / 1e9);
        (mark, ts)
    }

    /// Length, low-water mark, and the timestamp (ns) of the oldest retained
    /// frame, read under a *single* lock so they're mutually consistent (ADR
    /// 0002 DS-8). The status line's retained count is `len - first_index`;
    /// reading `len` and `first_index` under separate locks lets a flush evict
    /// between them, leaving `first_index > len` and a spurious zero.
    /// Returning them from one critical section forecloses that, guaranteeing
    /// `first_index <= len`. The oldest-retained ts is where the frontend
    /// places the truncation marker (ADR 0035) when `first_index > 0`.
    pub fn len_and_low_water(&self) -> (usize, usize, Option<u64>) {
        let inner = self.lock_inner();
        (
            inner.raw.len(),
            inner.raw.first_index(),
            inner.raw.first_last_ts().0,
        )
    }

    /// Append a frame to the tail of the trace. Updates the
    /// latest-by-key index and the per-id rate estimate, and records a
    /// rate sample if at least [`RATE_SAMPLE_INTERVAL`] has passed.
    ///
    /// Frames whose timestamp predates the current
    /// [`Self::start_session`] are silently dropped (returning
    /// `None`). That handles the pipeline-in-flight case after a
    /// Clear / new session: the recv path (sidecar queue, gRPC,
    /// packer thread) can still deliver frames captured before the
    /// clear; they'd otherwise land in the freshly-empty buffer with
    /// stale timestamps and show as negative offsets in the trace
    /// view.
    ///
    /// Returns the appended frame's absolute index — what the
    /// ingest-time verifier keys its violation records on, and what a
    /// tx-confirm reports back.
    pub fn append(&self, frame: RawTraceFrame) -> Option<u64> {
        let now = Instant::now();
        let ts_ns = frame.timestamp_ns;
        let key: FrameKey = (
            frame.bus_id.clone(),
            frame.channel,
            frame.id,
            frame.extended,
        );
        let bus_for_rate = key.0.clone();
        let direction = frame.direction;
        let mut inner = self.lock_inner();
        if ts_ns < inner.session_start_ns {
            inner.dropped_before_session = inner.dropped_before_session.saturating_add(1);
            return None;
        }
        // The raw store assigns the dense index and maintains `by-id`. The
        // frame clones into the eager retention overlay (ADR 0002 DS-8): one
        // small id-space-bounded clone per append keeps the trim itself pure
        // front-truncation, so an evicted index never blanks a by-id row.
        let idx = inner.raw.append(frame.clone());
        // Mux-group latest: one extra id×selector-bounded clone, only
        // for frames the extractor recognises as multiplexed.
        if let Some(sel) = inner.mux_selector_of.as_ref().and_then(|ext| ext(&frame)) {
            let mkey: MuxKey = (frame.bus_id.clone(), frame.id, frame.extended, sel);
            inner.latest_mux.insert(mkey.clone(), (idx, frame.clone()));
            inner
                .mux_rates
                .entry(mkey)
                .or_insert_with(|| RateEstimate::first_seen(ts_ns, now))
                .observe(ts_ns, now);
        }
        if let Some(e) = inner.per_key.get_mut(&key) {
            e.last_index = idx;
            e.last_frame = frame;
            e.rate.observe(ts_ns, now);
        } else {
            let mut rate = RateEstimate::first_seen(ts_ns, now);
            rate.observe(ts_ns, now);
            inner.per_key.insert(
                key,
                PerKey {
                    last_index: idx,
                    last_frame: frame,
                    rate,
                },
            );
            inner.key_generation = inner.key_generation.wrapping_add(1);
        }
        // The aggregate, per-bus, and per-direction throughput trackers all
        // fold in this frame the same way (bump the count, sample on the
        // shared cadence gate) — the aggregate is a `RateTrack` like the
        // others rather than a bypassing bare deque.
        inner.agg_rate.observe(ts_ns, now);
        inner.per_bus.entry(bus_for_rate).or_default().observe(ts_ns, now);
        match direction {
            Direction::Rx => &mut inner.rx_rate,
            Direction::Tx => &mut inner.tx_rate,
        }
        .observe(ts_ns, now);
        Some(u64::try_from(idx).unwrap_or(u64::MAX))
    }

    /// Number of frames currently stored.
    #[must_use]
    pub fn len(&self) -> usize {
        self.lock_inner().raw.len()
    }

    /// Cloned slice of frames in `[start, end)`. Clamped to the store's
    /// current bounds, so an over-large `end` returns whatever's
    /// available rather than erroring; an entirely out-of-range request
    /// returns an empty `Vec`.
    #[must_use]
    pub fn slice(&self, start: usize, end: usize) -> Vec<RawTraceFrame> {
        self.lock_inner().raw.slice(start, end)
    }

    /// First-and-last frame timestamps for the (clamped) range
    /// `[start, end)`, without cloning any frames. Used by
    /// `sample_signals` to anchor the x-axis at the window's first frame
    /// time and report the window's right edge — both independent of the
    /// per-signal decoded-sample slice the cache produces.
    #[must_use]
    pub fn frame_timestamps(&self, start: usize, end: usize) -> (Option<u64>, Option<u64>) {
        self.lock_inner().raw.frame_timestamps(start, end)
    }

    /// A window's x-axis anchors, read under **one** lock: the timestamp
    /// of the frame at `start`, the capture's live edge, and the store
    /// length that both describe.
    ///
    /// One acquisition because `sample_signals` needs all three to
    /// describe the same store, and taking them separately lets frames
    /// land in between — the window's floor, its right edge, and the
    /// bound the per-signal caches catch up to would then each be from a
    /// different instant.
    ///
    /// The right edge is [`cannet_spill::RawStore::max_ts`], the running
    /// max, **not** the last row in `[start, end)`. Frames are appended in
    /// arrival order and a multi-bus capture interleaves deliveries, so
    /// the last row's timestamp routinely dips below the true edge and
    /// recovers; anything scrolling to follow it (ADR 0024) reads that
    /// as the capture jumping backwards.
    #[must_use]
    pub fn window_anchors(&self, start: usize) -> WindowAnchors {
        let inner = self.lock_inner();
        WindowAnchors {
            first_ns: inner.raw.frame_timestamps(start, start + 1).0,
            live_edge_ns: inner.raw.max_ts(),
            len: inner.raw.len(),
        }
    }

    /// The absolute index of the first *retained* frame whose timestamp is
    /// `>= ts` (a lower bound), or `len()` if every retained frame is older.
    /// This is the anchor where a timeline event at `ts` sorts into the
    /// chronological frame stream (ADR 0035): the host owns the time↔index
    /// mapping (ADR 0024), so the trace view never re-derives it in JS.
    /// Frames are appended in arrival order with monotonic timestamps, so
    /// this is an `O(log n)` binary search over `[first_index, len)`.
    #[must_use]
    pub fn frame_index_at_ns(&self, ts: u64) -> usize {
        let inner = self.lock_inner();
        let (mut lo, mut hi) = (inner.raw.first_index(), inner.raw.len());
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            // `frame_timestamps(mid, mid+1).0` is the timestamp at `mid`,
            // read from the meta mapping without cloning the frame.
            let mid_ts = inner
                .raw
                .frame_timestamps(mid, mid + 1)
                .0
                .unwrap_or(u64::MAX);
            if mid_ts < ts {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    /// Wall-clock span of the buffered frames, in seconds: the timestamp
    /// gap between the oldest and newest frame currently stored. Zero
    /// when fewer than two frames are buffered. Drives the "N s buffered"
    /// readout in the status line. Frames are appended in arrival order,
    /// so `first` is the oldest and `last` the newest.
    #[must_use]
    pub fn buffer_seconds(&self) -> f64 {
        let inner = self.lock_inner();
        match inner.raw.first_last_ts() {
            (Some(first), Some(last)) => {
                let span = last.saturating_sub(first);
                #[allow(clippy::cast_precision_loss)]
                {
                    span as f64 / 1_000_000_000.0
                }
            }
            _ => 0.0,
        }
    }

    /// For one `(id, extended)` arbitration key: clone the matching
    /// frames in `[start, end)` **paired with their frame index in the
    /// store**. The raw store's `by-id` index jumps straight to the
    /// matching frames, so the work is `O(matches + log n)` — what the
    /// host-side decoded-sample cache uses to map between frame indices
    /// and sample indices (a `[from_frame, to_frame)` query can then
    /// binary-search the cache).
    #[must_use]
    pub fn matching_frames_indexed(
        &self,
        id_raw: u32,
        extended: bool,
        start: usize,
        end: usize,
    ) -> Vec<(usize, RawTraceFrame)> {
        self.lock_inner()
            .raw
            .matching_frames_indexed(id_raw, extended, start, end)
    }

    /// Scan the clamped range `[start, end)`, test each frame with
    /// `keep`, and return the **absolute store indices** of the matches,
    /// in ascending order. Nothing is cloned — the result is cheap
    /// `usize`s.
    ///
    /// This is the bounded unit of a filtered scan: the [`Inner`] mutex
    /// is held only for this range, so a caller scans a large window as
    /// a sequence of chunks, releasing the lock (and yielding) between
    /// them. That keeps a history scan from ever holding the append
    /// mutex across the whole buffer — the lock-hold that starved RX
    /// `append` and transmit as the buffer grew (the diagnosed lock
    /// contention). The
    /// matched page is materialised separately via [`Self::frames_at`].
    #[must_use]
    pub fn scan_chunk(
        &self,
        start: usize,
        end: usize,
        keep: impl Fn(&RawTraceFrame) -> bool,
    ) -> Vec<usize> {
        self.lock_inner().raw.scan_chunk(start, end, &keep)
    }

    /// Clone the frames at the given absolute indices, each paired with
    /// its index, in `idxs` order; indices past the current end are
    /// skipped. Backs the filtered-trace page fetch: the chunked scan
    /// collects the page's match indices, then this materialises just
    /// that page — at most one page's worth of clones, never the whole
    /// match set.
    #[must_use]
    pub fn frames_at(&self, idxs: &[usize]) -> Vec<(usize, RawTraceFrame)> {
        self.lock_inner().raw.frames_at(idxs)
    }

    /// Current session-start threshold (Unix-epoch ns). The trace UI
    /// renders frames relative to this; zero means "no session start
    /// has been configured yet", and the store accepts every frame.
    #[must_use]
    pub fn session_start_ns(&self) -> u64 {
        self.lock_inner().session_start_ns
    }

    /// Bring `index` current against this store for a resolved predicate,
    /// then it can be paged in `O(page)` ([`FilterIndex::page`]). The
    /// `candidates` come from [`crate::filter::resolve_candidates`]; for a
    /// membership set every candidate frame matches (no read), otherwise
    /// `keep` applies the full predicate per candidate frame (the caller
    /// gates decode the same way the scan path does). The build visits
    /// only candidate-id frames and only the `[built_through, len)` delta,
    /// so a steady filtered view is `O(delta)` and a fresh one
    /// `O(matches)` — never an `O(capture)` scan (ADR 0002 DS-3).
    ///
    /// This is the model-side core of the indexed filtered fetch; the
    /// Tauri command and the perf harness drive it.
    pub fn refresh_filter_index(
        &self,
        index: &mut FilterIndex,
        candidates: &CandidateSet,
        keep: &dyn Fn(&RawTraceFrame) -> bool,
    ) {
        let to = self.len();
        if candidates.membership {
            index.extend_membership(self, &candidates.keys, to);
        } else {
            index.extend(self, &candidates.keys, keep, to);
        }
    }

    /// Number of frames the session-start guard has dropped (stale
    /// pipeline frames after a clear/reconnect). Surfaced so that
    /// otherwise-silent path is visible in the diagnostic readout.
    #[must_use]
    pub fn frames_dropped_before_session(&self) -> u64 {
        self.lock_inner().dropped_before_session
    }

}

/// Lets a [`FilterIndex`] build against the facade without exposing the
/// raw store: each call locks, delegates to the inner store, and releases
/// — so the chunked index build never holds the append mutex across the
/// whole window (the same lock discipline the chunked scan keeps).
impl CandidateSource for TraceStore {
    fn frame_count(&self) -> usize {
        self.len()
    }

    fn candidate_indices(&self, ids: &[(u32, bool)], start: usize, end: usize) -> Vec<usize> {
        self.lock_inner().raw.candidate_indices(ids, start, end)
    }

    fn frames_at(&self, idxs: &[usize]) -> Vec<(usize, RawTraceFrame)> {
        self.frames_at(idxs)
    }
}

/// Frame-builder helpers shared by the split submodules' test modules.
/// Kept in the facade module so `rate`, `byid`, `scratch`, and `flush`
/// tests draw the same fixtures.
#[cfg(test)]
pub(crate) mod test_support {
    use super::{Direction, RawTraceFrame};
    use cannet_core::CanFramePayload;

    pub(crate) fn dummy(ts_ns: u64, id: u32) -> RawTraceFrame {
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

    pub(crate) fn dummy_on_bus(ts_ns: u64, id: u32, bus: &str) -> RawTraceFrame {
        let mut f = dummy(ts_ns, id);
        f.bus_id = Some(bus.into());
        f
    }

    pub(crate) fn dummy_tx(ts_ns: u64, id: u32) -> RawTraceFrame {
        let mut f = dummy(ts_ns, id);
        f.direction = Direction::Tx;
        f
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_core::{CanFrame, CanId};
    use test_support::dummy;

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
    fn poisoned_mutex_recovers_instead_of_panicking() {
        // A pump thread that panics while holding the inner mutex poisons
        // it. That must cost at most the panicking thread's own load —
        // every later accessor, and a subsequent session start, must keep
        // working on the pre-panic state rather than cascading the panic.
        let store = TraceStore::new();
        store.append(dummy(1_000, 1));
        std::thread::scope(|s| {
            let handle = s.spawn(|| {
                let _guard = store.inner.lock().unwrap();
                panic!("deliberate poison");
            });
            assert!(handle.join().is_err());
        });
        assert!(store.inner.is_poisoned());
        assert_eq!(store.len(), 1);
        assert_eq!(store.len_and_low_water().0, 1);
        assert_eq!(store.slice(0, 10).len(), 1);
        store.start_session(0);
        assert_eq!(store.len(), 0);
        store.append(dummy(2_000, 2));
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn live_edge_is_the_newest_frame_not_the_last_appended_one() {
        // The store is fed in *arrival* order and a multi-bus capture
        // interleaves deliveries, so the newest row is routinely not the
        // newest frame. Everything that scrolls to follow the capture
        // (ADR 0024) reads a dip here as the capture jumping backwards:
        // a 23-hour two-bus PCAN capture dipped ~1.1 s, several times a
        // minute, and threw the plot's window back by that much.
        let store = TraceStore::new();
        store.append(dummy(5_000_000_000, 1));
        store.append(dummy(9_000_000_000, 2));
        store.append(dummy(7_000_000_000, 3)); // the other bus, behind
        let a = store.window_anchors(0);
        assert_eq!(a.live_edge_ns, Some(9_000_000_000));
        assert_eq!(a.first_ns, Some(5_000_000_000));
        assert_eq!(a.len, 3);
        // The buffered span is a difference of two endpoints, so it can
        // only be monotonic if the newest one is.
        assert!((store.buffer_seconds() - 4.0).abs() < 1e-9);
        store.append(dummy(8_000_000_000, 4));
        assert!((store.buffer_seconds() - 4.0).abs() < 1e-9);
    }

    #[test]
    fn buffer_seconds_spans_oldest_to_newest() {
        let store = TraceStore::new();
        // Empty and single-frame buffers have no span.
        assert!(store.buffer_seconds().abs() < 1e-9);
        store.append(dummy(5_000_000_000, 1));
        assert!(store.buffer_seconds().abs() < 1e-9);
        // Newest − oldest = 7.5 s − 5 s = 2.5 s.
        store.append(dummy(6_000_000_000, 2));
        store.append(dummy(7_500_000_000, 3));
        assert!((store.buffer_seconds() - 2.5).abs() < 1e-9);
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
            pairs
                .iter()
                .map(|(i, f)| (*i, f.timestamp_ns))
                .collect::<Vec<_>>(),
            vec![(2, 2_000), (4, 4_000)],
        );
        // Out-of-range start: empty.
        assert!(store.matching_frames_indexed(7, false, 99, 200).is_empty());
        // Extended vs standard are distinct keys.
        assert!(store.matching_frames_indexed(7, true, 0, 6).is_empty());
        store.start_session(0);
        assert!(store.matching_frames_indexed(7, false, 0, 6).is_empty());
    }

    #[test]
    fn scan_chunk_returns_absolute_match_indices_in_its_range() {
        let store = TraceStore::new();
        // id 256 on the even raw indices → matches at raw 0, 2, 4, 6, 8.
        for i in 0u32..10 {
            store.append(dummy(0, if i % 2 == 0 { 256 } else { 999 }));
        }
        let keep = |f: &RawTraceFrame| f.id == 256;
        // A sub-range scan returns only the matches inside it, by
        // absolute index.
        assert_eq!(store.scan_chunk(0, 5, keep), vec![0, 2, 4]);
        assert_eq!(store.scan_chunk(5, 10, keep), vec![6, 8]);
        // The chunks concatenate to the full match set — the property the
        // chunked driver relies on.
        let mut all = store.scan_chunk(0, 5, keep);
        all.extend(store.scan_chunk(5, 10, keep));
        assert_eq!(all, vec![0, 2, 4, 6, 8]);
        // Out-of-range start: empty. End past the buffer is clamped.
        assert!(store.scan_chunk(99, 200, keep).is_empty());
        assert_eq!(store.scan_chunk(8, 1000, keep), vec![8]);
    }

    #[test]
    fn frames_at_clones_only_the_requested_indices_and_skips_out_of_range() {
        let store = TraceStore::new();
        for i in 0u32..6 {
            store.append(dummy(u64::from(i) * 1_000, i));
        }
        // Indices preserved in request order; ts proves the right frames.
        let got = store.frames_at(&[4, 1, 2]);
        assert_eq!(
            got.iter()
                .map(|(i, f)| (*i, f.timestamp_ns))
                .collect::<Vec<_>>(),
            vec![(4, 4_000), (1, 1_000), (2, 2_000)],
        );
        // Out-of-range indices are skipped, not panicked on.
        let got = store.frames_at(&[2, 99]);
        assert_eq!(got.iter().map(|(i, _)| *i).collect::<Vec<_>>(), vec![2]);
        assert!(store.frames_at(&[]).is_empty());
    }

    #[test]
    fn append_interleaves_between_chunk_scans_without_a_buffer_wide_lock() {
        // Regression for the lock-starvation fix: a filtered scan
        // is driven as a sequence of `scan_chunk` calls so the append
        // mutex is released between chunks. This simulates that interleave
        // single-threadedly: an append landing *between* two chunk scans
        // is visible to the later chunk, and indices stay consistent —
        // the property that lets live ingest proceed mid-scan instead of
        // being starved by one buffer-wide locked scan.
        let store = TraceStore::new();
        for _ in 0..8 {
            store.append(dummy(0, 256)); // raw 0..8 all match
        }
        let keep = |f: &RawTraceFrame| f.id == 256;
        let first = store.scan_chunk(0, 4, keep);
        assert_eq!(first, vec![0, 1, 2, 3]);
        // An append happens "between chunks" — the lock was not held.
        store.append(dummy(0, 256)); // raw 8 (a new match)
        let second = store.scan_chunk(4, store.len(), keep);
        assert_eq!(second, vec![4, 5, 6, 7, 8]);
        // The page materialises by index against the grown buffer.
        let page = store.frames_at(&[0, 8]);
        assert_eq!(page.iter().map(|(i, _)| *i).collect::<Vec<_>>(), vec![0, 8]);
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
    fn frame_index_at_ns_lower_bounds_the_time_to_a_frame_index() {
        // Anchor where a timeline event sorts into the chronological stream
        // (ADR 0035): the first frame with ts >= the event's ts.
        let store = TraceStore::new();
        for i in 0u32..6 {
            store.append(dummy(u64::from(i) * 1_000, i)); // ts 0,1000,..,5000
        }
        assert_eq!(store.frame_index_at_ns(0), 0, "exact first");
        assert_eq!(
            store.frame_index_at_ns(2_500),
            3,
            "between 2000 and 3000 → 3"
        );
        assert_eq!(
            store.frame_index_at_ns(3_000),
            3,
            "exact hit is the lower bound"
        );
        assert_eq!(store.frame_index_at_ns(99_000), 6, "after the last → len()");
    }

    #[test]
    fn slice_out_of_range_returns_empty() {
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        assert!(store.slice(10, 20).is_empty());
    }

    #[test]
    fn append_counts_frames_dropped_before_session_start() {
        let store = TraceStore::new();
        store.start_session(1_000);
        store.append(dummy(500, 1)); // stale → dropped + counted
        store.append(dummy(2_000, 2)); // kept
        assert_eq!(store.frames_dropped_before_session(), 1);
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
    fn append_drops_frames_stamped_before_session_start() {
        // Pipeline-in-flight regression: after a Clear, frames captured
        // before the clear can still arrive via the recv pipeline
        // (sidecar queue, gRPC stream). They must not land in the new
        // session's buffer or they'd show as negative offsets relative
        // to the session-start zero point.
        let store = TraceStore::new();
        store.start_session(1_000);
        store.append(dummy(500, 1)); // stale — before threshold
        store.append(dummy(999, 2)); // stale — also before
        store.append(dummy(1_000, 3)); // accepted — at threshold
        store.append(dummy(2_000, 4)); // accepted — after
        let ids: Vec<u32> = store.slice(0, store.len()).iter().map(|f| f.id).collect();
        assert_eq!(ids, vec![3, 4]);
    }

    #[test]
    fn pre_session_default_accepts_everything() {
        // `new()` leaves session_start_ns at 0 — every realistic
        // timestamp passes (no caller has configured a threshold yet).
        let store = TraceStore::new();
        store.append(dummy(1, 1));
        store.append(dummy(u64::MAX, 2));
        assert_eq!(store.len(), 2);
    }
}
