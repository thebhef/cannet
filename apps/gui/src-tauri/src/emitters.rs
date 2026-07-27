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
use crate::system_log::{self, SystemMessage};
use crate::trace_query::collect_trace_records;
use crate::{crash, diag};

/// How often the host pushes a `trace-grew` IPC event with the latest
/// count + rate. Slow enough to not flood the frontend, fast enough that
/// the status line and auto-scroll feel live.
const TRACE_GREW_TICK: Duration = Duration::from_millis(100);

/// How often the host flushes the trace store to disk (ADR 0002
/// DS-2/DS-7). Much slower than [`TRACE_GREW_TICK`]: a flush fsyncs
/// segments and rewrites the reopen manifest, so it trades a small,
/// bounded I/O cost for crash durability — a crash loses at most this
/// much trailing capture — and there is nothing to gain by doing it at UI
/// cadence.
const TRACE_FLUSH_TICK: Duration = Duration::from_secs(2);


/// How many trailing frames to ship with each `trace-grew` event so the
/// auto-scrolling trace view can paint its live tail without a fetch
/// round-trip. Comfortably larger than any plausible visible-row count
/// (≈256 rows is ~5600 px of trace area), so the whole auto-scroll
/// window is covered even on a big display.
pub(crate) const TRACE_GREW_TAIL: u64 = 256;
/// Whether a `trace-grew` tick should emit, given the `(count, fps)` it
/// last emitted and the values this tick. Skips only when both are
/// byte-identical. An idle session settles there: the count is frozen
/// and [`TraceStore::frames_per_second`] returns exactly `0.0` once a
/// full second has elapsed since the last append, so after the rate has
/// finished decaying the tuple stops changing and the emitter goes quiet.
/// During that one-second decay each read differs, so
/// the status line still slides to zero before the stream falls silent.
pub(crate) fn should_emit_trace_grew(last: Option<(u64, f64)>, current: (u64, f64)) -> bool {
    match last {
        Some((count, fps)) => count != current.0 || fps.to_bits() != current.1.to_bits(),
        None => true,
    }
}

/// Periodic emitter that fires `trace-grew` events on a fixed cadence.
/// Runs on Tauri's tokio runtime; doesn't own or block any worker
/// thread. Each tick reads the cheap `(len, frames_per_second)` pair and
/// emits only when [`should_emit_trace_grew`] says something moved — so a
/// connected but idle session stops collecting a tail, serializing it,
/// and waking the `WebView` listener at 10 Hz for data that hasn't changed.
/// The `collect_trace_records` tail decode (the expensive part) runs only
/// on a tick that actually emits.
pub(crate) fn spawn_trace_grew_emitter(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(TRACE_GREW_TICK);
        let mut last_emitted: Option<(u64, f64, u64)> = None;
        loop {
            interval.tick().await;
            let state: State<'_, AppState> = app.state();
            // Read len and the low-water mark together so the status line's
            // `count - first_index` can't go momentarily negative when a flush
            // evicts between two separate reads (ADR 0002 DS-8). The oldest-
            // retained ts rides along so the frontend can place the truncation
            // marker (ADR 0035) when `first_index > 0`.
            let (count_usize, first_index_usize, oldest_ts_ns) =
                state.trace_store.len_and_low_water();
            let count = u64::try_from(count_usize).unwrap_or(u64::MAX);
            let frames_per_second = state.trace_store.frames_per_second();
            let session_start_ns = state.trace_store.session_start_ns();
            if !should_emit_trace_grew(
                last_emitted.map(|(c, fps, _)| (c, fps)),
                (count, frames_per_second),
            ) && last_emitted.map(|(_, _, s)| s) == Some(session_start_ns)
            {
                continue;
            }
            last_emitted = Some((count, frames_per_second, session_start_ns));
            let tail =
                collect_trace_records(state.inner(), count.saturating_sub(TRACE_GREW_TAIL), count);
            #[allow(clippy::cast_precision_loss)]
            let session_start_seconds = session_start_ns as f64 / 1_000_000_000.0;
            let buffer_seconds = state.trace_store.buffer_seconds();
            let frames_per_second_by_bus = state
                .trace_store
                .frames_per_second_by_bus()
                .into_iter()
                .map(|(bus_id, frames_per_second)| BusFps {
                    bus_id,
                    frames_per_second,
                })
                .collect();
            let frames_dropped_before_session = state.trace_store.frames_dropped_before_session();
            let scratch_bytes = state.trace_store.scratch_footprint_bytes();
            let first_index = first_index_usize as u64;
            let mem_bytes = crash::last_host_rss();
            let (frames_per_second_rx, frames_per_second_tx) =
                state.trace_store.frames_per_second_by_direction();
            let _ = app.emit(
                "trace-grew",
                TraceGrew {
                    count,
                    first_index,
                    first_index_ts_ns: oldest_ts_ns,
                    frames_per_second,
                    frames_per_second_rx,
                    frames_per_second_tx,
                    frames_per_second_by_bus,
                    frames_dropped_before_session,
                    session_start_seconds,
                    buffer_seconds,
                    scratch_bytes,
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
        let mut interval = tokio::time::interval(TRACE_FLUSH_TICK);
        let mut last_flushed_len = 0usize;
        let mut last_trimmed_mark = 0usize;
        loop {
            interval.tick().await;
            let state: State<'_, AppState> = app.state();
            let len = state.trace_store.len();
            if len == last_flushed_len {
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
                    // stderr capture without a perf run.
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
                if let Some(active) = state
                    .filter_index
                    .lock()
                    .expect("filter index mutex poisoned")
                    .as_mut()
                {
                    active.index.evict_below(mark);
                }
                last_trimmed_mark = mark;
            }
        }
    });
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
/// the host-side `sys_info!` / `sys_warn!` / `sys_error!` macros: the
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
