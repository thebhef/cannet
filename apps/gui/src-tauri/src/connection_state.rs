//! Per-logical-bus connection state — the host-side model the project
//! panel's bus rows and binding rows render.
//!
//! A project bus has **at most one** interface binding
//! ([ADR 0023](../../../../docs/adr/0023-logical-bus-vs-interface.md)),
//! so the bus id is the natural key: one binding, one state, no
//! aggregation. The map holds only buses the host has an opinion
//! about; a bus with no entry is "not connected" (and, if it has no
//! binding at all, "unbound" — that the frontend knows from the
//! project, not from here).
//!
//! The frontend never derives these. It hydrates once via
//! [`get_connection_states`] and then follows
//! [`CONNECTION_STATES_CHANGED_EVENT`], exactly as the interface cache
//! works (ADR 0016).
//!
//! ## Why `applied` is what the host *sent*, not what the driver *did*
//!
//! `ConfigureBus` is fire-and-forget by design (ADR 0022: "conflict
//! semantics deliberately open"; the envelope has no response). Below
//! it, the driver adapter's `OpenConfig` is an input — no layer in the
//! stack reports back the timing registers a controller actually
//! landed on. So the deepest truth available to the host is *the
//! configuration it put on the wire for this bus*, including the two
//! normalisations that make it differ from what the user typed:
//! `speed_bps` unset **and** `fd` unset means no `ConfigureBus` was
//! sent at all (the driver's own default stands), and an FD bus with
//! no data rate takes the nominal rate. [`AppliedBusConfig`] carries
//! exactly that, and the UI labels it as such.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Tauri event emitted whenever any bus's connection state changes.
/// Payload is the whole map (bounded by the project's bus count, so
/// there is no diff format).
pub const CONNECTION_STATES_CHANGED_EVENT: &str = "connection-states-changed";

/// The configuration the host actually put on the wire for a bus.
///
/// See the module docs for why this is "what was sent", not "what the
/// controller achieved".
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedBusConfig {
    /// Nominal (arbitration) bitrate as sent, or `None` when no
    /// `ConfigureBus` was sent for this bus — the driver default
    /// stands and the host does not know what it is.
    pub speed_bps: Option<u64>,
    /// Whether the interface was asked to open in CAN-FD mode.
    pub fd_enabled: bool,
    /// Data-phase bitrate as sent, after the "0 means same as
    /// nominal" normalisation. `None` when FD is off or nothing was
    /// sent.
    pub fd_data_speed_bps: Option<u64>,
}

/// One logical bus's connection state.
///
/// `Connecting` is entered before the subscribe is attempted and only
/// leaves on the attempt's actual outcome — it is never a synonym for
/// "the request was dispatched".
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BusConnState {
    /// The subscribe/claim for this bus's binding is in flight.
    Connecting,
    /// The binding is subscribed and frames can flow. `applied` is
    /// `None` for an in-process virtual bus, which has no controller
    /// to configure.
    Connected { applied: Option<AppliedBusConfig> },
    /// The attempt failed. `reason` is short enough to sit inline on a
    /// dense row; the full detail is in System Messages.
    Error { reason: String },
}

impl BusConnState {
    /// Short error constructor — every call site formats a reason.
    pub fn error(reason: impl Into<String>) -> Self {
        BusConnState::Error {
            reason: reason.into(),
        }
    }
}

/// Tauri-managed singleton holding the per-bus map.
#[derive(Default)]
pub struct ConnectionStates {
    inner: Mutex<BTreeMap<String, BusConnState>>,
}

impl ConnectionStates {
    /// Current snapshot.
    pub fn snapshot(&self) -> BTreeMap<String, BusConnState> {
        self.lock().clone()
    }

    /// Set several buses at once. Returns whether anything moved, so
    /// the caller can skip a no-op event.
    pub fn set_many(&self, entries: impl IntoIterator<Item = (String, BusConnState)>) -> bool {
        let mut guard = self.lock();
        let mut changed = false;
        for (bus_id, state) in entries {
            if guard.get(&bus_id) != Some(&state) {
                guard.insert(bus_id, state);
                changed = true;
            }
        }
        changed
    }

    /// Drop the named buses. Returns whether anything was removed.
    pub fn remove_many(&self, bus_ids: impl IntoIterator<Item = String>) -> bool {
        let mut guard = self.lock();
        let mut changed = false;
        for bus_id in bus_ids {
            changed |= guard.remove(&bus_id).is_some();
        }
        changed
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, BusConnState>> {
        self.inner.lock().expect("connection states mutex poisoned")
    }
}

/// Apply `entries` and push the new snapshot at the frontend if
/// anything moved. The one write path — so "state changed" and "the
/// UI was told" can't drift apart.
pub(crate) fn set_and_emit(
    app: &AppHandle,
    entries: impl IntoIterator<Item = (String, BusConnState)>,
) {
    let Some(states) = app.try_state::<ConnectionStates>() else {
        return;
    };
    if states.set_many(entries) {
        emit(app, &states);
    }
}

/// Drop `bus_ids` and push the new snapshot if anything was removed.
pub(crate) fn remove_and_emit(app: &AppHandle, bus_ids: impl IntoIterator<Item = String>) {
    let Some(states) = app.try_state::<ConnectionStates>() else {
        return;
    };
    if states.remove_many(bus_ids) {
        emit(app, &states);
    }
}

fn emit(app: &AppHandle, states: &ConnectionStates) {
    let _ = app.emit(CONNECTION_STATES_CHANGED_EVENT, states.snapshot());
}

/// Initial-state read for a frontend that just mounted. The event
/// carries every subsequent change.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn get_connection_states(
    states: tauri::State<'_, ConnectionStates>,
) -> BTreeMap<String, BusConnState> {
    states.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connected(speed: Option<u64>) -> BusConnState {
        BusConnState::Connected {
            applied: Some(AppliedBusConfig {
                speed_bps: speed,
                fd_enabled: false,
                fd_data_speed_bps: None,
            }),
        }
    }

    #[test]
    fn a_bus_walks_connecting_then_connected() {
        let states = ConnectionStates::default();
        assert!(states.set_many([("b1".into(), BusConnState::Connecting)]));
        assert_eq!(
            states.snapshot().get("b1"),
            Some(&BusConnState::Connecting),
            "the in-flight state is visible before the outcome lands",
        );
        assert!(states.set_many([("b1".into(), connected(Some(500_000)))]));
        assert_eq!(states.snapshot().get("b1"), Some(&connected(Some(500_000))));
    }

    #[test]
    fn a_failed_bus_keeps_its_reason() {
        let states = ConnectionStates::default();
        states.set_many([(
            "b2".into(),
            BusConnState::error("not exposed by 127.0.0.1:1"),
        )]);
        assert_eq!(
            states.snapshot().get("b2"),
            Some(&BusConnState::Error {
                reason: "not exposed by 127.0.0.1:1".into(),
            }),
        );
    }

    #[test]
    fn buses_on_one_device_hold_independent_states() {
        // The VN17xx case: three channels up, one refused. Each bus is
        // keyed on its own, so one failure never masks its siblings.
        let states = ConnectionStates::default();
        states.set_many([
            ("b1".into(), connected(Some(500_000))),
            ("b2".into(), BusConnState::error("open failed")),
            ("b3".into(), connected(Some(500_000))),
            ("b4".into(), connected(Some(500_000))),
        ]);
        let snap = states.snapshot();
        assert_eq!(snap.get("b1"), Some(&connected(Some(500_000))));
        assert_eq!(
            snap.get("b2"),
            Some(&BusConnState::error("open failed")),
            "the one dead channel is the only one that reads as an error",
        );
        assert_eq!(snap.get("b3"), Some(&connected(Some(500_000))));
        assert_eq!(snap.get("b4"), Some(&connected(Some(500_000))));
    }

    #[test]
    fn setting_the_same_state_twice_reports_no_change() {
        // `set_many`'s bool is what suppresses redundant events; a
        // re-set of an identical value must not wake the WebView.
        let states = ConnectionStates::default();
        assert!(states.set_many([("b1".into(), BusConnState::Connecting)]));
        assert!(!states.set_many([("b1".into(), BusConnState::Connecting)]));
    }

    #[test]
    fn remove_reports_whether_it_did_anything() {
        let states = ConnectionStates::default();
        assert!(!states.remove_many(["b1".to_string()]));
        states.set_many([("b1".into(), BusConnState::Connecting)]);
        assert!(states.remove_many(["b1".to_string()]));
        assert!(states.snapshot().is_empty());
    }

    #[test]
    fn the_wire_shape_is_a_tagged_union_the_frontend_can_switch_on() {
        let json = serde_json::to_value(BusConnState::Connected {
            applied: Some(AppliedBusConfig {
                speed_bps: Some(250_000),
                fd_enabled: true,
                fd_data_speed_bps: Some(2_000_000),
            }),
        })
        .unwrap();
        assert_eq!(json["kind"], "connected");
        assert_eq!(json["applied"]["speedBps"], 250_000);
        assert_eq!(json["applied"]["fdEnabled"], true);
        assert_eq!(json["applied"]["fdDataSpeedBps"], 2_000_000);

        let json = serde_json::to_value(BusConnState::error("boom")).unwrap();
        assert_eq!(json["kind"], "error");
        assert_eq!(json["reason"], "boom");

        // "No ConfigureBus was sent" must be distinguishable from "sent
        // 0", which is why `speedBps` is nullable rather than defaulted.
        let json = serde_json::to_value(BusConnState::Connected {
            applied: Some(AppliedBusConfig {
                speed_bps: None,
                fd_enabled: false,
                fd_data_speed_bps: None,
            }),
        })
        .unwrap();
        assert!(json["applied"]["speedBps"].is_null());
    }
}
