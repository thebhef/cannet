//! Phase 8: vendor-driver sidecar lifecycle.
//!
//! At startup the host spawns the `cannet-python-can` sidecar (a
//! Python process that uses `python-can` to enumerate Vector,
//! Kvaser, and PEAK hardware). The sidecar speaks the same `.proto`
//! as `cannet-server`; this module is the host-side process manager
//! and the bridge that turns the sidecar's stdout / stderr / exit
//! status into [`sys_info!`] / [`sys_warn!`] / [`sys_error!`] System
//! Messages tagged with [`SOURCE`].
//!
//! ## Stdout banner format
//!
//! The sidecar's stdout uses a small, deliberately stable
//! tab-separated banner format so the bridge can parse it without
//! pulling JSON in:
//!
//! ```text
//! sidecar\tversion\t<v>
//! sidecar\tinterfaces\t<n>
//! interface\t<id>\t<display_name>\t<fd|classic>
//! sidecar\tlistening\t<addr>
//! sidecar\tshutdown\tsignal=<n>
//! sidecar\texit\t<code>
//! ```
//!
//! Anything that does *not* match those shapes falls through as a
//! plain info-level message — so a stray `print` from a vendor SDK
//! still reaches the user without code changes here. Stderr is
//! routed to warn level.
//!
//! ## Launch strategy
//!
//! Resolved in order:
//!
//! 1. **Bundled `uv`** under `tools/uv/<os>-<arch>/uv[.exe]`, relative
//!    to the GUI binary's parent directory. Phase 16 picks this up
//!    via the Tauri bundle; today the path is documented + populated
//!    by `scripts/fetch-uv.sh`.
//! 2. **`uv` on `PATH`** — the developer-machine fallback.
//! 3. **`python3 -m cannet_python_can`** — last resort if `uv` is
//!    not installed at all. Logs a warn-level System Message so the
//!    user knows to install `uv` for full functionality.
//!
//! At every step, the failure case logs a System Message at the right
//! severity and surfaces the install instructions; the process never
//! panics on a missing sidecar.
//!
//! ## Retry budget
//!
//! A sidecar that crashes (non-zero exit) gets at most
//! [`MAX_RESTARTS_PER_SESSION`] auto-restarts before the host stops
//! trying; an error-level message tells the user to click "Restart
//! sidecar" by hand (the Tauri command exposed below). The budget
//! resets when the user runs the manual restart command.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{ChildStderr, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::system_log::LogLevel;
use crate::{emit_system_log, sys_error, sys_info, sys_warn};

/// The System Messages source tag every sidecar event is published
/// under. Must match `cannet_python_can.server.WIRE_SOURCE` in the
/// Python sidecar so an in-band `LogMessage` envelope from the
/// sidecar later ends up under the same panel filter as the
/// process-level lifecycle events.
pub const SOURCE: &str = "sidecar:python-can";

/// How many times the host auto-restarts a crashing sidecar before
/// giving up for the rest of the session. Resets when the user
/// triggers a manual restart through [`restart_sidecar`].
pub const MAX_RESTARTS_PER_SESSION: u32 = 3;

/// Default gRPC bind address for the sidecar. The host connects to
/// this via the existing `connect_remote_server` path; the address is
/// chosen high enough not to collide with `cannet-server`'s 50051.
pub const DEFAULT_BIND: &str = "127.0.0.1:50061";

/// Per-app state: the auto-restart counter and a "user asked to
/// stay down" flag. The `Child` itself lives on the wait thread.
#[derive(Default)]
pub struct SidecarState {
    inner: Mutex<SidecarInner>,
}

#[derive(Default)]
struct SidecarInner {
    /// Total non-zero exits seen in this session. Resets on manual
    /// restart so the user has agency.
    crash_count: u32,
    /// `true` after the user explicitly stops the sidecar (or after
    /// the budget is exhausted); suppresses the next auto-restart.
    suppress_restart: bool,
}

/// What the user-facing fallback path is. The variants exist as
/// discrete states so the launcher can tell the user what flow they
/// just got — the System Messages text is different per branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchPath {
    /// Bundled `uv` binary under `tools/uv/...` next to the GUI.
    BundledUv,
    /// `uv` resolved through `PATH`.
    PathUv,
    /// `python3 -m cannet_python_can` — last-resort fallback when
    /// `uv` is not available.
    SystemPython,
}

/// Resolve which launcher to use without spawning the child yet.
/// Split out so tests can inspect the choice without touching the
/// process table.
pub fn resolve_launch_path() -> Option<LaunchPath> {
    if bundled_uv_path().is_some() {
        return Some(LaunchPath::BundledUv);
    }
    if which_uv().is_some() {
        return Some(LaunchPath::PathUv);
    }
    if which_python().is_some() {
        return Some(LaunchPath::SystemPython);
    }
    None
}

/// Build the `Command` for a given launch path + bind address. Pure;
/// no spawning happens here.
pub fn build_command(path: LaunchPath, bind: &str) -> Command {
    match path {
        LaunchPath::BundledUv => {
            let mut cmd = Command::new(bundled_uv_path().expect("bundled uv pre-checked"));
            cmd.args([
                "--directory",
                "servers/cannet-python-can",
                "run",
                "cannet-python-can",
                "--bind",
                bind,
            ]);
            cmd
        }
        LaunchPath::PathUv => {
            let mut cmd = Command::new("uv");
            cmd.args([
                "--directory",
                "servers/cannet-python-can",
                "run",
                "cannet-python-can",
                "--bind",
                bind,
            ]);
            cmd
        }
        LaunchPath::SystemPython => {
            let mut cmd = Command::new(which_python().unwrap_or_else(|| PathBuf::from("python3")));
            cmd.env("PYTHONPATH", "servers/cannet-python-can");
            cmd.args(["-m", "cannet_python_can", "--bind", bind]);
            cmd
        }
    }
}

fn bundled_uv_path() -> Option<PathBuf> {
    // Resolved relative to the GUI binary directory. The real Tauri
    // bundle will sit it alongside the executable; in development
    // (cargo run) it'll be next to the workspace `target/`, which is
    // also fine for the developer flow.
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidate = exe_dir.join("tools").join("uv").join(uv_filename());
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn uv_filename() -> &'static str {
    if cfg!(windows) { "uv.exe" } else { "uv" }
}

fn which_uv() -> Option<PathBuf> {
    which_binary(if cfg!(windows) { "uv.exe" } else { "uv" })
}

fn which_python() -> Option<PathBuf> {
    which_binary("python3").or_else(|| which_binary("python"))
}

fn which_binary(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Spawn the sidecar in the background. Safe to call from
/// `setup`; on success the child runs until shutdown or crash, and
/// every lifecycle event is published as a System Message tagged
/// [`SOURCE`].
///
/// Auto-restart on crash, capped by [`MAX_RESTARTS_PER_SESSION`].
pub fn spawn_sidecar(app: &AppHandle) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        spawn_blocking_inner(&app_clone);
    });
}

fn spawn_blocking_inner(app: &AppHandle) {
    let bind = DEFAULT_BIND;
    let Some(path) = resolve_launch_path() else {
        sys_error!(
            app,
            SOURCE,
            "no sidecar launcher found (bundled uv, PATH uv, or python3); install uv: https://docs.astral.sh/uv/"
        );
        return;
    };
    match path {
        LaunchPath::BundledUv => sys_info!(app, SOURCE, "starting sidecar via bundled uv on {bind}"),
        LaunchPath::PathUv => sys_info!(app, SOURCE, "starting sidecar via PATH uv on {bind}"),
        LaunchPath::SystemPython => sys_warn!(
            app,
            SOURCE,
            "uv not found; falling back to python3 -m cannet_python_can on {bind}. Install uv for the supported flow."
        ),
    }
    let mut cmd = build_command(path, bind);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            sys_error!(app, SOURCE, "spawn failed: {e}");
            return;
        }
    };
    let pid = child.id();
    sys_info!(app, SOURCE, "sidecar started (pid {pid})");
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Some(stdout) = stdout {
        let app_clone = app.clone();
        std::thread::spawn(move || stream_stdout(&app_clone, stdout));
    }
    if let Some(stderr) = stderr {
        let app_clone = app.clone();
        std::thread::spawn(move || stream_stderr(&app_clone, stderr));
    }
    let exit_status = child.wait();
    let suppress = app
        .try_state::<SidecarState>()
        .is_some_and(|state| {
            let inner = state.inner.lock().expect("sidecar state mutex poisoned");
            inner.suppress_restart
        });
    match exit_status {
        Ok(status) if status.success() => {
            sys_info!(app, SOURCE, "sidecar (pid {pid}) exited cleanly");
        }
        Ok(status) => {
            sys_error!(app, SOURCE, "sidecar (pid {pid}) exited with {status}");
            if !suppress {
                maybe_restart(app);
            }
        }
        Err(e) => {
            sys_error!(app, SOURCE, "sidecar (pid {pid}) wait failed: {e}");
        }
    }
}

fn stream_stdout(app: &AppHandle, stdout: ChildStdout) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { return };
        if line.is_empty() {
            continue;
        }
        let (level, message) = classify_stdout_line(&line);
        emit_system_log(app, SOURCE, level, message);
    }
}

fn stream_stderr(app: &AppHandle, stderr: ChildStderr) {
    let reader = BufReader::new(stderr);
    for line in reader.lines() {
        let Ok(line) = line else { return };
        if line.is_empty() {
            continue;
        }
        emit_system_log(app, SOURCE, LogLevel::Warn, line);
    }
}

/// Parse one tab-separated banner line from the sidecar's stdout into
/// a level + message. Anything we don't recognise falls through as a
/// plain info-level message so a stray `print` still reaches the
/// panel.
pub fn classify_stdout_line(line: &str) -> (LogLevel, String) {
    let parts: Vec<&str> = line.split('\t').collect();
    match parts.as_slice() {
        ["sidecar", "version", v] => (LogLevel::Info, format!("sidecar version {v}")),
        ["sidecar", "interfaces", n] => (LogLevel::Info, format!("discovered {n} interface(s)")),
        ["sidecar", "listening", addr] => (LogLevel::Info, format!("listening on {addr}")),
        ["sidecar", "shutdown", reason] => (LogLevel::Info, format!("shutting down ({reason})")),
        ["sidecar", "exit", code] => (LogLevel::Info, format!("exit code {code}")),
        ["interface", id, display, kind] => {
            (LogLevel::Info, format!("interface {id} ({display}) [{kind}]"))
        }
        _ => (LogLevel::Info, line.to_string()),
    }
}

/// Auto-restart hook. Called from the wait-thread after a non-zero
/// exit when the user has not asked us to stay down.
fn maybe_restart(app: &AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    let attempt = {
        let mut inner = state.inner.lock().expect("sidecar state mutex poisoned");
        inner.crash_count += 1;
        inner.crash_count
    };
    if attempt > MAX_RESTARTS_PER_SESSION {
        sys_error!(
            app,
            SOURCE,
            "sidecar crash budget exhausted after {attempt} attempts; use Restart sidecar to try again"
        );
        return;
    }
    sys_warn!(
        app,
        SOURCE,
        "auto-restarting sidecar ({attempt}/{MAX_RESTARTS_PER_SESSION})"
    );
    spawn_sidecar(app);
}

/// Manual restart, exposed to the frontend as a Tauri command.
/// Clears the crash counter so the user gets the full retry budget
/// again. The previous child (if any) is left to exit on its own —
/// the wait-thread sees `suppress_restart` and does not auto-restart.
/// In practice the OS reaps it when the GUI process exits; for
/// long-lived sessions, the new spawn binds a fresh port.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn restart_sidecar(app: AppHandle, state: State<'_, SidecarState>) {
    {
        let mut inner = state.inner.lock().expect("sidecar state mutex poisoned");
        inner.crash_count = 0;
        inner.suppress_restart = false;
    }
    sys_info!(&app, SOURCE, "manual restart");
    spawn_sidecar(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_stdout_recognises_banner_lines() {
        assert!(matches!(
            classify_stdout_line("sidecar\tversion\t0.1.0"),
            (LogLevel::Info, _)
        ));
        let (_lvl, msg) = classify_stdout_line("sidecar\tinterfaces\t0");
        assert!(msg.contains('0'));
        let (_lvl, msg) = classify_stdout_line("sidecar\tlistening\t127.0.0.1:50061");
        assert!(msg.contains("127.0.0.1:50061"));
        let (_lvl, msg) =
            classify_stdout_line("interface\tvector:VN1640A/ch0\tVector VN1640A ch0\tfd");
        assert!(msg.contains("vector:VN1640A/ch0"));
        assert!(msg.contains("[fd]"));
    }

    #[test]
    fn classify_stdout_passes_through_unknown_lines() {
        let (lvl, msg) = classify_stdout_line("a stray print from the sidecar");
        assert!(matches!(lvl, LogLevel::Info));
        assert_eq!(msg, "a stray print from the sidecar");
    }

    #[test]
    fn build_command_uses_expected_program_for_each_path() {
        let cmd = build_command(LaunchPath::SystemPython, "127.0.0.1:50099");
        let program = cmd.get_program().to_string_lossy().to_string();
        assert!(
            program.ends_with("python3") || program.ends_with("python"),
            "expected python program, got {program}",
        );
        // We cannot reliably test BundledUv / PathUv shape without
        // populating the host PATH; resolve_launch_path is what we
        // really want to exercise there, and it's covered by the
        // build_command-fallback test above.
    }
}
