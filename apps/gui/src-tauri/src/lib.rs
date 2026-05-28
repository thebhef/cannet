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
mod interfaces;
mod ipc;
mod notes;
mod project;
mod signal_cache;
mod sidecar;
mod signal_sampler;
mod system_log;
mod trace_store;

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use cannet_blf::{BlfCanFrameSource, BlfCaptureWriter};
use cannet_client::{SessionHandle, SessionTransmitter, Subscription};
use cannet_core::{CanFrame as CoreCanFrame, CanFrameSource, CanId};
use cannet_dbc::{Database, DecodedSignal};
use filter::FilterPredicate;

use ipc::{
    ByIdSnapshot, DbcAttributeRecord, DbcContentRecord, DbcInfo, DbcMessageContentRecord,
    DbcSignalContentRecord, DecodedRecord, FilteredTracePage, InterfaceRecord, LogFinished,
    OpenLogResult, RemoteSessionResult, SampledPoints, SignalDescriptorRecord, SignalQuery,
    SignalRecord, SignalsSample, TraceFrameRecord, TraceGrew, ValueTableEntryRecord,
};
use notes::{Note, NotesStore};
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
    /// Session-scoped notes. Edited by `add_note` / `rename_note` /
    /// `remove_note` / `clear_notes` (each emits `notes-changed` on
    /// success); snapshotted by `fetch_notes`. Save Capture writes
    /// them inside the BLF as `GLOBAL_MARKER` records; Open Capture
    /// and project-open migration restore through them.
    notes: NotesStore,
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
            remote_sessions: Mutex::new(HashMap::new()),
            trace_store: TraceStore::new(),
            signal_caches: SignalCacheStore::new(),
            system_log: SystemLog::new(),
            notes: NotesStore::new(),
        })
        .manage(sidecar::SidecarState::default())
        .manage(interfaces::InterfacesState::default())
        .invoke_handler(tauri::generate_handler![
            open_log,
            scan_blf_channels,
            add_dbc,
            remove_dbc,
            clear_dbcs,
            set_dbc_buses,
            fetch_trace_range,
            fetch_latest_by_id,
            fetch_filtered_trace,
            clear_trace_store,
            connect_remote_server,
            disconnect_remote_server,
            project::open_project,
            project::save_project,
            list_signals,
            list_dbc_content,
            sample_signals,
            transmit_frame,
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
        ])
        .setup(|app| {
            // Make sure the main window has the id our capabilities expect.
            // Tauri assigns "main" by default for the first window in the
            // config; we rely on that here.
            debug_assert!(app.get_webview_window("main").is_some());
            spawn_trace_grew_emitter(app.handle().clone());
            sidecar::spawn_sidecar(app.handle());
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

    // Notes live inside the BLF as `GLOBAL_MARKER` records (ADR 0010 —
    // no sidecar files). Pull them out of the file in a quick pre-pass
    // before kicking off the frame pump. The session-buffer notes are
    // session-scoped, so any notes already in the store are replaced:
    // Open BLF is a fresh-capture action that wipes the trace store via
    // the surrounding GUI flow.
    let notes = match read_notes_from_blf(&blf_path) {
        Ok(v) => v,
        Err(e) => {
            sys_warn!(&app, "blf-import", "couldn't read markers from {blf_path}: {e}");
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
    // we'll revisit when disk-spill (Phase 10) lands.
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

/// Phase 6.5: a *paged* window into the filtered chronological trace.
/// Scans `[scan_start, scan_end)` of the trace store, applies `filter`,
/// and returns the total match count plus the decoded matches at
/// match-indices `[offset, offset + limit)` — or, when `from_end` is
/// set, the *last* `limit` matches, so the live-tail view gets its
/// page and the running total in one call. The frontend pages this; it
/// never holds the whole filtered set in memory.
///
/// The scan runs by reference inside the trace store
/// ([`TraceStore::scan_window_filtered`]) — only the returned page's
/// frames are cloned, never the whole window. Decoding is per-frame
/// only when the predicate needs decoded fields
/// ([`FilterPredicate::needs_decode`]); the page is always decoded for
/// display.
///
/// `async` so Tauri runs it off the main thread, like `fetch_trace_range`.
#[tauri::command]
#[allow(clippy::unused_async)] // `async` is what makes Tauri run it off the main thread
async fn fetch_filtered_trace(
    app: AppHandle,
    filter: FilterPredicate,
    scan_start: u64,
    scan_end: u64,
    offset: u64,
    limit: u64,
    from_end: bool,
) -> FilteredTracePage {
    let state: State<'_, AppState> = app.state();
    let start_us = usize::try_from(scan_start).unwrap_or(usize::MAX);
    let end_us = usize::try_from(scan_end).unwrap_or(usize::MAX);
    let needs_decode = filter.needs_decode();
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    let (count, pairs) = state.trace_store.scan_window_filtered(
        start_us,
        end_us,
        offset,
        limit,
        from_end,
        |frame| {
            let decoded = if needs_decode {
                decode_against(&dbs, frame)
            } else {
                None
            };
            filter.matches(frame, decoded.as_ref())
        },
    );
    let win_len = u64::try_from(pairs.len()).unwrap_or(u64::MAX);
    let start = if from_end {
        count.saturating_sub(win_len)
    } else {
        offset.min(count)
    };
    let rows = pairs
        .into_iter()
        .map(|(i, frame)| {
            let index = u64::try_from(i).unwrap_or(u64::MAX);
            TraceFrameRecord::from_raw(index, &frame, decode_against(&dbs, &frame))
        })
        .collect();
    FilteredTracePage { count, start, rows }
}

/// Drop every stored frame. The frontend's Clear button is the typical
/// caller. The next `trace-grew` tick will fire with the new count
/// (zero), prompting the trace view to drop its row cache. Phase 9:
/// any session-scoped notes go with the buffer (they reference
/// timestamps on the now-discarded timeline).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn clear_trace_store(app: AppHandle, state: State<'_, AppState>) {
    state.trace_store.clear();
    // The decoded-sample caches hold frame indices into the store —
    // wipe them too, otherwise the next `sample_signals` would slice
    // against a buffer that no longer exists.
    state.signal_caches.clear();
    if let Some(applied) = state.notes.clear() {
        let _ = app.emit("notes-changed", applied.notes);
    }
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

/// Push a System Messages entry from the frontend. Same plumbing as
/// the host-side `sys_info!` / `sys_warn!` / `sys_error!` macros: the
/// host's log bus assigns the `seq`, emits a `system-log-appended`
/// event, and the frontend mirror picks it up via its existing
/// listener — no separate channel for GUI-emitted entries.
///
/// Phase 12 surfaces this for the filter-defined plot area's
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

/// Phase 9: snapshot of the session-scoped notes, chronological.
/// Plot panels call this on mount to seed their event list and
/// reconcile against `notes-changed` events.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn fetch_notes(state: State<'_, AppState>) -> Vec<Note> {
    state.notes.snapshot()
}

/// Phase 9: add a note to the session buffer. Emits `notes-changed`
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

/// Phase 9: rename an existing note.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn rename_note(app: AppHandle, id: String, label: String) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.rename(&id, label) {
        let _ = app.emit("notes-changed", applied.notes);
    }
}

/// Phase 9: remove a note from the session buffer.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn remove_note(app: AppHandle, id: String) {
    let state: State<'_, AppState> = app.state();
    if let Some(applied) = state.notes.remove(&id) {
        let _ = app.emit("notes-changed", applied.notes);
    }
}

/// Phase 9: drop every note from the session buffer. Called by the
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

/// Snapshot every loaded DBC's content for the Phase 12 DBC
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
                .map(|m| DbcMessageContentRecord {
                    message_id: m.message_id,
                    extended: m.extended,
                    name: m.name,
                    comment: m.comment,
                    attributes: m
                        .attributes
                        .into_iter()
                        .map(|a| DbcAttributeRecord {
                            name: a.name,
                            value: a.value,
                        })
                        .collect(),
                    signals: m
                        .signals
                        .into_iter()
                        .map(|s| DbcSignalContentRecord {
                            name: s.name,
                            unit: s.unit,
                            comment: s.comment,
                            attributes: s
                                .attributes
                                .into_iter()
                                .map(|a| DbcAttributeRecord {
                                    name: a.name,
                                    value: a.value,
                                })
                                .collect(),
                            value_table: s
                                .value_table
                                .into_iter()
                                .map(|e| ValueTableEntryRecord {
                                    raw: e.raw,
                                    label: e.label,
                                })
                                .collect(),
                        })
                        .collect(),
                })
                .collect(),
        })
        .collect()
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
                q.bus_id.as_deref(),
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


/// Connect to a `cannet-server`, list its interfaces, subscribe only
/// to the interfaces named by `bindings`, and spawn a pump thread to
/// push frames at the frontend.
///
/// Multiple remote sessions may be active at a time — one per server
/// address. A second connect to the same address while one is open
/// returns an error.
///
/// Phase 6: `bindings` is the project's interface → bus mapping for
/// this server (a list of `{interface, bus_id}` pairs). The host
/// subscribes to exactly those interfaces (in binding order) and
/// translates each into a per-channel mapping the pump uses to stamp
/// each frame's `bus_id`. An empty `bindings` is an error — there's
/// nothing to subscribe to.
// Phase 7 sprinkled structured-log emit sites across this command;
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
    let binding_lookup = bindings.unwrap_or_default();
    if binding_lookup.is_empty() {
        let msg = format!(
            "no interface bindings configured for {address}; add bindings in the project panel first"
        );
        sys_warn!(&app, "connection", "{msg}");
        return Err(msg);
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
    // per session, not globally unique.
    let subscriptions: Vec<Subscription> = binding_lookup
        .iter()
        .enumerate()
        .filter_map(|(i, b)| {
            if interfaces.iter().any(|iface| iface.id == b.interface) {
                Some(Subscription {
                    interface_id: b.interface.clone(),
                    channel: u8::try_from(i).unwrap_or(u8::MAX),
                })
            } else {
                None
            }
        })
        .collect();

    if subscriptions.is_empty() {
        return Err(format!(
            "no bound interface matches what {address} exposes"
        ));
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
                handle,
                transmitter,
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
            run_pump(&app_for_thread, receiver, stop, channel_to_bus);
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
fn disconnect_remote_server(
    app: AppHandle,
    state: State<'_, AppState>,
    address: Option<String>,
) {
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
        ipc::TransmitKind::Error => cannet_core::CanFrame::error(
            timestamp_ns,
            wire_channel,
            id,
            cannet_core::Direction::Tx,
        ),
    };

    // Append the tx-confirm — stamp it with the target `bus_id` so
    // the local trace view shows it on the right bus, even when no
    // remote session is actually carrying it.
    let mut raw = RawTraceFrame::from(frame.clone());
    raw.bus_id = Some(request.bus_id.clone());
    state.trace_store.append(raw);
    let tx_confirm_index = u64::try_from(state.trace_store.len()).unwrap_or(u64::MAX) - 1;

    let wire_status = match routing {
        None if sessions_guard.is_empty() => ipc::TransmitWireStatus::NotConnected,
        None => ipc::TransmitWireStatus::Failed {
            message: format!(
                "bus {} is not bound on any active server",
                request.bus_id
            ),
        },
        Some(BusRoute { address, interface_id, .. }) => {
            // Re-borrow the session for the actual transmit; `routing`
            // dropped its borrow when it returned.
            let session = sessions_guard
                .get(&address)
                .expect("session for resolved route disappeared mid-transmit");
            match session.transmitter.transmit(&interface_id, &frame) {
                Ok(()) => ipc::TransmitWireStatus::Sent { interface_id },
                Err(e) => ipc::TransmitWireStatus::Failed {
                    message: e.to_string(),
                },
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
fn resolve_bus_route(
    sessions: &std::collections::HashMap<String, RemoteSession>,
    bus_id: &str,
) -> Option<BusRoute> {
    for (address, session) in sessions {
        for (ch, b) in &session.channel_to_bus {
            if b.as_deref() == Some(bus_id) {
                if let Some((_, iid)) = session
                    .channel_to_interface
                    .iter()
                    .find(|(c, _)| c == ch)
                {
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
                })
                .collect();
            return Some(ipc::MessageDescriptorRecord {
                name: desc.name,
                expected_len: desc.expected_len,
                is_fd: desc.is_fd,
                brs: desc.brs,
                uses_extended_mux: desc.uses_extended_mux,
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
    Err(format!("no DBC matches id 0x{message_id:X} (extended={extended})"))
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
            remote_sessions: Mutex::new(HashMap::new()),
            trace_store: TraceStore::new(),
            signal_caches: SignalCacheStore::new(),
            system_log: SystemLog::new(),
            notes: NotesStore::new(),
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
        assert_eq!(recovered[0].timestamp_ns / 1_000_000, (ts_base + 500) / 1_000_000);
        assert_eq!(recovered[1].timestamp_ns / 1_000_000, (ts_base + 1_500) / 1_000_000);
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

        let outcome = write_capture(
            dest.to_str().unwrap(),
            &frames,
            &[],
            &buses,
        )
        .unwrap();
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
        let m1 = marker::build(abs - start, b"Notes".to_vec(), b"first".to_vec(), Vec::new());
        let m2 = marker::build(
            (abs + 1_000_000) - start,
            b"Notes".to_vec(),
            b"second".to_vec(),
            Vec::new(),
        );
        w.append_object(&marker::encode(&m1), abs).unwrap();
        w.append_object(&marker::encode(&m2), abs + 1_000_000).unwrap();
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
}
