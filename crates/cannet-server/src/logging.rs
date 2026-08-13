//! The server's two log sinks, and the one line that is allowed only
//! on the first of them.
//!
//! A headless server used to log by `eprintln!`: no timestamps, no
//! level tags, and nothing on disk — so an operator reporting "it hung
//! for minutes" had no record to correlate against, and a console
//! closed after the fact took the whole session's evidence with it.
//! This module gives it the same treatment the GUI host has:
//!
//! - **stderr**, which stays the operator's live console, and
//! - a **rolling [`LOG_FILE`]** in the server's per-user directory —
//!   append-only, flushed on every write, size-rotated to a single
//!   `.1` generation ([`cannet_log`]).
//!
//! Both sinks carry the same line: `<rfc3339> <LEVEL> <source>:
//! <message>`. There is no minimum level on either — the file's floor
//! is `debug`, i.e. everything, and the only verbosity knob that
//! exists is `--sidecar-log-level`, which governs how much the
//! supervised sidecar says in the first place. A log the operator has
//! to configure before it is useful is a log that is empty when it
//! matters.
//!
//! ## The one thing that never reaches the file
//!
//! The startup banner that hands the operator their client token is
//! [`console_only`]: it is printed to stderr and is not a log line at
//! all. A bearer token in a file that gets attached to bug reports is
//! a credential leak with a long tail, and the file has no use for the
//! value — only for the fact, which is [`token_configured_note`]. That
//! function takes no argument, so it cannot be handed a token by
//! accident; the same structural argument keeps `Debug` off
//! [`crate::AccessToken`] and [`crate::ServerIdentity`]. The
//! certificate fingerprint is *not* in this category — it is public by
//! design (ADR 0041), and pinning clients compare it out of band — so
//! it is an ordinary logged line.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Rolling log file name inside [`dir`].
pub const LOG_FILE: &str = "cannet-server.log";

/// Rotate the log once it passes this size: the current file is renamed
/// to `cannet-server.log.1` (one generation kept) and a fresh one
/// started, so disk use is bounded to ~2× this. The same figure the GUI
/// host defaults to — a server has no settings file to make it a knob.
const LOG_CAP_BYTES: u64 = 5 * 1024 * 1024;

/// Source tag on everything the proxy itself says, as against the
/// supervised sidecar (which uses `cannet_sidecar::SOURCE`).
pub const PROXY: &str = "hardware proxy";

/// Source tag for the process as a whole — a fatal startup error that
/// belongs to no particular mode.
pub const SERVER: &str = "cannet-server";

/// Source tag for the `debug replay` dev/test mode.
pub const REPLAY: &str = "replay";

/// Source tag for the `debug vbus` dev/test mode.
pub const VBUS: &str = "vbus";

/// Severity of a log line. Deliberately this crate's own rather than
/// the sidecar host trait's: what a supervised child's stderr line was
/// classified as and what this server has to say are two ladders that
/// happen to have the same rungs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

fn level_tag(level: Level) -> &'static str {
    match level {
        Level::Debug => "DEBUG",
        Level::Info => "INFO",
        Level::Warn => "WARN",
        Level::Error => "ERROR",
    }
}

/// Where the rolling file goes, or `None` when there is no file sink —
/// set once at startup. Until then (and if the per-user directory can't
/// be resolved) logging is stderr-only, which is what the server did
/// before it had a file at all.
static LOG_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Serializes writes so lines from the proxy, the supervisor's wait
/// loop, and the sidecar's stderr reader don't interleave.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Point the file sink at `dir`. Idempotent — the first call wins — and
/// `None` leaves the server stderr-only.
pub fn init(dir: Option<PathBuf>) {
    let _ = LOG_DIR.set(dir);
}

/// The directory holding the rolling log, once [`init`] has installed
/// one. Also where the supervised sidecar is told to write its own
/// always-debug logfile, so one directory holds the whole picture.
pub fn dir() -> Option<PathBuf> {
    LOG_DIR.get().cloned().flatten()
}

/// Write one line to both sinks.
pub fn emit(level: Level, source: &str, message: &str) {
    let line = format_line(cannet_log::unix_ms(), level, source, message);
    eprint!("{line}");
    if let Some(dir) = dir() {
        append_to(&dir, &line);
    }
}

pub fn info(source: &str, message: impl AsRef<str>) {
    emit(Level::Info, source, message.as_ref());
}

pub fn warn(source: &str, message: impl AsRef<str>) {
    emit(Level::Warn, source, message.as_ref());
}

pub fn error(source: &str, message: impl AsRef<str>) {
    emit(Level::Error, source, message.as_ref());
}

/// Print to the operator's console **only**, bypassing the log layer
/// entirely — no timestamp, no level, and above all no file.
///
/// Reserved for credential material the operator reads off the screen
/// and carries to the client. Anything printed here is invisible to
/// every later diagnosis, which is the point; if a line wants to be in
/// the log, it is not a [`console_only`] line.
pub fn console_only(message: &str) {
    eprintln!("{message}");
}

/// What the *file* is allowed to know about the client token: that
/// there is one. Takes no argument on purpose — there is no way to
/// hand this function a secret, so no future edit can accidentally
/// interpolate one into the log.
pub fn token_configured_note() -> &'static str {
    "a client token is required on every RPC; its value was printed to the console"
}

/// Render one line, trailing newline included. Pure; unit-testable.
fn format_line(ts_ms: u64, level: Level, source: &str, message: &str) -> String {
    format!(
        "{} {} {source}: {message}\n",
        cannet_log::iso8601_from_ms(ts_ms),
        level_tag(level),
    )
}

/// Append an already-rendered line to the rolling file under
/// [`WRITE_LOCK`]. Best-effort: a write failure is swallowed, because
/// the alternative — reporting it — would be another log line, and the
/// sink that would carry it is the one that just failed.
fn append_to(dir: &Path, line: &str) {
    let _guard = WRITE_LOCK.lock();
    let _ = cannet_log::append_block(dir, LOG_FILE, LOG_CAP_BYTES, line);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_carries_the_timestamp_the_level_and_the_source() {
        assert_eq!(
            format_line(1_700, Level::Info, PROXY, "listening on 127.0.0.1:50051"),
            "1970-01-01T00:00:01.700Z INFO hardware proxy: listening on 127.0.0.1:50051\n"
        );
    }

    #[test]
    fn every_level_has_its_own_tag() {
        let tags: Vec<&str> = [Level::Debug, Level::Info, Level::Warn, Level::Error]
            .into_iter()
            .map(level_tag)
            .collect();
        assert_eq!(tags, ["DEBUG", "INFO", "WARN", "ERROR"]);
    }

    #[test]
    fn lines_accumulate_in_the_rolling_file() {
        let dir = tempfile::tempdir().unwrap();
        append_to(dir.path(), &format_line(0, Level::Info, PROXY, "starting"));
        append_to(dir.path(), &format_line(1, Level::Warn, PROXY, "hmm"));
        let body = std::fs::read_to_string(dir.path().join(LOG_FILE)).unwrap();
        assert_eq!(
            body,
            "1970-01-01T00:00:00.000Z INFO hardware proxy: starting\n\
             1970-01-01T00:00:00.001Z WARN hardware proxy: hmm\n"
        );
    }

    #[test]
    fn the_file_records_that_a_token_is_configured_but_cannot_record_its_value() {
        // The owner's ruling: the token reaches the operator's console
        // and nothing else. The file still has to say authentication is
        // on — an endpoint that silently required a credential would be
        // undiagnosable — so the note is structurally incapable of
        // carrying one: `token_configured_note` takes no argument, the
        // same way `AccessToken` has no `Debug` impl.
        let dir = tempfile::tempdir().unwrap();
        append_to(
            dir.path(),
            &format_line(0, Level::Info, PROXY, token_configured_note()),
        );
        let body = std::fs::read_to_string(dir.path().join(LOG_FILE)).unwrap();
        assert!(body.contains("client token"), "{body}");
        // Nothing token-shaped: the generated token is 43 base64url
        // characters, an operator's is arbitrary. The note has no field
        // either could occupy.
        assert!(!body.contains('='), "{body}");
        assert_eq!(body.lines().count(), 1);
    }
}
