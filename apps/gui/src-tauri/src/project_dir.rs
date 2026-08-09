//! The project directory — where a session's scoped data lives
//! (ADR 0042).
//!
//! Every session is rooted in a **project directory**: a directory
//! holding a `.cannet_prj` *beside* a `.cannet/`. The pair identifies
//! one; neither alone does. `.cannet/` carries the workspace-scoped
//! settings and state, the `.gitignore` that keeps the cache out of
//! version control, and `cache/` — a link to cannet-managed local
//! storage.
//!
//! ```text
//! <project dir>/
//!   .cannet/
//!     settings.json        workspace-scoped settings (overrides)
//!     state.json           project-scoped view state
//!     cache/               link → cannet-managed local cache
//!     .gitignore           ignores cache/
//!   my_project.cannet_prj
//! ```
//!
//! **There is no anonymous mode.** When the user has not put a
//! `.cannet/` beside their project file — or has no project file at all
//! — [`resolve`] hands back an *auto-located* project directory inside
//! cannet's own cache space. It is an ordinary project directory that
//! happens to be somewhere cannet chose, so every read has one code
//! path rather than one plus a global fallback.
//!
//! **cannet never creates a `.cannet/` as a side effect** (ADR 0042 §2).
//! It writes one only in its own cache space. A `.cannet/` the user laid
//! down themselves is *filled in* — the missing files and the cache link
//! are created inside it — but one is never conjured in a directory just
//! because a project file was opened there.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;
use uuid::Uuid;

/// The scoped-data subdirectory inside a project directory.
pub const WORKSPACE_DIR: &str = ".cannet";

/// The cache link inside [`WORKSPACE_DIR`], pointing at cannet-managed
/// local storage.
pub const CACHE_LINK: &str = "cache";

/// Subdirectory of cannet's cache space holding auto-located project
/// directories — the ones cannet creates because the user named none.
const AUTO_PROJECTS_SUBDIR: &str = "projects";

/// Subdirectory of cannet's cache space holding the per-project cache
/// directories that [`CACHE_LINK`] points at.
const LOCAL_CACHES_SUBDIR: &str = "cache";

/// Key for the auto-located project directory a session with no project
/// file gets. Never collides with a [`path_key`] digest, which is hex.
const UNSAVED_KEY: &str = "unsaved";

/// Contents of `.cannet/.gitignore`. A project directory is plausibly a
/// repository and the cache is a multi-GB scratch tree, so the ignore
/// ships with the directory rather than waiting to be noticed
/// (ADR 0042 §4).
const GITIGNORE_BODY: &str = "cache/\n";

/// A resolved project directory: the root the user's content sits in,
/// plus the local directory its cache actually lands in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDir {
    root: PathBuf,
    cache: PathBuf,
    auto_located: bool,
}

impl ProjectDir {
    /// The project directory itself — where the `.cannet_prj` and the
    /// user's DBC / RBS files live.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The workspace-scoped data directory, `<root>/.cannet` — the
    /// project's half of the two-scope split (ADR 0042 §3).
    pub fn workspace_dir(&self) -> PathBuf {
        self.root.join(WORKSPACE_DIR)
    }

    /// The directory the disk-spill scratch, signal pyramids, filter
    /// index, and notes root in (ADR 0002 DS-6/DS-7, ADR 0042 §4).
    ///
    /// This is the **link target**, not `.cannet/cache` itself. The two
    /// name the same bytes when the link exists, and opening the target
    /// directly means a project directory on a filesystem that cannot
    /// hold a reparse point (an SMB share is the motivating case — the
    /// very case the link exists for) still gets a working, local,
    /// memory-mappable cache. `.cannet/cache` remains the browsable
    /// view of it.
    pub fn cache_dir(&self) -> &Path {
        &self.cache
    }

    /// Whether cannet chose this directory's location because the user
    /// named none. Not a mode — an auto-located directory behaves
    /// exactly like one the user made.
    pub fn is_auto_located(&self) -> bool {
        self.auto_located
    }

    /// Create everything this directory needs that isn't there yet: the
    /// root, the local cache directory, and the `.cannet/` contents.
    /// Idempotent; see [`populate_workspace_dir`].
    fn create(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.root)?;
        std::fs::create_dir_all(&self.cache)?;
        populate_workspace_dir(&self.root, &self.cache)
    }
}

/// Whether the session's active project directory is auto-located
/// ([`ProjectDir::is_auto_located`]) rather than one the user pointed
/// cannet at explicitly.
///
/// The one caller today is the autosave-on-exit close flow: it must act
/// only on a project directory the user chose, never invent one for an
/// auto-located or unsaved session. Queried fresh at close time rather
/// than mirrored into frontend state, since the active directory can
/// change mid-session (opening a project, Save As) and the close flow
/// only ever needs the answer at the moment it decides.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn active_project_is_auto_located(app: tauri::AppHandle) -> bool {
    app.state::<ActiveProjectDir>().get().is_auto_located()
}

/// Whether `dir` is a project directory: it holds a `.cannet_prj`
/// *beside* a `.cannet/` (ADR 0042 §1). Either alone is not one — a
/// loose project file gets an auto-located directory, and an orphaned
/// `.cannet/` is a directory whose project file moved away.
pub fn is_project_directory(dir: &Path) -> bool {
    dir.join(WORKSPACE_DIR).is_dir() && holds_a_project_file(dir)
}

/// Whether `dir` directly contains at least one `*.cannet_prj`.
fn holds_a_project_file(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.path()
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cannet_prj"))
    })
}

/// Resolve the project directory for `project_file`, creating whatever
/// is missing, and return it ready to use.
///
/// `cache_root` is cannet's own cache space (Tauri's `app_cache_dir`).
/// Two outcomes, and only two:
///
/// - **The user pointed at one.** `project_file`'s own directory is a
///   project directory ([`is_project_directory`]), so that is the
///   project directory. Anything missing inside its `.cannet/` is
///   filled in; nothing outside it is touched.
/// - **Everything else** — a loose project file, an orphaned `.cannet/`
///   whose project file moved away, or no project file at all — gets an
///   *auto-located* directory under
///   `<cache_root>/projects/`, keyed so that reopening the same project
///   file lands back on the same directory (and therefore the same
///   capture).
///
/// The cache directory is always `<cache_root>/cache/<hash of the
/// project directory's path>` (ADR 0042 §4, decision 12): the cache
/// belongs to the directory, not to the document inside it.
///
/// **Resolution always succeeds.** The paths are well-defined whether or
/// not the filesystem cooperates, so a creation failure is logged and
/// the resolved directory returned anyway — the caller has one code
/// path, and the degradation surfaces where it matters (the trace store
/// falls back to RAM when it can't open its scratch, as it already did).
pub fn resolve(project_file: Option<&Path>, cache_root: &Path) -> ProjectDir {
    let named = project_file
        .and_then(Path::parent)
        .filter(|dir| is_project_directory(dir))
        .map(Path::to_path_buf);
    match named {
        Some(dir) => prepare(dir, cache_root, false),
        None => prepare(
            cache_root
                .join(AUTO_PROJECTS_SUBDIR)
                .join(auto_location_key(project_file)),
            cache_root,
            true,
        ),
    }
}

/// Make `root` a project directory — creating its `.cannet/` — and return
/// it ready to use.
///
/// This is the **Save As** path, and one of only two places cannet writes
/// a `.cannet/` into storage the user chose (ADR 0042 §2). It is
/// legitimate here precisely because the user named the destination in a
/// save dialog: an explicit act, not a consequence of opening something.
/// Everywhere else, [`resolve`] auto-locates rather than creating one.
pub fn create_at(root: &Path, cache_root: &Path) -> ProjectDir {
    prepare(root.to_path_buf(), cache_root, false)
}

/// Assemble the [`ProjectDir`] for `root` and create whatever is missing.
///
/// The cache directory is always `<cache_root>/cache/<hash of the project
/// directory's path>` (ADR 0042 §4, decision 12): the cache belongs to the
/// directory, not to the document inside it. Creation failure is logged
/// rather than propagated — see [`resolve`].
fn prepare(root: PathBuf, cache_root: &Path, auto_located: bool) -> ProjectDir {
    let cache = cache_root.join(LOCAL_CACHES_SUBDIR).join(path_key(&root));
    let dir = ProjectDir {
        root,
        cache,
        auto_located,
    };
    if let Err(e) = dir.create() {
        tracing::error!(
            root = %dir.root.display(),
            error = %e,
            "could not create the project directory; \
             this session has no on-disk scoped storage"
        );
    }
    dir
}

/// The workspace-scoped documents a project directory carries — what
/// [`carry_workspace_scope`] brings across on Save As.
const WORKSPACE_SCOPE_FILES: [&str; 2] = ["settings.json", "state.json"];

/// Copy `from`'s workspace-scoped files into `to` — the Save As half of
/// ADR 0042 §6.
///
/// Save As is cannet's managed workflow, so the project's data goes where
/// the user asked cannet to put the project; arriving without it would be
/// a surprise. (The capture travels separately — it is the trace store
/// that owns those files, and it moves them under its own lock.)
///
/// A destination file that already says something is **not** overwritten.
/// That is the same directory ADR 0042 §6 says starts clean when the user
/// made it by hand: what they wrote there is their declaration for this
/// project, and a Save As into it does not get to overrule it.
pub fn carry_workspace_scope(from: &ProjectDir, to: &ProjectDir) {
    let (from, to) = (from.workspace_dir(), to.workspace_dir());
    if from == to {
        return;
    }
    for file in WORKSPACE_SCOPE_FILES {
        let dest = to.join(file);
        if !crate::persisted_json::declares_nothing(&dest) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(from.join(file)) else {
            continue;
        };
        if let Err(e) = std::fs::write(&dest, text) {
            tracing::warn!(
                file = %dest.display(),
                error = %e,
                "could not carry a workspace file to the new project directory"
            );
        }
    }
}

/// The project directory this session is rooted in — managed state, held
/// behind a lock because the session can move to a different one without
/// relaunching (ADR 0042 §1: opening another project, or Save As).
///
/// It carries the cache space it resolves against, so a re-root does not
/// need the `App` the original resolution had.
pub struct ActiveProjectDir {
    cache_root: PathBuf,
    current: Mutex<ProjectDir>,
}

impl ActiveProjectDir {
    /// Start out rooted in `current`, resolved against `cache_root`.
    pub fn new(cache_root: PathBuf, current: ProjectDir) -> Self {
        Self {
            cache_root,
            current: Mutex::new(current),
        }
    }

    /// The project directory in force right now.
    pub fn get(&self) -> ProjectDir {
        self.current
            .lock()
            .expect("project dir mutex poisoned")
            .clone()
    }

    /// cannet's own cache space — where auto-located project directories
    /// and every project's cache live.
    pub fn cache_root(&self) -> &Path {
        &self.cache_root
    }

    /// Root the session in `dir` from now on. Only the host's re-root path
    /// calls this: swapping the stores over is the rest of the job.
    pub fn set(&self, dir: ProjectDir) {
        *self.current.lock().expect("project dir mutex poisoned") = dir;
    }
}

/// The auto-located directory's name under `<cache_root>/projects/`.
/// Keyed by the project file's path so reopening a loose `.cannet_prj`
/// finds the same directory — and so its capture — rather than a fresh
/// one each time. A session with no project file gets [`UNSAVED_KEY`].
fn auto_location_key(project_file: Option<&Path>) -> String {
    match project_file {
        Some(p) => path_key(p),
        None => UNSAVED_KEY.to_string(),
    }
}

/// A stable, filesystem-safe key for `path`: the hex form of a v5
/// (name-based, SHA-1) UUID over the path text. Deterministic across
/// runs and builds — unlike `DefaultHasher`, whose output is explicitly
/// not stable — which is what a key naming an on-disk directory needs.
/// Compared as written: no case folding or canonicalisation, so the same
/// path string always keys the same directory.
fn path_key(path: &Path) -> String {
    Uuid::new_v5(&Uuid::NAMESPACE_URL, path.to_string_lossy().as_bytes())
        .simple()
        .to_string()
}

/// Create or complete `<root>/.cannet`: the ignore file, the two empty
/// scope files, and the `cache/` link to `cache_dir`.
///
/// Idempotent and additive — an existing file is left exactly as the
/// user wrote it. This is also the "fill in a hand-created `.cannet/`"
/// path (ADR 0042 §6): the user made the directory, cannet furnishes it.
fn populate_workspace_dir(root: &Path, cache_dir: &Path) -> std::io::Result<()> {
    let ws = root.join(WORKSPACE_DIR);
    std::fs::create_dir_all(&ws)?;
    write_if_absent(&ws.join(".gitignore"), GITIGNORE_BODY)?;
    // An *empty* override document, not a dump of the defaults: a
    // workspace value overrides the user value for the same key
    // (ADR 0042 §3), so writing every key here would shadow the user's
    // settings with defaults the moment the directory was created.
    write_if_absent(&ws.join("settings.json"), "{}\n")?;
    write_if_absent(&ws.join("state.json"), "{}\n")?;
    link_cache_dir(&ws.join(CACHE_LINK), cache_dir);
    Ok(())
}

/// Write `body` to `path` only if nothing is there yet.
fn write_if_absent(path: &Path, body: &str) -> std::io::Result<()> {
    if path.symlink_metadata().is_ok() {
        return Ok(());
    }
    std::fs::write(path, body)
}

/// Point `link` at `target`, best-effort.
///
/// The link is the browsable view of the cache, not the path the store
/// opens ([`ProjectDir::cache_dir`]), so a filesystem that refuses it
/// costs the user a shortcut and nothing else — hence a logged warning
/// rather than a failed resolve.
fn link_cache_dir(link: &Path, target: &Path) {
    if link.symlink_metadata().is_ok() {
        return;
    }
    if let Err(e) = create_dir_link(link, target) {
        tracing::warn!(
            link = %link.display(),
            target = %target.display(),
            error = %e,
            "could not link the workspace cache directory; \
             the cache is still used at its real location"
        );
    }
}

/// Create `link` as a directory link to `target`.
///
/// Windows gets a **directory junction**, not a symbolic link: a symlink
/// needs `SeCreateSymbolicLinkPrivilege` (administrator, or Developer
/// Mode), a junction needs neither, and the one link cannet creates is a
/// directory. `mklink` is a `cmd` builtin rather than an executable, so
/// it has to be run through `cmd /C`; the alternative is the
/// `FSCTL_SET_REPARSE_POINT` ioctl, which this crate cannot reach
/// (`unsafe_code = "forbid"`).
///
/// The command line is built with `raw_arg` and both paths explicitly
/// quoted. `Command::arg` quotes only what *MSVC* parsing needs, which
/// leaves `cmd`'s own metacharacters — `&`, `^`, `|` — live in a
/// directory name a user is perfectly entitled to use. A Windows path
/// can never contain `"`, so quoting is sound here.
#[cfg(windows)]
fn create_dir_link(link: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW from winbase.h; inlined to avoid a whole winapi
    // dependency for a single constant (as in `sidecar.rs`).
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("cmd")
        .arg("/C")
        .raw_arg(format!(
            "mklink /J \"{}\" \"{}\"",
            link.display(),
            target.display()
        ))
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "mklink /J failed: {}{}",
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

/// Create `link` as a directory symlink to `target`. Unprivileged
/// everywhere cannet runs off Windows.
#[cfg(not(windows))]
fn create_dir_link(link: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory that already looks like a project directory: a
    /// `.cannet/` beside a `.cannet_prj`, both made by hand as a user
    /// would.
    fn user_made_project_dir(root: &Path) {
        std::fs::create_dir_all(root.join(WORKSPACE_DIR)).unwrap();
        std::fs::write(root.join("p.cannet_prj"), "{}").unwrap();
    }

    #[test]
    fn a_cannet_prj_beside_a_cannet_dir_is_a_project_directory() {
        // ADR 0042 §1: the *pair* identifies one, not either alone.
        let tmp = tempfile::tempdir().unwrap();
        let both = tmp.path().join("both");
        user_made_project_dir(&both);
        assert!(is_project_directory(&both));

        let loose = tmp.path().join("loose");
        std::fs::create_dir_all(&loose).unwrap();
        std::fs::write(loose.join("p.cannet_prj"), "{}").unwrap();
        assert!(!is_project_directory(&loose), "a loose project file");

        let orphan = tmp.path().join("orphan");
        std::fs::create_dir_all(orphan.join(WORKSPACE_DIR)).unwrap();
        assert!(!is_project_directory(&orphan), "an orphaned .cannet/");

        let empty = tmp.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(!is_project_directory(&empty));
    }

    #[test]
    fn a_project_file_beside_a_cannet_dir_resolves_to_its_own_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");
        let root = tmp.path().join("work");
        user_made_project_dir(&root);

        let pd = resolve(Some(&root.join("p.cannet_prj")), &cache_root);

        assert_eq!(pd.root(), root);
        assert!(!pd.is_auto_located());
    }

    #[test]
    fn a_loose_project_file_gets_an_auto_located_directory_and_the_users_folder_is_untouched() {
        // ADR 0042 §2: opening a loose `.cannet_prj` must change nothing
        // about the user's folder — no `.cannet/` appears in it.
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");
        let theirs = tmp.path().join("their-folder");
        std::fs::create_dir_all(&theirs).unwrap();
        let file = theirs.join("p.cannet_prj");
        std::fs::write(&file, "{}").unwrap();

        let pd = resolve(Some(&file), &cache_root);

        assert!(pd.is_auto_located());
        assert!(pd.root().starts_with(&cache_root));
        assert!(
            !theirs.join(WORKSPACE_DIR).exists(),
            "cannet must never create a .cannet/ as a side effect"
        );
        assert_eq!(
            std::fs::read_dir(&theirs).unwrap().count(),
            1,
            "the user's folder gained nothing"
        );
    }

    #[test]
    fn a_project_file_moved_away_from_its_cannet_dir_is_loose_again() {
        // ADR 0042 §2: moving the `.cannet_prj` out un-pairs it. The
        // directory it landed in is not a project directory just because
        // a `.cannet/` sits next door with nothing to pair with.
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");
        let root = tmp.path().join("work");
        std::fs::create_dir_all(root.join(WORKSPACE_DIR)).unwrap();
        let moved_in = root.join("elsewhere.txt");
        std::fs::write(&moved_in, "not a project").unwrap();

        let pd = resolve(Some(&root.join("gone.cannet_prj")), &cache_root);

        assert!(pd.is_auto_located());
        assert!(pd.root().starts_with(&cache_root));
    }

    #[test]
    fn no_project_file_still_gets_a_project_directory() {
        // The point of "always a project directory": there is no
        // anonymous branch for a caller to handle.
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");

        let pd = resolve(None, &cache_root);

        assert!(pd.is_auto_located());
        assert!(pd.root().join(WORKSPACE_DIR).is_dir());
        assert!(pd.cache_dir().is_dir());
    }

    #[test]
    fn reopening_the_same_project_file_lands_on_the_same_directory_and_cache() {
        // What makes a capture survive: the same project resolves to the
        // same cache directory every time.
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");
        let file = tmp.path().join("a.cannet_prj");
        std::fs::write(&file, "{}").unwrap();

        let first = resolve(Some(&file), &cache_root);
        let again = resolve(Some(&file), &cache_root);

        assert_eq!(first, again);
    }

    #[test]
    fn two_projects_get_two_caches_and_neither_disturbs_the_other() {
        // ADR 0042 §5 / task decision 6: opening B and returning to A
        // finds A's capture intact, because they never shared a cache.
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");
        let a = tmp.path().join("a.cannet_prj");
        let b = tmp.path().join("b.cannet_prj");
        std::fs::write(&a, "{}").unwrap();
        std::fs::write(&b, "{}").unwrap();

        let pa = resolve(Some(&a), &cache_root);
        std::fs::write(pa.cache_dir().join("meta.000000"), b"a's capture").unwrap();

        let pb = resolve(Some(&b), &cache_root);
        assert_ne!(pa.root(), pb.root());
        assert_ne!(pa.cache_dir(), pb.cache_dir());
        std::fs::write(pb.cache_dir().join("meta.000000"), b"b's capture").unwrap();

        let back = resolve(Some(&a), &cache_root);
        assert_eq!(
            std::fs::read(back.cache_dir().join("meta.000000")).unwrap(),
            b"a's capture",
            "returning to A must find A's capture, not B's"
        );
    }

    #[test]
    fn the_cache_is_local_storage_never_the_project_directorys_own() {
        // The mmap hazard (ADR 0042 §4): the bytes must land in
        // cannet-managed local storage even when the project directory
        // is somewhere else entirely.
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");
        let root = tmp.path().join("share").join("work");
        user_made_project_dir(&root);

        let pd = resolve(Some(&root.join("p.cannet_prj")), &cache_root);

        assert!(
            pd.cache_dir().starts_with(&cache_root),
            "cache dir {} must be under the app's cache root",
            pd.cache_dir().display()
        );
        assert!(!pd.cache_dir().starts_with(&root));
    }

    #[test]
    fn creation_writes_a_gitignore_that_covers_the_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let pd = resolve(None, &tmp.path().join("cache-root"));
        let ignore =
            std::fs::read_to_string(pd.root().join(WORKSPACE_DIR).join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l.trim() == "cache/"), "{ignore}");
    }

    #[test]
    fn the_workspace_scope_files_start_empty_so_they_override_nothing() {
        // A workspace value overrides the user value (ADR 0042 §3), so a
        // freshly created workspace must declare *no* values — writing
        // the defaults here would shadow the user's own settings.
        let tmp = tempfile::tempdir().unwrap();
        let pd = resolve(None, &tmp.path().join("cache-root"));
        for name in ["settings.json", "state.json"] {
            let text = std::fs::read_to_string(pd.root().join(WORKSPACE_DIR).join(name)).unwrap();
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value, serde_json::json!({}), "{name} is {text}");
        }
    }

    #[test]
    fn filling_a_hand_made_workspace_dir_leaves_the_users_files_alone() {
        // ADR 0042 §6: the user made the directory, cannet fills it —
        // it does not rewrite what is already there.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("work");
        user_made_project_dir(&root);
        let ws = root.join(WORKSPACE_DIR);
        std::fs::write(
            ws.join("settings.json"),
            r#"{"clear_scratch_on_exit": true}"#,
        )
        .unwrap();

        let pd = resolve(
            Some(&root.join("p.cannet_prj")),
            &tmp.path().join("cache-root"),
        );

        assert_eq!(pd.root(), root);
        assert_eq!(
            std::fs::read_to_string(ws.join("settings.json")).unwrap(),
            r#"{"clear_scratch_on_exit": true}"#,
            "an existing workspace file must survive untouched"
        );
        assert!(ws.join(".gitignore").is_file(), "the missing bits get made");
    }

    #[test]
    fn the_cache_link_reaches_the_real_cache_directory() {
        // The link is the browsable view of the cache: writing through
        // `.cannet/cache` must land in the local cache dir. Junctions on
        // Windows, symlinks elsewhere.
        let tmp = tempfile::tempdir().unwrap();
        let pd = resolve(None, &tmp.path().join("cache-root"));
        let link = pd.root().join(WORKSPACE_DIR).join(CACHE_LINK);
        assert!(
            link.symlink_metadata().is_ok(),
            "the cache link must exist at {}",
            link.display()
        );
        std::fs::write(link.join("probe"), b"through the link").unwrap();
        assert_eq!(
            std::fs::read(pd.cache_dir().join("probe")).unwrap(),
            b"through the link",
            "the link must reach the cannet-managed cache directory"
        );
    }

    #[test]
    fn the_cache_link_survives_shell_metacharacters_in_the_path() {
        // The Windows link goes through `cmd /C`, so a directory named
        // with `&` — which a user is perfectly entitled to do — must not
        // break the command line.
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache&root");
        let root = tmp.path().join("a&b");
        user_made_project_dir(&root);

        let pd = resolve(Some(&root.join("p.cannet_prj")), &cache_root);

        std::fs::write(
            pd.root().join(WORKSPACE_DIR).join(CACHE_LINK).join("probe"),
            b"ok",
        )
        .unwrap();
        assert_eq!(std::fs::read(pd.cache_dir().join("probe")).unwrap(), b"ok");
    }

    #[test]
    fn resolving_twice_does_not_disturb_an_existing_cache_link() {
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");
        let first = resolve(None, &cache_root);
        std::fs::write(first.cache_dir().join("probe"), b"x").unwrap();
        let again = resolve(None, &cache_root);
        assert_eq!(first, again);
        assert!(again
            .root()
            .join(WORKSPACE_DIR)
            .join(CACHE_LINK)
            .join("probe")
            .is_file());
    }

    #[test]
    fn save_as_makes_a_chosen_directory_a_complete_project_directory() {
        // The Save As exit criterion (ADR 0042 §6, decision 9): the
        // destination comes up immediately usable — `.cannet/` with its
        // scope files, the cache link, and the `.gitignore` — with no
        // `.cannet/` needed there beforehand. `create_at`, unlike
        // `resolve`, does *not* auto-locate: naming a destination in a
        // save dialog is the explicit act that earns a directory here.
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");
        let chosen = tmp.path().join("somewhere").join("the user picked");
        std::fs::create_dir_all(&chosen).unwrap();

        let pd = create_at(&chosen, &cache_root);

        assert_eq!(pd.root(), chosen);
        assert!(!pd.is_auto_located());
        let ws = chosen.join(WORKSPACE_DIR);
        assert!(ws.join("settings.json").is_file());
        assert!(ws.join("state.json").is_file());
        assert!(ws.join(".gitignore").is_file());
        assert!(pd.cache_dir().is_dir());
        assert!(pd.cache_dir().starts_with(&cache_root), "cache stays local");
        std::fs::write(ws.join(CACHE_LINK).join("probe"), b"ok").unwrap();
        assert_eq!(std::fs::read(pd.cache_dir().join("probe")).unwrap(), b"ok");
        // And the pair now identifies it, once the project file lands.
        std::fs::write(chosen.join("p.cannet_prj"), "{}").unwrap();
        assert!(is_project_directory(&chosen));
    }

    #[test]
    fn save_as_carries_the_workspace_scope_across() {
        // ADR 0042 §6: the user asked cannet to put the project
        // somewhere, so its data goes too.
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");
        let from = resolve(None, &cache_root);
        std::fs::write(
            from.workspace_dir().join("state.json"),
            r#"{"recent_blfs": ["/a.blf"]}"#,
        )
        .unwrap();
        let to = create_at(&tmp.path().join("chosen"), &cache_root);

        carry_workspace_scope(&from, &to);

        assert_eq!(
            std::fs::read_to_string(to.workspace_dir().join("state.json")).unwrap(),
            r#"{"recent_blfs": ["/a.blf"]}"#
        );
    }

    #[test]
    fn save_as_does_not_overwrite_what_a_hand_made_workspace_dir_already_says() {
        // ADR 0042 §6's other half: a `.cannet/` the user wrote is their
        // declaration for that project, and a Save As into it does not get
        // to overrule it. Only the files cannet created empty are filled.
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");
        let from = resolve(None, &cache_root);
        std::fs::write(
            from.workspace_dir().join("state.json"),
            r#"{"recent_blfs": ["/a.blf"]}"#,
        )
        .unwrap();
        std::fs::write(
            from.workspace_dir().join("settings.json"),
            r#"{"clear_scratch_on_exit": true}"#,
        )
        .unwrap();
        let chosen = tmp.path().join("chosen");
        std::fs::create_dir_all(chosen.join(WORKSPACE_DIR)).unwrap();
        std::fs::write(
            chosen.join(WORKSPACE_DIR).join("settings.json"),
            r#"{"clear_scratch_on_exit": false}"#,
        )
        .unwrap();
        let to = create_at(&chosen, &cache_root);

        carry_workspace_scope(&from, &to);

        assert_eq!(
            std::fs::read_to_string(to.workspace_dir().join("settings.json")).unwrap(),
            r#"{"clear_scratch_on_exit": false}"#,
            "what the user wrote stands"
        );
        assert_eq!(
            std::fs::read_to_string(to.workspace_dir().join("state.json")).unwrap(),
            r#"{"recent_blfs": ["/a.blf"]}"#,
            "the file cannet created empty is filled"
        );
    }

    #[test]
    fn the_active_project_directory_can_be_swapped_mid_session() {
        let tmp = tempfile::tempdir().unwrap();
        let cache_root = tmp.path().join("cache-root");
        let first = resolve(None, &cache_root);
        let active = ActiveProjectDir::new(cache_root.clone(), first.clone());
        assert_eq!(active.get(), first);
        assert_eq!(active.cache_root(), cache_root);

        let second = create_at(&tmp.path().join("chosen"), &cache_root);
        active.set(second.clone());

        assert_eq!(active.get(), second);
        assert_ne!(active.get().cache_dir(), first.cache_dir());
    }

    #[test]
    fn path_keys_are_stable_and_distinct() {
        let a = Path::new("/work/one");
        let b = Path::new("/work/two");
        assert_eq!(path_key(a), path_key(a), "stable for the same path");
        assert_ne!(path_key(a), path_key(b));
        assert!(
            path_key(a).chars().all(|c| c.is_ascii_hexdigit()),
            "{}",
            path_key(a)
        );
        assert_ne!(path_key(a), UNSAVED_KEY);
    }
}
