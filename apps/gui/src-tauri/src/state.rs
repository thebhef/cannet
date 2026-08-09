//! Machine-local UI state, persisted host-side (ADR 0032, ADR 0034),
//! across two scopes (ADR 0042).
//!
//! Things the app records as the user works — last project, the open
//! project's layout snapshot, recent BLFs, recent commands — live in
//! `state.json`,
//! read and written through the [`get_state`] / [`set_state`] commands.
//! The frontend holds no authoritative copy: it hydrates [`UiState`] at
//! boot and writes the whole struct back on change.
//!
//! **Two scopes, one filename.** The *user* copy is in Tauri's
//! `app_config_dir`; the *workspace* copy is `.cannet/state.json` inside
//! the open project directory. A read resolves the two, workspace over
//! user per key; a write goes to the scope [`SCOPES`] declares for the
//! key. The split is not uniform, and that is the point: `last_project`
//! and the palette MRU follow the person, while the layout snapshot, the
//! BLF recents, and the BLF channel maps describe one project and travel
//! with it.
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
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::persisted_json::{Scope, ScopeTable};

/// File name under `app_config_dir`.
const STATE_FILE: &str = "state.json";

/// The scope of every key [`UiState`] persists (ADR 0042 §3) — what
/// routes a write to the user's `state.json` or the project's
/// `.cannet/state.json`.
///
/// Nothing here is overridable: a piece of recorded state belongs to one
/// scope or the other, and a value that meant two things at once would
/// just be two values. Which project to reopen and which commands you
/// reach for are facts about the person; the layout, the BLFs opened
/// *in this project*, and the channel→bus mappings are facts about the
/// project.
///
/// The names are the serialized ones. `every_ui_state_key_declares_a_scope`
/// is what keeps this table from drifting away from the struct.
pub(crate) const SCOPES: ScopeTable = &[
    ("last_project", Scope::User),
    ("recent_commands", Scope::User),
    ("layout", Scope::Workspace),
    ("recent_blfs", Scope::Workspace),
    ("blf_channel_maps", Scope::Workspace),
];

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
    /// The open project's working dockview layout — what its panels are
    /// arranged into right now, saved or not. Written only while a
    /// project is open: a session with nothing open leaves no view state
    /// behind, so `None` here is what a scratch launch reads. Opaque —
    /// the host round-trips it verbatim, the same way the project file
    /// treats the layout blob (ADR 0011).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<serde_json::Value>,
    /// Most-recently-opened BLF paths (frontend-capped MRU list).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recent_blfs: Vec<String>,
    /// Most-recently-used command-palette ids (frontend-capped MRU list).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recent_commands: Vec<String>,
    /// Last-accepted BLF channel→bus mappings, so reopening a BLF
    /// pre-fills the channel↔bus dialog. Project-scoped: it lives in the
    /// project's own `.cannet/state.json`, so the directory is the
    /// scoping and no `project_id` key is needed (ADR 0042). Unlike the
    /// spill caches this is user-authored and not recomputable, so it
    /// must not be evicted.
    #[serde(skip_serializing_if = "BlfChannelMaps::is_empty")]
    pub blf_channel_maps: BlfChannelMaps,
}

/// One project's remembered BLF channel→bus mappings. Both maps go
/// channel number → `Bus.id` (JSON object keys, so both outer keys are
/// strings); `""` records a deliberately skipped channel.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BlfChannelMaps {
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

impl BlfChannelMaps {
    /// Whether this project has remembered no mapping at all — the
    /// condition that keeps the key out of a fresh `state.json`.
    fn is_empty(&self) -> bool {
        self.by_path.is_empty() && self.by_channel_count.is_empty()
    }
}

/// Parse state JSON, tolerating junk. A malformed or partial file yields
/// [`UiState::default`] rather than an error — a corrupt state file must
/// never brick startup. Split from IO so it's testable without the
/// filesystem.
fn parse_state(text: &str) -> UiState {
    crate::persisted_json::parse_or_default(text)
}

/// Read `dir/state.json` from a single scope. A missing or unreadable
/// file, or junk contents, yields [`UiState::default`].
fn read_state(dir: &Path) -> UiState {
    match std::fs::read_to_string(dir.join(STATE_FILE)) {
        Ok(text) => parse_state(&text),
        Err(_) => UiState::default(),
    }
}

/// Read the effective UI state across both scopes (ADR 0042 §3):
/// `<user_dir>/state.json` overridden per key by
/// `<workspace_dir>/state.json`.
///
/// Precedence is uniform, not scope-gated: a project-scoped key that a
/// pre-split `state.json` still holds at user scope keeps resolving from
/// there until the first write moves it across.
///
/// A key whose value fails to parse costs that key alone, and its
/// complaint is dropped: unlike `settings.json`, this file is
/// best-effort scaffolding the app regenerates as the user works, so
/// there is nothing to tell them about.
fn read_state_scoped(user_dir: &Path, workspace_dir: &Path) -> UiState {
    crate::persisted_json::read_scoped(user_dir, workspace_dir, STATE_FILE).0
}

/// Write `state` across the two scopes, each key going to the file
/// [`SCOPES`] names for it (ADR 0042 §3). Each file is written to a temp
/// sibling and renamed over the target, so a crash mid-write can't leave
/// a half-written one.
fn write_state(user_dir: &Path, workspace_dir: &Path, state: &UiState) -> std::io::Result<()> {
    crate::persisted_json::write_scoped(user_dir, workspace_dir, STATE_FILE, state, SCOPES)
}

/// Load the persisted UI state. Returns defaults if the config dir can't
/// be resolved or the file is missing / corrupt — reading state never
/// fails for the caller.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_state(app: tauri::AppHandle) -> UiState {
    crate::persisted_json::config_dir(&app)
        .map(|user_dir| read_state_scoped(&user_dir, &crate::workspace_dir(&app)))
        .unwrap_or_default()
}

/// The path of the last project opened or saved-as, read from the
/// **user scope only**.
///
/// This is what the project directory is resolved from at startup
/// (ADR 0042 §1), which is why it can't go through the scoped read path:
/// the workspace scope lives *inside* the directory being resolved.
/// `last_project` is a user-scope value anyway — which project to reopen
/// is about the person, not about any one project.
pub(crate) fn user_scope_last_project(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = crate::persisted_json::config_dir(app).ok()?;
    read_state(&dir).last_project.map(std::path::PathBuf::from)
}

/// Persist the whole UI-state struct, each key at the scope [`SCOPES`]
/// declares for it. Errors (with a user-facing message) only if the config
/// dir can't be resolved or a write fails; on failure it also lands on the
/// system log.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_state(app: tauri::AppHandle, state: UiState) -> Result<(), String> {
    let dir = crate::persisted_json::config_dir(&app)?;
    write_state(&dir, &crate::workspace_dir(&app), &state).map_err(|e| {
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
            blf_channel_maps: BlfChannelMaps {
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
        }
    }

    /// The two scope directories, as they sit on disk.
    struct Scopes {
        _tmp: tempfile::TempDir,
        user: std::path::PathBuf,
        workspace: std::path::PathBuf,
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

        fn write(&self, state: &UiState) {
            write_state(&self.user, &self.workspace, state).unwrap();
        }

        fn effective(&self) -> UiState {
            read_state_scoped(&self.user, &self.workspace)
        }
    }

    #[test]
    fn round_trips_through_the_two_scopes() {
        let s = Scopes::new();
        s.write(&sample());
        assert_eq!(s.effective(), sample());
    }

    #[test]
    fn every_ui_state_key_declares_a_scope() {
        // The exit criterion: a key with no declared scope fails a test
        // rather than defaulting silently. `sample()` populates every
        // field, so every key it serializes is one the struct persists.
        let serde_json::Value::Object(keys) = serde_json::to_value(sample()).unwrap() else {
            panic!("state must serialize to a JSON object");
        };
        for key in keys.keys() {
            assert!(
                crate::persisted_json::scope_of(SCOPES, key).is_some(),
                "state key `{key}` declares no scope"
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
    fn the_project_half_lands_in_the_project_and_the_user_half_follows_the_person() {
        // ADR 0042 §3's scope review, on disk: which project to reopen
        // and the palette MRU are about the person; the layout, the BLFs
        // opened in this project, and its channel maps are about the
        // project.
        let s = Scopes::new();
        s.write(&sample());

        let user = read_state(&s.user);
        assert_eq!(user.last_project, sample().last_project);
        assert_eq!(user.recent_commands, sample().recent_commands);
        assert!(user.layout.is_none(), "the layout is not the user's");
        assert!(user.recent_blfs.is_empty());
        assert!(user.blf_channel_maps.is_empty());

        let project = read_state(&s.workspace);
        assert_eq!(project.layout, sample().layout);
        assert_eq!(project.recent_blfs, sample().recent_blfs);
        assert_eq!(project.blf_channel_maps, sample().blf_channel_maps);
        assert!(project.last_project.is_none(), "not the project's business");
        assert!(project.recent_commands.is_empty());
    }

    #[test]
    fn a_second_project_does_not_see_the_first_projects_state() {
        // The behavioural payoff of the split: one job's BLF list stops
        // bleeding into the next, while the palette MRU follows the
        // person across both.
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("config");
        let a = tmp.path().join("a").join(".cannet");
        let b = tmp.path().join("b").join(".cannet");
        for d in [&user, &a, &b] {
            std::fs::create_dir_all(d).unwrap();
        }
        write_state(
            &user,
            &a,
            &UiState {
                recent_blfs: vec!["/a/drive.blf".into()],
                recent_commands: vec!["project.open".into()],
                ..UiState::default()
            },
        )
        .unwrap();

        let in_b = read_state_scoped(&user, &b);
        assert!(in_b.recent_blfs.is_empty(), "{:?}", in_b.recent_blfs);
        assert_eq!(in_b.recent_commands, vec!["project.open".to_string()]);
    }

    #[test]
    fn a_pre_split_user_state_file_still_resolves_and_moves_across_on_write() {
        // Reads are not scope-gated, so a `state.json` written before the
        // split keeps working; the first write relocates its project half
        // without any migration code (ADR 0042: hand-migrated, and this
        // is what makes that safe to do at leisure).
        let s = Scopes::new();
        std::fs::write(
            s.user.join(STATE_FILE),
            r#"{"layout": {"panels": {}}, "last_project": "/x.cannet_prj"}"#,
        )
        .unwrap();
        let effective = s.effective();
        assert!(effective.layout.is_some(), "the old file still resolves");

        s.write(&effective);

        assert_eq!(read_state(&s.workspace).layout, effective.layout);
        assert_eq!(
            read_state(&s.user).last_project.as_deref(),
            Some("/x.cannet_prj")
        );
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
        // No `project_id` key: the project directory the file sits in is
        // the scoping (ADR 0042).
        let s = parse_state(
            r#"{"blf_channel_maps": {
                "by_path": {"/a.blf": {"0": "bus-a", "2": ""}},
                "by_channel_count": {"3": {"0": "bus-a"}}
            }}"#,
        );
        let p = &s.blf_channel_maps;
        assert_eq!(p.by_path["/a.blf"]["0"], "bus-a");
        assert_eq!(p.by_path["/a.blf"]["2"], "");
        assert_eq!(p.by_channel_count["3"]["0"], "bus-a");
    }

    #[test]
    fn a_second_project_cannot_see_the_first_projects_blf_mappings() {
        // The exit criterion for the `project_id` key's removal: the
        // mappings live in the project's own `.cannet/`, so a different
        // project directory simply has none.
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("config");
        let a = tmp.path().join("a").join(".cannet");
        let b = tmp.path().join("b").join(".cannet");
        for d in [&user, &a, &b] {
            std::fs::create_dir_all(d).unwrap();
        }
        write_state(&user, &a, &sample()).unwrap();

        assert_eq!(
            read_state_scoped(&user, &a).blf_channel_maps,
            sample().blf_channel_maps
        );
        assert_eq!(
            read_state_scoped(&user, &b).blf_channel_maps,
            BlfChannelMaps::default(),
            "project B must not see project A's mappings"
        );
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
        let s = Scopes::new();
        s.write(&sample());
        s.write(&UiState::default());
        assert_eq!(s.effective(), UiState::default());
    }
}
