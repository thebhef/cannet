//! Machine-local UI state, persisted host-side (ADR 0032, ADR 0034).
//!
//! Things the app records as the user works — last project, no-project
//! layout snapshot, recent BLFs, recent commands — live in a single JSON
//! file in Tauri's `app_config_dir` (`state.json`), read and written
//! through the [`get_state`] / [`set_state`] commands. The frontend holds
//! no authoritative copy: it hydrates [`UiState`] at boot and writes the
//! whole struct back on change.
//!
//! This is *state*, not *settings*: none of it is a choice the user
//! deliberately sets. ADR 0034 splits the two — user intent lives in a
//! sibling `settings.json`, and this file is renamed from the
//! `preferences.json` ADR 0032 introduced because its contents were never
//! preferences. Best-effort and unversioned: a corrupt or absent file
//! resolves to defaults, and the old `preferences.json` is dropped, not
//! migrated (ADR 0011).
//!
//! This is deliberately *not* the `WebView`'s `localStorage`, where these
//! values used to live — see ADR 0032 for why (WebView-owned, opaque,
//! base-dir-inconsistent, and clearable on a cache wipe).
//!
//! Window geometry is the one machine-local value *not* here: it is
//! restored before the `WebView` exists, so `tauri-plugin-window-state`
//! owns it in its own `.window-state.json` beside this file (see
//! [`crate::window_state`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// File name under `app_config_dir`.
const STATE_FILE: &str = "state.json";

/// The persisted machine-local UI state. Every field is optional /
/// defaulted so a partial or absent file still parses; unknown fields a
/// newer build wrote are ignored rather than rejected (these are
/// best-effort conveniences, not a versioned document like the project
/// file).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct UiState {
    /// Absolute path of the last project opened or saved-as, reopened on
    /// launch. `None` means "no named project" — fall back to `layout`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_project: Option<String>,
    /// The no-project dockview layout snapshot (the working layout when
    /// no project is open). Opaque — the host round-trips it verbatim,
    /// the same way the project file treats the layout blob (ADR 0011).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<serde_json::Value>,
    /// Most-recently-opened BLF paths (frontend-capped MRU list).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recent_blfs: Vec<String>,
    /// Most-recently-used command-palette ids (frontend-capped MRU list).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recent_commands: Vec<String>,
    /// Last-accepted BLF channel→bus mappings, so reopening a BLF
    /// pre-fills the channel↔bus dialog. Keyed by `project_id` (bus ids
    /// are project-scoped). Unlike the spill caches this is user-authored
    /// and not recomputable, so it must not be evicted.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub blf_channel_maps: BTreeMap<String, ProjectBlfChannelMaps>,
}

/// One project's remembered BLF channel→bus mappings. Both maps go
/// channel number → `Bus.id` (JSON object keys, so both outer keys are
/// strings); `""` records a deliberately skipped channel.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProjectBlfChannelMaps {
    /// Exact match: absolute BLF path → mapping. Pre-fill for reopening
    /// the very same file.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub by_path: BTreeMap<String, BTreeMap<String, String>>,
    /// Fallback: distinct-channel count → the mapping last accepted for
    /// a BLF with that many channels. An unrecognized file is assumed to
    /// come from the same source as the last same-shaped one, as a
    /// starting point.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub by_channel_count: BTreeMap<String, BTreeMap<String, String>>,
}

/// Parse state JSON, tolerating junk. A malformed or partial file yields
/// [`UiState::default`] rather than an error — a corrupt state file must
/// never brick startup. Split from IO so it's testable without the
/// filesystem.
fn parse_state(text: &str) -> UiState {
    serde_json::from_str(text).unwrap_or_default()
}

/// Read `dir/state.json`. A missing or unreadable file, or junk contents,
/// yields [`UiState::default`].
fn read_state(dir: &Path) -> UiState {
    match std::fs::read_to_string(dir.join(STATE_FILE)) {
        Ok(text) => parse_state(&text),
        Err(_) => UiState::default(),
    }
}

/// Write `state` to `dir/state.json`, creating `dir` if needed. Written to
/// a temp sibling and renamed over the target so a crash mid-write can't
/// leave a half-written file.
fn write_state(dir: &Path, state: &UiState) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(state)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = dir.join(format!("{STATE_FILE}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, dir.join(STATE_FILE))
}

/// Resolve the per-OS config directory (`$XDG_CONFIG_HOME/<id>`,
/// `%APPDATA%\<id>`, `~/Library/Application Support/<id>`).
fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))
}

/// Load the persisted UI state. Returns defaults if the config dir can't
/// be resolved or the file is missing / corrupt — reading state never
/// fails for the caller.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_state(app: tauri::AppHandle) -> UiState {
    config_dir(&app)
        .map(|dir| read_state(&dir))
        .unwrap_or_default()
}

/// Persist the whole UI-state struct, replacing the file. Errors (with a
/// user-facing message) only if the config dir can't be resolved or the
/// write fails; on failure it also lands on the system log.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_state(app: tauri::AppHandle, state: UiState) -> Result<(), String> {
    let dir = config_dir(&app)?;
    write_state(&dir, &state).map_err(|e| {
        let msg = format!("failed to write state: {e}");
        crate::sys_warn!(&app, "state", "{msg}");
        msg
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> UiState {
        UiState {
            last_project: Some("/home/u/bench.cannet_prj".into()),
            layout: Some(serde_json::json!({ "grid": {}, "panels": {} })),
            recent_blfs: vec!["/a.blf".into(), "/b.blf".into()],
            recent_commands: vec!["open-project".into()],
            blf_channel_maps: BTreeMap::from([(
                "5f2d7c1e-9a41-4a5e-8b1c-2e6f0d3a9b70".to_string(),
                ProjectBlfChannelMaps {
                    by_path: BTreeMap::from([(
                        "/captures/drive.blf".to_string(),
                        BTreeMap::from([
                            ("0".to_string(), "bus-pt".to_string()),
                            ("1".to_string(), String::new()),
                        ]),
                    )]),
                    by_channel_count: BTreeMap::from([(
                        "2".to_string(),
                        BTreeMap::from([
                            ("0".to_string(), "bus-pt".to_string()),
                            ("1".to_string(), String::new()),
                        ]),
                    )]),
                },
            )]),
        }
    }

    #[test]
    fn round_trips_through_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let s = sample();
        write_state(dir.path(), &s).unwrap();
        assert_eq!(read_state(dir.path()), s);
    }

    #[test]
    fn missing_file_reads_as_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_state(dir.path()), UiState::default());
    }

    #[test]
    fn junk_contents_read_as_default() {
        assert_eq!(parse_state("not json"), UiState::default());
        assert_eq!(parse_state("[1, 2, 3]"), UiState::default());
    }

    #[test]
    fn partial_file_keeps_present_fields_and_defaults_the_rest() {
        let s = parse_state(r#"{"last_project": "/x.cannet_prj"}"#);
        assert_eq!(s.last_project.as_deref(), Some("/x.cannet_prj"));
        assert!(s.recent_blfs.is_empty());
        assert!(s.layout.is_none());
    }

    #[test]
    fn blf_channel_maps_parse_from_nested_json() {
        let s = parse_state(
            r#"{"blf_channel_maps": {"pid": {
                "by_path": {"/a.blf": {"0": "bus-a", "2": ""}},
                "by_channel_count": {"3": {"0": "bus-a"}}
            }}}"#,
        );
        let p = &s.blf_channel_maps["pid"];
        assert_eq!(p.by_path["/a.blf"]["0"], "bus-a");
        assert_eq!(p.by_path["/a.blf"]["2"], "");
        assert_eq!(p.by_channel_count["3"]["0"], "bus-a");
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let s = parse_state(r#"{"recent_blfs": ["/x.blf"], "future_key": 42}"#);
        assert_eq!(s.recent_blfs, vec!["/x.blf".to_string()]);
    }

    #[test]
    fn default_state_serializes_to_an_empty_object() {
        // Every field skips when empty, so a fresh install writes `{}`
        // rather than a wall of nulls.
        assert_eq!(serde_json::to_string(&UiState::default()).unwrap(), "{}");
    }

    #[test]
    fn write_replaces_rather_than_merges() {
        let dir = tempfile::tempdir().unwrap();
        write_state(dir.path(), &sample()).unwrap();
        write_state(dir.path(), &UiState::default()).unwrap();
        assert_eq!(read_state(dir.path()), UiState::default());
    }
}
