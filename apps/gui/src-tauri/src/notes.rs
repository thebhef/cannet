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
//! **Three categories of event share this store's delivery path**
//! ([`EventCategory`], ADR 0035). User-authored events are the durable ones
//! it owns; host-derived events (a coalesced run of bus errors) are computed
//! elsewhere in the host, held apart, and never persisted or exported;
//! frontend-derived events (the truncation marker) never reach the host at
//! all. [`NotesStore::events`] is the merged view every surface reads.
//!
//! Notes also ride the disk-spill scratch (ADR 0002 DS-7): a store built
//! with [`NotesStore::with_scratch`] writes `notes.json` into the scratch
//! dir on **every
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
    /// Event kind (ADR 0035). The store holds only user-authored kinds;
    /// `#[serde(default)]` keeps a pre-kind `notes.json` / BLF-derived note
    /// readable (it reads back as [`EventKind::Note`]).
    #[serde(default)]
    pub kind: EventKind,
    /// Optional `#RRGGBB` color (ADR 0035). `None` renders in the view's
    /// default event color and round-trips through the BLF marker's
    /// `foreground_color`. `#[serde(default)]` for back-compat.
    #[serde(default)]
    pub color: Option<String>,
}

/// Where a timeline event came from (ADR 0035). The category, not the
/// individual kind, decides the event's lifecycle: whether it is editable,
/// whether it rides the scratch, and whether it is exported.
///
/// The model names **three** categories. The third —
/// *frontend-derived*, synthesized in the frontend from host data (the
/// disk-spill truncation marker, from the store's low-water mark) — has no
/// variant here on purpose: those kinds never cross the wire and never
/// reach this store, so a host-side value of that category cannot exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventCategory {
    /// The user placed it. Editable, persisted to the scratch, exported.
    UserAuthored,
    /// The host computed it from the frame stream. Not editable, not
    /// persisted, not exported — it is recomputed by whatever produces it,
    /// and the data it summarises is what gets written out.
    HostDerived,
}

/// The kind of a timeline event (ADR 0035). Kinds the *host* can hold or
/// produce appear here; frontend-derived kinds (the truncation marker) do
/// not, per [`EventCategory`]. The set grows as kinds are added.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    /// A user-placed marker — the original note. Editable, persisted to the
    /// scratch, exported to BLF `GLOBAL_MARKER`.
    #[default]
    Note,
    /// A run of CAN bus errors coalesced by the host into one event with a
    /// count and a span. Host-derived: not editable, not persisted, not
    /// exported — the error frames it summarises stay in the capture and
    /// are what a save writes.
    BusError,
}

impl EventKind {
    /// Which category this kind belongs to — the thing that fixes its
    /// lifecycle.
    pub fn category(self) -> EventCategory {
        match self {
            Self::Note => EventCategory::UserAuthored,
            Self::BusError => EventCategory::HostDerived,
        }
    }

    /// Does an event of this kind belong in the durable store — the one that
    /// rides the disk-spill scratch (ADR 0002 DS-7)?
    pub fn persisted(self) -> bool {
        matches!(self.category(), EventCategory::UserAuthored)
    }

    /// Is an event of this kind written out on Save Capture? Host-derived
    /// events are not user data (ADR 0035): the frames they summarise are
    /// what the file carries.
    pub fn exported(self) -> bool {
        matches!(self.category(), EventCategory::UserAuthored)
    }
}

/// The session-scoped notes store. Single `Mutex`-guarded vec —
/// edits are rare (one per user click) and the snapshot path is
/// what every plot panel hits each render, so a Mutex over a Vec
/// is fine. Sorted by `timestamp_ns` so a snapshot is already in
/// chronological order for the event list.
pub struct NotesStore {
    inner: Mutex<Vec<Note>>,
    /// Host-derived events ([`EventCategory::HostDerived`]) — held apart
    /// from `inner` so the two lifecycles cannot be confused: this list is
    /// never persisted, never exported, and is replaced wholesale by
    /// whatever computes it. Views see it merged with `inner` through
    /// [`Self::events`].
    derived: Mutex<Vec<Note>>,
    /// Scratch dir for durable-kind persistence (ADR 0002 DS-7), or `None`
    /// for the in-RAM test double. When set, every edit rewrites
    /// [`SCRATCH_NOTES_FILE`] under it. Behind its own lock because the
    /// session can move to a different project directory mid-flight
    /// ([`Self::reroot`], ADR 0042).
    scratch_dir: Mutex<Option<PathBuf>>,
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
            derived: Mutex::new(Vec::new()),
            scratch_dir: Mutex::new(None),
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
            derived: Mutex::new(Vec::new()),
            scratch_dir: Mutex::new(Some(dir)),
        }
    }

    /// The directory this store persists into, if any.
    fn scratch_dir(&self) -> Option<PathBuf> {
        self.scratch_dir
            .lock()
            .expect("notes scratch dir mutex poisoned")
            .clone()
    }

    /// Persist into `dir` from now on — the cache directory of a project
    /// directory the session has switched to (ADR 0042).
    ///
    /// The notes themselves are *not* carried over: they belong to the
    /// capture, and the caller has just swapped which capture this session
    /// holds. The store takes on whatever the new directory already has —
    /// nothing, for a project that has none — and returns it so the host
    /// can emit a `notes-changed`.
    ///
    /// The new directory's file is read *before* the store is emptied.
    /// Emptying first would persist that empty list through the new
    /// pointer and destroy the notes it was about to load.
    pub fn reroot(&self, dir: PathBuf) -> Vec<Note> {
        let arriving: Vec<Note> = read_json(&dir.join(SCRATCH_NOTES_FILE)).unwrap_or_default();
        *self
            .scratch_dir
            .lock()
            .expect("notes scratch dir mutex poisoned") = Some(dir);
        self.replace(arriving).notes
    }

    /// Chronological snapshot of the **durable** events — the user-authored
    /// ones this store owns. This is what rides the scratch; it is not what
    /// the views read (see [`Self::events`]).
    pub fn snapshot(&self) -> Vec<Note> {
        self.inner.lock().expect("notes mutex poisoned").clone()
    }

    /// Chronological snapshot of every event the views render: the durable
    /// ones merged with the host-derived ones. This is what `fetch_notes`
    /// returns and what a `notes-changed` payload carries — one model, one
    /// delivery path, whatever produced each event (ADR 0035).
    pub fn events(&self) -> Vec<Note> {
        let mut all = self.snapshot();
        all.extend(
            self.derived
                .lock()
                .expect("derived events mutex poisoned")
                .iter()
                .cloned(),
        );
        all.sort_by_key(|n| n.timestamp_ns);
        all
    }

    /// The events Save Capture writes out: user-authored only. Host-derived
    /// events summarise data the file already carries, so exporting them
    /// would add a lossy restatement of what is already there (ADR 0035).
    pub fn exportable(&self) -> Vec<Note> {
        let mut out = self.snapshot();
        out.retain(|n| n.kind.exported());
        out
    }

    /// Replace the host-derived event set with `events` — what a host-side
    /// detector calls when its computation changes. Non-derived kinds are
    /// dropped: this list is not a back door into the durable store.
    ///
    /// `dead_code`-allowed: this is the host-derived category's only entry
    /// point, and the detectors that will call it are not built yet. The
    /// category is unreachable without it.
    #[allow(dead_code)]
    pub fn replace_derived(&self, mut events: Vec<Note>) -> Applied {
        events.retain(|n| !n.kind.persisted());
        events.sort_by_key(|n| n.timestamp_ns);
        *self.derived.lock().expect("derived events mutex poisoned") = events;
        Applied {
            notes: self.events(),
        }
    }

    /// Drop every host-derived event. Used by the clear / replace paths:
    /// the frames they summarise are gone, so the summaries go with them.
    fn clear_derived(&self) {
        self.derived
            .lock()
            .expect("derived events mutex poisoned")
            .clear();
    }

    /// Rewrite the scratch copy from the current notes, via atomic
    /// temp-file + rename. Called after every mutation; a no-op without a
    /// scratch dir. A write failure is logged, not propagated — a dropped
    /// scratch write is a durability gap, not a reason to fail the edit.
    fn persist(&self) {
        let Some(dir) = self.scratch_dir() else {
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
        if !note.kind.persisted() {
            // The durable store holds user-authored events only; a
            // host-derived one arrives through `replace_derived` (ADR 0035).
            tracing::warn!(kind = ?note.kind, "refusing a non-durable event in the notes store");
            return None;
        }
        {
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
        }
        self.persist();
        Some(Applied {
            notes: self.events(),
        })
    }

    /// Rename a note. `None` if `id` is unknown.
    pub fn rename(&self, id: &str, label: impl Into<String>) -> Option<Applied> {
        {
            let mut guard = self.inner.lock().expect("notes mutex poisoned");
            let slot = guard.iter_mut().find(|n| n.id == id)?;
            slot.label = label.into();
        }
        self.persist();
        Some(Applied {
            notes: self.events(),
        })
    }

    /// Recolor a note (ADR 0035 color metadata): `Some("#RRGGBB")` to set,
    /// `None` to clear back to the view default. `None` return if `id` is
    /// unknown.
    pub fn recolor(&self, id: &str, color: Option<String>) -> Option<Applied> {
        {
            let mut guard = self.inner.lock().expect("notes mutex poisoned");
            let slot = guard.iter_mut().find(|n| n.id == id)?;
            slot.color = color;
        }
        self.persist();
        Some(Applied {
            notes: self.events(),
        })
    }

    /// Remove a note. `None` if `id` is unknown.
    pub fn remove(&self, id: &str) -> Option<Applied> {
        {
            let mut guard = self.inner.lock().expect("notes mutex poisoned");
            let before = guard.len();
            guard.retain(|n| n.id != id);
            if guard.len() == before {
                return None;
            }
        }
        self.persist();
        Some(Applied {
            notes: self.events(),
        })
    }

    /// Drop every note. Emits `Some` only if there was anything
    /// to drop — caller can skip the event otherwise.
    pub fn clear(&self) -> Option<Applied> {
        {
            let mut guard = self.inner.lock().expect("notes mutex poisoned");
            let derived_empty = self
                .derived
                .lock()
                .expect("derived events mutex poisoned")
                .is_empty();
            if guard.is_empty() && derived_empty {
                return None;
            }
            guard.clear();
        }
        self.clear_derived();
        self.persist();
        Some(Applied { notes: Vec::new() })
    }

    /// Replace the store's contents with `notes`. Used by Open
    /// Capture and project-open migration. Always emits `Some` so
    /// the change is observable.
    pub fn replace(&self, mut notes: Vec<Note>) -> Applied {
        notes.sort_by_key(|n| n.timestamp_ns);
        notes.retain(|n| n.kind.persisted());
        {
            let mut guard = self.inner.lock().expect("notes mutex poisoned");
            *guard = notes;
        }
        // A replace swaps which capture this session holds, so the previous
        // capture's host-derived summaries no longer describe anything.
        self.clear_derived();
        self.persist();
        Applied {
            notes: self.events(),
        }
    }

    /// Restore notes from this store's scratch [`SCRATCH_NOTES_FILE`],
    /// replacing the store's contents, and return the restored notes so the
    /// host can emit a `notes-changed`. `None` when there is no scratch dir
    /// or no file (a clean miss) — the store is left untouched.
    pub fn restore(&self) -> Option<Vec<Note>> {
        let dir = self.scratch_dir()?;
        let notes: Vec<Note> = read_json(&dir.join(SCRATCH_NOTES_FILE))?;
        self.replace(notes.clone());
        Some(notes)
    }

    /// Remove the scratch copy of notes (ADR 0002 DS-7) so a Clear / new
    /// capture leaves no stale events for a later reopen to restore. The
    /// live store is cleared / replaced separately by the caller; a no-op
    /// without a scratch dir.
    pub fn wipe_scratch(&self) {
        if let Some(dir) = self.scratch_dir() {
            let _ = std::fs::remove_file(dir.join(SCRATCH_NOTES_FILE));
        }
    }
}

use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;

/// Snapshot of the session-scoped timeline events, chronological — the
/// durable ones and the host-derived ones together, the same set a
/// `notes-changed` payload carries. Views call this on mount to seed their
/// event list and reconcile against `notes-changed` events.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn fetch_notes(state: State<'_, AppState>) -> Vec<Note> {
    state.notes.events()
}

/// Add a note to the session buffer. Emits `notes-changed`
/// with the new chronological snapshot on success. A duplicate `id`
/// is a no-op (idempotent against an event arriving twice).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn add_note(app: AppHandle, note: Note) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.add(note) {
        let _ = app.emit("notes-changed", applied.notes);
    }
}

/// Rename an existing note.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn rename_note(app: AppHandle, id: String, label: String) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.rename(&id, label) {
        let _ = app.emit("notes-changed", applied.notes);
    }
}

/// Recolor an existing note (ADR 0035): `Some("#RRGGBB")` to set, `null`
/// to clear back to the view default.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn recolor_note(app: AppHandle, id: String, color: Option<String>) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.recolor(&id, color) {
        let _ = app.emit("notes-changed", applied.notes);
    }
}

/// Remove a note from the session buffer.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn remove_note(app: AppHandle, id: String) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.remove(&id) {
        let _ = app.emit("notes-changed", applied.notes);
    }
}

/// Drop every note from the session buffer. Called by the
/// trace-store clear path so cleared captures lose their notes too.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn clear_notes(app: AppHandle) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.clear() {
        let _ = app.emit("notes-changed", applied.notes);
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
            kind: EventKind::Note,
            color: None,
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
    fn recolor_sets_and_clears_color_only() {
        let s = NotesStore::new();
        s.add(note("a", 1_000, "one")).unwrap();
        let applied = s.recolor("a", Some("#ff8800".into())).unwrap();
        assert_eq!(applied.notes[0].color.as_deref(), Some("#ff8800"));
        assert_eq!(applied.notes[0].label, "one", "label untouched");
        // Clearing back to the default color.
        let applied = s.recolor("a", None).unwrap();
        assert_eq!(applied.notes[0].color, None);
        // Unknown id is a no-op.
        assert!(s.recolor("missing", Some("#000".into())).is_none());
    }

    #[test]
    fn color_and_kind_round_trip_through_scratch_json() {
        // A pre-kind notes.json (no `kind`/`color`) still parses, and a
        // colored note survives a persist + restore (ADR 0002 DS-7 / 0035).
        let legacy: Note = serde_json::from_str(r#"{"id":"x","timestampNs":5,"label":"old"}"#)
            .expect("a pre-kind note still deserializes");
        assert_eq!(legacy.kind, EventKind::Note);
        assert_eq!(legacy.color, None);

        let dir = tempfile::tempdir().unwrap();
        let s = NotesStore::with_scratch(dir.path().to_path_buf());
        s.add(note("a", 1_000, "one")).unwrap();
        s.recolor("a", Some("#00aaff".into())).unwrap();
        let reopened = NotesStore::with_scratch(dir.path().to_path_buf());
        let restored = reopened.restore().expect("scratch notes restore");
        assert_eq!(restored[0].color.as_deref(), Some("#00aaff"));
        assert_eq!(restored[0].kind, EventKind::Note);
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
    fn rerooting_swaps_which_project_directory_the_notes_belong_to() {
        // A note belongs to a capture, and a re-root swaps which capture
        // this session holds (ADR 0042). So the store takes on the new
        // directory's notes rather than carrying the old ones into it —
        // and the old directory keeps its own, for when the user comes
        // back to that project.
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        NotesStore::with_scratch(b.path().to_path_buf()).add(note("b1", 9_000, "B's marker"));

        let store = NotesStore::with_scratch(a.path().to_path_buf());
        store.add(note("a1", 1_000, "A's marker"));

        let restored = store.reroot(b.path().to_path_buf());

        assert_eq!(
            restored.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["b1"]
        );
        assert_eq!(store.snapshot(), restored);
        assert_eq!(
            NotesStore::with_scratch(a.path().to_path_buf())
                .restore()
                .unwrap()
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a1"],
            "A's notes stay in A"
        );
        // And edits now persist into the new directory.
        store.add(note("b2", 10_000, "later"));
        assert_eq!(
            NotesStore::with_scratch(b.path().to_path_buf())
                .restore()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn rerooting_into_an_empty_directory_leaves_the_store_empty() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let store = NotesStore::with_scratch(a.path().to_path_buf());
        store.add(note("a1", 1_000, "A's marker"));

        assert!(store.reroot(b.path().to_path_buf()).is_empty());
        assert!(store.snapshot().is_empty());
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

#[cfg(test)]
mod category_tests {
    use super::*;

    fn bus_error(id: &str, ts: u64) -> Note {
        Note {
            id: id.into(),
            timestamp_ns: ts,
            label: "bus error".into(),
            kind: EventKind::BusError,
            color: None,
        }
    }

    fn user_note(id: &str, ts: u64) -> Note {
        Note {
            id: id.into(),
            timestamp_ns: ts,
            label: "note".into(),
            kind: EventKind::Note,
            color: None,
        }
    }

    #[test]
    fn each_kind_declares_its_category_and_that_category_fixes_its_lifecycle() {
        assert_eq!(EventKind::Note.category(), EventCategory::UserAuthored);
        assert_eq!(EventKind::BusError.category(), EventCategory::HostDerived);
        assert!(EventKind::Note.persisted() && EventKind::Note.exported());
        assert!(!EventKind::BusError.persisted() && !EventKind::BusError.exported());
    }

    #[test]
    fn a_host_derived_event_is_refused_by_the_durable_store() {
        let s = NotesStore::new();
        assert!(s.add(bus_error("e1", 1_000)).is_none());
        assert!(s.snapshot().is_empty());
        assert!(s.events().is_empty());
    }

    #[test]
    fn host_derived_events_reach_the_views_but_never_the_scratch_or_an_export() {
        let dir = tempfile::tempdir().unwrap();
        let s = NotesStore::with_scratch(dir.path().to_path_buf());
        s.add(user_note("n1", 2_000)).unwrap();
        let applied = s.replace_derived(vec![bus_error("e1", 1_000)]);

        // Views see both, chronologically.
        assert_eq!(
            applied
                .notes
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
            vec!["e1", "n1"],
        );
        assert_eq!(applied.notes, s.events());
        // The durable snapshot and the export set see only the note.
        assert_eq!(
            s.snapshot()
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
            vec!["n1"],
        );
        assert_eq!(
            s.exportable()
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
            vec!["n1"],
        );
        // And the scratch file the next session restores from holds only it.
        let reopened = NotesStore::with_scratch(dir.path().to_path_buf());
        assert_eq!(
            reopened
                .restore()
                .expect("notes.json present")
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
            vec!["n1"],
        );
    }

    #[test]
    fn clearing_the_capture_drops_the_derived_events_with_it() {
        let s = NotesStore::new();
        s.replace_derived(vec![bus_error("e1", 1_000)]);
        assert!(
            s.clear().is_some(),
            "derived-only store still has something to clear"
        );
        assert!(s.events().is_empty());
    }

    #[test]
    fn the_bus_error_kind_crosses_the_wire_camel_cased() {
        let v = serde_json::to_value(bus_error("e1", 1)).unwrap();
        assert_eq!(v["kind"], "busError");
    }
}
