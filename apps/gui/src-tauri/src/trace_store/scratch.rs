//! Scratch-directory footprint accounting for the cache diagnostic
//! (ADR 0002 DS-8).
//!
//! The windowed-ring cap bounds the whole `current/` scratch dir; the
//! status readout wants that total plus a per-family breakdown (raw
//! frames vs. signal pyramids vs. everything else). Both are measured by
//! walking the dir off the store lock (the dir path is cloned under the
//! lock, then released).

use std::path::Path;

use super::TraceStore;

impl TraceStore {
    /// The total `current/` scratch footprint in bytes as of the last flush,
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
    /// `current/` footprint before a flush sheds the oldest raw history.
    /// `None` is unbounded. A no-op in effect for the in-RAM double (it has
    /// no scratch dir, so flush never measures or evicts).
    pub fn set_scratch_cap(&self, cap: Option<u64>) {
        let mut inner = self.lock_inner();
        inner.scratch_cap_bytes = cap;
    }
}

/// Total bytes of every file under `dir` (recursively) — the `current/`
/// scratch footprint the windowed-ring cap measures (ADR 0002 DS-8): raw
/// segments, by-id and filter indexes, signal pyramids, and the small JSON
/// sidecars. Best-effort: an unreadable entry counts zero, so a transient
/// I/O hiccup can't wedge the flush path.
pub(super) fn dir_footprint(dir: &Path) -> u64 {
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

/// A per-family breakdown of the `current/` scratch footprint for the
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

/// Bucket the `current/` scratch by family for the cache diagnostic. One
/// walk: top-level `meta.*`/`payload.*` are frames, the `signals/` subdir is
/// the pyramids (with its level depth), everything else (by-id, the
/// `filter/` subdir, JSON sidecars) is "other".
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
            if name == "signals" {
                let (bytes, files, depth) = walk_pyramids(&entry.path());
                b.pyramid_bytes += bytes;
                b.pyramid_files += files;
                b.pyramid_depth = b.pyramid_depth.max(depth);
            } else {
                let (bytes, files) = walk_dir(&entry.path());
                b.other_bytes += bytes;
                b.other_files += files;
            }
        } else if name.starts_with("meta.") || name.starts_with("payload.") {
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

/// Recursively sum `(bytes, file_count)` under `dir`.
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

/// Like [`walk_dir`] for the `signals/` pyramid dir, also returning the
/// deepest pyramid (level count) seen — parsed from the `….l{n}.{seg}`
/// segment file names.
fn walk_pyramids(dir: &Path) -> (u64, u64, u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0, 0);
    };
    let (mut bytes, mut files, mut depth) = (0, 0, 0);
    for entry in entries.flatten() {
        let Ok(m) = entry.metadata() else { continue };
        if m.is_dir() {
            let (b, f, d) = walk_pyramids(&entry.path());
            bytes += b;
            files += f;
            depth = depth.max(d);
        } else {
            bytes += m.len();
            files += 1;
            if let Some(level) = pyramid_level(&entry.file_name().to_string_lossy()) {
                depth = depth.max(level + 1);
            }
        }
    }
    (bytes, files, depth)
}

/// The level index `n` in a pyramid segment file name `….l{n}.{seg}`
/// (`{base}.l0.0000`, `{base}.l2.0003`, …), or `None` if it doesn't match.
fn pyramid_level(name: &str) -> Option<u64> {
    let after = &name[name.rfind(".l")? + 2..];
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
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
        // double, the measured `current/` footprint for a disk store, cached
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
