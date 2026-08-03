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
/// The exceptions are the settings about *the person at the keyboard*
/// rather than about the work: what the settings view reveals
/// (`show_developer_settings`), how verbose their log view is
/// (`system_log_min_level`), and how long a status notice dwells before
/// it clears (`notice_dwell_ms`, a reading-speed accommodation). None of
/// those are a project's business, so they stay at user scope.
///
/// The names are the serialized ones. `every_settings_key_declares_a_scope`
/// is what keeps this table from drifting away from the struct.
pub(crate) const SCOPES: ScopeTable = &[
    ("scratch_cap_bytes", Scope::UserOverridable),
    ("clear_scratch_on_exit", Scope::UserOverridable),
    ("keybindings", Scope::UserOverridable),
    ("show_developer_settings", Scope::User),
    ("system_log_min_level", Scope::User),
    ("notice_dwell_ms", Scope::User),
    ("plot_fetch_interval_ms", Scope::UserOverridable),
    ("view_refresh_interval_ms", Scope::UserOverridable),
    ("follow_window_ms", Scope::UserOverridable),
    ("recent_blfs_limit", Scope::UserOverridable),
    ("recent_commands_limit", Scope::UserOverridable),
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Lowest severity the System Messages panel shows — one of
    /// [`SYSTEM_LOG_LEVELS`], default `info`. It is a preference ("how
    /// verbose do I want my log view") rather than panel state, so it
    /// survives closing and reopening the panel; the panel's *source*
    /// filter is view-local and stays in its dockview params.
    pub system_log_min_level: String,
    /// How long a transient status notice stays frozen in the header
    /// before the bar reverts to the resting residency line. Default
    /// 3000 ms. Nothing is lost by shortening or lengthening it —
    /// notices are mirrored to the system log — so it is purely a
    /// reading-speed accommodation.
    pub notice_dwell_ms: u64,
    /// How often an open plot asks the host for a resampled window
    /// while a capture runs. Default 67 ms (~15 Hz). Redraw stays
    /// pinned to rAF; this governs only the fetch, which is where the
    /// host-side cost is (ADR 0025).
    pub plot_fetch_interval_ms: u64,
    /// How often a paged view re-reads the tail while a capture runs —
    /// the chronological and filtered traces, by-id, signals, and the
    /// transmit/RBS host mirrors. Default 250 ms. It bounds both the
    /// UI-thread parse cost and the host-side window scans under a
    /// high-rate stream.
    pub view_refresh_interval_ms: u64,
    /// Width of a plot's follow-live x-window before the user has set
    /// one by zooming or panning, in milliseconds (the settings view
    /// edits it in seconds). Default 10 000 ms. Site-specific: 10 s is
    /// wrong for a slow body bus.
    pub follow_window_ms: u64,
    /// How many recently-opened BLFs the File menu remembers. Default
    /// 8. `0` remembers none.
    pub recent_blfs_limit: u64,
    /// How many recently-run commands the palette floats to the top.
    /// Default 10. `0` remembers none.
    pub recent_commands_limit: u64,
}

/// The smallest legal value of any millisecond-interval setting.
///
/// A hard implementation limit rather than a taste: an interval of zero
/// is a busy loop, and below one millisecond is not representable in the
/// timer APIs on either side of the IPC. Stated once, enforced in
/// [`validate`], and published as the `min` of every interval field's
/// descriptor rather than restated there
/// (`every_published_minimum_is_the_one_validate_enforces`).
pub const MIN_INTERVAL_MS: u64 = 1;

/// The severity names [`Settings::system_log_min_level`] accepts, least
/// to most severe — the same ladder the frontend's
/// `SYSTEM_LOG_LEVEL_RANK` and [`crate::system_log::LogLevel`] order by.
///
/// Stated once: [`validate`] refuses anything outside it, and it is what
/// the field's descriptor publishes as its `enum` options rather than
/// re-listing them ([`crate::settings_descriptor`]).
pub const SYSTEM_LOG_LEVELS: &[&str] = &["debug", "info", "warn", "error"];

impl Default for Settings {
    fn default() -> Self {
        Self {
            scratch_cap_bytes: None,
            clear_scratch_on_exit: false,
            keybindings: None,
            show_developer_settings: false,
            system_log_min_level: "info".to_string(),
            notice_dwell_ms: 3_000,
            plot_fetch_interval_ms: 67,
            view_refresh_interval_ms: 250,
            follow_window_ms: 10_000,
            recent_blfs_limit: 8,
            recent_commands_limit: 10,
        }
    }
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
/// as the `min` of the field's descriptor
/// ([`crate::settings_descriptor`]) rather than re-declared there. `None`
/// (unbounded) is always legal.
pub const MIN_SCRATCH_CAP_BYTES: u64 = 100 * 1024 * 1024;

/// Check every settings value against its documented bounds, returning the
/// accepted settings plus one human-readable complaint per refused field.
///
/// A refused field falls back to its default — the same resolution an absent
/// field gets — rather than being repaired to the nearest legal value. The
/// file is a user-authored document (ADR 0034): we report what we refuse and
/// leave their text alone, exactly as a hand-edited keybinding that names an
/// unknown command is dropped and reported rather than rewritten.
///
/// Crate-visible only so the descriptor table can be tested against it —
/// `every_published_minimum_is_the_one_validate_enforces` proves the
/// bound a control publishes is the bound this function applies. The
/// ingress calls are [`get_settings`] and [`set_settings`]; there is no
/// other caller.
pub(crate) fn validate(settings: Settings) -> (Settings, Vec<String>) {
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
    if !SYSTEM_LOG_LEVELS.contains(&settings.system_log_min_level.as_str()) {
        let bad = &settings.system_log_min_level;
        let known = SYSTEM_LOG_LEVELS.join(", ");
        complaints.push(format!(
            "system_log_min_level \"{bad}\" is not one of {known}; ignoring it — the \
             System Messages panel filters at its default"
        ));
        settings.system_log_min_level = Settings::default().system_log_min_level;
    }
    let d = Settings::default();
    for (key, value, min, default) in [
        (
            "notice_dwell_ms",
            &mut settings.notice_dwell_ms,
            MIN_INTERVAL_MS,
            d.notice_dwell_ms,
        ),
        (
            "plot_fetch_interval_ms",
            &mut settings.plot_fetch_interval_ms,
            MIN_INTERVAL_MS,
            d.plot_fetch_interval_ms,
        ),
        (
            "view_refresh_interval_ms",
            &mut settings.view_refresh_interval_ms,
            MIN_INTERVAL_MS,
            d.view_refresh_interval_ms,
        ),
        (
            "follow_window_ms",
            &mut settings.follow_window_ms,
            MIN_INTERVAL_MS,
            d.follow_window_ms,
        ),
    ] {
        refuse_below(&mut complaints, key, value, min, default);
    }
    (settings, complaints)
}

/// Refuse `value` if it is below `min`, reporting the field by name and
/// resolving it to `default` — the shared shape of every numeric bound
/// in [`validate`], so a new bounded field is one table row rather than
/// another hand-written `if`.
fn refuse_below(complaints: &mut Vec<String>, key: &str, value: &mut u64, min: u64, default: u64) {
    if *value >= min {
        return;
    }
    complaints.push(format!(
        "{key} {value} is below the minimum of {min}; ignoring it — using the \
         default ({default})"
    ));
    *value = default;
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
            system_log_min_level: "warn".to_string(),
            notice_dwell_ms: 1_500,
            plot_fetch_interval_ms: 33,
            view_refresh_interval_ms: 500,
            follow_window_ms: 30_000,
            recent_blfs_limit: 20,
            recent_commands_limit: 3,
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
        assert_eq!(d.system_log_min_level, "info");
    }

    #[test]
    fn an_unknown_system_log_level_is_refused_and_reported() {
        // Same contract as the cap (ADR 0034 / Stage 1 item 3): a value
        // the app can't honor is refused and reported, and resolves to
        // the default — never silently repaired to something else.
        let (accepted, complaints) = validate(Settings {
            system_log_min_level: "verbose".to_string(),
            ..Settings::default()
        });
        assert_eq!(accepted.system_log_min_level, "info");
        assert_eq!(complaints.len(), 1, "{complaints:?}");
        assert!(
            complaints[0].contains("system_log_min_level"),
            "{complaints:?}"
        );
        assert!(complaints[0].contains("verbose"), "{complaints:?}");
    }

    #[test]
    fn every_declared_system_log_level_is_accepted() {
        for level in SYSTEM_LOG_LEVELS {
            let (accepted, complaints) = validate(Settings {
                system_log_min_level: (*level).to_string(),
                ..Settings::default()
            });
            assert_eq!(&accepted.system_log_min_level, level);
            assert!(complaints.is_empty(), "{level}: {complaints:?}");
        }
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
    fn a_file_written_before_a_field_existed_resolves_to_that_field_s_default() {
        // The promotion promise, in its strongest form: a settings
        // document carrying only the keys the store had before Stage 3
        // must produce exactly the defaults — so an install nobody has
        // touched behaves as it did before the fields existed.
        let legacy = r#"{
            "scratch_cap_bytes": null,
            "clear_scratch_on_exit": false,
            "keybindings": null,
            "show_developer_settings": false
        }"#;
        assert_eq!(parse_settings(legacy), Settings::default());
        // Same for the empty document and the missing one.
        assert_eq!(parse_settings("{}"), Settings::default());
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let s = parse_settings(r#"{"scratch_cap_bytes": 1024, "future_key": 42}"#);
        assert_eq!(s.scratch_cap_bytes, Some(1024));
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
        // default so the file is discoverable when hand-edited. Checked
        // against `SCOPES` rather than a hand-written key list, which
        // `every_settings_key_declares_a_scope` already pins to the
        // struct in both directions.
        let serde_json::Value::Object(keys) = serde_json::to_value(Settings::default()).unwrap()
        else {
            panic!("settings must serialize to a JSON object");
        };
        for (name, _) in SCOPES {
            assert!(
                keys.contains_key(*name),
                "`{name}` is not in the written file"
            );
        }
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
