//! Cannet Tauri host. Wires the BLF / DBC stack and the
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

mod app_state;
mod capture;
mod crash;
mod dbc_commands;
mod emitters;
mod trace_query;
mod dbc_watcher;
mod diag;
// `filter` and `trace_store` are `pub` so the `cannet-perf-measurement` performance
// harness can drive the real host model — the same `TraceStore` and
// filter predicate the GUI runs — rather than reimplementing them and
// measuring a stand-in. `project` and `rbs` stay private (their
// `#[tauri::command]` fns reference the crate-private `AppState`); the
// harness only needs their file-model types, re-exported below.
pub mod filter;
mod interfaces;
// trace_store's `pub mod` (below) exposes its accessors as crate-public
// API for the harness; they `.expect` on an internally-upheld mutex
// invariant rather than a caller-reachable condition, so the pedantic
// panics/empty/default doc lints are suppressed here rather than
// papered over the whole module with boilerplate.
mod ipc;
mod licenses;
mod local_buses;
mod notes;
mod persisted_json;
mod project;
mod rbs;
mod session;
mod settings;
mod sampling;
mod sidecar;
mod state;
// `signal_cache` and `signal_sampler` are `pub` so the
// `cannet-perf-measurement` harness can drive the real per-signal
// decimation pyramid (ADR 0002 DS-5) — the same `SignalCacheStore`
// the GUI plots through — rather than measuring a stand-in. The
// mutex `.expect` is an internally-upheld invariant, so the pedantic
// missing-panics lint is suppressed here rather than papered over.
#[allow(clippy::missing_panics_doc, clippy::new_without_default)]
pub mod signal_cache;
pub mod signal_sampler;
mod signal_snapshot;
mod system_log;
#[allow(
    clippy::missing_panics_doc,
    clippy::new_without_default,
    clippy::len_without_is_empty
)]
pub mod trace_store;
mod transmit_commands;
mod transmit_frames;
mod transmit_scheduler;
mod verification;
mod window_state;

// File-model types the `cannet-perf-measurement` harness reuses, re-exported so the
// harness can parse the example project / RBS through the production
// types without the crate-private command modules they live in.
pub use project::{Project, PROJECT_SCHEMA_VERSION};
pub use rbs::{format_message_key, parse_message_key, RbsFile, RbsMessage, RbsValue};

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

use dbc_watcher::DbcWatcher;


use notes::{Note, NotesStore};
use signal_cache::SignalCacheStore;
use system_log::SystemLog;
use trace_store::TraceStore;

use app_state::AppState;
#[cfg(test)]
use std::collections::HashSet;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::time::Duration;
#[cfg(test)]
use cannet_core::CanFrameSource;
#[cfg(test)]
use cannet_dbc::Database;
#[cfg(test)]
use emitters::{should_emit_trace_grew, TRACE_GREW_TAIL};
#[cfg(test)]
use app_state::{invalidate_derived_caches, LoadedDbc};
#[cfg(test)]
use trace_store::RawTraceFrame;
#[cfg(test)]
use dbc_commands::decode_against;
#[cfg(test)]
use filter::FilterPredicate;
#[cfg(test)]
use ipc::{ByIdSnapshot, DecodedRecord, SignalSelection, SignalSnapshotRecord, TraceFrameRecord};
#[cfg(test)]
use session::{panic_message, route_channel, LocalSourceFrameSource, RemoteSession, SessionTx};
#[cfg(test)]
use transmit_commands::{
    group_wire_batches, next_tick_deadline, resolve_effective_calc, transmit_frame_inner,
};
use capture::{
    clear_trace_store, open_log, restore_scratch_capture, save_capture, scan_blf_channels,
};
#[cfg(test)]
use capture::{read_notes_from_blf, write_capture};
use dbc_commands::{
    add_dbc, clear_dbcs, decode_frame, describe_message, encode_frame, list_dbc_content,
    list_signals, list_value_tables, remove_dbc, set_dbc_buses,
};
#[cfg(test)]
use dbc_commands::{decode_frame_inner, describe_message_inner, encode_frame_inner};
pub(crate) use emitters::emit_system_log;
use emitters::{
    clear_system_log, fetch_system_log, gui_emit_system_log, spawn_trace_flusher,
    spawn_trace_grew_emitter,
};
use sampling::{sample_signals, signal_min_max};
use session::{connect_remote_server, disconnect_remote_server};
use transmit_commands::{
    clear_transmit_frames, fetch_field_validity, list_transmit_frames, remove_transmit_frame,
    reorder_transmit_frames, run_transmit_scheduler, set_transmit_frame, start_periodic_transmit,
    stop_periodic_transmit, transmit_frame_once,
};
use trace_query::{
    fetch_by_id_page, fetch_filtered_trace, fetch_signal_page, fetch_trace_range,
    filtered_positions_at_ns, frame_indices_at_ns,
};
#[cfg(test)]
use trace_query::{
    apply_filter_records, collect_trace_records, decode_candidate_ids, fetch_signal_page_inner,
    sort_by_id, windowed_filter_page, ActiveFilterIndex,
};





/// The build's version string: `git describe --tags` as captured by
/// `build.rs` (vergen), e.g. `v0.1.0` on a release tag or
/// `v0.1.0-3-gabc1234` for a build a few commits past one. Falls back to
/// the Cargo crate version when the binary was built outside a git
/// checkout (no `VERGEN_GIT_DESCRIBE` set).
fn build_version() -> &'static str {
    match option_env!("VERGEN_GIT_DESCRIBE") {
        Some(v) if !v.is_empty() && v != "VERGEN_IDEMPOTENT_OUTPUT" => v,
        _ => env!("CARGO_PKG_VERSION"),
    }
}

/// Report the running build's version for display in the About view.
#[tauri::command]
fn app_version() -> &'static str {
    build_version()
}

/// Record the frontend's current JS-heap size (bytes) for the health
/// recorder's log line. The host can't read the `WebView`'s V8 heap, so
/// the renderer pushes `performance.memory.usedJSHeapSize` here ~1 Hz;
/// pairing it with the host-measured `webview_mb` splits a JS-heap leak
/// from native/GPU growth. See `crash.rs`.
#[tauri::command]
fn report_js_heap(bytes: u64) {
    crash::record_js_heap(bytes);
}

/// The live disk-spill scratch directory: `<app cache dir>/current`
/// (ADR 0002 DS-7), where `<app cache dir>` is Tauri's `app_cache_dir()`
/// — `$XDG_CACHE_HOME/dev.cannet.app` on Linux and the per-OS
/// equivalents. Rooting under the app-identifier namespace keeps the
/// cache alongside the config (`app_config_dir`) and log (`app_log_dir`)
/// roots instead of a bare `cannet/` sibling. Created if absent. This is
/// the single working store location — ephemeral scratch, not an export
/// — wiped only when the session buffer is (Clear / Start), so a prior
/// session present at launch can be reloaded as a stopped historical
/// trace.
fn scratch_current_dir(app: &tauri::App) -> std::io::Result<std::path::PathBuf> {
    let base = app.path().app_cache_dir().map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("no app cache directory: {e}"),
        )
    })?;
    let dir = base.join("current");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Open the production trace store on the disk-spill backend rooted at
/// `scratch` (ADR 0002 DS-6: the disk store is the only production path).
/// Falls back to the in-RAM store — logging why — if the scratch dir can't
/// be resolved or the disk store can't be opened, so a capture still runs
/// (degraded to RAM-bounded) rather than the app failing to boot.
fn open_trace_store(scratch: std::io::Result<std::path::PathBuf>) -> Arc<TraceStore> {
    match scratch.and_then(|dir| TraceStore::new_disk(&dir)) {
        Ok(store) => Arc::new(store),
        Err(e) => {
            tracing::error!(
                "disk-spill scratch unavailable ({e}); falling back to the in-RAM store \
                 (capture is bounded by available RAM)"
            );
            Arc::new(TraceStore::new())
        }
    }
}

/// Push the windowed-ring scratch cap (ADR 0002 DS-8) from settings onto
/// the live trace store. Called at launch and after every settings change
/// so the cap takes effect without a restart.
pub(crate) fn apply_scratch_cap(app: &AppHandle) {
    // Raise a below-floor cap to the minimum (ADR 0002 DS-8): a smaller cap
    // can't be honored once the pre-allocated segment families are counted.
    let cap = settings::floored_scratch_cap(settings::get_settings(app.clone()).scratch_cap_bytes);
    app.state::<AppState>().trace_store.set_scratch_cap(cap);
}

/// The directory the live filter index roots in: a `filter/` subdir of the
/// disk-spill scratch (ADR 0002 DS-3/DS-7), or an OS-temp fallback if the
/// scratch is unavailable. Created if absent; failure to create is left to
/// `FilterIndex::new` to surface on first use.
fn filter_index_dir(scratch: Option<&std::path::Path>) -> std::path::PathBuf {
    let dir = match scratch {
        Some(s) => s.join("filter"),
        None => std::env::temp_dir().join("cannet").join("filter"),
    };
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// The directory the per-signal decimation pyramids spill into: a
/// `signals/` subdir of the disk-spill scratch (ADR 0002 DS-5/DS-7), or an
/// OS-temp fallback if the scratch is unavailable. `SignalCacheStore::new`
/// wipes it on construction (a pyramid is derived state).
fn signal_cache_dir(scratch: Option<&std::path::Path>) -> std::path::PathBuf {
    match scratch {
        Some(s) => s.join("signals"),
        None => std::env::temp_dir().join("cannet").join("signals"),
    }
}

/// Boot the Tauri runtime.
///
/// # Panics
/// Panics if the platform runtime fails to start (no display, missing
/// `WebView`, etc.) — there's no recovery path, so we surface the error
/// loudly rather than silently exiting.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::too_many_lines)]
pub fn run() {
    // Set up `tracing`'s `fmt` layer for stderr so dev logs still show
    // up alongside the in-process ring the System Messages panel
    // renders. Idempotent — safe to call again from tests.
    system_log::init_tracing_subscriber();
    // Persist a crash record on panic before any Tauri state exists — so
    // even an early-startup panic lands on disk. The companion flight
    // recorder (spawned in `setup`) and the System Messages mirror cover
    // the rest; uncatchable deaths (abort/OOM, stack overflow, native
    // crash) still leave the recorder's trail. See `crash.rs`.
    crash::install_panic_hook();
    // The transmit scheduler thread owns the receiver; the handle lives
    // on `AppState` so the IPC commands can push schedule changes. The
    // thread is spawned in `setup` (it needs the `AppHandle`).
    let (transmit_scheduler, transmit_sched_rx) = transmit_scheduler::channel();
    let transmit_sched_rx = std::sync::Mutex::new(Some(transmit_sched_rx));
    // Parse the self-driving perf flags (ADR 0031) once at startup; the
    // webview fetches the result via `diag_autostart` on boot. `None` on a
    // normal launch leaves boot behaviour untouched.
    let autostart = diag::AutomationConfig::from_args(std::env::args());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Persist the main window's size, position, and maximized /
        // fullscreen state across launches. The `setup` hook below runs
        // `window_state::ensure_on_screen` afterwards to recover a window
        // whose restored position landed off every connected monitor.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .manage(diag::HostMetrics::default())
        .manage(sidecar::SidecarState::default())
        .manage(interfaces::InterfacesState::default())
        .manage(diag::DiagState::default())
        .manage(diag::AutomationState(autostart))
        .invoke_handler(tauri::generate_handler![
            open_log,
            scan_blf_channels,
            add_dbc,
            remove_dbc,
            clear_dbcs,
            set_dbc_buses,
            fetch_trace_range,
            fetch_by_id_page,
            fetch_signal_page,
            fetch_filtered_trace,
            clear_trace_store,
            restore_scratch_capture,
            connect_remote_server,
            disconnect_remote_server,
            project::open_project,
            project::save_project,
            state::get_state,
            state::set_state,
            settings::get_settings,
            settings::set_settings,
            list_signals,
            list_dbc_content,
            sample_signals,
            signal_min_max,
            list_transmit_frames,
            set_transmit_frame,
            remove_transmit_frame,
            reorder_transmit_frames,
            clear_transmit_frames,
            transmit_frame_once,
            start_periodic_transmit,
            stop_periodic_transmit,
            list_value_tables,
            encode_frame,
            describe_message,
            decode_frame,
            fetch_system_log,
            clear_system_log,
            gui_emit_system_log,
            fetch_notes,
            add_note,
            rename_note,
            recolor_note,
            remove_note,
            clear_notes,
            frame_indices_at_ns,
            filtered_positions_at_ns,
            save_capture,
            sidecar::restart_sidecar,
            sidecar::get_sidecar_status,
            interfaces::get_interfaces,
            interfaces::watch_interfaces,
            interfaces::unwatch_interfaces,
            interfaces::refresh_interfaces,
            replay_local_virtual_buses,
            create_local_virtual_bus,
            drop_local_virtual_bus,
            attach_local_bus_bridge,
            detach_local_bus_bridge,
            list_local_bus_bridges,
            rbs::rbs_load,
            rbs::rbs_init,
            rbs::rbs_save_as,
            rbs::rbs_unload,
            rbs::rbs_sync_project_buses,
            rbs::rbs_set_run,
            rbs::rbs_set_kill_switch,
            rbs::rbs_set_enabled,
            rbs::rbs_set_period,
            rbs::rbs_set_signal,
            rbs::rbs_set_calc,
            rbs::rbs_save,
            rbs::rbs_dirty,
            rbs::rbs_view,
            rbs::rbs_crc_algorithms,
            fetch_field_validity,
            app_version,
            licenses::third_party_licenses,
            diag::diag_capture_start,
            diag::diag_push,
            diag::diag_capture_finish,
            diag::diag_autostart,
            report_js_heap,
        ])
        .setup(move |app| {
            // Resolve the disk-spill scratch (ADR 0002 DS-7) now that the
            // `AppHandle` exists, so it roots under Tauri's
            // `app_cache_dir()` (`<cache>/dev.cannet.app/current`) — the
            // same identifier namespace as the config and log dirs. The
            // trace store opens on the disk backend, or falls back to RAM
            // (logging why) if the cache dir can't be resolved or opened.
            // The filter index, signal pyramids, and notes hang off the
            // same scratch. `AppState` is managed here rather than on the
            // builder because that resolution needs the handle; no command
            // can run before `setup` returns, so it is in place for every
            // consumer (including `apply_scratch_cap` and the DBC watcher
            // below).
            let scratch = scratch_current_dir(app);
            let scratch_path = scratch.as_ref().ok().map(std::path::PathBuf::as_path);
            let filter_dir = filter_index_dir(scratch_path);
            let signal_dir = signal_cache_dir(scratch_path);
            let notes_dir = scratch_path.map(std::path::Path::to_path_buf);
            let trace_store = open_trace_store(scratch);
            app.manage(AppState {
                databases: Mutex::new(Vec::new()),
                remote_sessions: Mutex::new(HashMap::new()),
                trace_store,
                signal_caches: SignalCacheStore::new(signal_dir),
                system_log: SystemLog::new(),
                // Notes share the scratch `current/` dir with the trace
                // store's identity/derived files (ADR 0002 DS-7); they
                // persist on every edit, so a marker added to a stopped
                // trace survives reopen.
                notes: match notes_dir {
                    Some(p) => NotesStore::with_scratch(p),
                    None => NotesStore::new(),
                },
                dbc_watcher: Mutex::new(None),
                local_buses: local_buses::LocalBusRegistry::default(),
                transmit_frames: Mutex::new(transmit_frames::TransmitFrameRegistry::default()),
                transmit_scheduler,
                rbs: Mutex::new(rbs::RbsRuntime::default()),
                verifier: verification::VerificationState::default(),
                filter_index_dir: filter_dir,
                filter_index: Mutex::new(None),
                active_project_id: Mutex::new(None),
            });
            // Make sure the main window has the id our capabilities expect.
            // Tauri assigns "main" by default for the first window in the
            // config; we rely on that here.
            debug_assert!(app.get_webview_window("main").is_some());
            // The window-state plugin has restored the saved geometry by
            // now; pull a window whose title bar landed off-screen (a
            // disconnected monitor) back onto the primary monitor.
            if let Some(main) = app.get_webview_window("main") {
                window_state::ensure_on_screen(&main);
            }
            crash::spawn_health_recorder(app.handle().clone());
            spawn_trace_grew_emitter(app.handle().clone());
            spawn_trace_flusher(app.handle().clone());
            // Apply the persisted windowed-ring scratch cap (ADR 0002 DS-8)
            // so a flush honors it from the first tick.
            apply_scratch_cap(app.handle());
            // The single transmit scheduler thread drives every running
            // periodic. Takes ownership of the command
            // receiver created above.
            if let Some(rx) = transmit_sched_rx
                .lock()
                .expect("transmit scheduler rx mutex poisoned")
                .take()
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || run_transmit_scheduler(&handle, &rx));
            }
            sidecar::spawn_sidecar(app.handle());
            // Build the DBC filesystem watcher. Construction
            // is the only step that needs the `AppHandle` (the
            // watcher's event callback emits events / pushes system
            // log entries through it). Stored on `AppState` so the
            // DBC IPC commands can watch / unwatch paths.
            let watcher = DbcWatcher::new(app.handle());
            let state: State<'_, AppState> = app.state();
            *state
                .dbc_watcher
                .lock()
                .expect("dbc_watcher mutex poisoned") = Some(watcher);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running cannet")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Opt-in "clear scratch cache on exit" (Settings, ADR 0002
                // DS-7): wipe the session buffer so the prior session isn't
                // reloaded next launch. This is the same reset the Clear
                // command runs — it clears the live, still-mapped scratch in
                // place (dropping segments + manifest + identity/derived), so
                // no unmap dance is needed. Otherwise harden the scratch with
                // one synchronous flush, since the periodic flusher only
                // queues async writeback (ADR 0002 DS-2) and a power loss
                // right after quit could lose the trailing window.
                if settings::get_settings(app_handle.clone()).clear_scratch_on_exit {
                    clear_trace_store(app_handle.clone(), app_handle.state());
                } else if let Err(e) = app_handle.state::<AppState>().trace_store.flush() {
                    tracing::warn!(error = %e, "shutdown trace flush failed");
                }
            }
        });
}








/// Snapshot of the session-scoped notes, chronological.
/// Plot panels call this on mount to seed their event list and
/// reconcile against `notes-changed` events.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn fetch_notes(state: State<'_, AppState>) -> Vec<Note> {
    state.notes.snapshot()
}

/// Add a note to the session buffer. Emits `notes-changed`
/// with the new chronological snapshot on success. A duplicate `id`
/// is a no-op (idempotent against an event arriving twice).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn add_note(app: AppHandle, note: Note) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.add(note) {
        let _ = app.emit("notes-changed", applied.notes);
    }
}

/// Rename an existing note.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn rename_note(app: AppHandle, id: String, label: String) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.rename(&id, label) {
        let _ = app.emit("notes-changed", applied.notes);
    }
}


/// Recolour an existing note (ADR 0035): `Some("#RRGGBB")` to set, `null`
/// to clear back to the view default.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn recolor_note(app: AppHandle, id: String, color: Option<String>) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.recolor(&id, color) {
        let _ = app.emit("notes-changed", applied.notes);
    }
}

/// Remove a note from the session buffer.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn remove_note(app: AppHandle, id: String) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.remove(&id) {
        let _ = app.emit("notes-changed", applied.notes);
    }
}

/// Drop every note from the session buffer. Called by the
/// trace-store clear path so cleared captures lose their notes too.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn clear_notes(app: AppHandle) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.clear() {
        let _ = app.emit("notes-changed", applied.notes);
    }
}









// ------------------------------------------------------------------
// local-virtual-bus commands (ADR 0021)
// ------------------------------------------------------------------
//
// Lifecycle: the GUI calls [`replay_local_virtual_buses`] on every
// project open / new / close. Mid-session edits go through the
// `create_local_virtual_bus` / `drop_local_virtual_bus` /
// `attach_*` / `detach_*` commands for live updates.

/// Rebuild every host-side virtual-bus instance from the project's
/// definitions, and attach observers for each
/// `local-virtual-bus` binding (ADR 0021). Existing instances are
/// dropped first.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
// Returns `Result` for IPC-command uniformity even though replay only
// logs per-bus errors and always succeeds overall.
#[allow(clippy::unnecessary_wraps)]
fn replay_local_virtual_buses(
    app: AppHandle,
    state: State<'_, AppState>,
    defs: Vec<project::LocalVirtualBusDef>,
) -> Result<Vec<String>, String> {
    let errors = local_buses::replay(&state.local_buses, &defs);
    for err in &errors {
        sys_warn!(&app, "virtual-bus", "{err}");
    }
    let ids = state.local_buses.bus_ids();
    sys_info!(
        &app,
        "virtual-bus",
        "replayed {} local virtual bus(es)",
        ids.len(),
    );
    Ok(ids)
}

/// Create a virtual bus. The GUI calls this from the project
/// panel's *Add virtual bus* action. The vbus has no user-
/// configurable bitrate (see `LocalVirtualBusDef`); the host applies
/// a fixed default to `SharedBus` internally.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn create_local_virtual_bus(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    state
        .local_buses
        .create(&id, &name, local_buses::default_vbus_config())?;
    sys_info!(&app, "virtual-bus", "created virtual bus {id} ({name})");
    Ok(())
}

/// Drop a virtual bus by id. Every observer and bridge attached to
/// it tears down with it.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn drop_local_virtual_bus(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    if state.local_buses.drop_bus(&id) {
        sys_info!(&app, "virtual-bus", "dropped virtual bus {id}");
        Ok(())
    } else {
        Err(format!("no virtual bus {id:?}"))
    }
}

/// Attach a bridge to a virtual bus. The bridge opens a
/// `cannet-client` session against `spec.remote_address`. `allocates`
/// signals that the bridged interface is a virtual-bus factory id
/// (the client will wait for `InterfaceAllocated`).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn attach_local_bus_bridge(
    app: AppHandle,
    state: State<'_, AppState>,
    virtual_bus_id: String,
    spec: project::BridgeSpec,
    allocates: Option<bool>,
) -> Result<(), String> {
    state
        .local_buses
        .attach_bridge(&virtual_bus_id, &spec, allocates.unwrap_or(false))?;
    sys_info!(
        &app,
        "virtual-bus",
        "attached bridge {} on vbus {virtual_bus_id}",
        spec.name,
    );
    Ok(())
}

/// Detach a bridge from a virtual bus.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn detach_local_bus_bridge(
    app: AppHandle,
    state: State<'_, AppState>,
    virtual_bus_id: String,
    name: String,
) -> Result<bool, String> {
    let removed = state.local_buses.detach_bridge(&virtual_bus_id, &name)?;
    if removed {
        sys_info!(
            &app,
            "virtual-bus",
            "detached bridge {name} from vbus {virtual_bus_id}",
        );
    }
    Ok(removed)
}

/// Snapshot of every virtual bus's installed bridge names — the
/// GUI's project panel uses it as a readout.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_local_bus_bridges(state: State<'_, AppState>, virtual_bus_id: String) -> Vec<String> {
    state.local_buses.bridge_names(&virtual_bus_id)
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

    #[test]
    fn open_trace_store_uses_the_disk_backend_at_the_scratch_dir() {
        // Production opens the disk-spill store rooted at the scratch dir
        // (ADR 0002 DS-6): an append lands as on-disk segment files there,
        // proving the live store is disk-backed and not the in-RAM double.
        let root = tempfile::TempDir::new().unwrap();
        let dir = root.path().join("current");
        std::fs::create_dir_all(&dir).unwrap();
        let store = open_trace_store(Ok(dir.clone()));
        store.append(dummy_frame(1_000, 0x123));
        assert_eq!(store.len(), 1);
        let has_segments = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| {
                let n = e.file_name();
                let n = n.to_string_lossy();
                n.starts_with("meta.") || n.starts_with("payload.")
            });
        assert!(has_segments, "expected disk-spill segment files in {dir:?}");
    }

    #[test]
    fn open_trace_store_falls_back_to_in_ram_when_scratch_is_unavailable() {
        // A scratch dir that can't be resolved/opened must not down the app:
        // the store falls back to the in-RAM backend and a capture still runs.
        let store = open_trace_store(Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no cache dir",
        )));
        store.append(dummy_frame(1_000, 0x1));
        assert_eq!(store.len(), 1);
    }

    /// Serve a filtered page over a whole match set of `n` (positions
    /// `[0, n)`), returning `(count, page positions, start_match)` — the
    /// page is the position slice the index would read.
    fn fpage(n: usize, offset: u64, limit: u64, from_end: bool) -> (u64, Vec<usize>, u64) {
        let (count, pos, len, start) = windowed_filter_page(0, n, offset, limit, from_end);
        (count, (pos..pos + len).collect(), start)
    }

    #[test]
    fn windowed_filter_page_pages_a_forward_offset_limit_slice() {
        // 5 matches at positions 0..5; forward [1, 3) → positions 1, 2.
        let (count, page, start) = fpage(5, 1, 2, false);
        assert_eq!(count, 5);
        assert_eq!(page, vec![1, 2]);
        assert_eq!(start, 1);
    }

    #[test]
    fn windowed_filter_page_from_end_keeps_the_last_limit_matches() {
        let (count, page, start) = fpage(5, 0, 2, true);
        assert_eq!(count, 5);
        assert_eq!(page, vec![3, 4]);
        assert_eq!(start, 3); // count - page.len()
    }

    #[test]
    fn windowed_filter_page_limit_zero_counts_without_paging() {
        let (count, page, start) = fpage(5, 0, 0, false);
        assert_eq!(count, 5);
        assert!(page.is_empty());
        assert_eq!(start, 0);
    }

    #[test]
    fn windowed_filter_page_offset_past_the_end_is_an_empty_page() {
        let (count, page, start) = fpage(3, 99, 10, false);
        assert_eq!(count, 3);
        assert!(page.is_empty());
        assert_eq!(start, 3); // offset.min(count)
    }

    #[test]
    fn windowed_filter_page_from_end_fewer_matches_than_limit() {
        // Sparse window: fewer matches than the page cap → keep all,
        // anchored at match-index 0.
        let (count, page, start) = fpage(3, 0, 10, true);
        assert_eq!(count, 3);
        assert_eq!(page, vec![0, 1, 2]);
        assert_eq!(start, 0);
    }

    #[test]
    fn windowed_filter_page_sub_window_offsets_into_absolute_positions() {
        // A frame window mapping to match-positions [2, 7) (5 matches).
        // Forward [0, 3) within the window → absolute positions 2, 3, 4.
        let (count, pos, len, start) = windowed_filter_page(2, 7, 0, 3, false);
        assert_eq!(count, 5);
        assert_eq!((pos, len, start), (2, 3, 0));
        // from_end within the same window → last 2 → positions 5, 6.
        let (count, pos, len, start) = windowed_filter_page(2, 7, 0, 2, true);
        assert_eq!((count, pos, len, start), (5, 5, 2, 3));
    }

    #[test]
    fn windowed_filter_page_empty_or_inverted_window_is_zero() {
        // win_start past the tip (p_start > p_end via saturating_sub) → no
        // matches, empty page, regardless of direction.
        assert_eq!(windowed_filter_page(7, 2, 0, 5, false), (0, 7, 0, 0));
        assert_eq!(windowed_filter_page(7, 2, 0, 5, true), (0, 2, 0, 0));
    }

    // --- by-id host-side sort (former client `sortRows`) ---

    fn snap(id: u32, channel: u8, rate: f64, bus: Option<&str>) -> ByIdSnapshot {
        ByIdSnapshot {
            frame: TraceFrameRecord {
                index: 0,
                timestamp_seconds: 0.0,
                channel,
                id,
                extended: false,
                direction: "Rx",
                kind: ipc::CanFrameKind::Classic,
                data: vec![],
                decoded: None,
                bus_id: bus.map(Into::into),
                violation: None,
            },
            rate,
            count: 0,
        }
    }

    fn sorted_ids(
        rows: &[ByIdSnapshot],
        key: Option<&str>,
        dir: Option<&str>,
        names: &HashMap<String, String>,
    ) -> Vec<u32> {
        let mut v = rows.to_vec();
        sort_by_id(&mut v, key, dir, names);
        v.iter().map(|r| r.frame.id).collect()
    }

    #[test]
    fn sort_by_id_orders_by_a_column_stable_and_no_op_for_none() {
        let names = HashMap::new();
        let rows = [
            snap(0x200, 1, 0.0, None),
            snap(0x100, 0, 0.0, None),
            snap(0x100, 2, 0.0, None),
        ];
        // None key leaves the input order (the host default).
        assert_eq!(
            sorted_ids(&rows, None, None, &names),
            vec![0x200, 0x100, 0x100]
        );
        // Stable: the two 0x100 rows keep their input order (channels 0, 2).
        let mut v = rows.to_vec();
        sort_by_id(&mut v, Some("id"), Some("asc"), &names);
        assert_eq!(
            v.iter()
                .map(|r| (r.frame.id, r.frame.channel))
                .collect::<Vec<_>>(),
            vec![(0x100, 0), (0x100, 2), (0x200, 1)],
        );
        assert_eq!(
            sorted_ids(&rows, Some("id"), Some("desc"), &names),
            vec![0x200, 0x100, 0x100]
        );
    }

    #[test]
    fn sort_by_id_orders_by_rate() {
        let names = HashMap::new();
        let rows = [
            snap(0x100, 0, 5.0, None),
            snap(0x200, 0, 50.0, None),
            snap(0x300, 0, 0.5, None),
        ];
        assert_eq!(
            sorted_ids(&rows, Some("rate"), Some("asc"), &names),
            vec![0x300, 0x100, 0x200]
        );
        assert_eq!(
            sorted_ids(&rows, Some("rate"), Some("desc"), &names),
            vec![0x200, 0x100, 0x300]
        );
    }

    #[test]
    fn sort_by_id_orders_by_bus_name_unassigned_last() {
        // Sorts by the resolved bus *name*, with the unassigned bucket
        // after any real bus ascending (and before them descending).
        let names: HashMap<String, String> = [
            ("p".to_string(), "Powertrain".to_string()),
            ("c".to_string(), "Chassis".to_string()),
        ]
        .into_iter()
        .collect();
        let rows = [
            snap(0x100, 0, 0.0, Some("p")), // Powertrain
            snap(0x200, 0, 0.0, None),      // unassigned
            snap(0x300, 0, 0.0, Some("c")), // Chassis
        ];
        assert_eq!(
            sorted_ids(&rows, Some("bus"), Some("asc"), &names),
            vec![0x300, 0x100, 0x200]
        );
        assert_eq!(
            sorted_ids(&rows, Some("bus"), Some("desc"), &names),
            vec![0x200, 0x100, 0x300]
        );
    }

    #[test]
    fn sort_by_id_orders_by_ecu_no_transmitter_last() {
        // Sorts by the decoded message's transmitter, with undecoded /
        // no-sender rows after any real ECU ascending (mirrors "bus").
        let names = HashMap::new();
        let with_ecu = |mut s: ByIdSnapshot, tx: Option<&str>| {
            s.frame.decoded = Some(DecodedRecord {
                name: "M".to_string(),
                transmitter: tx.map(Into::into),
                signals: vec![],
            });
            s
        };
        let rows = [
            with_ecu(snap(0x100, 0, 0.0, None), Some("Zonal")),
            snap(0x200, 0, 0.0, None), // undecoded
            with_ecu(snap(0x300, 0, 0.0, None), Some("Bms")),
            with_ecu(snap(0x400, 0, 0.0, None), None), // Vector__XXX
        ];
        assert_eq!(
            sorted_ids(&rows, Some("ecu"), Some("asc"), &names),
            vec![0x300, 0x100, 0x200, 0x400],
        );
        assert_eq!(
            sorted_ids(&rows, Some("ecu"), Some("desc"), &names),
            vec![0x200, 0x400, 0x100, 0x300],
        );
    }

    /// A multiplexed message in the ev-zonal shape: a selector byte
    /// gating two per-mode fields, plus an unconditional field.
    const MUX_SNAPSHOT_DBC: &str = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: Zonal\n\n\
        BO_ 512 Modes: 8 Zonal\n\
        \x20SG_ Mux M : 0|8@1+ (1,0) [0|0] \"\" Zonal\n\
        \x20SG_ ModeA m0 : 8|16@1+ (1,0) [0|0] \"\" Zonal\n\
        \x20SG_ ModeB m1 : 8|16@1+ (0.5,0) [0|0] \"\" Zonal\n\
        \x20SG_ Always : 24|8@1+ (1,0) [0|0] \"\" Zonal\n";

    /// A `Modes` frame: selector byte + a little-endian 16-bit field +
    /// the unconditional byte.
    fn modes_frame(ts_ns: u64, sel: u8, field: u16, always: u8) -> RawTraceFrame {
        let [lo, hi] = field.to_le_bytes();
        RawTraceFrame {
            timestamp_ns: ts_ns,
            payload: CanFramePayload::Classic(vec![sel, lo, hi, always, 0, 0, 0, 0]),
            ..dummy_frame(ts_ns, 512)
        }
    }

    fn mux_snapshot_state() -> AppState {
        let state = test_state();
        state
            .databases
            .lock()
            .unwrap()
            .push(loaded("modes.dbc", MUX_SNAPSHOT_DBC));
        // What add_dbc does after a DBC-set change — installs the
        // trace store's mux-selector extractor.
        invalidate_derived_caches(&state);
        state
    }

    fn fetch_all_signals(state: &AppState, end: u64) -> Vec<SignalSnapshotRecord> {
        let sel = SignalSelection {
            keys: vec![],
            patterns: vec!["^/Zonal/Modes/".to_string()],
        };
        fetch_signal_page_inner(state, &sel, 0, end, None, None, vec![], &[], None, 0, 100)
            .expect("valid pattern")
            .rows
    }

    #[test]
    fn fetch_signal_page_scopes_to_source_buses() {
        // A signal view is a sink with `sources` wiring: restricted to
        // specific buses, descriptors outside them (including the
        // unassigned-bus degenerate) don't exist for it.
        let state = mux_snapshot_state();
        let sel = SignalSelection {
            keys: vec![],
            patterns: vec![".".to_string()],
        };
        let page = fetch_signal_page_inner(
            &state,
            &sel,
            0,
            u64::MAX,
            None,
            None,
            vec![],
            &[],
            Some(&["powertrain".to_string()]),
            0,
            100,
        )
        .unwrap();
        assert_eq!(page.count, 0); // fixture descriptors are unassigned-bus
        let unrestricted = fetch_signal_page_inner(
            &state,
            &sel,
            0,
            u64::MAX,
            None,
            None,
            vec![],
            &[],
            None,
            0,
            100,
        )
        .unwrap();
        assert_eq!(unrestricted.count, 4);
    }

    #[test]
    fn fetch_signal_page_holds_every_mux_group_simultaneously() {
        // The Task-20 stress case: decoding only the message's latest
        // frame would blank every mux group but the last one seen. Each
        // group must hold its own latest value at the same time.
        let state = mux_snapshot_state();
        state
            .trace_store
            .append(modes_frame(1_000_000_000, 0, 0x1234, 5));
        state
            .trace_store
            .append(modes_frame(2_000_000_000, 1, 0x5678, 9));
        let rows = fetch_all_signals(&state, u64::MAX);
        let by_name = |n: &str| rows.iter().find(|r| r.signal_name == n).unwrap();
        assert_eq!(rows.len(), 4); // Always, ModeA, ModeB, Mux — all present
                                   // Both groups hold values simultaneously, each from *its* frame.
        let mode_a = by_name("ModeA");
        assert_eq!(mode_a.value, Some(f64::from(0x1234u16)));
        assert_eq!(mode_a.count, Some(1));
        assert_eq!(mode_a.time_seconds, Some(1.0));
        let mode_b = by_name("ModeB");
        assert_eq!(mode_b.value, Some(f64::from(0x5678u16) * 0.5));
        assert_eq!(mode_b.count, Some(1));
        assert_eq!(mode_b.time_seconds, Some(2.0));
        // Plain signals ride the message's latest frame + statistics.
        let always = by_name("Always");
        assert_eq!(always.value, Some(9.0));
        assert_eq!(always.count, Some(2));
        assert_eq!(always.transmitter.as_deref(), Some("Zonal"));
    }

    #[test]
    fn fetch_signal_page_bounds_mux_groups_to_the_window() {
        let state = mux_snapshot_state();
        state
            .trace_store
            .append(modes_frame(1_000_000_000, 0, 0x1234, 5)); // idx 0
        state
            .trace_store
            .append(modes_frame(2_000_000_000, 1, 0x5678, 9)); // idx 1
                                                               // Window [0, 1): only the selector-0 frame is visible.
        let rows = fetch_all_signals(&state, 1);
        let by_name = |n: &str| rows.iter().find(|r| r.signal_name == n).unwrap();
        assert_eq!(rows.len(), 4); // blank rows stay present
        assert_eq!(by_name("ModeA").value, Some(f64::from(0x1234u16)));
        let mode_b = by_name("ModeB");
        assert_eq!(mode_b.value, None);
        assert_eq!(mode_b.count, None);
        assert_eq!(by_name("Always").value, Some(5.0)); // not the later 9
    }

    #[test]
    fn fetch_signal_page_lists_never_seen_descriptors_as_blank_rows() {
        // An empty capture still yields one row per selected
        // descriptor — a dashboard's dead-ECU rows must not vanish.
        let state = mux_snapshot_state();
        let rows = fetch_all_signals(&state, u64::MAX);
        assert_eq!(rows.len(), 4);
        assert!(rows.iter().all(|r| r.value.is_none() && r.count.is_none()));
    }

    #[test]
    fn fetch_signal_page_pages_and_sorts_host_side() {
        let state = mux_snapshot_state();
        state
            .trace_store
            .append(modes_frame(1_000_000_000, 0, 40, 5));
        let sel = SignalSelection {
            keys: vec![],
            patterns: vec!["^/Zonal/Modes/".to_string()],
        };
        // Sort by value ascending: Mux(0), Always(5), ModeA(40), then
        // blank ModeB last; page [1, 3) of that order.
        let page = fetch_signal_page_inner(
            &state,
            &sel,
            0,
            u64::MAX,
            Some("value"),
            Some("asc"),
            vec![],
            &[],
            None,
            1,
            2,
        )
        .unwrap();
        assert_eq!(page.count, 4);
        assert_eq!(page.start, 1);
        let names: Vec<&str> = page.rows.iter().map(|r| r.signal_name.as_str()).collect();
        assert_eq!(names, vec!["Always", "ModeA"]);
    }

    #[test]
    fn decode_against_carries_the_transmitter() {
        let db = Database::parse(&tiny_dbc(0x100, "M", "S")).unwrap();
        let dbs = vec![LoadedDbc {
            path: "t.dbc".into(),
            db: Arc::new(db),
            buses: Vec::new(),
        }];
        let decoded = decode_against(&dbs, &frame_with_data(0x100)).unwrap();
        assert_eq!(decoded.transmitter.as_deref(), Some("ECU"));
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

    pub(crate) fn test_state() -> AppState {
        // A process-unique signals dir so concurrently-running tests don't
        // share (and wipe) each other's pyramid files.
        static SIGNALS_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = SIGNALS_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let signals_dir = std::env::temp_dir().join(format!("cannet-test-signals-{n}"));
        AppState {
            databases: Mutex::new(Vec::new()),
            remote_sessions: Mutex::new(HashMap::new()),
            trace_store: Arc::new(TraceStore::new()),
            signal_caches: SignalCacheStore::new(signals_dir),
            system_log: SystemLog::new(),
            notes: NotesStore::new(),
            dbc_watcher: Mutex::new(None),
            local_buses: local_buses::LocalBusRegistry::default(),
            transmit_frames: Mutex::new(transmit_frames::TransmitFrameRegistry::default()),
            // Tests don't run the scheduler thread; the dropped receiver
            // makes `start`/`stop` best-effort no-ops, which is fine —
            // the registry's `running` state is what the tests assert.
            transmit_scheduler: transmit_scheduler::channel().0,
            rbs: Mutex::new(rbs::RbsRuntime::default()),
            verifier: verification::VerificationState::default(),
            filter_index_dir: std::env::temp_dir().join("cannet-test-filter"),
            filter_index: Mutex::new(None),
            active_project_id: Mutex::new(None),
        }
    }

    /// A minimal vbus-flavoured session for exercising the session-map
    /// seam without gRPC machinery.
    fn seam_session(sinks: Vec<(u8, std::sync::Arc<std::sync::Mutex<cannet_core::LocalSink>>)>) -> RemoteSession {
        RemoteSession {
            handle: None,
            tx: SessionTx::Vbus(sinks),
            channel_to_interface: vec![(0, project::LOCAL_VBUS_INTERFACE.into())],
            channel_to_bus: vec![(0, Some("p".into()))],
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn register_session_hints_routes_changed_and_rejects_duplicates() {
        let (sched, rx) = transmit_scheduler::channel();
        let mut state = test_state();
        state.transmit_scheduler = sched;

        state
            .register_session("addr".into(), seam_session(Vec::new()))
            .unwrap();
        // A successful register hints the scheduler exactly once, so
        // parked periodics can resume without waiting for the probe.
        assert_eq!(
            rx.try_recv().unwrap(),
            transmit_scheduler::SchedulerCmd::RoutesChanged
        );

        let err = state
            .register_session("addr".into(), seam_session(Vec::new()))
            .unwrap_err();
        assert!(err.contains("already connected"), "got: {err}");
        assert!(
            rx.try_recv().is_err(),
            "a rejected register must not hint routes-changed"
        );
        // The original entry survives the rejected duplicate.
        assert!(state.remote_sessions.lock().unwrap().contains_key("addr"));
    }

    #[test]
    fn unregister_sessions_removes_one_or_all() {
        let state = test_state();
        state
            .register_session("a".into(), seam_session(Vec::new()))
            .unwrap();
        state
            .register_session("b".into(), seam_session(Vec::new()))
            .unwrap();

        let removed = state.unregister_sessions(Some("a"));
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].0, "a");

        let removed = state.unregister_sessions(None);
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].0, "b");
        assert!(state.remote_sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn remove_vbus_session_if_dead_keeps_live_sessions() {
        let state = test_state();
        state
            .local_buses
            .create("vbus", "v", cannet_core::BusConfig::classic_500k())
            .unwrap();
        let (sink, _source) = state.local_buses.attach_participant("vbus").unwrap();

        // Live vbus session (one sink left): kept.
        state
            .register_session(
                "live".into(),
                seam_session(vec![(0, std::sync::Arc::new(std::sync::Mutex::new(sink)))]),
            )
            .unwrap();
        assert!(!state.remove_vbus_session_if_dead("live"));
        assert!(state.remote_sessions.lock().unwrap().contains_key("live"));

        // Dead vbus session (no sinks): removed.
        state
            .register_session("dead".into(), seam_session(Vec::new()))
            .unwrap();
        assert!(state.remove_vbus_session_if_dead("dead"));
        assert!(!state.remote_sessions.lock().unwrap().contains_key("dead"));

        // Absent entry counts as dead (pumps may race teardown).
        assert!(state.remove_vbus_session_if_dead("gone"));
    }

    pub(crate) fn loaded(path: &str, dbc_text: &str) -> LoadedDbc {
        LoadedDbc {
            path: path.into(),
            db: Arc::new(Database::parse(dbc_text).expect("test DBC parses")),
            buses: Vec::new(),
        }
    }

    pub(crate) fn loaded_scoped(path: &str, dbc_text: &str, buses: &[&str]) -> LoadedDbc {
        LoadedDbc {
            path: path.into(),
            db: Arc::new(Database::parse(dbc_text).expect("test DBC parses")),
            buses: buses.iter().map(|s| (*s).into()).collect(),
        }
    }

    #[test]
    fn dbc_set_change_invalidates_stale_derived_caches() {
        // A signal cache built while the DBC was absent advances its decode
        // cursor to the store tip; without invalidation a DBC loaded later
        // never back-fills (`catch_up` finds no new frames), so a stopped,
        // reloaded capture's plot and filtered view stay empty. Regression
        // for the DBC-arrives-late gap (ADR 0033).
        let state = test_state();
        // Ten 8-byte id-256 frames the DBC's byte-0 signal `S` decodes, at
        // distinct timestamps so they form a real series.
        for i in 0..10u8 {
            let mut f = frame_with_data(256);
            f.timestamp_ns = u64::from(i) * 1_000_000_000;
            if let CanFramePayload::Classic(ref mut d) = f.payload {
                d[0] = i;
            }
            state.trace_store.append(f);
        }
        let slice = |dbs: &[&Database]| {
            state.signal_caches.slice(
                None,
                256,
                false,
                "S",
                0.0,
                100.0,
                0,
                &state.trace_store,
                dbs,
            )
        };
        // Serve with NO DBC loaded: the cache catches up empty and pins its
        // decode cursor at the tip.
        assert!(slice(&[]).is_empty(), "no DBC -> nothing decodes");

        // The DBC arrives; plant an active filter index too (a filtered view
        // would have one) so we can see it reset.
        let db = Database::parse(&tiny_dbc(256, "Msg", "S")).unwrap();
        let fi_dir = std::env::temp_dir().join(format!("cannet-inval-fi-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&fi_dir).unwrap();
        *state.filter_index.lock().unwrap() = Some(ActiveFilterIndex {
            predicate: serde_json::from_str(r#"{"bus": "p"}"#).unwrap(),
            session_start_ns: 0,
            index: cannet_spill::FilterIndex::new(&fi_dir).unwrap(),
        });

        invalidate_derived_caches(&state);

        assert!(
            state.filter_index.lock().unwrap().is_none(),
            "filter index reset on DBC change"
        );
        // The rebuilt cache now decodes the whole series.
        assert_eq!(
            slice(&[&db]).len(),
            10,
            "DBC now back-fills the full series"
        );
        std::fs::remove_dir_all(&fi_dir).ok();
    }

    #[test]
    fn collect_trace_records_uses_absolute_indices() {
        let state = test_state();
        for i in 0u32..10 {
            state
                .trace_store
                .append(dummy_frame(u64::from(i) * 1_000, i));
        }
        let mid = collect_trace_records(&state, 3, 6);
        assert_eq!(
            mid.iter().map(|r| r.index).collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
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
            r[2].decoded
                .as_ref()
                .map(|d| d.signals[0].name.clone())
                .as_deref(),
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
    fn decode_candidates_resolve_name_and_signal_leaves_to_ids() {
        let dbs = vec![
            loaded("a.dbc", &tiny_dbc(256, "String1JustDetectedFault", "Sa")),
            loaded("b.dbc", &tiny_dbc(512, "BrakeStatus", "Rpm")),
        ];
        let parse = |t: &str| serde_json::from_str::<FilterPredicate>(t).unwrap();

        // Name leaf: only the message whose name matches contributes.
        let by_name =
            decode_candidate_ids(&dbs, &parse(r#"{"name_regex": "String1JustDetected.*?"}"#));
        assert_eq!(by_name, HashSet::from([256]));

        // Signal leaf: only the message carrying the signal contributes.
        let by_sig = decode_candidate_ids(
            &dbs,
            &parse(r#"{"signal_equals": {"name": "Rpm", "value": 1}}"#),
        );
        assert_eq!(by_sig, HashSet::from([512]));

        // Composition unions the leaves; raw-only predicates resolve empty.
        let both = decode_candidate_ids(
            &dbs,
            &parse(
                r#"{"any": [{"name_regex": "^String1"}, {"signal_equals": {"name": "Rpm", "value": 1}}]}"#,
            ),
        );
        assert_eq!(both, HashSet::from([256, 512]));
        assert!(decode_candidate_ids(&dbs, &parse(r#"{"id_list": [256]}"#)).is_empty());
    }

    #[test]
    fn filtered_scan_with_candidate_gating_matches_unconditional_decode() {
        // The candidate gate must be invisible in the results: a scan
        // that decodes only candidate ids returns exactly what a scan
        // decoding every frame returns.
        let dbs = vec![
            loaded("a.dbc", &tiny_dbc(256, "String1JustDetectedFault", "Sa")),
            loaded("b.dbc", &tiny_dbc(512, "BrakeStatus", "Sb")),
        ];
        let filter: FilterPredicate =
            serde_json::from_str(r#"{"name_regex": "String1JustDetected.*?"}"#).unwrap();
        let frames: Vec<RawTraceFrame> = [256, 512, 999, 256]
            .iter()
            .map(|&id| frame_with_data(id))
            .collect();

        let candidates = decode_candidate_ids(&dbs, &filter);
        let gated: Vec<bool> = frames
            .iter()
            .map(|f| {
                let decoded = if candidates.contains(&f.id) {
                    decode_against(&dbs, f)
                } else {
                    None
                };
                filter.matches(f, decoded.as_ref())
            })
            .collect();
        let unconditional: Vec<bool> = frames
            .iter()
            .map(|f| filter.matches(f, decode_against(&dbs, f).as_ref()))
            .collect();
        assert_eq!(gated, unconditional);
        assert_eq!(gated, vec![true, false, false, true]);
    }

    #[test]
    fn apply_filter_drops_records_that_dont_pass() {
        // Two records, same id, different buses. A `{bus: "p"}` filter
        // keeps the first only.
        let mut r1 = TraceFrameRecord::from_raw(0, &frame_with_data(256), None);
        r1.bus_id = Some("p".into());
        let mut r2 = TraceFrameRecord::from_raw(1, &frame_with_data(256), None);
        r2.bus_id = Some("c".into());
        let predicate: FilterPredicate = serde_json::from_str(r#"{"bus": "p"}"#).unwrap();
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
    fn panic_message_extracts_str_and_string_payloads() {
        let p = std::panic::catch_unwind(|| panic!("plain str")).unwrap_err();
        assert_eq!(panic_message(p.as_ref()), "plain str");
        let p = std::panic::catch_unwind(|| panic!("formatted {}", 42)).unwrap_err();
        assert_eq!(panic_message(p.as_ref()), "formatted 42");
        let p = std::panic::catch_unwind(|| std::panic::panic_any(7u32)).unwrap_err();
        assert_eq!(panic_message(p.as_ref()), "non-string panic payload");
    }

    #[test]
    fn trace_grew_skips_only_when_count_and_rate_are_unchanged() {
        // First tick (nothing emitted yet) always emits.
        assert!(should_emit_trace_grew(None, (0, 0.0)));
        // Idle: count frozen and the rate has fully decayed to 0.0 — skip.
        assert!(!should_emit_trace_grew(Some((10, 0.0)), (10, 0.0)));
        // New frames landed — emit.
        assert!(should_emit_trace_grew(Some((10, 0.0)), (11, 0.0)));
        // Count steady but the rate is still decaying (a different read) — emit.
        assert!(should_emit_trace_grew(Some((10, 5.0)), (10, 4.5)));
        // Capture cleared (count dropped) — emit.
        assert!(should_emit_trace_grew(Some((10, 5.0)), (0, 0.0)));
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
    fn describe_message_inner_finds_standard_and_extended_ids() {
        let state = test_state();
        let standard_dbc = tiny_dbc(0x100, "Std", "Sig");
        // DBC's on-disk BO_ id needs bit 31 set to mark it extended
        // (`can-dbc`'s `MessageId::Extended`); `message_id_parts` masks
        // it back off, so lookups use the plain 0x001A_BCDE id.
        let extended_dbc = tiny_dbc(0x001A_BCDE | 0x8000_0000, "Ext", "Sig");
        *state.databases.lock().unwrap() = vec![
            loaded("std.dbc", &standard_dbc),
            loaded("ext.dbc", &extended_dbc),
        ];

        let std_desc = describe_message_inner(&state, 0x100, false).unwrap();
        assert_eq!(std_desc.name, "Std");

        let ext_desc = describe_message_inner(&state, 0x001A_BCDE, true).unwrap();
        assert_eq!(ext_desc.name, "Ext");

        // The extended id's raw value doesn't collide with a standard
        // lookup at the same message table.
        assert!(describe_message_inner(&state, 0x001A_BCDE, false).is_none());
    }

    #[test]
    fn decode_frame_inner_decodes_standard_and_extended_ids() {
        let state = test_state();
        let standard_dbc = tiny_dbc(0x100, "Std", "Sig");
        // DBC's on-disk BO_ id needs bit 31 set to mark it extended
        // (`can-dbc`'s `MessageId::Extended`); `message_id_parts` masks
        // it back off, so lookups use the plain 0x001A_BCDE id.
        let extended_dbc = tiny_dbc(0x001A_BCDE | 0x8000_0000, "Ext", "Sig");
        *state.databases.lock().unwrap() = vec![
            loaded("std.dbc", &standard_dbc),
            loaded("ext.dbc", &extended_dbc),
        ];
        let data = vec![42u8, 0, 0, 0, 0, 0, 0, 0];

        let std_decoded = decode_frame_inner(&state, 0x100, false, &data).unwrap();
        assert_eq!(std_decoded.name, "Std");

        let ext_decoded = decode_frame_inner(&state, 0x001A_BCDE, true, &data).unwrap();
        assert_eq!(ext_decoded.name, "Ext");
    }

    #[test]
    fn encode_frame_inner_writes_signal_bits_through_first_matching_dbc() {
        // Two-byte signal `Sig` lives in byte 0 (factor 1, offset 0).
        // Encoding physical=42 writes byte 0 = 42 and leaves the rest
        // of base alone.
        let state = test_state();
        let dbc = tiny_dbc(256, "M", "Sig");
        *state.databases.lock().unwrap() = vec![loaded("any.dbc", &dbc)];
        let base = vec![0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11];
        let resp = encode_frame_inner(
            &state,
            256,
            false,
            &[ipc::EncodeFrameSignal {
                name: "Sig".into(),
                physical: 42.0,
            }],
            base,
        )
        .unwrap();
        assert!(resp.skipped.is_empty());
        assert_eq!(resp.bytes[0], 42);
        // Bytes 1..8 preserved.
        assert_eq!(
            &resp.bytes[1..],
            &[0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11]
        );
    }

    #[test]
    fn encode_frame_inner_reports_unknown_signal_in_skipped() {
        let state = test_state();
        let dbc = tiny_dbc(256, "M", "Sig");
        *state.databases.lock().unwrap() = vec![loaded("any.dbc", &dbc)];
        let resp = encode_frame_inner(
            &state,
            256,
            false,
            &[ipc::EncodeFrameSignal {
                name: "NotThere".into(),
                physical: 0.0,
            }],
            vec![0u8; 8],
        )
        .unwrap();
        assert_eq!(resp.skipped.len(), 1);
        assert_eq!(resp.skipped[0].name, "NotThere");
        assert_eq!(resp.skipped[0].reason, "signal_not_found");
    }

    #[test]
    fn encode_frame_inner_errors_when_no_dbc_matches() {
        let state = test_state();
        // No DBCs loaded.
        let err = encode_frame_inner(&state, 0x123, false, &[], vec![0u8; 8]).unwrap_err();
        assert!(err.contains("no DBC matches"));
    }

    #[test]
    fn transmit_frame_inner_appends_tx_confirm_when_not_connected() {
        let state = test_state();
        let req = ipc::TransmitRequest {
            bus_id: "p".into(),
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
    fn transmit_frame_inner_routes_through_local_virtual_bus_session() {
        // Two project buses ("p", "q") bound to the same vbus, with
        // an in-process session open against `local-vbus://vbus`.
        // Transmit on "p"; the tx-confirm appends to "p"'s trace
        // immediately, and the SharedBus fans the frame out to "q"'s
        // participant as a Direction::Rx copy. We don't spawn the
        // pump threads here — we drain the LocalSource manually to
        // assert the routing without depending on thread timing.
        let state = test_state();
        state
            .local_buses
            .create("vbus", "v", cannet_core::BusConfig::classic_500k())
            .unwrap();
        let (sink_p, _source_p) = state.local_buses.attach_participant("vbus").unwrap();
        let (_sink_q, mut source_q) = state.local_buses.attach_participant("vbus").unwrap();

        let session = RemoteSession {
            handle: None,
            tx: SessionTx::Vbus(vec![(
                0,
                std::sync::Arc::new(std::sync::Mutex::new(sink_p)),
            )]),
            channel_to_interface: vec![(0, project::LOCAL_VBUS_INTERFACE.into())],
            channel_to_bus: vec![(0, Some("p".into()))],
            stop: Arc::new(AtomicBool::new(false)),
        };
        state
            .remote_sessions
            .lock()
            .unwrap()
            .insert(format!("{}vbus", project::LOCAL_VBUS_URL_SCHEME), session);

        let req = ipc::TransmitRequest {
            bus_id: "p".into(),
            id: 0x321,
            extended: false,
            kind: ipc::TransmitKind::Classic,
            data: vec![9, 8, 7],
            brs: false,
            esi: false,
            dlc: 0,
        };
        let result = transmit_frame_inner(&state, &req).unwrap();
        assert!(
            matches!(result.wire_status, ipc::TransmitWireStatus::Sent { .. }),
            "expected Sent, got {:?}",
            result.wire_status,
        );

        // Tx-confirm landed in the trace store for bus "p".
        assert_eq!(state.trace_store.len(), 1, "expected tx-confirm row");
        let confirm = state.trace_store.slice(0, 1).pop().unwrap();
        assert_eq!(confirm.bus_id.as_deref(), Some("p"));
        assert_eq!(confirm.direction, Direction::Tx);
        assert_eq!(confirm.id, 0x321);

        // The fan-out is delivered to "q"'s LocalSource. Wait briefly
        // for the SharedBus's arbitration worker to run.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let frame_q = loop {
            match source_q.try_next() {
                Ok(Some(cannet_core::ParticipantEvent::Frame { frame, .. })) => break frame,
                Ok(_) => {}
                Err(e) => panic!("q's participant detached unexpectedly: {e:?}"),
            }
            assert!(
                std::time::Instant::now() < deadline,
                "vbus fan-out never arrived on q"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert_eq!(frame_q.direction, Direction::Rx);
        assert_eq!(frame_q.id.raw(), 0x321);
    }

    /// A frame sent through the transmit panel should land in the
    /// signal cache for a plot panel scoped to the same bus — the
    /// tx-confirm is the only record on the sending bus (the wire
    /// fan-out goes elsewhere), so a plot of "what I just sent on
    /// bus X" must include `Direction::Tx` rows.
    #[test]
    fn tx_confirm_is_visible_via_sample_signals_signal_cache() {
                let state = test_state();

        // One-message DBC: id 0x123, 8-bit signal "Sig" at byte 0.
        let dbc_text = tiny_dbc(0x123, "Msg", "Sig");
        state
            .databases
            .lock()
            .unwrap()
            .push(loaded("test.dbc", &dbc_text));

        // Transmit a frame on bus "p" with payload [42, ...]. No
        // session is required for the tx-confirm row to land.
        let req = ipc::TransmitRequest {
            bus_id: "p".into(),
            id: 0x123,
            extended: false,
            kind: ipc::TransmitKind::Classic,
            data: vec![42, 0, 0, 0, 0, 0, 0, 0],
            brs: false,
            esi: false,
            dlc: 0,
        };
        transmit_frame_inner(&state, &req).unwrap();

        // One tx-confirm row, Direction::Tx, bus_id "p".
        assert_eq!(state.trace_store.len(), 1);
        let row = state.trace_store.slice(0, 1).pop().unwrap();
        assert_eq!(row.direction, Direction::Tx);
        assert_eq!(row.bus_id.as_deref(), Some("p"));

        // The signal cache for `(bus=p, id=0x123, "Sig")` must include
        // the tx-confirm's decoded value (42).
        let dbs_guard = state.databases.lock().unwrap();
        let db_refs: Vec<&Database> = dbs_guard.iter().map(|l| l.db.as_ref()).collect();
        let samples = state.signal_caches.slice(
            Some("p"),
            0x123,
            false,
            "Sig",
            0.0,
            f64::MAX,
            0,
            &state.trace_store,
            &db_refs,
        );
        assert!(
            samples.iter().any(|p| (p.value - 42.0).abs() < 1e-9),
            "expected tx-confirm decoded as Sig=42 in signal cache; got {samples:?}",
        );
    }

    /// The user's actual scenario: two project buses ("p", "q") both
    /// bound to the same vbus. Transmit a frame on "p" through the
    /// host's transmit-frame command (so the tx-confirm appends to
    /// the trace store as `Direction::Tx` with `bus_id` "p", and the
    /// `SharedBus` fans the frame out to "q"'s participant; a pump
    /// stamps the fan-out copy with `bus_id` "q" and `Direction::Rx`).
    /// A plot scoped to *either* bus must then find the decoded
    /// signal in its signal cache — Tx for "p", Rx for "q".
    #[test]
    #[allow(clippy::too_many_lines)]
    fn full_vbus_session_tx_decodes_for_sender_and_receiver_plots() {
                let state = test_state();

        let dbc_text = tiny_dbc(0x456, "Msg", "Sig");
        state
            .databases
            .lock()
            .unwrap()
            .push(loaded("test.dbc", &dbc_text));

        // Set up the vbus and two participants the way
        // `connect_local_vbus` does — one per project bus.
        state
            .local_buses
            .create("vbus", "v", cannet_core::BusConfig::classic_500k())
            .unwrap();
        let (sink_p, _source_p) = state.local_buses.attach_participant("vbus").unwrap();
        let (_sink_q, source_q) = state.local_buses.attach_participant("vbus").unwrap();

        // Spawn the rx pump for "q" — mirrors the per-participant
        // pump `connect_local_vbus` spawns. `LocalSourceFrameSource`
        // forces frame.channel = self.channel; `run_pump` then
        // stamps `bus_id` via `route_channel`. We splice both in
        // manually here so the test doesn't need an `AppHandle`.
        let store_for_pump = state.trace_store.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_pump = stop.clone();
        let pump = std::thread::spawn(move || {
            let mut adapter = LocalSourceFrameSource {
                source: source_q,
                channel: 1,
            };
            let channel_to_bus = vec![(1u8, Some("q".to_string()))];
            while !stop_for_pump.load(Ordering::Relaxed) {
                let Some(frame) = cannet_core::CanFrameSource::next_frame(&mut adapter)
                    .ok()
                    .flatten()
                else {
                    break;
                };
                let mut raw = RawTraceFrame::from(frame);
                if let Ok(bid) = route_channel(raw.channel, &channel_to_bus) {
                    raw.bus_id = bid;
                    store_for_pump.append(raw);
                }
            }
        });

        // Register a vbus session with `p` on channel 0 (the only
        // sink the transmit path uses).
        let session = RemoteSession {
            handle: None,
            tx: SessionTx::Vbus(vec![(
                0,
                std::sync::Arc::new(std::sync::Mutex::new(sink_p)),
            )]),
            channel_to_interface: vec![
                (0, project::LOCAL_VBUS_INTERFACE.into()),
                (1, project::LOCAL_VBUS_INTERFACE.into()),
            ],
            channel_to_bus: vec![(0, Some("p".into())), (1, Some("q".into()))],
            stop: Arc::new(AtomicBool::new(false)),
        };
        state
            .remote_sessions
            .lock()
            .unwrap()
            .insert(format!("{}vbus", project::LOCAL_VBUS_URL_SCHEME), session);

        // Transmit on bus "p" — payload [7, …] decodes as Sig = 7.
        let req = ipc::TransmitRequest {
            bus_id: "p".into(),
            id: 0x456,
            extended: false,
            kind: ipc::TransmitKind::Classic,
            data: vec![7, 0, 0, 0, 0, 0, 0, 0],
            brs: false,
            esi: false,
            dlc: 0,
        };
        transmit_frame_inner(&state, &req).unwrap();

        // Wait for the pump to absorb the fan-out and the trace store
        // to grow to two rows (tx-confirm + Rx fan-out).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline && state.trace_store.len() < 2 {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(
            state.trace_store.len(),
            2,
            "expected tx-confirm + fan-out; got {} rows",
            state.trace_store.len(),
        );

        // The tx-confirm and the fan-out must share one clock. The plot
        // anchors its x-axis on the window's first-frame timestamp
        // (`frame_timestamps`); if the two rows sit on different clocks
        // the receiver's samples land ~decades off that anchor and the
        // plot stays empty even though both rows appear in the trace.
        // Guard the invariant directly: the rows fall within one
        // coherent span, not wall-clock vs bus-relative.
        let (first_ns, last_ns) = state.trace_store.frame_timestamps(0, 2);
        let spread = last_ns.unwrap().abs_diff(first_ns.unwrap());
        assert!(
            spread < 1_000_000_000,
            "tx-confirm and fan-out are {spread} ns apart — two clocks in one buffer",
        );

        let dbs_guard = state.databases.lock().unwrap();
        let db_refs: Vec<&Database> = dbs_guard.iter().map(|l| l.db.as_ref()).collect();

        // Plot scoped to "p" sees the tx-confirm.
        let samples_p = state.signal_caches.slice(
            Some("p"),
            0x456,
            false,
            "Sig",
            0.0,
            f64::MAX,
            0,
            &state.trace_store,
            &db_refs,
        );
        assert!(
            samples_p.iter().any(|p| (p.value - 7.0).abs() < 1e-9),
            "plot on sender bus 'p' missed the tx-confirm; got {samples_p:?}",
        );

        // Plot scoped to "q" sees the fan-out.
        let samples_q = state.signal_caches.slice(
            Some("q"),
            0x456,
            false,
            "Sig",
            0.0,
            f64::MAX,
            0,
            &state.trace_store,
            &db_refs,
        );
        assert!(
            samples_q.iter().any(|p| (p.value - 7.0).abs() < 1e-9),
            "plot on receiver bus 'q' missed the fan-out; got {samples_q:?}",
        );

        // Tear down the pump cleanly so the test doesn't leak the
        // participant (drop sink → source returns None → pump exits).
        stop.store(true, Ordering::Relaxed);
        drop(dbs_guard);
        assert!(state.local_buses.drop_bus("vbus"));
        let _ = pump.join();
    }

    /// Round-trip: write the trace-store contents + notes via
    /// `write_capture`, then read back via `BlfCanFrameSource` for
    /// the frames and `read_notes_from_blf` for the markers. The
    /// frame ids and the marker count must match the input.
    #[test]
    fn write_capture_round_trips_frames_and_notes() {
        use cannet_blf::BlfCanFrameSource;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("cap.blf");

        // Build a small mixed payload: classic + FD + error
        // frames. Modern absolute timestamps so the f64-second
        // round-trip drift behaves the way the writer's docs
        // describe.
        let ts_base = 1_700_000_000_000_000_000u64;
        let f_classic = trace_store::RawTraceFrame {
            timestamp_ns: ts_base,
            channel: 0,
            id: 0x100,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(vec![1, 2, 3]),
            bus_id: Some("p".into()),
        };
        let f_fd = trace_store::RawTraceFrame {
            timestamp_ns: ts_base + 1_000,
            channel: 1,
            id: 0x01AB_CDEF,
            extended: true,
            direction: Direction::Tx,
            payload: CanFramePayload::Fd {
                data: vec![0xAA; 12],
                flags: cannet_core::CanFdFlags {
                    bitrate_switch: true,
                    error_state_indicator: false,
                },
            },
            bus_id: None,
        };
        let f_err = trace_store::RawTraceFrame {
            timestamp_ns: ts_base + 2_000,
            channel: 0,
            id: 0x10,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Error,
            bus_id: None,
        };

        let notes_in = vec![
            notes::Note {
                id: "a".into(),
                timestamp_ns: ts_base + 500,
                label: "first".into(),
                kind: notes::EventKind::Note,
                color: Some("#FF8800".into()),
            },
            notes::Note {
                id: "b".into(),
                timestamp_ns: ts_base + 1_500,
                label: "second".into(),
                kind: notes::EventKind::Note,
                color: None,
            },
        ];

        let outcome = write_capture(
            dest.to_str().unwrap(),
            &[f_classic, f_fd, f_err],
            &notes_in,
            &[],
        )
        .unwrap();
        assert_eq!(outcome.frame_count, 3);
        assert_eq!(outcome.marker_count, 2);
        assert!(outcome.byte_size > 0);

        // Frames re-read via the existing reader.
        let mut src = BlfCanFrameSource::open(&dest).unwrap();
        let f1 = src.next_frame().unwrap().unwrap();
        let f2 = src.next_frame().unwrap().unwrap();
        let f3 = src.next_frame().unwrap().unwrap();
        assert!(src.next_frame().unwrap().is_none());
        assert_eq!(f1.id.raw(), 0x100);
        assert_eq!(f1.payload.data(), &[1, 2, 3]);
        assert!(f2.id.is_extended());
        assert_eq!(f2.id.raw(), 0x01AB_CDEF);
        assert!(matches!(
            f2.payload,
            cannet_core::CanFramePayload::Fd { .. }
        ));
        assert!(matches!(f3.payload, cannet_core::CanFramePayload::Error));

        // Notes recovered from in-BLF GLOBAL_MARKERs in
        // chronological order, ids + labels + timestamps intact.
        // No sidecar file is written.
        let recovered = read_notes_from_blf(dest.to_str().unwrap()).unwrap();
        assert_eq!(recovered.len(), 2);
        assert_eq!(recovered[0].id, "a");
        assert_eq!(recovered[0].label, "first");
        // Colour round-trips via the marker's foreground colour (ADR 0035);
        // the uncoloured note reads back uncoloured, not as black.
        assert_eq!(recovered[0].color.as_deref(), Some("#FF8800"));
        assert_eq!(recovered[1].id, "b");
        assert_eq!(recovered[1].label, "second");
        assert_eq!(recovered[1].color, None);
        // Timestamps round-trip within ms precision (the SYSTEMTIME
        // header floor that the writer applies); accept the
        // ms-rounded values.
        assert_eq!(
            recovered[0].timestamp_ns / 1_000_000,
            (ts_base + 500) / 1_000_000
        );
        assert_eq!(
            recovered[1].timestamp_ns / 1_000_000,
            (ts_base + 1_500) / 1_000_000
        );
    }

    /// `write_capture` re-channels each frame by its `bus_id`'s
    /// position in the project's ordered bus list. This is how the
    /// logical bus assignment round-trips through BLF — the channel
    /// number IS the bus index. A frame whose `bus_id` is missing or
    /// not in the project's bus list keeps its original wire channel
    /// (so we never silently lose data from a partly-mapped capture).
    #[test]
    fn write_capture_re_channels_frames_by_project_bus_order() {
        use cannet_blf::BlfCanFrameSource;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("multi-bus.blf");

        let ts = 1_700_000_000_000_000_000u64;
        let mk = |bus: Option<&str>, ch: u8, id: u32| trace_store::RawTraceFrame {
            timestamp_ns: ts,
            channel: ch,
            id,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(vec![]),
            bus_id: bus.map(str::to_owned),
        };
        // All three frames share wire channel 0 but live on different
        // logical buses. After re-channeling they must come out on
        // distinct BLF channels matching the project's bus order.
        let frames = vec![
            mk(Some("p"), 0, 0x100),
            mk(Some("c"), 0, 0x200),
            mk(Some("p"), 0, 0x300),
        ];
        let buses = vec!["p".to_string(), "c".to_string()];

        let outcome = write_capture(dest.to_str().unwrap(), &frames, &[], &buses).unwrap();
        assert_eq!(outcome.frame_count, 3);

        let mut src = BlfCanFrameSource::open(&dest).unwrap();
        let read: Vec<u8> = std::iter::from_fn(|| src.next_frame().unwrap())
            .map(|f| f.channel)
            .collect();
        assert_eq!(read, vec![0, 1, 0]);
    }

    /// Frames whose `bus_id` isn't in the project's bus list — either
    /// `None` (unassigned, common when a wire-channel binding was
    /// missing) or `Some(unknown)` (stale id) — keep their wire-level
    /// channel rather than getting silently re-channeled. The user
    /// can decide what to do with them on reload via the BLF
    /// channel-map modal.
    #[test]
    fn write_capture_keeps_wire_channel_when_bus_is_unmapped() {
        use cannet_blf::BlfCanFrameSource;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("partial-bus.blf");

        let ts = 1_700_000_000_000_000_000u64;
        let mk = |bus: Option<&str>, ch: u8, id: u32| trace_store::RawTraceFrame {
            timestamp_ns: ts,
            channel: ch,
            id,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(vec![]),
            bus_id: bus.map(str::to_owned),
        };
        let frames = vec![
            mk(None, 3, 0x10),
            mk(Some("x"), 4, 0x20), // "x" not in `buses`
            mk(Some("p"), 9, 0x30), // remapped to channel 0
        ];
        let buses = vec!["p".to_string(), "c".to_string()];

        write_capture(dest.to_str().unwrap(), &frames, &[], &buses).unwrap();

        let mut src = BlfCanFrameSource::open(&dest).unwrap();
        let read: Vec<u8> = std::iter::from_fn(|| src.next_frame().unwrap())
            .map(|f| f.channel)
            .collect();
        assert_eq!(read, vec![3, 4, 0]);
    }

    /// Third-party-written `GLOBAL_MARKER`s (no `description` =
    /// no cannet id) get synthetic `blf-marker-N` ids on read, so
    /// rename / remove on them still works through the existing
    /// id-keyed APIs.
    #[test]
    fn read_notes_from_blf_mints_synthetic_ids_for_third_party_markers() {
        use cannet_blf::format::marker;
        use cannet_blf::format::writer::BlfFileWriter;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("third-party.blf");
        let mut w = BlfFileWriter::create(&dest).unwrap();
        let abs = 1_700_000_000_000_000_000u64;
        let start = w.set_start_if_unset((abs / 1_000_000) * 1_000_000);
        // Two markers with no description (third-party shape).
        let m1 = marker::build(
            abs - start,
            b"Notes".to_vec(),
            b"first".to_vec(),
            Vec::new(),
        );
        let m2 = marker::build(
            (abs + 1_000_000) - start,
            b"Notes".to_vec(),
            b"second".to_vec(),
            Vec::new(),
        );
        w.append_object(&marker::encode(&m1), abs).unwrap();
        w.append_object(&marker::encode(&m2), abs + 1_000_000)
            .unwrap();
        w.finish().unwrap();

        let read = read_notes_from_blf(dest.to_str().unwrap()).unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].id, "blf-marker-0");
        assert_eq!(read[0].label, "first");
        assert_eq!(read[1].id, "blf-marker-1");
        assert_eq!(read[1].label, "second");
    }

    #[test]
    fn transmit_frame_inner_rejects_invalid_id() {
        let state = test_state();
        let req = ipc::TransmitRequest {
            bus_id: "p".into(),
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

    #[test]
    fn group_wire_batches_preserves_first_seen_group_and_frame_order() {
        // A tick's due frames for one (session, channel, interface)
        // ride one FrameBatch; interleaved destinations must not
        // reorder frames within a destination or shuffle destinations.
        let items = vec![
            (("a", 0u8, "if0"), 1u32),
            (("b", 0u8, "if1"), 2),
            (("a", 0u8, "if0"), 3),
            (("a", 1u8, "if2"), 4),
            (("b", 0u8, "if1"), 5),
        ];
        let grouped = group_wire_batches(items);
        assert_eq!(
            grouped,
            vec![
                (("a", 0u8, "if0"), vec![1, 3]),
                (("b", 0u8, "if1"), vec![2, 5]),
                (("a", 1u8, "if2"), vec![4]),
            ],
        );
    }

    #[test]
    fn next_tick_deadline_is_fixed_rate_not_fixed_delay() {
        let base = std::time::Instant::now();
        let period = Duration::from_millis(100);

        // On-time tick: work finished 4 ms in; the next deadline is
        // still base + 100 ms (the 4 ms of work is absorbed, not added),
        // so the wait is only ~96 ms — the message holds 10 Hz.
        let now = base + Duration::from_millis(4);
        assert_eq!(next_tick_deadline(base, now, period), base + period);

        // Behind schedule: this tick's work overran the period (110 ms).
        // We realign to `now` rather than scheduling in the past (which
        // would fire a catch-up burst). The next deadline is `now`, so
        // the wait is zero and there is no accumulating backlog.
        let now = base + Duration::from_millis(110);
        assert_eq!(next_tick_deadline(base, now, period), now);
    }

    // ---- Transmit-throughput benchmarks --------------------------------
    //
    // Not part of the default suite (they're `#[ignore]`d and loop for a
    // while). They exist to scope the "arbitrarily many 5–10 ms cyclic
    // messages across multiple buses" target with real numbers before we
    // rearchitect the scheduler. Run both with:
    //
    //   cargo test -p cannet-gui -- --ignored --nocapture bench_tx
    //
    // `bench_tx_model_only` is the model-side ceiling (build a frame +
    // append a tx-confirm, no session). `bench_tx_vbus_real_path` is the
    // real per-tick cost the scheduler pays: `transmit_frame_inner` over a
    // live virtual-bus session, with the loopback pump appending the
    // fan-out concurrently (so it captures `trace_store` lock contention).
    // Comparing the two tells us whether a slow real tick is the core
    // pipeline or the vbus/transport path.

    #[test]
    #[ignore = "throughput benchmark; run with --ignored --nocapture"]
    #[allow(clippy::cast_precision_loss)] // frame counts never approach 2^52
    fn bench_tx_model_only() {
        let state = test_state();
        let id = cannet_core::CanId::standard(0x123).unwrap();
        let n: u64 = 500_000;
        let start = std::time::Instant::now();
        for i in 0..n {
            let frame = cannet_core::CanFrame::classic(
                i,
                0,
                id,
                cannet_core::Direction::Tx,
                vec![0, 1, 2, 3, 4, 5, 6, 7],
            )
            .unwrap();
            let mut raw = RawTraceFrame::from(frame);
            raw.bus_id = Some("p".into());
            state.trace_store.append(raw);
        }
        let secs = start.elapsed().as_secs_f64();
        println!(
            "[bench] model-only: {n} frames in {:.1} ms = {:.0} frames/s ({:.3} us/frame)",
            secs * 1e3,
            n as f64 / secs,
            secs * 1e6 / n as f64,
        );
    }

    #[test]
    #[ignore = "throughput benchmark; run with --ignored --nocapture"]
    #[allow(clippy::cast_precision_loss)] // frame counts never approach 2^52
    fn bench_tx_vbus_real_path() {
        let state = test_state();
        state
            .local_buses
            .create("vbus", "v", cannet_core::BusConfig::classic_500k())
            .unwrap();
        let (sink_p, _source_p) = state.local_buses.attach_participant("vbus").unwrap();
        let (_sink_q, source_q) = state.local_buses.attach_participant("vbus").unwrap();

        // Loopback pump for "q" — mirrors `connect_local_vbus`; drains the
        // fan-out into the trace store, so the benchmark sees the same
        // `trace_store` contention the real scheduler does.
        let store_for_pump = state.trace_store.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_pump = stop.clone();
        let pump = std::thread::spawn(move || {
            let mut adapter = LocalSourceFrameSource {
                source: source_q,
                channel: 1,
            };
            let channel_to_bus = vec![(1u8, Some("q".to_string()))];
            while !stop_for_pump.load(Ordering::Relaxed) {
                let Some(frame) = cannet_core::CanFrameSource::next_frame(&mut adapter)
                    .ok()
                    .flatten()
                else {
                    break;
                };
                let mut raw = RawTraceFrame::from(frame);
                if let Ok(bid) = route_channel(raw.channel, &channel_to_bus) {
                    raw.bus_id = bid;
                    store_for_pump.append(raw);
                }
            }
        });

        let session = RemoteSession {
            handle: None,
            tx: SessionTx::Vbus(vec![(
                0,
                std::sync::Arc::new(std::sync::Mutex::new(sink_p)),
            )]),
            channel_to_interface: vec![
                (0, project::LOCAL_VBUS_INTERFACE.into()),
                (1, project::LOCAL_VBUS_INTERFACE.into()),
            ],
            channel_to_bus: vec![(0, Some("p".into())), (1, Some("q".into()))],
            stop: Arc::new(AtomicBool::new(false)),
        };
        state
            .remote_sessions
            .lock()
            .unwrap()
            .insert(format!("{}vbus", project::LOCAL_VBUS_URL_SCHEME), session);

        let req = ipc::TransmitRequest {
            bus_id: "p".into(),
            id: 0x123,
            extended: false,
            kind: ipc::TransmitKind::Classic,
            data: vec![0, 1, 2, 3, 4, 5, 6, 7],
            brs: false,
            esi: false,
            dlc: 0,
        };

        let n: u64 = 200_000;
        let start = std::time::Instant::now();
        for _ in 0..n {
            transmit_frame_inner(&state, &req).unwrap();
        }
        let secs = start.elapsed().as_secs_f64();
        println!(
            "[bench] vbus real path: {n} transmits in {:.1} ms = {:.0} frames/s ({:.3} us/transmit)",
            secs * 1e3,
            n as f64 / secs,
            secs * 1e6 / n as f64,
        );

        stop.store(true, Ordering::Relaxed);
        drop(state); // closes the bus → pump's next_frame returns
        let _ = pump.join();
    }

    /// A DBC declaring calculated fields on `Status` via the cannet
    /// attributes — the DBC-defaults layer for the layering tests.
    const CALC_ATTR_DBC: &str = "VERSION \"\"\n\nNS_ :\n\nBS_:\n\nBU_: ECU\n\n\
        BO_ 291 Status: 8 ECU\n\
        \x20SG_ Mode : 0|8@1+ (1,0) [0|255] \"\" ECU\n\
        \x20SG_ AliveCtr : 40|4@1+ (1,0) [0|15] \"\" ECU\n\
        \x20SG_ Ctr2 : 44|4@1+ (1,0) [0|15] \"\" ECU\n\
        \x20SG_ Crc8 : 56|8@1+ (1,0) [0|255] \"\" ECU\n\n\
        BA_DEF_ SG_ \"CannetCounter\" STRING ;\n\
        BA_DEF_ SG_ \"CannetCrc\" STRING ;\n\
        BA_DEF_DEF_ \"CannetCounter\" \"\";\n\
        BA_DEF_DEF_ \"CannetCrc\" \"\";\n\
        BA_ \"CannetCounter\" SG_ 291 AliveCtr \"increment=1;rollover=15\";\n\
        BA_ \"CannetCrc\" SG_ 291 Crc8 \"alg=CRC-8/SAE-J1850;range=0:56\";\n";

    fn calc_request(bus: &str, id: u32) -> ipc::TransmitRequest {
        ipc::TransmitRequest {
            bus_id: bus.into(),
            id,
            extended: false,
            kind: ipc::TransmitKind::Classic,
            data: vec![0u8; 8],
            brs: false,
            esi: false,
            dlc: 0,
        }
    }

    #[test]
    fn effective_calc_uses_dbc_defaults_when_no_override() {
        let dbs = vec![loaded("a.dbc", CALC_ATTR_DBC)];
        let resolved = resolve_effective_calc(&dbs, &calc_request("p", 291), None)
            .unwrap()
            .expect("DBC-declared fields resolve");
        // Counter at bits 40..44 (byte 5 low nibble), CRC in byte 7.
        let mut payload = [0u8; 8];
        let mut counter = 0;
        resolved.apply(&mut counter, &mut payload).unwrap();
        assert_eq!(payload[5] & 0x0F, 1);
        assert_ne!(payload[7], 0);
        // A message without any designation resolves to None.
        let dbs2 = vec![loaded("b.dbc", &tiny_dbc(291, "Plain", "S"))];
        assert!(resolve_effective_calc(&dbs2, &calc_request("p", 291), None)
            .unwrap()
            .is_none());
    }

    #[test]
    fn override_replaces_the_dbc_default_per_field() {
        let dbs = vec![loaded("a.dbc", CALC_ATTR_DBC)];
        // Counter override moves the counter to Ctr2; the DBC's CRC
        // default stays in effect (per-field layering, ADR 0027).
        let spec = ipc::CalcFieldsSpec {
            counter: Some(ipc::CounterSpec {
                signal: "Ctr2".into(),
                increment: 2,
                rollover: Some(15),
            }),
            crc: None,
        };
        let resolved = resolve_effective_calc(&dbs, &calc_request("p", 291), Some(&spec))
            .unwrap()
            .unwrap();
        let mut payload = [0u8; 8];
        let mut counter = 0;
        resolved.apply(&mut counter, &mut payload).unwrap();
        assert_eq!(payload[5] >> 4, 2, "override counter (Ctr2, +2) applied");
        assert_eq!(payload[5] & 0x0F, 0, "DBC default counter signal untouched");
        assert_ne!(payload[7], 0, "DBC default CRC still applied");
    }

    #[test]
    fn effective_calc_respects_bus_scoping_and_reports_errors() {
        // The DBC declaring the fields is scoped to bus "q" — a frame
        // on bus "p" doesn't see it.
        let dbs = vec![loaded_scoped("a.dbc", CALC_ATTR_DBC, &["q"])];
        assert!(resolve_effective_calc(&dbs, &calc_request("p", 291), None)
            .unwrap()
            .is_none());
        assert!(resolve_effective_calc(&dbs, &calc_request("q", 291), None)
            .unwrap()
            .is_some());
        // An override naming an unknown signal is an error, not a
        // silent no-op …
        let bad = ipc::CalcFieldsSpec {
            counter: Some(ipc::CounterSpec {
                signal: "Nope".into(),
                increment: 1,
                rollover: None,
            }),
            crc: None,
        };
        assert!(resolve_effective_calc(&dbs, &calc_request("q", 291), Some(&bad)).is_err());
        // … and so is an override on a message no DBC defines.
        assert!(resolve_effective_calc(&dbs, &calc_request("p", 291), Some(&bad)).is_err());
    }

    /// The spec types round-trip through JSON in ADR 0028's file shape
    /// (`snake_case` keys, `range_bits` array, hex-string CRC params).
    #[test]
    fn calc_spec_serde_matches_the_adr_shapes() {
        let json = r#"{
            "counter": { "signal": "AliveCtr", "increment": 1, "rollover": 15 },
            "crc": { "signal": "Crc8", "algorithm": "CRC-8/SAE-J1850",
                     "range_bits": [0, 56], "prefix": "A3" }
        }"#;
        let spec: ipc::CalcFieldsSpec = serde_json::from_str(json).unwrap();
        let config = spec.to_config().unwrap();
        assert_eq!(config.crc.as_ref().unwrap().prefix, vec![0xA3]);
        assert_eq!(config.crc.as_ref().unwrap().range_bits, (0, 56));
        let back: ipc::CalcFieldsSpec =
            serde_json::from_str(&serde_json::to_string(&spec).unwrap()).unwrap();
        assert_eq!(back, spec);

        // Raw params accept hex strings or numbers and write hex.
        let raw = r#"{ "crc": { "signal": "C", "width": 8, "poly": "0x1D",
                       "init": 255, "range_bits": [0, 56] } }"#;
        let spec: ipc::CalcFieldsSpec = serde_json::from_str(raw).unwrap();
        let config = spec.to_config().unwrap();
        match &config.crc.as_ref().unwrap().algorithm {
            cannet_dbc::CrcAlgorithm::Raw(p) => {
                assert_eq!(p.poly, 0x1D);
                assert_eq!(p.init, 0xFF);
                assert!(!p.refin);
            }
            cannet_dbc::CrcAlgorithm::Named(_) => panic!("expected raw params"),
        }
        let text = serde_json::to_string(&spec).unwrap();
        assert!(text.contains("\"0x1D\""), "{text}");
        // Mixed named + raw is rejected at conversion.
        let mixed = r#"{ "crc": { "signal": "C", "algorithm": "CRC-8/AUTOSAR",
                         "width": 8, "range_bits": [0, 56] } }"#;
        let spec: ipc::CalcFieldsSpec = serde_json::from_str(mixed).unwrap();
        assert!(spec.to_config().is_err());
    }
}
