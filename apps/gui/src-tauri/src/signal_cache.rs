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
//! window) tracked in `plans/backlog.md`. Caches are cleared by
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
/// the next trace-store frame index to scan from on the next catch-up,
/// plus the running min/max of every decoded value seen since the cache
/// was created. The frontend uses the running extrema to drive its y-
/// axis auto-normalisation, which under a sliding history buffer needs
/// to reflect the full capture's peak-to-peak rather than what happens
/// to still be in the visible window — letting the JS side recompute
/// extrema from the slice it just received made the y-axis "shrink
/// back" whenever a peak scrolled off-screen.
struct SignalCache {
    /// Decoded samples in capture (frame-index) order. The slice path
    /// binary-searches on `samples[i].t_seconds`.
    samples: Vec<SamplePoint>,
    /// Next trace-store frame index to start the next catch-up scan
    /// from. Advances to `TraceStore::len()` after each catch-up.
    next_index: usize,
    /// Running min of every decoded value. `None` until the first
    /// matching frame decodes successfully.
    value_lo: Option<f64>,
    /// Running max — same lifecycle as `value_lo`.
    value_hi: Option<f64>,
}

impl SignalCache {
    fn new() -> Self {
        Self { samples: Vec::new(), next_index: 0, value_lo: None, value_hi: None }
    }

    /// Fold a freshly-decoded sample into the running extrema.
    fn observe(&mut self, value: f64) {
        if !value.is_finite() {
            return;
        }
        self.value_lo = Some(match self.value_lo {
            Some(lo) if lo <= value => lo,
            _ => value,
        });
        self.value_hi = Some(match self.value_hi {
            Some(hi) if hi >= value => hi,
            _ => value,
        });
    }
}

/// One signal's slice plus the running extrema across the full capture
/// (not just the slice). Frontend uses the extrema for auto-norm so the
/// y-axis only widens when the *whole capture's* min/max grows, never
/// shrinks when a peak scrolls off-screen.
pub struct SignalSlice {
    pub samples: Vec<SamplePoint>,
    pub value_lo: Option<f64>,
    pub value_hi: Option<f64>,
}

/// Process-wide collection of per-signal caches.
pub struct SignalCacheStore {
    caches: Mutex<HashMap<(u32, bool, String), SignalCache>>,
}

impl SignalCacheStore {
    pub fn new() -> Self {
        Self { caches: Mutex::new(HashMap::new()) }
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
    /// "first DBC that decodes wins" semantics.
    #[allow(clippy::too_many_arguments)]
    pub fn slice(
        &self,
        message_id: u32,
        extended: bool,
        signal_name: &str,
        from_seconds: f64,
        to_seconds: f64,
        store: &TraceStore,
        dbs: &[&Database],
    ) -> SignalSlice {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        let key = (message_id, extended, signal_name.to_string());
        let cache = caches.entry(key).or_insert_with(SignalCache::new);

        // Catch up: decode any matching frames in `[next_index, len)`.
        let store_len = store.len();
        if cache.next_index < store_len {
            let new_matches =
                store.matching_frames_indexed(message_id, extended, cache.next_index, store_len);
            for (_idx, frame) in new_matches {
                // Try each loaded DBC in priority order, first decode
                // wins (matches `sample_signals`' existing semantics).
                for db in dbs {
                    let decoded = signal_sampler::sample_signal(
                        std::slice::from_ref(&frame),
                        db,
                        message_id,
                        extended,
                        signal_name,
                    );
                    if let Some(point) = decoded.into_iter().next() {
                        cache.observe(point.value);
                        cache.samples.push(point);
                        break;
                    }
                }
            }
            cache.next_index = store_len;
        }

        let value_lo = cache.value_lo;
        let value_hi = cache.value_hi;
        if cache.samples.is_empty() {
            return SignalSlice { samples: Vec::new(), value_lo, value_hi };
        }
        let lo = cache.samples.partition_point(|p| p.t_seconds < from_seconds);
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
        SignalSlice {
            samples: cache.samples[lo_inclusive..hi_inclusive].to_vec(),
            value_lo,
            value_hi,
        }
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

        // Full time range — all four id-256 samples. Extrema span the
        // full set of decoded values (1..4).
        let all = cache.slice(256, false, "X", 0.0, 10.0, &store, dbs);
        assert_eq!(all.samples.iter().map(|p| p.value as u32).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        assert_eq!(all.value_lo, Some(1.0));
        assert_eq!(all.value_hi, Some(4.0));

        // Time range [2.5, 4.5): only the id-256 sample at t = 3 is in
        // range. The ±2 boundary widening also pulls in the samples at
        // t = 0 / 2 (just before) and t = 5 (just after), giving uPlot
        // the last-known-coming-in value and the next-going-out value
        // to draw a line across. Extrema are *full-capture*, so they
        // still report the whole observed range — that's the point:
        // they don't shrink when the user zooms into a quiet section.
        let mid = cache.slice(256, false, "X", 2.5, 4.5, &store, dbs);
        assert_eq!(mid.samples.iter().map(|p| p.value as u32).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        assert_eq!(mid.value_lo, Some(1.0));
        assert_eq!(mid.value_hi, Some(4.0));

        // Very narrow zoom that contains zero matches: the slice still
        // returns the boundary samples on each side, so the plot draws
        // a line across the canvas instead of going blank.
        let narrow = cache.slice(256, false, "X", 0.5, 1.5, &store, dbs);
        assert_eq!(narrow.samples.iter().map(|p| p.value as u32).collect::<Vec<_>>(), vec![1, 2, 3]);

        // Append a new extreme — catch-up extends both the sample
        // vector and the running extrema in one pass.
        store.append(dummy(6 * S, 256, vec![5, 0, 0, 0, 0, 0, 0, 0]));
        let all2 = cache.slice(256, false, "X", 0.0, 10.0, &store, dbs);
        assert_eq!(all2.samples.iter().map(|p| p.value as u32).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
        assert_eq!(all2.value_hi, Some(5.0));

        // Clear drops the cache; the next slice rebuilds it.
        cache.clear();
        let after = cache.slice(256, false, "X", 0.0, 10.0, &store, dbs);
        assert_eq!(after.samples.len(), 5);
        assert_eq!(after.value_lo, Some(1.0));
        assert_eq!(after.value_hi, Some(5.0));
    }

    #[test]
    fn unknown_signal_returns_empty_and_doesnt_panic() {
        let store = TraceStore::new();
        store.append(dummy(0, 256, vec![0; 8]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let cache = SignalCacheStore::new();
        let nope = cache.slice(256, false, "Nope", 0.0, 1.0, &store, dbs);
        assert!(nope.samples.is_empty());
        assert_eq!(nope.value_lo, None);
        let no_id = cache.slice(42, false, "X", 0.0, 1.0, &store, dbs);
        assert!(no_id.samples.is_empty());
        assert_eq!(no_id.value_lo, None);
    }
}
