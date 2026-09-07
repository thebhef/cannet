//! Sticky machine state for log export: the last-used export folder,
//! format, and name template — machine-local UI state host-side
//! (ADR 0032), the same shape [`crate::server_trust`]'s trust store is.
//!
//! **Its own file, `export.json`, at user scope only.** Not a project
//! fact — a folder and format chosen for one export are what the next
//! export anywhere pre-fills — and not a *setting* either, so
//! `settings.json` (ADR 0034) is equally wrong. Best-effort and
//! unversioned like the rest of the machine-local documents: a missing
//! or corrupt file reads as the defaults rather than failing anything.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// File name under `app_config_dir`.
const EXPORT_STATE_FILE: &str = "export.json";

/// The name template a fresh install — or a project with nothing
/// exported yet — starts with: the slugified project name plus the
/// capture's wall-clock start.
pub(crate) const DEFAULT_NAME_TEMPLATE: &str = "{project}-{start}";

/// The file format an export or a logger writes. Live logging is
/// BLF-only for now; export offers both.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportFormat {
    #[default]
    Blf,
    Mdf,
}

/// The persisted document: what the next export dialog pre-fills.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExportState {
    /// The last folder an export was saved to. `None` until the first
    /// export — the OS picker then opens with no seeded folder rather
    /// than an invented one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    pub format: ExportFormat,
    pub name_template: String,
}

impl Default for ExportState {
    fn default() -> Self {
        Self {
            folder: None,
            format: ExportFormat::default(),
            name_template: DEFAULT_NAME_TEMPLATE.to_string(),
        }
    }
}

/// Read `dir/export.json`. A missing, unreadable, or malformed file
/// reads as the defaults, same as every other best-effort config file
/// this host keeps.
pub(crate) fn read(dir: &Path) -> ExportState {
    match std::fs::read_to_string(dir.join(EXPORT_STATE_FILE)) {
        Ok(text) => crate::persisted_json::parse_or_default(&text),
        Err(_) => ExportState::default(),
    }
}

/// Write `state` to `dir/export.json`, atomically (temp sibling +
/// rename), creating the directory if needed.
pub(crate) fn write(dir: &Path, state: &ExportState) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    crate::persisted_json::write_json_atomic(&dir.join(EXPORT_STATE_FILE), state)
}

/// Tauri command — the export dialog's (and a logger panel's) starting
/// point: the folder, format, and name template the last export left
/// behind, or the defaults on a fresh install.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_export_state(app: tauri::AppHandle) -> Result<ExportState, String> {
    let dir = crate::persisted_json::config_dir(&app)?;
    Ok(read(&dir))
}

/// Tauri command — remember the folder, format, and name template an
/// export (or a logger) just used, so the next one starts there.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_export_state(
    app: tauri::AppHandle,
    folder: Option<String>,
    format: ExportFormat,
    name_template: String,
) -> Result<(), String> {
    let dir = crate::persisted_json::config_dir(&app)?;
    write(
        &dir,
        &ExportState {
            folder,
            format,
            name_template,
        },
    )
    .map_err(|e| format!("failed to save the export defaults: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_file_reads_as_the_documented_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let state = read(dir.path());
        assert_eq!(state.folder, None);
        assert_eq!(state.format, ExportFormat::Blf);
        assert_eq!(state.name_template, "{project}-{start}");
    }

    #[test]
    fn a_corrupt_file_reads_as_the_defaults_rather_than_failing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(EXPORT_STATE_FILE), "not json").unwrap();
        assert_eq!(read(dir.path()), ExportState::default());
    }

    #[test]
    fn a_written_state_round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let state = ExportState {
            folder: Some("C:\\logs\\bench".to_string()),
            format: ExportFormat::Mdf,
            name_template: "{project}-{now}".to_string(),
        };
        write(dir.path(), &state).unwrap();
        assert_eq!(read(dir.path()), state);
    }

    #[test]
    fn writing_creates_the_directory_if_needed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("nested").join("config");
        write(&dir, &ExportState::default()).unwrap();
        assert!(dir.join(EXPORT_STATE_FILE).is_file());
    }

    #[test]
    fn every_format_has_a_stable_wire_name() {
        assert_eq!(serde_json::to_value(ExportFormat::Blf).unwrap(), "blf");
        assert_eq!(serde_json::to_value(ExportFormat::Mdf).unwrap(), "mdf");
    }

    #[test]
    fn a_cleared_folder_is_not_written_to_the_file() {
        // `skip_serializing_if` is how "nothing chosen yet" is spelled,
        // matching the rest of the machine-local documents.
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            &ExportState {
                folder: None,
                ..ExportState::default()
            },
        )
        .unwrap();
        let text = std::fs::read_to_string(dir.path().join(EXPORT_STATE_FILE)).unwrap();
        assert!(!text.contains("folder"), "{text}");
    }
}
