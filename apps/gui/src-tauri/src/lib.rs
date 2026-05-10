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
//! draining; it just appends each frame to the shared
//! [`TraceStore`].
//!
//! The trace UI is a *view* over [`TraceStore`]: it asks for slices via
//! `fetch_trace_range` and renders virtualized rows around the current
//! viewport. A `trace-grew` IPC event ticks at ~10 Hz with the latest
//! `count` and frame rate so the status line and auto-scroll stay
//! current without the host having to push every frame over IPC.
//!
//! The current DBC lives in shared backend state (`AppState::database`)
//! so that the per-fetch decoder always uses the most recently
//! attached database. There is no retro-decode walk; attaching a DBC
//! mid-stream just changes what subsequent fetches return.

mod ipc;
mod trace_store;

use std::fmt;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use cannet_blf::BlfCanFrameSource;
use cannet_client::{SessionHandle, Subscription};
use cannet_core::{CanFrameSource, CanId};
use cannet_dbc::{Database, DecodedSignal};

use ipc::{
    DbcInfo, DecodedRecord, InterfaceRecord, LogFinished, OpenLogResult,
    RemoteSessionResult, SignalRecord, TraceFrameRecord, TraceGrew,
};
use trace_store::{RawTraceFrame, TraceStore};

/// How often the host pushes a `trace-grew` IPC event with the latest
/// count + rate. Slow enough to not flood the frontend, fast enough that
/// the status line and auto-scroll feel live.
const TRACE_GREW_TICK: Duration = Duration::from_millis(100);

/// Process-wide state shared between commands and pump threads.
struct AppState {
    /// Currently-attached DBC, if any. Mutated by `attach_dbc` /
    /// `detach_dbc`; read by `fetch_trace_range` to decode the slice
    /// against whatever DBC is current at fetch time.
    database: Mutex<Option<Database>>,
    /// Active remote session, if any. The handle is stashed here while
    /// the corresponding pump thread drains frames from the
    /// `FrameReceiver`. `disconnect_remote_server` takes the handle out
    /// and drops it, signalling the worker to close the gRPC stream;
    /// the pump thread then sees `Ok(None)` and exits cleanly.
    remote_session: Mutex<Option<SessionHandle>>,
    /// The trace model — the single source of truth for the captured
    /// stream. Pump threads append; `fetch_trace_range` reads slices
    /// out for the trace view to render.
    trace_store: TraceStore,
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
            trace_store: TraceStore::new(),
        })
        .invoke_handler(tauri::generate_handler![
            open_log,
            attach_dbc,
            detach_dbc,
            fetch_trace_range,
            clear_trace_store,
            list_remote_interfaces,
            connect_remote_server,
            disconnect_remote_server,
        ])
        .setup(|app| {
            // Make sure the main window has the id our capabilities expect.
            // Tauri assigns "main" by default for the first window in the
            // config; we rely on that here.
            debug_assert!(app.get_webview_window("main").is_some());
            spawn_trace_grew_emitter(app.handle().clone());
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
            let _ = app.emit(
                "trace-grew",
                TraceGrew {
                    count,
                    frames_per_second,
                },
            );
        }
    });
}

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

/// Pull a `[start, end)` slice out of the trace store and decode each
/// frame against the currently-attached DBC. The caller is expected to
/// be the trace view, sizing `end - start` to the visible window plus a
/// small prefetch pad.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn fetch_trace_range(
    state: State<'_, AppState>,
    start: u64,
    end: u64,
) -> Vec<TraceFrameRecord> {
    let start_us = usize::try_from(start).unwrap_or(usize::MAX);
    let end_us = usize::try_from(end).unwrap_or(usize::MAX);
    let raw = state.trace_store.slice(start_us, end_us);
    let guard = state.database.lock().expect("database mutex poisoned");
    let db = guard.as_ref();
    raw.into_iter()
        .enumerate()
        .map(|(i, frame)| {
            #[allow(clippy::cast_possible_truncation)]
            let absolute_index = start + i as u64;
            let decoded = db.and_then(|db| decode_raw_frame(db, &frame));
            TraceFrameRecord::from_raw(absolute_index, &frame, decoded)
        })
        .collect()
}

/// Drop every stored frame. The frontend's Clear button is the typical
/// caller. The next `trace-grew` tick will fire with the new count
/// (zero), prompting the trace view to drop its row cache.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn clear_trace_store(state: State<'_, AppState>) {
    state.trace_store.clear();
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
/// notices via `Ok(None)` from its next `next_frame` call and exits.
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
    let mut total: u64 = 0;

    loop {
        match source.next_frame() {
            Ok(Some(frame)) => {
                state.trace_store.append(RawTraceFrame::from(frame));
                total = total.saturating_add(1);
            }
            Ok(None) => break,
            Err(e) => {
                let _ = app.emit(
                    "log-finished",
                    LogFinished::Error {
                        message: e.to_string(),
                    },
                );
                return;
            }
        }
    }

    let _ = app.emit("log-finished", LogFinished::Ok { total });
}

fn signal_to_wire(sig: &DecodedSignal<'_>) -> SignalRecord {
    SignalRecord {
        name: sig.name.to_string(),
        value: sig.value,
        unit: sig.unit.to_string(),
    }
}
