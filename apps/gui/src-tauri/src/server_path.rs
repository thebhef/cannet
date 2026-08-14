//! Putting the bundled `cannet-server` on the user's `PATH`.
//!
//! Every install carries the server binary beside the frozen sidecar it
//! supervises (ADR 0036), but running it is a terminal act — so the one
//! thing the app can usefully do is make the terminal able to find it.
//! That is this module: a single command that adds the bundled server's
//! directory to the *user's* environment, needing no elevation and
//! touching nothing machine-wide. It never starts a server.
//!
//! The edit is idempotent on both platforms: running it twice reports
//! that the directory is already there and writes nothing.
//!
//! The two mechanisms differ because the platforms' notions of "the
//! user's PATH" do:
//!
//! - **Windows** — the `Path` value under `HKCU\Environment`, read and
//!   written through PowerShell. The value's registry type is preserved
//!   (a `REG_EXPAND_SZ` `PATH` full of `%USERPROFILE%`-style entries
//!   would stop expanding if it were rewritten as `REG_SZ`), and the
//!   read is explicitly non-expanding so those entries are not baked
//!   into literals on the way through.
//! - **macOS** — an `export` line appended to `~/.zprofile`, zsh's
//!   login-shell profile.
//!
//! Everything that decides *what* to write is a pure function over the
//! current value, so the semantics are unit-tested on every platform
//! rather than only on the one whose I/O they belong to.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// The bundled server's file name, as `scripts/stage-server.py` stages
/// it into the bundle's resource root.
#[cfg(windows)]
const SERVER_FILE_NAME: &str = "cannet-server.exe";
#[cfg(not(windows))]
const SERVER_FILE_NAME: &str = "cannet-server";

/// What a `PATH` edit turns out to be once the current value is known.
///
/// On a platform with neither mechanism only the tests construct it —
/// they, unlike the mechanisms, are compiled everywhere.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
enum PathEdit {
    /// The directory is already reachable; nothing is written.
    AlreadyPresent,
    /// The full new value to write.
    Write(String),
}

/// The directory holding the bundled server — the bundle's resource
/// root, which is also where the frozen sidecar onedir lives.
///
/// The binary's presence is checked rather than assumed: a development
/// build stages no server (`build.rs` leaves the staging directory
/// empty), and "added a directory that contains no server to your PATH"
/// is a worse outcome than a refusal that says so.
fn bundled_server_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("cannot locate this install's resources: {e}"))?;
    let server = dir.join(SERVER_FILE_NAME);
    if !server.is_file() {
        return Err(format!(
            "this build carries no bundled {SERVER_FILE_NAME} (looked in {}); \
             development builds don't stage one",
            dir.display()
        ));
    }
    Ok(dir)
}

/// Add the bundled server's directory to the user's `PATH`, and report
/// what happened in one sentence.
///
/// Both the sentence and any failure also reach the System Messages
/// panel, which is where a command's outcome is read in this app.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn add_server_to_path(app: tauri::AppHandle) -> Result<String, String> {
    let outcome = bundled_server_dir(&app).and_then(|dir| add_to_path(&dir));
    match &outcome {
        Ok(message) => {
            crate::sys_info!(&app, "server", "{message}");
        }
        Err(message) => {
            crate::sys_error!(&app, "server", "add to PATH failed: {message}");
        }
    }
    outcome
}

// ---------------------------------------------------------------- Windows

/// The `PATH` value that puts `dir` on it, given the current *raw*
/// (unexpanded) value.
///
/// The new entry is appended to the string as it stands rather than to
/// a split-and-rejoined list: a user `PATH` may legitimately contain
/// empty entries, and rebuilding the value would quietly drop them.
/// Comparison ignores case and a trailing separator, because Windows
/// does.
///
/// Compiled everywhere so its tests run everywhere: the CI that gates
/// this repository is Linux, and semantics this fiddly should not be
/// checked only on the one platform that executes them.
#[cfg_attr(not(windows), allow(dead_code))]
fn user_path_with(current: &str, dir: &str) -> PathEdit {
    if current.split(';').any(|entry| same_directory(entry, dir)) {
        return PathEdit::AlreadyPresent;
    }
    PathEdit::Write(if current.is_empty() || current.ends_with(';') {
        format!("{current}{dir}")
    } else {
        format!("{current};{dir}")
    })
}

/// Whether two `PATH` entries name the same directory, by Windows'
/// rules. An empty entry names the current directory, never `dir`.
#[cfg_attr(not(windows), allow(dead_code))]
fn same_directory(entry: &str, dir: &str) -> bool {
    let entry = entry.trim().trim_end_matches(['\\', '/']);
    !entry.is_empty() && entry.eq_ignore_ascii_case(dir.trim_end_matches(['\\', '/']))
}

/// Read `HKCU\Environment\Path` without expanding it, and set it back
/// with the same registry type.
///
/// PowerShell rather than a registry crate: this crate forbids `unsafe`
/// and takes no Win32 dependency for one-off platform work (as
/// `project_dir.rs` does for `mklink`). It also buys the notification —
/// see [`WRITE_USER_PATH`].
#[cfg(windows)]
const READ_USER_PATH: &str = "$ErrorActionPreference='Stop'; \
     $k=Get-Item -LiteralPath 'HKCU:\\Environment'; $n='Path'; \
     if ($k.GetValueNames() -contains $n) { Write-Output $k.GetValueKind($n); \
     [Console]::Out.Write($k.GetValue($n,'','DoNotExpandEnvironmentNames')) } \
     else { Write-Output 'ExpandString' }";

/// Write the new value, then make running programs notice.
///
/// The value and its type arrive in the environment, not on the command
/// line: a `PATH` is long, arbitrary, and full of characters a shell
/// would like to interpret.
///
/// `Set-ItemProperty` alone updates only the registry — Explorer keeps
/// serving its cached environment block to every process it launches
/// until a `WM_SETTINGCHANGE` tells it otherwise, so without the second
/// line a new terminal would keep the old `PATH` until the next logon.
/// Broadcasting that message directly needs Win32 FFI, which this crate
/// forbids; .NET's user-scope setter broadcasts it as part of its own
/// contract, so deleting a variable that was never set is a registry
/// no-op with exactly the wanted side effect.
#[cfg(windows)]
const WRITE_USER_PATH: &str = "$ErrorActionPreference='Stop'; \
     Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name 'Path' \
     -Value $env:CANNET_NEW_USER_PATH -Type $env:CANNET_NEW_USER_PATH_KIND; \
     [Environment]::SetEnvironmentVariable('CANNET_PATH_BROADCAST',$null,'User')";

/// Run one single-line PowerShell script with `env` in its environment,
/// and hand back its stdout.
///
/// Both scripts are written with single quotes only, so the whole script
/// survives the command line as one argument without escaping. The
/// interpreter is named absolutely: this must not depend on the very
/// `PATH` it is about to edit.
#[cfg(windows)]
fn powershell(script: &str, env: &[(&str, &str)]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW from winbase.h; inlined to avoid a whole winapi
    // dependency for a single constant (as in `project_dir.rs`).
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let exe = format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let mut command = std::process::Command::new(exe);
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    for (name, value) in env {
        command.env(name, value);
    }
    let out = command
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("could not run PowerShell: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "PowerShell failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Split the read script's output into the value's registry type and
/// the raw value itself. The type is the first line; everything after
/// it is the value, verbatim — a `PATH` has no trailing whitespace to
/// trim that would not equally be part of an entry.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_user_path(stdout: &str) -> Result<(String, String), String> {
    let (kind, value) = stdout.split_once('\n').unwrap_or((stdout, ""));
    let kind = kind.trim();
    if kind != "String" && kind != "ExpandString" {
        return Err(format!(
            "the user PATH is a {kind} value, which this command will not rewrite"
        ));
    }
    Ok((kind.to_string(), value.to_string()))
}

#[cfg(windows)]
fn add_to_path(dir: &Path) -> Result<String, String> {
    let dir = dir.to_string_lossy().into_owned();
    let (kind, current) = parse_user_path(&powershell(READ_USER_PATH, &[])?)?;
    match user_path_with(&current, &dir) {
        PathEdit::AlreadyPresent => Ok(format!("{dir} is already on your user PATH")),
        PathEdit::Write(value) => {
            powershell(
                WRITE_USER_PATH,
                &[
                    ("CANNET_NEW_USER_PATH", value.as_str()),
                    ("CANNET_NEW_USER_PATH_KIND", kind.as_str()),
                ],
            )?;
            Ok(format!(
                "added {dir} to your user PATH; open a new terminal and run cannet-server"
            ))
        }
    }
}

// ------------------------------------------------------------------ macOS

/// The comment that marks the line this command owns, so a second run
/// recognises its own work and a reader knows where the line came from.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const ZPROFILE_MARKER: &str = "# added by cannet";

/// `~/.zprofile` with an `export` line for `dir` appended, given its
/// current contents.
///
/// The line is written once: a profile that already carries it is left
/// exactly as it is, byte for byte. `dir` is placed *ahead* of the
/// inherited `PATH` for the same reason every installer does — the
/// entry the user just asked for should win — and the whole file keeps
/// its own trailing newline discipline.
///
/// Compiled everywhere, for the reason given on [`user_path_with`].
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn zprofile_with(current: &str, dir: &str) -> Result<PathEdit, String> {
    // The path goes inside double quotes, which is what makes spaces
    // safe. A character that would end the quoting or start an
    // expansion cannot be made safe that way, and a corrupted login
    // profile is a bad way to find out.
    if dir.contains(['"', '$', '`', '\\']) {
        return Err(format!(
            "{dir} contains a character that cannot be safely written into a shell profile"
        ));
    }
    let line = format!("export PATH=\"{dir}:$PATH\"");
    if current.lines().any(|l| l.trim() == line) {
        return Ok(PathEdit::AlreadyPresent);
    }
    let mut next = current.to_string();
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    if !next.is_empty() {
        next.push('\n');
    }
    next.push_str(ZPROFILE_MARKER);
    next.push('\n');
    next.push_str(&line);
    next.push('\n');
    Ok(PathEdit::Write(next))
}

#[cfg(target_os = "macos")]
fn add_to_path(dir: &Path) -> Result<String, String> {
    let home = std::env::var_os("HOME").ok_or("there is no HOME in this process's environment")?;
    let profile = PathBuf::from(home).join(".zprofile");
    let current = match std::fs::read_to_string(&profile) {
        Ok(text) => text,
        // A user who has never had one is the common case, not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("could not read {}: {e}", profile.display())),
    };
    let dir = dir.to_string_lossy().into_owned();
    match zprofile_with(&current, &dir)? {
        PathEdit::AlreadyPresent => Ok(format!("{dir} is already exported from ~/.zprofile")),
        PathEdit::Write(next) => {
            std::fs::write(&profile, next)
                .map_err(|e| format!("could not write {}: {e}", profile.display()))?;
            Ok(format!(
                "added {dir} to ~/.zprofile; open a new terminal and run cannet-server"
            ))
        }
    }
}

/// Linux ships no GUI bundle, so there is no bundled server to add and
/// no profile this command may claim to know the name of.
#[cfg(not(any(windows, target_os = "macos")))]
fn add_to_path(_dir: &Path) -> Result<String, String> {
    Err("adding the bundled server to PATH is not supported on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = "C:\\Users\\dev\\AppData\\Local\\Programs\\cannet";

    #[test]
    fn an_absent_directory_is_appended() {
        assert_eq!(
            user_path_with("C:\\bin;C:\\other", DIR),
            PathEdit::Write(format!("C:\\bin;C:\\other;{DIR}"))
        );
    }

    #[test]
    fn an_empty_path_becomes_just_the_directory() {
        assert_eq!(user_path_with("", DIR), PathEdit::Write(DIR.to_string()));
    }

    #[test]
    fn a_trailing_separator_is_not_doubled() {
        assert_eq!(
            user_path_with("C:\\bin;", DIR),
            PathEdit::Write(format!("C:\\bin;{DIR}"))
        );
    }

    #[test]
    fn empty_entries_survive_the_edit() {
        // The value is appended to as a string, never split and
        // rejoined: a user PATH with an empty entry in it is legal, and
        // rebuilding the list would silently remove it.
        let current = "C:\\bin;;C:\\other";
        assert_eq!(
            user_path_with(current, DIR),
            PathEdit::Write(format!("{current};{DIR}"))
        );
    }

    #[test]
    fn a_directory_already_present_is_left_alone() {
        assert_eq!(
            user_path_with(&format!("C:\\bin;{DIR};C:\\other"), DIR),
            PathEdit::AlreadyPresent
        );
    }

    #[test]
    fn presence_ignores_case_and_a_trailing_backslash() {
        // Both spellings name the same directory to Windows, so neither
        // is a reason to add a second entry.
        assert_eq!(
            user_path_with(&format!("{}\\", DIR.to_uppercase()), DIR),
            PathEdit::AlreadyPresent
        );
        assert_eq!(
            user_path_with(&format!("C:\\bin; {DIR} "), DIR),
            PathEdit::AlreadyPresent
        );
    }

    #[test]
    fn an_empty_entry_is_not_mistaken_for_the_directory() {
        assert_eq!(
            user_path_with(";;", DIR),
            PathEdit::Write(format!(";;{DIR}"))
        );
    }

    #[test]
    fn the_registry_type_is_read_back_with_the_raw_value() {
        assert_eq!(
            parse_user_path("ExpandString\r\n%USERPROFILE%\\bin;C:\\other").unwrap(),
            (
                "ExpandString".to_string(),
                "%USERPROFILE%\\bin;C:\\other".to_string()
            )
        );
        assert_eq!(
            parse_user_path("String\r\n").unwrap(),
            ("String".to_string(), String::new())
        );
    }

    #[test]
    fn an_unexpected_registry_type_is_refused() {
        // Rewriting a MultiString (or anything else) as a plain string
        // would destroy it; the command declines instead.
        let err = parse_user_path("MultiString\r\na;b").expect_err("only string types are edited");
        assert!(err.contains("MultiString"), "{err}");
    }

    const APP: &str = "/Applications/cannet.app/Contents/Resources";

    #[test]
    fn the_export_line_is_appended_to_an_empty_profile() {
        let PathEdit::Write(next) = zprofile_with("", APP).unwrap() else {
            panic!("an empty profile has nothing exported yet");
        };
        assert_eq!(
            next,
            format!("{ZPROFILE_MARKER}\nexport PATH=\"{APP}:$PATH\"\n")
        );
    }

    #[test]
    fn an_existing_profile_keeps_its_contents_and_gains_a_newline() {
        let PathEdit::Write(next) = zprofile_with("export EDITOR=vi", APP).unwrap() else {
            panic!("the export line is not there yet");
        };
        assert_eq!(
            next,
            format!("export EDITOR=vi\n\n{ZPROFILE_MARKER}\nexport PATH=\"{APP}:$PATH\"\n")
        );
    }

    #[test]
    fn a_profile_that_already_exports_it_is_untouched() {
        let current = format!("{ZPROFILE_MARKER}\nexport PATH=\"{APP}:$PATH\"\n");
        assert_eq!(
            zprofile_with(&current, APP).unwrap(),
            PathEdit::AlreadyPresent
        );
        // Indentation is not a different line.
        assert_eq!(
            zprofile_with(&format!("  export PATH=\"{APP}:$PATH\"\n"), APP).unwrap(),
            PathEdit::AlreadyPresent
        );
    }

    #[test]
    fn a_directory_with_a_space_is_quoted_rather_than_refused() {
        let PathEdit::Write(next) = zprofile_with("", "/Applications/my apps/cannet").unwrap()
        else {
            panic!("a space is what the quotes are for");
        };
        assert!(
            next.contains("export PATH=\"/Applications/my apps/cannet:$PATH\""),
            "{next}"
        );
    }

    #[test]
    fn a_directory_that_cannot_be_quoted_is_refused() {
        for hostile in ["/tmp/we\"ird", "/tmp/$HOME", "/tmp/back`tick"] {
            zprofile_with("", hostile)
                .expect_err("a login profile is not the place to find out about quoting");
        }
    }
}
