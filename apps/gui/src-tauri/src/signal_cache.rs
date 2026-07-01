//! Per-signal cache of decoded sample points, extended incrementally
//! as the trace store grows so `sample_signals` doesn't re-decode the
//! same matching frames on every call.
//!
//! Each plotted signal gets its own [`SignalCache`]: a vector of
//! decoded samples in capture order, plus the next trace-store frame
//! index to scan from. A call to [`SignalCacheStore::slice`] catches
//! the cache up to the store's current tip (decoding any new matching
//! frames against the loaded DBCs) and then returns just the sample
//! slice within a requested `[from_seconds, to_seconds)` window via
//! binary search on the samples' `t_seconds`.
//!
//! Coupled with the existing per-id index in [`TraceStore::by_id`],
//! catch-up is `O(Σ new matches)`: at high rate the per-tick work
//! is bounded by how much capture arrived since the last call, not by
//! the total capture length — which is the whole point. Memory grows
//! `O(total matches per signal)`; for now we accept that, with the
//! eventual bound (a min/max decimation tier behind the raw recent
//! window) is deferred. Caches are cleared by
//! [`SignalCacheStore::clear`] on `clear_trace_store`.
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

/// One signal's decoded samples in capture (frame-index) order, plus
/// the next trace-store frame index to scan from on the next catch-up.
struct SignalCache {
    /// Decoded samples in capture (frame-index) order. The slice path
    /// binary-searches on `samples[i].t_seconds`.
    samples: Vec<SamplePoint>,
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
            samples: Vec::new(),
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
                    self.samples.push(point);
                    break;
                }
            }
        }
        self.next_index = store_len;
    }
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
    /// then return the cached samples whose `t_seconds` lies in
    /// `[from_seconds, to_seconds)`. Empty if no DBC decodes the signal
    /// or no matching frames have been seen yet.
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
    /// backlog. Loaded-DBC iteration mirrors the rest of the host's
    /// "first DBC that decodes wins" semantics. `bus_id` scopes the
    /// catch-up to frames tagged with that bus; pass `None` for the
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

        if cache.samples.is_empty() {
            return Vec::new();
        }
        let lo = cache
            .samples
            .partition_point(|p| p.t_seconds < from_seconds);
        let hi = cache.samples.partition_point(|p| p.t_seconds < to_seconds);
        // Include two boundary samples on each side of the requested
        // range. One was enough in principle (uPlot will draw the line
        // segment from the off-canvas point to the first in-canvas one
        // and clip at the edge), but in practice users have reported
        // gaps near the left/right edges at zoom-in — widening to 2
        // is essentially free and gives the renderer more line to
        // anchor against.
        let lo_inclusive = lo.saturating_sub(2);
        let hi_inclusive = std::cmp::min(cache.samples.len(), hi.saturating_add(2));
        cache.samples[lo_inclusive..hi_inclusive].to_vec()
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

        // Full time range — all four id-256 samples.
        let all = cache.slice(None, 256, false, "X", 0.0, 10.0, &store, dbs);
        assert_eq!(
            all.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );

        // Narrow time range [2.5, 4.5): only the id-256 sample at t = 3
        // is in range. The ±2 boundary widening also pulls in samples
        // at t = 0 / 2 (just before) and t = 5 (just after), giving
        // uPlot the last-known-coming-in value and the next-going-out
        // value to draw a line across.
        let mid = cache.slice(None, 256, false, "X", 2.5, 4.5, &store, dbs);
        assert_eq!(
            mid.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );

        // Very narrow zoom that contains zero matches: the slice still
        // returns the boundary samples on each side, so the plot draws
        // a line across the canvas instead of going blank.
        let narrow = cache.slice(None, 256, false, "X", 0.5, 1.5, &store, dbs);
        assert_eq!(
            narrow.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );

        // Append a new sample — catch-up extends the cached vector.
        store.append(dummy(6 * S, 256, vec![5, 0, 0, 0, 0, 0, 0, 0]));
        let all2 = cache.slice(None, 256, false, "X", 0.0, 10.0, &store, dbs);
        assert_eq!(
            all2.iter().map(|p| p.value as u32).collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );

        // Clear drops the cache; the next slice rebuilds it.
        cache.clear();
        let after = cache.slice(None, 256, false, "X", 0.0, 10.0, &store, dbs);
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
        let nope = cache.slice(None, 256, false, "Nope", 0.0, 1.0, &store, dbs);
        assert!(nope.is_empty());
        let no_id = cache.slice(None, 42, false, "X", 0.0, 1.0, &store, dbs);
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
        let on_p = cache.slice(Some("p"), 256, false, "X", 0.0, 10.0, &store, dbs);
        assert_eq!(
            on_p.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![1.0, 3.0]
        );
        let on_c = cache.slice(Some("c"), 256, false, "X", 0.0, 10.0, &store, dbs);
        assert_eq!(on_c.iter().map(|p| p.value).collect::<Vec<_>>(), vec![2.0]);
        // Legacy "any bus" path: takes every frame regardless of tag.
        let any = cache.slice(None, 256, false, "X", 0.0, 10.0, &store, dbs);
        assert_eq!(
            any.iter().map(|p| p.value).collect::<Vec<_>>(),
            vec![1.0, 2.0, 3.0]
        );
    }
}
