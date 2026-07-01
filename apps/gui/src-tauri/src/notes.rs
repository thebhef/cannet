//! Session-buffer notes — the host home for the plot panel's
//! event-marker annotations. A note is the first kind in the
//! timeline-event model (ADR 0035); this store is its seed.
//!
//! Notes are not owned by individual plot panels — a note placed
//! over a timeline must be visible in every panel over that same
//! timeline. They live in a single
//! session-scoped list, edited through Tauri commands, observed by
//! every plot panel via `notes-changed` IPC events. The session
//! buffer (the trace store) is the source of truth for the data; a
//! note is a labelled point on that timeline, so it belongs in the
//! same scope.
//!
//! On Save Capture the notes ride inside the BLF as `GLOBAL_MARKER`
//! (object type 96) records — no sidecar file (ADR 0010); see
//! `BlfCaptureWriter::append_marker` in `cannet-blf`. On Open
//! Capture the host pre-walks the BLF for markers and replaces
//! this store with what it found. The wire shape between the host
//! and the frontend is `{ id, timestamp_ns, label }` per note, so
//! the path from a plot click to a saved BLF is direct.
//!
//! Notes also ride the disk-spill scratch (ADR 0002 DS-7): a store built
//! with [`NotesStore::with_scratch`] writes `current/notes.json` on **every
//! edit** — not on the frame-flush cadence, since a user can add a marker to
//! a stopped, reloaded trace with no ingest underway — and the host restores
//! it when a prior session reopens through the manifest gate, so a
//! crash-or-reopen brings the events back without a BLF round-trip. This is
//! the durable-kind scratch persistence of the timeline-event model
//! (ADR 0035); the BLF path stays the export/import home.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::trace_store::{read_json, write_json};

/// File in the scratch dir holding this session's notes (ADR 0002 DS-7).
/// Written by the host on the flush cadence, restored on reopen, wiped on
/// Clear / new capture — the scratch's own copy of the durable-kind
/// events; the BLF is the export/import home.
pub const SCRATCH_NOTES_FILE: &str = "notes.json";

/// One note: a stable id, the absolute timestamp on the trace
/// timeline (nanoseconds — the same `RawTraceFrame::timestamp_ns`
/// the rest of the trace store uses), and the user-visible label.
///
/// `rename_all = "camelCase"` because this struct crosses the
/// Tauri wire: `add_note` deserialises it from JS, and
/// `fetch_notes` / the `notes-changed` event serialise it back.
/// Tauri only auto-camelCases top-level command arg names, not
/// nested struct fields — those have to opt in here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// Frontend-stable id (the `+ note` cursor mints a UUID before
    /// dispatching `add_note`). Used by the plot panel's event
    /// list for `rename`/`remove`, and by the migration in
    /// `project.rs` to keep ids stable across reloads.
    pub id: String,
    /// Absolute timestamp on the trace timeline, in nanoseconds.
    /// Matches `RawTraceFrame::timestamp_ns`.
    pub timestamp_ns: u64,
    /// User-visible label. Defaults to "note N" on creation;
    /// editable.
    pub label: String,
}

/// The session-scoped notes store. Single `Mutex`-guarded vec —
/// edits are rare (one per user click) and the snapshot path is
/// what every plot panel hits each render, so a Mutex over a Vec
/// is fine. Sorted by `timestamp_ns` so a snapshot is already in
/// chronological order for the event list.
pub struct NotesStore {
    inner: Mutex<Vec<Note>>,
    /// Scratch dir for durable-kind persistence (ADR 0002 DS-7), or `None`
    /// for the in-RAM test double. When set, every edit rewrites
    /// [`SCRATCH_NOTES_FILE`] under it.
    scratch_dir: Option<PathBuf>,
}

/// What [`NotesStore::apply`] returns so the host can decide
/// whether to emit a `notes-changed` event. `None` means the
/// requested edit was a no-op (e.g. removing an unknown id) and
/// no event needs to fire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    /// Snapshot **after** the edit, in chronological order.
    pub notes: Vec<Note>,
}

impl Default for NotesStore {
    fn default() -> Self {
        Self::new()
    }
}

impl NotesStore {
    /// Empty store with no scratch persistence — the test double.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Vec::new()),
            scratch_dir: None,
        }
    }

    /// Empty store that persists every mutation into `dir` as
    /// [`SCRATCH_NOTES_FILE`] (ADR 0002 DS-7 / ADR 0035) — the production
    /// path. Persistence rides each edit rather than the frame-flush
    /// cadence, so a marker added to a stopped, reloaded trace still reaches
    /// the scratch.
    pub fn with_scratch(dir: PathBuf) -> Self {
        Self {
            inner: Mutex::new(Vec::new()),
            scratch_dir: Some(dir),
        }
    }

    /// Chronological snapshot of the current notes — what the
    /// plot panel's IPC bootstrap reads, and what
    /// `notes-changed` events carry.
    pub fn snapshot(&self) -> Vec<Note> {
        self.inner.lock().expect("notes mutex poisoned").clone()
    }

    /// Rewrite the scratch copy from the current notes, via atomic
    /// temp-file + rename. Called after every mutation; a no-op without a
    /// scratch dir. A write failure is logged, not propagated — a dropped
    /// scratch write is a durability gap, not a reason to fail the edit.
    fn persist(&self) {
        let Some(dir) = self.scratch_dir.clone() else {
            return;
        };
        let notes = self.snapshot();
        if let Err(e) = write_json(&dir.join(SCRATCH_NOTES_FILE), &notes) {
            tracing::warn!(error = %e, "writing scratch notes failed");
        }
    }

    /// Add a note. Returns `None` if a note with the same `id`
    /// already exists (the call was a duplicate — the rate
    /// limiter or a missed event from the frontend), `Some`
    /// otherwise. The store enforces chronological order on
    /// `timestamp_ns`.
    pub fn add(&self, note: Note) -> Option<Applied> {
        let applied = {
            let mut guard = self.inner.lock().expect("notes mutex poisoned");
            if guard.iter().any(|n| n.id == note.id) {
                return None;
            }
            // Insertion sort — `Vec` of typically <100 entries.
            let pos = guard
                .iter()
                .position(|n| n.timestamp_ns > note.timestamp_ns)
                .unwrap_or(guard.len());
            guard.insert(pos, note);
            Applied {
                notes: guard.clone(),
            }
        };
        self.persist();
        Some(applied)
    }

    /// Rename a note. `None` if `id` is unknown.
    pub fn rename(&self, id: &str, label: impl Into<String>) -> Option<Applied> {
        let applied = {
            let mut guard = self.inner.lock().expect("notes mutex poisoned");
            let slot = guard.iter_mut().find(|n| n.id == id)?;
            slot.label = label.into();
            Applied {
                notes: guard.clone(),
            }
        };
        self.persist();
        Some(applied)
    }

    /// Remove a note. `None` if `id` is unknown.
    pub fn remove(&self, id: &str) -> Option<Applied> {
        let applied = {
            let mut guard = self.inner.lock().expect("notes mutex poisoned");
            let before = guard.len();
            guard.retain(|n| n.id != id);
            if guard.len() == before {
                return None;
            }
            Applied {
                notes: guard.clone(),
            }
        };
        self.persist();
        Some(applied)
    }

    /// Drop every note. Emits `Some` only if there was anything
    /// to drop — caller can skip the event otherwise.
    pub fn clear(&self) -> Option<Applied> {
        {
            let mut guard = self.inner.lock().expect("notes mutex poisoned");
            if guard.is_empty() {
                return None;
            }
            guard.clear();
        }
        self.persist();
        Some(Applied { notes: Vec::new() })
    }

    /// Replace the store's contents with `notes`. Used by Open
    /// Capture and project-open migration. Always emits `Some` so
    /// the change is observable.
    pub fn replace(&self, mut notes: Vec<Note>) -> Applied {
        notes.sort_by_key(|n| n.timestamp_ns);
        let applied = {
            let mut guard = self.inner.lock().expect("notes mutex poisoned");
            *guard = notes;
            Applied {
                notes: guard.clone(),
            }
        };
        self.persist();
        applied
    }

    /// Restore notes from this store's scratch [`SCRATCH_NOTES_FILE`],
    /// replacing the store's contents, and return the restored notes so the
    /// host can emit a `notes-changed`. `None` when there is no scratch dir
    /// or no file (a clean miss) — the store is left untouched.
    pub fn restore(&self) -> Option<Vec<Note>> {
        let dir = self.scratch_dir.clone()?;
        let notes: Vec<Note> = read_json(&dir.join(SCRATCH_NOTES_FILE))?;
        self.replace(notes.clone());
        Some(notes)
    }

    /// Remove the scratch copy of notes (ADR 0002 DS-7) so a Clear / new
    /// capture leaves no stale events for a later reopen to restore. The
    /// live store is cleared / replaced separately by the caller; a no-op
    /// without a scratch dir.
    pub fn wipe_scratch(&self) {
        if let Some(dir) = &self.scratch_dir {
            let _ = std::fs::remove_file(dir.join(SCRATCH_NOTES_FILE));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, ts: u64, label: &str) -> Note {
        Note {
            id: id.into(),
            timestamp_ns: ts,
            label: label.into(),
        }
    }

    #[test]
    fn add_keeps_chronological_order() {
        let s = NotesStore::new();
        let _ = s.add(note("b", 2_000, "two")).unwrap();
        let _ = s.add(note("a", 1_000, "one")).unwrap();
        let _ = s.add(note("c", 3_000, "three")).unwrap();
        let snap = s.snapshot();
        assert_eq!(
            snap.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"],
        );
    }

    #[test]
    fn duplicate_id_is_a_noop() {
        let s = NotesStore::new();
        s.add(note("a", 1_000, "one")).unwrap();
        // Same id, different timestamp — duplicate => None.
        assert!(s.add(note("a", 9_000, "again")).is_none());
        assert_eq!(s.snapshot().len(), 1);
    }

    #[test]
    fn rename_updates_label_only() {
        let s = NotesStore::new();
        s.add(note("a", 1_000, "old")).unwrap();
        let applied = s.rename("a", "new").unwrap();
        assert_eq!(applied.notes[0].label, "new");
        // Unknown id is a no-op (returns None).
        assert!(s.rename("missing", "x").is_none());
    }

    #[test]
    fn remove_drops_matching_id() {
        let s = NotesStore::new();
        s.add(note("a", 1_000, "one")).unwrap();
        s.add(note("b", 2_000, "two")).unwrap();
        let applied = s.remove("a").unwrap();
        assert_eq!(applied.notes.len(), 1);
        assert_eq!(applied.notes[0].id, "b");
        // Removing again is a no-op.
        assert!(s.remove("a").is_none());
    }

    #[test]
    fn clear_returns_none_when_empty() {
        let s = NotesStore::new();
        assert!(s.clear().is_none());
        s.add(note("a", 1_000, "one")).unwrap();
        assert!(s.clear().is_some());
        assert!(s.snapshot().is_empty());
    }

    /// Tauri only camelCases top-level command arg names — nested
    /// struct fields obey the struct's own serde config. The TS
    /// side (`apps/gui/src/notes.ts`) and the `add_note` invoke in
    /// `App.tsx` both speak `timestampNs`, so the struct must
    /// serialise/deserialise with that key. Regression guard for
    /// the silent-deserialise-failure that broke `add_note` end to
    /// end.
    #[test]
    fn note_uses_camel_case_on_the_wire() {
        let n = note("a", 1_700_000_000_000_000_000, "first");
        let v = serde_json::to_value(&n).unwrap();
        assert_eq!(v["timestampNs"], 1_700_000_000_000_000_000_u64);
        assert!(
            v.get("timestamp_ns").is_none(),
            "snake_case must not leak: {v}"
        );

        let parsed: Note =
            serde_json::from_str(r#"{"id":"a","timestampNs":1700000000000000000,"label":"first"}"#)
                .unwrap();
        assert_eq!(parsed, n);
    }

    #[test]
    fn mutations_persist_to_scratch_with_no_frame_activity() {
        let dir = tempfile::tempdir().unwrap();
        let live = NotesStore::with_scratch(dir.path().to_path_buf());
        // No frames, no flush cadence — manual edits on a stopped trace must
        // still reach the scratch (ADR 0002 DS-7 / ADR 0035).
        live.add(note("a", 1_000, "one")).unwrap();
        live.add(note("b", 2_000, "two")).unwrap();

        // A reopened session restores both notes — no BLF round-trip.
        let reopened = NotesStore::with_scratch(dir.path().to_path_buf());
        assert_eq!(
            reopened.restore().expect("notes.json present"),
            live.snapshot(),
        );

        // An edit on the stopped store persists too: remove one, reopen,
        // gone.
        live.remove("a").unwrap();
        let after_edit = NotesStore::with_scratch(dir.path().to_path_buf());
        assert_eq!(
            after_edit.restore().expect("notes.json present"),
            vec![note("b", 2_000, "two")],
        );

        // Clear / new capture wipes the scratch copy, so a later reload
        // misses and leaves the store untouched.
        live.wipe_scratch();
        let after_wipe = NotesStore::with_scratch(dir.path().to_path_buf());
        assert!(after_wipe.restore().is_none());
        assert!(after_wipe.snapshot().is_empty());
    }

    #[test]
    fn replace_sorts_input() {
        let s = NotesStore::new();
        let applied = s.replace(vec![
            note("c", 3_000, "three"),
            note("a", 1_000, "one"),
            note("b", 2_000, "two"),
        ]);
        assert_eq!(
            applied
                .notes
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b", "c"],
        );
    }
}
