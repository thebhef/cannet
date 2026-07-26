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
        let read: Sample =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
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

    /// Regression test for the non-atomic-save bug (task 0030 item 7):
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

    #[test]
    fn parse_versioned_accepts_exact_version_and_rejects_others() {
        assert!(parse_versioned::<Sample>(r#"{"schema_version":1}"#, "sample", 1).is_ok());
        assert!(parse_versioned::<Sample>(r#"{"schema_version":2}"#, "sample", 1).is_err());
        assert!(parse_versioned::<Sample>("{}", "sample", 1).is_err());
        assert!(parse_versioned::<Sample>("not json", "sample", 1).is_err());
    }
}
