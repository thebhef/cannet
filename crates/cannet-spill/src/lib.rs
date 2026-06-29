//! Raw frame storage for the trace model — the swappable backend behind
//! the GUI's `TraceStore` facade.
//!
//! The trace model is one append-only sequence of [`RawTraceFrame`]s plus
//! a pile of derived state (per-id rates, newest-per-id, etc.). The
//! *derived* state is small (bounded by id-space) and lives in the host's
//! `TraceStore`. The *raw frame bytes* are the part that grows with
//! capture length, so they sit behind the [`RawStore`] trait, which has
//! two implementations:
//!
//! - [`MemRawStore`] — a `Vec`-backed store. The test double
//!   ([ADR 0002](../../../docs/adr/0002-disk-spill-store.md) DS-6): simple,
//!   in-RAM, used by unit tests and benchmarks.
//! - [`DiskRawStore`] — the production store: append-only mmap'd segment
//!   files (DS-1, DS-2, DS-4) that spill the raw store to disk so a
//!   capture can outgrow RAM while every historical row stays
//!   random-access addressable.
//!
//! This crate is the one place the workspace's `unsafe_code = "forbid"`
//! policy is relaxed to `deny` (see `Cargo.toml`): mapping a file is
//! `unsafe` by nature, and ADR 0002 chose `memmap2` for it. Containing
//! that to a small, focused crate keeps the failure-mode-rich surface
//! reviewable and leaves every other crate `unsafe`-free.

mod byid;
mod disk;
mod filter_index;
mod mem;
mod record;
mod sample_seq;
mod seg;

pub use disk::{DiskConfig, DiskRawStore};
pub use filter_index::FilterIndex;
pub use mem::MemRawStore;
pub use sample_seq::SampleSeq;

// `CandidateSource` is defined below alongside `RawStore`.

use cannet_core::{CanFrame, CanFramePayload, Direction};

/// One row in the trace store. Owned, undecoded.
///
/// `bus_id` is the project's logical bus this frame was routed onto —
/// `None` if no binding/mapping assigned one. Pump threads stamp it
/// before appending; per-bus DBC scoping and the filter predicate both
/// read it. `channel` keeps its meaning (the source's 0-based channel
/// number) and is what the user maps onto a `bus_id` at import / connect
/// time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawTraceFrame {
    pub timestamp_ns: u64,
    pub channel: u8,
    pub id: u32,
    pub extended: bool,
    pub direction: Direction,
    pub payload: CanFramePayload,
    pub bus_id: Option<String>,
}

impl From<CanFrame> for RawTraceFrame {
    fn from(frame: CanFrame) -> Self {
        Self {
            timestamp_ns: frame.timestamp_ns,
            channel: frame.channel,
            id: frame.id.raw(),
            extended: frame.id.is_extended(),
            direction: frame.direction,
            payload: frame.payload,
            bus_id: None,
        }
    }
}

/// The append-only raw frame storage behind the `TraceStore` facade.
///
/// Implementations differ only in *where the bytes live* (a `Vec` for the
/// test double, mmap'd disk segments for production); the contract is the
/// same so the host swaps one for the other without reshaping callers
/// ([ADR 0025](../../../docs/adr/0025-frontend-windowed-source-contract.md):
/// the `RowPage` accessor signatures are store-independent).
///
/// Frames are addressed by a dense 0-based index assigned at append. The
/// trait also owns the always-on `by-id` index ([`Self::matching_frames_indexed`]),
/// because for the disk store that index is itself materialized on disk
/// (DS-3) — it is part of "where the bytes live," not derived host state.
pub trait RawStore: Send {
    /// Append a frame and return the index it was stored at (the prior
    /// length). Maintains the `by-id` index.
    fn append(&mut self, frame: RawTraceFrame) -> usize;

    /// Number of frames currently stored.
    fn len(&self) -> usize;

    /// Whether the store holds no frames.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The windowed-ring low-water mark ([ADR 0002](../../../docs/adr/0002-disk-spill-store.md)
    /// DS-8): the lowest still-addressable row index. `0` until eviction
    /// front-trims the oldest rows; the live range is `[first_index, len)`.
    /// Defaults to `0` for the in-RAM double, which never evicts.
    fn first_index(&self) -> usize {
        0
    }

    /// Drop every frame and reset to empty (a new session / Clear).
    fn clear(&mut self);

    /// Cloned frames in the clamped range `[start, end)`. An out-of-range
    /// `start` yields an empty `Vec`; an over-large `end` clamps.
    fn slice(&self, start: usize, end: usize) -> Vec<RawTraceFrame>;

    /// First-and-last frame timestamps for the clamped range
    /// `[start, end)`, without cloning frames.
    fn frame_timestamps(&self, start: usize, end: usize) -> (Option<u64>, Option<u64>);

    /// Timestamps of the oldest and newest stored frame (the whole-buffer
    /// span), without cloning frames.
    fn first_last_ts(&self) -> (Option<u64>, Option<u64>);

    /// For one `(id, extended)` arbitration key: the matching frames in
    /// `[start, end)` paired with their store index, via the `by-id`
    /// index (so the work is `O(matches + log n)`, not `O(window)`).
    fn matching_frames_indexed(
        &self,
        id_raw: u32,
        extended: bool,
        start: usize,
        end: usize,
    ) -> Vec<(usize, RawTraceFrame)>;

    /// Scan the clamped range `[start, end)`, test each frame with `keep`,
    /// and return the absolute indices of the matches in ascending order.
    /// Nothing is cloned. The bounded unit of a filtered scan — the caller
    /// chunks a large window so the store lock is released between chunks.
    fn scan_chunk(&self, start: usize, end: usize, keep: &dyn Fn(&RawTraceFrame) -> bool)
        -> Vec<usize>;

    /// Clone the frames at the given absolute indices, each paired with
    /// its index, in `idxs` order; indices past the end are skipped.
    fn frames_at(&self, idxs: &[usize]) -> Vec<(usize, RawTraceFrame)>;

    /// Ascending frame indices in `[start, end)` whose `(id, extended)`
    /// is in `ids` — the by-id-narrowed candidate set a filter index
    /// builds from. It visits only those ids' frames (via the `by-id`
    /// index), never the whole window, so a selective filter is
    /// `O(candidate occurrences)`, not `O(window)`. `ids` need not be
    /// sorted or unique; the result is sorted and (since a frame has one
    /// id) duplicate-free.
    fn candidate_indices(&self, ids: &[(u32, bool)], start: usize, end: usize) -> Vec<usize>;

    /// Flush buffered writes to the backing store **durably**. A no-op for
    /// the in-RAM double; for the disk store a synchronous `msync` of the
    /// active segments (waits for the bytes to reach the device) plus the
    /// reopen manifest. The crash-hardening path — use on clean shutdown.
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }

    /// Flush buffered writes **without** waiting for the device — an
    /// asynchronous `msync` (queues writeback) plus the manifest. The OS
    /// page cache still makes every write visible to a reopen in the same
    /// session, so this preserves reopen-after-process-restart (the
    /// ephemeral scratch's durability contract, [ADR 0002](../../../docs/adr/0002-disk-spill-store.md)
    /// DS-2); only a power loss before writeback could lose the trailing
    /// window. The periodic-flush path, where waiting on the device would
    /// hold the append lock. Defaults to [`Self::flush`] for stores with no
    /// async distinction (the in-RAM double).
    fn flush_async(&mut self) -> std::io::Result<()> {
        self.flush()
    }

    /// Windowed-ring eviction ([ADR 0002](../../../docs/adr/0002-disk-spill-store.md)
    /// DS-8): drop the oldest raw segments until at least `bytes` of on-disk
    /// footprint have been freed, or only the live tail remains. Returns the
    /// bytes actually freed. Trims only the raw meta/payload family — by-id
    /// and the derived caches front-trim against the same low-water mark
    /// elsewhere. Defaults to a no-op for the in-RAM double, which never
    /// spills.
    fn evict_oldest_bytes(&mut self, bytes: u64) -> u64 {
        let _ = bytes;
        0
    }

    /// On-disk bytes of the raw meta/payload family — the share of the
    /// scratch dir this store is responsible for. The cap bounds the *whole*
    /// dir (raw + derived caches), so the host scales an eviction request by
    /// this share before calling [`Self::evict_oldest_bytes`]. `0` for the
    /// in-RAM double, which never spills.
    fn raw_disk_bytes(&self) -> u64 {
        0
    }
}

/// The read-only surface a [`FilterIndex`] builds against: enough to walk
/// the by-id-narrowed candidate frames and read them.
///
/// Every [`RawStore`] is one (blanket impl below), so a filter index can
/// build directly against a raw store. The host's `TraceStore` facade —
/// which owns the raw store behind its lock — also implements it, so the
/// index builds against the facade without exposing the inner store. This
/// is the seam that lets the filter index serve the live model
/// ([ADR 0025](../../../docs/adr/0025-frontend-windowed-source-contract.md))
/// rather than only a bare store in tests.
pub trait CandidateSource {
    /// Total frames available. (Named `frame_count`, not `len`, so it
    /// never shadows [`RawStore::len`] when both traits are in scope.)
    fn frame_count(&self) -> usize;
    /// See [`RawStore::candidate_indices`].
    fn candidate_indices(&self, ids: &[(u32, bool)], start: usize, end: usize) -> Vec<usize>;
    /// See [`RawStore::frames_at`].
    fn frames_at(&self, idxs: &[usize]) -> Vec<(usize, RawTraceFrame)>;
}

impl<T: RawStore + ?Sized> CandidateSource for T {
    fn frame_count(&self) -> usize {
        RawStore::len(self)
    }
    fn candidate_indices(&self, ids: &[(u32, bool)], start: usize, end: usize) -> Vec<usize> {
        RawStore::candidate_indices(self, ids, start, end)
    }
    fn frames_at(&self, idxs: &[usize]) -> Vec<(usize, RawTraceFrame)> {
        RawStore::frames_at(self, idxs)
    }
}
