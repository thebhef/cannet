//! The project registry — every project directory cannet has worked in,
//! and the cache each one holds (ADR 0042 §5).
//!
//! Captures live in their project's own cache now, so disk use multiplies
//! by the number of projects and "reclaim the disk that job from last
//! month is using" has to be expressible. It is expressible only if
//! something remembers the projects: a cache directory is keyed by a hash
//! of its project directory's path (ADR 0042 §4), which is not a path
//! anything can read back. This file is that memory.
//!
//! **User scope, and its own file.** Which projects *you* have opened is a
//! fact about the person, so it belongs beside `settings.json` and
//! `state.json` in `app_config_dir` — but not *in* either. `state.json` is
//! the frontend's mirror: [`crate::state::set_state`] writes the whole
//! struct back from the renderer, so a host-owned key there would be
//! erased by the next layout change. The registry is written by the host
//! and read by the host, and it gets a file of its own to say so.
//!
//! Best-effort and unversioned, like the rest of the machine-local
//! documents: a corrupt or absent file reads as an empty registry rather
//! than failing anything. Losing it costs the user the list, not any data
//! — every entry is re-recorded the next time its project is opened.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::project_dir::ProjectDir;

/// File name under `app_config_dir`.
const REGISTRY_FILE: &str = "projects.json";

/// Emitted when a background measurement of the registered caches has
/// finished and the sizes the listing serves are no longer pending. The
/// settings view's cache list re-asks; it carries no payload, because
/// the walk measures the whole list at once.
pub const PROJECT_CACHES_MEASURED_EVENT: &str = "project-caches-measured";

/// One remembered project directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectEntry {
    /// The project directory itself — the directory the user's content
    /// sits in, and the identity of the entry.
    pub root: String,
    /// The cannet-managed cache directory that directory's `.cannet/cache`
    /// points at. Recorded rather than recomputed: it is what Clear and
    /// Delete act on, and the hash that derives it is an implementation
    /// detail of [`crate::project_dir`].
    pub cache: String,
    /// The project file the directory holds, when the session had one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_file: Option<String>,
    /// Whether cannet chose the location because the user named none —
    /// the rows that get the `Save as…` offer (ADR 0042 §5).
    pub auto_located: bool,
    /// When this project was last worked in, as seconds since the Unix
    /// epoch.
    pub last_used_seconds: u64,
}

/// Every project directory cannet has worked in, most recently used
/// first.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProjectRegistry {
    pub projects: Vec<ProjectEntry>,
}

/// Read the registry from `config_dir`. A missing, unreadable, or corrupt
/// file reads as an empty registry — the list is a convenience, and
/// nothing it backs may fail because of it.
pub(crate) fn read(config_dir: &Path) -> ProjectRegistry {
    match std::fs::read_to_string(config_dir.join(REGISTRY_FILE)) {
        Ok(text) => crate::persisted_json::parse_or_default(&text),
        Err(_) => ProjectRegistry::default(),
    }
}

/// Write the registry to `config_dir`, atomically (temp sibling +
/// rename), so a crash mid-write cannot leave a half-written list.
fn write(config_dir: &Path, registry: &ProjectRegistry) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    crate::persisted_json::write_json_atomic(&config_dir.join(REGISTRY_FILE), registry)
}

/// Remember `dir` as of `now_seconds`, or refresh what is already
/// remembered about it.
///
/// The project directory's path is the identity: reopening the same
/// project updates its entry rather than adding a second one, and a
/// directory that was promoted off cache space by Save As keeps the entry
/// its new root already has. Entries are kept most-recently-used first,
/// which is the order the cache list shows them in.
pub(crate) fn record(
    config_dir: &Path,
    dir: &ProjectDir,
    project_file: Option<&Path>,
    now_seconds: u64,
) {
    let mut registry = read(config_dir);
    let root = path_text(dir.root());
    registry.projects.retain(|e| e.root != root);
    registry.projects.insert(
        0,
        ProjectEntry {
            root,
            cache: path_text(dir.cache_dir()),
            project_file: project_file.map(path_text),
            auto_located: dir.is_auto_located(),
            last_used_seconds: now_seconds,
        },
    );
    if let Err(e) = write(config_dir, &registry) {
        tracing::warn!(
            error = %e,
            "could not record the project directory in the registry; \
             its cache will not be listed for reclaiming"
        );
    }
}

/// Forget the entry for `root`, leaving every other entry alone. The
/// project directory itself is not touched — forgetting is bookkeeping,
/// not deletion (ADR 0042 §5).
pub(crate) fn forget(config_dir: &Path, root: &Path) -> std::io::Result<()> {
    let mut registry = read(config_dir);
    let root = path_text(root);
    registry.projects.retain(|e| e.root != root);
    write(config_dir, &registry)
}

/// A path as the registry records it. Lossy conversion rather than a
/// failure: a path that is not valid Unicode still names a real directory,
/// and a row the user cannot act on is worse than a row with a
/// substitution character in it.
fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Seconds since the Unix epoch, for [`record`]'s `now_seconds`. A clock
/// before the epoch yields 0 rather than failing — the timestamp orders a
/// list, nothing more.
pub(crate) fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl ProjectEntry {
    /// The cannet-managed cache directory Clear empties and Delete
    /// removes.
    pub(crate) fn cache_path(&self) -> PathBuf {
        PathBuf::from(&self.cache)
    }

    /// The project directory itself — which neither Clear nor Delete may
    /// touch (ADR 0042 §5).
    pub(crate) fn root_path(&self) -> PathBuf {
        PathBuf::from(&self.root)
    }
}

/// What one row of the project cache list is, as the settings view shows
/// it. Exactly one state per row, ranked in the order below: what is
/// true of the open project outranks what is true of a directory that is
/// no longer there, which outranks where the directory came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CacheRowState {
    /// The project this session is working in. Its cache is mapped, so
    /// Clear means "discard this session" and Delete is unavailable.
    Active,
    /// The project directory is gone — deleted outside the app. The row
    /// stays, at whatever its cache still holds, until the user removes
    /// it: a stale entry is something to offer to forget, never a reason
    /// to fail.
    Missing,
    /// cannet chose the location, because the user named none. These are
    /// the rows that offer `Save as…` (ADR 0042 §5).
    AutoLocated,
    /// The directory is still there, but is no longer a project
    /// directory: its `.cannet_prj` moved away and left the `.cannet/`
    /// un-paired (ADR 0042 §2). Surfacing it is the point — an orphaned
    /// workspace directory is exactly the cache a user has no other way
    /// to find.
    Orphaned,
    /// A project directory the user made, not the open one.
    Known,
}

/// What the last background walk measured, per cache directory, and the
/// single-flight gate over the walk itself.
///
/// The measurement is a directory walk per registered cache — the work
/// ADR 0002 DS-8 calls expensive — so it is never what a listing waits
/// for (ADR 0049). A listing answers with what is in here (pending for a
/// cache never measured, or one whose figure was dropped by a Clear or a
/// Delete) and asks for a walk; the walk announces itself with
/// [`PROJECT_CACHES_MEASURED_EVENT`] and the view asks again.
///
/// Single-flight, the same shape as the pyramid sweep: requests that
/// arrive while a walk runs set `pending` and are drained by the walker
/// already running, so a settings view shown and hidden repeatedly costs
/// one walk at a time, not one per show.
#[derive(Default)]
pub struct ProjectCacheSizes {
    measured: Arc<Mutex<HashMap<PathBuf, u64>>>,
    gate: Arc<Mutex<WalkGate>>,
}

#[derive(Default)]
struct WalkGate {
    running: bool,
    pending: bool,
}

impl ProjectCacheSizes {
    /// The last measured size of `cache`, or `None` — never measured, or
    /// dropped because something changed what it holds.
    fn get(&self, cache: &Path) -> Option<u64> {
        self.measured
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(cache)
            .copied()
    }

    /// Forget what `cache` held. Called by Clear and Delete: the figure
    /// they invalidate is worse than no figure, because a stale one
    /// reads as a measurement.
    fn forget(&self, cache: &Path) {
        self.measured
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(cache);
    }

    /// Forget every measurement — Clear all.
    fn forget_all(&self) {
        self.measured
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    /// Measure `caches` in the background and announce the result.
    ///
    /// Returns immediately. `measure` walks one directory (the real
    /// `dir_footprint` in production, a counting stub in tests) and
    /// `announce` is the event; both injected so the single-flight rule
    /// is testable without a Tauri app or a multi-gigabyte fixture.
    fn measure_in_background(
        &self,
        caches: Vec<PathBuf>,
        measure: Arc<dyn Fn(&Path) -> u64 + Send + Sync>,
        announce: Arc<dyn Fn() + Send + Sync>,
    ) {
        {
            let mut gate = self
                .gate
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            gate.pending = true;
            if gate.running {
                return;
            }
            gate.running = true;
        }
        let measured = Arc::clone(&self.measured);
        let gate = Arc::clone(&self.gate);
        std::thread::spawn(move || loop {
            {
                let mut g = gate
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if !g.pending {
                    g.running = false;
                    return;
                }
                g.pending = false;
            }
            for cache in &caches {
                let bytes = measure(cache);
                measured
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(cache.clone(), bytes);
            }
            announce();
        });
    }
}

/// One project's row in the cache list: where it is, what its cache
/// holds, and what may be done to it.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectCacheRow {
    root: String,
    cache: String,
    project_file: Option<String>,
    /// Bytes the cache directory held when it was last measured, or
    /// `None` while that measurement is still pending.
    ///
    /// The walk is not cheap (ADR 0002 DS-8), so it is asked for by the
    /// listing and run in the background, never waited on and never on a
    /// timer (ADR 0049). A row therefore lists at once and its size
    /// arrives with [`PROJECT_CACHES_MEASURED_EVENT`].
    bytes: Option<u64>,
    state: CacheRowState,
    /// Whether cannet chose this directory's location. Separate from
    /// `state`, which is the one badge a row wears: the *open* project may
    /// also be auto-located, and it is exactly that row the `Save as…`
    /// offer belongs on (ADR 0042 §5).
    auto_located: bool,
    last_used_seconds: u64,
}

/// Build the cache list from `registry`, reading each cache's size out of
/// `sizes` — never measuring one here.
///
/// A row is produced for every entry, whatever the filesystem says: a
/// project directory deleted outside the app shows as
/// [`CacheRowState::Missing`] at whatever its cache still holds, and one
/// whose cache is gone shows zero bytes once it has been walked. Nothing
/// here can fail, which is what keeps a stale entry from stopping the
/// panel opening.
fn rows(
    registry: &ProjectRegistry,
    active_root: &Path,
    sizes: &ProjectCacheSizes,
) -> Vec<ProjectCacheRow> {
    registry
        .projects
        .iter()
        .map(|e| ProjectCacheRow {
            bytes: sizes.get(&e.cache_path()),
            state: row_state(e, active_root),
            auto_located: e.auto_located,
            root: e.root.clone(),
            cache: e.cache.clone(),
            project_file: e.project_file.clone(),
            last_used_seconds: e.last_used_seconds,
        })
        .collect()
}

/// Which badge `entry` wears. Active wins over everything (the open
/// project's directory exists by construction), and a directory that is
/// no longer there is the next thing worth saying about it.
///
/// Auto-located is checked before orphaned because an auto-located
/// directory holds no `.cannet_prj` in the usual case — its project file
/// lives in the user's own folder, or nowhere at all — so it would read
/// as orphaned when it is nothing of the kind.
fn row_state(entry: &ProjectEntry, active_root: &Path) -> CacheRowState {
    if entry.root_path() == active_root {
        CacheRowState::Active
    } else if !entry.root_path().is_dir() {
        CacheRowState::Missing
    } else if entry.auto_located {
        CacheRowState::AutoLocated
    } else if !crate::project_dir::is_project_directory(&entry.root_path()) {
        CacheRowState::Orphaned
    } else {
        CacheRowState::Known
    }
}

/// Empty `cache` without removing it — the Clear half of ADR 0042 §5's
/// table. The cache directory and the registry entry both stay, so the
/// project keeps working and the row keeps its place.
///
/// A cache directory that is already gone is nothing to clear, not a
/// failure: the row still lists, and Clear on it is a no-op.
fn empty_cache_dir(cache: &Path) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(cache) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let removed = if entry.file_type().is_ok_and(|t| t.is_dir()) {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        removed?;
    }
    Ok(())
}

/// The entry for `root`, or a message naming what the user asked about.
fn entry_for(registry: &ProjectRegistry, root: &Path) -> Result<ProjectEntry, String> {
    registry
        .projects
        .iter()
        .find(|e| e.root_path() == root)
        .cloned()
        .ok_or_else(|| format!("no project directory recorded at {}", root.display()))
}

/// Clear one project's cached data: empty the cache directory, keep the
/// cache directory and the registry entry, touch nothing else. The
/// active project does not come through here — its store is mapped, so
/// [`clear_project_cache`] clears it in place instead.
fn clear_cache(config_dir: &Path, root: &Path) -> Result<ProjectEntry, String> {
    let entry = entry_for(&read(config_dir), root)?;
    empty_cache_dir(&entry.cache_path())
        .map_err(|e| format!("failed to clear the cache for {}: {e}", entry.root))?;
    Ok(entry)
}

/// Delete one project's cache directory and forget the project. **The
/// project directory itself is not touched** (ADR 0042 §5).
fn delete_cache(config_dir: &Path, root: &Path) -> Result<ProjectEntry, String> {
    let entry = entry_for(&read(config_dir), root)?;
    if let Err(e) = std::fs::remove_dir_all(entry.cache_path()) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(format!(
                "failed to remove the cache directory for {}: {e}",
                entry.root
            ));
        }
    }
    forget(config_dir, root).map_err(|e| format!("failed to update the project registry: {e}"))?;
    Ok(entry)
}

/// Empty every recorded project's cache except `except` — the active
/// one, which [`clear_all_project_caches`] clears through the live store.
/// Removes nothing: every cache directory and every registry entry stays.
fn clear_caches_except(config_dir: &Path, except: &Path) -> Result<(), String> {
    let mut failures = Vec::new();
    for entry in &read(config_dir).projects {
        if entry.root_path() == except {
            continue;
        }
        if let Err(e) = empty_cache_dir(&entry.cache_path()) {
            failures.push(format!("{}: {e}", entry.root));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "some caches could not be cleared — {}",
            failures.join("; ")
        ))
    }
}

/// The project cache list: every project directory cannet has worked in,
/// and what its cache held when it was last measured (ADR 0042 §5).
///
/// **The rows come back before anything is walked** (ADR 0049). A size is
/// a directory walk per cache, which ADR 0002 DS-8 calls expensive and
/// which this command therefore does not do: a cache never measured, or
/// one a Clear or Delete has invalidated, lists with `bytes: None` and
/// the view shows it pending. Asking triggers one background walk of the
/// whole list — single-flight, so a settings view shown repeatedly costs
/// one at a time — and it announces itself with
/// [`PROJECT_CACHES_MEASURED_EVENT`].
///
/// `async` + [`off_async_workers`](crate::sampling::off_async_workers):
/// what is left is reading one small file out of the config directory,
/// but it is still the filesystem, and ADR 0048's rule is that the IPC
/// thread does none of it.
#[tauri::command]
pub async fn list_project_caches(app: tauri::AppHandle) -> Vec<ProjectCacheRow> {
    crate::sampling::off_async_workers(move || {
        let Ok(config) = crate::persisted_json::config_dir(&app) else {
            return Vec::new();
        };
        let registry = read(&config);
        let active = app.state::<crate::project_dir::ActiveProjectDir>().get();
        let sizes = app.state::<ProjectCacheSizes>();
        let rows = rows(&registry, active.root(), &sizes);
        let announce_app = app.clone();
        sizes.measure_in_background(
            registry
                .projects
                .iter()
                .map(ProjectEntry::cache_path)
                .collect(),
            Arc::new(|p: &Path| crate::trace_store::dir_footprint(p)),
            Arc::new(move || {
                let _ = announce_app.emit(PROJECT_CACHES_MEASURED_EVENT, ());
            }),
        );
        rows
    })
    .await
}

/// **Clear**: empty one project's cached data, keeping the cache
/// directory, the registry entry, and the project directory itself
/// (ADR 0042 §5).
///
/// The **active** project goes through the live-store clear instead of a
/// directory wipe — its scratch is mapped, and that path clears it in
/// place along with the derived caches that index it. For that project
/// Clear means "discard this session".
/// `async` + [`off_async_workers`](crate::sampling::off_async_workers):
/// emptying a cache directory is a walk and an unlink per file, so it
/// belongs on the blocking pool rather than on the IPC thread every
/// other command — the UI heartbeat included — is queued behind
/// (ADR 0048).
#[tauri::command]
pub async fn clear_project_cache(app: tauri::AppHandle, root: String) -> Result<(), String> {
    crate::sampling::off_async_workers(move || clear_project_cache_blocking(&app, root)).await
}

fn clear_project_cache_blocking(app: &tauri::AppHandle, root: String) -> Result<(), String> {
    let config = crate::persisted_json::config_dir(app)?;
    let root = PathBuf::from(root);
    if root == active_root(app) {
        crate::capture::clear_trace_store_now(app, &app.state::<crate::app_state::AppState>());
        crate::sys_info!(app, "project", "cleared the open project's data cache");
        return Ok(());
    }
    let entry = clear_cache(&config, &root).inspect_err(|msg| {
        crate::sys_warn!(app, "project", "{msg}");
    })?;
    // The figure this row was listing is now wrong, and a wrong figure
    // reads as a measurement. Drop it: the next listing shows it pending
    // and the walk it asks for fills it in.
    app.state::<ProjectCacheSizes>().forget(&entry.cache_path());
    crate::sys_info!(app, "project", "cleared the data cache for {}", entry.root);
    Ok(())
}

/// **Delete**: remove one project's cache directory and forget the
/// project (ADR 0042 §5). **The project directory itself is not
/// touched** — if the app may not create a `.cannet/` unasked, it
/// certainly may not remove one.
///
/// Refused for the active project, whose store is mapped: Clear is what
/// that project takes.
/// `async` + [`off_async_workers`](crate::sampling::off_async_workers)
/// for the same reason as [`clear_project_cache`]: the removal walks a
/// directory whose size is the user's capture history, and the observed
/// freeze was this command holding the IPC thread for 6.3 s (ADR 0048).
#[tauri::command]
pub async fn delete_project_cache(app: tauri::AppHandle, root: String) -> Result<(), String> {
    crate::sampling::off_async_workers(move || delete_project_cache_blocking(&app, root)).await
}

fn delete_project_cache_blocking(app: &tauri::AppHandle, root: String) -> Result<(), String> {
    let config = crate::persisted_json::config_dir(app)?;
    let root = PathBuf::from(root);
    if root == active_root(app) {
        return Err("the open project's cache directory is in use; clear it instead".into());
    }
    let entry = delete_cache(&config, &root).inspect_err(|msg| {
        crate::sys_warn!(app, "project", "{msg}");
    })?;
    app.state::<ProjectCacheSizes>().forget(&entry.cache_path());
    crate::sys_info!(app, "project", "removed the data cache for {}", entry.root);
    Ok(())
}

/// The project directory this session is working in — the row that wears
/// the `active` badge, whose Clear is the live-store clear and whose
/// Delete is refused.
fn active_root(app: &tauri::AppHandle) -> PathBuf {
    app.state::<crate::project_dir::ActiveProjectDir>()
        .get()
        .root()
        .to_path_buf()
}

/// **Clear all**: empty every project's cached data, removing nothing.
/// Every cache directory and every registry entry stays — including a
/// missing project's, whose row keeps its place at zero bytes so that
/// Clear means the same thing on every row.
/// `async` + [`off_async_workers`](crate::sampling::off_async_workers):
/// this is [`clear_project_cache`]'s walk once per registered project
/// (ADR 0048).
#[tauri::command]
pub async fn clear_all_project_caches(app: tauri::AppHandle) -> Result<(), String> {
    crate::sampling::off_async_workers(move || clear_all_project_caches_blocking(&app)).await
}

fn clear_all_project_caches_blocking(app: &tauri::AppHandle) -> Result<(), String> {
    let config = crate::persisted_json::config_dir(app)?;
    let active = active_root(app);
    let cleared = clear_caches_except(&config, &active);
    // The open project through the live-store path: its scratch is
    // mapped, so it is cleared in place rather than unlinked.
    if read(&config)
        .projects
        .iter()
        .any(|e| e.root_path() == active)
    {
        crate::capture::clear_trace_store_now(app, &app.state::<crate::app_state::AppState>());
    }
    app.state::<ProjectCacheSizes>().forget_all();
    cleared.inspect_err(|msg| {
        crate::sys_warn!(app, "project", "{msg}");
    })?;
    crate::sys_info!(app, "project", "cleared every project's data cache");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    /// A [`ProjectCacheSizes`] that has already measured every cache in
    /// `registry`, for the row tests that are about what a row *says*
    /// rather than when it says it.
    fn already_measured(registry: &ProjectRegistry) -> ProjectCacheSizes {
        let sizes = ProjectCacheSizes::default();
        let (tx, rx) = mpsc::channel();
        sizes.measure_in_background(
            registry
                .projects
                .iter()
                .map(ProjectEntry::cache_path)
                .collect(),
            Arc::new(|p: &Path| crate::trace_store::dir_footprint(p)),
            Arc::new(move || {
                let _ = tx.send(());
            }),
        );
        rx.recv_timeout(Duration::from_secs(10))
            .expect("the background walk never announced itself");
        sizes
    }

    /// The rows a listing would serve once every size has been measured.
    fn measured_rows(registry: &ProjectRegistry, active_root: &Path) -> Vec<ProjectCacheRow> {
        rows(registry, active_root, &already_measured(registry))
    }

    /// A project directory, resolved the way a session's is.
    fn project_dir(tmp: &Path, name: &str) -> ProjectDir {
        let root = tmp.join(name);
        std::fs::create_dir_all(root.join(crate::project_dir::WORKSPACE_DIR)).unwrap();
        std::fs::write(root.join("p.cannet_prj"), "{}").unwrap();
        crate::project_dir::resolve(Some(&root.join("p.cannet_prj")), &tmp.join("cache-root"))
    }

    /// A cache directory with `files` small files in it, spread over a
    /// handful of subdirectories the way a real one is (raw segments,
    /// `signals/`, `filter/`).
    ///
    /// **The count is the cost, not the byte total.** What a delete pays
    /// for is the directory walk and one unlink per entry; a cache that
    /// is gigabytes because a few segment files are large removes faster
    /// than one that is megabytes across tens of thousands of pyramid
    /// levels. So the fixture is many tiny files, which reproduces the
    /// freeze without writing the gigabytes.
    fn cache_with_many_files(cache: &Path, files: usize) {
        let subdirs = ["", "signals", "filter", "signals/parked"];
        for sub in subdirs {
            std::fs::create_dir_all(cache.join(sub)).unwrap();
        }
        for i in 0..files {
            let sub = subdirs[i % subdirs.len()];
            std::fs::write(cache.join(sub).join(format!("seg.{i:06}")), b"x").unwrap();
        }
    }

    /// The heartbeat's cadence in the test below, fast enough that a
    /// stall of even a fraction of the removal shows up as a missing
    /// beat.
    const BEAT: std::time::Duration = std::time::Duration::from_millis(5);

    #[test]
    fn deleting_a_large_project_cache_never_stops_the_ui_heartbeat() {
        // Exit criterion: the observed freeze (2026-09-22, 6.3 s with no
        // UI heartbeat, then "removed the data cache for …") must not be
        // reproducible. The mechanism was the command being synchronous:
        // a synchronous Tauri command runs on the IPC thread, and
        // `report_js_heap` — the heartbeat — is a synchronous command
        // too, so it could not land until the removal returned.
        //
        // This thread stands in for the IPC thread, and dispatches the
        // removal exactly as Tauri dispatches `delete_project_cache`:
        // the command is `async`, so its future is spawned on the
        // runtime and the thread goes straight back to serving. The
        // heartbeat is what this thread then keeps doing. A regression to
        // a synchronous body cannot even be written this way — it would
        // have to run here, and no beat could land during it.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let dir = project_dir(tmp.path(), "big");
        record(&config, &dir, None, 1_700);
        cache_with_many_files(dir.cache_dir(), 4_000);

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .build()
            .unwrap();
        let root = dir.root().to_path_buf();
        let config_for_job = config.clone();
        let started = std::time::Instant::now();
        // The removal marks when it actually begins and ends, so the
        // beats below are judged against the removal itself rather than
        // against how promptly the runtime picked the job up.
        let (mark, marks) = std::sync::mpsc::channel::<std::time::Duration>();
        let at_start = mark.clone();
        let job = rt.spawn(crate::sampling::off_async_workers(move || {
            at_start.send(started.elapsed()).unwrap();
            let outcome = delete_cache(&config_for_job, &root);
            mark.send(started.elapsed()).unwrap();
            outcome
        }));

        let began = marks.recv().unwrap();
        let mut beats = vec![began];
        let ended = loop {
            match marks.recv_timeout(BEAT) {
                Ok(ended) => break ended,
                Err(_) => beats.push(started.elapsed()),
            }
        };
        beats.push(ended);
        rt.block_on(job).unwrap().unwrap();

        // The removal really happened, and really took long enough for a
        // stall to have been visible. The guard is expressed in beats,
        // not wall-clock: it only needs the removal to span a handful of
        // them for the assertions below to say anything, and wall-clock
        // varies by runner (785 ms on a Windows dev box, 74 ms on the
        // Linux CI runner) while 4,000 unlinks cannot finish within a
        // few beats on either.
        assert!(!dir.cache_dir().exists(), "the cache directory is gone");
        let took = ended.checked_sub(began).unwrap();
        assert!(
            took >= 4 * BEAT,
            "the fixture removed too fast to say anything ({took:?}); \
             grow cache_with_many_files's file count for this runner"
        );
        // The decisive one: on the synchronous body this is zero, because
        // the thread the heartbeat arrives on is the thread doing the
        // removal.
        assert!(
            beats.len() > 2,
            "no UI heartbeat landed in the {took:?} the removal took: it is \
             holding the thread the heartbeat arrives on"
        );
        // And the criterion as the host words it.
        let widest = beats
            .windows(2)
            .map(|w| w[1].saturating_sub(w[0]))
            .max()
            .unwrap();
        assert!(
            widest < std::time::Duration::from_millis(crate::crash::UI_HEARTBEAT_STALL_MS),
            "the heartbeat went missing for {widest:?}, which the host reports \
             as `frontend unresponsive`"
        );
    }

    #[test]
    fn an_absent_registry_reads_as_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read(tmp.path()), ProjectRegistry::default());
    }

    #[test]
    fn a_corrupt_registry_reads_as_empty() {
        // The list is a convenience; nothing it backs may fail because the
        // file was hand-mangled.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(REGISTRY_FILE), "not json at all").unwrap();
        assert_eq!(read(tmp.path()), ProjectRegistry::default());
    }

    #[test]
    fn recording_a_project_remembers_its_root_cache_and_project_file() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let dir = project_dir(tmp.path(), "work");

        record(&config, &dir, Some(&dir.root().join("p.cannet_prj")), 1_700);

        let entry = &read(&config).projects[0];
        assert_eq!(entry.root_path(), dir.root());
        assert_eq!(entry.cache_path(), dir.cache_dir());
        assert!(entry
            .project_file
            .as_ref()
            .unwrap()
            .ends_with("p.cannet_prj"));
        assert!(!entry.auto_located);
        assert_eq!(entry.last_used_seconds, 1_700);
    }

    #[test]
    fn recording_the_same_project_twice_refreshes_one_entry_rather_than_adding_another() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let dir = project_dir(tmp.path(), "work");

        record(&config, &dir, None, 1_700);
        record(&config, &dir, None, 1_800);

        let registry = read(&config);
        assert_eq!(registry.projects.len(), 1);
        assert_eq!(registry.projects[0].last_used_seconds, 1_800);
    }

    #[test]
    fn the_most_recently_used_project_is_listed_first() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let a = project_dir(tmp.path(), "a");
        let b = project_dir(tmp.path(), "b");

        record(&config, &a, None, 1_700);
        record(&config, &b, None, 1_800);
        record(&config, &a, None, 1_900);

        let roots: Vec<PathBuf> = read(&config)
            .projects
            .iter()
            .map(ProjectEntry::root_path)
            .collect();
        assert_eq!(roots, vec![a.root().to_path_buf(), b.root().to_path_buf()]);
    }

    #[test]
    fn an_auto_located_directory_is_recorded_as_one() {
        // The rows that get the `Save as…` offer (ADR 0042 §5) are exactly
        // the ones cannet chose the location for.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let cache_root = tmp.path().join("cache-root");
        let dir = crate::project_dir::resolve(None, &cache_root);

        record(&config, &dir, None, 1_700);

        assert!(read(&config).projects[0].auto_located);
    }

    /// A recorded project directory whose cache holds `bytes` bytes of
    /// something, ready for Clear and Delete to be aimed at it.
    fn recorded_with_cache(tmp: &Path, config: &Path, name: &str) -> ProjectDir {
        let dir = project_dir(tmp, name);
        std::fs::write(dir.cache_dir().join("meta.000000"), vec![0u8; 4_096]).unwrap();
        std::fs::create_dir_all(dir.cache_dir().join("signals")).unwrap();
        std::fs::write(
            dir.cache_dir().join("signals").join("l0.0000"),
            vec![0u8; 512],
        )
        .unwrap();
        record(config, &dir, None, 1_700);
        dir
    }

    #[test]
    fn clear_empties_the_cache_and_keeps_the_directory_and_the_entry() {
        // ADR 0042 §5's table, top row: cached data emptied, cache
        // directory kept, registry entry kept.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let dir = recorded_with_cache(tmp.path(), &config, "work");
        assert!(crate::trace_store::dir_footprint(dir.cache_dir()) > 0);

        clear_cache(&config, dir.root()).unwrap();

        assert_eq!(crate::trace_store::dir_footprint(dir.cache_dir()), 0);
        assert!(dir.cache_dir().is_dir(), "the cache directory stays");
        assert_eq!(read(&config).projects.len(), 1, "the entry stays");
    }

    #[test]
    fn delete_removes_the_cache_directory_and_forgets_the_project() {
        // ADR 0042 §5's table, bottom row: cached data gone, cache
        // directory removed, registry entry forgotten.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let dir = recorded_with_cache(tmp.path(), &config, "work");

        delete_cache(&config, dir.root()).unwrap();

        assert!(!dir.cache_dir().exists(), "the cache directory is removed");
        assert!(
            read(&config).projects.is_empty(),
            "the project is forgotten"
        );
    }

    #[test]
    fn neither_clear_nor_delete_touches_the_project_directory() {
        // The inviolable column of ADR 0042 §5's table, and decision 2
        // applied to the reclaim path: if the app may not create a
        // `.cannet/` unasked, it certainly may not remove one. True of a
        // directory the user made *and* of one cannet auto-located.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let theirs = recorded_with_cache(tmp.path(), &config, "theirs");
        let auto = crate::project_dir::resolve(None, &tmp.path().join("cache-root"));
        record(&config, &auto, None, 1_800);

        clear_cache(&config, theirs.root()).unwrap();
        delete_cache(&config, theirs.root()).unwrap();
        clear_cache(&config, auto.root()).unwrap();
        delete_cache(&config, auto.root()).unwrap();

        for dir in [&theirs, &auto] {
            assert!(dir.root().is_dir(), "{} was removed", dir.root().display());
            assert!(
                dir.workspace_dir().join("settings.json").is_file(),
                "{} lost its workspace files",
                dir.root().display()
            );
        }
        assert!(theirs.root().join("p.cannet_prj").is_file());
    }

    #[test]
    fn clear_all_empties_every_cache_and_removes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let a = recorded_with_cache(tmp.path(), &config, "a");
        let b = recorded_with_cache(tmp.path(), &config, "b");

        clear_caches_except(&config, Path::new("nothing-is-active")).unwrap();

        for dir in [&a, &b] {
            assert_eq!(crate::trace_store::dir_footprint(dir.cache_dir()), 0);
            assert!(dir.cache_dir().is_dir());
        }
        assert_eq!(read(&config).projects.len(), 2, "nothing is forgotten");
    }

    #[test]
    fn clear_all_leaves_the_active_projects_cache_to_the_live_store() {
        // The open project's scratch is mapped; the command clears it in
        // place instead, so the directory sweep must skip it.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let active = recorded_with_cache(tmp.path(), &config, "active");
        let other = recorded_with_cache(tmp.path(), &config, "other");

        clear_caches_except(&config, active.root()).unwrap();

        assert!(crate::trace_store::dir_footprint(active.cache_dir()) > 0);
        assert_eq!(crate::trace_store::dir_footprint(other.cache_dir()), 0);
    }

    #[test]
    fn a_project_directory_deleted_outside_the_app_still_lists_and_can_be_cleared() {
        // A stale entry must degrade gracefully: the row lists as missing
        // at whatever the cache still holds, Clear means what it means on
        // every other row, and nothing here can fail — which is what keeps
        // it from stopping the panel opening.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let gone = recorded_with_cache(tmp.path(), &config, "gone");
        std::fs::remove_dir_all(gone.root()).unwrap();

        let listed = measured_rows(&read(&config), Path::new("some-other-project"));

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].state, CacheRowState::Missing);
        assert!(
            listed[0].bytes.is_some_and(|b| b > 0),
            "its cache is still on disk"
        );

        clear_cache(&config, gone.root()).unwrap();
        let listed = measured_rows(&read(&config), Path::new("some-other-project"));
        assert_eq!(listed[0].state, CacheRowState::Missing, "the row stays");
        assert_eq!(listed[0].bytes, Some(0));
    }

    // --- the cache list answers before it measures (ADR 0049) ---

    #[test]
    fn rows_list_with_their_sizes_pending_before_any_walk_has_run() {
        // A row's size is a directory walk per cache, which ADR 0002 DS-8
        // calls expensive. The listing answers with the rows and says the
        // sizes are not in yet, rather than holding the view for them.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        recorded_with_cache(tmp.path(), &config, "a");
        recorded_with_cache(tmp.path(), &config, "b");

        let listed = rows(
            &read(&config),
            Path::new("elsewhere"),
            &ProjectCacheSizes::default(),
        );

        assert_eq!(listed.len(), 2);
        assert!(
            listed.iter().all(|r| r.bytes.is_none()),
            "an unmeasured cache lists pending, not at zero"
        );
    }

    #[test]
    fn overlapping_listings_cost_one_walk_at_a_time() {
        // Single-flight. The settings view re-asks on every show, on
        // `project-dir-changed` and after every action; without this each
        // one would start its own walk of every registered cache.
        let sizes = ProjectCacheSizes::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let counted = Arc::clone(&calls);
        let held = Arc::clone(&gate);
        let measure: Arc<dyn Fn(&Path) -> u64 + Send + Sync> = Arc::new(move |_: &Path| {
            counted.fetch_add(1, Ordering::SeqCst);
            let (lock, cv) = &*held;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            7
        });
        let (tx, rx) = mpsc::channel();
        let announce: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _ = tx.send(());
        });
        let caches = vec![PathBuf::from("one")];

        for _ in 0..8 {
            sizes.measure_in_background(
                caches.clone(),
                Arc::clone(&measure),
                Arc::clone(&announce),
            );
        }
        {
            let (lock, cv) = &*gate;
            *lock.lock().unwrap() = true;
            cv.notify_all();
        }
        // The walk in flight drains the requests that piled up behind it,
        // so it runs at most twice: the one that started, and one round
        // for everything asked while it ran.
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(sizes.get(Path::new("one")), Some(7));
        // Drain any second round before counting.
        let _ = rx.recv_timeout(Duration::from_millis(500));
        let measured = calls.load(Ordering::SeqCst);
        assert!(
            measured <= 2,
            "eight overlapping listings must not cost eight walks (measured {measured})"
        );
    }

    #[test]
    fn clearing_a_cache_drops_its_measured_size_so_the_row_reads_pending() {
        // A figure taken before a Clear is not a measurement of what the
        // cache holds now; it just reads like one.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let dir = recorded_with_cache(tmp.path(), &config, "a");
        let registry = read(&config);
        let sizes = already_measured(&registry);
        assert!(sizes.get(dir.cache_dir()).is_some_and(|b| b > 0));

        sizes.forget(dir.cache_dir());

        assert_eq!(
            rows(&registry, Path::new("elsewhere"), &sizes)[0].bytes,
            None
        );
    }

    #[test]
    fn a_row_wears_exactly_one_badge_and_active_outranks_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let cache_root = tmp.path().join("cache-root");
        let open = project_dir(tmp.path(), "open");
        let theirs = project_dir(tmp.path(), "theirs");
        let auto = crate::project_dir::resolve(None, &cache_root);
        let gone = project_dir(tmp.path(), "gone");
        for dir in [&open, &theirs, &auto, &gone] {
            record(&config, dir, None, 1_700);
        }
        std::fs::remove_dir_all(gone.root()).unwrap();

        let listed = measured_rows(&read(&config), open.root());
        let state_of = |root: &Path| {
            listed
                .iter()
                .find(|r| Path::new(&r.root) == root)
                .expect("every entry lists")
                .state
        };
        assert_eq!(state_of(open.root()), CacheRowState::Active);
        assert_eq!(state_of(theirs.root()), CacheRowState::Known);
        assert_eq!(state_of(auto.root()), CacheRowState::AutoLocated);
        assert_eq!(state_of(gone.root()), CacheRowState::Missing);
    }

    #[test]
    fn a_directory_whose_project_file_moved_away_is_listed_as_orphaned() {
        // ADR 0042 §2: moving the `.cannet_prj` out un-pairs it, and the
        // orphaned `.cannet/` is what the registry surfaces so its cache
        // can be reclaimed. Without the badge it would read as a live
        // project the user still has.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let dir = project_dir(tmp.path(), "work");
        record(&config, &dir, None, 1_700);
        assert_eq!(
            measured_rows(&read(&config), Path::new("elsewhere"))[0].state,
            CacheRowState::Known
        );

        std::fs::remove_file(dir.root().join("p.cannet_prj")).unwrap();

        let listed = measured_rows(&read(&config), Path::new("elsewhere"));
        assert_eq!(listed[0].state, CacheRowState::Orphaned);
        assert!(dir.workspace_dir().is_dir(), "the .cannet/ is still there");
    }

    #[test]
    fn an_auto_located_directory_is_not_mistaken_for_an_orphan() {
        // It holds no `.cannet_prj` — its project file lives in the
        // user's own folder, or nowhere at all — so the auto-located
        // badge has to be decided first.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let auto = crate::project_dir::resolve(None, &tmp.path().join("cache-root"));
        record(&config, &auto, None, 1_700);

        assert_eq!(
            measured_rows(&read(&config), Path::new("elsewhere"))[0].state,
            CacheRowState::AutoLocated
        );
    }

    #[test]
    fn an_open_auto_located_project_wears_the_active_badge_and_still_says_it_is_auto_located() {
        // The `Save as…` offer belongs on the open auto-located project —
        // the one place a user sees their project is living in cache
        // space — so the badge (active) must not hide the fact.
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let auto = crate::project_dir::resolve(None, &tmp.path().join("cache-root"));
        record(&config, &auto, None, 1_700);

        let listed = measured_rows(&read(&config), auto.root());

        assert_eq!(listed[0].state, CacheRowState::Active);
        assert!(listed[0].auto_located);
    }

    #[test]
    fn clearing_a_cache_that_is_already_gone_is_a_no_op_rather_than_a_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let dir = recorded_with_cache(tmp.path(), &config, "work");
        std::fs::remove_dir_all(dir.cache_dir()).unwrap();

        clear_cache(&config, dir.root()).unwrap();
        delete_cache(&config, dir.root()).unwrap();

        assert!(read(&config).projects.is_empty());
    }

    #[test]
    fn an_action_aimed_at_a_project_that_is_not_recorded_says_so() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let error = clear_cache(&config, Path::new("nowhere")).unwrap_err();
        assert!(error.contains("nowhere"), "{error}");
    }

    #[test]
    fn forgetting_a_project_leaves_the_others_and_the_directory_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let a = project_dir(tmp.path(), "a");
        let b = project_dir(tmp.path(), "b");
        record(&config, &a, None, 1_700);
        record(&config, &b, None, 1_800);

        forget(&config, a.root()).unwrap();

        let registry = read(&config);
        assert_eq!(registry.projects.len(), 1);
        assert_eq!(registry.projects[0].root_path(), b.root());
        assert!(
            a.root().join(crate::project_dir::WORKSPACE_DIR).is_dir(),
            "forgetting is bookkeeping, not deletion"
        );
    }
}
