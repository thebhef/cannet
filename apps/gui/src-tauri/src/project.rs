//! Project files: the saved workspace, as a JSON document, read and
//! written by the [`open_project`] / [`save_project`] commands.
//!
//! The host owns the project model. The two fields it *doesn't*
//! interpret are `layout` (`dockview`'s serialized layout blob) and
//! `elements` (the project's elements — traces now, plots / transmit
//! messages later — each an opaque `{kind, id, …}` record the frontend
//! defines); the host just round-trips both.
//!
//! Carries today: the panel layout, the project elements, the attached
//! DBC path, and the remote-server address. Later steps add the bus
//! subscription set, multiple DBCs, and EDS references — bumping
//! [`PROJECT_SCHEMA_VERSION`] only if a change is *incompatible*
//! (adding optional fields isn't).

use serde::{Deserialize, Serialize};

/// Current project-file schema version. Bumped if the shape changes
/// incompatibly so a stale file is rejected rather than misread.
pub const PROJECT_SCHEMA_VERSION: u32 = 1;

/// A saved workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    /// Schema version — see [`PROJECT_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// The `dockview` panel layout, verbatim. The host doesn't read
    /// this; it's the frontend's serialized layout.
    pub layout: serde_json::Value,
    /// The project's elements — traces (and later plots, transmit
    /// messages, …), each an opaque `{kind, id, …}` record. The host
    /// doesn't read these either; the frontend owns the shape.
    #[serde(default)]
    pub elements: Vec<serde_json::Value>,
    /// Path to the attached DBC, if any — a reference, not an embedded
    /// copy, re-read from disk on open (or via the panel's "reload"
    /// action).
    #[serde(default)]
    pub dbc_path: Option<String>,
    /// Remote `cannet-server` address (`host:port`), if the project
    /// connects to one.
    #[serde(default)]
    pub remote_address: Option<String>,
}

/// Parse project JSON, rejecting an unsupported schema version. Split
/// from [`open_project`] so the parse + version check is testable
/// without touching the filesystem.
fn parse_project(text: &str) -> Result<Project, String> {
    let project: Project =
        serde_json::from_str(text).map_err(|e| format!("invalid project JSON: {e}"))?;
    if project.schema_version != PROJECT_SCHEMA_VERSION {
        return Err(format!(
            "schema version {}; this build expects {PROJECT_SCHEMA_VERSION}",
            project.schema_version,
        ));
    }
    Ok(project)
}

/// Read and parse a project file. Errors (with a user-facing message)
/// if it can't be read, isn't valid JSON, or has an unsupported schema
/// version.
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
            elements: vec![serde_json::json!({ "kind": "trace", "id": "abc", "view": "chronological" })],
            dbc_path: Some("/some/where/bus.dbc".into()),
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
        let p = parse_project(r#"{"schema_version": 1, "layout": {"grid": {}, "panels": {}}}"#)
            .unwrap();
        assert!(p.elements.is_empty());
        assert_eq!(p.dbc_path, None);
        assert_eq!(p.remote_address, None);
    }

    #[test]
    fn parse_rejects_an_unsupported_schema_version() {
        assert!(parse_project(r#"{"schema_version": 999, "layout": {}}"#).is_err());
        assert!(parse_project("not json").is_err());
    }

    #[test]
    fn open_reports_a_missing_file() {
        assert!(open_project("/no/such/cannet-project.json".into()).is_err());
    }
}
