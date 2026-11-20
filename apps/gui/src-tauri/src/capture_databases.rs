//! A capture's own databases, kept with the capture's scratch.
//!
//! An MF4 can carry the databases it was recorded against. An import
//! loads them into the session and assigns them to buses, but they are
//! no part of a project file — so a relaunch that restores the capture
//! from its scratch (ADR 0002 DS-7) would bring the frames back with
//! nothing to decode them. This module is what brings the databases back
//! with them: their bytes and their bus assignments are written beside
//! the capture, and reinstalled when that capture is restored.
//!
//! What is written is stamped with the capture's identity and only read
//! back against the same one, so a scratch that has since taken a
//! different capture restores without them. The files live in the
//! session's cache directory, where the capture's other derived state
//! already is; nothing is written beside a user's file
//! ([ADR 0010](../../../docs/adr/0010-no-sidecar-files.md)).

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::app_state::{AppState, EmbeddedDbcSource, LoadedDbc};
use crate::trace_store::{read_json, write_json};

/// Directory, under the scratch, holding the capture's databases.
const DIR: &str = "capture-databases";
/// The list of them, in load order.
const INDEX_FILE: &str = "index.json";

#[derive(Serialize, Deserialize)]
struct Index {
    /// The capture these databases arrived with.
    capture_id: Uuid,
    databases: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    /// What the database is loaded under: `<capture>#<attachment name>`.
    identity: String,
    file_name: String,
    buses: Vec<String>,
    /// The file in [`DIR`] holding its bytes.
    file: String,
}

/// One database read back, ready to install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stored {
    pub(crate) identity: String,
    pub(crate) source: EmbeddedDbcSource,
    pub(crate) buses: Vec<String>,
}

/// Write `capture_id`'s databases — the entries of `loaded` a capture
/// carries — under `scratch`, replacing whatever was there. With none to
/// write, what was there is removed.
pub(crate) fn write(scratch: &Path, capture_id: Uuid, loaded: &[LoadedDbc]) -> std::io::Result<()> {
    let dir = scratch.join(DIR);
    let _ = std::fs::remove_dir_all(&dir);
    let own: Vec<(&LoadedDbc, &EmbeddedDbcSource)> = loaded
        .iter()
        .filter_map(|db| Some((db, db.embedded.as_ref()?)))
        .collect();
    if own.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir)?;
    let mut databases = Vec::with_capacity(own.len());
    for (i, (db, source)) in own.iter().enumerate() {
        // Numbered, not named: an attachment's name is whatever its
        // writer chose, and need not be a file name here.
        let file = format!("{i}.dbc");
        std::fs::write(dir.join(&file), &source.data)?;
        databases.push(Entry {
            identity: db.path.clone(),
            file_name: source.file_name.clone(),
            buses: db.buses.clone(),
            file,
        });
    }
    write_json(
        &dir.join(INDEX_FILE),
        &Index {
            capture_id,
            databases,
        },
    )
}

/// The databases written under `scratch` for `capture_id`, in the order
/// they were loaded. Empty when there are none, when what is there is
/// another capture's, or when a file it names cannot be read.
pub(crate) fn read(scratch: &Path, capture_id: Uuid) -> Vec<Stored> {
    let dir = scratch.join(DIR);
    let Some(index) = read_json::<Index>(&dir.join(INDEX_FILE)) else {
        return Vec::new();
    };
    if index.capture_id != capture_id {
        return Vec::new();
    }
    index
        .databases
        .into_iter()
        .filter_map(|entry| {
            let data = std::fs::read(dir.join(&entry.file)).ok()?;
            Some(Stored {
                identity: entry.identity,
                source: EmbeddedDbcSource {
                    file_name: entry.file_name,
                    data: Arc::from(data),
                },
                buses: entry.buses,
            })
        })
        .collect()
}

/// Write the session's capture databases beside the capture it holds.
/// A no-op with no scratch on disk, or no identified capture in it —
/// there is then nothing a restore could bring them back with.
///
/// Called where a capture database arrives or its assignment changes:
/// the end of an import, a bus assignment, a removal. **Not** when the
/// whole set is cleared for a project open — that clear comes before the
/// capture is restored, and writing then would erase what the restore is
/// about to read.
pub(crate) fn persist(state: &AppState) {
    let Some(scratch) = state.trace_store.scratch_dir() else {
        return;
    };
    let Some(capture_id) = state.trace_store.scratch_capture_id() else {
        return;
    };
    let result = write(&scratch, capture_id, &state.databases());
    if let Err(e) = result {
        tracing::warn!(error = %e, "could not write the capture's databases to its scratch");
    }
}

/// Put `stored` back into the loaded set, each under its identity with
/// the buses it was assigned to. Returns the identities installed; one
/// that no longer parses is left out.
pub(crate) fn install(state: &AppState, stored: Vec<Stored>) -> Vec<String> {
    let mut installed = Vec::new();
    for db in stored {
        let text = String::from_utf8_lossy(&db.source.data).into_owned();
        if crate::dbc_commands::install_dbc(state, &db.identity, &text).is_err() {
            continue;
        }
        if let Some(slot) = state.databases().iter_mut().find(|d| d.path == db.identity) {
            slot.embedded = Some(db.source);
            slot.buses = db.buses;
        }
        installed.push(db.identity);
    }
    if !installed.is_empty() {
        // The assignments just set change what the set decodes.
        crate::app_state::invalidate_derived_caches(state);
    }
    installed
}

/// Reinstall the databases the restored capture arrived with. Returns
/// the identities installed.
pub(crate) fn restore(state: &AppState) -> Vec<String> {
    let Some(scratch) = state.trace_store.scratch_dir() else {
        return Vec::new();
    };
    let Some(capture_id) = state.trace_store.scratch_capture_id() else {
        return Vec::new();
    };
    install(state, read(&scratch, capture_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{test_state, tiny_dbc};

    fn attachment(name: &str, signal: &str) -> cannet_mdf::MdfAttachment {
        cannet_mdf::MdfAttachment {
            file_name: name.into(),
            mime_type: "application/vnd.vector.dbc".into(),
            data: tiny_dbc(0x1a5, "EngineData", signal).into_bytes(),
        }
    }

    /// A session with two capture databases, one assigned, and a
    /// project database on disk beside them.
    fn session() -> AppState {
        let state = test_state();
        state.databases().push(crate::tests::loaded(
            "C:/dbc/project.dbc",
            &tiny_dbc(0x10, "M", "S"),
        ));
        crate::capture::install_embedded_databases(
            &state,
            "run.mf4",
            &[
                attachment("powertrain.dbc", "EngineSpeed"),
                attachment("body.dbc", "DoorOpen"),
            ],
            Some(&[crate::capture::DatabaseBusAssignment {
                file_name: "body.dbc".into(),
                buses: vec!["chassis".into()],
            }]),
        );
        state
    }

    #[test]
    fn a_capture_s_databases_come_back_with_their_buses_and_bytes() {
        let scratch = tempfile::tempdir().unwrap();
        let capture = Uuid::new_v4();
        let before = session();
        write(scratch.path(), capture, &before.databases()).unwrap();

        // A fresh session — the project's own database is its to load.
        let after = test_state();
        let installed = install(&after, read(scratch.path(), capture));
        assert_eq!(
            installed,
            vec!["run.mf4#powertrain.dbc", "run.mf4#body.dbc"]
        );

        let list = after.databases();
        assert_eq!(list.len(), 2, "the project's database is not the capture's");
        assert!(list[0].buses.is_empty());
        assert_eq!(list[1].buses, vec!["chassis"]);
        let original = before.databases();
        assert_eq!(list[1].embedded, original[2].embedded);
        assert_eq!(
            list[1].db.signals().first().map(|s| s.signal_name.clone()),
            Some("DoorOpen".to_string())
        );
    }

    #[test]
    fn another_capture_s_databases_are_not_this_one_s() {
        let scratch = tempfile::tempdir().unwrap();
        write(scratch.path(), Uuid::new_v4(), &session().databases()).unwrap();
        assert!(read(scratch.path(), Uuid::new_v4()).is_empty());
    }

    #[test]
    fn writing_none_removes_what_was_written() {
        let scratch = tempfile::tempdir().unwrap();
        let capture = Uuid::new_v4();
        write(scratch.path(), capture, &session().databases()).unwrap();
        // Every capture database removed; only the project's is left.
        let state = test_state();
        state.databases().push(crate::tests::loaded(
            "C:/dbc/project.dbc",
            &tiny_dbc(0x10, "M", "S"),
        ));
        write(scratch.path(), capture, &state.databases()).unwrap();
        assert!(read(scratch.path(), capture).is_empty());
        assert!(!scratch.path().join(DIR).exists());
    }
}
