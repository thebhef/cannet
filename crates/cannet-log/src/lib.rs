//! The rolling log file every cannet host writes, and the timestamp
//! its lines are stamped with.
//!
//! Both hosts — the GUI (`cannet.log`) and the headless server
//! (`cannet-server.log`) — want the same artifact: a plain-text log a
//! user can attach to a bug report, that survives an instant death and
//! cannot fill a disk. The semantics are therefore fixed, not
//! configurable:
//!
//! - **Flushed on every write.** A log that is still in a buffer when
//!   the process is killed is not evidence. The cost is one `write` +
//!   `flush` syscall pair per line, which is nothing next to the work
//!   either host is doing between lines.
//! - **Size-rotated to a single generation.** Past the cap the file is
//!   renamed `<name>.1` (clobbering any previous one) and a fresh file
//!   started, so disk use is bounded to ~2× the cap. One generation,
//!   because the interesting part of a log is its tail.
//! - **Append-only, created on demand**, directory included.
//!
//! This crate deliberately holds no state: the *caller* owns the
//! directory, the file name, the cap, and any lock that serialises
//! concurrent writers, because those differ per host (the GUI reads its
//! cap from a live settings file; the server's is a constant, and its
//! panic path must be able to bypass the lock without deadlocking).
//! What is shared is the part that must not drift between the two —
//! how a block reaches the disk and how an instant is spelled.

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Append `block` to `dir/name`, creating the directory if needed,
/// rotating first if the file has grown past `cap`, and flushing before
/// returning.
///
/// `block` is written as-is, so a caller that wants one line per record
/// supplies the trailing newline itself (and a multi-line record — a
/// panic report, say — is one block, which keeps it contiguous).
pub fn append_block(dir: &Path, name: &str, cap: u64, block: &str) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(name);
    rotate_if_needed(&path, cap)?;
    let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
    f.write_all(block.as_bytes())?;
    f.flush()
}

/// If `path` exists and exceeds `cap`, rename it to `<path>.1` (one
/// retained generation), clobbering any previous `.1`. A missing file or
/// a stat failure is a no-op — the caller will create it fresh.
fn rotate_if_needed(path: &Path, cap: u64) -> io::Result<()> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(());
    };
    if meta.len() > cap {
        let mut rotated = path.as_os_str().to_owned();
        rotated.push(".1");
        std::fs::rename(path, PathBuf::from(rotated))?;
    }
    Ok(())
}

/// Format an epoch-millisecond instant as an ISO-8601 / RFC-3339 UTC
/// timestamp, e.g. `2026-06-21T14:30:45.123Z`. Falls back to the raw
/// millisecond count if the value is somehow out of `chrono`'s range
/// (not reachable for real wall-clock times).
#[must_use]
pub fn iso8601_from_ms(ts_ms: u64) -> String {
    i64::try_from(ts_ms)
        .ok()
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map_or_else(
            || ts_ms.to_string(),
            |dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        )
}

/// The wall clock as epoch milliseconds, or `0` if it is somehow before
/// the epoch. Read through `std::time` rather than `chrono` so the
/// dependency is only ever asked to format.
#[must_use]
pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG_FILE: &str = "cannet.log";

    #[test]
    fn append_block_accumulates_across_calls() {
        let dir = tempfile::tempdir().unwrap();
        append_block(dir.path(), LOG_FILE, 1024, "first\n").unwrap();
        append_block(dir.path(), LOG_FILE, 1024, "second\n").unwrap();
        let body = std::fs::read_to_string(dir.path().join(LOG_FILE)).unwrap();
        assert_eq!(body, "first\nsecond\n");
    }

    #[test]
    fn append_block_creates_a_missing_directory() {
        // Neither host guarantees its log directory exists before the
        // first line — the GUI's is a per-OS path that may never have
        // been used, the server's is created on first identity write.
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("nested").join("logs");
        append_block(&dir, LOG_FILE, 1024, "hello\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(LOG_FILE)).unwrap(),
            "hello\n"
        );
    }

    #[test]
    fn append_block_rotates_past_cap() {
        let dir = tempfile::tempdir().unwrap();
        // Cap of 0 forces a rotation on every call after the first write.
        append_block(dir.path(), LOG_FILE, 0, "first\n").unwrap();
        append_block(dir.path(), LOG_FILE, 0, "second\n").unwrap();
        // The first file was rotated aside; both exist.
        assert!(dir.path().join(LOG_FILE).exists());
        assert!(dir.path().join(format!("{LOG_FILE}.1")).exists());
        // The live file starts fresh with only the latest write.
        let live = std::fs::read_to_string(dir.path().join(LOG_FILE)).unwrap();
        assert_eq!(live, "second\n");
        let rotated = std::fs::read_to_string(dir.path().join(format!("{LOG_FILE}.1"))).unwrap();
        assert_eq!(rotated, "first\n");
    }

    #[test]
    fn only_one_generation_is_retained() {
        // Disk use is bounded to ~2× the cap, which only holds if the
        // second rotation clobbers the first `.1` rather than shifting
        // it along to a `.2`.
        let dir = tempfile::tempdir().unwrap();
        for line in ["first\n", "second\n", "third\n"] {
            append_block(dir.path(), LOG_FILE, 0, line).unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join(format!("{LOG_FILE}.1"))).unwrap(),
            "second\n"
        );
        assert!(!dir.path().join(format!("{LOG_FILE}.2")).exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn iso8601_from_ms_renders_rfc3339_utc_millis() {
        // 1_000 ms after the epoch, with sub-second millis preserved.
        assert_eq!(iso8601_from_ms(1_700), "1970-01-01T00:00:01.700Z");
        assert_eq!(iso8601_from_ms(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn unix_ms_is_a_plausible_wall_clock_reading() {
        // Sanity only: past 2020 (1_577_836_800_000) and formattable.
        let now = unix_ms();
        assert!(now > 1_577_836_800_000, "{now}");
        assert!(iso8601_from_ms(now).ends_with('Z'));
    }
}
