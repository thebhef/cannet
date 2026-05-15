//! gRPC client for the Phase-2 cannet wire protocol.
//!
//! The crate adapts the `cannet-wire` gRPC service into the
//! [`cannet_core::CanFrameSource`] trait the rest of the analyzer is
//! built around — so the GUI's existing trace pipeline can consume a
//! remote server with no changes other than swapping the source.
//!
//! ## Surface
//!
//! - [`list_interfaces`]: async one-shot RPC. Connects, calls
//!   `ListInterfaces`, disconnects. The GUI uses this to populate its
//!   connection panel.
//! - [`connect_and_subscribe`]: sync constructor for a long-lived
//!   session. Spawns a dedicated worker thread that owns its own
//!   single-thread tokio runtime, opens `Session`, subscribes to the
//!   requested interfaces, and pumps incoming `FrameBatch` envelopes
//!   into a sync mpsc queue.
//! - [`RemoteCanFrameSource`]: implements [`CanFrameSource`]. Calls to
//!   [`RemoteCanFrameSource::next_frame`] block on the queue, returning
//!   `Ok(Some(_))` for each frame, `Ok(None)` when the session ends
//!   cleanly, and `Err(_)` if the server reports an in-band error or
//!   the gRPC stream itself fails.
//!
//! Dropping the source aborts the worker thread's runtime, which cancels
//! the gRPC stream and closes the connection.
//!
//! ## Design choices
//!
//! - **Worker thread, not nested runtime.** The Tauri host already runs
//!   a tokio runtime; creating another from inside it would panic. A
//!   dedicated OS thread with its own current-thread runtime side-steps
//!   that, and gives the client a clean place to live without
//!   borrowing the host's executor.
//! - **`interface_id → channel` mapping is the caller's.** The wire
//!   addresses interfaces by string (`"blf:0"`); `CanFrame` carries a
//!   numeric `channel: u8`. Step-3 callers tell the client which wire
//!   id they want surfaced as which channel via [`Subscription`]. Any
//!   `FrameBatch` for an unsubscribed `interface_id` is dropped.

use std::sync::mpsc;
use std::thread;

use cannet_core::{CanFrame, CanFrameSource};
use cannet_wire::proto::{
    cannet_server_client::CannetServerClient,
    envelope::Body,
    Envelope, FrameBatch, ListInterfacesRequest, Subscribe,
};
use cannet_wire::{frame_to_proto, proto_to_frame, ProtoConversionError};
use tokio::sync::mpsc as tokio_mpsc;
use tokio::sync::oneshot;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

/// Outgoing-envelope channel depth for the per-session request stream.
/// Subscribes are bursty at startup; this gives them room without
/// blocking the worker thread before the stream is up.
const REQUEST_CHANNEL_DEPTH: usize = 16;

/// One entry in a [`connect_and_subscribe`] subscription request.
#[derive(Debug, Clone)]
pub struct Subscription {
    /// Wire interface to subscribe to (matches `Interface::id` from
    /// [`list_interfaces`]).
    pub interface_id: String,
    /// `CanFrame::channel` to attach to frames received on this
    /// interface. The caller picks the mapping; the wire only carries
    /// `interface_id`.
    pub channel: u8,
}

/// One CAN interface the server exposes. Mirrors
/// `cannet_wire::proto::Interface` so callers don't have to depend on
/// the generated proto types directly.
#[derive(Debug, Clone)]
pub struct Interface {
    pub id: String,
    pub display_name: String,
    pub fd_capable: bool,
}

impl From<cannet_wire::proto::Interface> for Interface {
    fn from(p: cannet_wire::proto::Interface) -> Self {
        Self {
            id: p.id,
            display_name: p.display_name,
            fd_capable: p.fd_capable,
        }
    }
}

/// One-shot connect + `ListInterfaces`. The transport is closed before
/// the function returns.
pub async fn list_interfaces(address: &str) -> Result<Vec<Interface>, ConnectionError> {
    let endpoint = format!("http://{address}");
    let mut client = CannetServerClient::connect(endpoint)
        .await
        .map_err(|e| ConnectionError::Connect(e.to_string()))?;
    let response = client
        .list_interfaces(ListInterfacesRequest {})
        .await
        .map_err(|s| ConnectionError::Status(s.message().into()))?;
    Ok(response
        .into_inner()
        .interfaces
        .into_iter()
        .map(Interface::from)
        .collect())
}

/// Open a long-lived `Session` against `address`, subscribe to every
/// entry in `subscriptions`, and return a sync [`CanFrameSource`]
/// backed by the resulting frame stream.
///
/// Blocks the calling thread until the session is established or the
/// initial connect fails. After this function returns successfully,
/// frames flow into the source in the background; subscription failures
/// (e.g. unknown interface ids) surface on a subsequent
/// [`RemoteCanFrameSource::next_frame`] call.
pub fn connect_and_subscribe(
    address: &str,
    subscriptions: Vec<Subscription>,
) -> Result<RemoteCanFrameSource, ConnectionError> {
    let address = address.to_string();
    let subs_for_thread = subscriptions.clone();
    let (frame_tx, frame_rx) = mpsc::channel::<Result<CanFrame, ConnectionError>>();
    let (ready_tx, ready_rx) = mpsc::sync_channel::<
        Result<tokio_mpsc::Sender<Envelope>, ConnectionError>,
    >(1);
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let thread = thread::Builder::new()
        .name("cannet-client".into())
        .spawn(move || run_worker(address, subs_for_thread, frame_tx, ready_tx, shutdown_rx))
        .map_err(|e| ConnectionError::Thread(e.to_string()))?;

    match ready_rx.recv() {
        Ok(Ok(req_tx)) => Ok(RemoteCanFrameSource {
            receiver: FrameReceiver {
                rx: frame_rx,
                subscriptions,
            },
            handle: SessionHandle {
                shutdown_tx: Some(shutdown_tx),
                _thread: thread,
            },
            transmitter: SessionTransmitter { req_tx },
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(ConnectionError::Thread(
            "client worker thread exited before signalling readiness".into(),
        )),
    }
}

/// The combined receive + shutdown handle returned by
/// [`connect_and_subscribe`].
///
/// Convenient when one piece of code owns the whole session — it
/// implements [`CanFrameSource`] directly. When the receive side and
/// shutdown side need to live in different threads (e.g. a pump
/// thread drains frames while a control surface decides when to
/// disconnect), use [`Self::into_parts`] to split them. Dropping the
/// [`SessionHandle`] from the control thread signals the worker to
/// exit, and the [`FrameReceiver`] in the pump thread observes
/// end-of-stream on its next [`CanFrameSource::next_frame`] call.
pub struct RemoteCanFrameSource {
    receiver: FrameReceiver,
    handle: SessionHandle,
    transmitter: SessionTransmitter,
}

impl RemoteCanFrameSource {
    /// The subscriptions this session was opened with, in the order
    /// they were requested.
    #[must_use]
    pub fn subscriptions(&self) -> &[Subscription] {
        self.receiver.subscriptions()
    }

    /// Split into the shutdown handle, the receive half, and the
    /// transmit half. Drop the [`SessionHandle`] to disconnect; the
    /// [`FrameReceiver`] will observe end-of-stream on its next
    /// [`CanFrameSource::next_frame`] call. The [`SessionTransmitter`]
    /// is what a transmit panel uses to push frames onto the wire.
    #[must_use]
    pub fn into_parts(self) -> (SessionHandle, FrameReceiver, SessionTransmitter) {
        let Self {
            receiver,
            handle,
            transmitter,
        } = self;
        (handle, receiver, transmitter)
    }
}

impl CanFrameSource for RemoteCanFrameSource {
    type Error = ConnectionError;

    fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
        self.receiver.next_frame()
    }
}

/// Receive half of a remote session. Implements [`CanFrameSource`]
/// blockingly: `Ok(Some(frame))` per delivered frame, `Ok(None)` once
/// the worker exits (cleanly or via [`SessionHandle`] drop), `Err(_)`
/// for an in-band server error or transport failure.
pub struct FrameReceiver {
    rx: mpsc::Receiver<Result<CanFrame, ConnectionError>>,
    subscriptions: Vec<Subscription>,
}

impl FrameReceiver {
    /// The subscriptions this session was opened with, in the order
    /// they were requested.
    #[must_use]
    pub fn subscriptions(&self) -> &[Subscription] {
        &self.subscriptions
    }
}

impl CanFrameSource for FrameReceiver {
    type Error = ConnectionError;

    fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
        match self.rx.recv() {
            Ok(Ok(frame)) => Ok(Some(frame)),
            Ok(Err(e)) => Err(e),
            Err(_) => Ok(None),
        }
    }
}

/// Transmit half of a remote session. Cloneable so a cyclic scheduler
/// and an interactive panel can both push frames through the same
/// session without coordinating ownership.
///
/// `transmit` enqueues a single-frame `FrameBatch` envelope on the
/// session's outgoing channel. The wire's batching is sender-side
/// only — the server unbatches — so one frame per call is fine.
///
/// Returns `Err(SessionClosed)` once the worker thread has shut down
/// (the user dropped the [`SessionHandle`], the server hung up, or a
/// transport failure tore the session down). A pending in-band server
/// error like `Error::TX_REJECTED` does *not* close the session — the
/// client sees the rejection through [`FrameReceiver::next_frame`]'s
/// `ConnectionError::Server` variant.
#[derive(Clone)]
pub struct SessionTransmitter {
    req_tx: tokio_mpsc::Sender<Envelope>,
}

impl SessionTransmitter {
    /// Send `frame` over the session, addressed to `interface_id`.
    pub fn transmit(&self, interface_id: &str, frame: &CanFrame) -> Result<(), SessionClosed> {
        let envelope = Envelope {
            body: Some(Body::FrameBatch(FrameBatch {
                interface_id: interface_id.to_string(),
                frames: vec![frame_to_proto(frame)],
            })),
        };
        // `blocking_send` waits if the queue is full but errors if the
        // receive side has been dropped — which is exactly what
        // "session closed" means here. Called from a synchronous Tauri
        // command, never from inside the runtime, so blocking is fine.
        self.req_tx
            .blocking_send(envelope)
            .map_err(|_| SessionClosed)
    }
}

/// Returned by [`SessionTransmitter::transmit`] when the session is
/// no longer alive — typically because the user disconnected, the
/// server hung up, or a transport-level failure tore the session down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionClosed;

impl std::fmt::Display for SessionClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("remote session is closed")
    }
}

impl std::error::Error for SessionClosed {}

/// Shutdown handle for a remote session. Drop it (or call
/// [`Self::shutdown`]) to disconnect; the worker thread exits and any
/// [`FrameReceiver`] sharing the same session sees `Ok(None)` from its
/// next [`CanFrameSource::next_frame`] call.
pub struct SessionHandle {
    shutdown_tx: Option<oneshot::Sender<()>>,
    _thread: thread::JoinHandle<()>,
}

impl SessionHandle {
    /// Synchronously signal the worker to disconnect. Equivalent to
    /// dropping the handle; provided for explicitness at call sites.
    pub fn shutdown(self) {
        // Drop fires here, sending the signal.
    }
}

impl Drop for SessionHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            // Best-effort: the receiver may already have woken on its
            // own (e.g. the server closed the stream).
            let _ = tx.send(());
        }
    }
}

fn run_worker(
    address: String,
    subscriptions: Vec<Subscription>,
    frame_tx: mpsc::Sender<Result<CanFrame, ConnectionError>>,
    ready_tx: mpsc::SyncSender<Result<tokio_mpsc::Sender<Envelope>, ConnectionError>>,
    shutdown_rx: oneshot::Receiver<()>,
) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            let _ = ready_tx.send(Err(ConnectionError::Runtime(e.to_string())));
            return;
        }
    };
    runtime.block_on(async move {
        run_session(address, subscriptions, frame_tx, ready_tx, shutdown_rx).await;
    });
}

async fn run_session(
    address: String,
    subscriptions: Vec<Subscription>,
    frame_tx: mpsc::Sender<Result<CanFrame, ConnectionError>>,
    ready_tx: mpsc::SyncSender<Result<tokio_mpsc::Sender<Envelope>, ConnectionError>>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    let endpoint = format!("http://{address}");
    let mut client = match CannetServerClient::connect(endpoint).await {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(ConnectionError::Connect(e.to_string())));
            return;
        }
    };

    let (req_tx, req_rx) = tokio_mpsc::channel::<Envelope>(REQUEST_CHANNEL_DEPTH);
    for sub in &subscriptions {
        let envelope = Envelope {
            body: Some(Body::Subscribe(Subscribe {
                interface_id: sub.interface_id.clone(),
            })),
        };
        if req_tx.send(envelope).await.is_err() {
            let _ = ready_tx.send(Err(ConnectionError::Session(
                "request channel closed before subscribes were sent".into(),
            )));
            return;
        }
    }

    let response = match client.session(ReceiverStream::new(req_rx)).await {
        Ok(r) => r,
        Err(s) => {
            let _ = ready_tx.send(Err(ConnectionError::Status(s.message().into())));
            return;
        }
    };

    // Hand a clone of the request sender back to the caller through
    // the ready channel — this is what a `SessionTransmitter` wraps.
    // Keep our own clone alive locally so the bidi request half stays
    // open for the session's lifetime even after every external
    // [`SessionTransmitter`] is dropped (a tx-only session is still
    // valid; the server just won't see anything from us, but the
    // receive half keeps streaming).
    let _ = ready_tx.send(Ok(req_tx.clone()));

    let mut id_to_channel = std::collections::HashMap::with_capacity(subscriptions.len());
    for sub in &subscriptions {
        id_to_channel.insert(sub.interface_id.clone(), sub.channel);
    }

    // Keep the request side of the bidi stream alive for the session's
    // lifetime — dropping it would close the request half early.
    let _req_tx = req_tx;

    let mut stream = response.into_inner();
    loop {
        tokio::select! {
            biased;
            // Treat a shutdown signal as the highest-priority branch so a
            // pending FrameBatch in the stream can't keep the worker
            // alive after the user has dropped the source.
            _ = &mut shutdown_rx => return,
            message = stream.next() => match message {
                Some(Ok(envelope)) => match envelope.body {
                    Some(Body::FrameBatch(batch)) => {
                        let Some(channel) = id_to_channel.get(&batch.interface_id).copied() else {
                            continue;
                        };
                        for proto_frame in batch.frames {
                            match proto_to_frame(&proto_frame, channel) {
                                Ok(frame) => {
                                    if frame_tx.send(Ok(frame)).is_err() {
                                        return;
                                    }
                                }
                                Err(e) => {
                                    let _ = frame_tx.send(Err(ConnectionError::Decode(e)));
                                    return;
                                }
                            }
                        }
                    }
                    Some(Body::Error(err)) => {
                        let _ = frame_tx.send(Err(ConnectionError::Server {
                            code: err.code,
                            message: err.message,
                        }));
                        return;
                    }
                    // Subscribe / Unsubscribe round-trips (a peer
                    // echoing the request) are ignored; Phase 7's
                    // wire `Log` envelopes have no consumer in this
                    // crate yet (Phase 8 bridges them at the GUI
                    // host); `None` is the no-body case. All drop.
                    Some(
                        Body::Log(_) | Body::Subscribe(_) | Body::Unsubscribe(_),
                    )
                    | None => {}
                },
                Some(Err(status)) => {
                    let _ = frame_tx.send(Err(ConnectionError::Status(status.message().into())));
                    return;
                }
                None => return,
            },
        }
    }
}

/// Errors surfaced by [`list_interfaces`] and
/// [`RemoteCanFrameSource::next_frame`].
#[derive(Debug)]
pub enum ConnectionError {
    /// The gRPC transport failed to connect to the server.
    Connect(String),
    /// The Session RPC could not be opened.
    Session(String),
    /// The server reported a tonic-level status error (transport-layer
    /// failure, mid-stream error, etc.).
    Status(String),
    /// The server reported an in-band [`cannet_wire::proto::Error`]
    /// envelope.
    Server { code: i32, message: String },
    /// A wire frame failed to decode into a `CanFrame`.
    Decode(ProtoConversionError),
    /// Constructing the worker tokio runtime failed.
    Runtime(String),
    /// Spawning the worker thread failed.
    Thread(String),
}

impl std::fmt::Display for ConnectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(m) => write!(f, "failed to connect: {m}"),
            Self::Session(m) => write!(f, "failed to open session: {m}"),
            Self::Status(m) => write!(f, "rpc status error: {m}"),
            Self::Server { code, message } => {
                write!(f, "server error (code {code}): {message}")
            }
            Self::Decode(e) => write!(f, "wire frame decode error: {e}"),
            Self::Runtime(m) => write!(f, "tokio runtime construction failed: {m}"),
            Self::Thread(m) => write!(f, "client worker thread error: {m}"),
        }
    }
}

impl std::error::Error for ConnectionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Decode(e) => Some(e),
            _ => None,
        }
    }
}
