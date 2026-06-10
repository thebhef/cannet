//! Server-internal gRPC client used by [`crate::virtual_bus`] to attach
//! a bridge that fronts a remote interface (ADR 0021 § "Bridge
//! installation"). The orchestrating side opens a `Session` against the
//! remote, subscribes to the named interface, and adapts the resulting
//! envelope stream into a [`CanFrameSink`] + [`CanFrameSource`] pair
//! that [`cannet_core::SharedBus::attach_bridge`] consumes.
//!
//! ## Why a server-internal client
//!
//! This client lives inside `cannet-server` rather than reusing
//! `cannet-client` because the bridge orchestrator needs one piece of
//! behaviour `cannet-client`'s public surface does not yet provide:
//! when the remote is a virtual-bus factory (`virtual:bus0`), the
//! `Subscribe` reply is `InterfaceAllocated`, and the bridge has to
//! address its TX `FrameBatch` envelopes to the *allocated* id, not
//! the factory id it subscribed to. Surfacing that allocated id
//! through `cannet-client`'s `Subscription` API is Phase-13 step 7's
//! job; the bridge orchestrator handles it server-side here.
//!
//! ## Runtime model
//!
//! The pump tasks (read inbound `FrameBatch` envelopes, write outbound
//! `FrameBatch` envelopes) run as `tokio::spawn` tasks on the calling
//! runtime — the same runtime that hosts [`crate::virtual_bus`]'s
//! tonic server. There is no nested runtime and no dedicated OS
//! thread; on detach the tasks are aborted, their futures drop, and
//! the captured channels close so the bus's bridge ingress/egress
//! threads unstick on their next read.

use std::sync::mpsc as std_mpsc;

use cannet_core::{CanFrame, CanFrameSink, CanFrameSource};
use cannet_wire::proto::{
    cannet_server_client::CannetServerClient, envelope::Body, Envelope, FrameBatch, Subscribe,
};
use cannet_wire::{frame_to_proto, proto_to_frame};
use tokio::sync::mpsc as tokio_mpsc;
use tokio::task::JoinHandle;
use tokio::time::Duration;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::Channel;

/// How long we wait for an `InterfaceAllocated` after `Subscribe`.
/// A virtual-bus factory replies immediately; other (non-factory)
/// interface ids do not reply. The window must be long enough to
/// cover real-world round-trip latency, short enough that an
/// interactive `AttachBridge` does not feel hung.
const ALLOCATED_GRACE: Duration = Duration::from_millis(250);

/// Outgoing-envelope queue depth for the gRPC request stream. Same
/// shape as `cannet-client`'s `REQUEST_CHANNEL_DEPTH`.
const REQUEST_CHANNEL_DEPTH: usize = 16;

/// Per-pump-channel queue depth. Bounded so a stalled consumer
/// back-pressures the wire rather than ballooning memory.
const PUMP_QUEUE_DEPTH: usize = 256;

/// Errors returned by [`BridgeRemote::connect`].
#[derive(Debug)]
pub enum BridgeRemoteError {
    /// The gRPC transport failed to connect.
    Connect(String),
    /// The Session RPC could not be opened.
    Session(String),
}

impl std::fmt::Display for BridgeRemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(m) => write!(f, "bridge connect failed: {m}"),
            Self::Session(m) => write!(f, "bridge session failed: {m}"),
        }
    }
}

impl std::error::Error for BridgeRemoteError {}

/// Server-internal client connection to a remote interface, presented
/// as a [`CanFrameSink`] + [`CanFrameSource`] pair. See module-level
/// docs.
pub struct BridgeRemote;

impl BridgeRemote {
    /// Open a session against `address`, subscribe to `interface_id`,
    /// resolve the wire address to which TX is forwarded, and spawn
    /// the inbound/outbound pump tasks.
    pub async fn connect(
        address: &str,
        interface_id: &str,
    ) -> Result<(BridgeSink, BridgeSource, BridgeShutdown), BridgeRemoteError> {
        let endpoint = format!("http://{address}");
        let mut client: CannetServerClient<Channel> =
            CannetServerClient::connect(endpoint)
                .await
                .map_err(|e| BridgeRemoteError::Connect(e.to_string()))?;

        let (req_tx, req_rx) = tokio_mpsc::channel::<Envelope>(REQUEST_CHANNEL_DEPTH);
        req_tx
            .send(Envelope {
                body: Some(Body::Subscribe(Subscribe {
                    interface_id: interface_id.to_string(),
                })),
            })
            .await
            .map_err(|_| {
                BridgeRemoteError::Session("request channel closed before subscribe".into())
            })?;

        let response = client
            .session(ReceiverStream::new(req_rx))
            .await
            .map_err(|s| BridgeRemoteError::Session(s.message().into()))?;
        let mut stream = response.into_inner();

        // Sync channel that the bus's bridge ingress thread drains
        // via [`BridgeSource::next_frame`]. The runtime-side sender is
        // owned by the inbound pump task — when the task aborts, the
        // sender drops and ingress's blocking recv unsticks.
        let (inbound_tx, inbound_rx) = std_mpsc::sync_channel::<CanFrame>(PUMP_QUEUE_DEPTH);

        let tx_target = wait_for_allocated_id(&mut stream, interface_id, &inbound_tx).await;

        let (outbound_tx, outbound_rx) = tokio_mpsc::channel::<CanFrame>(PUMP_QUEUE_DEPTH);

        let inbound_handle = tokio::spawn(run_inbound(stream, inbound_tx));
        let outbound_handle = tokio::spawn(run_outbound(outbound_rx, req_tx, tx_target));

        Ok((
            BridgeSink { outbound_tx },
            BridgeSource { inbound_rx },
            BridgeShutdown {
                inbound_handle,
                outbound_handle,
            },
        ))
    }
}

/// Sink half of a [`BridgeRemote`] connection. Implements
/// [`CanFrameSink`] by enqueuing the frame onto the runtime's outbound
/// pump task; the task sends it as a single-frame `FrameBatch`
/// addressed to the resolved remote id.
pub struct BridgeSink {
    outbound_tx: tokio_mpsc::Sender<CanFrame>,
}

/// Returned by [`BridgeSink::submit`] once the bridge runtime has
/// shut down (remote hung up, [`BridgeShutdown`] dropped, or
/// transport failure).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BridgeSessionClosed;

impl std::fmt::Display for BridgeSessionClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("bridge session is closed")
    }
}

impl std::error::Error for BridgeSessionClosed {}

impl CanFrameSink for BridgeSink {
    type Error = BridgeSessionClosed;

    fn submit(&mut self, frame: CanFrame) -> Result<(), Self::Error> {
        self.outbound_tx
            .blocking_send(frame)
            .map_err(|_| BridgeSessionClosed)
    }
}

/// Source half of a [`BridgeRemote`] connection. Implements
/// [`CanFrameSource`] by blocking on the runtime's inbound queue.
pub struct BridgeSource {
    inbound_rx: std_mpsc::Receiver<CanFrame>,
}

impl CanFrameSource for BridgeSource {
    type Error = BridgeSessionClosed;

    fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
        match self.inbound_rx.recv() {
            Ok(frame) => Ok(Some(frame)),
            // Sender dropped (pump task aborted) → end-of-stream so
            // the bus's bridge ingress thread unsticks.
            Err(_) => Ok(None),
        }
    }
}

/// Shutdown handle for a [`BridgeRemote`]. Dropping it aborts both
/// pump tasks; their futures drop, which closes the captured channels
/// so the bus's bridge ingress/egress threads unstick on their next
/// blocking read.
///
/// Aborting is asynchronous in tokio — the task is cancelled at its
/// next poll. There is no synchronous join; this avoids the
/// runtime-shutdown deadlock that a `JoinHandle::join`-equivalent
/// would create (the runtime processing the abort is the same
/// runtime that the join would block).
pub struct BridgeShutdown {
    inbound_handle: JoinHandle<()>,
    outbound_handle: JoinHandle<()>,
}

impl Drop for BridgeShutdown {
    fn drop(&mut self) {
        self.inbound_handle.abort();
        self.outbound_handle.abort();
    }
}

/// Read response envelopes from the remote and forward any frames to
/// the bus's bridge ingress thread.
async fn run_inbound(
    mut stream: tonic::Streaming<Envelope>,
    inbound_tx: std_mpsc::SyncSender<CanFrame>,
) {
    while let Ok(Some(envelope)) = stream.message().await {
        let Some(Body::FrameBatch(batch)) = envelope.body else {
            continue;
        };
        for proto_frame in batch.frames {
            // channel=0: the bus assigns the right channel at fan-out.
            let Ok(frame) = proto_to_frame(&proto_frame, 0) else {
                continue;
            };
            // `SyncSender::send` only blocks when the sync mpsc is at
            // capacity; the bus's bridge ingress thread drains it
            // promptly, so the call is effectively non-blocking.
            if inbound_tx.send(frame).is_err() {
                return;
            }
        }
    }
}

/// Pull frames from the bus's bridge egress thread and send them as
/// single-frame `FrameBatch` envelopes addressed to the resolved
/// remote id.
async fn run_outbound(
    mut outbound_rx: tokio_mpsc::Receiver<CanFrame>,
    req_tx: tokio_mpsc::Sender<Envelope>,
    tx_target: String,
) {
    while let Some(frame) = outbound_rx.recv().await {
        let envelope = Envelope {
            body: Some(Body::FrameBatch(FrameBatch {
                interface_id: tx_target.clone(),
                frames: vec![frame_to_proto(&frame)],
            })),
        };
        if req_tx.send(envelope).await.is_err() {
            return;
        }
    }
}

/// Drain the stream for at most [`ALLOCATED_GRACE`], yielding the
/// allocated id if an `InterfaceAllocated` arrives. Inbound
/// `FrameBatch` envelopes seen during the window are forwarded to
/// `inbound_tx` — losing them would be a correctness bug, since the
/// remote starts fanning out the moment the subscribe registers.
async fn wait_for_allocated_id(
    stream: &mut tonic::Streaming<Envelope>,
    fallback: &str,
    inbound_tx: &std_mpsc::SyncSender<CanFrame>,
) -> String {
    let deadline = tokio::time::sleep(ALLOCATED_GRACE);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            biased;
            () = &mut deadline => return fallback.to_string(),
            message = stream.message() => match message {
                Ok(Some(envelope)) => match envelope.body {
                    Some(Body::InterfaceAllocated(allocated)) => {
                        return allocated.interface_id;
                    }
                    Some(Body::FrameBatch(batch)) => {
                        for proto_frame in batch.frames {
                            if let Ok(frame) = proto_to_frame(&proto_frame, 0) {
                                if inbound_tx.send(frame).is_err() {
                                    return fallback.to_string();
                                }
                            }
                        }
                    }
                    _ => {}
                },
                _ => return fallback.to_string(),
            },
        }
    }
}
