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

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::project_dir::ProjectDir;

/// File name under `app_config_dir`.
const REGISTRY_FILE: &str = "projects.json";

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

/// One project's row in the cache list: where it is, what its cache
/// holds, and what may be done to it.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectCacheRow {
    root: String,
    cache: String,
    project_file: Option<String>,
    /// Bytes the cache directory currently holds — measured **on
    /// demand**, never on a timer: the walk is not cheap (ADR 0002 DS-8).
    bytes: u64,
    state: CacheRowState,
    /// Whether cannet chose this directory's location. Separate from
    /// `state`, which is the one badge a row wears: the *open* project may
    /// also be auto-located, and it is exactly that row the `Save as…`
    /// offer belongs on (ADR 0042 §5).
    auto_located: bool,
    last_used_seconds: u64,
}

/// Build the cache list from `registry`, measuring each cache as it goes.
///
/// A row is produced for every entry, whatever the filesystem says: a
/// project directory deleted outside the app shows as
/// [`CacheRowState::Missing`] at whatever its cache still holds, and one
/// whose cache is gone shows zero bytes. Nothing here can fail, which is
/// what keeps a stale entry from stopping the panel opening.
fn rows(registry: &ProjectRegistry, active_root: &Path) -> Vec<ProjectCacheRow> {
    registry
        .projects
        .iter()
        .map(|e| ProjectCacheRow {
            bytes: crate::trace_store::dir_footprint(&e.cache_path()),
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
/// with what its cache currently holds (ADR 0042 §5).
///
/// Sizes are measured **when this is called** — the directory walk is too
/// expensive to put on a timer (ADR 0002 DS-8), so the view asks when it
/// opens and when an action changes something.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn list_project_caches(app: tauri::AppHandle) -> Vec<ProjectCacheRow> {
    let Ok(config) = crate::persisted_json::config_dir(&app) else {
        return Vec::new();
    };
    let active = app.state::<crate::project_dir::ActiveProjectDir>().get();
    rows(&read(&config), active.root())
}

/// **Clear**: empty one project's cached data, keeping the cache
/// directory, the registry entry, and the project directory itself
/// (ADR 0042 §5).
///
/// The **active** project goes through the live-store clear instead of a
/// directory wipe — its scratch is mapped, and that path clears it in
/// place along with the derived caches that index it. For that project
/// Clear means "discard this session".
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn clear_project_cache(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    root: String,
) -> Result<(), String> {
    let config = crate::persisted_json::config_dir(&app)?;
    let root = PathBuf::from(root);
    if root == active_root(&app) {
        crate::capture::clear_trace_store(app.clone(), state);
        crate::sys_info!(&app, "project", "cleared the open project's data cache");
        return Ok(());
    }
    let entry = clear_cache(&config, &root).inspect_err(|msg| {
        crate::sys_warn!(&app, "project", "{msg}");
    })?;
    crate::sys_info!(&app, "project", "cleared the data cache for {}", entry.root);
    Ok(())
}

/// **Delete**: remove one project's cache directory and forget the
/// project (ADR 0042 §5). **The project directory itself is not
/// touched** — if the app may not create a `.cannet/` unasked, it
/// certainly may not remove one.
///
/// Refused for the active project, whose store is mapped: Clear is what
/// that project takes.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn delete_project_cache(app: tauri::AppHandle, root: String) -> Result<(), String> {
    let config = crate::persisted_json::config_dir(&app)?;
    let root = PathBuf::from(root);
    if root == active_root(&app) {
        return Err("the open project's cache directory is in use; clear it instead".into());
    }
    let entry = delete_cache(&config, &root).inspect_err(|msg| {
        crate::sys_warn!(&app, "project", "{msg}");
    })?;
    crate::sys_info!(&app, "project", "removed the data cache for {}", entry.root);
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
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn clear_all_project_caches(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<(), String> {
    let config = crate::persisted_json::config_dir(&app)?;
    let active = active_root(&app);
    let cleared = clear_caches_except(&config, &active);
    // The open project through the live-store path: its scratch is
    // mapped, so it is cleared in place rather than unlinked.
    if read(&config)
        .projects
        .iter()
        .any(|e| e.root_path() == active)
    {
        crate::capture::clear_trace_store(app.clone(), state);
    }
    cleared.inspect_err(|msg| {
        crate::sys_warn!(&app, "project", "{msg}");
    })?;
    crate::sys_info!(&app, "project", "cleared every project's data cache");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project directory, resolved the way a session's is.
    fn project_dir(tmp: &Path, name: &str) -> ProjectDir {
        let root = tmp.join(name);
        std::fs::create_dir_all(root.join(crate::project_dir::WORKSPACE_DIR)).unwrap();
        std::fs::write(root.join("p.cannet_prj"), "{}").unwrap();
        crate::project_dir::resolve(Some(&root.join("p.cannet_prj")), &tmp.join("cache-root"))
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

        let listed = rows(&read(&config), Path::new("some-other-project"));

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].state, CacheRowState::Missing);
        assert!(listed[0].bytes > 0, "its cache is still on disk");

        clear_cache(&config, gone.root()).unwrap();
        let listed = rows(&read(&config), Path::new("some-other-project"));
        assert_eq!(listed[0].state, CacheRowState::Missing, "the row stays");
        assert_eq!(listed[0].bytes, 0);
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

        let listed = rows(&read(&config), open.root());
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
            rows(&read(&config), Path::new("elsewhere"))[0].state,
            CacheRowState::Known
        );

        std::fs::remove_file(dir.root().join("p.cannet_prj")).unwrap();

        let listed = rows(&read(&config), Path::new("elsewhere"));
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
            rows(&read(&config), Path::new("elsewhere"))[0].state,
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

        let listed = rows(&read(&config), auto.root());

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
