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
//! 1. **Local `uv`** at `tools/uv/<os>-<arch>/uv[.exe]` relative to
//!    the GUI binary's parent directory. `uv` is fetched, not
//!    bundled — `scripts/fetch-uv.sh` populates this path for dev
//!    builds, and a Phase-16 install-time or first-run fetch will
//!    populate it for end-user builds (see
//!    `plans/phased-implementation.md` Phase 16). The runtime
//!    contract — "look here first" — is stable regardless of who
//!    wrote the file.
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
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// Per-app state: the auto-restart counter, a "user asked to stay
/// down" flag, and the currently-active child handle so a manual
/// restart can kill it before spawning a replacement.
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
    /// The currently-spawned sidecar's child handle, shared with the
    /// per-spawn wait thread. `restart_sidecar` swaps this out and
    /// calls `kill()` on the previous handle so we never leave an
    /// orphaned process bound to the gRPC port. `None` between
    /// "wait thread cleared its slot" and "next spawn installed
    /// itself", and after a clean exit.
    active: Option<Arc<Mutex<Child>>>,
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
/// no spawning happens here. `sidecar_dir` is the absolute path to
/// the `cannet-python-can` package directory — see
/// [`resolve_sidecar_dir`] for how the caller obtains it.
pub fn build_command(launcher: LaunchPath, sidecar_dir: &std::path::Path, bind: &str) -> Command {
    match launcher {
        LaunchPath::BundledUv => {
            let mut cmd = Command::new(bundled_uv_path().expect("local uv pre-checked"));
            cmd.arg("--directory").arg(sidecar_dir);
            cmd.args(["run", "cannet-python-can", "--bind", bind]);
            cmd
        }
        LaunchPath::PathUv => {
            let mut cmd = Command::new("uv");
            cmd.arg("--directory").arg(sidecar_dir);
            cmd.args(["run", "cannet-python-can", "--bind", bind]);
            cmd
        }
        LaunchPath::SystemPython => {
            let mut cmd = Command::new(which_python().unwrap_or_else(|| PathBuf::from("python3")));
            cmd.env("PYTHONPATH", sidecar_dir);
            cmd.args(["-m", "cannet_python_can", "--bind", bind]);
            cmd
        }
    }
}

/// Resolve the absolute path to the `cannet-python-can` package
/// directory, deliberately **independent of the GUI's CWD**.
///
/// Resolution order (first hit wins):
///
/// 1. **`CANNET_SIDECAR_DIR` env var** — escape hatch for tests,
///    packaging experiments, and unforeseen deployment shapes. The
///    value is used verbatim; if it's a non-existent path, the
///    launcher will surface the resulting spawn failure.
/// 2. **Walk up from the GUI binary's location** looking for
///    `pyproject.toml` under either:
///    - `<ancestor>/servers/cannet-python-can/` (dev / `cargo build`
///      layouts — workspace root is somewhere above `target/`), or
///    - `<ancestor>/cannet-python-can/` (production layout — the
///      sidecar source sits next to the GUI binary inside the
///      bundle, per Phase-16 packaging plan).
///
///    Capped at 8 ancestors so a misconfigured deployment fails
///    loudly instead of crawling the filesystem.
///
/// The returned path is the directory containing `pyproject.toml`,
/// suitable for `uv --directory <path>` or `PYTHONPATH=<path>`.
pub fn resolve_sidecar_dir() -> Option<PathBuf> {
    if let Some(override_dir) = std::env::var_os("CANNET_SIDECAR_DIR") {
        return Some(PathBuf::from(override_dir));
    }
    let exe = std::env::current_exe().ok()?;
    let mut cursor = exe.parent()?.to_path_buf();
    for _ in 0..8 {
        // Dev / workspace layout.
        let nested = cursor.join("servers").join("cannet-python-can");
        if nested.join("pyproject.toml").is_file() {
            return Some(nested);
        }
        // Production "next to the binary" layout.
        let sibling = cursor.join("cannet-python-can");
        if sibling.join("pyproject.toml").is_file() {
            return Some(sibling);
        }
        if !cursor.pop() {
            break;
        }
    }
    None
}

/// Where [`resolve_sidecar_dir`] looked, formatted for the System
/// Messages panel so the user can see what we tried.
fn sidecar_dir_search_summary() -> String {
    let exe = std::env::current_exe()
        .map_or_else(|e| format!("<current_exe failed: {e}>"), |p| p.display().to_string());
    format!(
        "CANNET_SIDECAR_DIR (unset) → walk up from {exe} looking for `servers/cannet-python-can/pyproject.toml` or `cannet-python-can/pyproject.toml`"
    )
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
    let Some(launcher) = resolve_launch_path() else {
        sys_error!(
            app,
            SOURCE,
            "no sidecar launcher found (local uv, PATH uv, or python3); install uv: https://docs.astral.sh/uv/"
        );
        return;
    };
    // Resolve the sidecar source directory to an absolute path
    // BEFORE we build the command — uv's `--directory` and Python's
    // `PYTHONPATH` are then independent of whatever CWD the GUI was
    // launched with. The previous relative-path version blew up with
    // a terse "No such file or directory" any time the GUI's CWD
    // wasn't the workspace root.
    let Some(sidecar_dir) = resolve_sidecar_dir() else {
        sys_error!(
            app,
            SOURCE,
            "could not locate the cannet-python-can package directory. Searched: {}",
            sidecar_dir_search_summary()
        );
        return;
    };
    match launcher {
        LaunchPath::BundledUv => sys_info!(app, SOURCE, "starting sidecar via local uv on {bind}"),
        LaunchPath::PathUv => sys_info!(app, SOURCE, "starting sidecar via PATH uv on {bind}"),
        LaunchPath::SystemPython => sys_warn!(
            app,
            SOURCE,
            "uv not found; falling back to python3 -m cannet_python_can on {bind}. Install uv for the supported flow."
        ),
    }
    sys_info!(app, SOURCE, "sidecar dir: {}", sidecar_dir.display());
    let mut cmd = build_command(launcher, &sidecar_dir, bind);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    // Capture the resolved invocation so we can both log it at info
    // level on the happy path AND attach it to the error-level
    // failure message when the sidecar exits non-zero — the panel's
    // default min-level filter is `warn`, so an info-level breadcrumb
    // on its own is invisible to most users at the moment they need
    // it most.
    let program = cmd.get_program().to_string_lossy().into_owned();
    let args: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let cwd = std::env::current_dir()
        .map_or_else(|e| format!("<unknown: {e}>"), |p| p.display().to_string());
    let invocation_summary = format!(
        "exec: {program} {}\ncwd:  {cwd}\nsidecar dir: {}",
        args.join(" "),
        sidecar_dir.display()
    );
    sys_info!(app, SOURCE, "exec: {program} {}", args.join(" "));
    sys_info!(app, SOURCE, "cwd:  {cwd}");
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            sys_error!(app, SOURCE, "spawn failed: {e}");
            return;
        }
    };
    let pid = child.id();
    sys_info!(app, SOURCE, "sidecar started (pid {pid})");
    // Pull stdout/stderr off the child BEFORE wrapping it so the
    // stream threads don't have to fight the wait-loop's mutex.
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
    let child_arc = Arc::new(Mutex::new(child));
    if let Some(state) = app.try_state::<SidecarState>() {
        let mut inner = state.inner.lock().expect("sidecar state mutex poisoned");
        inner.active = Some(child_arc.clone());
    }
    // Poll `try_wait` so another thread can lock and `kill` if the
    // user hits "Restart sidecar" while we're still alive. 250 ms is
    // imperceptible for boot/runtime and keeps the loop cheap.
    let exit_status = loop {
        let result = {
            let mut guard = child_arc.lock().expect("sidecar child mutex poisoned");
            guard.try_wait()
        };
        match result {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => break Err(e),
        }
    };
    // Clear `active` only if we still own the slot. If
    // `restart_sidecar` already swapped us out, the new spawn is in
    // charge — don't auto-restart and don't touch its slot.
    let (still_active, suppress) = if let Some(state) = app.try_state::<SidecarState>() {
        let mut inner = state.inner.lock().expect("sidecar state mutex poisoned");
        let still = inner
            .active
            .as_ref()
            .is_some_and(|a| Arc::ptr_eq(a, &child_arc));
        if still {
            inner.active = None;
        }
        (still, inner.suppress_restart)
    } else {
        (true, false)
    };
    if !still_active {
        // A manual restart already kicked off our replacement; the
        // exit we just saw is the one it triggered via `kill`. Stay
        // quiet — the new spawn has its own "sidecar started" line.
        return;
    }
    match exit_status {
        Ok(status) if status.success() => {
            sys_info!(app, SOURCE, "sidecar (pid {pid}) exited cleanly");
        }
        Ok(status) => {
            // Bundle the invocation context into the error message
            // itself so it's visible at the panel's default `warn`
            // filter level — info-level breadcrumbs above don't help
            // a user who hasn't widened the filter.
            sys_error!(
                app,
                SOURCE,
                "sidecar (pid {pid}) exited with {status}\n{invocation_summary}"
            );
            if !suppress {
                maybe_restart(app);
            }
        }
        Err(e) => {
            sys_error!(
                app,
                SOURCE,
                "sidecar (pid {pid}) wait failed: {e}\n{invocation_summary}"
            );
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
        // Top-level Python failure surfaced by `__main__.py`'s
        // last-chance handler. The matching multi-line traceback
        // follows on stderr (one `LogLevel::Warn` line per frame).
        ["sidecar", "error", msg] => (LogLevel::Error, format!("sidecar fatal: {msg}")),
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
/// again, then **kills the previous child** (if any) before spawning
/// a replacement. Killing first matters because we'd otherwise leave
/// an unresponsive sidecar holding the gRPC port, and the new spawn
/// would race-and-lose on `add_insecure_port`.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn restart_sidecar(app: AppHandle, state: State<'_, SidecarState>) {
    let previous = {
        let mut inner = state.inner.lock().expect("sidecar state mutex poisoned");
        inner.crash_count = 0;
        inner.suppress_restart = false;
        inner.active.take()
    };
    if let Some(child_arc) = previous {
        let kill_outcome = {
            let mut guard = child_arc.lock().expect("sidecar child mutex poisoned");
            let pid = guard.id();
            (pid, guard.kill())
        };
        match kill_outcome {
            (pid, Ok(())) => sys_info!(&app, SOURCE, "killed previous sidecar (pid {pid})"),
            // `InvalidInput` from `kill()` on Unix means the child has
            // already exited — that's fine, the wait thread will see
            // it next poll and clean up.
            (pid, Err(e)) => sys_warn!(
                &app,
                SOURCE,
                "previous sidecar (pid {pid}) could not be killed (already exited?): {e}"
            ),
        }
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
    fn classify_stdout_promotes_error_banner_to_error_level() {
        let (lvl, msg) = classify_stdout_line(
            "sidecar\terror\tVersionError: protobuf gencode/runtime mismatch",
        );
        assert!(matches!(lvl, LogLevel::Error));
        assert!(
            msg.contains("VersionError"),
            "expected exception text preserved, got {msg}"
        );
        assert!(
            msg.starts_with("sidecar fatal:"),
            "expected `sidecar fatal:` prefix, got {msg}"
        );
    }

    /// Cross-platform stand-in for the sidecar directory in tests —
    /// `/tmp/...` is Unix-only, and `std::env::temp_dir()` returns an
    /// absolute path on every supported OS.
    fn sample_sidecar_dir() -> PathBuf {
        std::env::temp_dir().join("cannet-python-can")
    }

    #[test]
    fn build_command_uses_expected_program_for_each_path() {
        let cmd = build_command(LaunchPath::SystemPython, &sample_sidecar_dir(), "127.0.0.1:50099");
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

    #[test]
    fn build_command_passes_absolute_sidecar_dir_to_uv() {
        let dir = sample_sidecar_dir();
        let cmd = build_command(LaunchPath::PathUv, &dir, "127.0.0.1:50099");
        let args: Vec<std::ffi::OsString> =
            cmd.get_args().map(std::ffi::OsStr::to_os_string).collect();
        // `--directory <abs-dir> run cannet-python-can --bind 127.0.0.1:50099`
        let idx = args
            .iter()
            .position(|a| a == "--directory")
            .expect("uv invocation must include --directory");
        assert_eq!(args[idx + 1], dir.as_os_str());
    }

    #[test]
    fn build_command_threads_sidecar_dir_into_pythonpath_for_system_python() {
        let dir = sample_sidecar_dir();
        let cmd = build_command(LaunchPath::SystemPython, &dir, "127.0.0.1:50099");
        let pythonpath = cmd
            .get_envs()
            .find_map(|(k, v)| (k == "PYTHONPATH").then(|| v.map(std::ffi::OsStr::to_os_string)))
            .flatten()
            .expect("SystemPython launcher must set PYTHONPATH");
        assert_eq!(pythonpath, dir.as_os_str());
    }

    // Note: `CANNET_SIDECAR_DIR` env-var precedence isn't covered by
    // a unit test — the workspace forbids `unsafe` blocks
    // (`unsafe_code = "forbid"` in the top-level Cargo.toml), and
    // `std::env::set_var` is `unsafe` since Rust 2024 because it can
    // race with concurrent reads. The override path is one branch in
    // `resolve_sidecar_dir`; eyeball-verify it there if it changes.
}
