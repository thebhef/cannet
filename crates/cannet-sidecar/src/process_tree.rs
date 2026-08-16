//! Ending a supervised child **and everything it started**.
//!
//! A sidecar is not one process. The developer launch chain is
//! `uv → uv → cannet-python-can → python → python`, so killing only the
//! process we spawned can leave the rest of that chain alive and still
//! holding CAN hardware open. It happens to work on that chain — `uv`
//! forwards stdin, so its death delivers the EOF the descendants exit
//! on — but that is one launcher's behaviour, not a guarantee, and the
//! kill is the backstop for exactly the case where the graceful path
//! has already failed.
//!
//! The two functions here are a pair: a child spawned through
//! [`spawn_as_group_leader`] can later be taken down whole by
//! [`kill_tree`], and neither is valid without the other.
//!
//! Neither half walks the process table by hand. The workspace forbids
//! `unsafe`, which puts Windows job objects and `killpg` out of reach
//! without a new dependency — so each OS's own tool does the walking:
//! `taskkill /T` follows the parent each Windows process records, and
//! `kill` on a negated process-group id reaches every descendant that
//! has not left the group.

use std::io;
use std::process::{Command, Stdio};

/// Arrange for `cmd`'s child to be reachable as a tree later.
///
/// On Unix that means giving it a process group of its own, which its
/// descendants inherit — one `kill` on the negated group id then
/// reaches all of them. A side effect worth knowing: a child in its own
/// group no longer receives the terminal's Ctrl-C, so the supervisor's
/// own shutdown becomes the only thing that ends it, which is the same
/// path every other OS already takes.
///
/// Windows needs no preparation: it records each process's parent, and
/// that is what the tree kill walks.
#[cfg_attr(not(unix), allow(unused_variables, clippy::needless_pass_by_ref_mut))]
pub(crate) fn spawn_as_group_leader(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}

/// Kill the process `pid` leads, descendants included. `pid` must be a
/// child spawned through [`spawn_as_group_leader`].
///
/// Unforgiving on purpose: this runs only after a graceful stop has
/// already been given its full grace period, or when a restart needs
/// the port and the hardware back before spawning a replacement.
pub(crate) fn kill_tree(pid: u32) -> io::Result<()> {
    let mut killer = killer(pid);
    let program = killer.get_program().to_string_lossy().into_owned();
    let status = killer
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("{program} exited with {status}")))
    }
}

#[cfg(windows)]
fn killer(pid: u32) -> Command {
    let mut cmd = Command::new("taskkill");
    // `/T` takes the descendants with it; `/F` does not ask nicely.
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    // A GUI host has no console, and this must not pop one up.
    crate::launch::suppress_console_window(&mut cmd);
    cmd
}

#[cfg(unix)]
fn killer(pid: u32) -> Command {
    let mut cmd = Command::new("kill");
    // A negated pid names the *process group* — the one the child leads
    // because it was spawned as its leader. The `--` is load-bearing:
    // without it, procps kill (3.3.17) misreads the negative operand
    // and delivers the signal to the *caller's own* process group —
    // sparing the sidecar tree and killing the supervisor, and in CI
    // the test harness and the runner agent above it.
    cmd.args(["-KILL", "--", &format!("-{pid}")]);
    cmd
}
