//! Recovery from a dead `WebView` renderer, and a close that works
//! without one.
//!
//! The frontend's 1 Hz `report_js_heap` is the host's only evidence the
//! renderer is alive ([`crate::crash`]). When the renderer process dies
//! — `WebView2` kills it out of memory — the host keeps capturing, but
//! nothing reloads the page and the close button is dead: the frontend
//! registered a close-requested listener, so Tauri holds every close for
//! it, and a dead renderer never answers.
//!
//! - **Reload.** A heartbeat silent for [`FRONTEND_GONE_MS`] *and* a
//!   `WebView` process family with no renderer in it is a dead renderer,
//!   and the host reloads the main webview, which rejoins the running
//!   session (ADR 0063). Silence alone is not enough: a renderer in a
//!   long GC pause is alive and must not be reloaded. A family the host
//!   cannot attribute (macOS, a shared browser process) is never acted
//!   on. Reloads are capped ([`MAX_RELOADS`] per [`RELOAD_WINDOW_MS`],
//!   none within [`RELOAD_GRACE_MS`] of the last) so a page that dies
//!   while it boots is not reloaded forever.
//! - **Close.** A close request while the heartbeat has been silent for
//!   [`FRONTEND_GONE_MS`] — renderer dead or hung — runs the host's
//!   shutdown sequence directly (`lib.rs`'s run loop). The frontend's
//!   unsaved-changes prompt cannot run; the capture is still written,
//!   which killing the process — the only way out before — did not do.

use std::collections::VecDeque;
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// How long the UI heartbeat may be silent before the host treats the
/// frontend as unable to answer. Well past the ~2 s main-thread stalls a
/// heavily loaded frontend shows several times an hour.
pub(crate) const FRONTEND_GONE_MS: u64 = 10_000;

/// How often the watch looks. The process scan runs only when the
/// heartbeat is already stale.
const CHECK_EVERY: Duration = Duration::from_secs(2);

/// No verdict this soon after a reload: the reloaded page has not sent
/// its first heartbeat yet, so the age still describes the dead one.
const RELOAD_GRACE_MS: u64 = 30_000;

/// The window the reload cap counts over.
const RELOAD_WINDOW_MS: u64 = 10 * 60_000;

/// Automatic reloads allowed per [`RELOAD_WINDOW_MS`].
const MAX_RELOADS: usize = 3;

/// What the host's own process family says about the renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RendererPresence {
    /// A renderer process is ours and running.
    Running,
    /// Our `WebView` family is there, with no renderer in it.
    Gone,
    /// The family cannot be attributed to this host — nothing to judge.
    Unknown,
}

/// What one look decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// The heartbeat is current.
    Healthy,
    /// Silent, but nothing to do: the renderer is alive (hung or busy),
    /// unattributable, just reloaded, or past the cap already reported.
    Wait,
    /// Reload, the `nth` automatic one inside the window.
    Reload { nth: usize },
    /// The renderer is gone again with the cap spent. Reported once per
    /// episode.
    GiveUp,
}

/// The reload history the cap counts.
#[derive(Debug, Default)]
struct Watch {
    /// When each automatic reload inside the window was issued, ms.
    reloads: VecDeque<u64>,
    /// The cap's give-up has been reported for the current episode.
    gave_up: bool,
}

impl Watch {
    /// Judge one look at `now_ms`. `presence` is asked only when the
    /// heartbeat is stale, since it costs a process scan.
    fn judge(
        &mut self,
        now_ms: u64,
        heartbeat_age_ms: Option<u64>,
        presence: impl FnOnce() -> RendererPresence,
    ) -> Verdict {
        if !cannot_answer(heartbeat_age_ms) {
            self.gave_up = false;
            return Verdict::Healthy;
        }
        if self
            .reloads
            .back()
            .is_some_and(|&at| now_ms.saturating_sub(at) < RELOAD_GRACE_MS)
        {
            return Verdict::Wait;
        }
        if presence() != RendererPresence::Gone {
            return Verdict::Wait;
        }
        while self
            .reloads
            .front()
            .is_some_and(|&at| now_ms.saturating_sub(at) >= RELOAD_WINDOW_MS)
        {
            self.reloads.pop_front();
        }
        if self.reloads.len() >= MAX_RELOADS {
            if self.gave_up {
                return Verdict::Wait;
            }
            self.gave_up = true;
            return Verdict::GiveUp;
        }
        self.reloads.push_back(now_ms);
        self.gave_up = false;
        Verdict::Reload {
            nth: self.reloads.len(),
        }
    }
}

/// Whether a frontend whose heartbeat is `age_ms` old can answer a close
/// request. `None` (no heartbeat yet) is a frontend still booting, which
/// has not registered its close handler and so is not holding the close.
fn cannot_answer(age_ms: Option<u64>) -> bool {
    age_ms.is_some_and(|age| age >= FRONTEND_GONE_MS)
}

/// Whether the frontend is too far gone to answer a close request; the
/// run loop then closes from the host.
pub(crate) fn frontend_cannot_answer() -> bool {
    cannot_answer(crate::crash::ui_heartbeat_age_ms())
}

/// Spawn the watch on a named OS thread.
pub(crate) fn spawn(app: AppHandle) {
    let mut watch = Watch::default();
    let mut sys = sysinfo::System::new();
    let own_pid = sysinfo::get_current_pid().ok();
    let _ = std::thread::Builder::new()
        .name("cannet-renderer-watch".into())
        .spawn(move || loop {
            std::thread::sleep(CHECK_EVERY);
            if app.state::<crate::closing::ClosingGate>().is_started() {
                return;
            }
            let age = crate::crash::ui_heartbeat_age_ms();
            let verdict = watch.judge(cannet_log::unix_ms(), age, || {
                crate::crash::renderer_presence(&mut sys, own_pid)
            });
            act(&app, verdict, age);
        });
}

fn act(app: &AppHandle, verdict: Verdict, age: Option<u64>) {
    let age = age.unwrap_or(0);
    match verdict {
        Verdict::Healthy | Verdict::Wait => {}
        Verdict::Reload { nth } => {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            match window.reload() {
                Ok(()) => crate::sys_warn!(
                    app,
                    "health",
                    "renderer process is gone (no UI heartbeat for {age} ms); reloaded the \
                     window — automatic reload {nth} of {MAX_RELOADS} in 10 min"
                ),
                Err(e) => crate::sys_warn!(
                    app,
                    "health",
                    "renderer process is gone (no UI heartbeat for {age} ms); reload failed: {e}"
                ),
            }
        }
        Verdict::GiveUp => crate::sys_warn!(
            app,
            "health",
            "renderer process is gone again; not reloading after {MAX_RELOADS} automatic \
             reloads in 10 min. Closing the window still saves the capture and exits."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1_000;

    fn never() -> RendererPresence {
        panic!("a fresh heartbeat must not cost a process scan")
    }

    #[test]
    fn a_fresh_heartbeat_is_healthy_and_scans_nothing() {
        let mut w = Watch::default();
        assert_eq!(w.judge(100 * S, Some(900), never), Verdict::Healthy);
        assert_eq!(w.judge(100 * S, None, never), Verdict::Healthy);
    }

    #[test]
    fn a_silent_but_running_renderer_is_not_reloaded() {
        // A long GC pause or a busy main thread: alive, just late.
        let mut w = Watch::default();
        let v = w.judge(100 * S, Some(60 * S), || RendererPresence::Running);
        assert_eq!(v, Verdict::Wait);
    }

    #[test]
    fn an_unattributable_family_is_not_acted_on() {
        let mut w = Watch::default();
        let v = w.judge(100 * S, Some(60 * S), || RendererPresence::Unknown);
        assert_eq!(v, Verdict::Wait);
    }

    #[test]
    fn a_short_silence_does_not_look() {
        let mut w = Watch::default();
        assert_eq!(
            w.judge(100 * S, Some(FRONTEND_GONE_MS - 1), never),
            Verdict::Healthy
        );
    }

    #[test]
    fn a_dead_renderer_is_reloaded_then_given_time_to_boot() {
        let mut w = Watch::default();
        let gone = || RendererPresence::Gone;
        assert_eq!(
            w.judge(100 * S, Some(12 * S), gone),
            Verdict::Reload { nth: 1 }
        );
        // The age still describes the dead page until the new one beats.
        assert_eq!(w.judge(110 * S, Some(22 * S), gone), Verdict::Wait);
        assert_eq!(
            w.judge(131 * S, Some(43 * S), gone),
            Verdict::Reload { nth: 2 }
        );
    }

    #[test]
    fn a_page_that_keeps_dying_is_reloaded_three_times_then_reported_once() {
        // 11-18: every reload rejoined the session and died within ~20 s.
        let mut w = Watch::default();
        let gone = || RendererPresence::Gone;
        let mut t = 100 * S;
        for nth in 1..=MAX_RELOADS {
            assert_eq!(w.judge(t, Some(20 * S), gone), Verdict::Reload { nth });
            t += RELOAD_GRACE_MS + S;
        }
        assert_eq!(w.judge(t, Some(20 * S), gone), Verdict::GiveUp);
        assert_eq!(w.judge(t + 5 * S, Some(25 * S), gone), Verdict::Wait);
        // Once the oldest reload leaves the window, one more is allowed.
        let later = 100 * S + RELOAD_WINDOW_MS + S;
        assert_eq!(
            w.judge(later, Some(20 * S), gone),
            Verdict::Reload { nth: 3 }
        );
    }

    #[test]
    fn a_recovered_frontend_reopens_the_give_up_report() {
        let mut w = Watch::default();
        let gone = || RendererPresence::Gone;
        let mut t = 100 * S;
        for _ in 0..MAX_RELOADS {
            w.judge(t, Some(20 * S), gone);
            t += RELOAD_GRACE_MS + S;
        }
        assert_eq!(w.judge(t, Some(20 * S), gone), Verdict::GiveUp);
        // Reloaded by hand; it beats again, then dies again.
        assert_eq!(w.judge(t + S, Some(500), never), Verdict::Healthy);
        assert_eq!(w.judge(t + 40 * S, Some(20 * S), gone), Verdict::GiveUp);
    }

    #[test]
    fn a_close_goes_to_the_host_only_when_the_frontend_has_been_silent() {
        assert!(!cannot_answer(None), "still booting: no close handler yet");
        assert!(
            !cannot_answer(Some(3_000)),
            "a GC pause answers late, but answers"
        );
        assert!(cannot_answer(Some(FRONTEND_GONE_MS)));
        assert!(cannot_answer(Some(5 * 60_000)));
    }
}
