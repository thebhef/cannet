//! Project files: the saved workspace, as a JSON document, read and
//! written by the [`open_project`] / [`save_project`] commands.
//!
//! The host owns the project model. The two fields it *doesn't*
//! interpret are `layout` (`dockview`'s serialized layout blob) and
//! `elements` (the project's elements — `trace` / `plot` / `transmit`
//! / `filter`, each an opaque `{kind, id, …}` record the frontend
//! defines); the host just round-trips both.
//!
//! Carries: the panel layout, the project elements, the loaded DBCs +
//! per-DBC bus scoping, the logical-bus list, the interface → bus
//! bindings, the in-process virtual buses, the transmit-message pool,
//! and the remote-server address.
//!
//! The file carries an explicit [`PROJECT_SCHEMA_VERSION`]. Only the
//! current version is accepted — see ADR 0011; older and newer
//! versions are rejected with a user-facing message rather than
//! migrated.

use serde::{Deserialize, Serialize};

/// Current project-file schema version. A file is accepted only if its
/// `schema_version` matches exactly; any other value is rejected with a
/// user-facing message rather than migrated (ADR 0011). Bump this
/// whenever the in-memory shape changes.
pub const PROJECT_SCHEMA_VERSION: u32 = 7;

/// A logical bus. `id` is a stable, project-local identifier (graph
/// edges reference it; per-DBC scoping and the filter `bus` predicate
/// both compare against it). `name` is the user-facing label.
///
/// `speed_bps`, `fd`, and `fd_data_speed_bps` are the hardware
/// configuration the host pushes to the sidecar (via `ConfigureBus`)
/// every time it opens a session for an interface binding scoped to
/// this bus. `fd_data_speed_bps` is only meaningful when `fd` is true
/// (FD's arbitration phase still runs at `speed_bps`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bus {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub speed_bps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fd: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fd_data_speed_bps: Option<u32>,
    /// User-chosen graph colour (`#rrggbb`). The host round-trips it
    /// without interpretation; the GUI falls back to a palette colour
    /// when it's absent.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
}

/// An interface binding routes a project [`Bus`] to an interface.
/// Each binding is a uniform `(server, interface, bus_id)` triple
/// regardless of what's on the other end — see ADR 0023. The
/// optional [`Self::kind`] discriminator hints at which backend the
/// host should pick when opening a session for the binding, but the
/// effective dispatch is by the URL scheme on [`Self::server`].
///
/// Multiple bindings may target the same `(server, interface)` — the
/// hardware-server (ADR 0022) and the in-process virtual bus
/// (ADR 0021) both fan out to N subscribers, so the host stamps each
/// source frame with every matching binding's `bus_id`.
///
/// Address shapes:
/// - **remote `host:port`** — a `(server, interface)` on a remote
///   `cannet-server`.
/// - **`"local"` sentinel** — the local sidecar at whatever address
///   it's bound to this session; the port is randomised per launch
///   so the sentinel is what gets persisted.
/// - **`local-vbus://<vbus_id>`** — an in-process virtual bus owned
///   by the project ([`Project::local_virtual_buses`]). `interface`
///   is the canonical `"bus"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InterfaceBinding {
    #[serde(default)]
    pub kind: BindingKind,
    pub server: String,
    pub interface: String,
    pub bus_id: String,
}

/// URI scheme that identifies an in-process virtual bus owned by the
/// project. A binding with `server = "local-vbus://<vbus_id>"` opens
/// an in-process session against the named [`LocalVirtualBusDef`].
pub const LOCAL_VBUS_URL_SCHEME: &str = "local-vbus://";

/// Canonical wire-interface name used by every `local-vbus://`
/// binding. A vbus has a single conceptual interface (the bus
/// itself); multiple project buses bound to the same vbus share this
/// interface name and rely on the multi-subscriber fan-out
/// (ADR 0022 §"shared interface").
pub const LOCAL_VBUS_INTERFACE: &str = "bus";

/// Discriminator for the three binding kinds (v6 schema).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BindingKind {
    /// A `(server, interface)` on a remote `cannet-server`. The
    /// default kind.
    #[default]
    Remote,
    /// A factory subscription against a remote virtual-bus server
    /// (ADR 0021).
    RemoteVirtualBus,
    /// A binding to an entry in [`Project::local_virtual_buses`]
    /// (ADR 0021).
    LocalVirtualBus,
}

/// A virtual bus owned by the project (ADR 0021). The host
/// instantiates one [`cannet_core::SharedBus`] per entry on project
/// open; bindings with `server = "local-vbus://<id>"` reference it.
/// Many bindings may reference the same virtual bus — each opens its
/// own participant on the shared bus when its session is connected.
///
/// A vbus has no user-configurable baud rate: it's an in-process
/// channel, not a model of a real wire, so a configurable bitrate
/// would just be misleading UI. The host instantiates each vbus
/// with a fixed default [`cannet_core::BusConfig`] that SharedBus
/// uses for its internal arbitration timing; the user never sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalVirtualBusDef {
    /// Stable project-local id, used in the binding's
    /// `local-vbus://<id>` URL and as the host's registry key.
    pub id: String,
    /// User-facing label.
    pub name: String,
    /// Bridges installed on the virtual bus. Each is re-instantiated
    /// on project open by opening a `cannet-client` session to its
    /// `remote_address` and calling `SharedBus::attach_bridge`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bridges: Vec<BridgeSpec>,
}

/// A persisted bridge installed on a [`LocalVirtualBusDef`].
/// `remote_address` is a `cannet-server` `host:port` (or the
/// `"local"` sentinel for the local sidecar). `interface` is the
/// wire id on that server (or its factory id for a cross-server
/// virtual-bus bridge). `name` is the user-chosen label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeSpec {
    pub remote_address: String,
    pub interface: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
}

/// A loaded DBC reference with its bus scoping. An empty `buses` is
/// the conventional "all buses" default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DbcRef {
    pub path: String,
    #[serde(default)]
    pub buses: Vec<String>,
}

/// A saved workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    /// Schema version — see [`PROJECT_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// The `dockview` panel layout, verbatim. The host doesn't read
    /// this; it's the frontend's serialized layout.
    pub layout: serde_json::Value,
    /// The project's elements — `trace` / `plot` / `transmit` /
    /// `filter`, each an opaque `{kind, id, …}` record. The host
    /// doesn't read these; the frontend owns the shape.
    #[serde(default)]
    pub elements: Vec<serde_json::Value>,
    /// Logical buses the project knows about.
    #[serde(default)]
    pub buses: Vec<Bus>,
    /// Interface → bus bindings.
    #[serde(default)]
    pub interface_bindings: Vec<InterfaceBinding>,
    /// Loaded DBCs + per-DBC bus scoping. An empty `buses`
    /// on a `DbcRef` is the "all buses" default.
    #[serde(default)]
    pub dbcs: Vec<DbcRef>,
    /// Remote `cannet-server` address (`host:port`), if the project
    /// connects to one.
    #[serde(default)]
    pub remote_address: Option<String>,
    /// In-process virtual buses owned by the project (ADR 0021).
    /// Each entry is instantiated once on project open;
    /// [`InterfaceBinding`]s with `kind = local-virtual-bus`
    /// reference one by [`LocalVirtualBusDef::id`].
    #[serde(default)]
    pub local_virtual_buses: Vec<LocalVirtualBusDef>,
    /// The TX-message pool. A flat, global list of
    /// transmit messages the project owns; each transmit panel groups
    /// a subset for display via its element's `frame_ids`. The host
    /// registry ([`crate::transmit_frames::TransmitFrameRegistry`]) is
    /// the runtime source of truth — `open_project` loads it from this
    /// list (all periodics stopped), `save_project` snapshots it back.
    /// Additive; no schema-version bump.
    #[serde(default)]
    pub transmit_frames: Vec<crate::transmit_frames::TransmitFrame>,
}

/// Parse project JSON. Accepts only a file whose `schema_version`
/// matches [`PROJECT_SCHEMA_VERSION`]; any other version (or a missing
/// version) is rejected with a user-facing message (ADR 0011). Split
/// from [`open_project`] so the parse is testable without touching the
/// filesystem.
fn parse_project(text: &str) -> Result<Project, String> {
    let raw: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("invalid project JSON: {e}"))?;
    let version = raw
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "missing schema_version".to_string())?;
    if version == u64::from(PROJECT_SCHEMA_VERSION) {
        serde_json::from_value(raw).map_err(|e| format!("invalid project JSON: {e}"))
    } else {
        Err(format!(
            "schema version {version}; this build expects {PROJECT_SCHEMA_VERSION}",
        ))
    }
}

/// Read and parse a project file. Errors (with a user-facing message)
/// if it can't be read, isn't valid JSON, or has an unsupported schema
/// version (see [`parse_project`]).
///
/// Emits `project`-tagged messages on the system log — `info` on
/// success, `error` on any failure.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn open_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    path: String,
) -> Result<Project, String> {
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            let msg = format!("failed to read project at {path}: {e}");
            crate::sys_error!(&app, "project", "{msg}");
            return Err(msg);
        }
    };
    match parse_project(&text) {
        Ok(p) => {
            // Load the host TX-message registry from
            // the project's pool. All periodics start stopped — reopen
            // never fires traffic onto a bus the user hasn't
            // intentionally reconnected.
            state
                .transmit_frames
                .lock()
                .expect("transmit_frames mutex poisoned")
                .load(p.transmit_frames.clone());
            crate::sys_info!(&app, "project", "opened project {path}");
            Ok(p)
        }
        Err(e) => {
            let msg = format!("project at {path}: {e}");
            crate::sys_error!(&app, "project", "{msg}");
            Err(msg)
        }
    }
}

/// Serialize `project` (pretty-printed) and write it to `path`.
///
/// Emits `project`-tagged messages on the system log —
/// `info` on success, `error` on serialise / write failure.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn save_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    path: String,
    mut project: Project,
) -> Result<(), String> {
    // The host registry is the source of truth for TX
    // messages — the thin-view frontend doesn't carry them in the
    // project it submits. Snapshot the registry into the project before
    // writing so save captures the current pool + order.
    project.transmit_frames = state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned")
        .snapshot();
    let text = match serde_json::to_string_pretty(&project) {
        Ok(t) => t,
        Err(e) => {
            let msg = format!("failed to serialize project: {e}");
            crate::sys_error!(&app, "project", "{msg}");
            return Err(msg);
        }
    };
    match std::fs::write(&path, text) {
        Ok(()) => {
            crate::sys_info!(&app, "project", "saved project to {path}");
            Ok(())
        }
        Err(e) => {
            let msg = format!("failed to write project to {path}: {e}");
            crate::sys_error!(&app, "project", "{msg}");
            Err(msg)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        Project {
            schema_version: PROJECT_SCHEMA_VERSION,
            layout: serde_json::json!({ "grid": { "root": {} }, "panels": {} }),
            elements: vec![serde_json::json!({ "kind": "trace", "id": "abc" })],
            buses: vec![Bus {
                id: "p".into(),
                name: "Powertrain".into(),
                speed_bps: Some(500_000),
                fd: Some(false),
                fd_data_speed_bps: None,
                color: Some("#60a5fa".into()),
            }],
            interface_bindings: vec![InterfaceBinding {
                kind: BindingKind::Remote,
                server: "local".into(),
                interface: "pcan:PCAN_USBBUS1(h:0x51, ch:0)".into(),
                bus_id: "p".into(),
            }],
            dbcs: vec![DbcRef {
                path: "/some/where/bus.dbc".into(),
                buses: vec!["p".into()],
            }],
            remote_address: Some("127.0.0.1:50051".into()),
            local_virtual_buses: Vec::new(),
            transmit_frames: Vec::new(),
        }
    }

    #[test]
    fn round_trips_through_the_serializer() {
        let p = sample();
        assert_eq!(parse_project(&serde_json::to_string_pretty(&p).unwrap()).unwrap(), p);
    }

    #[test]
    fn parse_defaults_the_optional_fields() {
        let p = parse_project(
            r#"{"schema_version": 7, "layout": {"grid": {}, "panels": {}}}"#,
        )
        .unwrap();
        assert!(p.elements.is_empty());
        assert!(p.dbcs.is_empty());
        assert!(p.buses.is_empty());
        assert!(p.interface_bindings.is_empty());
        assert_eq!(p.remote_address, None);
    }

    /// A virtual-bus definition + a binding pointing at it round-trip
    /// through serialize + parse. The vbus owns the config/bridges;
    /// the binding only references the vbus by id.
    #[test]
    fn local_virtual_bus_definition_and_binding_round_trip() {
        let p = Project {
            schema_version: PROJECT_SCHEMA_VERSION,
            layout: serde_json::json!({"grid": {}, "panels": {}}),
            elements: vec![],
            buses: vec![Bus {
                id: "v".into(),
                name: "Test virtual".into(),
                speed_bps: Some(500_000),
                fd: Some(true),
                fd_data_speed_bps: Some(2_000_000),
                color: None,
            }],
            interface_bindings: vec![InterfaceBinding {
                kind: BindingKind::LocalVirtualBus,
                server: format!("{LOCAL_VBUS_URL_SCHEME}vbus1"),
                interface: LOCAL_VBUS_INTERFACE.into(),
                bus_id: "v".into(),
            }],
            dbcs: vec![],
            remote_address: None,
            local_virtual_buses: vec![LocalVirtualBusDef {
                id: "vbus1".into(),
                name: "Bench".into(),
                bridges: vec![BridgeSpec {
                    remote_address: "local".into(),
                    interface: "pcan:PCAN_USBBUS1(h:0x51, ch:0)".into(),
                    name: "hw".into(),
                }],
            }],
            transmit_frames: Vec::new(),
        };
        let text = serde_json::to_string_pretty(&p).unwrap();
        let parsed = parse_project(&text).unwrap();
        assert_eq!(parsed, p);
    }

    /// v5 round-trips a binding that uses the `"local"` sentinel
    /// verbatim — i.e. saving and reloading doesn't drop or rewrite
    /// the sentinel.
    #[test]
    fn local_sentinel_round_trips_through_serialize_and_parse() {
        let p = Project {
            schema_version: PROJECT_SCHEMA_VERSION,
            layout: serde_json::json!({"grid": {}, "panels": {}}),
            elements: vec![],
            buses: vec![Bus {
                id: "p".into(),
                name: "Powertrain".into(),
                speed_bps: None,
                fd: None,
                fd_data_speed_bps: None,
                color: None,
            }],
            interface_bindings: vec![InterfaceBinding {
                kind: BindingKind::Remote,
                server: "local".into(),
                interface: "pcan:PCAN_USBBUS1(h:0x51, ch:0)".into(),
                bus_id: "p".into(),
            }],
            dbcs: vec![],
            remote_address: None,
            local_virtual_buses: Vec::new(),
            transmit_frames: Vec::new(),
        };
        let text = serde_json::to_string_pretty(&p).unwrap();
        let parsed = parse_project(&text).unwrap();
        assert_eq!(parsed, p);
        assert_eq!(parsed.interface_bindings[0].server, "local");
    }

    #[test]
    fn parse_rejects_an_unsupported_schema_version() {
        // A future version, the long-since-superseded v1, and the
        // pre-current versions that used to migrate (v2–v6) — all are
        // rejected now that the migrators are gone (ADR 0011).
        assert!(parse_project(r#"{"schema_version": 999, "layout": {}}"#).is_err());
        assert!(parse_project(r#"{"schema_version": 1, "layout": {}}"#).is_err());
        for v in 2..=6 {
            assert!(
                parse_project(&format!(r#"{{"schema_version": {v}, "layout": {{}}}}"#)).is_err(),
                "schema version {v} should be rejected, not migrated"
            );
        }
        assert!(parse_project(r#"{"layout": {}}"#).is_err(), "missing version");
        assert!(parse_project("not json").is_err());
    }

    /// `open_project` itself takes a `tauri::AppHandle` (system-log
    /// fanout), so the "missing file" path is exercised
    /// here against the underlying helper: a missing path yields a
    /// `std::io::Error` that the command then wraps with a
    /// user-facing prefix. The wrapping is trivial; this test guards
    /// the read step itself.
    #[test]
    fn missing_file_surfaces_as_an_io_error() {
        assert!(std::fs::read_to_string("/no/such/cannet-project.json").is_err());
    }
}
