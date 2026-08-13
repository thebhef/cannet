//! Vendor-driver sidecar lifecycle, shared by every host that runs one.
//!
//! The `cannet-python-can` sidecar is a Python process that uses
//! `python-can` to enumerate Vector, Kvaser, and PEAK hardware and
//! serves the same `.proto` as `cannet-server`. Any cannet process that
//! wants local hardware spawns one and supervises it; this crate is
//! that supervision, in one implementation, so a host only has to
//! supply the parts that are genuinely its own — where its settings
//! live and where its log lines go.
//!
//! ## Stdout banner format
//!
//! The sidecar's stdout uses a small, deliberately stable
//! tab-separated banner format so a host can parse it without pulling
//! JSON in:
//!
//! ```text
//! sidecar\tversion\t<v>
//! sidecar\tlogfile\t<path>
//! sidecar\tinterfaces\t<n>
//! interface\t<id>\t<display_name>\t<fd|classic>
//! sidecar\tlistening\t<addr>
//! sidecar\tshutdown\tsignal=<n>
//! sidecar\texit\t<code>
//! ```
//!
//! Anything that does *not* match those shapes falls through as a
//! plain debug-level message — so a stray `print` from a vendor SDK
//! still reaches the user without code changes here. Stderr carries the
//! sidecar's Python logger output and is parsed by
//! [`classify_stderr_line`].
//!
//! ## Two sidecar log sinks
//!
//! The child's stderr is one sink, at the host's chosen
//! `--log-level`. The host also hands the sidecar `--log-file <path>`
//! — a second, **always debug** rolling sink (1 MiB × 5 generations),
//! holding every gRPC command with its arguments and outcome and every
//! driver traceback. Raising the file's detail therefore never raises
//! the first sink's. The sidecar echoes the path back on the `logfile`
//! banner line so the user can find it.
//!
//! ## Launch strategy
//!
//! Two launch flavours exist; which is preferred is the host's call
//! ([`SidecarConfig::prefer_source_tree`]), with the other as fallback:
//!
//! - **Release builds prefer the frozen self-contained binary** — the
//!   end-user path. The `PyInstaller` onedir launcher ships with the
//!   host and the host resolves its path (see ADR 0036), because only
//!   the host knows how its own resources are laid out. The frozen
//!   artifact embeds its own `CPython` and dependencies, so it runs
//!   with no `uv`, no Python, and no sidecar-directory resolution.
//! - **Dev builds prefer the sidecar source tree**, so edits to
//!   `servers/cannet-python-can` take effect on the next sidecar
//!   restart without re-running `scripts/build-sidecar.py` — the
//!   frozen artifact is shipped in dev too and would otherwise shadow
//!   live source.
//!
//! The source-tree launchers, in priority order; they resolve
//! `uv`/`python3` against the sidecar *source* tree:
//!
//! 1. **Local `uv`** at `tools/uv/<os>-<arch>/uv[.exe]` relative to
//!    the host binary's parent directory. `scripts/fetch-uv.sh`
//!    populates this path for dev builds. The runtime contract —
//!    "look here first" — is stable regardless of who wrote the file.
//! 2. **`uv` on `PATH`** — the developer-machine fallback.
//! 3. **`python3 -m cannet_python_can`** — last resort if `uv` is
//!    not installed at all. Logs a warn-level line so the user knows
//!    to install `uv` for full functionality.
//!
//! At every step, the failure case logs through the host at the right
//! severity and surfaces the install instructions; nothing panics on a
//! missing sidecar.
//!
//! ## Retry budget
//!
//! A sidecar that crashes (non-zero exit) gets at most a budget of
//! auto-restarts ([`SidecarHost::restart_budget`]) before the
//! supervisor stops trying; an error-level line tells the user to
//! restart it by hand. The budget resets when
//! [`SidecarSupervisor::restart`] runs, so the user's own restart never
//! lands on an exhausted counter.
//!
//! ## Lifecycle: the sidecar dies when its host dies
//!
//! The supervisor pipes the sidecar's stdin and writes nothing to it.
//! It keeps the write end open for the child's lifetime; when the host
//! process exits (clean or not), the OS closes the pipe and the
//! sidecar's stdin-EOF watcher
//! (`cannet_python_can.__main__._install_stdin_eof_watcher`)
//! gracefully stops the gRPC server. That cross-platform "your parent
//! went away" contract is why a host crash never leaves an orphaned
//! sidecar holding hardware open — no `prctl(PR_SET_PDEATHSIG)` /
//! Windows job-object plumbing required.
//!
//! A host that means to outlive its sidecar — one shutting down in an
//! orderly way rather than dying — closes that pipe itself, through
//! [`SidecarSupervisor::stop`]: same graceful exit, but bounded, and
//! with a whole-process-tree kill as the backstop. Waiting for the OS
//! to do it instead is not an option for a host whose exit path is a
//! runtime teardown that first waits for the supervisor's own wait
//! loop, which waits for the child, which waits for the EOF.

mod banner;
mod launch;
mod process_tree;
mod supervise;

pub use banner::{classify_stderr_line, classify_stdout_line, parse_listening_address, LogLevel};
pub use launch::{
    env_over_setting, frozen_launcher_name, resolve_command, Resolved, SidecarConfig,
    DRIVER_MODULE_ENV, SIDECAR_DIR_ENV,
};
pub use supervise::{SidecarPhase, SidecarStatus, SidecarSupervisor, StopOutcome};

/// What a host supplies so this crate can run a sidecar for it: where
/// its configuration comes from, where the sidecar's chatter goes, and
/// what to do with a thread.
///
/// Every method is per-host by nature — a Tauri app reads
/// `settings.json` and publishes System Messages, a CLI server reads
/// its flags and writes `tracing` events — and everything else about
/// running a sidecar is the same, which is why it lives here.
///
/// `Send + Sync + 'static` because the supervisor's wait loop outlives
/// the call that started it.
pub trait SidecarHost: Send + Sync + 'static {
    /// The configuration for **this** spawn attempt, resolved fresh
    /// each time so a settings change takes effect on the next
    /// restart without one being cached across it.
    fn config(&self) -> SidecarConfig;

    /// Publish one line *about* the sidecar — a lifecycle event this
    /// crate produced. `message` is already user-facing text; the host
    /// decides where it lands and under what source tag ([`SOURCE`]).
    fn log(&self, level: LogLevel, message: String);

    /// Publish one line *from* the sidecar — a stdout banner or stderr
    /// line the child itself wrote, already classified. Separate from
    /// [`SidecarHost::log`] because the volume is different by orders
    /// of magnitude: a host may well want its own lifecycle events on
    /// every sink it has, and the child's output only on the cheap
    /// ones. Defaults to treating both alike.
    fn log_sidecar_output(&self, level: LogLevel, message: String) {
        self.log(level, message);
    }

    /// How many times a crashing sidecar is auto-restarted before the
    /// host gives up for the rest of the session. Read at the moment a
    /// crash is handled, not cached at spawn, so a host whose budget is
    /// a live setting honours the current one.
    fn restart_budget(&self) -> u64;

    /// The supervised sidecar moved from `previous` to `current`.
    /// Called once per actual change, never for a repeat, and never
    /// with the supervisor's lock held — a host is free to take its own
    /// locks here.
    fn status_changed(&self, previous: &SidecarStatus, current: &SidecarStatus);

    /// Run `task` on a thread of the host's choosing. It blocks for the
    /// supervised child's whole lifetime, so it must not land on an
    /// async runtime's worker; hosts hand it to a blocking pool
    /// (`tauri::async_runtime::spawn_blocking`,
    /// `tokio::task::spawn_blocking`) or a plain thread.
    fn spawn_blocking(&self, task: Box<dyn FnOnce() + Send + 'static>);
}

/// The log source tag every sidecar event should be published under.
/// Must match `cannet_python_can.server.WIRE_SOURCE` in the Python
/// sidecar so an in-band `LogMessage` envelope from the sidecar later
/// ends up under the same filter as the process-level lifecycle events.
pub const SOURCE: &str = "sidecar:python-can";

/// File name of the sidecar's rolling logfile. Hosts put it in their
/// own log directory, next to their own log — one place to look, and
/// one directory to attach to a bug report.
pub const SIDECAR_LOG_FILE: &str = "sidecar-python-can.log";
