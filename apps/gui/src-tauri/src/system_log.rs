//! Host-side structured log bus (Phase 7).
//!
//! A single in-process [`SystemLog`] holds a bounded ring of
//! [`SystemMessage`]s — `{ ts_ms, source, level, message }` — that the
//! System Messages panel renders. Call sites push through the [`info!`],
//! [`warn!`], and [`error!`] macros in this module, which:
//!
//! 1. emit a `tracing::event!` so the normal `tracing-subscriber` `fmt`
//!    layer (initialised via [`init_tracing_subscriber`]) still writes
//!    to stderr for development; and
//! 2. append a [`SystemMessage`] to the ring, after passing through a
//!    per-`(source, template)` rate limiter so a runaway emitter can
//!    only contribute a few entries per second.
//!
//! Sources are short stable strings (`"project"`, `"dbc"`,
//! `"connection"`, `"blf-import"`, `"plot"`; vendor sidecars will use
//! `"sidecar:<vendor>"` from Phase 8). Levels are
//! [`LogLevel::Info`] / `Warn` / `Error`.
//!
//! The ring is bounded — the oldest message is dropped when capacity is
//! reached — so a long-running session can't grow the buffer unboundedly.
//! `seq` is a monotonic id over the ring's lifetime (it doesn't wrap on
//! eviction); the frontend uses it to suppress duplicates when the
//! `system-log-appended` event and a manual `fetch_system_log` race.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Capacity of the in-process ring. Comfortably larger than any
/// realistic per-session message volume but small enough that a worst-
/// case dump (every entry copied into one IPC response) stays cheap.
pub const RING_CAPACITY: usize = 4096;

/// Rate-limiter window. A `(source, template)` pair contributes at
/// most [`RATE_LIMIT_BURST`] messages inside one window.
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(1);
/// Burst budget per `(source, template)` per window. Past this, a
/// short suppression note is recorded once and further duplicates are
/// silently dropped until the window rolls over.
const RATE_LIMIT_BURST: usize = 5;

/// Severity of a system message. Maps onto the panel's level-filter
/// dropdown — the panel defaults to `Warn` so an informational source
/// doesn't bury a real error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    /// Ordering for the panel's "minimum level" filter. The frontend
    /// has its own copy of this ordering (in `types.ts`); both must
    /// agree for the panel's level filter to behave consistently.
    #[must_use]
    #[cfg(test)]
    pub fn rank(self) -> u8 {
        match self {
            Self::Info => 0,
            Self::Warn => 1,
            Self::Error => 2,
        }
    }
}

/// One entry in the log bus. `seq` is monotonic over the bus lifetime
/// (it does not reset when the ring rolls). `ts_ms` is Unix-epoch
/// milliseconds — the frontend renders it in the user's locale.
#[derive(Debug, Clone, Serialize)]
pub struct SystemMessage {
    pub seq: u64,
    /// Unix-epoch milliseconds.
    pub ts_ms: u64,
    pub source: String,
    pub level: LogLevel,
    pub message: String,
}

/// The bounded ring + rate-limiter state. Wrapped in a [`Mutex`] for
/// shared access; every method takes the lock for the duration of the
/// call. The frontend reads via [`SystemLog::snapshot`] (one allocation
/// per call) and a `system-log-appended` event the host emits whenever
/// `push` succeeds.
pub struct SystemLog {
    inner: Mutex<Inner>,
}

struct Inner {
    ring: VecDeque<SystemMessage>,
    next_seq: u64,
    /// Per-`(source, template)` recent push timestamps. A `template` is
    /// usually just the message (the call sites that need a real
    /// template separator can pass one explicitly via
    /// [`SystemLog::push_with_template`]). The deque holds the last
    /// [`RATE_LIMIT_BURST`] push times within the current
    /// [`RATE_LIMIT_WINDOW`]; older entries are pruned on each push.
    recent: std::collections::HashMap<(String, String), VecDeque<Instant>>,
}

impl SystemLog {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                ring: VecDeque::with_capacity(RING_CAPACITY),
                next_seq: 0,
                recent: std::collections::HashMap::new(),
            }),
        }
    }

    /// Push a message, with the rate-limit template defaulting to the
    /// message text itself. Returns the appended [`SystemMessage`] —
    /// or `None` if the rate limiter dropped this one.
    pub fn push(&self, source: &str, level: LogLevel, message: impl Into<String>) -> Option<SystemMessage> {
        let msg = message.into();
        let template = msg.clone();
        self.push_with_template(source, level, &template, msg)
    }

    /// Push a message with an explicit rate-limit template — distinct
    /// from the rendered message. Useful where the message has a
    /// per-call variable (a path, an index) but the *kind* of event
    /// is the same and should share a rate-limit bucket.
    pub fn push_with_template(
        &self,
        source: &str,
        level: LogLevel,
        template: &str,
        message: impl Into<String>,
    ) -> Option<SystemMessage> {
        let message = message.into();
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("system_log mutex poisoned");
        let key = (source.to_string(), template.to_string());
        let times = inner.recent.entry(key).or_default();
        // Prune older-than-window timestamps before deciding.
        while times.front().is_some_and(|t| now.duration_since(*t) > RATE_LIMIT_WINDOW) {
            times.pop_front();
        }
        let suppressed = times.len() >= RATE_LIMIT_BURST;
        times.push_back(now);
        let ts_ms = current_unix_ms();
        if suppressed {
            // First suppression in this window emits a single note so
            // the panel doesn't go silent under a flood; further drops
            // are invisible until the window rolls.
            if times.len() == RATE_LIMIT_BURST + 1 {
                let note = SystemMessage {
                    seq: inner.next_seq,
                    ts_ms,
                    source: source.to_string(),
                    level: LogLevel::Warn,
                    message: format!(
                        "rate-limited '{template}' from {source} — further duplicates suppressed for ~1s"
                    ),
                };
                inner.next_seq += 1;
                push_ring(&mut inner.ring, note.clone());
                return Some(note);
            }
            return None;
        }
        let entry = SystemMessage {
            seq: inner.next_seq,
            ts_ms,
            source: source.to_string(),
            level,
            message,
        };
        inner.next_seq += 1;
        push_ring(&mut inner.ring, entry.clone());
        Some(entry)
    }

    /// Snapshot the ring's contents in chronological order. One
    /// allocation per call; the frontend keeps its own copy + applies
    /// per-panel filters on top.
    #[must_use]
    pub fn snapshot(&self) -> Vec<SystemMessage> {
        let inner = self.inner.lock().expect("system_log mutex poisoned");
        inner.ring.iter().cloned().collect()
    }

    /// Clear the ring. The next-seq counter does **not** reset — the
    /// frontend uses `seq` to de-duplicate against any in-flight event
    /// payloads, so resetting would risk delivering a stale "seq=0"
    /// after a clear.
    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("system_log mutex poisoned");
        inner.ring.clear();
        inner.recent.clear();
    }

    /// Number of messages currently in the ring (test-only helper).
    #[must_use]
    #[cfg(test)]
    pub fn len(&self) -> usize {
        let inner = self.inner.lock().expect("system_log mutex poisoned");
        inner.ring.len()
    }
}

impl Default for SystemLog {
    fn default() -> Self {
        Self::new()
    }
}

fn push_ring(ring: &mut VecDeque<SystemMessage>, msg: SystemMessage) {
    if ring.len() == RING_CAPACITY {
        ring.pop_front();
    }
    ring.push_back(msg);
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Initialise the global `tracing` subscriber once at process start.
/// The fan-out from the [`info!`] / [`warn!`] / [`error!`] macros emits
/// a `tracing::event!` *and* pushes into the ring; this subscriber is
/// what makes the `event!` half visible on stderr during development.
/// Safe to call multiple times — the underlying registry is idempotent.
pub fn init_tracing_subscriber() {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt};
    let _ = tracing_subscriber::registry().with(fmt::layer()).try_init();
}

/// Emit at info level. Fans the formatted message into the host's
/// `SystemLog` ring (via the `AppHandle`'s `SystemLog` state) and the
/// `tracing` subscriber, then broadcasts a `system-log-appended`
/// Tauri event so any open System Messages panel updates live.
///
/// `$app` is an `&AppHandle` (or `AppHandle`). `$source` is a short
/// stable tag (`"project"`, `"dbc"`, …). The rest is `format!`-style.
#[macro_export]
macro_rules! sys_info {
    ($app:expr, $source:expr, $($arg:tt)*) => {{
        let __msg = format!($($arg)*);
        ::tracing::info!(target: "cannet", source = $source, "{}", __msg);
        $crate::emit_system_log($app, $source, $crate::system_log::LogLevel::Info, __msg);
    }};
}

/// Emit at warn level. See [`sys_info!`].
#[macro_export]
macro_rules! sys_warn {
    ($app:expr, $source:expr, $($arg:tt)*) => {{
        let __msg = format!($($arg)*);
        ::tracing::warn!(target: "cannet", source = $source, "{}", __msg);
        $crate::emit_system_log($app, $source, $crate::system_log::LogLevel::Warn, __msg);
    }};
}

/// Emit at error level. See [`sys_info!`].
#[macro_export]
macro_rules! sys_error {
    ($app:expr, $source:expr, $($arg:tt)*) => {{
        let __msg = format!($($arg)*);
        ::tracing::error!(target: "cannet", source = $source, "{}", __msg);
        $crate::emit_system_log($app, $source, $crate::system_log::LogLevel::Error, __msg);
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_returns_entries_with_monotonic_seq() {
        let log = SystemLog::new();
        let a = log.push("project", LogLevel::Info, "one").unwrap();
        let b = log.push("project", LogLevel::Info, "two").unwrap();
        assert_eq!(a.seq + 1, b.seq);
        assert_eq!(log.len(), 2);
    }

    #[test]
    fn snapshot_returns_chronological_copy() {
        let log = SystemLog::new();
        log.push("dbc", LogLevel::Warn, "first").unwrap();
        log.push("dbc", LogLevel::Error, "second").unwrap();
        let snap = log.snapshot();
        assert_eq!(snap.iter().map(|m| m.message.as_str()).collect::<Vec<_>>(),
                   vec!["first", "second"]);
    }

    #[test]
    fn ring_evicts_oldest_at_capacity() {
        let log = SystemLog::new();
        for i in 0..(RING_CAPACITY + 10) {
            log.push_with_template(
                "test",
                LogLevel::Info,
                &format!("tpl-{i}"), // unique template, bypass rate limiter
                format!("msg {i}"),
            );
        }
        assert_eq!(log.len(), RING_CAPACITY);
        let snap = log.snapshot();
        // Oldest 10 entries were evicted.
        assert_eq!(snap.first().unwrap().message, format!("msg 10"));
        assert_eq!(
            snap.last().unwrap().message,
            format!("msg {}", RING_CAPACITY + 9),
        );
    }

    #[test]
    fn rate_limiter_caps_duplicates_in_a_window() {
        let log = SystemLog::new();
        // RATE_LIMIT_BURST pushes succeed; the very next push records
        // one suppression note (Warn) and then further pushes return
        // None until the window rolls.
        for _ in 0..RATE_LIMIT_BURST {
            assert!(log.push("dbc", LogLevel::Error, "boom").is_some());
        }
        let note = log.push("dbc", LogLevel::Error, "boom").expect("note emitted");
        assert_eq!(note.level, LogLevel::Warn);
        assert!(note.message.contains("rate-limited"));
        // Further duplicates inside the window vanish.
        assert!(log.push("dbc", LogLevel::Error, "boom").is_none());
        // A *different* template is not rate-limited.
        assert!(log.push("dbc", LogLevel::Error, "different").is_some());
    }

    #[test]
    fn clear_drops_messages_but_not_seq() {
        let log = SystemLog::new();
        log.push("project", LogLevel::Info, "a").unwrap();
        log.push("project", LogLevel::Info, "b").unwrap();
        log.clear();
        assert_eq!(log.len(), 0);
        let c = log.push("project", LogLevel::Info, "c").unwrap();
        // seq does NOT reset.
        assert_eq!(c.seq, 2);
    }

    #[test]
    fn level_rank_orders_info_warn_error() {
        assert!(LogLevel::Info.rank() < LogLevel::Warn.rank());
        assert!(LogLevel::Warn.rank() < LogLevel::Error.rank());
    }

    #[test]
    fn template_separates_rate_limit_buckets() {
        let log = SystemLog::new();
        for i in 0..RATE_LIMIT_BURST {
            log.push_with_template(
                "project",
                LogLevel::Info,
                "tpl-A",
                format!("variant {i}"),
            );
        }
        // Same template, distinct message text — still rate-limited.
        assert_eq!(
            log.push_with_template("project", LogLevel::Info, "tpl-A", "another").map(|m| m.level),
            Some(LogLevel::Warn), // suppression note
        );
        // Different template — bucket is fresh.
        assert!(log
            .push_with_template("project", LogLevel::Info, "tpl-B", "fine")
            .is_some());
    }
}
