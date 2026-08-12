//! Running a sidecar and keeping it running.
//!
//! One [`SidecarSupervisor`] owns at most one live sidecar: it spawns
//! the child, pumps its stdout/stderr through the host's log, publishes
//! the phase the host renders, auto-restarts a crashing sidecar within
//! a budget, and kills the previous child when the user asks for a
//! restart by hand. See the crate root for the retry budget and the
//! stdin-EOF lifetime contract.

use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStderr, ChildStdout, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::{
    classify_stderr_line, classify_stdout_line, parse_listening_address, resolve_command, LogLevel,
    SidecarHost,
};

/// Coarse lifecycle of the sidecar process. Distinguishes "we have a
/// child but it hasn't reported a bound port yet" from "the child is
/// up and answering on the bound address" so a host can show a
/// progress hint instead of treating the gap as an outage.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SidecarPhase {
    /// No child has been spawned in this session yet, or the last
    /// child exited and we are not currently spawning a replacement.
    #[default]
    Offline,
    /// A child has been spawned and we are waiting for its
    /// `listening` banner.
    Starting,
    /// The child has reported its bound address and is ready for
    /// clients.
    Ready,
}

/// What the supervisor publishes about the sidecar: how far along it
/// is, and where it is listening once it says so.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SidecarStatus {
    pub phase: SidecarPhase,
    /// `Some(host:port)` once the sidecar has reported its bound
    /// address, parsed from its `sidecar\tlistening\t<addr>` banner.
    /// `Some` between the banner arriving and the wait loop observing
    /// the child's exit.
    pub address: Option<String>,
}

/// One supervised sidecar: the auto-restart counter, a "user asked to
/// stay down" flag, the currently-active child handle so a manual
/// restart can kill it before spawning a replacement, and the
/// published status.
///
/// Shared as an `Arc` because the wait loop outlives the call that
/// started it.
#[derive(Default)]
pub struct SidecarSupervisor {
    inner: Mutex<SupervisorInner>,
}

#[derive(Default)]
struct SupervisorInner {
    /// Total non-zero exits seen in this session. Resets on manual
    /// restart so the user has agency.
    crash_count: u32,
    /// `true` after the user explicitly stops the sidecar (or after
    /// the budget is exhausted); suppresses the next auto-restart.
    suppress_restart: bool,
    /// The currently-spawned sidecar's child handle, shared with the
    /// per-spawn wait loop. [`SidecarSupervisor::restart`] swaps this
    /// out and calls `kill()` on the previous handle so we never leave
    /// an orphaned process bound to the gRPC port. `None` between
    /// "wait loop cleared its slot" and "next spawn installed
    /// itself", and after a clean exit.
    active: Option<Arc<Mutex<Child>>>,
    /// The status the host last saw published.
    status: SidecarStatus,
}

impl SidecarSupervisor {
    /// Snapshot the current status — what a host answers with when
    /// something asks after the fact, rather than having listened for
    /// [`SidecarHost::status_changed`].
    ///
    /// # Panics
    ///
    /// If a previous holder of the supervisor's lock panicked, which
    /// means the supervision state is no longer trustworthy.
    pub fn status(&self) -> SidecarStatus {
        self.inner
            .lock()
            .expect("sidecar state mutex poisoned")
            .status
            .clone()
    }

    /// Spawn the sidecar in the background. Safe to call from a host's
    /// startup path; on success the child runs until shutdown or
    /// crash, and every lifecycle event goes through the host's log.
    ///
    /// Auto-restart on crash, capped by
    /// [`SidecarHost::restart_budget`].
    pub fn spawn(self: &Arc<Self>, host: &Arc<dyn SidecarHost>) {
        let supervisor = Arc::clone(self);
        let dispatched = Arc::clone(host);
        host.spawn_blocking(Box::new(move || supervisor.run(&dispatched)));
    }

    /// Manual restart. Clears the crash counter so the user gets the
    /// full retry budget again, then **kills the previous child** (if
    /// any) before spawning a replacement. Killing first matters
    /// because we'd otherwise leave an unresponsive sidecar holding the
    /// gRPC port, and the new spawn would race-and-lose on
    /// `add_insecure_port`.
    ///
    /// # Panics
    ///
    /// If a previous holder of the supervisor's or the child's lock
    /// panicked, which means the supervision state is no longer
    /// trustworthy.
    pub fn restart(self: &Arc<Self>, host: &Arc<dyn SidecarHost>) {
        let previous = {
            let mut inner = self.inner.lock().expect("sidecar state mutex poisoned");
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
                (pid, Ok(())) => host.log(
                    LogLevel::Debug,
                    format!("killed previous sidecar (pid {pid})"),
                ),
                // `InvalidInput` from `kill()` on Unix means the child
                // has already exited — that's fine, the wait loop will
                // see it next poll and clean up.
                (pid, Err(e)) => host.log(
                    LogLevel::Warn,
                    format!(
                        "previous sidecar (pid {pid}) could not be killed (already exited?): {e}"
                    ),
                ),
            }
        }
        host.log(LogLevel::Info, "manual restart".to_string());
        self.spawn(host);
    }

    /// The blocking body: resolve, spawn, pump, wait, and decide what
    /// the exit means. Runs on whatever thread
    /// [`SidecarHost::spawn_blocking`] put it on, for the child's whole
    /// lifetime.
    #[allow(clippy::too_many_lines)]
    fn run(self: &Arc<Self>, host: &Arc<dyn SidecarHost>) {
        let Some((mut cmd, source_summary)) = resolve_command(host.as_ref()) else {
            return;
        };
        self.set_phase(host.as_ref(), SidecarPhase::Starting, None);
        // stdin is piped so we hold the write end for the lifetime of
        // the child; we never write to it. When the host process dies
        // (clean exit, panic, OS kill, …), Rust drops the `Child`, the
        // pipe closes, and the sidecar's stdin-EOF watcher (see
        // `cannet_python_can.__main__._install_stdin_eof_watcher`) reads
        // EOF and triggers its own graceful shutdown. Without this, a
        // host crash would leave an orphaned sidecar holding hardware
        // open. The default (inherited stdin from a GUI process is
        // typically `/dev/null`) would also fire the watcher
        // immediately, so the pipe is what keeps the sidecar alive in
        // the first place.
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Capture the resolved invocation so we can both log it at
        // debug level on the happy path AND attach it to the
        // error-level failure message when the sidecar exits non-zero
        // — a host's default filter is typically `warn`, so a
        // debug-level breadcrumb on its own is invisible to most users
        // at the moment they need it most.
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
        host.log(
            LogLevel::Debug,
            format!("exec: {program} {}", args.join(" ")),
        );
        host.log(LogLevel::Debug, format!("cwd:  {cwd}"));
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                host.log(LogLevel::Error, format!("spawn failed: {e}"));
                self.set_phase(host.as_ref(), SidecarPhase::Offline, None);
                return;
            }
        };
        let pid = child.id();
        host.log(LogLevel::Info, format!("sidecar started (pid {pid})"));
        // Pull stdout/stderr off the child BEFORE wrapping it so the
        // stream threads don't have to fight the wait-loop's mutex.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        if let Some(stdout) = stdout {
            let supervisor = Arc::clone(self);
            let host = Arc::clone(host);
            std::thread::spawn(move || supervisor.stream_stdout(&host, stdout));
        }
        if let Some(stderr) = stderr {
            let host = Arc::clone(host);
            std::thread::spawn(move || stream_stderr(&host, stderr));
        }
        let child_arc = Arc::new(Mutex::new(child));
        {
            let mut inner = self.inner.lock().expect("sidecar state mutex poisoned");
            inner.active = Some(Arc::clone(&child_arc));
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
        // Clear `active` only if we still own the slot. If `restart`
        // already swapped us out, the new spawn is in charge — don't
        // auto-restart and don't touch its slot.
        let (still_active, suppress) = {
            let mut inner = self.inner.lock().expect("sidecar state mutex poisoned");
            let still = inner
                .active
                .as_ref()
                .is_some_and(|a| Arc::ptr_eq(a, &child_arc));
            if still {
                inner.active = None;
            }
            (still, inner.suppress_restart)
        };
        if !still_active {
            // A manual restart already kicked off our replacement; the
            // exit we just saw is the one it triggered via `kill`. Stay
            // quiet — the new spawn has its own "sidecar started" line.
            // It already set the phase to Starting on its way in, so we
            // explicitly do *not* clear it here.
            return;
        }
        self.set_phase(host.as_ref(), SidecarPhase::Offline, None);
        match exit_status {
            Ok(status) if status.success() => {
                host.log(
                    LogLevel::Info,
                    format!("sidecar (pid {pid}) exited cleanly"),
                );
            }
            Ok(status) => {
                // Bundle the invocation context into the error message
                // itself so it's visible at the usual default filter
                // level — the debug-level breadcrumbs above don't help
                // a user who hasn't widened the filter.
                host.log(
                    LogLevel::Error,
                    format!("sidecar (pid {pid}) exited with {status}\n{invocation_summary}"),
                );
                if !suppress {
                    self.maybe_restart(host);
                }
            }
            Err(e) => {
                host.log(
                    LogLevel::Error,
                    format!("sidecar (pid {pid}) wait failed: {e}\n{invocation_summary}"),
                );
            }
        }
    }

    fn stream_stdout(&self, host: &Arc<dyn SidecarHost>, stdout: ChildStdout) {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { return };
            if line.is_empty() {
                continue;
            }
            let (level, message) = classify_stdout_line(&line);
            host.log_sidecar_output(level, message);
            if let Some(addr) = parse_listening_address(&line) {
                self.set_phase(host.as_ref(), SidecarPhase::Ready, Some(addr.to_string()));
            }
        }
    }

    /// Update the phase / address slot atomically and tell the host
    /// when anything actually changed. Folded into one function so
    /// callers can't drift the two halves out of sync — a host's
    /// reaction (re-rendering a status row, re-pointing a connection at
    /// a new address) hinges on the notification firing exactly when
    /// the published status moves.
    fn set_phase(&self, host: &dyn SidecarHost, phase: SidecarPhase, address: Option<String>) {
        let (previous, current) = {
            let mut inner = self.inner.lock().expect("sidecar state mutex poisoned");
            if inner.status.phase == phase && inner.status.address == address {
                return;
            }
            let previous = inner.status.clone();
            inner.status = SidecarStatus { phase, address };
            (previous, inner.status.clone())
        };
        // Outside the lock: a host reacting to the change may take
        // locks of its own, and must not take them under ours.
        host.status_changed(&previous, &current);
    }

    /// Auto-restart hook. Called from the wait loop after a non-zero
    /// exit when the user has not asked us to stay down.
    fn maybe_restart(self: &Arc<Self>, host: &Arc<dyn SidecarHost>) {
        let attempt = {
            let mut inner = self.inner.lock().expect("sidecar state mutex poisoned");
            inner.crash_count += 1;
            inner.crash_count
        };
        let budget = host.restart_budget();
        if u64::from(attempt) > budget {
            host.log(
                LogLevel::Error,
                format!(
                    "sidecar crash budget exhausted after {attempt} attempts; use Restart sidecar to try again"
                ),
            );
            return;
        }
        host.log(
            LogLevel::Warn,
            format!("auto-restarting sidecar ({attempt}/{budget})"),
        );
        self.spawn(host);
    }
}

fn stream_stderr(host: &Arc<dyn SidecarHost>, stderr: ChildStderr) {
    let reader = BufReader::new(stderr);
    for line in reader.lines() {
        let Ok(line) = line else { return };
        if line.is_empty() {
            continue;
        }
        let (level, message) = classify_stderr_line(&line);
        host.log_sidecar_output(level, message);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::SidecarConfig;

    /// A host that records instead of doing. The supervision decisions
    /// — how often a crash is retried, what the exhausted-budget line
    /// says, which status transitions are published — are exactly the
    /// ones no live process has to exist to check, so none does.
    #[derive(Default)]
    struct RecordingHost {
        budget: u64,
        lines: Mutex<Vec<(LogLevel, String)>>,
        transitions: Mutex<Vec<(SidecarStatus, SidecarStatus)>>,
        dispatched: AtomicUsize,
    }

    impl RecordingHost {
        fn with_budget(budget: u64) -> Arc<Self> {
            Arc::new(Self {
                budget,
                ..Self::default()
            })
        }

        fn dispatch_count(&self) -> usize {
            self.dispatched.load(Ordering::SeqCst)
        }

        fn messages(&self) -> Vec<String> {
            self.lines
                .lock()
                .unwrap()
                .iter()
                .map(|(_, message)| message.clone())
                .collect()
        }
    }

    impl SidecarHost for RecordingHost {
        fn config(&self) -> SidecarConfig {
            SidecarConfig {
                frozen_launcher: None,
                prefer_source_tree: false,
                sidecar_dir: None,
                log_level: "info".to_string(),
                log_file: None,
                driver_module: None,
            }
        }

        fn log(&self, level: LogLevel, message: String) {
            self.lines.lock().unwrap().push((level, message));
        }

        fn restart_budget(&self) -> u64 {
            self.budget
        }

        fn status_changed(&self, previous: &SidecarStatus, current: &SidecarStatus) {
            self.transitions
                .lock()
                .unwrap()
                .push((previous.clone(), current.clone()));
        }

        fn spawn_blocking(&self, _task: Box<dyn FnOnce() + Send + 'static>) {
            // Deliberately not run: what a test wants to know is that a
            // respawn was *asked for*, not that a Python process
            // appeared on the machine running the suite.
            self.dispatched.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn host_and_supervisor(budget: u64) -> (Arc<RecordingHost>, Arc<SidecarSupervisor>) {
        (
            RecordingHost::with_budget(budget),
            Arc::new(SidecarSupervisor::default()),
        )
    }

    /// The recording host as the supervisor wants it.
    fn as_host(host: &Arc<RecordingHost>) -> Arc<dyn SidecarHost> {
        Arc::clone(host) as Arc<dyn SidecarHost>
    }

    #[test]
    fn a_crash_inside_the_budget_asks_for_a_respawn_and_counts_it() {
        let (host, supervisor) = host_and_supervisor(3);
        supervisor.maybe_restart(&as_host(&host));
        assert_eq!(host.dispatch_count(), 1);
        assert_eq!(
            host.messages(),
            vec!["auto-restarting sidecar (1/3)".to_string()],
            "the attempt is numbered against the budget so a user can see it running out"
        );
    }

    #[test]
    fn the_budget_is_a_cap_on_attempts_not_a_countdown_that_restarts() {
        // The budget is per session: crash n+1 must not respawn, and
        // must say so rather than going quiet.
        let (host, supervisor) = host_and_supervisor(2);
        for _ in 0..3 {
            supervisor.maybe_restart(&as_host(&host));
        }
        assert_eq!(
            host.dispatch_count(),
            2,
            "a third crash is past a budget of two"
        );
        let last = host.messages().pop().expect("a line per crash");
        assert!(
            last.contains("budget exhausted") && last.contains("Restart sidecar"),
            "the give-up line has to name the way out, got {last}"
        );
    }

    #[test]
    fn a_manual_restart_hands_the_full_budget_back() {
        // Agency: after the auto-restarts are spent, the user's own
        // restart must not land on an exhausted counter.
        let (host, supervisor) = host_and_supervisor(1);
        supervisor.maybe_restart(&as_host(&host)); // spends the budget
        supervisor.maybe_restart(&as_host(&host)); // refused
        assert_eq!(host.dispatch_count(), 1);

        supervisor.restart(&as_host(&host)); // dispatch #2
        supervisor.maybe_restart(&as_host(&host)); // dispatch #3
        assert_eq!(
            host.dispatch_count(),
            3,
            "the counter reset, so one auto-restart is available again"
        );
    }

    #[test]
    fn a_phase_change_is_published_once_with_both_sides_of_it() {
        let (host, supervisor) = host_and_supervisor(3);
        let dyn_host = as_host(&host);
        supervisor.set_phase(dyn_host.as_ref(), SidecarPhase::Starting, None);
        supervisor.set_phase(
            dyn_host.as_ref(),
            SidecarPhase::Ready,
            Some("127.0.0.1:43891".to_string()),
        );
        let transitions = host.transitions.lock().unwrap().clone();
        assert_eq!(transitions.len(), 2);
        assert_eq!(transitions[0].0.phase, SidecarPhase::Offline);
        assert_eq!(transitions[0].1.phase, SidecarPhase::Starting);
        assert_eq!(transitions[1].0.phase, SidecarPhase::Starting);
        assert_eq!(
            transitions[1].1,
            SidecarStatus {
                phase: SidecarPhase::Ready,
                address: Some("127.0.0.1:43891".to_string()),
            },
            "the host is told the address in the same notification as the phase"
        );
        assert_eq!(supervisor.status(), transitions[1].1);
    }

    #[test]
    fn an_unchanged_phase_is_not_republished() {
        // A host re-renders (and, in the GUI, re-points a connection)
        // on every notification, so a repeat of the same status must
        // not produce one.
        let (host, supervisor) = host_and_supervisor(3);
        let dyn_host = as_host(&host);
        let addr = Some("127.0.0.1:43891".to_string());
        supervisor.set_phase(dyn_host.as_ref(), SidecarPhase::Ready, addr.clone());
        supervisor.set_phase(dyn_host.as_ref(), SidecarPhase::Ready, addr);
        assert_eq!(host.transitions.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_new_bound_address_at_the_same_phase_is_a_change() {
        // The sidecar binds an ephemeral port, so a restart lands on a
        // different address at the same `Ready` phase — a host that
        // isn't told keeps talking to the dead one.
        let (host, supervisor) = host_and_supervisor(3);
        let dyn_host = as_host(&host);
        supervisor.set_phase(
            dyn_host.as_ref(),
            SidecarPhase::Ready,
            Some("127.0.0.1:43891".to_string()),
        );
        supervisor.set_phase(
            dyn_host.as_ref(),
            SidecarPhase::Ready,
            Some("127.0.0.1:51234".to_string()),
        );
        let transitions = host.transitions.lock().unwrap().clone();
        assert_eq!(transitions.len(), 2);
        assert_eq!(
            transitions[1].0.address.as_deref(),
            Some("127.0.0.1:43891"),
            "the host needs the old address to stop watching it"
        );
        assert_eq!(transitions[1].1.address.as_deref(), Some("127.0.0.1:51234"));
    }
}
