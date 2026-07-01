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
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cannet_core::{CanFdFlags, CanFramePayload, Direction};
use cannet_spill::{CandidateSource, DiskRawStore, FilterIndex, MemRawStore, RawStore};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::filter::CandidateSet;

pub use cannet_spill::RawTraceFrame;

/// File in the scratch dir recording which project the on-disk session
/// belongs to (ADR 0002 DS-7). Written when a capture starts; read by
/// [`TraceStore::try_reload`] so a prior session reloads only against the
/// project that produced it. (The project *path* DS-7 mentions is
/// best-effort diagnostic only and is omitted here.)
const IDENTITY_FILE: &str = "identity.json";

/// File in the scratch dir holding the facade's RAM-only derived state —
/// the per-key newest index + count and the session-start anchor — so a
/// reopened session comes back with a working by-id view and filter
/// candidate resolution, not just the raw frames (ADR 0002 DS-7). Written
/// on flush; restored on reopen.
const DERIVED_FILE: &str = "derived.json";

/// Persisted scratch identity ([`IDENTITY_FILE`]).
#[derive(Serialize, Deserialize)]
struct ScratchIdentity {
    project_id: Uuid,
}

/// `derived.json` mirror of a frame payload. `cannet-core`'s
/// [`CanFramePayload`] carries no serde derives (a foundational crate kept
/// dependency-free), so the host serialises this local shape for the
/// retention overlay and converts back on reopen.
#[derive(Serialize, Deserialize)]
enum PersistedPayload {
    Classic(Vec<u8>),
    Fd { data: Vec<u8>, brs: bool, esi: bool },
    Remote { dlc: u8 },
    Error,
}

impl From<&CanFramePayload> for PersistedPayload {
    fn from(p: &CanFramePayload) -> Self {
        match p {
            CanFramePayload::Classic(d) => Self::Classic(d.clone()),
            CanFramePayload::Fd { data, flags } => Self::Fd {
                data: data.clone(),
                brs: flags.bitrate_switch,
                esi: flags.error_state_indicator,
            },
            CanFramePayload::Remote { dlc } => Self::Remote { dlc: *dlc },
            CanFramePayload::Error => Self::Error,
        }
    }
}

impl From<PersistedPayload> for CanFramePayload {
    fn from(p: PersistedPayload) -> Self {
        match p {
            PersistedPayload::Classic(d) => Self::Classic(d),
            PersistedPayload::Fd { data, brs, esi } => Self::Fd {
                data,
                flags: CanFdFlags {
                    bitrate_switch: brs,
                    error_state_indicator: esi,
                },
            },
            PersistedPayload::Remote { dlc } => Self::Remote { dlc },
            PersistedPayload::Error => Self::Error,
        }
    }
}

/// One persisted derived-state row: a [`FrameKey`] flattened, its last-seen
/// frame index and session frame count, plus the newest frame itself (the
/// retention overlay — `timestamp_ns` / `tx` / `payload`), so a reopen across
/// an eviction still shows the row's last value.
#[derive(Serialize, Deserialize)]
struct DerivedEntry {
    bus_id: Option<String>,
    channel: u8,
    id: u32,
    extended: bool,
    last_index: u64,
    count: u64,
    timestamp_ns: u64,
    tx: bool,
    payload: PersistedPayload,
}

/// Persisted derived state ([`DERIVED_FILE`]): the session-start anchor
/// and one [`DerivedEntry`] per distinct key. Small (id-space-bounded),
/// rewritten whole on each flush.
#[derive(Serialize, Deserialize)]
struct DerivedState {
    session_start_ns: u64,
    entries: Vec<DerivedEntry>,
}

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
const PER_ID_RATE_ALPHA: f64 = 0.6;

/// Identifies a "kind of frame" for the latest-by-id view: the
/// logical bus (`None` = unassigned, a distinct bucket from any named
/// bus), the wire channel, the arbitration id, and whether it's an
/// extended id (a standard and an extended id with the same numeric
/// value are distinct frames). Keying on `bus_id` matters when two
/// servers report frames on the same wire channel — without it, the
/// per-id snapshot would collapse them into one row.
type FrameKey = (Option<String>, u8, u32, bool);

/// Per-id message-rate estimate. Tracks the EMA of the *frame-time*
/// inter-arrival (the bus-side cadence) plus the wall-clock time of
/// the last observation (so a stalled stream visibly decays to zero
/// even though frame timestamps stop advancing).
#[derive(Debug, Clone, Copy)]
struct RateEstimate {
    last_ts_ns: u64,
    last_wall: Instant,
    ema_dt_secs: f64,
    count: u64,
}

impl RateEstimate {
    fn first_seen(ts_ns: u64, now: Instant) -> Self {
        Self {
            last_ts_ns: ts_ns,
            last_wall: now,
            ema_dt_secs: 0.0,
            count: 0,
        }
    }

    /// Fold in a new frame stamped at `ts_ns` and appended at wall-time
    /// `now`.
    #[allow(clippy::cast_precision_loss)] // ns diffs fit comfortably in f64's mantissa.
    fn observe(&mut self, ts_ns: u64, now: Instant) {
        self.count = self.count.saturating_add(1);
        let dt = ts_ns.saturating_sub(self.last_ts_ns) as f64 / 1e9;
        if self.ema_dt_secs <= 0.0 {
            if dt > 0.0 {
                self.ema_dt_secs = dt;
            }
        } else if dt > 0.0 {
            self.ema_dt_secs =
                PER_ID_RATE_ALPHA * dt + (1.0 - PER_ID_RATE_ALPHA) * self.ema_dt_secs;
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
        if dt > 0.0 {
            1.0 / dt
        } else {
            0.0
        }
    }
}

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

/// A rolling frames/second tracker: a running frame count plus its
/// rate-sample history, sampled and pruned exactly like the aggregate
/// [`Inner::rate_samples`]. One per bucket — used per-bus
/// ([`TraceStore::frames_per_second_by_bus`]) and per-direction
/// ([`TraceStore::frames_per_second_by_direction`]) — so each reads a
/// scoped rate the same way [`TraceStore::frames_per_second`] reads the
/// aggregate.
#[derive(Default)]
struct RateTrack {
    count: usize,
    samples: VecDeque<RateSample>,
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
    rate_samples: VecDeque<RateSample>,
    /// Frame index of the most recent frame seen for each [`FrameKey`] —
    /// `O(1)` to maintain on append, and what the per-message-ID view
    /// reads instead of walking the whole buffer.
    latest: HashMap<FrameKey, usize>,
    /// The newest *frame* seen for each [`FrameKey`] — the eager retention
    /// overlay (ADR 0002 DS-8). Maintained `O(1)` on append (one frame clone)
    /// and bounded by id-space, not capture length. The global latest-by-id
    /// read serves frame content from here instead of reading the maintained
    /// index back from the raw store, so a row whose newest frame has been
    /// evicted below the low-water mark still shows its last value. Persisted
    /// in `derived.json`, so the last value survives a reopen across an
    /// eviction.
    latest_frame: HashMap<FrameKey, RawTraceFrame>,
    /// Per-id message-rate estimate, also maintained `O(1)` on append.
    rates: HashMap<FrameKey, RateEstimate>,
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

    fn with_raw(raw: Box<dyn RawStore>, scratch_dir: Option<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                session_start_ns: 0,
                raw,
                rate_samples: VecDeque::new(),
                latest: HashMap::new(),
                latest_frame: HashMap::new(),
                rates: HashMap::new(),
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

    /// The total `current/` scratch footprint in bytes as of the last flush,
    /// or `None` for the in-RAM double (which has no scratch dir). Drives the
    /// status readout (ADR 0002 DS-8).
    pub fn scratch_footprint_bytes(&self) -> Option<u64> {
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        inner.scratch_dir.is_some().then_some(inner.footprint_bytes)
    }

    /// The windowed-ring low-water mark and the timestamp (seconds) of the
    /// oldest live row (ADR 0002 DS-8). The host trims the derived caches
    /// (pyramids, filter index) and the trace view's live window to these
    /// after an eviction. The mark is `0` and the timestamp the whole-buffer
    /// start until eviction first advances them.
    pub fn low_water(&self) -> (usize, Option<f64>) {
        let inner = self.inner.lock().expect("trace store mutex poisoned");
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
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        (
            inner.raw.len(),
            inner.raw.first_index(),
            inner.raw.first_last_ts().0,
        )
    }

    /// A per-family breakdown of the scratch footprint for the cache
    /// diagnostic (ADR 0002 DS-8), or `None` for the in-RAM double. The
    /// directory walk runs off the store lock (the dir is cloned under the
    /// lock, then released).
    pub fn scratch_breakdown(&self) -> Option<ScratchBreakdown> {
        let dir = {
            let inner = self.inner.lock().expect("trace store mutex poisoned");
            inner.scratch_dir.clone()?
        };
        Some(scratch_breakdown(&dir))
    }

    /// Set the windowed-ring cap (ADR 0002 DS-8) — the maximum total
    /// `current/` footprint before a flush sheds the oldest raw history.
    /// `None` is unbounded. A no-op in effect for the in-RAM double (it has
    /// no scratch dir, so flush never measures or evicts).
    pub fn set_scratch_cap(&self, cap: Option<u64>) {
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        inner.scratch_cap_bytes = cap;
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
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        if ts_ns < inner.session_start_ns {
            inner.dropped_before_session = inner.dropped_before_session.saturating_add(1);
            return None;
        }
        // The raw store assigns the dense index and maintains `by-id`. The
        // frame clones into the eager retention overlay (ADR 0002 DS-8): one
        // small id-space-bounded clone per append keeps the trim itself pure
        // front-truncation, so an evicted index never blanks a by-id row.
        let idx = inner.raw.append(frame.clone());
        let count = idx + 1;
        inner.latest.insert(key.clone(), idx);
        inner.latest_frame.insert(key.clone(), frame);
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
        let bus_rate = inner.per_bus.entry(bus_for_rate).or_default();
        bus_rate.count += 1;
        let bus_due = match bus_rate.samples.back() {
            Some(last) => now.duration_since(last.wall) >= RATE_SAMPLE_INTERVAL,
            None => true,
        };
        if bus_due {
            let bus_count = bus_rate.count;
            bus_rate.samples.push_back(RateSample {
                wall: now,
                ts_ns,
                count: bus_count,
            });
            prune_rate_samples(&mut bus_rate.samples, now);
        }
        let dir_rate = match direction {
            Direction::Rx => &mut inner.rx_rate,
            Direction::Tx => &mut inner.tx_rate,
        };
        dir_rate.count += 1;
        let dir_due = match dir_rate.samples.back() {
            Some(last) => now.duration_since(last.wall) >= RATE_SAMPLE_INTERVAL,
            None => true,
        };
        if dir_due {
            let dir_count = dir_rate.count;
            dir_rate.samples.push_back(RateSample {
                wall: now,
                ts_ns,
                count: dir_count,
            });
            prune_rate_samples(&mut dir_rate.samples, now);
        }
        Some(u64::try_from(idx).unwrap_or(u64::MAX))
    }

    /// Number of frames currently stored.
    #[must_use]
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("trace store mutex poisoned")
            .raw
            .len()
    }

    /// Cloned slice of frames in `[start, end)`. Clamped to the store's
    /// current bounds, so an over-large `end` returns whatever's
    /// available rather than erroring; an entirely out-of-range request
    /// returns an empty `Vec`.
    #[must_use]
    pub fn slice(&self, start: usize, end: usize) -> Vec<RawTraceFrame> {
        self.inner
            .lock()
            .expect("trace store mutex poisoned")
            .raw
            .slice(start, end)
    }

    /// First-and-last frame timestamps for the (clamped) range
    /// `[start, end)`, without cloning any frames. Used by
    /// `sample_signals` to anchor the x-axis at the window's first frame
    /// time and report the window's right edge — both independent of the
    /// per-signal decoded-sample slice the cache produces.
    #[must_use]
    pub fn frame_timestamps(&self, start: usize, end: usize) -> (Option<u64>, Option<u64>) {
        self.inner
            .lock()
            .expect("trace store mutex poisoned")
            .raw
            .frame_timestamps(start, end)
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
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        let (mut lo, mut hi) = (inner.raw.first_index(), inner.raw.len());
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            // `frame_timestamps(mid, mid+1).0` is the timestamp at `mid`,
            // read from the meta mapping without cloning the frame.
            let mid_ts = inner.raw.frame_timestamps(mid, mid + 1).0.unwrap_or(u64::MAX);
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
        let inner = self.inner.lock().expect("trace store mutex poisoned");
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
        self.inner
            .lock()
            .expect("trace store mutex poisoned")
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
        self.inner
            .lock()
            .expect("trace store mutex poisoned")
            .raw
            .scan_chunk(start, end, &keep)
    }

    /// Clone the frames at the given absolute indices, each paired with
    /// its index, in `idxs` order; indices past the current end are
    /// skipped. Backs the filtered-trace page fetch: the chunked scan
    /// collects the page's match indices, then this materialises just
    /// that page — at most one page's worth of clones, never the whole
    /// match set.
    #[must_use]
    pub fn frames_at(&self, idxs: &[usize]) -> Vec<(usize, RawTraceFrame)> {
        self.inner
            .lock()
            .expect("trace store mutex poisoned")
            .raw
            .frames_at(idxs)
    }

    /// Begin a new session: empty the buffer **and** raise the
    /// session-start threshold to `session_start_ns`. Subsequent
    /// [`Self::append`] calls drop any frame whose timestamp predates
    /// `session_start_ns` — the pipeline-drain guard for in-flight
    /// frames at the moment of clear / connect.
    ///
    /// Live capture passes wall-clock now; BLF replay passes the
    /// first frame's timestamp so the trace is rooted at the file's
    /// own time origin. Tests that just want an empty buffer with no
    /// gating pass `0`.
    ///
    /// (Why fresh `HashMap` allocations instead of `clear()`: those only
    /// reset length, leaving the — possibly enormous after a long replay
    /// — backing buffers resident. Replacing the containers returns the
    /// memory to the allocator so a small session after a large one
    /// doesn't carry the previous footprint. The raw store does the same
    /// in its own [`RawStore::clear`].)
    pub fn start_session(&self, session_start_ns: u64) {
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        inner.session_start_ns = session_start_ns;
        inner.raw.clear();
        inner.rate_samples = VecDeque::new();
        inner.latest = HashMap::new();
        inner.latest_frame = HashMap::new();
        inner.rates = HashMap::new();
        inner.per_bus = HashMap::new();
        inner.rx_rate = RateTrack::default();
        inner.tx_rate = RateTrack::default();
        inner.dropped_before_session = 0;
        // Wiping the buffer wipes the scratch (ADR 0002 DS-7): the raw
        // store's `clear` already dropped its segments and manifest; drop
        // the facade's derived + identity files too so a stale prior
        // session can't be reloaded. The host re-writes the identity if
        // this reset is the start of a fresh capture.
        if let Some(dir) = inner.scratch_dir.clone() {
            let _ = std::fs::remove_file(dir.join(DERIVED_FILE));
            let _ = std::fs::remove_file(dir.join(IDENTITY_FILE));
        }
    }

    /// Flush the raw store to disk — a no-op for the in-RAM test double,
    /// and for the disk-spill store the durability point that makes its
    /// segments and reopen manifest reloadable (ADR 0002 DS-4/DS-7). The
    /// host calls this on a cadence so a crash loses at most the
    /// since-last-flush tail (DS-2), and a cleanly stopped session is
    /// reloadable as a stopped trace. Returns the raw store's I/O result.
    ///
    /// The raw store's manifest is written first (it is the authority on
    /// frame count); then the facade's [`DERIVED_FILE`] is rewritten, so
    /// its newest-index/count entries never reference a frame past the
    /// just-persisted length.
    pub fn flush(&self) -> std::io::Result<()> {
        self.flush_with(true)
    }

    /// Like [`Self::flush`] but with a non-blocking `msync` of the raw
    /// store (ADR 0002 DS-2): queues writeback instead of waiting for the
    /// device, so the periodic flusher doesn't pin the append lock on a
    /// disk fsync. Reopen-after-process-restart is unaffected (the page
    /// cache backs the mapping); only power-loss durability of the trailing
    /// window relaxes — acceptable for the ephemeral scratch.
    pub fn flush_async(&self) -> std::io::Result<()> {
        self.flush_with(false)
    }

    fn flush_with(&self, sync: bool) -> std::io::Result<()> {
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        // Windowed-ring cap (ADR 0002 DS-8): shed the oldest raw segments
        // *before* the raw flush, so the manifest that flush writes reflects
        // the post-eviction floor and segment set. A manifest written before
        // the eviction would name segment files the eviction then deletes, and
        // a reopen across that eviction would fail.
        //
        // The cap bounds the *whole* scratch dir, but only the raw family is
        // shed here — the derived caches (pyramids, by-id, filter) cascade-
        // trim to the new low-water afterward (6d, in the flusher). So scale
        // the request by the raw share of the dir: handing the whole-dir
        // excess to a raw-only eviction would shed raw to cover the derived
        // families' bytes too, collapsing the retained window to the tail.
        // The cascade then shrinks the derived families to match, so raw + the
        // cascade converge on the cap together across a tick or two.
        if let (Some(dir), Some(cap)) = (inner.scratch_dir.clone(), inner.scratch_cap_bytes) {
            let footprint = dir_footprint(&dir);
            if footprint > cap {
                let raw = inner.raw.raw_disk_bytes();
                let raw_excess = u64::try_from(
                    u128::from(footprint - cap) * u128::from(raw) / u128::from(footprint),
                )
                .unwrap_or(footprint - cap);
                inner.raw.evict_oldest_bytes(raw_excess);
            }
        }
        if sync {
            inner.raw.flush()?;
        } else {
            inner.raw.flush_async()?;
        }
        if let Some(dir) = inner.scratch_dir.clone() {
            let entries = inner
                .latest_frame
                .iter()
                .map(|(key, frame)| DerivedEntry {
                    bus_id: key.0.clone(),
                    channel: key.1,
                    id: key.2,
                    extended: key.3,
                    last_index: inner.latest.get(key).map_or(0, |&i| i as u64),
                    count: inner.rates.get(key).map_or(0, |r| r.count),
                    timestamp_ns: frame.timestamp_ns,
                    tx: matches!(frame.direction, Direction::Tx),
                    payload: PersistedPayload::from(&frame.payload),
                })
                .collect();
            let derived = DerivedState {
                session_start_ns: inner.session_start_ns,
                entries,
            };
            write_json(&dir.join(DERIVED_FILE), &derived)?;
            // Cache the total footprint after all of this flush's writes, so
            // the status readout (ADR 0002 DS-8) reflects the on-disk truth
            // including the manifest and derived files just written.
            inner.footprint_bytes = dir_footprint(&dir);
        }
        Ok(())
    }

    /// Record which project the current scratch belongs to (ADR 0002
    /// DS-7), so a later launch reloads it only against that project. A
    /// no-op for the in-RAM double. `None` removes any prior identity (the
    /// scratch then belongs to no project and never reloads). Called by
    /// the host when a capture starts.
    pub fn write_scratch_identity(&self, project_id: Option<Uuid>) {
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        let Some(dir) = inner.scratch_dir.clone() else {
            return;
        };
        let path = dir.join(IDENTITY_FILE);
        match project_id {
            Some(project_id) => {
                if let Err(e) = write_json(&path, &ScratchIdentity { project_id }) {
                    tracing::warn!(error = %e, "writing scratch identity failed");
                }
            }
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    /// Reload a prior on-disk session as a **stopped** trace, but only if
    /// the scratch's recorded identity matches `project_id` (ADR 0002
    /// DS-7). On a match with a reopenable store, this swaps in the
    /// disk-spill store, restores the derived state and session-start
    /// anchor, and returns `true`; otherwise it leaves the store untouched
    /// (the scratch stays on disk, neither loaded nor wiped) and returns
    /// `false`. The reloaded trace's per-id rates read zero — it isn't
    /// live.
    pub fn try_reload(&self, project_id: Uuid) -> bool {
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        let Some(dir) = inner.scratch_dir.clone() else {
            return false;
        };
        let matches = read_json::<ScratchIdentity>(&dir.join(IDENTITY_FILE))
            .is_some_and(|id| id.project_id == project_id);
        if !matches {
            return false;
        }
        let Ok(Some(reopened)) = DiskRawStore::reopen(&dir) else {
            return false;
        };
        inner.raw = Box::new(reopened);
        // Restore the derived state the by-id view and filter resolution
        // read. Rates are left empty (a reloaded trace is stopped, so every
        // rate reads zero); only the newest-index and count are recovered.
        inner.latest = HashMap::new();
        inner.latest_frame = HashMap::new();
        inner.rates = HashMap::new();
        inner.session_start_ns = 0;
        if let Some(derived) = read_json::<DerivedState>(&dir.join(DERIVED_FILE)) {
            inner.session_start_ns = derived.session_start_ns;
            let now = Instant::now();
            for e in derived.entries {
                let frame = RawTraceFrame {
                    timestamp_ns: e.timestamp_ns,
                    channel: e.channel,
                    id: e.id,
                    extended: e.extended,
                    direction: if e.tx { Direction::Tx } else { Direction::Rx },
                    payload: e.payload.into(),
                    bus_id: e.bus_id.clone(),
                };
                let key: FrameKey = (e.bus_id, e.channel, e.id, e.extended);
                inner
                    .latest
                    .insert(key.clone(), usize::try_from(e.last_index).unwrap_or(usize::MAX));
                inner.latest_frame.insert(key.clone(), frame);
                let mut est = RateEstimate::first_seen(0, now);
                est.count = e.count;
                inner.rates.insert(key, est);
            }
        }
        true
    }

    /// Current session-start threshold (Unix-epoch ns). The trace UI
    /// renders frames relative to this; zero means "no session start
    /// has been configured yet", and the store accepts every frame.
    #[must_use]
    pub fn session_start_ns(&self) -> u64 {
        self.inner
            .lock()
            .expect("trace store mutex poisoned")
            .session_start_ns
    }

    /// For each distinct [`FrameKey`] whose most recent occurrence is at
    /// index `>= since`: that index, a clone of the frame, and the id's
    /// current message rate — sorted by key (channel, then id, then
    /// standard-before-extended). A thin alias for
    /// [`Self::latest_in_window`] over `[since, tip]`.
    #[must_use]
    pub fn latest_since(&self, since: usize) -> Vec<LatestById> {
        self.latest_in_window(since, usize::MAX)
    }

    /// Latest-by-id snapshot bounded to the window `[start, end)`: for
    /// each distinct [`FrameKey`] with an occurrence in the window, its
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
    /// window (paused / scrolled into history) costs one O(end - start)
    /// pass — paid on a status change, not on the live refresh tick.
    #[must_use]
    pub fn latest_in_window(&self, start: usize, end: usize) -> Vec<LatestById> {
        let now = Instant::now();
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        let len = inner.raw.len();
        let end = end.min(len);
        if start >= end {
            return Vec::new();
        }
        // (key, last-in-window index, frame). When the window reaches the
        // tip (the running follow-live case), the maintained `latest` index
        // and the eager overlay already hold each key's newest frame — serve
        // the frame from the overlay, not a raw read, so a row whose index
        // has evicted below the low-water mark still resolves (ADR 0002
        // DS-8). A bounded window (paused / scrolled into history) scans the
        // window once and materialises its frames by index — that path only
        // addresses live rows.
        let mut rows: Vec<(FrameKey, usize, RawTraceFrame)> = if end == len {
            inner
                .latest
                .iter()
                .filter(|(_, &idx)| idx >= start)
                .filter_map(|(key, &idx)| {
                    inner
                        .latest_frame
                        .get(key)
                        .map(|f| (key.clone(), idx, f.clone()))
                })
                .collect()
        } else {
            let mut last: HashMap<FrameKey, usize> = HashMap::new();
            for (offset, f) in inner.raw.slice(start, end).iter().enumerate() {
                last.insert((f.bus_id.clone(), f.channel, f.id, f.extended), start + offset);
            }
            let mut keyed: Vec<(FrameKey, usize)> = last.into_iter().collect();
            keyed.sort_unstable();
            let idxs: Vec<usize> = keyed.iter().map(|(_, idx)| *idx).collect();
            let frames = inner.raw.frames_at(&idxs);
            keyed
                .into_iter()
                .zip(frames)
                .map(|((key, idx), (_, frame))| (key, idx, frame))
                .collect()
        };
        rows.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        rows.into_iter()
            .map(|(key, idx, frame)| {
                let est = inner.rates.get(&key);
                LatestById {
                    index: idx,
                    frame,
                    rate: est.map_or(0.0, |r| r.rate(now)),
                    count: est.map_or(0, |r| r.count),
                }
            })
            .collect()
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

    /// The distinct `(bus_id, id, extended)` keys seen this session, from
    /// the maintained newest-per-key map (so it is id-space-bounded, not a
    /// capture walk). The filter-index candidate resolver
    /// (`filter::resolve_candidates`) reads it to turn a `bus` predicate
    /// into the ids on that bus and an `id_range` into the ids that
    /// actually occurred. Channels are collapsed: a `(bus, id, extended)`
    /// is reported once regardless of how many wire channels carried it.
    #[must_use]
    pub fn seen_bus_ids(&self) -> Vec<(Option<String>, u32, bool)> {
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        let mut out: Vec<(Option<String>, u32, bool)> = inner
            .latest
            .keys()
            .map(|(bus, _ch, id, ext)| (bus.clone(), *id, *ext))
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Number of frames the session-start guard has dropped (stale
    /// pipeline frames after a clear/reconnect). Surfaced so that
    /// otherwise-silent path is visible in the diagnostic readout.
    #[must_use]
    pub fn frames_dropped_before_session(&self) -> u64 {
        self.inner
            .lock()
            .expect("trace store mutex poisoned")
            .dropped_before_session
    }

    /// Estimated current append rate in frames per second.
    #[must_use]
    pub fn frames_per_second(&self) -> f64 {
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        prune_rate_samples(&mut inner.rate_samples, now);
        rate_from_samples(&inner.rate_samples)
    }

    /// Estimated current append rate per logical bus, in frames per
    /// second. One entry per bus that has received a frame this session
    /// (`None` = the unassigned bucket), sorted by bus (`None` first,
    /// then by name). Lets a capture show *which* bus is slowing on a
    /// multi-bus stream rather than only the aggregate.
    #[must_use]
    pub fn frames_per_second_by_bus(&self) -> Vec<(Option<String>, f64)> {
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        let mut out: Vec<(Option<String>, f64)> = inner
            .per_bus
            .iter_mut()
            .map(|(bus, br)| {
                prune_rate_samples(&mut br.samples, now);
                (bus.clone(), rate_from_samples(&br.samples))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Estimated current append rate split by [`Direction`], as
    /// `(rx, tx)` frames per second. Read the same way as the aggregate
    /// [`Self::frames_per_second`] — off the rolling sample window — but
    /// on direction-scoped buckets, so a transmit stall (tx falling while
    /// rx holds, or vice versa) is visible where the merged aggregate
    /// would hide it.
    #[must_use]
    pub fn frames_per_second_by_direction(&self) -> (f64, f64) {
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        prune_rate_samples(&mut inner.rx_rate.samples, now);
        prune_rate_samples(&mut inner.tx_rate.samples, now);
        let rx = rate_from_samples(&inner.rx_rate.samples);
        let tx = rate_from_samples(&inner.tx_rate.samples);
        (rx, tx)
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
        self.inner
            .lock()
            .expect("trace store mutex poisoned")
            .raw
            .candidate_indices(ids, start, end)
    }

    fn frames_at(&self, idxs: &[usize]) -> Vec<(usize, RawTraceFrame)> {
        self.frames_at(idxs)
    }
}

/// Serialize `value` to `path` as JSON via a temp-file + rename, so a
/// crash mid-write can't leave a half-written file that fails to parse on
/// reload.
pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, path)
}

/// Read and parse a JSON file written by [`write_json`]. `None` when the
/// file is absent or unparseable — both treated as "no usable state",
/// which the reload path handles as a clean miss.
pub(crate) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Total bytes of every file under `dir` (recursively) — the `current/`
/// scratch footprint the windowed-ring cap measures (ADR 0002 DS-8): raw
/// segments, by-id and filter indexes, signal pyramids, and the small JSON
/// sidecars. Best-effort: an unreadable entry counts zero, so a transient
/// I/O hiccup can't wedge the flush path.
fn dir_footprint(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => total += dir_footprint(&entry.path()),
            Ok(meta) => total += meta.len(),
            Err(_) => {}
        }
    }
    total
}

/// A per-family breakdown of the `current/` scratch footprint for the
/// periodic cache diagnostic (ADR 0002 DS-8). Byte counts are on-disk
/// segment-file sizes; `*_files` are file counts (segments, i.e. "pages").
#[derive(Debug, Default, Clone, Copy)]
pub struct ScratchBreakdown {
    /// Raw frame store: `meta.*` + `payload.*` segments.
    pub frames_bytes: u64,
    pub frames_files: u64,
    /// Signal-cache resolution pyramids (the `signals/` subdir).
    pub pyramid_bytes: u64,
    pub pyramid_files: u64,
    /// Deepest pyramid (number of levels) across all cached signals.
    pub pyramid_depth: u64,
    /// Everything else: by-id postings, filter indexes, and the small JSON
    /// sidecars (manifest / derived / identity).
    pub other_bytes: u64,
    pub other_files: u64,
    /// Sum of the three families' byte counts.
    pub total_bytes: u64,
}

/// Bucket the `current/` scratch by family for the cache diagnostic. One
/// walk: top-level `meta.*`/`payload.*` are frames, the `signals/` subdir is
/// the pyramids (with its level depth), everything else (by-id, the
/// `filter/` subdir, JSON sidecars) is "other".
fn scratch_breakdown(dir: &Path) -> ScratchBreakdown {
    let mut b = ScratchBreakdown::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return b;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if name == "signals" {
                let (bytes, files, depth) = walk_pyramids(&entry.path());
                b.pyramid_bytes += bytes;
                b.pyramid_files += files;
                b.pyramid_depth = b.pyramid_depth.max(depth);
            } else {
                let (bytes, files) = walk_dir(&entry.path());
                b.other_bytes += bytes;
                b.other_files += files;
            }
        } else if name.starts_with("meta.") || name.starts_with("payload.") {
            b.frames_bytes += meta.len();
            b.frames_files += 1;
        } else {
            b.other_bytes += meta.len();
            b.other_files += 1;
        }
    }
    b.total_bytes = b.frames_bytes + b.pyramid_bytes + b.other_bytes;
    b
}

/// Recursively sum `(bytes, file_count)` under `dir`.
fn walk_dir(dir: &Path) -> (u64, u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let (mut bytes, mut files) = (0, 0);
    for entry in entries.flatten() {
        match entry.metadata() {
            Ok(m) if m.is_dir() => {
                let (b, f) = walk_dir(&entry.path());
                bytes += b;
                files += f;
            }
            Ok(m) => {
                bytes += m.len();
                files += 1;
            }
            Err(_) => {}
        }
    }
    (bytes, files)
}

/// Like [`walk_dir`] for the `signals/` pyramid dir, also returning the
/// deepest pyramid (level count) seen — parsed from the `….l{n}.{seg}`
/// segment file names.
fn walk_pyramids(dir: &Path) -> (u64, u64, u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0, 0);
    };
    let (mut bytes, mut files, mut depth) = (0, 0, 0);
    for entry in entries.flatten() {
        let Ok(m) = entry.metadata() else { continue };
        if m.is_dir() {
            let (b, f, d) = walk_pyramids(&entry.path());
            bytes += b;
            files += f;
            depth = depth.max(d);
        } else {
            bytes += m.len();
            files += 1;
            if let Some(level) = pyramid_level(&entry.file_name().to_string_lossy()) {
                depth = depth.max(level + 1);
            }
        }
    }
    (bytes, files, depth)
}

/// The level index `n` in a pyramid segment file name `….l{n}.{seg}`
/// (`{base}.l0.0000`, `{base}.l2.0003`, …), or `None` if it doesn't match.
fn pyramid_level(name: &str) -> Option<u64> {
    let after = &name[name.rfind(".l")? + 2..];
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
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
    use cannet_core::{CanFrame, CanFramePayload, CanId};

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

    fn dummy_tx(ts_ns: u64, id: u32) -> RawTraceFrame {
        let mut f = dummy(ts_ns, id);
        f.direction = Direction::Tx;
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
        assert_eq!(store.frame_index_at_ns(2_500), 3, "between 2000 and 3000 → 3");
        assert_eq!(store.frame_index_at_ns(3_000), 3, "exact hit is the lower bound");
        assert_eq!(store.frame_index_at_ns(99_000), 6, "after the last → len()");
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
        store.start_session(0);
        assert!(store.latest_since(0).is_empty());
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
    fn latest_since_keeps_unassigned_distinct_from_a_named_bus() {
        // Edge case: an unassigned (`bus_id = None`) frame with the
        // same wire channel + id as a bus-tagged frame must not be
        // overwritten by it.
        let store = TraceStore::new();
        store.append(dummy(0, 0x200));
        store.append(dummy_on_bus(1_000, 0x200, "a"));
        let rows = store.latest_since(0);
        let buses: Vec<Option<&str>> = rows.iter().map(|r| r.frame.bus_id.as_deref()).collect();
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
    fn append_counts_frames_dropped_before_session_start() {
        let store = TraceStore::new();
        store.start_session(1_000);
        store.append(dummy(500, 1)); // stale → dropped + counted
        store.append(dummy(2_000, 2)); // kept
        assert_eq!(store.frames_dropped_before_session(), 1);
    }

    #[test]
    fn seen_bus_ids_reports_distinct_bus_id_keys_collapsing_channels() {
        let store = TraceStore::new();
        store.append(dummy_on_bus(0, 0x100, "pt"));
        store.append(dummy_on_bus(1, 0x100, "pt")); // same key — collapses
        store.append(dummy_on_bus(2, 0x200, "pt"));
        store.append(dummy_on_bus(3, 0x100, "body")); // same id, other bus
        store.append(dummy(4, 0x300)); // unassigned bus
        let seen = store.seen_bus_ids();
        assert_eq!(
            seen,
            vec![
                (None, 0x300, false),
                (Some("body".into()), 0x100, false),
                (Some("pt".into()), 0x100, false),
                (Some("pt".into()), 0x200, false),
            ],
        );
    }

    #[test]
    fn clear_resets_len() {
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        store.append(dummy(0, 2));
        store.start_session(0);
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

    #[test]
    fn frames_per_second_by_bus_is_empty_with_no_frames() {
        let store = TraceStore::new();
        assert!(store.frames_per_second_by_bus().is_empty());
    }

    #[test]
    fn frames_per_second_by_bus_buckets_each_bus_separately() {
        // Each logical bus (and the unassigned `None` bucket) is tracked
        // independently; the result is sorted (None first, then by name).
        let store = TraceStore::new();
        store.append(dummy_on_bus(0, 1, "A"));
        store.append(dummy_on_bus(0, 2, "B"));
        store.append(dummy(0, 3)); // unassigned
        let buses: Vec<Option<String>> = store
            .frames_per_second_by_bus()
            .into_iter()
            .map(|(b, _)| b)
            .collect();
        assert_eq!(
            buses,
            vec![None, Some("A".to_string()), Some("B".to_string())]
        );
    }

    #[test]
    fn frames_per_second_by_bus_reports_a_per_bus_rate() {
        // Two samples on bus A, the second taken after a wall gap longer
        // than RATE_SAMPLE_INTERVAL (so it's actually recorded), with
        // frame timestamps 100 ms apart and a count delta of 1 →
        // (2 − 1) / 0.1 s = 10 frames/s. The sleep is what guarantees the
        // second sample is due; the rate itself is read off the frame
        // timestamps, not wall time.
        let store = TraceStore::new();
        store.append(dummy_on_bus(0, 1, "A"));
        std::thread::sleep(std::time::Duration::from_millis(30));
        store.append(dummy_on_bus(100_000_000, 1, "A"));
        let rate = store
            .frames_per_second_by_bus()
            .into_iter()
            .find(|(b, _)| b.as_deref() == Some("A"))
            .expect("bus A present")
            .1;
        assert!((rate - 10.0).abs() < 1.0, "expected ~10/s, got {rate}");
    }

    #[test]
    fn frames_per_second_by_direction_splits_rx_and_tx() {
        // Rx and Tx are tracked in separate buckets. Two frames per
        // direction, the second taken after a wall gap longer than
        // RATE_SAMPLE_INTERVAL so it actually records; the rate reads off
        // the frame-time deltas. Rx steps 100 ms (→10/s); Tx steps 50 ms
        // (→20/s) — distinct rates prove the buckets don't bleed.
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        store.append(dummy_tx(0, 2));
        std::thread::sleep(Duration::from_millis(30));
        store.append(dummy(100_000_000, 1));
        store.append(dummy_tx(50_000_000, 2));
        let (rx, tx) = store.frames_per_second_by_direction();
        assert!((rx - 10.0).abs() < 2.0, "expected rx ~10/s, got {rx}");
        assert!((tx - 20.0).abs() < 3.0, "expected tx ~20/s, got {tx}");
    }

    #[test]
    #[allow(clippy::float_cmp)] // 0.0 is the exact "no frames this direction" sentinel.
    fn frames_per_second_by_direction_is_zero_for_an_unseen_direction() {
        // Only Rx frames have arrived: rx estimates, tx is exactly zero.
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        std::thread::sleep(Duration::from_millis(30));
        store.append(dummy(100_000_000, 1));
        let (rx, tx) = store.frames_per_second_by_direction();
        assert!(rx > 0.0, "rx should estimate, got {rx}");
        assert_eq!(tx, 0.0);
    }

    #[test]
    fn flush_is_a_noop_on_the_in_ram_double() {
        // The test double has no disk; flush must still succeed so the
        // host's flush cadence is store-agnostic.
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        assert!(store.flush().is_ok());
    }

    #[test]
    fn flush_persists_a_disk_store_for_reopen() {
        // The facade flush is the durability point the host cadence drives:
        // after it, the disk store reopens with every frame (ADR 0002 DS-7).
        let dir = std::env::temp_dir().join(format!("cannet-flush-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            let store = TraceStore::new_disk(&dir).unwrap();
            for i in 0u32..5 {
                store.append(dummy(u64::from(i) * 1_000, i));
            }
            store.flush().unwrap();
        }
        let reopened = cannet_spill::DiskRawStore::reopen(&dir)
            .unwrap()
            .expect("flush wrote a reopen manifest");
        assert_eq!(reopened.len(), 5);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_wipes_the_scratch_so_a_reopen_restores_nothing() {
        // The contract "clear scratch cache on exit" relies on (ADR 0002
        // DS-7): the Clear reset (`start_session`) drops the raw store's
        // segments and reopen manifest in place — while the store is still
        // mapped, no unmap needed — so a later reopen finds nothing to
        // restore. The host runs exactly this on exit when the setting is on.
        let dir = std::env::temp_dir().join(format!("cannet-clearexit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            let store = TraceStore::new_disk(&dir).unwrap();
            for i in 0u32..5 {
                store.append(dummy(u64::from(i) * 1_000, i));
            }
            store.flush().unwrap();
            store.start_session(1); // the Clear / clear-on-exit reset
        }
        let restored_len = cannet_spill::DiskRawStore::reopen(&dir)
            .unwrap()
            .map_or(0, |s| s.len());
        assert_eq!(restored_len, 0, "clear must leave nothing to reload");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scratch_breakdown_buckets_by_family() {
        // The cache diagnostic (ADR 0002 DS-8): frames vs pyramid vs other,
        // file counts, and the deepest pyramid parsed from the level names.
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::write(d.join("meta.000000"), vec![0u8; 100]).unwrap();
        std::fs::write(d.join("payload.000000"), vec![0u8; 200]).unwrap();
        std::fs::write(d.join("byid.s00000100.0000"), vec![0u8; 50]).unwrap();
        std::fs::write(d.join("manifest.json"), vec![0u8; 10]).unwrap();
        std::fs::create_dir(d.join("filter")).unwrap();
        std::fs::write(d.join("filter").join("filt.0000"), vec![0u8; 30]).unwrap();
        std::fs::create_dir(d.join("signals")).unwrap();
        std::fs::write(d.join("signals").join("0x100.sig.l0.0000"), vec![0u8; 300]).unwrap();
        std::fs::write(d.join("signals").join("0x100.sig.l1.0000"), vec![0u8; 150]).unwrap();
        std::fs::write(d.join("signals").join("0x100.sig.l2.0000"), vec![0u8; 70]).unwrap();

        let b = scratch_breakdown(d);
        assert_eq!(b.frames_bytes, 300); // meta 100 + payload 200
        assert_eq!(b.frames_files, 2);
        assert_eq!(b.pyramid_bytes, 520); // 300 + 150 + 70
        assert_eq!(b.pyramid_files, 3);
        assert_eq!(b.pyramid_depth, 3); // levels l0, l1, l2 → depth 3
        assert_eq!(b.other_bytes, 90); // byid 50 + manifest 10 + filter 30
        assert_eq!(b.other_files, 3);
        assert_eq!(b.total_bytes, 300 + 520 + 90);
    }

    #[test]
    fn scratch_footprint_bytes_is_none_for_ram_and_tracks_disk() {
        // The status readout source (ADR 0002 DS-8): None for the in-RAM
        // double, the measured `current/` footprint for a disk store, cached
        // on the flush cadence.
        let ram = TraceStore::new();
        assert_eq!(ram.scratch_footprint_bytes(), None);

        let dir = std::env::temp_dir().join(format!("cannet-fp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = TraceStore::new_disk(&dir).unwrap();
        assert_eq!(store.scratch_footprint_bytes(), Some(0), "no flush yet");
        for i in 0u32..50 {
            store.append(dummy(u64::from(i) * 1_000, i));
        }
        store.flush().unwrap();
        let fp = store.scratch_footprint_bytes().expect("disk store reports a footprint");
        assert!(fp > 0, "footprint reflects the written scratch");
        assert_eq!(fp, dir_footprint(&dir), "cached value matches a fresh walk");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn flush_sheds_oldest_segments_when_over_the_scratch_cap() {
        // 6c-B (ADR 0002 DS-8): a flush past the cap drops the oldest raw
        // segments; the tip is unchanged, only the floor moves.
        use cannet_spill::{DiskConfig, DiskRawStore};
        let dir = std::env::temp_dir().join(format!("cannet-cap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = DiskConfig {
            records_per_seg: 4,
            payload_seg_bytes: 64,
            ring_capacity: 3,
        };
        let raw = Box::new(DiskRawStore::with_config(&dir, cfg).unwrap());
        let store = TraceStore::with_raw(raw, Some(dir.clone()));
        for i in 0u32..40 {
            store.append(dummy(u64::from(i) * 1_000, 0x100));
        }
        store.flush().unwrap(); // unbounded: no eviction
        assert!(!store.slice(0, 1).is_empty(), "row 0 present before the cap");
        let full = dir_footprint(&dir);
        // Cap well below the footprint: the next flush sheds the oldest.
        store.set_scratch_cap(Some(full / 2));
        store.flush().unwrap();
        let after = dir_footprint(&dir);
        assert!(after < full, "flush reclaimed disk: {after} < {full}");
        assert!(store.slice(0, 1).is_empty(), "oldest rows were evicted");
        assert_eq!(store.len(), 40, "the tip is unchanged — only the floor moved");
        assert_eq!(store.slice(39, 40)[0].id, 0x100, "the live tail still reads");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn by_id_overlay_keeps_a_rare_ids_last_value_across_eviction() {
        // 6c-C (ADR 0002 DS-8): the global latest-by-id read serves frame
        // content from the eager overlay, so an id whose only frame was
        // evicted below the low-water mark still shows its last value in the
        // by-id grid — not a blank row, and not misaligned onto another id's
        // frame (the failure mode of reading evicted indices back from raw).
        use cannet_spill::{DiskConfig, DiskRawStore};
        let dir = std::env::temp_dir().join(format!("cannet-overlay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = DiskConfig {
            records_per_seg: 4,
            payload_seg_bytes: 64,
            ring_capacity: 3,
        };
        let raw = Box::new(DiskRawStore::with_config(&dir, cfg).unwrap());
        let store = TraceStore::with_raw(raw, Some(dir.clone()));
        // A rare id seen once at the very start (index 0), then a flood of a
        // common id that pushes the rare id's only frame into the oldest
        // segments.
        store.append({
            let mut f = dummy(1_000, 0x7AA);
            f.payload = CanFramePayload::Classic(vec![0xAB]);
            f
        });
        for i in 1u32..40 {
            store.append(dummy(u64::from(i) * 1_000, 0x100));
        }
        store.flush().unwrap();
        let full = dir_footprint(&dir);
        store.set_scratch_cap(Some(full / 2));
        store.flush().unwrap();

        let (mark, _) = store.low_water();
        assert!(mark > 0, "eviction advanced the low-water mark");
        assert!(store.slice(0, 1).is_empty(), "the rare id's frame left raw");
        let rows = store.latest_since(0);
        let rare = rows
            .iter()
            .find(|r| r.frame.id == 0x7AA)
            .expect("the evicted rare id is still in the by-id grid");
        assert_eq!(rare.frame.payload.data(), &[0xAB], "its last value survives");
        // The common id is also present and correct (no zip misalignment).
        assert!(rows.iter().any(|r| r.frame.id == 0x100));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn by_id_overlay_persists_an_evicted_last_value_across_reopen() {
        // 6c-C: the overlay rides `derived.json`, so a reopen across an
        // eviction still serves the evicted id's last value.
        use cannet_spill::{DiskConfig, DiskRawStore};
        let dir = std::env::temp_dir().join(format!("cannet-overlay-rl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid = uuid::Uuid::new_v4();
        let cfg = DiskConfig {
            records_per_seg: 4,
            payload_seg_bytes: 64,
            ring_capacity: 3,
        };
        {
            let raw = Box::new(DiskRawStore::with_config(&dir, cfg).unwrap());
            let store = TraceStore::with_raw(raw, Some(dir.clone()));
            store.write_scratch_identity(Some(pid));
            store.append({
                let mut f = dummy(1_000, 0x7AA);
                f.payload = CanFramePayload::Classic(vec![0xCD]);
                f
            });
            for i in 1u32..40 {
                store.append(dummy(u64::from(i) * 1_000, 0x100));
            }
            store.flush().unwrap();
            store.set_scratch_cap(Some(dir_footprint(&dir) / 2));
            store.flush().unwrap();
            assert!(store.slice(0, 1).is_empty(), "evicted before reopen");
        }
        let booted = TraceStore::new_disk(&dir).unwrap();
        assert!(booted.try_reload(pid), "matching project reloads");
        let rare = booted
            .latest_since(0)
            .into_iter()
            .find(|r| r.frame.id == 0x7AA)
            .expect("the evicted rare id reloads with its last value");
        assert_eq!(rare.frame.payload.data(), &[0xCD]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cap_eviction_does_not_over_evict_raw_for_derived_family_footprint() {
        // Regression (ADR 0002 DS-8): the scratch cap bounds the *whole* dir
        // (raw + the derived caches), but only the raw family is shed at flush
        // — the derived caches cascade-trim to the new low-water afterward.
        // Sizing the raw eviction against the whole-dir excess made it shed raw
        // to cover the derived families' bytes too, collapsing the retained
        // window to the tail ("retained resets to ~0 every flush"). The request
        // must be scaled to the raw share so raw + the cascade land at the cap
        // together.
        use cannet_spill::{DiskConfig, DiskRawStore};
        let dir =
            std::env::temp_dir().join(format!("cannet-cap-share-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = DiskConfig { records_per_seg: 4, payload_seg_bytes: 64, ring_capacity: 3 };
        let raw = Box::new(DiskRawStore::with_config(&dir, cfg).unwrap());
        let store = TraceStore::with_raw(raw, Some(dir.clone()));
        for i in 0u32..40 {
            store.append(dummy(u64::from(i) * 1_000, 0x100));
        }
        store.flush().unwrap();
        // A derived cache as large as the whole raw dir, which this flush
        // cannot shed (not a `meta.`/`payload.` file) — it stands in for the
        // signal pyramids that live in a `signals/` sibling.
        let raw_dir_bytes = dir_footprint(&dir);
        let stub = vec![0u8; usize::try_from(raw_dir_bytes).unwrap()];
        std::fs::write(dir.join("derived.stub"), stub).unwrap();
        // Cap at the raw dir's size: the whole dir is now ~2x the cap, but the
        // excess is the derived stub, not raw.
        store.set_scratch_cap(Some(raw_dir_bytes));
        store.flush().unwrap();

        let len = store.len();
        let (mark, _) = store.low_water();
        assert!(mark > 0, "eviction advanced the low-water mark");
        assert!(
            len - mark >= 12,
            "raw over-evicted to cover the derived stub: retained {} of {len} (mark {mark})",
            len - mark,
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn try_reload_restores_a_matching_stopped_session() {
        let dir = std::env::temp_dir().join(format!("cannet-reload-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid = uuid::Uuid::new_v4();
        {
            let store = TraceStore::new_disk(&dir).unwrap();
            store.start_session(1_000); // session-start anchor
            store.write_scratch_identity(Some(pid));
            store.append(dummy_on_bus(1_000, 0x100, "pt"));
            store.append(dummy_on_bus(2_000, 0x100, "body")); // same id, other bus
            store.append(dummy_on_bus(3_000, 0x100, "pt"));
            store.flush().unwrap();
        }
        // A fresh launch over the same dir: empty until the gate reloads.
        let booted = TraceStore::new_disk(&dir).unwrap();
        assert_eq!(booted.len(), 0);
        // Mismatched project: nothing loads, the scratch is left intact.
        assert!(!booted.try_reload(uuid::Uuid::new_v4()));
        assert_eq!(booted.len(), 0);
        // Matching project: reloads as a stopped trace with derived state
        // and the session-start anchor restored.
        assert!(booted.try_reload(pid));
        assert_eq!(booted.len(), 3);
        assert_eq!(booted.session_start_ns(), 1_000);
        // Multi-bus same-id stays faithful (fork P persists the full key):
        // both buses are present with their own counts.
        let mut by_bus: Vec<(Option<String>, u64)> = booted
            .latest_since(0)
            .iter()
            .map(|r| (r.frame.bus_id.clone(), r.count))
            .collect();
        by_bus.sort();
        assert_eq!(
            by_bus,
            vec![(Some("body".into()), 1), (Some("pt".into()), 2)]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn start_session_wipes_the_scratch_so_a_later_reload_misses() {
        let dir = std::env::temp_dir().join(format!("cannet-wipe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid = uuid::Uuid::new_v4();
        {
            let store = TraceStore::new_disk(&dir).unwrap();
            store.write_scratch_identity(Some(pid));
            store.append(dummy(1_000, 1));
            store.flush().unwrap();
        }
        {
            // A Clear / new-capture reset wipes the scratch identity.
            let store = TraceStore::new_disk(&dir).unwrap();
            assert!(store.try_reload(pid));
            store.start_session(0);
            store.flush().unwrap();
        }
        let booted = TraceStore::new_disk(&dir).unwrap();
        assert!(!booted.try_reload(pid), "wiped identity must not reload");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn start_session_empties_buffer_and_raises_threshold() {
        let store = TraceStore::new();
        store.append(dummy(100, 1));
        store.append(dummy(200, 2));
        assert_eq!(store.len(), 2);
        store.start_session(1_000);
        assert_eq!(store.len(), 0);
        assert_eq!(store.session_start_ns(), 1_000);
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
