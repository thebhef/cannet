//! User settings, persisted host-side (ADR 0034), across two scopes
//! (ADR 0042).
//!
//! Choices the user deliberately sets — as opposed to the machine state
//! the app records as it works ([`crate::state`]) — live in
//! `settings.json`, read and written through the [`get_settings`] /
//! [`set_settings`] commands. The file is a durable, hand-editable
//! contract (ADR 0034): every field is written explicitly (no
//! skip-when-default) so opening `settings.json` shows the full set of
//! knobs and their current values, VS Code-style. The GUI's settings
//! panel is sugar over it, not the only way to edit it.
//!
//! **Two scopes, one filename.** The *user* copy is in Tauri's
//! `app_config_dir` and follows the person; the *workspace* copy is
//! `.cannet/settings.json` inside the open project directory and holds
//! that project's overrides. A read resolves the two — a workspace value
//! wins for the key it declares, and every other key keeps the user's
//! value. The path carries the scope, not the filename.
//!
//! **Writes are routed by the same metadata.** [`SCOPES`] declares every
//! key's scope, and a write goes to the file that scope names — so
//! echoing the resolved settings back (which is all the frontend ever
//! does) updates an existing override in place instead of promoting it
//! into the user's own file. A project that overrides nothing never has
//! its `.cannet/settings.json` written at all.
//!
//! A missing file or missing key resolves to the documented default, so a
//! fresh install and a hand-deleted file behave identically.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::persisted_json::{Scope, ScopeTable};

/// File name under `app_config_dir`.
const SETTINGS_FILE: &str = "settings.json";

/// The scope of every key [`Settings`] persists (ADR 0042 §3) — what
/// routes a write to the user file or to the project's `.cannet/`.
///
/// Settings that govern the app's behaviour are **overridable**: the
/// value is a preference that follows the person, and the workspace copy
/// of the file exists to hold this project's exceptions to it. Which of
/// them are better modelled as project-scoped outright —
/// `scratch_cap_bytes` and `clear_scratch_on_exit` both govern a
/// per-project resource — is settled with the rest of the settings
/// promotion work, not here.
///
/// `show_developer_settings` is the exception: it governs what *you* see
/// in the settings view, which is not a project's business, so it stays
/// at user scope.
///
/// The names are the serialized ones. `every_settings_key_declares_a_scope`
/// is what keeps this table from drifting away from the struct.
pub(crate) const SCOPES: ScopeTable = &[
    ("scratch_cap_bytes", Scope::UserOverridable),
    ("clear_scratch_on_exit", Scope::UserOverridable),
    ("keybindings", Scope::UserOverridable),
    ("show_developer_settings", Scope::User),
];

/// The persisted user settings. `#[serde(default)]` fills any absent field
/// from [`Settings::default`], so a partial file still parses and an
/// unknown field a newer build wrote is ignored. Unlike [`crate::state`],
/// the fields are *not* skipped on serialize — the file is meant to be
/// read and hand-edited, so it always lists every setting.
// `show_developer_settings` trips `struct_field_names` by ending in the
// struct's own name. The field name *is* the `settings.json` key a user
// reads and hand-edits, so it is named for the file, not for Rust.
#[allow(clippy::struct_field_names)]
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Maximum bytes the disk-spill scratch may grow to before the oldest
    /// history is dropped — the windowed-ring cap (ADR 0002). `None` (the
    /// default) means unbounded: the scratch grows with the capture.
    pub scratch_cap_bytes: Option<u64>,
    /// Whether to wipe the disk-spill scratch on a clean exit. Default
    /// `false`: a prior session is kept and reloads on the next launch
    /// (ADR 0002 DS-7).
    pub clear_scratch_on_exit: bool,
    /// User keybinding customisation (ADR 0018). `None` (the default) means
    /// "use the app's built-in default bindings"; `Some(list)` is the whole
    /// effective binding set, which replaces the defaults. The host only
    /// stores and round-trips this — the frontend reads it, merges it over
    /// the defaults, and applies the result; the host never dispatches keys.
    pub keybindings: Option<Vec<Binding>>,
    /// Whether the settings view reveals the `developer`-tagged knobs
    /// ([`crate::settings_descriptor::Kind::Developer`]). Default
    /// `false`. It is an ordinary setting rather than panel chrome so
    /// that the view grows no controls of its own — and so that the
    /// toggle is itself findable by searching for it.
    pub show_developer_settings: bool,
}

/// One persisted keybinding — the on-disk mirror of the frontend's
/// `BindingSpec` (ADR 0018). camelCase to match the TypeScript shape the
/// frontend reads and writes; `skip_editable` is omitted when unset so a
/// hand-edited file stays close to what the app writes.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub chord: String,
    pub command_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_editable: Option<bool>,
}

/// The smallest legal [`Settings::scratch_cap_bytes`] (ADR 0002 DS-8).
///
/// This is a **hard implementation limit, not a setting**: below it the
/// pre-allocated segment families dominate the budget — one payload segment
/// (4 MiB) plus one filter segment (8 MiB) for a single filtered view
/// already exceed a small cap — so the retained frame window thrashes a
/// whole meta segment at a time and the cap cannot be honored at all. It is
/// therefore *validation metadata on the field*: stated once, here, enforced
/// where a value enters the app ([`validate`]), and surfaced to the frontend
/// through [`get_settings_bounds`] and as the `min` of the field's
/// descriptor ([`crate::settings_descriptor`]) rather than re-declared
/// there. `None` (unbounded) is always legal.
pub const MIN_SCRATCH_CAP_BYTES: u64 = 100 * 1024 * 1024;

/// The bounds the frontend needs to render the settings controls — the same
/// limits [`validate`] enforces, so the UI cannot offer a value the host
/// will refuse. Returned by [`get_settings_bounds`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsBounds {
    /// Smallest legal `scratch_cap_bytes`; see [`MIN_SCRATCH_CAP_BYTES`].
    pub min_scratch_cap_bytes: u64,
}

/// Check every settings value against its documented bounds, returning the
/// accepted settings plus one human-readable complaint per refused field.
///
/// A refused field falls back to its default — the same resolution an absent
/// field gets — rather than being repaired to the nearest legal value. The
/// file is a user-authored document (ADR 0034): we report what we refuse and
/// leave their text alone, exactly as a hand-edited keybinding that names an
/// unknown command is dropped and reported rather than rewritten.
fn validate(settings: Settings) -> (Settings, Vec<String>) {
    let mut complaints = Vec::new();
    let mut settings = settings;
    if let Some(cap) = settings.scratch_cap_bytes {
        if cap < MIN_SCRATCH_CAP_BYTES {
            complaints.push(format!(
                "scratch_cap_bytes {cap} is below the {MIN_SCRATCH_CAP_BYTES}-byte minimum \
                 (a smaller cap can't be honored); ignoring it — the cache is unbounded"
            ));
            settings.scratch_cap_bytes = None;
        }
    }
    (settings, complaints)
}

/// Read the effective settings across both scopes (ADR 0042 §3):
/// `<user_dir>/settings.json` overridden per key by
/// `<workspace_dir>/settings.json`. A missing or unreadable file, or
/// junk contents, contributes nothing at that scope.
fn read_settings(user_dir: &Path, workspace_dir: &Path) -> Settings {
    crate::persisted_json::read_scoped(user_dir, workspace_dir, SETTINGS_FILE)
}

/// Write `settings` across the two scopes, each key going to the file
/// [`SCOPES`] names for it (ADR 0042 §3). Each file is written to a temp
/// sibling and renamed over the target, so a crash mid-write can't leave
/// a half-written one.
fn write_settings(
    user_dir: &Path,
    workspace_dir: &Path,
    settings: &Settings,
) -> std::io::Result<()> {
    crate::persisted_json::write_scoped(user_dir, workspace_dir, SETTINGS_FILE, settings, SCOPES)
}

/// Report each refused field on the system log, so a hand-edit that the
/// app can't honor is visible rather than silently inert.
fn warn_refused(app: &tauri::AppHandle, complaints: &[String]) {
    for c in complaints {
        crate::sys_warn!(app, "settings", "{c}");
    }
}

/// Load the effective settings: the user scope, overridden per key by
/// the open project's workspace scope (ADR 0042 §3). Returns defaults if
/// the config dir can't be resolved or the files are missing / corrupt —
/// reading settings never fails for the caller. Out-of-range values in a
/// hand-edited file are refused here, at the read boundary, and reported
/// on the system log; the caller only ever sees values the app can honor.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_settings(app: tauri::AppHandle) -> Settings {
    let raw = crate::persisted_json::config_dir(&app)
        .map(|user_dir| read_settings(&user_dir, &crate::workspace_dir(&app)))
        .unwrap_or_default();
    let (settings, complaints) = validate(raw);
    warn_refused(&app, &complaints);
    settings
}

/// The validation bounds for the settings fields (ADR 0002 DS-8). The
/// frontend reads these instead of re-declaring the limits it renders.
#[tauri::command]
#[must_use]
pub fn get_settings_bounds() -> SettingsBounds {
    SettingsBounds {
        min_scratch_cap_bytes: MIN_SCRATCH_CAP_BYTES,
    }
}

/// The settings keys the open project's `.cannet/settings.json`
/// declares — the ones whose effective value came from the project
/// rather than from the user's own file (ADR 0042 §3). The settings view
/// marks them, so a value a project overrides is visible as such instead
/// of looking like a personal preference.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
#[must_use]
pub fn get_settings_overrides(app: tauri::AppHandle) -> Vec<String> {
    crate::persisted_json::declared_keys(&crate::workspace_dir(&app).join(SETTINGS_FILE))
}

/// Persist the whole settings struct — each key at the scope [`SCOPES`]
/// declares for it — and return what was actually stored: out-of-range
/// values are refused (and reported) before the write, so the file never
/// records a value the app would not honor and the caller can show what it
/// got. Errors (with a user-facing message) only if the config dir can't be
/// resolved or the write fails; on failure it also lands on the system log.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<Settings, String> {
    let dir = crate::persisted_json::config_dir(&app)?;
    let (settings, complaints) = validate(settings);
    warn_refused(&app, &complaints);
    write_settings(&dir, &crate::workspace_dir(&app), &settings).map_err(|e| {
        let msg = format!("failed to write settings: {e}");
        crate::sys_warn!(&app, "settings", "{msg}");
        msg
    })?;
    // Apply the windowed-ring scratch cap (ADR 0002 DS-8) to the live store
    // so a changed cap takes effect on the next flush, not just next launch.
    crate::apply_scratch_cap(&app);
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project directory with no workspace overrides — what cannet
    /// creates (`.cannet/settings.json` is written empty, so it shadows
    /// nothing). Reads through it must behave exactly as a single-scope
    /// read did.
    fn no_workspace() -> std::path::PathBuf {
        std::path::PathBuf::from("no-such-workspace-dir")
    }

    /// Write at user scope with no project overriding anything — the
    /// single-scope shape the older tests here assume.
    fn write_user_settings(dir: &Path, settings: &Settings) {
        write_settings(dir, &dir.join("unused-workspace"), settings).unwrap();
    }

    /// A user-scope settings document resolved with no workspace
    /// overrides — the same path production takes for a project that
    /// overrides nothing, without touching the filesystem. Junk and
    /// partial documents must survive it: a corrupt settings file can
    /// never brick startup.
    fn parse_settings(text: &str) -> Settings {
        crate::persisted_json::resolve_scoped(text, "")
    }

    fn sample() -> Settings {
        Settings {
            scratch_cap_bytes: Some(8 * 1024 * 1024 * 1024),
            clear_scratch_on_exit: true,
            keybindings: Some(vec![
                Binding {
                    chord: "Mod+k".into(),
                    command_id: "palette.show".into(),
                    skip_editable: None,
                },
                Binding {
                    chord: "Mod+z".into(),
                    command_id: "view.undo".into(),
                    skip_editable: Some(true),
                },
            ]),
            show_developer_settings: true,
        }
    }

    #[test]
    fn round_trips_through_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let s = sample();
        write_user_settings(dir.path(), &s);
        assert_eq!(read_settings(dir.path(), &no_workspace()), s);
    }

    #[test]
    fn missing_file_reads_as_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_settings(dir.path(), &no_workspace()),
            Settings::default()
        );
    }

    #[test]
    fn defaults_are_unbounded_cap_and_keep_on_exit() {
        let d = Settings::default();
        assert_eq!(d.scratch_cap_bytes, None);
        assert!(!d.clear_scratch_on_exit);
        assert_eq!(d.keybindings, None);
        assert!(!d.show_developer_settings);
    }

    #[test]
    fn keybindings_round_trip_with_camelcase_and_optional_skip_editable() {
        let dir = tempfile::tempdir().unwrap();
        write_user_settings(dir.path(), &sample());
        assert_eq!(read_settings(dir.path(), &no_workspace()), sample());
        // The on-disk shape matches the frontend `BindingSpec`: camelCase
        // `commandId`, and `skipEditable` present only when set.
        let text = serde_json::to_string(&sample()).unwrap();
        assert!(text.contains("\"commandId\":\"palette.show\""), "{text}");
        assert!(text.contains("\"skipEditable\":true"), "{text}");
        // The first binding has no skip_editable, so it must not serialize one.
        assert!(
            !text.contains("\"chord\":\"Mod+k\",\"commandId\":\"palette.show\",\"skipEditable\""),
            "{text}"
        );
    }

    #[test]
    fn missing_keybindings_key_reads_as_none() {
        let s = parse_settings(r#"{"scratch_cap_bytes": 1024}"#);
        assert_eq!(s.keybindings, None);
    }

    #[test]
    fn junk_contents_read_as_default() {
        assert_eq!(parse_settings("not json"), Settings::default());
        assert_eq!(parse_settings("[1, 2, 3]"), Settings::default());
    }

    #[test]
    fn partial_file_keeps_present_fields_and_defaults_the_rest() {
        let s = parse_settings(r#"{"clear_scratch_on_exit": true}"#);
        assert!(s.clear_scratch_on_exit);
        assert_eq!(s.scratch_cap_bytes, None);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let s = parse_settings(r#"{"scratch_cap_bytes": 1024, "future_key": 42}"#);
        assert_eq!(s.scratch_cap_bytes, Some(1024));
    }

    #[test]
    fn the_published_bound_is_the_one_validate_enforces() {
        // The frontend renders `get_settings_bounds` rather than its own
        // copy of the limit, so the published bound and the enforced one
        // must be the same number — this is what keeps them from drifting.
        let min = get_settings_bounds().min_scratch_cap_bytes;
        let at_bound = validate(Settings {
            scratch_cap_bytes: Some(min),
            ..Settings::default()
        });
        assert!(at_bound.1.is_empty(), "{:?}", at_bound.1);
        assert_eq!(at_bound.0.scratch_cap_bytes, Some(min));
        let below = validate(Settings {
            scratch_cap_bytes: Some(min - 1),
            ..Settings::default()
        });
        assert_eq!(below.1.len(), 1, "{:?}", below.1);
    }

    #[test]
    fn in_range_and_unbounded_caps_are_accepted_unchanged() {
        // Unbounded is always legal; at-or-above the minimum passes through
        // untouched (ADR 0002 DS-8).
        for cap in [
            None,
            Some(MIN_SCRATCH_CAP_BYTES),
            Some(8 * 1024 * 1024 * 1024),
        ] {
            let (accepted, complaints) = validate(Settings {
                scratch_cap_bytes: cap,
                ..Settings::default()
            });
            assert_eq!(accepted.scratch_cap_bytes, cap);
            assert!(complaints.is_empty(), "{complaints:?}");
        }
    }

    #[test]
    fn below_minimum_cap_is_rejected_and_reported_not_repaired() {
        // The minimum is a hard implementation limit (ADR 0002 DS-8), not a
        // setting: an out-of-range value is refused and reported, never
        // silently repaired to the nearest legal value. A refused field
        // resolves to its default, exactly as an absent one does.
        for cap in [
            Some(0),
            Some(15 * 1024 * 1024),
            Some(MIN_SCRATCH_CAP_BYTES - 1),
        ] {
            let (accepted, complaints) = validate(Settings {
                scratch_cap_bytes: cap,
                clear_scratch_on_exit: true,
                ..Settings::default()
            });
            assert_eq!(accepted.scratch_cap_bytes, None, "cap {cap:?}");
            assert_eq!(complaints.len(), 1, "cap {cap:?}: {complaints:?}");
            assert!(
                complaints[0].contains("scratch_cap_bytes"),
                "{complaints:?}"
            );
            // Only the offending field is refused; the rest is kept.
            assert!(accepted.clear_scratch_on_exit);
        }
    }

    #[test]
    fn default_settings_serialize_with_every_key_present() {
        // Unlike state.json, settings.json lists every knob even at its
        // default so the file is discoverable when hand-edited.
        let text = serde_json::to_string(&Settings::default()).unwrap();
        assert!(text.contains("scratch_cap_bytes"), "{text}");
        assert!(text.contains("clear_scratch_on_exit"), "{text}");
        assert!(text.contains("keybindings"), "{text}");
        assert!(text.contains("show_developer_settings"), "{text}");
    }

    #[test]
    fn a_workspace_setting_overrides_the_user_setting_for_the_same_key() {
        // ADR 0042 §3, through the real file layout: the user's
        // `settings.json` and the project's `.cannet/settings.json`.
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("config");
        let workspace = tmp.path().join("project").join(".cannet");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        write_user_settings(
            &user,
            &Settings {
                scratch_cap_bytes: Some(4 * 1024 * 1024 * 1024),
                ..Settings::default()
            },
        );
        std::fs::write(
            workspace.join(SETTINGS_FILE),
            r#"{"clear_scratch_on_exit": true}"#,
        )
        .unwrap();

        let effective = read_settings(&user, &workspace);

        assert!(
            effective.clear_scratch_on_exit,
            "the workspace value wins for the key it declares"
        );
        assert_eq!(
            effective.scratch_cap_bytes,
            Some(4 * 1024 * 1024 * 1024),
            "a key the workspace is silent about keeps the user's value"
        );
    }

    #[test]
    fn an_empty_workspace_file_leaves_the_user_settings_exactly_as_they_were() {
        // What a freshly created project directory holds. A user who
        // never touches workspace settings must see no change at all.
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("config");
        let workspace = tmp.path().join("project").join(".cannet");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        write_user_settings(&user, &sample());
        std::fs::write(workspace.join(SETTINGS_FILE), "{}\n").unwrap();

        assert_eq!(read_settings(&user, &workspace), sample());
    }

    #[test]
    fn every_settings_key_declares_a_scope() {
        // The exit criterion: a key with no declared scope fails a test
        // rather than defaulting silently. Both directions — an
        // undeclared key, and a declaration for a key that no longer
        // exists.
        let serde_json::Value::Object(keys) = serde_json::to_value(sample()).unwrap() else {
            panic!("settings must serialize to a JSON object");
        };
        for key in keys.keys() {
            assert!(
                crate::persisted_json::scope_of(SCOPES, key).is_some(),
                "settings key `{key}` declares no scope"
            );
        }
        for (name, _) in SCOPES {
            assert!(
                keys.contains_key(*name),
                "SCOPES names a stale key `{name}`"
            );
        }
    }

    #[test]
    fn writing_back_a_resolved_setting_updates_the_override_not_the_user_file() {
        // The gap the two-scope read left open: `get_settings` resolves
        // the override, the frontend echoes the whole struct back, and
        // the write used to land the project's value in the *user* file
        // — silently promoting it. The override is now maintained where
        // it lives, and the user's own value survives untouched.
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("config");
        let workspace = tmp.path().join("project").join(".cannet");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        write_user_settings(
            &user,
            &Settings {
                clear_scratch_on_exit: false,
                ..Settings::default()
            },
        );
        std::fs::write(
            workspace.join(SETTINGS_FILE),
            r#"{"clear_scratch_on_exit": true}"#,
        )
        .unwrap();

        let resolved = read_settings(&user, &workspace);
        assert!(resolved.clear_scratch_on_exit);
        write_settings(&user, &workspace, &resolved).unwrap();

        assert!(
            !read_settings(&user, &no_workspace()).clear_scratch_on_exit,
            "the user's own value must not be overwritten by the project's"
        );
        assert!(read_settings(&user, &workspace).clear_scratch_on_exit);
    }

    #[test]
    fn a_project_that_overrides_nothing_never_gets_its_settings_file_written() {
        // ADR 0042 §2 as it applies to writes: cannet fills `.cannet/`
        // once, and a settings change with no override in play leaves
        // that empty file exactly as created.
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("config");
        let workspace = tmp.path().join("project").join(".cannet");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join(SETTINGS_FILE), "{}\n").unwrap();

        write_settings(&user, &workspace, &sample()).unwrap();

        assert_eq!(
            std::fs::read_to_string(workspace.join(SETTINGS_FILE)).unwrap(),
            "{}\n"
        );
        assert_eq!(read_settings(&user, &workspace), sample());
    }

    #[test]
    fn write_replaces_rather_than_merges() {
        let dir = tempfile::tempdir().unwrap();
        write_user_settings(dir.path(), &sample());
        write_user_settings(dir.path(), &Settings::default());
        assert_eq!(
            read_settings(dir.path(), &no_workspace()),
            Settings::default()
        );
    }
}
