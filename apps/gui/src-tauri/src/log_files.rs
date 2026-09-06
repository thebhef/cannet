//! The logger folder's file gridview: a recursive `.blf` listing with
//! cached header metadata.
//!
//! Trace start, end and message count come from a header-only
//! [`cannet_blf::scan_blf`] walk — the same one the import dialog's
//! channel-mapping step already pays for ([`crate::capture::scan_blf_channels`])
//! — which is exact but not free on a large file. [`LogFileCache`]
//! remembers one file's scan against the `(size, modified time)` pair it
//! was taken at, so a listing that finds nothing changed about a file
//! since the last one pays nothing for it.
//!
//! The file a logger is writing right now is never scanned: its header
//! is not finished (a running [`crate::logger::LogWriter`] only finalises
//! it on stop), so a scan would either read a placeholder or race the
//! writer. Its row instead reports the live size and frame count
//! [`crate::logger::get_logger_statuses`] already tracks — the same
//! numbers the panel's own status line would show, because they are the
//! same call.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::logger::{LoggerRuntime, LoggerStatus};

/// One BLF file's header metadata, as [`cannet_blf::scan_blf`] reports
/// it — everything the gridview's start/end/message-count columns need
/// and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileMeta {
    frame_count: u64,
    first_timestamp_ns: Option<u64>,
    last_timestamp_ns: Option<u64>,
}

/// What [`LogFileCache`] remembers a scan against: the file's size and
/// modified time at the moment it was taken. Either moving means the
/// file is not the one that was scanned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CachedEntry {
    size: u64,
    modified: SystemTime,
    meta: FileMeta,
}

/// Per-file cache of [`FileMeta`], invalidated by `(size, modified time)`
/// rather than versioned or time-limited — a file that has not moved on
/// disk has not changed, and one that has is a different scan whatever
/// the reason. In-memory and host-state scoped (`AppHandle::manage`): a
/// session that never opens a logger's file list never pays for one, and
/// a folder revisited many times over a session pays for a header scan
/// at most once per file between two changes of it.
#[derive(Default)]
pub struct LogFileCache {
    entries: Mutex<HashMap<PathBuf, CachedEntry>>,
}

impl LogFileCache {
    /// The cached meta for `path` at `(size, modified)`, or the result of
    /// `scan` — cached for next time either way.
    ///
    /// `scan` is the expensive path (a real header walk in production, a
    /// call-counting stub in tests), so cache correctness — a file that
    /// has not changed is never rescanned — is testable without a BLF
    /// file on disk.
    fn get_or_scan(
        &self,
        path: &Path,
        size: u64,
        modified: SystemTime,
        scan: impl FnOnce() -> FileMeta,
    ) -> FileMeta {
        {
            let entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(cached) = entries.get(path) {
                if cached.size == size && cached.modified == modified {
                    return cached.meta;
                }
            }
        }
        let meta = scan();
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries.insert(
            path.to_path_buf(),
            CachedEntry {
                size,
                modified,
                meta,
            },
        );
        meta
    }
}

/// One node of the folder's file tree, as the panel's gridview renders
/// it. A directory's `children` is only ever files and directories that
/// themselves hold a `.blf` somewhere below — an empty branch is dropped
/// rather than shown with nothing under it.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LogFileNode {
    #[serde(rename_all = "camelCase")]
    Dir {
        /// The directory's absolute path — stable and unique, so it
        /// doubles as the gridview row id.
        id: String,
        name: String,
        children: Vec<LogFileNode>,
    },
    #[serde(rename_all = "camelCase")]
    File {
        /// The file's absolute path.
        id: String,
        name: String,
        size_bytes: u64,
        /// Absolute ns since the Unix epoch, or `None` for a file with no
        /// frames (or the file currently being written — its header is
        /// not there to read yet).
        start_ns: Option<u64>,
        end_ns: Option<u64>,
        message_count: u64,
        /// Filesystem modified time, ms since the Unix epoch.
        modified_ms: i64,
        /// This is the file a logger is writing right now: its size and
        /// message count are live, not header-scanned, and it is the
        /// gridview's writing row (ADR-free — owner ruling, not a design
        /// decision: the folder listing carries no separate status line).
        writing: bool,
    },
}

/// Absolute paths every logger is writing right now, with the size and
/// frame count [`crate::logger::get_logger_statuses`] already reports for
/// them. Pure over the status list rather than the runtime it comes from,
/// so the rule — which files are "live" and what their row shows — is
/// tested without a Tauri app.
fn writing_files(statuses: &[LoggerStatus]) -> HashMap<PathBuf, (u64, u64)> {
    statuses
        .iter()
        .filter(|s| s.writing)
        .filter_map(|s| {
            s.path
                .as_ref()
                .map(|p| (PathBuf::from(p), (s.bytes, s.frame_count)))
        })
        .collect()
}

fn is_blf(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("blf"))
}

fn path_id(path: &Path) -> String {
    path.display().to_string()
}

/// Filesystem modified time as ms since the Unix epoch. A clock before
/// the epoch (a file on a misconfigured system) reads as 0 rather than
/// failing the listing over one row's timestamp.
fn modified_ms(modified: SystemTime) -> i64 {
    modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// One file's node: the live-writing row if `writing` names it, otherwise
/// the cached (or freshly scanned) header metadata. A file whose header
/// cannot be read still lists — by name, size and modified time — with
/// empty trace columns, rather than disappearing from the folder.
fn file_node(
    path: &Path,
    name: &str,
    cache: &LogFileCache,
    writing: &HashMap<PathBuf, (u64, u64)>,
) -> Option<LogFileNode> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let modified_ms = modified_ms(modified);

    if let Some(&(bytes, frame_count)) = writing.get(path) {
        return Some(LogFileNode::File {
            id: path_id(path),
            name: name.to_string(),
            size_bytes: bytes,
            start_ns: None,
            end_ns: None,
            message_count: frame_count,
            modified_ms,
            writing: true,
        });
    }

    let size = metadata.len();
    let owned = path.to_path_buf();
    let meta = cache.get_or_scan(path, size, modified, || {
        cannet_blf::scan_blf(&owned).map_or(
            FileMeta {
                frame_count: 0,
                first_timestamp_ns: None,
                last_timestamp_ns: None,
            },
            |scan| FileMeta {
                frame_count: scan.frame_count,
                first_timestamp_ns: scan.first_timestamp_ns,
                last_timestamp_ns: scan.last_timestamp_ns,
            },
        )
    });
    Some(LogFileNode::File {
        id: path_id(path),
        name: name.to_string(),
        size_bytes: size,
        start_ns: meta.first_timestamp_ns,
        end_ns: meta.last_timestamp_ns,
        message_count: meta.frame_count,
        modified_ms,
        writing: false,
    })
}

/// Walk `dir` one level, recursing into subdirectories. Entries are
/// sorted by name, so the listing is deterministic between two calls
/// that found the same files. An unreadable directory (gone, permission
/// denied) lists as empty rather than failing its parent's walk.
fn walk_dir(
    dir: &Path,
    cache: &LogFileCache,
    writing: &HashMap<PathBuf, (u64, u64)>,
) -> Vec<LogFileNode> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);

    let mut nodes = Vec::with_capacity(entries.len());
    for entry in entries {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_dir() {
            let children = walk_dir(&path, cache, writing);
            if !children.is_empty() {
                nodes.push(LogFileNode::Dir {
                    id: path_id(&path),
                    name,
                    children,
                });
            }
        } else if file_type.is_file() && is_blf(&path) {
            if let Some(node) = file_node(&path, &name, cache, writing) {
                nodes.push(node);
            }
        }
    }
    nodes
}

/// The listing itself, over an already-resolved directory and an
/// already-fetched status list — the AppHandle-touching parts of
/// [`list_logger_files`] split out so the walk is testable without a
/// Tauri app (a struct a test constructs must never hold an `AppHandle`
/// — see `logger.rs`'s note on `ExportRun`).
fn list_files(dir: &Path, cache: &LogFileCache, statuses: &[LoggerStatus]) -> Vec<LogFileNode> {
    if !dir.is_dir() {
        return Vec::new();
    }
    walk_dir(dir, cache, &writing_files(statuses))
}

/// Tauri command — the logger panel's recursive file gridview: `folder`
/// resolved (as [`crate::export_template::resolve_folder`] leaves it),
/// walked for `.blf` files and subdirectories, each finished file's
/// header served from [`LogFileCache`] and the file any logger is
/// currently writing reported live instead of scanned.
///
/// `async` and off the blocking pool (ADR 0048, matching
/// [`crate::capture::scan_blf_channels`]): the first listing of a folder
/// full of large, uncached files pays for their header scans, which must
/// not be async-worker time.
#[tauri::command]
pub async fn list_logger_files(app: AppHandle, folder: String) -> Vec<LogFileNode> {
    crate::sampling::off_async_workers(move || {
        let dir = PathBuf::from(folder);
        let cache = app.state::<LogFileCache>();
        let statuses = app.state::<LoggerRuntime>().statuses();
        list_files(&dir, &cache, &statuses)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logger::LogWriter;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn frame(ts_ns: u64, id: u32) -> crate::trace_store::RawTraceFrame {
        crate::trace_store::RawTraceFrame {
            timestamp_ns: ts_ns,
            channel: 0,
            id,
            extended: false,
            direction: cannet_core::Direction::Rx,
            payload: cannet_core::CanFramePayload::Classic(vec![0xAB; 8]),
            bus_id: Some("b".into()),
        }
    }

    /// A real, finalized BLF file at `path`, one frame per `(ts_ns, id)`
    /// pair — built through [`LogWriter`] rather than a hand-rolled
    /// writer, so the fixture is exactly what a logger produces.
    fn write_test_blf(path: &Path, frames: &[(u64, u32)]) {
        let mut writer = LogWriter::open(path.to_path_buf(), u64::MAX, vec!["b".into()]).unwrap();
        let raw: Vec<_> = frames.iter().map(|&(ts, id)| frame(ts, id)).collect();
        writer.write(&raw).unwrap();
        writer.finish().unwrap();
    }

    fn status(
        id: &str,
        writing: bool,
        path: Option<&str>,
        bytes: u64,
        frames: u64,
    ) -> LoggerStatus {
        LoggerStatus {
            id: id.into(),
            writing,
            path: path.map(str::to_string),
            bytes,
            frame_count: frames,
            error: None,
        }
    }

    // --- LogFileCache ---

    #[test]
    fn get_or_scan_reuses_the_cached_meta_when_size_and_modified_time_are_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.blf");
        std::fs::write(&path, b"x").unwrap();
        let stat = std::fs::metadata(&path).unwrap();
        let cache = LogFileCache::default();
        let calls = AtomicUsize::new(0);
        let scan = || {
            calls.fetch_add(1, Ordering::SeqCst);
            FileMeta {
                frame_count: 1,
                first_timestamp_ns: Some(1),
                last_timestamp_ns: Some(2),
            }
        };
        cache.get_or_scan(&path, stat.len(), stat.modified().unwrap(), scan);
        cache.get_or_scan(&path, stat.len(), stat.modified().unwrap(), scan);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "the second call must not rescan"
        );
    }

    #[test]
    fn get_or_scan_rescans_when_the_modified_time_moves() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.blf");
        std::fs::write(&path, b"x").unwrap();
        let stat = std::fs::metadata(&path).unwrap();
        let cache = LogFileCache::default();
        let calls = AtomicUsize::new(0);
        let scan = || {
            calls.fetch_add(1, Ordering::SeqCst);
            FileMeta {
                frame_count: 1,
                first_timestamp_ns: None,
                last_timestamp_ns: None,
            }
        };
        cache.get_or_scan(&path, stat.len(), stat.modified().unwrap(), scan);
        let touched = stat.modified().unwrap() + std::time::Duration::from_secs(5);
        cache.get_or_scan(&path, stat.len(), touched, scan);
        assert_eq!(calls.load(Ordering::SeqCst), 2, "a moved mtime must rescan");
    }

    #[test]
    fn get_or_scan_rescans_when_the_size_moves_even_at_the_same_modified_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.blf");
        std::fs::write(&path, b"x").unwrap();
        let stat = std::fs::metadata(&path).unwrap();
        let cache = LogFileCache::default();
        let calls = AtomicUsize::new(0);
        let scan = || {
            calls.fetch_add(1, Ordering::SeqCst);
            FileMeta {
                frame_count: 1,
                first_timestamp_ns: None,
                last_timestamp_ns: None,
            }
        };
        cache.get_or_scan(&path, stat.len(), stat.modified().unwrap(), scan);
        cache.get_or_scan(&path, stat.len() + 1, stat.modified().unwrap(), scan);
        assert_eq!(calls.load(Ordering::SeqCst), 2, "a moved size must rescan");
    }

    // --- writing_files ---

    #[test]
    fn writing_files_indexes_only_the_running_statuses_by_path() {
        let statuses = vec![
            status("a", true, Some("/x/a.blf"), 10, 2),
            status("b", false, Some("/x/b.blf"), 0, 0),
            status("c", true, None, 0, 0),
        ];
        let map = writing_files(&statuses);
        assert_eq!(map.len(), 1);
        assert_eq!(map.get(Path::new("/x/a.blf")), Some(&(10, 2)));
    }

    // --- walk_dir / list_files ---

    #[test]
    fn a_finished_file_is_listed_with_its_scanned_header_metadata() {
        let dir = tempfile::tempdir().unwrap();
        write_test_blf(
            &dir.path().join("run.blf"),
            &[
                (1_700_000_000_000_000_000, 0x100),
                (1_700_000_000_500_000_000, 0x100),
            ],
        );
        let cache = LogFileCache::default();
        let nodes = list_files(dir.path(), &cache, &[]);
        assert_eq!(nodes.len(), 1);
        match &nodes[0] {
            LogFileNode::File {
                name,
                message_count,
                start_ns,
                end_ns,
                writing,
                ..
            } => {
                assert_eq!(name, "run.blf");
                assert_eq!(*message_count, 2);
                assert_eq!(*start_ns, Some(1_700_000_000_000_000_000));
                assert_eq!(*end_ns, Some(1_700_000_000_500_000_000));
                assert!(!writing);
            }
            other @ LogFileNode::Dir { .. } => panic!("expected a file node, got {other:?}"),
        }
    }

    #[test]
    fn a_subdirectory_becomes_a_branch_and_non_blf_files_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        write_test_blf(&dir.path().join("sub").join("a.blf"), &[(1, 0x1)]);
        std::fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        let cache = LogFileCache::default();
        let nodes = list_files(dir.path(), &cache, &[]);
        assert_eq!(nodes.len(), 1, "the stray .txt is dropped: {nodes:?}");
        match &nodes[0] {
            LogFileNode::Dir { name, children, .. } => {
                assert_eq!(name, "sub");
                assert_eq!(children.len(), 1);
            }
            other @ LogFileNode::File { .. } => panic!("expected a directory node, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_subdirectory_does_not_appear() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("empty")).unwrap();
        let cache = LogFileCache::default();
        assert!(list_files(dir.path(), &cache, &[]).is_empty());
    }

    #[test]
    fn the_currently_writing_file_reports_its_live_status_instead_of_a_header_scan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("open.blf");
        // An unfinalized file on disk — scanning it would read a
        // placeholder header, which is exactly what this must not do.
        std::fs::write(&path, b"not a real header").unwrap();
        let statuses = vec![status(
            "a",
            true,
            Some(path.display().to_string().as_str()),
            12_345,
            7,
        )];
        let cache = LogFileCache::default();
        let nodes = list_files(dir.path(), &cache, &statuses);
        assert_eq!(nodes.len(), 1);
        match &nodes[0] {
            LogFileNode::File {
                size_bytes,
                message_count,
                start_ns,
                writing,
                ..
            } => {
                assert_eq!(*size_bytes, 12_345);
                assert_eq!(*message_count, 7);
                assert_eq!(*start_ns, None);
                assert!(*writing);
            }
            other @ LogFileNode::Dir { .. } => panic!("expected a file node, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_folder_lists_as_empty_rather_than_erroring() {
        let cache = LogFileCache::default();
        let nodes = list_files(Path::new("this/does/not/exist"), &cache, &[]);
        assert!(nodes.is_empty());
    }

    #[test]
    fn entries_are_sorted_by_name() {
        let dir = tempfile::tempdir().unwrap();
        write_test_blf(&dir.path().join("b.blf"), &[(1, 0x1)]);
        write_test_blf(&dir.path().join("a.blf"), &[(1, 0x1)]);
        let cache = LogFileCache::default();
        let names: Vec<String> = list_files(dir.path(), &cache, &[])
            .into_iter()
            .map(|n| match n {
                LogFileNode::File { name, .. } | LogFileNode::Dir { name, .. } => name,
            })
            .collect();
        assert_eq!(names, vec!["a.blf".to_string(), "b.blf".to_string()]);
    }
}
