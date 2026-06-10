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
//! [`PROJECT_SCHEMA_VERSION`] bumped 2 → 3. v2 files migrate on parse:
//! the new lists default empty and `dbc_paths` is lifted into
//! `dbcs[].path` with no scoping (= unscoped = "all buses").

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
pub const PROJECT_SCHEMA_VERSION: u32 = 3;

/// A logical bus. `id` is a stable, project-local identifier (graph
/// edges reference it; per-DBC scoping and the filter `bus` predicate
/// both compare against it). `name` is the user-facing label.
/// `speed_bps` / `fd` are optional hints used by the graph view and
/// (in Phase 8) by the hardware-sidecar bus-config flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bus {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub speed_bps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fd: Option<bool>,
}

/// An interface binding: a `(server, interface)` pair routed onto a
/// logical bus. `server` is an opaque key (the remote address for now;
/// vendor sidecars get their own prefix in Phase 8). `interface` is
/// the wire-level `Interface.id` from `ListInterfaces`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InterfaceBinding {
    pub server: String,
    pub interface: String,
    pub bus_id: String,
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
}

/// Parse project JSON. Accepts a v3 file verbatim and migrates a v2
/// file in-memory by lifting `dbc_paths` into `dbcs` (each unscoped)
/// and defaulting the Phase-6 buses / bindings lists to empty. v1 and
/// anything else are rejected with a user-facing message. Split from
/// [`open_project`] so the parse + migration is testable without
/// touching the filesystem.
fn parse_project(text: &str) -> Result<Project, String> {
    let raw: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("invalid project JSON: {e}"))?;
    let version = raw
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "missing schema_version".to_string())?;
    match version {
        3 => serde_json::from_value(raw).map_err(|e| format!("invalid project JSON: {e}")),
        2 => migrate_v2(raw),
        v => Err(format!(
            "schema version {v}; this build expects {PROJECT_SCHEMA_VERSION}",
        )),
    }
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

/// Read and parse a project file. Errors (with a user-facing message)
/// if it can't be read, isn't valid JSON, or has an unsupported schema
/// version. v2 files migrate on parse (see [`parse_project`]).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn open_project(path: String) -> Result<Project, String> {
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read project at {path}: {e}"))?;
    parse_project(&text).map_err(|e| format!("project at {path}: {e}"))
}

/// Serialize `project` (pretty-printed) and write it to `path`.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn save_project(path: String, project: Project) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(&project).map_err(|e| format!("failed to serialize project: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("failed to write project to {path}: {e}"))
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
            }],
            interface_bindings: vec![InterfaceBinding {
                server: "127.0.0.1:50051".into(),
                interface: "blf-channel-1".into(),
                bus_id: "p".into(),
            }],
            dbcs: vec![DbcRef {
                path: "/some/where/bus.dbc".into(),
                buses: vec!["p".into()],
            }],
            remote_address: Some("127.0.0.1:50051".into()),
        }
    }

    #[test]
    fn round_trips_through_the_serializer() {
        let p = sample();
        assert_eq!(parse_project(&serde_json::to_string_pretty(&p).unwrap()).unwrap(), p);
    }

    #[test]
    fn parse_defaults_the_optional_fields() {
        let p = parse_project(r#"{"schema_version": 3, "layout": {"grid": {}, "panels": {}}}"#)
            .unwrap();
        assert!(p.elements.is_empty());
        assert!(p.dbcs.is_empty());
        assert!(p.buses.is_empty());
        assert!(p.interface_bindings.is_empty());
        assert_eq!(p.remote_address, None);
    }

    #[test]
    fn parse_rejects_an_unsupported_schema_version() {
        // A future version, and the long-since-superseded v1.
        assert!(parse_project(r#"{"schema_version": 999, "layout": {}}"#).is_err());
        assert!(parse_project(r#"{"schema_version": 1, "layout": {}}"#).is_err());
        assert!(parse_project("not json").is_err());
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

    #[test]
    fn open_reports_a_missing_file() {
        assert!(open_project("/no/such/cannet-project.json".into()).is_err());
    }
}
