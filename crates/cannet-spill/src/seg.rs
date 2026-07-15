//! A pre-allocated, whole-mapped segment file (ADR 0002 DS-4).
//!
//! Shared by the raw store ([`crate::disk`]) and the by-id index
//! ([`crate::byid`]). Each segment file is created at a fixed size and
//! mapped once, read-write; it is never resized while mapped (which
//! Windows forbids). This module owns the crate's single `unsafe` site —
//! the `mmap` call itself.

use std::fs::OpenOptions;
use std::io;
use std::path::Path;

use memmap2::MmapMut;

/// One pre-allocated, whole-mapped segment file.
///
/// The `File` handle is **not** retained: once `mmap` succeeds the OS
/// mapping object holds its own reference to the underlying file, so the
/// mapping stays valid after the descriptor is closed (on both POSIX and
/// Windows). Retaining it would cost one open fd per live segment, and the
/// by-id index holds one segment chain per distinct id — enough to exhaust
/// `RLIMIT_NOFILE` (EMFILE) mid-import on a wide capture.
pub(crate) struct Segment {
    pub(crate) map: MmapMut,
}

/// Create a segment file of exactly `bytes` and map it whole, read-write.
pub(crate) fn create_segment(path: &Path, bytes: usize) -> io::Result<Segment> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.set_len(bytes as u64)?;
    // SAFETY: `file` was just created and sized to `bytes`; the mapping
    // outlives the handle (the OS keeps the file alive for the mapping),
    // and the map is only ever accessed behind the host's store mutex, so
    // there is no concurrent mutation. External truncation of the scratch
    // volume would raise SIGBUS / EXCEPTION_IN_PAGE_ERROR, which ADR 0002
    // accepts for an ephemeral store. The handle is dropped at end of scope
    // to avoid holding one fd per live segment.
    #[allow(unsafe_code)]
    let map = unsafe { MmapMut::map_mut(&file)? };
    Ok(Segment { map })
}

/// Map an *existing* segment file whole, read-write, **without
/// truncating it** — the reopen path (ADR 0002 DS-7). The file keeps its
/// on-disk bytes (its pre-allocated capacity); only the store's persisted
/// valid-length watermark says how many of them are live data.
pub(crate) fn open_segment(path: &Path) -> io::Result<Segment> {
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    // SAFETY: same contract as `create_segment` — the mapping outlives the
    // handle (dropped at end of scope so no fd is held per segment), and the
    // map is only touched behind the store mutex. The file already exists at
    // its full pre-allocated size, so no resize is needed (or allowed while
    // mapped, on Windows).
    #[allow(unsafe_code)]
    let map = unsafe { MmapMut::map_mut(&file)? };
    Ok(Segment { map })
}

/// Remove every file in `dir` whose name starts with one of `prefixes`,
/// after the caller has dropped the mappings (so Windows allows removal).
pub(crate) fn remove_files_with_prefixes(dir: &Path, prefixes: &[&str]) -> io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if prefixes.iter().any(|p| name.starts_with(p)) {
                std::fs::remove_file(&path)?;
            }
        }
    }
    Ok(())
}
