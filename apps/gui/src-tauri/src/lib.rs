//! Cannet Tauri host. Wires the BLF / MDF / DBC stack and the
//! remote-server client to the React frontend.
//!
//! Three source modes share one frontend pipeline:
//!
//! - `open_log(blf_path)` — opens a Vector BLF file and spawns a worker
//!   thread that streams frames into the trace store until the file is
//!   exhausted.
//! - `import_mdf(mdf_path)` — the same shape over an ASAM MDF 4.x
//!   bus-logging file (`cannet_mdf::MdfCanFrameSource`).
//! - `connect_remote_server(address)` — connects to a `cannet-server`
//!   over gRPC, lists its interfaces, subscribes to all of them, and
//!   spawns the same kind of worker thread to push frames into the
//!   trace store. `disconnect_remote_server` ends the session.
//!
//! All three worker threads run [`run_pump`], which is generic over
//! `CanFrameSource` — it doesn't know or care which source it's
//! draining; it just appends each frame to the shared [`TraceStore`]
//! until the source ends or a stop flag is set (the latter is how
//! `disconnect_remote_server` halts a session without first draining
//! the gRPC task's frame backlog).
//!
//! The trace UI is a *view* over [`TraceStore`]: it asks for slices via
//! `fetch_trace_range` and renders virtualized rows around the current
//! viewport. A `trace-grew` IPC event ticks at ~10 Hz with the latest
//! `count`, frame rate, and — when a view has asked for one
//! (`set_live_tail_rows`) — a short decoded *tail* of the newest frames.
//! The count/rate keep the status line and scrollbar current, and the
//! tail lets the auto-scrolling view paint the live edge without a
//! fetch round-trip, so the host never has to push every frame.
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
mod clock_status;
mod connect_flow;
mod connection_state;
mod crash;
mod dbc_commands;
mod dbc_watcher;
mod diag;
mod emitters;
mod trace_query;
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
mod project_dir;
mod project_registry;
mod project_watch;
mod rbs;
mod sampling;
mod server_browse;
mod server_list;
mod server_path;
mod server_trust;
mod session;
mod settings;
mod settings_descriptor;
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
pub mod signal_fingerprint;
mod signal_generator;
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
mod watched_file;
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

use local_buses::{
    attach_local_bus_bridge, create_local_virtual_bus, detach_local_bus_bridge,
    drop_local_virtual_bus, list_local_bus_bridges, replay_local_virtual_buses,
};
use notes::{
    add_note, clear_notes, fetch_notes, recolor_note, remove_note, rename_note, NotesStore,
};
use signal_cache::SignalCacheStore;
use system_log::SystemLog;
use trace_store::TraceStore;

use app_state::AppState;
#[cfg(test)]
use app_state::{invalidate_derived_caches, LoadedDbc};
#[cfg(test)]
use cannet_core::CanFrameSource;
#[cfg(test)]
use cannet_dbc::Database;
use capture::{
    cancel_import, clear_trace_store, import_mdf, open_log, restore_scratch_capture, save_capture,
    scan_blf_channels, scan_mdf_channels, signal_pyramids_rebuilding,
};
#[cfg(test)]
use capture::{cancel_import_now, pyramids_rebuilding_now, write_blf_capture};
use clock_status::spawn_clock_status_emitter;
#[cfg(test)]
use dbc_commands::decode_against;
use dbc_commands::{
    add_dbc, clear_dbcs, decode_frame, describe_message, encode_frame, list_dbc_content,
    list_file_backed_content, list_signals, list_value_tables, remove_dbc, set_dbc_buses,
};
#[cfg(test)]
use dbc_commands::{
    decode_frame_inner, describe_message_inner, encode_frame_inner, list_value_tables_inner,
};
pub(crate) use emitters::emit_system_log;
use emitters::{
    clear_system_log, fetch_system_log, gui_emit_system_log, set_live_tail_rows,
    spawn_trace_flusher, spawn_trace_grew_emitter,
};
#[cfg(test)]
use emitters::{live_tail_range, should_emit_trace_grew, smooth_fps, TRACE_GREW_TAIL};
#[cfg(test)]
use filter::FilterPredicate;
#[cfg(test)]
use ipc::{ByIdSnapshot, DecodedRecord, SignalSelection, SignalSnapshotRecord, TraceFrameRecord};
use sampling::{sample_signals, signal_min_max};
use session::{connect_remote_server, disconnect_remote_server};
#[cfg(test)]
use session::{panic_message, route_channel, LocalSourceFrameSource, RemoteSession, SessionTx};
#[cfg(test)]
use std::collections::HashSet;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::time::Duration;
#[cfg(test)]
use trace_query::{
    apply_filter_records, collect_trace_records, decode_candidate_ids, fetch_signal_page_inner,
    sort_by_id, windowed_filter_page, ActiveFilterIndex,
};
use trace_query::{
    fetch_by_id_page, fetch_filtered_trace, fetch_signal_page, fetch_trace_range,
    filtered_positions_at_ns, frame_indices_at_ns,
};
#[cfg(test)]
use trace_store::RawTraceFrame;
use transmit_commands::{
    clear_transmit_frames, fetch_field_validity, list_transmit_frames, remove_transmit_frame,
    reorder_transmit_frames, run_transmit_scheduler, set_transmit_frame, start_periodic_transmit,
    stop_periodic_transmit, transmit_frame_once,
};
#[cfg(test)]
use transmit_commands::{
    group_wire_batches, next_tick_deadline, resolve_effective_calc, transmit_frame_inner,
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

/// Resolve the session's project directory (ADR 0042 §1): the directory
/// whose `.cannet/` carries this project's workspace scope and whose
/// `cache/` is the disk-spill scratch (ADR 0002 DS-6/DS-7).
///
/// The project to resolve for is the one the frontend is about to
/// reopen — the user-scope `last_project`, unless the user-scope
/// `reopen_last_project` says to launch with nothing open, in which case
/// this session resolves as if there were no last project. A project
/// file the user put a `.cannet/` beside resolves to its own directory;
/// anything else (a loose project file, a pointer this launch is not
/// resuming, or none at all) gets an auto-located directory
/// under Tauri's `app_cache_dir()` — `$XDG_CACHE_HOME/dev.cannet.app` on
/// Linux and the per-OS equivalents, the same identifier namespace as
/// the config (`app_config_dir`) and log (`app_log_dir`) roots. Either
/// way there is a project directory, so nothing downstream has a
/// no-project branch.
fn resolve_project_dir(app: &tauri::App) -> project_dir::ActiveProjectDir {
    // No cache dir at all is not a reason to have no project directory:
    // fall back to an OS-temp root, the same degradation the filter
    // index and signal pyramids already take.
    let cache_root = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("cannet"));
    let last_project = settings::project_to_reopen(
        state::user_scope_last_project(app.handle()),
        &settings::user_scope(app.handle()),
    );
    let dir = project_dir::resolve(last_project.as_deref(), &cache_root);
    log_project_dir(&dir, "project directory resolved");
    remember_project_dir(app.handle(), &dir, last_project.as_deref());
    project_dir::ActiveProjectDir::new(cache_root, dir)
}

/// Record the project directory the session is working in, so the cache
/// it accumulates can be found and reclaimed later (ADR 0042 §5).
///
/// Called wherever the session takes up a project directory: at startup,
/// on opening a project, and on Save As. A registry that cannot be
/// written costs the user a row in the cache list and nothing else, so
/// the failure is logged where it happens rather than propagated.
pub(crate) fn remember_project_dir(
    app: &AppHandle,
    dir: &project_dir::ProjectDir,
    project_file: Option<&std::path::Path>,
) {
    let Ok(config) = persisted_json::config_dir(app) else {
        return;
    };
    project_registry::record(&config, dir, project_file, project_registry::now_seconds());
}

/// Record which project directory the session is rooted in — at startup
/// and after every re-root, so the log says where a capture went.
fn log_project_dir(dir: &project_dir::ProjectDir, what: &'static str) {
    tracing::info!(
        root = %dir.root().display(),
        cache = %dir.cache_dir().display(),
        auto_located = dir.is_auto_located(),
        "{what}"
    );
}

/// Move the session onto `dest` — everything rooted in a project
/// directory's cache follows the project directory (ADR 0042 §1).
///
/// `carry` decides whether the capture comes too: [`Carry::Contents`] for
/// Save As, which is cannet's managed workflow and would surprise the user
/// by arriving without their data (ADR 0042 §6); [`Carry::Nothing`] for
/// opening a different project, whose own capture is what belongs there.
///
/// Order matters, and it is the mmap that dictates it. The derived caches
/// — the filter index and the signal pyramids — hold mapped files under
/// the *old* cache directory, and a mapped file cannot be moved (Windows
/// will not even rename one). They are dropped first, and they lose
/// nothing by it: both rebuild from the raw frames on demand. The trace
/// store then swaps its own files under its own lock, which is what makes
/// the whole thing safe against live ingest and the flusher thread.
pub(crate) fn reroot_session(
    app: &AppHandle,
    dest: &project_dir::ProjectDir,
    carry: trace_store::Carry,
) {
    let active = app.state::<project_dir::ActiveProjectDir>();
    if active.get().root() == dest.root() {
        return;
    }
    let state = app.state::<AppState>();
    let cache = dest.cache_dir();
    *state.filter_index() = None;
    state.signal_caches.reroot(signal_cache_dir(cache));
    if let Err(e) = state.trace_store.reroot(cache, carry) {
        // The store is left on whatever it could open; the session keeps
        // running rather than dying on a directory problem, exactly as the
        // RAM fallback does at startup.
        tracing::error!(
            cache = %cache.display(),
            error = %e,
            "could not re-root the trace store onto the new project directory"
        );
    }
    *state.filter_index_dir() = filter_index_dir(cache);
    let notes = state.notes.reroot(cache.to_path_buf());
    let _ = app.emit("notes-changed", notes);
    active.set(dest.clone());
    log_project_dir(dest, "session re-rooted");
    // Settings resolve through the new project's `.cannet/`, which may
    // override the scratch cap.
    apply_cache_caps(app);
}

/// The open project's workspace-scoped data directory — `.cannet/`
/// inside the session's project directory (ADR 0042 §3). This is the
/// override half of every two-scope read; the user half is
/// `app_config_dir`.
///
/// The project directory is managed as Tauri state at the top of
/// `setup`, before any command can run, so this is always answerable —
/// there is no session without a project directory (ADR 0042 §1).
pub(crate) fn workspace_dir(app: &AppHandle) -> std::path::PathBuf {
    app.state::<project_dir::ActiveProjectDir>()
        .get()
        .workspace_dir()
}

/// Open the production trace store on the disk-spill backend rooted at
/// `scratch` — the project directory's cache (ADR 0002 DS-6: the disk
/// store is the only production path). Falls back to the in-RAM store —
/// logging why — if the disk store can't be opened, so a capture still
/// runs (degraded to RAM-bounded) rather than the app failing to boot.
///
/// The directory is (re)created first, because the disk store maps its
/// segments lazily: handed an unusable path it opens happily and dies on
/// the first flush instead. `create_dir_all` on a path that is a file, or
/// that permissions forbid, is what turns that into the fallback here.
fn open_trace_store(scratch: &std::path::Path) -> Arc<TraceStore> {
    match std::fs::create_dir_all(scratch).and_then(|()| TraceStore::new_disk(scratch)) {
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

/// Push the two on-disk cache bounds from settings onto the live model:
/// the windowed-ring scratch cap (ADR 0002 DS-8) onto the trace store,
/// and the signal-pyramid retention budget (ADR 0047) onto the signal
/// cache. Called at launch and after every settings change so both take
/// effect without a restart.
pub(crate) fn apply_cache_caps(app: &AppHandle) {
    // `get_settings` has already refused any below-minimum cap (ADR 0002
    // DS-8) and reported it, so whatever arrives here is honorable as-is.
    let settings = settings::get_settings(app.clone());
    let state = app.state::<AppState>();
    state
        .trace_store
        .set_scratch_cap(settings.scratch_cap_bytes);
    state
        .signal_caches
        .set_retention_cap(settings.pyramid_retention_bytes);
}

/// The directory the live filter index roots in: a `filter/` subdir of
/// the disk-spill scratch (ADR 0002 DS-3/DS-7). Created if absent;
/// failure to create is left to `FilterIndex::new` to surface on first
/// use.
fn filter_index_dir(scratch: &std::path::Path) -> std::path::PathBuf {
    let dir = scratch.join("filter");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// The directory the per-signal decimation pyramids spill into: a
/// `signals/` subdir of the disk-spill scratch (ADR 0002 DS-5/DS-7).
/// `SignalCacheStore::new` stages whatever a prior session persisted there
/// for the restore path to validate (ADR 0047).
fn signal_cache_dir(scratch: &std::path::Path) -> std::path::PathBuf {
    scratch.join(signal_cache::PYRAMID_SUBDIR)
}

/// The code the process exits with once the event loop has returned.
///
/// `AppHandle::exit(code)` is the only way the webview can set an exit
/// code, and the runtime drops it: an exit request is translated into
/// tao's `ControlFlow::Exit`, an alias for `ExitWithCode(0)`, so
/// `event_loop_code` is 0 no matter what was asked for. The requested
/// code does arrive intact on `RunEvent::ExitRequested`, so `run` keeps
/// it from there and prefers it here. ADR 0031's failure contract — a
/// perf capture that never connected writes no report and exits
/// non-zero — depends on the requested code reaching the OS.
fn final_exit_code(requested: Option<i32>, event_loop_code: i32) -> i32 {
    requested.unwrap_or(event_loop_code)
}

/// Boot the Tauri runtime. Never returns: the process exits with
/// [`final_exit_code`] once the event loop is done.
///
/// # Panics
/// Panics if the platform runtime fails to start (no display, missing
/// `WebView`, etc.) — there's no recovery path, so we surface the error
/// loudly rather than silently exiting.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::too_many_lines)]
pub fn run() -> ! {
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
    // `--diag` (implied by the capture flags): arm the frontend's
    // diagnostic counters for this launch. Off otherwise — see
    // `diag::diag_enabled_from_args`.
    let diag_on = diag::diag_enabled_from_args(std::env::args());
    // `--app-data-dir <path>`: put this launch's whole user scope — trust
    // store, recents, settings, window geometry — in a directory it owns,
    // so a self-driving performance run (ADR 0031) measures without
    // writing the operator's state. Created up front because the
    // window-state plugin writes its document without creating a parent.
    let config_override = persisted_json::config_dir_override(std::env::args());
    if let Some(dir) = &config_override {
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!(dir = %dir.display(), error = %e, "could not create the app data directory this launch was pointed at");
        }
        tracing::info!(dir = %dir.display(), "user-scope state redirected for this launch");
    }
    let window_state_file = persisted_json::window_state_filename(config_override.as_deref());
    // Where an `AppHandle::exit(code)` request is caught on its way past
    // (see `final_exit_code`). Written by the `ExitRequested` arm below,
    // read after the event loop returns.
    let requested_exit_code = Arc::new(Mutex::new(None::<i32>));
    let exit_code_slot = Arc::clone(&requested_exit_code);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Persist the main window's size, position, and maximized /
        // fullscreen state across launches. The `setup` hook below runs
        // `window_state::ensure_on_screen` afterwards to recover a window
        // whose restored position landed off every connected monitor.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filename(window_state_file)
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .manage(persisted_json::ConfigDirOverride(config_override))
        .manage(diag::HostMetrics::default())
        .manage(sidecar::SidecarState::default())
        .manage(interfaces::InterfacesState::default())
        .manage(connection_state::ConnectionStates::default())
        .manage(connect_flow::ServerPrompts::default())
        .manage(server_browse::DiscoveredServers::default())
        .manage(diag::DiagState::default())
        .manage(diag::AutomationState(autostart))
        .manage(diag::DiagEnabled(diag_on))
        .invoke_handler(tauri::generate_handler![
            open_log,
            scan_blf_channels,
            import_mdf,
            scan_mdf_channels,
            cancel_import,
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
            signal_pyramids_rebuilding,
            connect_remote_server,
            disconnect_remote_server,
            connection_state::get_connection_states,
            project::open_project,
            project::close_project,
            project::save_project,
            project::save_project_as,
            project_dir::active_project_is_auto_located,
            project_registry::list_project_caches,
            project_registry::clear_project_cache,
            project_registry::delete_project_cache,
            project_registry::clear_all_project_caches,
            server_path::add_server_to_path,
            state::get_state,
            state::set_state,
            settings::get_settings,
            settings::set_settings,
            settings::get_settings_overrides,
            settings_descriptor::get_setting_descriptors,
            list_signals,
            list_dbc_content,
            list_file_backed_content,
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
            set_live_tail_rows,
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
            connect_flow::get_server_prompts,
            connect_flow::addresses_needing_trust,
            server_browse::get_discovered_servers,
            server_list::get_server_list,
            server_list::add_server,
            server_trust::accept_server_fingerprint,
            server_trust::set_server_token,
            server_trust::accept_server_insecure,
            server_trust::forget_server,
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
            rbs::rbs_dismiss_disk_change,
            rbs::rbs_view,
            rbs::rbs_crc_algorithms,
            fetch_field_validity,
            app_version,
            licenses::third_party_licenses,
            diag::diag_capture_start,
            diag::diag_push,
            diag::diag_capture_finish,
            diag::diag_autostart,
            diag::diag_enabled,
            diag::exit_process,
            report_js_heap,
            signal_generator::validate_signal_generator,
            signal_generator::evaluate_signal_generators,
        ])
        .setup(move |app| {
            // Resolve the session's project directory (ADR 0042) now that
            // the `AppHandle` exists — resolution reads the user-scope
            // `last_project` and Tauri's `app_cache_dir()`. Its cache is
            // the disk-spill scratch (ADR 0002 DS-6/DS-7), so each project
            // keeps its own capture instead of sharing one machine-wide
            // scratch. The trace store opens on the disk backend, or falls
            // back to RAM (logging why) if it can't be opened. The filter
            // index, signal pyramids, and notes hang off the same cache.
            // `AppState` is managed here rather than on the builder because
            // that resolution needs the handle; no command can run before
            // `setup` returns, so it is in place for every consumer
            // (including `apply_cache_caps` and the DBC watcher below).
            let project_dir = resolve_project_dir(app);
            let scratch = project_dir.get().cache_dir().to_path_buf();
            let filter_dir = filter_index_dir(&scratch);
            let signal_dir = signal_cache_dir(&scratch);
            let trace_store = open_trace_store(&scratch);
            // Managed on its own rather than as an `AppState` field: it
            // is the session's identity, not part of the trace model, and
            // the scoped settings / state reads that need it
            // (`workspace_dir`) run from commands that hold nothing but an
            // `AppHandle`.
            app.manage(project_dir);
            app.manage(AppState {
                databases: Mutex::new(Vec::new()),
                descriptor_snapshot: Mutex::new(None),
                remote_sessions: Mutex::new(HashMap::new()),
                trace_store,
                signal_caches: SignalCacheStore::new(signal_dir),
                system_log: SystemLog::new(),
                // Notes share the project's cache dir with the trace
                // store's identity/derived files (ADR 0002 DS-7); they
                // persist on every edit, so a marker added to a stopped
                // trace survives reopen.
                notes: NotesStore::with_scratch(scratch),
                dbc_watcher: Mutex::new(None),
                local_buses: local_buses::LocalBusRegistry::default(),
                transmit_frames: Mutex::new(transmit_frames::TransmitFrameRegistry::default()),
                transmit_scheduler,
                rbs: Mutex::new(rbs::RbsRuntime::default()),
                verifier: verification::VerificationState::default(),
                filter_index_dir: Mutex::new(filter_dir),
                filter_index: Mutex::new(None),
                import_cancel: Mutex::new(None),
                live_tail_rows: std::sync::atomic::AtomicU64::new(0),
                active_project_id: Mutex::new(None),
                watched_project: Mutex::new(watched_file::WatchedFile::default()),
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
            // Fill the host-side settings cache before anything that
            // reads it starts: the loops below, the rolling-log writer,
            // and the system-log ring all take their cadences and
            // depths from it (ADR 0034).
            settings::hydrate(app.handle());
            crash::spawn_health_recorder(app.handle().clone());
            spawn_trace_grew_emitter(app.handle().clone());
            spawn_trace_flusher(app.handle().clone());
            spawn_clock_status_emitter(app.handle().clone());
            // Apply the persisted windowed-ring scratch cap (ADR 0002 DS-8)
            // so a flush honors it from the first tick.
            apply_cache_caps(app.handle());
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
            // Browse `_cannet._tcp` for the app's lifetime so the
            // connect surface always has a current list of the servers
            // advertising on this subnet (ADR 0040).
            server_browse::spawn(app.handle().clone());
            // Build the DBC filesystem watcher. Construction
            // is the only step that needs the `AppHandle` (the
            // watcher's event callback emits events / pushes system
            // log entries through it). Stored on `AppState` so the
            // DBC IPC commands can watch / unwatch paths.
            let watcher = DbcWatcher::new(app.handle());
            let state: State<'_, AppState> = app.state();
            *state.dbc_watcher() = Some(watcher);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running cannet");
    // `run_return` rather than `run`, so the requested exit code caught
    // below can be handed to the OS ourselves — `run` exits the process
    // with the event loop's own code, which is always 0 (see
    // `final_exit_code`).
    let event_loop_code = app.run_return(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { code, .. } = event {
            if code.is_some() {
                *exit_code_slot.lock().expect("exit code mutex poisoned") = code;
            }
            // Hang up on every server before the process goes away, so
            // the disconnect is something we did rather than something
            // the server infers from a socket that stopped answering.
            // Done host-side rather than in the window's close handler:
            // this arm is reached by every exit route, including the
            // ones where the webview is already gone. Bounded — see
            // `session::disconnect_on_exit`. First, so no more frames
            // land while the flush below runs.
            session::disconnect_on_exit(app_handle);
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
            } else {
                let state = app_handle.state::<AppState>();
                if let Err(e) = state.trace_store.flush() {
                    tracing::warn!(error = %e, "shutdown trace flush failed");
                }
                // Harden the signal pyramids the same way, and record what
                // they are valid against — this is what the *next* launch
                // reads instead of re-decoding the whole history (ADR
                // 0047). After the trace flush, so the low-water mark in
                // the key is the one the raw store just persisted. The
                // flusher hardens each segment as it seals, so what is
                // left to write here is one tail segment per level.
                emitters::persist_pyramids(&state, signal_cache::Harden::All);
            }
        }
    });
    let requested = *requested_exit_code
        .lock()
        .expect("exit code mutex poisoned");
    std::process::exit(final_exit_code(requested, event_loop_code));
}

// ------------------------------------------------------------------

#[cfg(test)]
mod tests;
