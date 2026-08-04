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
//! Writes go to the user scope only, so cannet reads the workspace file
//! and never authors it: routing a key to the project's copy needs
//! per-setting metadata saying which keys may be overridden there, which
//! does not exist yet.
//!
//! A missing file or missing key resolves to the documented default, so a
//! fresh install and a hand-deleted file behave identically.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// File name under `app_config_dir`.
const SETTINGS_FILE: &str = "settings.json";

/// The persisted user settings. `#[serde(default)]` fills any absent field
/// from [`Settings::default`], so a partial file still parses and an
/// unknown field a newer build wrote is ignored. Unlike [`crate::state`],
/// the fields are *not* skipped on serialize — the file is meant to be
/// read and hand-edited, so it always lists every setting.
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
/// through [`get_settings_bounds`] rather than re-declared there. `None`
/// (unbounded) is always legal.
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

/// Write `settings` to `dir/settings.json`, creating `dir` if needed.
/// Written to a temp sibling and renamed over the target so a crash
/// mid-write can't leave a half-written file.
///
/// The write always goes to the **user scope**. Routing a key to the
/// workspace file needs the per-setting metadata that says which keys
/// may be overridden there, which is not yet defined; until it is,
/// `.cannet/settings.json` is a hand-authored override document that
/// cannet reads and never writes.
fn write_settings(dir: &Path, settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    crate::persisted_json::write_json_atomic(&dir.join(SETTINGS_FILE), settings)
}

/// Report each refused field on the system log, so a hand-edit that the
/// app can't honor is visible rather than silently inert.
fn warn_refused(app: &tauri::AppHandle, complaints: &[String]) {
    for c in complaints {
        crate::sys_warn!(app, "settings", "{c}");
    }
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

/// Persist the whole settings struct, replacing the file, and return what
/// was actually stored: out-of-range values are refused (and reported)
/// before the write, so the file never records a value the app would not
/// honor and the caller can show what it got. Errors (with a user-facing
/// message) only if the config dir can't be resolved or the write fails; on
/// failure it also lands on the system log.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<Settings, String> {
    let dir = crate::persisted_json::config_dir(&app)?;
    let (settings, complaints) = validate(settings);
    warn_refused(&app, &complaints);
    write_settings(&dir, &settings).map_err(|e| {
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
        }
    }

    #[test]
    fn round_trips_through_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let s = sample();
        write_settings(dir.path(), &s).unwrap();
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
    }

    #[test]
    fn keybindings_round_trip_with_camelcase_and_optional_skip_editable() {
        let dir = tempfile::tempdir().unwrap();
        write_settings(dir.path(), &sample()).unwrap();
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
                keybindings: None,
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
        write_settings(
            &user,
            &Settings {
                scratch_cap_bytes: Some(4 * 1024 * 1024 * 1024),
                clear_scratch_on_exit: false,
                keybindings: None,
            },
        )
        .unwrap();
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
        write_settings(&user, &sample()).unwrap();
        std::fs::write(workspace.join(SETTINGS_FILE), "{}\n").unwrap();

        assert_eq!(read_settings(&user, &workspace), sample());
    }

    #[test]
    fn write_replaces_rather_than_merges() {
        let dir = tempfile::tempdir().unwrap();
        write_settings(dir.path(), &sample()).unwrap();
        write_settings(dir.path(), &Settings::default()).unwrap();
        assert_eq!(
            read_settings(dir.path(), &no_workspace()),
            Settings::default()
        );
    }
}
