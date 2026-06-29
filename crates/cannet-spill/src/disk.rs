//! Disk-backed raw store: append-only mmap'd segment files (ADR 0002
//! DS-1, DS-2, DS-4).
//!
//! The raw store is two families of fixed-size, pre-allocated segment
//! files mapped whole:
//!
//! - **metadata** — fixed-size [`MetaRecord`]s, so row `N` is at
//!   `N * RECORD_SIZE` by arithmetic (DS-1).
//! - **payload** — a packed blob of the variable-length frame bytes;
//!   each metadata record carries an `(offset, len)` into it.
//!
//! Writes are write-through: each append memcpys straight into the active
//! segment's mapping (DS-2). Reads of the durable body come from the
//! mappings (the kernel page cache is the hot tier); the most recent
//! frames are mirrored in a small RAM ring so a tail read is served from
//! RAM and never races a half-written record. Because every read and
//! write goes through the *same* mapping within one process, this never
//! depends on `write()`/`mmap` coherency — the Windows pitfall DS-2/DS-4
//! call out. Segments are pre-allocated to full size and mapped once, so
//! a mapped file is never resized (which Windows forbids) (DS-4).
//!
//! The always-on `by-id` index is materialized on disk too (DS-3), in
//! [`crate::byid`]; only the small per-id directory of segment handles
//! stays in RAM.
//!
//! ## Reopen (DS-4 watermark, DS-7 lifecycle)
//!
//! Segments are pre-allocated to full size and zero-padded, so the bytes
//! alone don't say how many records are live. On every [`DiskRawStore::flush`]
//! the store writes a small `manifest.json` — the valid-length watermarks
//! (`len`, `payload_cursor`), the RAM-only bus-intern table, and the by-id
//! directory. [`DiskRawStore::reopen`] reads it back and remaps the
//! existing files without truncating them, so a prior session reloads in
//! `O(segments)` with no capture rebuild scan. The un-flushed RAM-ring
//! tail is not in the manifest: a crash loses only frames appended since
//! the last flush.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::byid::{ByIdIndex, BYID_PREFIX};
use crate::record::{rebuild_payload, split_payload, MetaRecord, BUS_NONE, RECORD_SIZE};
use crate::seg::{create_segment, open_segment, remove_files_with_prefixes, Segment};
use crate::{RawStore, RawTraceFrame};

/// File name of the reopen manifest (ADR 0002 DS-4/DS-7), written into the
/// store directory on flush.
const MANIFEST_NAME: &str = "manifest.json";

/// Persisted reopen record (ADR 0002 DS-4/DS-7). Captures exactly the
/// state a [`DiskRawStore`] cannot re-derive arithmetically from its
/// segment files: the valid-length watermarks (`len`, `payload_cursor`),
/// the bus-intern table, and the by-id directory. The segment *bytes*
/// live in the mapped files; this says how many of them are real. Written
/// on every flush so a clean exit (or the last flush before a crash) can
/// be remapped without an O(capture) rebuild scan.
#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    /// Schema version; bumped if the manifest layout changes.
    version: u32,
    /// Segment sizing — persisted so reopen reads back with the exact
    /// geometry the files were written with, not whatever `Default` is.
    cfg: DiskConfig,
    len: u64,
    /// Low-water mark (ADR 0002 DS-8). Defaulted for v1 manifests written
    /// before windowed-ring eviction existed (they had no evicted rows, so
    /// `0` is correct). Reopen derives the dropped-segment bases from it.
    #[serde(default)]
    first_index: u64,
    payload_cursor: u64,
    bus_intern: Vec<String>,
    /// One `(id, extended, len, first_slot)` per by-id posting list — the
    /// `first_slot` windowed-ring floor (DS-8) so a reopen across an eviction
    /// maps only surviving segments.
    byid: Vec<(u32, bool, u64, u64)>,
}

/// Current [`Manifest::version`]. v2 added [`Manifest::first_index`] (the
/// DS-8 low-water mark); v3 added the per-id `first_slot` to the by-id
/// directory (6d). A manifest from before the current layout fails to parse
/// and the caller wipes the (ephemeral) scratch.
const MANIFEST_VERSION: u32 = 3;

/// Segment sizing and the RAM-ring depth. Defaults suit production; tests
/// shrink them to exercise rollover and ring eviction cheaply.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DiskConfig {
    /// Metadata records per segment file.
    pub records_per_seg: usize,
    /// Bytes per payload segment file. Must exceed the largest single
    /// payload (64 for CAN FD) so a payload always fits one segment.
    pub payload_seg_bytes: usize,
    /// Most-recent frames mirrored in the RAM ring for fast tail reads.
    pub ring_capacity: usize,
}

impl Default for DiskConfig {
    fn default() -> Self {
        Self {
            records_per_seg: 1 << 16,   // 65_536 records ~ 1.7 MB / segment
            payload_seg_bytes: 4 << 20, // 4 MiB
            ring_capacity: 4096,
        }
    }
}

/// Disk-backed [`RawStore`]. See the module docs.
pub struct DiskRawStore {
    dir: PathBuf,
    cfg: DiskConfig,
    len: usize,
    /// Low-water mark: the lowest still-addressable row index (ADR 0002).
    /// `0` until windowed-ring eviction drops the oldest segments, after
    /// which it rises to the first surviving row. Reads below it return
    /// the evicted result (`None`) rather than indexing a dropped segment;
    /// the live range is `[first_index, len)`.
    first_index: usize,
    /// Global next-write byte offset into the logical payload blob.
    payload_cursor: u64,
    meta_segs: Vec<Segment>,
    payload_segs: Vec<Segment>,
    /// Absolute segment number of `meta_segs[0]` / `payload_segs[0]` — the
    /// count of leading segments windowed-ring eviction (ADR 0002 DS-8) has
    /// dropped. `0` until the first eviction. An absolute segment number `s`
    /// addresses `meta_segs[s - meta_seg_base]`, so surviving rows keep the
    /// arithmetic addressing of DS-1 while the dropped files free disk.
    meta_seg_base: usize,
    payload_seg_base: usize,
    /// Index of the first meta / payload segment that may hold un-flushed
    /// bytes — the segment that was active at the previous flush. Sealed
    /// segments below it were made durable while they were the tail, so a
    /// flush only re-syncs from here to the current tail (incremental
    /// flush): `O(segments dirtied since last flush)`, not `O(all
    /// segments)`, which is what keeps the periodic flush off the append
    /// lock's critical path at deep history.
    flushed_meta: usize,
    flushed_payload: usize,
    ring: VecDeque<RawTraceFrame>,
    bus_intern: Vec<String>,
    bus_rev: HashMap<String, u16>,
    by_id: ByIdIndex,
}

impl DiskRawStore {
    /// Create an empty disk store rooted at `dir` with default sizing.
    /// The directory must exist.
    pub fn new(dir: impl AsRef<Path>) -> io::Result<Self> {
        Self::with_config(dir, DiskConfig::default())
    }

    /// Create an empty disk store with explicit segment sizing.
    ///
    /// # Panics
    /// Panics if `cfg.payload_seg_bytes < 64` (a payload must fit one
    /// segment) or `cfg.records_per_seg == 0`.
    pub fn with_config(dir: impl AsRef<Path>, cfg: DiskConfig) -> io::Result<Self> {
        assert!(
            cfg.payload_seg_bytes >= 64,
            "payload_seg_bytes must hold at least one max-size (64 B) payload",
        );
        assert!(cfg.records_per_seg > 0, "records_per_seg must be positive");
        let dir = dir.as_ref().to_path_buf();
        let mut store = Self {
            by_id: ByIdIndex::new(&dir),
            dir,
            cfg,
            len: 0,
            first_index: 0,
            payload_cursor: 0,
            meta_segs: Vec::new(),
            payload_segs: Vec::new(),
            meta_seg_base: 0,
            payload_seg_base: 0,
            flushed_meta: 0,
            flushed_payload: 0,
            ring: VecDeque::new(),
            bus_intern: Vec::new(),
            bus_rev: HashMap::new(),
        };
        store.remove_segment_files()?;
        Ok(store)
    }

    /// Construct an empty store rooted at `dir` **without wiping** any
    /// files already there (ADR 0002 DS-7). Used at launch: the store
    /// starts empty (presenting no trace) but leaves a prior session's
    /// segments and manifest intact, so [`Self::reopen`] can still load
    /// them once the matching project is opened. The first capture
    /// ([`RawStore::clear`] via the host's start-session) wipes them, so
    /// the preserved files are only ever reopened or cleared — never
    /// appended into.
    pub fn open_empty(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        Ok(Self {
            by_id: ByIdIndex::new(&dir),
            dir,
            cfg: DiskConfig::default(),
            len: 0,
            first_index: 0,
            payload_cursor: 0,
            meta_segs: Vec::new(),
            payload_segs: Vec::new(),
            meta_seg_base: 0,
            payload_seg_base: 0,
            flushed_meta: 0,
            flushed_payload: 0,
            ring: VecDeque::new(),
            bus_intern: Vec::new(),
            bus_rev: HashMap::new(),
        })
    }

    /// Reopen a prior store from its on-disk manifest (ADR 0002 DS-7),
    /// remapping the existing segment files **without wiping them**.
    /// Returns `Ok(None)` when `dir` holds no manifest (nothing to
    /// reload); `Err` when a manifest is present but it — or a segment
    /// file it references — is unreadable, which the caller treats as an
    /// unusable scratch (wipe and start fresh).
    ///
    /// The store comes back exactly as the last flush left it: the
    /// un-flushed RAM-ring tail (DS-2) is not part of the manifest, so a
    /// crash loses only the frames appended since that flush.
    pub fn reopen(dir: impl AsRef<Path>) -> io::Result<Option<Self>> {
        let dir = dir.as_ref().to_path_buf();
        let manifest_path = dir.join(MANIFEST_NAME);
        if !manifest_path.exists() {
            return Ok(None);
        }
        let manifest: Manifest = serde_json::from_slice(&std::fs::read(&manifest_path)?)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let len = usize::try_from(manifest.len).unwrap_or(usize::MAX);
        let cfg = manifest.cfg;
        let first_index = usize::try_from(manifest.first_index).unwrap_or(0);
        let mut bus_rev = HashMap::new();
        for (i, name) in manifest.bus_intern.iter().enumerate() {
            bus_rev.insert(name.clone(), u16::try_from(i).unwrap_or(u16::MAX));
        }
        // A meta segment is dropped (DS-8) iff it falls entirely below the
        // mark; the first surviving segment is the one holding `first_index`.
        let meta_seg_base = first_index / cfg.records_per_seg;
        let mut store = Self {
            by_id: ByIdIndex::reopen(&dir, &manifest.byid)?,
            dir,
            cfg,
            len,
            first_index,
            payload_cursor: manifest.payload_cursor,
            meta_segs: Vec::new(),
            payload_segs: Vec::new(),
            meta_seg_base,
            payload_seg_base: 0, // set once the first live meta record maps
            flushed_meta: 0,
            flushed_payload: 0,
            ring: VecDeque::new(),
            bus_intern: manifest.bus_intern,
            bus_rev,
        };
        // Map the surviving metadata segments — from the dropped base up to
        // the count the watermark implies.
        let meta_segs_count = len.div_ceil(cfg.records_per_seg);
        for i in meta_seg_base..meta_segs_count {
            let path = store.meta_seg_path(i);
            store.meta_segs.push(open_segment(&path)?);
        }
        // The lowest live payload byte is the first live row's payload
        // offset; payload segments wholly below it were dropped, so map from
        // there. (Reading the first live meta record needs the meta segments
        // mapped, which they now are.)
        store.payload_seg_base = if first_index < len {
            usize::try_from(store.meta_payload_off(first_index) / cfg.payload_seg_bytes as u64)
                .unwrap_or(0)
        } else {
            0
        };
        let payload_segs_count = if manifest.payload_cursor == 0 {
            0
        } else {
            usize::try_from((manifest.payload_cursor - 1) / cfg.payload_seg_bytes as u64)
                .unwrap_or(usize::MAX)
                + 1
        };
        for i in store.payload_seg_base..payload_segs_count {
            let path = store.payload_seg_path(i);
            store.payload_segs.push(open_segment(&path)?);
        }
        // Refill the RAM ring from the durable tail so a follow-live read
        // behaves the same as it would on a never-exited store. Collect
        // from the mappings *first* (with the ring still empty, so every
        // `read_frame` resolves to a mapping), then install — pushing as we
        // read would move `ring_start` down and make later reads hit the
        // half-filled ring.
        let ring_from = len.saturating_sub(cfg.ring_capacity);
        let tail: Vec<RawTraceFrame> = (ring_from..len).filter_map(|i| store.read_frame(i)).collect();
        store.ring.extend(tail);
        // Reopened segments are already durable on disk, so the first flush
        // need only re-sync from the active tail forward.
        store.flushed_meta = meta_segs_count.saturating_sub(1).max(meta_seg_base);
        store.flushed_payload = payload_segs_count.saturating_sub(1).max(store.payload_seg_base);
        Ok(Some(store))
    }

    /// Serialize the current watermarks and directory to the manifest.
    /// Written via a temp file + rename so a crash mid-write cannot leave
    /// a half-written manifest that would fail (or misread) on reopen.
    fn write_manifest(&self) -> io::Result<()> {
        let manifest = Manifest {
            version: MANIFEST_VERSION,
            cfg: self.cfg,
            len: self.len as u64,
            first_index: self.first_index as u64,
            payload_cursor: self.payload_cursor,
            bus_intern: self.bus_intern.clone(),
            byid: self.by_id.directory(),
        };
        let bytes = serde_json::to_vec(&manifest)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let tmp = self.dir.join(format!("{MANIFEST_NAME}.tmp"));
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, self.dir.join(MANIFEST_NAME))
    }

    fn meta_seg_path(&self, i: usize) -> PathBuf {
        self.dir.join(format!("meta.{i:06}"))
    }

    fn payload_seg_path(&self, i: usize) -> PathBuf {
        self.dir.join(format!("payload.{i:06}"))
    }

    /// Drop every mapping and delete the segment files from `dir`,
    /// including the reopen manifest so a wiped store never reloads a
    /// stale prior session. Maps are dropped first so Windows lets the
    /// files be removed.
    /// Incremental flush: re-sync only the segments dirtied since the last
    /// flush — the tail that was active then (it may have sealed and grown)
    /// through the current tail. Sealed segments below `flushed_*` were
    /// synced while they were the tail and never change again, so the
    /// manifest written below still names only durable bytes. This makes
    /// the hold `O(segments since last flush)`, normally one.
    ///
    /// `sync` chooses the msync flavor: `true` waits for the device
    /// (`FlushFileBuffers` on Windows) — the crash-hardening shutdown path;
    /// `false` queues writeback (`FlushViewOfFile` / `MS_ASYNC`) and
    /// returns at memcpy speed — the periodic path, where waiting on the
    /// device would pin the append lock. Either way the OS page cache makes
    /// the writes visible to a reopen in the same session (ADR 0002 DS-2).
    fn flush_inner(&mut self, sync: bool) -> io::Result<()> {
        // `flushed_*` are absolute segment numbers; index the front-trimmed
        // `Vec`s relative to the dropped base (DS-8).
        for s in &self.meta_segs[self.flushed_meta - self.meta_seg_base..] {
            if sync {
                s.map.flush()?;
            } else {
                s.map.flush_async()?;
            }
        }
        for s in &self.payload_segs[self.flushed_payload - self.payload_seg_base..] {
            if sync {
                s.map.flush()?;
            } else {
                s.map.flush_async()?;
            }
        }
        self.flushed_meta = self.meta_seg_base + self.meta_segs.len().saturating_sub(1);
        self.flushed_payload = self.payload_seg_base + self.payload_segs.len().saturating_sub(1);
        self.by_id.flush(sync)?;
        self.write_manifest()
    }

    fn remove_segment_files(&mut self) -> io::Result<()> {
        self.meta_segs.clear();
        self.payload_segs.clear();
        self.flushed_meta = 0;
        self.flushed_payload = 0;
        self.meta_seg_base = 0;
        self.payload_seg_base = 0;
        self.first_index = 0;
        self.by_id.clear();
        remove_files_with_prefixes(&self.dir, &["meta.", "payload.", BYID_PREFIX, "manifest."])
    }

    // `seg` is an absolute segment number; the active tail lives at
    // `meta_seg_base + meta_segs.len() - 1`, so grow until it covers `seg`.
    fn ensure_meta_seg(&mut self, seg: usize) {
        while self.meta_seg_base + self.meta_segs.len() <= seg {
            let i = self.meta_seg_base + self.meta_segs.len();
            let bytes = self.cfg.records_per_seg * RECORD_SIZE;
            let s = create_segment(&self.meta_seg_path(i), bytes)
                .expect("cannet-spill: metadata segment I/O failed");
            self.meta_segs.push(s);
        }
    }

    fn ensure_payload_seg(&mut self, seg: usize) {
        while self.payload_seg_base + self.payload_segs.len() <= seg {
            let i = self.payload_seg_base + self.payload_segs.len();
            let s = create_segment(&self.payload_seg_path(i), self.cfg.payload_seg_bytes)
                .expect("cannet-spill: payload segment I/O failed");
            self.payload_segs.push(s);
        }
    }

    fn intern_bus(&mut self, name: &str) -> u16 {
        if let Some(&i) = self.bus_rev.get(name) {
            return i;
        }
        let i = u16::try_from(self.bus_intern.len())
            .expect("cannet-spill: more than 65535 distinct buses");
        assert!(i != BUS_NONE, "cannet-spill: bus intern table overflow");
        self.bus_intern.push(name.to_string());
        self.bus_rev.insert(name.to_string(), i);
        i
    }

    /// Reserve space for `len` payload bytes, padding to the next segment
    /// boundary if they would straddle one, and write them. Returns the
    /// global offset they were written at. (Payloads are <= 64 B and
    /// segments are MiB-scale, so the padding waste is negligible.)
    // `off % seg_bytes` and `off / seg_bytes` are bounded by the usize
    // `payload_seg_bytes`, so the narrowing casts cannot truncate.
    #[allow(clippy::cast_possible_truncation)]
    fn place_payload(&mut self, bytes: &[u8]) -> u64 {
        if bytes.is_empty() {
            return self.payload_cursor;
        }
        let seg_bytes = self.cfg.payload_seg_bytes as u64;
        let mut off = self.payload_cursor;
        let within = (off % seg_bytes) as usize;
        if within + bytes.len() > self.cfg.payload_seg_bytes {
            off = (off / seg_bytes + 1) * seg_bytes; // pad to next boundary
        }
        let seg = (off / seg_bytes) as usize;
        self.ensure_payload_seg(seg);
        let within = (off % seg_bytes) as usize;
        self.payload_segs[seg - self.payload_seg_base].map[within..within + bytes.len()]
            .copy_from_slice(bytes);
        self.payload_cursor = off + bytes.len() as u64;
        off
    }

    fn write_meta(&mut self, idx: usize, bytes: &[u8; RECORD_SIZE]) {
        let seg = idx / self.cfg.records_per_seg;
        self.ensure_meta_seg(seg);
        let within = (idx % self.cfg.records_per_seg) * RECORD_SIZE;
        self.meta_segs[seg - self.meta_seg_base].map[within..within + RECORD_SIZE]
            .copy_from_slice(bytes);
    }

    /// The lowest index currently mirrored in the RAM ring.
    fn ring_start(&self) -> usize {
        self.len - self.ring.len()
    }

    /// Read the timestamp of frame `idx` without rebuilding the payload.
    /// Returns `None` for an evicted row (`idx < first_index`) or one past
    /// the tip (`idx >= len`).
    fn read_ts(&self, idx: usize) -> Option<u64> {
        if idx < self.first_index || idx >= self.len {
            return None;
        }
        if idx >= self.ring_start() {
            return Some(self.ring[idx - self.ring_start()].timestamp_ns);
        }
        let seg = idx / self.cfg.records_per_seg;
        let within = (idx % self.cfg.records_per_seg) * RECORD_SIZE;
        let bytes = &self.meta_segs[seg - self.meta_seg_base].map[within..within + 8];
        Some(u64::from_le_bytes(bytes.try_into().unwrap()))
    }

    /// Rebuild frame `idx` — from the ring if recent, else from the
    /// mappings.
    // `payload_off % / payload_seg_bytes` are bounded by the usize
    // `payload_seg_bytes`, so the within-segment casts cannot truncate.
    #[allow(clippy::cast_possible_truncation)]
    fn read_frame(&self, idx: usize) -> Option<RawTraceFrame> {
        if idx < self.first_index || idx >= self.len {
            return None;
        }
        if idx >= self.ring_start() {
            return Some(self.ring[idx - self.ring_start()].clone());
        }
        let seg = idx / self.cfg.records_per_seg;
        let within = (idx % self.cfg.records_per_seg) * RECORD_SIZE;
        let rec = MetaRecord::decode(
            &self.meta_segs[seg - self.meta_seg_base].map[within..within + RECORD_SIZE],
        );
        let data: &[u8] = if rec.payload_len == 0 {
            &[]
        } else {
            let pseg = (rec.payload_off / self.cfg.payload_seg_bytes as u64) as usize;
            let pwithin = (rec.payload_off % self.cfg.payload_seg_bytes as u64) as usize;
            &self.payload_segs[pseg - self.payload_seg_base].map
                [pwithin..pwithin + rec.payload_len as usize]
        };
        let payload = rebuild_payload(rec.kind, data);
        let bus_id = if rec.bus_idx == BUS_NONE {
            None
        } else {
            Some(self.bus_intern[rec.bus_idx as usize].clone())
        };
        Some(RawTraceFrame {
            timestamp_ns: rec.ts_ns,
            channel: rec.channel,
            id: rec.id,
            extended: rec.extended,
            direction: rec.direction,
            payload,
            bus_id,
        })
    }

    /// Payload offset recorded for row `idx`, read straight from the meta
    /// mapping (written on every append, so this is valid for any
    /// `[first_index, len)` row regardless of the RAM ring). Locates the
    /// lowest still-live payload byte when trimming payload segments.
    fn meta_payload_off(&self, idx: usize) -> u64 {
        let seg = idx / self.cfg.records_per_seg;
        let within = (idx % self.cfg.records_per_seg) * RECORD_SIZE;
        MetaRecord::decode(
            &self.meta_segs[seg - self.meta_seg_base].map[within..within + RECORD_SIZE],
        )
        .payload_off
    }

    /// Windowed-ring eviction (ADR 0002 DS-8): raise the low-water mark to
    /// `first_index`, dropping every *sealed* leading meta/payload segment
    /// that now falls entirely below it and deleting its file, so the
    /// scratch footprint follows the live window. Surviving rows keep their
    /// absolute index — only the floor moves, mapped through `meta_seg_base`
    /// / `payload_seg_base` — so `read_frame` still resolves them
    /// arithmetically and the read guard returns the evicted result for a row
    /// below the mark.
    ///
    /// Clamped to `[self.first_index, self.len]`: the floor only ever rises,
    /// and never past the live tail (the active tail segment is never
    /// dropped). This trims only the raw family; the by-id postings and
    /// derived caches front-trim against this same mark elsewhere.
    pub fn evict_below(&mut self, first_index: usize) {
        let first_index = first_index.clamp(self.first_index, self.len);
        self.first_index = first_index;
        // Meta segment `s` holds rows `[s*rps, (s+1)*rps)`, so it is wholly
        // below the mark iff `s < first_index / rps`. Never drop the segment
        // holding the live tail.
        let rps = self.cfg.records_per_seg;
        let tail_meta_seg = self.len.saturating_sub(1) / rps;
        let target_meta_base = (first_index / rps).min(tail_meta_seg);
        while self.meta_seg_base < target_meta_base {
            drop(self.meta_segs.remove(0)); // unmap before deleting (Windows)
            let _ = std::fs::remove_file(self.meta_seg_path(self.meta_seg_base));
            self.meta_seg_base += 1;
        }
        // The lowest live payload byte is the first live row's payload offset;
        // payload segments wholly below it are dead.
        if first_index < self.len {
            let min_off = self.meta_payload_off(first_index);
            let seg_bytes = self.cfg.payload_seg_bytes as u64;
            let tail_payload_seg = self.payload_cursor.saturating_sub(1) / seg_bytes;
            let target_payload_base =
                usize::try_from((min_off / seg_bytes).min(tail_payload_seg)).unwrap_or(0);
            while self.payload_seg_base < target_payload_base {
                drop(self.payload_segs.remove(0));
                let _ = std::fs::remove_file(self.payload_seg_path(self.payload_seg_base));
                self.payload_seg_base += 1;
            }
        }
        // The incremental-flush watermarks must not point below the new base.
        self.flushed_meta = self.flushed_meta.max(self.meta_seg_base);
        self.flushed_payload = self.flushed_payload.max(self.payload_seg_base);
        // Front-trim the always-on by-id index to the same mark — it is part
        // of the raw family's footprint and grows O(capture) (DS-8 / 6d).
        self.by_id.evict_below(first_index as u64);
    }
}

impl RawStore for DiskRawStore {
    fn append(&mut self, frame: RawTraceFrame) -> usize {
        let idx = self.len;
        let bus_idx = match &frame.bus_id {
            None => BUS_NONE,
            Some(name) => self.intern_bus(name),
        };
        let (kind, bytes) = split_payload(&frame.payload);
        let payload_len =
            u16::try_from(bytes.len()).expect("cannet-spill: payload exceeds 65535 bytes");
        let payload_off = self.place_payload(bytes);
        let rec = MetaRecord {
            ts_ns: frame.timestamp_ns,
            payload_off,
            payload_len,
            id: frame.id,
            bus_idx,
            channel: frame.channel,
            extended: frame.extended,
            direction: frame.direction,
            kind,
        };
        self.write_meta(idx, &rec.encode());
        self.by_id
            .push(frame.id, frame.extended, idx as u64);
        self.ring.push_back(frame);
        if self.ring.len() > self.cfg.ring_capacity {
            self.ring.pop_front();
        }
        self.len += 1;
        idx
    }

    fn len(&self) -> usize {
        self.len
    }

    fn first_index(&self) -> usize {
        self.first_index
    }

    fn clear(&mut self) {
        self.len = 0;
        self.payload_cursor = 0;
        self.ring = VecDeque::new();
        self.bus_intern = Vec::new();
        self.bus_rev = HashMap::new();
        // `remove_segment_files` drops the by-id mappings and deletes its
        // files along with the raw families.
        self.remove_segment_files()
            .expect("cannet-spill: clearing scratch segments failed");
    }

    fn slice(&self, start: usize, end: usize) -> Vec<RawTraceFrame> {
        if start >= self.len {
            return Vec::new();
        }
        let end = end.min(self.len);
        (start..end).filter_map(|i| self.read_frame(i)).collect()
    }

    fn frame_timestamps(&self, start: usize, end: usize) -> (Option<u64>, Option<u64>) {
        // Clamp the start up to the low-water mark so a range straddling
        // evicted rows still reports the first *live* timestamp.
        let start = start.max(self.first_index);
        let end = end.min(self.len);
        if start >= end {
            return (None, None);
        }
        let first = self.read_ts(start);
        let last = self.read_ts(end - 1);
        (first, last)
    }

    fn first_last_ts(&self) -> (Option<u64>, Option<u64>) {
        if self.first_index >= self.len {
            return (None, None);
        }
        (self.read_ts(self.first_index), self.read_ts(self.len - 1))
    }

    fn matching_frames_indexed(
        &self,
        id_raw: u32,
        extended: bool,
        start: usize,
        end: usize,
    ) -> Vec<(usize, RawTraceFrame)> {
        if start >= self.len {
            return Vec::new();
        }
        let end = end.min(self.len);
        self.by_id
            .range(id_raw, extended, start, end)
            .into_iter()
            .filter_map(|i| self.read_frame(i).map(|f| (i, f)))
            .collect()
    }

    fn scan_chunk(
        &self,
        start: usize,
        end: usize,
        keep: &dyn Fn(&RawTraceFrame) -> bool,
    ) -> Vec<usize> {
        if start >= self.len {
            return Vec::new();
        }
        let end = end.min(self.len);
        (start..end)
            .filter_map(|i| {
                self.read_frame(i)
                    .and_then(|f| keep(&f).then_some(i))
            })
            .collect()
    }

    fn frames_at(&self, idxs: &[usize]) -> Vec<(usize, RawTraceFrame)> {
        idxs.iter()
            .filter_map(|&i| self.read_frame(i).map(|f| (i, f)))
            .collect()
    }

    fn candidate_indices(&self, ids: &[(u32, bool)], start: usize, end: usize) -> Vec<usize> {
        if start >= self.len {
            return Vec::new();
        }
        self.by_id.merge_range(ids, start, end.min(self.len))
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_inner(true)
    }

    fn flush_async(&mut self) -> io::Result<()> {
        self.flush_inner(false)
    }

    fn evict_oldest_bytes(&mut self, bytes: u64) -> u64 {
        let mut freed = 0;
        while freed < bytes {
            // The next eviction target is the start of the segment after the
            // current base — advancing the floor by one meta segment.
            let next_first = (self.meta_seg_base + 1) * self.cfg.records_per_seg;
            if next_first >= self.len {
                break; // only the live tail segment remains
            }
            let before = self.raw_disk_bytes();
            self.evict_below(next_first);
            let after = self.raw_disk_bytes();
            if after >= before {
                break; // nothing dropped — guard against a stuck loop
            }
            freed += before - after;
        }
        freed
    }

    /// On-disk bytes of the mapped raw segments (meta + payload). Each
    /// segment is pre-allocated to full size, so its file is exactly that
    /// many bytes regardless of the valid-length watermark — the figure the
    /// windowed-ring cap sheds against (DS-8).
    fn raw_disk_bytes(&self) -> u64 {
        let meta = self.meta_segs.len() * self.cfg.records_per_seg * RECORD_SIZE;
        let payload = self.payload_segs.len() * self.cfg.payload_seg_bytes;
        (meta + payload) as u64
    }
}

#[cfg(test)]
#[allow(clippy::cast_possible_truncation)] // small loop counters into u8/u32 payloads
mod tests {
    use super::*;
    use cannet_core::{CanFdFlags, CanFramePayload, Direction};
    use tempfile::TempDir;

    fn frame(ts: u64, id: u32) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: ts,
            channel: 0,
            id,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(vec![(id & 0xff) as u8]),
            bus_id: None,
        }
    }

    fn tiny() -> DiskConfig {
        // Tiny segments + ring so a handful of frames exercises rollover
        // and ring eviction.
        DiskConfig {
            records_per_seg: 4,
            payload_seg_bytes: 64,
            ring_capacity: 3,
        }
    }

    #[test]
    fn frames_round_trip_through_disk() {
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::new(dir.path()).unwrap();
        for i in 0u32..10 {
            s.append(frame(u64::from(i) * 1000, i));
        }
        assert_eq!(s.len(), 10);
        let got = s.slice(0, 10);
        assert_eq!(got.len(), 10);
        for (i, f) in got.iter().enumerate() {
            assert_eq!(f.timestamp_ns, i as u64 * 1000);
            assert_eq!(f.id, i as u32);
            assert_eq!(f.payload.data(), &[(i & 0xff) as u8]);
        }
    }

    #[test]
    fn reads_every_row_past_the_ram_ring() {
        // ring_capacity is 3; storing 50 frames forces most reads to come
        // from the mappings, not the ring. Every row must read back.
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
        for i in 0u32..50 {
            s.append(frame(u64::from(i), i));
        }
        for i in 0..50 {
            let f = &s.slice(i, i + 1)[0];
            assert_eq!(f.id, i as u32, "row {i} mismatched");
            assert_eq!(f.timestamp_ns, i as u64);
        }
        // The whole-buffer span and a mid-range timestamp pair.
        assert_eq!(s.first_last_ts(), (Some(0), Some(49)));
        assert_eq!(s.frame_timestamps(10, 13), (Some(10), Some(12)));
    }

    #[test]
    fn reads_below_the_low_water_mark_are_evicted_not_panics() {
        // The read contract once windowed-ring eviction starts dropping the
        // oldest segments (ADR 0002). 6c raises the mark when it deletes the
        // files; here we set it directly and assert the read path tolerates
        // a row below it — returns the evicted result (`None`), never
        // indexes a (would-be) dropped segment and panics.
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
        for i in 0u32..20 {
            s.append(frame(u64::from(i) * 10, i));
        }
        s.first_index = 8; // simulate the oldest 8 rows evicted
        for i in 0..8 {
            assert!(s.read_frame(i).is_none(), "row {i} below mark must be evicted");
            assert!(s.read_ts(i).is_none(), "ts {i} below mark must be evicted");
        }
        for i in 8..20 {
            assert!(s.read_frame(i).is_some(), "row {i} at/above mark must read");
        }
        // The whole-buffer span starts at the mark, not the hardcoded 0.
        assert_eq!(s.first_last_ts(), (Some(80), Some(190)));
        // A slice straddling the mark drops the evicted prefix and returns
        // only the live tail.
        let got = s.slice(0, 20);
        assert_eq!(got.len(), 12);
        assert_eq!(got[0].id, 8);
        // frame_timestamps over a straddling range clamps to the mark.
        assert_eq!(s.frame_timestamps(0, 20), (Some(80), Some(190)));
        // A by-id read whose hits are all below the mark comes back empty.
        assert!(s.matching_frames_indexed(3, false, 0, 20).is_empty());
    }

    #[test]
    fn evict_below_drops_oldest_meta_segments_and_files() {
        // 6c-A windowed-ring eviction (ADR 0002 DS-8): raising the mark drops
        // the leading meta segments that fall *entirely* below it and deletes
        // their files, while surviving rows keep their absolute index.
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap(); // rps = 4
        for i in 0u32..20 {
            s.append(frame(u64::from(i) * 10, i));
        }
        assert_eq!(s.meta_segs.len(), 5, "rows 0..20 fill 5 meta segments");
        s.evict_below(8);
        assert_eq!(s.first_index, 8);
        // Segments 0 and 1 (rows 0..8) are wholly below the mark and dropped;
        // segment 2 holds the first live row (8) and is kept.
        assert_eq!(s.meta_seg_base, 2);
        assert_eq!(s.meta_segs.len(), 3);
        assert!(!dir.path().join("meta.000000").exists(), "seg 0 file deleted");
        assert!(!dir.path().join("meta.000001").exists(), "seg 1 file deleted");
        assert!(dir.path().join("meta.000002").exists(), "seg 2 file kept");
        for i in 0..8 {
            assert!(s.read_frame(i).is_none(), "row {i} evicted");
        }
        for i in 8..20 {
            let f = s.read_frame(i).expect("live row reads across the base shift");
            assert_eq!(f.id, i as u32);
            assert_eq!(f.timestamp_ns, i as u64 * 10);
        }
        assert_eq!(s.first_last_ts(), (Some(80), Some(190)));
        // Appends continue from the tip with the floor in place.
        let idx = s.append(frame(9999, 99));
        assert_eq!(idx, 20);
        assert_eq!(s.read_frame(20).unwrap().id, 99);
    }

    #[test]
    fn evict_below_drops_oldest_payload_segments() {
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap(); // payload_seg_bytes = 64
        for i in 0u32..20 {
            let mut f = frame(u64::from(i), i);
            f.payload = CanFramePayload::Classic(vec![i as u8; 20]); // 20 B each
            s.append(f);
        }
        let payload_files = |d: &std::path::Path| {
            std::fs::read_dir(d)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with("payload."))
                .count()
        };
        let before = payload_files(dir.path());
        assert!(before >= 5, "20-byte payloads span several payload segments");
        s.evict_below(12);
        assert!(
            payload_files(dir.path()) < before,
            "payload segments wholly below the mark are reclaimed",
        );
        // Live rows still rebuild their payload across the payload base shift.
        for i in 12..20usize {
            assert_eq!(
                s.read_frame(i).unwrap().payload.data(),
                vec![i as u8; 20].as_slice(),
            );
        }
    }

    #[test]
    fn reopen_after_eviction_restores_the_floor() {
        let dir = TempDir::new().unwrap();
        {
            let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
            for i in 0u32..20 {
                s.append(frame(u64::from(i) * 10, i));
            }
            s.evict_below(8);
            s.flush().unwrap();
        }
        let s = DiskRawStore::reopen(dir.path()).unwrap().expect("manifest present");
        assert_eq!(s.len(), 20);
        assert_eq!(s.first_index, 8, "the floor reloads from the manifest");
        for i in 0..8 {
            assert!(s.read_frame(i).is_none(), "row {i} stays evicted after reopen");
        }
        for i in 8..20 {
            let f = s.read_frame(i).expect("live row after reopen");
            assert_eq!(f.id, i as u32);
            assert_eq!(f.timestamp_ns, i as u64 * 10);
        }
        assert_eq!(s.first_last_ts(), (Some(80), Some(190)));
    }

    #[test]
    fn evict_oldest_bytes_holds_the_window_and_keeps_the_tail() {
        // 6c-B cap primitive (ADR 0002 DS-8): shed the oldest raw segments
        // until at least the requested bytes are freed, never dropping the
        // live tail.
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
        for i in 0u32..40 {
            let mut f = frame(u64::from(i) * 5, i);
            f.payload = CanFramePayload::Classic(vec![i as u8; 20]); // grow payload segs too
            s.append(f);
        }
        let full = s.raw_disk_bytes();
        let target = full / 2;
        let freed = s.evict_oldest_bytes(target);
        assert!(freed >= target, "frees at least the requested {target} bytes (got {freed})");
        assert_eq!(s.raw_disk_bytes(), full - freed, "footprint drops by exactly what was freed");
        assert!(s.first_index > 0 && s.first_index < 40, "the floor moved into the window");
        for i in 0..s.first_index {
            assert!(s.read_frame(i).is_none(), "row {i} evicted");
        }
        let fi = s.first_index;
        for i in fi..40 {
            let f = s.read_frame(i).expect("live row");
            assert_eq!(f.id, i as u32);
            assert_eq!(f.timestamp_ns, i as u64 * 5);
            assert_eq!(f.payload.data(), vec![i as u8; 20].as_slice());
        }
        // The tail is never dropped, even asking for more than the whole store.
        let freed_all = s.evict_oldest_bytes(u64::MAX);
        assert!(s.read_frame(39).is_some(), "live tail survives an over-large request");
        let _ = freed_all;
    }

    #[test]
    fn reopen_after_eviction_restores_by_id_postings() {
        // 6d: by-id front-trims with the raw store (DiskRawStore::evict_below
        // calls by_id.evict_below), and the per-id first_slot persists so a
        // reopen across the eviction serves the same windowed by-id reads.
        let dir = TempDir::new().unwrap();
        {
            let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
            for i in 0u32..300 {
                s.append(frame(u64::from(i), 7)); // hot id 7 at every index
            }
            s.evict_below(100);
            s.flush().unwrap();
        }
        let s = DiskRawStore::reopen(dir.path()).unwrap().expect("manifest present");
        assert_eq!(s.first_index, 100);
        // by-id reads above the mark survive the reopen.
        let hits: Vec<usize> = s
            .matching_frames_indexed(7, false, 100, 300)
            .into_iter()
            .map(|(i, _)| i)
            .collect();
        assert_eq!(hits, (100..300).collect::<Vec<usize>>());
        // A read spanning the mark drops the evicted prefix (raw guard).
        let spanning: Vec<usize> = s
            .matching_frames_indexed(7, false, 0, 300)
            .into_iter()
            .map(|(i, _)| i)
            .collect();
        assert_eq!(spanning, (100..300).collect::<Vec<usize>>());
    }

    #[test]
    fn segment_rollover_is_exercised() {
        // records_per_seg = 4, payload_seg_bytes = 64. 30 frames spans
        // several metadata segments; multi-byte payloads span several
        // payload segments (with boundary padding).
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
        for i in 0u32..30 {
            let mut f = frame(u64::from(i), i);
            f.payload = CanFramePayload::Classic(vec![i as u8; 20]); // 20 B each
            s.append(f);
        }
        assert!(s.meta_segs.len() >= 7, "expected metadata rollover");
        assert!(s.payload_segs.len() >= 2, "expected payload rollover");
        for i in 0..30 {
            let f = &s.slice(i, i + 1)[0];
            assert_eq!(f.payload.data(), vec![i as u8; 20].as_slice());
        }
    }

    #[test]
    fn payload_never_straddles_a_segment_boundary() {
        // 64-byte payload segments; a 50-byte payload at offset 50 would
        // straddle, so it must pad to the next segment. Both read back.
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
        let mut a = frame(1, 1);
        a.payload = CanFramePayload::Classic(vec![0xaa; 50]);
        let mut b = frame(2, 2);
        b.payload = CanFramePayload::Classic(vec![0xbb; 50]);
        s.append(a);
        s.append(b);
        assert_eq!(s.slice(0, 1)[0].payload.data(), vec![0xaa; 50].as_slice());
        assert_eq!(s.slice(1, 2)[0].payload.data(), vec![0xbb; 50].as_slice());
        assert!(s.payload_segs.len() >= 2, "second payload padded to next seg");
    }

    #[test]
    fn round_trips_fd_remote_error_and_bus_interning() {
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
        let mut fd = frame(1, 0x10);
        fd.payload = CanFramePayload::Fd {
            data: vec![1, 2, 3, 4],
            flags: CanFdFlags {
                bitrate_switch: true,
                error_state_indicator: false,
            },
        };
        fd.extended = true;
        fd.direction = Direction::Tx;
        fd.bus_id = Some("pt".into());
        let mut rem = frame(2, 0x11);
        rem.payload = CanFramePayload::Remote { dlc: 6 };
        rem.bus_id = Some("body".into());
        let mut err = frame(3, 0x12);
        err.payload = CanFramePayload::Error;
        err.bus_id = Some("pt".into()); // re-uses interned index 0
        s.append(fd.clone());
        s.append(rem.clone());
        s.append(err.clone());
        // Force reads from the mappings, not the ring.
        for _ in 0..5 {
            s.append(frame(100, 0x99));
        }
        assert_eq!(s.read_frame(0), Some(fd));
        assert_eq!(s.read_frame(1), Some(rem));
        assert_eq!(s.read_frame(2), Some(err));
        assert_eq!(s.bus_intern, vec!["pt".to_string(), "body".to_string()]);
    }

    #[test]
    fn matching_frames_indexed_uses_by_id() {
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
        for (i, id) in [7u32, 3, 7, 3, 7, 9].into_iter().enumerate() {
            s.append(frame(u64::try_from(i).unwrap() * 1000, id));
        }
        let pairs = s.matching_frames_indexed(7, false, 1, 5);
        assert_eq!(
            pairs.iter().map(|(i, f)| (*i, f.id)).collect::<Vec<_>>(),
            vec![(2, 7), (4, 7)],
        );
        assert!(s.matching_frames_indexed(7, true, 0, 6).is_empty());
    }

    #[test]
    fn scan_chunk_and_frames_at_address_by_index() {
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
        for i in 0u32..10 {
            s.append(frame(0, if i % 2 == 0 { 256 } else { 999 }));
        }
        let hits = s.scan_chunk(0, 10, &|f| f.id == 256);
        assert_eq!(hits, vec![0, 2, 4, 6, 8]);
        let page = s.frames_at(&[8, 1]);
        assert_eq!(
            page.iter().map(|(i, f)| (*i, f.id)).collect::<Vec<_>>(),
            vec![(8, 256), (1, 999)],
        );
    }

    #[test]
    fn clear_resets_and_removes_segment_files() {
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
        for i in 0u32..10 {
            s.append(frame(0, i));
        }
        s.clear();
        assert_eq!(s.len(), 0);
        assert!(s.slice(0, 5).is_empty());
        let leftover = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| {
                let n = e.file_name();
                let n = n.to_string_lossy();
                n.starts_with("meta.") || n.starts_with("payload.")
            });
        assert!(!leftover, "segment files should be gone after clear");
        // Usable again after clear.
        s.append(frame(42, 1));
        assert_eq!(s.slice(0, 1)[0].timestamp_ns, 42);
    }

    #[test]
    fn flush_persists_without_changing_reads() {
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
        for i in 0u32..10 {
            s.append(frame(u64::from(i), i));
        }
        s.flush().unwrap();
        assert_eq!(s.slice(0, 10).len(), 10);
    }

    #[test]
    fn reopen_round_trips_frames_payloads_and_buses() {
        // Append a mix (FD / remote / error / interned buses, plus plain
        // frames spanning several metadata segments and overflowing the
        // RAM ring), flush, drop, and reopen the same directory. Every row
        // — ring tail and mapped body alike — must read back identically,
        // and the bus-intern table (RAM-only, manifest-restored) too.
        let dir = TempDir::new().unwrap();
        let mut fd = frame(1, 0x10);
        fd.payload = CanFramePayload::Fd {
            data: vec![1, 2, 3, 4],
            flags: CanFdFlags {
                bitrate_switch: true,
                error_state_indicator: false,
            },
        };
        fd.extended = true;
        fd.direction = Direction::Tx;
        fd.bus_id = Some("pt".into());
        let mut rem = frame(2, 0x11);
        rem.payload = CanFramePayload::Remote { dlc: 6 };
        rem.bus_id = Some("body".into());
        let mut err = frame(3, 0x12);
        err.payload = CanFramePayload::Error;
        err.bus_id = Some("pt".into());
        {
            let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
            s.append(fd.clone());
            s.append(rem.clone());
            s.append(err.clone());
            for i in 0u32..12 {
                s.append(frame(u64::from(i) + 100, i));
            }
            s.flush().unwrap();
        } // store dropped — mappings released, only the files remain

        let s = DiskRawStore::reopen(dir.path()).unwrap().expect("manifest present");
        assert_eq!(s.len(), 15);
        assert_eq!(s.read_frame(0), Some(fd));
        assert_eq!(s.read_frame(1), Some(rem));
        assert_eq!(s.read_frame(2), Some(err));
        for i in 0u32..12 {
            let f = &s.slice(3 + i as usize, 4 + i as usize)[0];
            assert_eq!(f.id, i);
            assert_eq!(f.timestamp_ns, u64::from(i) + 100);
        }
        assert_eq!(s.bus_intern, vec!["pt".to_string(), "body".to_string()]);
        assert_eq!(s.first_last_ts(), (Some(1), Some(111)));
    }

    #[test]
    fn incremental_flush_across_segment_seals_stays_durable() {
        // The incremental flush only re-syncs from the previously-active
        // segment forward. Flush *repeatedly while appending across seals*
        // — the tiny config seals a meta segment every 4 frames, and 200
        // frames of one hot id overflow the by-id chain (64, 128, … entry
        // segments). Flushing every 7 frames lands mid-segment and across
        // seals on alternating ticks, so a missed watermark seam would drop
        // a just-sealed segment's final bytes. Reopen must still return
        // every frame and the full by-id posting.
        let dir = TempDir::new().unwrap();
        {
            let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
            for i in 0u32..200 {
                s.append(frame(u64::from(i), 7));
                if i % 7 == 0 {
                    s.flush().unwrap();
                }
            }
            s.flush().unwrap();
        } // dropped — only the files (and what the flushes made durable) remain
        let s = DiskRawStore::reopen(dir.path()).unwrap().expect("manifest present");
        assert_eq!(s.len(), 200);
        for i in 0u32..200 {
            let f = &s.slice(i as usize, i as usize + 1)[0];
            assert_eq!(f.timestamp_ns, u64::from(i), "frame {i} lost after incremental flush");
        }
        // The by-id chain — also incrementally flushed — reopened intact.
        assert_eq!(s.matching_frames_indexed(7, false, 0, 200).len(), 200);
    }

    #[test]
    fn reopen_rebuilds_geometric_byid_chains() {
        // 300 frames of id 7 overflow the first by-id segments (64, 128,
        // 256, …) — the geometric chain. Reopen must rebuild it from the
        // persisted length alone and serve the same windowed by-id reads.
        let dir = TempDir::new().unwrap();
        {
            let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
            for i in 0u32..300 {
                s.append(frame(u64::from(i), if i % 3 == 0 { 9 } else { 7 }));
            }
            s.flush().unwrap();
        }
        let s = DiskRawStore::reopen(dir.path()).unwrap().expect("manifest present");
        assert_eq!(s.len(), 300);
        // id 7 is every index not divisible by 3.
        let want: Vec<usize> = (0..300).filter(|i| i % 3 != 0).collect();
        let got: Vec<usize> = s
            .matching_frames_indexed(7, false, 0, 300)
            .into_iter()
            .map(|(i, _)| i)
            .collect();
        assert_eq!(got, want);
        // A windowed by-id read across a segment boundary still pages.
        let mid: Vec<usize> = s
            .matching_frames_indexed(9, false, 100, 200)
            .into_iter()
            .map(|(i, _)| i)
            .collect();
        assert_eq!(mid, (100..200).filter(|i| i % 3 == 0).collect::<Vec<_>>());
    }

    #[test]
    fn reopen_then_append_continues_from_the_watermark() {
        let dir = TempDir::new().unwrap();
        {
            let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
            for i in 0u32..5 {
                s.append(frame(u64::from(i), i));
            }
            s.flush().unwrap();
        }
        let mut s = DiskRawStore::reopen(dir.path()).unwrap().unwrap();
        let idx = s.append(frame(500, 99));
        assert_eq!(idx, 5);
        assert_eq!(s.len(), 6);
        assert_eq!(s.slice(5, 6)[0].id, 99);
        // The earlier rows are still intact alongside the new one.
        assert_eq!(s.slice(0, 1)[0].id, 0);
    }

    #[test]
    fn reopen_without_a_manifest_is_none() {
        // Empty dir: nothing to reload.
        let dir = TempDir::new().unwrap();
        assert!(DiskRawStore::reopen(dir.path()).unwrap().is_none());
        // Frames appended but never flushed leave no manifest either.
        let other = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(other.path(), tiny()).unwrap();
        s.append(frame(0, 1));
        drop(s);
        assert!(DiskRawStore::reopen(other.path()).unwrap().is_none());
    }

    #[test]
    fn clear_removes_the_manifest_so_a_cleared_store_does_not_reload() {
        let dir = TempDir::new().unwrap();
        let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
        for i in 0u32..5 {
            s.append(frame(0, i));
        }
        s.flush().unwrap();
        s.clear();
        drop(s);
        assert!(DiskRawStore::reopen(dir.path()).unwrap().is_none());
    }

    #[test]
    fn open_empty_presents_empty_but_preserves_the_files_for_reopen() {
        // Launch semantics: a prior flushed session is left intact and the
        // store still presents empty, so the gate can reopen it later.
        let dir = TempDir::new().unwrap();
        {
            let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
            for i in 0u32..5 {
                s.append(frame(0, i));
            }
            s.flush().unwrap();
        }
        let empty = DiskRawStore::open_empty(dir.path()).unwrap();
        assert_eq!(empty.len(), 0, "presents empty");
        drop(empty);
        // The files survived, so a reopen still recovers the prior session.
        assert_eq!(
            DiskRawStore::reopen(dir.path()).unwrap().unwrap().len(),
            5,
            "files preserved for reopen"
        );
    }

    #[test]
    fn reopen_rejects_a_corrupt_manifest() {
        let dir = TempDir::new().unwrap();
        {
            let mut s = DiskRawStore::with_config(dir.path(), tiny()).unwrap();
            s.append(frame(0, 1));
            s.flush().unwrap();
        }
        std::fs::write(dir.path().join("manifest.json"), b"{ not json").unwrap();
        assert!(DiskRawStore::reopen(dir.path()).is_err());
    }
}
