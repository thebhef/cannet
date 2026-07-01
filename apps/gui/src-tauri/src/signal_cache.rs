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
//! Total RAM is still `O(total matches per signal)` — the pyramid bounds
//! *serve cost*, not residency; disk-backing level 0 (DS-7's pyramids in
//! `current/`) is the residency bound and lands with the live switchover.
//! Caches are cleared by [`SignalCacheStore::clear`] on
//! `clear_trace_store`.
//!
//! Concurrency: one global mutex around the (small) `HashMap`. The
//! catch-up itself doesn't hold the trace-store lock beyond
//! `matching_frames_indexed`'s clone — decoding runs off-lock, so the
//! pump isn't starved by long catch-ups.

use std::collections::HashMap;
use std::sync::Mutex;

use cannet_dbc::Database;

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
    /// Resolution pyramid. `levels[0]` is the raw decoded series in
    /// capture (frame-index) order; `levels[n]` (n ≥ 1) holds, for each
    /// bucket of [`PYRAMID_BRANCH`] consecutive `levels[n-1]` points,
    /// that bucket's min- and max-value points in time order. Every
    /// level is non-decreasing in `t_seconds`, so the serve path
    /// binary-searches each by `t_seconds`.
    levels: Vec<Vec<SamplePoint>>,
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
    fn new() -> Self {
        Self {
            levels: vec![Vec::new()],
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
                    self.levels[0].push(point);
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
                self.levels.push(Vec::new());
                self.folded.push(0);
            }
            for b in 0..complete {
                let s = start + b * PYRAMID_BRANCH;
                // Scope the immutable borrow of `levels[src]` so the
                // `levels[src + 1]` push below can mutably borrow `levels`
                // (SamplePoint is Copy, so the extrema are owned copies).
                let (pmin, pmax) = {
                    let bucket = &self.levels[src][s..s + PYRAMID_BRANCH];
                    let mut lo = 0;
                    let mut hi = 0;
                    for (i, p) in bucket.iter().enumerate() {
                        if p.value < bucket[lo].value {
                            lo = i;
                        }
                        if p.value > bucket[hi].value {
                            hi = i;
                        }
                    }
                    // Emit in time (index) order; collapse to one when the
                    // bucket's min and max are the same point (flat bucket).
                    let (a, c) = (lo.min(hi), lo.max(hi));
                    (bucket[a], (a != c).then(|| bucket[c]))
                };
                self.levels[src + 1].push(pmin);
                if let Some(pmax) = pmax {
                    self.levels[src + 1].push(pmax);
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
        if self.levels[0].is_empty() {
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
}

/// Count of `level` points whose `t_seconds` lies in `[from, to)`.
/// `level` is non-decreasing in `t_seconds`, so this is two binary
/// searches.
fn window_count(level: &[SamplePoint], from: f64, to: f64) -> usize {
    let lo = level.partition_point(|p| p.t_seconds < from);
    let hi = level.partition_point(|p| p.t_seconds < to);
    hi - lo
}

/// Slice `level` to `[from, to)`, widened by two boundary points on each
/// side. The extra points give a line renderer a segment running off each
/// range edge, so a consumer drawing the series doesn't go blank or end a
/// bin early at the range boundary (see [`SignalCacheStore::slice`]).
fn window_slice(level: &[SamplePoint], from: f64, to: f64) -> Vec<SamplePoint> {
    let lo = level.partition_point(|p| p.t_seconds < from);
    let hi = level.partition_point(|p| p.t_seconds < to);
    let lo_inclusive = lo.saturating_sub(2);
    let hi_inclusive = std::cmp::min(level.len(), hi.saturating_add(2));
    level[lo_inclusive..hi_inclusive].to_vec()
}

/// Cache key — one bucket per `(bus, message, signal)` triple, so
/// the same arbitration id on two different buses (with different
/// DBC scopes) decodes into two independent series. `bus_id = None`
/// is the legacy "any bus" path: it matches every frame regardless
/// of its bus tag, used by old plot panels that pre-date per-bus
/// signal binding.
type SignalKey = (Option<String>, u32, bool, String);

/// Process-wide collection of per-signal caches.
pub struct SignalCacheStore {
    caches: Mutex<HashMap<SignalKey, SignalCache>>,
}

impl SignalCacheStore {
    pub fn new() -> Self {
        Self {
            caches: Mutex::new(HashMap::new()),
        }
    }

    /// Drop every cached series — call on `clear_trace_store` (the
    /// frame indices and samples no longer correspond to anything).
    pub fn clear(&self) {
        *self.caches.lock().expect("signal cache mutex poisoned") = HashMap::new();
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
        let cache = caches.entry(key).or_insert_with(SignalCache::new);

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
        let cache = caches.entry(key).or_insert_with(SignalCache::new);
        cache.catch_up(bus_id, message_id, extended, signal_name, store, dbs);
        cache.extent()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace_store::RawTraceFrame;
    use cannet_core::{CanFramePayload, Direction};

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
        let cache = SignalCacheStore::new();

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
        let cache = SignalCacheStore::new();

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
        let cache = SignalCacheStore::new();
        // Unknown id and unknown signal both have no decoded samples.
        assert!(cache.min_max(None, 999, false, "X", &store, dbs).is_none());
        assert!(cache.min_max(None, 256, false, "Nope", &store, dbs).is_none());
    }

    #[test]
    fn unknown_signal_returns_empty_and_doesnt_panic() {
        let store = TraceStore::new();
        store.append(dummy(0, 256, vec![0; 8]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let cache = SignalCacheStore::new();
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
        let cache = SignalCacheStore::new();
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
        let cache = SignalCacheStore::new();

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
        let cache = SignalCacheStore::new();

        let fit = cache.slice(None, 256, false, "X", f64::MIN, f64::MAX, 100, &store, dbs);
        assert!(
            fit.iter().any(|p| (p.value - 60_000.0).abs() < 0.5),
            "spike (60000) lost during decimation; got max {:?}",
            fit.iter().map(|p| p.value).fold(f64::MIN, f64::max),
        );
        // The spike's timestamp is preserved too (not snapped to a bucket
        // edge): its bucket's argmax is the spike sample itself.
        assert!(
            fit.iter()
                .any(|p| (p.t_seconds - (spike_at * S) as f64 / 1e9).abs() < 0.5),
        );
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
        let cache = SignalCacheStore::new();

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
}
