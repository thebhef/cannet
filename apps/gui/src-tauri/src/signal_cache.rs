//! Per-signal cache of decoded sample points, extended incrementally
//! as the trace store grows so `sample_signals` doesn't re-decode the
//! same matching frames on every call.
//!
//! Each plotted signal gets its own [`SignalCache`]: a parallel pair of
//! `(frame_index, SamplePoint)` vectors, plus the next trace-store
//! frame index to scan from. A call to [`SignalCacheStore::slice`]
//! catches the cache up to the store's current tip (decoding any new
//! matching frames against the loaded DBCs) and then returns just the
//! sample slice corresponding to a requested frame-index range via
//! binary search on the parallel index vector.
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

/// One signal's decoded samples + parallel frame indices, plus the
/// next trace-store frame index to scan from on the next catch-up.
struct SignalCache {
    /// Decoded samples in capture (frame-index) order.
    samples: Vec<SamplePoint>,
    /// `frame_indices[i]` is the trace-store frame index that produced
    /// `samples[i]`. Used to binary-search a frame-index range into a
    /// sample-index range.
    frame_indices: Vec<usize>,
    /// Next trace-store frame index to start the next catch-up scan
    /// from. Advances to `TraceStore::len()` after each catch-up.
    next_index: usize,
}

impl SignalCache {
    fn new() -> Self {
        Self {
            samples: Vec::new(),
            frame_indices: Vec::new(),
            next_index: 0,
        }
    }
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
    /// then return the cached samples whose frame index lies in
    /// `[from_frame, to_frame)`. Empty if no DBC decodes the signal or
    /// no matching frames have been seen yet.
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
        from_frame: usize,
        to_frame: usize,
        store: &TraceStore,
        dbs: &[&Database],
    ) -> Vec<SamplePoint> {
        let mut caches = self.caches.lock().expect("signal cache mutex poisoned");
        let key = (message_id, extended, signal_name.to_string());
        let cache = caches.entry(key).or_insert_with(SignalCache::new);

        // Catch up: decode any matching frames in `[next_index, len)`.
        let store_len = store.len();
        if cache.next_index < store_len {
            let new_matches =
                store.matching_frames_indexed(message_id, extended, cache.next_index, store_len);
            for (idx, frame) in new_matches {
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
                        cache.samples.push(point);
                        cache.frame_indices.push(idx);
                        break;
                    }
                }
            }
            cache.next_index = store_len;
        }

        if cache.samples.is_empty() {
            return Vec::new();
        }
        let lo = cache.frame_indices.partition_point(|&i| i < from_frame);
        let hi = cache.frame_indices.partition_point(|&i| i < to_frame);
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

    #[test]
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    fn slice_decodes_lazily_and_returns_only_the_requested_range() {
        let store = TraceStore::new();
        // Mix of id 256 (decodes via the DBC) and id 999 (doesn't).
        // Frames at store indices 0..6.
        store.append(dummy(0, 256, vec![1, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(1_000, 999, vec![0, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(2_000, 256, vec![2, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(3_000, 256, vec![3, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(4_000, 999, vec![0, 0, 0, 0, 0, 0, 0, 0]));
        store.append(dummy(5_000, 256, vec![4, 0, 0, 0, 0, 0, 0, 0]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let cache = SignalCacheStore::new();

        // Full window — all four id-256 samples.
        let all = cache.slice(256, false, "X", 0, 6, &store, dbs);
        assert_eq!(all.iter().map(|p| p.value as u32).collect::<Vec<_>>(), vec![1, 2, 3, 4]);

        // Narrower frame range [2, 5) — id-256 frames at idx 2 and 3
        // are *in* the range; the boundary-sample widening also
        // includes the id-256 frames at idx 0 (just before) and idx 5
        // (just after), giving uPlot the last-known-coming-in value
        // and the next-going-out value to draw a line across.
        let mid = cache.slice(256, false, "X", 2, 5, &store, dbs);
        assert_eq!(mid.iter().map(|p| p.value as u32).collect::<Vec<_>>(), vec![1, 2, 3, 4]);

        // Very narrow zoom that contains zero matches: the slice still
        // returns the boundary samples on each side, so the plot draws
        // a line across the canvas instead of going blank.
        let narrow = cache.slice(256, false, "X", 1, 2, &store, dbs);
        assert_eq!(narrow.iter().map(|p| p.value as u32).collect::<Vec<_>>(), vec![1, 2, 3]);

        // Append more — catch-up extends the cache, doesn't redecode
        // what's already there.
        store.append(dummy(6_000, 256, vec![5, 0, 0, 0, 0, 0, 0, 0]));
        let all2 = cache.slice(256, false, "X", 0, 7, &store, dbs);
        assert_eq!(all2.iter().map(|p| p.value as u32).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);

        // Clear drops the cache; the next slice rebuilds it.
        cache.clear();
        let after = cache.slice(256, false, "X", 0, 7, &store, dbs);
        assert_eq!(after.len(), 5);
    }

    #[test]
    fn unknown_signal_returns_empty_and_doesnt_panic() {
        let store = TraceStore::new();
        store.append(dummy(0, 256, vec![0; 8]));
        let db = load_dbc();
        let dbs: &[&Database] = &[&db];
        let cache = SignalCacheStore::new();
        assert!(cache.slice(256, false, "Nope", 0, 1, &store, dbs).is_empty());
        assert!(cache.slice(42, false, "X", 0, 1, &store, dbs).is_empty());
    }
}
