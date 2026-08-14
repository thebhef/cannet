//! The production hardware proxy (ADR 0040): one network endpoint in
//! front of an upstream that speaks the same protocol.
//!
//! ## Pure pass-through
//!
//! Every RPC is relayed 1:1 and nothing on the wire is interpreted:
//!
//! - `ListInterfaces` returns the upstream's `InterfaceList` verbatim,
//!   so remote clients see the real interface identities (`vector:0`,
//!   `socketcan:can0`, …) rather than anything this process invented.
//! - `WatchInterfaces` opens one upstream watch stream and forwards
//!   every snapshot it pushes, for as long as the client is listening.
//! - `Session` opens **exactly one** upstream `Session` and relays
//!   envelopes verbatim in both directions. `Subscribe`,
//!   `ConfigureBus`, `FrameBatch`, `InterfaceAllocated`,
//!   `InterfaceState`, `Log` and `Error` all cross untouched — and so
//!   do `ClockProbe` / `ClockReply`, deliberately: the clock a client
//!   probes for is the one that stamps the frames it will receive, and
//!   that clock belongs to the upstream. Answering here would report a
//!   neighbouring process's clock, correct only for as long as the two
//!   happen to share a host. The extra hop inflates the measured delay,
//!   which is exactly what the client's minimum-delay sampling
//!   discards.
//!
//! What does *not* cross is the client's credential. Each upstream call
//! is a fresh `Request`, so an `authorization` header presented to this
//! endpoint authenticates the client *here* (ADR 0041) and goes no
//! further — the supervised sidecar on loopback never asked for one,
//! and relaying it would carry the secret a hop beyond where it
//! belongs.
//!
//! The consequence is that hardware-server semantics (ADR 0022) hold
//! end-to-end. In particular the proxy adds **no arbitration of its
//! own**: a second client is not refused here, it is offered to the
//! upstream, and whatever the upstream answers — an accepted session,
//! an in-band `Busy`, a `TxRejected` — is what the client receives.
//! The single owner of a piece of hardware stays the process that
//! owns the hardware.
//!
//! ## Session lifetime
//!
//! The two relay directions run to completion together. When the
//! client's request stream ends, the upstream request stream ends with
//! it, so the upstream tears its session down and releases whatever it
//! was holding. When the upstream's response stream ends — cleanly, or
//! with a transport error — the client's stream ends the same way,
//! carrying the same `Status`.
//!
//! ## Where the upstream is
//!
//! The address is resolved **per RPC**, through the closure handed to
//! [`ProxyServerImpl::new`], because a supervised sidecar binds an
//! ephemeral port and re-binds a different one every time it restarts.
//! A `None` means no upstream is listening yet, which is `Unavailable`
//! rather than an error the client should retry differently.

use cannet_wire::proto::{
    cannet_server_client::CannetServerClient,
    cannet_server_server::{CannetServer as CannetServerTrait, CannetServerServer},
    Envelope, InterfaceList, ListInterfacesRequest, WatchInterfacesRequest,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::Channel;
use tonic::{Request, Response, Status, Streaming};

/// Queue depth for a relayed stream. Matches the per-session depth the
/// other server modes use: deep enough to absorb a batch burst, shallow
/// enough that a stalled client back-pressures the upstream through
/// HTTP/2 flow control instead of growing memory here.
const RELAY_CHANNEL_DEPTH: usize = 64;

/// gRPC service that relays the cannet protocol to an upstream server.
/// Construct via [`ProxyServerImpl::new`] and mount on a
/// `tonic::transport::Server` via [`Self::into_service`].
pub struct ProxyServerImpl {
    upstream: Box<dyn Fn() -> Option<String> + Send + Sync>,
}

impl ProxyServerImpl {
    /// Build a proxy whose upstream address comes from `upstream`,
    /// called fresh for every RPC. Production hands it the supervised
    /// sidecar's currently-bound address (`None` until the sidecar has
    /// reported one); tests hand it a fixed address.
    pub fn new(upstream: impl Fn() -> Option<String> + Send + Sync + 'static) -> Self {
        Self {
            upstream: Box::new(upstream),
        }
    }

    /// Wrap this impl in the tonic `CannetServerServer` for mounting on
    /// a `Server::builder()` chain.
    #[must_use]
    pub fn into_service(self) -> CannetServerServer<Self> {
        CannetServerServer::new(self)
    }

    /// Connect to the upstream for one RPC. Both failure modes are
    /// `Unavailable` — "there is no upstream right now" is a transient
    /// condition a client retries, whether the sidecar has not yet
    /// bound a port or has stopped answering on the one it reported.
    async fn upstream_client(&self) -> Result<CannetServerClient<Channel>, Status> {
        let Some(address) = (self.upstream)() else {
            return Err(Status::unavailable(
                "no upstream sidecar is listening yet; retry once it has started",
            ));
        };
        CannetServerClient::connect(format!("http://{address}"))
            .await
            .map_err(|e| Status::unavailable(format!("upstream {address} is unreachable: {e}")))
    }
}

#[tonic::async_trait]
impl CannetServerTrait for ProxyServerImpl {
    async fn list_interfaces(
        &self,
        _request: Request<ListInterfacesRequest>,
    ) -> Result<Response<InterfaceList>, Status> {
        self.upstream_client()
            .await?
            .list_interfaces(ListInterfacesRequest {})
            .await
    }

    type WatchInterfacesStream = ReceiverStream<Result<InterfaceList, Status>>;

    async fn watch_interfaces(
        &self,
        _request: Request<WatchInterfacesRequest>,
    ) -> Result<Response<Self::WatchInterfacesStream>, Status> {
        let mut client = self.upstream_client().await?;
        let upstream = client
            .watch_interfaces(WatchInterfacesRequest {})
            .await?
            .into_inner();
        let (tx, rx) = mpsc::channel(RELAY_CHANNEL_DEPTH);
        tokio::spawn(async move {
            // The client owns the connection the stream is riding on,
            // so it has to outlive the relay.
            let _client = client;
            relay_watch(upstream, tx).await;
        });
        Ok(Response::new(ReceiverStream::new(rx)))
    }

    type SessionStream = ReceiverStream<Result<Envelope, Status>>;

    async fn session(
        &self,
        request: Request<Streaming<Envelope>>,
    ) -> Result<Response<Self::SessionStream>, Status> {
        let mut client = self.upstream_client().await?;
        let incoming = request.into_inner();
        // Open the upstream session before answering our own client, so
        // an upstream that refuses the RPC outright refuses this one
        // with the same `Status`.
        let (request_tx, request_rx) = mpsc::channel::<Envelope>(RELAY_CHANNEL_DEPTH);
        let upstream = client
            .session(ReceiverStream::new(request_rx))
            .await?
            .into_inner();
        let (tx, rx) = mpsc::channel(RELAY_CHANNEL_DEPTH);
        tokio::spawn(async move {
            let _client = client;
            // Both directions run to completion: a client that has
            // finished transmitting (half-close) keeps receiving, which
            // is what it would get talking to the upstream directly.
            tokio::join!(
                relay_to_upstream(incoming, request_tx),
                relay_to_client(upstream, tx),
            );
        });
        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

/// Forward every snapshot the upstream pushes, and the end of the
/// stream — including a transport error — exactly as it arrived.
async fn relay_watch(
    mut upstream: Streaming<InterfaceList>,
    tx: mpsc::Sender<Result<InterfaceList, Status>>,
) {
    loop {
        match upstream.message().await {
            Ok(Some(list)) => {
                if tx.send(Ok(list)).await.is_err() {
                    return;
                }
            }
            Ok(None) => return,
            Err(status) => {
                let _ = tx.send(Err(status)).await;
                return;
            }
        }
    }
}

/// Client → upstream. Ends when the client stops sending; dropping
/// `request_tx` on the way out closes the upstream's request stream,
/// which is how the upstream learns to tear the session down.
async fn relay_to_upstream(mut incoming: Streaming<Envelope>, request_tx: mpsc::Sender<Envelope>) {
    while let Ok(Some(envelope)) = incoming.message().await {
        if request_tx.send(envelope).await.is_err() {
            return;
        }
    }
}

/// Upstream → client. Ends when the upstream's stream ends or the
/// client hangs up; an upstream error becomes the client's, unchanged.
async fn relay_to_client(
    mut upstream: Streaming<Envelope>,
    tx: mpsc::Sender<Result<Envelope, Status>>,
) {
    loop {
        match upstream.message().await {
            Ok(Some(envelope)) => {
                if tx.send(Ok(envelope)).await.is_err() {
                    return;
                }
            }
            Ok(None) => return,
            Err(status) => {
                let _ = tx.send(Err(status)).await;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_upstream_that_has_not_bound_yet_is_unavailable() {
        // The supervised sidecar reports its ephemeral port on a banner
        // line, so there is a window at startup with no address at all.
        // A client asking during it gets told to come back.
        let proxy = ProxyServerImpl::new(|| None);
        let status = proxy
            .list_interfaces(Request::new(ListInterfacesRequest {}))
            .await
            .expect_err("there is nothing to list without an upstream");
        assert_eq!(status.code(), tonic::Code::Unavailable);
        assert!(
            status.message().contains("listening yet"),
            "the client is told to come back, not that something is broken: {}",
            status.message()
        );
    }
}
