//! Filesystem watcher for loaded DBC files (Phase 12 follow-up).
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
//!   share one watch.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use notify::{
    event::{CreateKind, ModifyKind},
    EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{sys_error, sys_info, sys_warn};

/// Tracks a `notify` watcher plus the parent directories it currently
/// owns watches on. Lives inside [`crate::AppState`] behind a mutex so
/// `add_dbc` / `remove_dbc` / `clear_dbcs` can mutate the watch set.
pub struct DbcWatcher {
    /// The underlying `notify` watcher. `None` only if construction
    /// failed (e.g. the OS refused to give us a backend — rare but
    /// possible on minimal Linux setups). The whole subsystem
    /// degrades to "no auto-reload" in that case rather than failing
    /// startup.
    watcher: Option<RecommendedWatcher>,
    /// Parent dirs we've called `watch()` on, with a refcount of how
    /// many loaded DBCs live under each.
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
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            match res {
                Ok(event) => on_event(&callback_app, &event),
                Err(e) => sys_warn!(&callback_app, "dbc-watch", "watcher error: {e}"),
            }
        });
        match watcher {
            Ok(w) => Self {
                watcher: Some(w),
                watched_dirs: HashMap::new(),
            },
            Err(e) => {
                sys_warn!(app, "dbc-watch", "couldn't start DBC file watcher: {e}");
                Self {
                    watcher: None,
                    watched_dirs: HashMap::new(),
                }
            }
        }
    }

    /// Start watching the parent directory of `path` (or bump its
    /// refcount if we're already watching). Safe to call on a path
    /// whose parent is the same as another loaded DBC's parent —
    /// only one underlying watch exists.
    pub fn watch_dbc(&mut self, path: &Path) {
        let Some(watcher) = self.watcher.as_mut() else {
            return;
        };
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
                return;
            }
        }
        *count += 1;
    }

    /// Decrement the refcount for `path`'s parent and unwatch if it
    /// drops to zero. No-op if the path was never watched.
    pub fn unwatch_dbc(&mut self, path: &Path) {
        let Some(watcher) = self.watcher.as_mut() else {
            return;
        };
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

    /// Drop every watch — used when the loaded DBC set is cleared.
    pub fn unwatch_all(&mut self) {
        let Some(watcher) = self.watcher.as_mut() else {
            self.watched_dirs.clear();
            return;
        };
        for dir in self.watched_dirs.keys() {
            let _ = watcher.unwatch(dir);
        }
        self.watched_dirs.clear();
    }
}

/// `notify` callback. Runs on the watcher's own thread; locks
/// `AppState::databases` only briefly to identify which loaded DBCs
/// were touched, then drops the lock before doing the (relatively
/// slow) read + parse.
///
/// Event kinds we react to: `Modify(Data | Any)` and `Create(Any)`.
/// Atomic-save (the editor pattern of writing to a temp file then
/// `rename`-ing it into place) shows up as `Create(Any)` on the
/// target path on macOS/Linux, so we have to accept creates too.
/// Removes log a warning but don't change in-memory state.
fn on_event(app: &AppHandle, event: &notify::Event) {
    let interesting = match event.kind {
        EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Any | ModifyKind::Name(_))
        | EventKind::Create(CreateKind::Any | CreateKind::File) => true,
        EventKind::Remove(_) => {
            // Surface a warning but don't drop the in-memory DB —
            // the user might restore the file or save-replace it.
            let state: State<'_, crate::AppState> = app.state();
            let dbs = state.databases.lock().expect("databases mutex poisoned");
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
        _ => false,
    };
    if !interesting {
        return;
    }

    let matching: Vec<String> = {
        let state: State<'_, crate::AppState> = app.state();
        let dbs = state.databases.lock().expect("databases mutex poisoned");
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
    {
        let state: State<'_, crate::AppState> = app.state();
        let mut list = state.databases.lock().expect("databases mutex poisoned");
        let Some(slot) = list.iter_mut().find(|d| d.path == path) else {
            // Unloaded between the FS event and now — nothing to
            // swap. The watcher will get unwatched on the next
            // `remove_dbc`'s pass.
            return;
        };
        slot.db = db;
    }
    sys_info!(app, "dbc-watch", "auto-reloaded DBC {path}");
    let _ = app.emit("dbc-changed", path);
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

    /// A `DbcWatcher` whose backend is missing degrades to no-op
    /// watch / unwatch — the rest of the GUI still has to function
    /// even when (e.g.) Linux refuses to give us inotify. Verifies
    /// the no-op contract.
    #[test]
    fn null_backend_watcher_no_ops_cleanly() {
        let mut w = DbcWatcher {
            watcher: None,
            watched_dirs: HashMap::new(),
        };
        // None of these should panic; nothing is recorded.
        w.watch_dbc(&PathBuf::from("/tmp/foo.dbc"));
        w.unwatch_dbc(&PathBuf::from("/tmp/foo.dbc"));
        w.unwatch_all();
        assert!(w.watched_dirs.is_empty());
    }
}
