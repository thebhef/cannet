//! The shutdown sequence, run behind a window that stays up.
//!
//! Closing cannet is not instant: the host hangs up on its servers,
//! finishes every logger's file, hardens the capture scratch with one
//! synchronous flush and records the signal pyramids — tens of seconds
//! for a multi-GB capture — and only then hands the project cache's lock
//! back (ADR 0002 DS-7). All of that used to run after the window was
//! gone, so the app looked closed while it still held the cache, and a
//! relaunch in that gap is refused. Now the window stays up and says
//! what it is doing until the host is done.
//!
//! How every exit route reaches the sequence exactly once:
//!
//! - **The window's close** (title bar, the Quit command, which closes
//!   the window): the frontend's close handler owns the decision —
//!   Tauri itself holds the close open while a webview listens for it —
//!   and, once nothing unsaved stands in the way, calls [`begin_close`]
//!   instead of destroying the window.
//! - **An exit request** (`AppHandle::exit(code)`, a destroyed window,
//!   the OS): `run`'s `RunEvent::ExitRequested` arm holds the exit with
//!   `prevent_exit` and calls [`begin_shutdown`] with the code.
//!
//! [`ClosingGate`] makes the start one-shot, so a second close click or
//! a second exit request while the sequence runs changes nothing. The
//! sequence runs on its own thread — never the event loop, which has to
//! keep painting the window and delivering its events (ADR 0049) — and
//! ends with `AppHandle::exit(code)`, which the `ExitRequested` arm lets
//! through because the gate reads finished.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::app_state::AppState;
use crate::signal_cache::Harden;

/// The event each step of the shutdown sequence is announced on; the
/// payload is a [`ClosingProgress`].
pub(crate) const CLOSING_PROGRESS_EVENT: &str = "closing-progress";

/// The step the shutdown sequence is on, as the closing window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub(crate) enum ClosingProgress {
    /// Hanging up on every connected server.
    Disconnecting,
    /// Waiting for each running logger to finish its file.
    FinishingLoggers,
    /// "Clear scratch cache on exit" is on: the capture is being wiped
    /// instead of written.
    ClearingCapture,
    /// The synchronous flush of the capture scratch. `bytes` is the
    /// scratch's size as of the last periodic flush — how much the flush
    /// is hardening — or `None` for the in-RAM store.
    WritingCapture { bytes: Option<u64> },
    /// Recording the signal pyramids: `done` of `total` held signals
    /// flushed. `total` is 0 until the first signal is through (and stays
    /// 0 when there is nothing to write).
    WritingSignals { done: usize, total: usize },
}

/// The work the shutdown sequence does, one method per step, so the
/// order can be tested without a running app.
pub(crate) trait ShutdownWork {
    fn disconnect(&mut self);
    fn stop_loggers(&mut self);
    /// Whether the user asked for the capture to be wiped on exit.
    fn clears_on_exit(&mut self) -> bool;
    fn clear_capture(&mut self);
    fn capture_bytes(&mut self) -> Option<u64>;
    fn flush_capture(&mut self);
    fn persist_signals(&mut self, progress: &mut dyn FnMut(usize, usize));
    /// Hand the project cache's lock back (ADR 0002 DS-7).
    fn release_cache(&mut self);
}

/// Run the shutdown sequence, announcing each step through `report`
/// before doing it.
///
/// The order is the contract: the disconnect first, so no more frames
/// land while the scratch is written; the loggers next, so their files
/// are finished; then the capture flush and the pyramids after it (the
/// pyramids' validity key carries the low-water mark the flush just
/// persisted, ADR 0047); and the cache lock **last**, once every write
/// into the directory is done — a relaunch mid-flush is refused rather
/// than let onto a half-written cache.
///
/// The signal count is reported at most once per whole percent, so a
/// capture with thousands of signals sends ~100 events, not thousands.
pub(crate) fn run_shutdown(work: &mut impl ShutdownWork, report: &mut impl FnMut(ClosingProgress)) {
    report(ClosingProgress::Disconnecting);
    work.disconnect();
    report(ClosingProgress::FinishingLoggers);
    work.stop_loggers();
    if work.clears_on_exit() {
        report(ClosingProgress::ClearingCapture);
        work.clear_capture();
    } else {
        report(ClosingProgress::WritingCapture {
            bytes: work.capture_bytes(),
        });
        work.flush_capture();
        report(ClosingProgress::WritingSignals { done: 0, total: 0 });
        let mut last_percent = 0;
        work.persist_signals(&mut |done, total| {
            let percent = done * 100 / total.max(1);
            if percent > last_percent || done == total {
                last_percent = percent;
                report(ClosingProgress::WritingSignals { done, total });
            }
        });
    }
    work.release_cache();
}

const IDLE: u8 = 0;
const RUNNING: u8 = 1;
const FINISHED: u8 = 2;

/// Whether the shutdown sequence has started or finished, and the exit
/// code the process leaves with. Managed app state; one per process.
#[derive(Default)]
pub(crate) struct ClosingGate {
    phase: AtomicU8,
    code: Mutex<Option<i32>>,
}

impl ClosingGate {
    /// Start the sequence. `true` for the first caller only; every call
    /// records `code` if it has one (a later code wins), so an exit
    /// request that arrives mid-sequence still sets what the process
    /// exits with.
    pub(crate) fn begin(&self, code: Option<i32>) -> bool {
        if code.is_some() {
            *self.code.lock().expect("closing code mutex poisoned") = code;
        }
        self.phase
            .compare_exchange(IDLE, RUNNING, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// Whether the sequence has started (and so a close must be held).
    pub(crate) fn is_started(&self) -> bool {
        self.phase.load(Ordering::Acquire) != IDLE
    }

    /// Whether the sequence is done, so an exit request may go through.
    pub(crate) fn is_finished(&self) -> bool {
        self.phase.load(Ordering::Acquire) == FINISHED
    }

    /// Mark the sequence done and return the code to exit with: the one
    /// requested, or 0.
    fn finish(&self) -> i32 {
        self.phase.store(FINISHED, Ordering::Release);
        self.code
            .lock()
            .expect("closing code mutex poisoned")
            .unwrap_or(0)
    }
}

/// The exit code for a shutdown sequence that panicked part-way — Rust's
/// own code for a panicking process, which is what the process would have
/// died with had the sequence still run on the event loop.
const PANICKED_EXIT_CODE: i32 = 101;

/// Start the shutdown sequence on its own thread, unless it has already
/// started; then exit the app with the requested code (or 0) when it is
/// done. The app exits even if a step panics — a window held open
/// forever by a dead sequence would be worse than the lost flush.
pub(crate) fn begin_shutdown(app: &AppHandle, code: Option<i32>) {
    if !app.state::<ClosingGate>().begin(code) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_shutdown(&mut HostShutdown { app: &app }, &mut |step| {
                let _ = app.emit(CLOSING_PROGRESS_EVENT, step);
            });
        }));
        let code = app.state::<ClosingGate>().finish();
        app.exit(if ran.is_ok() {
            code
        } else {
            PANICKED_EXIT_CODE
        });
    });
}

/// Close the app: run the shutdown sequence behind the window, which the
/// app then closes with. What the frontend calls once its close handler
/// has decided the window may go; a no-op once the sequence has started.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn begin_close(app: AppHandle) {
    begin_shutdown(&app, None);
}

/// The real shutdown steps, over the running app.
struct HostShutdown<'a> {
    app: &'a AppHandle,
}

impl ShutdownWork for HostShutdown<'_> {
    fn disconnect(&mut self) {
        // Hang up on every server before the process goes away, so the
        // disconnect is something we did rather than something the server
        // infers from a socket that stopped answering. Bounded — see
        // `session::disconnect_on_exit`.
        crate::session::disconnect_on_exit(self.app);
    }

    fn stop_loggers(&mut self) {
        // A logger streams straight into its destination, so a file the
        // process walks away from is left unfinalized — readable only
        // through the reader's recovery path. Stopping waits for the
        // writer, so the capture on disk is complete.
        crate::logger::stop_all(self.app);
    }

    fn clears_on_exit(&mut self) -> bool {
        crate::settings::get_settings(self.app.clone()).clear_scratch_on_exit
    }

    fn clear_capture(&mut self) {
        // Opt-in "clear scratch cache on exit" (Settings, ADR 0002 DS-7):
        // the same reset the Clear command runs — it clears the live,
        // still-mapped scratch in place, so no unmap dance is needed.
        crate::capture::clear_trace_store_now(self.app, &self.app.state::<AppState>());
    }

    fn capture_bytes(&mut self) -> Option<u64> {
        self.app
            .state::<AppState>()
            .trace_store
            .scratch_footprint_bytes()
    }

    fn flush_capture(&mut self) {
        // One synchronous flush: the periodic flusher only queues async
        // writeback (ADR 0002 DS-2), and a power loss right after quit
        // could otherwise lose the trailing window.
        if let Err(e) = self.app.state::<AppState>().trace_store.flush() {
            tracing::warn!(error = %e, "shutdown trace flush failed");
        }
    }

    fn persist_signals(&mut self, progress: &mut dyn FnMut(usize, usize)) {
        // What the *next* launch reads instead of re-decoding the whole
        // history (ADR 0047). The flusher hardens each segment as it
        // seals, so what is left here is one tail segment per level.
        crate::emitters::persist_pyramids_reporting(
            &self.app.state::<AppState>(),
            Harden::All,
            progress,
        );
    }

    fn release_cache(&mut self) {
        // The OS would release the lock when the process dies, but that
        // is after `std::process::exit` in `run` — handing it back here
        // is what lets a relaunch that arrives the moment the writes are
        // done open the project.
        self.app.state::<AppState>().scratch_lock().take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records each step's call, so a test can read the order back.
    #[derive(Default)]
    struct FakeWork {
        log: Vec<&'static str>,
        clears: bool,
        signals: usize,
    }

    impl ShutdownWork for FakeWork {
        fn disconnect(&mut self) {
            self.log.push("disconnect");
        }
        fn stop_loggers(&mut self) {
            self.log.push("stop_loggers");
        }
        fn clears_on_exit(&mut self) -> bool {
            self.clears
        }
        fn clear_capture(&mut self) {
            self.log.push("clear_capture");
        }
        fn capture_bytes(&mut self) -> Option<u64> {
            Some(4096)
        }
        fn flush_capture(&mut self) {
            self.log.push("flush_capture");
        }
        fn persist_signals(&mut self, progress: &mut dyn FnMut(usize, usize)) {
            self.log.push("persist_signals");
            for done in 1..=self.signals {
                progress(done, self.signals);
            }
        }
        fn release_cache(&mut self) {
            self.log.push("release_cache");
        }
    }

    fn run(work: &mut FakeWork) -> Vec<ClosingProgress> {
        let mut reported = Vec::new();
        run_shutdown(work, &mut |step| reported.push(step));
        reported
    }

    #[test]
    fn each_step_is_announced_before_it_runs_and_the_lock_goes_last() {
        let mut work = FakeWork {
            signals: 2,
            ..FakeWork::default()
        };
        let reported = run(&mut work);
        assert_eq!(
            reported,
            vec![
                ClosingProgress::Disconnecting,
                ClosingProgress::FinishingLoggers,
                ClosingProgress::WritingCapture { bytes: Some(4096) },
                ClosingProgress::WritingSignals { done: 0, total: 0 },
                ClosingProgress::WritingSignals { done: 1, total: 2 },
                ClosingProgress::WritingSignals { done: 2, total: 2 },
            ]
        );
        assert_eq!(
            work.log,
            [
                "disconnect",
                "stop_loggers",
                "flush_capture",
                "persist_signals",
                "release_cache"
            ]
        );
    }

    #[test]
    fn clear_on_exit_wipes_instead_of_writing_and_still_releases_last() {
        let mut work = FakeWork {
            clears: true,
            signals: 3,
            ..FakeWork::default()
        };
        let reported = run(&mut work);
        assert_eq!(
            reported,
            vec![
                ClosingProgress::Disconnecting,
                ClosingProgress::FinishingLoggers,
                ClosingProgress::ClearingCapture,
            ]
        );
        assert_eq!(
            work.log,
            [
                "disconnect",
                "stop_loggers",
                "clear_capture",
                "release_cache"
            ]
        );
    }

    #[test]
    fn a_large_signal_set_reports_once_per_percent_and_always_the_end() {
        let mut work = FakeWork {
            signals: 1000,
            ..FakeWork::default()
        };
        let signal_reports: Vec<_> = run(&mut work)
            .into_iter()
            .filter_map(|step| match step {
                ClosingProgress::WritingSignals { done, total } if total > 0 => Some(done),
                _ => None,
            })
            .collect();
        assert_eq!(signal_reports.len(), 100);
        assert_eq!(signal_reports.last(), Some(&1000));
        assert!(signal_reports.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn the_gate_starts_once_and_keeps_the_latest_requested_code() {
        let gate = ClosingGate::default();
        assert!(!gate.is_started());
        assert!(gate.begin(None), "the first request starts the sequence");
        assert!(gate.is_started());
        assert!(!gate.is_finished());
        // A second close click, and an exit request with a code, while it
        // runs: neither starts it again, the code is kept.
        assert!(!gate.begin(None));
        assert!(!gate.begin(Some(3)));
        assert!(!gate.begin(None), "a code-less request keeps the code");
        assert_eq!(gate.finish(), 3);
        assert!(gate.is_finished());
        assert!(!gate.begin(None), "a finished sequence never restarts");
    }

    #[test]
    fn a_plain_close_exits_zero() {
        let gate = ClosingGate::default();
        assert!(gate.begin(None));
        assert_eq!(gate.finish(), 0);
    }

    #[test]
    fn the_payload_is_tagged_by_step() {
        let json = |p: ClosingProgress| serde_json::to_value(p).unwrap();
        assert_eq!(
            json(ClosingProgress::FinishingLoggers),
            serde_json::json!({ "step": "finishing_loggers" })
        );
        assert_eq!(
            json(ClosingProgress::WritingCapture { bytes: None }),
            serde_json::json!({ "step": "writing_capture", "bytes": null })
        );
        assert_eq!(
            json(ClosingProgress::WritingSignals { done: 4, total: 9 }),
            serde_json::json!({ "step": "writing_signals", "done": 4, "total": 9 })
        );
    }
}
