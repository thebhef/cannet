//! Vendor-driver sidecar lifecycle.
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
//! Resolved in priority order; the first that applies wins.
//!
//! 1. **Frozen self-contained binary** — the top-priority, end-user
//!    path. The `PyInstaller` onedir sidecar launcher, bundled into the
//!    installer as a Tauri resource and resolved through the
//!    framework-canonical `resource_dir()` (see ADR 0036 — *not* the
//!    exe walk-up the dev paths use, since on macOS the resources land
//!    in `Contents/Resources/`, a sibling of the exe's `Contents/MacOS/`
//!    and never an ancestor). The frozen artifact embeds its own
//!    `CPython` and dependencies, so it runs with no `uv`, no Python, and
//!    no `sidecar_dir` resolution. When it is present it wins outright.
//!
//! The paths below are all **developer-machine** fallbacks, used when
//! the frozen artifact isn't bundled (the dev tree). They resolve
//! `uv`/`python3` against the sidecar *source* tree; `uv` is dev-only.
//!
//! 2. **Local `uv`** at `tools/uv/<os>-<arch>/uv[.exe]` relative to
//!    the GUI binary's parent directory. `scripts/fetch-uv.sh`
//!    populates this path for dev builds. The runtime contract —
//!    "look here first" — is stable regardless of who wrote the file.
//! 3. **`uv` on `PATH`** — the developer-machine fallback.
//! 4. **`python3 -m cannet_python_can`** — last resort if `uv` is
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
//!
//! ## Lifecycle: sidecar dies when the host dies
//!
//! The host pipes the sidecar's stdin and writes nothing to it. The
//! `Child` keeps the write end open for its own lifetime; when the
//! host process exits (clean or not), the OS closes the pipe and the
//! sidecar's stdin-EOF watcher
//! (`cannet_python_can.__main__._install_stdin_eof_watcher`)
//! gracefully stops the gRPC server. That cross-platform "your parent
//! went away" contract is why a host crash never leaves an orphaned
//! sidecar holding hardware open — no `prctl(PR_SET_PDEATHSIG)` /
//! Windows job-object plumbing required.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

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

/// Tauri event name fired on every transition between [`SidecarPhase`]
/// states (including bound-address changes). Frontend subscribers
/// re-fetch with [`get_sidecar_status`] after listening — the payload
/// is the same struct the command returns.
pub const STATUS_EVENT: &str = "sidecar-status-changed";

/// Per-app state: the auto-restart counter, a "user asked to stay
/// down" flag, the currently-active child handle so a manual restart
/// can kill it before spawning a replacement, and the published
/// status (phase + address) the frontend reads through
/// [`get_sidecar_status`] / [`STATUS_EVENT`].
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
    /// Where the running sidecar is listening, parsed from its
    /// `sidecar\tlistening\t<addr>` banner. `Some` between the banner
    /// arriving and the wait thread observing the child's exit. The
    /// frontend uses this address as the `connect_remote_server`
    /// target for the local-sidecar connection — replacing the
    /// hard-coded 50061 the project bindings previously assumed.
    bound_address: Option<String>,
    /// Coarse lifecycle phase. Drives the GUI's "Local sidecar" row in
    /// the connection panel (Starting … / Ready (addr) / Offline).
    phase: SidecarPhase,
}

/// Coarse lifecycle of the sidecar process. Distinguishes "we have a
/// child but it hasn't reported a bound port yet" from "the child is
/// up and answering on `bound_address`" so the GUI can show a
/// progress hint instead of treating the gap as an outage.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SidecarPhase {
    /// No child has been spawned in this session yet, or the last
    /// child exited and we are not currently spawning a replacement.
    #[default]
    Offline,
    /// A child has been spawned and we are waiting for its
    /// `listening` banner. The GUI shows this as "starting…".
    Starting,
    /// The child has reported its bound address; ready to accept
    /// `connect_remote_server`.
    Ready,
}

/// Wire-shape for [`get_sidecar_status`] and [`STATUS_EVENT`]. Kept in
/// one place so the Tauri command and the event always agree, since
/// the frontend uses the event as a "refetch now" prompt.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub phase: SidecarPhase,
    /// `Some(host:port)` once the sidecar has reported its bound
    /// address. The frontend feeds this straight into
    /// `connect_remote_server`.
    pub address: Option<String>,
}

/// Which **developer-machine** launcher to use. The frozen end-user
/// path is resolved separately ([`frozen_launcher_path`] →
/// [`build_frozen_command`]) and never routed through this enum, so its
/// variants are exactly the dev fallbacks. They exist as discrete states
/// so the launcher can tell the user what flow they just got — the
/// System Messages text is different per branch.
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

/// Build the `Command` for a given launch path. Pure; no spawning
/// happens here. `sidecar_dir` is the absolute path to the
/// `cannet-python-can` package directory — see [`resolve_sidecar_dir`]
/// for how the caller obtains it.
///
/// No `--bind` is passed: the sidecar's own default is `127.0.0.1:0`
/// (let the OS pick a free ephemeral port), and we read the actual
/// address back from the `sidecar\tlistening\t<addr>` banner in
/// [`stream_stdout`]. Hard-coding a port here would just re-create the
/// "stale instance holds 50061" failure mode the random-port
/// selection was added to fix.
pub fn build_command(launcher: LaunchPath, sidecar_dir: &std::path::Path) -> Command {
    match launcher {
        LaunchPath::BundledUv => {
            let mut cmd = Command::new(bundled_uv_path().expect("local uv pre-checked"));
            cmd.arg("--directory").arg(sidecar_dir);
            cmd.args(["run", "cannet-python-can"]);
            cmd
        }
        LaunchPath::PathUv => {
            let mut cmd = Command::new("uv");
            cmd.arg("--directory").arg(sidecar_dir);
            cmd.args(["run", "cannet-python-can"]);
            cmd
        }
        LaunchPath::SystemPython => {
            let mut cmd = Command::new(which_python().unwrap_or_else(|| PathBuf::from("python3")));
            cmd.env("PYTHONPATH", sidecar_dir);
            cmd.args(["-m", "cannet_python_can"]);
            cmd
        }
    }
}

/// Pull the `<addr>` out of a `sidecar\tlistening\t<addr>` banner line.
/// `None` for any other input. Pure; testable without spawning.
pub fn parse_listening_address(line: &str) -> Option<&str> {
    line.strip_prefix("sidecar\tlistening\t")
}

/// Absolute path to the frozen sidecar launcher inside the Tauri
/// resource directory, or `None` if the frozen artifact isn't present
/// (the developer flow). Resolved through Tauri's framework-canonical
/// `resource_dir()` -- not the exe walk-up -- because on macOS the
/// bundled resources live in `Contents/Resources/`, a sibling of the
/// exe's `Contents/MacOS/` and never an ancestor (see ADR 0036).
fn frozen_launcher_path(app: &AppHandle) -> Option<PathBuf> {
    let launcher = app
        .path()
        .resource_dir()
        .ok()?
        .join("cannet-python-can")
        .join(frozen_launcher_name());
    launcher.is_file().then_some(launcher)
}

/// The frozen launcher's file name — platform-suffixed to match what
/// `PyInstaller` emits (`.exe` on Windows, bare elsewhere).
fn frozen_launcher_name() -> &'static str {
    if cfg!(windows) {
        "cannet-python-can.exe"
    } else {
        "cannet-python-can"
    }
}

/// Build the `Command` for the frozen self-contained launcher. Pure;
/// no spawning. The frozen onedir bundles its own interpreter and deps,
/// so unlike the dev paths there is no `--directory` / `PYTHONPATH` /
/// `--bind` -- the sidecar's own `127.0.0.1:0` default still applies and
/// the bound address is read back from the `listening` banner.
pub fn build_frozen_command(launcher: &std::path::Path) -> Command {
    Command::new(launcher)
}

/// Windows: suppress the console window a console-subsystem child would
/// otherwise pop up. The release GUI is built `windows_subsystem =
/// "windows"` (see `main.rs`), so it has no console of its own; spawning
/// a console-subsystem executable — the frozen `PyInstaller` launcher, or
/// `uv`/`python` on the dev paths — makes Windows allocate a fresh console
/// window for it. `CREATE_NO_WINDOW` runs the child with no console at
/// all; stdin/stdout/stderr are piped regardless (see `spawn_blocking_inner`),
/// so the tab-separated banner protocol is unaffected. No-op off Windows,
/// where a console app never spawns a stray window.
#[cfg_attr(not(windows), allow(unused_variables, clippy::needless_pass_by_ref_mut))]
fn suppress_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW from winbase.h; inlined to avoid a whole
        // winapi dependency for a single constant.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
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
///      bundle).
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
    let exe = std::env::current_exe().map_or_else(
        |e| format!("<current_exe failed: {e}>"),
        |p| p.display().to_string(),
    );
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
    if cfg!(windows) {
        "uv.exe"
    } else {
        "uv"
    }
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

/// Resolve the sidecar invocation to a ready-to-configure [`Command`]
/// plus a human-readable "source" line for the invocation summary
/// (there is no `sidecar_dir` on the frozen path, so the frozen and dev
/// branches converge here and share the whole spawn tail below).
/// `None` — after logging an error-level System Message — when no
/// launcher could be resolved at all.
fn resolve_command(app: &AppHandle) -> Option<(Command, String)> {
    // Frozen self-contained binary first (ADR 0036): if the bundled
    // onedir launcher is present in the resource dir, run it directly.
    // It embeds its own interpreter and deps, so no `sidecar_dir`/`uv`
    // resolution applies.
    if let Some(launcher) = frozen_launcher_path(app) {
        sys_info!(app, SOURCE, "starting sidecar via frozen binary");
        return Some((
            build_frozen_command(&launcher),
            "source: frozen self-contained binary".to_string(),
        ));
    }
    // Developer-machine fallbacks: uv / python3 against the sidecar
    // source tree.
    let Some(launcher) = resolve_launch_path() else {
        sys_error!(
            app,
            SOURCE,
            "no sidecar launcher found (frozen binary, local uv, PATH uv, or python3); install uv: https://docs.astral.sh/uv/"
        );
        return None;
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
        return None;
    };
    match launcher {
        LaunchPath::BundledUv => sys_info!(app, SOURCE, "starting sidecar via local uv"),
        LaunchPath::PathUv => sys_info!(app, SOURCE, "starting sidecar via PATH uv"),
        LaunchPath::SystemPython => sys_warn!(
            app,
            SOURCE,
            "uv not found; falling back to python3 -m cannet_python_can. Install uv for the supported flow."
        ),
    }
    sys_info!(app, SOURCE, "sidecar dir: {}", sidecar_dir.display());
    Some((
        build_command(launcher, &sidecar_dir),
        format!("sidecar dir: {}", sidecar_dir.display()),
    ))
}

#[allow(clippy::too_many_lines)]
fn spawn_blocking_inner(app: &AppHandle) {
    let Some((mut cmd, source_summary)) = resolve_command(app) else {
        return;
    };
    set_phase(app, SidecarPhase::Starting, None);
    // stdin is piped so we hold the write end for the lifetime of the
    // child; we never write to it. When the host process dies (clean
    // exit, panic, OS kill, …), Rust drops the `Child`, the pipe
    // closes, and the sidecar's stdin-EOF watcher (see
    // `cannet_python_can.__main__._install_stdin_eof_watcher`) reads
    // EOF and triggers its own graceful shutdown. Without this, a
    // host crash would leave an orphaned sidecar holding hardware
    // open. The default (inherited stdin from a GUI process is
    // typically `/dev/null`) would also fire the watcher immediately,
    // so the pipe is what keeps the sidecar alive in the first place.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Keep the console-subsystem child from popping a terminal window
    // (Windows only); stdio stays piped so the banner protocol works.
    suppress_console_window(&mut cmd);
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
        "exec: {program} {}\ncwd:  {cwd}\n{source_summary}",
        args.join(" ")
    );
    sys_info!(app, SOURCE, "exec: {program} {}", args.join(" "));
    sys_info!(app, SOURCE, "cwd:  {cwd}");
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            sys_error!(app, SOURCE, "spawn failed: {e}");
            set_phase(app, SidecarPhase::Offline, None);
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
        // It already set the phase to Starting on its way in, so we
        // explicitly do *not* clear it here.
        return;
    }
    set_phase(app, SidecarPhase::Offline, None);
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
        if let Some(addr) = parse_listening_address(&line) {
            set_phase(app, SidecarPhase::Ready, Some(addr.to_string()));
        }
    }
}

/// Update the [`SidecarPhase`] / `bound_address` slot atomically and
/// emit [`STATUS_EVENT`] when anything actually changes. Folded into
/// one function so callers can't drift the two halves out of sync —
/// the GUI's reaction (re-rendering "Local sidecar" status, redoing
/// `connect_remote_server` against a new address) hinges on the event
/// firing exactly when the published status moves.
fn set_phase(app: &AppHandle, phase: SidecarPhase, address: Option<String>) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    let (status, watch_change) = {
        let mut inner = state.inner.lock().expect("sidecar state mutex poisoned");
        if inner.phase == phase && inner.bound_address == address {
            return;
        }
        let prev_address = inner.bound_address.clone();
        let prev_was_ready = inner.phase == SidecarPhase::Ready;
        inner.phase = phase;
        inner.bound_address = address;
        let now_ready = phase == SidecarPhase::Ready;
        // Lifecycle drives the local-address watch. The actual
        // subscription manager lives in `interfaces.rs`; this just
        // decides which transitions add/remove the local address from
        // its managed set. Done after the lock is released so the
        // interface state's own lock isn't taken under ours.
        let change = match (prev_was_ready, now_ready) {
            (false, true) => WatchChange::Start(inner.bound_address.clone()),
            (true, false) => WatchChange::Stop(prev_address),
            (true, true) if prev_address != inner.bound_address => WatchChange::Replace {
                stop: prev_address,
                start: inner.bound_address.clone(),
            },
            _ => WatchChange::None,
        };
        (
            SidecarStatus {
                phase,
                address: inner.bound_address.clone(),
            },
            change,
        )
    };
    let _ = app.emit(STATUS_EVENT, status);
    match watch_change {
        WatchChange::Start(Some(addr)) => crate::interfaces::watch(app, addr),
        WatchChange::Stop(Some(addr)) => crate::interfaces::unwatch(app, &addr),
        WatchChange::Replace { stop, start } => {
            if let Some(addr) = stop {
                crate::interfaces::unwatch(app, &addr);
            }
            if let Some(addr) = start {
                crate::interfaces::watch(app, addr);
            }
        }
        // Nothing to do: either no change, or a Start/Stop whose address
        // slot is `None` on phase transitions the launcher drives before
        // the listening banner arrives.
        WatchChange::None | WatchChange::Start(None) | WatchChange::Stop(None) => {}
    }
}

/// Outcome the locked critical section in `set_phase` decides; the
/// matching subscription-manager call happens after the lock so the
/// `InterfacesState` lock isn't taken under the sidecar one.
enum WatchChange {
    None,
    Start(Option<String>),
    Stop(Option<String>),
    Replace {
        stop: Option<String>,
        start: Option<String>,
    },
}

/// Tauri command — snapshot the current sidecar status. The
/// connection panel calls this on mount to pick up the address the
/// host learned before the panel listened for [`STATUS_EVENT`].
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_sidecar_status(state: State<'_, SidecarState>) -> SidecarStatus {
    let inner = state.inner.lock().expect("sidecar state mutex poisoned");
    SidecarStatus {
        phase: inner.phase,
        address: inner.bound_address.clone(),
    }
}

fn stream_stderr(app: &AppHandle, stderr: ChildStderr) {
    let reader = BufReader::new(stderr);
    for line in reader.lines() {
        let Ok(line) = line else { return };
        if line.is_empty() {
            continue;
        }
        let (level, message) = classify_stderr_line(&line);
        emit_system_log(app, SOURCE, level, message);
    }
}

/// Parse one stderr line from the sidecar against the Python logger
/// format configured by `logging.basicConfig` in `__main__.py`:
/// `"%(asctime)s %(levelname)s %(name)s %(message)s"`. Returns the
/// embedded severity (mapped onto our 3-level [`LogLevel`]) so a
/// run-of-the-mill `INFO` line isn't surfaced as a warning, and the
/// timestamp is stripped from the displayed text (the System Messages
/// panel already stamps its own time).
///
/// Anything that doesn't look like that format — a raw traceback
/// frame, an unbuffered `print`, a third-party library writing
/// directly to stderr — falls through as `Warn` with the line
/// unchanged. Warn is the safest default: it lands at the panel's
/// default filter level so the user actually sees it, without
/// pretending to know its real severity.
pub fn classify_stderr_line(line: &str) -> (LogLevel, String) {
    // asctime = "YYYY-MM-DD HH:MM:SS,mmm" → two whitespace-separated
    // tokens. `splitn(5, …)` then peels: date, time, levelname, name,
    // message-rest.
    let mut parts = line.splitn(5, ' ');
    let _date = parts.next();
    let _time = parts.next();
    let level_token = parts.next();
    let name = parts.next();
    let message = parts.next();
    let (Some(level_token), Some(name), Some(message)) = (level_token, name, message) else {
        return (LogLevel::Warn, line.to_string());
    };
    let level = match level_token {
        // Python: DEBUG / INFO / WARNING / ERROR / CRITICAL — plus the
        // `WARN` alias some loggers emit. We collapse DEBUG to Info
        // (the panel has no debug level) and CRITICAL to Error.
        "DEBUG" | "INFO" => LogLevel::Info,
        "WARNING" | "WARN" => LogLevel::Warn,
        "ERROR" | "CRITICAL" => LogLevel::Error,
        // Token doesn't look like a Python level — bail out so a
        // traceback frame like `  File "x.py", line 42, in foo`
        // isn't mis-classified.
        _ => return (LogLevel::Warn, line.to_string()),
    };
    (level, format!("{name} {message}"))
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
        ["interface", id, display, kind] => (
            LogLevel::Info,
            format!("interface {id} ({display}) [{kind}]"),
        ),
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
        let (_lvl, msg) = classify_stdout_line(
            "interface\tvector:VN1630A(SN:12345, ch:0)\tVector VN1630A ch0\tfd",
        );
        assert!(msg.contains("vector:VN1630A(SN:12345, ch:0)"));
        assert!(msg.contains("[fd]"));
    }

    #[test]
    fn classify_stdout_passes_through_unknown_lines() {
        let (lvl, msg) = classify_stdout_line("a stray print from the sidecar");
        assert!(matches!(lvl, LogLevel::Info));
        assert_eq!(msg, "a stray print from the sidecar");
    }

    #[test]
    fn classify_stderr_reads_python_levelname() {
        // The Python sidecar's basicConfig format is
        // "%(asctime)s %(levelname)s %(name)s %(message)s".
        let (lvl, msg) = classify_stderr_line(
            "2026-05-25 16:05:43,487 INFO cannet_python_can.server ListInterfaces -> 2 channels",
        );
        assert!(matches!(lvl, LogLevel::Info), "INFO should not be warned");
        assert_eq!(
            msg, "cannet_python_can.server ListInterfaces -> 2 channels",
            "timestamp should be stripped; name + message retained"
        );

        let (lvl, _) = classify_stderr_line(
            "2026-05-25 16:05:43,487 WARNING cannet_python_can.server rx pump for X failed",
        );
        assert!(matches!(lvl, LogLevel::Warn));

        let (lvl, _) = classify_stderr_line(
            "2026-05-25 16:05:43,487 ERROR cannet_python_can sidecar fatal error",
        );
        assert!(matches!(lvl, LogLevel::Error));

        let (lvl, _) =
            classify_stderr_line("2026-05-25 16:05:43,487 CRITICAL cannet_python_can boom");
        assert!(matches!(lvl, LogLevel::Error));

        let (lvl, _) =
            classify_stderr_line("2026-05-25 16:05:43,487 DEBUG cannet_python_can chatty");
        assert!(matches!(lvl, LogLevel::Info));
    }

    #[test]
    fn classify_stderr_falls_back_to_warn_on_unrecognised_lines() {
        // Traceback frame — no levelname token at position 2.
        let (lvl, msg) = classify_stderr_line("  File \"server.py\", line 42, in <module>");
        assert!(matches!(lvl, LogLevel::Warn));
        assert_eq!(msg, "  File \"server.py\", line 42, in <module>");

        // Looks roughly right but the level token isn't a real level.
        let (lvl, msg) =
            classify_stderr_line("2026-05-25 16:05:43,487 BANANAS cannet_python_can not a level");
        assert!(matches!(lvl, LogLevel::Warn));
        assert!(msg.contains("BANANAS"));
    }

    #[test]
    fn classify_stdout_promotes_error_banner_to_error_level() {
        let (lvl, msg) =
            classify_stdout_line("sidecar\terror\tVersionError: protobuf gencode/runtime mismatch");
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
        let cmd = build_command(LaunchPath::SystemPython, &sample_sidecar_dir());
        let program = cmd.get_program().to_string_lossy().to_string();
        assert!(
            program.ends_with("python3") || program.ends_with("python"),
            "expected python program, got {program}",
        );
    }

    #[test]
    fn build_command_passes_absolute_sidecar_dir_to_uv() {
        let dir = sample_sidecar_dir();
        let cmd = build_command(LaunchPath::PathUv, &dir);
        let args: Vec<std::ffi::OsString> =
            cmd.get_args().map(std::ffi::OsStr::to_os_string).collect();
        let idx = args
            .iter()
            .position(|a| a == "--directory")
            .expect("uv invocation must include --directory");
        assert_eq!(args[idx + 1], dir.as_os_str());
    }

    #[test]
    fn build_command_threads_sidecar_dir_into_pythonpath_for_system_python() {
        let dir = sample_sidecar_dir();
        let cmd = build_command(LaunchPath::SystemPython, &dir);
        let pythonpath = cmd
            .get_envs()
            .find_map(|(k, v)| (k == "PYTHONPATH").then(|| v.map(std::ffi::OsStr::to_os_string)))
            .flatten()
            .expect("SystemPython launcher must set PYTHONPATH");
        assert_eq!(pythonpath, dir.as_os_str());
    }

    #[test]
    fn build_command_does_not_pin_a_bind_address() {
        // The sidecar's own default (`127.0.0.1:0`) is the contract
        // for "host doesn't care about the port" — if we ever start
        // passing `--bind` from here again we'd silently re-create
        // the stale-instance-holds-50061 wedge that random-port
        // selection was added to fix.
        for launcher in [LaunchPath::PathUv, LaunchPath::SystemPython] {
            let cmd = build_command(launcher, &sample_sidecar_dir());
            let has_bind = cmd.get_args().any(|a| a == "--bind");
            assert!(
                !has_bind,
                "{launcher:?} command should not pass --bind; got {:?}",
                cmd.get_args().collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn build_frozen_command_runs_the_launcher_with_no_args() {
        // The frozen onedir is self-contained: the launcher embeds its
        // own interpreter and deps, so the command is just the launcher
        // path — no `--directory`, no `--bind`, no `run` subcommand.
        let launcher = std::env::temp_dir().join(frozen_launcher_name());
        let cmd = build_frozen_command(&launcher);
        assert_eq!(cmd.get_program(), launcher.as_os_str());
        assert_eq!(
            cmd.get_args().count(),
            0,
            "frozen launcher takes no args; got {:?}",
            cmd.get_args().collect::<Vec<_>>()
        );
    }

    #[test]
    fn frozen_launcher_name_matches_target_os_suffix() {
        #[cfg(windows)]
        assert_eq!(frozen_launcher_name(), "cannet-python-can.exe");
        #[cfg(not(windows))]
        assert_eq!(frozen_launcher_name(), "cannet-python-can");
    }

    // Note: `frozen_launcher_path` itself isn't unit-tested — it needs a
    // live `AppHandle` to reach `resource_dir()`, which can't be
    // constructed in a plain unit test (same constraint that keeps
    // `CANNET_SIDECAR_DIR` eyeball-verified below). Its two moving
    // parts — the platform suffix and the "no args" launch shape — are
    // covered by the two tests above.

    #[test]
    fn parse_listening_address_strips_the_banner_prefix() {
        assert_eq!(
            parse_listening_address("sidecar\tlistening\t127.0.0.1:43891"),
            Some("127.0.0.1:43891"),
        );
        assert_eq!(
            parse_listening_address("sidecar\tlistening\t[::1]:43891"),
            Some("[::1]:43891"),
        );
    }

    #[test]
    fn parse_listening_address_ignores_other_banner_lines() {
        assert_eq!(parse_listening_address("sidecar\tversion\t0.1.0"), None);
        assert_eq!(
            parse_listening_address("interface\tvector:ch0\tVector ch0\tfd"),
            None,
        );
        assert_eq!(parse_listening_address(""), None);
    }

    // Note: `CANNET_SIDECAR_DIR` env-var precedence isn't covered by
    // a unit test — the workspace forbids `unsafe` blocks
    // (`unsafe_code = "forbid"` in the top-level Cargo.toml), and
    // `std::env::set_var` is `unsafe` since Rust 2024 because it can
    // race with concurrent reads. The override path is one branch in
    // `resolve_sidecar_dir`; eyeball-verify it there if it changes.
}
