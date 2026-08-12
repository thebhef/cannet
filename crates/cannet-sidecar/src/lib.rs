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

mod banner;

pub use banner::{classify_stderr_line, classify_stdout_line, parse_listening_address, LogLevel};

/// The log source tag every sidecar event should be published under.
/// Must match `cannet_python_can.server.WIRE_SOURCE` in the Python
/// sidecar so an in-band `LogMessage` envelope from the sidecar later
/// ends up under the same filter as the process-level lifecycle events.
pub const SOURCE: &str = "sidecar:python-can";

/// File name of the sidecar's rolling logfile. Hosts put it in their
/// own log directory, next to their own log — one place to look, and
/// one directory to attach to a bug report.
pub const SIDECAR_LOG_FILE: &str = "sidecar-python-can.log";
