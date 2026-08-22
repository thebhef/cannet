//! Fault-confinement state of the controllers behind a session.
//!
//! ISO 11898-1 makes every CAN controller run a pair of error counters
//! and a three-state machine over them: **error-active** while it is
//! healthy, **error-passive** once either counter passes 127 (its error
//! flags turn recessive and stop destroying other nodes' traffic), and
//! **bus-off** once the transmit counter passes 255, at which point it
//! is off the wire entirely. That state and those two counters are the
//! only thing a controller reports about *why* a bus is unwell — the
//! error frames themselves carry no identity.
//!
//! The wire has carried them since it was written: `InterfaceState`
//! (`interface_id`, `ControllerState`, `tec`, `rec`), produced by the
//! python-can sidecar's state poll and forwarded untouched by the
//! server and the proxy. What was missing was somewhere for a consumer
//! to read them, because the session's only outward channel is the
//! frame stream and a controller state is not a frame.
//!
//! [`ControllerStates`] is that place, shaped like
//! [`SessionClock`](crate::clock::SessionClock): a cheap-to-clone handle
//! over shared state that the session's own worker writes and anything
//! holding the session reads, without blocking and without a callback
//! into the reader's thread.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// ISO 11898-1 fault confinement, as a controller reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControllerState {
    /// Healthy: both counters below 128, error flags dominant.
    Active,
    /// A counter above 127. The node still communicates, but its error
    /// flags are recessive — it no longer destroys others' traffic.
    Passive,
    /// Transmit counter above 255. The node is off the wire.
    BusOff,
}

impl ControllerState {
    /// The wire's enum, or `None` for the unspecified value and for
    /// anything a future peer sends that this build does not know.
    /// A state we cannot name is not reported at all — a health readout
    /// that guesses is worse than one that says nothing.
    #[must_use]
    pub fn from_wire(value: i32) -> Option<Self> {
        match value {
            1 => Some(Self::Active),
            2 => Some(Self::Passive),
            3 => Some(Self::BusOff),
            _ => None,
        }
    }

    /// Lower-camel name, as the GUI's wire shapes spell their tags.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Passive => "passive",
            Self::BusOff => "busOff",
        }
    }
}

/// One controller's last reported state and error counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControllerStatus {
    pub state: ControllerState,
    /// Transmit error counter (TEC).
    pub tec: u32,
    /// Receive error counter (REC).
    pub rec: u32,
}

/// Per-interface controller state for one session. Cheap to clone; the
/// clones share one map, so the session worker's writes are visible to
/// every reader.
#[derive(Debug, Clone, Default)]
pub struct ControllerStates(Arc<Mutex<BTreeMap<String, ControllerStatus>>>);

impl ControllerStates {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record what a peer reported for `interface_id`. A state this
    /// build cannot name is dropped rather than stored as a guess.
    pub fn record(&self, interface_id: &str, state: i32, tec: u32, rec: u32) {
        let Some(state) = ControllerState::from_wire(state) else {
            return;
        };
        if let Ok(mut guard) = self.0.lock() {
            guard.insert(
                interface_id.to_string(),
                ControllerStatus { state, tec, rec },
            );
        }
    }

    /// What `interface_id`'s controller last reported, or `None` for an
    /// interface no peer has reported on. Never blocks on the network.
    #[must_use]
    pub fn get(&self, interface_id: &str) -> Option<ControllerStatus> {
        self.0.lock().ok()?.get(interface_id).copied()
    }

    /// Everything reported so far, by interface id.
    #[must_use]
    pub fn snapshot(&self) -> BTreeMap<String, ControllerStatus> {
        self.0.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reported_state_is_readable_through_any_clone_of_the_handle() {
        // The session worker holds one clone and the control surface
        // another; a report on the worker's has to be visible on the
        // reader's, which is the whole reason this is not a plain map.
        let writer = ControllerStates::new();
        let reader = writer.clone();
        assert_eq!(reader.get("PCAN_USBBUS1"), None);
        writer.record("PCAN_USBBUS1", 2, 142, 9);
        assert_eq!(
            reader.get("PCAN_USBBUS1"),
            Some(ControllerStatus {
                state: ControllerState::Passive,
                tec: 142,
                rec: 9,
            }),
        );
    }

    #[test]
    fn the_newest_report_replaces_the_last_one() {
        let states = ControllerStates::new();
        states.record("i1", 1, 0, 0);
        states.record("i1", 3, 256, 0);
        assert_eq!(states.get("i1").unwrap().state, ControllerState::BusOff);
        assert_eq!(states.get("i1").unwrap().tec, 256);
    }

    #[test]
    fn a_state_this_build_cannot_name_is_not_reported_at_all() {
        // The control for the test above: an unspecified or future
        // state must leave the map untouched rather than land as a
        // guess, and must not wipe what a real report put there.
        let states = ControllerStates::new();
        states.record("i1", 0, 7, 7);
        assert_eq!(states.get("i1"), None, "unspecified reports nothing");
        states.record("i1", 2, 130, 4);
        states.record("i1", 99, 0, 0);
        assert_eq!(
            states.get("i1").unwrap().state,
            ControllerState::Passive,
            "an unknown state does not displace a known one",
        );
    }

    #[test]
    fn interfaces_are_reported_independently() {
        let states = ControllerStates::new();
        states.record("i1", 3, 256, 0);
        states.record("i2", 1, 0, 0);
        assert_eq!(states.get("i1").unwrap().state, ControllerState::BusOff);
        assert_eq!(states.get("i2").unwrap().state, ControllerState::Active);
        assert_eq!(states.snapshot().len(), 2);
    }

    #[test]
    fn the_wire_enum_maps_onto_the_names_the_gui_spells() {
        assert_eq!(ControllerState::Active.as_str(), "active");
        assert_eq!(ControllerState::Passive.as_str(), "passive");
        assert_eq!(ControllerState::BusOff.as_str(), "busOff");
    }
}
