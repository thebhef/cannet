//! Disk-backed append-only run of decoded sample points (ADR 0002 DS-5
//! residency bound, DS-7 lifecycle).
//!
//! A signal's resolution pyramid (the GUI's `signal_cache`) is a stack of
//! these: each pyramid level is an append-only run of `(t_seconds, value)`
//! pairs that grows `O(matches)` in capture length. Held as a `Vec` it
//! would sit in RAM at that size — the pyramid bounds *serve* cost, not
//! *residency*. Spilling each level to an mmap'd segment chain leaves only
//! a small directory of segment handles resident, so the kernel pages cold
//! history out under pressure; that is the residency bound.
//!
//! Layout mirrors the by-id postings ([`crate::byid`]): a chain of segment
//! files whose capacities **double** (64, 128, … capped at 65 536 entries),
//! so a sparse signal stays one tiny segment while a hot one needs only a
//! few dozen — no large per-signal pre-allocation. Each entry is a fixed
//! 16 bytes (two little-endian `f64`s), so entry `k` is at `k * 16` by
//! arithmetic and random access (the serve path's binary search) is O(1).
//!
//! Unlike the raw store, this sequence carries **no manifest of its own**:
//! the chain's geometry is deterministic in its length, so a `(len,
//! first_slot)` pair the caller has recorded is enough to map every
//! surviving segment file back ([`SampleSeq::reopen`]). Which run those two
//! numbers describe — and whether it is still valid to reuse — is the
//! caller's question, so the caller owns the manifest that answers it.

use std::path::{Path, PathBuf};

use crate::seg::{open_segments, Segment};
use crate::seg_chain::{
    evict_leading, geometric_locate, geometric_push_grow, geometric_seg_capacity,
};

/// Bytes per entry: two `f64`s (`t_seconds`, `value`).
const ENTRY_BYTES: usize = 16;

/// One append-only run of `(t_seconds, value)` pairs, backed by a geometric
/// chain of mmap'd segment files named `{prefix}.NNNN` under `dir`.
pub struct SampleSeq {
    dir: PathBuf,
    prefix: String,
    segs: Vec<Segment>,
    /// `cum_cap[i]` = total entry capacity of segments `0..=i` in **absolute**
    /// numbering (includes any dropped leading segments), so a slot index is
    /// located in `O(log segs)` and a surviving slot keeps its original index
    /// across a trim.
    cum_cap: Vec<usize>,
    len: usize,
    /// Low-water mark: the lowest still-live slot (ADR 0002). `0` until the
    /// pyramid is front-trimmed to honor the scratch cap, after which it
    /// rises to the first surviving slot. The live range is
    /// `[first_slot, len)`; slots below it are evicted. Absolute slot
    /// numbering is preserved across a trim (mirroring the raw store's
    /// `first_index`), so the serve path's binary search and the host's
    /// slot bookkeeping stay valid — only the floor moves.
    first_slot: usize,
    /// Count of dropped leading segments — the absolute number of `segs[0]`.
    /// An absolute segment number `s` addresses `segs[s - seg_base]`.
    seg_base: usize,
}

impl SampleSeq {
    /// A new, empty sequence. No files are touched until the first
    /// [`Self::push`]; segment `i` is created lazily as the chain fills.
    pub fn new(dir: impl AsRef<Path>, prefix: impl Into<String>) -> Self {
        Self {
            dir: dir.as_ref().to_path_buf(),
            prefix: prefix.into(),
            segs: Vec::new(),
            cum_cap: Vec::new(),
            len: 0,
            first_slot: 0,
            seg_base: 0,
        }
    }

    /// Reopen a run persisted by a prior session: the segment files under
    /// `dir` named `{prefix}.NNNN`, restored to the `len` and `first_slot`
    /// the caller recorded when it last wrote the run.
    ///
    /// No manifest of its own is read or needed. The chain's geometry is
    /// deterministic in the run's length ([`geometric_seg_capacity`]), so
    /// `len` alone names every segment file the run ever created, and
    /// `first_slot` says how many leading ones eviction has since deleted —
    /// exactly the two numbers [`Self::evict_below`] and [`Self::push`]
    /// maintain. The caller owns the manifest that carries them, because the
    /// caller is what decides whether the run is still *valid* to reuse.
    ///
    /// `Ok(None)` — a miss, not an error — when the persisted state and the
    /// directory disagree: `first_slot > len`, or a segment file the length
    /// implies is missing. A miss means "rebuild", never a half-mapped run.
    ///
    /// # Errors
    /// Propagates the I/O error if a segment file exists but cannot be
    /// mapped.
    pub fn reopen(
        dir: impl AsRef<Path>,
        prefix: impl Into<String>,
        len: usize,
        first_slot: usize,
    ) -> std::io::Result<Option<Self>> {
        let dir = dir.as_ref().to_path_buf();
        let prefix = prefix.into();
        if first_slot > len {
            return Ok(None);
        }
        // Replay the growth progression: `push` creates segment `i` when the
        // chain is full, so the chain covering `len` entries is the shortest
        // prefix of the progression whose capacity reaches it.
        let mut cum_cap = Vec::new();
        let mut total = 0usize;
        while total < len {
            total += geometric_seg_capacity(cum_cap.len());
            cum_cap.push(total);
        }
        // Leading segments lying wholly below the mark were deleted by
        // `evict_below`, which computes the same base.
        let seg_base = cum_cap.partition_point(|&c| c <= first_slot);
        let paths: Vec<PathBuf> = (seg_base..cum_cap.len())
            .map(|i| seg_path(&dir, &prefix, i))
            .collect();
        if !paths.iter().all(|p| p.is_file()) {
            return Ok(None);
        }
        let segs = open_segments(&paths)?;
        Ok(Some(Self {
            dir,
            prefix,
            segs,
            cum_cap,
            len,
            first_slot,
            seg_base,
        }))
    }

    /// Number of pairs stored — the append count, including any slots
    /// evicted below [`Self::first_slot`]. Slot indices remain absolute, so
    /// this is the exclusive upper bound of the slot space.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether the sequence holds no pairs.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The low-water mark — the lowest still-live slot. `0` until eviction
    /// front-trims the sequence; the live range is `[first_slot, len)`.
    pub fn first_slot(&self) -> usize {
        self.first_slot
    }

    /// Count of still-live pairs (those in `[first_slot, len)`).
    pub fn live_len(&self) -> usize {
        self.len - self.first_slot
    }

    /// Raise the low-water mark to `first_slot`, evicting the slots below it
    /// (clamped to `[self.first_slot, len]`, so the floor only ever rises),
    /// and **drop every leading segment file that now falls entirely below
    /// it** to reclaim disk (ADR 0002 DS-8 / 6d). Absolute slot numbering is
    /// preserved (`seg_base` maps an absolute segment number to its slot in
    /// the trimmed `Vec`), so a live read still addresses a surviving slot by
    /// its original index; only whole dead segments are dropped, so the floor
    /// may sit inside the first kept segment (its sub-floor prefix is simply
    /// never served).
    pub fn evict_below(&mut self, first_slot: usize) {
        self.first_slot = first_slot.clamp(self.first_slot, self.len);
        let target_base = self.cum_cap.partition_point(|&c| c <= self.first_slot);
        let dir = &self.dir;
        let prefix = &self.prefix;
        evict_leading(&mut self.segs, &mut self.seg_base, target_base, |i| {
            seg_path(dir, prefix, i)
        });
    }

    /// `(segment index, byte offset within it)` for entry slot `k`.
    fn locate(&self, k: usize) -> (usize, usize) {
        let (seg, off) = geometric_locate(&self.cum_cap, k);
        (seg, off * ENTRY_BYTES)
    }

    /// The `(t_seconds, value)` pair at the live slot `k`
    /// (`first_slot <= k < len`).
    ///
    /// # Panics
    /// Panics if `k >= len` (the slot's segment isn't mapped). Reading an
    /// evicted slot (`k < first_slot`) is a logic error — the serve path
    /// stays within `[first_slot, len)`; after the leading segments are
    /// dropped it would touch an unmapped segment.
    pub fn get(&self, k: usize) -> (f64, f64) {
        let (seg, off) = self.locate(k);
        let bytes = &self.segs[seg - self.seg_base].map[off..off + ENTRY_BYTES];
        let t = f64::from_le_bytes(bytes[0..8].try_into().unwrap());
        let v = f64::from_le_bytes(bytes[8..16].try_into().unwrap());
        (t, v)
    }

    /// Append a pair, growing the chain by a new (doubled) segment when the
    /// current chain is full.
    ///
    /// # Panics
    /// Panics if a new segment file cannot be created or mapped (the
    /// scratch volume is full or gone) — the same unrecoverable-I/O policy
    /// as the rest of the disk store.
    pub fn push(&mut self, t: f64, value: f64) {
        let len = self.len;
        let dir = &self.dir;
        let prefix = &self.prefix;
        geometric_push_grow(&mut self.segs, &mut self.cum_cap, len, ENTRY_BYTES, |i| {
            seg_path(dir, prefix, i)
        });
        let (seg, off) = self.locate(self.len);
        let map = &mut self.segs[seg - self.seg_base].map;
        map[off..off + 8].copy_from_slice(&t.to_le_bytes());
        map[off + 8..off + ENTRY_BYTES].copy_from_slice(&value.to_le_bytes());
        self.len += 1;
    }

    /// Flush every mapped segment so the run is durable.
    pub fn flush(&self) -> std::io::Result<()> {
        for seg in &self.segs {
            seg.map.flush()?;
        }
        Ok(())
    }
}

fn seg_path(dir: &Path, prefix: &str, seg: usize) -> PathBuf {
    dir.join(format!("{prefix}.{seg:04}"))
}

#[cfg(test)]
#[allow(clippy::float_cmp, clippy::cast_precision_loss)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn push_get_round_trips_across_geometric_segments() {
        // 2000 pairs overflow the first geometric segments (64, 128, 256, …).
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        for i in 0..2000u32 {
            seq.push(f64::from(i), f64::from(i) * 2.0);
        }
        assert_eq!(seq.len(), 2000);
        for i in 0..2000usize {
            let (t, v) = seq.get(i);
            assert_eq!(t, i as f64);
            assert_eq!(v, i as f64 * 2.0);
        }
    }

    #[test]
    fn empty_sequence_touches_no_files() {
        let dir = TempDir::new().unwrap();
        let seq = SampleSeq::new(dir.path(), "sig.l0");
        assert!(seq.is_empty());
        assert_eq!(seq.len(), 0);
        // No push: the directory stays empty (lazy segment creation).
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn distinct_prefixes_do_not_collide() {
        // Two levels of one signal share a directory; their files are
        // independent by prefix.
        let dir = TempDir::new().unwrap();
        let mut l0 = SampleSeq::new(dir.path(), "sig.l0");
        let mut l1 = SampleSeq::new(dir.path(), "sig.l1");
        for i in 0..100u32 {
            l0.push(f64::from(i), 1.0);
        }
        l1.push(7.0, 9.0);
        assert_eq!(l0.len(), 100);
        assert_eq!(l1.len(), 1);
        assert_eq!(l1.get(0), (7.0, 9.0));
        assert_eq!(l0.get(50), (50.0, 1.0));
    }

    #[test]
    fn evict_below_drops_dead_leading_segment_files() {
        // 6d: front-trim drops the whole leading segment files below the mark
        // and reclaims their disk, while surviving slots still read by their
        // absolute index across the base shift.
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        for i in 0..2000u32 {
            seq.push(f64::from(i), f64::from(i) * 2.0);
        }
        let before = std::fs::read_dir(dir.path()).unwrap().count();
        assert!(before >= 4, "2000 points span several geometric segments");
        seq.evict_below(500);
        assert_eq!(seq.first_slot(), 500);
        assert_eq!(
            seq.get(500),
            (500.0, 1000.0),
            "kept slot reads across the base shift"
        );
        assert_eq!(seq.get(1999), (1999.0, 3998.0));
        let after = std::fs::read_dir(dir.path()).unwrap().count();
        assert!(
            after < before,
            "leading pyramid segment files reclaimed: {after} < {before}"
        );
    }

    #[test]
    fn evict_below_raises_the_live_floor_preserving_absolute_slots() {
        // The low-water mark for a pyramid level (ADR 0002): front-trim
        // raises the floor, narrowing the live range, but surviving slots
        // keep their absolute index so the serve path's binary search stays
        // valid.
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        for i in 0..100u32 {
            seq.push(f64::from(i), f64::from(i) * 2.0);
        }
        seq.evict_below(40);
        assert_eq!(seq.first_slot(), 40);
        assert_eq!(seq.live_len(), 60);
        assert_eq!(seq.len(), 100, "len stays the absolute slot bound");
        // Live slots still read by their original absolute index.
        assert_eq!(seq.get(40), (40.0, 80.0));
        assert_eq!(seq.get(99), (99.0, 198.0));
        // The floor only rises — a lower request is ignored.
        seq.evict_below(20);
        assert_eq!(seq.first_slot(), 40);
        // …and clamps to len (a fully-evicted sequence has no live slots).
        seq.evict_below(1000);
        assert_eq!(seq.first_slot(), 100);
        assert_eq!(seq.live_len(), 0);
    }

    #[test]
    fn reopen_recovers_a_persisted_run_and_keeps_appending() {
        // The reopen path a persisted pyramid needs: the segment geometry is
        // deterministic in the run's length, so `len` alone names every
        // segment file, and a reopened run appends where it left off.
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        for i in 0..2000u32 {
            seq.push(f64::from(i), f64::from(i) * 2.0);
        }
        let len = seq.len();
        drop(seq); // unmap, as a process exit would

        let mut back = SampleSeq::reopen(dir.path(), "sig.l0", len, 0)
            .unwrap()
            .expect("every segment file is present");
        assert_eq!(back.len(), 2000);
        assert_eq!(back.first_slot(), 0);
        assert_eq!(back.get(0), (0.0, 0.0));
        assert_eq!(back.get(1999), (1999.0, 3998.0));
        // Appending continues the same chain — the next push lands at 2000
        // and grows the chain exactly as an unbroken run would.
        back.push(2000.0, 4000.0);
        assert_eq!(back.len(), 2001);
        assert_eq!(back.get(2000), (2000.0, 4000.0));
        assert_eq!(back.get(1999), (1999.0, 3998.0));
    }

    #[test]
    fn reopen_restores_a_front_trimmed_run_without_its_dropped_segments() {
        // A run that was evicted before persisting has no leading segment
        // files left; the reopen must map only the surviving ones and put
        // the low-water mark back where it was, so absolute slot numbering
        // still addresses live data.
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        for i in 0..2000u32 {
            seq.push(f64::from(i), f64::from(i) * 2.0);
        }
        seq.evict_below(500);
        let (len, first) = (seq.len(), seq.first_slot());
        drop(seq);

        let back = SampleSeq::reopen(dir.path(), "sig.l0", len, first)
            .unwrap()
            .expect("the surviving segment files are present");
        assert_eq!(back.len(), 2000);
        assert_eq!(back.first_slot(), 500);
        assert_eq!(back.live_len(), 1500);
        assert_eq!(back.get(500), (500.0, 1000.0));
        assert_eq!(back.get(1999), (1999.0, 3998.0));
    }

    #[test]
    fn reopen_reports_a_miss_rather_than_half_a_run() {
        let dir = TempDir::new().unwrap();
        // Nothing was ever written: a zero-length run reopens as an empty
        // one (no files are expected).
        let empty = SampleSeq::reopen(dir.path(), "sig.l0", 0, 0)
            .unwrap()
            .expect("an empty run needs no files");
        assert!(empty.is_empty());

        // A length that names files which aren't there is a miss, not a
        // partial mapping — the caller rebuilds.
        assert!(SampleSeq::reopen(dir.path(), "sig.l0", 5000, 0)
            .unwrap()
            .is_none());

        // So is a nonsensical low-water mark.
        let mut seq = SampleSeq::new(dir.path(), "sig.l1");
        seq.push(1.0, 2.0);
        drop(seq);
        assert!(SampleSeq::reopen(dir.path(), "sig.l1", 1, 2)
            .unwrap()
            .is_none());
    }

    #[test]
    fn flush_is_ok_on_an_empty_and_a_populated_sequence() {
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        seq.flush().unwrap();
        for i in 0..200u32 {
            seq.push(f64::from(i), -f64::from(i));
        }
        seq.flush().unwrap();
        assert_eq!(seq.get(199), (199.0, -199.0));
    }
}
