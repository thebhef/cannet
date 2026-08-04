//! Scratch-directory footprint accounting for the cache diagnostic
//! (ADR 0002 DS-8).
//!
//! The windowed-ring cap bounds the whole `cache/` scratch dir; the
//! status readout wants that total plus a per-family breakdown (raw
//! frames vs. signal pyramids vs. everything else). Both are measured by
//! walking the dir off the store lock (the dir path is cloned under the
//! lock, then released).

use std::path::Path;

use super::TraceStore;

impl TraceStore {
    /// The total `cache/` scratch footprint in bytes as of the last flush,
    /// or `None` for the in-RAM double (which has no scratch dir). Drives the
    /// status readout (ADR 0002 DS-8).
    pub fn scratch_footprint_bytes(&self) -> Option<u64> {
        let inner = self.lock_inner();
        inner.scratch_dir.is_some().then_some(inner.footprint_bytes)
    }

    /// A per-family breakdown of the scratch footprint for the cache
    /// diagnostic (ADR 0002 DS-8), or `None` for the in-RAM double. The
    /// directory walk runs off the store lock (the dir is cloned under the
    /// lock, then released).
    pub fn scratch_breakdown(&self) -> Option<ScratchBreakdown> {
        let dir = {
            let inner = self.lock_inner();
            inner.scratch_dir.clone()?
        };
        Some(scratch_breakdown(&dir))
    }

    /// Set the windowed-ring cap (ADR 0002 DS-8) — the maximum total
    /// `cache/` footprint before a flush sheds the oldest raw history.
    /// `None` is unbounded. A no-op in effect for the in-RAM double (it has
    /// no scratch dir, so flush never measures or evicts).
    pub fn set_scratch_cap(&self, cap: Option<u64>) {
        let mut inner = self.lock_inner();
        inner.scratch_cap_bytes = cap;
    }
}

/// Total bytes of every file under `dir` (recursively) — the `cache/`
/// scratch footprint the windowed-ring cap measures (ADR 0002 DS-8): raw
/// segments, by-id and filter indexes, signal pyramids, and the small JSON
/// sidecars. Best-effort: an unreadable entry counts zero, so a transient
/// I/O hiccup can't wedge the flush path.
pub(crate) fn dir_footprint(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => total += dir_footprint(&entry.path()),
            Ok(meta) => total += meta.len(),
            Err(_) => {}
        }
    }
    total
}

/// A per-family breakdown of the `cache/` scratch footprint for the
/// periodic cache diagnostic (ADR 0002 DS-8). Byte counts are on-disk
/// segment-file sizes; `*_files` are file counts (segments, i.e. "pages").
#[derive(Debug, Default, Clone, Copy)]
pub struct ScratchBreakdown {
    /// Raw frame store: `meta.*` + `payload.*` segments.
    pub frames_bytes: u64,
    pub frames_files: u64,
    /// Signal-cache resolution pyramids (the `signals/` subdir).
    pub pyramid_bytes: u64,
    pub pyramid_files: u64,
    /// Deepest pyramid (number of levels) across all cached signals.
    pub pyramid_depth: u64,
    /// Everything else: by-id postings, filter indexes, and the small JSON
    /// sidecars (manifest / derived / identity).
    pub other_bytes: u64,
    pub other_files: u64,
    /// Sum of the three families' byte counts.
    pub total_bytes: u64,
}

/// Bucket the `cache/` scratch by family for the cache diagnostic. One
/// walk that delegates each family's naming to the module that owns it,
/// rather than re-deriving foreign file names here: the raw-frame family is
/// identified by [`cannet_spill::is_raw_frame_segment`], and the pyramid
/// subdir + its level depth by [`crate::signal_cache`]
/// ([`PYRAMID_SUBDIR`](crate::signal_cache::PYRAMID_SUBDIR) /
/// [`pyramid_scratch_usage`](crate::signal_cache::pyramid_scratch_usage)).
/// Everything else (by-id, the `filter/` subdir, JSON sidecars) is "other",
/// summed generically.
fn scratch_breakdown(dir: &Path) -> ScratchBreakdown {
    let mut b = ScratchBreakdown::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return b;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if name == crate::signal_cache::PYRAMID_SUBDIR {
                let (bytes, files, depth) =
                    crate::signal_cache::pyramid_scratch_usage(&entry.path());
                b.pyramid_bytes += bytes;
                b.pyramid_files += files;
                b.pyramid_depth = b.pyramid_depth.max(depth);
            } else {
                let (bytes, files) = walk_dir(&entry.path());
                b.other_bytes += bytes;
                b.other_files += files;
            }
        } else if cannet_spill::is_raw_frame_segment(&name) {
            b.frames_bytes += meta.len();
            b.frames_files += 1;
        } else {
            b.other_bytes += meta.len();
            b.other_files += 1;
        }
    }
    b.total_bytes = b.frames_bytes + b.pyramid_bytes + b.other_bytes;
    b
}

/// Recursively sum `(bytes, file_count)` under `dir` — the generic "other"
/// family (by-id postings, the `filter/` subdir, JSON sidecars), which
/// carries no per-family naming to attribute.
fn walk_dir(dir: &Path) -> (u64, u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let (mut bytes, mut files) = (0, 0);
    for entry in entries.flatten() {
        match entry.metadata() {
            Ok(m) if m.is_dir() => {
                let (b, f) = walk_dir(&entry.path());
                bytes += b;
                files += f;
            }
            Ok(m) => {
                bytes += m.len();
                files += 1;
            }
            Err(_) => {}
        }
    }
    (bytes, files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace_store::test_support::dummy;

    #[test]
    fn scratch_breakdown_buckets_by_family() {
        // The cache diagnostic (ADR 0002 DS-8): frames vs pyramid vs other,
        // file counts, and the deepest pyramid parsed from the level names.
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::write(d.join("meta.000000"), vec![0u8; 100]).unwrap();
        std::fs::write(d.join("payload.000000"), vec![0u8; 200]).unwrap();
        std::fs::write(d.join("byid.s00000100.0000"), vec![0u8; 50]).unwrap();
        std::fs::write(d.join("manifest.json"), vec![0u8; 10]).unwrap();
        std::fs::create_dir(d.join("filter")).unwrap();
        std::fs::write(d.join("filter").join("filt.0000"), vec![0u8; 30]).unwrap();
        std::fs::create_dir(d.join("signals")).unwrap();
        std::fs::write(d.join("signals").join("0x100.sig.l0.0000"), vec![0u8; 300]).unwrap();
        std::fs::write(d.join("signals").join("0x100.sig.l1.0000"), vec![0u8; 150]).unwrap();
        std::fs::write(d.join("signals").join("0x100.sig.l2.0000"), vec![0u8; 70]).unwrap();

        let b = scratch_breakdown(d);
        assert_eq!(b.frames_bytes, 300); // meta 100 + payload 200
        assert_eq!(b.frames_files, 2);
        assert_eq!(b.pyramid_bytes, 520); // 300 + 150 + 70
        assert_eq!(b.pyramid_files, 3);
        assert_eq!(b.pyramid_depth, 3); // levels l0, l1, l2 → depth 3
        assert_eq!(b.other_bytes, 90); // byid 50 + manifest 10 + filter 30
        assert_eq!(b.other_files, 3);
        assert_eq!(b.total_bytes, 300 + 520 + 90);
    }

    #[test]
    fn scratch_footprint_bytes_is_none_for_ram_and_tracks_disk() {
        // The status readout source (ADR 0002 DS-8): None for the in-RAM
        // double, the measured `cache/` footprint for a disk store, cached
        // on the flush cadence.
        let ram = TraceStore::new();
        assert_eq!(ram.scratch_footprint_bytes(), None);

        let dir = std::env::temp_dir().join(format!("cannet-fp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = TraceStore::new_disk(&dir).unwrap();
        assert_eq!(store.scratch_footprint_bytes(), Some(0), "no flush yet");
        for i in 0u32..50 {
            store.append(dummy(u64::from(i) * 1_000, i));
        }
        store.flush().unwrap();
        let fp = store
            .scratch_footprint_bytes()
            .expect("disk store reports a footprint");
        assert!(fp > 0, "footprint reflects the written scratch");
        assert_eq!(fp, dir_footprint(&dir), "cached value matches a fresh walk");
        std::fs::remove_dir_all(&dir).ok();
    }
}
