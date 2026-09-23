//! The exclusive lock over a project's cache directory ([ADR 0002](../../../docs/adr/0002-disk-spill-store.md)
//! DS-7).
//!
//! The scratch is keyed on the *project*, not on the process
//! ([ADR 0042](../../../docs/adr/0042-project-directory-and-scopes.md)),
//! so two cannet processes with the same project open would otherwise
//! share one directory — and a memory mapping belongs to the file, not
//! to the process that made it. Two sessions mapping one scratch is not
//! a race that can be made safe: a segment file one of them has grown
//! past the other's manifest is a file the other will `truncate` and
//! `set_len` under a live mapping, which Windows refuses outright
//! (`ERROR_USER_MAPPED_FILE`, 1224) and POSIX does silently, zeroing the
//! other session's data.
//!
//! So the directory is owned, exclusively, for the life of a session.
//! [`ScratchLock::acquire`] takes it or fails immediately; there is no
//! wait, because a directory another live process holds does not become
//! free on any schedule the user is waiting on.
//!
//! **Two files, not one.** The lock itself is an empty sentinel
//! ([`LOCK_FILE`]) held through [`std::fs::File::try_lock`] — `flock`
//! on POSIX, `LockFileEx` on Windows. Windows byte-range locks are
//! *mandatory*: a second process cannot even read a locked range, so
//! the holder's identity cannot live inside the locked file. It goes in
//! a plain sibling ([`HOLDER_FILE`]) that the refused session reads to
//! say who is holding the directory. The record is only ever trusted
//! when the lock is actually held, so a copy left behind by a process
//! that died cannot mislead: whoever takes the lock next rewrites it.

use std::fmt;
use std::fs::{File, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The lock sentinel inside the cache directory. Always empty — its
/// contents are never read, only its lock state matters.
const LOCK_FILE: &str = "cache.lock";

/// The holder record beside it: who owns the directory right now.
const HOLDER_FILE: &str = "cache.lock.holder";

/// Both files [`ScratchLock`] owns. Callers that move a scratch
/// directory's contents elsewhere must leave these behind — they belong
/// to the directory, not to the capture in it.
pub const SCRATCH_LOCK_FILES: [&str; 2] = [LOCK_FILE, HOLDER_FILE];

/// Who holds a cache directory, as the holding process recorded it.
///
/// Best-effort: a refused session reads this to name the holder, and
/// falls back to an unnamed refusal if the record is missing or
/// unreadable (it is written just after the lock is taken, so there is a
/// microsecond-wide window where it is not there yet).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScratchHolder {
    /// OS process id of the cannet holding the directory.
    pub pid: u32,
    /// The project that process has open, for the refusal message.
    /// Empty when the session has no project file.
    pub project: String,
}

/// Why a cache directory could not be taken.
#[derive(Debug)]
pub enum ScratchLockError {
    /// Another live process holds it. The session that hit this refuses
    /// the project open — it does **not** wait, and it does not fall
    /// back to an unlocked store over the same files.
    Held(Option<ScratchHolder>),
    /// The lock file itself could not be created or opened — a cache
    /// directory that cannot be *made*, not one that is held. That is
    /// the degradation the in-RAM store exists for.
    Io(io::Error),
}

impl fmt::Display for ScratchLockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Held(Some(h)) if h.project.is_empty() => write!(
                f,
                "another cannet (pid {}) still holds this project's cache \
                 — it may still be closing",
                h.pid
            ),
            Self::Held(Some(h)) => write!(
                f,
                "another cannet (pid {}) still holds this project's cache \
                 ({}) — it may still be closing",
                h.pid, h.project
            ),
            Self::Held(None) => write!(
                f,
                "another cannet still holds this project's cache \
                 — it may still be closing"
            ),
            Self::Io(e) => write!(f, "this project's cache could not be locked: {e}"),
        }
    }
}

impl std::error::Error for ScratchLockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Held(_) => None,
            Self::Io(e) => Some(e),
        }
    }
}

impl From<io::Error> for ScratchLockError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// Exclusive ownership of one cache directory, held for as long as the
/// value lives. Dropping it releases the directory for the next session.
///
/// It covers **everything** under the directory — the raw meta/payload
/// segments, the by-id postings, the signal pyramids, the filter index,
/// the manifest and the JSON records beside it — because it is the
/// directory that is owned, not any one family in it.
#[derive(Debug)]
pub struct ScratchLock {
    dir: PathBuf,
    /// Closing this handle is what releases the OS lock; nothing else
    /// reads it.
    _file: File,
}

impl ScratchLock {
    /// Take `dir` exclusively, recording `project` as the holder's
    /// project for whoever is refused next. Creates `dir` if it is not
    /// there.
    ///
    /// Fails immediately with [`ScratchLockError::Held`] when another
    /// process owns the directory — never waits.
    pub fn acquire(dir: &Path, project: &Path) -> Result<Self, ScratchLockError> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(LOCK_FILE);
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(ScratchLockError::Held(read_holder(dir)));
            }
            Err(TryLockError::Error(e)) => return Err(ScratchLockError::Io(e)),
        }
        // Only now that the directory is ours: the record describes the
        // holder, so it must never be written by a session that was
        // refused.
        write_holder(
            dir,
            &ScratchHolder {
                pid: std::process::id(),
                project: project.display().to_string(),
            },
        );
        Ok(Self {
            dir: dir.to_path_buf(),
            _file: file,
        })
    }

    /// The directory this lock owns.
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

impl Drop for ScratchLock {
    fn drop(&mut self) {
        // The OS lock goes with `_file`. The holder record is ours to
        // clean up; a leftover one is harmless (it is only read while
        // someone holds the lock) but leaves a stale pid on disk.
        let _ = std::fs::remove_file(self.dir.join(HOLDER_FILE));
    }
}

/// The holder record, or `None` when it is absent or unreadable.
fn read_holder(dir: &Path) -> Option<ScratchHolder> {
    let bytes = std::fs::read(dir.join(HOLDER_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Write the holder record. Best-effort: failing to record who we are
/// costs the *next* session a name in its refusal message, which is not
/// worth failing an otherwise successful acquire over.
fn write_holder(dir: &Path, holder: &ScratchHolder) {
    let Ok(bytes) = serde_json::to_vec(holder) else {
        return;
    };
    // Written in place rather than temp-file+rename: the file is ours
    // alone while the lock is held, and a rename over it on Windows
    // would contend with a refused session reading it.
    if let Ok(mut f) = File::create(dir.join(HOLDER_FILE)) {
        let _ = f.write_all(&bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn prj() -> &'static Path {
        Path::new("C:/projects/demo.cannet_prj")
    }

    #[test]
    fn an_unheld_directory_is_taken() {
        let dir = TempDir::new().unwrap();
        let lock = ScratchLock::acquire(dir.path(), prj()).unwrap();
        assert_eq!(lock.dir(), dir.path());
        assert!(dir.path().join(LOCK_FILE).is_file());
    }

    #[test]
    fn a_missing_directory_is_created() {
        let base = TempDir::new().unwrap();
        let dir = base.path().join("cache").join("deadbeef");
        let _lock = ScratchLock::acquire(&dir, prj()).unwrap();
        assert!(dir.join(LOCK_FILE).is_file());
    }

    #[test]
    fn a_held_directory_is_refused_and_names_the_holder() {
        let dir = TempDir::new().unwrap();
        let _held = ScratchLock::acquire(dir.path(), prj()).unwrap();
        let err = ScratchLock::acquire(dir.path(), Path::new("other.cannet_prj"))
            .expect_err("the directory is held");
        let ScratchLockError::Held(holder) = &err else {
            panic!("expected a held directory, got {err}");
        };
        let holder = holder.clone().expect("the holder record is readable");
        assert_eq!(holder.pid, std::process::id());
        assert_eq!(holder.project, prj().display().to_string());
        let msg = err.to_string();
        assert!(msg.contains(&std::process::id().to_string()), "{msg}");
        assert!(msg.contains("demo.cannet_prj"), "{msg}");
        assert!(msg.contains("may still be closing"), "{msg}");
    }

    #[test]
    fn a_released_directory_is_taken_by_the_next_session() {
        let dir = TempDir::new().unwrap();
        let held = ScratchLock::acquire(dir.path(), prj()).unwrap();
        assert!(ScratchLock::acquire(dir.path(), prj()).is_err());
        drop(held);
        let next = ScratchLock::acquire(dir.path(), Path::new("next.cannet_prj")).unwrap();
        assert_eq!(next.dir(), dir.path());
        assert_eq!(
            read_holder(dir.path())
                .expect("the new holder recorded itself")
                .project,
            "next.cannet_prj"
        );
    }

    #[test]
    fn two_directories_are_held_at_once() {
        // A re-root takes the destination before it releases the source,
        // so the two locks overlap by construction.
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        let _one = ScratchLock::acquire(a.path(), prj()).unwrap();
        let _two = ScratchLock::acquire(b.path(), prj()).unwrap();
    }

    #[test]
    fn a_refused_session_does_not_overwrite_the_holder_record() {
        let dir = TempDir::new().unwrap();
        let _held = ScratchLock::acquire(dir.path(), prj()).unwrap();
        let _ = ScratchLock::acquire(dir.path(), Path::new("intruder.cannet_prj"));
        assert_eq!(
            read_holder(dir.path())
                .expect("the holder record survives")
                .project,
            prj().display().to_string()
        );
    }

    #[test]
    fn a_stale_holder_record_is_replaced_not_believed() {
        // What a process that died without unwinding leaves behind: a
        // holder record with nobody holding the lock. The next session
        // takes the directory and rewrites it.
        let dir = TempDir::new().unwrap();
        write_holder(
            dir.path(),
            &ScratchHolder {
                pid: 999_999,
                project: "ghost.cannet_prj".into(),
            },
        );
        let _lock = ScratchLock::acquire(dir.path(), prj()).unwrap();
        assert_eq!(read_holder(dir.path()).unwrap().pid, std::process::id());
    }

    #[test]
    fn a_directory_path_that_is_a_file_is_an_io_error_not_a_refusal() {
        // "The cache cannot be created" — the case the in-RAM store
        // stands in for — must never read as "another cannet holds it".
        let base = TempDir::new().unwrap();
        let path = base.path().join("not-a-dir");
        std::fs::write(&path, b"x").unwrap();
        let err = ScratchLock::acquire(&path, prj()).expect_err("cannot be a directory");
        assert!(
            matches!(err, ScratchLockError::Io(_)),
            "expected an I/O error, got {err}"
        );
    }
}
