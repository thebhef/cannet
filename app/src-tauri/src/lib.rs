//! Cannet Tauri host. Wires the Phase-1 BLF / DBC stack to the React
//! frontend.
//!
//! The single command `open_log(blf_path, dbc_path?)` spawns a worker
//! thread that streams `frame-batch` events at the frontend until the
//! file is exhausted; the frontend renders them in a virtualized trace
//! view. A `log-finished` event closes out the run.

mod wire;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use blf_source::BlfFrameSource;
use can_core::FrameSource;
use cannet_dbc::{Database, DecodedSignal};

use wire::{
    DecodedRecord, FrameBatch, FrameRecord, LogFinished, OpenLogResult, SignalRecord,
};

/// Frames per emitted batch. Smaller batches cut latency; larger ones cut
/// IPC overhead. 256 is roughly one screenful of trace rows and keeps
/// IPC chatter modest on multi-MHz BLF replays.
const BATCH_SIZE: usize = 256;

/// Boot the Tauri runtime.
///
/// # Panics
/// Panics if the platform runtime fails to start (no display, missing
/// `WebView`, etc.) — there's no recovery path, so we surface the error
/// loudly rather than silently exiting.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_log])
        .setup(|app| {
            // Make sure the main window has the id our capabilities expect.
            // Tauri assigns "main" by default for the first window in the
            // config; we rely on that here.
            debug_assert!(app.get_webview_window("main").is_some());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running cannet");
}

// Tauri's command macro deserializes arguments into owned values, so the
// `needless_pass_by_value` flavour of clippy doesn't apply here.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn open_log(
    app: AppHandle,
    blf_path: String,
    dbc_path: Option<String>,
) -> Result<OpenLogResult, String> {
    // Open the BLF synchronously so the user gets immediate feedback if
    // the path is wrong.
    let source = BlfFrameSource::open(&blf_path).map_err(|e| e.to_string())?;

    let database = match dbc_path.as_deref() {
        Some(path) => Some(load_database(path)?),
        None => None,
    };
    let dbc_message_count = database.as_ref().map(Database::message_count);

    let result = OpenLogResult {
        blf_path: blf_path.clone(),
        dbc_path: dbc_path.clone(),
        dbc_message_count,
    };

    let app_for_thread = app.clone();
    std::thread::Builder::new()
        .name("cannet-blf-pump".into())
        .spawn(move || {
            run_pump(&app_for_thread, source, database);
        })
        .map_err(|e| format!("failed to spawn pump thread: {e}"))?;

    Ok(result)
}

fn load_database(path: &str) -> Result<Database, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read DBC at {path}: {e}"))?;
    Database::parse(&text).map_err(|e| format!("failed to parse DBC at {path}: {e}"))
}

// `BlfFrameSource` and `Database` are owned by this thread for its
// lifetime; clippy's "pass by reference" suggestion doesn't fit the
// thread-spawn site.
#[allow(clippy::needless_pass_by_value)]
fn run_pump(app: &AppHandle, mut source: BlfFrameSource, database: Option<Database>) {
    let total = Arc::new(AtomicU64::new(0));
    let mut batch: Vec<FrameRecord> = Vec::with_capacity(BATCH_SIZE);

    loop {
        let frame = match source.next_frame() {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                flush_batch(app, &mut batch);
                let _ = app.emit(
                    "log-finished",
                    LogFinished::Error { message: e.to_string() },
                );
                return;
            }
        };

        let decoded = database.as_ref().and_then(|db| {
            db.decode(&frame).map(|m| DecodedRecord {
                name: m.name.to_string(),
                signals: m
                    .signals
                    .iter()
                    .map(signal_to_wire)
                    .collect(),
            })
        });

        batch.push(FrameRecord::from_frame(&frame, decoded));
        total.fetch_add(1, Ordering::Relaxed);

        if batch.len() >= BATCH_SIZE {
            flush_batch(app, &mut batch);
        }
    }

    flush_batch(app, &mut batch);
    let _ = app.emit(
        "log-finished",
        LogFinished::Ok { total: total.load(Ordering::Relaxed) },
    );
}

fn flush_batch(app: &AppHandle, batch: &mut Vec<FrameRecord>) {
    if batch.is_empty() {
        return;
    }
    let frames = std::mem::replace(batch, Vec::with_capacity(BATCH_SIZE));
    let _ = app.emit("frame-batch", FrameBatch { frames });
}

fn signal_to_wire(sig: &DecodedSignal<'_>) -> SignalRecord {
    SignalRecord {
        name: sig.name.to_string(),
        value: sig.value,
        unit: sig.unit.to_string(),
    }
}
