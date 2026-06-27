//! Always-on `by-id` index: per-id append-only mmap'd posting lists
//! (ADR 0002 DS-3 backbone).
//!
//! For each arbitration id `(id, extended)`, the ordered list of the
//! frame indices that carry it — ascending, because frames are appended
//! in index order. This is the structure that lets a query jump straight
//! to one id's frames without scanning the capture, and it is the
//! backbone the materialized filter index (DS-3) and the decimated
//! pyramids (DS-5) build on.
//!
//! ## Why on disk, and why geometric segments
//!
//! The postings hold one `u64` per stored frame — so as a `Vec` they grow
//! `O(capture)` in RAM, the unbounded cost this step removes. Spilling
//! them to mmap'd files leaves only a small directory in RAM (a handful
//! of segment handles per id), bounded by the id-space, not the capture
//! length.
//!
//! Each id's postings are a sequence of segment files whose capacities
//! **double** (64, 128, 256, … capped at 65 536 entries). Geometric
//! growth keeps a sparse id tiny (one 512-byte segment) while a hot id
//! with millions of occurrences needs only a few dozen segments — so the
//! total number of live mappings stays well bounded even at 10^9 frames,
//! without pre-allocating a large segment per id.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::seg::{create_segment, Segment};

/// Entries in the first (smallest) per-id segment.
const BASE_ENTRIES: usize = 64;
/// Cap on per-id segment size; segments double up to here, then stay.
const MAX_SEG_ENTRIES: usize = 65_536;
/// Bytes per posting entry (a `u64` frame index).
const ENTRY_BYTES: usize = 8;

/// File-name prefix for every by-id segment (used to wipe them on clear).
pub(crate) const BYID_PREFIX: &str = "byid.";

/// One id's posting list: a geometric chain of mmap'd segments plus the
/// number of entries written.
#[derive(Default)]
struct IdPostings {
    segs: Vec<Segment>,
    /// `cum_cap[i]` = total entry capacity of `segs[0..=i]`. Lets a slot
    /// index be located in `O(log segs)`.
    cum_cap: Vec<usize>,
    len: usize,
}

impl IdPostings {
    fn capacity(&self) -> usize {
        self.cum_cap.last().copied().unwrap_or(0)
    }

    /// `(segment index, byte offset within it)` for entry slot `k`.
    fn locate(&self, k: usize) -> (usize, usize) {
        let seg = self.cum_cap.partition_point(|&c| c <= k);
        let base = if seg == 0 { 0 } else { self.cum_cap[seg - 1] };
        (seg, (k - base) * ENTRY_BYTES)
    }

    /// The frame index stored at slot `k` (`k < len`).
    fn entry(&self, k: usize) -> u64 {
        let (seg, off) = self.locate(k);
        u64::from_le_bytes(self.segs[seg].map[off..off + ENTRY_BYTES].try_into().unwrap())
    }
}

/// The whole by-id index: a directory of per-id posting lists, all backed
/// by segment files under one directory.
pub(crate) struct ByIdIndex {
    dir: PathBuf,
    map: HashMap<(u32, bool), IdPostings>,
}

impl ByIdIndex {
    pub(crate) fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            dir: dir.as_ref().to_path_buf(),
            map: HashMap::new(),
        }
    }

    /// Record that frame `frame_idx` carries `(id, extended)`. Appends to
    /// that id's posting list, growing it by a new (doubled) segment when
    /// the current chain is full.
    pub(crate) fn push(&mut self, id: u32, extended: bool, frame_idx: u64) {
        // Borrow `self.dir` and `self.map` as disjoint fields (a `&self`
        // method on `self` would conflict with the `&mut` posting borrow).
        let dir = &self.dir;
        let post = self.map.entry((id, extended)).or_default();
        if post.len == post.capacity() {
            let i = post.segs.len();
            let cap = (BASE_ENTRIES << i).min(MAX_SEG_ENTRIES);
            let seg = create_segment(&seg_path(dir, id, extended, i), cap * ENTRY_BYTES)
                .expect("cannet-spill: by-id segment I/O failed");
            post.segs.push(seg);
            let prev = post.cum_cap.last().copied().unwrap_or(0);
            post.cum_cap.push(prev + cap);
        }
        let (seg, off) = post.locate(post.len);
        post.segs[seg].map[off..off + ENTRY_BYTES].copy_from_slice(&frame_idx.to_le_bytes());
        post.len += 1;
    }

    /// The frame indices of `(id, extended)` that fall in `[start, end)`,
    /// ascending. `O(log occurrences + matches)` via binary search over
    /// the (ascending) posting list — never a capture scan.
    pub(crate) fn range(&self, id: u32, extended: bool, start: usize, end: usize) -> Vec<usize> {
        let Some(post) = self.map.get(&(id, extended)) else {
            return Vec::new();
        };
        let lo = partition_point(post, start as u64);
        let hi = partition_point(post, end as u64);
        (lo..hi)
            .map(|k| usize::try_from(post.entry(k)).unwrap_or(usize::MAX))
            .collect()
    }

    /// Drop every mapping. The caller removes the segment files (via
    /// [`crate::seg::remove_files_with_prefixes`]) once the maps are gone.
    pub(crate) fn clear(&mut self) {
        self.map.clear();
    }

    #[cfg(test)]
    fn len(&self, id: u32, extended: bool) -> usize {
        self.map.get(&(id, extended)).map_or(0, |p| p.len)
    }
}

fn seg_path(dir: &Path, id: u32, extended: bool, seg: usize) -> PathBuf {
    let kind = if extended { 'e' } else { 's' };
    dir.join(format!("{BYID_PREFIX}{kind}{id:08x}.{seg:04}"))
}

/// Smallest slot `k` in `[0, len)` whose stored frame index is `>= target`
/// (the partition point of an ascending list).
fn partition_point(post: &IdPostings, target: u64) -> usize {
    let mut lo = 0usize;
    let mut hi = post.len;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if post.entry(mid) < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

#[cfg(test)]
#[allow(clippy::cast_possible_truncation)] // small loop counters round-trip through u32
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn postings_round_trip_across_geometric_segments() {
        // id 0x100 gets every even frame index, 0x200 every odd. Enough to
        // overflow the first few geometric segments (64, 128, 256, …).
        let dir = TempDir::new().unwrap();
        let mut idx = ByIdIndex::new(dir.path());
        for i in 0u64..2000 {
            let id = if i % 2 == 0 { 0x100 } else { 0x200 };
            idx.push(id, false, i);
        }
        assert_eq!(idx.len(0x100, false), 1000);
        assert_eq!(idx.len(0x200, false), 1000);
        // Full range comes back in order.
        let evens = idx.range(0x100, false, 0, 2000);
        assert_eq!(evens.len(), 1000);
        assert!(evens.iter().enumerate().all(|(k, &v)| v == k * 2));
    }

    #[test]
    fn range_is_a_windowed_slice() {
        let dir = TempDir::new().unwrap();
        let mut idx = ByIdIndex::new(dir.path());
        for i in 0u64..100 {
            idx.push(7, false, i * 3); // 0, 3, 6, …, 297
        }
        // Frame indices in [10, 40): 12,15,18,21,24,27,30,33,36,39.
        let got = idx.range(7, false, 10, 40);
        assert_eq!(got, vec![12, 15, 18, 21, 24, 27, 30, 33, 36, 39]);
        // Standard vs extended are distinct keys.
        assert!(idx.range(7, true, 0, 1000).is_empty());
        // Unknown id is empty.
        assert!(idx.range(9, false, 0, 1000).is_empty());
    }

    #[test]
    fn many_ids_each_keep_their_own_list() {
        let dir = TempDir::new().unwrap();
        let mut idx = ByIdIndex::new(dir.path());
        // 500 distinct ids, round-robin — exercises a wide id space.
        for i in 0u64..5000 {
            idx.push((i % 500) as u32, false, i);
        }
        for id in 0u32..500 {
            let got = idx.range(id, false, 0, 5000);
            assert_eq!(got.len(), 10);
            // Each id's frames are exactly i where i % 500 == id.
            assert!(got.iter().all(|&v| (v as u32) % 500 == id));
        }
    }

    #[test]
    fn clear_empties_the_index() {
        let dir = TempDir::new().unwrap();
        let mut idx = ByIdIndex::new(dir.path());
        for i in 0u64..200 {
            idx.push(1, false, i);
        }
        idx.clear();
        assert!(idx.range(1, false, 0, 1000).is_empty());
        idx.push(1, false, 0);
        assert_eq!(idx.range(1, false, 0, 1000), vec![0]);
    }
}
