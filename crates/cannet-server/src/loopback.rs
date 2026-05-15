//! Loopback gRPC server: every frame a client transmits is echoed back
//! on the same interface as an `Rx` frame.
//!
//! The Phase-5 demo target for the transmit path. With no hardware (and
//! no virtual CAN device on the host), the GUI's transmit panel can
//! still see its frames land "on the bus" — they leave the client as
//! `Tx` envelopes, pass through this server's loopback, and come back
//! as `Rx` envelopes on the same `interface_id`. The session sees them
//! and ticks like any other live stream.
//!
//! Concurrency shape mirrors the BLF replay server:
//!
//! - One [`LoopbackServerImpl`] is shared across all gRPC calls.
//! - `list_interfaces` reports a single fixed `"loopback:0"` interface
//!   (FD-capable so a client can send classic or FD frames through it).
//! - `session` accepts one client at a time (the same `BUSY` gate as
//!   the replay server), and within a session every received
//!   [`Body::FrameBatch`] is mirrored back into the per-session
//!   outgoing channel after rewriting [`Direction::Rx`] and re-stamping
//!   the timestamp to "now" relative to the session start. `Subscribe`
//!   tracks the subscription set so a frame on an unsubscribed
//!   interface is dropped instead of mirrored. `Unsubscribe` removes
//!   the subscription. `Error` envelopes from the client are
//!   informational.
//!
//! The in-process building block is [`cannet_core::loopback_bus`]; the
//! server holds the sink + source pair for one session at a time and
//! drives it with a small `tokio` task that pumps the source side back
//! out through the gRPC response stream.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use cannet_core::{loopback_bus, CanFrameSink, Direction};
// Re-imported via `cannet_core::CanFrameSource` for the pump's
// `try_next` call — pulled in implicitly through the public re-export.
use cannet_wire::{
    frame_to_proto,
    proto::{
        cannet_server_server::{CannetServer as CannetServerTrait, CannetServerServer},
        envelope::Body,
        error::Code,
        Envelope, Error as ErrorMsg, FrameBatch, Interface as ProtoInterface, InterfaceList,
        ListInterfacesRequest,
    },
    proto_to_frame,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};

/// Stable wire id of the single interface a loopback server exposes.
pub const LOOPBACK_INTERFACE_ID: &str = "loopback:0";

/// Channel depth for the per-session outgoing envelope queue. Same
/// shape and rationale as the replay server's queue — a backpressure
/// point that propagates to HTTP/2 flow control.
const OUTGOING_CHANNEL_DEPTH: usize = 64;

/// How long the pump sleeps when the loopback queue is empty. Short
/// enough that mirrored frames arrive without noticeable extra
/// latency; long enough to avoid CPU churn while the client is idle.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(5);

/// gRPC service implementation for the loopback mode.
///
/// Construct via [`LoopbackServerImpl::new`] and mount on a
/// `tonic::transport::Server` via [`Self::into_service`].
pub struct LoopbackServerImpl {
    busy: Arc<AtomicBool>,
}

impl LoopbackServerImpl {
    /// Build a fresh loopback server.
    #[must_use]
    pub fn new() -> Self {
        Self {
            busy: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Wrap this impl in the tonic `CannetServerServer` for mounting on
    /// a `Server::builder()` chain.
    #[must_use]
    pub fn into_service(self) -> CannetServerServer<Self> {
        CannetServerServer::new(self)
    }
}

impl Default for LoopbackServerImpl {
    fn default() -> Self {
        Self::new()
    }
}

/// Releases the busy flag when dropped — including on task panic.
struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[tonic::async_trait]
impl CannetServerTrait for LoopbackServerImpl {
    async fn list_interfaces(
        &self,
        _request: Request<ListInterfacesRequest>,
    ) -> Result<Response<InterfaceList>, Status> {
        Ok(Response::new(InterfaceList {
            interfaces: vec![ProtoInterface {
                id: LOOPBACK_INTERFACE_ID.to_string(),
                display_name: "Loopback".to_string(),
                fd_capable: true,
            }],
        }))
    }

    type SessionStream = ReceiverStream<Result<Envelope, Status>>;

    async fn session(
        &self,
        request: Request<Streaming<Envelope>>,
    ) -> Result<Response<Self::SessionStream>, Status> {
        let incoming = request.into_inner();
        let (tx, rx) = mpsc::channel(OUTGOING_CHANNEL_DEPTH);

        let already_busy = self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err();
        if already_busy {
            let _ = tx
                .send(Ok(error_envelope(
                    Code::Busy,
                    "server is already serving a client".into(),
                )))
                .await;
            return Ok(Response::new(ReceiverStream::new(rx)));
        }

        let busy_guard = BusyGuard(self.busy.clone());
        tokio::spawn(async move {
            let _busy_guard = busy_guard;
            run_session(incoming, tx).await;
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

async fn run_session(
    mut incoming: Streaming<Envelope>,
    outgoing: mpsc::Sender<Result<Envelope, Status>>,
) {
    // Per-session subscription set + loopback bus. The loopback bus is
    // the `cannet_core` primitive — the sink eats client transmits, the
    // source feeds the pump task that mirrors them back as `Rx`. Using
    // the primitive (rather than a direct mpsc) keeps the demo
    // path identical to what an in-process consumer of `cannet_core`
    // would use.
    let subscriptions: Arc<RwLock<HashSet<String>>> = Arc::new(RwLock::new(HashSet::new()));
    let (mut sink, mut source) = loopback_bus();

    let outgoing_for_pump = outgoing.clone();
    let subscriptions_for_pump = subscriptions.clone();
    let session_start = Instant::now();
    let pump_handle = tokio::spawn(async move {
        // Drain the loopback source on a short poll. `try_next` returns
        // `Ok(None)` while the queue is empty and the sink is still
        // live, `Err(_)` once the sink has been dropped — so the pump
        // exits cleanly on session end.
        loop {
            match source.try_next() {
                Ok(Some(frame)) => {
                    let mut mirrored = frame;
                    mirrored.direction = Direction::Rx;
                    mirrored.timestamp_ns =
                        u64::try_from(session_start.elapsed().as_nanos()).unwrap_or(u64::MAX);
                    let subscribed = subscriptions_for_pump
                        .read()
                        .expect("subscriptions poisoned")
                        .contains(LOOPBACK_INTERFACE_ID);
                    if !subscribed {
                        continue;
                    }
                    let envelope = Envelope {
                        body: Some(Body::FrameBatch(FrameBatch {
                            interface_id: LOOPBACK_INTERFACE_ID.to_string(),
                            frames: vec![frame_to_proto(&mirrored)],
                        })),
                    };
                    if outgoing_for_pump.send(Ok(envelope)).await.is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    tokio::time::sleep(POLL_INTERVAL).await;
                }
                Err(_) => return,
            }
        }
    });

    while let Ok(Some(envelope)) = incoming.message().await {
        let Some(body) = envelope.body else { continue };
        match body {
            Body::Subscribe(sub) => {
                if sub.interface_id != LOOPBACK_INTERFACE_ID {
                    let _ = outgoing
                        .send(Ok(error_envelope(
                            Code::UnknownInterface,
                            format!("no such interface: {}", sub.interface_id),
                        )))
                        .await;
                    continue;
                }
                subscriptions
                    .write()
                    .expect("subscriptions poisoned")
                    .insert(sub.interface_id);
            }
            Body::Unsubscribe(unsub) => {
                subscriptions
                    .write()
                    .expect("subscriptions poisoned")
                    .remove(&unsub.interface_id);
            }
            Body::FrameBatch(batch) => {
                if batch.interface_id != LOOPBACK_INTERFACE_ID {
                    let _ = outgoing
                        .send(Ok(error_envelope(
                            Code::UnknownInterface,
                            format!("no such interface: {}", batch.interface_id),
                        )))
                        .await;
                    continue;
                }
                for proto_frame in batch.frames {
                    // Channel is 0 — the loopback exposes a single
                    // interface; the wire only carries `interface_id`.
                    match proto_to_frame(&proto_frame, 0) {
                        Ok(frame) => {
                            // Best-effort: the source pump exiting closes
                            // the bus; treat that as a no-op since the
                            // session is already winding down.
                            let _ = sink.submit(frame);
                        }
                        Err(e) => {
                            let _ = outgoing
                                .send(Ok(error_envelope(
                                    Code::TxRejected,
                                    format!("invalid frame: {e}"),
                                )))
                                .await;
                        }
                    }
                }
            }
            // Client-side `Error` is informational on the loopback
            // server, and Phase 7 wire `Log` messages similarly have
            // no destination here — both arms drop.
            Body::Error(_) | Body::Log(_) => {}
        }
    }

    // Closing the sink ends the pump task on its next `next_frame` call.
    drop(sink);
    let _ = pump_handle.await;
}

fn error_envelope(code: Code, message: String) -> Envelope {
    Envelope {
        body: Some(Body::Error(ErrorMsg {
            code: code.into(),
            message,
        })),
    }
}
