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

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};

use crate::byid::{ByIdIndex, BYID_PREFIX};
use crate::record::{rebuild_payload, split_payload, MetaRecord, BUS_NONE, RECORD_SIZE};
use crate::seg::{create_segment, remove_files_with_prefixes, Segment};
use crate::{RawStore, RawTraceFrame};

/// Segment sizing and the RAM-ring depth. Defaults suit production; tests
/// shrink them to exercise rollover and ring eviction cheaply.
#[derive(Debug, Clone, Copy)]
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
    /// Global next-write byte offset into the logical payload blob.
    payload_cursor: u64,
    meta_segs: Vec<Segment>,
    payload_segs: Vec<Segment>,
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
            payload_cursor: 0,
            meta_segs: Vec::new(),
            payload_segs: Vec::new(),
            ring: VecDeque::new(),
            bus_intern: Vec::new(),
            bus_rev: HashMap::new(),
        };
        store.remove_segment_files()?;
        Ok(store)
    }

    fn meta_seg_path(&self, i: usize) -> PathBuf {
        self.dir.join(format!("meta.{i:06}"))
    }

    fn payload_seg_path(&self, i: usize) -> PathBuf {
        self.dir.join(format!("payload.{i:06}"))
    }

    /// Drop every mapping and delete the segment files from `dir`. Maps
    /// are dropped first so Windows lets the files be removed.
    fn remove_segment_files(&mut self) -> io::Result<()> {
        self.meta_segs.clear();
        self.payload_segs.clear();
        self.by_id.clear();
        remove_files_with_prefixes(&self.dir, &["meta.", "payload.", BYID_PREFIX])
    }

    fn ensure_meta_seg(&mut self, seg: usize) {
        while self.meta_segs.len() <= seg {
            let i = self.meta_segs.len();
            let bytes = self.cfg.records_per_seg * RECORD_SIZE;
            let s = create_segment(&self.meta_seg_path(i), bytes)
                .expect("cannet-spill: metadata segment I/O failed");
            self.meta_segs.push(s);
        }
    }

    fn ensure_payload_seg(&mut self, seg: usize) {
        while self.payload_segs.len() <= seg {
            let i = self.payload_segs.len();
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
        self.payload_segs[seg].map[within..within + bytes.len()].copy_from_slice(bytes);
        self.payload_cursor = off + bytes.len() as u64;
        off
    }

    fn write_meta(&mut self, idx: usize, bytes: &[u8; RECORD_SIZE]) {
        let seg = idx / self.cfg.records_per_seg;
        self.ensure_meta_seg(seg);
        let within = (idx % self.cfg.records_per_seg) * RECORD_SIZE;
        self.meta_segs[seg].map[within..within + RECORD_SIZE].copy_from_slice(bytes);
    }

    /// The lowest index currently mirrored in the RAM ring.
    fn ring_start(&self) -> usize {
        self.len - self.ring.len()
    }

    /// Read the timestamp of frame `idx` without rebuilding the payload.
    fn read_ts(&self, idx: usize) -> Option<u64> {
        if idx >= self.len {
            return None;
        }
        if idx >= self.ring_start() {
            return Some(self.ring[idx - self.ring_start()].timestamp_ns);
        }
        let seg = idx / self.cfg.records_per_seg;
        let within = (idx % self.cfg.records_per_seg) * RECORD_SIZE;
        let bytes = &self.meta_segs[seg].map[within..within + 8];
        Some(u64::from_le_bytes(bytes.try_into().unwrap()))
    }

    /// Rebuild frame `idx` — from the ring if recent, else from the
    /// mappings.
    // `payload_off % / payload_seg_bytes` are bounded by the usize
    // `payload_seg_bytes`, so the within-segment casts cannot truncate.
    #[allow(clippy::cast_possible_truncation)]
    fn read_frame(&self, idx: usize) -> Option<RawTraceFrame> {
        if idx >= self.len {
            return None;
        }
        if idx >= self.ring_start() {
            return Some(self.ring[idx - self.ring_start()].clone());
        }
        let seg = idx / self.cfg.records_per_seg;
        let within = (idx % self.cfg.records_per_seg) * RECORD_SIZE;
        let rec = MetaRecord::decode(&self.meta_segs[seg].map[within..within + RECORD_SIZE]);
        let data: &[u8] = if rec.payload_len == 0 {
            &[]
        } else {
            let pseg = (rec.payload_off / self.cfg.payload_seg_bytes as u64) as usize;
            let pwithin = (rec.payload_off % self.cfg.payload_seg_bytes as u64) as usize;
            &self.payload_segs[pseg].map[pwithin..pwithin + rec.payload_len as usize]
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
        if start >= self.len {
            return (None, None);
        }
        let end = end.min(self.len);
        let first = self.read_ts(start);
        let last = end.checked_sub(1).and_then(|i| self.read_ts(i));
        (first, last)
    }

    fn first_last_ts(&self) -> (Option<u64>, Option<u64>) {
        if self.len == 0 {
            return (None, None);
        }
        (self.read_ts(0), self.read_ts(self.len - 1))
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

    fn flush(&mut self) -> io::Result<()> {
        if let Some(s) = self.meta_segs.last() {
            s.map.flush()?;
        }
        if let Some(s) = self.payload_segs.last() {
            s.map.flush()?;
        }
        Ok(())
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
}
