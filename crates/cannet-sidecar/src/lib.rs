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

mod banner;
mod launch;

pub use banner::{classify_stderr_line, classify_stdout_line, parse_listening_address, LogLevel};
pub use launch::{
    env_over_setting, frozen_launcher_name, resolve_command, Resolved, SidecarConfig,
    DRIVER_MODULE_ENV, SIDECAR_DIR_ENV,
};

/// What a host supplies so this crate can run a sidecar for it: where
/// its configuration comes from, and where the sidecar's chatter goes.
///
/// Both halves are per-host by nature — a Tauri app reads
/// `settings.json` and publishes System Messages, a CLI server reads
/// its flags and writes `tracing` events — and everything else about
/// running a sidecar is the same, which is why it lives here.
pub trait SidecarHost {
    /// The configuration for **this** spawn attempt, resolved fresh
    /// each time so a settings change takes effect on the next
    /// restart without one being cached across it.
    fn config(&self) -> SidecarConfig;

    /// Publish one line about the sidecar. `message` is already
    /// user-facing text; the host decides where it lands and under
    /// what source tag ([`SOURCE`]).
    fn log(&self, level: LogLevel, message: String);
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
