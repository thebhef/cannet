//! gRPC server implementation of [`CannetServerTrait`].
//!
//! ### Concurrency shape
//!
//! - One [`CannetServerImpl`] is shared across all incoming gRPC calls.
//! - `list_interfaces` is fully synchronous over the in-memory replay.
//! - `session` is bidirectional. Each accepted session spawns one task
//!   that drains the client's incoming envelopes; that task spawns one
//!   *further* task per active subscription, each of which loops the
//!   replay for its own interface and pushes [`FrameBatch`] envelopes to
//!   the response sink. Unsubscribe aborts the per-interface task; end of
//!   the incoming stream aborts all of them.
//! - The single-client gate is an [`AtomicBool`]. A drop-guard releases
//!   it when the session task ends, including on panic.
//!
//! ### What the server rejects
//!
//! - A second concurrent session: in-band [`Code::Busy`] envelope, then
//!   the stream is closed.
//! - A subscribe to an unknown `interface_id`: in-band
//!   [`Code::UnknownInterface`].
//! - Any client-sent [`FrameBatch`]: in-band [`Code::TxRejected`] (BLF
//!   sources are read-only).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cannet_wire::{
    batch_frames,
    proto::{
        cannet_server_server::{CannetServer as CannetServerTrait, CannetServerServer},
        envelope::Body,
        error::Code,
        Envelope, Error as ErrorMsg, Interface as ProtoInterface, InterfaceList,
        ListInterfacesRequest, Subscribe, Unsubscribe,
    },
    BatchPolicy,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use tonic::{Request, Response, Status, Streaming};

use crate::replay::LoopingBlfReplay;

/// Channel depth for the per-session outgoing envelope queue. Provides
/// the natural HTTP/2 flow-control backpressure point: when the queue
/// fills, per-interface pump tasks block on `send`, which propagates to
/// the BLF source and then to the network.
const OUTGOING_CHANNEL_DEPTH: usize = 64;

/// gRPC service implementation. Construct via [`CannetServerImpl::new`]
/// and mount on a `tonic::transport::Server` via [`Self::into_service`].
pub struct CannetServerImpl {
    replay: Arc<LoopingBlfReplay>,
    busy: Arc<AtomicBool>,
}

impl CannetServerImpl {
    /// Build a server impl over the given in-memory replay.
    #[must_use]
    pub fn new(replay: Arc<LoopingBlfReplay>) -> Self {
        Self {
            replay,
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

/// Releases the busy flag when dropped — including on task panic.
struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[tonic::async_trait]
impl CannetServerTrait for CannetServerImpl {
    async fn list_interfaces(
        &self,
        _request: Request<ListInterfacesRequest>,
    ) -> Result<Response<InterfaceList>, Status> {
        let interfaces = self
            .replay
            .interfaces()
            .iter()
            .map(|iface| ProtoInterface {
                id: iface.id.clone(),
                display_name: iface.display_name.clone(),
                fd_capable: iface.fd_capable,
            })
            .collect();
        Ok(Response::new(InterfaceList { interfaces }))
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
            // Reject in-band: send Error envelope, then close the stream
            // by dropping `tx`.
            let _ = tx
                .send(Ok(error_envelope(
                    Code::Busy,
                    "server is already serving a client".into(),
                )))
                .await;
            return Ok(Response::new(ReceiverStream::new(rx)));
        }

        let busy_guard = BusyGuard(self.busy.clone());
        let replay = self.replay.clone();
        tokio::spawn(async move {
            let _busy_guard = busy_guard;
            run_session(incoming, tx, replay).await;
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

async fn run_session(
    mut incoming: Streaming<Envelope>,
    outgoing: mpsc::Sender<Result<Envelope, Status>>,
    replay: Arc<LoopingBlfReplay>,
) {
    let mut tasks: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

    while let Ok(Some(envelope)) = incoming.message().await {
        let Some(body) = envelope.body else { continue };
        match body {
            Body::Subscribe(Subscribe { interface_id }) => {
                if tasks.contains_key(&interface_id) {
                    continue;
                }
                let Some(iface) = replay.interface_by_id(&interface_id) else {
                    let _ = outgoing
                        .send(Ok(error_envelope(
                            Code::UnknownInterface,
                            format!("no such interface: {interface_id}"),
                        )))
                        .await;
                    continue;
                };
                let channel = iface.channel;
                let outgoing_clone = outgoing.clone();
                let replay_clone = replay.clone();
                let interface_id_for_task = interface_id.clone();
                let handle = tokio::spawn(async move {
                    pump_interface(replay_clone, channel, interface_id_for_task, outgoing_clone)
                        .await;
                });
                tasks.insert(interface_id, handle);
            }
            Body::Unsubscribe(Unsubscribe { interface_id }) => {
                if let Some(h) = tasks.remove(&interface_id) {
                    h.abort();
                }
            }
            Body::FrameBatch(_) => {
                let _ = outgoing
                    .send(Ok(error_envelope(
                        Code::TxRejected,
                        "BLF source is read-only; transmits not supported".into(),
                    )))
                    .await;
            }
            Body::Error(_) => {
                // Client-side errors are informational only on this server.
            }
        }
    }

    // Incoming stream closed: cancel all per-interface pumps. Dropping
    // `outgoing` then closes the response side.
    for (_, handle) in tasks {
        handle.abort();
    }
}

async fn pump_interface(
    replay: Arc<LoopingBlfReplay>,
    channel: u8,
    interface_id: String,
    outgoing: mpsc::Sender<Result<Envelope, Status>>,
) {
    let frames = async_stream::stream! {
        let Some(frames) = replay.frames_for_channel(channel) else { return; };
        if frames.is_empty() { return; }
        loop {
            for frame in frames {
                yield frame.clone();
            }
        }
    };
    let batches = batch_frames(interface_id, frames, BatchPolicy::default());
    tokio::pin!(batches);
    while let Some(batch) = batches.next().await {
        let envelope = Envelope { body: Some(Body::FrameBatch(batch)) };
        if outgoing.send(Ok(envelope)).await.is_err() {
            return; // Receiver dropped; session ended.
        }
    }
}

fn error_envelope(code: Code, message: String) -> Envelope {
    Envelope {
        body: Some(Body::Error(ErrorMsg {
            code: code.into(),
            message,
        })),
    }
}
