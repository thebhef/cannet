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
//!
//! **A listing never waits for a scan** (ADR 0049). The walk answers with
//! the stat data it has — name, size, modified time — and a file whose
//! header is not in [`LogFileCache`] lists with its trace columns
//! *pending*. The scan itself is a background job: one per unscanned
//! file, deduplicated by path and drained by a single worker, so a folder
//! of N unscanned files costs N scans however many listings overlap. Each
//! finished scan announces itself with [`LOG_FILES_SCANNED_EVENT`] and
//! the grid asks again. This is the rule the listing used to break: a
//! 4 Hz poll over a folder whose files each take seconds to scan started
//! a fresh full read of the same file on every tick.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::logger::{LoggerRuntime, LoggerStatus};

/// Emitted with the absolute path of a file whose background header scan
/// has just landed in [`LogFileCache`]. The logger file grid re-asks for
/// the listing; its host-mirror coalesces a burst of these into one
/// refetch.
pub const LOG_FILES_SCANNED_EVENT: &str = "logger-files-scanned";

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

/// How a file's header is read, and how a finished read is announced.
/// Both are injected rather than hardcoded: production passes
/// [`cannet_blf::scan_blf`] and a Tauri emit, tests pass a stub that
/// counts its calls and blocks on command, which is how single-flight is
/// asserted without a multi-hundred-megabyte fixture.
type ScanFn = Arc<dyn Fn(&Path) -> FileMeta + Send + Sync>;
type AnnounceFn = Arc<dyn Fn(&Path) + Send + Sync>;

/// The background scan queue: which paths are waiting or running, in
/// discovery order, and whether a worker is draining them.
///
/// `pending` is the single-flight set. A path enters it once and leaves
/// it when its scan has been stored, so however many overlapping
/// listings name the same unscanned file, exactly one scan runs for it
/// (ADR 0049). One worker drains the queue, so N unscanned files are N
/// sequential reads rather than N concurrent ones — the concurrency was
/// half of what saturated the machine.
#[derive(Default)]
struct ScanQueue {
    queued: VecDeque<ScanJob>,
    pending: HashSet<PathBuf>,
    running: bool,
}

/// One queued header scan: the file, and the `(size, modified)` pair the
/// result is cached against.
struct ScanJob {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

/// Per-file cache of [`FileMeta`], invalidated by `(size, modified time)`
/// rather than versioned or time-limited — a file that has not moved on
/// disk has not changed, and one that has is a different scan whatever
/// the reason. In-memory and host-state scoped (`AppHandle::manage`): a
/// session that never opens a logger's file list never pays for one, and
/// a folder revisited many times over a session pays for a header scan
/// at most once per file between two changes of it.
///
/// The cache is also the scan *scheduler*: a listing that misses asks
/// for a background scan and answers pending, never waiting for one
/// (ADR 0049).
#[derive(Default)]
pub struct LogFileCache {
    entries: Arc<Mutex<HashMap<PathBuf, CachedEntry>>>,
    scans: Arc<Mutex<ScanQueue>>,
}

impl LogFileCache {
    /// The cached meta for `path` at `(size, modified)`, or `None` — the
    /// file has never been scanned, or has moved on disk since it was.
    /// Never scans: reading the cache is all a listing may do.
    fn cached(&self, path: &Path, size: u64, modified: SystemTime) -> Option<FileMeta> {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries
            .get(path)
            .filter(|c| c.size == size && c.modified == modified)
            .map(|c| c.meta)
    }

    /// Queue a background header scan of `path`, unless one is already
    /// queued or running for it.
    ///
    /// Returns having done no I/O. The worker stores each result under
    /// the `(size, modified)` pair the job was created with — not one it
    /// re-stats — so a file that changed while it waited fails the
    /// [`Self::cached`] check on the next listing and is queued again,
    /// rather than a stale scan being read as current.
    fn request_scan(&self, job: ScanJob, scan: &ScanFn, announce: &AnnounceFn) {
        {
            let mut q = self
                .scans
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !q.pending.insert(job.path.clone()) {
                return;
            }
            q.queued.push_back(job);
            if q.running {
                return;
            }
            q.running = true;
        }
        let entries = Arc::clone(&self.entries);
        let scans = Arc::clone(&self.scans);
        let scan = Arc::clone(scan);
        let announce = Arc::clone(announce);
        std::thread::spawn(move || loop {
            let job = {
                let mut q = scans
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let Some(job) = q.queued.pop_front() else {
                    q.running = false;
                    return;
                };
                job
            };
            let meta = scan(&job.path);
            {
                let mut e = entries
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                e.insert(
                    job.path.clone(),
                    CachedEntry {
                        size: job.size,
                        modified: job.modified,
                        meta,
                    },
                );
            }
            // Out of `pending` only once the result is readable, so a
            // listing that races the hand-off either reads the meta or
            // finds the scan still in flight — never misses both and
            // queues a second one.
            {
                let mut q = scans
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                q.pending.remove(&job.path);
            }
            announce(&job.path);
        });
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
        /// The header has not been read yet: a background scan is queued
        /// or running for this file and `start_ns` / `end_ns` /
        /// `message_count` are not its numbers, they are the absence of
        /// them. The grid renders those columns as pending and re-asks
        /// when [`LOG_FILES_SCANNED_EVENT`] lands (ADR 0049 — a partial
        /// answer is first-class, and it says so).
        scan_pending: bool,
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
/// the cached header metadata, or a pending row with one background scan
/// asked for. A file whose header cannot be read still lists — by name,
/// size and modified time — with empty trace columns, rather than
/// disappearing from the folder.
fn file_node(
    path: &Path,
    name: &str,
    cache: &LogFileCache,
    writing: &HashMap<PathBuf, (u64, u64)>,
    scan: &ScanFn,
    announce: &AnnounceFn,
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
            scan_pending: false,
            writing: true,
        });
    }

    let size = metadata.len();
    let Some(meta) = cache.cached(path, size, modified) else {
        cache.request_scan(
            ScanJob {
                path: path.to_path_buf(),
                size,
                modified,
            },
            scan,
            announce,
        );
        return Some(LogFileNode::File {
            id: path_id(path),
            name: name.to_string(),
            size_bytes: size,
            start_ns: None,
            end_ns: None,
            message_count: 0,
            modified_ms,
            scan_pending: true,
            writing: false,
        });
    };
    Some(LogFileNode::File {
        id: path_id(path),
        name: name.to_string(),
        size_bytes: size,
        start_ns: meta.first_timestamp_ns,
        end_ns: meta.last_timestamp_ns,
        message_count: meta.frame_count,
        modified_ms,
        scan_pending: false,
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
    scan: &ScanFn,
    announce: &AnnounceFn,
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
            let children = walk_dir(&path, cache, writing, scan, announce);
            if !children.is_empty() {
                nodes.push(LogFileNode::Dir {
                    id: path_id(&path),
                    name,
                    children,
                });
            }
        } else if file_type.is_file() && is_blf(&path) {
            if let Some(node) = file_node(&path, &name, cache, writing, scan, announce) {
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
///
/// Returns as fast as the directory walk itself: every header it does
/// not already have is a queued background scan, not a read it waits on.
fn list_files(
    dir: &Path,
    cache: &LogFileCache,
    statuses: &[LoggerStatus],
    scan: &ScanFn,
    announce: &AnnounceFn,
) -> Vec<LogFileNode> {
    if !dir.is_dir() {
        return Vec::new();
    }
    walk_dir(dir, cache, &writing_files(statuses), scan, announce)
}

/// The production header read: [`cannet_blf::scan_blf`], with an
/// unreadable file reading as an empty trace rather than failing the row.
fn scan_blf_header(path: &Path) -> FileMeta {
    cannet_blf::scan_blf(path).map_or(
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
}

/// Tauri command — the logger panel's recursive file gridview: `folder`
/// resolved (as [`crate::export_template::resolve_folder`] leaves it),
/// walked for `.blf` files and subdirectories, each finished file's
/// header served from [`LogFileCache`] — or reported pending, with one
/// background scan asked for — and the file any logger is currently
/// writing reported live instead of scanned.
///
/// **This never waits for a header scan** (ADR 0049): its cost is the
/// directory walk, whatever the folder holds. That is what makes it safe
/// for the grid to poll while a logger writes; the previous shape, which
/// scanned every unlisted file inline, turned a 4 Hz poll over a folder
/// of large files into overlapping full reads of the same file.
///
/// `async` and off the blocking pool (ADR 0048, matching
/// [`crate::capture::scan_blf_channels`]): the walk itself is
/// filesystem work whose duration is the folder's, and a cloud-synced
/// folder's stat calls are a network away.
#[tauri::command]
pub async fn list_logger_files(app: AppHandle, folder: String) -> Vec<LogFileNode> {
    crate::sampling::off_async_workers(move || {
        let dir = PathBuf::from(folder);
        let scan: ScanFn = Arc::new(scan_blf_header);
        let announce_app = app.clone();
        let announce: AnnounceFn = Arc::new(move |path: &Path| {
            let _ = announce_app.emit(LOG_FILES_SCANNED_EVENT, path_id(path));
        });
        let cache = app.state::<LogFileCache>();
        let statuses = app.state::<LoggerRuntime>().statuses();
        list_files(&dir, &cache, &statuses, &scan, &announce)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logger::LogWriter;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

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

    /// The production header read, for the tests that want the real
    /// numbers rather than a controllable stub.
    fn real_scan() -> ScanFn {
        Arc::new(scan_blf_header)
    }

    fn no_announce() -> AnnounceFn {
        Arc::new(|_: &Path| {})
    }

    /// One `path` announced per finished scan, so a test can wait for the
    /// background worker instead of sleeping for a guessed duration.
    fn announce_to(tx: mpsc::Sender<PathBuf>) -> AnnounceFn {
        Arc::new(move |p: &Path| {
            let _ = tx.send(p.to_path_buf());
        })
    }

    /// List `dir`, wait for `expect` background scans to land, and list
    /// again — the second listing is what the grid draws once the scans
    /// have announced themselves.
    fn list_and_settle(
        dir: &Path,
        cache: &LogFileCache,
        scan: &ScanFn,
        expect: usize,
    ) -> Vec<LogFileNode> {
        let (tx, rx) = mpsc::channel();
        let announce = announce_to(tx);
        list_files(dir, cache, &[], scan, &announce);
        for _ in 0..expect {
            rx.recv_timeout(Duration::from_secs(10))
                .expect("a queued scan never announced itself");
        }
        list_files(dir, cache, &[], scan, &announce)
    }

    fn files_of(nodes: &[LogFileNode]) -> Vec<&LogFileNode> {
        nodes
            .iter()
            .flat_map(|n| match n {
                LogFileNode::Dir { children, .. } => files_of(children),
                f @ LogFileNode::File { .. } => vec![f],
            })
            .collect()
    }

    // --- LogFileCache ---

    #[test]
    fn a_scan_is_reused_when_size_and_modified_time_are_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        write_test_blf(&dir.path().join("a.blf"), &[(1, 0x1)]);
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&calls);
        let scan: ScanFn = Arc::new(move |p: &Path| {
            counted.fetch_add(1, Ordering::SeqCst);
            scan_blf_header(p)
        });
        let cache = LogFileCache::default();
        list_and_settle(dir.path(), &cache, &scan, 1);
        list_and_settle(dir.path(), &cache, &scan, 0);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "a file that has not moved on disk must not be rescanned"
        );
    }

    #[test]
    fn a_moved_size_or_modified_time_reads_as_uncached() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.blf");
        std::fs::write(&path, b"x").unwrap();
        let stat = std::fs::metadata(&path).unwrap();
        let (size, modified) = (stat.len(), stat.modified().unwrap());
        let cache = LogFileCache::default();
        assert!(cache.cached(&path, size, modified).is_none());

        let (tx, rx) = mpsc::channel();
        cache.request_scan(
            ScanJob {
                path: path.clone(),
                size,
                modified,
            },
            &real_scan(),
            &announce_to(tx),
        );
        rx.recv_timeout(Duration::from_secs(10)).unwrap();

        assert!(cache.cached(&path, size, modified).is_some());
        assert!(
            cache
                .cached(&path, size, modified + Duration::from_secs(5))
                .is_none(),
            "a moved mtime must read as uncached"
        );
        assert!(
            cache.cached(&path, size + 1, modified).is_none(),
            "a moved size must read as uncached"
        );
    }

    // --- exit criterion 3 ---

    #[test]
    fn a_listing_returns_before_any_scan_finishes() {
        // The reference case (ADR 0049): the walk's cost is the walk, not
        // the headers. Every scan is held on a gate for the whole of the
        // listing, so a listing that waited for one could not return at
        // all.
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.blf", "b.blf", "c.blf"] {
            write_test_blf(&dir.path().join(name), &[(1, 0x1)]);
        }
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let held = Arc::clone(&gate);
        let scan: ScanFn = Arc::new(move |p: &Path| {
            let (lock, cv) = &*held;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            drop(open);
            scan_blf_header(p)
        });
        let cache = LogFileCache::default();
        let announce = no_announce();

        let started = std::time::Instant::now();
        let nodes = list_files(dir.path(), &cache, &[], &scan, &announce);
        let elapsed = started.elapsed();

        assert_eq!(files_of(&nodes).len(), 3);
        for node in files_of(&nodes) {
            let LogFileNode::File {
                scan_pending,
                start_ns,
                message_count,
                size_bytes,
                ..
            } = node
            else {
                unreachable!()
            };
            assert!(scan_pending, "an unscanned file must list as pending");
            assert_eq!(*start_ns, None);
            assert_eq!(*message_count, 0);
            assert!(*size_bytes > 0, "stat data is served at once");
        }
        assert!(
            elapsed < Duration::from_secs(2),
            "the listing waited on a scan ({elapsed:?})"
        );

        // Release the worker so the fixture's thread does not outlive the
        // temp directory.
        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }

    #[test]
    fn n_unscanned_files_cost_n_scans_under_overlapping_listings() {
        // Single-flight, the property the pre-fix listing broke: every
        // 250 ms poll that landed during a scan started another full read
        // of the same file. Eight listings overlap here — all issued
        // while every scan is still blocked — and the file count, not the
        // listing count, is what the scanner pays.
        let dir = tempfile::tempdir().unwrap();
        let names = ["a.blf", "b.blf", "c.blf", "d.blf", "e.blf"];
        for name in names {
            write_test_blf(&dir.path().join(name), &[(1, 0x1)]);
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let counted = Arc::clone(&calls);
        let held = Arc::clone(&gate);
        let scan: ScanFn = Arc::new(move |p: &Path| {
            counted.fetch_add(1, Ordering::SeqCst);
            let (lock, cv) = &*held;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            drop(open);
            scan_blf_header(p)
        });
        let cache = LogFileCache::default();
        let (tx, rx) = mpsc::channel();
        let announce = announce_to(tx);

        for _ in 0..8 {
            let nodes = list_files(dir.path(), &cache, &[], &scan, &announce);
            assert!(files_of(&nodes).iter().all(|n| matches!(
                n,
                LogFileNode::File {
                    scan_pending: true,
                    ..
                }
            )));
        }
        {
            let (lock, cv) = &*gate;
            *lock.lock().unwrap() = true;
            cv.notify_all();
        }
        for _ in 0..names.len() {
            rx.recv_timeout(Duration::from_secs(10))
                .expect("a queued scan never announced itself");
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            names.len(),
            "eight overlapping listings of five files must cost five scans"
        );

        // And the listing after them serves the headers, no longer pending.
        let nodes = list_files(dir.path(), &cache, &[], &scan, &announce);
        for node in files_of(&nodes) {
            let LogFileNode::File {
                scan_pending,
                message_count,
                ..
            } = node
            else {
                unreachable!()
            };
            assert!(!scan_pending);
            assert_eq!(*message_count, 1);
        }
        assert_eq!(calls.load(Ordering::SeqCst), names.len());
    }

    #[test]
    fn a_finished_scan_announces_the_file_it_read() {
        let dir = tempfile::tempdir().unwrap();
        write_test_blf(&dir.path().join("run.blf"), &[(1, 0x1)]);
        let (tx, rx) = mpsc::channel();
        let announce = announce_to(tx);
        let cache = LogFileCache::default();
        list_files(dir.path(), &cache, &[], &real_scan(), &announce);
        let announced = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(announced, dir.path().join("run.blf"));
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
        let scan = real_scan();
        let nodes = list_and_settle(dir.path(), &cache, &scan, 1);
        assert_eq!(nodes.len(), 1);
        match &nodes[0] {
            LogFileNode::File {
                name,
                message_count,
                start_ns,
                end_ns,
                writing,
                scan_pending,
                ..
            } => {
                assert_eq!(name, "run.blf");
                assert_eq!(*message_count, 2);
                assert_eq!(*start_ns, Some(1_700_000_000_000_000_000));
                assert_eq!(*end_ns, Some(1_700_000_000_500_000_000));
                assert!(!writing);
                assert!(!scan_pending);
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
        let nodes = list_files(dir.path(), &cache, &[], &real_scan(), &no_announce());
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
        assert!(list_files(dir.path(), &cache, &[], &real_scan(), &no_announce()).is_empty());
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
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&calls);
        let scan: ScanFn = Arc::new(move |p: &Path| {
            counted.fetch_add(1, Ordering::SeqCst);
            scan_blf_header(p)
        });
        let nodes = list_files(dir.path(), &cache, &statuses, &scan, &no_announce());
        assert_eq!(nodes.len(), 1);
        match &nodes[0] {
            LogFileNode::File {
                size_bytes,
                message_count,
                start_ns,
                writing,
                scan_pending,
                ..
            } => {
                assert_eq!(*size_bytes, 12_345);
                assert_eq!(*message_count, 7);
                assert_eq!(*start_ns, None);
                assert!(*writing);
                assert!(
                    !scan_pending,
                    "the writing row is live, not waiting for a scan"
                );
            }
            other @ LogFileNode::Dir { .. } => panic!("expected a file node, got {other:?}"),
        }
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "the file being written must never be queued for a scan"
        );
    }

    #[test]
    fn a_missing_folder_lists_as_empty_rather_than_erroring() {
        let cache = LogFileCache::default();
        let nodes = list_files(
            Path::new("this/does/not/exist"),
            &cache,
            &[],
            &real_scan(),
            &no_announce(),
        );
        assert!(nodes.is_empty());
    }

    #[test]
    fn entries_are_sorted_by_name() {
        let dir = tempfile::tempdir().unwrap();
        write_test_blf(&dir.path().join("b.blf"), &[(1, 0x1)]);
        write_test_blf(&dir.path().join("a.blf"), &[(1, 0x1)]);
        let cache = LogFileCache::default();
        let names: Vec<String> = list_files(dir.path(), &cache, &[], &real_scan(), &no_announce())
            .into_iter()
            .map(|n| match n {
                LogFileNode::File { name, .. } | LogFileNode::Dir { name, .. } => name,
            })
            .collect();
        assert_eq!(names, vec!["a.blf".to_string(), "b.blf".to_string()]);
    }
}
