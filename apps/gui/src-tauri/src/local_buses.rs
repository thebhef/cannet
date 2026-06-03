//! Host-side `SharedBus` instances for `local-virtual-bus`
//! definitions (ADR 0021).
//!
//! The *virtual bus* is a project-scoped
//! resource ([`crate::project::LocalVirtualBusDef`]) separate from
//! the *bindings* that observe it. The registry owns one
//! [`SharedBus`] per definition and tracks any bridges configured on
//! it. Per-binding participants are not owned here — they're owned
//! by the in-process session that the host opens for a binding via
//! [`LocalBusRegistry::attach_participant`], which mirrors what
//! `cannet_client::connect_and_subscribe` does for a remote session.
//!
//! Lifetimes:
//! - **virtual bus**: instantiated on project open ([`Self::create`]),
//!   dropped on project close. Owns its bridges. A vbus has no
//!   user-configurable bitrate — SharedBus's arbitration timing
//!   comes from a fixed [`default_vbus_config`] applied at create
//!   time and never changes for the bus's lifetime.
//! - **session participants**: held by the in-process session in
//!   `lib.rs`. Dropped with the session.
//!
//! Bridges:
//!   * The host opens a `cannet-client` session to the bridge's
//!     `remote_address`.
//!   * The session's [`FrameReceiver`] is the bridge's
//!     `CanFrameSource`; its [`SessionTransmitter`] is wrapped in a
//!     thin adapter that becomes the bridge's `CanFrameSink`.
//!   * [`SharedBus::attach_bridge`] returns a [`BridgeHandle`] that we
//!     hold for the life of the bridge. Dropping it tears the bridge
//!     down (the ingress / egress threads detach and self-terminate).

use std::collections::HashMap;
use std::sync::Mutex;

use cannet_client::{
    connect_and_subscribe, ConnectionError, SessionHandle, SessionTransmitter,
    Subscription,
};
use cannet_core::{
    BridgeHandle, BusConfig, CanFrame, CanFrameSink, LocalSink, LocalSource,
    SharedBus,
};

use crate::project::{BridgeSpec, LocalVirtualBusDef};

/// Channel id stamped onto frames carried over a vbus bridge — the
/// trace store uses `channel` for paging granularity and per-source
/// routing (`bus_id` carries the logical assignment), so a fixed
/// channel per bridge is fine.
const LOCAL_BUS_CHANNEL: u8 = 0;

/// One installed bridge on a local virtual bus.
struct InstalledBridge {
    /// Display name (matches the `BridgeSpec.name`).
    name: String,
    /// `cannet-client` session backing the bridge. Dropping `_session`
    /// disconnects from the remote.
    _session: SessionHandle,
    /// Drop to detach the bridge from the bus. The
    /// `BridgeHandle::drop` is non-blocking (cannet-core makes the
    /// ingress / egress threads self-terminate); see ADR 0021 §
    /// *Bridge teardown*.
    _bridge: BridgeHandle,
}

/// One live local virtual bus.
struct LocalBus {
    /// The shared bus primitive. We keep the [`SharedBus`] alive for
    /// the lifetime of the [`LocalBus`].
    bus: SharedBus,
    /// Display name (matches `LocalVirtualBusDef.name` at the moment
    /// of creation; not updated when the project renames the bus —
    /// the host doesn't need it for routing).
    #[allow(dead_code)]
    name: String,
    /// Installed bridges keyed by name.
    bridges: HashMap<String, InstalledBridge>,
}

/// Registry of host-side `SharedBus` instances, keyed by
/// `virtual_bus_id`. Wraps a [`Mutex`] so it can live inside
/// `AppState` and be addressed from Tauri commands.
#[derive(Default)]
pub struct LocalBusRegistry {
    inner: Mutex<HashMap<String, LocalBus>>,
}

impl LocalBusRegistry {
    /// Instantiate a [`SharedBus`] for `virtual_bus_id`. Errors if
    /// one already exists for that id.
    pub fn create(
        &self,
        virtual_bus_id: &str,
        name: &str,
        config: BusConfig,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock().expect("local-bus registry poisoned");
        if guard.contains_key(virtual_bus_id) {
            return Err(format!(
                "local virtual bus {virtual_bus_id:?} already exists",
            ));
        }
        let bus = SharedBus::new(config);
        guard.insert(
            virtual_bus_id.to_string(),
            LocalBus {
                bus,
                name: name.to_string(),
                bridges: HashMap::new(),
            },
        );
        Ok(())
    }

    /// Drop a registered virtual bus and every bridge attached to it.
    /// Returns `true` if it existed.
    pub fn drop_bus(&self, virtual_bus_id: &str) -> bool {
        let mut guard = self.inner.lock().expect("local-bus registry poisoned");
        guard.remove(virtual_bus_id).is_some()
    }

    /// Drop every registered bus. Called on project-close /
    /// project-replace.
    pub fn drop_all(&self) {
        let mut guard = self.inner.lock().expect("local-bus registry poisoned");
        guard.clear();
    }

    /// Attach a fresh participant on `virtual_bus_id` and return its
    /// [`LocalSink`] + [`LocalSource`] pair. The session that called
    /// this owns both for its lifetime: it transmits through the sink
    /// and pumps frames out of the source into the trace store. This
    /// is the in-process analogue of [`connect_and_subscribe`].
    pub fn attach_participant(
        &self,
        virtual_bus_id: &str,
    ) -> Result<(LocalSink, LocalSource), String> {
        let guard = self.inner.lock().expect("local-bus registry poisoned");
        let entry = guard
            .get(virtual_bus_id)
            .ok_or_else(|| format!("no local virtual bus {virtual_bus_id:?}"))?;
        Ok(entry.bus.attach_participant())
    }

    /// Open a `cannet-client` session against `spec.remote_address`
    /// and attach a bridge on the named virtual bus.
    pub fn attach_bridge(
        &self,
        virtual_bus_id: &str,
        spec: &BridgeSpec,
        allocates: bool,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock().expect("local-bus registry poisoned");
        let entry = guard
            .get_mut(virtual_bus_id)
            .ok_or_else(|| format!("no local virtual bus {virtual_bus_id:?}"))?;
        if spec.name.is_empty() {
            return Err("bridge name must be non-empty".into());
        }
        if entry.bridges.contains_key(&spec.name) {
            return Err(format!(
                "bridge {:?} already installed on {virtual_bus_id:?}",
                spec.name,
            ));
        }
        let subscription = if allocates {
            Subscription::factory(spec.interface.clone(), LOCAL_BUS_CHANNEL)
        } else {
            Subscription::new(spec.interface.clone(), LOCAL_BUS_CHANNEL)
        };
        let session = connect_and_subscribe(&spec.remote_address, vec![subscription])
            .map_err(|e: ConnectionError| {
                format!("bridge {:?} failed to connect: {e}", spec.name)
            })?;
        let effective_id = session
            .subscriptions()
            .first()
            .map(|s| s.effective_id().to_string())
            .ok_or_else(|| {
                format!("bridge {:?}: no resolved subscription", spec.name)
            })?;
        let (handle, receiver, transmitter) = session.into_parts();
        let sink = SessionSink {
            transmitter,
            interface_id: effective_id,
        };
        let bridge = entry.bus.attach_bridge(&spec.name, sink, receiver);
        entry.bridges.insert(
            spec.name.clone(),
            InstalledBridge {
                name: spec.name.clone(),
                _session: handle,
                _bridge: bridge,
            },
        );
        Ok(())
    }

    /// Detach a bridge by name. Returns `true` if it existed.
    pub fn detach_bridge(
        &self,
        virtual_bus_id: &str,
        name: &str,
    ) -> Result<bool, String> {
        let mut guard = self.inner.lock().expect("local-bus registry poisoned");
        let entry = guard
            .get_mut(virtual_bus_id)
            .ok_or_else(|| format!("no local virtual bus {virtual_bus_id:?}"))?;
        Ok(entry.bridges.remove(name).is_some())
    }

    /// Snapshot of the registered virtual-bus ids.
    pub fn bus_ids(&self) -> Vec<String> {
        let guard = self.inner.lock().expect("local-bus registry poisoned");
        guard.keys().cloned().collect()
    }

    /// Names of the bridges installed on `virtual_bus_id` (empty if
    /// the bus isn't registered).
    pub fn bridge_names(&self, virtual_bus_id: &str) -> Vec<String> {
        let guard = self.inner.lock().expect("local-bus registry poisoned");
        guard
            .get(virtual_bus_id)
            .map(|b| b.bridges.values().map(|br| br.name.clone()).collect())
            .unwrap_or_default()
    }
}

/// Re-instantiate every host-side virtual bus from the project's
/// definitions, applying each def's persistent bridges. Existing
/// buses are dropped first. Per-binding session participants are
/// **not** opened here — that happens on Connect, the same way a
/// remote session would.
pub fn replay(
    registry: &LocalBusRegistry,
    defs: &[LocalVirtualBusDef],
) -> Vec<String> {
    registry.drop_all();
    let mut errors = Vec::new();
    for def in defs {
        if let Err(e) = registry.create(&def.id, &def.name, default_vbus_config()) {
            errors.push(format!("create vbus {:?}: {e}", def.id));
            continue;
        }
        for bridge in &def.bridges {
            // Until BridgeSpec carries an explicit `allocates` hint,
            // default false. Users who need to bridge against a
            // factory id can hand-edit the project file.
            if let Err(e) = registry.attach_bridge(&def.id, bridge, false) {
                errors.push(format!(
                    "attach bridge {:?} on vbus {:?}: {e}",
                    bridge.name, def.id,
                ));
            }
        }
    }
    errors
}

/// Fixed [`BusConfig`] used for every host-side virtual bus.
/// SharedBus needs *a* bus configuration for its arbitration timing,
/// but a vbus is in-process and not a model of a real wire — so the
/// user never sees this value and there's no point exposing it.
#[must_use]
pub fn default_vbus_config() -> BusConfig {
    BusConfig::classic_500k()
}

/// Adapter: a [`SessionTransmitter`] satisfies [`CanFrameSink`] by
/// forwarding `submit` calls to `transmit` with the bridge's
/// effective interface id.
struct SessionSink {
    transmitter: SessionTransmitter,
    interface_id: String,
}

#[derive(Debug)]
pub struct BridgeSinkClosed;

impl std::fmt::Display for BridgeSinkClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("bridge session closed")
    }
}

impl std::error::Error for BridgeSinkClosed {}

impl CanFrameSink for SessionSink {
    type Error = BridgeSinkClosed;

    fn submit(&mut self, frame: CanFrame) -> Result<(), Self::Error> {
        self.transmitter
            .transmit(&self.interface_id, &frame)
            .map_err(|_| BridgeSinkClosed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_then_drop_works() {
        let reg = LocalBusRegistry::default();
        reg.create("vbus", "Test", BusConfig::classic_500k()).unwrap();
        assert_eq!(reg.bus_ids(), vec!["vbus".to_string()]);
        assert!(reg.drop_bus("vbus"));
        assert!(reg.bus_ids().is_empty());
    }

    #[test]
    fn creating_the_same_vbus_twice_errors() {
        let reg = LocalBusRegistry::default();
        reg.create("vbus", "v", BusConfig::classic_500k()).unwrap();
        let err = reg
            .create("vbus", "v", BusConfig::classic_500k())
            .unwrap_err();
        assert!(err.contains("already exists"), "{err}");
    }

    #[test]
    fn attach_participant_returns_a_working_sink_source_pair() {
        let reg = LocalBusRegistry::default();
        reg.create("vbus", "v", BusConfig::classic_500k()).unwrap();
        let (sink_a, _source_a) = reg.attach_participant("vbus").unwrap();
        let (_sink_b, _source_b) = reg.attach_participant("vbus").unwrap();
        // The participants exist; dropping them detaches.
        drop(sink_a);
        assert!(reg.drop_bus("vbus"));
    }

    #[test]
    fn attach_participant_on_unknown_vbus_errors() {
        let reg = LocalBusRegistry::default();
        match reg.attach_participant("missing") {
            Ok(_) => panic!("expected error"),
            Err(err) => assert!(err.contains("no local virtual bus"), "{err}"),
        }
    }

    #[test]
    fn replay_creates_vbuses_without_touching_bindings() {
        let reg = LocalBusRegistry::default();
        let defs = vec![LocalVirtualBusDef {
            id: "vbus1".into(),
            name: "Bench".into(),
            bridges: vec![],
        }];
        let errs = replay(&reg, &defs);
        assert!(errs.is_empty(), "unexpected errors: {errs:?}");
        assert_eq!(reg.bus_ids(), vec!["vbus1".to_string()]);
    }
}
