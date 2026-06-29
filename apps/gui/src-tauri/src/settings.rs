//! User settings, persisted host-side (ADR 0034).
//!
//! Choices the user deliberately sets — as opposed to the machine state
//! the app records as it works ([`crate::state`]) — live in a single JSON
//! file in Tauri's `app_config_dir` (`settings.json`), read and written
//! through the [`get_settings`] / [`set_settings`] commands. The file is a
//! durable, hand-editable contract (ADR 0034): every field is written
//! explicitly (no skip-when-default) so opening `settings.json` shows the
//! full set of knobs and their current values, VS Code-style. The GUI's
//! settings panel is sugar over it, not the only way to edit it.
//!
//! A missing file or missing key resolves to the documented default, so a
//! fresh install and a hand-deleted file behave identically.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

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
}

/// Minimum effective windowed-ring scratch cap (ADR 0002 DS-8). Below this
/// the pre-allocated segment families dominate the budget — one payload
/// segment (4 MiB) plus one filter segment (8 MiB) for a single filtered
/// view already exceed a small cap — so the retained frame window thrashes a
/// whole meta segment at a time and a smaller cap can't be honored usefully.
/// A cap set below the floor is raised to it; `None` (unbounded) is untouched.
pub const MIN_SCRATCH_CAP_BYTES: u64 = 100 * 1024 * 1024;

/// Apply the cap floor (ADR 0002 DS-8): raise a below-floor cap up to
/// [`MIN_SCRATCH_CAP_BYTES`], passing `None` (unbounded) through unchanged.
/// The floor is policy applied where settings meet the store, not in the
/// low-level `set_scratch_cap`, so tests can still drive eviction with a
/// tiny cap.
#[must_use]
pub fn floored_scratch_cap(cap: Option<u64>) -> Option<u64> {
    cap.map(|v| v.max(MIN_SCRATCH_CAP_BYTES))
}

/// Parse settings JSON, tolerating junk. A malformed or partial file
/// yields [`Settings::default`] rather than an error — a corrupt settings
/// file must never brick startup. Split from IO so it's testable without
/// the filesystem.
fn parse_settings(text: &str) -> Settings {
    serde_json::from_str(text).unwrap_or_default()
}

/// Read `dir/settings.json`. A missing or unreadable file, or junk
/// contents, yields [`Settings::default`].
fn read_settings(dir: &Path) -> Settings {
    match std::fs::read_to_string(dir.join(SETTINGS_FILE)) {
        Ok(text) => parse_settings(&text),
        Err(_) => Settings::default(),
    }
}

/// Write `settings` to `dir/settings.json`, creating `dir` if needed.
/// Written to a temp sibling and renamed over the target so a crash
/// mid-write can't leave a half-written file.
fn write_settings(dir: &Path, settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = dir.join(format!("{SETTINGS_FILE}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, dir.join(SETTINGS_FILE))
}

/// Resolve the per-OS config directory (`$XDG_CONFIG_HOME/<id>`,
/// `%APPDATA%\<id>`, `~/Library/Application Support/<id>`).
fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))
}

/// Load the persisted settings. Returns defaults if the config dir can't
/// be resolved or the file is missing / corrupt — reading settings never
/// fails for the caller.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_settings(app: tauri::AppHandle) -> Settings {
    config_dir(&app)
        .map(|dir| read_settings(&dir))
        .unwrap_or_default()
}

/// Persist the whole settings struct, replacing the file. Errors (with a
/// user-facing message) only if the config dir can't be resolved or the
/// write fails; on failure it also lands on the system log.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let dir = config_dir(&app)?;
    write_settings(&dir, &settings).map_err(|e| {
        let msg = format!("failed to write settings: {e}");
        crate::sys_warn!(&app, "settings", "{msg}");
        msg
    })?;
    // Apply the windowed-ring scratch cap (ADR 0002 DS-8) to the live store
    // so a changed cap takes effect on the next flush, not just next launch.
    crate::apply_scratch_cap(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Settings {
        Settings {
            scratch_cap_bytes: Some(8 * 1024 * 1024 * 1024),
            clear_scratch_on_exit: true,
        }
    }

    #[test]
    fn round_trips_through_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let s = sample();
        write_settings(dir.path(), &s).unwrap();
        assert_eq!(read_settings(dir.path()), s);
    }

    #[test]
    fn missing_file_reads_as_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_settings(dir.path()), Settings::default());
    }

    #[test]
    fn defaults_are_unbounded_cap_and_keep_on_exit() {
        let d = Settings::default();
        assert_eq!(d.scratch_cap_bytes, None);
        assert!(!d.clear_scratch_on_exit);
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
    fn cap_floor_raises_below_minimum_and_leaves_unbounded_alone() {
        // Unbounded passes through; a below-floor cap is raised to the floor;
        // at-or-above is untouched (ADR 0002 DS-8).
        assert_eq!(floored_scratch_cap(None), None);
        assert_eq!(floored_scratch_cap(Some(15 * 1024 * 1024)), Some(MIN_SCRATCH_CAP_BYTES));
        assert_eq!(floored_scratch_cap(Some(0)), Some(MIN_SCRATCH_CAP_BYTES));
        assert_eq!(
            floored_scratch_cap(Some(MIN_SCRATCH_CAP_BYTES)),
            Some(MIN_SCRATCH_CAP_BYTES),
        );
        let big = 8 * 1024 * 1024 * 1024;
        assert_eq!(floored_scratch_cap(Some(big)), Some(big));
    }

    #[test]
    fn default_settings_serialize_with_every_key_present() {
        // Unlike state.json, settings.json lists every knob even at its
        // default so the file is discoverable when hand-edited.
        let text = serde_json::to_string(&Settings::default()).unwrap();
        assert!(text.contains("scratch_cap_bytes"), "{text}");
        assert!(text.contains("clear_scratch_on_exit"), "{text}");
    }

    #[test]
    fn write_replaces_rather_than_merges() {
        let dir = tempfile::tempdir().unwrap();
        write_settings(dir.path(), &sample()).unwrap();
        write_settings(dir.path(), &Settings::default()).unwrap();
        assert_eq!(read_settings(dir.path()), Settings::default());
    }
}
