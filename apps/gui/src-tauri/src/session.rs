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

use cannet_client::{
    clock::SessionClock, controller::ControllerStates, rejections::PerFrameErrors, ConnectionError,
    PreSubscribeConfig, SessionHandle, SessionTransmitter, Subscription,
};
use cannet_core::CanFrameSource;

use crate::app_state::AppState;
use crate::capture::{restamp_scratch_for_capture, ImportProgress};
use crate::connect_flow::{self, Attempt, Outcome};
use crate::connection_state::{self, AppliedBusConfig, BusConnState};
use crate::ipc::{self, InterfaceRecord, LogFinished, RemoteSessionResult};
use crate::project;
use crate::trace_store::RawTraceFrame;
use crate::{sys_debug, sys_error, sys_info, sys_warn};

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
    /// A channel with no entry is unmapped — its frames are dropped at
    /// the pump and it is unreachable as a transmit destination.
    pub(crate) channel_to_bus: Vec<(u8, String)>,
    pub(crate) stop: Arc<AtomicBool>,
    /// This session's live clock-offset tracking, or `None` for a
    /// session with no `Session` behind it — the in-process
    /// `local-vbus://` backend never opens one, so there is no peer
    /// clock to measure. Cheap to clone: [`crate::clock_status`] polls
    /// it from a separate task without touching the session map.
    pub(crate) clock: Option<SessionClock>,
    /// ISO 11898-1 fault-confinement state per wire interface, as the
    /// peer's `InterfaceState` envelopes report it. `None` for the
    /// in-process backend, which has no controller at all — and that is
    /// a different answer from "error-active", which is why it is an
    /// option rather than an empty map. Polled by
    /// [`crate::bus_health`] the same way the clock status is.
    pub(crate) controllers: Option<ControllerStates>,
    /// What this peer said about frames it would not carry — the
    /// per-frame error codes, tallied by code. `None` for the
    /// in-process backend, which has no peer to refuse anything.
    /// Polled by [`crate::bus_health`] alongside the controller states,
    /// and reported coalesced: a peer refusing at bus rate produces
    /// thousands a second.
    pub(crate) rejections: Option<PerFrameErrors>,
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
    pub(crate) fn register_session(
        &self,
        address: String,
        session: RemoteSession,
    ) -> Result<(), String> {
        {
            let mut guard = self.remote_sessions();
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
    pub(crate) fn unregister_sessions(
        &self,
        address: Option<&str>,
    ) -> Vec<(String, RemoteSession)> {
        let mut guard = self.remote_sessions();
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
        let mut guard = self.remote_sessions();
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

/// What the host will actually put on the wire for `b`, as the UI
/// reports it back on the bus row.
///
/// This is the same decision [`presubscribe_config_from`] makes, read
/// out rather than sent — so the row can only ever echo what was
/// really sent. The two normalisations the user can't see from the
/// input fields are both encoded here: nothing pinned means **no**
/// `ConfigureBus` at all (`speed_bps: None` — the driver default
/// stands), and an FD bus with no data rate rides the nominal rate
/// (a wire `0`, which the sidecar resolves that way).
fn applied_config_from(b: &InterfaceBusBinding) -> AppliedBusConfig {
    match presubscribe_config_from(b) {
        None => AppliedBusConfig {
            speed_bps: None,
            fd_enabled: false,
            fd_data_speed_bps: None,
        },
        Some(cfg) => AppliedBusConfig {
            speed_bps: Some(cfg.speed_bps),
            fd_enabled: cfg.fd_enabled,
            fd_data_speed_bps: if cfg.fd_enabled {
                Some(if cfg.fd_data_speed_bps == 0 {
                    cfg.speed_bps
                } else {
                    cfg.fd_data_speed_bps
                })
            } else {
                None
            },
        },
    }
}

/// Split `bindings` by whether `exposed` (the server's live
/// enumeration) actually carries the bound interface.
///
/// The unavailable half used to be dropped on the floor by the
/// subscription `filter_map`: the bus simply never received frames
/// while the panel showed the server connected. Returning it lets the
/// caller give that bus its own error state — the one dead channel on
/// an otherwise working multi-channel card.
fn split_by_availability<'a>(
    bindings: &'a [InterfaceBusBinding],
    exposed: &[String],
) -> (Vec<&'a InterfaceBusBinding>, Vec<&'a InterfaceBusBinding>) {
    bindings
        .iter()
        .partition(|b| exposed.contains(&b.interface))
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

/// Fold a failed connection attempt through the connect-flow
/// classifier, publishing anything only the user can answer as a
/// [`crate::connect_flow::TrustPrompt`] against `address`. Returns the
/// sentence for the bus rows and the system log either way — the dialog
/// carries the detail, the rows carry the reason.
fn ask_or_report(
    app: &AppHandle,
    address: &str,
    attempt: &Attempt,
    error: &ConnectionError,
) -> String {
    match connect_flow::classify(attempt, error) {
        Outcome::Ask(prompt) => {
            connect_flow::ask(app, address, prompt);
            error.to_string()
        }
        Outcome::Fatal(msg) | Outcome::Retry(msg) => msg,
    }
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

    // The bus rows go to `connecting…` before anything is attempted and
    // only move on a real outcome — never on "the request left".
    connection_state::set_and_emit(
        &app,
        binding_lookup
            .iter()
            .map(|b| (b.bus_id.clone(), BusConnState::Connecting)),
    );
    // Failure closure: every early return below has to leave the rows
    // saying why, not stuck spinning.
    let fail_all = |app: &AppHandle, reason: &str| {
        connection_state::set_and_emit(
            app,
            binding_lookup
                .iter()
                .map(|b| (b.bus_id.clone(), BusConnState::error(reason))),
        );
    };

    // ADR 0023 dispatch: a `local-vbus://<id>` address opens an
    // in-process session against the named virtual bus instead of
    // going over `cannet-client`. Same RemoteSession shape; same
    // entry in the session map; same transmit / disconnect paths.
    if let Some(vbus_id) = address.strip_prefix(project::LOCAL_VBUS_URL_SCHEME) {
        let result = connect_local_vbus(&app, address.clone(), vbus_id, &binding_lookup);
        match &result {
            Ok(_) => connection_state::set_and_emit(
                &app,
                binding_lookup.iter().map(|b| {
                    // An in-process bus has no controller to configure,
                    // so there is no applied hardware config to echo.
                    (b.bus_id.clone(), BusConnState::Connected { applied: None })
                }),
            ),
            Err(e) => fail_all(&app, e),
        }
        return result;
    }

    sys_debug!(&app, "connection", "connecting to {address}");
    // How this server is reached is the host's decision, planned once
    // from what it has stored for the address (ADR 0041) and reused for
    // both the discovery call and the session below.
    let attempt = connect_flow::plan(&address, &crate::server_trust::trust_for(&app, &address));
    let config = match attempt.config(&address) {
        Ok(config) => config,
        Err(msg) => {
            sys_error!(&app, "connection", "{msg}");
            fail_all(&app, &msg);
            return Err(msg);
        }
    };
    let interfaces = match cannet_client::list_interfaces(&config).await {
        Ok(v) => v,
        Err(e) => {
            let msg = ask_or_report(&app, &address, &attempt, &e);
            sys_error!(&app, "connection", "failed to connect to {address}: {msg}");
            fail_all(&app, &msg);
            return Err(msg);
        }
    };
    connect_flow::resolved(&app, &address);

    if interfaces.is_empty() {
        let msg = format!("server at {address} exposes no interfaces");
        sys_warn!(&app, "connection", "{msg}");
        fail_all(&app, "server exposes no interfaces");
        return Err(msg);
    }

    // Subscribe only to interfaces named in the project's bindings for
    // this server. A binding whose interface the server doesn't expose
    // gets its bus an error state of its own rather than being dropped
    // silently — the rest of the card still connects.
    let exposed: Vec<String> = interfaces.iter().map(|i| i.id.clone()).collect();
    let (available, unavailable) = split_by_availability(&binding_lookup, &exposed);
    for b in &unavailable {
        sys_warn!(
            &app,
            "connection",
            "{iface} is not exposed by {address}; bus {bus} will not receive frames",
            iface = b.interface,
            bus = b.bus_id,
        );
    }
    connection_state::set_and_emit(
        &app,
        unavailable.iter().map(|b| {
            (
                b.bus_id.clone(),
                BusConnState::error(format!("not exposed by {address}")),
            )
        }),
    );

    // Channels are 0..N over the binding list — distinct per session,
    // not globally unique. When the binding carries an explicit bus
    // speed / FD mode, attach it so the worker emits a `ConfigureBus`
    // ahead of the corresponding `Subscribe` and the controller opens
    // at the right rate from the start.
    let subscriptions: Vec<Subscription> = binding_lookup
        .iter()
        .enumerate()
        .filter_map(|(i, b)| {
            if !exposed.contains(&b.interface) {
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
    // From here on only the bindings we actually subscribed for move;
    // the unavailable ones keep the error state set above.
    let subscribed_buses: Vec<String> = available.iter().map(|b| b.bus_id.clone()).collect();
    let fail_subscribed = |app: &AppHandle, reason: &str| {
        connection_state::set_and_emit(
            app,
            subscribed_buses
                .iter()
                .map(|id| (id.clone(), BusConnState::error(reason))),
        );
    };

    let config_for_thread = config.clone();
    let subs_for_thread = subscriptions.clone();
    let source = match tokio::task::spawn_blocking(move || {
        cannet_client::connect_and_subscribe(&config_for_thread, subs_for_thread)
    })
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let msg = ask_or_report(&app, &address, &attempt, &e);
            sys_error!(&app, "connection", "subscribe to {address} failed: {msg}");
            fail_subscribed(&app, &msg);
            return Err(msg);
        }
        Err(e) => {
            let msg = format!("subscribe task panicked: {e}");
            sys_error!(&app, "connection", "{msg}");
            fail_subscribed(&app, &msg);
            return Err(msg);
        }
    };

    let (handle, receiver, transmitter) = source.into_parts();
    let clock = receiver.clock().clone();
    let controllers = receiver.controllers().clone();
    let rejections = receiver.rejections().clone();
    let stop = Arc::new(AtomicBool::new(false));

    // Build the channel-to-bus mapping from the per-server
    // bindings. We subscribed to exactly the bindings' interfaces
    // above, so each subscription has a matching binding by
    // interface id. Stored on the session so `transmit_frame` can
    // use it for outgoing routing; the pump gets its own clone.
    let channel_to_bus: Vec<(u8, String)> = subscriptions
        .iter()
        .filter_map(|sub| {
            binding_lookup
                .iter()
                .find(|b| b.interface == sub.interface_id)
                .map(|b| (sub.channel, b.bus_id.clone()))
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
            clock: Some(clock),
            controllers: Some(controllers),
            rejections: Some(rejections),
        },
    )
    .inspect_err(|e| fail_subscribed(&app, e))?;

    let app_for_thread = app.clone();
    let address_for_cleanup = address.clone();
    let buses_for_cleanup = subscribed_buses.clone();
    std::thread::Builder::new()
        .name(format!("cannet-remote-pump:{address}"))
        .spawn(move || {
            run_pump(
                &app_for_thread,
                receiver,
                stop,
                pump_channel_to_bus,
                false,
                None,
            );
            // Pump exited (server hung up or user disconnected). Drop
            // our entry so the address is free for a fresh connect, and
            // retire the bus rows' connected state with it.
            let state: State<'_, AppState> = app_for_thread.state();
            drop(state.unregister_sessions(Some(&address_for_cleanup)));
            connection_state::remove_and_emit(&app_for_thread, buses_for_cleanup);
        })
        .map_err(|e| {
            let msg = format!("failed to spawn remote pump thread: {e}");
            fail_subscribed(&app, &msg);
            msg
        })?;

    // The subscribe returned: these buses are up, and each row now
    // carries the configuration that actually went on the wire for it.
    connection_state::set_and_emit(
        &app,
        available.iter().map(|b| {
            (
                b.bus_id.clone(),
                BusConnState::Connected {
                    applied: Some(applied_config_from(b)),
                },
            )
        }),
    );

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
    sys_debug!(
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
    let channel_to_bus: Vec<(u8, String)> = participants
        .iter()
        .map(|(c, _, _, bid)| (*c, bid.clone()))
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
            // No `Session` is opened for an in-process vbus backend
            // (see the module docs), so there is no peer clock to
            // measure and no controller to report a state.
            clock: None,
            controllers: None,
            rejections: None,
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
        let channel_to_bus = vec![(channel, bus_id.clone())];
        std::thread::Builder::new()
            .name(format!("cannet-vbus-pump:{address_for_cleanup}#{channel}"))
            .spawn(move || {
                let adapter = LocalSourceFrameSource { source, channel };
                run_pump(&app_for_thread, adapter, stop, channel_to_bus, false, None);
                // When the *last* participant's pump exits, drop the
                // session entry so the URL is free for a fresh
                // connect. Use a guarded check — pumps may exit out
                // of order; the first one shouldn't tear the whole
                // session down.
                let state: State<'_, AppState> = app_for_thread.state();
                if state.remove_vbus_session_if_dead(&address_for_cleanup) {
                    sys_debug!(
                        &app_for_thread,
                        "connection",
                        "in-process session {cleanup_addr_for_log} closed",
                    );
                }
                connection_state::remove_and_emit(&app_for_thread, [bus_id.clone()]);
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
pub(crate) fn disconnect_remote_server(
    app: AppHandle,
    state: State<'_, AppState>,
    address: Option<String>,
) {
    let sessions = state.unregister_sessions(address.as_deref());
    // Retire the bus rows before the pumps get a chance to: the buses
    // an ending session covered are exactly its `channel_to_bus`
    // entries, and the pump's own cleanup races this one.
    let retired: Vec<String> = sessions
        .iter()
        .flat_map(|(_, s)| s.channel_to_bus.iter().map(|(_, b)| b.clone()))
        .collect();
    for (addr, session) in sessions {
        session.stop.store(true, Ordering::Relaxed);
        // Dropping the handle signals the worker to disconnect; the
        // transmitter goes with it, so subsequent transmit_frame calls
        // see SessionClosed.
        drop(session);
        sys_info!(&app, "connection", "disconnected from {addr}");
    }
    connection_state::remove_and_emit(&app, retired);
}

/// How long the whole exit-time disconnect may take. Generous enough
/// for a healthy session to close over loopback or a LAN, short enough
/// that a wedged or unreachable server can't make quitting feel stuck.
const EXIT_DISCONNECT_BUDGET: std::time::Duration = std::time::Duration::from_millis(500);

/// End every active session as the app exits, waiting — briefly — for
/// each remote session's worker to finish.
///
/// Without this the process simply dies with its sessions open, and the
/// server has to infer the disconnect from a socket that stopped
/// answering: exactly the shape of a client that crashed. The wait is
/// what makes the difference real (signalling alone is asynchronous, and
/// the process exits far sooner than the worker would get around to it),
/// and [`EXIT_DISCONNECT_BUDGET`] is what keeps it from delaying the
/// exit when the server is gone.
///
/// No connection-state event is emitted: the webview this would notify
/// is already on its way out.
pub(crate) fn disconnect_on_exit(app: &AppHandle) {
    let state: State<'_, AppState> = app.state();
    let sessions = state.unregister_sessions(None);
    if sessions.is_empty() {
        return;
    }
    let deadline = std::time::Instant::now() + EXIT_DISCONNECT_BUDGET;
    for (addr, mut session) in sessions {
        session.stop.store(true, Ordering::Relaxed);
        let Some(handle) = session.handle.take() else {
            continue; // in-process session — nothing on the wire to close
        };
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if handle.shutdown_timeout(remaining) {
            tracing::info!(address = %addr, "disconnected on exit");
        } else {
            tracing::warn!(address = %addr, "session did not close within the exit budget");
        }
    }
}

/// Decide how to route an incoming frame given the per-channel bus
/// mapping. Returns `Some(bus_id)` to stamp the frame with that bus,
/// or `None` to drop the frame — a channel the mapping does not name
/// has no bus, and a CAN frame without a bus is not a thing this host
/// stores. The import dialog's "(skip)" is spelled the same way: the
/// caller simply leaves the channel out.
///
/// Pure helper so the pump's routing decision is unit-testable without
/// spinning up a Tauri runtime.
pub(crate) fn route_channel(channel: u8, mapping: &[(u8, String)]) -> Option<String> {
    mapping
        .iter()
        .find(|(ch, _)| *ch == channel)
        .map(|(_, bid)| bid.clone())
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
// `channel_to_bus` is the source's per-channel logical-bus mapping.
// On each frame the pump tags it with the bus_id matching its
// `channel`; a channel with no entry is dropped, which is both the
// import dialog's "skip" choice and the answer for a channel nobody
// mapped.
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn run_pump<S>(
    app: &AppHandle,
    mut source: S,
    stop: Arc<AtomicBool>,
    channel_to_bus: Vec<(u8, String)>,
    replay_origin: bool,
    mut progress: Option<ImportProgress>,
) -> Option<u64>
where
    S: CanFrameSource,
    S::Error: fmt::Display,
{
    let state: State<'_, AppState> = app.state();
    // Bus errors are coalesced host-side for display (ADR 0035). The
    // frames still go into the store below like any other frame — the
    // summary is produced *beside* them, never instead of them, so a
    // saved capture keeps every error frame that was received.
    let health = app.try_state::<crate::bus_health::BusHealth>();
    let mut total: u64 = 0;
    // For replay sources (BLF, MDF) the session timeline is the file's
    // own; `anchor` tracks the earliest timestamp seen so far, which is
    // the origin (ADR 0024). Live sources keep the wall-clock
    // session-start the GUI set via `clear_trace_store` before
    // connecting, so they never anchor here.
    let mut anchor: Option<u64> = None;

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        // Determinate progress for a replay (`None` for a live session,
        // which has no end to be a fraction of). It reports what the
        // *source* has read, not `total` below: an import range or a
        // skipped channel drops frames after the read, and the census's
        // count — the denominator — counted what was read.
        if let Some(progress) = &mut progress {
            if progress.checkpoint() {
                if let Some(frames_read) = source.frames_read() {
                    progress.report(app, frames_read);
                }
            }
        }
        match source.next_frame() {
            Ok(Some(frame)) => {
                let mut raw = RawTraceFrame::from(frame);
                match route_channel(raw.channel, &channel_to_bus) {
                    Some(bid) => raw.bus_id = Some(bid),
                    None => continue, // no bus for this channel: drop
                }
                if replay_origin && anchor_replay_session(&state, &mut anchor, raw.timestamp_ns) {
                    restamp_scratch_for_capture(&state);
                    // This frame mints a new capture, so the previous
                    // one's health has nothing left to describe.
                    if let Some(health) = health.as_ref() {
                        health.clear();
                    }
                }
                if matches!(raw.payload, cannet_core::CanFramePayload::Error) {
                    if let (Some(health), Some(bus_id)) = (health.as_ref(), raw.bus_id.as_deref()) {
                        health.observe_error(bus_id, raw.timestamp_ns);
                    }
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
                return anchor;
            }
        }
    }

    sys_info!(
        app,
        "connection",
        "frame source ended cleanly ({total} frames)"
    );
    // The store's own length, read here rather than left to the next
    // `trace-grew` tick: this is the count the frontend freezes an
    // ended import's windows at, and the sampler is up to a tick behind.
    let count = u64::try_from(state.trace_store.len()).unwrap_or(u64::MAX);
    let _ = app.emit("log-finished", LogFinished::Ok { total, count });
    anchor
}

/// Keep `anchor` — and the trace store's session origin — at the
/// **earliest** timestamp this import has brought in (ADR 0024).
///
/// Returns `true` exactly once, on the frame that mints the capture:
/// the caller restamps the scratch for it. A later frame stamped
/// *before* the anchor lowers the origin instead of starting a new
/// session, which is what keeps the frames already appended.
///
/// The first frame read is not reliably the earliest one. BLF promises
/// no ordering between objects, and an interleaved multi-bus capture
/// saved back out carries that interleaving; anchoring on it left every
/// earlier frame below the origin, where `TraceStore::append`'s
/// pipeline-drain guard silently dropped it and any annotation at the
/// same instant rendered negative.
pub(crate) fn anchor_replay_session(
    state: &AppState,
    anchor: &mut Option<u64>,
    ts_ns: u64,
) -> bool {
    match *anchor {
        None => {
            *anchor = Some(ts_ns);
            state.trace_store.start_session(ts_ns);
            true
        }
        Some(current) if ts_ns < current => {
            *anchor = Some(ts_ns);
            state.trace_store.lower_session_start(ts_ns);
            false
        }
        Some(_) => false,
    }
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
            if b == bus_id {
                if let Some((_, iid)) = session.channel_to_interface.iter().find(|(c, _)| c == ch) {
                    if interface_is_unavailable(session, iid) {
                        continue;
                    }
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

/// Whether the peer last said its driver can no longer reach
/// `interface_id`.
///
/// The subscription, the binding and the session all survive an adapter
/// being unplugged, so nothing else in the route makes it stop
/// resolving — and a route that keeps resolving keeps appending
/// tx-confirm rows for frames no wire ever carried. This is the one
/// signal that says the far end is gone, and it is deliberately narrow:
/// a controller over the warning limit, error-passive or even bus-off is
/// present and recovers on its own as its counters fall, so it keeps its
/// route (ADR 0039).
fn interface_is_unavailable(session: &RemoteSession, interface_id: &str) -> bool {
    session
        .controllers
        .as_ref()
        .and_then(|c| c.get(interface_id))
        .is_some_and(|status| {
            status.state == cannet_client::controller::ControllerState::Unavailable
        })
}

/// Why `bus_id` has no route, when the reason is that its interface has
/// gone unreachable rather than that nothing binds it. Only the wording
/// of a transmit failure needs this — the scheduler's park (ADR 0039)
/// treats every route loss alike.
pub(crate) fn unreachable_interface_for_bus(
    sessions: &std::collections::HashMap<String, RemoteSession>,
    bus_id: &str,
) -> Option<String> {
    for session in sessions.values() {
        for (ch, b) in &session.channel_to_bus {
            if b == bus_id {
                if let Some((_, iid)) = session.channel_to_interface.iter().find(|(c, _)| c == ch) {
                    if interface_is_unavailable(session, iid) {
                        return Some(iid.clone());
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod connect_outcome_tests {
    use super::*;

    fn binding(iface: &str, bus: &str) -> InterfaceBusBinding {
        InterfaceBusBinding {
            interface: iface.into(),
            bus_id: bus.into(),
            speed_bps: None,
            fd: None,
            fd_data_speed_bps: None,
        }
    }

    #[test]
    fn a_binding_the_server_does_not_expose_is_reported_not_dropped() {
        // The VN17xx shape: four bound channels, one of which the
        // server's enumeration doesn't carry. Before this split the
        // subscription `filter_map` dropped that binding on the floor —
        // the bus never saw a frame while the panel read "connected".
        let bindings = vec![
            binding("vector:VN1780(ch:0)", "b1"),
            binding("vector:VN1780(ch:1)", "b2"),
            binding("vector:VN1780(ch:2)", "b3"),
            binding("vector:VN1780(ch:3)", "b4"),
        ];
        let exposed = vec![
            "vector:VN1780(ch:0)".to_string(),
            "vector:VN1780(ch:2)".to_string(),
            "vector:VN1780(ch:3)".to_string(),
        ];
        let (available, unavailable) = split_by_availability(&bindings, &exposed);
        assert_eq!(
            available.iter().map(|b| &b.bus_id).collect::<Vec<_>>(),
            ["b1", "b3", "b4"],
        );
        assert_eq!(
            unavailable.iter().map(|b| &b.bus_id).collect::<Vec<_>>(),
            ["b2"],
            "the missing channel's bus must be nameable so it can carry its own error",
        );
    }

    #[test]
    fn every_binding_available_leaves_nothing_unavailable() {
        let bindings = vec![binding("a", "b1")];
        let exposed = vec!["a".to_string(), "b".to_string()];
        let (available, unavailable) = split_by_availability(&bindings, &exposed);
        assert_eq!(available.len(), 1);
        assert!(unavailable.is_empty());
    }

    #[test]
    fn an_unpinned_bus_reports_that_nothing_was_sent() {
        // Neither speed nor FD pinned => `presubscribe_config_from` is
        // `None` => no `ConfigureBus` on the wire at all. The row must
        // say "driver default", not echo the placeholder the input
        // showed.
        let b = binding("a", "b1");
        assert!(presubscribe_config_from(&b).is_none());
        assert_eq!(
            applied_config_from(&b),
            AppliedBusConfig {
                speed_bps: None,
                fd_enabled: false,
                fd_data_speed_bps: None,
            },
        );
    }

    #[test]
    fn a_classic_bus_echoes_its_nominal_rate_and_no_data_rate() {
        let mut b = binding("a", "b1");
        b.speed_bps = Some(250_000);
        // An FD data rate left over from a bus that has since been
        // switched back to classic is not on the wire as a data rate,
        // so it must not be echoed as one.
        b.fd_data_speed_bps = Some(2_000_000);
        assert_eq!(
            applied_config_from(&b),
            AppliedBusConfig {
                speed_bps: Some(250_000),
                fd_enabled: false,
                fd_data_speed_bps: None,
            },
        );
    }

    #[test]
    fn an_fd_bus_without_a_data_rate_echoes_the_nominal_rate() {
        // A wire `fd_data_speed_bps` of 0 means "same as nominal" — the
        // normalisation the user cannot see from the (blank) input.
        let mut b = binding("a", "b1");
        b.speed_bps = Some(500_000);
        b.fd = Some(true);
        assert_eq!(
            applied_config_from(&b),
            AppliedBusConfig {
                speed_bps: Some(500_000),
                fd_enabled: true,
                fd_data_speed_bps: Some(500_000),
            },
        );
    }

    #[test]
    fn an_fd_only_bus_reports_the_zero_nominal_it_actually_sends() {
        // FD pinned but no bitrate: `presubscribe_config_from` sends
        // `speed_bps: 0`, which the sidecar reads as "unset". The echo
        // reports the 0 rather than pretending a rate was chosen.
        let mut b = binding("a", "b1");
        b.fd = Some(true);
        assert_eq!(
            applied_config_from(&b),
            AppliedBusConfig {
                speed_bps: Some(0),
                fd_enabled: true,
                fd_data_speed_bps: Some(0),
            },
        );
    }
}
