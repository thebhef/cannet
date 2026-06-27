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

mod crash;
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
mod local_buses;
mod notes;
mod prefs;
mod project;
mod rbs;
mod sidecar;
// `signal_cache` and `signal_sampler` are `pub` so the
// `cannet-perf-measurement` harness can drive the real per-signal
// decimation pyramid (ADR 0002 DS-5) — the same `SignalCacheStore`
// the GUI plots through — rather than measuring a stand-in. The
// mutex `.expect` is an internally-upheld invariant, so the pedantic
// missing-panics lint is suppressed here rather than papered over.
#[allow(clippy::missing_panics_doc, clippy::new_without_default)]
pub mod signal_cache;
pub mod signal_sampler;
mod system_log;
#[allow(
    clippy::missing_panics_doc,
    clippy::new_without_default,
    clippy::len_without_is_empty
)]
pub mod trace_store;
mod transmit_frames;
mod transmit_scheduler;
mod verification;
mod window_state;

// File-model types the `cannet-perf-measurement` harness reuses, re-exported so the
// harness can parse the example project / RBS through the production
// types without the crate-private command modules they live in.
pub use project::{Project, PROJECT_SCHEMA_VERSION};
pub use rbs::{format_message_key, parse_message_key, RbsFile, RbsMessage, RbsValue};

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use cannet_blf::{BlfCanFrameSource, BlfCaptureWriter};
use cannet_client::{PreSubscribeConfig, SessionHandle, SessionTransmitter, Subscription};
use cannet_core::{CanFrame as CoreCanFrame, CanFrameSource, CanId};
use cannet_dbc::{Database, DecodedSignal};
use dbc_watcher::DbcWatcher;
use filter::{DecodeDependentLeaf, FilterPredicate};

use ipc::{
    BusFps, ByIdSnapshot, DbcAttributeRecord, DbcContentRecord, DbcInfo, DbcMessageContentRecord,
    DbcSignalContentRecord, DecimatedRange, DecodedRecord, FilteredTracePage, InterfaceRecord,
    LogFinished, OpenLogResult, RemoteSessionResult, RowPage, SampledPoints,
    SignalDescriptorRecord, SignalExtent, SignalQuery, SignalRecord, TraceFrameRecord, TraceGrew,
    ValueTableEntryRecord,
};
use notes::{Note, NotesStore};
use signal_cache::SignalCacheStore;
use system_log::{SystemLog, SystemMessage};
use trace_store::{RawTraceFrame, TraceStore};

/// A loaded DBC: its source path, the parsed database, and the set of
/// logical bus ids this DBC is scoped to. Decoders walk the
/// loaded list in order — the first that decodes a given frame wins —
/// and skip any DBC whose `buses` set is non-empty and doesn't contain
/// the frame's `bus_id`. An empty set is "applies to every bus".
struct LoadedDbc {
    path: String,
    db: Database,
    /// Scoped bus ids; empty = unscoped (applies to all buses).
    buses: Vec<String>,
}

/// State for an active session — remote (over `cannet-client`) or
/// in-process (an `local-vbus://` URL). The two share the same
/// channel→interface / channel→bus maps and the same stop flag; the
/// backend split lives inside [`SessionTx`].
#[allow(dead_code)]
struct RemoteSession {
    /// Drop-to-disconnect handle for a remote session. `None` for an
    /// in-process session — teardown there happens by dropping the
    /// participant sinks held inside [`Self::tx`], which detaches the
    /// participants and lets the per-channel pumps see
    /// `LocalSource::next_event() -> None` and exit.
    handle: Option<SessionHandle>,
    /// Submitting end of the session — what the `transmit_frame`
    /// command pushes onto. Variants reflect the backend; both
    /// answer to a uniform `transmit(channel, interface_id, frame)`
    /// call (see [`SessionTx::transmit`]).
    tx: SessionTx,
    /// `channel -> wire interface_id` for every subscription opened
    /// when the session was established. The transmit-panel command
    /// uses this to translate a frame's `channel` to the wire id the
    /// `FrameBatch` envelope must carry (remote backend) or to the
    /// canonical `"bus"` string the vbus backend stamps on `Sent`
    /// status responses.
    channel_to_interface: Vec<(u8, String)>,
    /// `channel -> logical bus id` derived from the project's
    /// interface bindings. The pump uses it to stamp incoming frames'
    /// `bus_id`; `transmit_frame` uses the reverse direction (bus id
    /// → channel) to route an outgoing frame to the right session.
    /// Entries with `None` mean "channel unmapped" — those frames
    /// pump through unassigned and are unreachable as transmit
    /// destinations.
    channel_to_bus: Vec<(u8, Option<String>)>,
    stop: Arc<AtomicBool>,
}

/// Backend-specific transmit machinery for a [`RemoteSession`].
/// Both arms expose the same `transmit(channel, interface_id, frame)`
/// surface so the upstream transmit path (`transmit_frame_inner`,
/// `resolve_bus_route`) is uniform.
enum SessionTx {
    /// Remote backend — `transmit` hands off to the `cannet-client`
    /// session's `SessionTransmitter`, addressed by `interface_id`.
    Remote(SessionTransmitter),
    /// In-process backend — one `LocalSink` per opened binding,
    /// keyed by the binding's channel. `transmit` looks up the sink
    /// by channel and submits the frame on it; the `SharedBus` fans
    /// the frame out to every other participant on the bus, who
    /// receive it as `Direction::Rx`.
    Vbus(Vec<(u8, std::sync::Arc<std::sync::Mutex<cannet_core::LocalSink>>)>),
}

impl SessionTx {
    fn transmit(
        &self,
        channel: u8,
        interface_id: &str,
        frame: &cannet_core::CanFrame,
    ) -> Result<(), String> {
        use cannet_core::CanFrameSink;
        match self {
            SessionTx::Remote(t) => t.transmit(interface_id, frame).map_err(|e| e.to_string()),
            SessionTx::Vbus(participants) => {
                let sink = participants
                    .iter()
                    .find(|(c, _)| *c == channel)
                    .ok_or_else(|| format!("vbus session has no participant on channel {channel}"))?
                    .1
                    .clone();
                let mut guard = sink.lock().expect("vbus participant sink mutex poisoned");
                guard.submit(frame.clone()).map_err(|e| e.to_string())
            }
        }
    }
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
    /// Active remote sessions, keyed by server address. Each value is
    /// the gRPC [`SessionHandle`] (drop to disconnect), a
    /// [`SessionTransmitter`] the transmit panel uses to push frames
    /// over the wire, the interfaces the session is subscribed to (so
    /// the transmit-panel command can pick the right `interface_id` for
    /// a chosen channel), and a stop flag the pump thread watches.
    /// `disconnect_remote_server` takes one or all entries out, sets
    /// the flag, and drops the handle — the flag makes the pump exit
    /// promptly instead of first draining whatever frames the gRPC
    /// task already buffered, and dropping the handle closes the
    /// stream. The pump thread removes its own entry on exit.
    remote_sessions: Mutex<HashMap<String, RemoteSession>>,
    /// The trace model — the single source of truth for the captured
    /// stream. Pump threads append; `fetch_trace_range` reads slices
    /// out for the trace view to render. `Arc`-wrapped so background
    /// threads spawned outside an `AppHandle` context (e.g. the local
    /// virtual-bus observer pumps in [`local_buses`]) can hold their
    /// own clone of the store across their lifetime.
    trace_store: Arc<TraceStore>,
    /// Per-`(message, signal)` decoded-sample caches, extended
    /// incrementally by `sample_signals` so a plot doesn't re-decode
    /// the same matching frames every tick. Cleared on
    /// `clear_trace_store` (the frame indices it holds wouldn't
    /// otherwise survive).
    signal_caches: SignalCacheStore,
    /// Host-side log bus. Append-side: the `sys_info!` /
    /// `sys_warn!` / `sys_error!` macros that wrap call sites in
    /// project / DBC / connection / BLF-import flows. Read-side: the
    /// `fetch_system_log` / `clear_system_log` IPC commands and the
    /// `system-log-appended` event the host emits on every successful
    /// push.
    system_log: SystemLog,
    /// Session-scoped notes. Edited by `add_note` / `rename_note` /
    /// `remove_note` / `clear_notes` (each emits `notes-changed` on
    /// success); snapshotted by `fetch_notes`. Save Capture writes
    /// them inside the BLF as `GLOBAL_MARKER` records; Open Capture
    /// and project-open migration restore through them.
    notes: NotesStore,
    /// Filesystem watcher for loaded DBC paths. Lazily
    /// initialised in the Tauri `setup` hook (it needs an
    /// `AppHandle` to drive its event callback). `None` only
    /// briefly during startup or if backend construction fails on
    /// an exotic platform; `add_dbc` / `remove_dbc` / `clear_dbcs`
    /// handle the `None` case as "no auto-reload" rather than
    /// failing.
    dbc_watcher: Mutex<Option<DbcWatcher>>,
    /// Host-side `SharedBus` instances for
    /// `local-virtual-bus` bindings (ADR 0021). Reconstructed on
    /// every project open; dropped on close.
    local_buses: local_buses::LocalBusRegistry,
    /// The host-side TX-message pool. The transmit
    /// panel is a thin view onto this. Populated on project open,
    /// snapshotted on save.
    transmit_frames: Mutex<transmit_frames::TransmitFrameRegistry>,
    /// Handle to the single transmit scheduler thread
    /// (`run_transmit_scheduler`) that drives every running periodic.
    /// `start`/`stop_periodic_transmit` push schedule changes through
    /// it; the thread itself is spawned in `run`'s `setup`.
    transmit_scheduler: transmit_scheduler::TransmitScheduler,
    /// Rest-of-bus-simulation state (ADR 0028): loaded `.cannet_rbs`
    /// documents per element, the project's logical-bus name map, and
    /// the global kill-switch. Lock order: `rbs` before `databases`
    /// before `transmit_frames` before `remote_sessions`.
    rbs: Mutex<rbs::RbsRuntime>,
    /// Ingest-time CRC / counter verification (ADR 0027): the
    /// per-`(bus, id)` config index, counter continuity, the sparse
    /// violation index the trace fetch decorates rows from, and the
    /// validity map. Owns its own lock.
    verifier: verification::VerificationState,
}

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

/// Report the running build's version for display in the title bar.
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
        .manage(AppState {
            databases: Mutex::new(Vec::new()),
            remote_sessions: Mutex::new(HashMap::new()),
            trace_store: Arc::new(TraceStore::new()),
            signal_caches: SignalCacheStore::new(),
            system_log: SystemLog::new(),
            notes: NotesStore::new(),
            dbc_watcher: Mutex::new(None),
            local_buses: local_buses::LocalBusRegistry::default(),
            transmit_frames: Mutex::new(transmit_frames::TransmitFrameRegistry::default()),
            transmit_scheduler,
            rbs: Mutex::new(rbs::RbsRuntime::default()),
            verifier: verification::VerificationState::default(),
        })
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
            fetch_filtered_trace,
            clear_trace_store,
            connect_remote_server,
            disconnect_remote_server,
            project::open_project,
            project::save_project,
            prefs::get_prefs,
            prefs::set_prefs,
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
            remove_note,
            clear_notes,
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
            diag::diag_capture_start,
            diag::diag_push,
            diag::diag_capture_finish,
            diag::diag_autostart,
            report_js_heap,
        ])
        .setup(move |app| {
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
        .run(tauri::generate_context!())
        .expect("error while running cannet");
}

/// Whether a `trace-grew` tick should emit, given the `(count, fps)` it
/// last emitted and the values this tick. Skips only when both are
/// byte-identical. An idle session settles there: the count is frozen
/// and [`TraceStore::frames_per_second`] returns exactly `0.0` once a
/// full second has elapsed since the last append, so after the rate has
/// finished decaying the tuple stops changing and the emitter goes quiet.
/// During that one-second decay each read differs, so
/// the status line still slides to zero before the stream falls silent.
fn should_emit_trace_grew(last: Option<(u64, f64)>, current: (u64, f64)) -> bool {
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
fn spawn_trace_grew_emitter(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(TRACE_GREW_TICK);
        let mut last_emitted: Option<(u64, f64, u64)> = None;
        loop {
            interval.tick().await;
            let state: State<'_, AppState> = app.state();
            let count = u64::try_from(state.trace_store.len()).unwrap_or(u64::MAX);
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
            let (frames_per_second_rx, frames_per_second_tx) =
                state.trace_store.frames_per_second_by_direction();
            let _ = app.emit(
                "trace-grew",
                TraceGrew {
                    count,
                    frames_per_second,
                    frames_per_second_rx,
                    frames_per_second_tx,
                    frames_per_second_by_bus,
                    frames_dropped_before_session,
                    session_start_seconds,
                    buffer_seconds,
                    tail,
                },
            );
        }
    });
}

/// Per-channel BLF bus mapping. One entry per channel the
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
/// to `connect_remote_server`. `interface` is the wire
/// `Interface.id`; `bus_id` is the project's logical bus.
///
/// `speed_bps` / `fd` / `fd_data_speed_bps` are the bus's hardware
/// configuration as held in [`crate::project::Bus`]. When any of
/// `speed_bps` / `fd` is set, the host pushes a `ConfigureBus`
/// envelope to the sidecar immediately after subscribe so the
/// underlying controller is reopened at the requested rate / mode.
/// Omitting both leaves the sidecar on its driver default
/// (typically classic, 500 kbps).
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceBusBinding {
    pub interface: String,
    pub bus_id: String,
    #[serde(default)]
    pub speed_bps: Option<u32>,
    #[serde(default)]
    pub fd: Option<bool>,
    #[serde(default)]
    pub fd_data_speed_bps: Option<u32>,
}

/// Build a [`PreSubscribeConfig`] from a binding's bus hints, or
/// `None` if neither speed nor FD mode is pinned (the project hasn't
/// configured this bus, so the sidecar uses its driver default).
fn presubscribe_config_from(b: &InterfaceBusBinding) -> Option<PreSubscribeConfig> {
    if b.speed_bps.is_none() && b.fd.is_none() {
        return None;
    }
    Some(PreSubscribeConfig {
        speed_bps: u64::from(b.speed_bps.unwrap_or(0)),
        fd_enabled: b.fd.unwrap_or(false),
        fd_data_speed_bps: u64::from(b.fd_data_speed_bps.unwrap_or(0)),
    })
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

    // Notes live inside the BLF as `GLOBAL_MARKER` records (ADR 0010 —
    // no sidecar files). Pull them out of the file in a quick pre-pass
    // before kicking off the frame pump. The session-buffer notes are
    // session-scoped, so any notes already in the store are replaced:
    // Open BLF is a fresh-capture action that wipes the trace store via
    // the surrounding GUI flow.
    let notes = match read_notes_from_blf(&blf_path) {
        Ok(v) => v,
        Err(e) => {
            sys_warn!(
                &app,
                "blf-import",
                "couldn't read markers from {blf_path}: {e}"
            );
            Vec::new()
        }
    };
    let marker_count = notes.len();
    if marker_count > 0 {
        let _ = app.state::<AppState>().notes.replace(notes.clone());
        let _ = app.emit("notes-changed", notes);
        sys_info!(
            &app,
            "blf-import",
            "loaded {marker_count} note(s) from BLF markers",
        );
    }

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
                true, // replay_origin: BLF anchors the session at the first frame's ts
            );
        })
        .map_err(|e| format!("failed to spawn pump thread: {e}"))?;

    Ok(result)
}

/// Write the entire session buffer to `blf_path` as a Vector BLF.
/// Every frame on every bus, no per-trace slicing — the project
/// file's bus bindings handle re-routing on import. Notes ride
/// inside the BLF as `GLOBAL_MARKER` records (object type 96) —
/// no sidecar file (ADR 0010). The write is atomic at the BLF
/// level (temp file + rename in `cannet-blf`).
///
/// Emits `capture`-tagged System Messages: `info` with the frame
/// count + byte size + marker count on success, `error` on
/// failure.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn save_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    blf_path: String,
    buses: Vec<String>,
) -> Result<SaveCaptureResult, String> {
    // Snapshot the trace store. `slice(0, len)` clones each
    // RawTraceFrame out under the trace-store lock — that's the
    // simplest correct read; for very long captures it's a single
    // big allocation rather than streaming chunked reads, which
    // we'll revisit when disk-spill lands.
    let frames = state.trace_store.slice(0, state.trace_store.len());
    let notes = state.notes.snapshot();

    let outcome = match write_capture(&blf_path, &frames, &notes, &buses) {
        Ok(o) => o,
        Err(e) => {
            sys_error!(&app, "capture", "save to {blf_path} failed: {e}");
            return Err(e);
        }
    };

    sys_info!(
        &app,
        "capture",
        "saved capture to {blf_path}: {n} frame(s), {b} bytes, {m} note(s)",
        n = outcome.frame_count,
        b = outcome.byte_size,
        m = outcome.marker_count,
    );
    // The native BLF writer is ns-exact (no f64-second boundary
    // since blf_asc retired); `max_timestamp_drift_ns` is always
    // 0. The warn branch stays for surface stability but is
    // effectively unreachable.
    if outcome.max_timestamp_drift_ns >= 1_000 {
        sys_warn!(
            &app,
            "capture",
            "precision degraded on save: timestamps drifted up to {d} ns vs. the in-memory timeline",
            d = outcome.max_timestamp_drift_ns,
        );
    }

    Ok(outcome)
}

/// Result of [`save_capture`]; mirrors the `cannet-blf` writer's
/// outcome plus the note count, so the frontend can surface
/// "saved 12,345 frames + 3 notes".
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCaptureResult {
    pub blf_path: String,
    pub frame_count: u64,
    pub byte_size: u64,
    pub marker_count: u64,
    pub max_timestamp_drift_ns: u64,
}

/// Read every `GLOBAL_MARKER` out of `blf_path` and project it to a
/// [`Note`]. Marker layout matches what [`BlfCaptureWriter::append_marker`]
/// emits: `group_name = "cannet"`, `marker_name = label`,
/// `description = id`. Third-party markers (any other group, or
/// `description` empty) get a synthetic id `blf-marker-<index>` so
/// their `rename` / `remove` paths still work; this mints a stable
/// id deterministic in the marker's position within the file.
fn read_notes_from_blf(blf_path: &str) -> Result<Vec<Note>, String> {
    use cannet_blf::format::reader::{BlfObject, BlfReader};
    let mut reader = BlfReader::open(blf_path).map_err(|e| e.to_string())?;
    let start_unix_nanos = reader.start_unix_nanos();
    let mut notes = Vec::new();
    let mut synthetic_idx: u64 = 0;
    while let Some(obj) = reader.next_object().map_err(|e| e.to_string())? {
        if let BlfObject::GlobalMarker(m) = obj {
            let label = String::from_utf8_lossy(&m.marker_name).into_owned();
            let id = if m.description.is_empty() {
                let id = format!("blf-marker-{synthetic_idx}");
                synthetic_idx += 1;
                id
            } else {
                String::from_utf8_lossy(&m.description).into_owned()
            };
            // Per-event timestamp is relative to the file's start;
            // recover the absolute ns the rest of cannet uses.
            let timestamp_ns = start_unix_nanos.saturating_add(m.event.timestamp_ns());
            notes.push(Note {
                id,
                timestamp_ns,
                label,
            });
        }
    }
    Ok(notes)
}

/// Perform the actual BLF write. Frames go in as CAN events, notes
/// go in as `GLOBAL_MARKER` (object type 96) records — both inside
/// the BLF file itself, no sidecar (per [ADR 0010]).
///
/// [ADR 0010]: ../../../docs/adr/0010-no-sidecar-files.md
///
/// `buses` is the project's ordered bus-id list. Each frame's
/// `bus_id` is resolved to its position in this list and that
/// position becomes the BLF channel — so the logical bus assignment
/// round-trips through the channel number alone. A frame whose
/// `bus_id` is `None` or isn't in `buses` keeps its original wire
/// channel as a fallback, so a partial mapping never loses data.
///
/// Markers carry the note's `label` as `marker_name` and the note's
/// `id` as `description`, so a save → open round-trip preserves the
/// frontend-stable id.
fn write_capture(
    blf_path: &str,
    frames: &[trace_store::RawTraceFrame],
    notes: &[Note],
    buses: &[String],
) -> Result<SaveCaptureResult, String> {
    let mut writer = BlfCaptureWriter::create(blf_path)
        .map_err(|e| format!("failed to open {blf_path} for writing: {e}"))?;
    // Interleave frames and markers in chronological order. The
    // BLF writer doesn't enforce ordering, but consumers (Vector
    // CANalyzer, our own reader) expect timestamps to climb, so we
    // merge-sort the two streams on the way in.
    let mut frame_iter = frames.iter().peekable();
    let mut note_iter = notes.iter().peekable();
    loop {
        let next_frame_ts = frame_iter.peek().map(|f| f.timestamp_ns);
        let next_note_ts = note_iter.peek().map(|n| n.timestamp_ns);
        let take_frame = match (next_frame_ts, next_note_ts) {
            (None, None) => break,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            // Tie goes to the frame so a marker placed at exactly
            // a frame's timestamp sorts after it; matches Vector's
            // convention where a marker comments on the frame
            // immediately before it.
            (Some(ft), Some(nt)) => ft <= nt,
        };
        if take_frame {
            let frame = frame_iter.next().expect("peek matched");
            let core = raw_to_core_frame(frame, buses)
                .map_err(|e| format!("invalid frame in session buffer: {e}"))?;
            writer
                .append(&core)
                .map_err(|e| format!("failed to write frame: {e}"))?;
        } else {
            let note = note_iter.next().expect("peek matched");
            writer
                .append_marker(note.timestamp_ns, &note.label, &note.id)
                .map_err(|e| format!("failed to write marker: {e}"))?;
        }
    }
    let outcome = writer
        .finish()
        .map_err(|e| format!("failed to finalise capture: {e}"))?;

    Ok(SaveCaptureResult {
        blf_path: blf_path.to_string(),
        frame_count: outcome.frame_count,
        byte_size: outcome.byte_size,
        marker_count: outcome.marker_count,
        max_timestamp_drift_ns: outcome.max_timestamp_drift_ns,
    })
}

/// Convert a `RawTraceFrame` back into a `CanFrame` for the
/// BLF writer. Errors only if the id mode disagrees with the
/// raw id value (which shouldn't happen — `RawTraceFrame`s
/// originate from `CanFrame`s — but the validating
/// constructors are the only way to spell the conversion).
///
/// `buses` is the project's ordered bus-id list; the output
/// channel is the index of `frame.bus_id` in that list, or the
/// frame's wire-level channel if the bus isn't listed (or the
/// frame is unassigned).
fn raw_to_core_frame(
    frame: &trace_store::RawTraceFrame,
    buses: &[String],
) -> Result<CoreCanFrame, String> {
    use cannet_core::CanFramePayload as P;
    let channel = channel_for_save(frame, buses);
    let id = if frame.extended {
        CanId::extended(frame.id).map_err(|e| e.to_string())?
    } else {
        CanId::standard(frame.id).map_err(|e| e.to_string())?
    };
    match &frame.payload {
        P::Classic(data) => CoreCanFrame::classic(
            frame.timestamp_ns,
            channel,
            id,
            frame.direction,
            data.clone(),
        )
        .map_err(|e| e.to_string()),
        P::Fd { data, flags } => CoreCanFrame::fd(
            frame.timestamp_ns,
            channel,
            id,
            frame.direction,
            data.clone(),
            *flags,
        )
        .map_err(|e| e.to_string()),
        P::Remote { dlc } => Ok(CoreCanFrame::remote(
            frame.timestamp_ns,
            channel,
            id,
            frame.direction,
            *dlc,
        )),
        P::Error => Ok(CoreCanFrame::error(
            frame.timestamp_ns,
            channel,
            id,
            frame.direction,
        )),
    }
}

/// The BLF channel to write a frame on: index of the frame's
/// `bus_id` in the project's ordered bus list, or the wire-level
/// `frame.channel` as a fallback when the bus isn't listed (or the
/// frame is unassigned). Lifted to its own function so it has one
/// unambiguous home and the round-trip behaviour is unit-testable.
fn channel_for_save(frame: &trace_store::RawTraceFrame, buses: &[String]) -> u8 {
    if let Some(bid) = frame.bus_id.as_deref() {
        if let Some(i) = buses.iter().position(|b| b == bid) {
            // The bus index is bounded by `buses.len()` (a project
            // configured by the GUI never exceeds a handful), so the
            // truncation cast is safe; saturate at u8::MAX just in
            // case some future caller hands in a giant list.
            return u8::try_from(i).unwrap_or(u8::MAX);
        }
    }
    frame.channel
}

/// Pre-scan a BLF file and return its distinct channel numbers, in
/// ascending order. Used by the GUI's BLF import flow to
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
/// Emits `dbc`-tagged messages on the system log — `info` on
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
    // Non-fatal attribute problems (malformed CannetCounter /
    // CannetCrc values) surface as warnings; the DBC still loads.
    for w in db.parse_warnings() {
        sys_warn!(&app, "dbc", "{path}: {w}");
    }
    let reloaded = {
        let mut list = state.databases.lock().expect("databases mutex poisoned");
        if let Some(slot) = list.iter_mut().find(|d| d.path == path) {
            slot.db = db;
            true
        } else {
            list.push(LoadedDbc {
                path: path.clone(),
                db,
                buses: Vec::new(),
            });
            false
        }
    };
    if reloaded {
        sys_info!(&app, "dbc", "reloaded DBC {path}");
    } else {
        sys_info!(&app, "dbc", "loaded DBC {path}");
        // Start watching this file's parent dir for FS
        // events (only on first-load — a reload is already watched).
        if let Some(w) = state
            .dbc_watcher
            .lock()
            .expect("dbc_watcher mutex poisoned")
            .as_mut()
        {
            w.watch_dbc(std::path::Path::new(&path));
        }
    }
    rbs::refresh_all_elements(&app);
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
    app: AppHandle,
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
    rbs::refresh_all_elements(&app);
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
        if let Some(w) = state
            .dbc_watcher
            .lock()
            .expect("dbc_watcher mutex poisoned")
            .as_mut()
        {
            w.unwatch_dbc(std::path::Path::new(&path));
        }
        rbs::refresh_all_elements(&app);
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
        rbs::refresh_all_elements(&app);
    }
    if let Some(w) = state
        .dbc_watcher
        .lock()
        .expect("dbc_watcher mutex poisoned")
        .as_mut()
    {
        w.unwatch_all();
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
    let violations: std::collections::HashMap<u64, &'static str> = state
        .verifier
        .violations_in(start, end)
        .into_iter()
        .collect();
    raw.into_iter()
        .enumerate()
        .map(|(i, frame)| {
            #[allow(clippy::cast_possible_truncation)]
            let absolute_index = start + i as u64;
            let decoded = decode_against(&dbs, &frame);
            let mut record = TraceFrameRecord::from_raw(absolute_index, &frame, decoded);
            record.violation = violations.get(&absolute_index).copied();
            record
        })
        .collect()
}

/// Decode a raw frame against the loaded DBCs, in order — the first
/// one that recognises the arbitration id wins. Skips any DBC whose
/// `buses` set is non-empty and doesn't contain the frame's `bus_id`
/// (per-bus scoping); an empty set is "all buses". `None` if
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

/// Resolve `filter`'s decode-dependent leaves against the loaded DBCs
/// into the set of arbitration ids whose decode could change the
/// predicate's verdict — the *decode candidates*. A `name_regex` leaf
/// contributes every id whose message name matches in any DBC; a
/// `signal_equals` leaf contributes every id whose message carries a
/// signal with that name.
///
/// For a frame whose id is outside the set, no DBC decodes it to a
/// matching name / signal, so the decode-dependent leaves evaluate
/// false with or without the decode and the raw leaves never read it —
/// skipping the decode cannot change the scan's result. This is what
/// keeps `fetch_filtered_trace`'s repeated full-window scans from
/// decoding every frame in the session: the per-frame decode gate
/// collapses to a set lookup, and only actual candidates pay for a
/// decode. The set is keyed on the raw id alone (standard/extended
/// collisions just decode a few extra frames — a harmless superset).
fn decode_candidate_ids(dbs: &[LoadedDbc], filter: &FilterPredicate) -> HashSet<u32> {
    let leaves = filter.decode_dependent_leaves();
    let mut out = HashSet::new();
    if leaves.is_empty() {
        return out;
    }
    for d in dbs {
        for (id, _extended, name) in d.db.message_names() {
            let hit = leaves.iter().any(|l| {
                matches!(l, DecodeDependentLeaf::MessageNameRegex(p)
                    if filter::regex_match(p, name))
            });
            if hit {
                out.insert(id);
            }
        }
        for (id, _extended, sig) in d.db.signal_names() {
            let hit = leaves
                .iter()
                .any(|l| matches!(l, DecodeDependentLeaf::SignalName(n) if *n == sig));
            if hit {
                out.insert(id);
            }
        }
    }
    out
}

/// Pull a `[start, end)` slice out of the trace store and decode each
/// frame against the currently-attached DBC. The caller is expected to
/// be the trace view, sizing `end - start` to the visible window plus a
/// small prefetch pad.
///
/// `filter` is the consumer's optional [`FilterPredicate`]
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

/// Sort key for the by-id "bus" column: the project bus *name* (so the
/// on-screen order matches what the user reads), the raw bus id when the
/// project doesn't know it (defensive — a removed bus), or `"~"` for an
/// unassigned frame so it sorts after any real bus name ascending.
/// Mirrors the former client-side `sortValue` "bus" case, moved host-side
/// with the rest of the by-id sort.
fn bus_sort_key(bus_id: Option<&str>, names: &HashMap<String, String>) -> String {
    match bus_id {
        None => "~".to_string(),
        Some(id) => names.get(id).cloned().unwrap_or_else(|| id.to_string()),
    }
}

/// The `kind` column's sort key — the frame-kind discriminant, matching
/// the `snake_case` tag the frontend column shows.
fn kind_sort_key(kind: &ipc::CanFrameKind) -> &'static str {
    match kind {
        ipc::CanFrameKind::Classic => "classic",
        ipc::CanFrameKind::Fd { .. } => "fd",
        ipc::CanFrameKind::Remote { .. } => "remote",
        ipc::CanFrameKind::Error => "error",
    }
}

/// Compare two by-id rows by one column's value — the host-side
/// equivalent of the former client `sortValue` / `compareValues`
/// (traceColumns.ts). An unknown key compares equal (leaves the order).
fn by_id_cmp(
    a: &ByIdSnapshot,
    b: &ByIdSnapshot,
    key: &str,
    names: &HashMap<String, String>,
) -> std::cmp::Ordering {
    let (fa, fb) = (&a.frame, &b.frame);
    match key {
        "rate" => a.rate.total_cmp(&b.rate),
        "idx" => fa.index.cmp(&fb.index),
        "time" => fa.timestamp_seconds.total_cmp(&fb.timestamp_seconds),
        "bus" => {
            bus_sort_key(fa.bus_id.as_deref(), names).cmp(&bus_sort_key(fb.bus_id.as_deref(), names))
        }
        "dir" => fa.direction.cmp(fb.direction),
        "id" => fa.id.cmp(&fb.id),
        "kind" => kind_sort_key(&fa.kind).cmp(kind_sort_key(&fb.kind)),
        "len" => fa.data.len().cmp(&fb.data.len()),
        "data" => fa.data.cmp(&fb.data),
        "msg" => {
            let na = fa.decoded.as_ref().map_or("", |d| d.name.as_str());
            let nb = fb.decoded.as_ref().map_or("", |d| d.name.as_str());
            na.cmp(nb)
        }
        _ => std::cmp::Ordering::Equal,
    }
}

/// Sort by-id rows host-side per the panel's column sort, so a *paged*
/// by-id view orders the whole set rather than each page in isolation
/// (ADR 0025). `key` / `dir` are the `ColumnKey` and direction the panel
/// sends; a `None` key leaves the `latest_in_window` default order (by
/// bus, channel, id). Replaces the former client-side `sortRows`. Stable,
/// so equal keys keep the default order — including under `desc`.
fn sort_by_id(
    rows: &mut [ByIdSnapshot],
    key: Option<&str>,
    dir: Option<&str>,
    names: &HashMap<String, String>,
) {
    let Some(key) = key else { return };
    let desc = dir == Some("desc");
    rows.sort_by(|a, b| {
        let c = by_id_cmp(a, b, key, names);
        if desc {
            c.reverse()
        } else {
            c
        }
    });
}

/// A *paged* by-id snapshot of the trace window `[scan_start, scan_end)`:
/// one row per arbitration id, its latest in-window frame decoded against
/// the loaded DBCs (paired with the id's rate and session frame count),
/// optionally constrained by `filter`, sorted host-side per
/// `sort_key` / `sort_dir`, returned as the page `[offset, offset+limit)`
/// of a [`RowPage`] (ADR 0025). The by-id view pages this through the
/// same windowed-source primitive as the chronological views — there is
/// no separate whole-snapshot path. `bus_names` carries the project's bus
/// id→name map so the "bus" column sorts by the name the user sees (the
/// host knows only bus ids). A count-only refresh passes `limit == 0` and
/// reads just `count`.
///
/// `filter` drops rows whose latest in-window frame doesn't pass the
/// predicate. (As before, this filters the *latest* observation; a row a
/// signal-value filter excludes can re-appear once the id emits a passing
/// value.) Bounding to `scan_end` rather than the live tip is what makes
/// a paused/stopped snapshot reflect the window it shows. `async` so
/// Tauri runs it off the main thread, like the other paged accessors.
#[tauri::command]
#[allow(clippy::unused_async, clippy::too_many_arguments)] // off-thread; args are the IPC payload
async fn fetch_by_id_page(
    app: AppHandle,
    filter: Option<FilterPredicate>,
    scan_start: u64,
    scan_end: u64,
    sort_key: Option<String>,
    sort_dir: Option<String>,
    bus_names: Vec<(String, String)>,
    offset: u64,
    limit: u64,
) -> RowPage<ByIdSnapshot> {
    let state: State<'_, AppState> = app.state();
    let start = usize::try_from(scan_start).unwrap_or(usize::MAX);
    let end = usize::try_from(scan_end).unwrap_or(usize::MAX);
    let rows = state.trace_store.latest_in_window(start, end);
    let mut snaps: Vec<ByIdSnapshot> = {
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
                Some(ByIdSnapshot {
                    frame: record,
                    rate: row.rate,
                    count: row.count,
                })
            })
            .collect()
    };
    let names: HashMap<String, String> = bus_names.into_iter().collect();
    sort_by_id(&mut snaps, sort_key.as_deref(), sort_dir.as_deref(), &names);

    let count = u64::try_from(snaps.len()).unwrap_or(u64::MAX);
    let off = usize::try_from(offset).unwrap_or(usize::MAX).min(snaps.len());
    let lim = usize::try_from(limit).unwrap_or(usize::MAX);
    let page: Vec<ByIdSnapshot> = snaps.into_iter().skip(off).take(lim).collect();
    RowPage {
        count,
        start: u64::try_from(off).unwrap_or(0),
        rows: page,
    }
}

/// Streaming page selector for [`fetch_filtered_trace`]: as match
/// indices arrive in order (across chunked scans) it accumulates the
/// running match `count` and keeps only the requested page's indices — a
/// sliding tail of `limit` for `from_end`, or the `[offset, offset+limit)`
/// slice otherwise. `seed` is the incremental-count checkpoint: matches
/// already counted before the scan's first frame, so a count-only refresh
/// that scans only newly-appended frames still reports the full total
/// (ADR 0025 — the extent advances on growth without a full re-scan).
///
/// Pure and synchronous: the async command feeds it the chunked scan
/// results, and it is unit-tested without a runtime or DBCs.
struct PageSelector {
    count: u64,
    page: VecDeque<usize>,
    offset: u64,
    hi: u64,
    cap: usize,
    from_end: bool,
}

impl PageSelector {
    fn new(offset: u64, limit: u64, from_end: bool, seed: u64) -> Self {
        Self {
            count: seed,
            page: VecDeque::new(),
            offset,
            hi: offset.saturating_add(limit),
            cap: usize::try_from(limit).unwrap_or(usize::MAX),
            from_end,
        }
    }

    /// Feed one match index (absolute trace-store index), in scan order.
    fn push(&mut self, idx: usize) {
        let match_idx = self.count;
        self.count += 1;
        if self.from_end {
            self.page.push_back(idx);
            if self.page.len() > self.cap {
                self.page.pop_front();
            }
        } else if match_idx >= self.offset && match_idx < self.hi {
            self.page.push_back(idx);
        }
    }

    /// `(total count, page indices, match-index of the page's first row)`.
    fn finish(self) -> (u64, Vec<usize>, u64) {
        let page: Vec<usize> = self.page.into_iter().collect();
        let win_len = u64::try_from(page.len()).unwrap_or(u64::MAX);
        let start_match = if self.from_end {
            self.count.saturating_sub(win_len)
        } else {
            self.offset.min(self.count)
        };
        (self.count, page, start_match)
    }
}

/// Scan one chunk `[lo, hi)` of the store for frames matching `filter`,
/// returning their absolute indices. The predicate decodes only frames
/// whose id is in `candidates` (the filter's decode-dependent leaves) and
/// raw-field-tests the rest. Shared by [`fetch_filtered_trace`]'s forward,
/// incremental-count, and backward-tail scans so the match test is written
/// once. Caller holds the `databases` lock for the call and releases it
/// between chunks.
fn scan_chunk_filtered(
    store: &crate::trace_store::TraceStore,
    dbs: &[LoadedDbc],
    candidates: &HashSet<u32>,
    filter: &FilterPredicate,
    lo: usize,
    hi: usize,
) -> Vec<usize> {
    store.scan_chunk(lo, hi, |frame| {
        let decoded = if candidates.contains(&frame.id) {
            decode_against(dbs, frame)
        } else {
            None
        };
        filter.matches(frame, decoded.as_ref())
    })
}

/// Materialise the decoded rows of a filtered page from its absolute store
/// indices: clone the frames, decode each against the current DBCs, and
/// attach any ingest-time violation. Shared by [`fetch_filtered_trace`]'s
/// full-scan and follow-live tail paths.
fn materialize_filtered_rows(state: &AppState, page_idxs: &[usize]) -> Vec<TraceFrameRecord> {
    let pairs = state.trace_store.frames_at(page_idxs);
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    pairs
        .into_iter()
        .map(|(i, frame)| {
            let index = u64::try_from(i).unwrap_or(u64::MAX);
            let mut record = TraceFrameRecord::from_raw(index, &frame, decode_against(&dbs, &frame));
            record.violation = state.verifier.violation_at(index);
            record
        })
        .collect()
}

/// Finish a follow-live tail page from match indices collected by scanning
/// the window *backward* in chunks — each chunk's matches appended
/// newest-first, so `collected_desc` is descending overall. Keep the `cap`
/// most-recent, return them ascending (oldest-first, the render order), and
/// the match-index of the first (`total - page_len`). Pure so the index
/// math is unit-tested apart from the scan/lock machinery.
fn tail_page(mut collected_desc: Vec<usize>, cap: usize, total: u64) -> (Vec<usize>, u64) {
    collected_desc.truncate(cap);
    collected_desc.reverse();
    let start = total.saturating_sub(u64::try_from(collected_desc.len()).unwrap_or(0));
    (collected_desc, start)
}

/// A *paged* window into the filtered chronological trace.
/// Scans `[scan_start, scan_end)` of the trace store, applies `filter`,
/// and returns the total match count plus the decoded matches at
/// match-indices `[offset, offset + limit)` — or, when `from_end` is
/// set, the *last* `limit` matches, so the live-tail view gets its
/// page and the running total in one call. The frontend pages this; it
/// never holds the whole filtered set in memory.
///
/// The `prev_count` / `prev_count_end` checkpoint — the `(count, end)` the
/// caller already knows — lets two paths avoid a full window re-scan:
/// - A **count-only refresh** (`limit == 0`) counts only frames appended
///   since the checkpoint and reports the full total in O(Δ).
/// - A **follow-live tail** (`from_end`) takes that same incremental total
///   and then scans *backward* from the tip for just its page, so the
///   steady follow-live tick is O(Δ + page span) rather than re-scanning
///   `[scan_start, scan_end)` every time. Without it (the first call, or a
///   stale checkpoint whose end is outside the window) the tail falls back
///   to the full forward scan, which also seeds the next checkpoint.
///
/// A **positioned page** (`from_end == false`, `limit > 0`) ignores the
/// checkpoint and scans from `scan_start` so it can place the page by
/// match-index; that happens on user scroll, not on the live tick.
///
/// The scan runs as a sequence of bounded chunks
/// ([`TraceStore::scan_chunk`]), releasing the trace-store lock — and
/// `await`-yielding — between each, so a history scan never holds the
/// append mutex across the whole buffer. That mutex also gates the
/// ingest pump's `append` and the tx-confirm `append`, so a buffer-wide
/// locked scan here starved RX and transmit as the buffer grew (the
/// diagnosed lock contention); chunking bounds the lock-hold to one chunk. The scan
/// never decodes blindly: when the predicate has decode-dependent
/// leaves, they're pre-resolved to a candidate-id set
/// ([`decode_candidate_ids`]) and only frames whose id is in the set are
/// decoded — every other frame's test is a raw-field check plus a set
/// lookup. Only the returned page's frames are cloned
/// ([`TraceStore::frames_at`]), never the whole match set; that page is
/// decoded for display.
///
/// `async` so Tauri runs it off the main thread, and so the per-chunk
/// `yield_now` actually cedes the runtime between chunks.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // a Tauri command — args are the IPC payload fields
async fn fetch_filtered_trace(
    app: AppHandle,
    filter: FilterPredicate,
    scan_start: u64,
    scan_end: u64,
    offset: u64,
    limit: u64,
    from_end: bool,
    prev_count: Option<u64>,
    prev_count_end: Option<u64>,
) -> FilteredTracePage {
    /// Frames scanned under one lock acquisition before releasing it and
    /// yielding. Small enough that the append mutex is never held long
    /// (the starvation fix); large enough that the per-chunk lock /
    /// yield overhead stays negligible against a multi-hundred-k buffer.
    const SCAN_CHUNK: usize = 8192;

    let state: State<'_, AppState> = app.state();
    let win_start = usize::try_from(scan_start).unwrap_or(usize::MAX);
    let end = usize::try_from(scan_end)
        .unwrap_or(usize::MAX)
        .min(state.trace_store.len());

    // Incremental-count checkpoint: a count-only refresh (`limit == 0`)
    // can resume from the `(count, end)` it already knows so the host
    // counts only newly-appended frames — O(Δ). A stale checkpoint (end
    // outside the window) or any row-returning call scans from the window
    // start.
    let (seed, scan_from) = match (limit, prev_count, prev_count_end) {
        (0, Some(c), Some(e)) => {
            let e = usize::try_from(e).unwrap_or(usize::MAX);
            if e >= win_start && e <= end {
                (c, e)
            } else {
                (0, win_start)
            }
        }
        _ => (0, win_start),
    };

    // Resolve the decode-candidate id set once against the current DBCs.
    // The per-chunk match test re-locks `databases` (a `std::sync::Mutex`
    // guard must never be held across the `.await` below).
    let candidates = {
        let dbs = state.databases.lock().expect("databases mutex poisoned");
        decode_candidate_ids(&dbs, &filter)
    };

    // Follow-live tail fast path: the last `limit` matches plus the running
    // total in O(Δ + tail span), not a full `[win_start, end)` re-scan. The
    // full re-scan ran on every refresh tick while following live —
    // chunked, so never a buffer-wide lock-hold, but its O(buffer) work per
    // tick still loaded the store and dragged ingest down as the buffer
    // grew. Used only with a valid checkpoint (the steady follow-live
    // case); the first call after a descriptor change has none and takes
    // the full scan below, which seeds it.
    if from_end && limit > 0 {
        if let (Some(prev_c), Some(prev_e)) = (prev_count, prev_count_end) {
            let prev_e = usize::try_from(prev_e).unwrap_or(usize::MAX);
            if prev_e >= win_start && prev_e <= end {
                // Total: prior count plus matches in the freshly-appended
                // tail `[prev_e, end)`.
                let mut count = prev_c;
                let mut pos = prev_e;
                while pos < end {
                    let chunk_end = pos.saturating_add(SCAN_CHUNK).min(end);
                    let n = {
                        let dbs = state.databases.lock().expect("databases mutex poisoned");
                        scan_chunk_filtered(
                            &state.trace_store,
                            &dbs,
                            &candidates,
                            &filter,
                            pos,
                            chunk_end,
                        )
                        .len()
                    };
                    count = count.saturating_add(u64::try_from(n).unwrap_or(0));
                    pos = chunk_end;
                    tokio::task::yield_now().await;
                }
                // Page: scan backward from `end` until `limit` matches are
                // collected (or `win_start` is reached) — bounded by how far
                // back the tail page reaches, not the whole buffer.
                let cap = usize::try_from(limit).unwrap_or(usize::MAX);
                let mut collected: Vec<usize> = Vec::new();
                let mut hi = end;
                while hi > win_start && collected.len() < cap {
                    let lo = hi.saturating_sub(SCAN_CHUNK).max(win_start);
                    let mut matches = {
                        let dbs = state.databases.lock().expect("databases mutex poisoned");
                        scan_chunk_filtered(&state.trace_store, &dbs, &candidates, &filter, lo, hi)
                    };
                    matches.reverse(); // newest-first within the chunk
                    collected.extend(matches);
                    hi = lo;
                    tokio::task::yield_now().await;
                }
                let (page_idxs, start_match) = tail_page(collected, cap, count);
                let rows = materialize_filtered_rows(state.inner(), &page_idxs);
                return FilteredTracePage {
                    count,
                    start: start_match,
                    rows,
                };
            }
        }
    }

    // Full scan: a count-only refresh, a positioned page, or the first
    // follow-live tail before a checkpoint exists. Driven chunk by chunk so
    // the store lock is held only per chunk, yielding between.
    let mut sel = PageSelector::new(offset, limit, from_end, seed);
    let mut pos = scan_from;
    while pos < end {
        let chunk_end = pos.saturating_add(SCAN_CHUNK).min(end);
        let matches = {
            let dbs = state.databases.lock().expect("databases mutex poisoned");
            scan_chunk_filtered(&state.trace_store, &dbs, &candidates, &filter, pos, chunk_end)
        };
        for idx in matches {
            sel.push(idx);
        }
        pos = chunk_end;
        tokio::task::yield_now().await;
    }

    let (count, page_idxs, start_match) = sel.finish();
    let rows = materialize_filtered_rows(state.inner(), &page_idxs);
    FilteredTracePage {
        count,
        start: start_match,
        rows,
    }
}

/// Drop every stored frame and start a fresh session timeline rooted
/// at wall-clock now. The frontend's Clear button is the typical
/// caller. Raising the session-start threshold to "now" is what makes
/// any frames captured before the clear but still in flight through
/// the recv pipeline (sidecar queue, gRPC stream, packer thread) get
/// dropped on append rather than land in the new session's buffer with
/// stale timestamps and show as negative offsets.
///
/// The next `trace-grew` tick will fire with the new count (zero),
/// prompting the trace view to drop its row cache. Any
/// session-scoped notes go with the buffer (they reference timestamps
/// on the now-discarded timeline).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn clear_trace_store(app: AppHandle, state: State<'_, AppState>) {
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX));
    state.trace_store.start_session(now_ns);
    // The decoded-sample caches hold frame indices into the store —
    // wipe them too, otherwise the next `sample_signals` would slice
    // against a buffer that no longer exists. Same for the
    // verification runtime (violation indices + counter continuity).
    state.signal_caches.clear();
    state.verifier.clear_runtime();
    if let Some(applied) = state.notes.clear() {
        let _ = app.emit("notes-changed", applied.notes);
    }
}

/// Snapshot the host-side system log. Returns every message
/// currently in the ring in chronological order. The frontend keeps
/// its own copy and merges incremental `system-log-appended` events
/// into it; this command is the bootstrap (panel opens / page reloads)
/// and a fallback if an event is missed.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn fetch_system_log(state: State<'_, AppState>) -> Vec<SystemMessage> {
    state.system_log.snapshot()
}

/// Drop every message from the host-side system log. The
/// `seq` counter is deliberately *not* reset; the frontend uses `seq`
/// to deduplicate against in-flight `system-log-appended` events, so
/// resetting would risk delivering a stale `seq = 0` after a clear.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn clear_system_log(state: State<'_, AppState>) {
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
fn gui_emit_system_log(
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

/// Every `(bus, message, signal)` triple the loaded DBCs define, for
/// a plot panel's signal picker. One record per matching project bus
/// per DBC signal — so a scoped DBC produces one record per bus in
/// its scope, an unscoped DBC produces one record per project bus,
/// and a project with no buses falls back to one `bus_id: None`
/// record per signal (the legacy "any bus" path). Sorted by
/// `(bus_id, message_id, signal_name)` and deduplicated on that key.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_signals(
    state: State<'_, AppState>,
    project_buses: Vec<String>,
) -> Vec<SignalDescriptorRecord> {
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    let mut out: Vec<SignalDescriptorRecord> = Vec::new();
    for loaded in dbs.iter() {
        // A DBC's effective scope: explicit `buses` if set, else
        // every project bus. With no project buses at all, fall back
        // to a single `bus_id: None` so an early-bring-up plot still
        // sees something.
        let scope: Vec<Option<String>> = if !loaded.buses.is_empty() {
            loaded.buses.iter().map(|b| Some(b.clone())).collect()
        } else if !project_buses.is_empty() {
            project_buses.iter().map(|b| Some(b.clone())).collect()
        } else {
            vec![None]
        };
        for d in loaded.db.signals() {
            for bus_id in &scope {
                out.push(SignalDescriptorRecord {
                    bus_id: bus_id.clone(),
                    message_id: d.message_id,
                    extended: d.extended,
                    message_name: d.message_name.clone(),
                    signal_name: d.signal_name.clone(),
                    unit: d.unit.clone(),
                    has_value_table: d.has_value_table,
                });
            }
        }
    }
    out.sort_by(|a, b| {
        (
            a.bus_id.as_deref(),
            a.message_id,
            a.extended,
            a.signal_name.as_str(),
        )
            .cmp(&(
                b.bus_id.as_deref(),
                b.message_id,
                b.extended,
                b.signal_name.as_str(),
            ))
    });
    out.dedup_by(|a, b| {
        a.bus_id == b.bus_id
            && a.message_id == b.message_id
            && a.extended == b.extended
            && a.signal_name == b.signal_name
    });
    out
}

/// Snapshot every loaded DBC's content for the DBC
/// discovery panel: one [`DbcContentRecord`] per loaded file, each
/// carrying the file path plus the tree the panel renders (messages
/// → signals + comments + attributes + value tables).
///
/// Unlike [`list_signals`], this is **not** expanded per bus —
/// scoping is a panel-side concern (the panel may show the same DBC
/// once, even when it's scoped to multiple buses) and re-expanding
/// here would multiply the payload. The DBC file path is the
/// frontend's grouping key.
///
/// Order matches the host's loaded-DBC list (priority order); the
/// `messages` list inside each record is sorted by
/// `(extended, message_id)`.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_dbc_content(state: State<'_, AppState>) -> Vec<DbcContentRecord> {
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    dbs.iter()
        .map(|loaded| DbcContentRecord {
            dbc_path: loaded.path.clone(),
            messages: loaded
                .db
                .dbc_content()
                .into_iter()
                .map(message_record)
                .collect(),
        })
        .collect()
}

fn message_record(m: cannet_dbc::DbcMessageContent) -> DbcMessageContentRecord {
    DbcMessageContentRecord {
        message_id: m.message_id,
        extended: m.extended,
        name: m.name,
        comment: m.comment,
        expected_len: m.expected_len,
        is_fd: m.is_fd,
        brs: m.brs,
        uses_extended_mux: m.uses_extended_mux,
        attributes: m.attributes.into_iter().map(attribute_record).collect(),
        signals: m.signals.into_iter().map(signal_record).collect(),
    }
}

fn signal_record(s: cannet_dbc::DbcSignalContent) -> DbcSignalContentRecord {
    DbcSignalContentRecord {
        name: s.name,
        unit: s.unit,
        comment: s.comment,
        start_bit: s.start_bit,
        length: s.length,
        byte_order: match s.byte_order {
            cannet_dbc::ByteOrder::Little => "little",
            cannet_dbc::ByteOrder::Big => "big",
        },
        signed: s.signed,
        factor: s.factor,
        offset: s.offset,
        min: s.min,
        max: s.max,
        mux: match s.mux {
            cannet_dbc::SignalMux::Plain => ipc::SignalMuxRecord::Plain,
            cannet_dbc::SignalMux::Multiplexor => ipc::SignalMuxRecord::Multiplexor,
            cannet_dbc::SignalMux::Multiplexed { selector } => {
                ipc::SignalMuxRecord::Multiplexed { selector }
            }
            cannet_dbc::SignalMux::MultiplexorAndMultiplexed { selector } => {
                ipc::SignalMuxRecord::MultiplexorAndMultiplexed { selector }
            }
        },
        float_kind: match s.float_kind {
            cannet_dbc::FloatKind::Integer => "integer",
            cannet_dbc::FloatKind::Float32 => "float32",
            cannet_dbc::FloatKind::Float64 => "float64",
        },
        attributes: s.attributes.into_iter().map(attribute_record).collect(),
        value_table: s
            .value_table
            .into_iter()
            .map(|e| ValueTableEntryRecord {
                raw: e.raw,
                label: e.label,
            })
            .collect(),
    }
}

fn attribute_record(a: cannet_dbc::DbcAttribute) -> DbcAttributeRecord {
    DbcAttributeRecord {
        name: a.name,
        value: a.value,
    }
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

/// Pack a [`DecimatedRange`] into the compact binary layout the frontend
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
fn encode_signals_sample(s: &DecimatedRange) -> Vec<u8> {
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
) -> DecimatedRange {
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
    // The cache decimates internally now: it reads the coarsest pyramid
    // level above `max_points` (ADR 0002 DS-5), so a "fit data" over a
    // huge capture serves `O(max_points)` points instead of
    // materializing and decimating the whole raw window here every tick.
    let sliced: Vec<Vec<signal_sampler::SamplePoint>> = signals
        .iter()
        .map(|q| {
            state.signal_caches.slice(
                q.bus_id.as_deref(),
                q.message_id,
                q.extended,
                &q.signal_name,
                slice_from,
                slice_to,
                max_points as usize,
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
        .map(|points| {
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

    DecimatedRange {
        from_seconds: from_ts.map(ns_to_seconds),
        last_seconds: last_ts.map(ns_to_seconds),
        series,
        slice_ms,
        decode_ms,
    }
}

/// Each requested signal's all-time value extent — the host-owned
/// y-extent the plot's auto-normalisation reads (ADR 0025: a scalar
/// model fact, queried directly rather than latched in a React ref).
/// One [`SignalExtent`] per query in the same order, `None` for a
/// signal nothing has decoded yet. Like `sample_signals` it catches the
/// per-signal caches up to the store tip, so cost is `O(new matches)`.
#[tauri::command]
#[allow(clippy::unused_async)]
async fn signal_min_max(app: AppHandle, signals: Vec<SignalQuery>) -> Vec<Option<SignalExtent>> {
    let state: State<'_, AppState> = app.state();
    let dbs_guard = state.databases.lock().expect("databases mutex poisoned");
    let db_refs: Vec<&Database> = dbs_guard.iter().map(|l| &l.db).collect();
    let out = signals
        .iter()
        .map(|q| {
            state
                .signal_caches
                .min_max(
                    q.bus_id.as_deref(),
                    q.message_id,
                    q.extended,
                    &q.signal_name,
                    &state.trace_store,
                    &db_refs,
                )
                .map(|(lo, hi)| SignalExtent { lo, hi })
        })
        .collect();
    drop(dbs_guard);
    out
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

/// Connect to a `cannet-server`, list its interfaces, subscribe only
/// to the interfaces named by `bindings`, and spawn a pump thread to
/// push frames at the frontend.
///
/// Multiple remote sessions may be active at a time — one per server
/// address. A second connect to the same address while one is open
/// returns an error.
///
/// `bindings` is the project's interface → bus mapping for
/// this server (a list of `{interface, bus_id}` pairs). The host
/// subscribes to exactly those interfaces (in binding order) and
/// translates each into a per-channel mapping the pump uses to stamp
/// each frame's `bus_id`. An empty `bindings` is an error — there's
/// nothing to subscribe to.
// Structured-log emit sites are sprinkled across this command;
// it's slightly over clippy's default function-length cap, but the
// shape is "linear sequence of named failure points" — splitting would
// just inline-extract a helper that has zero independent meaning.
#[allow(clippy::too_many_lines)]
#[tauri::command]
async fn connect_remote_server(
    app: AppHandle,
    address: String,
    bindings: Option<Vec<InterfaceBusBinding>>,
) -> Result<RemoteSessionResult, String> {
    let binding_lookup = bindings.unwrap_or_default();
    if binding_lookup.is_empty() {
        let msg = format!(
            "no interface bindings configured for {address}; add bindings in the project panel first"
        );
        sys_warn!(&app, "connection", "{msg}");
        return Err(msg);
    }

    // ADR 0023 dispatch: a `local-vbus://<id>` address opens an
    // in-process session against the named virtual bus instead of
    // going over `cannet-client`. Same RemoteSession shape; same
    // entry in the session map; same transmit / disconnect paths.
    if let Some(vbus_id) = address.strip_prefix(project::LOCAL_VBUS_URL_SCHEME) {
        return connect_local_vbus(&app, address.clone(), vbus_id, &binding_lookup);
    }

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

    // Subscribe only to interfaces named in the project's bindings for
    // this server. Channels are 0..N over the binding list — distinct
    // per session, not globally unique. When the binding carries an
    // explicit bus speed / FD mode, attach it so the worker emits a
    // `ConfigureBus` ahead of the corresponding `Subscribe` and the
    // controller opens at the right rate from the start.
    let subscriptions: Vec<Subscription> = binding_lookup
        .iter()
        .enumerate()
        .filter_map(|(i, b)| {
            if !interfaces.iter().any(|iface| iface.id == b.interface) {
                return None;
            }
            let sub = Subscription::new(b.interface.clone(), u8::try_from(i).unwrap_or(u8::MAX));
            Some(match presubscribe_config_from(b) {
                Some(cfg) => sub.with_config(cfg),
                None => sub,
            })
        })
        .collect();

    if subscriptions.is_empty() {
        return Err(format!("no bound interface matches what {address} exposes"));
    }

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
            .remote_sessions
            .lock()
            .expect("remote_sessions mutex poisoned");
        if guard.contains_key(&address) {
            // Drop `handle` here, which sends shutdown to the worker we
            // just spawned. The existing entry stays untouched.
            let msg = format!("already connected to {address}");
            sys_warn!(&app, "connection", "{msg}");
            return Err(msg);
        }
        // Build the channel-to-bus mapping from the per-server
        // bindings. We subscribed to exactly the bindings' interfaces
        // above, so each subscription has a matching binding by
        // interface id. Stored on the session so `transmit_frame` can
        // use it for outgoing routing; the pump gets its own clone.
        let channel_to_bus: Vec<(u8, Option<String>)> = subscriptions
            .iter()
            .filter_map(|sub| {
                binding_lookup
                    .iter()
                    .find(|b| b.interface == sub.interface_id)
                    .map(|b| (sub.channel, Some(b.bus_id.clone())))
            })
            .collect();

        guard.insert(
            address.clone(),
            RemoteSession {
                handle: Some(handle),
                tx: SessionTx::Remote(transmitter),
                channel_to_interface: subscriptions
                    .iter()
                    .map(|s| (s.channel, s.interface_id.clone()))
                    .collect(),
                channel_to_bus,
                stop: Arc::clone(&stop),
            },
        );
    }

    // Pump's own copy of the same channel→bus list — pulled from the
    // session under a fresh lock so we know it matches what the
    // transmit path will see.
    let channel_to_bus: Vec<(u8, Option<String>)> = {
        let state: State<'_, AppState> = app.state();
        let guard = state
            .remote_sessions
            .lock()
            .expect("remote_sessions mutex poisoned");
        guard
            .get(&address)
            .map(|s| s.channel_to_bus.clone())
            .unwrap_or_default()
    };

    let app_for_thread = app.clone();
    let address_for_cleanup = address.clone();
    std::thread::Builder::new()
        .name(format!("cannet-remote-pump:{address}"))
        .spawn(move || {
            run_pump(&app_for_thread, receiver, stop, channel_to_bus, false);
            // Pump exited (server hung up or user disconnected). Drop
            // our entry so the address is free for a fresh connect.
            let state: State<'_, AppState> = app_for_thread.state();
            state
                .remote_sessions
                .lock()
                .expect("remote_sessions mutex poisoned")
                .remove(&address_for_cleanup);
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

/// Open an in-process session against a `local-vbus://<id>` address.
/// Attaches one participant per binding on the named virtual bus;
/// each participant's read half is pumped into the trace store by a
/// dedicated thread (mirroring how the remote pump drains a
/// `cannet-client` `FrameReceiver`), and the write halves are stored
/// in the session's [`SessionTx::Vbus`] for transmits.
///
/// The session lands in the same `remote_sessions` map as a remote
/// session and is keyed by the full `local-vbus://<id>` URL, so the
/// rest of the host (`transmit_frame`, `connectedBusIds`, Disconnect)
/// treats it uniformly.
#[allow(clippy::too_many_lines)]
fn connect_local_vbus(
    app: &AppHandle,
    address: String,
    vbus_id: &str,
    binding_lookup: &[InterfaceBusBinding],
) -> Result<RemoteSessionResult, String> {
    sys_info!(
        &app,
        "connection",
        "opening in-process session against {address}"
    );

    let state: State<'_, AppState> = app.state();

    // Attach one participant per binding while we still hold the
    // registry's view of the vbus. We collect (channel, sink,
    // source, bus_id) tuples; sinks become the session's transmit
    // handles, sources are pumped on per-channel threads.
    let mut participants: Vec<(u8, cannet_core::LocalSink, cannet_core::LocalSource, String)> =
        Vec::with_capacity(binding_lookup.len());
    for (i, binding) in binding_lookup.iter().enumerate() {
        let channel = u8::try_from(i).unwrap_or(u8::MAX);
        match state.local_buses.attach_participant(vbus_id) {
            Ok((sink, source)) => {
                participants.push((channel, sink, source, binding.bus_id.clone()));
            }
            Err(e) => {
                let msg = format!("failed to open in-process session against {address}: {e}");
                sys_error!(&app, "connection", "{msg}");
                return Err(msg);
            }
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let channel_to_interface: Vec<(u8, String)> = participants
        .iter()
        .map(|(c, _, _, _)| (*c, project::LOCAL_VBUS_INTERFACE.to_string()))
        .collect();
    let channel_to_bus: Vec<(u8, Option<String>)> = participants
        .iter()
        .map(|(c, _, _, bid)| (*c, Some(bid.clone())))
        .collect();
    let subscriptions: Vec<ipc::SubscriptionRecord> = participants
        .iter()
        .map(|(c, _, _, _)| ipc::SubscriptionRecord {
            interface_id: project::LOCAL_VBUS_INTERFACE.to_string(),
            channel: *c,
        })
        .collect();

    // Move the participants into (sinks, sources). Sinks go into the
    // session map under `SessionTx::Vbus`; sources are handed off to
    // per-channel pumps.
    let mut sinks: Vec<(u8, std::sync::Arc<std::sync::Mutex<cannet_core::LocalSink>>)> =
        Vec::with_capacity(participants.len());
    let mut pumps: Vec<(u8, String, cannet_core::LocalSource)> =
        Vec::with_capacity(participants.len());
    for (channel, sink, source, bus_id) in participants {
        sinks.push((channel, std::sync::Arc::new(std::sync::Mutex::new(sink))));
        pumps.push((channel, bus_id, source));
    }

    {
        let mut guard = state
            .remote_sessions
            .lock()
            .expect("remote_sessions mutex poisoned");
        if guard.contains_key(&address) {
            let msg = format!("already connected to {address}");
            sys_warn!(&app, "connection", "{msg}");
            return Err(msg);
        }
        guard.insert(
            address.clone(),
            RemoteSession {
                handle: None,
                tx: SessionTx::Vbus(sinks),
                channel_to_interface,
                channel_to_bus: channel_to_bus.clone(),
                stop: Arc::clone(&stop),
            },
        );
    }

    // Spawn one pump per participant. Each pump exits when the
    // session-wide stop flag is set or when its `LocalSource`
    // returns `None` (which happens when the matching `LocalSink` is
    // dropped — that's how Disconnect tears participants down).
    for (channel, bus_id, source) in pumps {
        let app_for_thread = app.clone();
        let stop = Arc::clone(&stop);
        let address_for_cleanup = address.clone();
        let cleanup_addr_for_log = address.clone();
        let channel_to_bus = vec![(channel, Some(bus_id.clone()))];
        std::thread::Builder::new()
            .name(format!("cannet-vbus-pump:{address_for_cleanup}#{channel}"))
            .spawn(move || {
                let adapter = LocalSourceFrameSource { source, channel };
                run_pump(&app_for_thread, adapter, stop, channel_to_bus, false);
                // When the *last* participant's pump exits, drop the
                // session entry so the URL is free for a fresh
                // connect. Use a guarded check — pumps may exit out
                // of order; the first one shouldn't tear the whole
                // session down.
                let state: State<'_, AppState> = app_for_thread.state();
                let mut guard = state
                    .remote_sessions
                    .lock()
                    .expect("remote_sessions mutex poisoned");
                let session_dead = guard.get(&address_for_cleanup).is_none_or(|s| match &s.tx {
                    SessionTx::Vbus(sinks) => sinks.is_empty(),
                    SessionTx::Remote(_) => false,
                });
                if session_dead {
                    guard.remove(&address_for_cleanup);
                    drop(guard);
                    sys_info!(
                        &app_for_thread,
                        "connection",
                        "in-process session {cleanup_addr_for_log} closed",
                    );
                }
            })
            .map_err(|e| format!("failed to spawn vbus pump thread: {e}"))?;
    }

    sys_info!(
        &app,
        "connection",
        "opened in-process session against {address} ({n} participant(s))",
        n = subscriptions.len(),
    );

    Ok(RemoteSessionResult {
        address,
        subscriptions,
        interfaces: Vec::new(),
    })
}

/// Adapter: a [`cannet_core::LocalSource`] satisfies
/// [`cannet_core::CanFrameSource`] by waiting for the next
/// `ParticipantEvent::Frame` and stamping the configured channel on
/// the frame before passing it up. Frame events from the source
/// arrive with `Direction::Rx` (the bus already flipped direction on
/// fan-out — see `SharedBus::deliver_to_others`); the trace store
/// records them as the receiving project bus's `Rx` row.
struct LocalSourceFrameSource {
    source: cannet_core::LocalSource,
    channel: u8,
}

impl cannet_core::CanFrameSource for LocalSourceFrameSource {
    type Error = std::convert::Infallible;

    fn next_frame(&mut self) -> Result<Option<cannet_core::CanFrame>, Self::Error> {
        loop {
            match self.source.next_event() {
                Some(cannet_core::ParticipantEvent::Frame {
                    mut frame,
                    sender: _,
                }) => {
                    frame.channel = self.channel;
                    return Ok(Some(frame));
                }
                Some(cannet_core::ParticipantEvent::NoAcknowledger(_)) => {
                    // Host-side participants don't currently surface
                    // NACKs to the trace; spin to the next event.
                }
                None => return Ok(None),
            }
        }
    }
}

/// End remote sessions: set their pumps' stop flags and drop their
/// [`SessionHandle`]s. The flags make pumps break out of their loops
/// on the next iteration — without first replaying whatever frames the
/// gRPC tasks already buffered — and dropping the handles closes the
/// streams. Each pump removes its own entry on exit.
///
/// `address = None` disconnects every active session; `Some(addr)`
/// disconnects only that one.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn disconnect_remote_server(app: AppHandle, state: State<'_, AppState>, address: Option<String>) {
    let sessions: Vec<(String, RemoteSession)> = {
        let mut guard = state
            .remote_sessions
            .lock()
            .expect("remote_sessions mutex poisoned");
        match address {
            Some(addr) => guard.remove(&addr).map(|s| (addr, s)).into_iter().collect(),
            None => guard.drain().collect(),
        }
    };
    for (addr, session) in sessions {
        session.stop.store(true, Ordering::Relaxed);
        // Dropping the handle signals the worker to disconnect; the
        // transmitter goes with it, so subsequent transmit_frame calls
        // see SessionClosed.
        drop(session);
        sys_info!(&app, "connection", "disconnected from {addr}");
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
// On each frame the pump tags it with the bus_id matching
// its `channel`; a channel with no entry stays `bus_id: None`; a
// channel mapped to `None` is dropped (the BLF-import "skip" path).
#[allow(clippy::needless_pass_by_value)]
fn run_pump<S>(
    app: &AppHandle,
    mut source: S,
    stop: Arc<AtomicBool>,
    channel_to_bus: Vec<(u8, Option<String>)>,
    replay_origin: bool,
) where
    S: CanFrameSource,
    S::Error: fmt::Display,
{
    let state: State<'_, AppState> = app.state();
    let mut total: u64 = 0;
    // For replay sources (BLF) the session timeline is the file's own
    // — the first frame's timestamp becomes the session-start. Live
    // sources keep the wall-clock session-start the GUI set via
    // `clear_trace_store` before connecting.
    let mut needs_replay_session_start = replay_origin;

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
                if needs_replay_session_start {
                    state.trace_store.start_session(raw.timestamp_ns);
                    needs_replay_session_start = false;
                }
                // Ingest-time verification (ADR 0027): ids with a
                // calculated-field config get checked against the
                // appended index. The `wants` probe keeps the
                // unconfigured fast path clone-free.
                let checked = state.verifier.wants(&raw).then(|| raw.clone());
                if let Some(index) = state.trace_store.append(raw) {
                    if let Some(frame) = checked {
                        state.verifier.observe(app, &frame, index);
                    }
                }
                total = total.saturating_add(1);
            }
            Ok(None) => break,
            Err(e) => {
                let msg = e.to_string();
                sys_error!(app, "connection", "frame source ended with error: {msg}");
                let _ = app.emit("log-finished", LogFinished::Error { message: msg });
                return;
            }
        }
    }

    sys_info!(
        app,
        "connection",
        "frame source ended cleanly ({total} frames)"
    );
    let _ = app.emit("log-finished", LogFinished::Ok { total });
}

// ---- host-side TX-message registry IPC surface ----
//
// Every transmit panel is a thin view onto the host pool. Mutations go
// through these commands; each emits `transmit-frames-changed` so open
// views re-fetch. Periodic schedules run on host threads
// (`spawn_periodic_transmit`), not a JS `setInterval`.

/// Notify open transmit views that the pool changed so they re-fetch.
fn emit_transmit_frames_changed(app: &AppHandle) {
    let _ = app.emit("transmit-frames-changed", ());
}

/// Resolve the *effective* calculated-fields config for one TX
/// message (ADR 0027): the DBC-declared defaults (`CannetCounter` /
/// `CannetCrc` attributes) with the message's override spec layered
/// on top — an override replaces the DBC default wholesale for that
/// field. The resolving DBC is the first one scoped to the request's
/// bus that defines the message id. `Ok(None)` when nothing is
/// configured for the message.
fn resolve_effective_calc(
    dbs: &[LoadedDbc],
    request: &ipc::TransmitRequest,
    override_spec: Option<&ipc::CalcFieldsSpec>,
) -> Result<Option<cannet_dbc::ResolvedCalculatedFields>, String> {
    let no_override = override_spec.is_none_or(ipc::CalcFieldsSpec::is_empty);
    let id = if request.extended {
        CanId::extended(request.id)
    } else {
        CanId::standard(request.id)
    };
    let Ok(id) = id else {
        // An unencodable arbitration id can't carry calculated fields;
        // the transmit path itself will surface the id error.
        return Ok(None);
    };
    let Some(loaded) = dbs
        .iter()
        .filter(|d| d.buses.is_empty() || d.buses.iter().any(|b| b == &request.bus_id))
        .find(|d| d.db.dbc_calculated_fields(id).is_some())
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
    let (mut counter, mut crc) = (dbc_default.counter, dbc_default.crc);
    if let Some(o) = override_config {
        if o.counter.is_some() {
            counter = o.counter;
        }
        if o.crc.is_some() {
            crc = o.crc;
        }
    }
    let merged = cannet_dbc::CalculatedFieldsConfig { counter, crc };
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
fn fetch_field_validity(state: State<'_, AppState>) -> Vec<verification::ValidityRecord> {
    state.verifier.validity_snapshot()
}

/// Rebuild the ingest-time verifier's config index from the loaded
/// DBC set plus every RBS element's per-message overrides (an
/// override replaces the DBC default per field — ADR 0027). Called
/// alongside the calc-resolution refresh whenever DBCs, project
/// buses, or RBS configs change.
pub(crate) fn rebuild_verification(state: &AppState) {
    let overrides: Vec<(String, u32, bool, cannet_dbc::CalculatedFieldsConfig)> = {
        let rbs_guard = state.rbs.lock().expect("rbs mutex poisoned");
        let dbs = state.databases.lock().expect("databases mutex poisoned");
        let mut out = Vec::new();
        for element in rbs_guard.elements.values() {
            for (bus_key, bus) in &element.file.buses {
                let Some(bus_id) = rbs_guard
                    .project_buses
                    .iter()
                    .find(|(_, n)| n == bus_key)
                    .map(|(id, _)| id.clone())
                else {
                    continue;
                };
                for ecu in bus.ecus.values() {
                    for (msg_key, msg) in &ecu.messages {
                        if msg.counter.is_none() && msg.crc.is_none() {
                            continue;
                        }
                        let Ok((id, extended)) = rbs::parse_message_key(msg_key) else {
                            continue;
                        };
                        let can_id = if extended {
                            CanId::extended(id)
                        } else {
                            CanId::standard(id)
                        };
                        let Ok(can_id) = can_id else { continue };
                        let spec = ipc::CalcFieldsSpec {
                            counter: msg.counter.clone(),
                            crc: msg.crc.clone(),
                        };
                        let Ok(override_config) = spec.to_config() else {
                            continue;
                        };
                        // Per-field layering over the DBC default.
                        let dbc_default = dbs
                            .iter()
                            .filter(|d| d.buses.is_empty() || d.buses.iter().any(|b| b == &bus_id))
                            .find_map(|d| d.db.dbc_calculated_fields(can_id))
                            .cloned()
                            .unwrap_or_default();
                        let merged = cannet_dbc::CalculatedFieldsConfig {
                            counter: override_config.counter.or(dbc_default.counter),
                            crc: override_config.crc.or(dbc_default.crc),
                        };
                        if !merged.is_empty() {
                            out.push((bus_id.clone(), id, extended, merged));
                        }
                    }
                }
            }
        }
        out
    };
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    state.verifier.rebuild_configs(&dbs, &overrides);
}

/// Re-resolve every TX-registry entry's calculated fields against the
/// current DBC set. Called whenever either side changes — a DBC is
/// added / removed / rescoped / auto-reloaded, a project is opened,
/// or an entry is edited. A resolution failure clears that entry's
/// fields (the frame still transmits, without recompute) and warns on
/// the system log.
pub(crate) fn refresh_calc_resolutions(app: &AppHandle) {
    let state: State<'_, AppState> = app.state();
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    let mut registry = state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned");
    for (id, request, spec) in registry.resolution_inputs() {
        match resolve_effective_calc(&dbs, &request, spec.as_ref()) {
            Ok(resolved) => registry.set_resolved_calc(&id, resolved),
            Err(e) => {
                registry.set_resolved_calc(&id, None);
                sys_warn!(
                    app,
                    "transmit",
                    "calculated fields disabled for TX message {id}: {e}"
                );
            }
        }
    }
}

/// Snapshot the TX-message pool (each message + its `running` flag), in
/// pool order.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_transmit_frames(state: State<'_, AppState>) -> Vec<transmit_frames::TransmitFrameView> {
    state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned")
        .list()
}

/// Insert a new TX message or update an existing one in place. The
/// command arg `id` is authoritative (it overrides any id carried on
/// `frame`). Parking the message (`manual` mode or `cycle_ms == 0`)
/// marks it stopped and unschedules it from the scheduler; a non-parking
/// edit to a running periodic (e.g. a payload change) leaves it running,
/// and the scheduler picks the new value up on its next tick.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn set_transmit_frame(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    mut frame: transmit_frames::TransmitFrame,
) {
    id.clone_into(&mut frame.id);
    let parked = frame.mode != transmit_frames::TransmitMode::Periodic || frame.cycle_ms == 0;
    state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned")
        .set(frame);
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
fn remove_transmit_frame(app: AppHandle, state: State<'_, AppState>, id: String) {
    state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned")
        .remove(&id);
    state.transmit_scheduler.stop(id);
    emit_transmit_frames_changed(&app);
}

/// Rewrite the pool order to match `ids`.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn reorder_transmit_frames(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) {
    state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned")
        .reorder(&ids);
    emit_transmit_frames_changed(&app);
}

/// Stop every periodic and drop all TX messages (used by New project).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn clear_transmit_frames(app: AppHandle, state: State<'_, AppState>) {
    state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned")
        .clear();
    emit_transmit_frames_changed(&app);
}

/// Send one TX message now (the manual-send path). Looks the request up
/// by id and routes it through the same `transmit_frame_inner` the
/// scheduler uses — one transmit primitive, no special-casing.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn transmit_frame_once(
    state: State<'_, AppState>,
    id: String,
) -> Result<ipc::TransmitResult, String> {
    let request = state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned")
        .send_request(&id)
        .ok_or_else(|| format!("no transmit frame with id {id}"))?;
    transmit_frame_inner(state.inner(), &request)
}

/// Start a message's periodic schedule. Rejects non-periodic messages
/// and a zero period; a no-op if it's already running. Adds the message
/// to the single scheduler thread rather than spawning one of its own.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn start_periodic_transmit(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let newly_started = {
        let mut registry = state
            .transmit_frames
            .lock()
            .expect("transmit_frames mutex poisoned");
        let newly_started = registry.begin_periodic(&id)?;
        if newly_started {
            // The owner is starting to transmit — the sequence counter
            // seeds at 0 (ADR 0027).
            registry.reset_counter(&id);
        }
        newly_started
    };
    if newly_started {
        state.transmit_scheduler.start(id);
    }
    emit_transmit_frames_changed(&app);
    Ok(())
}

/// Stop a message's periodic schedule. A no-op if it isn't running.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn stop_periodic_transmit(app: AppHandle, state: State<'_, AppState>, id: String) {
    state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned")
        .stop_periodic(&id);
    state.transmit_scheduler.stop(id);
    emit_transmit_frames_changed(&app);
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
fn next_tick_deadline(
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
    /// scheduler stays silent.
    fn maybe_emit(&mut self, now: std::time::Instant) {
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
/// On each due entry it asks the registry [`fire_info`] what to emit
/// (re-read every tick, so live payload / period edits land on the next
/// emission — property 4), skips the actual transmit when the target bus
/// has no live session (no tx-confirm while disconnected; the
/// schedule keeps ticking and resumes on reconnect), and reschedules on
/// a fixed-rate grid via [`next_tick_deadline`] (work time absorbed, no
/// catch-up burst). A `fire_info` of `None` (stopped, parked, or
/// removed) drops the entry from the schedule. The thread exits when
/// every [`transmit_scheduler::TransmitScheduler`] sender is dropped
/// (app shutdown).
fn run_transmit_scheduler(
    app: &AppHandle,
    rx: &std::sync::mpsc::Receiver<transmit_scheduler::SchedulerCmd>,
) {
    use std::sync::mpsc::RecvTimeoutError;
    use transmit_scheduler::SchedulerCmd;

    let mut schedule = transmit_scheduler::PeriodicSchedule::new();
    // Idle wait when nothing is scheduled — long, but bounded so the
    // thread stays responsive to a spurious wake and re-checks cleanly.
    let idle = Duration::from_hours(1);
    let mut diag = SchedDiag::new(std::time::Instant::now());
    loop {
        let planned = schedule.next_deadline();
        let wait = planned.map_or(idle, |d| {
            d.saturating_duration_since(std::time::Instant::now())
        });
        let recv = rx.recv_timeout(wait);
        let now = std::time::Instant::now();
        match recv {
            Ok(SchedulerCmd::Start(id)) => schedule.schedule(id, now),
            Ok(SchedulerCmd::Stop(id)) => schedule.unschedule(&id),
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
        let fire_start = std::time::Instant::now();
        let mut fired = 0usize;
        for (id, fired_at) in schedule.take_due(now) {
            let Some((request, cycle_ms)) = state
                .transmit_frames
                .lock()
                .expect("transmit_frames mutex poisoned")
                .fire_info(&id)
            else {
                // Stopped, parked, or removed — drop it from the schedule.
                schedule.unschedule(&id);
                continue;
            };
            fired += 1;
            let connected = {
                let sessions = state
                    .remote_sessions
                    .lock()
                    .expect("remote_sessions mutex poisoned");
                resolve_bus_route(&sessions, &request.bus_id).is_some()
            };
            if connected {
                let _ = transmit_frame_inner(state.inner(), &request);
            }
            let period = Duration::from_millis(u64::from(cycle_ms));
            let next = next_tick_deadline(fired_at, std::time::Instant::now(), period);
            schedule.reschedule(&id, next);
        }
        if fired > 0 {
            diag.record_fire(fire_start.elapsed(), fired);
        }
        diag.maybe_emit(std::time::Instant::now());
    }
}

/// The one transmit primitive: compose a frame from a request, append
/// it to the trace as a `Tx`-direction tx-confirm row (always, even
/// with no remote session — that's what a real analyzer shows for its
/// own transmits), and — if a remote session is open — forward it onto
/// the wire too. Both the manual `transmit_frame_once` command and the
/// scheduler thread (`run_transmit_scheduler`) route through here, so
/// there's no special-casing for the periodic case.
/// Server-side rejection (e.g. the BLF replay server's
/// `Error::TX_REJECTED`) surfaces inline through the receive pump as a
/// `ConnectionError::Server`; the returned `wire_status` only reports
/// the *enqueue* outcome.
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
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX));

    // Resolve `bus_id` → `(session, channel, interface_id)`. With no
    // active session for the target bus, we still want a local Tx-
    // confirm to land (the user sees what they tried to send); use
    // wire channel 0 in that case — the trace view shows the *bus*
    // column, not the wire channel, so it stays unambiguous.
    let sessions_guard = state
        .remote_sessions
        .lock()
        .expect("remote_sessions mutex poisoned");
    let routing = resolve_bus_route(&sessions_guard, &request.bus_id);
    let wire_channel = routing.as_ref().map_or(0u8, |r| r.channel);

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

    // Append the tx-confirm — stamp it with the target `bus_id` so
    // the local trace view shows it on the right bus, even when no
    // remote session is actually carrying it.
    let mut raw = RawTraceFrame::from(frame.clone());
    raw.bus_id = Some(request.bus_id.clone());
    let tx_confirm_index = state.trace_store.append(raw).unwrap_or(u64::MAX);

    let wire_status = match routing {
        None if sessions_guard.is_empty() => ipc::TransmitWireStatus::NotConnected,
        None => ipc::TransmitWireStatus::Failed {
            message: format!("bus {} is not bound on any active server", request.bus_id),
        },
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
                Ok(()) => ipc::TransmitWireStatus::Sent { interface_id },
                Err(message) => ipc::TransmitWireStatus::Failed { message },
            }
        }
    };
    drop(sessions_guard);

    Ok(ipc::TransmitResult {
        tx_confirm_index,
        wire_status,
    })
}

/// One resolved bus → wire route. Returned from
/// [`resolve_bus_route`]; carries the server address (so the caller
/// can re-borrow the session under the same lock), the wire channel
/// the bus maps to, and the wire interface id the transmit must be
/// addressed to.
struct BusRoute {
    address: String,
    channel: u8,
    interface_id: String,
}

/// Walk the active sessions, find the first one whose
/// `channel_to_bus` lists this bus id, and return the resolved
/// route. The first-match-wins semantics matches the current
/// project-side rule of "one interface binding per bus".
pub(crate) fn resolve_bus_route(
    sessions: &std::collections::HashMap<String, RemoteSession>,
    bus_id: &str,
) -> Option<BusRoute> {
    for (address, session) in sessions {
        for (ch, b) in &session.channel_to_bus {
            if b.as_deref() == Some(bus_id) {
                if let Some((_, iid)) = session.channel_to_interface.iter().find(|(c, _)| c == ch) {
                    return Some(BusRoute {
                        address: address.clone(),
                        channel: *ch,
                        interface_id: iid.clone(),
                    });
                }
            }
        }
    }
    None
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
        if let Some(rows) = loaded
            .db
            .value_table_for_signal(message_id, extended, &signal_name)
        {
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

/// Run a batch of signal edits through
/// [`cannet_dbc::Database::encode_frame`] against the first DBC that
/// claims the `(message_id, extended)` pair. Returns the updated
/// payload bytes plus any signals the encoder couldn't place.
///
/// The transmit panel calls this on every signal-table edit: it passes
/// the current `dataHex` (decoded to bytes) and the signal that
/// changed; the host returns the new bytes which the panel writes back
/// into `dataHex`. Partial encode means an unrelated signal in the
/// same payload (or a non-DBC-mapped byte — CRC, sequence count,
/// padding) is preserved across the call.
///
/// Returns `Err` only on infrastructure faults (mutex poisoned, no
/// DBC matches the id). A signal name with no match on the resolved
/// message lands in the `skipped` list instead — same shape as a
/// successful response. The frontend treats "no DBC matches" as
/// "stay in raw-bytes mode."
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn encode_frame(
    state: State<'_, AppState>,
    message_id: u32,
    extended: bool,
    signals: Vec<ipc::EncodeFrameSignal>,
    base: Vec<u8>,
) -> Result<ipc::EncodeFrameResponse, String> {
    encode_frame_inner(state.inner(), message_id, extended, &signals, base)
}

/// Return the rich descriptor for one DBC message (signals, range,
/// mux indicator, …) — what the transmit panel needs to render the
/// signals table without reimplementing DBC walking on the frontend.
/// Returns `None` if no DBC matches the id.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn describe_message(
    state: State<'_, AppState>,
    message_id: u32,
    extended: bool,
) -> Option<ipc::MessageDescriptorRecord> {
    describe_message_inner(state.inner(), message_id, extended)
}

fn describe_message_inner(
    state: &AppState,
    message_id: u32,
    extended: bool,
) -> Option<ipc::MessageDescriptorRecord> {
    let id = if extended {
        cannet_core::CanId::extended(message_id).ok()?
    } else {
        cannet_core::CanId::standard(message_id).ok()?
    };
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    for loaded in dbs.iter() {
        if let Some(desc) = loaded.db.describe_message(id) {
            let signals: Vec<ipc::SignalDescriptorRichRecord> = desc
                .signals
                .into_iter()
                .map(|s| ipc::SignalDescriptorRichRecord {
                    name: s.name,
                    unit: s.unit,
                    factor: s.factor,
                    offset: s.offset,
                    min: s.min,
                    max: s.max,
                    size: s.size,
                    signed: s.signed,
                    mux: match s.mux {
                        cannet_dbc::SignalMux::Plain => ipc::SignalMuxRecord::Plain,
                        cannet_dbc::SignalMux::Multiplexor => ipc::SignalMuxRecord::Multiplexor,
                        cannet_dbc::SignalMux::Multiplexed { selector } => {
                            ipc::SignalMuxRecord::Multiplexed { selector }
                        }
                        cannet_dbc::SignalMux::MultiplexorAndMultiplexed { selector } => {
                            ipc::SignalMuxRecord::MultiplexorAndMultiplexed { selector }
                        }
                    },
                    float_kind: match s.float_kind {
                        cannet_dbc::FloatKind::Integer => "integer",
                        cannet_dbc::FloatKind::Float32 => "float32",
                        cannet_dbc::FloatKind::Float64 => "float64",
                    },
                    has_value_table: s.has_value_table,
                    start_value_raw: s.start_value_raw,
                })
                .collect();
            let calc_fields = if desc.calc_fields.is_empty() {
                None
            } else {
                Some(ipc::CalcFieldsSpec::from_config(&desc.calc_fields))
            };
            return Some(ipc::MessageDescriptorRecord {
                name: desc.name,
                expected_len: desc.expected_len,
                is_fd: desc.is_fd,
                brs: desc.brs,
                gen_msg_cycle_time_ms: desc.gen_msg_cycle_time_ms,
                gen_msg_send_type: desc.gen_msg_send_type,
                uses_extended_mux: desc.uses_extended_mux,
                calc_fields,
                signals,
            });
        }
    }
    None
}

/// Decode the current payload bytes of a hypothetical (panel-side)
/// frame through the first DBC that claims `(message_id, extended)`.
/// Same decoded-signal shape the trace view uses, but the frame
/// doesn't need to be in the trace store.
///
/// Returns `None` if no DBC matches the id.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn decode_frame(
    state: State<'_, AppState>,
    message_id: u32,
    extended: bool,
    data: Vec<u8>,
) -> Option<ipc::DecodedFrameRecord> {
    decode_frame_inner(state.inner(), message_id, extended, &data)
}

fn decode_frame_inner(
    state: &AppState,
    message_id: u32,
    extended: bool,
    data: &[u8],
) -> Option<ipc::DecodedFrameRecord> {
    let id = if extended {
        cannet_core::CanId::extended(message_id).ok()?
    } else {
        cannet_core::CanId::standard(message_id).ok()?
    };
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    for loaded in dbs.iter() {
        if let Some(decoded) = loaded.db.decode_raw(id, data) {
            return Some(ipc::DecodedFrameRecord {
                name: decoded.name.to_string(),
                signals: decoded.signals.iter().map(signal_to_wire).collect(),
            });
        }
    }
    None
}

fn encode_frame_inner(
    state: &AppState,
    message_id: u32,
    extended: bool,
    signals: &[ipc::EncodeFrameSignal],
    base: Vec<u8>,
) -> Result<ipc::EncodeFrameResponse, String> {
    let id = if extended {
        cannet_core::CanId::extended(message_id).map_err(|e| format!("invalid extended id: {e}"))?
    } else {
        cannet_core::CanId::standard(message_id).map_err(|e| format!("invalid standard id: {e}"))?
    };
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    let mut bytes = base;
    let signal_pairs: Vec<(&str, f64)> = signals
        .iter()
        .map(|s| (s.name.as_str(), s.physical))
        .collect();
    for loaded in dbs.iter() {
        if let Some(report) = loaded.db.encode_frame(id, &signal_pairs, &mut bytes) {
            let skipped = report
                .skipped
                .into_iter()
                .map(|s| ipc::EncodeFrameSkipped {
                    name: s.name,
                    reason: match s.reason {
                        cannet_dbc::SkipReason::SignalNotFound => "signal_not_found",
                        cannet_dbc::SkipReason::BaseTooShort => "base_too_short",
                        cannet_dbc::SkipReason::SizeOutOfRange => "size_out_of_range",
                    },
                })
                .collect();
            return Ok(ipc::EncodeFrameResponse { bytes, skipped });
        }
    }
    Err(format!(
        "no DBC matches id 0x{message_id:X} (extended={extended})"
    ))
}

fn signal_to_wire(sig: &DecodedSignal<'_>) -> SignalRecord {
    SignalRecord {
        name: sig.name.to_string(),
        value: sig.value,
        unit: sig.unit.to_string(),
        label: sig.label.map(str::to_string),
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

    /// Drive a [`PageSelector`] with a sequence of match indices.
    fn select(
        matches: &[usize],
        offset: u64,
        limit: u64,
        from_end: bool,
        seed: u64,
    ) -> (u64, Vec<usize>, u64) {
        let mut sel = PageSelector::new(offset, limit, from_end, seed);
        for &idx in matches {
            sel.push(idx);
        }
        sel.finish()
    }

    #[test]
    fn page_selector_pages_a_forward_offset_limit_slice() {
        let m = [10usize, 20, 30, 40, 50];
        // match-indices 1..3 → the 2nd and 3rd matches.
        let (count, page, start) = select(&m, 1, 2, false, 0);
        assert_eq!(count, 5);
        assert_eq!(page, vec![20, 30]);
        assert_eq!(start, 1);
    }

    #[test]
    fn page_selector_from_end_keeps_the_last_limit_matches() {
        let m = [10usize, 20, 30, 40, 50];
        let (count, page, start) = select(&m, 0, 2, true, 0);
        assert_eq!(count, 5);
        assert_eq!(page, vec![40, 50]);
        assert_eq!(start, 3); // count - page.len()
    }

    #[test]
    fn page_selector_limit_zero_counts_without_paging() {
        let m = [10usize, 20, 30, 40, 50];
        let (count, page, start) = select(&m, 0, 0, false, 0);
        assert_eq!(count, 5);
        assert!(page.is_empty());
        assert_eq!(start, 0);
    }

    #[test]
    fn page_selector_offset_past_the_end_is_an_empty_page() {
        let m = [10usize, 20, 30];
        let (count, page, start) = select(&m, 99, 10, false, 0);
        assert_eq!(count, 3);
        assert!(page.is_empty());
        assert_eq!(start, 3); // offset.min(count)
    }

    #[test]
    fn tail_page_keeps_the_most_recent_cap_in_render_order() {
        // Backward chunked scan appends each chunk newest-first, so the
        // input is descending overall. A window of 6 matches, cap 3:
        // newest chunk {15,20}→[20,15], next {9,12}→[12,9] (loop stops,
        // ≥cap collected). Keep the 3 newest, return ascending.
        let collected_desc = vec![20usize, 15, 12, 9];
        let (page, start) = tail_page(collected_desc, 3, 6);
        assert_eq!(page, vec![12, 15, 20]); // last 3 matches, oldest-first
        assert_eq!(start, 3); // total(6) - page.len(3): match-index of `12`

        // The from_end PageSelector over the same full match set must agree
        // — the incremental tail and a full re-scan return the same page.
        let full = [3usize, 7, 9, 12, 15, 20];
        let (count, sel_page, sel_start) = select(&full, 0, 3, true, 0);
        assert_eq!((count, sel_page, sel_start), (6, page, start));
    }

    #[test]
    fn tail_page_fewer_matches_than_cap_returns_all_from_zero() {
        // Sparse window: backward scan reached win_start with < cap; keep
        // all, anchored at match-index 0.
        let (page, start) = tail_page(vec![30usize, 20, 10], 10, 3);
        assert_eq!(page, vec![10, 20, 30]);
        assert_eq!(start, 0);
    }

    #[test]
    fn page_selector_seed_makes_an_incremental_count_equal_a_full_count() {
        // The incremental-count invariant: counting all matches at once
        // must equal counting a prefix, then resuming from the prefix's
        // total over the remaining matches (the O(Δ) refresh).
        let m = [10usize, 20, 30, 40, 50, 60, 70];
        let (full, _, _) = select(&m, 0, 0, false, 0);

        let k = 3;
        let (prefix, _, _) = select(&m[..k], 0, 0, false, 0);
        let (resumed, _, _) = select(&m[k..], 0, 0, false, prefix);
        assert_eq!(resumed, full);
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
        let rows = [snap(0x200, 1, 0.0, None), snap(0x100, 0, 0.0, None), snap(0x100, 2, 0.0, None)];
        // None key leaves the input order (the host default).
        assert_eq!(sorted_ids(&rows, None, None, &names), vec![0x200, 0x100, 0x100]);
        // Stable: the two 0x100 rows keep their input order (channels 0, 2).
        let mut v = rows.to_vec();
        sort_by_id(&mut v, Some("id"), Some("asc"), &names);
        assert_eq!(
            v.iter().map(|r| (r.frame.id, r.frame.channel)).collect::<Vec<_>>(),
            vec![(0x100, 0), (0x100, 2), (0x200, 1)],
        );
        assert_eq!(sorted_ids(&rows, Some("id"), Some("desc"), &names), vec![0x200, 0x100, 0x100]);
    }

    #[test]
    fn sort_by_id_orders_by_rate() {
        let names = HashMap::new();
        let rows = [snap(0x100, 0, 5.0, None), snap(0x200, 0, 50.0, None), snap(0x300, 0, 0.5, None)];
        assert_eq!(sorted_ids(&rows, Some("rate"), Some("asc"), &names), vec![0x300, 0x100, 0x200]);
        assert_eq!(sorted_ids(&rows, Some("rate"), Some("desc"), &names), vec![0x200, 0x100, 0x300]);
    }

    #[test]
    fn sort_by_id_orders_by_bus_name_unassigned_last() {
        // Sorts by the resolved bus *name*, with the unassigned bucket
        // after any real bus ascending (and before them descending).
        let names: HashMap<String, String> =
            [("p".to_string(), "Powertrain".to_string()), ("c".to_string(), "Chassis".to_string())]
                .into_iter()
                .collect();
        let rows = [
            snap(0x100, 0, 0.0, Some("p")), // Powertrain
            snap(0x200, 0, 0.0, None),      // unassigned
            snap(0x300, 0, 0.0, Some("c")), // Chassis
        ];
        assert_eq!(sorted_ids(&rows, Some("bus"), Some("asc"), &names), vec![0x300, 0x100, 0x200]);
        assert_eq!(sorted_ids(&rows, Some("bus"), Some("desc"), &names), vec![0x200, 0x100, 0x300]);
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
        AppState {
            databases: Mutex::new(Vec::new()),
            remote_sessions: Mutex::new(HashMap::new()),
            trace_store: Arc::new(TraceStore::new()),
            signal_caches: SignalCacheStore::new(),
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
        }
    }

    pub(crate) fn loaded(path: &str, dbc_text: &str) -> LoadedDbc {
        LoadedDbc {
            path: path.into(),
            db: Database::parse(dbc_text).expect("test DBC parses"),
            buses: Vec::new(),
        }
    }

    pub(crate) fn loaded_scoped(path: &str, dbc_text: &str, buses: &[&str]) -> LoadedDbc {
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
        use cannet_dbc::Database;
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
        let db_refs: Vec<&Database> = dbs_guard.iter().map(|l| &l.db).collect();
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
        use cannet_dbc::Database;
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
        let db_refs: Vec<&Database> = dbs_guard.iter().map(|l| &l.db).collect();

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
            },
            notes::Note {
                id: "b".into(),
                timestamp_ns: ts_base + 1_500,
                label: "second".into(),
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
        assert_eq!(recovered[1].id, "b");
        assert_eq!(recovered[1].label, "second");
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
