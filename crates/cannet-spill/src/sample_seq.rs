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

/// `ENTRY_BYTES`, published — what one stored sample costs.
///
/// A caller that keeps sample runs has to be able to say how much disk
/// they are worth: how much a set it reused was spared producing, how
/// much a set it discarded will have to be produced again, how much a
/// retained-but-unreferenced run is holding. The slot size is the only
/// input to that arithmetic which is not already the caller's — and the
/// caller often has only a run's `(len, first_slot)` out of its own
/// manifest, with nothing mapped to ask ([`SampleSeq::live_bytes`]).
///
/// It is the *stored* size, not a footprint: segment files are
/// geometrically sized and lazily created, so a chain's bytes on disk are
/// this times the slots it has room for, rounded up by segment. Which
/// number a caller wants depends on the question — "what did these
/// samples cost to produce" is this one, and the on-disk footprint is
/// what a directory walk measures.
pub const SAMPLE_ENTRY_BYTES: usize = ENTRY_BYTES;

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
    /// Slot up to which [`Self::flush`] has already waited for the device.
    /// The `[flushed, len)` residue is what the next flush has to write, so
    /// a caller that flushes on a cadence leaves a shutdown flush a small,
    /// bounded amount of work instead of the whole run.
    flushed: usize,
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
            flushed: 0,
        }
    }

    /// Reopen a run persisted by a prior session: the segment files under
    /// `dir` named `{prefix}.NNNN`, restored to the `len` and `first_slot`
    /// the caller recorded when it last wrote the run.
    ///
    /// No manifest of its own is read or needed. The chain's geometry is
    /// deterministic in the run's length (`geometric_seg_capacity`), so
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
        let runs = [(prefix.into(), len, first_slot)];
        Ok(Self::reopen_many(dir, &runs)?.and_then(|mut v| v.pop()))
    }

    /// [`Self::reopen`] for a whole set of runs at once, mapping **every**
    /// run's segment files in one parallel open rather than one open per
    /// run.
    ///
    /// That is the difference between a fast reopen and a slow one, and it
    /// is not a micro-optimization: mapping an existing segment is latency-
    /// bound (see `open_segments`), so the useful width is how many opens
    /// are in flight. A pyramid's levels hold a handful of segments each, so
    /// reopening level by level runs the parallel open at a width of about
    /// four; a restore of dozens of pyramids is thousands of files that
    /// should all be in flight together.
    ///
    /// `runs` is `(prefix, len, first_slot)` per run, all under `dir`. The
    /// result is in the same order. `Ok(None)` if *any* run's persisted
    /// state and the directory disagree — a set reopens whole or not at all.
    ///
    /// # Errors
    /// Propagates the I/O error if a segment file exists but cannot be
    /// mapped.
    pub fn reopen_many(
        dir: impl AsRef<Path>,
        runs: &[(String, usize, usize)],
    ) -> std::io::Result<Option<Vec<Self>>> {
        let dir = dir.as_ref();
        let mut plans = Vec::with_capacity(runs.len());
        let mut paths = Vec::new();
        for (prefix, len, first_slot) in runs {
            let Some((cum_cap, seg_base)) = chain_plan(*len, *first_slot) else {
                return Ok(None);
            };
            let from = paths.len();
            paths.extend((seg_base..cum_cap.len()).map(|i| seg_path(dir, prefix, i)));
            plans.push((cum_cap, seg_base, from..paths.len()));
        }
        if !paths.iter().all(|p| p.is_file()) {
            return Ok(None);
        }
        let mut segs = open_segments(&paths)?;
        // Peel the mappings off the back so each run takes its own tail
        // without shifting the ones still to come.
        let mut out: Vec<Option<Self>> = (0..runs.len()).map(|_| None).collect();
        for (n, (cum_cap, seg_base, range)) in plans.into_iter().enumerate().rev() {
            out[n] = Some(Self {
                dir: dir.to_path_buf(),
                prefix: runs[n].0.clone(),
                segs: segs.split_off(range.start),
                cum_cap,
                len: runs[n].1,
                first_slot: runs[n].2,
                seg_base,
                // A run that came off disk is on disk: nothing is owed
                // until something is appended to it.
                flushed: runs[n].1,
            });
        }
        Ok(Some(out.into_iter().flatten().collect()))
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

    /// Bytes of samples this run still holds — [`Self::live_len`] at
    /// [`SAMPLE_ENTRY_BYTES`].
    ///
    /// The arithmetic is trivial and lives here so the slot size stays a
    /// fact of the layout rather than one a caller re-states. A run whose
    /// front has been trimmed reports what it kept: the evicted prefix is
    /// no longer anybody's to account for.
    pub fn live_bytes(&self) -> usize {
        self.live_len() * ENTRY_BYTES
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

    /// Entries appended since the last successful [`Self::flush`] — the
    /// residue a flush still owes the device.
    pub fn unflushed(&self) -> usize {
        self.len - self.flushed.min(self.len)
    }

    /// Wait for the device to take every entry appended since the last
    /// flush, so the run is durable up to its current length — the
    /// shutdown path.
    ///
    /// # Errors
    /// Propagates the `msync` / `FlushFileBuffers` failure, leaving the
    /// residue where it was so the next flush retries it.
    pub fn flush(&mut self) -> std::io::Result<()> {
        self.flush_upto(self.len)
    }

    /// Wait for the device to take up to `budget` **sealed** segments,
    /// leaving the one segment appends still land in — the periodic path.
    /// Decrements `budget` by the number of segments it waited on.
    ///
    /// A segment is sealed once the chain has grown past it: nothing can
    /// dirty its pages again, so it is waited on exactly once, ever. The
    /// hot tail is the opposite — every append re-dirties it, so a
    /// cadence that flushed it would wait on the same file every tick for
    /// as long as the capture runs, and *still* leave it dirty.
    ///
    /// The budget is the other half. Sealing is bursty — a bus's plotted
    /// signals share a rate, so their chains grow past a segment boundary
    /// on the same tick — and an unbounded cadence turns that into one
    /// long device stall. A sealed segment can wait, so the ones over
    /// budget simply go on the next tick; nothing re-dirties in the
    /// meantime, so the work never grows.
    ///
    /// # Errors
    /// As [`Self::flush`]. Segments already waited on keep their
    /// progress.
    pub fn flush_sealed(&mut self, budget: &mut usize) -> std::io::Result<()> {
        let n = self.cum_cap.len();
        // `cum_cap` is cumulative and absolute, so the last entry's
        // predecessor is the first slot of the segment appends land in.
        let hot_start = if n >= 2 { self.cum_cap[n - 2] } else { 0 };
        if self.flushed >= hot_start {
            return Ok(());
        }
        let last_sealed = self.locate(hot_start - 1).0;
        let mut seg = self.locate(self.flushed).0.max(self.seg_base);
        while seg <= last_sealed && *budget > 0 {
            self.segs[seg - self.seg_base].map.flush()?;
            *budget -= 1;
            // The end of the segment just taken, which is where the next
            // cadence tick picks up.
            self.flushed = self.cum_cap[seg];
            seg += 1;
        }
        Ok(())
    }

    /// Flush the segments spanning `[flushed, upto)` — from the segment
    /// holding the residue's first slot, which may already have been
    /// flushed once while partly filled, and never below the leading
    /// segments eviction has since dropped.
    fn flush_upto(&mut self, upto: usize) -> std::io::Result<()> {
        let upto = upto.min(self.len);
        if self.flushed >= upto {
            return Ok(());
        }
        let first = self.locate(self.flushed).0.max(self.seg_base);
        let last = self.locate(upto - 1).0;
        if last >= first {
            for seg in &self.segs[first - self.seg_base..=last - self.seg_base] {
                seg.map.flush()?;
            }
        }
        self.flushed = upto;
        Ok(())
    }
}

fn seg_path(dir: &Path, prefix: &str, seg: usize) -> PathBuf {
    dir.join(format!("{prefix}.{seg:04}"))
}

/// The `(cum_cap, seg_base)` a run of `len` entries trimmed to `first_slot`
/// must have had. `push` creates segment `i` when the chain is full, so the
/// chain covering `len` entries is the shortest prefix of the doubling
/// progression whose capacity reaches it; `evict_below` deleted the leading
/// segments lying wholly below the mark, and computes the same base.
/// `None` when the two numbers cannot describe one run.
fn chain_plan(len: usize, first_slot: usize) -> Option<(Vec<usize>, usize)> {
    if first_slot > len {
        return None;
    }
    let mut cum_cap = Vec::new();
    let mut total = 0usize;
    while total < len {
        total += geometric_seg_capacity(cum_cap.len());
        cum_cap.push(total);
    }
    let seg_base = cum_cap.partition_point(|&c| c <= first_slot);
    Some((cum_cap, seg_base))
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
    fn live_bytes_counts_the_slots_the_run_still_holds() {
        // The honest size of a run is its *live* slots at the fixed slot
        // size — what a caller accounting for the samples it is keeping
        // (or would have to produce again) has to charge. A front-trimmed
        // run costs what it kept, not what it ever appended.
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        assert_eq!(seq.live_bytes(), 0, "an empty run holds nothing");
        for i in 0..100u32 {
            seq.push(f64::from(i), f64::from(i) * 2.0);
        }
        assert_eq!(seq.live_bytes(), 100 * SAMPLE_ENTRY_BYTES);
        seq.evict_below(40);
        assert_eq!(
            seq.live_bytes(),
            60 * SAMPLE_ENTRY_BYTES,
            "an evicted prefix is not held any more"
        );
        // The same arithmetic a caller does over `(len, first_slot)` alone
        // — the two numbers a manifest carries for a run it has not
        // mapped.
        assert_eq!(
            seq.live_bytes(),
            (seq.len() - seq.first_slot()) * SAMPLE_ENTRY_BYTES
        );
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
    fn reopen_many_maps_a_whole_set_in_order() {
        // A pyramid restore reopens dozens of runs at once; they must come
        // back in the order asked for, each addressing its own files.
        let dir = TempDir::new().unwrap();
        let runs: Vec<(String, usize, usize)> = (0..6usize)
            .map(|r| {
                let prefix = format!("sig{r}.l0");
                let mut seq = SampleSeq::new(dir.path(), prefix.clone());
                // Different lengths, so a mis-split would read the wrong
                // run's segments rather than merely the wrong offset.
                let n = 100 + r * 400;
                for i in 0..n {
                    seq.push(i as f64, (r * 1000 + i) as f64);
                }
                (prefix, seq.len(), 0)
            })
            .collect();

        let back = SampleSeq::reopen_many(dir.path(), &runs)
            .unwrap()
            .expect("every run is present");
        assert_eq!(back.len(), 6);
        for (r, seq) in back.iter().enumerate() {
            assert_eq!(seq.len(), 100 + r * 400, "run {r} length");
            assert_eq!(seq.get(0), (0.0, (r * 1000) as f64), "run {r} first");
            let last = seq.len() - 1;
            assert_eq!(
                seq.get(last),
                (last as f64, (r * 1000 + last) as f64),
                "run {r} last",
            );
        }

        // One bad run fails the whole set — a partial reopen is never
        // handed back.
        let mut broken = runs;
        broken.push(("absent.l0".to_string(), 500, 0));
        assert!(SampleSeq::reopen_many(dir.path(), &broken)
            .unwrap()
            .is_none());
        assert!(SampleSeq::reopen_many(dir.path(), &[]).unwrap().is_some());
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

    #[test]
    fn a_flush_clears_the_residue_and_the_next_appends_rebuild_it() {
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        assert_eq!(seq.unflushed(), 0, "an empty run owes nothing");
        for i in 0..10u32 {
            seq.push(f64::from(i), -f64::from(i));
        }
        assert_eq!(seq.unflushed(), 10);
        seq.flush().unwrap();
        assert_eq!(seq.unflushed(), 0);
        // Straight back into the *same* (partly filled) segment: the next
        // flush has to cover the segment it already flushed once, not start
        // after it.
        for i in 10..20u32 {
            seq.push(f64::from(i), -f64::from(i));
        }
        assert_eq!(seq.unflushed(), 10);
        seq.flush().unwrap();
        assert_eq!(seq.unflushed(), 0);
        let back = SampleSeq::reopen(dir.path(), "sig.l0", 20, 0)
            .unwrap()
            .unwrap();
        assert_eq!(back.get(19), (19.0, -19.0));
        assert_eq!(back.unflushed(), 0, "a reopened run is already on disk");
    }

    #[test]
    fn a_sealed_flush_leaves_the_hot_tail_owing_and_a_full_one_takes_it() {
        // More budget than any of these runs can spend, so what the
        // assertions pin is the sealed-vs-hot line and not the budget.
        let mut ample = usize::MAX;
        // The cadence's flush waits only on segments that can never be
        // written to again. The tail is where every append lands, so
        // flushing it on a cadence means waiting on the same file over
        // and over for as long as the capture runs — and it is still
        // dirty afterwards. Only the shutdown flush takes it.
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        // 100 entries: segment 0 (cap 64) is sealed, segment 1 is hot.
        for i in 0..100u32 {
            seq.push(f64::from(i), -f64::from(i));
        }
        seq.flush_sealed(&mut ample).unwrap();
        assert_eq!(seq.unflushed(), 100 - 64, "the hot tail is still owed");
        // Running the cadence again with nothing sealed since costs
        // nothing and changes nothing — that is the whole point.
        seq.flush_sealed(&mut ample).unwrap();
        assert_eq!(seq.unflushed(), 100 - 64);
        seq.flush().unwrap();
        assert_eq!(seq.unflushed(), 0);
    }

    #[test]
    fn a_sealed_flush_owes_everything_while_the_run_is_one_segment() {
        // More budget than any of these runs can spend, so what the
        // assertions pin is the sealed-vs-hot line and not the budget.
        let mut ample = usize::MAX;
        // Nothing is sealed until the chain grows, so a short run's
        // cadence flush is a no-op and its shutdown flush does all of it.
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        seq.flush_sealed(&mut ample).unwrap();
        assert_eq!(seq.unflushed(), 0, "an empty run owes nothing either way");
        for i in 0..10u32 {
            seq.push(f64::from(i), -f64::from(i));
        }
        seq.flush_sealed(&mut ample).unwrap();
        assert_eq!(seq.unflushed(), 10);
        seq.flush().unwrap();
        assert_eq!(seq.unflushed(), 0);
    }

    #[test]
    fn sealing_advances_what_the_cadence_will_take_next() {
        // More budget than any of these runs can spend, so what the
        // assertions pin is the sealed-vs-hot line and not the budget.
        let mut ample = usize::MAX;
        // What makes the cadence bounded: each segment is waited on
        // exactly once, when it seals, and never again.
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        for i in 0..64u32 {
            seq.push(f64::from(i), -f64::from(i));
        }
        // Still one segment, so nothing has sealed.
        seq.flush_sealed(&mut ample).unwrap();
        assert_eq!(seq.unflushed(), 64);
        // The 65th push opens segment 1 and seals segment 0.
        seq.push(64.0, -64.0);
        seq.flush_sealed(&mut ample).unwrap();
        assert_eq!(seq.unflushed(), 1, "only the new segment's entry is owed");
    }

    #[test]
    fn a_budgeted_sealed_flush_stops_at_its_budget_and_resumes_next_time() {
        // Sealing is bursty, and a device wait is a barrier everything
        // else queues behind, so the cadence spends a fixed number per
        // call. What it defers is immutable, so it is still there — and
        // no more than there was — on the next call.
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        // 1000 entries: segments of 64/128/256/512 are sealed, the fifth
        // is hot.
        for i in 0..1000u32 {
            seq.push(f64::from(i), -f64::from(i));
        }
        let sealed_end = 64 + 128 + 256 + 512;
        assert_eq!(seq.unflushed(), 1000);

        let mut budget = 2usize;
        seq.flush_sealed(&mut budget).unwrap();
        assert_eq!(budget, 0, "the budget was spent");
        assert_eq!(seq.unflushed(), 1000 - (64 + 128), "two segments taken");

        let mut budget = 2usize;
        seq.flush_sealed(&mut budget).unwrap();
        assert_eq!(budget, 0);
        assert_eq!(
            seq.unflushed(),
            1000 - sealed_end,
            "the rest of the sealed run"
        );

        // Caught up: further calls cost nothing and leave the hot tail.
        let mut budget = 4usize;
        seq.flush_sealed(&mut budget).unwrap();
        assert_eq!(budget, 4, "nothing sealed was left to take");
        assert_eq!(seq.unflushed(), 1000 - sealed_end);

        seq.flush().unwrap();
        assert_eq!(seq.unflushed(), 0);
    }

    #[test]
    fn a_spent_budget_leaves_the_next_run_nothing_to_spend() {
        // The budget is shared across a whole pyramid, so a run reached
        // with none left must do nothing at all — not "at least one".
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        for i in 0..1000u32 {
            seq.push(f64::from(i), -f64::from(i));
        }
        let mut budget = 0usize;
        seq.flush_sealed(&mut budget).unwrap();
        assert_eq!(seq.unflushed(), 1000);
    }

    #[test]
    fn a_flush_after_a_trim_stays_inside_the_surviving_segments() {
        let dir = TempDir::new().unwrap();
        let mut seq = SampleSeq::new(dir.path(), "sig.l0");
        for i in 0..100u32 {
            seq.push(f64::from(i), -f64::from(i));
        }
        seq.flush().unwrap();
        for i in 100..600u32 {
            seq.push(f64::from(i), -f64::from(i));
        }
        // The residue now starts below the floor eviction is about to raise,
        // and the segment holding its first slot is dropped outright — so a
        // flush that indexes from the residue would address a segment that
        // is no longer mapped.
        seq.evict_below(500);
        assert!(seq.first_slot() > 600 - seq.unflushed());
        seq.flush().unwrap();
        assert_eq!(seq.unflushed(), 0);
        assert_eq!(seq.get(599), (599.0, -599.0));
    }
}
