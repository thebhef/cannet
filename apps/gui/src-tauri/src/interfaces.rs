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

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ipc::InterfaceRecord;
use crate::sys_warn;

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
const RECONNECT_BACKOFF: Duration = Duration::from_secs(2);

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

struct AddressEntry {
    snapshot: Vec<InterfaceRecord>,
    /// Join handle for the long-lived watch task. Held so [`unwatch`]
    /// can `.abort()` the task at its next `.await` point; dropped
    /// along with the entry when the address is unwatched.
    task: JoinHandle<()>,
}

/// Begin (or no-op on) a `WatchInterfaces` subscription against
/// `address`. Idempotent: calling it twice for the same address keeps
/// the existing subscription. The watch task lives until either
/// [`unwatch`] is called for this address, or the app shuts down.
pub fn watch(app: &AppHandle, address: String) {
    let Some(state) = app.try_state::<InterfacesState>() else {
        return;
    };
    {
        let inner = state.inner.lock().expect("interfaces state poisoned");
        if inner.entries.contains_key(&address) {
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
    // us and installed its own task. If so, abort ours and keep
    // theirs.
    if inner.entries.contains_key(&address) {
        handle.abort();
        return;
    }
    inner.entries.insert(
        address,
        AddressEntry {
            snapshot: Vec::new(),
            task: handle,
        },
    );
}

/// Stop watching `address` and drop its cached snapshot. The watch
/// task is aborted at its next `.await`; any frontend subscriber to
/// [`INTERFACES_CHANGED_EVENT`] sees one final empty-snapshot event so
/// stale `(unassigned)` rows clear out of the UI.
pub fn unwatch(app: &AppHandle, address: &str) {
    let Some(state) = app.try_state::<InterfacesState>() else {
        return;
    };
    let removed = {
        let mut inner = state.inner.lock().expect("interfaces state poisoned");
        inner.entries.remove(address)
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

/// Tauri command — snapshot the host's cached interface list for an
/// address. Returns an empty list when the address isn't being
/// watched (caller should not block on this; the watch task pushes
/// updates through [`INTERFACES_CHANGED_EVENT`]).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_interfaces(
    state: State<'_, InterfacesState>,
    address: String,
) -> Vec<InterfaceRecord> {
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
#[tauri::command]
pub async fn refresh_interfaces(
    app: AppHandle,
    address: String,
) -> Result<Vec<InterfaceRecord>, String> {
    let interfaces = cannet_client::list_interfaces(&address)
        .await
        .map_err(|e| e.to_string())?;
    let records: Vec<InterfaceRecord> =
        interfaces.into_iter().map(InterfaceRecord::from).collect();
    update_cache_and_emit(&app, &address, &records);
    Ok(records)
}

/// Long-lived task body: connect, subscribe, stream snapshots, retry
/// on disconnect. Exits only when the `AbortHandle` is fired — by
/// [`unwatch`] or implicitly when the entry is removed from the
/// cache.
async fn run_watch(app: AppHandle, address: String) {
    loop {
        match cannet_client::watch_interfaces(&address).await {
            Ok(mut stream) => {
                while let Ok(Some(interfaces)) = stream.next().await {
                    let records: Vec<InterfaceRecord> =
                        interfaces.into_iter().map(InterfaceRecord::from).collect();
                    update_cache_and_emit(&app, &address, &records);
                }
            }
            Err(e) => {
                // First connect (or reconnect) failed. Log once at
                // warn so the user sees something on a misconfigured
                // remote; subsequent retries stay quiet to avoid log
                // spam on a permanently-down server.
                sys_warn!(
                    &app,
                    SOURCE,
                    "WatchInterfaces({address}) connect failed: {e}; retrying"
                );
            }
        }
        tokio::time::sleep(RECONNECT_BACKOFF).await;
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
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).all(|(x, y)| {
        x.id == y.id && x.display_name == y.display_name && x.fd_capable == y.fd_capable
    })
}
