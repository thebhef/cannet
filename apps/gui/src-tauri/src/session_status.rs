//! What the session holds, in one read — the question a frontend boot
//! asks first (ADR 0063).
//!
//! The frontend may be reloaded at any time without changing host or
//! project state. A boot therefore starts by asking [`session_status`]:
//! if the host already holds a project, the boot **rejoins** it — it
//! applies the working document, mirrors the trace windows, and reads
//! the session's other facts back from here and from the mirrors that
//! already hydrate themselves on mount — instead of opening the project
//! file again. Only a process launch, which holds nothing, takes the
//! fresh path.
//!
//! The facts here are the ones the frontend used to build up itself, from
//! the answers to commands it issued or from events it heard, and so
//! would lose on a reload: the working project
//! ([`crate::working_project`]), the buffer's count and origin (the
//! `trace-grew` picture, which a stopped capture never re-sends), the
//! connected sessions as their connects answered, the loaded DBC set,
//! whether a pyramid rebuild is still owed, and an import in flight.
//! Everything else a reload needs already has a mount-time read.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;
use crate::capture::ImportSource;
use crate::ipc::{DbcInfo, TraceGrew};
use crate::session::SessionJoin;
use crate::working_project::WorkingProjectStatus;

/// Everything [`session_status`] answers except the buffer picture,
/// which needs the running app to compute its bus load.
#[derive(Clone, Serialize)]
pub(crate) struct SessionHolds {
    /// Whether a project is held, its file, its working document and
    /// dirty flag.
    #[serde(flatten)]
    pub(crate) project: WorkingProjectStatus,
    /// Each connected session, as its connect answered and with the
    /// bindings it was connected with.
    pub(crate) sessions: Vec<SessionJoin>,
    /// The loaded DBC set, in priority order, with each one's bus
    /// scoping.
    pub(crate) dbcs: Vec<DbcInfo>,
    /// Whether the cold pyramid rebuild a restore forced is still owed
    /// (ADR 0047).
    pub(crate) pyramids_rebuilding: bool,
    /// The file an import pump is reading right now, if one is.
    pub(crate) importing: Option<ImportSource>,
}

/// [`session_status`]'s answer.
#[derive(Clone, Serialize)]
pub(crate) struct SessionStatus {
    #[serde(flatten)]
    pub(crate) holds: SessionHolds,
    /// The session buffer as a `trace-grew` would describe it now, with
    /// no tail.
    pub(crate) trace: TraceGrew,
}

/// Read every fact of [`SessionHolds`] off `state`.
pub(crate) fn holds(state: &AppState) -> SessionHolds {
    let path = state.watched_project().path_string();
    let mut sessions: Vec<SessionJoin> = state
        .remote_sessions()
        .values()
        .map(|s| s.joined.clone())
        .collect();
    // The map's order is a hash order; answer in a stable one.
    sessions.sort_by(|a, b| a.result.address.cmp(&b.result.address));
    SessionHolds {
        project: state.working_project.status(path),
        sessions,
        dbcs: crate::dbc_commands::dbc_list(state),
        pyramids_rebuilding: crate::capture::pyramids_rebuilding_now(state).rebuilding,
        importing: state.import_source().clone(),
    }
}

/// What the session holds — the boot's first question (ADR 0063).
///
/// `async` + [`off_async_workers`](crate::sampling::off_async_workers):
/// the buffer readout takes the trace store's lock, which a capture
/// restore holds for its swap (ADR 0048).
#[tauri::command]
pub(crate) async fn session_status(app: AppHandle) -> SessionStatus {
    crate::sampling::off_async_workers(move || {
        let state = app.state::<AppState>();
        let snap = state.trace_store.status_snapshot();
        let fps = snap.frames_per_second;
        let trace = crate::emitters::trace_grew_payload(&app, &state, snap, fps, Vec::new());
        SessionStatus {
            holds: holds(&state),
            trace,
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::test_state;
    use crate::working_project::WorkingDocument;

    fn project() -> crate::project::Project {
        crate::project::parse_project(&format!(
            r#"{{
                "schema_version": {v},
                "layout": {{"grid": {{}}, "panels": {{}}}},
                "elements": [{{"kind": "trace", "id": "e1"}}],
                "buses": [{{"id": "b1", "name": "Bus 1"}}],
                "transmit_frames": [],
                "math_signals": []
            }}"#,
            v = crate::project::PROJECT_SCHEMA_VERSION
        ))
        .expect("test project parses")
    }

    #[test]
    fn a_fresh_process_holds_nothing() {
        let h = holds(&test_state());
        assert!(!h.project.held);
        assert_eq!(h.project.document, None);
        assert!(h.sessions.is_empty());
        assert!(h.dbcs.is_empty());
        assert!(h.importing.is_none());
        assert!(!h.pyramids_rebuilding);
    }

    #[test]
    fn an_opened_project_is_held_clean_with_its_document() {
        let state = test_state();
        state.working_project.opened(&project());
        let h = holds(&state);
        assert!(h.project.held);
        assert!(!h.project.dirty);
        assert_eq!(h.project.document, Some(WorkingDocument::from(&project())));
    }

    #[test]
    fn a_closed_project_is_still_held_with_no_document() {
        let state = test_state();
        state.working_project.opened(&project());
        state.working_project.closed();
        let h = holds(&state);
        assert!(h.project.held, "New project is a project the session holds");
        assert_eq!(h.project.document, None);
    }

    #[test]
    fn a_push_is_answered_with_its_document_and_dirty_flag() {
        let state = test_state();
        state.working_project.opened(&project());
        let mut edited = WorkingDocument::from(&project());
        edited.buses[0].name = "Edited".into();
        state.working_project.push(edited.clone(), true);
        let h = holds(&state);
        assert!(h.project.dirty);
        assert_eq!(h.project.document, Some(edited));
    }

    #[test]
    fn a_connected_session_is_answered_as_its_connect_did() {
        let state = test_state();
        let mut session = crate::tests::seam_session_for_status();
        session.joined = SessionJoin {
            result: crate::ipc::RemoteSessionResult {
                address: "127.0.0.1:50051".into(),
                ..Default::default()
            },
            bindings: vec![crate::session::InterfaceBusBinding {
                interface: "pcan:1".into(),
                bus_id: "b1".into(),
                speed_bps: Some(500_000),
                fd: None,
                fd_data_speed_bps: None,
            }],
        };
        state
            .register_session("127.0.0.1:50051".into(), session)
            .unwrap();
        let h = holds(&state);
        assert_eq!(h.sessions.len(), 1);
        assert_eq!(h.sessions[0].result.address, "127.0.0.1:50051");
        assert_eq!(h.sessions[0].bindings[0].speed_bps, Some(500_000));
        let json = serde_json::to_value(&h).expect("serializes");
        assert_eq!(json["sessions"][0]["bindings"][0]["busId"], "b1");
        assert_eq!(json["held"], false, "the project fields are flattened");
    }

    #[test]
    fn an_import_in_flight_is_answered_with_its_file() {
        let state = test_state();
        *state.import_source() = Some(ImportSource::Mdf(crate::ipc::ImportMdfResult {
            mdf_path: "c.mf4".into(),
        }));
        let json = serde_json::to_value(holds(&state)).expect("serializes");
        assert_eq!(json["importing"]["mdf_path"], "c.mf4");
    }
}
