//! gRPC server implementation of [`CannetServerTrait`].
//!
//! ### Concurrency shape
//!
//! - One [`CannetServerImpl`] is shared across all incoming gRPC calls.
//! - `list_interfaces` is fully synchronous over the in-memory replay.
//! - `session` is bidirectional. Each accepted session spawns one
//!   *single* paced pump task that walks the replay's frames in their
//!   recorded order and emits each subscribed frame at the appropriate
//!   wall-clock time. The session task itself drains the client's
//!   incoming envelopes and updates the shared subscription set the
//!   pump consults; `Subscribe` adds an interface, `Unsubscribe`
//!   removes it. End-of-incoming aborts the pump.
//! - The single-client gate is an [`AtomicBool`]. A drop-guard
//!   releases it when the session task ends, including on panic.
//!
//! ### Pacing
//!
//! Frames are walked in original BLF timestamp order. The pump sleeps
//! `(t[i] - loop_start_ts) / rate` of wall time before emitting the
//! frame at index `i`, giving real-time playback at `rate = 1.0`,
//! `100×` real-time at `rate = 100.0`, etc. `rate = 0.0` (the default,
//! and the test setting) skips the sleep entirely — the pump runs as
//! fast as the consumer drains, matching the pre-pacing behavior.
//! Looping: each new lap rebases the wall-clock origin to "now", so
//! recorded timestamps don't have to be monotonic across lap
//! boundaries — only within one lap.
//!
//! ### What the server rejects
//!
//! - A second concurrent session: in-band [`Code::Busy`] envelope, then
//!   the stream is closed.
//! - A subscribe to an unknown `interface_id`: in-band
//!   [`Code::UnknownInterface`].
//! - Any client-sent [`FrameBatch`]: in-band [`Code::TxRejected`] (BLF
//!   sources are read-only).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use cannet_wire::{
    frame_to_proto,
    proto::{
        cannet_server_server::{CannetServer as CannetServerTrait, CannetServerServer},
        envelope::Body,
        error::Code,
        Envelope, Error as ErrorMsg, FrameBatch, Interface as ProtoInterface, InterfaceList,
        ListInterfacesRequest, Subscribe, Unsubscribe, WatchInterfacesRequest,
    },
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};

use crate::replay::LoopingBlfReplay;

/// Channel depth for the per-session outgoing envelope queue. Provides
/// the natural HTTP/2 flow-control backpressure point: when the queue
/// fills, the pump task blocks on `send`, which propagates to HTTP/2
/// flow control and stops the bus from outrunning the client.
const OUTGOING_CHANNEL_DEPTH: usize = 64;

/// gRPC service implementation. Construct via [`CannetServerImpl::new`]
/// and mount on a `tonic::transport::Server` via [`Self::into_service`].
pub struct CannetServerImpl {
    replay: Arc<LoopingBlfReplay>,
    busy: Arc<AtomicBool>,
    /// Replay rate multiplier: `1.0` = recorded cadence, `100.0` = 100×
    /// faster, `0.0` = no pacing (emit as fast as the consumer drains).
    rate: f64,
}

impl CannetServerImpl {
    /// Build a server impl over the given in-memory replay.
    #[must_use]
    pub fn new(replay: Arc<LoopingBlfReplay>, rate: f64) -> Self {
        Self {
            replay,
            busy: Arc::new(AtomicBool::new(false)),
            rate,
        }
    }

    /// Wrap this impl in the tonic `CannetServerServer` for mounting on
    /// a `Server::builder()` chain.
    #[must_use]
    pub fn into_service(self) -> CannetServerServer<Self> {
        CannetServerServer::new(self)
    }

    /// Build the proto `InterfaceList` snapshot from the replay's
    /// channel set. Shared by `list_interfaces` (pull) and
    /// `watch_interfaces` (push on subscribe).
    fn snapshot_interfaces(&self) -> InterfaceList {
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
        InterfaceList { interfaces }
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
        Ok(Response::new(self.snapshot_interfaces()))
    }

    type WatchInterfacesStream = ReceiverStream<Result<InterfaceList, Status>>;

    /// BLF replay's interface set is fixed for the session: emit one
    /// snapshot on subscribe, then keep the stream open until the
    /// client drops. There's nothing to push afterwards because the
    /// BLF file's channel list can't change underneath us. (Per ADR
    /// 0016, the *server* decides when its view changed; here, never.)
    async fn watch_interfaces(
        &self,
        _request: Request<WatchInterfacesRequest>,
    ) -> Result<Response<Self::WatchInterfacesStream>, Status> {
        let (tx, rx) = mpsc::channel(1);
        let snapshot = self.snapshot_interfaces();
        // Best-effort send: a buffer-of-1 means the snapshot lands as
        // long as the client polls the stream at all. If the client
        // drops before polling, the send errors and we just drop the
        // sender — the stream closes for them.
        let _ = tx.send(Ok(snapshot)).await;
        // We deliberately keep `tx` alive in the task so the client
        // can hold the subscription open. Drop it the moment the
        // client disconnects — `ReceiverStream` notices and ends.
        tokio::spawn(async move {
            // Park forever; only client drop ends this.
            let _hold = tx;
            std::future::pending::<()>().await;
        });
        Ok(Response::new(ReceiverStream::new(rx)))
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
        let rate = self.rate;
        tokio::spawn(async move {
            let _busy_guard = busy_guard;
            run_session(incoming, tx, replay, rate).await;
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

async fn run_session(
    mut incoming: Streaming<Envelope>,
    outgoing: mpsc::Sender<Result<Envelope, Status>>,
    replay: Arc<LoopingBlfReplay>,
    rate: f64,
) {
    let subscriptions: Arc<RwLock<HashSet<String>>> =
        Arc::new(RwLock::new(HashSet::new()));

    let pump_handle = tokio::spawn(pump_paced(
        replay.clone(),
        subscriptions.clone(),
        rate,
        outgoing.clone(),
    ));

    while let Ok(Some(envelope)) = incoming.message().await {
        let Some(body) = envelope.body else { continue };
        match body {
            Body::Subscribe(Subscribe { interface_id }) => {
                if replay.interface_by_id(&interface_id).is_none() {
                    let _ = outgoing
                        .send(Ok(error_envelope(
                            Code::UnknownInterface,
                            format!("no such interface: {interface_id}"),
                        )))
                        .await;
                    continue;
                }
                subscriptions
                    .write()
                    .expect("subscriptions poisoned")
                    .insert(interface_id);
            }
            Body::Unsubscribe(Unsubscribe { interface_id }) => {
                subscriptions
                    .write()
                    .expect("subscriptions poisoned")
                    .remove(&interface_id);
            }
            Body::FrameBatch(_) => {
                let _ = outgoing
                    .send(Ok(error_envelope(
                        Code::TxRejected,
                        "BLF source is read-only; transmits not supported".into(),
                    )))
                    .await;
            }
            // Client-side `Error` is informational on this server (the
            // BLF replay surface has nothing to do about it); Phase 7
            // wire `Log` messages likewise have no log destination on
            // this server, so both arms drop.
            Body::Error(_) | Body::Log(_) => {}
        }
    }

    pump_handle.abort();
}

/// How long the pump idles when the client hasn't subscribed to any
/// interfaces. Long enough to avoid CPU churn, short enough that the
/// first frame after a subscribe arrives without noticeable latency.
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(50);

async fn pump_paced(
    replay: Arc<LoopingBlfReplay>,
    subscriptions: Arc<RwLock<HashSet<String>>>,
    rate: f64,
    outgoing: mpsc::Sender<Result<Envelope, Status>>,
) {
    let frames = replay.frames();
    if frames.is_empty() {
        return;
    }

    // Pre-compute the recorded duration of one BLF lap. Each loop
    // iteration shifts emitted timestamps forward by N * loop_duration
    // so the consumer sees a strictly monotonic time even though the
    // BLF restarts.
    let loop_duration_ns = frames
        .last()
        .unwrap()
        .timestamp_ns
        .saturating_sub(frames.first().unwrap().timestamp_ns);
    let mut loop_offset_ns: u64 = 0;

    loop {
        // Skip the whole loop body if the client hasn't subscribed to
        // anything yet — otherwise rate=0 + no-subs walks the BLF in a
        // tight loop with no yield points, starving the session task
        // (current-thread tokio in tests) and burning CPU (production).
        if subscriptions
            .read()
            .expect("subscriptions poisoned")
            .is_empty()
        {
            tokio::time::sleep(IDLE_POLL_INTERVAL).await;
            continue;
        }

        let loop_start_wall = Instant::now();
        let loop_start_ts = frames[0].timestamp_ns;

        for frame in frames {
            if rate > 0.0 {
                let rel_ns = frame.timestamp_ns.saturating_sub(loop_start_ts);
                let scaled_ns = scale_ns(rel_ns, rate);
                let target = loop_start_wall + Duration::from_nanos(scaled_ns);
                let now = Instant::now();
                if target > now {
                    tokio::time::sleep(target - now).await;
                }
            }

            let Some(interface_id) = replay.interface_id_for_channel(frame.channel) else {
                tokio::task::yield_now().await;
                continue;
            };
            let subscribed = subscriptions
                .read()
                .expect("subscriptions poisoned")
                .contains(interface_id);
            if !subscribed {
                tokio::task::yield_now().await;
                continue;
            }

            // Emit with a timestamp shifted into the current lap so the
            // consumer's view of time keeps incrementing across loops.
            let mut proto_frame = frame_to_proto(frame);
            proto_frame.timestamp_ns = proto_frame.timestamp_ns.saturating_add(loop_offset_ns);
            let envelope = Envelope {
                body: Some(Body::FrameBatch(FrameBatch {
                    interface_id: interface_id.to_string(),
                    frames: vec![proto_frame],
                })),
            };
            if outgoing.send(Ok(envelope)).await.is_err() {
                return;
            }
        }

        loop_offset_ns = loop_offset_ns.saturating_add(loop_duration_ns);
    }
}

#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn scale_ns(rel_ns: u64, rate: f64) -> u64 {
    let scaled = rel_ns as f64 / rate;
    if scaled.is_finite() && scaled >= 0.0 {
        scaled as u64
    } else {
        0
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
