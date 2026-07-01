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
//! Unlike the raw store, a pyramid is *derived* state: it is rebuilt by
//! re-decoding the reopened raw frames, so this sequence carries no reopen
//! manifest. The host wipes the pyramid directory when a capture is cleared
//! or a session reopened (the frames it indexed no longer correspond), and
//! the next serve rebuilds it on disk.

use std::path::{Path, PathBuf};

use crate::seg::{create_segment, Segment};

/// Entries in the first (smallest) segment.
const BASE_ENTRIES: usize = 64;
/// Cap on per-segment size; segments double up to here, then stay.
const MAX_SEG_ENTRIES: usize = 65_536;
/// `seg` index at which `BASE_ENTRIES << seg` first reaches the cap
/// (`64 << 10 == 65_536`). Beyond it every segment is `MAX_SEG_ENTRIES`.
const CAP_SEG: usize = 10;
/// Bytes per entry: two `f64`s (`t_seconds`, `value`).
const ENTRY_BYTES: usize = 16;

/// Entry capacity of segment `seg`: [`BASE_ENTRIES`] doubled per step,
/// capped at [`MAX_SEG_ENTRIES`]. Branching on [`CAP_SEG`] keeps the shift
/// in range (matching [`crate::byid`]'s geometry).
fn seg_capacity(seg: usize) -> usize {
    if seg >= CAP_SEG {
        MAX_SEG_ENTRIES
    } else {
        BASE_ENTRIES << seg
    }
}

/// One append-only run of `(t_seconds, value)` pairs, backed by a geometric
/// chain of mmap'd segment files named `{prefix}.NNNN` under `dir`.
pub struct SampleSeq {
    dir: PathBuf,
    prefix: String,
    segs: Vec<Segment>,
    /// `cum_cap[i]` = total entry capacity of `segs[0..=i]`, so a slot index
    /// is located in `O(log segs)`.
    cum_cap: Vec<usize>,
    len: usize,
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
        }
    }

    /// Number of pairs stored.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether the sequence holds no pairs.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    fn capacity(&self) -> usize {
        self.cum_cap.last().copied().unwrap_or(0)
    }

    /// `(segment index, byte offset within it)` for entry slot `k`.
    fn locate(&self, k: usize) -> (usize, usize) {
        let seg = self.cum_cap.partition_point(|&c| c <= k);
        let base = if seg == 0 { 0 } else { self.cum_cap[seg - 1] };
        (seg, (k - base) * ENTRY_BYTES)
    }

    /// The `(t_seconds, value)` pair at slot `k` (`k < len`).
    ///
    /// # Panics
    /// Panics if `k >= len` (the slot's segment isn't mapped).
    pub fn get(&self, k: usize) -> (f64, f64) {
        let (seg, off) = self.locate(k);
        let bytes = &self.segs[seg].map[off..off + ENTRY_BYTES];
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
        if self.len == self.capacity() {
            let i = self.segs.len();
            let cap = seg_capacity(i);
            let seg = create_segment(&self.seg_path(i), cap * ENTRY_BYTES)
                .expect("cannet-spill: sample-seq segment I/O failed");
            self.segs.push(seg);
            let prev = self.cum_cap.last().copied().unwrap_or(0);
            self.cum_cap.push(prev + cap);
        }
        let (seg, off) = self.locate(self.len);
        let map = &mut self.segs[seg].map;
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

    fn seg_path(&self, seg: usize) -> PathBuf {
        self.dir.join(format!("{}.{seg:04}", self.prefix))
    }
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
