//! Session connect / pump / routing.
//!
//! A [`RemoteSession`] is an active source — a remote `cannet-client`
//! session or an in-process `local-vbus://` session (ADR 0021 / ADR
//! 0023) — landing in the same `AppState::remote_sessions` map and
//! answering the same transmit / disconnect paths. `connect_remote_server`
//! and `connect_local_vbus` build one, register it through the shared
//! `register_session_or_warn` seam, and spawn a [`run_pump`] worker per
//! source; `resolve_bus_route` maps a logical bus id back to the wire
//! route a transmit must take.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use cannet_client::{PreSubscribeConfig, SessionHandle, SessionTransmitter, Subscription};
use cannet_core::CanFrameSource;

use crate::app_state::AppState;
use crate::capture::restamp_scratch_for_capture;
use crate::ipc::{self, InterfaceRecord, LogFinished, RemoteSessionResult};
use crate::project;
use crate::trace_store::RawTraceFrame;
use crate::{sys_error, sys_info, sys_warn};

/// State for an active session — remote (over `cannet-client`) or
/// in-process (an `local-vbus://` URL). The two share the same
/// channel→interface / channel→bus maps and the same stop flag; the
/// backend split lives inside [`SessionTx`].
#[allow(dead_code)]
pub(crate) struct RemoteSession {
    /// Drop-to-disconnect handle for a remote session. `None` for an
    /// in-process session — teardown there happens by dropping the
    /// participant sinks held inside [`Self::tx`], which detaches the
    /// participants and lets the per-channel pumps see
    /// `LocalSource::next_event() -> None` and exit.
    pub(crate) handle: Option<SessionHandle>,
    /// Submitting end of the session — what the `transmit_frame`
    /// command pushes onto. Variants reflect the backend; both
    /// answer to a uniform `transmit(channel, interface_id, frame)`
    /// call (see [`SessionTx::transmit`]).
    pub(crate) tx: SessionTx,
    /// `channel -> wire interface_id` for every subscription opened
    /// when the session was established. The transmit-panel command
    /// uses this to translate a frame's `channel` to the wire id the
    /// `FrameBatch` envelope must carry (remote backend) or to the
    /// canonical `"bus"` string the vbus backend stamps on `Sent`
    /// status responses.
    pub(crate) channel_to_interface: Vec<(u8, String)>,
    /// `channel -> logical bus id` derived from the project's
    /// interface bindings. The pump uses it to stamp incoming frames'
    /// `bus_id`; `transmit_frame` uses the reverse direction (bus id
    /// → channel) to route an outgoing frame to the right session.
    /// Entries with `None` mean "channel unmapped" — those frames
    /// pump through unassigned and are unreachable as transmit
    /// destinations.
    pub(crate) channel_to_bus: Vec<(u8, Option<String>)>,
    pub(crate) stop: Arc<AtomicBool>,
}

/// Backend-specific transmit machinery for a [`RemoteSession`].
/// Both arms expose the same `transmit(channel, interface_id, frame)`
/// surface so the upstream transmit path (`transmit_frame_inner`,
/// `resolve_bus_route`) is uniform.
pub(crate) enum SessionTx {
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
    pub(crate) fn transmit(
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

    /// Send several frames to one interface. Remote sessions ride a
    /// single `FrameBatch` envelope (per-envelope overhead paid once
    /// per tick, not per frame); the in-process vbus has no envelope
    /// concept, so it submits per frame.
    pub(crate) fn transmit_batch(
        &self,
        channel: u8,
        interface_id: &str,
        frames: &[cannet_core::CanFrame],
    ) -> Result<(), String> {
        match self {
            SessionTx::Remote(t) => t
                .transmit_batch(interface_id, frames)
                .map_err(|e| e.to_string()),
            SessionTx::Vbus(_) => {
                for frame in frames {
                    self.transmit(channel, interface_id, frame)?;
                }
                Ok(())
            }
        }
    }
}
/// Session-map mutation seam. Every insert/remove of `remote_sessions`
/// goes through these — never through a raw lock at a call site — so
/// route up-transitions have one place to hint the transmit scheduler
/// and the map's lifecycle is auditable in one screen.
impl AppState {
    /// Insert a freshly-connected session. Fails (leaving the existing
    /// entry untouched, and dropping `session` — which shuts its worker
    /// down) if `address` already has one. On success, hints the
    /// transmit scheduler that a route may have come up so parked
    /// periodics resume promptly.
    pub(crate) fn register_session(&self, address: String, session: RemoteSession) -> Result<(), String> {
        {
            let mut guard = self
                .remote_sessions();
            if guard.contains_key(&address) {
                return Err(format!("already connected to {address}"));
            }
            guard.insert(address, session);
        }
        self.transmit_scheduler.routes_changed();
        Ok(())
    }

    /// Remove one session (`Some(addr)`) or all of them (`None`),
    /// returning what was removed so the caller can run teardown
    /// (stop flags, handle drops) outside the lock.
    pub(crate) fn unregister_sessions(&self, address: Option<&str>) -> Vec<(String, RemoteSession)> {
        let mut guard = self
            .remote_sessions();
        match address {
            Some(addr) => guard
                .remove(addr)
                .map(|s| (addr.to_string(), s))
                .into_iter()
                .collect(),
            None => guard.drain().collect(),
        }
    }

    /// Vbus pump-exit teardown: remove `address` only if its session is
    /// dead (entry already gone, or a vbus session with no sinks left).
    /// Returns whether the session is dead — pumps exit out of order and
    /// the first one out must not tear the whole session down.
    pub(crate) fn remove_vbus_session_if_dead(&self, address: &str) -> bool {
        let mut guard = self
            .remote_sessions();
        let session_dead = guard.get(address).is_none_or(|s| match &s.tx {
            SessionTx::Vbus(sinks) => sinks.is_empty(),
            SessionTx::Remote(_) => false,
        });
        if session_dead {
            guard.remove(address);
        }
        session_dead
    }
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
/// Register a freshly-built session through the shared session-map seam,
/// surfacing the duplicate-address rejection on the system log. The only
/// session insert either connect path does — so the subscribe/pump-spawn
/// skeleton around it stays uniform. On rejection the session (and its
/// worker handle) is dropped inside `register_session`, shutting the
/// just-spawned worker down and leaving the existing entry untouched.
fn register_session_or_warn(
    app: &AppHandle,
    state: &AppState,
    address: String,
    session: RemoteSession,
) -> Result<(), String> {
    state.register_session(address, session).map_err(|msg| {
        sys_warn!(app, "connection", "{msg}");
        msg
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
pub(crate) async fn connect_remote_server(
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

    let state: State<'_, AppState> = app.state();
    // The pump gets its own copy of the same channel→bus list while the
    // session owns the original — the value is known here, so clone it
    // instead of re-reading the just-inserted entry under a second lock.
    let pump_channel_to_bus = channel_to_bus.clone();
    register_session_or_warn(
        &app,
        &state,
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
    )?;

    let app_for_thread = app.clone();
    let address_for_cleanup = address.clone();
    std::thread::Builder::new()
        .name(format!("cannet-remote-pump:{address}"))
        .spawn(move || {
            run_pump(&app_for_thread, receiver, stop, pump_channel_to_bus, false);
            // Pump exited (server hung up or user disconnected). Drop
            // our entry so the address is free for a fresh connect.
            let state: State<'_, AppState> = app_for_thread.state();
            drop(state.unregister_sessions(Some(&address_for_cleanup)));
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

    register_session_or_warn(
        app,
        &state,
        address.clone(),
        RemoteSession {
            handle: None,
            tx: SessionTx::Vbus(sinks),
            channel_to_interface,
            channel_to_bus: channel_to_bus.clone(),
            stop: Arc::clone(&stop),
        },
    )?;

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
                if state.remove_vbus_session_if_dead(&address_for_cleanup) {
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
pub(crate) struct LocalSourceFrameSource {
    pub(crate) source: cannet_core::LocalSource,
    pub(crate) channel: u8,
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
pub(crate) fn disconnect_remote_server(app: AppHandle, state: State<'_, AppState>, address: Option<String>) {
    let sessions = state.unregister_sessions(address.as_deref());
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
pub(crate) fn route_channel(channel: u8, mapping: &[(u8, Option<String>)]) -> Result<Option<String>, ()> {
    match mapping.iter().find(|(ch, _)| *ch == channel) {
        Some((_, Some(bid))) => Ok(Some(bid.clone())),
        Some((_, None)) => Err(()),
        None => Ok(None),
    }
}

/// Human-readable text of a `catch_unwind` payload: the `&str` or
/// `String` a `panic!` carries, or a placeholder for anything else.
pub(crate) fn panic_message(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload")
}

// `source` is owned by this thread for its lifetime; clippy's
// "pass by reference" suggestion doesn't fit the thread-spawn site.
//
// `channel_to_bus` is the source's per-channel logical-bus mapping
// On each frame the pump tags it with the bus_id matching
// its `channel`; a channel with no entry stays `bus_id: None`; a
// channel mapped to `None` is dropped (the BLF-import "skip" path).
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn run_pump<S>(
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
                    restamp_scratch_for_capture(&state);
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
/// One resolved bus → wire route. Returned from
/// [`resolve_bus_route`]; carries the server address (so the caller
/// can re-borrow the session under the same lock), the wire channel
/// the bus maps to, and the wire interface id the transmit must be
/// addressed to.
pub(crate) struct BusRoute {
    pub(crate) address: String,
    pub(crate) channel: u8,
    pub(crate) interface_id: String,
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
