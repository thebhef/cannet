//! Vendor-driver sidecar lifecycle, GUI-host side.
//!
//! At startup the host spawns the `cannet-python-can` sidecar (a
//! Python process that uses `python-can` to enumerate Vector,
//! Kvaser, and PEAK hardware). The sidecar speaks the same `.proto`
//! as `cannet-server`; this module is the host-side process manager
//! and the bridge that turns the sidecar's stdout / stderr / exit
//! status into [`sys_debug!`] / [`sys_info!`] / [`sys_warn!`] /
//! [`sys_error!`] System Messages tagged with [`SOURCE`].
//!
//! The banner and stderr grammars the bridge parses, and the launch
//! strategy it follows (frozen binary vs. `uv` source tree, and the
//! order between them), live in [`cannet_sidecar`], which is shared
//! with `cannet-server` — see its crate docs. What stays here is the
//! half only a Tauri app can answer: where its settings live, where
//! its resources are, and where a log line goes.
//!
//! ## Retry budget
//!
//! A sidecar that crashes (non-zero exit) gets at most
//! a budget of auto-restarts before the host stops
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
use std::process::{Child, ChildStderr, ChildStdout, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use cannet_sidecar::{env_over_setting, Resolved, SidecarConfig, SidecarHost};
pub use cannet_sidecar::{parse_listening_address, SIDECAR_LOG_FILE, SOURCE};

use crate::system_log::LogLevel;
use crate::{emit_system_log, sys_debug, sys_error, sys_info, sys_warn};

/// The shared crate's classification of a sidecar line, said in the
/// host's own [`LogLevel`] ladder. Same four levels, so this is a
/// rename and never a judgement call.
fn host_level(level: cannet_sidecar::LogLevel) -> LogLevel {
    match level {
        cannet_sidecar::LogLevel::Debug => LogLevel::Debug,
        cannet_sidecar::LogLevel::Info => LogLevel::Info,
        cannet_sidecar::LogLevel::Warn => LogLevel::Warn,
        cannet_sidecar::LogLevel::Error => LogLevel::Error,
    }
}

/// How many times the host auto-restarts a crashing sidecar before
/// giving up for the rest of the session, from `settings.json`
/// (`sidecar_restart_budget`). Resets when the user triggers a manual
/// restart through [`restart_sidecar`].
fn restart_budget() -> u64 {
    crate::settings::effective().sidecar_restart_budget
}

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

/// Absolute path to the frozen sidecar launcher inside the Tauri
/// resource directory, or `None` if the frozen artifact isn't present
/// (the developer flow). Resolved through Tauri's framework-canonical
/// `resource_dir()` -- not the exe walk-up the dev paths use -- because
/// on macOS the bundled resources live in `Contents/Resources/`, a
/// sibling of the exe's `Contents/MacOS/` and never an ancestor (see
/// ADR 0036). Which is why the shared crate cannot resolve it: only a
/// Tauri app knows where a Tauri app keeps its resources.
///
/// Not unit-tested: it needs a live `AppHandle` to reach
/// `resource_dir()`, which can't be constructed in a plain unit test.
/// Its two moving parts — the platform suffix and the "no args" launch
/// shape — are covered in [`cannet_sidecar`].
fn frozen_launcher_path(app: &AppHandle) -> Option<PathBuf> {
    let launcher = app
        .path()
        .resource_dir()
        .ok()?
        .join("cannet-python-can")
        .join(cannet_sidecar::frozen_launcher_name());
    launcher.is_file().then_some(launcher)
}

/// Where to tell the sidecar to write its logfile, creating the
/// directory if it isn't there yet (the sidecar creates it too, but the
/// host knows the path first and a missing directory is the one failure
/// mode that would silently cost the whole log). `None` — and no
/// `--log-file` argument — when the directory can't be created, since a
/// sidecar that serves hardware without a logfile beats one that
/// doesn't start.
fn sidecar_log_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::crash::log_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        sys_warn!(
            app,
            SOURCE,
            "could not create the log directory {}: {e}; the sidecar will not write a logfile",
            dir.display()
        );
        return None;
    }
    Some(dir.join(SIDECAR_LOG_FILE))
}

/// Where to look for the `cannet-python-can` package: the
/// [`cannet_sidecar::SIDECAR_DIR_ENV`] variable, else the `sidecar_dir`
/// setting, else nowhere (the shared crate's walk-up applies).
fn sidecar_dir_override() -> Resolved {
    env_over_setting(
        cannet_sidecar::SIDECAR_DIR_ENV,
        "sidecar_dir",
        std::env::var_os(cannet_sidecar::SIDECAR_DIR_ENV),
        &crate::settings::effective().sidecar_dir,
    )
}

/// Which driver module the sidecar should load: the
/// [`cannet_sidecar::DRIVER_MODULE_ENV`] variable already in the host's
/// environment, else the `driver_module` setting, else nothing (the
/// sidecar's own default).
fn driver_module_override() -> Resolved {
    env_over_setting(
        cannet_sidecar::DRIVER_MODULE_ENV,
        "driver_module",
        std::env::var_os(cannet_sidecar::DRIVER_MODULE_ENV),
        &crate::settings::effective().driver_module,
    )
}

/// The GUI's half of the sidecar contract: `settings.json` plus the
/// escape-hatch environment variables on the way in, System Messages on
/// the way out. Everything else about running a sidecar is
/// [`cannet_sidecar`]'s.
struct GuiSidecarHost {
    app: AppHandle,
}

impl SidecarHost for GuiSidecarHost {
    fn config(&self) -> SidecarConfig {
        let sidecar_dir = sidecar_dir_override();
        let driver_module = driver_module_override();
        for note in [&sidecar_dir.shadowed, &driver_module.shadowed]
            .into_iter()
            .flatten()
        {
            sys_warn!(&self.app, SOURCE, "{note}");
        }
        SidecarConfig {
            frozen_launcher: frozen_launcher_path(&self.app),
            // Tauri emits the `dev` cfg for `tauri dev`, where the
            // editable source tree must win over the frozen resource
            // bundled beside the dev binary (ADR 0036).
            prefer_source_tree: cfg!(dev),
            sidecar_dir: sidecar_dir.value,
            log_level: crate::settings::effective().sidecar_log_level.clone(),
            log_file: sidecar_log_file(&self.app),
            driver_module: driver_module.value,
        }
    }

    fn log(&self, level: cannet_sidecar::LogLevel, message: String) {
        // Through the macros, not `emit_system_log`, so these lifecycle
        // lines keep their `tracing` mirror to dev stderr.
        match level {
            cannet_sidecar::LogLevel::Debug => sys_debug!(&self.app, SOURCE, "{message}"),
            cannet_sidecar::LogLevel::Info => sys_info!(&self.app, SOURCE, "{message}"),
            cannet_sidecar::LogLevel::Warn => sys_warn!(&self.app, SOURCE, "{message}"),
            cannet_sidecar::LogLevel::Error => sys_error!(&self.app, SOURCE, "{message}"),
        }
    }
}

/// Spawn the sidecar in the background. Safe to call from
/// `setup`; on success the child runs until shutdown or crash, and
/// every lifecycle event is published as a System Message tagged
/// [`SOURCE`].
///
/// Auto-restart on crash, capped by [`restart_budget`].
pub fn spawn_sidecar(app: &AppHandle) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        spawn_blocking_inner(&app_clone);
    });
}

#[allow(clippy::too_many_lines)]
fn spawn_blocking_inner(app: &AppHandle) {
    let host = GuiSidecarHost { app: app.clone() };
    let Some((mut cmd, source_summary)) = cannet_sidecar::resolve_command(&host) else {
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
    sys_debug!(app, SOURCE, "exec: {program} {}", args.join(" "));
    sys_debug!(app, SOURCE, "cwd:  {cwd}");
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
            // itself so it's visible at the panel's default filter
            // level — the debug-level breadcrumbs above don't help a
            // user who hasn't widened the filter.
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
        let (level, message) = cannet_sidecar::classify_stdout_line(&line);
        emit_system_log(app, SOURCE, host_level(level), message);
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
        let (level, message) = cannet_sidecar::classify_stderr_line(&line);
        emit_system_log(app, SOURCE, host_level(level), message);
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
    let budget = restart_budget();
    if u64::from(attempt) > budget {
        sys_error!(
            app,
            SOURCE,
            "sidecar crash budget exhausted after {attempt} attempts; use Restart sidecar to try again"
        );
        return;
    }
    sys_warn!(app, SOURCE, "auto-restarting sidecar ({attempt}/{budget})");
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
            (pid, Ok(())) => sys_debug!(&app, SOURCE, "killed previous sidecar (pid {pid})"),
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
