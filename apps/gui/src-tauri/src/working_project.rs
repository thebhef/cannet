//! The **working project**: the open project as the user has it right
//! now, saved or not — what Save would write — and whether it has
//! unsaved changes.
//!
//! Host state so the frontend can be torn down and rebuilt without the
//! project reverting to its file: the frontend pushes its half of the
//! document ([`set_working_project`]) on every project edit, debounced,
//! the way it already pushes the working layout (ADR 0032), and a
//! reloaded frontend reads it back through
//! [`crate::session_status::session_status`] (ADR 0063).
//!
//! **Session-scoped and in memory only**, like the RBS Run flag
//! (ADR 0028) and the trace windows ([`crate::trace_windows`]). Nothing
//! here reaches the disk: the project file changes only on Save, as it
//! always has, and the disk watch's "changed on disk" comparison
//! ([`crate::project_watch`], ADR 0053 §1) keeps comparing against the
//! text last read from or written to the file, never against this.
//!
//! **The document is the frontend-owned half only.** The pieces the host
//! already holds as registries — the transmit pool, math signals,
//! per-signal database picks and signal units — are snapshotted into the
//! file by `save_project` from those registries, and stay there as their
//! single source; carrying a second copy here would give two answers
//! that can disagree. Layout and elements stay opaque blobs (ADR 0011).
//!
//! The open file's path is not stored here either: the disk watch's
//! record already knows it (set on open and on every save, forgotten on
//! close), so [`crate::session_status`] reads it from there.
//!
//! Undo history is not carried (ADR 0058's stacks stay in the frontend).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::project::{Bus, DbcRef, InterfaceBinding, LocalVirtualBusDef, Project};

/// The frontend-owned fields of a project, in the project file's own
/// shape and path form (DBC and `.cannet_rbs` references relative to the
/// project file where the file would store them so, ADR 0030).
///
/// Deserialized from the frontend's save payload, which also carries
/// `schema_version` and `remote_address`; those are ignored — the
/// version is the build's, and the address is no longer a project field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct WorkingDocument {
    /// The `dockview` panel layout, verbatim (opaque to the host).
    pub(crate) layout: serde_json::Value,
    /// The project's elements, each an opaque `{kind, id, …}` record.
    #[serde(default)]
    pub(crate) elements: Vec<serde_json::Value>,
    #[serde(default)]
    pub(crate) buses: Vec<Bus>,
    #[serde(default)]
    pub(crate) interface_bindings: Vec<InterfaceBinding>,
    #[serde(default)]
    pub(crate) dbcs: Vec<DbcRef>,
    #[serde(default)]
    pub(crate) local_virtual_buses: Vec<LocalVirtualBusDef>,
    #[serde(default)]
    pub(crate) signal_colors: HashMap<String, String>,
}

impl From<&Project> for WorkingDocument {
    fn from(p: &Project) -> Self {
        Self {
            layout: p.layout.clone(),
            elements: p.elements.clone(),
            buses: p.buses.clone(),
            interface_bindings: p.interface_bindings.clone(),
            dbcs: p.dbcs.clone(),
            local_virtual_buses: p.local_virtual_buses.clone(),
            signal_colors: p.signal_colors.clone(),
        }
    }
}

/// What the host holds of the project, as
/// [`crate::session_status::session_status`] answers it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct WorkingProjectStatus {
    /// Whether the session holds a project at all. `false` only before
    /// the first open, New project or push of this process.
    pub(crate) held: bool,
    /// The file the project was opened from or last saved to; `None`
    /// for a project never saved.
    pub(crate) path: Option<String>,
    /// The working document; `None` for a project held but not yet
    /// pushed (a New project the frontend has not reported).
    pub(crate) document: Option<WorkingDocument>,
    /// Whether the working document has changes the file lacks.
    pub(crate) dirty: bool,
}

#[derive(Debug, Default)]
struct Slot {
    held: bool,
    document: Option<WorkingDocument>,
    dirty: bool,
}

/// The working project, behind its lock. Every method is a memory swap;
/// none touches the disk.
#[derive(Debug, Default)]
pub(crate) struct WorkingProject {
    inner: Mutex<Slot>,
}

impl WorkingProject {
    /// A project was opened: the working document is the file just
    /// parsed, with no unsaved changes.
    pub(crate) fn opened(&self, project: &Project) {
        *self.lock() = Slot {
            held: true,
            document: Some(WorkingDocument::from(project)),
            dirty: false,
        };
    }

    /// The project was closed for a New one: an unsaved project, nothing
    /// pushed yet.
    pub(crate) fn closed(&self) {
        *self.lock() = Slot {
            held: true,
            document: None,
            dirty: false,
        };
    }

    /// The frontend's push: the document and dirty flag replace what was
    /// held.
    pub(crate) fn push(&self, document: WorkingDocument, dirty: bool) {
        *self.lock() = Slot {
            held: true,
            document: Some(document),
            dirty,
        };
    }

    /// The project was written to its file: nothing is unsaved.
    pub(crate) fn saved(&self) {
        self.lock().dirty = false;
    }

    /// What is held, with `path` (the open file, which the disk watch
    /// records) alongside.
    pub(crate) fn status(&self, path: Option<String>) -> WorkingProjectStatus {
        let held = self.lock();
        WorkingProjectStatus {
            held: held.held,
            path,
            document: held.document.clone(),
            dirty: held.dirty,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The frontend's push of the working document and its dirty flag, sent
/// debounced after a project edit — never per frame. A memory swap, so
/// it stays on the IPC thread (ADR 0048).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn set_working_project(
    state: tauri::State<'_, AppState>,
    document: WorkingDocument,
    dirty: bool,
) {
    state.working_project.push(document, dirty);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(bus_name: &str) -> Project {
        crate::project::parse_project(&format!(
            r##"{{
                "schema_version": {v},
                "layout": {{"grid": {{}}, "panels": {{}}}},
                "elements": [{{"kind": "trace", "id": "e1"}}],
                "buses": [{{"id": "b1", "name": "{bus_name}"}}],
                "dbcs": [{{"path": "a.dbc", "buses": ["b1"]}}],
                "signal_colors": {{"k": "#112233"}},
                "transmit_frames": [],
                "math_signals": []
            }}"##,
            v = crate::project::PROJECT_SCHEMA_VERSION
        ))
        .expect("test project parses")
    }

    #[test]
    fn a_fresh_process_holds_nothing() {
        let w = WorkingProject::default();
        let s = w.status(None);
        assert!(!s.held);
        assert_eq!(s.document, None);
        assert!(!s.dirty);
    }

    #[test]
    fn open_seeds_the_document_from_the_file_not_dirty() {
        let w = WorkingProject::default();
        w.push(WorkingDocument::from(&project("old")), true);
        let p = project("Opened");
        w.opened(&p);
        let s = w.status(Some("C:/p.cannet_prj".into()));
        assert!(s.held);
        assert!(!s.dirty);
        assert_eq!(s.path.as_deref(), Some("C:/p.cannet_prj"));
        let doc = s.document.expect("seeded");
        assert_eq!(doc, WorkingDocument::from(&p));
        assert_eq!(doc.buses[0].name, "Opened");
    }

    #[test]
    fn close_resets_to_an_unsaved_project_with_nothing_pushed() {
        let w = WorkingProject::default();
        w.opened(&project("x"));
        w.push(WorkingDocument::from(&project("y")), true);
        w.closed();
        let s = w.status(None);
        assert!(s.held);
        assert_eq!(s.document, None);
        assert!(!s.dirty);
    }

    #[test]
    fn a_push_replaces_the_document_and_the_dirty_flag() {
        let w = WorkingProject::default();
        w.opened(&project("x"));
        let edited = WorkingDocument::from(&project("Edited"));
        w.push(edited.clone(), true);
        let s = w.status(None);
        assert_eq!(s.document, Some(edited));
        assert!(s.dirty);
        // A push of an unsaved never-opened project is held too.
        let fresh = WorkingProject::default();
        fresh.push(WorkingDocument::from(&project("New")), false);
        assert!(fresh.status(None).held);
    }

    #[test]
    fn save_clears_dirty_and_keeps_the_document() {
        let w = WorkingProject::default();
        let edited = WorkingDocument::from(&project("Edited"));
        w.push(edited.clone(), true);
        w.saved();
        let s = w.status(Some("C:/saved.cannet_prj".into()));
        assert!(!s.dirty);
        assert_eq!(s.document, Some(edited));
        assert_eq!(s.path.as_deref(), Some("C:/saved.cannet_prj"));
    }

    /// The frontend pushes its save payload, which carries
    /// `schema_version` and a null `remote_address` and none of the
    /// host-registry fields; the document keeps exactly the
    /// frontend-owned ones.
    #[test]
    fn deserializes_the_frontend_save_payload_and_carries_only_its_fields() {
        let doc: WorkingDocument = serde_json::from_str(
            r#"{
                "schema_version": 7,
                "layout": {"grid": {}, "panels": {}},
                "elements": [{"kind": "plot", "id": "p1"}],
                "buses": [{"id": "b1", "name": "Bus 1"}],
                "interface_bindings": [],
                "dbcs": [],
                "remote_address": null,
                "local_virtual_buses": [],
                "signal_colors": {}
            }"#,
        )
        .expect("payload parses");
        assert_eq!(doc.elements.len(), 1);
        let keys: Vec<String> = serde_json::to_value(&doc)
            .expect("serializes")
            .as_object()
            .expect("object")
            .keys()
            .cloned()
            .collect();
        let mut keys = keys;
        keys.sort();
        assert_eq!(
            keys,
            [
                "buses",
                "dbcs",
                "elements",
                "interface_bindings",
                "layout",
                "local_virtual_buses",
                "signal_colors",
            ]
        );
    }
}
