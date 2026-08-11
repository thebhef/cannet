//! Capture-session commands: BLF open / save / scan, the raw↔core frame
//! conversion, and the scratch-buffer lifecycle (clear / restore /
//! restamp).
//!
//! Opening a BLF spawns a pump thread (`crate::run_pump`); saving writes
//! the whole session buffer plus notes back out as a Vector BLF (ADR
//! 0010 — no sidecar files); clearing/restoring manage the disk-spill
//! scratch identity (ADR 0002 DS-7).

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use cannet_blf::{BlfCanFrameSource, BlfCaptureWriter};
use cannet_core::{CanFrame as CoreCanFrame, CanFrameSource, CanId};

use crate::app_state::AppState;
use crate::ipc::{LogFinished, OpenLogResult};
use crate::notes::{self, Note};
use crate::trace_store;
use crate::{sys_debug, sys_error, sys_info, sys_warn};
// `run_pump` / `panic_message` live in `session` once it is split out;
// they resolve at the crate root until then.
use crate::session::{panic_message, run_pump};

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
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn open_log(
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
    // Log the file's own header stats so an unusual capture (huge
    // object count, an uncompressed single-container Kvaser log, etc.)
    // is visible in the system log before the pump even starts.
    let stats = source.file_statistics();
    let uncompressed_mib = stats.uncompressed_file_size / (1024 * 1024);
    sys_info!(
        &app,
        "blf-import",
        "opened BLF {blf_path}: {objects} objects, {uncompressed_mib} MiB uncompressed, \
         app_id={app_id}",
        objects = stats.object_count,
        app_id = stats.application_id,
    );

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
            //
            // A panic on the ingest path (a hostile BLF) must end the
            // load with a visible error, not a silently dead thread the
            // UI waits on forever. The panic hook has already written
            // the message and backtrace to `cannet.log` by the time
            // `catch_unwind` returns.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_pump(
                    &app_for_thread,
                    source,
                    Arc::new(AtomicBool::new(false)),
                    channel_to_bus,
                    true, // replay_origin: BLF anchors the session at the first frame's ts
                );
            }));
            if let Err(payload) = result {
                let msg = format!("load failed: {}", panic_message(payload.as_ref()));
                sys_error!(&app_for_thread, "blf-import", "{msg}");
                let _ = app_for_thread.emit("log-finished", LogFinished::Error { message: msg });
            }
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
pub(crate) fn save_capture(
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
/// An event color (ADR 0035) as the BLF marker's `0x00RRGGBB`
/// foreground color: `#RRGGBB` parses to the packed RGB; `None` (or an
/// unparseable string) is `0`, the marker build default. Inverse of
/// [`rgb_to_color`].
fn color_to_rgb(color: Option<&str>) -> u32 {
    color
        .and_then(|c| u32::from_str_radix(c.trim_start_matches('#'), 16).ok())
        .map_or(0, |rgb| rgb & 0x00FF_FFFF)
}

/// The inverse: a packed `0x00RRGGBB` becomes `Some("#RRGGBB")`, except `0`
/// (the marker build default / an uncolored event) reads back as `None` so
/// an uncolored note round-trips as uncolored rather than as black.
fn rgb_to_color(rgb: u32) -> Option<String> {
    let rgb = rgb & 0x00FF_FFFF;
    (rgb != 0).then(|| format!("#{rgb:06X}"))
}

pub(crate) fn read_notes_from_blf(blf_path: &str) -> Result<Vec<Note>, String> {
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
                kind: notes::EventKind::Note,
                color: rgb_to_color(m.foreground_color),
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
pub(crate) fn write_capture(
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
                .append_marker(
                    note.timestamp_ns,
                    &note.label,
                    &note.id,
                    color_to_rgb(note.color.as_deref()),
                )
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
    let id = CanId::new(frame.id, frame.extended).map_err(|e| e.to_string())?;
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
pub(crate) async fn scan_blf_channels(app: AppHandle, blf_path: String) -> Result<Vec<u8>, String> {
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
/// Re-stamp the scratch for a freshly reset capture buffer (ADR 0002
/// DS-7), called right after each `start_session`: drop the now-stale
/// filter index and record the active project as the scratch's owner, so
/// a later launch reloads this session only against the same project.
/// `start_session` already wiped the raw store, the reopen manifest, and
/// the prior identity / derived files; this writes the fresh identity.
pub(crate) fn restamp_scratch_for_capture(state: &AppState) {
    *state.filter_index() = None;
    let active = *state.active_project_id();
    state.trace_store.write_scratch_identity(active);
    // Drop the scratch copy of notes too (ADR 0002 DS-7): a reset session
    // starts with no events. The live `NotesStore` is cleared / replaced by
    // the caller, which re-persists from there.
    state.notes.wipe_scratch();
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn clear_trace_store(app: AppHandle, state: State<'_, AppState>) {
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX));
    state.trace_store.start_session(now_ns);
    restamp_scratch_for_capture(&state);
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

/// What a successful scratch restore brings back: the reloaded frame
/// `count` and the session-start anchor (seconds since the Unix epoch) the
/// trace view renders timestamps relative to. `count == 0` means nothing
/// was restored.
#[derive(serde::Serialize, Clone, Copy)]
pub struct RestoredCapture {
    count: u64,
    /// Windowed-ring low-water mark of the reloaded store (ADR 0002 DS-8):
    /// non-zero when the prior capture was evicted before exit, so the
    /// restored chronological view clamps to `[first_index, count)`.
    first_index: u64,
    /// Absolute ns of the oldest retained frame — where the truncation
    /// marker (ADR 0035) sits when `first_index > 0`, so a reopened evicted
    /// capture shows it without waiting for a `trace-grew` tick (a stopped
    /// trace gets none). `None` when nothing was truncated or restored.
    first_index_ts_ns: Option<u64>,
    session_start_seconds: f64,
}

/// Reload the prior disk-spill capture as a stopped historical trace, if
/// one belongs to the open project (ADR 0002 DS-7). The frontend calls
/// this *after* `open_project` has applied the project and cleared the
/// trace view, so the restored history is presented rather than wiped by
/// the open. Returns `count == 0` when there is nothing to restore (no
/// open project, no scratch, or an identity mismatch) — the gate lives in
/// [`TraceStore::try_reload`], which only reloads on a matching identity.
///
/// `async` so Tauri runs it off the main thread. The frontend does not
/// wait for this — the app comes up interactive and the history appears
/// when it lands — and that only holds if the reopen isn't running on the
/// thread the window and every other command share: reopening a large
/// capture is `O(segment files)`, seconds' worth on a multi-million-frame
/// one. (Commands that read the trace store do queue behind it, because
/// the reload holds the store lock for the swap; during that window the
/// store they would read is the new session's empty one.)
#[tauri::command]
#[allow(clippy::unused_async)] // `async` is what makes Tauri run it off the main thread
pub(crate) async fn restore_scratch_capture(app: AppHandle) -> RestoredCapture {
    let state: State<'_, AppState> = app.state();
    let started = std::time::Instant::now();
    let active = *state.active_project_id();
    let Some(breakdown) = active.and_then(|pid| state.trace_store.try_reload(pid)) else {
        return RestoredCapture {
            count: 0,
            first_index: 0,
            first_index_ts_ns: None,
            session_start_seconds: 0.0,
        };
    };
    let (count, first_index_usize, first_index_ts_ns) = state.trace_store.len_and_low_water();
    let first_index = first_index_usize as u64;
    let session_start_ns = state.trace_store.session_start_ns();
    // Bring the session's events back too (ADR 0002 DS-7 / ADR 0035) — the
    // scratch's own copy, independent of any BLF round-trip.
    let notes_at = std::time::Instant::now();
    if let Some(restored) = state.notes.restore() {
        let _ = app.emit("notes-changed", restored);
    }
    let notes_ms = notes_at.elapsed().as_secs_f64() * 1000.0;
    // What a large-cache launch actually waited for, in the log every
    // launch already writes. The total goes on the line the user sees so a
    // slow restore is self-evident; the phase split and its file counts sit
    // behind it at debug, next to the command's own wall clock — which
    // together say whether a slow launch was spent restoring or waiting to
    // be asked to (ADR 0002 DS-7).
    let total_ms = started.elapsed().as_secs_f64() * 1000.0;
    sys_info!(
        &app,
        "project",
        "restored {count} frames from prior capture in {total_ms:.0} ms"
    );
    sys_debug!(
        &app,
        "project",
        "restore: {breakdown} notes {notes_ms:.0} command {total_ms:.0}"
    );
    #[allow(clippy::cast_precision_loss)]
    RestoredCapture {
        count: u64::try_from(count).unwrap_or(u64::MAX),
        first_index,
        first_index_ts_ns,
        session_start_seconds: session_start_ns as f64 / 1_000_000_000.0,
    }
}
