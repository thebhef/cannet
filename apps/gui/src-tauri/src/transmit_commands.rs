//! Transmit commands and the periodic scheduler.
//!
//! The host owns the TX-message pool; every transmit panel is a thin
//! view onto it (mutations go through these commands, each emitting
//! `transmit-frames-changed`). `transmit_frame_inner` / `build_frame` +
//! `append_refused_tx_row` are the single transmit primitive (offer the
//! frame to the wire; append a row only when the enqueue was refused),
//! shared by the manual send and the single `run_transmit_scheduler`
//! thread that drives every running periodic (fixed-rate grid, ADR 0039).
//! A frame the session accepted enters the trace only when the bus
//! carries it — as the driver's echo, ingested like any frame (ADR 0039). `resolve_effective_calc` layers a
//! message's calculated-field overrides over the DBC defaults (ADR 0027).

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use cannet_core::CanId;

use crate::app_state::{refresh_calc_resolutions, AppState};
use crate::ipc;
use crate::session::{resolve_bus_route, BusRoute};
use crate::trace_store::RawTraceFrame;
use crate::{diag, transmit_frames, transmit_scheduler, verification};

/// How often the transmit scheduler re-checks routes for periodics
/// parked on a down bus (ADR 0039). The `RoutesChanged` hint makes the
/// common resume (reconnect) immediate; this probe bounds the resume
/// latency if a route-up path ever misses the hint.
const PARKED_ROUTE_PROBE: Duration = Duration::from_secs(1);

/// Where a tick's frame is going: `(session address, wire channel,
/// interface id)`. The scheduler groups its due frames by this so a
/// tick costs one `FrameBatch` per destination rather than one envelope
/// per frame.
type WireDestination = (String, u8, String);

/// Ceiling on the number of undelivered runs [`UndeliveredTx`] holds.
/// A bus that is down stays down, so an outage is one run however long
/// it lasts and the realistic driver of growth is a bus that flaps.
/// Past the cap the oldest run is dropped — the same windowed-ring
/// answer the frame store gives its rows
/// ([ADR 0002](../../../docs/adr/0002-disk-spill-store.md) DS-8), and by
/// then the rows it described are the ones nearest eviction.
pub(crate) const MAX_UNDELIVERED_RUNS: usize = 4096;

/// Which `Tx` rows describe a frame **no wire took** — the `Tx ✗` rows.
///
/// A send the session accepts appends nothing: its row is the echo the
/// bus reports once it carried the frame. A send the transmit path
/// refused — no session routes the bus, or the session would not take
/// the frame — is the one transmit the host writes into the trace
/// itself, and every such row is recorded here so it cannot read as a
/// frame the bus carried. The trace fetch reads this the way it reads
/// the ingest-time violation index, decorating the row it names.
///
/// Rows are held as inclusive index runs rather than one entry each:
/// the case that produces them in bulk is a bus that is down, which is
/// one run.
///
/// This is the *enqueue* answer. A frame the session accepted and the
/// far end then rejected is not marked here — that rejection arrives
/// asynchronously, belongs to no single row, and is reported as its own
/// coalesced count (see [`crate::bus_health`]).
#[derive(Debug, Default)]
pub(crate) struct UndeliveredTx {
    /// Inclusive `(first, last)` runs, ascending and non-overlapping.
    runs: std::sync::Mutex<std::collections::VecDeque<(u64, u64)>>,
}

impl UndeliveredTx {
    /// Record that the row at `index` describes a frame no wire took.
    /// Indices arrive in append order, so this extends the newest run
    /// when it is contiguous and opens a new one otherwise.
    pub(crate) fn mark(&self, index: u64) {
        let Ok(mut runs) = self.runs.lock() else {
            return;
        };
        match runs.back_mut() {
            Some((_, last)) if *last + 1 == index => *last = index,
            Some((_, last)) if *last >= index => {}
            _ => {
                if runs.len() >= MAX_UNDELIVERED_RUNS {
                    runs.pop_front();
                }
                runs.push_back((index, index));
            }
        }
    }

    /// Whether the row at `index` is marked.
    pub(crate) fn contains(&self, index: u64) -> bool {
        self.runs.lock().is_ok_and(|runs| {
            runs.binary_search_by(|(first, last)| {
                if index < *first {
                    std::cmp::Ordering::Greater
                } else if index > *last {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .is_ok()
        })
    }

    /// How many runs are held — the bound this type exists to keep.
    #[cfg(test)]
    pub(crate) fn runs(&self) -> usize {
        self.runs.lock().map_or(0, |runs| runs.len())
    }

    /// Forget every mark. The marks address rows by index, so a new
    /// capture has to start with none.
    pub(crate) fn clear(&self) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.clear();
        }
    }
}
// ---- host-side TX-message registry IPC surface ----
//
// Every transmit panel is a thin view onto the host pool. Mutations go
// through these commands; each emits `transmit-frames-changed` so open
// views re-fetch. Periodic schedules run on host threads
// (`spawn_periodic_transmit`), not a JS `setInterval`.

/// Notify open transmit views that the pool changed so they re-fetch.
pub(crate) fn emit_transmit_frames_changed(app: &AppHandle) {
    let _ = app.emit("transmit-frames-changed", ());
}

/// Layer a per-message calc override over the DBC default, per field
/// (ADR 0027): a present override field replaces the DBC default
/// wholesale, an absent one keeps the default. `None` override yields
/// the default unchanged. Shared by [`resolve_effective_calc`] and the
/// verifier's per-bus override rebuild.
pub(crate) fn merge_calc_override(
    dbc_default: cannet_dbc::CalculatedFieldsConfig,
    override_config: Option<cannet_dbc::CalculatedFieldsConfig>,
) -> cannet_dbc::CalculatedFieldsConfig {
    match override_config {
        Some(o) => cannet_dbc::CalculatedFieldsConfig {
            counter: o.counter.or(dbc_default.counter),
            crc: o.crc.or(dbc_default.crc),
        },
        None => dbc_default,
    }
}

/// Resolve the *effective* calculated-fields config for one TX
/// message (ADR 0027): the DBC-declared defaults (`CannetCounter` /
/// `CannetCrc` attributes) with the message's override spec layered
/// on top — an override replaces the DBC default wholesale for that
/// field. The resolving DBC is
/// [`DecodeModel::message_source`](crate::signal_fingerprint::DecodeModel::message_source)'s
/// — the database that supplies the message on the request's bus, so a
/// designation can only come from the file that decodes the traffic it
/// is designating (ADR 0054), and a pick on one of the message's
/// signals moves it. `Ok(None)` when nothing is configured for the
/// message.
pub(crate) fn resolve_effective_calc(
    dbs: &crate::signal_fingerprint::DecodeModel<'_>,
    request: &ipc::TransmitRequest,
    override_spec: Option<&ipc::CalcFieldsSpec>,
) -> Result<Option<cannet_dbc::ResolvedCalculatedFields>, String> {
    let no_override = override_spec.is_none_or(ipc::CalcFieldsSpec::is_empty);
    let Ok(id) = CanId::new(request.id, request.extended) else {
        // An unencodable arbitration id can't carry calculated fields;
        // the transmit path itself will surface the id error.
        return Ok(None);
    };
    let Some(loaded) =
        dbs.message_source(Some(request.bus_id.as_str()), request.id, request.extended)
    else {
        return if no_override {
            Ok(None)
        } else {
            Err(format!(
                "no DBC on bus {} defines message 0x{:X}",
                request.bus_id, request.id
            ))
        };
    };
    let dbc_default = loaded
        .db
        .dbc_calculated_fields(id)
        .cloned()
        .unwrap_or_default();
    let override_config = override_spec
        .map(ipc::CalcFieldsSpec::to_config)
        .transpose()?;
    let merged = merge_calc_override(dbc_default, override_config);
    if merged.is_empty() {
        return Ok(None);
    }
    loaded
        .db
        .resolve_calculated_fields(id, &merged)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Current per-`(bus, id)` calculated-field validity, as observed by
/// the ingest-time verifier. Entries appear once an id with a config
/// has produced its first violation; absent ids have never failed.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn fetch_field_validity(
    state: State<'_, AppState>,
) -> Vec<verification::ValidityRecord> {
    state.verifier.validity_snapshot()
}

/// Snapshot the TX-message pool (each message + its `running` flag), in
/// pool order.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn list_transmit_frames(
    state: State<'_, AppState>,
) -> Vec<transmit_frames::TransmitFrameView> {
    state.transmit_frames().list()
}

/// Insert a new TX message or update an existing one in place. The
/// command arg `id` is authoritative (it overrides any id carried on
/// `frame`). Parking the message (`manual` mode or `cycle_ms == 0`)
/// marks it stopped and unschedules it from the scheduler; a non-parking
/// edit to a running periodic (e.g. a payload change) leaves it running,
/// and the scheduler picks the new value up on its next tick.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn set_transmit_frame(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    mut frame: transmit_frames::TransmitFrame,
) {
    id.clone_into(&mut frame.id);
    let parked = frame.mode != transmit_frames::TransmitMode::Periodic || frame.cycle_ms == 0;
    state.transmit_frames().set(frame);
    if parked {
        state.transmit_scheduler.stop(id);
    }
    // The edit may have changed the calc spec, the payload shape, the
    // bus, or the id — re-resolve against the DBC set.
    refresh_calc_resolutions(&app);
    emit_transmit_frames_changed(&app);
}

/// Remove a TX message, unscheduling its periodic first.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn remove_transmit_frame(app: AppHandle, state: State<'_, AppState>, id: String) {
    state.transmit_frames().remove(&id);
    state.transmit_scheduler.stop(id);
    emit_transmit_frames_changed(&app);
}

/// Rewrite the pool order to match `ids`.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn reorder_transmit_frames(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) {
    state.transmit_frames().reorder(&ids);
    emit_transmit_frames_changed(&app);
}

/// Stop every periodic and drop all TX messages (used by New project).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn clear_transmit_frames(app: AppHandle, state: State<'_, AppState>) {
    state.transmit_frames().clear();
    emit_transmit_frames_changed(&app);
}

/// Send one TX message now (the manual-send path). Looks the request up
/// by id and routes it through the same `transmit_frame_inner` the
/// scheduler uses — one transmit primitive, no special-casing.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn transmit_frame_once(
    state: State<'_, AppState>,
    id: String,
) -> Result<ipc::TransmitResult, String> {
    let request = state
        .transmit_frames()
        .send_request(&id)
        .ok_or_else(|| format!("no transmit frame with id {id}"))?;
    transmit_frame_inner(state.inner(), &request)
}

/// Start a message's periodic schedule. Rejects non-periodic messages
/// and a zero period; a no-op if it's already running. Adds the message
/// to the single scheduler thread rather than spawning one of its own.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn start_periodic_transmit(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let started_cycle_ms = {
        let mut registry = state.transmit_frames();
        if registry.begin_periodic(&id)? {
            // The owner is starting to transmit — the sequence counter
            // seeds at 0 (ADR 0027).
            registry.reset_counter(&id);
            registry.cycle_ms(&id)
        } else {
            None
        }
    };
    if let Some(cycle_ms) = started_cycle_ms {
        state.transmit_scheduler.start(id, cycle_ms);
    }
    emit_transmit_frames_changed(&app);
    Ok(())
}

/// [`stop_periodic_transmit`]'s body without its `AppHandle`: clear the
/// entry's running flag and unschedule it. Every stop goes through here
/// — the user's, and the one a DBC assignment change makes
/// ([`stop_periodics_whose_backing_changed`]) — so a periodic can only
/// ever be in the state the panel's own Stop leaves it in.
pub(crate) fn stop_periodic_transmit_inner(state: &AppState, id: &str) {
    state.transmit_frames().stop_periodic(id);
    state.transmit_scheduler.stop(id.to_string());
}

/// Stop a message's periodic schedule. A no-op if it isn't running.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn stop_periodic_transmit(app: AppHandle, state: State<'_, AppState>, id: String) {
    stop_periodic_transmit_inner(state.inner(), &id);
    emit_transmit_frames_changed(&app);
}

/// A firing periodic the DBC set is driving, and the database driving
/// it: the answer of the per-bus priority scan, plus which database
/// gave it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackedPeriodic {
    /// The registry id of the row.
    pub id: String,
    /// The path of the database whose definition the row transmits.
    pub dbc_path: String,
}

/// The database assigned to this periodic's bus that defines the
/// message it transmits — i.e. what the loaded set is driving the row
/// from, or `None` if nothing is. The same
/// [`DecodeModel::message_source`](crate::signal_fingerprint::DecodeModel::message_source)
/// the transmit panel's describe / decode / encode queries resolve
/// through, so the answer is exactly "which database does the app show
/// this row a message out of".
fn backing_dbc(state: &AppState, p: &transmit_frames::RunningPeriodic) -> Option<String> {
    let dbs = state.databases();
    state
        .decode_model(&dbs)
        .message_source(Some(&p.bus_id), p.can_id, p.extended)
        .map(|d| d.path.to_owned())
}

/// The periodics the current DBC set is driving: firing right now, and
/// defined by a database assigned to their bus, each paired with that
/// database. Taken **before** a change to the set;
/// [`stop_periodics_whose_backing_changed`] and
/// [`stop_periodics_driven_by`] re-ask the same question after it.
///
/// A row the set never backed — a hand-typed id no database on the bus
/// describes — is absent from both answers, so a change to the set is
/// never its business.
pub(crate) fn dbc_backed_running_periodics(state: &AppState) -> Vec<BackedPeriodic> {
    let running = state.transmit_frames().running_periodics();
    running
        .into_iter()
        .filter_map(|p| {
            backing_dbc(state, &p).map(|dbc_path| BackedPeriodic { id: p.id, dbc_path })
        })
        .collect()
}

/// Stop every periodic in `backed_before` that the assignment of
/// `path` took out from under, and return the ids stopped in pool
/// order. Two ways that happens, and they are the same fact from
/// either side:
///
/// - **nothing applies it any more** — `path` left the bus (or the
///   project) and no other assigned database defines the message;
/// - **`path` is its new winner** — `path` joined the bus and outranks
///   the database the row was firing from, so the next frame out would
///   carry an encoding the user never armed.
///
/// This is the transmit half of the rule on
/// [`crate::dbc_commands::set_dbc_buses_inner`]: continuing to put
/// frames on a real bus from definitions the project no longer applies
/// is [ADR 0053](../../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)
/// §1's uncommanded send, reached deliberately instead of by a file
/// changing underneath. Stopping is all it does — the row keeps its
/// configuration, exactly as the user's own Stop leaves it.
///
/// "The mapping changed" is measured as the resolution rule of
/// [ADR 0054](../../../docs/adr/0054-a-decoded-value-has-one-definition.md)
/// defines it — which database wins the message on this bus — and not
/// as "the set changed": a database assigned to a bus where it loses
/// the contest, or to a bus the row does not live on, moves no winner
/// and stops nothing. What it deliberately does **not** cover is the
/// winner falling back to a database the bus was *already* applying
/// when the incumbent leaves: nothing new came into the picture, and
/// the fallback is the resolution rule doing what it always does.
///
/// A row the set never backed — a hand-typed id no database on the bus
/// describes — is in neither answer, so a change to the set is never
/// its business.
pub(crate) fn stop_periodics_whose_backing_changed(
    state: &AppState,
    backed_before: &[BackedPeriodic],
    path: &str,
) -> Vec<String> {
    let running = state.transmit_frames().running_periodics();
    let mut stopped = Vec::new();
    for p in running {
        let Some(before) = backed_before.iter().find(|b| b.id == p.id) else {
            continue;
        };
        let taken_over = match backing_dbc(state, &p) {
            None => true,
            Some(after) => after == path && after != before.dbc_path,
        };
        if taken_over {
            stop_periodic_transmit_inner(state, &p.id);
            stopped.push(p.id);
        }
    }
    stopped
}

/// Stop every periodic the database at `path` was driving — or is
/// driving now — and return the ids stopped in pool order.
///
/// The reload counterpart to [`stop_periodics_whose_backing_changed`].
/// A
/// database reloaded in place can change or drop the very definitions a
/// row is transmitting from, so continuing to put those frames on a
/// real bus is [ADR 0053](../../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)
/// §1's uncommanded send — reached by a file changing underneath rather
/// than by a deliberate gesture, which makes it more surprising, not
/// less. The reload itself still applies; the stop happens first.
///
/// "Driven by" is the same per-bus priority scan asked either side of
/// the swap, so a row a *different* assigned database defines is none
/// of the reload's business, and a row the reload makes this database
/// the new winner for is.
pub(crate) fn stop_periodics_driven_by(
    state: &AppState,
    backed_before: &[BackedPeriodic],
    path: &str,
) -> Vec<String> {
    let running = state.transmit_frames().running_periodics();
    let mut stopped = Vec::new();
    for p in running {
        let before = backed_before
            .iter()
            .find(|b| b.id == p.id)
            .map(|b| b.dbc_path.as_str());
        if before == Some(path) || backing_dbc(state, &p).as_deref() == Some(path) {
            stop_periodic_transmit_inner(state, &p.id);
            stopped.push(p.id);
        }
    }
    stopped
}

/// The next fixed-rate deadline. The schedule advances `prev` by one
/// `period` each tick, so the time spent doing the transmit work (and
/// any sleep overshoot) is absorbed instead of being added on top of
/// the period — the bug behind the observed rate shortfall (a 100 ms
/// period that measured ~104 ms because ~4 ms of per-tick work was
/// being tacked onto every sleep).
///
/// If the schedule has fallen behind — a tick ran longer than its
/// period, or the period was just shortened — the target is in the
/// past; we realign to `now` rather than firing a catch-up *burst*
/// (back-to-back frames to "make up" lost ticks), which is never what
/// a CAN cyclic transmit wants. The effect is that a message whose
/// per-tick work exceeds its period simply runs as fast as it can,
/// with no growing backlog.
pub(crate) fn next_tick_deadline(
    prev: std::time::Instant,
    now: std::time::Instant,
    period: Duration,
) -> std::time::Instant {
    let target = prev + period;
    if target > now {
        target
    } else {
        now
    }
}

/// Per-second diagnostic accumulator for the transmit scheduler's wake
/// jitter. The scheduler reschedules on a fixed grid, so a wake that
/// returns late past its deadline is paid back by a short next interval
/// (a visible "catch-up" double on a tight periodic). This probe
/// localises the *cause* of that lateness: a histogram of wake lateness
/// (`now − deadline`) — a cluster around one OS timer tick (~15 ms on
/// Windows) points at timer granularity — alongside the max per-tick
/// fire duration, which points at lock contention in the transmit path
/// when it spikes. Summarised once a second to the dev log (target
/// `tx-sched`); silent while no periodic is scheduled.
struct SchedDiag {
    window_start: std::time::Instant,
    /// Scheduled (timeout-driven) wakes this window.
    wakes: u32,
    /// Wake-lateness histogram, ms buckets: `<2`, `2–8`, `8–18`,
    /// `18–30`, `≥30` (the 8–18 bucket straddles a Windows timer tick).
    late_buckets: [u32; 5],
    max_late_ms: f64,
    /// Ticks that fired ≥1 frame, and the worst fire-loop duration seen.
    fire_ticks: u32,
    frames: u32,
    max_fire_ms: f64,
}

impl SchedDiag {
    fn new(now: std::time::Instant) -> Self {
        Self {
            window_start: now,
            wakes: 0,
            late_buckets: [0; 5],
            max_late_ms: 0.0,
            fire_ticks: 0,
            frames: 0,
            max_fire_ms: 0.0,
        }
    }

    fn record_wake(&mut self, late: Duration) {
        self.wakes += 1;
        let ms = late.as_secs_f64() * 1000.0;
        if ms > self.max_late_ms {
            self.max_late_ms = ms;
        }
        let bucket = if ms < 2.0 {
            0
        } else if ms < 8.0 {
            1
        } else if ms < 18.0 {
            2
        } else if ms < 30.0 {
            3
        } else {
            4
        };
        self.late_buckets[bucket] += 1;
    }

    fn record_fire(&mut self, dur: Duration, frames: usize) {
        self.fire_ticks += 1;
        self.frames += u32::try_from(frames).unwrap_or(u32::MAX);
        let ms = dur.as_secs_f64() * 1000.0;
        if ms > self.max_fire_ms {
            self.max_fire_ms = ms;
        }
    }

    /// Emit and reset once the window reaches a second. Skips the log line
    /// (but still rolls the window) when nothing fired, so an idle
    /// scheduler stays silent. The `tx-sched` target is off in the default
    /// log filter (`system_log.rs`) — the line goes to stderr and nowhere
    /// else, so it is opt-in via `RUST_LOG`.
    fn maybe_emit(&mut self, now: std::time::Instant, metrics: &diag::HostMetrics) {
        if now.duration_since(self.window_start) < Duration::from_secs(1) {
            return;
        }
        if self.wakes > 0 {
            let b = self.late_buckets;
            tracing::info!(
                target: "tx-sched",
                "wakes={} late_ms[<2|2-8|8-18|18-30|>=30]={}|{}|{}|{}|{} max_late={:.1}ms frames={} max_fire={:.2}ms",
                self.wakes, b[0], b[1], b[2], b[3], b[4], self.max_late_ms, self.frames, self.max_fire_ms,
            );
        }
        // Surface this window's worst wake-lateness to the perf capture
        // (ADR 0031 / `diag::HostMetrics`) — the tail signal a throughput
        // average can't see.
        metrics.record_tx_late_ms(self.max_late_ms);
        *self = SchedDiag::new(now);
    }
}

/// The single transmit scheduler thread. It owns one
/// [`transmit_scheduler::PeriodicSchedule`] for *all* running periodics
/// and blocks on the command channel with a timeout equal to the time
/// until the next deadline — so it wakes either when a `Start` / `Stop`
/// arrives or when a message is due, and never busy-waits. One thread
/// scales to arbitrarily many low-rate messages across buses without the
/// per-thread wake-up jitter the old thread-per-message model had.
///
/// Emission timing semantics are ADR 0039: each message's first fire
/// carries a deterministic phase offset
/// ([`transmit_scheduler::stagger_offset`]) so same-period messages
/// don't fire as one aligned cohort; a missed period is dropped (grid
/// realigned via [`next_tick_deadline`]), never burst; and a message
/// whose bus route is down is *parked* — no preparation (counter
/// frozen), no trace rows, no per-period wakes — until the route
/// returns (`RoutesChanged` hint, [`PARKED_ROUTE_PROBE`] backstop).
///
/// Each tick's due entries go through [`fire_due`]: route, then room in
/// the session's request channel, then the registry's
/// [`fire_info`] (re-read every tick, so live payload / period edits land
/// on the next emission — property 4), rescheduling on a fixed-rate grid
/// via [`next_tick_deadline`] (work time absorbed, no catch-up burst). A
/// period that finds no room is missed, never waited for (ADR 0060 rule
/// 6), so one stalled session cannot stall every other bus's schedule.
/// The thread exits when every
/// [`transmit_scheduler::TransmitScheduler`] sender is dropped
/// (app shutdown).
pub(crate) fn run_transmit_scheduler(
    app: &AppHandle,
    rx: &std::sync::mpsc::Receiver<transmit_scheduler::SchedulerCmd>,
) {
    use std::sync::mpsc::RecvTimeoutError;
    use transmit_scheduler::SchedulerCmd;

    let mut schedule = transmit_scheduler::PeriodicSchedule::new();
    let metrics = app.state::<diag::HostMetrics>();
    // Idle wait when nothing is scheduled — long, but bounded so the
    // thread stays responsive to a spurious wake and re-checks cleanly.
    let idle = Duration::from_hours(1);
    let mut diag = SchedDiag::new(std::time::Instant::now());
    loop {
        let planned = schedule.next_deadline();
        let mut wait = planned.map_or(idle, |d| {
            d.saturating_duration_since(std::time::Instant::now())
        });
        // While anything is parked on a down route, wake at least every
        // probe interval to re-check — the backstop for a missed
        // RoutesChanged hint (ADR 0039).
        if schedule.any_parked() {
            wait = wait.min(PARKED_ROUTE_PROBE);
        }
        let recv = rx.recv_timeout(wait);
        let now = std::time::Instant::now();
        match recv {
            // First fire at `now + offset`: same-period messages spread
            // across the period instead of sharing one epoch (ADR 0039).
            Ok(SchedulerCmd::Start { id, cycle_ms }) => {
                let offset = transmit_scheduler::stagger_offset(
                    &id,
                    Duration::from_millis(u64::from(cycle_ms)),
                );
                schedule.schedule(id, now + offset);
            }
            Ok(SchedulerCmd::Stop(id)) => schedule.unschedule(&id),
            // Route-up hint: nothing to do here — the resume attempt
            // below runs on every wake while anything is parked.
            Ok(SchedulerCmd::RoutesChanged) => {}
            // A timeout is a scheduled wake: record how late past the
            // deadline `recv_timeout` actually returned (the jitter probe).
            Err(RecvTimeoutError::Timeout) => {
                if let Some(d) = planned {
                    diag.record_wake(now.saturating_duration_since(d));
                }
            }
            // All senders dropped — the app is shutting down.
            Err(RecvTimeoutError::Disconnected) => break,
        }

        let state: State<'_, AppState> = app.state();

        // Parked resume attempt (ADR 0039): on every wake while anything
        // is parked — the RoutesChanged hint and the probe timeout both
        // land here.
        if schedule.any_parked() {
            resume_parked_routes(&state, &mut schedule);
        }

        let fire_start = std::time::Instant::now();
        let due_entries = schedule.take_due(now);
        let health = app.try_state::<crate::bus_health::BusHealth>();
        let fired = fire_due(&state, &mut schedule, due_entries, now, &|bus, kind, n| {
            if let Some(health) = health.as_ref() {
                health.record_missed(bus, kind, n);
            }
        });
        if fired > 0 {
            diag.record_fire(fire_start.elapsed(), fired);
        }
        diag.maybe_emit(std::time::Instant::now(), &metrics);
    }
}

/// How many whole periods a tick that fired `fired_at`'s period at `now`
/// skipped (ADR 0039 rule 2): every grid deadline up to `now` beyond the
/// one firing now and the one [`next_tick_deadline`] realigns to `now` —
/// dropped rather than burst, and counted as missed (ADR 0060 rule 6).
pub(crate) fn periods_skipped(
    fired_at: std::time::Instant,
    now: std::time::Instant,
    period: Duration,
) -> u64 {
    if period.is_zero() {
        return 0;
    }
    let late = now.saturating_duration_since(fired_at);
    let due = late.as_nanos() / period.as_nanos();
    u64::try_from(due.saturating_sub(1)).unwrap_or(u64::MAX)
}

/// Where one due periodic goes, resolved under the registry and session
/// locks and carried out of them.
struct DueEntry {
    id: String,
    fired_at: std::time::Instant,
    bus: String,
    cycle_ms: u32,
}

/// One scheduler tick's emission of the `due` entries (ADR 0039, ADR 0060
/// rule 6). Returns how many periods it fired.
///
/// 1. **Route.** Each entry's bus is resolved to a wire destination. One
///    with no route is *parked* — no preparation, counter frozen (ADR
///    0039); one whose registry row is gone leaves the schedule.
/// 2. **Room, then preparation.** Per destination — one session's
///    interface — the tick **reserves room** in the session's request
///    channel before it prepares anything. With no room, every period
///    due there is **missed**: not prepared, its counters not stepped,
///    rescheduled on its grid, and counted through `missed` as
///    [`MissedPeriod::NoRoom`](crate::bus_health::MissedPeriod). A session
///    whose far end has stopped draining therefore costs its own buses
///    their periods and nobody else anything: the tick never waits on
///    it. With room, each period is prepared (`fire_info`, which steps
///    its counters) and the destination's frames go out as one batch.
///    A session that has gone refuses the batch, and its frames are
///    the marked `Tx ✗` rows the single-frame path leaves.
/// 3. **Lateness.** A tick that ran past one or more whole periods drops
///    them rather than bursting (ADR 0039 rule 2), and counts them as
///    [`MissedPeriod::Late`](crate::bus_health::MissedPeriod).
///
/// The session map is held only to copy each destination's transmit
/// handle out of it; nothing is offered to a wire under it.
pub(crate) fn fire_due(
    state: &AppState,
    schedule: &mut transmit_scheduler::PeriodicSchedule,
    due: Vec<(String, std::time::Instant)>,
    now: std::time::Instant,
    missed: &dyn Fn(&str, crate::bus_health::MissedPeriod, u64),
) -> usize {
    use crate::bus_health::MissedPeriod;
    if due.is_empty() {
        return 0;
    }
    // Pass 1 — route every entry, under the locks, and copy each
    // destination's transmit handle out. Lock order: `transmit_frames`
    // before `remote_sessions`.
    let mut routed: Vec<(WireDestination, DueEntry)> = Vec::new();
    let mut handles: Vec<(String, crate::session::SessionTx)> = Vec::new();
    {
        let registry = state.transmit_frames();
        let sessions = state.remote_sessions();
        for (id, fired_at) in due {
            let (Some(bus), Some(cycle_ms)) = (registry.bus_id(&id), registry.cycle_ms(&id)) else {
                // Removed — drop it.
                schedule.unschedule(&id);
                continue;
            };
            if !registry.is_running(&id) || cycle_ms == 0 {
                // Stopped, or parked to Manual — drop it.
                schedule.unschedule(&id);
                continue;
            }
            let Some(route) = resolve_bus_route(&sessions, &bus) else {
                schedule.park(&id);
                continue;
            };
            if !handles.iter().any(|(a, _)| *a == route.address) {
                if let Some(session) = sessions.get(&route.address) {
                    handles.push((route.address.clone(), session.tx.clone()));
                }
            }
            routed.push((
                (route.address, route.channel, route.interface_id),
                DueEntry {
                    id,
                    fired_at,
                    bus,
                    cycle_ms,
                },
            ));
        }
    }
    // Pass 2 — per destination: room first, then preparation and the
    // batch. Batch order is the refused-row order: `group_wire_batches`
    // preserves per-destination order, and the batches are offered in it.
    let mut fired = 0;
    for ((address, channel, interface_id), entries) in group_wire_batches(routed) {
        let tx = handles.iter().find(|(a, _)| *a == address).map(|(_, t)| t);
        let reserved = match tx.map(crate::session::SessionTx::try_reserve) {
            Some(Err(cannet_client::TransmitRefused::QueueFull)) => {
                for entry in &entries {
                    let period = Duration::from_millis(u64::from(entry.cycle_ms));
                    missed(&entry.bus, MissedPeriod::NoRoom, 1);
                    missed(
                        &entry.bus,
                        MissedPeriod::Late,
                        periods_skipped(entry.fired_at, now, period),
                    );
                    let next =
                        next_tick_deadline(entry.fired_at, std::time::Instant::now(), period);
                    schedule.reschedule(&entry.id, next);
                }
                continue;
            }
            Some(Ok(reserved)) => Some(reserved),
            // The session has gone since the route resolved: the frames
            // are prepared and refused, as before.
            Some(Err(cannet_client::TransmitRefused::Closed)) | None => None,
        };
        let mut prepared: Vec<(ipc::TransmitRequest, cannet_core::CanFrame)> = Vec::new();
        for entry in &entries {
            let Some((request, cycle_ms)) = state.transmit_frames().fire_info(&entry.id) else {
                // Stopped, parked to Manual, or removed — drop it.
                schedule.unschedule(&entry.id);
                continue;
            };
            let period = Duration::from_millis(u64::from(cycle_ms));
            missed(
                &entry.bus,
                MissedPeriod::Late,
                periods_skipped(entry.fired_at, now, period),
            );
            let next = next_tick_deadline(entry.fired_at, std::time::Instant::now(), period);
            schedule.reschedule(&entry.id, next);
            fired += 1;
            // A malformed request (invalid id / frame) is dropped, as
            // the single-frame path's discarded error did.
            if let Ok(frame) = build_frame(&request, channel) {
                prepared.push((request, frame));
            }
        }
        let frames: Vec<cannet_core::CanFrame> = prepared.iter().map(|(_, f)| f.clone()).collect();
        let delivered = match (tx, reserved) {
            (Some(tx), Some(reserved)) => tx
                .send_reserved(reserved, channel, &interface_id, &frames)
                .is_ok(),
            _ => false,
        };
        if !delivered {
            for (request, frame) in &prepared {
                append_refused_tx_row(state, request, frame);
            }
        }
    }
    fired
}

/// Re-check routes for every parked periodic (ADR 0039). A recovered
/// id re-anchors at now + its stagger offset; an id whose registry row
/// is gone (removed while the route was down) is dropped for good; the
/// rest stay parked until the next hint or probe.
fn resume_parked_routes(state: &AppState, schedule: &mut transmit_scheduler::PeriodicSchedule) {
    // Lock order: `transmit_frames` before `remote_sessions`.
    let resumable: Vec<(String, Option<u32>)> = {
        let registry = state.transmit_frames();
        let sessions = state.remote_sessions();
        schedule
            .parked_ids()
            .into_iter()
            .filter_map(|id| match (registry.bus_id(&id), registry.cycle_ms(&id)) {
                (Some(bus), Some(cycle)) => resolve_bus_route(&sessions, &bus)
                    .is_some()
                    .then_some((id, Some(cycle))),
                // Row gone — nothing left to resume.
                _ => Some((id, None)),
            })
            .collect()
    };
    let resume_now = std::time::Instant::now();
    for (id, cycle_ms) in resumable {
        match cycle_ms {
            Some(cycle_ms) => {
                let offset = transmit_scheduler::stagger_offset(
                    &id,
                    Duration::from_millis(u64::from(cycle_ms)),
                );
                schedule.resume(&id, resume_now + offset);
            }
            None => schedule.unschedule(&id),
        }
    }
}

/// The one transmit primitive: compose a frame from a request and offer
/// it to the wire if a session carries its bus. Both the manual
/// `transmit_frame_once` command and the scheduler thread
/// (`run_transmit_scheduler`) route through here, so there's no
/// special-casing for the periodic case.
///
/// Only the wire writes data. A send the session accepts appends
/// nothing: the frame enters the trace when the bus carries it, as the
/// driver's echo — a `Tx` frame on the receive path, logged, counted
/// and decoded like any other — and a frame the bus never carries
/// leaves no row. A send that is refused (no session routes the bus, or
/// the session would not take it) appends its `Tx` row here, recorded
/// in [`UndeliveredTx`] so it reads as `Tx ✗`.
///
/// `wire_status` reports the *enqueue* outcome. Server-side rejection
/// (e.g. the BLF replay server's `Error::TX_REJECTED`) arrives later on
/// the receive stream and is reported as its own coalesced count, not
/// against a row.
pub(crate) fn transmit_frame_inner(
    state: &AppState,
    request: &ipc::TransmitRequest,
) -> Result<ipc::TransmitResult, String> {
    // Resolve `bus_id` → `(session, channel, interface_id)`. With no
    // active session for the target bus, the refused `Tx ✗` row still
    // lands (the user sees what they tried to send); use wire channel 0
    // in that case — the trace view shows the *bus* column, not the
    // wire channel, so it stays unambiguous.
    let sessions_guard = state.remote_sessions();
    let routing = resolve_bus_route(&sessions_guard, &request.bus_id);
    let wire_channel = routing.as_ref().map_or(0u8, |r| r.channel);

    let frame = build_frame(request, wire_channel)?;

    let wire_status = match routing {
        None if sessions_guard.is_empty() => ipc::TransmitWireStatus::NotConnected,
        // A bound bus whose adapter has gone is not an unbound bus, and
        // saying so sends the reader to the wrong panel.
        None => {
            match crate::session::unreachable_interface_for_bus(&sessions_guard, &request.bus_id) {
                Some(interface_id) => ipc::TransmitWireStatus::Failed {
                    message: format!(
                    "the driver can no longer reach {interface_id}, the interface bound to bus {}",
                    request.bus_id
                ),
                },
                None => ipc::TransmitWireStatus::Failed {
                    message: format!("bus {} is not bound on any active server", request.bus_id),
                },
            }
        }
        Some(BusRoute {
            address,
            channel,
            interface_id,
        }) => {
            // Re-borrow the session for the actual transmit; `routing`
            // dropped its borrow when it returned.
            let session = sessions_guard
                .get(&address)
                .expect("session for resolved route disappeared mid-transmit");
            match session.tx.transmit(channel, &interface_id, &frame) {
                Ok(()) => ipc::TransmitWireStatus::Accepted { interface_id },
                Err(message) => ipc::TransmitWireStatus::Failed { message },
            }
        }
    };
    drop(sessions_guard);

    if !matches!(wire_status, ipc::TransmitWireStatus::Accepted { .. }) {
        append_refused_tx_row(state, request, &frame);
    }

    Ok(ipc::TransmitResult { wire_status })
}

/// Compose the wire [`cannet_core::CanFrame`] for `request`. Shared by
/// the single-frame path ([`transmit_frame_inner`]) and the scheduler's
/// batched tick, so one place owns frame composition — and neither
/// touches the trace until the wire has answered.
fn build_frame(
    request: &ipc::TransmitRequest,
    wire_channel: u8,
) -> Result<cannet_core::CanFrame, String> {
    let mode = if request.extended {
        "extended"
    } else {
        "standard"
    };
    let id =
        CanId::new(request.id, request.extended).map_err(|e| format!("invalid {mode} id: {e}"))?;
    // Best-effort wall-clock stamp: the wire restamps a carried frame,
    // so this is what a refused `Tx ✗` row shows.
    let timestamp_ns = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX));

    let frame = match request.kind {
        ipc::TransmitKind::Classic => cannet_core::CanFrame::classic(
            timestamp_ns,
            wire_channel,
            id,
            cannet_core::Direction::Tx,
            request.data.clone(),
        )
        .map_err(|e| format!("invalid classic frame: {e}"))?,
        ipc::TransmitKind::Fd => cannet_core::CanFrame::fd(
            timestamp_ns,
            wire_channel,
            id,
            cannet_core::Direction::Tx,
            request.data.clone(),
            cannet_core::CanFdFlags {
                bitrate_switch: request.brs,
                error_state_indicator: request.esi,
            },
        )
        .map_err(|e| format!("invalid FD frame: {e}"))?,
        ipc::TransmitKind::Remote => cannet_core::CanFrame::remote(
            timestamp_ns,
            wire_channel,
            id,
            cannet_core::Direction::Tx,
            request.dlc,
        ),
        ipc::TransmitKind::Error => {
            cannet_core::CanFrame::error(timestamp_ns, wire_channel, id, cannet_core::Direction::Tx)
        }
    };

    Ok(frame)
}

/// Append a refused send's `Tx ✗` row: `frame` as a `Tx`-direction row,
/// stamped with the target `bus_id` so the trace shows it on the right
/// bus even though no session carried it, and recorded in
/// [`UndeliveredTx`]. Only a refused enqueue writes a row here — an
/// accepted send's row is the echo the bus reports.
fn append_refused_tx_row(
    state: &AppState,
    request: &ipc::TransmitRequest,
    frame: &cannet_core::CanFrame,
) {
    let mut raw = RawTraceFrame::from(frame.clone());
    raw.bus_id = Some(request.bus_id.clone());
    if let Some(index) = state.trace_store.append(raw) {
        state.undelivered_tx.mark(index);
    }
}

/// Group `(destination, frame)` pairs into per-destination batches,
/// preserving first-seen destination order and per-destination frame
/// order. The scheduler tick uses this to turn its due frames into one
/// `FrameBatch` per `(session, channel, interface)`.
pub(crate) fn group_wire_batches<K: PartialEq, F>(items: Vec<(K, F)>) -> Vec<(K, Vec<F>)> {
    let mut grouped: Vec<(K, Vec<F>)> = Vec::new();
    for (key, frame) in items {
        if let Some((_, frames)) = grouped.iter_mut().find(|(k, _)| *k == key) {
            frames.push(frame);
        } else {
            grouped.push((key, vec![frame]));
        }
    }
    grouped
}
