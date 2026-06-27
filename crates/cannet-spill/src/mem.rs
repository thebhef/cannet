//! In-RAM `Vec`-backed raw store — the test double (ADR 0002 DS-6).
//!
//! Holds frames in a `Vec` and the `by-id` index in a `HashMap`. Simple
//! and allocation-cheap; used by unit tests and the perf harness. The
//! disk store ([`crate::DiskRawStore`]) is the production path.

use std::collections::HashMap;

use crate::{RawStore, RawTraceFrame};

/// Arbitration key for the `by-id` index: id value plus addressing mode
/// (a standard and an extended frame with the same numeric id are
/// distinct).
type IdKey = (u32, bool);

/// `Vec`-backed [`RawStore`]. See the module docs.
#[derive(Default)]
pub struct MemRawStore {
    frames: Vec<RawTraceFrame>,
    by_id: HashMap<IdKey, Vec<usize>>,
}

impl MemRawStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl RawStore for MemRawStore {
    fn append(&mut self, frame: RawTraceFrame) -> usize {
        let idx = self.frames.len();
        self.by_id
            .entry((frame.id, frame.extended))
            .or_default()
            .push(idx);
        self.frames.push(frame);
        idx
    }

    fn len(&self) -> usize {
        self.frames.len()
    }

    fn clear(&mut self) {
        // Fresh allocations (not `clear()`) so a small session after a
        // large one returns the backing memory to the allocator.
        self.frames = Vec::new();
        self.by_id = HashMap::new();
    }

    fn slice(&self, start: usize, end: usize) -> Vec<RawTraceFrame> {
        let len = self.frames.len();
        if start >= len {
            return Vec::new();
        }
        self.frames[start..end.min(len)].to_vec()
    }

    fn frame_timestamps(&self, start: usize, end: usize) -> (Option<u64>, Option<u64>) {
        let len = self.frames.len();
        if start >= len {
            return (None, None);
        }
        let end = end.min(len);
        let first = self.frames.get(start).map(|f| f.timestamp_ns);
        let last = end
            .checked_sub(1)
            .and_then(|i| self.frames.get(i))
            .map(|f| f.timestamp_ns);
        (first, last)
    }

    fn first_last_ts(&self) -> (Option<u64>, Option<u64>) {
        (
            self.frames.first().map(|f| f.timestamp_ns),
            self.frames.last().map(|f| f.timestamp_ns),
        )
    }

    fn matching_frames_indexed(
        &self,
        id_raw: u32,
        extended: bool,
        start: usize,
        end: usize,
    ) -> Vec<(usize, RawTraceFrame)> {
        let len = self.frames.len();
        if start >= len {
            return Vec::new();
        }
        let end = end.min(len);
        match self.by_id.get(&(id_raw, extended)) {
            Some(frame_idxs) => {
                let lo = frame_idxs.partition_point(|&i| i < start);
                let hi = frame_idxs.partition_point(|&i| i < end);
                frame_idxs[lo..hi]
                    .iter()
                    .map(|&i| (i, self.frames[i].clone()))
                    .collect()
            }
            None => Vec::new(),
        }
    }

    fn scan_chunk(
        &self,
        start: usize,
        end: usize,
        keep: &dyn Fn(&RawTraceFrame) -> bool,
    ) -> Vec<usize> {
        let len = self.frames.len();
        if start >= len {
            return Vec::new();
        }
        let end = end.min(len);
        self.frames[start..end]
            .iter()
            .enumerate()
            .filter_map(|(i, frame)| keep(frame).then_some(start + i))
            .collect()
    }

    fn frames_at(&self, idxs: &[usize]) -> Vec<(usize, RawTraceFrame)> {
        idxs.iter()
            .filter_map(|&i| self.frames.get(i).map(|frame| (i, frame.clone())))
            .collect()
    }
}
