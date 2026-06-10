//! Virtual-bus gRPC server: multi-client sessions over an in-process
//! [`cannet_core::SharedBus`] (ADR 0021).
//!
//! Each accepted [`tonic`] session is independent. Subscribing to the
//! factory interface id allocates a fresh participant on the bus and
//! returns the allocated id via [`Body::InterfaceAllocated`]; that id
//! becomes the wire address the client uses for subsequent
//! `FrameBatch` envelopes. Fan-out of one participant's transmits to
//! every other participant flows back to each subscriber's session as
//! `FrameBatch` envelopes tagged with the sender's allocated id. A
//! transmit reaching zero recipients turns into an
//! [`Code::NoAcknowledger`] envelope to the originator.
//!
//! ## Bridges
//!
//! `Body::AttachBridge { remote_address, interface_id, name }` from
//! any session installs a bridge that fronts the named interface on a
//! remote wire endpoint (ADR 0021 § "Bridge installation"). The
//! orchestration runs entirely server-side: the bridge opens a
//! [`crate::bridge_client::BridgeRemote`] session, hands the
//! resulting sink/source pair to
//! [`cannet_core::SharedBus::attach_bridge`], and registers the
//! installed bridge so a later `DetachBridge { name }` can tear it
//! down. The bridge is exposed in `ListInterfaces` /
//! `WatchInterfaces` as `virtual:bus0/bridge-<name>`; every open
//! `WatchInterfaces` stream pushes a fresh snapshot on every
//! topology change.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use cannet_core::{BridgeHandle, BusConfig, LocalSink, ParticipantEvent, ParticipantId, SharedBus};
use cannet_wire::{
    frame_to_proto,
    proto::{
        cannet_server_server::{CannetServer as CannetServerTrait, CannetServerServer},
        envelope::Body,
        error::Code,
        AttachBridge, DetachBridge, Envelope, Error as ErrorMsg, FrameBatch,
        Interface as ProtoInterface, InterfaceAllocated, InterfaceList, ListInterfacesRequest,
        Subscribe, Unsubscribe, WatchInterfacesRequest,
    },
    proto_to_frame,
};
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};

use crate::bridge_client::{BridgeRemote, BridgeShutdown};

/// Factory interface id every virtual-bus server publishes.
/// Subscribing to it allocates a fresh participant.
pub const VIRTUAL_BUS_FACTORY_ID: &str = "virtual:bus0";

/// Display label for the factory interface in `ListInterfaces`.
const VIRTUAL_BUS_DISPLAY_NAME: &str = "Virtual bus 0";

/// Channel depth for the per-session outgoing envelope queue. Same
/// shape as the BLF replay server — a natural backpressure point that
/// propagates into HTTP/2 flow control.
const OUTGOING_CHANNEL_DEPTH: usize = 64;

/// Channel depth for the topology-change broadcast. The actual signal
/// is unit-typed; subscribers re-snapshot on receipt. Generous because
/// a Lagged error is benign here (the latest snapshot is what we want),
/// but spurious lag is still noise.
const TOPOLOGY_BROADCAST_DEPTH: usize = 8;

/// gRPC service implementation for the virtual-bus mode.
///
/// Construct with [`VirtualBusServerImpl::new`] and mount on a
/// `tonic::transport::Server` via [`Self::into_service`]. The bus's
/// arbitration-phase / FD config is set at construction time and is
/// not reconfigurable over the wire — `ConfigureBus` envelopes
/// targeting the virtual-bus server are silently dropped (ADR 0021
/// § "Server roles").
pub struct VirtualBusServerImpl {
    inner: Arc<ServerInner>,
}

/// Shared state every per-session task holds onto. Wrapped in an `Arc`
/// so cloning into spawned tasks is cheap and lock-free.
struct ServerInner {
    bus: Arc<SharedBus>,
    fd_capable: bool,
    bridges: Mutex<HashMap<String, BridgeEntry>>,
    /// Fires `()` on every topology change. `WatchInterfaces`
    /// subscribers re-snapshot on receipt.
    topology_changed: broadcast::Sender<()>,
}

/// One installed bridge. Held only for `Drop` side-effects:
/// `_remote` aborts the bridge client's pump tasks (their futures
/// drop, closing the inbound sender that signals end-of-stream to the
/// bus's ingress thread); `_handle` removes the bridge participant
/// from the bus (closing `events_tx` so the egress thread exits) and
/// detaches the ingress/egress threads. Field order picks `_remote`
/// first so the end-of-stream signal lands before `_handle`'s
/// participant removal, but neither drop blocks the caller.
struct BridgeEntry {
    _remote: BridgeShutdown,
    _handle: BridgeHandle,
}

impl VirtualBusServerImpl {
    /// Construct a fresh virtual-bus server with the given initial
    /// bus configuration. The factory interface is published as
    /// FD-capable iff `config.fd_enabled` is `true`.
    #[must_use]
    pub fn new(config: BusConfig) -> Self {
        let fd_capable = config.fd_enabled;
        let (topology_changed, _) = broadcast::channel::<()>(TOPOLOGY_BROADCAST_DEPTH);
        Self {
            inner: Arc::new(ServerInner {
                bus: Arc::new(SharedBus::new(config)),
                fd_capable,
                bridges: Mutex::new(HashMap::new()),
                topology_changed,
            }),
        }
    }

    /// Wrap this impl in the tonic `CannetServerServer` for mounting
    /// on a `Server::builder()` chain.
    #[must_use]
    pub fn into_service(self) -> CannetServerServer<Self> {
        CannetServerServer::new(self)
    }
}

impl ServerInner {
    fn snapshot_interfaces(&self) -> InterfaceList {
        let bridges = self.bridges.lock().expect("bridges lock poisoned");
        let mut interfaces = Vec::with_capacity(1 + bridges.len());
        interfaces.push(ProtoInterface {
            id: VIRTUAL_BUS_FACTORY_ID.to_string(),
            display_name: VIRTUAL_BUS_DISPLAY_NAME.to_string(),
            fd_capable: self.fd_capable,
        });
        // Deterministic order so tests and humans see a stable list.
        let mut names: Vec<&String> = bridges.keys().collect();
        names.sort();
        for name in names {
            let id = bridge_interface_id(name);
            interfaces.push(ProtoInterface {
                id,
                display_name: format!("Bridge {name}"),
                // Defer FD-capability of the underlying remote to the
                // controller. For a virtual-bus-to-virtual-bus bridge,
                // FD capability follows the local bus's FD-enable.
                fd_capable: self.fd_capable,
            });
        }
        InterfaceList { interfaces }
    }

    fn signal_topology_changed(&self) {
        // Lagged receivers will re-snapshot the next time they poll,
        // so the send-error case is benign (no subscribers).
        let _ = self.topology_changed.send(());
    }
}

/// Wire interface id for an installed bridge (ADR 0021 § "Wire
/// addressing"). Bridges are listed as `virtual:bus0/bridge-<name>`.
fn bridge_interface_id(name: &str) -> String {
    format!("{VIRTUAL_BUS_FACTORY_ID}/bridge-{name}")
}

#[tonic::async_trait]
impl CannetServerTrait for VirtualBusServerImpl {
    async fn list_interfaces(
        &self,
        _request: Request<ListInterfacesRequest>,
    ) -> Result<Response<InterfaceList>, Status> {
        Ok(Response::new(self.inner.snapshot_interfaces()))
    }

    type WatchInterfacesStream = ReceiverStream<Result<InterfaceList, Status>>;

    /// Emit the initial snapshot, then push a fresh snapshot on every
    /// topology change. The stream stays open for the lifetime of the
    /// subscription; dropping it tears down the per-watcher task.
    async fn watch_interfaces(
        &self,
        _request: Request<WatchInterfacesRequest>,
    ) -> Result<Response<Self::WatchInterfacesStream>, Status> {
        let (tx, rx) = mpsc::channel(1);
        let inner = self.inner.clone();
        let mut topology_rx = inner.topology_changed.subscribe();
        tokio::spawn(async move {
            // Initial snapshot — the watcher contract guarantees one
            // even when nothing has changed yet (ADR 0016).
            if tx.send(Ok(inner.snapshot_interfaces())).await.is_err() {
                return;
            }
            loop {
                match topology_rx.recv().await {
                    Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Either kind of wake-up means "the snapshot
                        // may have changed; re-send it." Lagged just
                        // means we missed intermediate signals; the
                        // current snapshot is still the right answer.
                        if tx.send(Ok(inner.snapshot_interfaces())).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
        Ok(Response::new(ReceiverStream::new(rx)))
    }

    type SessionStream = ReceiverStream<Result<Envelope, Status>>;

    async fn session(
        &self,
        request: Request<Streaming<Envelope>>,
    ) -> Result<Response<Self::SessionStream>, Status> {
        let incoming = request.into_inner();
        let (outgoing, rx) = mpsc::channel(OUTGOING_CHANNEL_DEPTH);
        let inner = self.inner.clone();
        tokio::spawn(async move {
            run_session(incoming, outgoing, inner).await;
        });
        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

/// Translate a bus-side [`ParticipantId`] into its wire address
/// (`virtual:bus0/p<n>`).
fn allocated_interface_id(id: ParticipantId) -> String {
    format!("{VIRTUAL_BUS_FACTORY_ID}/p{id}")
}

/// One participant a session owns. Dropping the holder detaches the
/// participant (`LocalSink::drop`); the drain thread sees its source
/// close and exits on its own. The handle is held so the thread isn't
/// orphaned across an early panic in the session task — we don't
/// otherwise wait on it.
struct ParticipantHolder {
    sink: LocalSink,
    _drain: JoinHandle<()>,
}

// One coherent dispatch loop over an envelope stream; splitting it
// into per-variant async helpers buys nothing but indirection.
#[allow(clippy::too_many_lines)]
async fn run_session(
    mut incoming: Streaming<Envelope>,
    outgoing: mpsc::Sender<Result<Envelope, Status>>,
    inner: Arc<ServerInner>,
) {
    // Keyed by the allocated wire id (`virtual:bus0/p<n>`); a session
    // may hold multiple participants concurrently.
    let mut participants: HashMap<String, ParticipantHolder> = HashMap::new();

    while let Ok(Some(envelope)) = incoming.message().await {
        let Some(body) = envelope.body else { continue };
        match body {
            Body::Subscribe(Subscribe { interface_id }) => {
                if interface_id != VIRTUAL_BUS_FACTORY_ID {
                    let _ = outgoing
                        .send(Ok(error_envelope(
                            Code::UnknownInterface,
                            format!("no such interface: {interface_id}"),
                        )))
                        .await;
                    continue;
                }
                let (sink, source) = inner.bus.attach_participant();
                let allocated = allocated_interface_id(sink.id());
                // Tell the client which id they got.
                if outgoing
                    .send(Ok(Envelope {
                        body: Some(Body::InterfaceAllocated(InterfaceAllocated {
                            interface_id: allocated.clone(),
                        })),
                    }))
                    .await
                    .is_err()
                {
                    return;
                }
                let drain = spawn_drain(source, outgoing.clone(), allocated.clone());
                participants.insert(
                    allocated,
                    ParticipantHolder {
                        sink,
                        _drain: drain,
                    },
                );
            }
            Body::Unsubscribe(Unsubscribe { interface_id }) => {
                // Dropping the holder detaches the participant; the
                // drain thread sees `next_event` return `None` once
                // the bus closes its end and exits on its own.
                participants.remove(&interface_id);
            }
            Body::FrameBatch(batch) => {
                let Some(holder) = participants.get_mut(&batch.interface_id) else {
                    let _ = outgoing
                        .send(Ok(error_envelope(
                            Code::NotSubscribed,
                            format!("not subscribed: {}", batch.interface_id),
                        )))
                        .await;
                    continue;
                };
                let mut frames = Vec::with_capacity(batch.frames.len());
                let mut decode_err = None;
                for proto_frame in batch.frames {
                    match proto_to_frame(&proto_frame, 0) {
                        Ok(f) => frames.push(f),
                        Err(e) => {
                            decode_err = Some(e);
                            break;
                        }
                    }
                }
                if let Some(e) = decode_err {
                    let _ = outgoing
                        .send(Ok(error_envelope(
                            Code::TxRejected,
                            format!("invalid frame: {e}"),
                        )))
                        .await;
                    continue;
                }
                if frames.is_empty() {
                    continue;
                }
                if holder.sink.submit_batch(frames).is_err() {
                    let _ = outgoing
                        .send(Ok(error_envelope(Code::TxRejected, "bus closed".into())))
                        .await;
                }
            }
            Body::AttachBridge(AttachBridge {
                remote_address,
                interface_id,
                name,
            }) => {
                if let Err(reply) =
                    handle_attach_bridge(&inner, &remote_address, &interface_id, &name).await
                {
                    let _ = outgoing.send(Ok(reply)).await;
                }
            }
            Body::DetachBridge(DetachBridge { name }) => {
                handle_detach_bridge(&inner, &name);
            }
            // Client `Error` / `Log` are informational here. The
            // virtual-bus server doesn't model controller config or
            // controller state, so `ConfigureBus` and `InterfaceState`
            // are silently ignored — those concerns belong to the
            // hardware server (ADR 0021 § "Server roles"). The
            // server→client envelope `InterfaceAllocated` a peer might
            // echo is dropped.
            Body::Error(_)
            | Body::Log(_)
            | Body::ConfigureBus(_)
            | Body::InterfaceAllocated(_)
            | Body::InterfaceState(_) => {}
        }
    }

    // Session end — detach every participant (LocalSink Drop runs)
    // so each drain thread sees `next_event() == None` and exits.
    // We don't explicitly join the drain threads; they run to
    // completion on their own once their sources close.
    participants.clear();
}

/// Install a bridge by `name` connecting the local bus to
/// `interface_id` on a remote wire endpoint at `remote_address`.
/// Returns `Ok(())` on success; `Err(reply)` to forward an error
/// envelope back on the requesting session.
async fn handle_attach_bridge(
    inner: &Arc<ServerInner>,
    remote_address: &str,
    interface_id: &str,
    name: &str,
) -> Result<(), Envelope> {
    if name.is_empty() {
        return Err(error_envelope(
            Code::TxRejected,
            "AttachBridge.name must be non-empty".into(),
        ));
    }
    {
        let bridges = inner.bridges.lock().expect("bridges lock poisoned");
        if bridges.contains_key(name) {
            return Err(error_envelope(
                Code::TxRejected,
                format!("bridge name already in use: {name}"),
            ));
        }
    }

    let (sink, source, remote) = BridgeRemote::connect(remote_address, interface_id)
        .await
        .map_err(|e| error_envelope(Code::TxRejected, format!("bridge connect failed: {e}")))?;

    let handle = inner.bus.attach_bridge(name, sink, source);

    let entry = BridgeEntry {
        _remote: remote,
        _handle: handle,
    };
    {
        let mut bridges = inner.bridges.lock().expect("bridges lock poisoned");
        if bridges.contains_key(name) {
            // entry drops here, tearing down the freshly-installed
            // bridge cleanly (pump tasks aborted, bus participant
            // removed).
            return Err(error_envelope(
                Code::TxRejected,
                format!("bridge name already in use: {name}"),
            ));
        }
        bridges.insert(name.to_string(), entry);
    }
    inner.signal_topology_changed();
    Ok(())
}

/// Remove the installed bridge `name`. Idempotent: detaching an
/// unknown name is a silent no-op at the wire level.
fn handle_detach_bridge(inner: &Arc<ServerInner>, name: &str) {
    let removed = {
        let mut bridges = inner.bridges.lock().expect("bridges lock poisoned");
        bridges.remove(name)
    };
    if let Some(entry) = removed {
        // Drop outside the lock — runtime shutdown + bridge handle join
        // can take a moment; we don't want to hold the registry lock
        // against ListInterfaces during that.
        drop(entry);
        inner.signal_topology_changed();
    }
}

/// Spawn a blocking thread that drains a [`cannet_core::LocalSource`]
/// and forwards its events to the session's outgoing channel as
/// envelopes addressed by the wire `interface_id`.
fn spawn_drain(
    mut source: cannet_core::LocalSource,
    outgoing: mpsc::Sender<Result<Envelope, Status>>,
    allocated: String,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name(format!("cannet-vbus-drain[{allocated}]"))
        .spawn(move || {
            while let Some(event) = source.next_event() {
                let envelope = match event {
                    ParticipantEvent::Frame { frame, sender } => Envelope {
                        body: Some(Body::FrameBatch(FrameBatch {
                            interface_id: allocated_interface_id(sender),
                            frames: vec![frame_to_proto(&frame)],
                        })),
                    },
                    ParticipantEvent::NoAcknowledger(_) => Envelope {
                        body: Some(Body::Error(ErrorMsg {
                            code: Code::NoAcknowledger as i32,
                            message: format!("no acknowledger on {allocated}"),
                        })),
                    },
                };
                if outgoing.blocking_send(Ok(envelope)).is_err() {
                    return;
                }
            }
        })
        .expect("spawning vbus drain")
}

fn error_envelope(code: Code, message: String) -> Envelope {
    Envelope {
        body: Some(Body::Error(ErrorMsg {
            code: code.into(),
            message,
        })),
    }
}
