//! Bus health — the low-level state of each logical bus, which the app
//! surfaced nowhere before.
//!
//! Everything here is host-side because it is computation over what the
//! peer reports and over the session's own state:
//!
//! - **Bus-error episodes.** The sidecar counts a bus's error frames into
//!   episodes and reports each one on the session's control lane (ADR
//!   0060 rule 1); only the first few error frames of an episode are
//!   rows. [`ingest_peer_reports`] reads the session's latest episode
//!   reports on a 250 ms poll and folds them into the bus's
//!   [`BusErrorReports`] — the total, the newest episode, its counts by
//!   kind and its counters, which the panel shows — and into the bus's
//!   error series in the signal cache, which the timeline's bus-error
//!   events are read from (ADR 0035,
//!   [`crate::signal_cache::SignalCacheStore::bus_error_windows`]). An
//!   imported capture feeds the same store through the import builder
//!   (`crate::session::run_pump`).
//! - **Controller state.** `InterfaceState` — the ISO 11898-1
//!   fault-confinement state, the transmit and receive error counters,
//!   and the driver's count of receive overruns — arrives on the
//!   session stream and is cached per interface. The overrun count is
//!   not a fault-confinement reading; it is the one number that says
//!   whether the capture is the whole of what the bus sent, and it is
//!   optional because a backend that does not watch for receive loss
//!   must not be read as one that watched and saw none. The peer
//!   republishes the reading every second with the instant it was taken
//!   (ADR 0060 rule 5), so a reading that has stopped arriving reads as
//!   **stale** rather than as unchanged ([`STALE_AFTER_NS`]); a
//!   republish that moves nothing but that instant is not a change, and
//!   does not repaint anything.
//!   One reported state is not a fault-confinement state:
//!   `unavailable`, which says the peer's driver can no longer reach
//!   the interface. It is also the one that takes the bus's transmit
//!   route down (ADR 0039's park), because a route that survives the
//!   adapter fills the trace with frames no wire carried.
//! - **Bus load.** Computed where the bitrate is known and reported as
//!   absent where it is not; see [`load_percent`].
//! - **Refused sends.** What the peer refused to put on the wire, per bus
//!   and per reason — counts, the first and last refusal, the driver's
//!   last words, and how often a stuck transmit queue was flushed (ADR
//!   0060 rules 4 and 7). A peer that predates those summaries still
//!   refuses with one per-frame `TX_REJECTED` each, which name no
//!   interface; those are tallied per session and shown on every bus of
//!   it, marked as such. Both are also reported to the System Messages
//!   as one line per session per second ([`rejection_reports`]) — a
//!   peer refusing at bus rate refuses thousands a second, and a message
//!   each would be the flood rather than the report of it.
//! - **Missed periods.** The periodic scheduler's count, per bus, of the
//!   periods it did not offer — those that found no room in the
//!   session's request channel and those a late tick skipped (ADR 0060
//!   rule 6, ADR 0039 rule 2) — shown beside the refusals.
//! - **Dropped-frames gaps.** The spans the peer's data lane dropped
//!   rather than deliver late (ADR 0060 rule 3) become durable events in
//!   the notes store ([`dropped_frames_note`]).
//!
//! The frontend joins these rows against the project's buses, which it
//! owns: a bus the host has nothing to say about is absent from the map
//! and reads as an em dash rather than as a zero.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;

use cannet_client::episodes::BusErrorEpisode;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::bus_error_episodes::{BusErrorReports, ReportedEpisode};
use crate::connection_state::AppliedBusConfig;
use crate::ipc::ErrorKindCount;
use crate::notes::{EventKind, Note};
use crate::signal_cache::SignalCacheStore;

/// How often the host reads what the peers reported and republishes the
/// health rows. The sidecar republishes an open episode and the
/// controller state every 250 ms (ADR 0060 rule 5); polling at the same
/// cadence keeps a fault on screen within about a second of the wire.
/// The rows are only emitted when they have moved.
const FAULT_POLL: Duration = Duration::from_millis(250);

/// How many [`FAULT_POLL`]s between two refusal reports to the System
/// Messages — once a second, the readout's cadence rather than the bus's.
const REFUSAL_REPORT_EVERY: u32 = 4;

/// A controller reading older than this has stopped arriving: the peer
/// republishes it every second (ADR 0060 rule 5), so three missed
/// heartbeats is a reading nobody is refreshing.
pub(crate) const STALE_AFTER_NS: u64 = 3_000_000_000;

/// A peer timestamp on this host's clock: the session's applied clock
/// offset taken off, exactly as the client corrects a frame's timestamp
/// (ADR 0046), so a report and the frames it describes share one
/// timeline.
pub(crate) fn to_host_ns(peer_ns: u64, applied_offset_ns: i64) -> u64 {
    u64::try_from(
        (i128::from(peer_ns) - i128::from(applied_offset_ns)).clamp(0, i128::from(u64::MAX)),
    )
    .unwrap_or(u64::MAX)
}

/// One kind of refusal, counted for the System Messages report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RefusalCount {
    /// The reason, worded for a reader.
    pub(crate) what: &'static str,
    pub(crate) count: u64,
    pub(crate) last_message: String,
}

/// One coalesced report of what a peer refused since the last report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RejectionReport {
    /// The session's address, so a reader knows which peer refused.
    pub(crate) address: String,
    /// How many arrived since the previous report.
    pub(crate) since_last: u64,
    /// How many this session has seen in total.
    pub(crate) total: u64,
    /// The reasons and the newest message each carried, already worded.
    pub(crate) detail: String,
}

impl RejectionReport {
    /// The system message this report reads as.
    pub(crate) fn message(&self) -> String {
        format!(
            "{address}: {detail} — {since_last} since the last report, {total} this session",
            address = self.address,
            detail = self.detail,
            since_last = self.since_last,
            total = self.total,
        )
    }
}

/// Coalesce each session's refusal counts into at most one report, and
/// remember what has been reported.
///
/// `reported` is the caller's running record of each session's last
/// reported total; it is updated in place, and sessions that have gone
/// are forgotten so it stays bounded by the number of open sessions
/// rather than by how many have ever been opened. A session whose total
/// has not moved produces nothing — silence means the peer is carrying
/// what it is given, which is the case that must not generate traffic.
pub(crate) fn rejection_reports(
    current: &BTreeMap<String, Vec<RefusalCount>>,
    reported: &mut BTreeMap<String, u64>,
) -> Vec<RejectionReport> {
    reported.retain(|address, _| current.contains_key(address));
    let mut out = Vec::new();
    for (address, tallies) in current {
        let total: u64 = tallies.iter().map(|t| t.count).sum();
        let last = reported.get(address).copied().unwrap_or(0);
        // A reconnect restarts the peer's count, so a total that fell
        // is a new session on the same address and the whole of it is
        // new — not a negative delta, and not something to sit on until
        // the fresh session passes the old one's tally.
        let since_last = if total < last { total } else { total - last };
        reported.insert(address.clone(), total);
        if since_last == 0 {
            continue;
        }
        out.push(RejectionReport {
            address: address.clone(),
            since_last,
            total,
            detail: describe_tallies(tallies),
        });
    }
    out
}

/// The reasons a session reported, worded for a reader: each named as it
/// means rather than as the proto spells it, with its count and the
/// newest message the peer sent with it.
fn describe_tallies(tallies: &[RefusalCount]) -> String {
    tallies
        .iter()
        .map(|t| {
            if t.last_message.is_empty() {
                format!("{} ×{}", t.what, t.count)
            } else {
                format!("{} ×{} ({})", t.what, t.count, t.last_message)
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// One interface's controller state as the driver last reported it —
/// ISO 11898-1 fault confinement plus the two error counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControllerHealth {
    /// `"active"`, `"warning"`, `"passive"`, `"busOff"` — or
    /// `"unavailable"`, which is not a fault-confinement state at all
    /// but the driver reporting it can no longer reach the interface.
    /// `"warning"` is not one of ISO 11898-1's three states either: it
    /// is the warning limit the standard defines on the way to
    /// error-passive, and it is the first reading that separates a bus
    /// in trouble from a quiet one. A driver that reports a state we do
    /// not recognise contributes nothing rather than a guess, so there
    /// is no "unknown" variant to render.
    pub(crate) state: &'static str,
    pub(crate) tec: u32,
    pub(crate) rec: u32,
    /// Receive overruns the peer's driver has reported since it opened
    /// the interface — occasions on which frames reached the controller
    /// and did not reach the peer, and therefore did not reach this
    /// capture. `None` for a driver that reports no such thing, which
    /// is emphatically not zero: zero is the reading that licenses
    /// treating the capture as complete, and absent is nobody having
    /// looked. Counts **reports, not lost frames** — no vendor says how
    /// many an overrun swallowed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rx_overruns: Option<u64>,
    /// When the peer took this reading, on this host's clock (ADR 0060
    /// rule 5). `None` for a peer that does not stamp its readings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) as_of_ns: Option<u64>,
    /// The reading is older than [`STALE_AFTER_NS`]: the peer has stopped
    /// refreshing it, so it says what the controller *was*. Never set for
    /// a reading with no `as_of_ns`.
    pub(crate) stale: bool,
}

/// A bus's newest bus-error episode, as the health row shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrorEpisodeHealth {
    /// No closing report has arrived for it: the fault is on now.
    pub(crate) ongoing: bool,
    pub(crate) first_ts_ns: u64,
    pub(crate) last_ts_ns: u64,
    pub(crate) count: u64,
    /// The kinds it counted, largest first (`crate::ipc::kind_counts`);
    /// `ack` names a pulled cable.
    pub(crate) count_by_kind: Vec<ErrorKindCount>,
    /// Errors seen while transmitting / while receiving, where the
    /// vendor says.
    pub(crate) tx_count: u64,
    pub(crate) rx_count: u64,
    /// The error counters as of its latest error.
    pub(crate) tec: u32,
    pub(crate) rec: u32,
}

impl From<&ReportedEpisode> for ErrorEpisodeHealth {
    fn from(e: &ReportedEpisode) -> Self {
        Self {
            ongoing: e.open,
            first_ts_ns: e.first_ns,
            last_ts_ns: e.last_ns,
            count: e.count,
            count_by_kind: crate::ipc::kind_counts(&e.kinds),
            tx_count: e.tx_count,
            rx_count: e.rx_count,
            tec: e.tec,
            rec: e.rec,
        }
    }
}

/// One reason a bus's sends were refused, summed over the session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BusRefusal {
    /// `"queueFull"`, `"closed"`, `"listenOnly"`, `"incompatible"`,
    /// `"other"` (ADR 0060 rule 4) — or, from a peer that predates those
    /// summaries, `"txRejected"`, `"notSubscribed"`, `"noAcknowledger"`.
    pub(crate) reason: &'static str,
    /// The reason worded for a reader.
    pub(crate) reason_text: &'static str,
    pub(crate) count: u64,
    /// The first and latest refusal, on this host's clock. Absent for a
    /// per-frame refusal, which carries no time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) first_ns: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_ns: Option<u64>,
    /// The driver's own words for the latest refusal, where it gave any.
    pub(crate) last_message: String,
    /// Counted for the whole session rather than for this bus: a
    /// per-frame refusal names no interface, so it is shown on every bus
    /// the session carries.
    pub(crate) session_wide: bool,
}

/// The periods the periodic scheduler did not offer on a bus (ADR 0060
/// rule 6).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MissedPeriods {
    /// No room in the session's request channel: the period was not
    /// prepared and its counters were not stepped.
    pub(crate) no_room: u64,
    /// A tick ran late past one or more whole periods, which are dropped
    /// rather than burst (ADR 0039 rule 2).
    pub(crate) late: u64,
}

/// Which way a period was missed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MissedPeriod {
    NoRoom,
    Late,
}

/// What one bus's row in the health panel is built from. Only buses the
/// host has something to say about appear; the frontend walks the
/// project's buses and renders an em dash for the rest, because "no
/// traffic" and "we cannot know" are different answers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BusHealthRecord {
    /// Controller state and counters, or `None` for a bus whose driver
    /// never reported one (an in-process virtual bus has no controller
    /// at all).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) controller: Option<ControllerHealth>,
    /// Percentage of the wire in use, or `None` where the bitrate is
    /// not known — never estimated from an unknown one. Error frames are
    /// not in it (ADR 0060 rule 2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) load_percent: Option<f64>,
    /// Every error frame the bus's episodes have counted this session.
    pub(crate) error_count: u64,
    /// Errors per second over the newest episode's own span.
    pub(crate) error_rate: f64,
    /// Frame-time instant of the most recent error, or `None` for a bus
    /// that has seen none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_error_ts_ns: Option<u64>,
    /// The newest bus-error episode, ongoing or not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_episode: Option<ErrorEpisodeHealth>,
    /// What the peer refused to send on this bus, one entry per reason.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) refusals: Vec<BusRefusal>,
    /// Transmit-queue flushes the peer reported for this bus (ADR 0060
    /// rule 7), and when the latest was, on this host's clock.
    pub(crate) flush_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_flush_ns: Option<u64>,
    /// Periods the scheduler did not offer on this bus.
    pub(crate) missed_periods: MissedPeriods,
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
///
/// The **controller** and **refusal** sides of bus health are
/// deliberately not held here: they live on the session that reported
/// them (`RemoteSession`), so a disconnect takes them with the session
/// rather than leaving a stale reading behind that looks like a live one.
#[derive(Default)]
pub struct BusHealth {
    reports: Mutex<BusErrorReports>,
    missed: Mutex<BTreeMap<String, MissedPeriods>>,
}

impl BusHealth {
    pub(crate) fn reports(&self) -> std::sync::MutexGuard<'_, BusErrorReports> {
        self.reports
            .lock()
            .expect("bus health reports mutex poisoned")
    }

    /// Count `n` periods the scheduler did not offer on `bus_id`.
    pub(crate) fn record_missed(&self, bus_id: &str, kind: MissedPeriod, n: u64) {
        if n == 0 {
            return;
        }
        let mut missed = self.missed.lock().expect("missed periods mutex poisoned");
        let entry = missed.entry(bus_id.to_string()).or_default();
        match kind {
            MissedPeriod::NoRoom => entry.no_room += n,
            MissedPeriod::Late => entry.late += n,
        }
    }

    /// Every bus's missed periods so far.
    pub(crate) fn missed(&self) -> BTreeMap<String, MissedPeriods> {
        self.missed
            .lock()
            .expect("missed periods mutex poisoned")
            .clone()
    }

    /// Drop everything — a capture clear or an Open Capture starts a new
    /// session, and a tally of the previous one has nothing to count any
    /// more.
    pub(crate) fn clear(&self) {
        self.reports().clear();
        self.missed
            .lock()
            .expect("missed periods mutex poisoned")
            .clear();
    }
}

/// Fold one bus-error episode report into `bus`'s record and its error
/// series — the one path the live poll and the import builder share
/// (ADR 0060). A bus the reports have not seen yet starts from the total
/// its series already holds, so a capture restored with its series
/// counts on rather than stepping back.
pub(crate) fn record_episode(
    state: &AppState,
    health: &BusHealth,
    bus: &str,
    source: &str,
    report: &BusErrorEpisode,
) {
    fold_episode(&state.signal_caches, health, bus, source, report);
}

/// [`record_episode`] against `caches`: the report's points go onto the
/// bus's error series and the episode it updated is kept beside the
/// series, so both persist together (ADR 0047).
fn fold_episode(
    caches: &SignalCacheStore,
    health: &BusHealth,
    bus: &str,
    source: &str,
    report: &BusErrorEpisode,
) {
    let mut reports = health.reports();
    reports.seed(bus, || caches.bus_error_total(bus));
    let points = reports.apply(bus, source, report);
    let latest = reports.latest(bus).cloned();
    drop(reports);
    caches.record_bus_errors(bus, &points);
    if let Some(episode) = latest {
        caches.record_bus_error_episode(bus, &episode);
    }
}

/// Start the report store from the error series a scratch restore just
/// brought back: each bus's total, and the reported episodes persisted
/// beside its series, so a restored capture's episodes carry the kinds,
/// directions and counters they showed live (ADR 0060 rule 2). A series
/// from a scratch written before those were kept restores its total
/// alone, and its episodes have no detail.
pub(crate) fn restore_reports(caches: &SignalCacheStore, health: &BusHealth) {
    let restored = caches.bus_error_reports();
    let mut reports = health.reports();
    for (bus, total, episodes) in restored {
        reports.restore(&bus, total, episodes);
    }
}

/// The report-store source a live session's interface reports under:
/// the session's own number as well as its address, since an episode's
/// seq means something only within the session that reported it.
/// Prefixed so a source that has gone can be told from an import's.
pub(crate) fn live_source(session_id: u64, address: &str, interface_id: &str) -> String {
    format!("{LIVE_SOURCE_PREFIX}{session_id}:{address}#{interface_id}")
}

const LIVE_SOURCE_PREFIX: &str = "live:";

/// The poll's memory of what it has folded in, per live source: the
/// newest episode it applied, by seq and count — so an unchanged
/// snapshot costs nothing.
pub(crate) type AppliedEpisodes = BTreeMap<String, (u64, u64, u64, bool)>;

/// The one durable event a dropped-frames span becomes (ADR 0060 rule 3):
/// a `droppedFrames` event at the span's first frame on `bus`, saying how
/// many frames and over what span. Its id is stable in the bus and the
/// span's start, so the same span is never recorded twice.
pub(crate) fn dropped_frames_note(bus: &str, count: u64, first_ns: u64, last_ns: u64) -> Note {
    #[allow(clippy::cast_precision_loss)]
    let span_s = last_ns.saturating_sub(first_ns) as f64 / 1e9;
    Note {
        id: format!("dropped-frames:{bus}:{first_ns}"),
        timestamp_ns: first_ns,
        label: format!("{count} frames dropped on {bus}"),
        kind: EventKind::DroppedFrames,
        color: None,
        description: Some(format!(
            "The server dropped {count} frames on {bus} over {span_s:.3} s rather than \
             deliver them late: this capture holds none of them."
        )),
        tag: None,
        commented_event_type: None,
        subjects: Vec::new(),
        unknown_block_lines: Vec::new(),
    }
}

/// Read every open session's peer reports once: fold new bus-error
/// episode reports into `health` and the error series, and drain new
/// dropped-frame spans into durable events. Returns the events added,
/// so the caller can announce them.
///
/// Interface → bus by the session's own mapping, read now, as every
/// other bus-health reading is. A session that has gone closes whatever
/// episode it still held open.
pub(crate) fn ingest_peer_reports(
    state: &AppState,
    health: &BusHealth,
    applied: &mut AppliedEpisodes,
) -> Vec<Note> {
    let mut episodes: Vec<(String, String, BusErrorEpisode)> = Vec::new();
    let mut gaps: Vec<Note> = Vec::new();
    let mut live: Vec<String> = Vec::new();
    {
        let sessions = state.remote_sessions();
        for (address, session) in sessions.iter() {
            let Some(peer) = session.peer.as_ref() else {
                continue;
            };
            let offset = session
                .clock
                .as_ref()
                .map_or(0, cannet_client::clock::SessionClock::applied_offset_ns);
            let mut drained = peer.dropped_frames.drain();
            for (channel, bus) in &session.channel_to_bus {
                let Some((_, interface_id)) = session
                    .channel_to_interface
                    .iter()
                    .find(|(c, _)| c == channel)
                else {
                    continue;
                };
                let source = live_source(peer.session_id, address, interface_id);
                live.push(source.clone());
                if let Some(snapshot) = peer.episodes.get(interface_id) {
                    let mut reports: Vec<BusErrorEpisode> = snapshot.recent_closed;
                    reports.extend(snapshot.open);
                    reports.sort_by_key(|r| r.seq);
                    for mut report in fresh_reports(applied, &source, reports) {
                        report.first_ns = to_host_ns(report.first_ns, offset);
                        report.last_ns = to_host_ns(report.last_ns, offset);
                        episodes.push((bus.clone(), source.clone(), report));
                    }
                }
                for span in drained.remove(interface_id).unwrap_or_default() {
                    gaps.push(dropped_frames_note(
                        bus,
                        span.count,
                        to_host_ns(span.first_ns, offset),
                        to_host_ns(span.last_ns, offset),
                    ));
                }
            }
        }
    }
    applied.retain(|source, _| live.contains(source));
    for (bus, source, report) in &episodes {
        record_episode(state, health, bus, source, report);
    }
    {
        let mut reports = health.reports();
        for source in reports.open_sources() {
            if source.starts_with(LIVE_SOURCE_PREFIX) && !live.contains(&source) {
                reports.close_source(&source);
            }
        }
    }
    gaps.into_iter()
        .filter(|note| state.notes.add(note.clone()).is_some())
        .collect()
}

/// The reports in `snapshot` (ascending seq) that `source` has not yet
/// had folded in, updating `applied` to the newest.
fn fresh_reports(
    applied: &mut AppliedEpisodes,
    source: &str,
    snapshot: Vec<BusErrorEpisode>,
) -> Vec<BusErrorEpisode> {
    let Some(newest) = snapshot.last().copied() else {
        return Vec::new();
    };
    let held = applied.get(source).copied();
    let fresh: Vec<BusErrorEpisode> = snapshot
        .into_iter()
        .filter(|r| match held {
            Some((seq, count, last_ns, open)) => {
                r.seq > seq
                    || (r.seq == seq && (r.count, r.last_ns, r.open) != (count, last_ns, open))
            }
            None => true,
        })
        .collect();
    applied.insert(
        source.to_string(),
        (newest.seq, newest.count, newest.last_ns, newest.open),
    );
    fresh
}

/// What the open sessions say about each bus they carry: the
/// controllers' readings and what the peers refused.
#[derive(Debug, Default)]
pub(crate) struct SessionReadings {
    pub(crate) controllers: BTreeMap<String, ControllerHealth>,
    pub(crate) refusals: BTreeMap<String, Vec<BusRefusal>>,
    /// `(flushes, latest flush)` per bus.
    pub(crate) flushes: BTreeMap<String, (u64, Option<u64>)>,
}

/// The machine key and the words for a refusal reason.
fn refusal_reason(reason: cannet_client::rejections::TxRefusalReason) -> &'static str {
    use cannet_client::rejections::TxRefusalReason as R;
    match reason {
        R::QueueFull => "queueFull",
        R::Closed => "closed",
        R::ListenOnly => "listenOnly",
        R::Incompatible => "incompatible",
        R::Other => "other",
    }
}

/// The machine key for a per-frame code from a peer that predates the
/// refusal summaries.
fn per_frame_reason(code: cannet_client::rejections::PerFrameError) -> &'static str {
    use cannet_client::rejections::PerFrameError as E;
    match code {
        E::TxRejected => "txRejected",
        E::NotSubscribed => "notSubscribed",
        E::NoAcknowledger => "noAcknowledger",
    }
}

/// Read every open session's controller reports and refusal tallies,
/// attributed to the buses they carry, as of `now_ns` on this host's
/// clock.
///
/// The mapping is the session's own (`channel -> interface`, `channel ->
/// bus`), read at the moment the row is built rather than cached, so a
/// rebinding cannot leave a reading attributed to the bus it used to
/// serve. A session with no controller map at all — the in-process
/// virtual bus — contributes nothing, which is the honest answer for a
/// bus that has no controller.
pub(crate) fn session_readings(
    sessions: &std::collections::HashMap<String, crate::session::RemoteSession>,
    now_ns: u64,
) -> SessionReadings {
    let mut out = SessionReadings::default();
    for session in sessions.values() {
        let offset = session
            .clock
            .as_ref()
            .map_or(0, cannet_client::clock::SessionClock::applied_offset_ns);
        let tx_refusals = session
            .peer
            .as_ref()
            .map(|p| p.tx_refusals.snapshot())
            .unwrap_or_default();
        let per_frame = session
            .rejections
            .as_ref()
            .map(cannet_client::rejections::PerFrameErrors::snapshot)
            .unwrap_or_default();
        for (channel, bus_id) in &session.channel_to_bus {
            let Some((_, interface_id)) = session
                .channel_to_interface
                .iter()
                .find(|(c, _)| c == channel)
            else {
                continue;
            };
            if let Some(status) = session
                .controllers
                .as_ref()
                .and_then(|s| s.get(interface_id))
            {
                let as_of_ns = (status.as_of_ns > 0).then(|| to_host_ns(status.as_of_ns, offset));
                out.controllers.insert(
                    bus_id.clone(),
                    ControllerHealth {
                        state: status.state.as_str(),
                        tec: status.tec,
                        rec: status.rec,
                        rx_overruns: status.rx_overruns,
                        as_of_ns,
                        stale: as_of_ns.is_some_and(|t| now_ns.saturating_sub(t) > STALE_AFTER_NS),
                    },
                );
            }
            let mut refusals: Vec<BusRefusal> = Vec::new();
            let mut flushes = (0u64, None::<u64>);
            for t in tx_refusals
                .iter()
                .filter(|t| &t.interface_id == interface_id)
            {
                refusals.push(BusRefusal {
                    reason: refusal_reason(t.reason),
                    reason_text: t.reason.as_str(),
                    count: t.count,
                    first_ns: Some(to_host_ns(t.first_ns, offset)),
                    last_ns: Some(to_host_ns(t.last_ns, offset)),
                    last_message: t.last_message.clone(),
                    session_wide: false,
                });
                flushes.0 += t.flush_count;
                if t.flush_count > 0 {
                    let at = to_host_ns(t.last_flush_ns, offset);
                    flushes.1 = Some(flushes.1.map_or(at, |f| f.max(at)));
                }
            }
            for t in per_frame.iter().filter(|t| t.count > 0) {
                refusals.push(BusRefusal {
                    reason: per_frame_reason(t.code),
                    reason_text: t.code.as_str(),
                    count: t.count,
                    first_ns: None,
                    last_ns: None,
                    last_message: t.last_message.clone(),
                    session_wide: true,
                });
            }
            if !refusals.is_empty() {
                out.refusals.insert(bus_id.clone(), refusals);
            }
            if flushes.0 > 0 {
                out.flushes.insert(bus_id.clone(), flushes);
            }
        }
    }
    out
}

/// Everything [`health_rows`] builds the rows from, read at one instant.
pub(crate) struct HealthInputs<'a> {
    pub(crate) readings: &'a SessionReadings,
    pub(crate) applied: &'a BTreeMap<String, AppliedBusConfig>,
    /// `(bus, arbitration bits/s, data bits/s)`, error frames excluded.
    pub(crate) bits_by_bus: &'a [(String, f64, f64)],
    pub(crate) mapped_buses: &'a [String],
    pub(crate) reports: &'a BusErrorReports,
    pub(crate) missed: &'a BTreeMap<String, MissedPeriods>,
}

/// Build the per-bus rows the health panel renders, for every bus the
/// host has something to say about.
///
/// A bus is included when a session maps it, when it has reported an
/// error episode, when the host configured it, or when the scheduler
/// missed a period on it. Everything else is left out on purpose: the
/// frontend walks the project's own bus list and renders an em dash for
/// a bus with no row, which is what keeps "we cannot know" distinct from
/// a zero.
pub(crate) fn health_rows(inputs: &HealthInputs<'_>) -> BTreeMap<String, BusHealthRecord> {
    let mut buses: Vec<&str> = inputs.mapped_buses.iter().map(String::as_str).collect();
    buses.extend(inputs.reports.buses());
    buses.extend(inputs.applied.keys().map(String::as_str));
    buses.extend(inputs.missed.keys().map(String::as_str));
    buses.sort_unstable();
    buses.dedup();
    buses
        .into_iter()
        .map(|bus_id| {
            let latest = inputs.reports.latest(bus_id);
            // Absent bits are a genuine zero, not a missing reading: the
            // bus is configured, so the denominator is known and nothing
            // going over the wire *is* the answer. That is what makes a
            // bus-off row read 0 % where an unconfigurable one reads
            // nothing at all.
            let (arb_bits, data_bits) = inputs
                .bits_by_bus
                .iter()
                .find(|(b, _, _)| b == bus_id)
                .map_or((0.0, 0.0), |(_, a, d)| (*a, *d));
            let (flush_count, last_flush_ns) = inputs
                .readings
                .flushes
                .get(bus_id)
                .copied()
                .unwrap_or((0, None));
            (
                bus_id.to_string(),
                BusHealthRecord {
                    controller: inputs.readings.controllers.get(bus_id).copied(),
                    load_percent: inputs.applied.get(bus_id).and_then(|cfg| {
                        load_percent(arb_bits, data_bits, cfg.speed_bps, cfg.fd_data_speed_bps)
                    }),
                    error_count: inputs.reports.total(bus_id),
                    error_rate: latest.map_or(0.0, ReportedEpisode::rate),
                    last_error_ts_ns: latest.map(|e| e.last_ns),
                    error_episode: latest.map(ErrorEpisodeHealth::from),
                    refusals: inputs
                        .readings
                        .refusals
                        .get(bus_id)
                        .cloned()
                        .unwrap_or_default(),
                    flush_count,
                    last_flush_ns,
                    missed_periods: inputs.missed.get(bus_id).copied().unwrap_or_default(),
                },
            )
        })
        .collect()
}

/// Whether two sets of rows differ in anything but the instant their
/// controller readings were taken. The peer republishes an unchanged
/// reading every second (ADR 0060 rule 5); that heartbeat is what makes
/// staleness visible, and a reading going stale *is* a change, but a
/// fresh copy of the same reading is not one worth a repaint.
pub(crate) fn rows_changed(
    a: &BTreeMap<String, BusHealthRecord>,
    b: &BTreeMap<String, BusHealthRecord>,
) -> bool {
    let strip = |rows: &BTreeMap<String, BusHealthRecord>| {
        rows.iter()
            .map(|(bus, row)| {
                let mut row = row.clone();
                if let Some(c) = row.controller.as_mut() {
                    c.as_of_ns = None;
                }
                (bus.clone(), row)
            })
            .collect::<BTreeMap<_, _>>()
    };
    strip(a) != strip(b)
}

/// The status bar's one bus-load figure: the **worst** load across every
/// bus that reports one, or `None` while none does.
///
/// The worst rather than the mean, for the same reason the health
/// launcher tints on the worst state: a bar has room for one number, and
/// an average over four buses hides the one that is saturating, which is
/// the only one worth a glance. Which bus it is remains the panel's
/// answer to give.
pub(crate) fn worst_load_percent(rows: &BTreeMap<String, BusHealthRecord>) -> Option<f64> {
    rows.values()
        .filter_map(|r| r.load_percent)
        .fold(None, |worst: Option<f64>, load| {
            Some(worst.map_or(load, |w| w.max(load)))
        })
}

/// The status bar's bus-load figure, off a store snapshot the caller
/// has **already taken**.
///
/// The live-update emitter takes one `status_snapshot` per tick for
/// every other metric, and taking a second one here would both cost a
/// lock at 10 Hz and describe a different instant from the numbers
/// beside it.
pub(crate) fn worst_load_from(
    app: &AppHandle,
    state: &AppState,
    bits_by_bus: &[(String, f64, f64)],
) -> Option<f64> {
    let health = app.try_state::<BusHealth>()?;
    worst_load_percent(&collect_health_rows(app, state, &health, bits_by_bus))
}

/// What the host put on the wire for each bus it has connected — the
/// denominator of a bus-load figure, and the only place it can come
/// from: `ConfigureBus` is fire-and-forget, so the configuration the
/// host *sent* is the deepest truth available about a controller's
/// timing (see [`crate::connection_state`]).
fn applied_configs(
    states: &crate::connection_state::ConnectionStates,
) -> BTreeMap<String, AppliedBusConfig> {
    states
        .snapshot()
        .into_iter()
        .filter_map(|(bus_id, state)| match state {
            crate::connection_state::BusConnState::Connected { applied } => {
                Some((bus_id, applied?))
            }
            _ => None,
        })
        .collect()
}

/// Read the peers' reports on [`FAULT_POLL`], republish the bus-health
/// rows when they have moved, and report what peers refused once a
/// second.
///
/// A poll rather than a callback for the same reason the clock status is
/// one: the producer is the session worker, which runs at bus rate on a
/// thread of its own and must not be the thing that decides when a
/// `WebView` repaints.
pub(crate) fn spawn_bus_health_emitter(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(FAULT_POLL);
        let mut published_rows: BTreeMap<String, BusHealthRecord> = BTreeMap::new();
        let mut reported_rejections: BTreeMap<String, u64> = BTreeMap::new();
        let mut applied: AppliedEpisodes = BTreeMap::new();
        let mut polls: u32 = 0;
        loop {
            interval.tick().await;
            polls = polls.wrapping_add(1);
            let state: State<'_, AppState> = app.state();
            if polls.is_multiple_of(REFUSAL_REPORT_EVERY) {
                for report in
                    rejection_reports(&refusal_counts_by_session(&state), &mut reported_rejections)
                {
                    crate::sys_warn!(&app, "transmit", "{}", report.message());
                }
            }
            let Some(health) = app.try_state::<BusHealth>() else {
                continue;
            };
            let gaps = ingest_peer_reports(&state, &health, &mut applied);
            if !gaps.is_empty() {
                for gap in &gaps {
                    crate::sys_warn!(&app, "connection", "{}", gap.label);
                }
                let _ = app.emit("notes-changed", state.notes.events());
            }
            let bits = state.trace_store.status_snapshot().bits_per_second_by_bus;
            let rows = collect_health_rows(&app, &state, &health, &bits);
            if rows_changed(&rows, &published_rows) {
                let _ = app.emit(BUS_HEALTH_CHANGED_EVENT, &rows);
            }
            published_rows = rows;
        }
    });
}

/// Tauri event carrying the whole per-bus health map. Bounded by the
/// project's bus count, so there is no diff format — the same shape the
/// connection-state map uses.
pub(crate) const BUS_HEALTH_CHANGED_EVENT: &str = "bus-health-changed";

/// Initial read for a panel that just mounted; the event carries every
/// subsequent change (ADR 0016's pull-then-follow shape).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn get_bus_health(
    app: AppHandle,
    health: tauri::State<'_, BusHealth>,
    state: State<'_, AppState>,
) -> BTreeMap<String, BusHealthRecord> {
    let bits = state.trace_store.status_snapshot().bits_per_second_by_bus;
    collect_health_rows(&app, &state, &health, &bits)
}

/// One read of every open session's refusals, by address, for the System
/// Messages report: the per-frame codes of a peer that predates the
/// refusal summaries, and the summaries of one that sends them, summed
/// over the session's interfaces per reason. A session with no peer (the
/// in-process virtual bus) contributes nothing — there is nobody there to
/// refuse anything.
fn refusal_counts_by_session(state: &AppState) -> BTreeMap<String, Vec<RefusalCount>> {
    state
        .remote_sessions()
        .iter()
        .filter_map(|(address, session)| {
            let mut counts: Vec<RefusalCount> = session
                .rejections
                .as_ref()?
                .snapshot()
                .into_iter()
                .map(|t| RefusalCount {
                    what: t.code.as_str(),
                    count: t.count,
                    last_message: t.last_message,
                })
                .collect();
            if let Some(peer) = session.peer.as_ref() {
                let mut by_reason: BTreeMap<_, RefusalCount> = BTreeMap::new();
                for t in peer.tx_refusals.snapshot() {
                    let entry = by_reason.entry(t.reason).or_insert_with(|| RefusalCount {
                        what: t.reason.as_str(),
                        count: 0,
                        last_message: String::new(),
                    });
                    entry.count += t.count;
                    if !t.last_message.is_empty() {
                        entry.last_message = t.last_message;
                    }
                }
                counts.extend(by_reason.into_values());
            }
            Some((address.clone(), counts))
        })
        .collect()
}

/// Now, in ns since the Unix epoch — the clock a corrected peer reading
/// is compared against.
fn now_ns() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
}

/// Gather one instant's worth of every input the rows are built from —
/// the sessions' reports and bus mapping, the connection states' applied
/// bitrates, the store's per-bus bit rates, the episode reports and the
/// scheduler's missed periods.
fn collect_health_rows(
    app: &AppHandle,
    state: &AppState,
    health: &BusHealth,
    bits_by_bus: &[(String, f64, f64)],
) -> BTreeMap<String, BusHealthRecord> {
    let sessions = state.remote_sessions();
    let readings = session_readings(&sessions, now_ns());
    let mapped: Vec<String> = sessions
        .values()
        .flat_map(|s| s.channel_to_bus.iter().map(|(_, b)| b.clone()))
        .collect();
    drop(sessions);
    let applied = app
        .try_state::<crate::connection_state::ConnectionStates>()
        .map(|states| applied_configs(&states))
        .unwrap_or_default();
    let missed = health.missed();
    health_rows(&HealthInputs {
        readings: &readings,
        applied: &applied,
        bits_by_bus,
        mapped_buses: &mapped,
        reports: &health.reports(),
        missed: &missed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_client::episodes::ErrorKindCounts;

    const S: u64 = 1_000_000_000;

    fn count(what: &'static str, count: u64, last: &str) -> RefusalCount {
        RefusalCount {
            what,
            count,
            last_message: last.to_string(),
        }
    }

    fn episode(seq: u64, first_ns: u64, last_ns: u64, n: u64, open: bool) -> BusErrorEpisode {
        BusErrorEpisode {
            seq,
            first_ns,
            last_ns,
            count: n,
            count_by_kind: ErrorKindCounts {
                ack: n,
                ..ErrorKindCounts::default()
            },
            tx_count: n,
            rx_count: 0,
            tec: 128,
            rec: 0,
            open,
        }
    }

    fn rows(inputs: &HealthInputs<'_>) -> BTreeMap<String, BusHealthRecord> {
        health_rows(inputs)
    }

    fn empty_inputs<'a>(
        readings: &'a SessionReadings,
        reports: &'a BusErrorReports,
        missed: &'a BTreeMap<String, MissedPeriods>,
        applied: &'a BTreeMap<String, AppliedBusConfig>,
    ) -> HealthInputs<'a> {
        HealthInputs {
            readings,
            applied,
            bits_by_bus: &[],
            mapped_buses: &[],
            reports,
            missed,
        }
    }

    #[test]
    fn a_peer_refusing_at_bus_rate_reports_once_a_poll() {
        // The defect this pins: refusals were logged to `tracing` and
        // discarded, so a peer refusing every transmit told the user
        // nothing. It reaches them now — and as a count, because the
        // owner's bench regime produces thousands a second and a
        // message each would be the flood, not the report of it.
        let mut reported = BTreeMap::new();
        let mut current = BTreeMap::new();
        current.insert(
            "tcp://host:1".to_string(),
            vec![count("transmit rejected", 5_120, "bus is listen-only")],
        );
        let reports = rejection_reports(&current, &mut reported);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].since_last, 5_120);
        assert_eq!(reports[0].total, 5_120);
        let text = reports[0].message();
        assert!(text.contains("tcp://host:1"), "{text}");
        assert!(text.contains("transmit rejected"), "{text}");
        assert!(text.contains("bus is listen-only"), "{text}");

        // The next poll reports only what moved since.
        current.insert(
            "tcp://host:1".to_string(),
            vec![count("transmit rejected", 9_000, "bus is listen-only")],
        );
        let reports = rejection_reports(&current, &mut reported);
        assert_eq!(reports[0].since_last, 3_880);
        assert_eq!(reports[0].total, 9_000);
    }

    #[test]
    fn a_peer_carrying_what_it_is_given_says_nothing() {
        // The control. A session with no refusals, and one whose count
        // has not moved since the last poll, must both be silent — a
        // readout that repeated itself every second would be worse than
        // the discarded log line it replaces.
        let mut reported = BTreeMap::new();
        let mut current = BTreeMap::new();
        current.insert("tcp://host:1".to_string(), Vec::new());
        assert!(rejection_reports(&current, &mut reported).is_empty());
        current.insert("tcp://host:1".to_string(), vec![count("x", 3, "x")]);
        assert_eq!(rejection_reports(&current, &mut reported).len(), 1);
        assert!(
            rejection_reports(&current, &mut reported).is_empty(),
            "an unmoved count is not news",
        );
    }

    #[test]
    fn a_reconnect_on_the_same_address_is_not_a_negative_delta() {
        // A fresh session restarts the peer's count at zero. Reporting
        // the difference would underflow, and reporting nothing until
        // it passed the old total would hide the new session's first
        // few thousand refusals.
        let mut reported = BTreeMap::new();
        let mut current = BTreeMap::new();
        current.insert("tcp://host:1".to_string(), vec![count("x", 900, "x")]);
        rejection_reports(&current, &mut reported);
        current.insert("tcp://host:1".to_string(), vec![count("x", 4, "x")]);
        let reports = rejection_reports(&current, &mut reported);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].total, 4);
    }

    #[test]
    fn a_session_that_has_gone_is_forgotten() {
        // The record of what has been reported is keyed by address, so
        // it has to shrink with the session map rather than grow with
        // every connection the app has ever opened.
        let mut reported = BTreeMap::new();
        let mut current = BTreeMap::new();
        current.insert("tcp://a:1".to_string(), vec![count("x", 5, "x")]);
        current.insert("tcp://b:1".to_string(), vec![count("x", 5, "x")]);
        rejection_reports(&current, &mut reported);
        assert_eq!(reported.len(), 2);
        current.remove("tcp://b:1");
        rejection_reports(&current, &mut reported);
        assert_eq!(reported.len(), 1);
    }

    #[test]
    fn each_reason_keeps_its_own_words_in_the_report() {
        // The reasons mean different things, and a report that summed
        // them would name the wrong fault.
        let mut reported = BTreeMap::new();
        let mut current = BTreeMap::new();
        current.insert(
            "tcp://host:1".to_string(),
            vec![
                count("transmit queue full", 2, "QXMTFULL"),
                count("no listener on the bus", 7, "nobody on the bus"),
            ],
        );
        let text = rejection_reports(&current, &mut reported)[0].message();
        assert!(text.contains("transmit queue full ×2"), "{text}");
        assert!(text.contains("no listener on the bus ×7"), "{text}");
    }

    #[test]
    fn a_peer_timestamp_is_corrected_onto_this_hosts_clock() {
        assert_eq!(to_host_ns(10 * S, 2_000_000_000), 8 * S);
        assert_eq!(to_host_ns(10 * S, -1_000_000_000), 11 * S);
        assert_eq!(to_host_ns(1, i64::MAX), 0, "clamped, not wrapped");
    }

    #[test]
    #[allow(clippy::float_cmp)] // the rate is exact on these round numbers
    fn a_row_reads_the_newest_episode_and_the_running_total() {
        // ADR 0060: the panel's count is every error the episodes counted
        // — not the few rows the capture holds — and its rate and "last
        // error" read the newest episode.
        let mut reports = BusErrorReports::default();
        let _ = reports.apply("b1", "s", &episode(1, 10 * S, 11 * S, 10_000, false));
        let _ = reports.apply("b1", "s", &episode(2, 20 * S, 22 * S, 3_000, true));
        let readings = SessionReadings::default();
        let missed = BTreeMap::new();
        let applied = BTreeMap::new();
        let rows = rows(&empty_inputs(&readings, &reports, &missed, &applied));
        let row = &rows["b1"];
        assert_eq!(row.error_count, 13_000);
        assert_eq!(row.error_rate, 1_500.0);
        assert_eq!(row.last_error_ts_ns, Some(22 * S));
        let ep = row.error_episode.as_ref().unwrap();
        assert!(ep.ongoing);
        assert_eq!((ep.count, ep.tec), (3_000, 128));
        let json = serde_json::to_value(row).unwrap();
        assert_eq!(
            json["errorEpisode"]["countByKind"],
            serde_json::json!([{ "kind": "ack", "count": 3_000 }]),
            "only the kinds counted, largest first"
        );
        assert_eq!(json["errorEpisode"]["ongoing"], true);
        assert_eq!(json["missedPeriods"]["noRoom"], 0);
    }

    #[test]
    fn the_bar_shows_the_worst_load_and_nothing_at_all_when_no_bus_reports_one() {
        let row = |load: Option<f64>| BusHealthRecord {
            controller: None,
            load_percent: load,
            error_count: 0,
            error_rate: 0.0,
            last_error_ts_ns: None,
            error_episode: None,
            refusals: Vec::new(),
            flush_count: 0,
            last_flush_ns: None,
            missed_periods: MissedPeriods::default(),
        };
        assert_eq!(
            worst_load_percent(&BTreeMap::from([
                ("b1".to_string(), row(Some(12.0))),
                ("b2".to_string(), row(Some(71.0))),
                ("b3".to_string(), row(None)),
            ])),
            Some(71.0),
            "the saturating bus is the one worth the bar's single slot",
        );
        // The control: a bus with no knowable load must not read as 0 %
        // and drag the summary down, and a bar with nothing to report
        // shows no metric rather than a zero.
        assert_eq!(
            worst_load_percent(&BTreeMap::from([("b3".to_string(), row(None))])),
            None,
        );
        assert_eq!(worst_load_percent(&BTreeMap::new()), None);
    }

    fn controller(as_of_ns: Option<u64>, stale: bool) -> ControllerHealth {
        ControllerHealth {
            state: "passive",
            tec: 142,
            rec: 9,
            rx_overruns: None,
            as_of_ns,
            stale,
        }
    }

    #[test]
    fn a_driver_that_does_not_watch_for_receive_loss_sends_no_count_to_the_panel() {
        // The panel's whole discipline: absent is not zero. A driver
        // that watches and has seen none serialises `rxOverruns: 0`,
        // which is what says the capture is the whole of what the bus
        // sent; one that does not watch omits the key, and the panel
        // renders an em dash for it.
        let watched = ControllerHealth {
            rx_overruns: Some(0),
            ..controller(None, false)
        };
        let unwatched = controller(None, false);
        let json = |h: &ControllerHealth| serde_json::to_string(h).unwrap();
        assert!(json(&watched).contains("\"rxOverruns\":0"));
        assert!(!json(&unwatched).contains("rxOverruns"));
        assert!(!json(&unwatched).contains("asOfNs"), "an unstamped reading");
    }

    #[test]
    fn a_heartbeat_alone_is_not_a_change_but_going_stale_is() {
        // ADR 0060 rule 5: the peer republishes an unchanged reading every
        // second so a stopped one is visible. A fresh copy of the same
        // reading repaints nothing; a reading that has gone stale does.
        let row = |c: ControllerHealth| {
            BTreeMap::from([(
                "b1".to_string(),
                BusHealthRecord {
                    controller: Some(c),
                    load_percent: None,
                    error_count: 0,
                    error_rate: 0.0,
                    last_error_ts_ns: None,
                    error_episode: None,
                    refusals: Vec::new(),
                    flush_count: 0,
                    last_flush_ns: None,
                    missed_periods: MissedPeriods::default(),
                },
            )])
        };
        let first = row(controller(Some(10 * S), false));
        assert!(!rows_changed(&first, &row(controller(Some(11 * S), false))));
        assert!(rows_changed(&first, &row(controller(Some(11 * S), true))));
        assert!(rows_changed(
            &first,
            &row(ControllerHealth {
                tec: 200,
                ..controller(Some(10 * S), false)
            })
        ));
    }

    /// Reports folded live, persisted with the error series, and read back
    /// by a fresh report store over the restored scratch: each reported
    /// episode's kinds, directions and counters come back with it.
    fn persisted_then_restored(
        fold: impl FnOnce(&SignalCacheStore, &BusHealth),
        check: impl Fn(&BusHealth),
    ) -> BusHealth {
        let root = tempfile::TempDir::new().unwrap();
        let validity = crate::signal_cache::PyramidValidity {
            capture_id: "cap".into(),
            low_water: 0,
        };
        let model = crate::signal_fingerprint::DecodeModel::plain(Vec::new());
        let caches = SignalCacheStore::new(root.path());
        let live = BusHealth::default();
        fold(&caches, &live);
        check(&live);
        assert!(caches.persist(&validity, &model, crate::signal_cache::Harden::All));
        drop(caches);
        drop(live);

        let reopened = SignalCacheStore::new(root.path());
        let _ = reopened.restore(&validity, &model, 0);
        let restored = BusHealth::default();
        restore_reports(&reopened, &restored);
        restored
    }

    #[test]
    fn a_restored_capture_reads_its_episodes_detail_exactly_as_it_did_live() {
        // Owner ruling 2026-10-05: an episode's kinds, directions and
        // counters persist with the error series (ADR 0047, ADR 0060
        // rule 2), so a relaunch reads the same episode the live session
        // showed — closed, since nothing is ongoing after a relaunch.
        let mut first = episode(1, 10 * S, 11 * S, 3_412, true);
        first.count_by_kind = ErrorKindCounts {
            ack: 3_410,
            bit: 2,
            ..ErrorKindCounts::default()
        };
        first.rx_count = 7;
        let mut grown = first;
        grown.last_ns = 12 * S;
        grown.count = 3_500;
        grown.count_by_kind.ack = 3_498;
        grown.tec = 255;
        grown.open = false;
        let second = episode(2, 30 * S, 30 * S, 1, true);
        let live_detail = std::cell::RefCell::new(Vec::new());
        let restored = persisted_then_restored(
            |caches, health| {
                for (bus, r) in [
                    ("b1", &first),
                    ("b1", &grown),
                    ("b1", &second),
                    ("b2", &first),
                ] {
                    fold_episode(caches, health, bus, "s", r);
                }
            },
            |live| {
                let r = live.reports();
                *live_detail.borrow_mut() = vec![
                    r.detail("b1", 10.0, 12.0),
                    r.detail("b1", 10.0, 30.0),
                    r.detail("b1", 30.0, 30.0),
                    r.detail("b2", 10.0, 11.0),
                ];
            },
        );
        let live_detail = live_detail.into_inner();
        assert!(live_detail.iter().all(Option::is_some));
        let r = restored.reports();
        let back = vec![
            r.detail("b1", 10.0, 12.0),
            r.detail("b1", 10.0, 30.0),
            r.detail("b1", 30.0, 30.0),
            r.detail("b2", 10.0, 11.0),
        ];
        // Equal to the live answer in everything but `ongoing`: seq 2 was
        // still open live, and is closed once restored.
        let mut expected = live_detail;
        for d in expected.iter_mut().flatten() {
            d.ongoing = false;
        }
        assert_eq!(back, expected);
        assert_eq!((r.total("b1"), r.total("b2")), (3_501, 3_412));
        assert!(
            r.open_sources().is_empty(),
            "nothing is ongoing after a relaunch"
        );
    }

    #[test]
    fn a_series_from_a_scratch_without_episode_records_restores_its_total_alone() {
        // A scratch written before the records were kept holds the series
        // and nothing beside it: the count carries on from its total, and
        // its episodes have no detail — as before.
        let restored = persisted_then_restored(
            |caches, _| caches.record_bus_errors("b1", &[(10.0, 1.0), (11.0, 3_412.0)]),
            |_| {},
        );
        let r = restored.reports();
        assert_eq!(r.total("b1"), 3_412);
        assert_eq!(r.detail("b1", 10.0, 11.0), None);
    }

    #[test]
    fn a_cleared_session_forgets_its_errors_and_missed_periods() {
        let health = BusHealth::default();
        let _ = health
            .reports()
            .apply("b1", "s", &episode(1, S, S, 1, true));
        health.record_missed("b1", MissedPeriod::NoRoom, 3);
        health.clear();
        assert_eq!(health.reports().total("b1"), 0);
        assert!(health.missed().is_empty());
    }

    #[test]
    fn missed_periods_are_counted_per_bus_and_per_kind() {
        let health = BusHealth::default();
        health.record_missed("b1", MissedPeriod::NoRoom, 2);
        health.record_missed("b1", MissedPeriod::Late, 5);
        health.record_missed("b2", MissedPeriod::Late, 0);
        assert_eq!(
            health.missed(),
            BTreeMap::from([(
                "b1".to_string(),
                MissedPeriods {
                    no_room: 2,
                    late: 5
                }
            )]),
        );
    }

    #[test]
    fn a_row_is_built_for_a_mapped_bus_and_for_a_bus_that_only_faulted() {
        let mut reports = BusErrorReports::default();
        let _ = reports.apply("b9", "s", &episode(1, S, 2 * S, 2, false));
        let readings = SessionReadings {
            controllers: BTreeMap::from([("b1".to_string(), controller(None, false))]),
            ..SessionReadings::default()
        };
        let missed = BTreeMap::from([(
            "b7".to_string(),
            MissedPeriods {
                no_room: 1,
                late: 0,
            },
        )]);
        let applied = BTreeMap::new();
        let mapped = vec!["b1".to_string()];
        let rows = rows(&HealthInputs {
            mapped_buses: &mapped,
            ..empty_inputs(&readings, &reports, &missed, &applied)
        });
        assert_eq!(
            rows.keys().collect::<Vec<_>>(),
            vec!["b1", "b7", "b9"],
            "a mapped bus, a bus the scheduler missed on and a faulting one",
        );
        assert_eq!(rows["b1"].controller.unwrap().tec, 142);
        assert_eq!(rows["b1"].error_count, 0);
        // The control: a bus the host has nothing to say about gets no
        // row at all, so the panel renders an em dash rather than a zero.
        assert!(!rows.contains_key("b2"));
        assert_eq!(rows["b9"].controller, None);
        assert_eq!(rows["b9"].error_count, 2);
        assert_eq!(rows["b9"].last_error_ts_ns, Some(2 * S));
        assert!(rows["b9"].error_rate > 0.0);
        assert_eq!(rows["b7"].missed_periods.no_room, 1);
    }

    #[test]
    fn a_row_carries_no_load_where_the_host_has_no_bitrate_for_the_bus() {
        let reports = BusErrorReports::default();
        let readings = SessionReadings::default();
        let missed = BTreeMap::new();
        let applied = BTreeMap::new();
        let mapped = vec!["b1".to_string()];
        let bits = [("b1".to_string(), 170_000.0, 0.0)];
        let rows = rows(&HealthInputs {
            mapped_buses: &mapped,
            bits_by_bus: &bits,
            ..empty_inputs(&readings, &reports, &missed, &applied)
        });
        assert_eq!(
            rows["b1"].load_percent, None,
            "bits on the wire with no bitrate to divide by is still not a load",
        );
        let json = serde_json::to_value(&rows["b1"]).unwrap();
        assert!(
            json.get("loadPercent").is_none(),
            "absent, not zero: {json}",
        );
        assert!(json.get("controller").is_none());
        assert!(json.get("refusals").is_none());
        assert_eq!(json["errorCount"], 0);
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
    fn a_configured_bus_reports_a_load_and_a_silent_one_reports_zero() {
        // The pair the panel exists to distinguish. Both buses are
        // configured at 500k; one is carrying traffic and one has gone
        // quiet (a bus-off controller is exactly this), and the quiet one
        // reads 0 % rather than reading absent.
        let cfg = |speed: Option<u64>| AppliedBusConfig {
            speed_bps: speed,
            fd_enabled: false,
            fd_data_speed_bps: None,
        };
        let applied = BTreeMap::from([
            ("busy".to_string(), cfg(Some(500_000))),
            ("quiet".to_string(), cfg(Some(500_000))),
            ("defaulted".to_string(), cfg(None)),
        ]);
        let reports = BusErrorReports::default();
        let readings = SessionReadings::default();
        let missed = BTreeMap::new();
        let bits = [("busy".to_string(), 170_000.0, 0.0)];
        let rows = rows(&HealthInputs {
            bits_by_bus: &bits,
            ..empty_inputs(&readings, &reports, &missed, &applied)
        });
        assert_eq!(rows["busy"].load_percent, Some(34.0));
        assert_eq!(rows["quiet"].load_percent, Some(0.0));
        assert_eq!(
            rows["defaulted"].load_percent, None,
            "no ConfigureBus was sent, so the host does not know the wire's rate",
        );
    }

    #[test]
    fn a_snapshot_is_folded_once_and_only_what_moved_is_read_again() {
        let mut applied = AppliedEpisodes::new();
        let snap = vec![
            episode(1, S, 2 * S, 5, false),
            episode(2, 5 * S, 5 * S, 1, true),
        ];
        assert_eq!(fresh_reports(&mut applied, "s", snap.clone()).len(), 2);
        assert!(
            fresh_reports(&mut applied, "s", snap).is_empty(),
            "an unchanged snapshot costs nothing",
        );
        // The open one grew.
        let grown = vec![
            episode(1, S, 2 * S, 5, false),
            episode(2, 5 * S, 6 * S, 9, true),
        ];
        let fresh = fresh_reports(&mut applied, "s", grown);
        assert_eq!(
            fresh.iter().map(|r| (r.seq, r.count)).collect::<Vec<_>>(),
            vec![(2, 9)]
        );
        // A reconnect is a new session, so a new source, read whole.
        let reconnected = vec![episode(1, 30 * S, 30 * S, 1, true)];
        assert_eq!(fresh_reports(&mut applied, "s2", reconnected).len(), 1);
        assert_ne!(
            live_source(1, "tcp://a:1", "if"),
            live_source(2, "tcp://a:1", "if")
        );
    }

    #[test]
    fn a_dropped_frames_span_is_one_durable_event_with_a_stable_id() {
        let note = dropped_frames_note("powertrain", 49_959, 100 * S, 110 * S);
        assert_eq!(note.kind, EventKind::DroppedFrames);
        assert!(note.kind.persisted() && note.kind.exported());
        assert_eq!(note.timestamp_ns, 100 * S);
        assert_eq!(note.id, format!("dropped-frames:powertrain:{}", 100 * S));
        assert!(note.label.contains("49959"), "{}", note.label);
        assert!(note.description.as_deref().unwrap().contains("10.000 s"));
        // The store takes it once.
        let store = crate::notes::NotesStore::new();
        assert!(store.add(note.clone()).is_some());
        assert!(store.add(note).is_none());
    }
}
