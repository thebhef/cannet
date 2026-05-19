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
pub const PROJECT_SCHEMA_VERSION: u32 = 4;

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
    /// User-chosen graph colour (`#rrggbb`). The host round-trips it
    /// without interpretation; the GUI falls back to a palette colour
    /// when it's absent.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
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
        4 => serde_json::from_value(raw).map_err(|e| format!("invalid project JSON: {e}")),
        3 => migrate_v3(raw),
        2 => migrate_v2(raw).map(|mut p| {
            strip_plot_notes_from_layout(&mut p.layout);
            p
        }),
        v => Err(format!(
            "schema version {v}; this build expects {PROJECT_SCHEMA_VERSION}",
        )),
    }
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
pub fn open_project(app: tauri::AppHandle, path: String) -> Result<Project, String> {
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
    path: String,
    project: Project,
) -> Result<(), String> {
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
                color: Some("#60a5fa".into()),
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
        let p = parse_project(r#"{"schema_version": 4, "layout": {"grid": {}, "panels": {}}}"#)
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
