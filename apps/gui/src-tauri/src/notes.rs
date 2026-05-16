//! Session-buffer notes — the Phase-9 home for the plot panel's
//! event-marker annotations.
//!
//! Phase 4 put notes in each plot panel's dockview `params`, which
//! meant a note placed in panel A wasn't visible in panel B even
//! over the same timeline. Phase 9 lifts them out: a single
//! session-scoped list, edited through Tauri commands, observed by
//! every plot panel via `notes-changed` IPC events. The session
//! buffer (the trace store) is the source of truth for the data; a
//! note is a labelled point on that timeline, so it belongs in the
//! same scope.
//!
//! On Save Capture the notes ride beside the BLF as a
//! `<file>.blf.notes.json` sidecar (a deliberate Phase-9 deferral
//! pending upstream `blf_asc` `GLOBAL_MARKER` support; see
//! `plans/technology-inventory.md`). On Open Capture the host
//! reads the sidecar (if present) into this store. The wire shape
//! between the host and the frontend (and between the host and the
//! sidecar file) is the same — `{ id, timestamp_ns, label }` per
//! note — so the path from a plot click to a saved BLF is direct.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One note: a stable id, the absolute timestamp on the trace
/// timeline (nanoseconds — the same `RawTraceFrame::timestamp_ns`
/// the rest of the trace store uses), and the user-visible label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Empty store.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Vec::new()),
        }
    }

    /// Chronological snapshot of the current notes — what the
    /// plot panel's IPC bootstrap reads, and what
    /// `notes-changed` events carry.
    pub fn snapshot(&self) -> Vec<Note> {
        self.inner.lock().expect("notes mutex poisoned").clone()
    }

    /// Add a note. Returns `None` if a note with the same `id`
    /// already exists (the call was a duplicate — the rate
    /// limiter or a missed event from the frontend), `Some`
    /// otherwise. The store enforces chronological order on
    /// `timestamp_ns`.
    pub fn add(&self, note: Note) -> Option<Applied> {
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
        Some(Applied { notes: guard.clone() })
    }

    /// Rename a note. `None` if `id` is unknown.
    pub fn rename(&self, id: &str, label: impl Into<String>) -> Option<Applied> {
        let mut guard = self.inner.lock().expect("notes mutex poisoned");
        let slot = guard.iter_mut().find(|n| n.id == id)?;
        slot.label = label.into();
        Some(Applied { notes: guard.clone() })
    }

    /// Remove a note. `None` if `id` is unknown.
    pub fn remove(&self, id: &str) -> Option<Applied> {
        let mut guard = self.inner.lock().expect("notes mutex poisoned");
        let before = guard.len();
        guard.retain(|n| n.id != id);
        if guard.len() == before {
            return None;
        }
        Some(Applied { notes: guard.clone() })
    }

    /// Drop every note. Emits `Some` only if there was anything
    /// to drop — caller can skip the event otherwise.
    pub fn clear(&self) -> Option<Applied> {
        let mut guard = self.inner.lock().expect("notes mutex poisoned");
        if guard.is_empty() {
            return None;
        }
        guard.clear();
        Some(Applied { notes: Vec::new() })
    }

    /// Replace the store's contents with `notes`. Used by Open
    /// Capture (sidecar load) and project-open migration. Always
    /// emits `Some` so the change is observable.
    // `allow(dead_code)` — first caller (`open_capture`) lands in
    // the next commit; the API is part of this commit because the
    // unit tests exercise it.
    #[allow(dead_code)]
    pub fn replace(&self, mut notes: Vec<Note>) -> Applied {
        notes.sort_by_key(|n| n.timestamp_ns);
        let mut guard = self.inner.lock().expect("notes mutex poisoned");
        *guard = notes;
        Applied { notes: guard.clone() }
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

    #[test]
    fn replace_sorts_input() {
        let s = NotesStore::new();
        let applied = s.replace(vec![
            note("c", 3_000, "three"),
            note("a", 1_000, "one"),
            note("b", 2_000, "two"),
        ]);
        assert_eq!(
            applied.notes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"],
        );
    }
}
