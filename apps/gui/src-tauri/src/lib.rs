//! Cannet Tauri host. Wires the Phase-1 BLF / DBC stack and the Phase-2
//! remote-server client to the React frontend.
//!
//! Two source modes share one frontend pipeline:
//!
//! - `open_log(blf_path)` — opens a Vector BLF file and spawns a worker
//!   thread that streams `can-frame-batch` events at the frontend until
//!   the file is exhausted.
//! - `connect_remote_server(address)` — connects to a `cannet-server`
//!   over gRPC, lists its interfaces, subscribes to all of them, and
//!   spawns the same kind of worker thread to push frames at the
//!   frontend. `disconnect_remote_server` ends the session.
//!
//! Both worker threads run [`run_pump`], which is generic over
//! `CanFrameSource` — it doesn't know or care which source it's draining,
//! so DBC decoding, IPC batching, and `log-finished` semantics behave
//! identically across modes.
//!
//! The current DBC lives in shared backend state (`AppState::database`)
//! so that:
//!   - the worker decodes incoming frames against whatever DBC is
//!     attached at the moment each frame arrives, and
//!   - the frontend can call `decode_frames` to retro-decode already-
//!     displayed rows when a DBC is attached after the source was
//!     opened.

mod ipc;

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use cannet_blf::BlfCanFrameSource;
use cannet_client::{FrameReceiver, SessionHandle, Subscription};
use cannet_core::{CanFrameSource, CanId};
use cannet_dbc::{Database, DecodedSignal};

use ipc::{
    CanFrameBatch, CanFrameRecord, DbcInfo, DecodeRequest, DecodedRecord, InterfaceRecord,
    LogFinished, OpenLogResult, RemoteSessionResult, SignalRecord,
};

/// Frames per emitted batch. Smaller batches cut latency; larger ones cut
/// IPC overhead. 256 is roughly one screenful of trace rows and keeps
/// IPC chatter modest on multi-MHz BLF replays.
const BATCH_SIZE: usize = 256;

/// Process-wide state shared between commands and pump threads.
struct AppState {
    /// Currently-attached DBC, if any. Mutated by `attach_dbc` /
    /// `detach_dbc`; read by the pump and by `decode_frames`.
    database: Mutex<Option<Database>>,
    /// Active remote session, if any. The handle is stashed here while
    /// the corresponding pump thread drains frames from the
    /// `FrameReceiver`. `disconnect_remote_server` takes the handle out
    /// and drops it, signalling the worker to close the gRPC stream;
    /// the pump thread then sees `Ok(None)` and exits cleanly.
    remote_session: Mutex<Option<SessionHandle>>,
}

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
        .manage(AppState {
            database: Mutex::new(None),
            remote_session: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            open_log,
            attach_dbc,
            detach_dbc,
            decode_frames,
            list_remote_interfaces,
            connect_remote_server,
            disconnect_remote_server,
        ])
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
fn open_log(app: AppHandle, blf_path: String) -> Result<OpenLogResult, String> {
    // Open the BLF synchronously so the user gets immediate feedback if
    // the path is wrong.
    let source = BlfCanFrameSource::open(&blf_path).map_err(|e| e.to_string())?;

    let result = OpenLogResult {
        blf_path: blf_path.clone(),
    };

    let app_for_thread = app.clone();
    std::thread::Builder::new()
        .name("cannet-blf-pump".into())
        .spawn(move || {
            run_pump(&app_for_thread, source);
        })
        .map_err(|e| format!("failed to spawn pump thread: {e}"))?;

    Ok(result)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn attach_dbc(state: State<'_, AppState>, path: String) -> Result<DbcInfo, String> {
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read DBC at {path}: {e}"))?;
    let db = Database::parse(&text).map_err(|e| format!("failed to parse DBC at {path}: {e}"))?;
    let message_count = db.message_count();
    *state.database.lock().expect("database mutex poisoned") = Some(db);
    Ok(DbcInfo {
        dbc_path: path,
        message_count,
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn detach_dbc(state: State<'_, AppState>) {
    *state.database.lock().expect("database mutex poisoned") = None;
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn decode_frames(
    state: State<'_, AppState>,
    frames: Vec<DecodeRequest>,
) -> Vec<Option<DecodedRecord>> {
    let guard = state.database.lock().expect("database mutex poisoned");
    let Some(db) = guard.as_ref() else {
        return vec![None; frames.len()];
    };
    frames.iter().map(|req| decode_one(db, req)).collect()
}

fn decode_one(db: &Database, req: &DecodeRequest) -> Option<DecodedRecord> {
    let id = if req.extended {
        CanId::extended(req.id).ok()?
    } else {
        CanId::standard(req.id).ok()?
    };
    db.decode_raw(id, &req.data).map(|m| DecodedRecord {
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
#[tauri::command]
async fn connect_remote_server(
    app: AppHandle,
    address: String,
) -> Result<RemoteSessionResult, String> {
    let interfaces = cannet_client::list_interfaces(&address)
        .await
        .map_err(|e| e.to_string())?;

    if interfaces.is_empty() {
        return Err(format!("server at {address} exposes no interfaces"));
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
    let source = tokio::task::spawn_blocking(move || {
        cannet_client::connect_and_subscribe(&address_for_thread, subs_for_thread)
    })
    .await
    .map_err(|e| format!("subscribe task panicked: {e}"))?
    .map_err(|e| e.to_string())?;

    let (handle, receiver) = source.into_parts();

    {
        let state: State<'_, AppState> = app.state();
        let mut guard = state
            .remote_session
            .lock()
            .expect("remote_session mutex poisoned");
        if guard.is_some() {
            // Drop `handle` here, which sends shutdown to the worker we
            // just spawned. Subsequent pump-thread spawn is skipped.
            return Err("already connected to a remote server".into());
        }
        *guard = Some(handle);
    }

    let app_for_thread = app.clone();
    std::thread::Builder::new()
        .name("cannet-remote-pump".into())
        .spawn(move || {
            run_pump(&app_for_thread, receiver);
            // The pump exited (server hung up or user disconnected).
            // Clear the stashed handle so a fresh connect can start.
            let state: State<'_, AppState> = app_for_thread.state();
            let _ = state
                .remote_session
                .lock()
                .expect("remote_session mutex poisoned")
                .take();
        })
        .map_err(|e| format!("failed to spawn remote pump thread: {e}"))?;

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

/// Drop the active remote session's [`SessionHandle`]. The pump thread
/// notices via `Ok(None)` from its next `next_frame` call, flushes any
/// buffered frames, emits `log-finished`, and exits.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn disconnect_remote_server(state: State<'_, AppState>) {
    let handle = state
        .remote_session
        .lock()
        .expect("remote_session mutex poisoned")
        .take();
    drop(handle);
}

// `source` is owned by this thread for its lifetime; clippy's
// "pass by reference" suggestion doesn't fit the thread-spawn site.
#[allow(clippy::needless_pass_by_value)]
fn run_pump<S>(app: &AppHandle, mut source: S)
where
    S: CanFrameSource,
    S::Error: fmt::Display,
{
    let state: State<'_, AppState> = app.state();
    let total = AtomicU64::new(0);
    let mut batch: Vec<CanFrameRecord> = Vec::with_capacity(BATCH_SIZE);

    loop {
        let frame = match source.next_frame() {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                flush_batch(app, &mut batch);
                let _ = app.emit(
                    "log-finished",
                    LogFinished::Error {
                        message: e.to_string(),
                    },
                );
                return;
            }
        };

        // Hold the lock just long enough to decode this one frame.
        // Attach/detach are rare so contention is negligible.
        let decoded = {
            let guard = state.database.lock().expect("database mutex poisoned");
            guard.as_ref().and_then(|db| {
                db.decode(&frame).map(|m| DecodedRecord {
                    name: m.name.to_string(),
                    signals: m.signals.iter().map(signal_to_wire).collect(),
                })
            })
        };

        batch.push(CanFrameRecord::from_frame(&frame, decoded));
        total.fetch_add(1, Ordering::Relaxed);

        if batch.len() >= BATCH_SIZE {
            flush_batch(app, &mut batch);
        }
    }

    flush_batch(app, &mut batch);
    let _ = app.emit(
        "log-finished",
        LogFinished::Ok {
            total: total.load(Ordering::Relaxed),
        },
    );
}

fn flush_batch(app: &AppHandle, batch: &mut Vec<CanFrameRecord>) {
    if batch.is_empty() {
        return;
    }
    let frames = std::mem::replace(batch, Vec::with_capacity(BATCH_SIZE));
    let _ = app.emit("can-frame-batch", CanFrameBatch { frames });
}

fn signal_to_wire(sig: &DecodedSignal<'_>) -> SignalRecord {
    SignalRecord {
        name: sig.name.to_string(),
        value: sig.value,
        unit: sig.unit.to_string(),
    }
}
