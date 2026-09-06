//! "Show in Explorer" / "Show in Finder": select one path in the
//! platform's file manager, from the logger file gridview's context
//! menu.
//!
//! A one-line process spawn, factored so the platform-specific command
//! line — the only part with a rule worth getting wrong — is a pure
//! function the tests can check without actually popping a file-manager
//! window.

use std::path::{Path, PathBuf};

/// The program and arguments that reveal `path` in the platform's file
/// manager. Windows and macOS both select the item in its parent
/// window; the generic Unix fallback has no "select" verb across file
/// managers, so it opens the containing directory instead.
fn reveal_command(path: &Path) -> (&'static str, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        ("explorer", vec![format!("/select,{}", path.display())])
    }
    #[cfg(target_os = "macos")]
    {
        ("open", vec!["-R".to_string(), path.display().to_string()])
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = path.parent().unwrap_or(path);
        ("xdg-open", vec![dir.display().to_string()])
    }
}

/// Tauri command — open the platform's file manager on `path`. Fire and
/// forget: the spawned process outlives this call, and its own success
/// or failure to open a window is not something the caller can act on
/// beyond knowing the launch itself succeeded.
#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let (program, args) = reveal_command(&path);
    std::process::Command::new(program)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open the file manager: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "windows")]
    fn windows_selects_the_file_in_its_parent_window() {
        let (program, args) = reveal_command(Path::new(r"C:\logs\run.blf"));
        assert_eq!(program, "explorer");
        assert_eq!(args, vec![r"/select,C:\logs\run.blf".to_string()]);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_selects_the_file_in_its_parent_window() {
        let (program, args) = reveal_command(Path::new("/logs/run.blf"));
        assert_eq!(program, "open");
        assert_eq!(args, vec!["-R".to_string(), "/logs/run.blf".to_string()]);
    }

    #[test]
    #[cfg(all(unix, not(target_os = "macos")))]
    fn linux_opens_the_containing_directory() {
        let (program, args) = reveal_command(Path::new("/logs/sub/run.blf"));
        assert_eq!(program, "xdg-open");
        assert_eq!(args, vec!["/logs/sub".to_string()]);
    }
}
