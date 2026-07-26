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

use tauri::{AppHandle, Manager, State};

use dbc_watcher::DbcWatcher;


use notes::{
    add_note, clear_notes, fetch_notes, recolor_note, remove_note, rename_note, NotesStore,
};
use local_buses::{
    attach_local_bus_bridge, create_local_virtual_bus, detach_local_bus_bridge,
    drop_local_virtual_bus, list_local_bus_bridges, replay_local_virtual_buses,
};
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
    let sub = signal_cache::PYRAMID_SUBDIR;
    match scratch {
        Some(s) => s.join(sub),
        None => std::env::temp_dir().join("cannet").join(sub),
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

















// ------------------------------------------------------------------

#[cfg(test)]
mod tests;
