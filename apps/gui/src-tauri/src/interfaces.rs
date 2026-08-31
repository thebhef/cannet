//! Interface-discovery cache + subscription manager (ADR 0016).
//!
//! One shared cache, keyed by server address, holding the latest
//! `InterfaceList` snapshot the host has observed for that address.
//! The cache is fed by **two** mechanisms:
//!
//! 1. A long-lived `WatchInterfaces` subscription per address. Opened
//!    by [`watch`] (called by the sidecar lifecycle for the local
//!    address, and by the [`watch_interfaces`] / [`unwatch_interfaces`]
//!    Tauri commands for remote addresses the frontend cares about).
//!    Each pushed snapshot updates the cache and fires
//!    [`INTERFACES_CHANGED_EVENT`] iff the snapshot actually moves.
//! 2. An on-demand [`refresh_interfaces`] command that runs
//!    `ListInterfaces` once and folds the result through the same
//!    "update cache + emit-on-diff" path. Wired to the "Discover"
//!    buttons in the connection panel.
//!
//! The frontend never polls. It listens to the change event and
//! reads the cache through [`get_interfaces`] for its initial-state
//! snapshot.
//!
//! Reconnect: when a watch stream ends (server hung up, transport
//! error, sidecar restarted), the watcher sleeps briefly and tries
//! again. Cancellation is via the `AbortHandle` stored alongside the
//! cache entry; calling [`unwatch`] aborts the task before the next
//! `.await`, draining the address from the cache.
//!
//! **How a server is reached is not this module's decision.**
//! [`crate::connect_flow`] plans every attempt from what the host has
//! stored for the address (ADR 0041), and classifies every failure.
//! Two of them — a certificate that is not the pinned one, and a
//! refused credential — are terminal here: the loop stops and the
//! question reaches the user instead of being retried once a second
//! forever.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::connect_flow::{self, Attempt, Outcome};
use crate::ipc::InterfaceRecord;
use crate::{server_trust, sys_error, sys_info, sys_warn};

/// Tauri event emitted whenever the host's cached interface list for
/// some address changes. Payload is [`InterfacesChangedPayload`]; the
/// frontend listens once and dispatches by `address`.
pub const INTERFACES_CHANGED_EVENT: &str = "interfaces-changed";

/// Source tag used for any System Message emitted from this module.
const SOURCE: &str = "interfaces";

/// Cadence at which a failed watch task waits before retrying the
/// connect + subscribe path. Short enough that a sidecar restart
/// reconnects "instantly" from the user's perspective; long enough
/// that a permanently-down remote server doesn't hammer.
fn reconnect_backoff() -> Duration {
    Duration::from_millis(crate::settings::effective().reconnect_backoff_ms)
}

/// Wire shape of [`INTERFACES_CHANGED_EVENT`]. `address` is the same
/// `host:port` the cache is keyed by; `interfaces` is the new full
/// snapshot (there is no diff format).
#[derive(Clone, Serialize)]
pub struct InterfacesChangedPayload {
    pub address: String,
    pub interfaces: Vec<InterfaceRecord>,
}

/// Tauri-managed singleton. Read locks via `Mutex` because all hot
/// paths are short — emitting an event or comparing two `Vec`s.
#[derive(Default)]
pub struct InterfacesState {
    inner: Mutex<InterfacesInner>,
}

#[derive(Default)]
struct InterfacesInner {
    entries: HashMap<String, AddressEntry>,
}

impl InterfacesInner {
    /// One more subscriber for `address`. `true` when nothing watches
    /// it yet, in which case the caller must spawn a task and
    /// [`install`](Self::install) it.
    fn subscribe(&mut self, address: &str) -> bool {
        match self.entries.get_mut(address) {
            Some(entry) => {
                entry.refs += 1;
                false
            }
            None => true,
        }
    }

    /// Install the watch task a [`subscribe`](Self::subscribe) asked
    /// for, counting that subscriber.
    fn install(&mut self, address: String, task: JoinHandle<()>) {
        self.entries.insert(
            address,
            AddressEntry {
                snapshot: Vec::new(),
                task,
                refs: 1,
            },
        );
    }

    /// One subscriber gone. Returns the entry, for teardown, only when
    /// it was the last one — two panels can watch one address, and the
    /// first to leave must not kill the other's live feed.
    fn unsubscribe(&mut self, address: &str) -> Option<AddressEntry> {
        let entry = self.entries.get_mut(address)?;
        if entry.refs > 1 {
            entry.refs -= 1;
            return None;
        }
        self.entries.remove(address)
    }
}

struct AddressEntry {
    snapshot: Vec<InterfaceRecord>,
    /// Join handle for the long-lived watch task. Held so [`unwatch`]
    /// can `.abort()` the task at its next `.await` point; dropped
    /// along with the entry when the address is unwatched.
    task: JoinHandle<()>,
    /// How many [`watch`] calls this task is serving. [`unwatch`]
    /// decrements; the task and cache entry go when it reaches zero.
    refs: usize,
}

/// Begin (or join) a `WatchInterfaces` subscription against `address`.
/// Refcounted: a second `watch` shares the existing task, and the task
/// lives until every subscriber has called [`unwatch`] — or the app
/// shuts down. The sidecar lifecycle's own watch of the local address
/// never unwatches, so no panel teardown can take it down.
pub fn watch(app: &AppHandle, address: String) {
    let Some(state) = app.try_state::<InterfacesState>() else {
        return;
    };
    {
        let mut inner = state.inner.lock().expect("interfaces state poisoned");
        if !inner.subscribe(&address) {
            return;
        }
    }
    let app_for_task = app.clone();
    let address_for_task = address.clone();
    let handle = tauri::async_runtime::spawn(async move {
        run_watch(app_for_task, address_for_task).await;
    });
    let mut inner = state.inner.lock().expect("interfaces state poisoned");
    // Re-check under the lock: a concurrent `watch` could have raced
    // us and installed its own task. If so, count our subscriber on
    // theirs and abort ours.
    if let Some(entry) = inner.entries.get_mut(&address) {
        entry.refs += 1;
        handle.abort();
        return;
    }
    inner.install(address, handle);
}

/// Drop one subscription to `address`. Only the last subscriber's
/// `unwatch` stops the task and drops the cached snapshot — the task
/// is then aborted at its next `.await`, and any frontend subscriber
/// to [`INTERFACES_CHANGED_EVENT`] sees one final empty-snapshot event
/// so stale `(unassigned)` rows clear out of the UI.
pub fn unwatch(app: &AppHandle, address: &str) {
    let Some(state) = app.try_state::<InterfacesState>() else {
        return;
    };
    let removed = {
        let mut inner = state.inner.lock().expect("interfaces state poisoned");
        inner.unsubscribe(address)
    };
    if let Some(entry) = removed {
        entry.task.abort();
        let _ = app.emit(
            INTERFACES_CHANGED_EVENT,
            InterfacesChangedPayload {
                address: address.to_string(),
                interfaces: Vec::new(),
            },
        );
    }
}

/// Restart the watch task for `address`, if one is running, against a
/// freshly read trust decision. Called when the user answers a trust
/// question: the loop that stopped on it has to try again, and waiting
/// for a reconnect that will never come on its own is not an answer.
///
/// The cached snapshot is deliberately left in place — this is the same
/// server, so there is nothing to clear and nothing to flicker.
pub(crate) fn rewatch(app: &AppHandle, address: &str) {
    let Some(state) = app.try_state::<InterfacesState>() else {
        return;
    };
    let mut inner = state.inner.lock().expect("interfaces state poisoned");
    let Some(entry) = inner.entries.get_mut(address) else {
        return;
    };
    entry.task.abort();
    let app_for_task = app.clone();
    let address_for_task = address.to_string();
    entry.task = tauri::async_runtime::spawn(async move {
        run_watch(app_for_task, address_for_task).await;
    });
}

/// Like [`rewatch`], but for an address nothing is watching: dial it
/// once so the freshly stored decision is exercised at all. An answer
/// that goes unverified is how a mistyped token sits silent — the
/// accepted identity produced no attempt, no prompt, and no log line
/// until the server was next needed (found the hard way, 2026-08-30).
/// The one-shot goes through [`refresh_interfaces`], so a refusal is
/// reported exactly as loudly as any other failed attempt, and a
/// success lands in the cache and the system log.
pub(crate) fn rewatch_or_verify(app: &AppHandle, address: &str) {
    let watched = app.try_state::<InterfacesState>().is_some_and(|state| {
        let inner = state.inner.lock().expect("interfaces state poisoned");
        inner.entries.contains_key(address)
    });
    if watched {
        rewatch(app, address);
        return;
    }
    let app = app.clone();
    let address = address.to_string();
    tauri::async_runtime::spawn(async move {
        // On Err, refresh_interfaces already reported: system log plus
        // a raised prompt when it is a question for the user.
        if let Ok(records) = refresh_interfaces(app.clone(), address.clone()).await {
            let n = records.len();
            sys_info!(&app, SOURCE, "{address}: trust decision verified — {n} interface(s)");
        }
    });
}

/// Tauri command — snapshot the host's cached interface list for an
/// address. Returns an empty list when the address isn't being
/// watched (caller should not block on this; the watch task pushes
/// updates through [`INTERFACES_CHANGED_EVENT`]).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_interfaces(state: State<'_, InterfacesState>, address: String) -> Vec<InterfaceRecord> {
    let inner = state.inner.lock().expect("interfaces state poisoned");
    inner
        .entries
        .get(&address)
        .map(|e| e.snapshot.clone())
        .unwrap_or_default()
}

/// Tauri command — start watching `address` for interface changes.
/// Used by the frontend for remote server addresses; the sidecar's
/// own watch is started directly by the sidecar lifecycle.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn watch_interfaces(app: AppHandle, address: String) {
    watch(&app, address);
}

/// Tauri command — stop watching `address`. The cache entry is
/// dropped and a final empty-snapshot event is emitted.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn unwatch_interfaces(app: AppHandle, address: String) {
    unwatch(&app, &address);
}

/// Tauri command — run `ListInterfaces` once against `address` and
/// fold the result into the cache. Wired to the "Discover" buttons
/// in the connection panel so a user who can't wait for the next
/// watch push can force the freshest possible answer.
///
/// This is also where trust-on-first-use usually starts: discovering a
/// routable server the host knows nothing about probes its identity and
/// raises the accept dialog, so the fingerprint is compared before any
/// bus is bound to it.
#[tauri::command]
pub async fn refresh_interfaces(
    app: AppHandle,
    address: String,
) -> Result<Vec<InterfaceRecord>, String> {
    let attempt = connect_flow::plan(&address, &server_trust::trust_for(&app, &address));
    let config = attempt.config(&address)?;
    let interfaces = match cannet_client::list_interfaces(&config).await {
        Ok(interfaces) => interfaces,
        Err(e) => {
            report_failure(&app, &address, &attempt, &e, None);
            return Err(e.to_string());
        }
    };
    connect_flow::resolved(&app, &address);
    let records: Vec<InterfaceRecord> = interfaces.into_iter().map(InterfaceRecord::from).collect();
    update_cache_and_emit(&app, &address, &records);
    Ok(records)
}

/// Long-lived task body: connect, subscribe, stream snapshots, retry
/// on disconnect. Exits when the `AbortHandle` is fired — by
/// [`unwatch`], by [`rewatch`], or implicitly when the entry is removed
/// from the cache — and also when the failure is one retrying cannot
/// fix (S13: a changed certificate or a refused token stops the loop
/// and puts the question to the user).
async fn run_watch(app: AppHandle, address: String) {
    let mut gate = RetryWarnGate::new();
    loop {
        let attempt = connect_flow::plan(&address, &server_trust::trust_for(&app, &address));
        let config = match attempt.config(&address) {
            Ok(config) => config,
            Err(msg) => {
                sys_error!(&app, SOURCE, "WatchInterfaces({address}): {msg}");
                return;
            }
        };
        match cannet_client::watch_interfaces(&config).await {
            Ok(mut stream) => {
                // The connection stands, so whatever was being asked
                // about this server has been answered.
                connect_flow::resolved(&app, &address);
                gate.reset();
                loop {
                    match stream.next().await {
                        Ok(Some(interfaces)) => {
                            let records: Vec<InterfaceRecord> =
                                interfaces.into_iter().map(InterfaceRecord::from).collect();
                            update_cache_and_emit(&app, &address, &records);
                        }
                        Ok(None) => break,
                        // A credential the server stops accepting
                        // mid-stream is as terminal as one refused at
                        // connect time.
                        Err(e) => {
                            if report_failure(&app, &address, &attempt, &e, Some(&mut gate)) {
                                return;
                            }
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                if report_failure(&app, &address, &attempt, &e, Some(&mut gate)) {
                    return;
                }
            }
        }
        tokio::time::sleep(reconnect_backoff()).await;
    }
}

/// Suppresses repeats of the same retry warning between successes, so
/// a permanently-down server costs one log line, not one per backoff
/// tick. One gate per watch task: a rewatch starts fresh, so the first
/// failure under a new trust decision always logs.
struct RetryWarnGate(Option<String>);

impl RetryWarnGate {
    fn new() -> Self {
        Self(None)
    }

    /// Whether `msg` should be logged now. A message different from
    /// the last admitted one always logs — the failure changed, and a
    /// change is information.
    fn admit(&mut self, msg: &str) -> bool {
        if self.0.as_deref() == Some(msg) {
            return false;
        }
        self.0 = Some(msg.to_string());
        true
    }

    /// A successful connection: whatever failure comes next is news.
    fn reset(&mut self) {
        self.0 = None;
    }
}

/// Put a failed attempt on the system log and, when it is a question
/// only the user can answer, in front of them. Returns whether the
/// caller must stop trying. `gate` (for the retrying watch loop)
/// quiets repeats of one unchanged retry warning; a one-shot caller
/// passes `None` and always logs.
fn report_failure(
    app: &AppHandle,
    address: &str,
    attempt: &Attempt,
    error: &cannet_client::ConnectionError,
    gate: Option<&mut RetryWarnGate>,
) -> bool {
    match connect_flow::classify(attempt, error) {
        Outcome::Ask(prompt) => {
            sys_warn!(
                app,
                SOURCE,
                "{address}: {error}; waiting for an answer before trying again"
            );
            connect_flow::ask(app, address, prompt);
            true
        }
        Outcome::Fatal(msg) => {
            sys_error!(app, SOURCE, "{address}: {msg}");
            true
        }
        Outcome::Retry(msg) => {
            let line = format!("{address}: {msg}; retrying");
            if gate.is_none_or(|gate| gate.admit(&line)) {
                sys_warn!(app, SOURCE, "{line}");
            }
            false
        }
    }
}

/// Compare `records` against the cached snapshot for `address`. If
/// different (or no entry exists), update the cache and fire
/// [`INTERFACES_CHANGED_EVENT`]. A stable system pushes nothing
/// through this function past the first call.
fn update_cache_and_emit(app: &AppHandle, address: &str, records: &[InterfaceRecord]) {
    let changed = {
        let Some(state) = app.try_state::<InterfacesState>() else {
            return;
        };
        let mut inner = state.inner.lock().expect("interfaces state poisoned");
        if let Some(entry) = inner.entries.get_mut(address) {
            if interfaces_equal(&entry.snapshot, records) {
                false
            } else {
                entry.snapshot = records.to_vec();
                true
            }
        } else {
            // No watcher entry — `refresh_interfaces` may have been
            // called against an address we don't manage. Don't create
            // an entry (no task to own it); just emit, so the
            // frontend at least sees the one-shot answer.
            true
        }
    };
    if changed {
        let _ = app.emit(
            INTERFACES_CHANGED_EVENT,
            InterfacesChangedPayload {
                address: address.to_string(),
                interfaces: records.to_vec(),
            },
        );
    }
}

fn interfaces_equal(a: &[InterfaceRecord], b: &[InterfaceRecord]) -> bool {
    // Whole-record equality, so a re-enumeration that picks up an
    // identity field the first one could not read counts as a change
    // and reaches the panel. `InterfaceRecord` derives `Eq`, which
    // keeps this from silently going stale the next time a field is
    // added.
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str) -> InterfaceRecord {
        InterfaceRecord {
            id: id.to_string(),
            display_name: format!("Adapter {id}"),
            fd_capable: true,
            driver_name: None,
            driver_version: None,
            firmware_version: None,
            serial_number: None,
        }
    }

    #[test]
    fn a_re_enumeration_that_learns_an_identity_field_counts_as_a_change() {
        // The identity reads can fail on one enumeration and succeed on
        // the next — a PCAN handle the driver would not answer for, an
        // XL library that was not loaded yet. A comparison that only
        // looked at id / name / FD would swallow that, and the adapter
        // cell would keep showing an em dash until something else about
        // the interface moved.
        let before = [record("pcan:1")];
        let mut after = before.clone();
        after[0].firmware_version = Some("3.3.0".to_string());
        assert!(interfaces_equal(&before, &before));
        assert!(!interfaces_equal(&before, &after));
    }

    #[test]
    fn a_watch_survives_until_its_last_subscriber_unsubscribes() {
        // Two panels can watch one address — Connection Management for
        // a bus bound to it, the Servers panel for its row. Without
        // the refcount, whichever unmounts first silently kills the
        // other's live feed.
        let mut inner = InterfacesInner::default();
        assert!(inner.subscribe("a:1"), "first subscriber spawns a task");
        inner.install("a:1".into(), tauri::async_runtime::spawn(async {}));
        assert!(!inner.subscribe("a:1"), "second subscriber shares it");
        assert!(
            inner.unsubscribe("a:1").is_none(),
            "one subscriber remains; nothing to tear down"
        );
        let last = inner.unsubscribe("a:1").expect("last unsubscribe tears down");
        last.task.abort();
        assert!(inner.unsubscribe("a:1").is_none(), "already gone");
    }

    #[test]
    fn a_repeated_retry_warning_logs_once_until_something_changes() {
        // The gate exists so a permanently-down server costs one log
        // line per distinct failure, not one every backoff tick.
        let mut gate = RetryWarnGate::new();
        assert!(gate.admit("addr: connect refused; retrying"));
        assert!(!gate.admit("addr: connect refused; retrying"));
        assert!(!gate.admit("addr: connect refused; retrying"));
        // A different failure is information and logs immediately.
        assert!(gate.admit("addr: dns error; retrying"));
        assert!(!gate.admit("addr: dns error; retrying"));
        // A success in between resets: the next failure is news again,
        // even when it reads the same as the last one.
        gate.reset();
        assert!(gate.admit("addr: dns error; retrying"));
    }

    #[test]
    fn an_unchanged_interface_set_stays_unchanged() {
        // The control: the comparison exists to keep an unchanged
        // enumeration from firing a change event at every poll.
        let a = [record("pcan:1"), record("pcan:2")];
        let b = a.clone();
        assert!(interfaces_equal(&a, &b));
        assert!(!interfaces_equal(&a, &a[..1]));
    }
}
