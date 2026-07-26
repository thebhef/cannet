//! Shared segment-chain machinery: the append-only geometric growth and
//! windowed-eviction mechanics common to every mmap'd segment sequence in
//! this crate (ADR 0002 DS-4/DS-8).
//!
//! Two things are deliberately **not** unified here, because they encode
//! genuinely different behavior per caller:
//!
//! - **Segment geometry.** The by-id postings ([`crate::byid`]) and the
//!   sample-sequence pyramids ([`crate::sample_seq`]) grow *geometrically*
//!   — [`geometric_seg_capacity`] doubles per segment, capped — and address
//!   a slot via [`geometric_locate`]'s `cum_cap` search. The filter index
//!   and the raw store's meta/payload families instead use segments of one
//!   *fixed* size and address a slot by plain arithmetic division — a
//!   different enough scheme that they grow their own way rather than
//!   through the geometric helpers here.
//! - **Eviction policy.** *What* low-water mark triggers a drop, and how it
//!   maps to a target segment base, differs per caller — a binary search
//!   over stored values for the by-id index and the filter index; a
//!   directly-supplied slot for the sample sequence; a raw-store watermark
//!   clamped to protect the live tail segment for the disk store's two
//!   families. Callers compute their own target base and keep that policy
//!   visible in their own `evict_below`.

use std::path::PathBuf;

use crate::seg::{create_segment, Segment};

/// Entries in the first (smallest) segment of a geometric chain.
const BASE_ENTRIES: usize = 64;
/// Cap on segment size; segments double up to here, then stay.
const MAX_SEG_ENTRIES: usize = 65_536;
/// `seg` index at which `BASE_ENTRIES << seg` first reaches the cap
/// (`64 << 10 == 65_536`). Beyond it every segment is `MAX_SEG_ENTRIES`.
const CAP_SEG: usize = 10;

/// Entry capacity of geometric segment `seg`: [`BASE_ENTRIES`] doubled per
/// step, capped at [`MAX_SEG_ENTRIES`]. Branching on [`CAP_SEG`] (rather
/// than `(BASE_ENTRIES << seg).min(MAX_SEG_ENTRIES)`) keeps the shift in
/// range — a chain needing 58+ segments would otherwise overflow the `<<`.
/// The geometry is deterministic in `seg`, so a reopen path can rebuild a
/// chain from its persisted length alone.
pub(crate) fn geometric_seg_capacity(seg: usize) -> usize {
    if seg >= CAP_SEG {
        MAX_SEG_ENTRIES
    } else {
        BASE_ENTRIES << seg
    }
}

/// `(absolute segment index, entry offset within it)` for slot `k` in a
/// geometric chain whose per-segment cumulative capacity (absolute
/// numbering) is `cum_cap`. The caller scales the offset by its own entry
/// width.
pub(crate) fn geometric_locate(cum_cap: &[usize], k: usize) -> (usize, usize) {
    let seg = cum_cap.partition_point(|&c| c <= k);
    let base = if seg == 0 { 0 } else { cum_cap[seg - 1] };
    (seg, k - base)
}

/// Grow a geometric chain by exactly one segment — the next in the doubling
/// progression — when it is full, ahead of writing slot `len`. `segs` and
/// `cum_cap` are the caller's chain and cumulative-capacity index;
/// `entry_bytes` sizes the new segment; `path` names its file.
pub(crate) fn geometric_push_grow(
    segs: &mut Vec<Segment>,
    cum_cap: &mut Vec<usize>,
    len: usize,
    entry_bytes: usize,
    path: impl Fn(usize) -> PathBuf,
) {
    let cap = cum_cap.last().copied().unwrap_or(0);
    if len == cap {
        let i = cum_cap.len(); // absolute segment number (survives a trim)
        let seg_cap = geometric_seg_capacity(i);
        let seg = create_segment(&path(i), seg_cap * entry_bytes)
            .expect("cannet-spill: segment I/O failed");
        segs.push(seg);
        cum_cap.push(cap + seg_cap);
    }
}

/// Drop every leading segment below `target_base`: unmap (drop the
/// mapping) then delete its file — Windows forbids deleting a file while it
/// is mapped, so the unmap must come first. `segs`/`seg_base` are the
/// chain's segment `Vec` and its dropped-leading-segment count; `path(i)`
/// names the file to remove for absolute segment `i`.
///
/// This is only the mechanical removal step, shared by every segment-chain
/// type in the crate (5 near-identical copies before this extraction).
/// *What* `target_base` should be — the eviction policy — is decided by
/// the caller and deliberately differs per type; see the module docs.
pub(crate) fn evict_leading(
    segs: &mut Vec<Segment>,
    seg_base: &mut usize,
    target_base: usize,
    path: impl Fn(usize) -> PathBuf,
) {
    while *seg_base < target_base {
        drop(segs.remove(0)); // unmap before deleting (Windows)
        let _ = std::fs::remove_file(path(*seg_base));
        *seg_base += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometric_seg_capacity_doubles_then_caps() {
        assert_eq!(geometric_seg_capacity(0), 64);
        assert_eq!(geometric_seg_capacity(1), 128);
        assert_eq!(geometric_seg_capacity(9), 64 << 9);
        assert_eq!(geometric_seg_capacity(10), MAX_SEG_ENTRIES);
        assert_eq!(geometric_seg_capacity(100), MAX_SEG_ENTRIES);
    }

    #[test]
    fn geometric_locate_finds_segment_and_offset() {
        let cum_cap = vec![64, 192, 448]; // 64, 128, 256
        assert_eq!(geometric_locate(&cum_cap, 0), (0, 0));
        assert_eq!(geometric_locate(&cum_cap, 63), (0, 63));
        assert_eq!(geometric_locate(&cum_cap, 64), (1, 0));
        assert_eq!(geometric_locate(&cum_cap, 191), (1, 127));
        assert_eq!(geometric_locate(&cum_cap, 192), (2, 0));
    }
}
