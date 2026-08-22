//! Filesystem watch on the **open project file** (`.cannet_prj`).
//!
//! The machinery is the DBC watcher's ([`crate::dbc_watcher`]): the same
//! `notify` backend, the same parent-directory watch with a refcount,
//! the same event-kind classification ([`crate::dbc_watcher::reaction_to`]).
//! What differs is what a change *means*, and that difference is the
//! whole of this module
//! ([ADR 0053](../../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)
//! §1).
//!
//! A DBC is an externally-owned input: cannet reads it and never writes
//! it, so a change on disk is unambiguous news and the in-memory copy
//! swaps in place. A project file is an **app-owned document**. Two
//! things follow:
//!
//! - **The host does not apply it.** Reloading a project runs
//!   [`crate::project::open_project`], which re-roots the session
//!   (ADR 0042) and drops the connection, and the in-memory project can
//!   hold unsaved changes a reload would discard. Whether that is safe
//!   depends on the *dirty* bit and on whether a session is up — state
//!   the frontend holds and renders. So the host does what it alone can
//!   do: it says the file changed, by emitting
//!   [`PROJECT_CHANGED_EVENT`]. The apply-or-notify decision is the
//!   frontend's.
//! - **cannet's own writes must not look like external edits.** Save
//!   (and autosave-on-exit) write this file, and every write raises the
//!   same filesystem events an editor would. [`WatchedProject`]
//!   therefore records the content the app last *exchanged* with the
//!   file — read on open, written on save — and an event only becomes
//!   news when what is on disk differs from it. Without that, every
//!   Save would announce a change, and a clean disconnected session
//!   would reload itself (re-rooting, and dropping its capture) on each
//!   one.
//!
//! Failure semantics match the DBC watch: a file that will not read or
//! will not parse logs and leaves the in-memory project alone (a user
//! editing by hand passes through broken states), and a deleted file is
//! reported but does not close the project.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::dbc_watcher::Reaction;
use crate::{sys_error, sys_info, sys_warn};

/// Tauri event: the open project file changed on disk. Payload is the
/// project file's path.
///
/// Purely an announcement — nothing has been applied when it fires. The
/// frontend decides whether to apply it silently or to notify (ADR 0053
/// §1), and applies it by calling `open_project`, the existing open
/// path.
pub const PROJECT_CHANGED_EVENT: &str = "project-changed";

/// The project file the session has open, plus the content the app last
/// exchanged with it.
///
/// `content` is the copy cannet knows the file to hold: what
/// `open_project` read, or what `save_project` wrote. It is what tells
/// an external edit from cannet's own write — see the module docs.
#[derive(Default)]
pub struct WatchedProject {
    path: Option<PathBuf>,
    content: Option<String>,
}

impl WatchedProject {
    /// The watched project file's path, if a project is open.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Whether `text` — what is on disk now — differs from the content
    /// the app last exchanged with the file, i.e. whether this is news.
    fn is_external(&self, text: &str) -> bool {
        self.content.as_deref() != Some(text)
    }
}

/// Take up `path` as the open project file, with `text` as the content
/// the app has for it. Called by `open_project` with what it read — the
/// other entry point that exchanges content with the file is
/// [`record_own_write`].
///
/// Moving to a different file re-points the underlying watch; opening
/// the same file again just re-records the content.
pub(crate) fn set_open_project(app: &AppHandle, path: &Path, text: String) {
    let state: State<'_, AppState> = app.state();
    let mut record = state.watched_project();
    adopt(&state, &mut record, path, text);
}

/// Perform cannet's own write of the project file, recording what landed
/// on disk as the content the app has for it.
///
/// The write runs **under the watch record's lock**, which is what makes
/// the record race-free: the events the write itself raises are read by
/// [`announce_if_changed`] under the same lock, so it cannot compare the
/// post-write file against the pre-write record and mistake a Save for
/// an external edit.
pub(crate) fn record_own_write<F>(app: &AppHandle, path: &Path, write: F) -> std::io::Result<()>
where
    F: FnOnce() -> std::io::Result<()>,
{
    let state: State<'_, AppState> = app.state();
    let mut record = state.watched_project();
    write()?;
    // Read back rather than keeping what the serializer produced: the
    // bytes on disk are what an event will be compared against.
    if let Ok(text) = std::fs::read_to_string(path) {
        adopt(&state, &mut record, path, text);
    }
    Ok(())
}

/// Point the record — and the underlying watch — at `path`, holding
/// `text` as its content.
fn adopt(state: &State<'_, AppState>, record: &mut WatchedProject, path: &Path, text: String) {
    let previous = record.path.replace(path.to_path_buf());
    record.content = Some(text);
    if previous.as_deref() == Some(path) {
        return;
    }
    let mut watcher = state.dbc_watcher();
    let Some(watcher) = watcher.as_mut() else {
        return;
    };
    if let Some(old) = previous.as_deref() {
        watcher.unwatch_file(old);
    }
    watcher.watch_file(path);
}

/// Stop watching the open project file — the project was closed.
pub(crate) fn clear_open_project(app: &AppHandle) {
    let state: State<'_, AppState> = app.state();
    let mut record = state.watched_project();
    let previous = record.path.take();
    record.content = None;
    let Some(old) = previous else {
        return;
    };
    let mut watcher = state.dbc_watcher();
    if let Some(watcher) = watcher.as_mut() {
        watcher.unwatch_file(&old);
    }
}

/// Filesystem-event hook, called from the DBC watcher's `notify`
/// callback for every event before the DBC paths are considered — a
/// project file is never also a loaded DBC, so the two are independent.
pub(crate) fn on_event(app: &AppHandle, event: &notify::Event) {
    let path = {
        let state: State<'_, AppState> = app.state();
        let record = state.watched_project();
        match record.path() {
            Some(p) if event.paths.iter().any(|e| e == p) => p.to_path_buf(),
            _ => return,
        }
    };
    // `true` where the DBC watch reads `dbc_auto_reload`: that setting is
    // the opt-out for a database swapping under an analysis, and nothing
    // is swapped here — the announcement carries no change with it.
    match crate::dbc_watcher::reaction_to(event.kind, true) {
        Reaction::Ignore => {}
        Reaction::NoteRemoval => sys_warn!(
            app,
            "project-watch",
            "project file removed on disk: {} (the open project is unchanged)",
            path.display()
        ),
        Reaction::Reload => announce_if_changed(app, &path),
    }
}

/// Re-read the project file and announce it if what is on disk is not
/// what the app last exchanged with it.
///
/// Holds the [`WatchedProject`] lock across the read, which is what makes
/// cannet's own saves invisible here: [`record_own_write`] writes under
/// that same lock, so this either reads before the write started (and
/// matches the pre-write record) or after it finished (and matches the
/// post-write one) — never the new file against the old record.
fn announce_if_changed(app: &AppHandle, path: &Path) {
    let state: State<'_, AppState> = app.state();
    let mut record = state.watched_project();
    if record.path() != Some(path) {
        return; // closed / re-pointed between the event and this read
    }
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            sys_error!(
                app,
                "project-watch",
                "couldn't read the project after a change at {}: {e}",
                path.display()
            );
            return;
        }
    };
    // A hand-edited file passes through syntactically broken states.
    // Announcing one would put a Reload in front of the user that cannot
    // succeed; the open project is untouched either way.
    if let Err(e) = crate::project::parse_project(&text) {
        sys_error!(
            app,
            "project-watch",
            "couldn't parse the project after a change at {}: {e}",
            path.display()
        );
        return;
    }
    if !record.is_external(&text) {
        return; // cannet's own save, or a rewrite of identical bytes
    }
    record.content = Some(text);
    drop(record);
    sys_info!(
        app,
        "project-watch",
        "project changed on disk: {}",
        path.display()
    );
    let _ = app.emit(PROJECT_CHANGED_EVENT, path.display().to_string());
}

#[cfg(test)]
mod tests {
    //! What is testable without an `AppHandle` (Tauri's mock runtime does
    //! not load on Windows — see task 27's status log): the record that
    //! decides whether an event is news at all.

    use super::*;

    /// A record of a project file the app has read or written.
    fn recorded(content: &str) -> WatchedProject {
        WatchedProject {
            path: Some(PathBuf::from("/p/x.cannet_prj")),
            content: Some(content.to_string()),
        }
    }

    #[test]
    fn a_file_holding_what_the_app_last_exchanged_with_it_is_not_news() {
        // The reason this record exists: cannet writes this file, and a
        // Save raises the same events an editor's would.
        assert!(!recorded("{\"a\":1}").is_external("{\"a\":1}"));
    }

    #[test]
    fn a_file_holding_anything_else_is_news() {
        assert!(recorded("{\"a\":1}").is_external("{\"a\":2}"));
    }

    #[test]
    fn a_project_the_app_has_never_read_is_news() {
        // No recorded content — a watch installed without an exchange
        // has nothing to compare against, so the honest answer is
        // "changed".
        assert!(WatchedProject::default().is_external("{}"));
    }
}
