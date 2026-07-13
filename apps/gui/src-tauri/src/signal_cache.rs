//! Per-signal cache of decoded sample points, extended incrementally
//! as the trace store grows so `sample_signals` doesn't re-decode the
//! same matching frames on every call.
//!
//! Each decoded signal gets its own [`SignalCache`]: a **resolution
//! pyramid** of its decoded samples plus the next trace-store frame
//! index to scan from. The pyramid is a property of the signal, not of
//! any one consumer — a plot fitting all data is the consumer today,
//! but the multi-resolution view is the signal's. Level 0 is the raw
//! decoded series in capture order; each higher level holds, per bucket
//! of [`PYRAMID_BRANCH`] points of the level below, that bucket's min-
//! and max-value points — so the pyramid is geometrically smaller going
//! up and per-bucket extrema mean spikes survive (ADR 0002 DS-5). A
//! call to [`SignalCacheStore::slice`] catches the cache up to the
//! store's tip (decoding any new matching frames against the loaded
//! DBCs), then serves a `[from_seconds, to_seconds)` range at a point
//! budget by reading the coarsest pyramid level that still has more than
//! `max_points` points in the range. So a whole-span serve over a
//! 10^8-frame capture reads `O(max_points)` points instead of
//! materializing and decimating the whole raw series on every request.
//!
//! Coupled with the existing per-id index in [`TraceStore::by_id`],
//! catch-up is `O(Σ new matches)`: at high rate the per-tick work
//! is bounded by how much capture arrived since the last call, not by
//! the total capture length — which is the whole point. The pyramid is
//! built incrementally on the same catch-up (each new sample is folded
//! into each higher level at most once), so first-plot build is
//! `O(that id's occurrences)` and steady-state serve is `O(max_points)`.
//! Every pyramid level is an mmap'd [`SampleSeq`] under the disk-spill
//! scratch (ADR 0002 DS-5/DS-7), so the resident set is only the segment
//! handles plus whatever windows the serve path has recently touched — the
//! kernel pages cold history out under pressure. A pyramid is *derived*
//! state, so it carries no reopen manifest: [`SignalCacheStore::clear`]
//! (on `clear_trace_store`) drops the caches and wipes their files, and the
//! next serve rebuilds the pyramid on disk by re-decoding the reopened raw
//! frames (the source of truth).
//!
//! Concurrency: one global mutex around the (small) `HashMap`. The
//! catch-up itself doesn't hold the trace-store lock beyond
//! `matching_frames_indexed`'s clone — decoding runs off-lock, so the
//! pump isn't starved by long catch-ups.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use cannet_dbc::Database;
use cannet_spill::SampleSeq;

use crate::signal_sampler::{self, SamplePoint};
use crate::trace_store::TraceStore;

/// Min/max bucket branching factor: each pyramid level merges this many
/// consecutive points of the level below into one bucket, emitting that
/// bucket's min- and max-value points (so spikes survive). 8 keeps 2
/// points per 8, a ~4× point reduction per level, so a handful of levels
/// span 10^7+ samples and a wide-window serve reads a small coarse level.
const PYRAMID_BRANCH: usize = 8;

/// One signal's decoded samples as a min/max resolution pyramid, plus
/// the next trace-store frame index to scan from on the next catch-up.
struct SignalCache {
    /// Scratch directory the level [`SampleSeq`]s are rooted in, and the
    /// per-signal file-name base under it — held so [`Self::fold`] can mint
    /// a new level's sequence when the one below first overflows a bucket.
    dir: PathBuf,
    base: String,
    /// Resolution pyramid. `levels[0]` is the raw decoded series in
    /// capture (frame-index) order; `levels[n]` (n ≥ 1) holds, for each
    /// bucket of [`PYRAMID_BRANCH`] consecutive `levels[n-1]` points,
    /// that bucket's min- and max-value points in time order. Every
    /// level is non-decreasing in `t_seconds`, so the serve path
    /// binary-searches each by `t_seconds`. Each level is an mmap'd
    /// [`SampleSeq`], so the pyramid's residency is bounded (the module
    /// docs); only the small per-level segment directories stay in RAM.
    levels: Vec<SampleSeq>,
    /// `folded[n]` = how many of `levels[n]`'s points have already been
    /// folded into complete buckets in `levels[n+1]`. Lets catch-up
    /// extend the pyramid incrementally: only the buckets that just
    /// became complete are folded, so per-call work is `O(new matches)`.
    folded: Vec<usize>,
    /// Next trace-store frame index to start the next catch-up scan
    /// from. Advances to `TraceStore::len()` after each catch-up.
    next_index: usize,
    /// Running all-time value extent over every decoded sample —
    /// widen-only, maintained as samples are pushed. This is the
    /// host-owned y-extent the plot's auto-normalisation reads (ADR
    /// 0025: a scalar model fact, not a windowed accessor), so the
    /// frontend no longer latches it in a React ref. `lo > hi` (the
    /// empty sentinel) means nothing has decoded yet.
    lo: f64,
    hi: f64,
}

impl SignalCache {
    /// A fresh cache whose level-0 sequence is rooted at `dir` with file
    /// base `base` (`{base}.l0`, `{base}.l1`, … minted per level by
    /// [`Self::fold`]).
    fn new(dir: &Path, base: &str) -> Self {
        Self {
            dir: dir.to_path_buf(),
            base: base.to_string(),
            levels: vec![SampleSeq::new(dir, format!("{base}.l0"))],
            folded: vec![0],
            next_index: 0,
            lo: f64::INFINITY,
            hi: f64::NEG_INFINITY,
        }
    }

    /// All-time value extent, or `None` if nothing has decoded yet.
    fn extent(&self) -> Option<(f64, f64)> {
        (self.lo <= self.hi).then_some((self.lo, self.hi))
    }

    /// Decode any matching frames in `[next_index, store_len)` into the
    /// cache, advancing `next_index` to the tip and widening the
    /// `[lo, hi]` extent. `O(new matches since last call)` — the whole
    /// point of the cache. Shared by [`SignalCacheStore::slice`] and
    /// [`SignalCacheStore::min_max`] so both observe the same samples.
    fn catch_up(
        &mut self,
        bus_id: Option<&str>,
        message_id: u32,
        extended: bool,
        signal_name: &str,
        store: &TraceStore,
        dbs: &[&Database],
    ) {
        let store_len = store.len();
        if self.next_index >= store_len {
            return;
        }
        let new_matches =
            store.matching_frames_indexed(message_id, extended, self.next_index, store_len);
        for (_idx, frame) in new_matches {
            // Bus filter: when the query is scoped to a bus, drop
            // frames whose `bus_id` doesn't match. `None` on the query
            // is the legacy "any bus" path that takes every frame.
            if let Some(want) = bus_id {
                if frame.bus_id.as_deref() != Some(want) {
                    continue;
                }
            }
            // Try each loaded DBC in priority order, first decode wins
            // (matches `sample_signals`' existing semantics).
            for db in dbs {
                let decoded = signal_sampler::sample_signal(
                    std::slice::from_ref(&frame),
                    db,
                    message_id,
                    extended,
                    signal_name,
                );
                if let Some(point) = decoded.into_iter().next() {
                    if point.value < self.lo {
                        self.lo = point.value;
                    }
                    if point.value > self.hi {
                        self.hi = point.value;
                    }
                    self.levels[0].push(point.t_seconds, point.value);
                    break;
                }
            }
        }
        self.next_index = store_len;
        self.fold();
    }

    /// Propagate newly-appended `levels[0]` points up the pyramid: for
    /// each level, fold every bucket of [`PYRAMID_BRANCH`] points that
    /// became complete since the last call into the level above, emitting
    /// that bucket's min- and max-value points in time order. Amortized
    /// `O(new points)` — a point is folded into each higher level at most
    /// once — and it creates the next level only when the one below has a
    /// full bucket to give it, so the pyramid is exactly as tall as the
    /// data warrants (the top level always holds `< PYRAMID_BRANCH` points).
    fn fold(&mut self) {
        let mut src = 0;
        loop {
            let start = self.folded[src];
            let complete = (self.levels[src].len() - start) / PYRAMID_BRANCH;
            if complete == 0 {
                break;
            }
            if self.levels.len() == src + 1 {
                let n = self.levels.len();
                self.levels
                    .push(SampleSeq::new(&self.dir, format!("{}.l{n}", self.base)));
                self.folded.push(0);
            }
            for b in 0..complete {
                let s = start + b * PYRAMID_BRANCH;
                // Copy the bucket out of `levels[src]` first (releasing its
                // immutable borrow) so the `levels[src + 1]` push below can
                // mutably borrow `levels`.
                let mut bucket = [(0.0f64, 0.0f64); PYRAMID_BRANCH];
                for (j, slot) in bucket.iter_mut().enumerate() {
                    *slot = self.levels[src].get(s + j);
                }
                let mut lo = 0;
                let mut hi = 0;
                for (i, &(_, v)) in bucket.iter().enumerate() {
                    if v < bucket[lo].1 {
                        lo = i;
                    }
                    if v > bucket[hi].1 {
                        hi = i;
                    }
                }
                // Emit in time (index) order; collapse to one when the
                // bucket's min and max are the same point (flat bucket).
                let (a, c) = (lo.min(hi), lo.max(hi));
                let (tmin, vmin) = bucket[a];
                self.levels[src + 1].push(tmin, vmin);
                if a != c {
                    let (tmax, vmax) = bucket[c];
                    self.levels[src + 1].push(tmax, vmax);
                }
            }
            self.folded[src] = start + complete * PYRAMID_BRANCH;
            src += 1;
        }
    }

    /// Serve a `[from, to)` window decimated to about `max_points` points.
    /// Reads the coarsest pyramid level whose in-window point count still
    /// exceeds `max_points` (so the next coarser level would drop below
    /// it), slices that level to the window with two boundary points on
    /// each side, and clamps to `max_points` via min/max decimation. The
    /// chosen level holds at most `~PYRAMID_BRANCH × max_points` points in
    /// the window, so this is `O(max_points)` regardless of capture
    /// length. `max_points == 0` disables decimation and returns the raw
    /// level-0 window slice.
    fn window(&self, from: f64, to: f64, max_points: usize) -> Vec<SamplePoint> {
        if self.levels[0].live_len() == 0 {
            return Vec::new();
        }
        // Coarsest level still holding > max_points points in the window.
        // Counts shrink monotonically as levels coarsen, so walk up while
        // the count stays above the budget.
        let mut chosen = 0;
        if max_points > 0 {
            for (n, level) in self.levels.iter().enumerate() {
                if window_count(level, from, to) > max_points {
                    chosen = n;
                } else {
                    break;
                }
            }
        }
        let slice = window_slice(&self.levels[chosen], from, to);
        if max_points == 0 {
            slice
        } else {
            signal_sampler::decimate_min_max(&slice, max_points)
        }
    }

    /// Front-trim every level to the truncation time `ts_seconds` (ADR 0002
    /// DS-8 / 6d): drop the points (and their leading segment files) older
    /// than the live window, so the pyramid's footprint follows the raw
    /// store's. Each level is non-decreasing in `t_seconds`, so the floor is
    /// the time partition point. `folded` is bumped to the floor so the next
    /// [`Self::fold`] never reads an evicted slot — old points evict only
    /// after they have long since folded upward, so this is normally a no-op
    /// on `folded`, but it makes the rare evict-outran-fold case safe.
    fn evict_below(&mut self, ts_seconds: f64) {
        for n in 0..self.levels.len() {
            let floor = partition_by_t(&self.levels[n], ts_seconds);
            self.levels[n].evict_below(floor);
            self.folded[n] = self.folded[n].max(floor);
        }
    }
}

/// Smallest live slot `k` in `[first_slot, level.len())` whose `t_seconds`
/// is `>= target` — the partition point of the (non-decreasing) `t_seconds`
/// order, by binary search over [`SampleSeq::get`]. The lower bound starts
/// at the level's low-water mark, so an evicted (front-trimmed) slot is
/// never read.
fn partition_by_t(level: &SampleSeq, target: f64) -> usize {
    let mut lo = level.first_slot();
    let mut hi = level.len();
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if level.get(mid).0 < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

/// Count of `level` points whose `t_seconds` lies in `[from, to)`.
/// `level` is non-decreasing in `t_seconds`, so this is two binary
/// searches.
fn window_count(level: &SampleSeq, from: f64, to: f64) -> usize {
    partition_by_t(level, to) - partition_by_t(level, from)
}

/// Slice `level` to `[from, to)`, widened by two boundary points on each
/// side. The extra points give a line renderer a segment running off each
/// range edge, so a consumer drawing the series doesn't go blank or end a
/// bin early at the range boundary (see [`SignalCacheStore::slice`]). The
/// chosen level holds `O(max_points)` points in the window, so this
/// materializes a bounded run out of the mmap'd sequence.
fn window_slice(level: &SampleSeq, from: f64, to: f64) -> Vec<SamplePoint> {
    let lo = partition_by_t(level, from);
    let hi = partition_by_t(level, to);
    // Widen by two boundary points each side, but never below the level's
    // low-water mark — a slot under it has been front-trimmed.
    let lo_inclusive = lo.saturating_sub(2).max(level.first_slot());
    let hi_inclusive = std::cmp::min(level.len(), hi.saturating_add(2));
    (lo_inclusive..hi_inclusive)
        .map(|k| {
            let (t_seconds, value) = level.get(k);
            SamplePoint { t_seconds, value }
        })
        .collect()
}

/// Cache key — one bucket per `(bus, message, signal)` triple, so
/// the same arbitration id on two different buses (with different
/// DBC scopes) decodes into two independent series. `bus_id = None`
/// is the legacy "any bus" path: it matches every frame regardless
/// of its bus tag, used by old plot panels that pre-date per-bus
/// signal binding.
type SignalKey = (Option<String>, u32, bool, String);

/// A stable, filesystem-safe file-name base for a signal's pyramid levels:
/// `sig.{s|e}{id:08x}.{hash:016x}`. The id and extended flag are encoded
/// literally (debuggable); the variable-length bus/signal text is folded
/// into an FNV-1a hash so the name is bounded and contains no path-hostile
/// characters. Deterministic in the key, so the same signal always maps to
/// the same files within a session.
fn key_prefix(key: &SignalKey) -> String {
    let (bus, id, extended, signal) = key;
    // FNV-1a over a canonical encoding of the whole key, separators
    // included so `(Some("a"), "b")` and `(Some("ab"), "")` can't alias.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |bytes: &[u8]| {
        for &b in bytes {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    mix(bus.as_deref().unwrap_or("").as_bytes());
    mix(&[0]);
    mix(&id.to_le_bytes());
    mix(&[u8::from(*extended)]);
    mix(signal.as_bytes());
    let kind = if *extended { 'e' } else { 's' };
    format!("sig.{kind}{id:08x}.{h:016x}")
}

/// Remove every file directly under `dir` (the pyramid scratch). Called
/// after the mappings have been dropped, so Windows allows the removal.
/// Best-effort: a missing dir or an unremovable file is ignored — the
/// pyramid is derived state that rebuilds regardless.
fn wipe_dir(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Process-wide collection of per-signal caches. The pyramid levels spill
/// to mmap'd files under `root` (a `signals/` subdir of the disk-spill
/// scratch), so the resident set stays bounded (ADR 0002 DS-5/DS-7).
pub struct SignalCacheStore {
    root: PathBuf,
    caches: Mutex<HashMap<SignalKey, SignalCache>>,
}

impl SignalCacheStore {
    /// Root the per-signal pyramids at `root`, wiping any stale files left
    /// there by a prior session (a pyramid is derived state — rebuilt from
    /// the reopened raw frames — so nothing there is worth preserving).
    pub fn new(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref().to_path_buf();
        let _ = std::fs::create_dir_all(&root);
        wipe_dir(&root);
        Self {
            root,
            caches: Mutex::new(HashMap::new()),
        }
    }

    /// Drop every cached series and wipe its files — call on
    /// `clear_trace_store` (the frame indices and samples no longer
    /// correspond to anything). Dropping the map unmaps the segments first,
    /// so the files can then be removed (Windows forbids removing a mapped
    /// file).
    pub fn clear(&self) {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        *caches = HashMap::new();
        wipe_dir(&self.root);
    }

    /// Front-trim every cached pyramid to the truncation time `ts_seconds`
    /// (ADR 0002 DS-8 / 6d) so the signal cache's footprint follows the raw
    /// store's windowed-ring eviction. The host calls this with the timestamp
    /// of the raw low-water mark whenever eviction advances it; signals with
    /// no points that old are unaffected.
    pub fn evict_below(&self, ts_seconds: f64) {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        for cache in caches.values_mut() {
            cache.evict_below(ts_seconds);
        }
    }

    /// Catch the signal's cache up to the trace store's current tip,
    /// then return the samples whose `t_seconds` lies in
    /// `[from_seconds, to_seconds)`, decimated to about `max_points`
    /// points by reading the coarsest pyramid level that still has more
    /// than `max_points` points in the window (ADR 0002 DS-5).
    /// `max_points == 0` disables decimation and returns the raw
    /// level-0 window slice. Empty if no DBC decodes the signal or no
    /// matching frames have been seen yet.
    ///
    /// Slicing by time rather than by trace-store frame index matters
    /// when the caller derives a range from "visible x-axis seconds"
    /// via an average-rate (`fps`) estimate: under non-uniform per-id
    /// rates the index drift is tens of seconds, and the user sees the
    /// returned samples starting well inside the requested left edge
    /// (the "fencepost" effect on zoomed-in panels). The cache stores
    /// `t_seconds` per sample anyway, so partitioning by it directly
    /// removes the conversion entirely.
    ///
    /// The catch-up is `O(new matches since last call)` — fast in
    /// steady state; only the first call on a fresh cache pays for the
    /// backlog. The decimated serve is `O(max_points)`, independent of
    /// capture length. Loaded-DBC iteration mirrors the rest of the
    /// host's "first DBC that decodes wins" semantics. `bus_id` scopes
    /// the catch-up to frames tagged with that bus; pass `None` for the
    /// legacy "any bus" path.
    #[allow(clippy::too_many_arguments)]
    pub fn slice(
        &self,
        bus_id: Option<&str>,
        message_id: u32,
        extended: bool,
        signal_name: &str,
        from_seconds: f64,
        to_seconds: f64,
        max_points: usize,
        store: &TraceStore,
        dbs: &[&Database],
    ) -> Vec<SamplePoint> {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        let key: SignalKey = (
            bus_id.map(str::to_owned),
            message_id,
            extended,
            signal_name.to_string(),
        );
        let base = key_prefix(&key);
        let cache = caches
            .entry(key)
            .or_insert_with(|| SignalCache::new(&self.root, &base));

        cache.catch_up(bus_id, message_id, extended, signal_name, store, dbs);
        cache.window(from_seconds, to_seconds, max_points)
    }

    /// The signal's all-time value extent `(lo, hi)` over every decoded
    /// sample, catching the cache up to the store's tip first. `None`
    /// when no matching frame has decoded yet. This is the host-owned
    /// y-extent the plot's auto-normalisation reads — a scalar model
    /// fact (ADR 0025), so the frontend reads it instead of latching a
    /// widen-only range in a React ref. `bus_id` scoping matches
    /// [`Self::slice`].
    pub fn min_max(
        &self,
        bus_id: Option<&str>,
        message_id: u32,
        extended: bool,
        signal_name: &str,
        store: &TraceStore,
        dbs: &[&Database],
    ) -> Option<(f64, f64)> {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        let key: SignalKey = (
            bus_id.map(str::to_owned),
            message_id,
            extended,
            signal_name.to_string(),
        );
        let base = key_prefix(&key);
        let cache = caches
            .entry(key)
            .or_insert_with(|| SignalCache::new(&self.root, &base));
        cache.catch_up(bus_id, message_id, extended, signal_name, store, dbs);
        cache.extent()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace_store::RawTraceFrame;
    use cannet_core::{CanFramePayload, Direction};
    use tempfile::TempDir;

    fn dummy(ts_ns: u64, id: u32, payload: Vec<u8>) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: ts_ns,
            channel: 0,
            id,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(payload),
            bus_id: None,
        }
    }

    const TEST_DBC: &str = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_:\n\nBO_ 256 Msg: 8 Vector__XXX\n SG_ X : 0|16@1+ (1,0) [0|0] \"\" Vector__XXX\n\n";

    fn load_dbc() -> Database {
        Database::parse(TEST_DBC).unwrap()
    }

    /// One second in nanoseconds — keeps the test data using
    /// whole-second timestamps so the seconds-based slice bounds read
    /// naturally.
    const S: u64 = 1_000_000_000;

    #[test]
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    fn slice_decodes_lazily_and_returns_only_the_requested_range() {
        let store = TraceStore::new();
        // Mix of id 256 (decodes via the DBC) and id 999 (doesn't).
        // Id-256 samples land at t = 0, 2, 3, 5 seconds.
        store.append(dummy(0, 256, vec![1, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(S, 999, vec![0, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(2 * S, 256, vec![2, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(3 * S, 256, vec![3, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(4 * S, 999, vec![0, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(5 * S, 256, vec![4, 0, 0, 0, 0, 0, 0, 0]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        // Full time range — all four id-256 samples. `max_points = 0`
        // disables decimation, so the raw level-0 window comes back.
        let all = cache.slice(None, 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(
            all.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );

        // Narrow time range [2.5, 4.5): only the id-256 sample at t = 3
        // is in range. The ±2 boundary widening also pulls in samples
        // at t = 0 / 2 (just before) and t = 5 (just after), giving
        // uPlot the last-known-coming-in value and the next-going-out
        // value to draw a line across.
        let mid = cache.slice(None, 256, false, "X", 2.5, 4.5, 0, &store, dbs);
        assert_eq!(
            mid.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );

        // Very narrow zoom that contains zero matches: the slice still
        // returns the boundary samples on each side, so the plot draws
        // a line across the canvas instead of going blank.
        let narrow = cache.slice(None, 256, false, "X", 0.5, 1.5, 0, &store, dbs);
        assert_eq!(
            narrow.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );

        // Append a new sample — catch-up extends the cached series.
        store.append(dummy(6 * S, 256, vec![5, 0, 0, 0, 0, 0, 0, 0]));
        let all2 = cache.slice(None, 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(
            all2.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );

        // Clear drops the cache; the next slice rebuilds it.
        cache.clear();
        let after = cache.slice(None, 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(after.len(), 5);
    }

    #[test]
    fn min_max_tracks_all_time_extent_and_catches_up() {
        // The per-signal min/max latch is the host-owned y-extent the
        // plot's auto-normalisation reads (ADR 0025: a scalar model
        // fact, not a windowed accessor). It is all-time and widen-only:
        // a later in-range sample never shrinks it, a new extreme grows
        // it, and a fresh append is caught up on the next call.
        let store = TraceStore::new();
        store.append(dummy(0, 256, vec![3, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(S, 256, vec![1, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(2 * S, 256, vec![5, 0, 0, 0, 0, 0, 0, 0]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        assert_eq!(
            cache.min_max(None, 256, false, "X", &store, dbs),
            Some((1.0, 5.0))
        );
        // A later sample inside the latch doesn't shrink it.
        store.append(dummy(3 * S, 256, vec![2, 0, 0, 0, 0, 0, 0, 0]));
        assert_eq!(
            cache.min_max(None, 256, false, "X", &store, dbs),
            Some((1.0, 5.0))
        );
        // A new extreme widens it.
        store.append(dummy(4 * S, 256, vec![9, 0, 0, 0, 0, 0, 0, 0]));
        assert_eq!(
            cache.min_max(None, 256, false, "X", &store, dbs),
            Some((1.0, 9.0))
        );
    }

    #[test]
    fn min_max_is_none_for_a_signal_nothing_has_decoded() {
        let store = TraceStore::new();
        store.append(dummy(0, 256, vec![1, 0, 0, 0, 0, 0, 0, 0]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        // Unknown id and unknown signal both have no decoded samples.
        assert!(cache.min_max(None, 999, false, "X", &store, dbs).is_none());
        assert!(cache
            .min_max(None, 256, false, "Nope", &store, dbs)
            .is_none());
    }

    #[test]
    fn unknown_signal_returns_empty_and_doesnt_panic() {
        let store = TraceStore::new();
        store.append(dummy(0, 256, vec![0; 8]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        let nope = cache.slice(None, 256, false, "Nope", 0.0, 1.0, 0, &store, dbs);
        assert!(nope.is_empty());
        let no_id = cache.slice(None, 42, false, "X", 0.0, 1.0, 0, &store, dbs);
        assert!(no_id.is_empty());
    }

    #[test]
    fn bus_id_scoping_keeps_per_bus_series_independent() {
        // Two frames sharing wire channel 0 and the same arbitration
        // id but tagged with different buses get sliced into two
        // independent cached series.
        let store = TraceStore::new();
        let mut a = dummy(0, 256, vec![1, 0, 0, 0, 0, 0, 0, 0]);
        a.bus_id = Some("p".into());
        let mut b = dummy(S, 256, vec![2, 0, 0, 0, 0, 0, 0, 0]);
        b.bus_id = Some("c".into());
        let mut c2 = dummy(2 * S, 256, vec![3, 0, 0, 0, 0, 0, 0, 0]);
        c2.bus_id = Some("p".into());
        store.append(a);
        store.append(b);
        store.append(c2);
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());
        let on_p = cache.slice(Some("p"), 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(
            on_p.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![1.0, 3.0]
        );
        let on_c = cache.slice(Some("c"), 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(on_c.iter().map(|p| p.value).collect::<Vec<_>>(), vec![2.0]);
        // Legacy "any bus" path: takes every frame regardless of tag.
        let any = cache.slice(None, 256, false, "X", 0.0, 10.0, 0, &store, dbs);
        assert_eq!(
            any.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![1.0, 2.0, 3.0]
        );
    }

    /// A 16-bit LE value packed into the low two payload bytes — the
    /// `X` signal of `TEST_DBC` (`0|16@1+`). Lets the pyramid tests drive
    /// specific decoded values, including a spike.
    fn val_frame(ts_ns: u64, v: u16) -> RawTraceFrame {
        let [b0, b1] = v.to_le_bytes();
        dummy(ts_ns, 256, vec![b0, b1, 0, 0, 0, 0, 0, 0])
    }

    #[test]
    #[allow(clippy::cast_possible_truncation)]
    fn fit_data_over_large_capture_returns_bounded_points() {
        // Far more samples than the canvas budget: a "fit data" serve
        // must read a coarse pyramid level and return O(max_points), not
        // re-materialize the whole raw series.
        let store = TraceStore::new();
        let n = 50_000u64;
        for i in 0..n {
            store.append(val_frame(i * S, (i % 1000) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        let max_points = 200;
        let fit = cache.slice(
            None,
            256,
            false,
            "X",
            f64::MIN,
            f64::MAX,
            max_points,
            &store,
            dbs,
        );
        // decimate_min_max bounds output to 2*max_points + 2.
        assert!(
            fit.len() <= 2 * max_points + 2,
            "fit returned {} points, expected ≤ {}",
            fit.len(),
            2 * max_points + 2,
        );
        // And far fewer than the raw series — the whole point.
        assert!(fit.len() < n as usize / 10);
    }

    #[test]
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    fn decimation_preserves_spikes() {
        // One extreme sample buried in a flat series must survive a
        // coarse fit-data serve — per-bucket min/max keeps the argmax.
        let store = TraceStore::new();
        let n = 20_000u64;
        let spike_at = 12_345u64;
        for i in 0..n {
            let v = if i == spike_at { 60_000 } else { 1 };
            store.append(val_frame(i * S, v));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        let fit = cache.slice(None, 256, false, "X", f64::MIN, f64::MAX, 100, &store, dbs);
        assert!(
            fit.iter().any(|p| (p.value - 60_000.0).abs() < 0.5),
            "spike (60000) lost during decimation; got max {:?}",
            fit.iter().map(|p| p.value).fold(f64::MIN, f64::max),
        );
        // The spike's timestamp is preserved too (not snapped to a bucket
        // edge): its bucket's argmax is the spike sample itself.
        assert!(fit
            .iter()
            .any(|p| (p.t_seconds - (spike_at * S) as f64 / 1e9).abs() < 0.5),);
    }

    #[test]
    #[allow(clippy::cast_possible_truncation)]
    fn zoom_in_reads_a_finer_level_than_fit_data() {
        // A narrow window over the same capture should serve more detail
        // (finer level) than the whole-capture fit — the level choice is
        // window-relative, not capture-relative.
        let store = TraceStore::new();
        let n = 40_000u64;
        for i in 0..n {
            store.append(val_frame(i * S, (i % 500) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        let max_points = 100;
        // Whole capture.
        let fit = cache.slice(
            None,
            256,
            false,
            "X",
            f64::MIN,
            f64::MAX,
            max_points,
            &store,
            dbs,
        );
        // A 500-sample-wide window (well under the level-0 count but over
        // max_points): served from a fine level, so every in-window raw
        // sample is representable.
        let from = 1000.0;
        let to = 1500.0;
        let zoom = cache.slice(None, 256, false, "X", from, to, max_points, &store, dbs);
        // Both honour the budget…
        assert!(fit.len() <= 2 * max_points + 2);
        assert!(zoom.len() <= 2 * max_points + 2);
        // …and the zoomed window's samples all fall in range (plus the ±2
        // boundary), confirming it's a window slice, not the whole series.
        let in_range = zoom
            .iter()
            .filter(|p| p.t_seconds >= from && p.t_seconds < to)
            .count();
        assert!(in_range > 0 && in_range <= 504);
    }

    #[test]
    fn pyramid_levels_spill_to_disk_and_clear_wipes_them() {
        // Enough samples to fold at least one higher level (200 / 8 = 25
        // level-1 points), so more than level 0 lands on disk.
        let store = TraceStore::new();
        for i in 0..200u64 {
            store.append(val_frame(i * S, (i % 50) as u16));
        }
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let tmp = TempDir::new().unwrap();
        let cache = SignalCacheStore::new(tmp.path());

        // Serving catches the pyramid up; its level files land under root.
        let _ = cache.slice(None, 256, false, "X", 0.0, 1000.0, 100, &store, dbs);
        let names: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            names.iter().any(|n| n.contains(".l0.")),
            "expected a level-0 segment file, got {names:?}",
        );
        assert!(
            names.iter().any(|n| n.contains(".l1.")),
            "expected a folded level-1 segment file, got {names:?}",
        );

        // Clear drops the caches (unmapping) and wipes the files.
        cache.clear();
        let after = std::fs::read_dir(tmp.path()).unwrap().flatten().count();
        assert_eq!(after, 0, "clear must wipe the pyramid files");

        // A subsequent serve rebuilds the pyramid from the raw store.
        let rebuilt = cache.slice(None, 256, false, "X", 0.0, 1000.0, 0, &store, dbs);
        assert_eq!(rebuilt.len(), 200);
    }

    #[test]
    fn serve_skips_an_evicted_pyramid_front_without_panicking() {
        // The evicted-read contract for the signal cache (ADR 0002): once a
        // pyramid level is front-trimmed to honor the scratch cap, the serve
        // path must read only the live tail and never touch a slot below the
        // level's low-water mark. (Step 6d raises the mark when it drops the
        // segment files; here we raise it directly to assert the read path
        // already tolerates it.)
        let dir = TempDir::new().unwrap();
        let mut cache = SignalCache::new(dir.path(), "sig");
        for i in 0..100u32 {
            cache.levels[0].push(f64::from(i), f64::from(i));
        }
        cache.levels[0].evict_below(40); // drop the oldest 40 (t = 0..40)
        assert_eq!(cache.levels[0].first_slot(), 40);

        // A whole-span serve returns only the live tail, in order, no panic.
        let pts = cache.window(0.0, 1000.0, 0);
        assert_eq!(pts.len(), 60);
        assert_eq!(pts.first().map(|p| p.t_seconds), Some(40.0));
        assert_eq!(pts.last().map(|p| p.t_seconds), Some(99.0));
        // A window straddling the floor never reads below it (the ±2
        // boundary widening clamps to the mark, not to slot 38/39).
        let straddle = cache.window(0.0, 50.0, 0);
        assert!(straddle.iter().all(|p| p.t_seconds >= 40.0));
        // A fully-evicted level serves empty rather than reading a dead slot.
        cache.levels[0].evict_below(100);
        assert!(cache.window(0.0, 1000.0, 0).is_empty());
    }

    #[test]
    fn evict_below_trims_the_pyramid_by_time_and_reclaims_disk() {
        // 6d: front-trim the whole pyramid to a truncation timestamp — every
        // level drops the points (and leading segment files) older than it,
        // keeping the serve aligned with the raw store's live window.
        let dir = TempDir::new().unwrap();
        let mut cache = SignalCache::new(dir.path(), "0x100.sig");
        for i in 0..200u32 {
            cache.levels[0].push(f64::from(i), f64::from(i)); // t = value = i seconds
        }
        cache.fold(); // build the higher levels
        let before = std::fs::read_dir(dir.path()).unwrap().count();
        cache.evict_below(100.0);
        assert_eq!(
            cache.levels[0].first_slot(),
            100,
            "level-0 floor rose to t=100"
        );
        let pts = cache.window(0.0, 200.0, 0);
        assert!(!pts.is_empty());
        assert!(
            pts.iter().all(|p| p.t_seconds >= 100.0),
            "no point below the truncation time survives",
        );
        let after = std::fs::read_dir(dir.path()).unwrap().count();
        assert!(after < before, "pyramid disk reclaimed: {after} < {before}");
    }
}
