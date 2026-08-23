//! Filesystem watcher for loaded DBC files — and the shared machinery
//! the app-owned documents' watches reuse ([`crate::project_watch`] for
//! the `.cannet_prj`, [`crate::rbs::watch`] for the `.cannet_rbs` files
//! RBS elements have open): the same `notify` backend, the same
//! parent-directory watch set, the same event-kind classification.
//!
//! When the user has a DBC loaded and then edits / re-exports it from
//! another tool, we'd like the GUI to pick up the change automatically
//! instead of demanding a manual "Reload DBC" click. This module wraps
//! [`notify`] in a small bookkeeping struct: each loaded DBC's parent
//! directory is watched (with a refcount so multiple DBCs in the same
//! folder share one watch), and any FS event that touches a loaded
//! path triggers a re-parse + in-place swap of the cached `Database`.
//!
//! Auto-reload semantics — what we do, and why:
//!
//! - **The swap is opt-out.** `dbc_auto_reload` (default on) gates it,
//!   read per event so switching it takes effect immediately rather
//!   than at the next relaunch. Off, the watch stays installed and a
//!   file disappearing is still reported — what stops is the in-memory
//!   copy being replaced under a user mid-analysis, which is the thing
//!   someone editing a DBC in another tool may not want. "Reload DBC"
//!   still reloads on demand.
//! - **Re-read + re-parse on every relevant event.** Editors save in
//!   wildly different ways (atomic rename, in-place truncate-then-
//!   rewrite, multi-step temp+rename); the cheapest cross-editor
//!   strategy is to just re-read on any plausible event and let the
//!   parse step accept/reject. A burst of events from one save costs
//!   us a few extra parses but never produces incorrect state.
//! - **Parse failures log + leave the in-memory copy alone.** A user
//!   editing the file by hand might pass through transient
//!   syntactically-broken states; clobbering the working DB with a
//!   broken one would be a worse experience than ignoring the
//!   transient.
//! - **Deletions don't unload.** If the file disappears on disk
//!   (`rm`, moved out of the directory) we keep the in-memory copy
//!   and log a warning — the user can still decode against it. They
//!   can explicitly Remove via the project panel when they want it
//!   gone.
//! - **Parent-directory watches with refcount.** Watching a single
//!   file directly is unreliable across editors that rename a new
//!   file into the target (the inode changes; many backends lose the
//!   watch). Watching the parent dir + filtering by exact path is
//!   the convention. The refcount lets two DBCs in the same dir
//!   share one watch, and the set of watched *files* keeps the
//!   refcount honest: a path that was never watched — a database
//!   embedded in a capture, whose "path" is an identity and not a
//!   file — must not decrement a directory some other file is
//!   holding.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use notify::{
    event::{CreateKind, ModifyKind},
    EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use tauri::{AppHandle, Manager, State};

use crate::{sys_error, sys_info, sys_warn};

/// Tracks a `notify` watcher plus the parent directories it currently
/// owns watches on. Lives inside [`crate::app_state::AppState`] behind a mutex so
/// `add_dbc` / `remove_dbc` / `clear_dbcs` can mutate the watch set.
pub struct DbcWatcher {
    /// The underlying `notify` watcher. `None` only if construction
    /// failed (e.g. the OS refused to give us a backend — rare but
    /// possible on minimal Linux setups). The whole subsystem
    /// degrades to "no auto-reload" in that case rather than failing
    /// startup.
    watcher: Option<RecommendedWatcher>,
    /// The files this watcher is holding a watch for — every loaded
    /// DBC that came from disk, plus the app-owned documents (the open
    /// project file, each element's `.cannet_rbs`). Makes
    /// [`Self::watch_file`] idempotent and [`Self::unwatch_file`] exact:
    /// an unwatch for a path never watched is a no-op rather than a
    /// decrement of somebody else's directory.
    watched_files: HashSet<PathBuf>,
    /// Parent dirs we've called `watch()` on, with a refcount of how
    /// many watched files live under each.
    watched_dirs: HashMap<PathBuf, usize>,
}

impl DbcWatcher {
    /// Build a watcher whose event callback re-reads + re-parses any
    /// loaded DBC whose path matches a changed file. The callback
    /// runs on a `notify`-internal thread; it locks `AppState` only
    /// briefly (to identify the affected DBCs and swap their
    /// in-memory copies), and emits a `dbc-changed` event to the
    /// frontend.
    ///
    /// `app` is cloned into the callback's environment. Tauri's
    /// `AppHandle::clone` is cheap.
    pub fn new(app: &AppHandle) -> Self {
        let callback_app = app.clone();
        let watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
                Ok(event) => on_event(&callback_app, &event),
                Err(e) => sys_warn!(&callback_app, "dbc-watch", "watcher error: {e}"),
            });
        match watcher {
            Ok(w) => Self {
                watcher: Some(w),
                watched_files: HashSet::new(),
                watched_dirs: HashMap::new(),
            },
            Err(e) => {
                sys_warn!(app, "dbc-watch", "couldn't start DBC file watcher: {e}");
                Self {
                    watcher: None,
                    watched_files: HashSet::new(),
                    watched_dirs: HashMap::new(),
                }
            }
        }
    }

    /// Start watching the parent directory of `path` (or bump its
    /// refcount if we're already watching). Safe to call on a path
    /// whose parent is the same as another watched file's parent —
    /// only one underlying watch exists.
    pub fn watch_file(&mut self, path: &Path) {
        let Some(watcher) = self.watcher.as_mut() else {
            return;
        };
        if !self.watched_files.insert(path.to_path_buf()) {
            return; // already watched — one file, one refcount
        }
        let dir = match path.parent() {
            Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
            // Path has no parent (or empty parent) — fall back to "."
            // so a relative path like "foo.dbc" still gets watched.
            _ => PathBuf::from("."),
        };
        let count = self.watched_dirs.entry(dir.clone()).or_insert(0);
        if *count == 0 {
            // `NonRecursive` keeps the event volume sensible — we
            // only care about the parent's direct entries, not the
            // entire subtree.
            if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
                // Watch failure is non-fatal; the user just won't
                // get auto-reload for files under this dir. They
                // can still hit "Reload DBC" manually.
                eprintln!("dbc-watch: couldn't watch {}: {e}", dir.display());
                self.watched_dirs.remove(&dir);
                self.watched_files.remove(path);
                return;
            }
        }
        *count += 1;
    }

    /// Decrement the refcount for `path`'s parent and unwatch if it
    /// drops to zero. No-op if the path was never watched.
    pub fn unwatch_file(&mut self, path: &Path) {
        let Some(watcher) = self.watcher.as_mut() else {
            return;
        };
        if !self.watched_files.remove(path) {
            return; // never watched — not ours to decrement
        }
        let dir = match path.parent() {
            Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
            _ => PathBuf::from("."),
        };
        if let Some(count) = self.watched_dirs.get_mut(&dir) {
            *count -= 1;
            if *count == 0 {
                let _ = watcher.unwatch(&dir);
                self.watched_dirs.remove(&dir);
            }
        }
    }
}

/// What a filesystem event calls for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reaction {
    /// Re-read, re-parse, and swap the in-memory `Database`.
    Reload,
    /// The file is gone: warn, but keep the in-memory copy.
    NoteRemoval,
    /// Nothing to do.
    Ignore,
}

/// Decide what an event calls for, given the `dbc_auto_reload` setting.
///
/// Pure, so both the event-kind filter and the opt-out are testable
/// without an OS watcher — the reason the rest of this module's
/// end-to-end behaviour is left to manual verification.
///
/// Event kinds that mean a reload: `Modify(Data | Any | Name)` and
/// `Create(Any | File)`. Atomic-save (the editor pattern of writing to
/// a temp file then `rename`-ing it into place) shows up as
/// `Create(Any)` on the target path on macOS/Linux, so creates count
/// too. A removal is reported whether or not auto-reload is on: it is
/// news, not a swap.
pub(crate) fn reaction_to(kind: EventKind, auto_reload: bool) -> Reaction {
    match kind {
        EventKind::Remove(_) => Reaction::NoteRemoval,
        EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Any | ModifyKind::Name(_))
        | EventKind::Create(CreateKind::Any | CreateKind::File)
            if auto_reload =>
        {
            Reaction::Reload
        }
        _ => Reaction::Ignore,
    }
}

/// `notify` callback. Runs on the watcher's own thread; locks
/// `AppState::databases` only briefly to identify which loaded DBCs
/// were touched, then drops the lock before doing the (relatively
/// slow) read + parse.
///
/// The `dbc_auto_reload` setting is read here, once per event, so
/// turning it off stops the next swap rather than the next launch.
fn on_event(app: &AppHandle, event: &notify::Event) {
    // The app-owned documents ride on this same watch set, and neither
    // is ever also a loaded DBC — the three reactions are independent.
    crate::project_watch::on_event(app, event);
    crate::rbs::watch::on_event(app, event);
    match reaction_to(event.kind, crate::settings::effective().dbc_auto_reload) {
        Reaction::Reload => {}
        Reaction::NoteRemoval => {
            // Surface a warning but don't drop the in-memory DB —
            // the user might restore the file or save-replace it.
            let state: State<'_, crate::app_state::AppState> = app.state();
            let dbs = state.databases();
            for d in dbs.iter() {
                if event.paths.iter().any(|p| Path::new(&d.path) == p) {
                    sys_warn!(
                        app,
                        "dbc-watch",
                        "DBC file removed on disk: {} (in-memory copy retained)",
                        d.path
                    );
                }
            }
            return;
        }
        Reaction::Ignore => return,
    }

    let matching: Vec<String> = {
        let state: State<'_, crate::app_state::AppState> = app.state();
        let dbs = state.databases();
        dbs.iter()
            .filter(|d| event.paths.iter().any(|p| Path::new(&d.path) == p))
            .map(|d| d.path.clone())
            .collect()
    };
    for path in matching {
        reload_one(app, &path);
    }
}

/// Re-read `path`, re-parse it, and swap the new `Database` into the
/// loaded entry that matches. Logs `info` on success, `error` on read
/// / parse failure. Emits `dbc-changed` with the path so the frontend
/// can refresh its catalog / filter areas.
///
/// Exposed at module level so a unit test can exercise the
/// reload-and-swap pipeline without touching the OS-level watcher.
pub fn reload_one(app: &AppHandle, path: &str) {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            sys_error!(
                app,
                "dbc-watch",
                "couldn't read DBC after change at {path}: {e}",
            );
            return;
        }
    };
    let db = match cannet_dbc::Database::parse(&text) {
        Ok(db) => db,
        Err(e) => {
            sys_error!(
                app,
                "dbc-watch",
                "couldn't re-parse DBC after change at {path}: {e}",
            );
            return;
        }
    };
    let state: State<'_, crate::app_state::AppState> = app.state();
    // Snapshotted before the swap: afterwards there is no way left to
    // ask what the content this replaces was driving.
    let backed_before = crate::transmit_commands::dbc_backed_running_periodics(&state);
    {
        let mut list = state.databases();
        let Some(slot) = list.iter_mut().find(|d| d.path == path) else {
            // Unloaded between the FS event and now — nothing to
            // swap. The watcher will get unwatched on the next
            // `remove_dbc`'s pass.
            return;
        };
        slot.db = std::sync::Arc::new(db);
    }
    sys_info!(app, "dbc-watch", "auto-reloaded DBC {path}");
    // Signal placements may have moved — drop the derived decode caches so
    // the new parse takes effect (see `crate::app_state::invalidate_derived_caches`),
    // rebuild RBS rows, and re-resolve every TX entry's calculated fields.
    crate::app_state::invalidate_derived_caches(&state);
    // The definitions a periodic was transmitting from just changed
    // underneath it, so it stops before anything else hears about the
    // swap (ADR 0053 §1).
    crate::dbc_commands::report_reload_stops(app, &state, path, &backed_before);
    crate::dbc_commands::announce_dbc_change(app, path);
}

#[cfg(test)]
impl DbcWatcher {
    /// A watcher with a real `notify` backend and a callback that does
    /// nothing, so the watch-set bookkeeping can be exercised without a
    /// Tauri app (whose mock runtime does not load on this platform).
    /// Watching is real; only the reaction is dropped.
    fn inert() -> Self {
        Self {
            watcher: notify::recommended_watcher(|_| {}).ok(),
            watched_files: HashSet::new(),
            watched_dirs: HashMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    //! Unit tests focus on bookkeeping pieces that don't need the OS
    //! watcher running — the refcount logic is the most error-prone
    //! part. End-to-end "edit a file on disk, see the in-memory DB
    //! swap" coverage is left to manual verification (FS watchers are
    //! timing-dependent enough that automated tests for them are
    //! consistently flaky in CI).

    use super::*;
    use std::path::PathBuf;

    /// Opening a project is `clear_dbcs` followed by an `add_dbc` per
    /// database, and `clear_dbcs` unwatches every DBC it unloaded. The
    /// open project file lives in the same watch set — frequently in
    /// the same directory as the DBCs it references — so this is the
    /// case that decides whether the project watch survives a project
    /// open at all.
    #[test]
    fn unwatching_every_dbc_in_a_directory_leaves_the_project_file_watched() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = DbcWatcher::inert();
        let prj = dir.path().join("p.cannet_prj");
        let a = dir.path().join("a.dbc");
        let b = dir.path().join("b.dbc");
        w.watch_file(&prj);
        w.watch_file(&a);
        w.watch_file(&b);
        assert_eq!(w.watched_dirs.get(dir.path()), Some(&3));
        w.unwatch_file(&a);
        w.unwatch_file(&b);
        assert_eq!(w.watched_dirs.get(dir.path()), Some(&1));
        assert!(w.watched_files.contains(&prj));
    }

    /// A database embedded in a capture is loaded under an identity,
    /// not a file, and is never watched — so unloading it must not
    /// decrement the directory a real file is holding. (It also used to
    /// underflow the refcount.)
    #[test]
    fn unwatching_a_path_that_was_never_watched_leaves_the_directory_alone() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = DbcWatcher::inert();
        let real = dir.path().join("a.dbc");
        w.watch_file(&real);
        w.unwatch_file(&dir.path().join("capture.blf#embedded"));
        assert_eq!(w.watched_dirs.get(dir.path()), Some(&1));
        w.unwatch_file(&real);
        assert!(w.watched_dirs.is_empty());
    }

    /// One file, one refcount: re-watching an already-watched path (the
    /// project file re-recorded on every save) must not leave a
    /// directory watched forever.
    #[test]
    fn watching_the_same_file_twice_takes_one_refcount() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = DbcWatcher::inert();
        let f = dir.path().join("p.cannet_prj");
        w.watch_file(&f);
        w.watch_file(&f);
        assert_eq!(w.watched_dirs.get(dir.path()), Some(&1));
        w.unwatch_file(&f);
        assert!(w.watched_dirs.is_empty());
    }

    /// A `DbcWatcher` whose backend is missing degrades to no-op
    /// watch / unwatch — the rest of the GUI still has to function
    /// even when (e.g.) Linux refuses to give us inotify. Verifies
    /// the no-op contract.
    #[test]
    fn null_backend_watcher_no_ops_cleanly() {
        let mut w = DbcWatcher {
            watcher: None,
            watched_files: HashSet::new(),
            watched_dirs: HashMap::new(),
        };
        // None of these should panic; nothing is recorded.
        w.watch_file(&PathBuf::from("/tmp/foo.dbc"));
        w.unwatch_file(&PathBuf::from("/tmp/foo.dbc"));
        assert!(w.watched_dirs.is_empty());
        assert!(w.watched_files.is_empty());
    }

    /// Every event kind an editor's save shows up as, so the opt-out
    /// can't be tested against only one of them.
    const SAVE_KINDS: &[EventKind] = &[
        EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
        EventKind::Modify(ModifyKind::Any),
        EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::To)),
        EventKind::Create(CreateKind::Any),
        EventKind::Create(CreateKind::File),
    ];

    #[test]
    fn a_save_reloads_while_auto_reload_is_on() {
        for kind in SAVE_KINDS {
            assert_eq!(reaction_to(*kind, true), Reaction::Reload, "{kind:?}");
        }
    }

    #[test]
    fn auto_reload_off_leaves_the_in_memory_copy_alone() {
        // The whole point of the opt-out: a DBC edited in another tool
        // must not swap out from under an analysis in progress.
        // "Reload DBC" is still there for when it should.
        for kind in SAVE_KINDS {
            assert_eq!(reaction_to(*kind, false), Reaction::Ignore, "{kind:?}");
        }
    }

    #[test]
    fn a_removal_is_reported_whichever_way_the_setting_is_set() {
        // A vanished file is news, not a swap — switching auto-reload
        // off asks us not to replace the database, not to go quiet.
        for auto_reload in [true, false] {
            assert_eq!(
                reaction_to(
                    EventKind::Remove(notify::event::RemoveKind::File),
                    auto_reload
                ),
                Reaction::NoteRemoval,
            );
        }
    }

    #[test]
    fn an_event_that_touches_no_content_is_ignored_either_way() {
        for auto_reload in [true, false] {
            assert_eq!(
                reaction_to(
                    EventKind::Modify(ModifyKind::Metadata(
                        notify::event::MetadataKind::AccessTime
                    )),
                    auto_reload,
                ),
                Reaction::Ignore,
            );
        }
    }
}
