//! Materialized filter index: the matching subsequence of a predicate,
//! stored as an append-only mmap'd list of frame indices (ADR 0002 DS-3).
//!
//! A filtered chronological view is "every frame matching the current
//! predicate." Re-deriving it by scanning the whole capture on every page
//! is `O(capture)`. Instead the host materializes the matching frame
//! indices once, into this index, and pages it in `O(page)`.
//!
//! ## How it builds — id-narrowed, no capture scan
//!
//! Every predicate is id-narrowable against the loaded DBC ([ADR 0002]
//! DS-3): it resolves to a set of candidate arbitration ids, and only
//! those ids' frames can match. The index is built by walking the
//! by-id-narrowed candidate set ([`RawStore::candidate_indices`]), never
//! the whole window:
//!
//! - **membership predicates** (`id_range`, `id_list`, and any predicate
//!   whose candidate id set is exactly its match set) — every candidate
//!   frame matches, so [`FilterIndex::extend_membership`] records them
//!   without reading a single frame.
//! - **tested predicates** (`bus`, `name_regex` under per-bus DBC
//!   scoping, `signal_equals`, and mixed `all`/`any`) —
//!   [`FilterIndex::extend`] reads each candidate frame and applies a
//!   `keep` test (decoding only when the predicate needs it). Still only
//!   candidate-id frames are visited.
//!
//! Both record only matches and both advance a `built_through` watermark,
//! so a growing capture is brought current incrementally (`O(delta)`),
//! and a predicate change is a [`FilterIndex::clear`] + rebuild.
//!
//! [ADR 0002]: ../../../docs/adr/0002-disk-spill-store.md

use std::io;
use std::path::{Path, PathBuf};

use crate::seg::{create_segment, remove_files_with_prefixes, Segment};
use crate::{CandidateSource, RawTraceFrame};

/// Frame indices per index segment file (8 MiB at 8 bytes each).
const SEG_ENTRIES: usize = 1 << 20;
const ENTRY_BYTES: usize = 8;
/// File-name prefix for every filter-index segment.
const FILTER_PREFIX: &str = "filter.";

/// Frames visited under one build chunk before the (eventual) caller can
/// release its lock and yield — mirrors the host's filtered-scan chunk.
const BUILD_CHUNK: usize = 8192;

/// An append-only, mmap'd list of the frame indices matching one
/// predicate. See the module docs.
pub struct FilterIndex {
    dir: PathBuf,
    segs: Vec<Segment>,
    /// Number of matching frame indices stored.
    len: usize,
    /// Frame index (exclusive) the index has been built up to. Lets a
    /// growing capture be brought current without rescanning history.
    built_through: usize,
    /// Low-water mark: the lowest still-live match-position (ADR 0002). `0`
    /// until eviction front-trims the postings whose frames have dropped
    /// below the raw store's `first_index`, after which it rises. The live
    /// match-positions are `[first_pos, len)`; positions below it are
    /// evicted. Match-positions stay absolute across a trim, so a below-mark
    /// position is never read (its segment may be unmapped).
    first_pos: usize,
}

impl FilterIndex {
    /// Create an empty filter index under `dir`, clearing any stale
    /// `filter.*` segment files left there.
    pub fn new(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        remove_files_with_prefixes(&dir, &[FILTER_PREFIX])?;
        Ok(Self {
            dir,
            segs: Vec::new(),
            len: 0,
            built_through: 0,
            first_pos: 0,
        })
    }

    /// Matching frames recorded so far (the filtered view's total count).
    #[must_use]
    pub fn len(&self) -> usize {
        self.len
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The frame index (exclusive) the index has been built through.
    #[must_use]
    pub fn built_through(&self) -> usize {
        self.built_through
    }

    /// The low-water mark — the lowest still-live match-position. `0` until
    /// eviction front-trims the postings whose frames have dropped below the
    /// raw store's `first_index`; the live positions are `[first_pos, len)`.
    #[must_use]
    pub fn first_pos(&self) -> usize {
        self.first_pos
    }

    fn seg_path(&self, i: usize) -> PathBuf {
        self.dir.join(format!("{FILTER_PREFIX}{i:06}"))
    }

    fn push(&mut self, frame_idx: usize) {
        let seg = self.len / SEG_ENTRIES;
        while self.segs.len() <= seg {
            let i = self.segs.len();
            let s = create_segment(&self.seg_path(i), SEG_ENTRIES * ENTRY_BYTES)
                .expect("cannet-spill: filter-index segment I/O failed");
            self.segs.push(s);
        }
        let off = (self.len % SEG_ENTRIES) * ENTRY_BYTES;
        self.segs[seg].map[off..off + ENTRY_BYTES]
            .copy_from_slice(&(frame_idx as u64).to_le_bytes());
        self.len += 1;
    }

    fn entry(&self, k: usize) -> usize {
        let seg = k / SEG_ENTRIES;
        let off = (k % SEG_ENTRIES) * ENTRY_BYTES;
        let v = u64::from_le_bytes(self.segs[seg].map[off..off + ENTRY_BYTES].try_into().unwrap());
        usize::try_from(v).unwrap_or(usize::MAX)
    }

    /// Bring the index current to frame index `to` for a **membership**
    /// predicate: every candidate-id frame matches, so candidate indices
    /// are recorded directly with no frame read. `ids` is the candidate id
    /// set. Idempotent past `built_through`.
    pub fn extend_membership(&mut self, store: &dyn CandidateSource, ids: &[(u32, bool)], to: usize) {
        let to = to.min(store.frame_count());
        let mut pos = self.built_through;
        while pos < to {
            let hi = (pos + BUILD_CHUNK).min(to);
            for idx in store.candidate_indices(ids, pos, hi) {
                self.push(idx);
            }
            pos = hi;
        }
        self.built_through = self.built_through.max(to);
    }

    /// Bring the index current to frame index `to` for a **tested**
    /// predicate: read each candidate-id frame and record it only when
    /// `keep` holds. `ids` is the candidate id set; `keep` applies the
    /// full predicate (decoding only when it must). Idempotent past
    /// `built_through`.
    pub fn extend(
        &mut self,
        store: &dyn CandidateSource,
        ids: &[(u32, bool)],
        keep: &dyn Fn(&RawTraceFrame) -> bool,
        to: usize,
    ) {
        let to = to.min(store.frame_count());
        let mut pos = self.built_through;
        while pos < to {
            let hi = (pos + BUILD_CHUNK).min(to);
            let cands = store.candidate_indices(ids, pos, hi);
            for (idx, frame) in store.frames_at(&cands) {
                if keep(&frame) {
                    self.push(idx);
                }
            }
            pos = hi;
        }
        self.built_through = self.built_through.max(to);
    }

    /// The match-position of the first recorded match whose frame index is
    /// `>= frame` — i.e. the number of matches with a frame index strictly
    /// below `frame`. A lower-bound binary search over the ascending stored
    /// indices, `O(log len)`.
    ///
    /// This maps a frame-index window onto match positions: the matches in
    /// `[a, b)` are exactly the match-positions `[position_of(a),
    /// position_of(b))`, so a windowed filtered view counts and pages by
    /// slicing the index — no scan.
    #[must_use]
    pub fn position_of(&self, frame: usize) -> usize {
        // The lower bound starts at the low-water mark, so an evicted
        // (front-trimmed) match-position is never read.
        let (mut lo, mut hi) = (self.first_pos, self.len);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if self.entry(mid) < frame {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    /// The matching frame indices at match-positions `[offset, offset +
    /// limit)`, ascending — the page the filtered chrono view renders.
    /// `O(limit)`.
    #[must_use]
    pub fn page(&self, offset: usize, limit: usize) -> Vec<usize> {
        // Clamp the start up to the low-water mark so an evicted prefix is
        // dropped rather than read from a (would-be) unmapped segment.
        let start = offset.max(self.first_pos).min(self.len);
        let end = offset.saturating_add(limit).min(self.len);
        if end <= start {
            return Vec::new();
        }
        (start..end).map(|k| self.entry(k)).collect()
    }

    /// Drop the index: unmap and delete its segment files, reset to empty.
    /// The predicate-change path (a fresh predicate invalidates the whole
    /// index).
    pub fn clear(&mut self) -> io::Result<()> {
        self.segs.clear();
        self.len = 0;
        self.built_through = 0;
        self.first_pos = 0;
        remove_files_with_prefixes(&self.dir, &[FILTER_PREFIX])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MemRawStore, RawStore};
    use cannet_core::{CanFramePayload, Direction};
    use tempfile::TempDir;

    fn frame(id: u32, bus: Option<&str>) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: 0,
            channel: 0,
            id,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(vec![]),
            bus_id: bus.map(str::to_string),
        }
    }

    /// Build a store of `n` frames cycling ids 0x100/0x200/0x300, the
    /// first two on bus "a", the third on bus "b".
    fn seeded(n: u32) -> MemRawStore {
        let mut s = MemRawStore::new();
        for i in 0..n {
            let f = match i % 3 {
                0 => frame(0x100, Some("a")),
                1 => frame(0x200, Some("a")),
                _ => frame(0x300, Some("b")),
            };
            s.append(f);
        }
        s
    }

    #[test]
    fn membership_records_every_candidate_with_no_frame_read() {
        let store = seeded(30); // ids at: 0x100 @0,3,…; 0x200 @1,4,…
        let dir = TempDir::new().unwrap();
        let mut idx = FilterIndex::new(dir.path()).unwrap();
        // id_list [0x100, 0x200] -> exact match set, membership build.
        idx.extend_membership(&store, &[(0x100, false), (0x200, false)], store.len());
        assert_eq!(idx.len(), 20);
        // Page is ascending and excludes the 0x300 frames (2,5,8,…).
        let page = idx.page(0, idx.len());
        assert!(page.iter().all(|&i| i % 3 != 2));
        assert_eq!(page.first(), Some(&0));
        assert_eq!(idx.built_through(), 30);
    }

    #[test]
    fn extend_applies_the_keep_test_to_candidate_frames_only() {
        let store = seeded(30);
        let dir = TempDir::new().unwrap();
        let mut idx = FilterIndex::new(dir.path()).unwrap();
        // bus "a": candidate ids 0x100 & 0x200 are on bus a, but keep must
        // still confirm bus_id (an id could appear on another bus).
        let ids = [(0x100, false), (0x200, false)];
        idx.extend(&store, &ids, &|f| f.bus_id.as_deref() == Some("a"), store.len());
        assert_eq!(idx.len(), 20);
        let page = idx.page(0, idx.len());
        assert!(page.iter().all(|&i| i % 3 != 2));
    }

    #[test]
    fn incremental_extend_only_visits_the_delta() {
        let mut store = seeded(15);
        let dir = TempDir::new().unwrap();
        let mut idx = FilterIndex::new(dir.path()).unwrap();
        let ids = [(0x100, false)];
        idx.extend_membership(&store, &ids, store.len());
        let first = idx.len();
        assert_eq!(idx.built_through(), 15);
        // Grow the capture, extend again — only new matches are added.
        for i in 15..30 {
            let f = match i % 3 {
                0 => frame(0x100, Some("a")),
                1 => frame(0x200, Some("a")),
                _ => frame(0x300, Some("b")),
            };
            store.append(f);
        }
        idx.extend_membership(&store, &ids, store.len());
        assert!(idx.len() > first);
        assert_eq!(idx.built_through(), 30);
        // Every recorded index really carries id 0x100 (offset % 3 == 0).
        assert!(idx.page(0, idx.len()).iter().all(|&i| i % 3 == 0));
    }

    #[test]
    fn position_of_lower_bounds_a_frame_window_onto_match_positions() {
        // ids cycle 0x100/0x200/0x300; index id 0x100 → frame indices
        // 0,3,6,9,…,27 (10 matches over 30 frames).
        let store = seeded(30);
        let dir = TempDir::new().unwrap();
        let mut idx = FilterIndex::new(dir.path()).unwrap();
        idx.extend_membership(&store, &[(0x100, false)], store.len());
        assert_eq!(idx.len(), 10);
        // Below / at / between recorded frame indices.
        assert_eq!(idx.position_of(0), 0); // first match is frame 0
        assert_eq!(idx.position_of(1), 1); // frame 0 is below, 3 is above
        assert_eq!(idx.position_of(3), 1); // exact hit → its own position
        assert_eq!(idx.position_of(7), 3); // matches 0,3,6 below 7
        assert_eq!(idx.position_of(30), 10); // past the tip → full count
        assert_eq!(idx.position_of(1000), 10);
        // A frame window [6, 21) selects match-positions [2, 7): frames
        // 6,9,12,15,18.
        let (a, b) = (idx.position_of(6), idx.position_of(21));
        assert_eq!((a, b), (2, 7));
        assert_eq!(idx.page(a, b - a), vec![6, 9, 12, 15, 18]);
    }

    #[test]
    fn paging_is_a_windowed_slice_of_matches() {
        let store = seeded(300);
        let dir = TempDir::new().unwrap();
        let mut idx = FilterIndex::new(dir.path()).unwrap();
        idx.extend_membership(&store, &[(0x100, false)], store.len());
        let all = idx.page(0, idx.len());
        // A mid-page matches the corresponding slice of the full list.
        assert_eq!(idx.page(10, 5), all[10..15]);
        // Over-large offset / limit clamp.
        assert!(idx.page(idx.len() + 5, 10).is_empty());
        assert_eq!(idx.page(idx.len() - 2, 100), all[idx.len() - 2..]);
    }

    // Illustrative timing (run with `--ignored --nocapture`): a selective
    // filter on the disk store, full scan vs the by-id-narrowed filter
    // index, plus a deep positional page from each. Not a gate — it just
    // makes Step 3's asymptotics concrete on the disk store.
    #[test]
    #[ignore = "timing measurement; run with --ignored --nocapture"]
    fn timing_scan_vs_filter_index_on_disk() {
        use crate::DiskRawStore;
        use std::time::Instant;

        const N: u32 = 200_000;
        const RARE: u32 = 0xABC; // ~1 in 200 frames
        let dir = TempDir::new().unwrap();
        let mut store = DiskRawStore::new(dir.path()).unwrap();
        for i in 0..N {
            let id = if i % 200 == 0 { RARE } else { 0x100 + (i % 64) };
            store.append(frame(id, Some("pt")));
        }

        // Full scan: visit every frame, test the predicate (O(N)).
        let t = Instant::now();
        let mut scan_matches = Vec::new();
        let mut pos = 0;
        while pos < RawStore::len(&store) {
            let hi = (pos + 8192).min(RawStore::len(&store));
            scan_matches.extend(store.scan_chunk(pos, hi, &|f| f.id == RARE));
            pos = hi;
        }
        let scan_ms = t.elapsed().as_secs_f64() * 1e3;

        // Filter index: visit only candidate-id frames (O(matches)).
        let dir2 = TempDir::new().unwrap();
        let mut idx = FilterIndex::new(dir2.path()).unwrap();
        let t = Instant::now();
        idx.extend_membership(&store, &[(RARE, false)], store.len());
        let build_ms = t.elapsed().as_secs_f64() * 1e3;

        assert_eq!(idx.len(), scan_matches.len());
        let deep = idx.len() / 2;
        let t = Instant::now();
        let page = idx.page(deep, 50);
        let page_us = t.elapsed().as_secs_f64() * 1e6;

        eprintln!(
            "N={N} matches={}  full_scan={scan_ms:.2}ms  index_build={build_ms:.2}ms  \
             index_page(@{deep})={page_us:.1}us  page0={}",
            idx.len(),
            page[0],
        );
    }

    #[test]
    fn reads_below_the_low_water_position_are_evicted_not_panics() {
        // The evicted-read contract for the filter index (ADR 0002): once
        // its postings are front-trimmed (Step 6d, when the matched frames
        // drop below the raw store's `first_index`), `position_of` / `page`
        // must not read a below-mark match-position. Build the index, raise
        // the mark directly, and assert the reads honor it.
        let store = seeded(30); // id 0x100 → frames 0,3,6,…,27 (10 matches)
        let dir = TempDir::new().unwrap();
        let mut idx = FilterIndex::new(dir.path()).unwrap();
        idx.extend_membership(&store, &[(0x100, false)], store.len());
        assert_eq!(idx.len(), 10);
        idx.first_pos = 4; // simulate the oldest 4 match-positions evicted

        // `position_of` never descends below the mark…
        assert_eq!(idx.position_of(0), 4);
        assert_eq!(idx.position_of(1000), 10);
        // …and a page straddling the mark drops the evicted prefix.
        let page = idx.page(0, idx.len());
        assert_eq!(page, vec![12, 15, 18, 21, 24, 27]); // positions 4..10
        // A page entirely below the mark comes back empty (no panic).
        assert!(idx.page(0, 4).is_empty());
    }

    #[test]
    fn clear_drops_files_and_resets() {
        let store = seeded(30);
        let dir = TempDir::new().unwrap();
        let mut idx = FilterIndex::new(dir.path()).unwrap();
        idx.extend_membership(&store, &[(0x100, false)], store.len());
        assert!(!idx.is_empty());
        idx.clear().unwrap();
        assert_eq!(idx.len(), 0);
        assert_eq!(idx.built_through(), 0);
        assert!(idx.page(0, 10).is_empty());
        let leftover = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with(FILTER_PREFIX));
        assert!(!leftover, "filter segment files should be gone");
        // Reusable after clear.
        idx.extend_membership(&store, &[(0x200, false)], store.len());
        assert_eq!(idx.len(), 10);
    }
}
