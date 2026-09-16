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
//!
//! ## The fold is budgeted, driven by the flush cadence, and persisted
//!
//! A delta is only small if something folds it regularly. Folded on
//! query alone, a session that never anchored an event owed the whole
//! capture to its first query, and a *reopened* capture owed all of it
//! to every launch: 546 M rows of metadata walked under the store lock —
//! 14 GB paged in, 40–80 s with the window unable to paint. So the
//! flush tick folds what arrived since the last tick, at most
//! [`FOLD_BLOCKS_PER_HOLD`] blocks per hold of the lock, and persists
//! the folded blocks to [`ANCHOR_FILE`] beside the raw manifest (ADR
//! 0002 DS-7). A reopen reads them back, so its index is current to the
//! last flush; a query folds what is left, again a bounded slice per
//! hold ([`super::TraceStore::frame_index_at_ns`]), so a scratch written
//! before the file existed catches up without ever stalling ingest on
//! one hold. The file is append-only in the common case — a prefix
//! maximum never changes once folded — and rewritten whole only when
//! the index re-bases.

use std::io::Write;
use std::path::Path;

use cannet_spill::RawStore;

/// Rows per sampled prefix-maximum. The query scans at most this many
/// rows after the binary search, so it trades index size against scan
/// length: at the measured ~12.5 ns/row a block costs ~13 µs to walk,
/// and the index costs 8 bytes per block.
pub(super) const BLOCK: usize = 1024;

/// Blocks one hold of the store lock may fold — 2 M rows, about 25 ms
/// when their metadata is in the page cache and a few hundred ms when
/// it has to come off the disk (26 B a row, ~52 MB). Small enough that
/// live ingest never queues behind a fold for long; large enough that a
/// capture whose scratch predates the persisted index catches up in a
/// few hundred flush ticks.
pub(super) const FOLD_BLOCKS_PER_HOLD: usize = 2_048;

/// The persisted index in the scratch directory: `base` as a
/// little-endian `u64`, then one `u64` per folded block. See the module
/// docs.
pub(super) const ANCHOR_FILE: &str = "anchor.bin";

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
    /// Blocks [`ANCHOR_FILE`] holds, and the base it holds them from.
    /// `None` when nothing is known to be on disk (a fresh index, or one
    /// whose file was cut back on load), which is what makes the next
    /// [`Self::persist`] write the file whole.
    persisted_base: Option<usize>,
    persisted: usize,
}

impl TsAnchorIndex {
    /// The index a prior session persisted under `dir`, cut back to the
    /// `[first, len)` the reopened store actually holds — or an empty
    /// index when there is no usable file.
    ///
    /// The file is written after the raw manifest, so a crash between the
    /// two leaves it describing rows the store came back without; those
    /// trailing blocks are dropped, and the ones over surviving rows are
    /// kept, since a prefix maximum depends on nothing after it. A file
    /// whose base sits above the low-water mark cannot be this store's
    /// (the base only ever follows the mark), and is ignored whole. A
    /// partial trailing entry — an append cut short — is not a block.
    pub(super) fn load(dir: &Path, first: usize, len: usize) -> Self {
        let Ok(bytes) = std::fs::read(dir.join(ANCHOR_FILE)) else {
            return Self::default();
        };
        let mut words = bytes
            .chunks_exact(8)
            .map(|c| u64::from_le_bytes(c.try_into().expect("chunks_exact yields 8 bytes")));
        let Some(base) = words.next().and_then(|b| usize::try_from(b).ok()) else {
            return Self::default();
        };
        if base > first || first > len {
            return Self::default();
        }
        let block_max: Vec<u64> = words.take((len - base) / BLOCK).collect();
        let n = block_max.len();
        let on_disk = bytes.len() / 8 - 1;
        Self {
            base,
            through: base + n * BLOCK,
            block_max,
            persisted_base: (on_disk == n).then_some(base),
            persisted: n,
        }
    }

    /// Write what [`Self::fold`] has added since the last call to
    /// [`ANCHOR_FILE`] under `dir`: an append of the new blocks, or the
    /// whole file again if the index has re-based (or the file is not
    /// what this index last wrote). Written through a temp file and a
    /// rename when whole, so a crash never leaves a half-written base.
    ///
    /// # Errors
    /// The I/O error, leaving the on-disk state as it was so the next
    /// call retries the same delta.
    pub(super) fn persist(&mut self, dir: &Path) -> std::io::Result<()> {
        let path = dir.join(ANCHOR_FILE);
        let n = self.block_max.len();
        let whole = self.persisted_base != Some(self.base) || n < self.persisted || !path.is_file();
        if whole {
            let mut bytes = Vec::with_capacity(8 * (n + 1));
            bytes.extend_from_slice(&(self.base as u64).to_le_bytes());
            bytes.extend(self.block_max.iter().flat_map(|m| m.to_le_bytes()));
            let tmp = path.with_extension("bin.tmp");
            std::fs::write(&tmp, &bytes)?;
            std::fs::rename(&tmp, &path)?;
        } else if n > self.persisted {
            let bytes: Vec<u8> = self.block_max[self.persisted..]
                .iter()
                .flat_map(|m| m.to_le_bytes())
                .collect();
            std::fs::OpenOptions::new()
                .append(true)
                .open(&path)?
                .write_all(&bytes)?;
        } else {
            return Ok(());
        }
        self.persisted_base = Some(self.base);
        self.persisted = n;
        Ok(())
    }

    /// Folded blocks — how much of the capture the index covers, for the
    /// restore breakdown.
    pub(super) fn blocks(&self) -> usize {
        self.block_max.len()
    }

    #[cfg(test)]
    pub(super) fn through(&self) -> usize {
        self.through
    }

    /// Bring the index current against `raw`, then return the absolute
    /// index of the first row in `[first_index, len)` whose timestamp is
    /// `>= ts`, or `len` if every retained row is older.
    pub(super) fn frame_index_at_ns(&mut self, raw: &dyn RawStore, ts: u64) -> usize {
        let (first, len) = (raw.first_index(), raw.len());
        self.fold(raw, usize::MAX);
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

    /// Fold up to `max_blocks` whole blocks that have appeared since the
    /// last call, and say whether the index is now current — every whole
    /// block folded, the uncovered tail under one block long. `false`
    /// means the budget ran out first; the next call resumes where this
    /// one stopped.
    ///
    /// Two things invalidate what is already folded, and both re-base
    /// rather than re-walk: the store shrinking (a session start or a
    /// scratch reopen replaced the capture), and eviction advancing past
    /// the folded region (the rows a fold would need are gone). Eviction
    /// *within* the folded region needs nothing — a stale maximum only
    /// names a block too early, which the query's clamp absorbs.
    pub(super) fn fold(&mut self, raw: &dyn RawStore, max_blocks: usize) -> bool {
        let (first, len) = (raw.first_index(), raw.len());
        if self.through > len || self.through < first {
            self.base = first;
            self.through = first;
            self.block_max.clear();
        }
        let mut budget = max_blocks;
        while self.through + BLOCK <= len {
            if budget == 0 {
                return false;
            }
            budget -= 1;
            let mut max = self.block_max.last().copied().unwrap_or(0);
            for i in self.through..self.through + BLOCK {
                if let Some(row) = raw.frame_timestamps(i, i + 1).0 {
                    max = max.max(row);
                }
            }
            self.block_max.push(max);
            self.through += BLOCK;
        }
        true
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

    /// Append `rows` rows stamped after everything already in `raw`, with
    /// the same periodic dip as [`fill_dipping`].
    fn grow_dipping(raw: &mut dyn RawStore, rows: usize, step: u64) {
        let from = raw.len();
        for i in from..from + rows {
            let base = (i as u64 + 1) * step;
            raw.append(frame(if i % 7 == 6 { base - 3_000 } else { base }));
        }
    }

    #[test]
    fn a_budgeted_fold_stops_at_its_budget_and_finishes_on_a_later_call() {
        // The fold is what a flush tick and a query both drive, and
        // neither may hold the store lock for a whole capture's worth of
        // rows: a budget bounds one call, and the next call resumes where
        // it stopped. `true` means the index is current — the uncovered
        // tail is under one block.
        let mut raw = MemRawStore::new();
        fill_dipping(&mut raw, BLOCK * 5 + 3, 1_000, 7, 3_000);
        let mut idx = TsAnchorIndex::default();
        assert!(!idx.fold(&raw, 2), "two of five blocks is not current");
        assert_eq!(idx.through, BLOCK * 2);
        assert!(!idx.fold(&raw, 2));
        assert_eq!(idx.through, BLOCK * 4);
        assert!(idx.fold(&raw, 2), "the fifth block completes it");
        assert_eq!(idx.through, BLOCK * 5);
        assert!(idx.fold(&raw, 2), "nothing left to fold stays current");
        assert_matches_reference(&raw, &mut idx, &probes(BLOCK * 5 + 3, 1_000));
    }

    #[test]
    fn a_persisted_index_reopens_current_and_folds_only_the_delta() {
        // The whole point: a relaunch over a long capture must not walk
        // every row again. What was folded comes back off disk, and the
        // next fold covers only what was appended since.
        let dir = tempfile::tempdir().unwrap();
        let mut raw = MemRawStore::new();
        fill_dipping(&mut raw, BLOCK * 3 + 5, 1_000, 7, 3_000);
        let mut idx = TsAnchorIndex::default();
        idx.fold(&raw, usize::MAX);
        idx.persist(dir.path()).unwrap();

        let mut back = TsAnchorIndex::load(dir.path(), raw.first_index(), raw.len());
        assert_eq!(back.through, BLOCK * 3, "reopened current");
        assert_eq!(back.block_max, idx.block_max);
        assert_matches_reference(&raw, &mut back, &probes(BLOCK * 3 + 5, 1_000));

        grow_dipping(&mut raw, BLOCK * 2, 1_000);
        assert!(back.fold(&raw, 2), "two new blocks is the whole delta");
        assert_eq!(back.through, BLOCK * 5);
        assert_matches_reference(&raw, &mut back, &probes(BLOCK * 5 + 5, 1_000));
    }

    #[test]
    fn a_persisted_index_appends_its_growth_and_rewrites_on_a_rebase() {
        // Prefix maxima never change once folded, so growth is an append
        // of the new blocks — a six-day capture at the flush cadence must
        // not rewrite a multi-megabyte file every tick. A rebase (the
        // capture replaced under the index, or the low-water mark passing
        // the fold) is the one case the file is written whole again.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ANCHOR_FILE);
        let mut raw = MemRawStore::new();
        fill_dipping(&mut raw, BLOCK * 2, 1_000, 7, 3_000);
        let mut idx = TsAnchorIndex::default();
        idx.fold(&raw, usize::MAX);
        idx.persist(dir.path()).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            8 * 3,
            "base + 2 blocks"
        );

        grow_dipping(&mut raw, BLOCK, 1_000);
        idx.fold(&raw, usize::MAX);
        idx.persist(dir.path()).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            8 * 4,
            "one block appended"
        );
        let back = TsAnchorIndex::load(dir.path(), raw.first_index(), raw.len());
        assert_eq!(
            (back.base, back.through, &back.block_max),
            (0, BLOCK * 3, &idx.block_max)
        );

        // Replace the capture with a shorter one: the index re-bases and
        // now holds fewer blocks than the file does.
        raw.clear();
        fill_dipping(&mut raw, BLOCK * 2 + 9, 500, 4, 900);
        idx.fold(&raw, usize::MAX);
        assert_eq!((idx.base, idx.block_max.len()), (0, 2), "rebased");
        idx.persist(dir.path()).unwrap();
        let back = TsAnchorIndex::load(dir.path(), raw.first_index(), raw.len());
        assert_eq!(
            (back.base, back.through, &back.block_max),
            (idx.base, idx.through, &idx.block_max)
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            8 * (1 + idx.block_max.len() as u64),
            "rewritten whole from the new base",
        );
    }

    #[test]
    fn a_persisted_index_is_cut_back_to_the_rows_that_survived() {
        // The anchor file is written after the raw manifest, so a crash
        // between the two leaves it describing rows the store came back
        // without. Those blocks are dropped; the ones over surviving rows
        // are still right, since a prefix max depends on nothing after it.
        let dir = tempfile::tempdir().unwrap();
        let mut raw = MemRawStore::new();
        fill_dipping(&mut raw, BLOCK * 3, 1_000, 7, 3_000);
        let mut idx = TsAnchorIndex::default();
        idx.fold(&raw, usize::MAX);
        idx.persist(dir.path()).unwrap();
        let back = TsAnchorIndex::load(dir.path(), 0, BLOCK * 2 + 10);
        assert_eq!(back.through, BLOCK * 2);
        assert_eq!(back.block_max, idx.block_max[..2]);
        // A file whose base sits above the low-water mark, or a file from
        // some other store, describes nothing this store can use.
        let stale = TsAnchorIndex::load(dir.path(), 0, 10);
        assert_eq!((stale.through, stale.block_max.len()), (0, 0));
        assert_eq!(TsAnchorIndex::load(dir.path(), 0, 0).through, 0);
    }

    #[test]
    fn a_torn_trailing_write_is_ignored_on_load() {
        // An append cut short by a crash leaves a partial entry at the
        // end; it is not a block and is not read as one.
        let dir = tempfile::tempdir().unwrap();
        let mut raw = MemRawStore::new();
        fill_dipping(&mut raw, BLOCK * 2, 1_000, 7, 3_000);
        let mut idx = TsAnchorIndex::default();
        idx.fold(&raw, usize::MAX);
        idx.persist(dir.path()).unwrap();
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(dir.path().join(ANCHOR_FILE))
                .unwrap();
            f.write_all(&[1, 2, 3]).unwrap();
        }
        let back = TsAnchorIndex::load(dir.path(), 0, raw.len());
        assert_eq!((back.through, &back.block_max), (BLOCK * 2, &idx.block_max));
        assert!(
            TsAnchorIndex::load(dir.path().join("nowhere").as_path(), 0, 5)
                .block_max
                .is_empty()
        );
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
