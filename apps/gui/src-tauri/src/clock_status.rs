//! Publishing a session's clock offset (Task 68) and the two log lines
//! the owner's ruling allows: one at session start, and one per
//! warn-state transition — never per probe round, never per frame.
//!
//! The measurement itself lives on `cannet_client::clock::SessionClock`,
//! updated by the session's own worker on its own schedule (a start-up
//! probe, then a fixed re-probe cadence — see that crate's `clock`
//! module docs). Nothing calls back out of `cannet-client` when a round
//! settles, so this is a poll: a lightweight periodic tick reads every
//! active session's [`SessionClock::record`], republishes the merged
//! server list (`crate::server_list`) whenever a row's summary actually
//! moved, and drives [`ClockLatch`] — the pure state machine the log
//! lines come from.

use std::collections::HashMap;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use cannet_client::clock::{ClockProbeStatus, ClockRecord};

use crate::app_state::AppState;
use crate::server_list::{self, server_clock_from_record, ServerClock, CLOCK_WARN_THRESHOLD_NS};
use crate::{sys_info, sys_warn};

/// How often the host polls active sessions' clock records. Far above
/// anything that could matter here — the fastest thing that can move a
/// record is the session's own 30 s re-probe cadence, and the start-up
/// probe settles within its 2 s window — but frequent enough that a
/// settled measurement or a warn-state transition reaches the row and
/// the log within a second of the round that produced it.
const CLOCK_STATUS_POLL: Duration = Duration::from_secs(1);

/// What [`ClockLatch::observe`] found worth logging on one tick.
/// `None` covers everything else: nothing has settled yet
/// ([`ClockProbeStatus::Pending`]), or the state hasn't moved since the
/// last observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClockLogEvent {
    /// The session's first settled status — logged exactly once,
    /// whichever it turns out to be. `offset_ns` is `None` for a peer
    /// that never answered the probe at all.
    SessionStart { offset_ns: Option<i64>, warn: bool },
    /// The warn state flipped since the last observation this session
    /// logged.
    Transition { offset_ns: i64, warn: bool },
}

/// Per-session log state: whether the session-start line has fired yet,
/// and — once it has, for a peer that answers — which side of
/// [`CLOCK_WARN_THRESHOLD_NS`] the last *logged* state was on. A pure
/// state machine (no I/O), so "once per crossing, both directions" is
/// unit-testable without a session or an `AppHandle`.
#[derive(Debug, Default)]
pub(crate) struct ClockLatch {
    logged: bool,
    warn: bool,
}

impl ClockLatch {
    /// Fold one tick's record through the latch. A peer that never
    /// answers latches once (`Unsupported`) and never speaks again —
    /// consistent with `cannet_client::clock::ProbeRounds` giving up on
    /// it for the rest of the session.
    pub(crate) fn observe(&mut self, record: &ClockRecord) -> Option<ClockLogEvent> {
        match record.status {
            ClockProbeStatus::Pending => None,
            ClockProbeStatus::Unsupported => {
                if self.logged {
                    None
                } else {
                    self.logged = true;
                    Some(ClockLogEvent::SessionStart {
                        offset_ns: None,
                        warn: false,
                    })
                }
            }
            ClockProbeStatus::Measured(_) => {
                let offset_ns = record.measured_offset_ns?;
                let warn = offset_ns.abs() > CLOCK_WARN_THRESHOLD_NS;
                if !self.logged {
                    self.logged = true;
                    self.warn = warn;
                    Some(ClockLogEvent::SessionStart {
                        offset_ns: Some(offset_ns),
                        warn,
                    })
                } else if warn != self.warn {
                    self.warn = warn;
                    Some(ClockLogEvent::Transition { offset_ns, warn })
                } else {
                    None
                }
            }
        }
    }
}

/// Poll every active session's clock record on [`CLOCK_STATUS_POLL`]:
/// publish the merged server list whenever a row's clock summary moved,
/// and turn each session's [`ClockLatch`] events into the ruled system-
/// log lines.
pub(crate) fn spawn_clock_status_emitter(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(CLOCK_STATUS_POLL);
        let mut published: HashMap<String, ServerClock> = HashMap::new();
        let mut latches: HashMap<String, ClockLatch> = HashMap::new();
        loop {
            interval.tick().await;
            let records: Vec<(String, ClockRecord)> = {
                let state: State<'_, AppState> = app.state();
                let sessions = state.remote_sessions();
                sessions
                    .iter()
                    .filter_map(|(address, session)| {
                        session
                            .clock
                            .as_ref()
                            .map(|clock| (address.clone(), clock.record()))
                    })
                    .collect()
            };

            // Log lines. A session that has disconnected drops its
            // latch, so a fresh connect to the same address logs its
            // own session-start line rather than inheriting the old
            // one's warn state.
            latches.retain(|address, _| records.iter().any(|(a, _)| a == address));
            for (address, record) in &records {
                if let Some(event) = latches.entry(address.clone()).or_default().observe(record) {
                    log_event(&app, address, event);
                }
            }

            // Row publication: emit only when a summary actually moved
            // (same shape as `interfaces::update_cache_and_emit`).
            let current: HashMap<String, ServerClock> = records
                .iter()
                .filter_map(|(address, record)| {
                    server_clock_from_record(record).map(|c| (address.clone(), c))
                })
                .collect();
            if current != published {
                published = current;
                server_list::changed(&app);
            }
        }
    });
}

/// Render one [`ClockLogEvent`] as the system-log line the ruling
/// allows.
fn log_event(app: &AppHandle, address: &str, event: ClockLogEvent) {
    match event {
        ClockLogEvent::SessionStart {
            offset_ns: None, ..
        } => {
            sys_info!(
                app,
                "connection",
                "clock offset vs {address}: not supported by this server"
            );
        }
        ClockLogEvent::SessionStart {
            offset_ns: Some(offset_ns),
            warn,
        } => {
            let ms = format_offset_ms(offset_ns);
            if warn {
                sys_warn!(
                    app,
                    "connection",
                    "clock offset vs {address}: {ms}, applied"
                );
            } else {
                sys_info!(
                    app,
                    "connection",
                    "clock offset vs {address}: {ms}, applied"
                );
            }
        }
        ClockLogEvent::Transition { offset_ns, warn } => {
            let ms = format_offset_ms(offset_ns);
            if warn {
                sys_warn!(
                    app,
                    "connection",
                    "clock offset vs {address} crossed above 100 ms: {ms}"
                );
            } else {
                sys_info!(
                    app,
                    "connection",
                    "clock offset vs {address} recovered below 100 ms: {ms}"
                );
            }
        }
    }
}

/// `offset_ns` as a signed millisecond figure for a log line — the
/// threshold this all keys off is stated in milliseconds, so the line
/// reads in the same unit.
fn format_offset_ms(offset_ns: i64) -> String {
    #[allow(clippy::cast_precision_loss)]
    let ms = offset_ns as f64 / 1_000_000.0;
    format!("{ms:+.1} ms")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measured(offset_ns: i64) -> ClockRecord {
        ClockRecord {
            status: ClockProbeStatus::Measured(cannet_client::clock::ClockOffset {
                offset_ns,
                delay_ns: 1_000_000,
                samples: 4,
            }),
            start_offset_ns: Some(offset_ns),
            measured_offset_ns: Some(offset_ns),
            applied_offset_ns: offset_ns,
            delay_ns: Some(1_000_000),
            samples: 4,
            rounds: 1,
            silent_rounds: 0,
            measured_at_ns: Some(0),
        }
    }

    fn pending() -> ClockRecord {
        ClockRecord {
            status: ClockProbeStatus::Pending,
            start_offset_ns: None,
            measured_offset_ns: None,
            applied_offset_ns: 0,
            delay_ns: None,
            samples: 0,
            rounds: 0,
            silent_rounds: 0,
            measured_at_ns: None,
        }
    }

    fn unsupported() -> ClockRecord {
        ClockRecord {
            status: ClockProbeStatus::Unsupported,
            ..pending()
        }
    }

    #[test]
    fn pending_logs_nothing() {
        assert_eq!(ClockLatch::default().observe(&pending()), None);
    }

    #[test]
    fn the_first_settled_measurement_is_the_session_start_line() {
        let mut latch = ClockLatch::default();
        assert_eq!(
            latch.observe(&measured(42_000_000)),
            Some(ClockLogEvent::SessionStart {
                offset_ns: Some(42_000_000),
                warn: false,
            }),
        );
    }

    #[test]
    fn a_repeated_measurement_in_the_same_regime_logs_nothing_more() {
        let mut latch = ClockLatch::default();
        latch.observe(&measured(42_000_000));
        assert_eq!(latch.observe(&measured(45_000_000)), None);
        assert_eq!(latch.observe(&measured(-42_000_000)), None);
    }

    #[test]
    fn crossing_above_then_recovering_logs_exactly_one_line_each_way() {
        let mut latch = ClockLatch::default();
        latch.observe(&measured(10_000_000)); // session start, below
        assert_eq!(
            latch.observe(&measured(150_000_000)),
            Some(ClockLogEvent::Transition {
                offset_ns: 150_000_000,
                warn: true,
            }),
            "the crossing"
        );
        // Holding above threshold logs nothing more.
        assert_eq!(latch.observe(&measured(160_000_000)), None);
        assert_eq!(
            latch.observe(&measured(50_000_000)),
            Some(ClockLogEvent::Transition {
                offset_ns: 50_000_000,
                warn: false,
            }),
            "the recovery"
        );
        // Holding below threshold logs nothing more.
        assert_eq!(latch.observe(&measured(10_000_000)), None);
    }

    #[test]
    fn a_negative_offset_past_threshold_still_warns() {
        let mut latch = ClockLatch::default();
        latch.observe(&measured(0));
        assert_eq!(
            latch.observe(&measured(-150_000_000)),
            Some(ClockLogEvent::Transition {
                offset_ns: -150_000_000,
                warn: true,
            }),
        );
    }

    #[test]
    fn a_session_start_that_is_already_over_threshold_warns_immediately() {
        let mut latch = ClockLatch::default();
        assert_eq!(
            latch.observe(&measured(4_000_000_000)),
            Some(ClockLogEvent::SessionStart {
                offset_ns: Some(4_000_000_000),
                warn: true,
            }),
        );
    }

    #[test]
    fn an_unsupported_peer_logs_once_and_never_again() {
        let mut latch = ClockLatch::default();
        assert_eq!(
            latch.observe(&unsupported()),
            Some(ClockLogEvent::SessionStart {
                offset_ns: None,
                warn: false,
            }),
        );
        assert_eq!(latch.observe(&unsupported()), None);
    }

    #[test]
    fn staleness_alone_does_not_trigger_a_transition() {
        // Silence is a lost round, not a retraction (see
        // `cannet_client::clock`); the row greys, but nothing is logged
        // unless the warn state itself moves.
        let mut latch = ClockLatch::default();
        latch.observe(&measured(42_000_000));
        let mut stale = measured(42_000_000);
        stale.silent_rounds = 3;
        assert_eq!(latch.observe(&stale), None);
    }

    #[test]
    fn offset_formatting_keeps_the_sign_and_one_decimal() {
        assert_eq!(format_offset_ms(4_200_000_000), "+4200.0 ms");
        assert_eq!(format_offset_ms(-42_000_000), "-42.0 ms");
        assert_eq!(format_offset_ms(0), "+0.0 ms");
    }
}
