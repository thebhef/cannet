//! Project files: the saved workspace, as a JSON document, read and
//! written by the [`open_project`] / [`save_project`] commands.
//!
//! The host owns the project model. The two fields it *doesn't*
//! interpret are `layout` (`dockview`'s serialized layout blob) and
//! `elements` (the project's elements — `trace` / `plot` / `transmit`
//! / `filter` (Phase 6), each an opaque `{kind, id, …}` record the
//! frontend defines); the host just round-trips both.
//!
//! Carries today: the panel layout, the project elements, the loaded
//! DBCs + per-DBC bus scoping, the logical-bus list, the interface →
//! bus bindings, and the remote-server address. Phase 6 grew the
//! schema with the buses + bindings + per-DBC scoping fields, so
//! [`PROJECT_SCHEMA_VERSION`] bumped 2 → 3. Phase 9 bumped it 3 → 4
//! to lift per-plot-panel `params.notes` out of the dockview layout
//! into the session-scoped host store. v2 and v3 files migrate on
//! parse: the new lists default empty, `dbc_paths` is lifted into
//! `dbcs[].path` with no scoping (= unscoped = "all buses"), and any
//! `notes` field on a plot panel's `params` is stripped.

use serde::{Deserialize, Serialize};

/// Current project-file schema version. Bumped if the shape changes
/// incompatibly so a stale file is rejected rather than misread.
///
/// History:
/// - v1: single `dbc_path`.
/// - v2: `dbc_paths` list, `elements`, `remote_address`.
/// - v3 (Phase 6): `buses`, `interface_bindings`, `dbcs` (per-DBC bus
///   scoping; replaces the bare `dbc_paths` list). The on-disk
///   `schema_version` is rewritten to 3 the next time a migrated v2
///   project is saved.
/// - v4 (Phase 9): notes lifted out of per-plot-panel dockview
///   `params` into the session-scoped host store. The project file
///   no longer stores notes (they're session-scoped — saved to a
///   BLF sidecar when the user runs Save Capture). The migration
///   strips any `notes` field from plot-panel `params` blocks in
///   the dockview layout so a Phase-4-vintage project opens
///   cleanly. The on-disk `schema_version` is rewritten to 4 the
///   next time a migrated project is saved.
/// - v5: `InterfaceBinding.server` may be the literal `"local"`
///   sentinel, meaning "the local sidecar at whatever address it's
///   bound to in the current session". This decouples the persisted
///   binding from the sidecar's random per-launch port. v4 files
///   parse unchanged; any pre-existing `127.0.0.1:<port>` binding
///   renders under a stale remote-server row until the user re-picks
///   it from the Local group (the existing offline-fallback UX
///   already supports this).
/// - v6 (Phase 13): three binding kinds (ADR 0021 / 0022):
///   `"remote"` (existing semantics — a `(server, interface)` on a
///   remote `cannet-server`), `"remote-virtual-bus"` (subscribe to
///   the factory id of a remote virtual-bus server), and
///   `"local-virtual-bus"` (instantiate a `SharedBus` in-process, no
///   sidecar, with an optional list of bridges to remote interfaces).
///   v5 entries migrate to `kind: "remote"` on parse; the file is
///   rewritten to v6 on next save.
/// - v7 (Phase 13): `local-virtual-bus` bindings are addressed via
///   the same `(server, interface)` pair as every other kind —
///   `server = "local-vbus://<vbus_id>"`, `interface = "bus"`. The
///   separate `virtual_bus_id` field is dropped; the URL is the
///   index, and the host dispatches on the URL scheme when it opens a
///   session for the binding. No on-disk projects exist with the v6
///   shape (Phase 13 hasn't shipped yet), so v6 is rejected like any
///   other unknown version rather than carrying a migrator forward.
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

/// Discriminator for the three binding kinds (Phase 13, v6 schema).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BindingKind {
    /// A `(server, interface)` on a remote `cannet-server`. This is
    /// the v5-compatible default.
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

/// A loaded DBC reference with its bus scoping (Phase 6). Replaces
/// the v2 `dbc_paths` entry; an empty `buses` is the conventional
/// "all buses" default and is what a migrated v2 project carries.
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
    /// Logical buses the project knows about (Phase 6).
    #[serde(default)]
    pub buses: Vec<Bus>,
    /// Interface → bus bindings (Phase 6).
    #[serde(default)]
    pub interface_bindings: Vec<InterfaceBinding>,
    /// Loaded DBCs + per-DBC bus scoping (Phase 6). An empty `buses`
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
    /// The TX-message pool (Phase 13 Step 9). A flat, global list of
    /// transmit messages the project owns; each transmit panel groups
    /// a subset for display via its element's `frame_ids`. The host
    /// registry ([`crate::transmit_frames::TransmitFrameRegistry`]) is
    /// the runtime source of truth — `open_project` loads it from this
    /// list (all periodics stopped), `save_project` snapshots it back.
    /// Additive; no schema-version bump.
    #[serde(default)]
    pub transmit_frames: Vec<crate::transmit_frames::TransmitFrame>,
}

/// Parse project JSON. Accepts a v4 file verbatim; migrates v3
/// (Phase 9: lifts plot-panel `params.notes` out of the dockview
/// layout — they're session-scoped now) and v2 (Phase 6:
/// `dbc_paths` → `dbcs`, plus default Phase-6 fields) in memory.
/// v1 and anything else are rejected with a user-facing message.
/// Split from [`open_project`] so the parse + migration is
/// testable without touching the filesystem.
fn parse_project(text: &str) -> Result<Project, String> {
    let raw: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("invalid project JSON: {e}"))?;
    let version = raw
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "missing schema_version".to_string())?;
    match version {
        7 => serde_json::from_value(raw).map_err(|e| format!("invalid project JSON: {e}")),
        5 => migrate_v5(raw),
        4 => migrate_v4(raw).and_then(reapply_v5_to_v6),
        3 => migrate_v3(raw).and_then(reapply_v5_to_v6),
        2 => migrate_v2(raw)
            .map(|mut p| {
                strip_plot_notes_from_layout(&mut p.layout);
                p
            })
            .and_then(reapply_v5_to_v6),
        v => Err(format!(
            "schema version {v}; this build expects {PROJECT_SCHEMA_VERSION}",
        )),
    }
}

/// v5 → v6. Adds the `kind` field on each existing binding,
/// defaulting to [`BindingKind::Remote`] so the old
/// `(server, interface, bus_id)` shape continues to work. The new
/// `local-virtual-bus` / `remote-virtual-bus` variants are opt-in:
/// users create them via the project panel.
fn migrate_v5(mut raw: serde_json::Value) -> Result<Project, String> {
    if let Some(obj) = raw.as_object_mut() {
        if let Some(serde_json::Value::Array(bindings)) = obj.get_mut("interface_bindings") {
            for binding in bindings.iter_mut() {
                if let Some(map) = binding.as_object_mut() {
                    map.entry("kind").or_insert_with(|| "remote".into());
                }
            }
        }
        obj.insert(
            "schema_version".into(),
            serde_json::Value::from(PROJECT_SCHEMA_VERSION),
        );
    }
    serde_json::from_value(raw).map_err(|e| format!("v5 migration failed: {e}"))
}

/// Re-apply the v5 → v6 binding-kind defaulting once an upstream
/// migrator (v4 / v3 / v2) has already produced a [`Project`].
/// Each existing binding ends up as [`BindingKind::Remote`], which
/// is also the struct's default — no-op in practice today, but
/// retained as the explicit migration step for clarity.
fn reapply_v5_to_v6(project: Project) -> Result<Project, String> {
    Ok(project)
}

/// v4 → v5. No shape change: v5 only relaxes the meaning of
/// `InterfaceBinding.server` to allow the literal `"local"` sentinel.
/// Per the approved plan we do not auto-rewrite existing
/// `127.0.0.1:<port>` bindings — the user re-picks them once from
/// the live Local group, and the offline-fallback UI handles the
/// transition.
fn migrate_v4(mut raw: serde_json::Value) -> Result<Project, String> {
    if let Some(obj) = raw.as_object_mut() {
        obj.insert(
            "schema_version".into(),
            serde_json::Value::from(PROJECT_SCHEMA_VERSION),
        );
    }
    serde_json::from_value(raw).map_err(|e| format!("v4 migration failed: {e}"))
}

/// v3 → v4. Walks the `dockview` layout and removes the per-plot-
/// panel `params.notes` field; Phase 9 stores notes in the
/// session-scoped host store rather than the project file.
fn migrate_v3(mut raw: serde_json::Value) -> Result<Project, String> {
    if let Some(obj) = raw.as_object_mut() {
        if let Some(layout) = obj.get_mut("layout") {
            strip_plot_notes_from_layout(layout);
        }
        obj.insert(
            "schema_version".into(),
            serde_json::Value::from(PROJECT_SCHEMA_VERSION),
        );
    }
    serde_json::from_value(raw).map_err(|e| format!("v3 migration failed: {e}"))
}

fn migrate_v2(mut raw: serde_json::Value) -> Result<Project, String> {
    // Lift `dbc_paths: [string]` into `dbcs: [{path, buses: []}]`.
    let dbc_paths: Vec<String> = raw
        .get("dbc_paths")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| format!("invalid v2 dbc_paths: {e}"))?
        .unwrap_or_default();
    let dbcs: Vec<DbcRef> = dbc_paths
        .into_iter()
        .map(|path| DbcRef { path, buses: Vec::new() })
        .collect();
    if let Some(obj) = raw.as_object_mut() {
        obj.remove("dbc_paths");
        obj.insert(
            "dbcs".into(),
            serde_json::to_value(dbcs).map_err(|e| format!("migrate dbcs: {e}"))?,
        );
        obj.insert(
            "schema_version".into(),
            serde_json::Value::from(PROJECT_SCHEMA_VERSION),
        );
    }
    serde_json::from_value(raw).map_err(|e| format!("v2 migration failed: {e}"))
}

/// Walk a `dockview` layout JSON blob and strip `notes` from any
/// plot panel's `params`. The shape `dockview` serialises is
/// `{ panels: { <id>: { params: { … }, … }, … }, … }`; we don't
/// hard-code anything else about it. Anything that isn't a JSON
/// object at the expected key just gets left alone.
fn strip_plot_notes_from_layout(layout: &mut serde_json::Value) {
    let Some(panels) = layout.get_mut("panels").and_then(|v| v.as_object_mut()) else {
        return;
    };
    for panel in panels.values_mut() {
        let Some(params) = panel.get_mut("params").and_then(|v| v.as_object_mut()) else {
            continue;
        };
        params.remove("notes");
    }
}

/// Read and parse a project file. Errors (with a user-facing message)
/// if it can't be read, isn't valid JSON, or has an unsupported schema
/// version. v2 files migrate on parse (see [`parse_project`]).
///
/// Phase 7: emits `project`-tagged messages on the system log —
/// `info` on success (with a short note when a v2→v3 migration ran),
/// `error` on any failure.
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
            // Phase 13 Step 9: load the host TX-message registry from
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
/// Phase 7: emits `project`-tagged messages on the system log —
/// `info` on success, `error` on serialise / write failure.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn save_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    path: String,
    mut project: Project,
) -> Result<(), String> {
    // Phase 13 Step 9: the host registry is the source of truth for TX
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
        let p = parse_project(r#"{"schema_version": 5, "layout": {"grid": {}, "panels": {}}}"#)
            .unwrap();
        assert!(p.elements.is_empty());
        assert!(p.dbcs.is_empty());
        assert!(p.buses.is_empty());
        assert!(p.interface_bindings.is_empty());
        assert_eq!(p.remote_address, None);
    }

    /// v4 → v5 is shape-compatible. v5 → v6 adds `kind` defaulting
    /// to `remote`. A v4 file with a `127.0.0.1:<port>` binding must
    /// parse unchanged (the user re-picks it from the live Local
    /// group on next launch — see the schema-version doc).
    #[test]
    fn parse_migrates_a_v4_project_to_v6_preserving_existing_bindings() {
        let v4 = r#"{
            "schema_version": 4,
            "layout": {"grid": {}, "panels": {}},
            "interface_bindings": [
                {
                    "server": "127.0.0.1:50051",
                    "interface": "pcan:PCAN_USBBUS1",
                    "bus_id": "p"
                }
            ]
        }"#;
        let p = parse_project(v4).expect("v4 migrates");
        assert_eq!(p.schema_version, PROJECT_SCHEMA_VERSION);
        assert_eq!(p.interface_bindings.len(), 1);
        // The legacy host:port is preserved verbatim — no auto-rewrite
        // to the "local" sentinel. The GUI's offline-fallback path
        // surfaces it under a stale remote-server row until re-picked.
        assert_eq!(p.interface_bindings[0].kind, BindingKind::Remote);
        assert_eq!(p.interface_bindings[0].server, "127.0.0.1:50051");
        assert_eq!(p.interface_bindings[0].interface, "pcan:PCAN_USBBUS1");
    }

    /// v5 → v6 attaches `kind: "remote"` to each existing binding.
    /// New `local-virtual-bus` / `remote-virtual-bus` entries are
    /// opt-in; they don't appear from migration.
    #[test]
    fn parse_migrates_a_v5_project_to_v6_marking_bindings_as_remote() {
        let v5 = r#"{
            "schema_version": 5,
            "layout": {"grid": {}, "panels": {}},
            "interface_bindings": [
                {"server": "local", "interface": "vector:VN1640A", "bus_id": "p"}
            ]
        }"#;
        let p = parse_project(v5).expect("v5 migrates");
        assert_eq!(p.schema_version, PROJECT_SCHEMA_VERSION);
        assert_eq!(p.interface_bindings.len(), 1);
        assert_eq!(p.interface_bindings[0].kind, BindingKind::Remote);
        assert_eq!(p.interface_bindings[0].server, "local");
        assert_eq!(p.interface_bindings[0].interface, "vector:VN1640A");
    }

    /// A virtual-bus definition + a binding pointing at it round-trip
    /// through serialize + parse. The vbus owns the config/bridges;
    /// the binding only references the vbus by id (Phase 13 rework).
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
        // A future version, and the long-since-superseded v1.
        assert!(parse_project(r#"{"schema_version": 999, "layout": {}}"#).is_err());
        assert!(parse_project(r#"{"schema_version": 1, "layout": {}}"#).is_err());
        assert!(parse_project("not json").is_err());
    }

    /// Phase-4-vintage project: notes lived in a plot panel's
    /// dockview `params`. Phase 9 strips them from the layout
    /// (notes are session-scoped now) and bumps the version.
    #[test]
    fn parse_migrates_a_v3_project_stripping_plot_notes_from_layout() {
        let v3 = r#"{
            "schema_version": 3,
            "layout": {
                "grid": {},
                "panels": {
                    "p1": {
                        "params": {
                            "elementId": "abc",
                            "notes": [
                                {"id": "n1", "t": 1.5, "label": "look here"},
                                {"id": "n2", "t": 2.0, "label": "and here"}
                            ],
                            "areas": []
                        }
                    },
                    "p2": {
                        "params": {
                            "elementId": "other"
                        }
                    }
                }
            },
            "elements": [{"kind": "plot", "id": "abc"}]
        }"#;
        let p = parse_project(v3).expect("v3 migrates");
        assert_eq!(p.schema_version, PROJECT_SCHEMA_VERSION);

        // The plot panel's `notes` field is gone, but the rest of
        // `params` survives.
        let panels = p
            .layout
            .get("panels")
            .and_then(serde_json::Value::as_object)
            .unwrap();
        let p1 = panels
            .get("p1")
            .unwrap()
            .get("params")
            .and_then(serde_json::Value::as_object)
            .unwrap();
        assert!(!p1.contains_key("notes"), "notes should be stripped");
        assert_eq!(p1.get("elementId").and_then(|v| v.as_str()), Some("abc"));
        assert!(p1.contains_key("areas"));

        // A panel without notes is left untouched.
        let p2 = panels
            .get("p2")
            .unwrap()
            .get("params")
            .and_then(serde_json::Value::as_object)
            .unwrap();
        assert_eq!(p2.get("elementId").and_then(|v| v.as_str()), Some("other"));
    }

    /// A v2 migration also strips Phase-4 notes if they happen to
    /// be present (they would be in any project that opened in
    /// Phase 4–8). The migration cascades v2 → v3 → v4 logic in
    /// one step.
    #[test]
    fn parse_migrates_v2_strips_phase4_notes_too() {
        let v2 = r#"{
            "schema_version": 2,
            "layout": {
                "panels": {
                    "p1": {"params": {"notes": [{"id":"n","t":1.0,"label":"x"}]}}
                }
            },
            "elements": [],
            "dbc_paths": []
        }"#;
        let p = parse_project(v2).expect("v2 migrates");
        assert_eq!(p.schema_version, PROJECT_SCHEMA_VERSION);
        let p1 = p
            .layout
            .get("panels")
            .and_then(|v| v.get("p1"))
            .and_then(|v| v.get("params"))
            .and_then(serde_json::Value::as_object)
            .unwrap();
        assert!(!p1.contains_key("notes"));
    }

    /// `strip_plot_notes_from_layout` is safe to call on layouts
    /// without `panels` or with non-object panels — it's a pure
    /// best-effort scrub and shouldn't panic if a future schema
    /// reshapes the dockview blob.
    #[test]
    fn strip_plot_notes_tolerates_unexpected_shapes() {
        let mut v1: serde_json::Value = serde_json::json!({});
        strip_plot_notes_from_layout(&mut v1);
        let mut v2: serde_json::Value = serde_json::json!({ "panels": "not-an-object" });
        strip_plot_notes_from_layout(&mut v2);
        let mut v3: serde_json::Value =
            serde_json::json!({ "panels": { "p": { "params": "not-an-object" } } });
        strip_plot_notes_from_layout(&mut v3);
    }

    #[test]
    fn parse_migrates_a_v2_project_unscoping_every_dbc() {
        let v2 = r#"{
            "schema_version": 2,
            "layout": {"grid": {}, "panels": {}},
            "elements": [{"kind": "trace", "id": "x"}],
            "dbc_paths": ["/a.dbc", "/b.dbc"],
            "remote_address": "host:1234"
        }"#;
        let p = parse_project(v2).expect("v2 project migrates");
        assert_eq!(p.schema_version, PROJECT_SCHEMA_VERSION);
        // Migration default: every DBC unscoped.
        assert_eq!(
            p.dbcs,
            vec![
                DbcRef { path: "/a.dbc".into(), buses: Vec::new() },
                DbcRef { path: "/b.dbc".into(), buses: Vec::new() },
            ],
        );
        assert!(p.buses.is_empty());
        assert!(p.interface_bindings.is_empty());
        assert_eq!(p.remote_address.as_deref(), Some("host:1234"));
        assert_eq!(p.elements.len(), 1);
    }

    /// `open_project` itself takes a `tauri::AppHandle` (Phase 7
    /// system-log fanout), so the "missing file" path is exercised
    /// here against the underlying helper: a missing path yields a
    /// `std::io::Error` that the command then wraps with a
    /// user-facing prefix. The wrapping is trivial; this test guards
    /// the read step itself.
    #[test]
    fn missing_file_surfaces_as_an_io_error() {
        assert!(std::fs::read_to_string("/no/such/cannet-project.json").is_err());
    }
}
