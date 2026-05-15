//! Cannet Tauri host. Wires the Phase-1 BLF / DBC stack and the Phase-2
//! remote-server client to the React frontend.
//!
//! Two source modes share one frontend pipeline:
//!
//! - `open_log(blf_path)` — opens a Vector BLF file and spawns a worker
//!   thread that streams frames into the trace store until the file is
//!   exhausted.
//! - `connect_remote_server(address)` — connects to a `cannet-server`
//!   over gRPC, lists its interfaces, subscribes to all of them, and
//!   spawns the same kind of worker thread to push frames into the
//!   trace store. `disconnect_remote_server` ends the session.
//!
//! Both worker threads run [`run_pump`], which is generic over
//! `CanFrameSource` — it doesn't know or care which source it's
//! draining; it just appends each frame to the shared [`TraceStore`]
//! until the source ends or a stop flag is set (the latter is how
//! `disconnect_remote_server` halts a session without first draining
//! the gRPC task's frame backlog).
//!
//! The trace UI is a *view* over [`TraceStore`]: it asks for slices via
//! `fetch_trace_range` and renders virtualized rows around the current
//! viewport. A `trace-grew` IPC event ticks at ~10 Hz with the latest
//! `count`, frame rate, and a short decoded *tail* of the newest frames
//! — the count/rate keep the status line and scrollbar current, and the
//! tail lets the auto-scrolling view paint the live edge without a
//! fetch round-trip — so the host never has to push every frame.
//!
//! The loaded DBCs live in shared backend state (`AppState::databases`)
//! so that the per-fetch decoder always uses the current set — frames
//! are decoded against each in order, first match wins. (There's only
//! one interface for now, so every DBC applies to it; per-bus DBC
//! association is a later step.) There is no retro-decode walk; adding
//! or removing a DBC mid-stream just changes what subsequent fetches
//! return.

mod filter;
mod ipc;
mod project;
mod signal_cache;
mod signal_sampler;
mod system_log;
mod trace_store;

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use cannet_blf::BlfCanFrameSource;
use cannet_client::{SessionHandle, SessionTransmitter, Subscription};
use cannet_core::{CanFrameSource, CanId};
use cannet_dbc::{Database, DecodedSignal};
use filter::FilterPredicate;

use ipc::{
    ByIdSnapshot, DbcInfo, DecodedRecord, InterfaceRecord, LogFinished, OpenLogResult,
    RemoteSessionResult, SampledPoints, SignalDescriptorRecord, SignalQuery, SignalRecord,
    SignalsSample, TraceFrameRecord, TraceGrew,
};
use signal_cache::SignalCacheStore;
use system_log::{SystemLog, SystemMessage};
use trace_store::{RawTraceFrame, TraceStore};

/// A loaded DBC: its source path, the parsed database, and the set of
/// logical bus ids this DBC is scoped to (Phase 6). Decoders walk the
/// loaded list in order — the first that decodes a given frame wins —
/// and skip any DBC whose `buses` set is non-empty and doesn't contain
/// the frame's `bus_id`. An empty set is "applies to every bus".
struct LoadedDbc {
    path: String,
    db: Database,
    /// Scoped bus ids; empty = unscoped (applies to all buses).
    buses: Vec<String>,
}

/// State for an active remote session — see
/// [`AppState::remote_session`] for the full role.
#[allow(dead_code)]
struct RemoteSession {
    /// Drop-to-disconnect handle. Read by `disconnect_remote_server`
    /// only; the rest of the file just keeps it alive in the slot.
    handle: SessionHandle,
    /// Submitting end of the session — what the `transmit_frame`
    /// command pushes onto. Populated in this commit; consumed in
    /// the next.
    transmitter: SessionTransmitter,
    /// `channel -> wire interface_id` for every subscription opened
    /// when the session was established. The transmit-panel command
    /// uses this to translate a frame's `channel` to the wire id the
    /// `FrameBatch` envelope must carry.
    channel_to_interface: Vec<(u8, String)>,
    stop: Arc<AtomicBool>,
}

/// How often the host pushes a `trace-grew` IPC event with the latest
/// count + rate. Slow enough to not flood the frontend, fast enough that
/// the status line and auto-scroll feel live.
const TRACE_GREW_TICK: Duration = Duration::from_millis(100);

/// How many trailing frames to ship with each `trace-grew` event so the
/// auto-scrolling trace view can paint its live tail without a fetch
/// round-trip. Comfortably larger than any plausible visible-row count
/// (≈256 rows is ~5600 px of trace area), so the whole auto-scroll
/// window is covered even on a big display.
const TRACE_GREW_TAIL: u64 = 256;

/// Process-wide state shared between commands and pump threads.
struct AppState {
    /// The loaded DBCs, in priority order — when decoding a frame the
    /// fetch commands try each in turn and take the first match. Mutated
    /// by `add_dbc` / `remove_dbc` / `clear_dbcs`. (Only one interface
    /// exists for now, so every loaded DBC applies to it.)
    databases: Mutex<Vec<LoadedDbc>>,
    /// Active remote session, if any: the gRPC [`SessionHandle`] (drop
    /// to disconnect), a [`SessionTransmitter`] the transmit panel
    /// uses to push frames over the wire, the interfaces the session
    /// is subscribed to (so the transmit-panel command can pick the
    /// right `interface_id` for a chosen channel), and a stop flag the
    /// pump thread watches. `disconnect_remote_server` takes everything
    /// out, sets the flag, and drops the handle — the flag makes the
    /// pump exit promptly instead of first draining whatever frames the
    /// gRPC task already buffered, and dropping the handle closes the
    /// stream. The pump thread clears this slot on exit.
    remote_session: Mutex<Option<RemoteSession>>,
    /// The trace model — the single source of truth for the captured
    /// stream. Pump threads append; `fetch_trace_range` reads slices
    /// out for the trace view to render.
    trace_store: TraceStore,
    /// Per-`(message, signal)` decoded-sample caches, extended
    /// incrementally by `sample_signals` so a plot doesn't re-decode
    /// the same matching frames every tick. Cleared on
    /// `clear_trace_store` (the frame indices it holds wouldn't
    /// otherwise survive).
    signal_caches: SignalCacheStore,
    /// Phase 7 host-side log bus. Append-side: the `sys_info!` /
    /// `sys_warn!` / `sys_error!` macros that wrap call sites in
    /// project / DBC / connection / BLF-import flows. Read-side: the
    /// `fetch_system_log` / `clear_system_log` IPC commands and the
    /// `system-log-appended` event the host emits on every successful
    /// push.
    system_log: SystemLog,
}

/// Boot the Tauri runtime.
///
/// # Panics
/// Panics if the platform runtime fails to start (no display, missing
/// `WebView`, etc.) — there's no recovery path, so we surface the error
/// loudly rather than silently exiting.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set up `tracing`'s `fmt` layer for stderr so dev logs still show
    // up alongside the in-process ring the System Messages panel
    // renders. Idempotent — safe to call again from tests.
    system_log::init_tracing_subscriber();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            databases: Mutex::new(Vec::new()),
            remote_session: Mutex::new(None),
            trace_store: TraceStore::new(),
            signal_caches: SignalCacheStore::new(),
            system_log: SystemLog::new(),
        })
        .invoke_handler(tauri::generate_handler![
            open_log,
            scan_blf_channels,
            add_dbc,
            remove_dbc,
            clear_dbcs,
            set_dbc_buses,
            fetch_trace_range,
            fetch_latest_by_id,
            clear_trace_store,
            list_remote_interfaces,
            connect_remote_server,
            disconnect_remote_server,
            project::open_project,
            project::save_project,
            list_signals,
            sample_signals,
            transmit_frame,
            list_value_tables,
            fetch_system_log,
            clear_system_log,
        ])
        .setup(|app| {
            // Make sure the main window has the id our capabilities expect.
            // Tauri assigns "main" by default for the first window in the
            // config; we rely on that here.
            debug_assert!(app.get_webview_window("main").is_some());
            spawn_trace_grew_emitter(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running cannet");
}

/// Periodic emitter that fires `trace-grew` events on a fixed cadence.
/// Runs on Tauri's tokio runtime; doesn't own or block any worker
/// thread. The unconditional emit is intentional — the rate must be
/// able to fall to zero promptly when streaming stops, and at 10 Hz
/// with a small payload the IPC cost is negligible compared to the
/// frame traffic itself.
fn spawn_trace_grew_emitter(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(TRACE_GREW_TICK);
        loop {
            interval.tick().await;
            let state: State<'_, AppState> = app.state();
            let count = u64::try_from(state.trace_store.len()).unwrap_or(u64::MAX);
            let frames_per_second = state.trace_store.frames_per_second();
            let tail =
                collect_trace_records(state.inner(), count.saturating_sub(TRACE_GREW_TAIL), count);
            let _ = app.emit(
                "trace-grew",
                TraceGrew {
                    count,
                    frames_per_second,
                    tail,
                },
            );
        }
    });
}

/// Per-channel BLF bus mapping (Phase 6). One entry per channel the
/// caller wants to route: `Some(bus_id)` to route it onto that logical
/// bus, `None` to drop frames on that channel. Channels not listed
/// stream through unassigned (`bus_id = None` on the raw frame). Camel
/// case at the wire because Tauri only renames top-level command args.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChannelBusMapping {
    pub channel: u8,
    /// `None` here means "skip this channel"; the frontend sends a
    /// JSON `null` for skipped entries.
    pub bus_id: Option<String>,
}

/// One entry of the remote-server interface → bus map the GUI sends
/// to `connect_remote_server` (Phase 6). `interface` is the wire
/// `Interface.id`; `bus_id` is the project's logical bus.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceBusBinding {
    pub interface: String,
    pub bus_id: String,
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn open_log(
    app: AppHandle,
    blf_path: String,
    #[allow(non_snake_case)] channel_bus_mapping: Option<Vec<ChannelBusMapping>>,
) -> Result<OpenLogResult, String> {
    // Open the BLF synchronously so the user gets immediate feedback if
    // the path is wrong.
    let source = match BlfCanFrameSource::open(&blf_path) {
        Ok(s) => s,
        Err(e) => {
            let msg = e.to_string();
            sys_error!(&app, "blf-import", "failed to open BLF {blf_path}: {msg}");
            return Err(msg);
        }
    };
    sys_info!(&app, "blf-import", "opened BLF {blf_path}");

    let result = OpenLogResult {
        blf_path: blf_path.clone(),
    };

    let channel_to_bus: Vec<(u8, Option<String>)> = channel_bus_mapping
        .unwrap_or_default()
        .into_iter()
        .map(|m| (m.channel, m.bus_id))
        .collect();

    let app_for_thread = app.clone();
    std::thread::Builder::new()
        .name("cannet-blf-pump".into())
        .spawn(move || {
            // The BLF pump ends at end-of-file; nothing signals it to
            // stop early, so the flag is just a never-set placeholder.
            run_pump(
                &app_for_thread,
                source,
                Arc::new(AtomicBool::new(false)),
                channel_to_bus,
            );
        })
        .map_err(|e| format!("failed to spawn pump thread: {e}"))?;

    Ok(result)
}

/// Pre-scan a BLF file and return its distinct channel numbers, in
/// ascending order. Used by the GUI's BLF import flow (Phase 6) to
/// build the channel → bus mapping step before frames start flowing.
///
/// `async` so Tauri runs it off the main thread — scanning a multi-
/// gigabyte BLF can take a few seconds and we don't want to freeze the
/// UI. The implementation pulls every frame's `channel` from the BLF
/// (we don't have a "list channels" shortcut in `cannet-blf` today)
/// but stops early once the set stops changing for a comfortable
/// window of frames.
#[tauri::command]
#[allow(clippy::unused_async)]
async fn scan_blf_channels(app: AppHandle, blf_path: String) -> Result<Vec<u8>, String> {
    use std::collections::BTreeSet;
    // Cap the scan: most BLFs have <16 channels, all visible in their
    // first few thousand frames. The cap keeps a huge BLF from blocking
    // import for a minute; if a project legitimately has a 17th channel
    // that doesn't appear until frame 100k, the channel just streams
    // through unassigned and the user can edit the mapping afterwards.
    const MAX_SCAN_FRAMES: usize = 200_000;
    let mut source = match BlfCanFrameSource::open(&blf_path) {
        Ok(s) => s,
        Err(e) => {
            let msg = e.to_string();
            sys_error!(&app, "blf-import", "failed to open BLF {blf_path}: {msg}");
            return Err(msg);
        }
    };
    let mut seen: BTreeSet<u8> = BTreeSet::new();
    for _ in 0..MAX_SCAN_FRAMES {
        match source.next_frame() {
            Ok(Some(frame)) => {
                seen.insert(frame.channel);
            }
            Ok(None) => break,
            Err(e) => {
                let msg = e.to_string();
                sys_error!(&app, "blf-import", "BLF scan failed: {msg}");
                return Err(msg);
            }
        }
    }
    Ok(seen.into_iter().collect())
}

/// The loaded-DBC list as IPC records (each one's path + message
/// count + bus scoping), in priority order. Returned from `add_dbc` /
/// `remove_dbc` / `set_dbc_buses` so the frontend always gets the
/// authoritative set after a change.
fn dbc_list(state: &AppState) -> Vec<DbcInfo> {
    state
        .databases
        .lock()
        .expect("databases mutex poisoned")
        .iter()
        .map(|d| DbcInfo {
            dbc_path: d.path.clone(),
            message_count: d.db.message_count(),
            buses: d.buses.clone(),
        })
        .collect()
}

/// Load a DBC file and add it to the set (or, if a DBC with the same
/// path is already loaded, reload it in place — same effect as a
/// "reload from disk"). Returns the full loaded list on success; on a
/// read / parse error the set is left unchanged.
///
/// Phase 7: emits `dbc`-tagged messages on the system log — `info` on
/// success (loaded or reloaded), `error` if the file can't be read or
/// the DBC can't be parsed.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn add_dbc(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<DbcInfo>, String> {
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            let msg = format!("failed to read DBC at {path}: {e}");
            sys_error!(&app, "dbc", "{msg}");
            return Err(msg);
        }
    };
    let db = match Database::parse(&text) {
        Ok(db) => db,
        Err(e) => {
            let msg = format!("failed to parse DBC at {path}: {e}");
            sys_error!(&app, "dbc", "{msg}");
            return Err(msg);
        }
    };
    let reloaded = {
        let mut list = state.databases.lock().expect("databases mutex poisoned");
        if let Some(slot) = list.iter_mut().find(|d| d.path == path) {
            slot.db = db;
            true
        } else {
            list.push(LoadedDbc { path: path.clone(), db, buses: Vec::new() });
            false
        }
    };
    if reloaded {
        sys_info!(&app, "dbc", "reloaded DBC {path}");
    } else {
        sys_info!(&app, "dbc", "loaded DBC {path}");
    }
    Ok(dbc_list(state.inner()))
}

/// Replace the bus-scoping set for a loaded DBC. An empty `buses` is
/// the "applies to all buses" default. Unknown path is a no-op (returns
/// the unchanged list); the frontend's project state can drift if a DBC
/// is removed between the user clicking a checkbox and this command
/// firing.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn set_dbc_buses(
    state: State<'_, AppState>,
    path: String,
    buses: Vec<String>,
) -> Vec<DbcInfo> {
    {
        let mut list = state.databases.lock().expect("databases mutex poisoned");
        if let Some(slot) = list.iter_mut().find(|d| d.path == path) {
            slot.buses = buses;
        }
    }
    dbc_list(state.inner())
}

/// Remove the loaded DBC with this path (no-op if it isn't loaded).
/// Returns the remaining loaded list.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn remove_dbc(app: AppHandle, state: State<'_, AppState>, path: String) -> Vec<DbcInfo> {
    let removed = {
        let mut list = state.databases.lock().expect("databases mutex poisoned");
        let before = list.len();
        list.retain(|d| d.path != path);
        before != list.len()
    };
    if removed {
        sys_info!(&app, "dbc", "removed DBC {path}");
    }
    dbc_list(state.inner())
}

/// Unload every DBC (the "New project" reset, and the first half of an
/// "open project" — the project's DBCs are then re-added one by one).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn clear_dbcs(app: AppHandle, state: State<'_, AppState>) {
    let count = {
        let mut list = state.databases.lock().expect("databases mutex poisoned");
        let n = list.len();
        list.clear();
        n
    };
    if count > 0 {
        sys_info!(&app, "dbc", "cleared {count} loaded DBC(s)");
    }
}

/// Pull a `[start, end)` slice out of the trace store and decode each
/// frame against the loaded DBCs (first that matches wins). Shared by
/// the `fetch_trace_range` command (trace-view scrolling) and the
/// `trace-grew` tail (auto-scroll live tail). Out-of-range or
/// oversized ranges clamp to what's stored, matching [`TraceStore::slice`].
fn collect_trace_records(state: &AppState, start: u64, end: u64) -> Vec<TraceFrameRecord> {
    let start_us = usize::try_from(start).unwrap_or(usize::MAX);
    let end_us = usize::try_from(end).unwrap_or(usize::MAX);
    let raw = state.trace_store.slice(start_us, end_us);
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    raw.into_iter()
        .enumerate()
        .map(|(i, frame)| {
            #[allow(clippy::cast_possible_truncation)]
            let absolute_index = start + i as u64;
            let decoded = decode_against(&dbs, &frame);
            TraceFrameRecord::from_raw(absolute_index, &frame, decoded)
        })
        .collect()
}

/// Decode a raw frame against the loaded DBCs, in order — the first
/// one that recognises the arbitration id wins. Skips any DBC whose
/// `buses` set is non-empty and doesn't contain the frame's `bus_id`
/// (Phase 6 per-bus scoping); an empty set is "all buses". `None` if
/// no DBC decodes.
fn decode_against(dbs: &[LoadedDbc], frame: &RawTraceFrame) -> Option<DecodedRecord> {
    dbs.iter()
        .filter(|d| dbc_applies_to_frame(d, frame))
        .find_map(|d| decode_raw_frame(&d.db, frame))
}

fn dbc_applies_to_frame(dbc: &LoadedDbc, frame: &RawTraceFrame) -> bool {
    if dbc.buses.is_empty() {
        return true; // unscoped: every frame
    }
    match &frame.bus_id {
        Some(bid) => dbc.buses.iter().any(|b| b == bid),
        None => false, // scoped DBCs ignore unassigned frames
    }
}

/// Pull a `[start, end)` slice out of the trace store and decode each
/// frame against the currently-attached DBC. The caller is expected to
/// be the trace view, sizing `end - start` to the visible window plus a
/// small prefetch pad.
///
/// Phase 6: `filter` is the consumer's optional [`FilterPredicate`]
/// (a filter element's predicate, evaluated post-decode). Frames that
/// don't pass are dropped from the returned vec — the consumer sees a
/// pre-filtered slice. The frontend already keys its row cache on the
/// raw absolute index, so a filtered slice is just a denser stream of
/// rows over the same window.
///
/// `async` so Tauri runs it off the main thread: under a fast replay
/// the pump thread takes the trace-store lock thousands of times a
/// second, so the clone-and-decode here can stall briefly — keeping it
/// off the UI thread keeps the window (and `disconnect`) responsive.
#[tauri::command]
#[allow(clippy::unused_async)] // `async` is what makes Tauri run it off the main thread
async fn fetch_trace_range(
    app: AppHandle,
    start: u64,
    end: u64,
    filter: Option<FilterPredicate>,
) -> Vec<TraceFrameRecord> {
    let state: State<'_, AppState> = app.state();
    let records = collect_trace_records(state.inner(), start, end);
    apply_filter_records(records, filter.as_ref())
}

/// Drop the records that don't pass `predicate`. The `Option` shape is
/// the "no filter wired" path; this just returns the vec unchanged.
fn apply_filter_records(
    records: Vec<TraceFrameRecord>,
    predicate: Option<&FilterPredicate>,
) -> Vec<TraceFrameRecord> {
    let Some(p) = predicate else { return records };
    // The fetch-path's decoded `TraceFrameRecord` doesn't carry a raw
    // `RawTraceFrame`; build a thin facade so the predicate's `matches`
    // can read the fields it needs (id / bus_id / decoded).
    records
        .into_iter()
        .filter(|r| record_matches(p, r))
        .collect()
}

/// Evaluate a predicate against an already-decoded record. Mirrors
/// [`FilterPredicate::matches`] but reads off `TraceFrameRecord`
/// rather than re-creating a `RawTraceFrame`.
fn record_matches(predicate: &FilterPredicate, record: &TraceFrameRecord) -> bool {
    use crate::trace_store::RawTraceFrame;
    use cannet_core::CanFramePayload;
    // Synthesise just enough of a `RawTraceFrame` for the evaluator;
    // the predicate only touches `id`, `bus_id`, and the decoded
    // record's name + signals.
    let raw = RawTraceFrame {
        timestamp_ns: 0,
        channel: record.channel,
        id: record.id,
        extended: record.extended,
        direction: cannet_core::Direction::Rx,
        payload: CanFramePayload::Classic(Vec::new()),
        bus_id: record.bus_id.clone(),
    };
    predicate.matches(&raw, record.decoded.as_ref())
}

/// Latest frame seen for each distinct (channel, id, extended-flag)
/// whose most recent occurrence is at or after session count `since` —
/// one per id, sorted by channel then id, decoded against the loaded
/// DBCs, each paired with the id's current message rate. `since` is a
/// trace window's start, so for a *running* trace this is "the latest
/// value of every id in the window". Backs the per-message-ID panel;
/// `async` so it runs off the main thread, like [`fetch_trace_range`].
///
/// Phase 6: `filter` drops rows whose latest frame doesn't pass the
/// predicate. (Note: this filters the *latest* observation; a row a
/// signal-value filter excludes can re-appear once the id emits a
/// passing value.)
#[tauri::command]
#[allow(clippy::unused_async)] // `async` is what makes Tauri run it off the main thread
async fn fetch_latest_by_id(
    app: AppHandle,
    since: u64,
    filter: Option<FilterPredicate>,
) -> Vec<ByIdSnapshot> {
    let state: State<'_, AppState> = app.state();
    let since = usize::try_from(since).unwrap_or(usize::MAX);
    let rows = state.trace_store.latest_since(since);
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    rows.into_iter()
        .filter_map(|row| {
            let decoded = decode_against(&dbs, &row.frame);
            let record = TraceFrameRecord::from_raw(
                u64::try_from(row.index).unwrap_or(u64::MAX),
                &row.frame,
                decoded,
            );
            if let Some(p) = filter.as_ref() {
                if !record_matches(p, &record) {
                    return None;
                }
            }
            Some(ByIdSnapshot { frame: record, rate: row.rate })
        })
        .collect()
}

/// Drop every stored frame. The frontend's Clear button is the typical
/// caller. The next `trace-grew` tick will fire with the new count
/// (zero), prompting the trace view to drop its row cache.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn clear_trace_store(state: State<'_, AppState>) {
    state.trace_store.clear();
    // The decoded-sample caches hold frame indices into the store —
    // wipe them too, otherwise the next `sample_signals` would slice
    // against a buffer that no longer exists.
    state.signal_caches.clear();
}

/// Snapshot the host-side system log (Phase 7). Returns every message
/// currently in the ring in chronological order. The frontend keeps
/// its own copy and merges incremental `system-log-appended` events
/// into it; this command is the bootstrap (panel opens / page reloads)
/// and a fallback if an event is missed.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn fetch_system_log(state: State<'_, AppState>) -> Vec<SystemMessage> {
    state.system_log.snapshot()
}

/// Drop every message from the host-side system log (Phase 7). The
/// `seq` counter is deliberately *not* reset; the frontend uses `seq`
/// to deduplicate against in-flight `system-log-appended` events, so
/// resetting would risk delivering a stale `seq = 0` after a clear.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn clear_system_log(state: State<'_, AppState>) {
    state.system_log.clear();
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
        let _ = app.emit("system-log-appended", entry);
    }
}

/// Every `(message, signal)` pair defined by any loaded DBC, for a plot
/// panel's signal picker — the union across all loaded DBCs, sorted and
/// deduplicated. Empty when no DBC is loaded.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_signals(state: State<'_, AppState>) -> Vec<SignalDescriptorRecord> {
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    let mut out: Vec<SignalDescriptorRecord> = dbs
        .iter()
        .flat_map(|l| l.db.signals())
        .map(SignalDescriptorRecord::from)
        .collect();
    out.sort_by(|a, b| {
        (a.message_id, a.extended, a.signal_name.as_str()).cmp(&(
            b.message_id,
            b.extended,
            b.signal_name.as_str(),
        ))
    });
    out.dedup_by(|a, b| {
        a.message_id == b.message_id && a.extended == b.extended && a.signal_name == b.signal_name
    });
    out
}

/// Sample a batch of DBC signals over a slice `[from_index, window_end)`
/// of the capture (frame-index range — a plot panel backed by a trace
/// element passes it), returning one [`SampledPoints`] per query (same
/// order) plus the slice's first/last frame timestamps so a live plot
/// can place its x-origin and "follow live" edge without a second
/// round-trip. A signal's points are empty if no DBC is attached or the
/// id / signal is unknown / unseen in the slice.
///
/// One trace-store lock acquisition cleans out *all* the queried
/// signals' frames at once (via [`TraceStore::slice_matching_many`], so
/// the per-tick lock hold is `O(Σ matches)`, not `O(|signals| ·
/// window)`); the DBC lock is then taken once for the whole batch's
/// decode. A live plot re-samples this frequently and **incrementally**
/// — each tick `from_index` is just past the last frame it already has,
/// so `[from_index, window_end)` is one tick's worth of new frames, not
/// the whole capture. (The first call after the plot opens / its window
/// re-anchors passes `from_index` = the window start, decoding the
/// backlog once.)
///
/// `max_points` (`0` ⇒ no limit): the caller passes roughly the pixel
/// width of the plot (times a small factor) on a full / backlog fetch so
/// that fetch is min/max-decimated rather than shipping a point per
/// frame; on an incremental tick it passes `0` (the slice is already
/// small, and the caller re-decimates its own accumulated series).
/// Min/max decimation preserves per-bucket extrema, so spikes survive.
///
/// `async` for the same reason as `fetch_trace_range`: the slice +
/// decode can briefly contend with a fast pump thread, so it runs off
/// the UI thread. The trace-store slice is taken before the DBC lock to
/// keep the lock order (DBC ⊃ nothing) consistent with the other
/// commands.
#[tauri::command]
#[allow(clippy::unused_async, clippy::too_many_arguments)]
async fn sample_signals(
    app: AppHandle,
    from_index: u32,
    window_end: u32,
    from_seconds: Option<f64>,
    to_seconds: Option<f64>,
    signals: Vec<SignalQuery>,
    max_points: u32,
) -> tauri::ipc::Response {
    let sample = sample_signals_inner(
        &app,
        from_index,
        window_end,
        from_seconds,
        to_seconds,
        &signals,
        max_points,
    );
    tauri::ipc::Response::new(encode_signals_sample(&sample))
}

/// Pack a [`SignalsSample`] into the compact binary layout the frontend
/// decodes via `DataView` / `Float64Array`. Replaces the JSON encode of
/// the same data — at 10 panels × a few signals × thousands of points
/// the JSON path was 100-200 ms of every per-tick wall clock, and
/// almost all of that was spent encoding f64 arrays to base-10 text
/// just for the JS side to parse them straight back to floats.
///
/// Layout (little-endian throughout):
/// ```text
/// magic   8 bytes  "SIGSAMP\x01"
/// from_s  f64      capture-window first timestamp, NaN ⇒ null
/// last_s  f64      capture-window last timestamp, NaN ⇒ null
/// slice   f64      diagnostic: lock-held slice ms
/// decode  f64      diagnostic: decode + decimate ms
/// nsig    u32      number of signals
/// for each signal:
///   n     u32      sample count
///   t[n]  f64×n    timestamps (absolute seconds)
///   v[n]  f64×n    values
/// ```
fn encode_signals_sample(s: &SignalsSample) -> Vec<u8> {
    let total_points: usize = s.series.iter().map(|p| p.t.len()).sum();
    let mut buf = Vec::with_capacity(8 + 32 + 4 + s.series.len() * 4 + total_points * 16);
    buf.extend_from_slice(b"SIGSAMP\x01");
    buf.extend_from_slice(&s.from_seconds.unwrap_or(f64::NAN).to_le_bytes());
    buf.extend_from_slice(&s.last_seconds.unwrap_or(f64::NAN).to_le_bytes());
    buf.extend_from_slice(&s.slice_ms.to_le_bytes());
    buf.extend_from_slice(&s.decode_ms.to_le_bytes());
    #[allow(clippy::cast_possible_truncation)]
    buf.extend_from_slice(&(s.series.len() as u32).to_le_bytes());
    for p in &s.series {
        debug_assert_eq!(p.t.len(), p.v.len());
        #[allow(clippy::cast_possible_truncation)]
        buf.extend_from_slice(&(p.t.len() as u32).to_le_bytes());
        for &t in &p.t {
            buf.extend_from_slice(&t.to_le_bytes());
        }
        for &v in &p.v {
            buf.extend_from_slice(&v.to_le_bytes());
        }
    }
    buf
}

fn sample_signals_inner(
    app: &AppHandle,
    from_index: u32,
    window_end: u32,
    from_seconds: Option<f64>,
    to_seconds: Option<f64>,
    signals: &[SignalQuery],
    max_points: u32,
) -> SignalsSample {
    let state: State<'_, AppState> = app.state();

    #[allow(clippy::cast_precision_loss)]
    let ns_to_seconds = |ns: u64| (ns as f64) / 1e9;

    let t_slice = std::time::Instant::now();
    let (from_ts, last_ts) = state
        .trace_store
        .frame_timestamps(from_index as usize, window_end as usize);
    // Time bounds for the per-signal slice. When the caller didn't
    // supply them (first fetch on a fresh panel — it doesn't have a
    // base / fps yet), fall back to the window's actual timestamps so
    // the slice still covers the full window. Sending the times
    // directly (rather than reusing `from_index` / `window_end` to
    // partition the cache by frame index) is what fixes the "fencepost"
    // offset on zoomed-in panels: the frontend's `frame_index =
    // floor(t * fps)` is biased by the average-rate approximation, and
    // the returned samples ended up tens of seconds inside the
    // requested left edge whenever the per-id rate wasn't uniform.
    let slice_from = from_seconds.unwrap_or_else(|| from_ts.map_or(f64::MIN, ns_to_seconds));
    let slice_to = to_seconds.unwrap_or_else(|| {
        // `last_ts` is the timestamp of the *last* frame in the window
        // — the cache slice's right edge is exclusive, so widen by one
        // second so that last sample isn't lost. (One tick of float
        // precision would be cleaner but at 1 e9 ns scale the next
        // representable float is multiple ns away.)
        last_ts.map_or(f64::MAX, |ns| ns_to_seconds(ns) + 1.0)
    });
    // Catch the per-signal decoded-sample caches up to the trace
    // store's current tip and pull the slice each plot wants. Catch-up
    // is `O(new matches)` rather than `O(matches in window)`, which is
    // the win at long captures + high rate: per-tick host work no
    // longer scales with capture length.
    let dbs_guard = state.databases.lock().expect("databases mutex poisoned");
    let db_refs: Vec<&Database> = dbs_guard.iter().map(|l| &l.db).collect();
    let sliced: Vec<Vec<signal_sampler::SamplePoint>> = signals
        .iter()
        .map(|q| {
            state.signal_caches.slice(
                q.message_id,
                q.extended,
                &q.signal_name,
                slice_from,
                slice_to,
                &state.trace_store,
                &db_refs,
            )
        })
        .collect();
    drop(dbs_guard);
    let slice_ms = t_slice.elapsed().as_secs_f64() * 1000.0;

    let t_decode = std::time::Instant::now();
    let series: Vec<SampledPoints> = sliced
        .into_iter()
        .map(|samples| {
            let points = if max_points > 0 {
                signal_sampler::decimate_min_max(&samples, max_points as usize)
            } else {
                samples
            };
            let mut t = Vec::with_capacity(points.len());
            let mut v = Vec::with_capacity(points.len());
            for p in points {
                t.push(p.t_seconds);
                v.push(p.value);
            }
            SampledPoints { t, v }
        })
        .collect();
    let decode_ms = t_decode.elapsed().as_secs_f64() * 1000.0;

    SignalsSample {
        from_seconds: from_ts.map(ns_to_seconds),
        last_seconds: last_ts.map(ns_to_seconds),
        series,
        slice_ms,
        decode_ms,
    }
}

fn decode_raw_frame(db: &Database, frame: &RawTraceFrame) -> Option<DecodedRecord> {
    let id = if frame.extended {
        CanId::extended(frame.id).ok()?
    } else {
        CanId::standard(frame.id).ok()?
    };
    let data = frame.payload.data();
    db.decode_raw(id, data).map(|m| DecodedRecord {
        name: m.name.to_string(),
        signals: m.signals.iter().map(signal_to_wire).collect(),
    })
}

/// One-shot RPC: connect, list the server's interfaces, disconnect.
/// Used by the connection panel before the user commits to a session.
#[tauri::command]
async fn list_remote_interfaces(address: String) -> Result<Vec<InterfaceRecord>, String> {
    let interfaces = cannet_client::list_interfaces(&address)
        .await
        .map_err(|e| e.to_string())?;
    Ok(interfaces.into_iter().map(InterfaceRecord::from).collect())
}

/// Connect to a `cannet-server`, list its interfaces, subscribe to all
/// of them (each gets `channel = its index in the list`), and spawn a
/// pump thread to push frames at the frontend.
///
/// At most one remote session may be active at a time — second call
/// while one is open returns an error.
///
/// Phase 6: `bindings` is the project's interface → bus mapping for
/// this server (a list of `{interface, bus_id}` pairs). The host
/// translates that into a per-channel mapping the pump uses to stamp
/// each frame's `bus_id`. Interfaces without a binding stream through
/// unassigned.
// Phase 7 sprinkled six structured-log emit sites across this command;
// it's now slightly over clippy's default function-length cap, but the
// shape is "linear sequence of named failure points" — splitting would
// just inline-extract a helper that has zero independent meaning.
#[allow(clippy::too_many_lines)]
#[tauri::command]
async fn connect_remote_server(
    app: AppHandle,
    address: String,
    bindings: Option<Vec<InterfaceBusBinding>>,
) -> Result<RemoteSessionResult, String> {
    sys_info!(&app, "connection", "connecting to {address}");
    let interfaces = match cannet_client::list_interfaces(&address).await {
        Ok(v) => v,
        Err(e) => {
            let msg = e.to_string();
            sys_error!(&app, "connection", "failed to connect to {address}: {msg}");
            return Err(msg);
        }
    };

    if interfaces.is_empty() {
        let msg = format!("server at {address} exposes no interfaces");
        sys_warn!(&app, "connection", "{msg}");
        return Err(msg);
    }

    let subscriptions: Vec<Subscription> = interfaces
        .iter()
        .enumerate()
        .map(|(i, iface)| Subscription {
            interface_id: iface.id.clone(),
            channel: u8::try_from(i).unwrap_or(u8::MAX),
        })
        .collect();

    let address_for_thread = address.clone();
    let subs_for_thread = subscriptions.clone();
    let source = match tokio::task::spawn_blocking(move || {
        cannet_client::connect_and_subscribe(&address_for_thread, subs_for_thread)
    })
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let msg = e.to_string();
            sys_error!(&app, "connection", "subscribe to {address} failed: {msg}");
            return Err(msg);
        }
        Err(e) => {
            let msg = format!("subscribe task panicked: {e}");
            sys_error!(&app, "connection", "{msg}");
            return Err(msg);
        }
    };

    let (handle, receiver, transmitter) = source.into_parts();
    let stop = Arc::new(AtomicBool::new(false));

    {
        let state: State<'_, AppState> = app.state();
        let mut guard = state
            .remote_session
            .lock()
            .expect("remote_session mutex poisoned");
        if guard.is_some() {
            // Drop `handle` here, which sends shutdown to the worker we
            // just spawned. Subsequent pump-thread spawn is skipped.
            let msg = "already connected to a remote server";
            sys_warn!(&app, "connection", "{msg}");
            return Err(msg.into());
        }
        *guard = Some(RemoteSession {
            handle,
            transmitter,
            channel_to_interface: subscriptions
                .iter()
                .map(|s| (s.channel, s.interface_id.clone()))
                .collect(),
            stop: Arc::clone(&stop),
        });
    }

    // Build the channel-to-bus mapping from the per-server bindings:
    // pick out only the bindings whose `interface` matches one of this
    // server's subscribed interfaces, then translate via the
    // subscription's channel. An interface without a matching binding
    // contributes no entry (the pump leaves that channel's bus_id
    // unassigned).
    let binding_lookup = bindings.unwrap_or_default();
    let channel_to_bus: Vec<(u8, Option<String>)> = subscriptions
        .iter()
        .filter_map(|sub| {
            binding_lookup
                .iter()
                .find(|b| b.interface == sub.interface_id)
                .map(|b| (sub.channel, Some(b.bus_id.clone())))
        })
        .collect();

    let app_for_thread = app.clone();
    std::thread::Builder::new()
        .name("cannet-remote-pump".into())
        .spawn(move || {
            run_pump(&app_for_thread, receiver, stop, channel_to_bus);
            // The pump exited (server hung up or user disconnected).
            // Clear the stashed session so a fresh connect can start.
            let state: State<'_, AppState> = app_for_thread.state();
            let _ = state
                .remote_session
                .lock()
                .expect("remote_session mutex poisoned")
                .take();
        })
        .map_err(|e| format!("failed to spawn remote pump thread: {e}"))?;

    sys_info!(
        &app,
        "connection",
        "connected to {address} ({n} interface(s))",
        n = subscriptions.len(),
    );

    Ok(RemoteSessionResult {
        address,
        subscriptions: subscriptions
            .iter()
            .map(|s| ipc::SubscriptionRecord {
                interface_id: s.interface_id.clone(),
                channel: s.channel,
            })
            .collect(),
        interfaces: interfaces.into_iter().map(InterfaceRecord::from).collect(),
    })
}

/// End the active remote session: set the pump's stop flag and drop the
/// [`SessionHandle`]. The flag makes the pump break out of its loop on
/// the next iteration — without first replaying whatever frames the
/// gRPC task already buffered, which under a fast replay can be a large
/// backlog — and dropping the handle closes the stream. The pump then
/// emits `log-finished` and clears the session slot.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn disconnect_remote_server(app: AppHandle, state: State<'_, AppState>) {
    let session = state
        .remote_session
        .lock()
        .expect("remote_session mutex poisoned")
        .take();
    if let Some(session) = session {
        session.stop.store(true, Ordering::Relaxed);
        // Dropping the handle signals the worker to disconnect; the
        // transmitter goes with it, so subsequent transmit_frame calls
        // see SessionClosed.
        drop(session);
        sys_info!(&app, "connection", "disconnected from remote server");
    }
}

/// Decide how to route an incoming frame given the per-channel bus
/// mapping. Returns `Some(bus_id)` to stamp the frame with that bus,
/// `None` to leave it unassigned, or `Err(())` to drop the frame
/// (the "skip this channel" path from the BLF mapping step).
///
/// Pure helper so the pump's routing decision is unit-testable without
/// spinning up a Tauri runtime.
fn route_channel(channel: u8, mapping: &[(u8, Option<String>)]) -> Result<Option<String>, ()> {
    match mapping.iter().find(|(ch, _)| *ch == channel) {
        Some((_, Some(bid))) => Ok(Some(bid.clone())),
        Some((_, None)) => Err(()),
        None => Ok(None),
    }
}

// `source` is owned by this thread for its lifetime; clippy's
// "pass by reference" suggestion doesn't fit the thread-spawn site.
//
// `channel_to_bus` is the source's per-channel logical-bus mapping
// (Phase 6). On each frame the pump tags it with the bus_id matching
// its `channel`; a channel with no entry stays `bus_id: None`; a
// channel mapped to `None` is dropped (the BLF-import "skip" path).
#[allow(clippy::needless_pass_by_value)]
fn run_pump<S>(
    app: &AppHandle,
    mut source: S,
    stop: Arc<AtomicBool>,
    channel_to_bus: Vec<(u8, Option<String>)>,
) where
    S: CanFrameSource,
    S::Error: fmt::Display,
{
    let state: State<'_, AppState> = app.state();
    let mut total: u64 = 0;

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match source.next_frame() {
            Ok(Some(frame)) => {
                let mut raw = RawTraceFrame::from(frame);
                match route_channel(raw.channel, &channel_to_bus) {
                    Ok(bid) => raw.bus_id = bid,
                    Err(()) => continue, // skip this channel
                }
                state.trace_store.append(raw);
                total = total.saturating_add(1);
            }
            Ok(None) => break,
            Err(e) => {
                let msg = e.to_string();
                sys_error!(app, "connection", "frame source ended with error: {msg}");
                let _ = app.emit(
                    "log-finished",
                    LogFinished::Error { message: msg },
                );
                return;
            }
        }
    }

    sys_info!(app, "connection", "frame source ended cleanly ({total} frames)");
    let _ = app.emit("log-finished", LogFinished::Ok { total });
}

/// Compose a frame from the transmit panel, append it to the trace as
/// a `Tx`-direction tx-confirm row (always, even with no remote
/// session — that's what a real analyzer shows for its own
/// transmits), and — if a remote session is open — forward it onto
/// the wire too. Server-side rejection (e.g. the BLF replay
/// server's `Error::TX_REJECTED`) surfaces inline through the receive
/// pump as a `ConnectionError::Server`; this command's
/// `wire_status` only reports the *enqueue* outcome.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn transmit_frame(
    state: State<'_, AppState>,
    request: ipc::TransmitRequest,
) -> Result<ipc::TransmitResult, String> {
    transmit_frame_inner(state.inner(), &request)
}

fn transmit_frame_inner(
    state: &AppState,
    request: &ipc::TransmitRequest,
) -> Result<ipc::TransmitResult, String> {
    let id = if request.extended {
        CanId::extended(request.id).map_err(|e| format!("invalid extended id: {e}"))?
    } else {
        CanId::standard(request.id).map_err(|e| format!("invalid standard id: {e}"))?
    };
    // Best-effort monotonic timestamp tied to the host's clock — for a
    // tx-confirm the analyzer's wall-time stamp is what we want.
    let timestamp_ns = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    let frame = match request.kind {
        ipc::TransmitKind::Classic => cannet_core::CanFrame::classic(
            timestamp_ns,
            request.channel,
            id,
            cannet_core::Direction::Tx,
            request.data.clone(),
        )
        .map_err(|e| format!("invalid classic frame: {e}"))?,
        ipc::TransmitKind::Fd => cannet_core::CanFrame::fd(
            timestamp_ns,
            request.channel,
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
            request.channel,
            id,
            cannet_core::Direction::Tx,
            request.dlc,
        ),
        ipc::TransmitKind::Error => {
            cannet_core::CanFrame::error(timestamp_ns, request.channel, id, cannet_core::Direction::Tx)
        }
    };

    // Append the tx-confirm. The next `trace-grew` tick carries the
    // updated count and (a tail including) this row to the frontend.
    state.trace_store.append(RawTraceFrame::from(frame.clone()));
    let tx_confirm_index = u64::try_from(state.trace_store.len()).unwrap_or(u64::MAX) - 1;

    // Forward to the remote session, if any.
    let session_guard = state
        .remote_session
        .lock()
        .expect("remote_session mutex poisoned");
    let wire_status = match session_guard.as_ref() {
        None => ipc::TransmitWireStatus::NotConnected,
        Some(session) => 'wire: {
            let Some((_, interface_id)) = session
                .channel_to_interface
                .iter()
                .find(|(ch, _)| *ch == request.channel)
            else {
                break 'wire ipc::TransmitWireStatus::Failed {
                    message: format!(
                        "channel {} is not bound to any wire interface",
                        request.channel
                    ),
                };
            };
            let interface_id = interface_id.clone();
            match session.transmitter.transmit(&interface_id, &frame) {
                Ok(()) => ipc::TransmitWireStatus::Sent { interface_id },
                Err(e) => ipc::TransmitWireStatus::Failed {
                    message: e.to_string(),
                },
            }
        }
    };

    Ok(ipc::TransmitResult {
        tx_confirm_index,
        wire_status,
    })
}

/// Look up the full `VAL_` table for one DBC signal across every
/// loaded DBC, first-match-wins. Returns an empty vec if no DBC has
/// a value table for the requested signal. The plot panel's symbolic
/// y-axis ticks and the transmit panel's enum dropdown call this
/// once per signal — the table doesn't have to ride along on every
/// decoded frame.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_value_tables(
    state: State<'_, AppState>,
    message_id: u32,
    extended: bool,
    signal_name: String,
) -> Vec<ipc::ValueTableEntryRecord> {
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    for loaded in dbs.iter() {
        if let Some(rows) = loaded.db.value_table_for_signal(message_id, extended, &signal_name) {
            return rows
                .iter()
                .map(|e| ipc::ValueTableEntryRecord {
                    raw: e.raw,
                    label: e.label.clone(),
                })
                .collect();
        }
    }
    Vec::new()
}

fn signal_to_wire(sig: &DecodedSignal<'_>) -> SignalRecord {
    SignalRecord {
        name: sig.name.to_string(),
        value: sig.value,
        unit: sig.unit.to_string(),
        label: sig.label.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_core::{CanFramePayload, Direction};

    fn dummy_frame(ts_ns: u64, id: u32) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: ts_ns,
            channel: 0,
            id,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(vec![]),
            bus_id: None,
        }
    }

    /// A classic frame with a full 8-byte payload — enough that an
    /// 8-bit signal at byte 0 actually decodes (an empty payload would
    /// be skipped as "outside the payload").
    fn frame_with_data(id: u32) -> RawTraceFrame {
        RawTraceFrame {
            payload: CanFramePayload::Classic(vec![0u8; 8]),
            ..dummy_frame(0, id)
        }
    }

    /// A minimal one-message DBC: arbitration id `id`, message name
    /// `name`, one 8-bit signal `sig` at byte 0.
    fn tiny_dbc(id: u32, name: &str, sig: &str) -> String {
        format!(
            "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\n\
             BO_ {id} {name}: 8 ECU\n SG_ {sig} : 0|8@1+ (1,0) [0|0] \"\" ECU\n"
        )
    }

    fn test_state() -> AppState {
        AppState {
            databases: Mutex::new(Vec::new()),
            remote_session: Mutex::new(None),
            trace_store: TraceStore::new(),
            signal_caches: SignalCacheStore::new(),
            system_log: SystemLog::new(),
        }
    }

    fn loaded(path: &str, dbc_text: &str) -> LoadedDbc {
        LoadedDbc {
            path: path.into(),
            db: Database::parse(dbc_text).expect("test DBC parses"),
            buses: Vec::new(),
        }
    }

    fn loaded_scoped(path: &str, dbc_text: &str, buses: &[&str]) -> LoadedDbc {
        LoadedDbc {
            path: path.into(),
            db: Database::parse(dbc_text).expect("test DBC parses"),
            buses: buses.iter().map(|s| (*s).into()).collect(),
        }
    }

    #[test]
    fn collect_trace_records_uses_absolute_indices() {
        let state = test_state();
        for i in 0u32..10 {
            state.trace_store.append(dummy_frame(u64::from(i) * 1_000, i));
        }
        let mid = collect_trace_records(&state, 3, 6);
        assert_eq!(mid.iter().map(|r| r.index).collect::<Vec<_>>(), vec![3, 4, 5]);
        assert_eq!(mid.iter().map(|r| r.id).collect::<Vec<_>>(), vec![3, 4, 5]);
        // No DBC attached -> nothing decoded.
        assert!(mid.iter().all(|r| r.decoded.is_none()));
    }

    #[test]
    fn decodes_against_the_loaded_dbcs_first_match_wins() {
        let state = test_state();
        // Two DBCs: each owns one unique id (256 / 512) and both define
        // id 768 — with different message names — so we can see "first
        // loaded wins" on the overlap.
        let dbc_a = format!(
            "{}\nBO_ 768 SharedMsg: 8 ECU\n SG_ FromA : 0|8@1+ (1,0) [0|0] \"\" ECU\n",
            tiny_dbc(256, "OnlyInA", "Sa"),
        );
        let dbc_b = format!(
            "{}\nBO_ 768 SharedMsg: 8 ECU\n SG_ FromB : 0|8@1+ (1,0) [0|0] \"\" ECU\n",
            tiny_dbc(512, "OnlyInB", "Sb"),
        );
        *state.databases.lock().unwrap() = vec![loaded("a.dbc", &dbc_a), loaded("b.dbc", &dbc_b)];

        for id in [256u32, 512, 768, 999] {
            state.trace_store.append(frame_with_data(id));
        }
        let r = collect_trace_records(&state, 0, 4);
        let name = |i: usize| r[i].decoded.as_ref().map(|d| d.name.clone());
        assert_eq!(name(0).as_deref(), Some("OnlyInA")); // only DBC A has it
        assert_eq!(name(1).as_deref(), Some("OnlyInB")); // only DBC B has it
        assert_eq!(name(2).as_deref(), Some("SharedMsg")); // both — A first
        assert_eq!(
            r[2].decoded.as_ref().map(|d| d.signals[0].name.clone()).as_deref(),
            Some("FromA"),
        );
        assert!(r[3].decoded.is_none()); // no DBC knows id 999
    }

    #[test]
    fn per_bus_dbc_scoping_filters_decode() {
        let state = test_state();
        // DBC A scoped to bus "p" (powertrain), DBC B scoped to bus "c"
        // (chassis). Same arbitration id 256, different message names so
        // we can tell which DBC decoded each frame.
        let dbc_a = tiny_dbc(256, "FromBusP", "Sa");
        let dbc_b = tiny_dbc(256, "FromBusC", "Sb");
        *state.databases.lock().unwrap() = vec![
            loaded_scoped("a.dbc", &dbc_a, &["p"]),
            loaded_scoped("b.dbc", &dbc_b, &["c"]),
        ];
        // Three frames, same id, different routing.
        let mut on_p = frame_with_data(256);
        on_p.bus_id = Some("p".into());
        let mut on_c = frame_with_data(256);
        on_c.bus_id = Some("c".into());
        let unassigned = frame_with_data(256); // bus_id: None
        state.trace_store.append(on_p);
        state.trace_store.append(on_c);
        state.trace_store.append(unassigned);

        let r = collect_trace_records(&state, 0, 3);
        let name = |i: usize| r[i].decoded.as_ref().map(|d| d.name.clone());
        assert_eq!(name(0).as_deref(), Some("FromBusP"));
        assert_eq!(name(1).as_deref(), Some("FromBusC"));
        // An unassigned frame doesn't match any scoped DBC.
        assert_eq!(name(2), None);
    }

    #[test]
    fn apply_filter_drops_records_that_dont_pass() {
        // Two records, same id, different buses. A `{bus: "p"}` filter
        // keeps the first only.
        let mut r1 = TraceFrameRecord::from_raw(0, &frame_with_data(256), None);
        r1.bus_id = Some("p".into());
        let mut r2 = TraceFrameRecord::from_raw(1, &frame_with_data(256), None);
        r2.bus_id = Some("c".into());
        let predicate: FilterPredicate =
            serde_json::from_str(r#"{"bus": "p"}"#).unwrap();
        let filtered = apply_filter_records(vec![r1.clone(), r2], Some(&predicate));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].bus_id.as_deref(), Some("p"));
    }

    #[test]
    fn apply_filter_none_returns_input_unchanged() {
        let r1 = TraceFrameRecord::from_raw(0, &frame_with_data(1), None);
        let r2 = TraceFrameRecord::from_raw(1, &frame_with_data(2), None);
        let v = apply_filter_records(vec![r1, r2], None);
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn route_channel_translates_via_mapping() {
        let m = vec![
            (0u8, Some("p".to_string())),
            (1, None), // explicit skip
            (2, Some("c".into())),
        ];
        assert_eq!(route_channel(0, &m), Ok(Some("p".into())));
        assert_eq!(route_channel(2, &m), Ok(Some("c".into())));
        assert_eq!(route_channel(1, &m), Err(()));
        // Channel without an entry: unassigned.
        assert_eq!(route_channel(7, &m), Ok(None));
    }

    #[test]
    fn unscoped_dbc_decodes_every_bus() {
        let state = test_state();
        let dbc = tiny_dbc(256, "Anywhere", "Sig");
        *state.databases.lock().unwrap() = vec![loaded("any.dbc", &dbc)];
        let mut on_p = frame_with_data(256);
        on_p.bus_id = Some("p".into());
        let unassigned = frame_with_data(256);
        state.trace_store.append(on_p);
        state.trace_store.append(unassigned);
        let r = collect_trace_records(&state, 0, 2);
        // Both decode against the unscoped DBC.
        assert_eq!(
            r[0].decoded.as_ref().map(|d| d.name.clone()).as_deref(),
            Some("Anywhere"),
        );
        assert_eq!(
            r[1].decoded.as_ref().map(|d| d.name.clone()).as_deref(),
            Some("Anywhere"),
        );
    }

    #[test]
    fn collect_trace_records_clamps_like_slice() {
        let state = test_state();
        for i in 0u32..10 {
            state.trace_store.append(dummy_frame(0, i));
        }
        // Oversized end: the trace-grew tail asks for `[count - TAIL, count)`,
        // and when there are fewer than TAIL frames the start saturates to 0.
        let tail = collect_trace_records(&state, 10u64.saturating_sub(TRACE_GREW_TAIL), 10);
        assert_eq!(tail.len(), 10);
        assert_eq!(tail.first().map(|r| r.index), Some(0));
        assert_eq!(tail.last().map(|r| r.index), Some(9));
        // Entirely past the end -> empty.
        assert!(collect_trace_records(&state, 20, 30).is_empty());
    }

    #[test]
    fn transmit_frame_inner_appends_tx_confirm_when_not_connected() {
        let state = test_state();
        let req = ipc::TransmitRequest {
            channel: 0,
            id: 0x123,
            extended: false,
            kind: ipc::TransmitKind::Classic,
            data: vec![1, 2, 3, 4],
            brs: false,
            esi: false,
            dlc: 0,
        };
        let result = transmit_frame_inner(&state, &req).unwrap();
        assert_eq!(result.tx_confirm_index, 0);
        assert!(
            matches!(result.wire_status, ipc::TransmitWireStatus::NotConnected),
            "expected NotConnected, got {:?}",
            result.wire_status,
        );
        // The trace store now has exactly one frame, with Direction::Tx
        // and the payload we asked for.
        assert_eq!(state.trace_store.len(), 1);
        let only = state.trace_store.slice(0, 1).pop().unwrap();
        assert_eq!(only.direction, Direction::Tx);
        assert_eq!(only.id, 0x123);
        assert!(matches!(&only.payload, CanFramePayload::Classic(d) if d == &[1, 2, 3, 4]));
    }

    #[test]
    fn transmit_frame_inner_rejects_invalid_id() {
        let state = test_state();
        let req = ipc::TransmitRequest {
            channel: 0,
            id: 0xFFFF,
            extended: false,
            kind: ipc::TransmitKind::Classic,
            data: vec![],
            brs: false,
            esi: false,
            dlc: 0,
        };
        assert!(transmit_frame_inner(&state, &req).is_err());
        // And the trace store was not appended to.
        assert_eq!(state.trace_store.len(), 0);
    }
}
