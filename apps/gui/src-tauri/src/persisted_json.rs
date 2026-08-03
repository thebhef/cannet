//! Shared JSON persistence for the host's small config/document files
//! (settings, UI state, project, RBS) — one atomic-write path instead
//! of each file reimplementing it.
//!
//! **Atomic write.** [`write_json_atomic`] serializes to a temp sibling
//! and renames it over the target, so a crash mid-write can't leave a
//! half-written file that fails to parse on reload.
//!
//! Best-effort config files (settings, UI state) don't version-gate —
//! [`parse_or_default`] tolerates a missing or malformed file by
//! falling back to `T::default()`. The project file and the RBS file
//! instead gate on an explicit schema version (ADR 0011); that shared
//! gate is [`parse_versioned`], added alongside their migration onto
//! this module.
//!
//! **Two scopes.** Settings and UI state exist once per user and once
//! per project directory (ADR 0042). [`resolve_scoped`] is the single
//! precedence rule both go through — a workspace value overrides the
//! user value for the same key — and [`read_scoped`] is that rule
//! applied to a filename in two directories.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::Manager;

/// Serialize `value` to `path` as pretty JSON via a temp-file + rename,
/// so a crash mid-write can't leave a half-written file. The temp file
/// is `path` with `.tmp` appended, in the same directory as `path` (so
/// the rename is same-filesystem and atomic).
pub(crate) fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// Parse JSON, tolerating junk: any parse failure yields `T::default()`
/// rather than an error. For best-effort config files where a corrupt
/// file must never brick startup.
pub(crate) fn parse_or_default<T: DeserializeOwned + Default>(text: &str) -> T {
    serde_json::from_str(text).unwrap_or_default()
}

/// Resolve one document across the two scopes (ADR 0042 §3): **a
/// workspace value overrides the user value for the same key**, and a
/// key the workspace does not mention keeps whatever the user scope
/// says.
///
/// The merge is by top-level key, not deep. A setting's value is one
/// thing the user chose — a keybinding list, a colour map — and merging
/// *into* it would produce a value neither scope ever wrote. Overriding
/// `keybindings` means replacing the list, not splicing it.
///
/// Which keys may legitimately be overridden is per-setting metadata,
/// not a property of this mechanism; this is only the precedence.
///
/// Junk at either scope contributes nothing rather than poisoning the
/// result, and a document that isn't a JSON object (an array, a bare
/// number) is treated the same way — a corrupt file at one scope must
/// not lose the other scope's values.
pub(crate) fn resolve_scoped<T: DeserializeOwned + Default>(user: &str, workspace: &str) -> T {
    let mut merged = top_level_keys(user);
    merged.extend(top_level_keys(workspace));
    serde_json::from_value(serde_json::Value::Object(merged)).unwrap_or_default()
}

/// The top-level keys of `text`, or an empty map if it isn't a JSON
/// object (missing, junk, or the wrong shape).
fn top_level_keys(text: &str) -> serde_json::Map<String, serde_json::Value> {
    match serde_json::from_str(text) {
        Ok(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    }
}

/// Read `<user_dir>/<file>` and `<workspace_dir>/<file>` and resolve
/// them through [`resolve_scoped`]. An unreadable file at either scope
/// reads as an empty document — the same resolution an absent one gets.
pub(crate) fn read_scoped<T: DeserializeOwned + Default>(
    user_dir: &Path,
    workspace_dir: &Path,
    file: &str,
) -> T {
    let read = |dir: &Path| std::fs::read_to_string(dir.join(file)).unwrap_or_default();
    resolve_scoped(&read(user_dir), &read(workspace_dir))
}

/// Where a persisted key may be written, and therefore which of the two
/// scope files a write of that key lands in (ADR 0042 §3).
///
/// Precedence on *read* is uniform — a workspace value overrides the user
/// value for any key ([`resolve_scoped`]). This is the other half: the
/// declaration that says where a value the app writes back belongs, so
/// echoing a resolved document back cannot move a value between scopes.
/// Every persisted key declares one.
///
/// `Serialize`d so the settings view can render a key's scope beside it
/// rather than keeping its own copy of the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Scope {
    /// User scope only — the value follows the person and no project
    /// carries its own. Writes always go to the user file.
    User,
    /// User scope, overridable per project. Writes go to whichever scope
    /// currently holds the key: the workspace file if it declares one,
    /// the user file otherwise. There is no UI for choosing a scope, so
    /// "leave the value where it already is" is the only rule that
    /// neither promotes an override into the user's own settings nor
    /// silently demotes one.
    UserOverridable,
    /// Workspace scope only — the value belongs to one project. Writes
    /// always go to `.cannet/`.
    Workspace,
}

/// One document's scope declaration: every top-level key it persists,
/// with the [`Scope`] that routes writes of that key.
pub(crate) type ScopeTable = &'static [(&'static str, Scope)];

/// The declared scope of `key`, or `None` if `scopes` doesn't mention it.
pub(crate) fn scope_of(scopes: ScopeTable, key: &str) -> Option<Scope> {
    scopes
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, scope)| *scope)
}

/// Write `value` across the two scopes, routing each key by its declared
/// [`Scope`] (ADR 0042 §3). The counterpart of [`read_scoped`].
///
/// Each declared key is written to — or, when the serialization omits it,
/// removed from — exactly one of the two files. Nothing else in either
/// file is touched: a key routed to the other scope keeps the value it
/// had there, and a key neither scope declares (one a newer build wrote)
/// is preserved rather than clobbered. A file whose content this write
/// doesn't change is not rewritten at all, so cannet doesn't author
/// `.cannet/settings.json` merely because a user-scope setting changed.
///
/// **A key with no declared scope is a bug**, not a case to handle: it
/// trips a `debug_assert` (so a test catches it) and, in a release build,
/// is written at user scope and logged rather than dropped.
pub(crate) fn write_scoped<T: Serialize>(
    user_dir: &Path,
    workspace_dir: &Path,
    file: &str,
    value: &T,
    scopes: ScopeTable,
) -> std::io::Result<()> {
    let serialized = to_object(value)?;
    let user_before = read_object(&user_dir.join(file));
    let workspace_before = read_object(&workspace_dir.join(file));
    let mut user = user_before.clone();
    let mut workspace = workspace_before.clone();
    for (key, scope) in scopes {
        let to_workspace = match scope {
            Scope::User => false,
            Scope::Workspace => true,
            // Stay in the scope that already holds it; see `Scope`.
            Scope::UserOverridable => workspace_before.contains_key(*key),
        };
        let target = if to_workspace {
            &mut workspace
        } else {
            &mut user
        };
        match serialized.get(*key) {
            Some(v) => target.insert((*key).to_string(), v.clone()),
            None => target.remove(*key),
        };
    }
    for (key, v) in &serialized {
        if scope_of(scopes, key).is_none() {
            debug_assert!(false, "persisted key `{key}` in {file} declares no scope");
            tracing::warn!(
                key,
                file,
                "persisted key declares no scope; writing it at user scope"
            );
            user.insert(key.clone(), v.clone());
        }
    }
    write_object_if_changed(&user_dir.join(file), &user_before, &user)?;
    write_object_if_changed(&workspace_dir.join(file), &workspace_before, &workspace)
}

/// `value` as a JSON object. A document that doesn't serialize to one has
/// no top-level keys to route, which is a programming error rather than a
/// runtime condition.
fn to_object<T: Serialize>(
    value: &T,
) -> std::io::Result<serde_json::Map<String, serde_json::Value>> {
    match serde_json::to_value(value).map_err(std::io::Error::other)? {
        serde_json::Value::Object(map) => Ok(map),
        other => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("a scoped document must serialize to a JSON object, got {other}"),
        )),
    }
}

/// The top-level keys of the JSON document at `path` — empty when it is
/// missing, unreadable, or not an object, the same resolution
/// [`read_scoped`] gives those cases.
fn read_object(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    top_level_keys(&std::fs::read_to_string(path).unwrap_or_default())
}

/// Write `after` to `path` unless it is what is already there, creating
/// the parent directory if needed.
fn write_object_if_changed(
    path: &Path,
    before: &serde_json::Map<String, serde_json::Value>,
    after: &serde_json::Map<String, serde_json::Value>,
) -> std::io::Result<()> {
    if before == after {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_json_atomic(path, after)
}

/// Resolve the per-OS config directory (`$XDG_CONFIG_HOME/<id>`,
/// `%APPDATA%\<id>`, `~/Library/Application Support/<id>`).
pub(crate) fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))
}

/// Parse `text` as JSON, accepting only a document whose
/// `schema_version` equals `expected_version` (ADR 0011): any other
/// value — or a missing one — is rejected with a user-facing message
/// rather than migrated. `kind` labels the document in error text
/// (e.g. `"project"`, `"RBS"`).
pub(crate) fn parse_versioned<T: DeserializeOwned>(
    text: &str,
    kind: &str,
    expected_version: u32,
) -> Result<T, String> {
    let raw: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("invalid {kind} JSON: {e}"))?;
    let version = raw
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "missing schema_version".to_string())?;
    if version != u64::from(expected_version) {
        return Err(format!(
            "schema version {version}; this build expects {expected_version}"
        ));
    }
    serde_json::from_value(raw).map_err(|e| format!("invalid {kind} JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
    struct Sample {
        schema_version: u32,
        #[serde(default)]
        name: String,
    }

    #[test]
    fn write_json_atomic_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thing.json");
        let value = Sample {
            schema_version: 1,
            name: "x".into(),
        };
        write_json_atomic(&path, &value).unwrap();
        let read: Sample = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read, value);
    }

    #[test]
    fn write_json_atomic_leaves_no_leftover_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thing.json");
        write_json_atomic(&path, &Sample::default()).unwrap();
        let mut tmp = path.clone().into_os_string();
        tmp.push(".tmp");
        assert!(
            !Path::new(&tmp).exists(),
            "temp file must be renamed away, not left behind"
        );
    }

    /// Regression test for the non-atomic-save bug:
    /// project.rs / RBS used to write straight to the target path, so a
    /// write failure partway could leave a corrupted file behind. The
    /// atomic helper writes to a temp sibling first — if *that* write
    /// fails, the real target is never touched.
    #[test]
    fn write_json_atomic_leaves_target_untouched_when_temp_write_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thing.json");
        let original = br#"{"schema_version":1,"name":"original"}"#;
        std::fs::write(&path, original).unwrap();
        // Block the temp-file write: put a directory where the temp
        // sibling would go, so the write can't complete.
        let mut tmp = path.clone().into_os_string();
        tmp.push(".tmp");
        std::fs::create_dir(&tmp).unwrap();

        let result = write_json_atomic(
            &path,
            &Sample {
                schema_version: 1,
                name: "new".into(),
            },
        );

        assert!(
            result.is_err(),
            "write must fail when the temp file can't be created"
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            original,
            "the original file must be untouched by a failed write"
        );
    }

    #[test]
    fn parse_or_default_tolerates_junk() {
        assert_eq!(parse_or_default::<Sample>("not json"), Sample::default());
        assert_eq!(parse_or_default::<Sample>("[1, 2, 3]"), Sample::default());
    }

    /// A two-scope document in the shape the real ones have: every field
    /// optional, and absent from the serialization when it has nothing to
    /// say (which is how a write asks for a key to be *removed*).
    #[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(default)]
    struct Scoped {
        #[serde(skip_serializing_if = "Option::is_none")]
        alpha: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        beta: Option<u32>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        list: Vec<u32>,
    }

    #[test]
    fn a_workspace_value_overrides_the_user_value_for_the_same_key() {
        // ADR 0042 §3, the whole point of two scopes.
        let s: Scoped = resolve_scoped(r#"{"alpha": 1}"#, r#"{"alpha": 2}"#);
        assert_eq!(s.alpha, Some(2));
    }

    #[test]
    fn a_key_the_workspace_does_not_mention_keeps_the_user_value() {
        let s: Scoped = resolve_scoped(r#"{"alpha": 1, "beta": 7}"#, r#"{"alpha": 2}"#);
        assert_eq!(s.alpha, Some(2));
        assert_eq!(s.beta, Some(7), "beta is untouched by the override");
    }

    #[test]
    fn an_empty_workspace_document_changes_nothing() {
        // What a freshly created project directory looks like: `{}` must
        // resolve to exactly the user's settings, not to the defaults.
        let user = r#"{"alpha": 1, "beta": 7, "list": [3, 4]}"#;
        assert_eq!(
            resolve_scoped::<Scoped>(user, "{}"),
            resolve_scoped::<Scoped>(user, "")
        );
        let s: Scoped = resolve_scoped(user, "{}");
        assert_eq!(s.alpha, Some(1));
        assert_eq!(s.beta, Some(7));
        assert_eq!(s.list, vec![3, 4]);
    }

    #[test]
    fn a_workspace_only_key_applies_over_the_default() {
        let s: Scoped = resolve_scoped("{}", r#"{"beta": 9}"#);
        assert_eq!(s.beta, Some(9));
    }

    #[test]
    fn an_overridden_list_is_replaced_not_spliced() {
        // Top-level merge, not deep: an override replaces the value the
        // user chose rather than producing one neither scope wrote.
        let s: Scoped = resolve_scoped(r#"{"list": [1, 2, 3]}"#, r#"{"list": [9]}"#);
        assert_eq!(s.list, vec![9]);
    }

    #[test]
    fn junk_at_one_scope_does_not_cost_the_other_scopes_values() {
        let from_user: Scoped = resolve_scoped(r#"{"alpha": 1}"#, "not json");
        assert_eq!(from_user.alpha, Some(1));
        let from_workspace: Scoped = resolve_scoped("[1, 2, 3]", r#"{"alpha": 5}"#);
        assert_eq!(from_workspace.alpha, Some(5));
    }

    #[test]
    fn read_scoped_resolves_two_directories_and_tolerates_missing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("user");
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&ws).unwrap();

        // Neither file present: defaults.
        assert_eq!(
            read_scoped::<Scoped>(&user, &ws, "x.json"),
            Scoped::default()
        );

        std::fs::write(user.join("x.json"), r#"{"alpha": 1, "beta": 7}"#).unwrap();
        // Workspace file still absent — the user scope stands alone.
        let s: Scoped = read_scoped(&user, &ws, "x.json");
        assert_eq!((s.alpha, s.beta), (Some(1), Some(7)));

        std::fs::write(ws.join("x.json"), r#"{"alpha": 2}"#).unwrap();
        let s: Scoped = read_scoped(&user, &ws, "x.json");
        assert_eq!((s.alpha, s.beta), (Some(2), Some(7)));
    }

    /// The scope declaration for [`Scoped`], the test document.
    const SCOPED_SCOPES: ScopeTable = &[
        ("alpha", Scope::User),
        ("beta", Scope::UserOverridable),
        ("list", Scope::Workspace),
    ];

    /// The two scope directories plus a reader for what each file holds.
    struct Scopes {
        _tmp: tempfile::TempDir,
        user: PathBuf,
        workspace: PathBuf,
    }

    impl Scopes {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let user = tmp.path().join("config");
            let workspace = tmp.path().join("project").join(".cannet");
            std::fs::create_dir_all(&user).unwrap();
            std::fs::create_dir_all(&workspace).unwrap();
            Self {
                _tmp: tmp,
                user,
                workspace,
            }
        }

        fn write(&self, value: &Scoped) {
            write_scoped(&self.user, &self.workspace, "x.json", value, SCOPED_SCOPES).unwrap();
        }

        fn user_doc(&self) -> serde_json::Map<String, serde_json::Value> {
            top_level_keys(&std::fs::read_to_string(self.user.join("x.json")).unwrap_or_default())
        }

        fn workspace_doc(&self) -> serde_json::Map<String, serde_json::Value> {
            top_level_keys(
                &std::fs::read_to_string(self.workspace.join("x.json")).unwrap_or_default(),
            )
        }
    }

    #[test]
    fn a_user_scope_key_is_written_to_the_user_file() {
        let s = Scopes::new();
        s.write(&Scoped {
            alpha: Some(1),
            ..Scoped::default()
        });
        assert_eq!(s.user_doc()["alpha"], serde_json::json!(1));
        assert!(!s.workspace_doc().contains_key("alpha"));
    }

    #[test]
    fn a_workspace_scope_key_is_written_to_the_workspace_file() {
        // The half of the split that makes `.cannet/state.json` real:
        // a per-project value never lands in the user's file.
        let s = Scopes::new();
        s.write(&Scoped {
            list: vec![1, 2],
            ..Scoped::default()
        });
        assert_eq!(s.workspace_doc()["list"], serde_json::json!([1, 2]));
        assert!(!s.user_doc().contains_key("list"));
    }

    #[test]
    fn an_echoed_override_is_written_back_to_the_workspace_not_promoted_to_the_user_file() {
        // The bug this routing exists to kill: a workspace override, read
        // through `resolve_scoped` and echoed back by the frontend, used
        // to be written into the *user* file — silently promoting the
        // project's choice into the person's.
        let s = Scopes::new();
        std::fs::write(s.user.join("x.json"), r#"{"beta": 1}"#).unwrap();
        std::fs::write(s.workspace.join("x.json"), r#"{"beta": 2}"#).unwrap();

        let effective: Scoped = read_scoped(&s.user, &s.workspace, "x.json");
        assert_eq!(effective.beta, Some(2), "the override is what was read");
        s.write(&effective);

        assert_eq!(
            s.user_doc()["beta"],
            serde_json::json!(1),
            "the user's own value must survive the echo"
        );
        assert_eq!(s.workspace_doc()["beta"], serde_json::json!(2));
    }

    #[test]
    fn an_overridable_key_with_no_override_is_written_to_the_user_file() {
        let s = Scopes::new();
        s.write(&Scoped {
            beta: Some(7),
            ..Scoped::default()
        });
        assert_eq!(s.user_doc()["beta"], serde_json::json!(7));
        assert!(!s.workspace_doc().contains_key("beta"));
    }

    #[test]
    fn editing_an_overridden_key_updates_the_override_in_place() {
        let s = Scopes::new();
        std::fs::write(s.user.join("x.json"), r#"{"beta": 1}"#).unwrap();
        std::fs::write(s.workspace.join("x.json"), r#"{"beta": 2}"#).unwrap();

        s.write(&Scoped {
            beta: Some(5),
            ..Scoped::default()
        });

        assert_eq!(s.workspace_doc()["beta"], serde_json::json!(5));
        assert_eq!(s.user_doc()["beta"], serde_json::json!(1));
    }

    #[test]
    fn a_key_absent_from_the_written_value_is_removed_from_its_own_file_only() {
        // `skip_serializing_if` is how these documents say "empty":
        // clearing the recents must clear the stored list, and must not
        // reach into the other scope's file to do it.
        let s = Scopes::new();
        s.write(&Scoped {
            alpha: Some(1),
            list: vec![9],
            ..Scoped::default()
        });
        assert!(s.workspace_doc().contains_key("list"));

        s.write(&Scoped {
            alpha: Some(1),
            ..Scoped::default()
        });

        assert!(!s.workspace_doc().contains_key("list"), "cleared");
        assert_eq!(s.user_doc()["alpha"], serde_json::json!(1), "untouched");
    }

    #[test]
    fn a_scope_file_a_write_has_nothing_to_say_about_is_left_alone() {
        // cannet must not author `.cannet/settings.json` just because a
        // setting changed: with no override in it, the file it created
        // empty stays exactly as it wrote it (ADR 0042 §2).
        let s = Scopes::new();
        std::fs::write(s.workspace.join("x.json"), "{}\n").unwrap();
        s.write(&Scoped {
            alpha: Some(1),
            beta: Some(2),
            ..Scoped::default()
        });
        assert_eq!(
            std::fs::read_to_string(s.workspace.join("x.json")).unwrap(),
            "{}\n",
            "an untouched scope file must not even be rewritten"
        );
    }

    #[test]
    fn a_key_neither_scope_declares_is_preserved_rather_than_clobbered() {
        // A key a *newer* build wrote is not this build's to delete —
        // the write only replaces the keys it declares.
        let s = Scopes::new();
        std::fs::write(s.user.join("x.json"), r#"{"from_the_future": 42}"#).unwrap();
        s.write(&Scoped {
            alpha: Some(1),
            ..Scoped::default()
        });
        assert_eq!(s.user_doc()["from_the_future"], serde_json::json!(42));
    }

    #[test]
    fn scope_of_answers_for_a_declared_key_and_not_for_anything_else() {
        assert_eq!(scope_of(SCOPED_SCOPES, "alpha"), Some(Scope::User));
        assert_eq!(scope_of(SCOPED_SCOPES, "list"), Some(Scope::Workspace));
        assert_eq!(scope_of(SCOPED_SCOPES, "nope"), None);
    }

    #[test]
    fn parse_versioned_accepts_exact_version_and_rejects_others() {
        assert!(parse_versioned::<Sample>(r#"{"schema_version":1}"#, "sample", 1).is_ok());
        assert!(parse_versioned::<Sample>(r#"{"schema_version":2}"#, "sample", 1).is_err());
        assert!(parse_versioned::<Sample>("{}", "sample", 1).is_err());
        assert!(parse_versioned::<Sample>("not json", "sample", 1).is_err());
    }
}
