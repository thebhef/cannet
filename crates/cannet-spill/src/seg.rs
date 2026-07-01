//! A pre-allocated, whole-mapped segment file (ADR 0002 DS-4).
//!
//! Shared by the raw store ([`crate::disk`]) and the by-id index
//! ([`crate::byid`]). Each segment file is created at a fixed size and
//! mapped once, read-write; it is never resized while mapped (which
//! Windows forbids). This module owns the crate's single `unsafe` site —
//! the `mmap` call itself.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

use memmap2::MmapMut;

/// One pre-allocated, whole-mapped segment file. The `File` handle is
/// kept alive for the mapping's lifetime.
pub(crate) struct Segment {
    _file: File,
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
    // SAFETY: `file` was just created and sized to `bytes`; we keep its
    // handle alive in the returned `Segment` for the mapping's whole
    // lifetime, so it cannot be truncated out from under the map by this
    // process. The map is only ever accessed behind the host's store
    // mutex, so there is no concurrent mutation. External truncation of
    // the scratch volume would raise SIGBUS / EXCEPTION_IN_PAGE_ERROR,
    // which ADR 0002 accepts for an ephemeral store.
    #[allow(unsafe_code)]
    let map = unsafe { MmapMut::map_mut(&file)? };
    Ok(Segment { _file: file, map })
}

/// Map an *existing* segment file whole, read-write, **without
/// truncating it** — the reopen path (ADR 0002 DS-7). The file keeps its
/// on-disk bytes (its pre-allocated capacity); only the store's persisted
/// valid-length watermark says how many of them are live data.
pub(crate) fn open_segment(path: &Path) -> io::Result<Segment> {
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    // SAFETY: same contract as `create_segment` — the file handle is kept
    // alive in the returned `Segment` for the mapping's lifetime, and the
    // map is only touched behind the store mutex. The file already exists
    // at its full pre-allocated size, so no resize is needed (or allowed
    // while mapped, on Windows).
    #[allow(unsafe_code)]
    let map = unsafe { MmapMut::map_mut(&file)? };
    Ok(Segment { _file: file, map })
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
