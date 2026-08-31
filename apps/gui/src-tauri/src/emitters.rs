//! IPC event emitters.
//!
//! The periodic `trace-grew` (count + rate + a decoded tail, ~10 Hz) and
//! trace-store flush timers, plus the System Messages surface: the
//! `emit_system_log` chokepoint the `sys_*` macros expand to (re-exported
//! at the crate root as `crate::emit_system_log`) and the `fetch` /
//! `clear` / `gui_emit` system-log commands.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::ipc::{BusFps, TraceGrew};
use crate::signal_cache::Harden;
use crate::system_log::{self, SystemMessage};
use crate::trace_query::collect_trace_records;
use crate::{crash, diag};

/// How often the host pushes a `trace-grew` IPC event with the latest
/// count + rate, from `settings.json` (`live_update_interval_ms`). Slow
/// enough to not flood the frontend, fast enough that the status line
/// and auto-scroll feel live.
///
/// It is exposed as *one* setting covering the whole live-update loop:
/// [`FPS_SMOOTHING`] and [`TRACE_GREW_TAIL`] are both tuned against this
/// cadence, so surfacing one of the three would invite a combination
/// none of them was designed for.
fn trace_grew_tick() -> Duration {
    Duration::from_millis(crate::settings::effective().live_update_interval_ms)
}

/// How often the host flushes the trace store to disk (ADR 0002
/// DS-2/DS-7), from `settings.json` (`trace_flush_interval_ms`). Much
/// slower than [`trace_grew_tick`]: a flush fsyncs segments and rewrites
/// the reopen manifest, so it trades a small, bounded I/O cost for crash
/// durability — a crash loses at most this much trailing capture — and
/// there is nothing to gain by doing it at UI cadence.
fn trace_flush_tick() -> Duration {
    Duration::from_millis(crate::settings::effective().trace_flush_interval_ms)
}

/// Re-arm `interval` if the cadence setting moved since it was built, so
/// a changed knob takes effect on the next tick instead of at relaunch.
fn retune(interval: &mut tokio::time::Interval, period: &mut Duration, want: Duration) {
    if want != *period {
        *period = want;
        *interval = tokio::time::interval(want);
    }
}

/// Ceiling on the trailing frames shipped with a `trace-grew` event so
/// the auto-scrolling trace view can paint its live tail without a fetch
/// round-trip. Comfortably larger than any plausible visible-row count
/// (≈256 rows is ~5600 px of trace area), so the whole auto-scroll
/// window is covered even on a big display.
///
/// It is a *ceiling*, not the amount shipped: only an auto-scrolling
/// chronological view reads the tail, so the frontend declares what it
/// wants (`set_live_tail_rows`) and the host ships nothing until
/// something does.
pub(crate) const TRACE_GREW_TAIL: u64 = 256;

/// The absolute frame range to ship as the live tail, or `None` when
/// there is nothing to ship — no demand declared, or an empty capture.
/// The declared size is clamped to [`TRACE_GREW_TAIL`] so the per-tick
/// payload stays bounded whatever the frontend asks for.
pub(crate) fn live_tail_range(count: u64, requested: u64) -> Option<(u64, u64)> {
    let want = requested.min(TRACE_GREW_TAIL);
    if want == 0 || count == 0 {
        return None;
    }
    Some((count.saturating_sub(want), count))
}

/// Declare how many trailing frames the frontend wants on each
/// `trace-grew`. `0` (the startup default) means none: the host skips the
/// collect + decode entirely. Called by the views that overlay the live
/// edge as they mount, unmount, or stop auto-scrolling.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn set_live_tail_rows(state: State<'_, AppState>, rows: u64) {
    state.live_tail_rows.store(
        rows.min(TRACE_GREW_TAIL),
        std::sync::atomic::Ordering::Relaxed,
    );
}

/// Fraction of the gap to the raw rate that [`smooth_fps`] closes per
/// tick. At the default [`trace_grew_tick`] (10 Hz) that is a ~300 ms
/// time constant:
/// enough to take the burst out of a batched arrival without making the
/// readout feel detached from the bus.
const FPS_SMOOTHING: f64 = 0.3;

/// One step of the emitted rate's filter — an exponential moving average
/// over [`TraceStore::frames_per_second`]. The raw estimate is a count over
/// the *frame-time* span of a one-second sample window, so frames arriving
/// in driver batches make it jump around; the status line wants the trend,
/// not the jitter.
///
/// A raw `0.0` snaps straight to zero rather than decaying asymptotically:
/// an idle session has to reach *exactly* zero for
/// [`trace_grew_changed`] to stop waking the `WebView` 10×/second.
pub(crate) fn smooth_fps(last: Option<f64>, raw: f64) -> f64 {
    match last {
        Some(prev) if raw > 0.0 => prev + (raw - prev) * FPS_SMOOTHING,
        _ => raw,
    }
}

/// Whether a `trace-grew` tick should emit, given the
/// `(count, fps, session_start_ns, session_generation)` it last emitted
/// and the values this tick. Skips only when all four are byte-identical.
/// An idle session settles there: the count is frozen and
/// [`TraceStore::frames_per_second`] returns exactly `0.0` once a full
/// second has elapsed since the last append — which [`smooth_fps`] passes
/// through unfiltered — so after the rate has finished decaying the tuple
/// stops changing and the emitter goes quiet. During that one-second
/// decay each read differs, so the status line still slides to zero
/// before the stream falls silent.
///
/// The origin is compared because an import lowers it after its pump has
/// finished (a BLF marker below the first frame), when count and rate no
/// longer move. The generation is compared because a re-import of the
/// same small file repeats *every* other field exactly — the clear and
/// refill both fit between two ticks, and a sub-20 ms burst records one
/// rate sample so fps reads `0.0` throughout — and the frontend's
/// session origin, nulled when the import began, only ever arrives on a
/// `trace-grew`. Without the generation the emitter stayed silent and
/// the trace rendered absolute epoch seconds as elapsed time.
pub(crate) fn trace_grew_changed(
    last: Option<(u64, f64, u64, u64)>,
    current: (u64, f64, u64, u64),
) -> bool {
    match last {
        Some((count, fps, start_ns, generation)) => {
            count != current.0
                || fps.to_bits() != current.1.to_bits()
                || start_ns != current.2
                || generation != current.3
        }
        None => true,
    }
}

/// Periodic emitter that fires `trace-grew` events on a fixed cadence.
/// Runs on Tauri's tokio runtime; doesn't own or block any worker
/// thread. Each tick takes one
/// [`TraceStore::status_snapshot`](crate::trace_store::TraceStore::status_snapshot)
/// — the whole store-side readout under a single lock — and emits only
/// when [`trace_grew_changed`] says something moved, so a connected
/// but idle session stops collecting a tail, serializing it, and waking
/// the `WebView` listener at 10 Hz for data that hasn't changed. The
/// `collect_trace_records` tail decode (the expensive part) runs only on
/// a tick that actually emits, and takes the lock for its slice alone so
/// the decode itself happens off it.
pub(crate) fn spawn_trace_grew_emitter(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut period = trace_grew_tick();
        let mut interval = tokio::time::interval(period);
        let mut last_emitted: Option<(u64, f64, u64, u64)> = None;
        loop {
            interval.tick().await;
            retune(&mut interval, &mut period, trace_grew_tick());
            let state: State<'_, AppState> = app.state();
            // One lock acquisition for the whole store-side readout, so it
            // describes a single instant: `count - first_index` can't go
            // momentarily negative when a flush evicts between two separate
            // reads (ADR 0002 DS-8), and the rates belong to the length
            // reported alongside them. The oldest-retained ts rides along so
            // the frontend can place the truncation marker (ADR 0035) when
            // `first_index > 0`.
            let snap = state.trace_store.status_snapshot();
            let count = u64::try_from(snap.len).unwrap_or(u64::MAX);
            // Filter the aggregate before it leaves the host: the status
            // line reads the trend, not the per-batch arrival jitter. The
            // filter state is the last *emitted* value — a skipped tick is
            // by definition one where nothing moved.
            let frames_per_second = smooth_fps(
                last_emitted.map(|(_, fps, _, _)| fps),
                snap.frames_per_second,
            );
            let session_start_ns = snap.session_start_ns;
            let current = (
                count,
                frames_per_second,
                session_start_ns,
                snap.session_generation,
            );
            if !trace_grew_changed(last_emitted, current) {
                continue;
            }
            last_emitted = Some(current);
            // Only an auto-scrolling chronological view reads the tail, so
            // the decode runs only when one has said it wants it.
            let tail = match live_tail_range(
                count,
                state
                    .live_tail_rows
                    .load(std::sync::atomic::Ordering::Relaxed),
            ) {
                Some((from, to)) => collect_trace_records(state.inner(), from, to),
                None => Vec::new(),
            };
            #[allow(clippy::cast_precision_loss)]
            let session_start_seconds = snap
                .session_started
                .then(|| session_start_ns as f64 / 1_000_000_000.0);
            let frames_per_second_by_bus = snap
                .frames_per_second_by_bus
                .into_iter()
                .map(|(bus_id, frames_per_second)| BusFps {
                    bus_id,
                    frames_per_second,
                })
                .collect();
            let first_index = snap.first_index as u64;
            let mem_bytes = crash::last_app_rss();
            // The bar's numbers are the host's, every one of them
            // (ADR 0055), so the bus-load figure is computed here beside
            // the rest rather than folded together in the view — off the
            // same snapshot, so it describes the same instant they do.
            let bus_load_percent =
                crate::bus_health::worst_load_from(&app, &state, &snap.bits_per_second_by_bus);
            let _ = app.emit(
                "trace-grew",
                TraceGrew {
                    count,
                    first_index,
                    first_index_ts_ns: snap.first_index_ts_ns,
                    frames_per_second,
                    frames_per_second_rx: snap.frames_per_second_rx,
                    frames_per_second_tx: snap.frames_per_second_tx,
                    frames_per_second_by_bus,
                    bus_load_percent,
                    frames_dropped_before_session: snap.frames_dropped_before_session,
                    session_start_seconds,
                    buffer_seconds: snap.buffer_seconds,
                    scratch_bytes: snap.scratch_bytes,
                    mem_bytes,
                    tail,
                },
            );
        }
    });
}

/// Periodically flush the trace store so its disk-spill segments and
/// reopen manifest stay durable (ADR 0002 DS-7) — without this nothing
/// drives [`TraceStore::flush`], so a prior session could never be
/// reloaded. Skips a tick when the buffer hasn't grown since the last
/// flush, so an idle or stopped session doesn't rewrite the manifest for
/// no reason; the first tick after capture stops still persists the final
/// state, so a cleanly stopped trace is reloadable within one tick.
pub(crate) fn spawn_trace_flusher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut period = trace_flush_tick();
        let mut interval = tokio::time::interval(period);
        let mut last_flushed_len = 0usize;
        let mut last_trimmed_mark = 0usize;
        loop {
            interval.tick().await;
            retune(&mut interval, &mut period, trace_flush_tick());
            let state: State<'_, AppState> = app.state();
            // The pyramids move on their own schedule — a first-use rebuild
            // over a *stopped* restored capture extends them while the
            // buffer never grows — so their manifest is written before the
            // buffer-grew gate below, not behind it (ADR 0047). The write
            // is itself gated on the pyramids having changed, and it
            // hardens the segments that have come to rest — never the hot
            // tail every append re-dirties, which is what keeps a live
            // capture's tick off the device.
            //
            // How many it takes depends on whether this tick had frames
            // in it. The budget exists to protect a receive cadence; with
            // nothing arriving there is none to protect, and a backlog a
            // rebuild just created is better drained now than paid for at
            // the quit.
            let len = state.trace_store.len();
            let arriving = len != last_flushed_len;
            let harden = if arriving {
                Harden::live_budget()
            } else {
                Harden::idle_budget()
            };
            persist_pyramids(&state, harden);
            if !arriving {
                continue;
            }
            // Async flush (ADR 0002 DS-2): queue writeback without waiting
            // on the device, so the append lock isn't pinned on a disk
            // fsync. Time it anyway — the duration is the lock-contention
            // signal the perf capture gates on (ADR 0031 /
            // `diag::HostMetrics`).
            let started = std::time::Instant::now();
            match state.trace_store.flush_async() {
                Ok(()) => {
                    last_flushed_len = len;
                    let ms = started.elapsed().as_secs_f64() * 1000.0;
                    app.state::<diag::HostMetrics>().record_flush_ms(ms);
                    // Dev-log twin of the gauge (ADR 0031): timestamp-
                    // correlatable with the `tx-sched` lateness lines, so
                    // a flush-vs-scheduler stall can be diagnosed from one
                    // stderr capture without a perf run. Opt-in — the
                    // default filter has this target off, since it is
                    // routed to stderr alone (`system_log.rs`).
                    tracing::info!(target: "tx-flush", "flush_ms={ms:.1}");
                }
                Err(e) => tracing::warn!(error = %e, "trace store flush failed"),
            }
            // The flush may have advanced the windowed-ring mark (raw + by-id
            // evicted inside `flush_async`). Front-trim the derived caches to
            // the same mark so the *total* scratch footprint holds at the cap
            // (ADR 0002 DS-8 / 6d) — they live in `AppState`, not the store.
            // The pyramids trim by truncation *time* (their slots are
            // `(t, value)` points); the filter index trims by frame *index*
            // (its postings are frame indices), so it takes the mark directly.
            let (mark, ts_seconds) = state.trace_store.low_water();
            if mark > last_trimmed_mark {
                if let Some(ts) = ts_seconds {
                    state.signal_caches.evict_below(ts);
                }
                if let Some(active) = state.filter_index().as_mut() {
                    active.index.evict_below(mark);
                }
                last_trimmed_mark = mark;
                // The cascade moved the pyramids and the low-water mark
                // their validity key carries, so re-record both now rather
                // than leaving the manifest a tick behind the files.
                persist_pyramids(&state, harden);
            }
        }
    });
}

/// Record the signal pyramids' manifest against the key the current model
/// would reuse them under (ADR 0047). A no-op when the scratch holds no
/// identified capture, or when the pyramids haven't moved since the last
/// write. Flushes the level pages before it writes, so the manifest never
/// describes bytes the disk has not been given; `harden` says how much of
/// them (ADR 0047), and it is the whole difference between the periodic
/// caller and the exit one.
pub(crate) fn persist_pyramids(state: &AppState, harden: Harden) {
    if !state.signal_caches.needs_persist() {
        return;
    }
    if let Some(validity) = crate::app_state::pyramid_validity(state) {
        // Lock order: the DBC set before the signal caches, as every
        // other path that needs both takes them (`sample_signals`).
        let dbcs = state.databases();
        state
            .signal_caches
            .persist(&validity, &state.decode_model(&dbcs), harden);
    }
}
/// Snapshot the host-side system log. Returns every message
/// currently in the ring in chronological order. The frontend keeps
/// its own copy and merges incremental `system-log-appended` events
/// into it; this command is the bootstrap (panel opens / page reloads)
/// and a fallback if an event is missed.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn fetch_system_log(state: State<'_, AppState>) -> Vec<SystemMessage> {
    state.system_log.snapshot()
}

/// Drop every message from the host-side system log. The
/// `seq` counter is deliberately *not* reset; the frontend uses `seq`
/// to deduplicate against in-flight `system-log-appended` events, so
/// resetting would risk delivering a stale `seq = 0` after a clear.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn clear_system_log(state: State<'_, AppState>) {
    state.system_log.clear();
}

/// Push a System Messages entry from the frontend. Same plumbing as
/// the host-side `sys_debug!` / `sys_info!` / `sys_warn!` / `sys_error!`
/// macros: the
/// host's log bus assigns the `seq`, emits a `system-log-appended`
/// event, and the frontend mirror picks it up via its existing
/// listener — no separate channel for GUI-emitted entries.
///
/// This is surfaced for the filter-defined plot area's
/// bus-rename invalidation warning (`source = "plot"`). Future
/// frontend-side warnings reuse the same command; keep `source`
/// short and stable (it's filterable in the panel).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn gui_emit_system_log(
    app: AppHandle,
    level: String,
    source: String,
    message: String,
) -> Result<(), String> {
    let lvl = match level.as_str() {
        "debug" => system_log::LogLevel::Debug,
        "info" => system_log::LogLevel::Info,
        "warn" => system_log::LogLevel::Warn,
        "error" => system_log::LogLevel::Error,
        other => return Err(format!("unknown level: {other}")),
    };
    emit_system_log(&app, source.as_str(), lvl, message);
    Ok(())
}
/// Append a message to the host's log bus and broadcast it as a
/// `system-log-appended` event. The rate limiter may drop the push
/// silently — the call site doesn't need to distinguish.
///
/// Internal to this crate, but `pub(crate)` so the [`sys_info!`] /
/// [`sys_warn!`] / [`sys_error!`] macros expand to a free function call
/// rather than carrying their own `&AppHandle`-bound state plumbing.
pub(crate) fn emit_system_log(
    app: &AppHandle,
    source: &str,
    level: system_log::LogLevel,
    message: impl Into<String>,
) {
    let state: State<'_, AppState> = app.state();
    if let Some(entry) = state.system_log.push(source, level, message) {
        // Mirror every rung message to the rolling tmp log so the stream
        // survives a crash that the panic hook can't catch (see `crash.rs`).
        crash::persist_message(&entry);
        let _ = app.emit("system-log-appended", entry);
    }
}
