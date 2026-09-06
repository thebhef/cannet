//! Project loggers: a project element that writes the live capture to
//! file while it is enabled and something is connected.
//!
//! A logger is the standing counterpart to an export. Export names one
//! file and writes a slice of what has already been captured; a logger
//! names a *folder* and a *file*, both templated
//! ([`crate::export_template`]), and keeps writing frames to disk as
//! they arrive. It writes BLF.
//!
//! **Logging runs exactly while `enabled && connected`.** The enabled
//! flag lives in the project — unlike the RBS Run flag, which is session
//! state (ADR 0028) because arming it puts frames on a bus. Logging
//! transmits nothing; it writes locally, so a project left with a logger
//! enabled resumes logging the next time it connects. That is
//! [`reconcile`]'s job: it recomputes "should this logger be writing"
//! for every logger and starts or stops the difference, and every
//! connection-state change runs it.
//!
//! **Splitting.** A logger has a maximum file size. When the file on
//! disk reaches it the writer closes that file and opens the next, with
//! `-002`, `-003`… appended to the last path segment before its
//! extension. A file already sitting where the run would start takes the
//! next suffix the same way, so a second run on the same template never
//! overwrites the first.
//!
//! **How frames are found.** The logger does not sit on the ingest path.
//! It follows the capture model's own index: a writer thread remembers
//! how far it has written and asks the trace store for whatever has been
//! appended since. Nothing is added to the per-frame cost of a session
//! that has no logger running, and every frame source is covered without
//! naming any of them.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use cannet_blf::BlfCaptureWriter;

use crate::app_state::AppState;
use crate::connection_state::{BusConnState, ConnectionStates};
use crate::export_template::{resolve, resolve_folder, TemplateContext};
use crate::trace_store::RawTraceFrame;
use crate::{sys_error, sys_info, sys_warn};

/// How often a running logger asks the capture model what has arrived.
/// Frames are written in whatever batch has accumulated, so the interval
/// trades write-batch size against how far behind the live edge the file
/// can be — a quarter second is well inside "the file is current" and
/// far outside the store's per-append lock.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Tauri event fired when any logger starts writing, stops, splits, or
/// fails. The payload is every logger's status, bounded by the project's
/// logger count. A running logger's *size* is not announced through it —
/// that is polled through [`get_logger_statuses`], so a growing file
/// costs no events.
pub const LOGGERS_CHANGED_EVENT: &str = "loggers-changed";

/// One logger, as the project holds it. Pushed wholesale by the
/// frontend through [`set_loggers`] whenever the element set changes.
///
/// There is no format field: live logging is BLF. The element carries
/// the format the panel renders so the project records it, but the host
/// has one writer and no branch to make on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggerConfig {
    /// The project element's id — the key everything else is keyed by.
    pub id: String,
    /// The logger's display name; what `{logger}` resolves to (slugified).
    pub name: String,
    /// Project-persisted. `true` means "write whenever connected".
    pub enabled: bool,
    /// Folder template. A relative result is rooted at the project
    /// directory ([`resolve_folder`]).
    pub folder: String,
    /// File template, relative to the folder. May carry path separators
    /// — either kind, resolved to this OS's own — so a template can put
    /// each run in its own subdirectory.
    pub file: String,
    /// Split threshold in megabytes.
    pub max_file_size_mb: u64,
}

/// What a logger is doing, for the panel that owns it and the file view
/// that lists its folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggerStatus {
    pub id: String,
    /// Whether a file is open right now. The panel locks the controls
    /// that cannot change mid-file on this.
    pub writing: bool,
    /// The file currently being written, absolute.
    pub path: Option<String>,
    /// Its size on disk, bytes.
    pub bytes: u64,
    /// Frames written to the current run, across every split.
    pub frame_count: u64,
    /// Why the last start failed, if it did. Cleared by a start that
    /// works.
    pub error: Option<String>,
}

/// A logger's live state, shared between its writer thread and whoever
/// asks for a status.
#[derive(Debug, Default)]
struct RunState {
    path: Option<String>,
    bytes: u64,
    frame_count: u64,
    /// Set by the writer thread on its way out. A run that ended on a
    /// write error is no longer writing even though its entry is still
    /// in the map — nothing has come along to reconcile it away yet.
    finished: bool,
    /// The write error that ended the run early, if one did.
    error: Option<String>,
}

/// A stop flag a sleeping thread is woken by rather than polls out.
///
/// The writer thread spends its life waiting for the next batch of
/// frames, and stopping it has to be prompt: the caller waits for the
/// thread so the file is *finished* — header written, containers
/// flushed — before it moves on, and a wait that first slept out a poll
/// interval would put that delay on the disconnect path.
#[derive(Default)]
pub(crate) struct StopSignal {
    stopped: Mutex<bool>,
    woken: std::sync::Condvar,
}

impl StopSignal {
    /// Ask the thread to finish, and wake it now.
    pub(crate) fn stop(&self) {
        *self
            .stopped
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        self.woken.notify_all();
    }

    pub(crate) fn stopped(&self) -> bool {
        *self
            .stopped
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Sleep until `timeout` elapses or [`Self::stop`] is called,
    /// whichever comes first. Returns immediately if already stopped.
    pub(crate) fn wait_timeout(&self, timeout: Duration) {
        let guard = self
            .stopped
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *guard {
            return;
        }
        let _ = self
            .woken
            .wait_timeout_while(guard, timeout, |stopped| !*stopped);
    }
}

/// One running logger: the signal that stops its thread, the state the
/// thread publishes, and the handle stopping waits on.
struct RunningLogger {
    /// This logger's own stop signal. Deliberately not a share of
    /// `AppState::export_cancel` — an export and a logger run at the
    /// same time, and cancelling one must not stop the other.
    stop: Arc<StopSignal>,
    state: Arc<Mutex<RunState>>,
    /// The writer thread. Joined when the logger stops, so the file is
    /// finished — not merely abandoned mid-container — before whatever
    /// stopped it carries on. Without that a process exiting on the
    /// heels of a disconnect leaves an unfinalized capture behind.
    handle: std::thread::JoinHandle<()>,
}

/// The host's view of the project's loggers: the pushed configuration
/// and whatever is running against it.
#[derive(Default)]
pub(crate) struct LoggerRuntime {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    configs: Vec<LoggerConfig>,
    /// The project's display name, for `{project}`.
    project: String,
    /// The project's ordered bus ids — position in this list is the BLF
    /// channel a frame on that bus is written as, exactly as an export
    /// writes it.
    buses: Vec<String>,
    running: std::collections::HashMap<String, RunningLogger>,
    /// Last start failure per logger id, until a start succeeds.
    errors: std::collections::HashMap<String, String>,
}

impl LoggerRuntime {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Replace the pushed configuration. Returns nothing — the caller
    /// reconciles.
    fn set(&self, configs: Vec<LoggerConfig>, project: String, buses: Vec<String>) {
        let mut inner = self.lock();
        inner.configs = configs;
        inner.project = project;
        inner.buses = buses;
    }

    /// Every logger's status, in configuration order.
    pub(crate) fn statuses(&self) -> Vec<LoggerStatus> {
        let inner = self.lock();
        inner
            .configs
            .iter()
            .map(|cfg| {
                let run = inner.running.get(&cfg.id);
                let state = run.map(|r| {
                    r.state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                });
                let finished = state.as_ref().is_some_and(|s| s.finished);
                LoggerStatus {
                    id: cfg.id.clone(),
                    writing: run.is_some() && !finished,
                    path: state.as_ref().and_then(|s| s.path.clone()),
                    bytes: state.as_ref().map_or(0, |s| s.bytes),
                    frame_count: state.as_ref().map_or(0, |s| s.frame_count),
                    // A start that never got off the ground, or a write
                    // that ended one that had.
                    error: inner
                        .errors
                        .get(&cfg.id)
                        .cloned()
                        .or_else(|| state.as_ref().and_then(|s| s.error.clone())),
                }
            })
            .collect()
    }
}

/// Whether any of the project's buses is connected. `Connecting` is not
/// connected — frames cannot flow yet, and a logger that opened a file
/// on it would leave an empty one behind if the attempt failed.
fn anything_connected(states: &ConnectionStates) -> bool {
    states
        .snapshot()
        .values()
        .any(|s| matches!(s, BusConnState::Connected { .. }))
}

/// The `n`-th file of a run. Part 1 is `base` itself; every later part
/// takes `-002`, `-003`… before the extension of the **last** path
/// segment, so a template whose file part is a subpath keeps its
/// directories intact.
pub(crate) fn split_path(base: &Path, part: u32) -> PathBuf {
    if part <= 1 {
        return base.to_path_buf();
    }
    let stem = base.file_stem().unwrap_or_default().to_string_lossy();
    let suffixed = match base.extension() {
        Some(ext) => format!("{stem}-{part:03}.{}", ext.to_string_lossy()),
        None => format!("{stem}-{part:03}"),
    };
    base.with_file_name(suffixed)
}

/// The first part number at or after `from` whose file does not exist.
///
/// Used both when a run starts — a file already sitting at the resolved
/// name takes the next suffix rather than being overwritten — and at
/// every split, so the rule is stated once and a run that outlives an
/// earlier one never eats it.
pub(crate) fn first_free_part(base: &Path, from: u32, exists: &dyn Fn(&Path) -> bool) -> u32 {
    let mut part = from.max(1);
    while exists(&split_path(base, part)) {
        part += 1;
    }
    part
}

/// The split-aware BLF sink one logging run writes through.
///
/// Holds no `AppHandle`: the tests construct one, and an `AppHandle` in
/// a struct a test binary instantiates links Tauri's window graph into
/// that binary, which then fails to load on Windows. Anything the run
/// wants to say goes through the caller.
pub(crate) struct LogWriter {
    base: PathBuf,
    max_bytes: u64,
    part: u32,
    writer: Option<BlfCaptureWriter>,
    path: PathBuf,
    /// Ordered project bus ids — a frame's bus resolves to its position
    /// here, which is the BLF channel it is written as.
    buses: Vec<String>,
    frame_count: u64,
    /// Every file this run has opened, in order. The run's product.
    parts: Vec<PathBuf>,
}

impl LogWriter {
    /// Open the first file of a run at `base`, creating the directories
    /// it needs. `max_bytes` is the size at which the writer rolls to
    /// the next file.
    pub(crate) fn open(base: PathBuf, max_bytes: u64, buses: Vec<String>) -> Result<Self, String> {
        let mut w = Self {
            base,
            max_bytes: max_bytes.max(1),
            part: 1,
            writer: None,
            path: PathBuf::new(),
            buses,
            frame_count: 0,
            parts: Vec::new(),
        };
        w.open_part(1)?;
        Ok(w)
    }

    /// Open part number `from` or the first free one after it.
    fn open_part(&mut self, from: u32) -> Result<(), String> {
        let part = first_free_part(&self.base, from, &|p| p.exists());
        let path = split_path(&self.base, part);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
        }
        let writer = BlfCaptureWriter::create(&path)
            .map_err(|e| format!("failed to open {} for writing: {e}", path.display()))?;
        self.part = part;
        self.writer = Some(writer);
        self.parts.push(path.clone());
        self.path = path;
        Ok(())
    }

    /// The file being written right now.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Its size on disk.
    pub(crate) fn bytes(&self) -> u64 {
        self.writer
            .as_ref()
            .map_or(0, BlfCaptureWriter::bytes_on_disk)
    }

    /// Frames written across every part of this run.
    pub(crate) fn frame_count(&self) -> u64 {
        self.frame_count
    }

    /// Every file this run has opened, oldest first.
    #[cfg(test)]
    pub(crate) fn parts(&self) -> &[PathBuf] {
        &self.parts
    }

    /// Append `frames`, rolling to the next file whenever the current
    /// one reaches the size cap. A frame the writer cannot represent is
    /// skipped with its reason returned, rather than ending the run: a
    /// logger's job is to keep writing.
    pub(crate) fn write(&mut self, frames: &[RawTraceFrame]) -> Result<Vec<String>, String> {
        let mut skipped = Vec::new();
        for frame in frames {
            let core = match crate::capture::raw_to_core_frame(frame, &self.buses) {
                Ok(core) => core,
                Err(e) => {
                    skipped.push(e);
                    continue;
                }
            };
            let writer = self
                .writer
                .as_mut()
                .ok_or_else(|| "the logger's file is already closed".to_string())?;
            writer
                .append(&core)
                .map_err(|e| format!("failed to write to {}: {e}", self.path.display()))?;
            self.frame_count += 1;
            if writer.bytes_on_disk() >= self.max_bytes {
                self.roll()?;
            }
        }
        Ok(skipped)
    }

    /// Close the current file and open the next part.
    fn roll(&mut self) -> Result<(), String> {
        self.close_current()?;
        self.open_part(self.part + 1)
    }

    fn close_current(&mut self) -> Result<(), String> {
        let Some(writer) = self.writer.take() else {
            return Ok(());
        };
        writer
            .finish()
            .map(|_| ())
            .map_err(|e| format!("failed to finalise {}: {e}", self.path.display()))
    }

    /// Finalise the file this run is on. The files it wrote stay where
    /// they are — a logger's output is the point, so nothing is removed
    /// the way a cancelled export's partial file is.
    pub(crate) fn finish(mut self) -> Result<(), String> {
        self.close_current()
    }
}

/// What one reconcile decides: which loggers to start and which to
/// stop. Split out from [`reconcile`] so the rule — a logger writes
/// exactly while it is enabled and something is connected — is testable
/// without an app, a filesystem, or a connection.
///
/// A logger no longer in `configs` stops too: removing its element ends
/// its run, whatever the flag said.
fn plan(
    configs: &[LoggerConfig],
    running: &[&str],
    connected: bool,
) -> (Vec<LoggerConfig>, Vec<String>) {
    let mut to_start = Vec::new();
    let mut to_stop = Vec::new();
    for cfg in configs {
        let want = cfg.enabled && connected;
        match (want, running.contains(&cfg.id.as_str())) {
            (true, false) => to_start.push(cfg.clone()),
            (false, true) => to_stop.push(cfg.id.clone()),
            _ => {}
        }
    }
    for id in running {
        if !configs.iter().any(|c| c.id == *id) {
            to_stop.push((*id).to_string());
        }
    }
    (to_start, to_stop)
}

/// Where a writer's cursor into the capture model belongs after a look
/// at the store, and whether frames were lost getting there.
///
/// Two things move the index space under a running logger: a session
/// reset (or a different capture opened), which rewinds `len` below the
/// cursor, and eviction from a windowed store, which advances
/// `first_index` past it. The first is followed silently — there is
/// nothing to lose. The second is a gap in the file, and is reported.
fn settle_cursor(cursor: usize, len: usize, first_index: usize) -> (usize, bool) {
    let cursor = cursor.min(len);
    if first_index > cursor {
        (first_index, true)
    } else {
        (cursor, false)
    }
}

/// Reconcile every logger against the world: start the ones that should
/// be writing and are not, stop the ones that are and should not be.
/// Idempotent, so every caller is free to run it whenever anything it
/// depends on might have moved — the pushed configuration, or the
/// connection states.
pub(crate) fn reconcile(app: &AppHandle) {
    let Some(runtime) = app.try_state::<LoggerRuntime>() else {
        return;
    };
    let connected = app
        .try_state::<ConnectionStates>()
        .is_some_and(|s| anything_connected(&s));
    // Decide under the lock, act outside it: starting a run touches the
    // filesystem and the system log, neither of which belongs inside a
    // mutex every status read also takes.
    let (to_start, to_stop) = {
        let inner = runtime.lock();
        let running: Vec<&str> = inner.running.keys().map(String::as_str).collect();
        plan(&inner.configs, &running, connected)
    };
    let mut changed = false;
    for id in to_stop {
        changed |= stop_one(app, &runtime, &id);
    }
    for cfg in to_start {
        changed |= start_one(app, &runtime, &cfg);
    }
    if changed {
        let _ = app.emit(LOGGERS_CHANGED_EVENT, runtime.statuses());
    }
}

/// Stop every running logger, whatever the configuration says. What
/// leaving a project has to do: the files belong to the project that is
/// closing, and the next one starts with its own.
pub(crate) fn stop_all(app: &AppHandle) {
    let Some(runtime) = app.try_state::<LoggerRuntime>() else {
        return;
    };
    let ids: Vec<String> = runtime.lock().running.keys().cloned().collect();
    let mut changed = false;
    for id in ids {
        changed |= stop_one(app, &runtime, &id);
    }
    if changed {
        let _ = app.emit(LOGGERS_CHANGED_EVENT, runtime.statuses());
    }
}

/// Stop one logger's thread and **wait for it**, so the file it was
/// writing is finished rather than abandoned. The wait is short by
/// construction: the signal wakes the thread out of its sleep, and all
/// that is left is the last container plus the header.
fn stop_one(app: &AppHandle, runtime: &LoggerRuntime, id: &str) -> bool {
    let Some(running) = runtime.lock().running.remove(id) else {
        return false;
    };
    running.stop.stop();
    // A panicked writer thread has nothing left to finish; the join
    // result is not news the caller can act on either way.
    let _ = running.handle.join();
    sys_info!(app, "logger", "logging stopped for {id}");
    true
}

/// Resolve one logger's templates and spawn its writer thread.
fn start_one(app: &AppHandle, runtime: &LoggerRuntime, cfg: &LoggerConfig) -> bool {
    let base = match resolve_run_path(app, runtime, cfg) {
        Ok(base) => base,
        Err(e) => {
            runtime.lock().errors.insert(cfg.id.clone(), e.clone());
            sys_error!(app, "logger", "{name}: {e}", name = cfg.name);
            return true;
        }
    };
    let max_bytes = cfg.max_file_size_mb.max(1).saturating_mul(1024 * 1024);
    let buses = runtime.lock().buses.clone();
    let writer = match LogWriter::open(base, max_bytes, buses) {
        Ok(writer) => writer,
        Err(e) => {
            runtime.lock().errors.insert(cfg.id.clone(), e.clone());
            sys_error!(app, "logger", "{name}: {e}", name = cfg.name);
            return true;
        }
    };
    let stop = Arc::new(StopSignal::default());
    let state = Arc::new(Mutex::new(RunState {
        path: Some(writer.path().display().to_string()),
        ..RunState::default()
    }));
    let path = writer.path().display().to_string();
    let app_for_thread = app.clone();
    let name = cfg.name.clone();
    let thread_stop = Arc::clone(&stop);
    let thread_state = Arc::clone(&state);
    // Spawned before the entry is recorded, because the entry carries
    // the handle that stopping joins on.
    let handle = match std::thread::Builder::new()
        .name("cannet-logger".into())
        .spawn(move || run_logger(&app_for_thread, &name, writer, &thread_stop, &thread_state))
    {
        Ok(handle) => handle,
        Err(e) => {
            let msg = format!("failed to spawn the logger thread: {e}");
            runtime.lock().errors.insert(cfg.id.clone(), msg.clone());
            sys_error!(app, "logger", "{name}: {msg}", name = cfg.name);
            return true;
        }
    };
    {
        let mut inner = runtime.lock();
        inner.errors.remove(&cfg.id);
        inner.running.insert(
            cfg.id.clone(),
            RunningLogger {
                stop,
                state,
                handle,
            },
        );
    }
    sys_info!(app, "logger", "{name}: logging to {path}", name = cfg.name);
    true
}

/// The absolute path a run's first file goes to: the folder template
/// resolved (and rooted at the project directory when it is relative),
/// joined with the file template, with the format's extension.
///
/// Both templates resolve against one `now` — the instant logging
/// started — so `{now}` names the run rather than the moment each field
/// happened to be read.
fn resolve_run_path(
    app: &AppHandle,
    runtime: &LoggerRuntime,
    cfg: &LoggerConfig,
) -> Result<PathBuf, String> {
    let active = app.state::<crate::project_dir::ActiveProjectDir>().get();
    let project_dir = (!active.is_auto_located()).then(|| active.root().to_path_buf());
    // Nanoseconds since the epoch exceed `f64`'s exact integer range, so
    // the seconds this yields are precise to a few hundred nanoseconds.
    // That is the same conversion the export dialog's preview makes, and
    // it feeds a `{start}` rendered to whole seconds.
    #[allow(clippy::cast_precision_loss)]
    let start_seconds = app.try_state::<AppState>().and_then(|state| {
        crate::capture::capture_extent_now(&state)
            .session_start_ns
            .map(|ns| ns as f64 / 1e9)
    });
    let project = runtime.lock().project.clone();
    let ctx = TemplateContext {
        project: &project,
        logger: Some(&cfg.name),
        start_seconds,
        project_dir: project_dir.as_deref(),
    };
    let now = Local::now();
    let folder = resolve_folder(&cfg.folder, &ctx, now)?;
    let file = resolve(cfg.file.trim(), &ctx, now)?;
    if file.text.trim().is_empty() {
        return Err(
            "the File template resolved to nothing — a logger needs a file name".to_string(),
        );
    }
    // Both halves already read in this OS's separators — template
    // resolution renders them — so the join is a plain one.
    let mut path = PathBuf::from(folder.text).join(file.text);
    path.set_extension("blf");
    Ok(path)
}

/// The writer thread: follow the capture model's index, writing whatever
/// has been appended since the last look, until the stop flag is set.
fn run_logger(
    app: &AppHandle,
    name: &str,
    mut writer: LogWriter,
    stop: &StopSignal,
    state: &Mutex<RunState>,
) {
    let Some(app_state) = app.try_state::<AppState>() else {
        return;
    };
    // Start at the live edge: a logger logs what arrives while it runs,
    // not the capture that was already there when it was switched on.
    let mut cursor = app_state.trace_store.len();
    let mut warned_eviction = false;
    loop {
        // Read once, before the pass: whatever arrived up to here is
        // written on the way out, so a stop never drops a frame the
        // store already had.
        let stopping = stop.stopped();
        let snapshot = app_state.trace_store.status_snapshot();
        let (settled, evicted) = settle_cursor(cursor, snapshot.len, snapshot.first_index);
        cursor = settled;
        if evicted && !warned_eviction {
            sys_warn!(
                app,
                "logger",
                "{name}: the capture dropped frames before the logger could write them",
            );
            warned_eviction = true;
        }
        if snapshot.len > cursor {
            let frames = app_state.trace_store.slice(cursor, snapshot.len);
            cursor = snapshot.len;
            match writer.write(&frames) {
                Ok(skipped) => {
                    for reason in skipped.iter().take(1) {
                        sys_warn!(app, "logger", "{name}: skipped a frame — {reason}");
                    }
                }
                Err(e) => {
                    sys_error!(app, "logger", "{name}: {e}");
                    if let Ok(mut s) = state.lock() {
                        s.error = Some(e);
                    }
                    break;
                }
            }
            if let Ok(mut s) = state.lock() {
                s.path = Some(writer.path().display().to_string());
                s.bytes = writer.bytes();
                s.frame_count = writer.frame_count();
            }
        }
        if stopping {
            break;
        }
        stop.wait_timeout(POLL_INTERVAL);
    }
    let path = writer.path().display().to_string();
    let frames = writer.frame_count();
    let finish = writer.finish();
    if let Ok(mut s) = state.lock() {
        s.finished = true;
        if let Err(e) = &finish {
            s.error = Some(e.clone());
        }
    }
    match finish {
        Ok(()) => sys_info!(app, "logger", "{name}: finished {path} ({frames} frame(s))"),
        Err(e) => sys_error!(app, "logger", "{name}: {e}"),
    }
}

/// Tauri command — push the project's loggers at the host. Called
/// whenever the logger element set changes (including project open), and
/// reconciles as a matter of course, so enabling a logger while
/// connected starts it at once.
///
/// `project` is the project's display name (what `{project}` resolves
/// to) and `buses` its ordered bus-id list — position in that list is
/// the BLF channel a frame on that bus is written as, the same mapping
/// Save Capture uses.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_loggers(
    app: AppHandle,
    loggers: Vec<LoggerConfig>,
    project: String,
    buses: Vec<String>,
) {
    app.state::<LoggerRuntime>().set(loggers, project, buses);
    reconcile(&app);
}

/// Tauri command — every logger's status. The panel reads it to lock
/// the controls a running logger cannot change; a file view polls it for
/// the size of the file being written.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_logger_statuses(runtime: State<'_, LoggerRuntime>) -> Vec<LoggerStatus> {
    runtime.statuses()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(dir: &Path) -> PathBuf {
        dir.join("run.blf")
    }

    #[test]
    fn the_first_part_is_the_base_name_itself() {
        assert_eq!(
            split_path(Path::new("/logs/run.blf"), 1),
            Path::new("/logs/run.blf")
        );
        assert_eq!(
            split_path(Path::new("/logs/run.blf"), 0),
            Path::new("/logs/run.blf")
        );
    }

    #[test]
    fn later_parts_take_a_three_digit_suffix_before_the_extension() {
        assert_eq!(
            split_path(Path::new("/logs/run.blf"), 2),
            Path::new("/logs/run-002.blf")
        );
        assert_eq!(
            split_path(Path::new("/logs/run.blf"), 10),
            Path::new("/logs/run-010.blf")
        );
        assert_eq!(
            split_path(Path::new("/logs/run.blf"), 1000),
            Path::new("/logs/run-1000.blf")
        );
    }

    #[test]
    fn the_suffix_lands_on_the_last_path_segment_only() {
        // The File template may carry subdirectories; a split must stay
        // inside the directory the run made, not name a sibling of it.
        assert_eq!(
            split_path(Path::new("/logs/20260906T101500-0600/run.blf"), 3),
            Path::new("/logs/20260906T101500-0600/run-003.blf")
        );
    }

    #[test]
    fn first_free_part_skips_what_is_already_there() {
        let taken = |p: &Path| {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            name == "run.blf" || name == "run-002.blf"
        };
        assert_eq!(first_free_part(Path::new("/logs/run.blf"), 1, &taken), 3);
    }

    #[test]
    fn first_free_part_leaves_a_clear_name_alone() {
        assert_eq!(
            first_free_part(Path::new("/logs/run.blf"), 1, &|_| false),
            1
        );
    }

    /// Ruling: a start that collides with an existing file takes the
    /// next split suffix rather than overwriting it.
    #[test]
    fn a_start_collision_takes_the_next_suffix() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("run.blf"), b"previous run").unwrap();
        let writer = LogWriter::open(base(dir.path()), 1024 * 1024, vec![]).unwrap();
        assert_eq!(writer.path(), dir.path().join("run-002.blf"));
        writer.finish().unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("run.blf")).unwrap(),
            b"previous run",
            "the earlier run's file is untouched",
        );
    }

    fn frame(ts_ns: u64, id: u32) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: ts_ns,
            channel: 0,
            id,
            extended: false,
            direction: cannet_core::Direction::Rx,
            payload: cannet_core::CanFramePayload::Classic(vec![0xAB; 8]),
            bus_id: Some("b".into()),
        }
    }

    /// The split rule, exercised with a cap of a few kilobytes rather
    /// than the 500 MB default — the behaviour is the same and the test
    /// stays fast.
    #[test]
    fn reaching_the_size_cap_closes_the_file_and_opens_the_next() {
        let dir = tempfile::tempdir().unwrap();
        // Below one flushed container, so the first flush trips the cap.
        let mut writer = LogWriter::open(base(dir.path()), 4 * 1024, vec!["b".into()]).unwrap();
        let frames: Vec<RawTraceFrame> = (0..20_000u32)
            .map(|i| frame(1_700_000_000_000_000_000 + u64::from(i) * 1_000_000, 0x100))
            .collect();
        writer.write(&frames).unwrap();
        assert!(
            writer.parts().len() > 1,
            "the cap must have split the run: {:?}",
            writer.parts()
        );
        assert_eq!(writer.parts()[0], dir.path().join("run.blf"));
        assert_eq!(writer.parts()[1], dir.path().join("run-002.blf"));
        assert_eq!(writer.frame_count(), 20_000);
        writer.finish().unwrap();
        for part in [dir.path().join("run.blf"), dir.path().join("run-002.blf")] {
            assert!(part.is_file(), "{} was not written", part.display());
        }
    }

    /// Everything the run wrote is readable BLF once it finishes — the
    /// split is a file boundary, not a lost frame.
    #[test]
    fn every_frame_written_survives_the_split() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = LogWriter::open(base(dir.path()), 4 * 1024, vec!["b".into()]).unwrap();
        let frames: Vec<RawTraceFrame> = (0..8_000u32)
            .map(|i| frame(1_700_000_000_000_000_000 + u64::from(i) * 1_000_000, 0x100))
            .collect();
        writer.write(&frames).unwrap();
        let parts = writer.parts().to_vec();
        writer.finish().unwrap();
        let mut total = 0usize;
        for part in &parts {
            let mut source = cannet_blf::BlfCanFrameSource::open(part).unwrap();
            while cannet_core::CanFrameSource::next_frame(&mut source)
                .unwrap()
                .is_some()
            {
                total += 1;
            }
        }
        assert_eq!(total, 8_000, "every frame reached one of {parts:?}");
    }

    /// The File template's subdirectories are created, not assumed.
    #[test]
    fn a_file_template_subpath_creates_its_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("20260906T101500").join("run.blf");
        let writer = LogWriter::open(nested.clone(), 1024 * 1024, vec![]).unwrap();
        writer.finish().unwrap();
        assert!(nested.is_file());
    }

    fn cfg(id: &str, enabled: bool) -> LoggerConfig {
        LoggerConfig {
            id: id.into(),
            name: id.into(),
            enabled,
            folder: "logs/{logger}".into(),
            file: "{start}".into(),
            max_file_size_mb: 500,
        }
    }

    /// The rule, stated four ways: enabling while connected starts at
    /// once, disabling stops, connecting starts what was waiting, and
    /// disconnecting stops what was writing.
    #[test]
    fn a_logger_runs_exactly_while_enabled_and_connected() {
        let on = [cfg("a", true)];
        let off = [cfg("a", false)];

        let (start, stop) = plan(&on, &[], true);
        assert_eq!(start.len(), 1, "enabled and connected, not yet running");
        assert!(stop.is_empty());

        let (start, stop) = plan(&on, &[], false);
        assert!(start.is_empty(), "enabled but nothing is connected");
        assert!(stop.is_empty());

        let (start, stop) = plan(&on, &["a"], true);
        assert!(
            start.is_empty(),
            "already running — reconcile is idempotent"
        );
        assert!(stop.is_empty());

        let (start, stop) = plan(&on, &["a"], false);
        assert!(start.is_empty());
        assert_eq!(stop, vec!["a".to_string()], "disconnect stops the run");

        let (start, stop) = plan(&off, &["a"], true);
        assert!(start.is_empty());
        assert_eq!(stop, vec!["a".to_string()], "disabling stops the run");
    }

    /// Deleting a logger's element ends its run, whatever its flag said.
    #[test]
    fn a_logger_that_left_the_project_stops() {
        let (start, stop) = plan(&[], &["gone"], true);
        assert!(start.is_empty());
        assert_eq!(stop, vec!["gone".to_string()]);
    }

    /// Loggers are independent: one enabled, one not, and only the
    /// enabled one starts.
    #[test]
    fn each_logger_is_decided_on_its_own() {
        let (start, stop) = plan(&[cfg("a", true), cfg("b", false)], &["b"], true);
        assert_eq!(start.len(), 1);
        assert_eq!(start[0].id, "a");
        assert_eq!(stop, vec!["b".to_string()]);
    }

    /// The header a BLF carries at `file_size` — zero while the file is
    /// unfinalized, which is what the reader's recovery path keys on.
    fn header_file_size(path: &Path) -> u64 {
        let bytes = std::fs::read(path).unwrap();
        u64::from_le_bytes(bytes[16..24].try_into().unwrap())
    }

    /// Regression: a run that stops leaves a **finalized** file.
    ///
    /// Observed on the first live run — the harness exited while the
    /// writer thread was still asleep between polls, so `finish` never
    /// ran and the capture on disk carried the unfinalized header
    /// (`file_size = 0`, `object_count = 0`). Readable only through the
    /// reader's recovery path, which is not what a logger should be
    /// producing. Stopping now waits for the writer, and this pins the
    /// difference between a file that has been finished and one that has
    /// merely been abandoned.
    #[test]
    fn a_finished_run_leaves_a_finalized_file_and_an_abandoned_one_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = LogWriter::open(base(dir.path()), 1024 * 1024, vec!["b".into()]).unwrap();
        writer
            .write(&[frame(1_700_000_000_000_000_000, 0x100)])
            .unwrap();
        let path = writer.path().to_path_buf();
        writer.finish().unwrap();
        assert!(
            header_file_size(&path) > 0,
            "a finished file states its own size",
        );

        let abandoned = dir.path().join("abandoned.blf");
        let mut writer = LogWriter::open(abandoned.clone(), 1024 * 1024, vec!["b".into()]).unwrap();
        writer
            .write(&[frame(1_700_000_000_000_000_000, 0x100)])
            .unwrap();
        std::mem::forget(writer);
        assert_eq!(
            header_file_size(&abandoned),
            0,
            "…which a file nobody finished does not",
        );
    }

    /// A waiter is released the moment the signal is set, not at the end
    /// of its timeout — what makes stopping prompt enough to wait for.
    #[test]
    fn a_stop_signal_wakes_its_waiter_at_once() {
        let stop = Arc::new(StopSignal::default());
        assert!(!stop.stopped());
        let sleeper = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let start = std::time::Instant::now();
            sleeper.wait_timeout(Duration::from_secs(30));
            start.elapsed()
        });
        // Give the waiter time to reach the wait before releasing it.
        std::thread::sleep(Duration::from_millis(50));
        stop.stop();
        let waited = handle.join().unwrap();
        assert!(stop.stopped());
        assert!(
            waited < Duration::from_secs(5),
            "the sleeper slept out its timeout instead of being woken: {waited:?}",
        );
    }

    #[test]
    fn a_stop_signal_set_before_the_wait_never_waits() {
        let stop = StopSignal::default();
        stop.stop();
        let start = std::time::Instant::now();
        stop.wait_timeout(Duration::from_secs(30));
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn the_cursor_follows_new_frames_and_stands_still_otherwise() {
        assert_eq!(settle_cursor(10, 40, 0), (10, false));
        assert_eq!(settle_cursor(40, 40, 0), (40, false));
    }

    #[test]
    fn a_session_reset_rewinds_the_cursor_without_reporting_a_gap() {
        // The index space restarted under the writer; there is nothing
        // lost to report, only a smaller store to follow.
        assert_eq!(settle_cursor(5_000, 3, 0), (3, false));
    }

    #[test]
    fn eviction_past_the_cursor_is_a_gap_and_says_so() {
        assert_eq!(settle_cursor(10, 5_000, 400), (400, true));
    }

    #[test]
    fn a_logger_writes_only_while_enabled_and_connected() {
        use crate::connection_state::ConnectionStates;
        let states = ConnectionStates::default();
        assert!(!anything_connected(&states));
        states.set_many([("b".to_string(), BusConnState::Connecting)]);
        assert!(
            !anything_connected(&states),
            "connecting is not connected — frames cannot flow yet",
        );
        states.set_many([("b".to_string(), BusConnState::Connected { applied: None })]);
        assert!(anything_connected(&states));
        states.set_many([("b".to_string(), BusConnState::error("gone"))]);
        assert!(!anything_connected(&states));
    }
}
