//! Time→index anchoring over a store that is *not* sorted by timestamp.
//!
//! The store holds frames in arrival order, and a multi-bus capture
//! interleaves deliveries, so the timestamp column dips below its own
//! running max and recovers routinely ([ADR 0024](../../../../docs/adr/0024-trace-like-view-timing.md)
//! measured ~1.1 s, several times a minute, on a 23-hour two-bus
//! capture). The anchor a timeline event needs
//! ([ADR 0035](../../../../docs/adr/0035-timeline-event-model.md)) is
//! *positional* in that stream: the first row at or after the event's
//! timestamp. A binary search over the timestamps cannot answer that —
//! it walks straight past an exact match sitting behind a dip.
//!
//! A forward scan answers it correctly, and is the reference every
//! alternative here is checked against, but it is `O(n)` on the serve
//! path with the append mutex held: measured ~12.5 ns/row, so 10 ms at
//! 1 M rows and 100 ms at 8 M, once per timeline event.
//!
//! ## The monotone sequence the search needs
//!
//! Let `M(i)` be the largest timestamp among rows `[0, i]`. `M` is
//! non-decreasing by construction however the timestamps arrive, and
//! `M(i) >= t` exactly when *some* row at or before `i` is at or after
//! `t`. So the first `i` with `M(i) >= t` **is** the first row with
//! `ts >= t` — the answer — and `M` is binary-searchable where the raw
//! timestamps are not.
//!
//! [`TsAnchorIndex`] stores `M` sampled at every [`BLOCK`]-th row, which
//! is enough to name the block the answer falls in; a scan of at most
//! `BLOCK` rows finishes the job. That is `8` bytes per `1024` rows —
//! 8 KB per million — and the fold is a delta over `[through, len)`,
//! never a re-walk, in the shape [`super::TraceStore::refresh_filter_index`]
//! already uses.

use cannet_spill::RawStore;

/// Rows per sampled prefix-maximum. The query scans at most this many
/// rows after the binary search, so it trades index size against scan
/// length: at the measured ~12.5 ns/row a block costs ~13 µs to walk,
/// and the index costs 8 bytes per block.
const BLOCK: usize = 1024;

/// Sampled prefix maxima of the store's timestamp column — the monotone
/// sequence a time→index lower bound needs when the column itself is not
/// monotone. See the module docs.
#[derive(Debug, Default)]
pub(super) struct TsAnchorIndex {
    /// Row where block `0` starts. Every row below it has been evicted,
    /// so none can be an answer.
    base: usize,
    /// Rows folded in: `[base, through)` is covered, and `through - base`
    /// is a whole number of blocks.
    through: usize,
    /// `block_max[j]` is the largest timestamp among rows
    /// `[base, base + (j + 1) * BLOCK)` — non-decreasing in `j`.
    block_max: Vec<u64>,
}

impl TsAnchorIndex {
    /// Bring the index current against `raw`, then return the absolute
    /// index of the first row in `[first_index, len)` whose timestamp is
    /// `>= ts`, or `len` if every retained row is older.
    pub(super) fn frame_index_at_ns(&mut self, raw: &dyn RawStore, ts: u64) -> usize {
        let (first, len) = (raw.first_index(), raw.len());
        self.refresh(raw, first, len);
        // The first covered block whose prefix max reaches `ts`. Every
        // row below that block's start is strictly older than `ts`
        // (that is what "prefix max" buys), so the answer is at or after
        // it. With no such block, every covered row is older and the
        // answer lies in the uncovered tail, which is under one block
        // long because `refresh` just folded every whole block.
        let block = self.block_max.partition_point(|&m| m < ts);
        let from = match self.block_max.len() {
            n if block < n => self.base + block * BLOCK,
            _ => self.through,
        };
        // Clamped to the low-water mark: a block's max can come from a
        // row that has since been evicted, which only ever names a block
        // too early — the scan below still returns the first *retained*
        // match.
        (from.max(first)..len)
            .find(|&i| {
                raw.frame_timestamps(i, i + 1)
                    .0
                    .is_some_and(|row| row >= ts)
            })
            .unwrap_or(len)
    }

    /// Fold every whole block that has appeared since the last call.
    ///
    /// Two things invalidate what is already folded, and both re-base
    /// rather than re-walk: the store shrinking (a session start or a
    /// scratch reopen replaced the capture), and eviction advancing past
    /// the folded region (the rows a fold would need are gone). Eviction
    /// *within* the folded region needs nothing — a stale maximum only
    /// names a block too early, which the query's clamp absorbs.
    fn refresh(&mut self, raw: &dyn RawStore, first: usize, len: usize) {
        if self.through > len || self.through < first {
            self.base = first;
            self.through = first;
            self.block_max.clear();
        }
        while self.through + BLOCK <= len {
            let mut max = self.block_max.last().copied().unwrap_or(0);
            for i in self.through..self.through + BLOCK {
                if let Some(row) = raw.frame_timestamps(i, i + 1).0 {
                    max = max.max(row);
                }
            }
            self.block_max.push(max);
            self.through += BLOCK;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_core::{CanFramePayload, Direction};
    use cannet_spill::{DiskConfig, DiskRawStore, MemRawStore, RawTraceFrame};

    fn frame(ts: u64) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: ts,
            channel: 0,
            id: 1,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(Vec::new()),
            bus_id: None,
        }
    }

    /// The reference implementation: the contract read literally off the
    /// stream the trace displays. Every answer the index gives is checked
    /// against this one.
    fn reference(raw: &dyn RawStore, ts: u64) -> usize {
        let len = raw.len();
        (raw.first_index()..len)
            .find(|&i| raw.frame_timestamps(i, i + 1).0.is_some_and(|t| t >= ts))
            .unwrap_or(len)
    }

    /// What the old implementation did: a lower bound over the raw
    /// timestamps. Used only as a **control**, to prove a fixture is
    /// actually non-monotonic enough to tell the two apart — agreeing
    /// with the reference is free over a fixture nothing could get wrong.
    fn plain_lower_bound(raw: &dyn RawStore, ts: u64) -> usize {
        let (mut lo, mut hi) = (raw.first_index(), raw.len());
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if raw.frame_timestamps(mid, mid + 1).0.unwrap_or(u64::MAX) < ts {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    /// A rising ramp that dips every `period` rows — the shape ADR 0024
    /// measured, scaled down. Row `i` is stamped `(i + 1) * step`, except
    /// that every `period`-th row drops `dip` below that.
    fn fill_dipping(raw: &mut dyn RawStore, rows: usize, step: u64, period: usize, dip: u64) {
        for i in 0..rows {
            let base = (i as u64 + 1) * step;
            let ts = if i % period == period - 1 {
                base.saturating_sub(dip)
            } else {
                base
            };
            raw.append(frame(ts));
        }
    }

    /// Every probe worth asking of a `rows`-row ramp: each row's own
    /// timestamp, the gaps either side of it, and both ends.
    fn probes(rows: usize, step: u64) -> Vec<u64> {
        let mut out = vec![0, u64::MAX];
        for i in 0..=rows {
            let base = (i as u64) * step;
            out.extend([base.saturating_sub(1), base, base + 1]);
        }
        out
    }

    /// Assert the index and the reference agree on every probe, and that
    /// the fixture could have told them apart.
    fn assert_matches_reference(raw: &dyn RawStore, idx: &mut TsAnchorIndex, probes: &[u64]) {
        for &ts in probes {
            assert_eq!(
                idx.frame_index_at_ns(raw, ts),
                reference(raw, ts),
                "probe {ts}",
            );
        }
        assert!(
            probes
                .iter()
                .any(|&ts| plain_lower_bound(raw, ts) != reference(raw, ts)),
            "control: the fixture must be one a plain binary search gets wrong",
        );
    }

    #[test]
    fn the_index_matches_the_reference_scan_over_a_dipping_store() {
        // Wider than one block, so the binary search actually runs.
        let rows = BLOCK * 4 + 37;
        let mut raw = MemRawStore::new();
        fill_dipping(&mut raw, rows, 1_000, 7, 3_000);
        assert_matches_reference(&raw, &mut TsAnchorIndex::default(), &probes(rows, 1_000));
    }

    #[test]
    fn the_index_matches_the_reference_scan_as_the_store_grows() {
        // The fold is a delta over `[through, len)`, so a store queried
        // repeatedly while it grows must answer what one queried only at
        // the end does.
        let mut raw = MemRawStore::new();
        let mut idx = TsAnchorIndex::default();
        for i in 0..(BLOCK * 3 + 11) {
            let base = (i as u64 + 1) * 1_000;
            raw.append(frame(if i % 5 == 4 {
                base.saturating_sub(2_500)
            } else {
                base
            }));
            if i % 97 == 0 {
                for ts in [0, base, base + 1, base.saturating_sub(1), u64::MAX] {
                    assert_eq!(idx.frame_index_at_ns(&raw, ts), reference(&raw, ts));
                }
            }
        }
        assert_matches_reference(&raw, &mut idx, &probes(BLOCK * 3 + 11, 1_000));
    }

    #[test]
    fn the_index_survives_eviction_advancing_the_low_water_mark() {
        // Eviction (ADR 0002 DS-8) front-trims whole meta segments, so
        // the mark lands mid-block: a fold that covered evicted rows must
        // still yield the first *retained* match, never one below the
        // mark and never one past the answer.
        let dir = tempfile::tempdir().unwrap();
        let cfg = DiskConfig {
            records_per_seg: 512,
            payload_seg_bytes: 4096,
            ring_capacity: 64,
        };
        let mut raw = DiskRawStore::with_config(dir.path(), cfg).unwrap();
        let rows = BLOCK * 4;
        fill_dipping(&mut raw, rows, 1_000, 7, 3_000);
        let mut idx = TsAnchorIndex::default();
        let probes = probes(rows, 1_000);
        assert_matches_reference(&raw, &mut idx, &probes);
        // Shed the oldest history under the same index, twice, so the
        // mark crosses a block boundary and then lands inside one.
        for _ in 0..2 {
            raw.evict_oldest_bytes(20_000);
            assert!(raw.first_index() > 0, "eviction must have advanced");
            assert_matches_reference(&raw, &mut idx, &probes);
        }
    }

    #[test]
    fn the_index_rebases_when_the_capture_shrinks_under_it() {
        // A session start empties the buffer. The store resets the index
        // explicitly, but the index also refuses to answer from a fold
        // that describes more rows than exist — the cheap half of the
        // guard, and the half that does not depend on a caller.
        let mut raw = MemRawStore::new();
        fill_dipping(&mut raw, BLOCK * 2, 1_000, 7, 3_000);
        let mut idx = TsAnchorIndex::default();
        assert_eq!(
            idx.frame_index_at_ns(&raw, 900_000),
            reference(&raw, 900_000)
        );
        raw.clear();
        fill_dipping(&mut raw, BLOCK + 5, 7, 4, 20);
        for ts in [0, 7, 8, 3_500, u64::MAX] {
            assert_eq!(
                idx.frame_index_at_ns(&raw, ts),
                reference(&raw, ts),
                "after the capture was replaced, ts {ts}",
            );
        }
    }
}
