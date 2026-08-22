//! Bus health — the low-level state of each logical bus, which the app
//! surfaced nowhere before.
//!
//! Three things live here, all of them host-side because they are
//! computation over the frame stream and over the session's own state:
//!
//! - **Error-frame coalescing.** An error frame aborts the frame in
//!   flight, which is then retransmitted, so a persistent physical fault
//!   yields error → retransmit → error at roughly the bus's whole frame
//!   rate. [`ErrorRuns`] folds a run of them into one summary carrying a
//!   count and a span, published as a host-derived `busError` timeline
//!   event (ADR 0035). **The frames themselves are stored like any
//!   other frame** — the summary sits beside them, never instead of
//!   them, so a saved capture is not a lossy restatement of what was
//!   received.
//! - **Controller state.** `InterfaceState` — the ISO 11898-1
//!   fault-confinement state plus the transmit and receive error
//!   counters — arrives on the session stream and is cached here per
//!   interface.
//! - **Bus load.** Computed where the bitrate is known and reported as
//!   absent where it is not; see [`load_percent`].
//!
//! The frontend joins these rows against the project's buses, which it
//! owns: a bus the host has nothing to say about is absent from the map
//! and reads as an em dash rather than as a zero.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::notes::{EventKind, Note};

/// How often the host republishes the coalesced summaries. A fault at
/// bus frame rate moves the count thousands of times a second and every
/// republication repaints three event surfaces, so the cadence is the
/// readout's, not the bus's — the same once-a-second poll the clock
/// status uses.
const BUS_HEALTH_POLL: Duration = Duration::from_secs(1);

/// Errors closer together than this — in **frame time**, so an import
/// reads the same as a live session — belong to one episode. A fault at
/// bus frame rate produces thousands per second, and what distinguishes
/// them is the count and the span, not the individual arrivals; a gap
/// this long is what separates "the bus is still faulting" from "it
/// faulted again later".
pub(crate) const COALESCE_GAP_NS: u64 = 1_000_000_000;

/// Ceiling on the number of coalesced runs held at once. The runs are
/// events, and events are held in RAM and rendered whole (ADR 0035), so
/// the set has to be bounded by something other than how long the
/// session runs. Past the cap the oldest run is dropped — the same
/// windowed-ring answer the frame store gives (ADR 0002 DS-8), and the
/// frames it summarised are still in the capture.
pub(crate) const MAX_RUNS: usize = 256;

/// One coalesced run of error frames on one bus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ErrorRun {
    pub(crate) bus_id: String,
    pub(crate) first_ts_ns: u64,
    pub(crate) last_ts_ns: u64,
    pub(crate) count: u64,
}

impl ErrorRun {
    /// Frame-time span of the run in seconds. Zero for a run of one.
    #[allow(clippy::cast_precision_loss)]
    fn span_secs(&self) -> f64 {
        self.last_ts_ns.saturating_sub(self.first_ts_ns) as f64 / 1e9
    }

    /// Errors per second averaged over the run's own span. `0.0` for a
    /// run that has not yet spanned any time — one error carries a
    /// count, not a rate.
    #[allow(clippy::cast_precision_loss)]
    fn rate(&self) -> f64 {
        let span = self.span_secs();
        if span <= 0.0 {
            return 0.0;
        }
        self.count as f64 / span
    }
}

/// The coalescer: every error frame the ingest path sees, folded into
/// runs. Pure — no clock, no locks, no Tauri — so the coalescing rule is
/// testable on its own.
#[derive(Debug, Default)]
pub(crate) struct ErrorRuns {
    runs: Vec<ErrorRun>,
    /// Every error ever seen per bus, including any whose run has since
    /// been evicted by [`MAX_RUNS`]. The panel's count must not fall
    /// when a summary ages out.
    totals: BTreeMap<String, u64>,
}

impl ErrorRuns {
    /// Fold in one error frame on `bus_id`, stamped `ts_ns`.
    pub(crate) fn observe(&mut self, bus_id: &str, ts_ns: u64) {
        *self.totals.entry(bus_id.to_string()).or_default() += 1;
        if let Some(open) = self
            .runs
            .iter_mut()
            .rev()
            .find(|r| r.bus_id == bus_id)
            .filter(|r| ts_ns.saturating_sub(r.last_ts_ns) <= COALESCE_GAP_NS)
        {
            open.count += 1;
            open.last_ts_ns = open.last_ts_ns.max(ts_ns);
            return;
        }
        if self.runs.len() >= MAX_RUNS {
            self.runs.remove(0);
        }
        self.runs.push(ErrorRun {
            bus_id: bus_id.to_string(),
            first_ts_ns: ts_ns,
            last_ts_ns: ts_ns,
            count: 1,
        });
    }

    pub(crate) fn runs(&self) -> &[ErrorRun] {
        &self.runs
    }

    /// Every error seen on `bus_id` this session, eviction-proof.
    #[allow(dead_code)] // the health panel's emitter is its first caller.
    pub(crate) fn total(&self, bus_id: &str) -> u64 {
        self.totals.get(bus_id).copied().unwrap_or(0)
    }

    /// The most recent run on `bus_id`, which is where the panel reads
    /// its error rate and its "last error" instant.
    #[allow(dead_code)] // the health panel's emitter is its first caller.
    pub(crate) fn latest(&self, bus_id: &str) -> Option<&ErrorRun> {
        self.runs.iter().rev().find(|r| r.bus_id == bus_id)
    }

    #[allow(dead_code)] // read by tests; the panel reads `runs` directly.
    pub(crate) fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    pub(crate) fn clear(&mut self) {
        self.runs.clear();
        self.totals.clear();
    }
}

/// Render the coalesced runs as the host-derived timeline events every
/// view reads (ADR 0035).
///
/// The event sits at the run's **first** error, which is the instant a
/// reader navigating to it wants: the onset of the fault, not its tail.
/// The bus rides the `tag`, the axis the event view already filters on,
/// because the host holds bus *ids* and the project's bus **names** are
/// the frontend's — so this is where the summary can honestly name the
/// bus, and the health panel is where the name appears.
pub(crate) fn runs_as_events(runs: &[ErrorRun]) -> Vec<Note> {
    runs.iter()
        .map(|run| Note {
            // Stable across republications so a view's row keys and any
            // open disclosure survive the count ticking up.
            id: format!("bus-error:{}:{}", run.bus_id, run.first_ts_ns),
            timestamp_ns: run.first_ts_ns,
            label: label_for(run),
            kind: EventKind::BusError,
            color: None,
            description: Some(description_for(run)),
            tag: Some(run.bus_id.clone()),
            commented_event_type: None,
        })
        .collect()
}

fn label_for(run: &ErrorRun) -> String {
    if run.count == 1 {
        return "1 bus error".to_string();
    }
    format!("{} bus errors over {:.1} s", run.count, run.span_secs())
}

fn description_for(run: &ErrorRun) -> String {
    format!(
        "bus {bus}\n{count} error frames, {rate:.0}/s over {span:.3} s\nthe frames themselves are in the capture and are what a save writes",
        bus = run.bus_id,
        count = run.count,
        rate = run.rate(),
        span = run.span_secs(),
    )
}

/// One interface's controller state as the driver last reported it —
/// ISO 11898-1 fault confinement plus the two error counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControllerHealth {
    /// `"active"`, `"passive"` or `"busOff"`. A driver that reports a
    /// state we do not recognise contributes nothing rather than a
    /// guess, so there is no "unknown" variant to render.
    pub(crate) state: &'static str,
    pub(crate) tec: u32,
    pub(crate) rec: u32,
}

/// What one bus's row in the health panel is built from. Only buses the
/// host has something to say about appear; the frontend walks the
/// project's buses and renders an em dash for the rest, because "no
/// traffic" and "we cannot know" are different answers.
#[allow(dead_code)] // built by the health panel's emitter.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BusHealthRecord {
    /// Controller state and counters, or `None` for a bus whose driver
    /// never reported one (an in-process virtual bus has no controller
    /// at all).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) controller: Option<ControllerHealth>,
    /// Percentage of the wire in use, or `None` where the bitrate is
    /// not known — never estimated from an unknown one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) load_percent: Option<f64>,
    /// Every error frame seen on this bus this session.
    pub(crate) error_count: u64,
    /// Errors per second over the most recent run's own span.
    pub(crate) error_rate: f64,
    /// Frame-time instant of the most recent error, or `None` for a bus
    /// that has seen none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_error_ts_ns: Option<u64>,
}

/// Bus load as a percentage of the wire, or `None` where it cannot be
/// known.
///
/// `arbitration_bps` is what the host actually put on the wire for this
/// bus (`AppliedBusConfig::speed_bps`); `None` there means no
/// `ConfigureBus` was sent and the controller is on a driver default the
/// host cannot see, so there is no denominator and the answer is
/// "we cannot know" rather than a number. A virtual bus has no
/// configurable bitrate at all and lands in the same arm.
///
/// A bus-off controller returns `Some(0.0)`: the denominator is known
/// and nothing is on the wire, which is the true reading, and "no
/// traffic" and "we cannot know" must not render alike.
#[allow(dead_code)] // called by the health panel's emitter.
pub(crate) fn load_percent(
    arbitration_bits_per_second: f64,
    data_bits_per_second: f64,
    arbitration_bps: Option<u64>,
    data_bps: Option<u64>,
) -> Option<f64> {
    let nominal = arbitration_bps.filter(|b| *b > 0)?;
    #[allow(clippy::cast_precision_loss)]
    let mut fraction = arbitration_bits_per_second / nominal as f64;
    if data_bits_per_second > 0.0 {
        // A data phase only runs at its own rate when one was sent; with
        // no FD data rate the whole frame ran at the nominal one.
        #[allow(clippy::cast_precision_loss)]
        let data_rate = data_bps.filter(|b| *b > 0).unwrap_or(nominal) as f64;
        fraction += data_bits_per_second / data_rate;
    }
    Some((fraction * 100.0).clamp(0.0, 100.0))
}

/// Session-scoped bus-health state, managed by Tauri alongside the
/// connection-state map. Separate from `AppState` for the same reason
/// `ConnectionStates` is: it is the session's low-level status, not part
/// of the trace model.
#[derive(Default)]
pub struct BusHealth {
    errors: Mutex<ErrorRuns>,
    /// Controller state keyed by **wire interface id**, which is what
    /// `InterfaceState` names. The bus it belongs to is resolved through
    /// the session's channel maps at read time, so a rebinding cannot
    /// leave a stale bus attribution behind.
    controllers: Mutex<BTreeMap<String, ControllerHealth>>,
}

impl BusHealth {
    /// Fold one error frame into the coalescer.
    pub(crate) fn observe_error(&self, bus_id: &str, ts_ns: u64) {
        self.errors().observe(bus_id, ts_ns);
    }

    pub(crate) fn errors(&self) -> std::sync::MutexGuard<'_, ErrorRuns> {
        self.errors
            .lock()
            .expect("bus health errors mutex poisoned")
    }

    /// Record what a driver reported for one interface. Returns whether
    /// anything moved, so a caller can skip a no-op republish.
    #[allow(dead_code)] // the session's `InterfaceState` reader is its caller.
    pub(crate) fn set_controller(&self, interface_id: &str, health: ControllerHealth) -> bool {
        let mut guard = self.controllers();
        if guard.get(interface_id) == Some(&health) {
            return false;
        }
        guard.insert(interface_id.to_string(), health);
        true
    }

    #[allow(dead_code)] // the health panel's emitter is its first caller.
    pub(crate) fn controller(&self, interface_id: &str) -> Option<ControllerHealth> {
        self.controllers().get(interface_id).copied()
    }

    fn controllers(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, ControllerHealth>> {
        self.controllers
            .lock()
            .expect("bus health controllers mutex poisoned")
    }

    /// Drop everything — a capture clear or an Open Capture starts a new
    /// session, and a summary of the previous one has nothing to
    /// summarise any more.
    pub(crate) fn clear(&self) {
        self.errors().clear();
        self.controllers().clear();
    }
}

/// Republish the coalesced bus-error summaries on [`BUS_HEALTH_POLL`],
/// and only when the set has actually moved.
///
/// A poll rather than a callback for the same reason the clock status is
/// one: the producer is the ingest path, which runs at bus rate on a
/// worker thread and must not be the thing that decides when a `WebView`
/// repaints. The events go in through [`crate::notes::NotesStore::replace_derived`],
/// so they reach every view on the one delivery path the timeline-event
/// model already has (ADR 0035) — and stay out of the durable store and
/// out of a saved capture, which is what keeps the file lossless.
pub(crate) fn spawn_bus_health_emitter(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(BUS_HEALTH_POLL);
        let mut published: Vec<Note> = Vec::new();
        loop {
            interval.tick().await;
            let Some(health) = app.try_state::<BusHealth>() else {
                continue;
            };
            let events = runs_as_events(health.errors().runs());
            if events == published {
                continue;
            }
            published.clone_from(&events);
            let state: State<'_, AppState> = app.state();
            let applied = state.notes.replace_derived(events);
            let _ = app.emit("notes-changed", applied.notes);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frame time in ns, for readability.
    fn ms(n: u64) -> u64 {
        n * 1_000_000
    }

    #[test]
    fn a_storm_at_bus_frame_rate_becomes_one_summary() {
        // 10 000 errors, 100 µs apart — the retransmit cadence of a
        // persistent fault at 500 kbit/s. One episode, one event.
        let mut runs = ErrorRuns::default();
        for i in 0..10_000u64 {
            runs.observe("b1", i * 100_000);
        }
        assert_eq!(runs.runs().len(), 1, "one episode is one run");
        let run = &runs.runs()[0];
        assert_eq!(run.count, 10_000);
        assert_eq!(run.first_ts_ns, 0);
        assert_eq!(run.last_ts_ns, 9_999 * 100_000);
        assert_eq!(runs_as_events(runs.runs()).len(), 1);
    }

    #[test]
    fn a_quiet_gap_starts_a_new_episode() {
        // The control for the test above: without it, "one run" would
        // also pass on a coalescer that merged everything forever.
        let mut runs = ErrorRuns::default();
        runs.observe("b1", ms(0));
        runs.observe("b1", ms(10));
        runs.observe("b1", ms(10) + COALESCE_GAP_NS + 1);
        assert_eq!(runs.runs().len(), 2);
        assert_eq!(runs.runs()[0].count, 2);
        assert_eq!(runs.runs()[1].count, 1);
    }

    #[test]
    fn two_buses_faulting_at_once_are_two_summaries() {
        let mut runs = ErrorRuns::default();
        for i in 0..100u64 {
            runs.observe("b1", i * 100_000);
            runs.observe("b2", i * 100_000);
        }
        assert_eq!(runs.runs().len(), 2);
        assert_eq!(runs.total("b1"), 100);
        assert_eq!(runs.total("b2"), 100);
        let events = runs_as_events(runs.runs());
        assert_eq!(
            events
                .iter()
                .filter_map(|e| e.tag.as_deref())
                .collect::<Vec<_>>(),
            vec!["b1", "b2"],
            "the bus rides the tag, which is the axis the event view filters on",
        );
    }

    #[test]
    fn the_run_set_is_bounded_but_the_count_is_not() {
        // Alternating fault-and-quiet is the shape that would otherwise
        // grow the event set without limit.
        let mut runs = ErrorRuns::default();
        for i in 0..(MAX_RUNS as u64 + 50) {
            runs.observe("b1", i * (COALESCE_GAP_NS + 1));
        }
        assert_eq!(runs.runs().len(), MAX_RUNS, "the event set is capped");
        assert_eq!(
            runs.total("b1"),
            MAX_RUNS as u64 + 50,
            "but an evicted summary does not take its errors off the count",
        );
    }

    #[test]
    fn every_coalesced_event_is_host_derived_and_so_never_exported() {
        // The write-side contract, read off the producer rather than
        // asserted about a hand-built note.
        let mut runs = ErrorRuns::default();
        runs.observe("b1", 0);
        for event in runs_as_events(runs.runs()) {
            assert_eq!(event.kind, EventKind::BusError);
            assert!(!event.kind.persisted(), "not in the durable store");
            assert!(!event.kind.exported(), "not written to a saved capture");
        }
    }

    #[test]
    fn an_event_keeps_its_identity_as_its_run_grows() {
        // The republication cadence must not make a live fault's row
        // flicker: the id is the run's onset, which does not move.
        let mut runs = ErrorRuns::default();
        runs.observe("b1", ms(1));
        let first = runs_as_events(runs.runs())[0].id.clone();
        runs.observe("b1", ms(2));
        let second = runs_as_events(runs.runs());
        assert_eq!(second[0].id, first);
        assert_eq!(
            second[0].timestamp_ns,
            ms(1),
            "the marker sits at the onset"
        );
        assert!(second[0].label.starts_with("2 bus errors"));
    }

    #[test]
    #[allow(clippy::float_cmp)] // 0.0 is the exact "no rate yet" sentinel.
    fn a_lone_error_reads_as_one_error_and_claims_no_rate() {
        let mut runs = ErrorRuns::default();
        runs.observe("b1", ms(5));
        assert_eq!(runs_as_events(runs.runs())[0].label, "1 bus error");
        assert_eq!(runs.latest("b1").unwrap().rate(), 0.0);
    }

    #[test]
    fn load_is_absent_without_a_bitrate_and_zero_on_a_silent_configured_bus() {
        // The distinction the panel exists to draw: a bus-off controller
        // reads 0 %, an unconfigurable one reads nothing at all.
        assert_eq!(load_percent(0.0, 0.0, None, None), None);
        assert_eq!(load_percent(0.0, 0.0, Some(0), None), None);
        assert_eq!(load_percent(0.0, 0.0, Some(500_000), None), Some(0.0));
    }

    #[test]
    fn load_is_the_bits_on_the_wire_over_the_bitrate() {
        let pct = load_percent(170_000.0, 0.0, Some(500_000), None).unwrap();
        assert!((pct - 34.0).abs() < 1e-9, "got {pct}");
    }

    #[test]
    fn an_fd_data_phase_is_charged_at_its_own_rate() {
        // Half the arbitration wire at 500k plus a data phase that is a
        // tenth of a 2M wire.
        let pct = load_percent(250_000.0, 200_000.0, Some(500_000), Some(2_000_000)).unwrap();
        assert!((pct - 60.0).abs() < 1e-9, "got {pct}");
        // With no data rate sent, the data phase ran at the nominal rate.
        let pct = load_percent(250_000.0, 200_000.0, Some(500_000), None).unwrap();
        assert!((pct - 90.0).abs() < 1e-9, "got {pct}");
    }

    #[test]
    fn a_controller_report_that_repeats_itself_is_not_a_change() {
        let health = BusHealth::default();
        let h = ControllerHealth {
            state: "passive",
            tec: 142,
            rec: 9,
        };
        assert!(health.set_controller("PCAN_USBBUS1", h));
        assert!(!health.set_controller("PCAN_USBBUS1", h));
        assert!(health.set_controller("PCAN_USBBUS1", ControllerHealth { tec: 143, ..h }));
        assert_eq!(health.controller("PCAN_USBBUS1").unwrap().tec, 143);
        assert_eq!(health.controller("PCAN_USBBUS2"), None);
    }

    #[test]
    fn a_cleared_session_forgets_its_errors_and_its_controllers() {
        let health = BusHealth::default();
        health.observe_error("b1", 0);
        health.set_controller(
            "i1",
            ControllerHealth {
                state: "busOff",
                tec: 256,
                rec: 0,
            },
        );
        health.clear();
        assert!(health.errors().is_empty());
        assert_eq!(health.errors().total("b1"), 0);
        assert_eq!(health.controller("i1"), None);
    }
}
