//! Host-side structured log bus.
//!
//! A single in-process [`SystemLog`] holds a bounded ring of
//! [`SystemMessage`]s — `{ ts_ms, source, level, message }` — that the
//! System Messages panel renders. Call sites push through the [`debug!`],
//! [`info!`], [`warn!`], and [`error!`] macros in this module, which:
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
//! `"sidecar:<vendor>"`). Levels are
//! [`LogLevel::Debug`] / `Info` / `Warn` / `Error`.
//!
//! The split between the bottom two is by *cause*, not by importance:
//! `Info` is for what the user asked for (a file opened or saved, a
//! connection made or dropped, a view created), so an untouched app
//! produces none. Everything the app does on its own — health samples,
//! internal lifecycle breadcrumbs, sidecar chatter — is `Debug`. Debug
//! entries still reach the ring, the panel (which filters them out by
//! default), and the rolling log file (whose own minimum level defaults
//! to keeping them), so a diagnosis never needs a rebuild.
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

/// Rate-limiter window. A `(source, template)` pair contributes at
/// most [`burst_budget`] messages inside one window.
///
/// The window stays a constant while the *budget* is a setting: the
/// budget is the number a user reasons about ("how many identical
/// messages per second"), and making both adjustable would express one
/// rate two ways.
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(1);

/// Capacity of the in-process ring, from `settings.json`
/// (`system_log_ring_capacity`). The oldest entry is evicted past this;
/// the frontend mirror reads the same setting, so the two agree without
/// a hand-kept copy of the number on either side.
fn ring_capacity() -> usize {
    usize::try_from(crate::settings::effective().system_log_ring_capacity).unwrap_or(usize::MAX)
}

/// Burst budget per `(source, template)` per [`RATE_LIMIT_WINDOW`], from
/// `settings.json` (`system_log_rate_limit`). Past it, a short
/// suppression note is recorded once and further duplicates are silently
/// dropped until the window rolls over. **`0` means no limit** —
/// diagnosing a message flood is exactly when you want all of it.
fn burst_budget() -> Option<usize> {
    budget_from(crate::settings::effective().system_log_rate_limit)
}

/// The settings value read as a budget, split out from the read so the
/// "`0` is no limit" rule is testable without touching global state.
fn budget_from(raw: u64) -> Option<usize> {
    match raw {
        0 => None,
        n => Some(usize::try_from(n).unwrap_or(usize::MAX)),
    }
}

/// Severity of a system message. Maps onto the panel's level-filter
/// dropdown, which defaults to `Info` — a session's worth of user
/// actions, without the app's own chatter underneath it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    /// The app talking to itself: health samples, lifecycle
    /// breadcrumbs, sidecar chatter. Reaches the ring and, at the log
    /// file's default minimum, the rolling log file; below the panel's
    /// default filter.
    Debug,
    /// The consequence of something the user did. Nothing here should
    /// appear in an app nobody is touching.
    Info,
    Warn,
    Error,
}

impl LogLevel {
    /// Ordering for the panel's "minimum level" filter, and for the
    /// rolling log file's own minimum ([`crate::crash`]). The frontend
    /// has its own copy of this ordering (in `types.ts`); both must
    /// agree for the panel's level filter to behave consistently.
    #[must_use]
    pub fn rank(self) -> u8 {
        match self {
            Self::Debug => 0,
            Self::Info => 1,
            Self::Warn => 2,
            Self::Error => 3,
        }
    }

    /// The level a settings value names — one of
    /// [`crate::settings::SYSTEM_LOG_LEVELS`], which is the same ladder
    /// in the same order.
    ///
    /// `None` for anything else. `validate` refuses an unknown name at
    /// ingress, so the only way to get here is a caller that hasn't
    /// gone through it; the callers treat that as "no minimum" rather
    /// than as "log nothing", because a filter nobody chose must not
    /// silence a log.
    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "debug" => Some(Self::Debug),
            "info" => Some(Self::Info),
            "warn" => Some(Self::Warn),
            "error" => Some(Self::Error),
            _ => None,
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
    /// [`burst_budget`] push times within the current
    /// [`RATE_LIMIT_WINDOW`]; older entries are pruned on each push.
    recent: std::collections::HashMap<(String, String), VecDeque<Instant>>,
}

impl SystemLog {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                ring: VecDeque::with_capacity(ring_capacity()),
                next_seq: 0,
                recent: std::collections::HashMap::new(),
            }),
        }
    }

    /// Push a message, with the rate-limit template defaulting to the
    /// message text itself. Returns the appended [`SystemMessage`] —
    /// or `None` if the rate limiter dropped this one.
    pub fn push(
        &self,
        source: &str,
        level: LogLevel,
        message: impl Into<String>,
    ) -> Option<SystemMessage> {
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
        while times
            .front()
            .is_some_and(|t| now.duration_since(*t) > RATE_LIMIT_WINDOW)
        {
            times.pop_front();
        }
        let capacity = ring_capacity();
        let budget = burst_budget();
        let suppressed = budget.is_some_and(|b| times.len() >= b);
        times.push_back(now);
        let ts_ms = current_unix_ms();
        if suppressed {
            // First suppression in this window emits a single note so
            // the panel doesn't go silent under a flood; further drops
            // are invisible until the window rolls.
            if budget.is_some_and(|b| times.len() == b + 1) {
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
                push_ring(&mut inner.ring, capacity, note.clone());
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
        push_ring(&mut inner.ring, capacity, entry.clone());
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

/// Append `msg`, evicting from the front until the ring is within
/// `capacity`. `capacity` is a parameter rather than a read of the
/// setting so the eviction rule is testable on its own.
///
/// A loop against `>=`, not a single `==` check: lowering the capacity
/// setting mid-session leaves an over-long ring that has to shrink back
/// rather than stay stuck at its old size.
fn push_ring(ring: &mut VecDeque<SystemMessage>, capacity: usize, msg: SystemMessage) {
    while ring.len() >= capacity.max(1) {
        ring.pop_front();
    }
    ring.push_back(msg);
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Bridge a wire-level [`cannet_wire::proto::LogMessage`] into the
/// local host log bus. `Unspecified` levels default to
/// `Info`. The wire timestamp is recorded by `push`'s own wall-clock
/// stamping — the wire `timestamp_ns` is intentionally **not** trusted
/// as a host clock value; if a future revision wants to preserve the
/// remote clock, extend [`SystemMessage`] with a `remote_ts_ns` field
/// rather than overloading `ts_ms`.
///
/// Returns the pushed entry — or `None` if the rate-limiter dropped
/// it. The bridge does not emit a Tauri event by itself; the call site
/// (a future wire-receive loop) is the right place for
/// that, where the `AppHandle` is in hand.
//
// The bridge is exercised by unit tests in this module but not yet
// called from the binary — a future session-receive loop will wire it
// in. Until then, allow the dead-code lint rather than removing the
// definition.
#[allow(dead_code)]
pub fn bridge_wire_log(
    bus: &SystemLog,
    msg: &cannet_wire::proto::LogMessage,
) -> Option<SystemMessage> {
    let level = match cannet_wire::proto::LogLevel::try_from(msg.level) {
        Ok(cannet_wire::proto::LogLevel::Warn) => LogLevel::Warn,
        Ok(cannet_wire::proto::LogLevel::Error) => LogLevel::Error,
        // Unspecified / Info / unknown all degrade to Info — the wire
        // protocol's enum-evolution rule is that receivers tolerate
        // variants they don't know.
        _ => LogLevel::Info,
    };
    bus.push(&msg.source, level, msg.message.clone())
}

/// The dev-stderr filter used when `RUST_LOG` is unset.
///
/// `info` overall, with the chatty transport crates dropped to `warn`
/// (see [`init_tracing_subscriber`]) — and the two transmit dev-log
/// targets off. `tx-flush` and `tx-sched` go to stderr alone: unlike the
/// app's own messages they are not fanned out to the System Messages
/// panel or the rolling log, so on a normal launch — a windowed process
/// with nothing attached to stderr — the line a second they format
/// reaches no reader. They are a diagnostic pair for a stall hunt, so
/// they are opt-in: any `RUST_LOG` value that enables them (`info`, or
/// `tx-flush=info,tx-sched=info` for just these) brings them back, since
/// `RUST_LOG` replaces this filter wholesale.
const DEFAULT_LOG_FILTER: &str = "info,tonic=warn,h2=warn,hyper=warn,hyper_util=warn,\
     tower=warn,tx-flush=off,tx-sched=off";

/// Initialise the global `tracing` subscriber once at process start.
/// The fan-out from the [`info!`] / [`warn!`] / [`error!`] macros emits
/// a `tracing::event!` *and* pushes into the ring; this subscriber is
/// what makes the `event!` half visible on stderr during development.
/// Safe to call multiple times — the underlying registry is idempotent.
/// Install the dev-stderr `tracing` subscriber.
///
/// Without a filter, a bare `fmt` layer enables every event from every
/// crate at TRACE — which floods stderr with `tonic` / `h2` / `hyper`
/// transport spam under a live gRPC session. That volume isn't free: when
/// stderr is a live terminal (e.g. `tauri dev` in an editor), rendering it
/// steals CPU from timing-sensitive work like the transmit scheduler.
///
/// So we cap the default at `info`, drop the chatty transport crates to
/// `warn`, and honour `RUST_LOG` when set (so a debugging session can dial
/// any target back up). This only governs the dev-stderr layer; the System
/// Messages panel is fed separately by `emit_system_log`, so quieting
/// stderr never hides an in-app message.
pub fn init_tracing_subscriber() {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_LOG_FILTER));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .try_init();
}

/// Emit at debug level — the app's own chatter, not something the user
/// asked for. Same plumbing as [`crate::sys_info!`]; the panel filters it out
/// by default, but it still lands in the rolling log file.
#[macro_export]
macro_rules! sys_debug {
    ($app:expr, $source:expr, $($arg:tt)*) => {{
        let __msg = format!($($arg)*);
        ::tracing::debug!(target: "cannet", source = $source, "{}", __msg);
        $crate::emit_system_log($app, $source, $crate::system_log::LogLevel::Debug, __msg);
    }};
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

/// Emit at warn level. See [`crate::sys_info!`].
#[macro_export]
macro_rules! sys_warn {
    ($app:expr, $source:expr, $($arg:tt)*) => {{
        let __msg = format!($($arg)*);
        ::tracing::warn!(target: "cannet", source = $source, "{}", __msg);
        $crate::emit_system_log($app, $source, $crate::system_log::LogLevel::Warn, __msg);
    }};
}

/// Emit at error level. See [`crate::sys_info!`].
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

    /// Record the target of every event a filter lets through.
    struct TargetSpy(std::sync::Arc<Mutex<Vec<String>>>);

    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for TargetSpy {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            self.0
                .lock()
                .unwrap()
                .push(event.metadata().target().to_string());
        }
    }

    #[test]
    fn the_default_filter_drops_the_transmit_dev_lines_but_keeps_the_apps_own() {
        // `tx-flush` / `tx-sched` are a diagnostic pair for reading a
        // stall off one stderr capture. They are routed to stderr alone —
        // no `emit_system_log` fan-out — so on a normal launch they reach
        // no reader at all, and the default filter excludes their targets
        // rather than formatting a line a second into a handle nobody is
        // holding. `RUST_LOG` replaces the whole filter, so any value that
        // enables them brings them back.
        use tracing_subscriber::{layer::SubscriberExt, EnvFilter};
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry()
            .with(EnvFilter::new(DEFAULT_LOG_FILTER))
            .with(TargetSpy(std::sync::Arc::clone(&seen)));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "tx-flush", "flush_ms=1.0");
            tracing::info!(target: "tx-sched", "wakes=1");
            tracing::info!(target: "cannet", "something the app said");
        });
        assert_eq!(*seen.lock().unwrap(), vec!["cannet".to_string()]);
    }

    #[test]
    fn every_declared_level_name_maps_to_a_level_in_ladder_order() {
        // `from_name` is a second statement of `SYSTEM_LOG_LEVELS`, so
        // it is pinned to it: every declared name resolves, and the
        // ranks rise in the order the list declares them. A name added
        // to the settings list with no variant here fails.
        let levels = crate::settings::SYSTEM_LOG_LEVELS;
        let ranks: Vec<u8> = levels
            .iter()
            .map(|name| {
                LogLevel::from_name(name)
                    .unwrap_or_else(|| panic!("`{name}` names no level"))
                    .rank()
            })
            .collect();
        assert!(ranks.windows(2).all(|w| w[0] < w[1]), "{ranks:?}");
        assert_eq!(ranks.len(), 4, "the ladder has four rungs");
        assert_eq!(LogLevel::from_name("verbose"), None);
    }

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
        assert_eq!(
            snap.iter().map(|m| m.message.as_str()).collect::<Vec<_>>(),
            vec!["first", "second"]
        );
    }

    /// The values the tests below run at — the defaults, since a test
    /// never hydrates the settings cache and `effective()` answers
    /// `Settings::default()` until something does.
    fn default_ring_capacity() -> usize {
        usize::try_from(crate::settings::Settings::default().system_log_ring_capacity).unwrap()
    }
    fn default_rate_limit() -> usize {
        usize::try_from(crate::settings::Settings::default().system_log_rate_limit).unwrap()
    }

    #[test]
    fn ring_evicts_oldest_at_capacity() {
        let ring_capacity = default_ring_capacity();
        let log = SystemLog::new();
        for i in 0..(ring_capacity + 10) {
            log.push_with_template(
                "test",
                LogLevel::Info,
                &format!("tpl-{i}"), // unique template, bypass rate limiter
                format!("msg {i}"),
            );
        }
        assert_eq!(log.len(), ring_capacity);
        let snap = log.snapshot();
        // Oldest 10 entries were evicted.
        assert_eq!(snap.first().unwrap().message, format!("msg 10"));
        assert_eq!(
            snap.last().unwrap().message,
            format!("msg {}", ring_capacity + 9),
        );
    }

    #[test]
    fn a_rate_limit_of_zero_means_no_limit() {
        // The setting's stated purpose: "debugging a message flood is
        // exactly when you want the limiter off". Zero is that switch,
        // and it must not read as "suppress everything".
        assert_eq!(budget_from(0), None);
        assert_eq!(budget_from(1), Some(1));
        assert_eq!(budget_from(5), Some(5));
    }

    #[test]
    fn the_ring_shrinks_to_a_lowered_capacity() {
        // Capacity is a setting now, so it can drop under a ring that
        // is already longer. Evicting only one entry per push would
        // leave it stuck above the new limit for as long as it took to
        // push that many more messages.
        let mut ring = VecDeque::new();
        for i in 0..6u64 {
            push_ring(&mut ring, 6, msg(i));
        }
        assert_eq!(ring.len(), 6, "a capacity of six holds six");
        push_ring(&mut ring, 2, msg(99));
        assert_eq!(ring.len(), 2);
        assert_eq!(ring.back().unwrap().message, "msg 99");
        // A capacity of zero cannot mean "drop the message being
        // pushed" — the floor is one entry.
        push_ring(&mut ring, 0, msg(100));
        assert_eq!(ring.len(), 1);
        assert_eq!(ring.back().unwrap().message, "msg 100");
    }

    fn msg(i: u64) -> SystemMessage {
        SystemMessage {
            seq: i,
            ts_ms: 0,
            source: "test".into(),
            level: LogLevel::Info,
            message: format!("msg {i}"),
        }
    }

    #[test]
    fn rate_limiter_caps_duplicates_in_a_window() {
        let log = SystemLog::new();
        // The budget's worth of pushes succeed; the very next push
        // records one suppression note (Warn) and then further pushes
        // return None until the window rolls.
        for _ in 0..default_rate_limit() {
            assert!(log.push("dbc", LogLevel::Error, "boom").is_some());
        }
        let note = log
            .push("dbc", LogLevel::Error, "boom")
            .expect("note emitted");
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
    fn level_rank_orders_debug_info_warn_error() {
        assert!(LogLevel::Debug.rank() < LogLevel::Info.rank());
        assert!(LogLevel::Info.rank() < LogLevel::Warn.rank());
        assert!(LogLevel::Warn.rank() < LogLevel::Error.rank());
    }

    #[test]
    fn debug_serialises_as_its_lowercase_wire_name() {
        // The frontend's `SystemLogLevel` union matches on these strings.
        let msg = SystemMessage {
            seq: 0,
            ts_ms: 0,
            source: "health".into(),
            level: LogLevel::Debug,
            message: "sample".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""level":"debug""#), "{json}");
    }

    #[test]
    fn bridge_wire_log_pushes_with_mapped_level() {
        use cannet_wire::proto;
        let bus = SystemLog::new();
        let pushed = bridge_wire_log(
            &bus,
            &proto::LogMessage {
                timestamp_ns: 1_234,
                level: proto::LogLevel::Warn as i32,
                source: "sidecar:peak".into(),
                message: "USB device unplugged".into(),
            },
        )
        .expect("bridge pushed an entry");
        assert_eq!(pushed.level, LogLevel::Warn);
        assert_eq!(pushed.source, "sidecar:peak");
        assert_eq!(pushed.message, "USB device unplugged");
        assert_eq!(bus.len(), 1);
    }

    #[test]
    fn bridge_wire_log_unspecified_degrades_to_info() {
        use cannet_wire::proto;
        let bus = SystemLog::new();
        let pushed = bridge_wire_log(
            &bus,
            &proto::LogMessage {
                timestamp_ns: 0,
                // LOG_LEVEL_UNSPECIFIED = 0, and any future-unknown
                // variant arriving from a newer peer also lands here.
                level: 0,
                source: "server".into(),
                message: "starting".into(),
            },
        )
        .expect("bridge pushed an entry");
        assert_eq!(pushed.level, LogLevel::Info);
    }

    #[test]
    fn template_separates_rate_limit_buckets() {
        let log = SystemLog::new();
        for i in 0..default_rate_limit() {
            log.push_with_template("project", LogLevel::Info, "tpl-A", format!("variant {i}"));
        }
        // Same template, distinct message text — still rate-limited.
        assert_eq!(
            log.push_with_template("project", LogLevel::Info, "tpl-A", "another")
                .map(|m| m.level),
            Some(LogLevel::Warn), // suppression note
        );
        // Different template — bucket is fresh.
        assert!(log
            .push_with_template("project", LogLevel::Info, "tpl-B", "fine")
            .is_some());
    }
}
