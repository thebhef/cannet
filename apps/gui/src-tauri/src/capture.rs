//! Capture-session commands: BLF/MDF open / scan, capture save, the
//! raw↔core frame conversion, and the scratch-buffer lifecycle
//! (clear / restore / restamp).
//!
//! Opening a BLF or an MDF spawns a pump thread (`crate::run_pump`,
//! generic over `cannet_core::CanFrameSource`, so the same pipeline
//! runs either source). Saving is one command over two writers, the
//! format an explicit argument rather than a guess at the path's
//! extension: a Vector BLF carries frames and notes, an ASAM MDF also
//! carries the capture's file-backed signals and the project's DBCs.
//! Everything either format carries lives inside the capture file
//! (ADR 0010 — no sidecar files). Clearing/restoring manage the
//! disk-spill scratch identity (ADR 0002 DS-7).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use cannet_blf::{BlfCanFrameSource, BlfCaptureWriter, FinishedCapture};
use cannet_core::{CanFrame as CoreCanFrame, CanId};
use cannet_mdf::MdfCanFrameSource;

use crate::app_state::AppState;
use crate::event_text;
use crate::ipc::{
    ImportMdfResult, LoadProgress, LogFinished, OpenLogResult, RebuildProgressRecord,
    ValueTableEntryRecord,
};
use crate::notes::{self, Note};
use crate::sampling::off_async_workers;
use crate::signal_cache::{FileSignalEntry, FileSignalInfo, SignalCacheStore};
use crate::trace_store;
use crate::{sys_debug, sys_error, sys_info, sys_warn};
// `run_pump` / `panic_message` live in `session` once it is split out;
// they resolve at the crate root until then.
use crate::session::{panic_message, run_pump};

/// Event announcing that the capture's **file-backed signal** set has
/// changed — an import filled it, a clear emptied it, a restore
/// adopted one. Carries no payload: a listener re-reads the catalog
/// (`list_file_backed_content`), the way `dbc-changed` works for the
/// DBC set. It is what lets the Database view's per-file branches (ADR
/// 0052) come and go with the capture instead of being polled for.
pub(crate) const FILE_SIGNALS_CHANGED: &str = "file-signals-changed";

/// Event carrying how far the trace load in flight has got — see
/// [`LoadProgress`] for what each phase counts against what.
pub(crate) const LOAD_PROGRESS: &str = "load-progress";

/// Paces [`LOAD_PROGRESS`] to the frontend's own live-update cadence.
///
/// The checkpoints behind it fire thousands of times a second, which is
/// what makes a cancel land promptly; a status line redrawn that often
/// would cost more than the load it is reporting on. The cadence is the
/// one `trace-grew` already runs at (`live_update_interval_ms`) rather
/// than a second knob, because it is the same question — how often the
/// status line is allowed to change — asked about a different number.
pub(crate) struct ProgressPacer {
    last: Instant,
    period: Duration,
}

impl ProgressPacer {
    /// Start paced, so the first report waits a period rather than
    /// firing on the checkpoint a millisecond into the walk.
    pub(crate) fn new() -> Self {
        Self {
            last: Instant::now(),
            period: Duration::from_millis(crate::settings::effective().live_update_interval_ms),
        }
    }

    /// Whether a report is due at `now`, consuming the slot if it is.
    pub(crate) fn due(&mut self, now: Instant) -> bool {
        if now.duration_since(self.last) < self.period {
            return false;
        }
        self.last = now;
        true
    }
}

/// Frames the pump moves between two looks at the clock.
///
/// The pump's cancel check is per frame and stays there; this is only
/// about how often progress is worth reporting, and reading the clock
/// costs more per frame than the check does. At any plausible pump rate
/// this is single-digit milliseconds, well under the pacer's own period,
/// so the cadence the user sees is the pacer's and not this.
const PROGRESS_CHECKPOINT_FRAMES: u64 = 16_384;

/// Determinate progress for an import pump: the census's frame count as
/// the denominator, and the pacing that keeps the reports to a cadence.
///
/// Only a replay has one of these. A live session has no end to be a
/// fraction of, so it carries `None` and the pump's loop skips all of
/// this (see [`LoadProgress`]).
pub(crate) struct ImportProgress {
    total_frames: u64,
    pacer: ProgressPacer,
    until_checkpoint: u64,
}

impl ImportProgress {
    pub(crate) fn new(total_frames: u64) -> Self {
        Self {
            total_frames,
            pacer: ProgressPacer::new(),
            until_checkpoint: PROGRESS_CHECKPOINT_FRAMES,
        }
    }

    /// Whether the pump has run far enough to be worth asking the clock.
    /// One decrement and one compare, which is what keeps this off the
    /// per-frame cost of the loop it sits in.
    pub(crate) fn checkpoint(&mut self) -> bool {
        self.until_checkpoint -= 1;
        if self.until_checkpoint > 0 {
            return false;
        }
        self.until_checkpoint = PROGRESS_CHECKPOINT_FRAMES;
        true
    }

    /// Report `frames_read` if the pacer says a report is due.
    pub(crate) fn report(&mut self, app: &AppHandle, frames_read: u64) {
        if !self.pacer.due(Instant::now()) {
            return;
        }
        let _ = app.emit(
            LOAD_PROGRESS,
            LoadProgress::Import {
                frames: frames_read,
                total_frames: self.total_frames,
            },
        );
    }
}

/// Per-channel BLF bus mapping. One entry per channel the caller wants
/// to route, naming the logical bus its frames land on. A channel with
/// no entry is **dropped**: the import dialog's "(skip)" is spelled by
/// leaving the channel out, and there is no third answer where a frame
/// arrives without a bus. Camel case at the wire because Tauri only
/// renames top-level command args.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChannelBusMapping {
    pub channel: u8,
    /// The logical bus this channel's frames are routed onto.
    pub bus_id: String,
}
/// Start importing `blf_path`, routing each channel per
/// `channel_bus_mapping`, optionally narrowed to `[start_ns, end_ns]`
/// (either or both `None` for unbounded).
///
/// `total_frames` is the frame count the census of this same file
/// returned, and it is what makes the import's progress determinate: it
/// travels with the request rather than being re-derived, because the
/// walk that found it has already happened and walking again to find it
/// twice is the cost this whole phase exists to avoid. `None` means no
/// progress is reported — the load still runs.
///
/// The whole import is **one pass over the file**: the pump walks it
/// once, and the capture's `GLOBAL_MARKER` annotations are collected on
/// that same walk through the source's marker sink rather than by a
/// second whole-file decode before it. There is no import-specific
/// ingest path — the frames go through the same `run_pump` a live
/// session uses (ADR 0046). The time range is the same rule applied to
/// itself: it is a [`cannet_core::WindowedSource`] wrapped around the
/// BLF source, not a second pump — frames outside the range never reach
/// `run_pump`, let alone `TraceStore::append`. The wrapper reads the
/// source to EOF regardless of the window, because a capture's frames
/// are not promised to arrive in timestamp order (ADR 0024) and a
/// frame that belongs in the range can sit after one that doesn't; see
/// [`cannet_core::WindowedSource`]'s docs. Markers ride the whole walk
/// the same way — every marker the file carries, not just a prefix.
///
/// `async` so Tauri runs it off the main thread, like its siblings:
/// opening a several-hundred-megabyte BLF parses a header and allocates
/// the reader's buffers, and the command must not hold up the window
/// while it does.
///
/// Cancellable: `cancel_import` flips a stop flag this command installs
/// into [`AppState::import_cancel`] before spawning the pump, and the
/// pump loop (`run_pump`) checks it every frame — the same cooperative
/// shape a live session's disconnect uses. A cancelled pump still ends
/// through its normal clean-exit path (`log-finished: Ok`); the
/// frontend is what tells a cancellation apart from a natural finish,
/// since it is the one that asked for it.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
#[allow(clippy::unused_async)] // `async` is what makes Tauri run it off the main thread
pub(crate) async fn open_log(
    app: AppHandle,
    blf_path: String,
    #[allow(non_snake_case)] channel_bus_mapping: Option<Vec<ChannelBusMapping>>,
    start_ns: Option<u64>,
    end_ns: Option<u64>,
    #[allow(non_snake_case)] total_frames: Option<u64>,
) -> Result<OpenLogResult, String> {
    // Open the BLF before returning so the user gets immediate feedback
    // if the path is wrong.
    let mut source = match BlfCanFrameSource::open(&blf_path) {
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
    // A writer killed mid-run never came back to fill its header in, so
    // the zeros below are placeholders rather than the file's own
    // numbers. The walk is what the counts elsewhere come from; this
    // line just must not pass the placeholders off as facts.
    let header_note = if stats.is_unfinalized() {
        " — placeholder header, its writer never finalized the file"
    } else {
        ""
    };
    sys_info!(
        &app,
        "blf-import",
        "opened BLF {blf_path}: {objects} objects, {uncompressed_mib} MiB uncompressed, \
         app_id={app_id}{header_note}",
        objects = stats.object_count,
        app_id = stats.application_id,
    );

    // Notes live inside the BLF as `GLOBAL_MARKER` records (ADR 0010 —
    // no sidecar files). They ride the pump's own walk: the source hands
    // each marker to this sink as it passes it, so finding the
    // annotations costs no extra read of the file. The session-buffer
    // notes are session-scoped, so whatever the file carries replaces
    // what's in the store — Open BLF is a fresh-capture action that
    // wipes the trace store via the surrounding GUI flow.
    let collected = collect_annotations(&mut source);

    let result = OpenLogResult {
        blf_path: blf_path.clone(),
    };

    let channel_to_bus: Vec<(u8, String)> = channel_bus_mapping
        .unwrap_or_default()
        .into_iter()
        .map(|m| (m.channel, m.bus_id))
        .collect();

    // The selected import range (ADR 0046): a filter at the
    // `CanFrameSource` seam, applied on top of the marker sink set
    // above so `run_pump` — and therefore `TraceStore::append` — never
    // sees a frame outside `[start_ns, end_ns]`.
    let source = cannet_core::WindowedSource::new(source, start_ns, end_ns);

    // The launcher doubles as a Cancel button once the pump is running:
    // this flag is what `cancel_import` flips, mirroring
    // `remote_sessions`'s per-session `stop` flag. Installed before the
    // thread spawns so a cancel racing the spawn still lands on a flag
    // the pump will see; cleared back to `None` when the pump ends,
    // whichever way.
    let cancel = Arc::new(AtomicBool::new(false));
    *app.state::<AppState>().import_cancel() = Some(Arc::clone(&cancel));
    // Read back after the pump: it is what tells a cancellation apart
    // from an end of file on this side (see `import_was_cancelled`).
    let cancelled_probe = Arc::clone(&cancel);

    let app_for_thread = app.clone();
    std::thread::Builder::new()
        .name("cannet-blf-pump".into())
        .spawn(move || {
            // A panic on the ingest path (a hostile BLF) must end the
            // load with a visible error, not a silently dead thread the
            // UI waits on forever. The panic hook has already written
            // the message and backtrace to `cannet.log` by the time
            // `catch_unwind` returns.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_pump(
                    &app_for_thread,
                    source,
                    cancel,
                    channel_to_bus,
                    // replay_origin: the session anchors on the file's own
                    // earliest timestamp (ADR 0024), which the pump tracks.
                    true,
                    total_frames.map(ImportProgress::new),
                )
            }));
            // This pump is done — cleanly, cancelled, or panicked —
            // so nothing should be able to cancel it again.
            *app_for_thread.state::<AppState>().import_cancel() = None;
            let mut anchor = match result {
                Ok(anchor) => anchor,
                Err(payload) => {
                    let msg = format!("load failed: {}", panic_message(payload.as_ref()));
                    sys_error!(&app_for_thread, "blf-import", "{msg}");
                    let _ =
                        app_for_thread.emit("log-finished", LogFinished::Error { message: msg });
                    return;
                }
            };
            // Abandoned: the frames this walk appended are being
            // cleared right now, so its markers have no capture to
            // belong to. Stop before applying them.
            if import_was_cancelled(&cancelled_probe) {
                return;
            }
            // The markers the pump walked past. Applied once the pass is
            // over — the file's annotations are only fully known when
            // its last object has been read. A marker can precede the
            // first frame, so it is folded into the session origin (ADR
            // 0024) and dropped if the import range excludes it.
            let notes =
                std::mem::take(&mut *collected.lock().unwrap_or_else(PoisonError::into_inner));
            let app_state: State<'_, AppState> = app_for_thread.state();
            let notes =
                settle_import_origin(&app_state, &mut anchor, notes, None, start_ns, end_ns);
            if !notes.is_empty() {
                let marker_count = notes.len();
                let _ = app_state.notes.replace(notes.clone());
                let _ = app_for_thread.emit("notes-changed", notes);
                sys_info!(
                    &app_for_thread,
                    "blf-import",
                    "loaded {marker_count} note(s) from BLF markers",
                );
            }
        })
        .map_err(|e| format!("failed to spawn pump thread: {e}"))?;

    Ok(result)
}

/// Whether the import that has just ended was cancelled rather than
/// finishing, and so must apply none of what its walk collected.
///
/// A pump exits through the same clean path whichever way it stopped,
/// and everything an import gathers *alongside* the frames — a BLF's
/// `GLOBAL_MARKER` notes, an MDF's file-backed signal series — is
/// applied after it, because none of it is fully known until the walk
/// is over. The frontend, meanwhile, has seen `log-finished` and is
/// already clearing the partial capture. Applying afterwards would put
/// content into a session whose frames are gone.
///
/// For an MDF this is not a race but a certainty: filling the file's
/// signal series takes as long as the content is big, and it starts
/// after the pump has already announced it finished.
pub(crate) fn import_was_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

/// Flip whichever import's cancel flag [`AppState::import_cancel`] holds
/// right now, if any. Factored out from [`cancel_import`] so it's
/// testable against a plain `AppState` — the command wrapper needs a
/// live Tauri app to construct its `State`, the suite has no harness
/// for one (see the module-level tests).
pub(crate) fn cancel_import_now(state: &AppState) {
    if let Some(flag) = state.import_cancel().as_ref() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Cancel whichever phase of a trace open is in flight right now — the
/// census (`scan_blf_channels` / `scan_mdf_channels`) or the pump
/// (`open_log` / `import_mdf`) — if either is. One command for both:
/// the phases are sequential, only one trace open runs at a time, and
/// [`AppState::import_cancel`] therefore never holds more than one flag.
///
/// Cooperative, not immediate: it flips the flag the running walk checks
/// at its checkpoint — once per frame in `run_pump`, once per
/// checkpoint stride in a census.
///
/// The two phases end differently, and the difference is what they have
/// produced. A cancelled census has produced nothing: its command
/// returns `None` and there is nothing to undo. A cancelled pump has
/// frames in the store, and exits through its ordinary clean-exit path
/// — the same `log-finished: Ok` a natural end-of-file emits, since the
/// loop itself cannot tell "stopped because EOF" from "stopped because
/// asked to". The frontend is the one that knows it asked, and treats
/// the next `log-finished` as an abandonment: it clears the partial
/// frames the pump already appended rather than presenting them as a
/// finished capture.
///
/// A no-op, not an error, when nothing is loading — the Cancel button
/// this backs isn't perfectly synchronized with the pump's own lifetime
/// (a click can race the pump's natural completion), and a stray call
/// after the pump has already finished should do nothing rather than
/// fail.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn cancel_import(state: State<'_, AppState>) {
    cancel_import_now(&state);
}

/// The capture file format a save writes. Chosen in the save dialog and
/// sent explicitly — never inferred from the path's extension, so what
/// the user picked and what the host writes cannot drift apart.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SaveFormat {
    /// Vector BLF: frames and notes.
    Blf,
    /// ASAM MDF 4.10: frames, notes, file-backed signals and the
    /// project's DBCs — the full-fidelity save.
    Mdf,
}

impl SaveFormat {
    fn label(self) -> &'static str {
        match self {
            Self::Blf => "BLF",
            Self::Mdf => "MDF",
        }
    }
}

/// Write the entire session buffer to `path` in `format`. Every frame on
/// every bus, no per-trace slicing — the project file's bus bindings
/// handle re-routing on import. Both writers are atomic (temp file +
/// rename) and put everything they carry **inside** the capture file, no
/// sidecar (ADR 0010).
///
/// What each format carries:
///
/// | | BLF | MDF |
/// | --- | --- | --- |
/// | frames | yes | yes |
/// | notes | `GLOBAL_MARKER` | `##EV` |
/// | file-backed signals | **no** | signal channel groups |
/// | project DBCs | no | `##AT` attachments |
///
/// A BLF save that is about to drop file-backed signals says so
/// ([`dropped_file_backed_warning`]); an MDF save carries them, so it
/// does not.
///
/// Emits `capture`-tagged System Messages: `info` with the frame
/// count + byte size + marker count on success, `warn` naming any
/// file-backed signals the format cannot carry, `warn` naming any event
/// whose timestamp the format could not hold
/// ([`clamped_timestamp_warning`]), `error` on failure.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn save_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    format: SaveFormat,
    buses: Vec<String>,
) -> Result<SaveCaptureResult, String> {
    // User-authored events only: a host-derived event summarises frames the
    // file already carries, so writing it would restate them lossily
    // (ADR 0035).
    let notes = state.notes.exportable();
    let outcome = match format {
        // Snapshot the trace store. `slice(0, len)` clones each
        // RawTraceFrame out under the trace-store lock — that's the
        // simplest correct read; for very long captures it's a single
        // big allocation rather than streaming chunked reads, which
        // we'll revisit when disk-spill lands.
        SaveFormat::Blf => {
            let frames = state.trace_store.slice(0, state.trace_store.len());
            write_blf_capture(&path, &frames, &notes, &buses)
        }
        SaveFormat::Mdf => write_mdf_capture(&path, &state, &notes, &buses),
    };
    let outcome = match outcome {
        Ok(o) => o,
        Err(e) => {
            sys_error!(&app, "capture", "save to {path} failed: {e}");
            return Err(e);
        }
    };

    sys_info!(
        &app,
        "capture",
        "saved capture to {path} as {fmt}: {n} frame(s), {b} bytes, {m} note(s)",
        fmt = format.label(),
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
    // A save that could not put an event where the capture had it says
    // which event and by how much — never silently.
    if let Some(warning) = &outcome.clamped_timestamps {
        sys_warn!(&app, "capture", "{warning}");
    }
    // Only BLF drops them; MDF is the save that carries them.
    if format == SaveFormat::Blf {
        if let Some(warning) = dropped_file_backed_warning(&state.signal_caches.file_signals()) {
            sys_warn!(&app, "capture", "{warning}");
        }
    }

    Ok(outcome)
}

/// What a scan recovered from a capture whose writer never finished
/// it, or `None` when the file is intact and there is nothing to say.
///
/// A writer killed mid-run leaves the placeholder header it stamped at
/// open, and — if it buffered its writes — a fragment of a record it
/// never completed. The frames before that fragment are read normally,
/// but the counts and span come from the walk rather than from a header
/// that claims the file is empty. That is worth exactly one line —
/// enough that the numbers on screen are never unexplained, and not so
/// much that the import stops to ask. The file itself is left alone
/// (ADR 0010): there is no repair and no repaired copy.
///
/// A second line joins it only for a capture that states no measurement
/// start, whose timestamps therefore run from zero. Every `.part` this
/// build leaves carries its anchor — the writer persists it the moment
/// it latches one — so that line is for files an earlier build wrote,
/// and nothing can date those.
pub(crate) fn recovered_capture_warning(scan: &cannet_blf::BlfScan) -> Option<String> {
    if !scan.unfinalized && scan.truncated_tail_bytes.is_none() {
        return None;
    }
    let mut line = format!(
        "recovered {frames} frame(s) on {channels} channel(s) from a capture whose writer \
         never finalized it",
        frames = scan.frame_count,
        channels = scan.channels.len(),
    );
    if let Some(bytes) = scan.truncated_tail_bytes {
        use std::fmt::Write as _;
        let _ = write!(
            line,
            "; its last {bytes} byte(s) are an incomplete record, and whatever the writer \
             still held in memory never reached the file"
        );
    }
    if scan.start_unix_nanos == 0 {
        line.push_str(
            "; the file states no measurement start, so the capture's wall clock is lost \
             and its timestamps run from zero",
        );
    }
    line.push_str(". The file is read as it stands and not modified.");
    Some(line)
}

/// What a BLF save is about to lose, or `None` when it loses nothing.
///
/// A BLF carries frames. File-backed signals (`docs/CONTEXT.md`) are not
/// frames and nothing in the format can hold them, so saving a capture
/// that has them to BLF silently drops them — the one thing this warning
/// exists to stop being silent. It names them rather than counting them:
/// which signals disappeared is what decides whether the user wanted a
/// different format.
///
/// A warning, not a refusal. BLF is still the right save for a capture
/// whose frames are the point, and the user is the one who knows.
#[must_use]
pub(crate) fn dropped_file_backed_warning(signals: &[FileSignalEntry]) -> Option<String> {
    // Long captures can carry hundreds; the log line names enough to
    // recognise what is going and says how many more there are.
    const NAMED: usize = 8;
    if signals.is_empty() {
        return None;
    }
    let mut names: Vec<String> = signals
        .iter()
        .take(NAMED)
        .map(|e| format!("{}/{}", e.info.group_label(), e.info.name))
        .collect();
    if signals.len() > NAMED {
        names.push(format!("… and {} more", signals.len() - NAMED));
    }
    Some(format!(
        "BLF carries frames only — {n} file-backed signal(s) will not be in the saved file: {list}",
        n = signals.len(),
        list = names.join(", "),
    ))
}

/// What a BLF save moved, or `None` when it moved nothing.
///
/// BLF's per-event timestamp is an unsigned offset from the file's
/// start, so a writer whose anchor it did not declare up front writes
/// anything earlier than its first event *at* that anchor.
/// [`write_blf_capture`] declares the capture's minimum, so this is
/// `None` for every save the GUI makes today — it exists so that a
/// caller which cannot declare one (a future streaming writer) says what
/// it moved instead of shipping a file that quietly differs from the
/// capture it came from.
///
/// Names the deepest clamp: the frame it hit and how far the event
/// moved, which is what decides whether the saved file is still usable.
#[must_use]
pub(crate) fn clamped_timestamp_warning(outcome: &FinishedCapture) -> Option<String> {
    let worst = outcome.worst_clamp?;
    let what = worst.frame.map_or_else(
        || "a note".to_owned(),
        |(channel, id)| format!("the frame on channel {channel}, id 0x{id:X},"),
    );
    Some(format!(
        "{n} event(s) saved later than their own timestamp — BLF cannot hold an event          before the file's start. Worst: {what} stamped {ts} ns, written {ms}.{us:03} ms late",
        n = outcome.clamped_count,
        ts = worst.timestamp_ns,
        ms = worst.error_ns / 1_000_000,
        us = (worst.error_ns % 1_000_000) / 1_000,
    ))
}

/// Result of [`save_capture`]; mirrors the `cannet-blf` writer's
/// outcome plus the note count, so the frontend can surface
/// "saved 12,345 frames + 3 notes".
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCaptureResult {
    pub path: String,
    pub frame_count: u64,
    pub byte_size: u64,
    pub marker_count: u64,
    pub max_timestamp_drift_ns: u64,
    /// What the save had to move, when it moved anything — see
    /// [`clamped_timestamp_warning`]. `None` for a faithful save, which
    /// is every save either writer makes today.
    pub clamped_timestamps: Option<String>,
}

/// An event color (ADR 0035) as the BLF marker's `0x00RRGGBB` fill:
/// `#RRGGBB` parses to the packed RGB. `None` — an uncoloured event, or a
/// string that does not parse — stays `None` and leaves the marker's
/// neutral default, which is what keeps it distinct from a chosen
/// `#000000`. Inverse of [`marker_color`].
fn color_to_rgb(color: Option<&str>) -> Option<u32> {
    color
        .and_then(|c| u32::from_str_radix(c.trim_start_matches('#'), 16).ok())
        .map(|rgb| rgb & 0x00FF_FFFF)
}

/// A `GLOBAL_MARKER`'s two colours as one event colour (ADR 0035).
///
/// The event's colour is the marker's **fill** — `background_color` under
/// white text, which is how `BlfCaptureWriter::append_marker` and
/// python-can's independent writer both pack one. Any fill but white is
/// the colour, black included. A white background means the marker is not
/// filled, and then the colour is the label's, which reads both the
/// neutral black-on-white default (as `None`, so an uncoloured note stays
/// uncoloured) and every marker cannet wrote before the fill convention.
fn marker_color(marker: &cannet_blf::format::marker::GlobalMarker) -> Option<String> {
    let fill = marker.background_color & 0x00FF_FFFF;
    if fill != 0x00FF_FFFF {
        return Some(format!("#{fill:06X}"));
    }
    let label = marker.foreground_color & 0x00FF_FFFF;
    (label != 0).then(|| format!("#{label:06X}"))
}

/// Marks a BLF text field as cannet's *previous* structured event payload.
/// Superseded by the `cannet-event/1` block ([`event_text`]) and still
/// read, so a capture written by an earlier build opens with its events
/// intact.
const LEGACY_EVENT_TEXT_PREFIX: &str = "cannet:event:";

/// Read the form a marker's `description` held before the
/// `cannet-event/1` block: `cannet:event:<tag>\n<id>\n<description>`, and
/// before that a bare id. Text with neither is a third party's, and the
/// bare-id rule is what has always applied to it.
fn legacy_marker_description(raw: &str) -> (String, Option<String>, Option<String>) {
    let Some(rest) = raw.strip_prefix(LEGACY_EVENT_TEXT_PREFIX) else {
        return (raw.to_owned(), None, None);
    };
    let mut parts = rest.splitn(3, '\n');
    let tag = parts.next().unwrap_or_default();
    let id = parts.next().unwrap_or_default();
    let description = parts.next().unwrap_or_default();
    (
        id.to_owned(),
        (!tag.is_empty()).then(|| tag.to_owned()),
        (!description.is_empty()).then(|| description.to_owned()),
    )
}

/// Project one BLF `GLOBAL_MARKER` onto a [`Note`]. Marker layout matches
/// what [`BlfCaptureWriter::append_marker`] emits: `group_name = "cannet"`,
/// `marker_name = label`, the event's colour as the fill, and everything
/// with no field of its own in the `description`'s `cannet-event/1` block
/// (ADR 0057).
///
/// Third-party markers (any other group, or a `description` with no block)
/// get a synthetic id `blf-marker-<index>` so their `rename` / `remove`
/// paths still work; `synthetic_idx` is the caller's running counter of
/// those, which makes the minted id deterministic in the marker's position
/// within the file.
pub(crate) fn note_from_marker(
    scanned: &cannet_blf::ScannedMarker,
    synthetic_idx: &mut u64,
) -> Note {
    let m = &scanned.marker;
    let raw = String::from_utf8_lossy(&m.description);
    let text = event_text::decode(&raw);
    let (id, kind, tag, description, subjects, unknown_block_lines) = if event_text::has_block(&raw)
    {
        (
            text.id
                .unwrap_or_else(|| synthetic_id("blf-marker", synthetic_idx)),
            text.kind.unwrap_or(notes::EventKind::Note),
            text.tag,
            text.description,
            text.subjects,
            text.extra,
        )
    } else if m.description.is_empty() {
        (
            synthetic_id("blf-marker", synthetic_idx),
            notes::EventKind::Note,
            None,
            None,
            Vec::new(),
            Vec::new(),
        )
    } else {
        let (id, tag, description) = legacy_marker_description(&raw);
        (
            id,
            notes::EventKind::Note,
            tag,
            description,
            Vec::new(),
            Vec::new(),
        )
    };
    Note {
        id,
        timestamp_ns: scanned.timestamp_ns,
        label: String::from_utf8_lossy(&m.marker_name).into_owned(),
        kind,
        color: marker_color(m),
        description,
        tag,
        commented_event_type: None,
        subjects,
        unknown_block_lines,
    }
}

/// A deterministic id for an annotation that carries none of its own —
/// another tool's, or one of ours from before ids were written. Numbered
/// by position within the file, so it is the same on every open.
fn synthetic_id(prefix: &str, synthetic_idx: &mut u64) -> String {
    let id = format!("{prefix}-{synthetic_idx}");
    *synthetic_idx += 1;
    id
}

/// Wire both annotation sinks onto `source` and hand back the list they
/// fill: `GLOBAL_MARKER` and `EVENT_COMMENT` alike, collected on the walk
/// the pump was already making rather than a second pass over the file.
fn collect_annotations(source: &mut cannet_blf::BlfCanFrameSource) -> Arc<Mutex<Vec<Note>>> {
    let collected: Arc<Mutex<Vec<Note>>> = Arc::default();
    source.on_marker({
        let collected = Arc::clone(&collected);
        let mut synthetic_idx = 0u64;
        move |m| {
            let note = note_from_marker(&m, &mut synthetic_idx);
            collected
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(note);
        }
    });
    source.on_comment({
        let collected = Arc::clone(&collected);
        let mut synthetic_idx = 0u64;
        move |c| {
            let note = note_from_comment(&c, &mut synthetic_idx);
            collected
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(note);
        }
    });
    collected
}

/// Project one BLF `EVENT_COMMENT` onto a [`Note`] of the message-bound
/// kind. The record has a single text field and no name or colour of its
/// own, so the `cannet-event/1` block in it carries those too
/// ([`comment_text`]). A comment written by another tool carries no block:
/// its first line reads as the label, the rest as the description, and it
/// gets a synthetic `blf-comment-<index>` id — mirroring what
/// [`note_from_marker`] does for a third-party marker, so its rename /
/// remove paths still work.
pub(crate) fn note_from_comment(
    scanned: &cannet_blf::ScannedComment,
    synthetic_idx: &mut u64,
) -> Note {
    let raw = String::from_utf8_lossy(&scanned.comment.text).into_owned();
    let (id, kind, label, color, description, tag, subjects, unknown_block_lines) =
        if event_text::has_block(&raw) {
            let text = event_text::decode(&raw);
            (
                text.id
                    .unwrap_or_else(|| synthetic_id("blf-comment", synthetic_idx)),
                text.kind.unwrap_or(notes::EventKind::MessageBound),
                text.label.unwrap_or_default(),
                text.color,
                text.description,
                text.tag,
                text.subjects,
                text.extra,
            )
        } else {
            let (id, tag, label, description) = legacy_comment_text(&raw, synthetic_idx);
            (
                id,
                notes::EventKind::MessageBound,
                label,
                None,
                description,
                tag,
                Vec::new(),
                Vec::new(),
            )
        };
    Note {
        id,
        timestamp_ns: scanned.timestamp_ns,
        label,
        kind,
        color,
        description,
        tag,
        commented_event_type: Some(scanned.comment.commented_event_type),
        subjects,
        unknown_block_lines,
    }
}

/// Pack a message-bound event into an `EVENT_COMMENT`'s one text field.
/// The record has nowhere to put a name or a colour, so those go in the
/// block alongside everything else it carries. The object type the comment
/// is attached to is written *both* ways — the record's own field, which
/// is what a foreign reader looks at, and the block, so the grammar reads
/// the same on every carrier (ADR 0057).
fn comment_text(note: &Note) -> String {
    let mut text = event_text::EventText::from_note(note);
    text.label = Some(note.label.clone());
    text.color.clone_from(&note.color);
    event_text::encode(&text)
}

/// Read the form an `EVENT_COMMENT`'s text held before the
/// `cannet-event/1` block: `cannet:event:<tag>\n<id>\n<label>\n<description>`.
/// Text without the prefix is another tool's comment — first line the
/// label, remainder the description, synthetic id.
fn legacy_comment_text(
    raw: &str,
    synthetic_idx: &mut u64,
) -> (String, Option<String>, String, Option<String>) {
    let Some(rest) = raw.strip_prefix(LEGACY_EVENT_TEXT_PREFIX) else {
        let (label, description) = raw.split_once('\n').unwrap_or((raw, ""));
        return (
            synthetic_id("blf-comment", synthetic_idx),
            None,
            label.to_owned(),
            (!description.is_empty()).then(|| description.to_owned()),
        );
    };
    let mut parts = rest.splitn(4, '\n');
    let tag = parts.next().unwrap_or_default();
    let id = parts.next().unwrap_or_default();
    let label = parts.next().unwrap_or_default();
    let description = parts.next().unwrap_or_default();
    (
        id.to_owned(),
        (!tag.is_empty()).then(|| tag.to_owned()),
        label.to_owned(),
        (!description.is_empty()).then(|| description.to_owned()),
    )
}

/// A capture's `##EV` blocks as [`Note`]s — the inverse of
/// [`events_from_notes`], over the whole list because MDF's native range
/// link names another event by position and only the list can resolve it.
///
/// An event written by another tool carries no `cannet-event/1` block, so
/// it gets a synthetic `mdf-event-<index>` id (mirroring what
/// [`note_from_marker`] does for a third-party BLF marker), which keeps
/// its `rename` / `remove` paths working.
pub(crate) fn notes_from_mdf_events(events: &[cannet_mdf::MdfEvent]) -> Vec<Note> {
    let mut synthetic_idx = 0u64;
    let mut notes: Vec<Note> = events
        .iter()
        .map(|e| note_from_event(e, &mut synthetic_idx))
        .collect();
    // A native begin/end pair is another tool's way of saying two events
    // belong together, so it reads back as one more untyped link
    // (ADR 0056) — but only where the block did not already carry it, so
    // our own files do not link a pair twice.
    for (i, event) in events.iter().enumerate() {
        let other = match event.range {
            None => continue,
            Some(cannet_mdf::MdfEventRange::Begin { end }) => end,
            Some(cannet_mdf::MdfEventRange::End { begin }) => begin,
        };
        let Some(other_id) = notes.get(other).map(|n| n.id.clone()) else {
            continue;
        };
        if notes::linked_event_ids(&notes, &notes[i].id).contains(&other_id) {
            continue;
        }
        notes[i]
            .subjects
            .push(notes::EventSubject::Event { id: other_id });
    }
    notes
}

/// One MDF `##EV` block as a [`Note`], its range link still unresolved.
fn note_from_event(event: &cannet_mdf::MdfEvent, synthetic_idx: &mut u64) -> Note {
    if event_text::has_block(&event.text) {
        let text = event_text::decode(&event.text);
        return Note {
            id: text
                .id
                .unwrap_or_else(|| synthetic_id("mdf-event", synthetic_idx)),
            timestamp_ns: event.timestamp_ns,
            label: event.name.clone(),
            kind: text.kind.unwrap_or(notes::EventKind::Note),
            color: text.color,
            description: text.description,
            tag: text.tag,
            commented_event_type: text.commented_event_type,
            subjects: text.subjects,
            unknown_block_lines: text.extra,
        };
    }
    // No block: either another tool's event, or one of ours from before
    // the block existed, when the same fields rode in `common_properties`.
    Note {
        id: event.property(EVENT_ID_PROPERTY).map_or_else(
            || synthetic_id("mdf-event", synthetic_idx),
            ToOwned::to_owned,
        ),
        timestamp_ns: event.timestamp_ns,
        label: event.name.clone(),
        kind: notes::EventKind::Note,
        color: event.property(EVENT_COLOR_PROPERTY).map(ToOwned::to_owned),
        description: event
            .property(EVENT_DESCRIPTION_PROPERTY)
            .map(ToOwned::to_owned)
            .or_else(|| (!event.text.is_empty()).then(|| event.text.clone())),
        tag: event.property(EVENT_TAG_PROPERTY).map(ToOwned::to_owned),
        commented_event_type: None,
        subjects: Vec::new(),
        unknown_block_lines: Vec::new(),
    }
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
/// Markers carry the note's `label` as `marker_name` and
/// the `cannet-event/1` block as `description`, so a save →
/// open round-trip preserves the frontend-stable id along with the tag and
/// the description body.
pub(crate) fn write_blf_capture(
    blf_path: &str,
    frames: &[trace_store::RawTraceFrame],
    notes: &[Note],
    buses: &[String],
) -> Result<SaveCaptureResult, String> {
    // Pass one: the capture's origin. A BLF event's timestamp is an
    // unsigned offset from the file's start, so nothing earlier than
    // that start is representable — and arrival order is not timestamp
    // order (ADR 0024), so the store's first frame is routinely not its
    // earliest. Declaring the minimum before the first append is what
    // keeps every timestamp; it is the same pass `write_mdf_capture`
    // makes for MDF's identically-constrained `hd_start_time_ns`, over
    // frames and notes alike since a note clamps exactly as a frame
    // does. An empty capture has no origin of its own: anchor it at the
    // epoch.
    let start_time_ns = frames
        .iter()
        .map(|f| f.timestamp_ns)
        .chain(notes.iter().map(|n| n.timestamp_ns))
        .min()
        .unwrap_or(0);
    let mut writer = BlfCaptureWriter::create_with_start(blf_path, start_time_ns)
        .map_err(|e| format!("failed to open {blf_path} for writing: {e}"))?;
    // Pass two: interleave frames and markers in timestamp order.
    // Nothing in BLF requires objects to ascend and cannet's reader
    // does not assume they do (`docs/blf-feature-support.md`
    // § "Object timestamps and ordering"); the merge is here because a
    // note comments on the frames around it, so it belongs next to them
    // in the object stream.
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
            match note.kind.blf_record() {
                Some(notes::BlfRecord::EventComment) => writer
                    .append_comment(
                        note.timestamp_ns,
                        &comment_text(note),
                        note.commented_event_type.unwrap_or(0),
                    )
                    .map_err(|e| format!("failed to write comment: {e}"))?,
                // A kind with no record of its own is not written at all;
                // `NotesStore::exportable` has already filtered those out,
                // so falling back to a marker here only affects a caller
                // that assembled its own list.
                _ => writer
                    .append_marker(
                        note.timestamp_ns,
                        &note.label,
                        &event_text::encode(&event_text::EventText::from_note(note)),
                        color_to_rgb(note.color.as_deref()),
                    )
                    .map_err(|e| format!("failed to write marker: {e}"))?,
            }
        }
    }
    let outcome = writer
        .finish()
        .map_err(|e| format!("failed to finalise capture: {e}"))?;

    Ok(SaveCaptureResult {
        path: blf_path.to_string(),
        frame_count: outcome.frame_count,
        byte_size: outcome.byte_size,
        marker_count: outcome.marker_count,
        max_timestamp_drift_ns: outcome.max_timestamp_drift_ns,
        clamped_timestamps: clamped_timestamp_warning(&outcome),
    })
}

/// How many frames one pass of [`write_mdf_capture`] pulls out of the
/// trace store at a time. Big enough that the per-slice lock and the
/// spilled-segment reads amortise, small enough that a multi-million-
/// frame capture never sits in RAM twice (`CLAUDE.md` § GUI architecture
/// — the store is paged, and a save is one more reader of those pages).
const MDF_SAVE_CHUNK: usize = 65_536;

/// Perform the MDF write: the full-fidelity save.
///
/// Everything the model holds that the format can carry goes in, and all
/// of it inside the one file (ADR 0010): frames as bus-logging channel
/// groups, file-backed signals as signal channel groups, notes as `##EV`
/// blocks, and the project's DBCs as embedded `##AT` attachments. What
/// deliberately does *not* go in is DBC-decoded signals — the frames plus
/// the attached DBC already say everything they would.
///
/// `buses` re-channels frames exactly as the BLF save does: a frame's
/// `bus_id` becomes its position in the project's ordered bus list, which
/// is the `BusChannel` an import maps back (ADR 0023).
///
/// Two chunked passes over the trace store, never a whole-capture
/// snapshot: MDF records are a fixed layout, so the first pass settles
/// the capture's origin and its longest payload and the second writes the
/// records.
pub(crate) fn write_mdf_capture(
    path: &str,
    state: &AppState,
    notes: &[Note],
    buses: &[String],
) -> Result<SaveCaptureResult, String> {
    let signals = state.signal_caches.file_signal_series();
    let events = events_from_notes(notes);
    let attachments = dbc_attachments(state);

    // Pass one: the capture's origin and its widest payload. The origin
    // is the earliest of everything on the timeline, not just the frames
    // — a note or a signal sample before the first frame must still land
    // at a non-negative offset from `hd_start_time_ns` (ADR 0024).
    let len = state.trace_store.len();
    let mut start_time_ns = u64::MAX;
    let mut max_payload_len = 0usize;
    for start in (0..len).step_by(MDF_SAVE_CHUNK) {
        for frame in state.trace_store.slice(start, start + MDF_SAVE_CHUNK) {
            start_time_ns = start_time_ns.min(frame.timestamp_ns);
            max_payload_len = max_payload_len.max(frame.payload.data().len());
        }
    }
    for note in notes {
        start_time_ns = start_time_ns.min(note.timestamp_ns);
    }
    for (_, points) in &signals {
        if let Some(first) = points.first() {
            start_time_ns = start_time_ns.min(sample_ns(first.t_seconds));
        }
    }
    // An empty capture with no events and no signals has no origin of its
    // own; anchor it at the epoch rather than at `u64::MAX`.
    let start_time_ns = if start_time_ns == u64::MAX {
        0
    } else {
        start_time_ns
    };

    let mut writer = cannet_mdf::MdfCaptureWriter::create(
        path,
        cannet_mdf::MdfCaptureLayout {
            start_time_ns,
            max_payload_len,
        },
    )
    .map_err(|e| format!("failed to open {path} for writing: {e}"))?;

    // Pass two: the records themselves.
    for start in (0..len).step_by(MDF_SAVE_CHUNK) {
        for frame in state.trace_store.slice(start, start + MDF_SAVE_CHUNK) {
            let core = raw_to_core_frame(&frame, buses)
                .map_err(|e| format!("invalid frame in session buffer: {e}"))?;
            writer
                .append_frame(&core)
                .map_err(|e| format!("failed to write frame: {e}"))?;
        }
    }
    for (info, points) in &signals {
        writer.add_signal(
            info.group_name.clone(),
            cannet_mdf::FileSignal {
                name: info.name.clone(),
                unit: (!info.unit.is_empty()).then(|| info.unit.clone()),
                conversion: None,
                value_table: info
                    .value_table
                    .iter()
                    .map(|e| (e.raw, e.label.clone()))
                    .collect(),
                timestamps_ns: points.iter().map(|p| sample_ns(p.t_seconds)).collect(),
                values: points.iter().map(|p| p.value).collect(),
            },
        );
    }
    for event in events {
        writer.add_event(event);
    }
    for attachment in attachments {
        writer.add_attachment(attachment);
    }

    let outcome = writer
        .finish()
        .map_err(|e| format!("failed to finalise capture: {e}"))?;
    Ok(SaveCaptureResult {
        path: path.to_string(),
        frame_count: outcome.frame_count,
        byte_size: outcome.byte_size,
        marker_count: outcome.event_count,
        // The master axis is f64 seconds against the capture's own origin,
        // so a frame's absolute nanoseconds come back exactly for any
        // capture spanning less than ~26 days.
        max_timestamp_drift_ns: 0,
        // MDF declares its origin the same way (pass one above), so
        // nothing is ever moved to reach it.
        clamped_timestamps: None,
    })
}

/// A cached sample's `t_seconds` back as absolute nanoseconds. The cache
/// stores seconds since the epoch as an `f64`, so this is the model's own
/// resolution (~0.24 µs at present-day wall clocks), not the nanosecond
/// the frame timeline keeps.
#[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
pub(crate) fn sample_ns(t_seconds: f64) -> u64 {
    if t_seconds <= 0.0 {
        return 0;
    }
    (t_seconds * 1e9).round() as u64
}

/// A list of [`Note`]s as MDF events. The whole list, because the native
/// range pairing is by position and only the list can compute it.
///
/// The `##EV` block's own fields carry what they honestly can — the label
/// as `ev_tx_name`, the range pair where a link is unambiguously a span —
/// and the `cannet-event/1` block in the comment's `<TX>` carries the
/// model exactly (ADR 0057). Nothing goes in `common_properties`: a
/// second encoding of the same data buys nothing the native fields do not
/// already buy for interop.
fn events_from_notes(notes: &[Note]) -> Vec<cannet_mdf::MdfEvent> {
    let ranges = span_ranges(notes);
    notes
        .iter()
        .zip(ranges)
        .map(|(note, range)| {
            let mut text = event_text::EventText::from_note(note);
            // MDF's event has a name, but no colour: that one rides the
            // block here and nowhere else.
            text.color.clone_from(&note.color);
            cannet_mdf::MdfEvent {
                timestamp_ns: note.timestamp_ns,
                name: note.label.clone(),
                text: event_text::encode(&text),
                properties: Vec::new(),
                range,
            }
        })
        .collect()
}

/// Which events may be written as MDF's native begin/end range pair.
///
/// MDF's range link is *typed* and holds exactly one partner, where ours
/// are untyped and fan out (ADR 0056). So the pair is written only where
/// the two models agree — two events linked to each other and to nothing
/// else — and it is an interop courtesy either way: the link itself is
/// carried by the text block, whether or not a range is written.
fn span_ranges(notes: &[Note]) -> Vec<Option<cannet_mdf::MdfEventRange>> {
    let mut linked: Vec<Vec<usize>> = vec![Vec::new(); notes.len()];
    for (i, note) in notes.iter().enumerate() {
        for subject in &note.subjects {
            let Some(target) = subject.referenced_event() else {
                continue;
            };
            let Some(j) = notes.iter().position(|n| n.id == target) else {
                continue;
            };
            if i == j {
                continue;
            }
            if !linked[i].contains(&j) {
                linked[i].push(j);
            }
            if !linked[j].contains(&i) {
                linked[j].push(i);
            }
        }
    }
    linked
        .iter()
        .enumerate()
        .map(|(i, ends)| {
            let [j] = ends[..] else { return None };
            if linked[j] != [i] {
                return None;
            }
            Some(if i < j {
                cannet_mdf::MdfEventRange::Begin { end: j }
            } else {
                cannet_mdf::MdfEventRange::End { begin: j }
            })
        })
        .collect()
}

/// `common_properties` keys a cannet-written MDF event carried before the
/// `cannet-event/1` block took over (ADR 0057). Still read, so a capture
/// written by an earlier build opens with its events intact.
pub(crate) const EVENT_ID_PROPERTY: &str = "cannet.id";
pub(crate) const EVENT_COLOR_PROPERTY: &str = "cannet.color";
pub(crate) const EVENT_DESCRIPTION_PROPERTY: &str = "cannet.description";
pub(crate) const EVENT_TAG_PROPERTY: &str = "cannet.tag";

/// The project's loaded DBCs as embedded attachments, read back off disk
/// at save time. A DBC that has since moved or been deleted is skipped
/// rather than failing the save — the capture is the thing being written.
fn dbc_attachments(state: &AppState) -> Vec<cannet_mdf::MdfAttachment> {
    state
        .databases()
        .iter()
        .filter_map(|db| {
            let data = std::fs::read(&db.path).ok()?;
            Some(cannet_mdf::MdfAttachment {
                file_name: std::path::Path::new(&db.path)
                    .file_name()
                    .map_or_else(|| db.path.clone(), |n| n.to_string_lossy().into_owned()),
                mime_type: DBC_MIME_TYPE.to_owned(),
                data,
            })
        })
        .collect()
}

/// What an embedded DBC declares itself as. Vector's own registration for
/// the format, and what other MDF tools look for on an attachment.
const DBC_MIME_TYPE: &str = "application/vnd.vector.dbc";

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

/// Everything the import dialog needs from one header-only scan of a
/// BLF file: the channel census the mapping step maps, the capture's
/// span and frame count (cheap header metadata, per ADR 0046 — the
/// census is the one sanctioned extra walk, so anything it already
/// carries is free to surface here), and its markers projected onto
/// the same [`Note`] shape they land in the session store as, if the
/// file is imported.
///
/// Domain computation stops here: the frontend formats the ns fields
/// into a duration and a wall-clock string (thin-views-over-a-paged-
/// model — see `CLAUDE.md` § GUI architecture), and marker ordering is
/// whatever [`cannet_blf::scan_blf`] found (file order).
#[derive(Debug, Clone, serde::Serialize)]
pub struct BlfScanResult {
    pub channels: Vec<u8>,
    pub frame_count: u64,
    pub first_timestamp_ns: Option<u64>,
    pub last_timestamp_ns: Option<u64>,
    pub start_unix_nanos: u64,
    pub markers: Vec<Note>,
}

/// Pre-scan a BLF file and return its distinct channel numbers, capture
/// metadata, and markers — everything the channel → bus mapping dialog
/// shows before frames start flowing.
///
/// The census is **exact**: [`cannet_blf::scan_blf`] walks the whole
/// file header-only — reading each object's channel field without
/// decoding its body — so a channel that first appears late in a long
/// capture is still offered a mapping. The walk pays the file's inflate
/// and nothing else, which measures around 80 MB/s in a release build —
/// half a second on a 46 MB log, under six on a 470 MB one — and is the
/// price of never silently dropping a channel. The
/// same walk also sees every `GLOBAL_MARKER` and the first/last frame
/// timestamps for free (ADR 0046), so the dialog's markers gridview and
/// metadata line cost nothing beyond this one pass.
///
/// `async` so Tauri runs it off the main thread, and the body itself on
/// the blocking pool ([`off_async_workers`]): the walk covers the whole
/// file, so its duration scales with the capture — 20 s at the reference
/// scale in a dev build — and that is exactly the work an async worker
/// must not be holding (ADR 0048). Freezing the UI is not the only cost
/// of getting this wrong; a parked worker is one the close path may
/// need.
#[tauri::command]
pub(crate) async fn scan_blf_channels(
    app: AppHandle,
    blf_path: String,
) -> Result<Option<BlfScanResult>, String> {
    off_async_workers(move || {
        let started = std::time::Instant::now();
        let mut pacer = ProgressPacer::new();
        let scan = match census_blf(&app.state::<AppState>(), &blf_path, &mut |p| {
            if pacer.due(Instant::now()) {
                let _ = app.emit(
                    LOAD_PROGRESS,
                    LoadProgress::Census {
                        bytes_read: p.bytes_read,
                        total_bytes: p.total_bytes,
                    },
                );
            }
        }) {
            Ok(Some(s)) => s,
            // Cancelled. Nothing was produced and nothing is owed: the
            // caller drops the open rather than showing a dialog over a
            // census that never finished.
            Ok(None) => {
                sys_info!(&app, "blf-import", "census of {blf_path} cancelled");
                return Ok(None);
            }
            Err(msg) => {
                sys_error!(&app, "blf-import", "BLF scan failed: {msg}");
                return Err(msg);
            }
        };
        // What the census cost, and what it found — a slow import starts
        // here, so the log says how much of it was the scan.
        sys_debug!(
            &app,
            "blf-import",
            "scanned {blf_path} in {ms:.0} ms: {frames} frame(s) on {channels} channel(s), \
             {markers} annotation(s)",
            ms = started.elapsed().as_secs_f64() * 1000.0,
            frames = scan.frame_count,
            channels = scan.channels.len(),
            markers = scan.markers.len() + scan.comments.len(),
        );
        // A capture whose writer never finished is opened for what it
        // holds rather than refused, and says so once — the counts and
        // the timeline the dialog is about to show were derived from
        // the walk, not from the file's own header.
        if let Some(warning) = recovered_capture_warning(&scan) {
            sys_warn!(&app, "blf-import", "{blf_path}: {warning}");
        }
        let mut synthetic_idx = 0u64;
        let mut markers: Vec<Note> = scan
            .markers
            .iter()
            .map(|m| note_from_marker(m, &mut synthetic_idx))
            .collect();
        let mut synthetic_comment_idx = 0u64;
        markers.extend(
            scan.comments
                .iter()
                .map(|c| note_from_comment(c, &mut synthetic_comment_idx)),
        );
        markers.sort_by_key(|n| n.timestamp_ns);
        Ok(Some(BlfScanResult {
            channels: scan.channels,
            frame_count: scan.frame_count,
            first_timestamp_ns: scan.first_timestamp_ns,
            last_timestamp_ns: scan.last_timestamp_ns,
            start_unix_nanos: scan.start_unix_nanos,
            markers,
        }))
    })
    .await
}

/// Walk `path`'s census under a cancel flag installed in
/// [`AppState::import_cancel`], reporting progress at each checkpoint.
///
/// The flag is the same one the pump uses, so one `cancel_import` stops
/// whichever phase of a trace open is running — the phases are
/// sequential and only one trace open runs at a time, so there is never
/// more than one flag to hold. It is installed before the walk and
/// cleared however the walk ends.
///
/// `Ok(None)` means cancelled. A census produces nothing until it
/// finishes — its channel set, frame count and span are only right once
/// the whole file has been read — so a cancelled one has no partial
/// result to return and nothing anywhere to undo.
///
/// Factored out of [`scan_blf_channels`] so it's testable against a
/// plain [`AppState`]: the command wrapper needs a live Tauri app to
/// construct its `State` and to emit, and the suite has no harness for
/// one.
pub(crate) fn census_blf(
    state: &AppState,
    path: &str,
    on_progress: &mut dyn FnMut(cannet_blf::ScanProgress),
) -> Result<Option<cannet_blf::BlfScan>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    *state.import_cancel() = Some(Arc::clone(&cancel));
    let outcome = cannet_blf::scan_blf_cancellable(path, &cancel, on_progress);
    *state.import_cancel() = None;
    match outcome {
        Ok(cannet_blf::ScanOutcome::Complete(scan)) => Ok(Some(scan)),
        Ok(cannet_blf::ScanOutcome::Cancelled) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Start importing `mdf_path`, routing each `BusChannel` per
/// `channel_bus_mapping`, optionally narrowed to `[start_ns, end_ns]`.
/// The MDF counterpart of [`open_log`]: same shape, same
/// one-pass-over-the-source pipeline (`run_pump`, generic over
/// [`cannet_core::CanFrameSource`]), same `WindowedSource` import-range
/// filter (ADR 0046), same [`cancel_import`] cancellation, same
/// `total_frames` denominator from the census. The file's
/// `##EV` blocks become session notes, the part `GLOBAL_MARKER` records
/// play on the BLF path — read up front rather than through a sink,
/// because MDF events hang off the header block rather than riding the
/// record stream.
///
/// An MF4 holds two independent kinds of content and the caller says
/// which it wants. `import_signals` brings in the file's signal channel
/// groups as file-backed signals; `import_messages` runs the frames
/// through the pump onto the timeline, where the project's own DBCs
/// decode them. Neither implies the other, and with `import_messages`
/// off there are no frames to anchor the session — the signal content
/// supplies the origin instead (see [`signal_origin_ns`]).
///
/// `async` for the same reason as `open_log`: opening and finalizing an
/// unsorted MDF parses the whole block graph, and that must not hold up
/// the Tauri main thread.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
#[allow(clippy::unused_async)]
// `async` is what makes Tauri run it off the main thread
// A Tauri command: the args are the IPC payload fields, and the body is
// one pump thread with one linear tail — opening, the pump, and what the
// walk collected, in the order they happen.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
pub(crate) async fn import_mdf(
    app: AppHandle,
    mdf_path: String,
    #[allow(non_snake_case)] channel_bus_mapping: Option<Vec<ChannelBusMapping>>,
    start_ns: Option<u64>,
    end_ns: Option<u64>,
    #[allow(non_snake_case)] import_signals: Option<bool>,
    #[allow(non_snake_case)] import_messages: Option<bool>,
    #[allow(non_snake_case)] total_frames: Option<u64>,
) -> Result<ImportMdfResult, String> {
    // Absent flags mean "everything the file has" — the shape the
    // command had before the contents became selectable.
    let import_signals = import_signals.unwrap_or(true);
    let import_messages = import_messages.unwrap_or(true);
    // Open (and, for an unsorted/unfinalized CANedge file, finalize +
    // sort) before returning, so a bad path fails immediately rather
    // than behind a spawned thread.
    let source = match MdfCanFrameSource::open(&mdf_path) {
        Ok(s) => s,
        Err(e) => {
            let msg = e.to_string();
            sys_error!(&app, "mdf-import", "failed to open MDF {mdf_path}: {msg}");
            return Err(msg);
        }
    };
    sys_info!(
        &app,
        "mdf-import",
        "opened MDF {mdf_path}: unfinalized={unfinalized}",
        unfinalized = source.is_unfinalized(),
    );

    adopt_embedded_databases(&app, &mdf_path, &source);

    let result = ImportMdfResult {
        mdf_path: mdf_path.clone(),
    };

    // Read the file's signal channel groups and events before the source
    // is handed to the pump: both are one-time reads that complete,
    // unlike the frame stream, and both need the open file.
    let signal_groups = if import_signals {
        source.signal_groups()
    } else {
        Vec::new()
    };
    let notes = notes_from_events(&app, &source);

    let channel_to_bus: Vec<(u8, String)> = channel_bus_mapping
        .unwrap_or_default()
        .into_iter()
        .map(|m| (m.channel, m.bus_id))
        .collect();

    // Same seam BLF import uses (ADR 0046): the selected range is a
    // filter at the `CanFrameSource` boundary, ahead of `run_pump`, so
    // an out-of-range frame never reaches `TraceStore::append`.
    let source = cannet_core::WindowedSource::new(source, start_ns, end_ns);

    // See `open_log`'s identical flag: installed before the thread
    // spawns, checked by `run_pump`'s loop, cleared once the pump ends.
    let cancel = Arc::new(AtomicBool::new(false));
    *app.state::<AppState>().import_cancel() = Some(Arc::clone(&cancel));
    let cancelled_probe = Arc::clone(&cancel);

    let app_for_thread = app.clone();
    std::thread::Builder::new()
        .name("cannet-mdf-pump".into())
        .spawn(move || {
            // See `open_log`'s identical guard: a panic on the ingest
            // path must end the load with a visible error, not a
            // silently dead thread the UI waits on forever.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let state: State<'_, AppState> = app_for_thread.state();
                let mut anchor = if import_messages {
                    run_pump(
                        &app_for_thread,
                        source,
                        cancel,
                        channel_to_bus,
                        // replay_origin: the session anchors on the file's
                        // own earliest timestamp (ADR 0024).
                        true,
                        total_frames.map(ImportProgress::new),
                    )
                } else {
                    // The frontend's load state ends on this event
                    // whichever contents were asked for.
                    let count = u64::try_from(state.trace_store.len()).unwrap_or(u64::MAX);
                    let _ =
                        app_for_thread.emit("log-finished", LogFinished::Ok { total: 0, count });
                    None
                };
                // Abandoned: the frames are being cleared right now, so
                // the file's signals and events have no capture to
                // belong to. Stop before the fill, which is the
                // expensive part and would otherwise run to completion
                // long after the user asked for it to stop.
                if import_was_cancelled(&cancelled_probe) {
                    return;
                }
                // The file's signals and events are on the capture's
                // timeline too, and either can start before its first
                // frame — an MDF's earliest content routinely does. Fold
                // both into the origin before the fill: minting one wipes
                // the signal caches, so a fill ahead of it would be eaten.
                let notes = settle_import_origin(
                    &state,
                    &mut anchor,
                    notes,
                    signal_origin_ns(&signal_groups, start_ns, end_ns),
                    start_ns,
                    end_ns,
                );
                let (signals, samples) = fill_file_backed_signals(
                    &state.signal_caches,
                    &signal_groups,
                    start_ns,
                    end_ns,
                    &mdf_path,
                );
                // The capture's file-backed set just changed — say so, so a
                // catalog over it (the Database view's per-file branches,
                // ADR 0052) refreshes without polling.
                let _ = app_for_thread.emit(FILE_SIGNALS_CHANGED, ());
                if signals > 0 {
                    sys_info!(
                        &app_for_thread,
                        "mdf-import",
                        "imported {signals} file-backed signal(s) \
                         ({samples} sample(s)) from {groups} signal channel group(s)",
                        groups = signal_groups.len(),
                    );
                }
                // The file's events, applied after the pass — same point
                // in the flow as `open_log`'s BLF markers, and after the
                // capture identity that wipes the session store. Their
                // range filtering and their contribution to the origin
                // already happened above.
                if !notes.is_empty() {
                    let count = notes.len();
                    let _ = state.notes.replace(notes.clone());
                    let _ = app_for_thread.emit("notes-changed", notes);
                    sys_info!(
                        &app_for_thread,
                        "mdf-import",
                        "loaded {count} note(s) from MDF event blocks",
                    );
                }
            }));
            // This pump is done — cleanly, cancelled, or panicked — so
            // nothing should be able to cancel it again.
            *app_for_thread.state::<AppState>().import_cancel() = None;
            if let Err(payload) = result {
                let msg = format!("load failed: {}", panic_message(payload.as_ref()));
                sys_error!(&app_for_thread, "mdf-import", "{msg}");
                let _ = app_for_thread.emit("log-finished", LogFinished::Error { message: msg });
            }
        })
        .map_err(|e| format!("failed to spawn pump thread: {e}"))?;

    Ok(result)
}

/// Fill one cache entry per signal of `groups` — the file-backed half of
/// an MDF import. Returns `(signals filled, samples across them)`.
///
/// Each channel is already a decoded value series with absolute
/// timestamps (ADR 0024), so this is a straight hand-off into the signal
/// cache: no message carries these signals and no DBC decodes them, and
/// what lands is complete the moment it lands.
///
/// `start_ns` / `end_ns` are the import range (ADR 0046), applied here
/// for the same reason `WindowedSource` applies it to frames — a
/// windowed import must not put a file-backed series spanning the whole
/// file on the same plot as a trace holding a slice of it. Bounds are
/// inclusive, matching `WindowedSource`. A signal left with no samples
/// in range is not filled at all: the capture simply doesn't have it.
pub(crate) fn fill_file_backed_signals(
    caches: &SignalCacheStore,
    groups: &[cannet_mdf::SignalChannelGroup],
    start_ns: Option<u64>,
    end_ns: Option<u64>,
    source_path: &str,
) -> (usize, u64) {
    let (mut signals, mut samples) = (0usize, 0u64);
    for group in groups {
        for signal in &group.signals {
            let points: Vec<(u64, f64)> = signal
                .timestamps_ns
                .iter()
                .zip(&signal.values)
                .filter(|(ts, _)| {
                    start_ns.is_none_or(|s| **ts >= s) && end_ns.is_none_or(|e| **ts <= e)
                })
                .map(|(ts, v)| (*ts, *v))
                .collect();
            if points.is_empty() {
                continue;
            }
            let info = FileSignalInfo {
                source_path: source_path.to_string(),
                group: u32::try_from(group.group_index).unwrap_or(u32::MAX),
                group_name: group.name.clone(),
                name: signal.name.clone(),
                unit: signal.unit.clone().unwrap_or_default(),
                value_table: signal
                    .value_table
                    .iter()
                    .map(|(raw, label)| ValueTableEntryRecord {
                        raw: *raw,
                        label: label.clone(),
                    })
                    .collect(),
            };
            samples += points.len() as u64;
            signals += 1;
            caches.fill_file_backed(&info, &points);
        }
    }
    (signals, samples)
}

/// The capture's `##EV` blocks as session notes — the part
/// `GLOBAL_MARKER` records play on the BLF path. A bad event chain is
/// reported, not fatal: it is no reason to lose the frames.
fn notes_from_events(app: &AppHandle, source: &MdfCanFrameSource) -> Vec<Note> {
    match source.events() {
        Ok(events) => notes_from_mdf_events(&events),
        Err(e) => {
            sys_warn!(app, "mdf-import", "could not read MDF events: {e}");
            Vec::new()
        }
    }
}

/// Put the capture's own databases into the loaded set, and say so.
/// Called before the frames flow: the embedded definitions are what
/// decodes them, and they are usable without being written anywhere
/// (ADR 0010).
fn adopt_embedded_databases(app: &AppHandle, mdf_path: &str, source: &MdfCanFrameSource) {
    let attachments = match source.attachments() {
        Ok(a) => a,
        Err(e) => {
            // A bad attachment chain is not a reason to lose the capture.
            sys_warn!(app, "mdf-import", "could not read MDF attachments: {e}");
            return;
        }
    };
    let state: State<'_, AppState> = app.state();
    // Snapshotted before the installs: a re-import replaces the same
    // capture's databases in place, and afterwards there is no way left
    // to ask what the content they replace was driving.
    let backed_before = crate::transmit_commands::dbc_backed_running_periodics(state.inner());
    let loaded = install_embedded_databases(state.inner(), mdf_path, &attachments);
    for db in &loaded {
        if db.reloaded {
            crate::dbc_commands::report_reload_stops(
                app,
                state.inner(),
                &db.identity,
                &backed_before,
            );
        }
    }
    for db in &loaded {
        for w in &db.warnings {
            sys_warn!(app, "dbc", "{identity}: {w}", identity = db.identity);
        }
        if let Some(error) = &db.error {
            sys_error!(app, "mdf-import", "embedded database not loaded: {error}");
        } else {
            sys_info!(
                app,
                "mdf-import",
                "loaded embedded database {identity} ({messages} message(s)) from the capture",
                identity = db.identity,
                messages = db.message_count,
            );
        }
    }
    if loaded.iter().any(|d| d.error.is_none()) {
        // The same announcement every other DBC-set change makes
        // (ADR 0053 §2) — the loaded set just changed, and a capture's
        // embedded databases are no different to the consumers.
        crate::dbc_commands::announce_dbc_change(app, mdf_path);
    }
}

/// What one embedded database did on its way into the loaded set.
#[derive(Debug, Clone)]
pub(crate) struct EmbeddedDbc {
    /// The identity it was loaded under — the capture, then the
    /// attachment's own name.
    pub identity: String,
    /// Messages it defines, `0` if it did not parse.
    pub message_count: usize,
    /// Non-fatal attribute problems.
    pub warnings: Vec<String>,
    /// Why it did not load, if it did not.
    pub error: Option<String>,
    /// Whether this replaced a database already loaded under the same
    /// identity — a re-import of the same capture is a reload in place.
    pub reloaded: bool,
}

/// Whether an `##AT` attachment is a database this project can read: the
/// MIME type Vector registered for the format, or failing that a `.dbc`
/// name. An external attachment carries no bytes (it names a file on
/// disk instead), and chasing that reference would be the sidecar
/// [ADR 0010](../../../docs/adr/0010-no-sidecar-files.md) rules out.
fn is_embedded_dbc(attachment: &cannet_mdf::MdfAttachment) -> bool {
    !attachment.data.is_empty()
        && (attachment.mime_type.eq_ignore_ascii_case(DBC_MIME_TYPE)
            || std::path::Path::new(&attachment.file_name)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("dbc")))
}

/// Stream the capture's embedded databases into the loaded DBC set —
/// the same machinery a DBC picked off disk goes through
/// ([`crate::dbc_commands::install_dbc`]), given the bytes instead of a
/// path. Nothing is written anywhere: an embedded database is usable
/// where it lies (ADR 0010).
///
/// The identity is `<capture>#<attachment name>`, which is deliberately
/// not a path: nothing reloads it from disk, and re-importing the same
/// capture replaces it in place rather than stacking a second copy.
pub(crate) fn install_embedded_databases(
    state: &AppState,
    capture_path: &str,
    attachments: &[cannet_mdf::MdfAttachment],
) -> Vec<EmbeddedDbc> {
    attachments
        .iter()
        .filter(|a| is_embedded_dbc(a))
        .map(|a| {
            let identity = format!("{capture_path}#{}", a.file_name);
            let text = String::from_utf8_lossy(&a.data);
            match crate::dbc_commands::install_dbc(state, &identity, &text) {
                Ok(installed) => EmbeddedDbc {
                    identity,
                    message_count: installed.message_count,
                    warnings: installed.warnings,
                    error: None,
                    reloaded: installed.reloaded,
                },
                Err(message) => EmbeddedDbc {
                    identity,
                    message_count: 0,
                    warnings: Vec::new(),
                    error: Some(message),
                    reloaded: false,
                },
            }
        })
        .collect()
}

/// Fold everything the import brings in *besides* its frames into the
/// session origin, and return the notes that belong to the imported
/// range.
///
/// The origin is the earliest timestamp on the capture's timeline (ADR
/// 0024), and frames are not the only thing on it: an MDF's earliest
/// content is routinely a file-backed signal sample, and either format
/// can carry an annotation ahead of its first frame. Anchoring on the
/// frames alone left those rendering at a negative elapsed time —
/// exactly what the ADR's invariant forbids.
///
/// `anchor` is the pump's own anchor (`None` when it appended no
/// frames), threaded through so this either lowers an existing origin or
/// mints one — and when it mints one, restamps the scratch for the
/// capture the way the pump's first frame does.
///
/// Notes outside `[start_ns, end_ns]` are dropped rather than kept and
/// anchored around: the selected range is what the import brings in (ADR
/// 0046), so an annotation outside it is not part of this capture. Call
/// this **before** filling the file-backed signals — minting an origin
/// wipes the signal caches.
pub(crate) fn settle_import_origin(
    state: &AppState,
    anchor: &mut Option<u64>,
    notes: Vec<Note>,
    signal_origin_ns: Option<u64>,
    start_ns: Option<u64>,
    end_ns: Option<u64>,
) -> Vec<Note> {
    let notes: Vec<Note> = notes
        .into_iter()
        .filter(|n| {
            start_ns.is_none_or(|s| n.timestamp_ns >= s)
                && end_ns.is_none_or(|e| n.timestamp_ns <= e)
        })
        .collect();
    let earliest = signal_origin_ns
        .into_iter()
        .chain(notes.iter().map(|n| n.timestamp_ns).min())
        .min();
    if let Some(ts) = earliest {
        // Same call the pump makes per frame; `true` means this minted
        // the capture, so the scratch is restamped for it here instead.
        if crate::session::anchor_replay_session(state, anchor, ts) {
            restamp_scratch_for_capture(state);
        }
    }
    notes
}

/// The earliest sample `groups` will land inside the import range — the
/// signals' half of [`settle_import_origin`]'s input.
///
/// A capture's timeline starts at its own first sample, not at the wall
/// clock the import happened to run at (ADR 0024). `None` when the range
/// excludes every sample: the signals then contribute no origin.
pub(crate) fn signal_origin_ns(
    groups: &[cannet_mdf::SignalChannelGroup],
    start_ns: Option<u64>,
    end_ns: Option<u64>,
) -> Option<u64> {
    groups
        .iter()
        .flat_map(|g| &g.signals)
        .flat_map(|s| s.timestamps_ns.iter().copied())
        .filter(|ts| start_ns.is_none_or(|s| *ts >= s) && end_ns.is_none_or(|e| *ts <= e))
        .min()
}

/// One per-message DBC-decoded channel group [`scan_mdf_channels`]
/// found — one CAN message's signals, as the recording tool's own DBC
/// decoded them. Its series arrive as file-backed signals with the rest
/// of the file's signal content; this is the per-message breakdown, so
/// the import dialog can say what that content is.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DecodedMessageGroupInfo {
    pub source_path: String,
    pub name: Option<String>,
    pub signal_count: usize,
}

impl From<&cannet_mdf::DecodedMessageGroup> for DecodedMessageGroupInfo {
    fn from(g: &cannet_mdf::DecodedMessageGroup) -> Self {
        Self {
            source_path: g.source_path.clone(),
            name: g.name.clone(),
            signal_count: g.signal_count,
        }
    }
}

/// Everything the import dialog needs from one census walk of an MDF
/// 4.x bus-logging file — the MDF counterpart of [`BlfScanResult`].
///
/// `markers` are the file's `##EV` blocks projected onto the same
/// [`Note`] shape a BLF's `GLOBAL_MARKER` records take, so the
/// channel→bus mapping dialog (shared with BLF import) needs no
/// per-format branching for its markers section.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MdfScanResult {
    pub channels: Vec<u8>,
    pub frame_count: u64,
    pub first_timestamp_ns: Option<u64>,
    pub last_timestamp_ns: Option<u64>,
    pub start_unix_nanos: u64,
    pub markers: Vec<Note>,
    pub unfinalized: bool,
    /// Signal channel groups the file carries — what [`import_mdf`]
    /// brings in as file-backed signals (`docs/CONTEXT.md`) when its
    /// `import_signals` is set, so the mapping dialog can offer the
    /// choice and say what arrives beyond the frames.
    pub signal_group_count: usize,
    /// Signals across those groups — the number that lands when signals
    /// are imported.
    pub signal_count: usize,
    /// The per-message DBC-decoded subset of them. See
    /// [`DecodedMessageGroupInfo`].
    pub decoded_message_groups: Vec<DecodedMessageGroupInfo>,
}

/// Pre-scan an MDF file and return its distinct `BusChannel` census,
/// capture metadata, and the file's other content shapes — everything
/// the channel → bus mapping dialog shows before frames start flowing.
/// The MDF counterpart of [`scan_blf_channels`]: same one-pass-over-
/// the-file cost model (ADR 0046), routed through [`cannet_mdf::scan_mdf`]
/// instead of `cannet_blf::scan_blf`.
///
/// A signal-shape file (no bus-logging group) scans like any other,
/// reporting no channels and no frames: its content is signals, and
/// the dialog offers that content alone.
#[tauri::command]
pub(crate) async fn scan_mdf_channels(
    app: AppHandle,
    mdf_path: String,
) -> Result<Option<MdfScanResult>, String> {
    off_async_workers(move || {
        let started = std::time::Instant::now();
        let mut pacer = ProgressPacer::new();
        let scan = match census_mdf(&app.state::<AppState>(), &mdf_path, &mut |p| {
            if pacer.due(Instant::now()) {
                let _ = app.emit(
                    LOAD_PROGRESS,
                    LoadProgress::Census {
                        bytes_read: p.bytes_read,
                        total_bytes: p.total_bytes,
                    },
                );
            }
        }) {
            Ok(Some(s)) => s,
            Ok(None) => {
                sys_info!(&app, "mdf-import", "census of {mdf_path} cancelled");
                return Ok(None);
            }
            Err(msg) => {
                sys_error!(&app, "mdf-import", "MDF scan failed: {msg}");
                return Err(msg);
            }
        };
        sys_debug!(
            &app,
            "mdf-import",
            "scanned {mdf_path} in {ms:.0} ms: {frames} frame(s) on {channels} channel(s), \
             {signals} signal group(s), {decoded} of them per-message decoded",
            ms = started.elapsed().as_secs_f64() * 1000.0,
            frames = scan.frame_count,
            channels = scan.channels.len(),
            signals = scan.signal_groups.len(),
            decoded = scan.decoded_message_groups.len(),
        );
        // Never silent (per the crate's own design): every per-message
        // group is named in the System Messages, not just counted.
        if !scan.decoded_message_groups.is_empty() {
            let names = scan
                .decoded_message_groups
                .iter()
                .map(|g| g.name.clone().unwrap_or_else(|| g.source_path.clone()))
                .collect::<Vec<_>>()
                .join(", ");
            sys_info!(
                &app,
                "mdf-import",
                "{n} per-message decoded group(s) carry signals of their own: {names}",
                n = scan.decoded_message_groups.len(),
            );
        }
        let markers = notes_from_mdf_events(&scan.events);
        Ok(Some(MdfScanResult {
            channels: scan.channels,
            frame_count: scan.frame_count,
            first_timestamp_ns: scan.first_timestamp_ns,
            last_timestamp_ns: scan.last_timestamp_ns,
            start_unix_nanos: scan.start_unix_nanos,
            markers,
            unfinalized: scan.unfinalized,
            signal_group_count: scan.signal_groups.len(),
            signal_count: scan.signal_groups.iter().map(|g| g.signal_count).sum(),
            decoded_message_groups: scan.decoded_message_groups.iter().map(Into::into).collect(),
        }))
    })
    .await
}

/// [`census_blf`] for an MDF: same flag, same `Ok(None)` for cancelled,
/// same reason for being factored out of its command.
pub(crate) fn census_mdf(
    state: &AppState,
    path: &str,
    on_progress: &mut dyn FnMut(cannet_mdf::ScanProgress),
) -> Result<Option<cannet_mdf::MdfScan>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    *state.import_cancel() = Some(Arc::clone(&cancel));
    let outcome = cannet_mdf::scan_mdf_cancellable(path, &cancel, on_progress);
    *state.import_cancel() = None;
    match outcome {
        Ok(cannet_mdf::ScanOutcome::Complete(scan)) => Ok(Some(scan)),
        Ok(cannet_mdf::ScanOutcome::Cancelled) => Ok(None),
        Err(e) => Err(e.to_string()),
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
/// Re-stamp the scratch for a freshly reset capture buffer (ADR 0002
/// DS-7), called right after each `start_session`: drop the now-stale
/// filter index and record the active project as the scratch's owner, so
/// a later launch reloads this session only against the same project.
/// `start_session` already wiped the raw store, the reopen manifest, and
/// the prior identity / derived files; this writes the fresh identity.
pub(crate) fn restamp_scratch_for_capture(state: &AppState) {
    *state.filter_index() = None;
    // The pyramids decode frame indices into the capture that has just been
    // discarded, and so does anything a prior session left staged on disk
    // (ADR 0047). A new capture is exactly the event that makes them
    // meaningless — including a BLF import, which reaches here through the
    // pump's replay session-start rather than through Clear.
    state.signal_caches.clear();
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
    // Drops the decoded-sample caches along with the rest of the scratch's
    // capture-scoped state. The verification runtime (violation indices +
    // counter continuity) holds frame indices too and goes the same way.
    restamp_scratch_for_capture(&state);
    state.verifier.clear_runtime();
    // Same reason: the undelivered-transmit marks address rows by
    // index, so the new capture's row 0 would inherit the last one's.
    state.undelivered_tx.clear();
    // `restamp_scratch_for_capture` dropped the file-backed series with
    // the rest of the capture-scoped state; the catalog over them is
    // now empty and its readers need to hear it.
    let _ = app.emit(FILE_SIGNALS_CHANGED, ());
    if let Some(applied) = state.notes.clear() {
        let _ = app.emit("notes-changed", applied.notes);
    }
    // The coalescer is the derived events' producer, so clearing them
    // without clearing it would only have them republished a tick later.
    if let Some(health) = app.try_state::<crate::bus_health::BusHealth>() {
        health.clear();
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
    /// The reloaded capture's session origin (Unix-epoch seconds, ADR
    /// 0024), or `None` when nothing was restored. Never zero-for-absent:
    /// a capture imported from a log with no stated start time is
    /// anchored at exactly zero.
    session_start_seconds: Option<f64>,
    /// Whether the restore had to **discard** the pyramids a prior
    /// session persisted (ADR 0047), so every plotted signal is decoded
    /// again from frame zero — minutes on a large capture. The frontend
    /// announces this and offers to drop the capture instead; it is the
    /// host's own reading of [`SignalCacheStore::rebuilding`], never
    /// something the frontend infers from how slow a plot feels.
    pyramids_rebuilding: bool,
}

/// Whether the session is still owed the cold pyramid rebuild a restore
/// forced (ADR 0047), and how far it has got. Factored out from
/// [`signal_pyramids_rebuilding`] so it's testable against a plain
/// `AppState` — the command wrapper needs a live Tauri app to construct
/// its `State`.
pub(crate) fn pyramids_rebuilding_now(state: &AppState) -> RebuildProgressRecord {
    state
        .signal_caches
        .rebuild_progress(state.trace_store.len())
        .into()
}

/// The rebuild's progress, polled by the frontend while it shows the
/// rebuild chip. A queryable fact rather than an event: the answer is
/// derived from where the caches' decode cursors have reached, so there
/// is no single moment for the host to fire, and the chip only asks
/// while it is up.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn signal_pyramids_rebuilding(state: State<'_, AppState>) -> RebuildProgressRecord {
    pyramids_rebuilding_now(&state)
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
        // Nothing came back, so nothing a prior session left in the pyramid
        // scratch describes a capture this one holds (ADR 0047).
        state.signal_caches.clear();
        return RestoredCapture {
            count: 0,
            first_index: 0,
            first_index_ts_ns: None,
            session_start_seconds: None,
            pyramids_rebuilding: false,
        };
    };
    let (count, first_index_usize, first_index_ts_ns) = state.trace_store.len_and_low_water();
    // Adopt the signal pyramids the prior session persisted, if they
    // provably describe this capture decoded against this DBC set (ADR
    // 0047). This is where a relaunch stops re-paying a full rebuild: the
    // frames come back in about a second, and without this the first plot
    // over them re-decodes the whole history. A rejected set is wiped here
    // and rebuilt on demand, exactly as before.
    let pyramids_at = std::time::Instant::now();
    let pyramids = crate::app_state::pyramid_validity(&state).map_or_else(Default::default, |v| {
        // Lock order: the DBC set before the signal caches, as every
        // other path that needs both takes them (`persist_pyramids`,
        // `sample_signals`). The set is what each persisted signal's
        // encoding fingerprint is judged against.
        let dbcs = state.databases();
        state
            .signal_caches
            .restore(&v, &state.decode_model(&dbcs), count)
    });
    let pyramids_ms = pyramids_at.elapsed().as_secs_f64() * 1000.0;
    // A rejection used to be invisible from here: the capture came back
    // fast and then every plot over it spent minutes re-decoding, with
    // nothing said. The frontend announces this and offers to drop the
    // capture instead of paying for it.
    let pyramids_rebuilding = pyramids_rebuilding_now(&state).rebuilding;
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
    // The pyramid half carries counts *and* bytes: one reopened pyramid
    // over a long capture and one over a short one are the same count and
    // wildly different savings, and "are we saving time or wasting disk"
    // (ADR 0047) is a question about the samples, not the signals.
    // `revived` is how many of the reopened came back out of the
    // retention pool — the only number that says whether keeping them
    // paid off.
    let mb = |bytes: u64| bytes / (1024 * 1024);
    sys_debug!(
        &app,
        "project",
        "restore: {breakdown} notes {notes_ms:.0} \
         pyramids {pyramids_ms:.0} ({} reopened, {} revived, {} rebuilt; \
         reused {} MB, re-decoding {} MB) command {total_ms:.0}",
        pyramids.reopened,
        pyramids.revived,
        pyramids.rebuilt,
        mb(pyramids.reused_bytes),
        mb(pyramids.rebuilt_bytes),
    );
    if pyramids_rebuilding {
        sys_info!(
            &app,
            "project",
            "{} persisted signal cache(s) did not match this capture — \
             rebuilding them by re-decoding its frames",
            pyramids.rebuilt
        );
    }
    // Whatever the restore adopted (or rejected) is the file-backed set
    // this session now has.
    let _ = app.emit(FILE_SIGNALS_CHANGED, ());
    #[allow(clippy::cast_precision_loss)]
    RestoredCapture {
        count: u64::try_from(count).unwrap_or(u64::MAX),
        first_index,
        first_index_ts_ns,
        session_start_seconds: state
            .trace_store
            .session_started()
            .then_some(session_start_ns as f64 / 1_000_000_000.0),
        pyramids_rebuilding,
    }
}
