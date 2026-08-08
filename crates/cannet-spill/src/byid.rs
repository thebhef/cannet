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

use crate::seg::{open_segments, Segment};
use crate::seg_chain::{
    evict_leading, geometric_locate, geometric_push_grow, geometric_seg_capacity, lower_bound,
};

/// Bytes per posting entry (a `u64` frame index).
const ENTRY_BYTES: usize = 8;

/// File-name prefix for every by-id segment (used to wipe them on clear).
pub(crate) const BYID_PREFIX: &str = "byid.";

/// One id's posting list: a geometric chain of mmap'd segments plus the
/// number of entries written.
#[derive(Default)]
struct IdPostings {
    segs: Vec<Segment>,
    /// `cum_cap[i]` = total entry capacity of segments `0..=i` in **absolute**
    /// numbering (includes any dropped leading segments, so a surviving slot
    /// keeps its original index across a trim). Lets a slot index be located
    /// in `O(log segs)`.
    cum_cap: Vec<usize>,
    len: usize,
    /// Absolute entry count already handed to writeback — `len` as of the
    /// previous flush. Appends only ever extend past it, so a flush syncs
    /// exactly the byte range `[flushed_len, len)` and an id with no new
    /// postings costs nothing at all (no per-id syscall). That per-id
    /// skip is what keeps the periodic flush off the append lock's
    /// critical path: whole-map re-syncs across every id were the
    /// dominant cost of the 2 s flush tick (measured 2026-07-25).
    flushed_len: usize,
    /// Windowed-ring floor (ADR 0002 DS-8 / 6d): the lowest still-mapped slot,
    /// always a segment boundary. `0` until eviction drops leading segments.
    /// Reads stay within `[first_slot, len)`; a binary search lower-bounds
    /// here so it never touches a dropped segment.
    first_slot: usize,
    /// Count of dropped leading segments — the absolute number of `segs[0]`.
    /// An absolute segment number `s` addresses `segs[s - seg_base]`.
    seg_base: usize,
}

impl IdPostings {
    fn capacity(&self) -> usize {
        self.cum_cap.last().copied().unwrap_or(0)
    }

    /// `(absolute segment index, byte offset within it)` for entry slot `k`.
    fn locate(&self, k: usize) -> (usize, usize) {
        let (seg, off) = geometric_locate(&self.cum_cap, k);
        (seg, off * ENTRY_BYTES)
    }

    /// The frame index stored at the live slot `k` (`first_slot <= k < len`).
    fn entry(&self, k: usize) -> u64 {
        let (seg, off) = self.locate(k);
        u64::from_le_bytes(
            self.segs[seg - self.seg_base].map[off..off + ENTRY_BYTES]
                .try_into()
                .unwrap(),
        )
    }

    /// Front-trim to the low-water mark `first_index`: drop every leading
    /// segment whose entries are *all* below it and delete its file, raising
    /// `first_slot`/`seg_base`. Returns `true` when the id is now fully dead
    /// (no live entry remains), so the caller can forget it. Whole segments
    /// only — the partial dead prefix inside the first kept segment stays and
    /// is filtered by the raw read guard.
    fn evict_below(&mut self, dir: &Path, id: u32, extended: bool, first_index: u64) -> bool {
        // First live slot: the lowest slot whose stored frame index is
        // `>= first_index`. Everything below it is dead (evicted raw rows).
        let floor_slot = partition_point(self, first_index);
        // The id is dead if no slot survives the mark; drop the whole chain.
        let target_base = if floor_slot >= self.len {
            self.cum_cap.len()
        } else {
            // Keep the segment that holds `floor_slot`; drop the strictly
            // earlier ones (those whose cumulative capacity fits below it).
            self.cum_cap.partition_point(|&c| c <= floor_slot)
        };
        evict_leading(&mut self.segs, &mut self.seg_base, target_base, |i| {
            seg_path(dir, id, extended, i)
        });
        self.first_slot = if self.seg_base == 0 {
            0
        } else {
            self.cum_cap[self.seg_base - 1]
        };
        // `flushed_len` needs no adjustment: it counts absolute entries,
        // and the flush path clamps its start to the surviving floor.
        self.first_slot >= self.len
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

    /// Reopen the index from its persisted per-id directory (ADR 0002
    /// DS-7). Each `(id, extended, len)` entry's segment chain is
    /// rebuilt from `len` alone — the geometry ([`seg_capacity`]) is
    /// deterministic — by mapping the existing files whole without
    /// truncating them. A missing or short segment file surfaces as an
    /// I/O error, which the caller treats as an unusable scratch.
    pub(crate) fn reopen(
        dir: impl AsRef<Path>,
        entries: &[(u32, bool, u64, u64)],
    ) -> std::io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        // Plan every id's chain first — the geometry is pure arithmetic —
        // then map the whole directory's segment files in one parallel
        // pass. Mapping is the expensive half by three orders of magnitude
        // (see [`open_segments`]), and pooling the paths across ids is what
        // keeps a capture with few, deep chains as parallel as one with
        // many shallow ones.
        let mut plans: Vec<((u32, bool), IdPostings)> = Vec::with_capacity(entries.len());
        let mut paths: Vec<PathBuf> = Vec::new();
        for &(id, extended, len, first_slot) in entries {
            let len = usize::try_from(len).unwrap_or(usize::MAX);
            let first_slot = usize::try_from(first_slot).unwrap_or(0);
            let mut post = IdPostings::default();
            // Rebuild the absolute cum_cap up to `len` (the geometry is
            // deterministic in the absolute segment index).
            while post.capacity() < len {
                let i = post.cum_cap.len();
                let cap = geometric_seg_capacity(i);
                let prev = post.cum_cap.last().copied().unwrap_or(0);
                post.cum_cap.push(prev + cap);
            }
            // `first_slot` is a segment boundary; the segments below it were
            // dropped on eviction (DS-8), so map only those at/above it.
            let seg_base = post.cum_cap.partition_point(|&c| c <= first_slot);
            paths.extend((seg_base..post.cum_cap.len()).map(|i| seg_path(&dir, id, extended, i)));
            post.len = len;
            post.first_slot = first_slot;
            post.seg_base = seg_base;
            // Reopened bytes are durable; the next flush syncs only what
            // is appended after this point.
            post.flushed_len = len;
            plans.push(((id, extended), post));
        }
        let mut segs = open_segments(&paths)?.into_iter();
        let mut map = HashMap::with_capacity(plans.len());
        for (key, mut post) in plans {
            let want = post.cum_cap.len() - post.seg_base;
            post.segs.extend(segs.by_ref().take(want));
            map.insert(key, post);
        }
        Ok(Self { dir, map })
    }

    /// Total posting segment files currently mapped, across every id —
    /// the "how much work did it do" companion to the reopen timing
    /// breakdown (ADR 0002 DS-7).
    pub(crate) fn segment_count(&self) -> usize {
        self.map.values().map(|p| p.segs.len()).sum()
    }

    /// Distinct ids with a posting chain.
    pub(crate) fn id_count(&self) -> usize {
        self.map.len()
    }

    /// The persisted directory: one `(id, extended, len, first_slot)` per
    /// posting list. `first_slot` is the windowed-ring floor (DS-8), so a
    /// reopen across an eviction maps only the surviving segments. Written
    /// into the store manifest on flush.
    pub(crate) fn directory(&self) -> Vec<(u32, bool, u64, u64)> {
        self.map
            .iter()
            .map(|(&(id, ext), post)| (id, ext, post.len as u64, post.first_slot as u64))
            .collect()
    }

    /// Flush the postings. Two flavors (ADR 0002 DS-2):
    ///
    /// - **async** (`sync == false`, the periodic tick): queue writeback
    ///   of just the `[flushed_len, len)` entry range per id, skipping
    ///   clean ids without a syscall — see
    ///   [`Segment::queue_writeback`] for the platform split (a no-op on
    ///   Windows, where the nearest API stalls ~0.3–0.5 ms per call and
    ///   dozens of dirty ids per tick stalled the transmit scheduler —
    ///   measured 2026-07-25).
    /// - **sync** (the shutdown-hardening path): flush every live
    ///   segment whole and wait for the device — deliberately ignoring
    ///   the watermarks, so its guarantee never depends on what the
    ///   async flavor did or didn't queue.
    pub(crate) fn flush(&mut self, sync: bool) -> std::io::Result<()> {
        for post in self.map.values_mut() {
            if sync {
                for seg in &post.segs {
                    seg.map.flush()?;
                }
                post.flushed_len = post.len;
                continue;
            }
            // Clamp to the windowed-ring floor: entries below it live in
            // dropped segments (DS-8).
            let start = post.flushed_len.max(post.first_slot);
            if post.len <= start {
                post.flushed_len = post.len.max(post.flushed_len);
                continue;
            }
            let (first_seg, first_off) = post.locate(start);
            let (last_seg, last_off) = post.locate(post.len - 1);
            for seg_no in first_seg..=last_seg {
                let seg = &post.segs[seg_no - post.seg_base];
                let from = if seg_no == first_seg { first_off } else { 0 };
                let to = if seg_no == last_seg {
                    last_off + ENTRY_BYTES
                } else {
                    seg.map.len()
                };
                seg.queue_writeback(from, to - from)?;
            }
            post.flushed_len = post.len;
        }
        Ok(())
    }

    /// Front-trim every id's postings to the low-water mark `first_index`
    /// (ADR 0002 DS-8 / 6d): drop the leading dead segments and delete their
    /// files; an id with no surviving entry is forgotten entirely. Called by
    /// [`crate::disk::DiskRawStore::evict_below`] with the same mark the raw
    /// store front-trims to, so by-id stays aligned with the live window.
    pub(crate) fn evict_below(&mut self, first_index: u64) {
        let dir = self.dir.clone();
        self.map
            .retain(|&(id, extended), post| !post.evict_below(&dir, id, extended, first_index));
    }

    /// Record that frame `frame_idx` carries `(id, extended)`. Appends to
    /// that id's posting list, growing it by a new (doubled) segment when
    /// the current chain is full.
    pub(crate) fn push(&mut self, id: u32, extended: bool, frame_idx: u64) {
        // Borrow `self.dir` and `self.map` as disjoint fields (a `&self`
        // method on `self` would conflict with the `&mut` posting borrow).
        let dir = &self.dir;
        let post = self.map.entry((id, extended)).or_default();
        geometric_push_grow(
            &mut post.segs,
            &mut post.cum_cap,
            post.len,
            ENTRY_BYTES,
            |i| seg_path(dir, id, extended, i),
        );
        let (seg, off) = post.locate(post.len);
        post.segs[seg - post.seg_base].map[off..off + ENTRY_BYTES]
            .copy_from_slice(&frame_idx.to_le_bytes());
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

    /// The union of several ids' frame indices in `[start, end)`, sorted
    /// ascending. Each id's postings are already ascending and the id sets
    /// are disjoint (a frame has one id), so the merge is duplicate-free.
    pub(crate) fn merge_range(&self, ids: &[(u32, bool)], start: usize, end: usize) -> Vec<usize> {
        let mut out = Vec::new();
        for &(id, extended) in ids {
            out.extend(self.range(id, extended, start, end));
        }
        out.sort_unstable();
        out
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

/// Smallest live slot `k` in `[first_slot, len)` whose stored frame index is
/// `>= target` (the partition point of an ascending list). Lower-bounding at
/// `first_slot` keeps the search out of any dropped leading segment (DS-8).
fn partition_point(post: &IdPostings, target: u64) -> usize {
    lower_bound(post.first_slot, post.len, target, |k| post.entry(k))
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

    fn byid_file_count(dir: &std::path::Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with(BYID_PREFIX))
            .count()
    }

    #[test]
    fn evict_below_drops_dead_leading_segments() {
        // 6d windowed-ring trim (ADR 0002 DS-8): front-trim a hot id's
        // postings to the low-water mark — drop the leading segments whose
        // entries are all below it and delete their files — while keeping
        // absolute slot numbering so windowed reads stay valid. Whole
        // segments only, so the surviving floor is a segment boundary at or
        // below the mark (the dead tail inside the kept segment is filtered
        // by the raw read guard, not here).
        let dir = TempDir::new().unwrap();
        let mut idx = ByIdIndex::new(dir.path());
        for i in 0u64..1000 {
            idx.push(7, false, i); // id 7 at every frame index
        }
        let before = byid_file_count(dir.path());
        assert!(before >= 4, "1000 entries span several geometric segments");
        idx.evict_below(300);
        let got = idx.range(7, false, 0, 1000);
        assert!(!got.is_empty());
        let floor = got[0];
        assert!(
            floor > 0 && floor <= 300,
            "floor {floor} is a dropped-segment boundary ≤ mark"
        );
        assert_eq!(
            got,
            (floor..1000).collect::<Vec<usize>>(),
            "contiguous above the floor"
        );
        assert!(
            idx.range(7, false, 0, floor).is_empty(),
            "below the floor is gone"
        );
        assert!(
            byid_file_count(dir.path()) < before,
            "leading segment files reclaimed"
        );
    }

    #[test]
    fn interleaved_flushes_keep_postings_intact_across_boundaries_and_eviction() {
        // The incremental flush syncs only `[flushed_len, len)` per id and
        // skips clean ids entirely. Interleave flushes with appends that
        // cross geometric segment boundaries, evict, and flush again — the
        // watermark bookkeeping must never corrupt reads or error.
        let dir = TempDir::new().unwrap();
        let mut idx = ByIdIndex::new(dir.path());
        for i in 0u64..50 {
            idx.push(7, false, i); // inside the first (64-entry) segment
        }
        idx.flush(false).unwrap();
        idx.flush(false).unwrap(); // clean id: skip path, still Ok
        for i in 50u64..500 {
            idx.push(7, false, i); // crosses 64 and 192 boundaries
        }
        idx.flush(false).unwrap();
        idx.evict_below(300); // drops leading segments below the mark
        for i in 500u64..700 {
            idx.push(7, false, i);
        }
        idx.flush(false).unwrap(); // watermark below the floor: clamped
        idx.flush(true).unwrap(); // sync flavor over the same state
        let got = idx.range(7, false, 0, 1000);
        let floor = got[0];
        assert!(floor <= 300);
        assert_eq!(got, (floor..700).collect::<Vec<usize>>());
    }

    #[test]
    fn evict_below_removes_a_fully_dead_id() {
        // A rare id whose every sighting is below the mark drops out entirely
        // (all its segments are dead).
        let dir = TempDir::new().unwrap();
        let mut idx = ByIdIndex::new(dir.path());
        idx.push(0x55, false, 5);
        idx.push(0x55, false, 9);
        for i in 100u64..400 {
            idx.push(7, false, i); // keep some other id live above the mark
        }
        idx.evict_below(50);
        assert!(
            idx.range(0x55, false, 0, 1000).is_empty(),
            "the rare id is gone"
        );
        assert!(
            !idx.range(7, false, 0, 1000).is_empty(),
            "the live id stays"
        );
    }

    #[cfg(unix)]
    fn open_fd_count() -> usize {
        // Every open descriptor shows up as an entry under /dev/fd (a
        // /proc/self/fd symlink on Linux, a real dir on macOS).
        std::fs::read_dir("/dev/fd").map_or(0, Iterator::count)
    }

    #[test]
    #[cfg(unix)]
    fn segments_do_not_retain_file_descriptors() {
        // A mmap'd segment must not keep its file descriptor open for the
        // mapping's lifetime: the by-id index holds one segment chain per
        // distinct id, so retaining an fd per segment exhausts RLIMIT_NOFILE
        // (EMFILE) mid-import on a capture with many ids. Push across 400
        // ids, each past the first segment boundary (>64 entries → ≥2
        // segments), and assert the open-fd count stays bounded — not O(ids).
        let dir = TempDir::new().unwrap();
        let mut idx = ByIdIndex::new(dir.path());
        let before = open_fd_count();
        for id in 0u32..400 {
            for f in 0u64..100 {
                idx.push(id, false, f);
            }
        }
        let after = open_fd_count();
        // 400 ids × ≥2 segments = ≥800 fds if each segment retains one; a
        // margin of 64 absorbs incidental fds from parallel tests.
        assert!(
            after <= before + 64,
            "open fds grew from {before} to {after}; segments retain file descriptors"
        );
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
