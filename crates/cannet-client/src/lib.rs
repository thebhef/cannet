//! gRPC client for the cannet wire protocol.
//!
//! The crate adapts the `cannet-wire` gRPC service into the
//! [`cannet_core::CanFrameSource`] trait the rest of the analyzer is
//! built around — so the GUI's existing trace pipeline can consume a
//! remote server with no changes other than swapping the source.
//!
//! ## Surface
//!
//! - [`ConnectConfig`]: which server to reach and how the connection is
//!   protected — plaintext for a loopback server, or TLS pinned to the
//!   server's certificate fingerprint plus a bearer token for a routable
//!   one (ADR 0041). Every entry point below takes one.
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
//! - [`clock`]: how far the server's wall clock is from ours. Every
//!   session measures it once at start-up and publishes the result on
//!   [`FrameReceiver::clock`]; frames are delivered uncorrected.
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
//!   numeric `channel: u8`. Callers tell the client which wire id they
//!   want surfaced as which channel via [`Subscription`]. Any
//!   `FrameBatch` for an unsubscribed `interface_id` is dropped.
//! - **Factory subscribes (virtual-bus, ADR 0021).** A `Subscription`
//!   with `allocates: true` is a request against a virtual-bus
//!   factory id. The server responds with an `InterfaceAllocated`
//!   envelope naming the freshly-allocated participant id; the
//!   client waits for that envelope before signalling readiness, maps
//!   the allocated id onto the subscription's `channel`, and surfaces
//!   the resolved id through [`ResolvedSubscription::allocated_id`]
//!   so the caller can transmit against it.
//! - **The clock probe never gates anything.** It runs alongside the
//!   frame stream on the same session, so readiness is signalled at the
//!   speed of the subscribes and a peer that does not answer costs a
//!   status of `Unsupported` and nothing else. Waiting on a clock
//!   before delivering frames would trade a definite small error for
//!   an indefinite stall.

pub mod clock;
pub mod tls;

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use cannet_core::{CanFrame, CanFrameSource};
use cannet_wire::proto::{
    cannet_server_client::CannetServerClient, envelope::Body, ClockProbe, ConfigureBus, Envelope,
    FrameBatch, ListInterfacesRequest, Subscribe, WatchInterfacesRequest,
};
use cannet_wire::{frame_to_proto, proto_to_frame, ProtoConversionError};
use tokio::sync::mpsc as tokio_mpsc;
use tokio::sync::oneshot;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use tonic::transport::{Channel, Endpoint};

use crate::clock::{ClockSample, SessionClock};
use crate::tls::{CertPin, ObservedPin};

/// Outgoing-envelope channel depth for the per-session request stream.
/// Subscribes are bursty at startup; this gives them room without
/// blocking the worker thread before the stream is up.
const REQUEST_CHANNEL_DEPTH: usize = 16;

/// How many clock probes a session sends at start-up. Minimum-delay
/// selection needs several exchanges to choose between, and each one
/// costs two small envelopes — but the marginal value of a fifth is
/// low next to the extra window it keeps open.
const CLOCK_PROBE_COUNT: usize = 4;

/// Spacing between probes. Far enough apart that a single transient
/// queue does not distort every exchange, close enough that the whole
/// burst is over long before a user notices a session existing.
const CLOCK_PROBE_SPACING: Duration = Duration::from_millis(20);

/// How long the session waits for probe replies before concluding.
///
/// Generous, because nothing waits on it: the probe runs alongside the
/// frame stream and readiness is signalled without it, so the only
/// thing this budget buys is a chance for a slow link to answer before
/// its server is written off as not supporting the exchange.
const CLOCK_PROBE_DEADLINE: Duration = Duration::from_secs(2);

/// Wall-clock nanoseconds since the Unix epoch — the clock the wire's
/// timestamps are on, and therefore the one whose distance from the
/// server's is worth measuring.
fn wall_clock_ns() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
}

/// How a connection to one server is protected — the argument every
/// entry point in this crate takes in place of a bare address.
///
/// A cannet server is either unprotected (the loopback default: no TLS,
/// no credential) or protected by both halves of ADR 0041 at once —
/// TLS pinned to the server's certificate fingerprint, and a bearer
/// token presented on every RPC. The constructors are the whole of the
/// permitted combinations, so the two rules that matter cannot be
/// expressed wrongly:
///
/// - **A credential never rides an unencrypted channel.** Only
///   [`ConnectConfig::pinned_with_token`] carries a token, and it always
///   pins.
/// - **A pinned server is never dialled over `http://`.** The scheme
///   follows the protection; an address that spells out a contradicting
///   one is [`ConnectionError::InsecureScheme`] before any packet is
///   sent.
#[derive(Debug, Clone)]
pub struct ConnectConfig {
    /// `host:port`, optionally with an explicit scheme.
    address: String,
    trust: Trust,
}

/// The transport half of a [`ConnectConfig`].
#[derive(Clone)]
enum Trust {
    /// No TLS and no credential — the loopback default, and what every
    /// in-process and sidecar server speaks.
    Plaintext,
    /// TLS verified by certificate fingerprint. `pin` is `None` for a
    /// trust-on-first-use probe, which by construction refuses the
    /// handshake and reports what it saw.
    Pinned {
        pin: Option<CertPin>,
        token: Option<String>,
    },
}

/// Redacts the token, which the derived impl printed in full. The pin
/// is public material and stays legible; the credential is not, and
/// `ConnectConfig` is a public type, so a consumer's `debug!(?config)`
/// would otherwise write a bearer token into their log with no warning.
/// The server keeps `Debug` off `AccessToken` for the same reason —
/// the guarantee has to live at the type, not in every call site's
/// memory.
impl std::fmt::Debug for Trust {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Plaintext => f.write_str("Plaintext"),
            Self::Pinned { pin, token } => f
                .debug_struct("Pinned")
                .field("pin", pin)
                .field("token", &token.as_ref().map(|_| "<redacted>"))
                .finish(),
        }
    }
}

impl ConnectConfig {
    /// The unprotected path: plaintext HTTP/2, no credential.
    ///
    /// This is what a loopback server — the GUI's own sidecar, a
    /// `--bind 127.0.0.1` proxy, an in-process test server — is reached
    /// with. A server that is not on loopback refuses to start this way
    /// without `--insecure`.
    #[must_use]
    pub fn plaintext(address: impl Into<String>) -> Self {
        Self {
            address: address.into(),
            trust: Trust::Plaintext,
        }
    }

    /// TLS against a server whose certificate fingerprint is already
    /// known, with no credential. Useful for a server started with
    /// `--tls` and no token.
    #[must_use]
    pub fn pinned(address: impl Into<String>, pin: CertPin) -> Self {
        Self {
            address: address.into(),
            trust: Trust::Pinned {
                pin: Some(pin),
                token: None,
            },
        }
    }

    /// The fully protected path: TLS pinned to `pin`, and `token`
    /// presented as an RFC 6750 `authorization: Bearer` credential on
    /// every RPC.
    #[must_use]
    pub fn pinned_with_token(
        address: impl Into<String>,
        pin: CertPin,
        token: impl Into<String>,
    ) -> Self {
        Self {
            address: address.into(),
            trust: Trust::Pinned {
                pin: Some(pin),
                token: Some(token.into()),
            },
        }
    }

    /// A trust-on-first-use probe: complete enough of a TLS handshake to
    /// see the server's certificate, then refuse it.
    ///
    /// Nothing is pinned, so the connection *always* fails with
    /// [`ConnectionError::PinMismatch`] carrying `expected: None` and
    /// the fingerprint the server presented — the value a first-connect
    /// dialog asks the user to accept. No RPC is made and no credential
    /// is sent, because the handshake never completes.
    #[must_use]
    pub fn unpinned(address: impl Into<String>) -> Self {
        Self {
            address: address.into(),
            trust: Trust::Pinned {
                pin: None,
                token: None,
            },
        }
    }

    /// The address as given, without any scheme this crate added.
    #[must_use]
    pub fn address(&self) -> &str {
        &self.address
    }

    /// The bearer token to present, if this connection carries one.
    fn token(&self) -> Option<&str> {
        match &self.trust {
            Trust::Plaintext => None,
            Trust::Pinned { token, .. } => token.as_deref(),
        }
    }

    /// The endpoint to dial, after checking the address against how this
    /// connection is protected.
    ///
    /// A pinned connection whose address spells out `http://` is refused
    /// here — before a socket is opened, let alone a credential sent —
    /// rather than silently upgraded, because an address the user
    /// believes is plaintext and a connection that is not is exactly the
    /// confusion ADR 0041 exists to remove.
    ///
    /// The URI itself is always `http://`, even when the connection is
    /// TLS: [`tls::pinned_connector`] explains why tonic requires that
    /// of a hand-supplied connector.
    fn endpoint(&self) -> Result<Endpoint, ConnectionError> {
        let (scheme, authority) = match self.address.split_once("://") {
            Some((scheme, rest)) => (Some(scheme), rest),
            None => (None, self.address.as_str()),
        };
        if let (Some(scheme), Trust::Pinned { .. }) = (scheme, &self.trust) {
            if !scheme.eq_ignore_ascii_case("https") {
                return Err(ConnectionError::InsecureScheme {
                    address: self.address.clone(),
                });
            }
        }
        Endpoint::from_shared(format!("http://{authority}"))
            .map_err(|e| ConnectionError::Connect(e.to_string()))
    }

    /// Dial the server, terminating TLS against the pin when there is
    /// one.
    ///
    /// A refused handshake reaches this function as an opaque transport
    /// error with nothing certificate-shaped left in it, so the verifier
    /// publishes what it saw through a side channel that is read here
    /// and turned into [`ConnectionError::PinMismatch`].
    async fn connect(&self) -> Result<Channel, ConnectionError> {
        let endpoint = self.endpoint()?;
        match self.trust {
            Trust::Plaintext => endpoint
                .connect()
                .await
                .map_err(|e| ConnectionError::Connect(e.to_string())),
            Trust::Pinned { pin, .. } => {
                let observed: ObservedPin = Arc::new(Mutex::new(None));
                let connector = tls::pinned_connector(pin, observed.clone());
                match endpoint.connect_with_connector(connector).await {
                    Ok(channel) => Ok(channel),
                    Err(e) => {
                        let seen = observed.lock().ok().and_then(|slot| *slot);
                        Err(match seen {
                            Some(observation) => ConnectionError::PinMismatch {
                                expected: observation.expected.map(|p| p.to_string()),
                                observed: observation.observed.to_string(),
                            },
                            None => ConnectionError::Connect(e.to_string()),
                        })
                    }
                }
            }
        }
    }

    /// A gRPC client over a freshly dialled channel, with this
    /// connection's credential attached to every request it makes.
    async fn client(
        &self,
    ) -> Result<
        CannetServerClient<
            tonic::service::interceptor::InterceptedService<Channel, BearerCredential>,
        >,
        ConnectionError,
    > {
        let channel = self.connect().await?;
        Ok(CannetServerClient::with_interceptor(
            channel,
            BearerCredential::new(self.token())?,
        ))
    }
}

/// Attaches the connection's bearer token to every outgoing request.
///
/// Built once per connection rather than per call: the credential gates
/// *every* RPC on the server (ADR 0041), so anything that forgets it is
/// simply refused, and the only way not to forget is to not have the
/// choice at the call site.
#[derive(Clone)]
pub struct BearerCredential(Option<tonic::metadata::MetadataValue<tonic::metadata::Ascii>>);

impl BearerCredential {
    fn new(token: Option<&str>) -> Result<Self, ConnectionError> {
        let Some(token) = token else {
            return Ok(Self(None));
        };
        // The token is 43 characters of base64url as the server mints
        // it, but an operator can supply any value with `--token`, and
        // metadata is ASCII-only. A value that cannot be sent is a
        // configuration error, not something to discover as a rejection.
        let value = format!("Bearer {token}")
            .parse()
            .map_err(|_| ConnectionError::InvalidToken)?;
        Ok(Self(Some(value)))
    }
}

impl tonic::service::Interceptor for BearerCredential {
    fn call(
        &mut self,
        mut request: tonic::Request<()>,
    ) -> Result<tonic::Request<()>, tonic::Status> {
        if let Some(value) = &self.0 {
            request
                .metadata_mut()
                .insert("authorization", value.clone());
        }
        Ok(request)
    }
}

/// Hardware configuration the caller wants applied to an interface
/// *before* the corresponding [`Subscription`] is sent. The server
/// receives a `ConfigureBus` envelope ahead of the `Subscribe`, so
/// the underlying controller opens at the requested rate / mode the
/// first time around — no close+reopen window where frames could be
/// lost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreSubscribeConfig {
    /// Nominal (arbitration-phase) bitrate in bits/s.
    pub speed_bps: u64,
    /// Whether the interface should be opened in CAN-FD mode.
    pub fd_enabled: bool,
    /// FD data-phase bitrate in bits/s (only meaningful when
    /// `fd_enabled`). `0` means "same as `speed_bps`".
    pub fd_data_speed_bps: u64,
}

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
    /// Whether to expect an `InterfaceAllocated` envelope in
    /// response. Set this when subscribing to a virtual-bus factory
    /// id (ADR 0021); the worker thread blocks readiness until the
    /// allocated id arrives and surfaces it via the resolved
    /// subscriptions on [`RemoteCanFrameSource`].
    pub allocates: bool,
    /// Optional `ConfigureBus` to send before this subscribe. Lets
    /// hardware-server interfaces (PCAN, Vector, Kvaser via the
    /// python-can sidecar) open at the project-configured rate / FD
    /// mode from the start; non-sidecar servers (BLF replay, virtual
    /// bus) accept the envelope and ignore it.
    pub config: Option<PreSubscribeConfig>,
}

impl Subscription {
    /// Construct an ordinary (non-factory) subscription.
    #[must_use]
    pub fn new(interface_id: impl Into<String>, channel: u8) -> Self {
        Self {
            interface_id: interface_id.into(),
            channel,
            allocates: false,
            config: None,
        }
    }

    /// Construct a virtual-bus factory subscription (ADR 0021).
    #[must_use]
    pub fn factory(interface_id: impl Into<String>, channel: u8) -> Self {
        Self {
            interface_id: interface_id.into(),
            channel,
            allocates: true,
            config: None,
        }
    }

    /// Attach a pre-subscribe hardware configuration. The server
    /// receives a `ConfigureBus` envelope ahead of the corresponding
    /// `Subscribe`, so the underlying controller opens at the
    /// requested settings the first time round.
    #[must_use]
    pub fn with_config(mut self, config: PreSubscribeConfig) -> Self {
        self.config = Some(config);
        self
    }
}

/// A subscription as the server resolved it.
///
/// For ordinary subscribes `allocated_id` is `None` and
/// [`Self::effective_id`] returns the requested id. For factory
/// subscribes against a virtual-bus server, `allocated_id` holds the
/// participant id the server allocated, and
/// [`Self::effective_id`] returns that — the id the caller must use
/// when transmitting.
#[derive(Debug, Clone)]
pub struct ResolvedSubscription {
    /// The interface id the caller passed to [`connect_and_subscribe`].
    pub requested_id: String,
    /// The channel the caller asked frames to be tagged with.
    pub channel: u8,
    /// `Some(id)` when the server returned an `InterfaceAllocated`
    /// naming this subscription's participant; `None` otherwise.
    pub allocated_id: Option<String>,
}

impl ResolvedSubscription {
    /// The wire id frames on this subscription arrive with and
    /// transmits must be addressed to. The allocated id when present,
    /// otherwise the requested id.
    #[must_use]
    pub fn effective_id(&self) -> &str {
        self.allocated_id
            .as_deref()
            .unwrap_or(self.requested_id.as_str())
    }
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
pub async fn list_interfaces(config: &ConnectConfig) -> Result<Vec<Interface>, ConnectionError> {
    let response = config
        .client()
        .await?
        .list_interfaces(ListInterfacesRequest {})
        .await
        .map_err(ConnectionError::from)?;
    Ok(response
        .into_inner()
        .interfaces
        .into_iter()
        .map(Interface::from)
        .collect())
}

/// Long-lived subscription to a server's interface set (ADR 0016).
/// Connects, opens `WatchInterfaces`, and returns the streaming
/// response. Each message yielded by the stream is a fresh complete
/// snapshot — there's no diff format — so the consumer just replaces
/// its cache and re-renders.
///
/// The transport stays open for the lifetime of the returned stream;
/// dropping the stream ends the subscription. Reconnect-on-disconnect
/// is the caller's job — for the GUI host that's the subscription
/// manager in `sidecar.rs` (and the analogous remote manager).
pub async fn watch_interfaces(
    config: &ConnectConfig,
) -> Result<InterfaceWatchStream, ConnectionError> {
    let response = config
        .client()
        .await?
        .watch_interfaces(WatchInterfacesRequest {})
        .await
        .map_err(ConnectionError::from)?;
    Ok(InterfaceWatchStream {
        inner: response.into_inner(),
    })
}

/// Streaming response from [`watch_interfaces`]. Always yields one
/// snapshot on initial subscribe; whether further snapshots are pushed
/// as the server's view changes is the server's choice — clients must
/// not assume every change is pushed (re-subscribe or poll
/// `list_interfaces` for a guaranteed-fresh view).
pub struct InterfaceWatchStream {
    inner: tonic::Streaming<cannet_wire::proto::InterfaceList>,
}

impl InterfaceWatchStream {
    /// Wait for the next snapshot. Returns:
    ///
    /// - `Ok(Some(interfaces))` for each pushed snapshot.
    /// - `Ok(None)` once the server closes the stream cleanly.
    /// - `Err(_)` on transport failure.
    pub async fn next(&mut self) -> Result<Option<Vec<Interface>>, ConnectionError> {
        match self.inner.message().await {
            Ok(Some(list)) => Ok(Some(
                list.interfaces.into_iter().map(Interface::from).collect(),
            )),
            Ok(None) => Ok(None),
            Err(s) => Err(ConnectionError::from(s)),
        }
    }
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
    config: &ConnectConfig,
    subscriptions: Vec<Subscription>,
) -> Result<RemoteCanFrameSource, ConnectionError> {
    let config = config.clone();
    let (frame_tx, frame_rx) = mpsc::channel::<Result<CanFrame, ConnectionError>>();
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<SessionReady, ConnectionError>>(1);
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<()>();

    let thread = thread::Builder::new()
        .name("cannet-client".into())
        .spawn(move || {
            // Nothing is ever sent on `done_tx`; it exists so that its
            // drop — which happens only once the worker has returned and
            // its runtime is gone — wakes
            // `SessionHandle::shutdown_timeout`.
            let _done = done_tx;
            run_worker(&config, subscriptions, frame_tx, ready_tx, shutdown_rx);
        })
        .map_err(|e| ConnectionError::Thread(e.to_string()))?;

    match ready_rx.recv() {
        Ok(Ok(ready)) => Ok(RemoteCanFrameSource {
            receiver: FrameReceiver {
                rx: frame_rx,
                subscriptions: ready.resolved,
                clock: ready.clock,
            },
            handle: SessionHandle {
                shutdown_tx: Some(shutdown_tx),
                done_rx,
                _thread: thread,
            },
            transmitter: SessionTransmitter {
                req_tx: ready.req_tx,
            },
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(ConnectionError::Thread(
            "client worker thread exited before signalling readiness".into(),
        )),
    }
}

/// What the worker thread hands back to [`connect_and_subscribe`] when
/// the session is fully established (every subscribe sent, every
/// expected `InterfaceAllocated` received).
struct SessionReady {
    req_tx: tokio_mpsc::Sender<Envelope>,
    resolved: Vec<ResolvedSubscription>,
    /// Handed over already, though the probe it reports on is usually
    /// still in flight: readiness must not wait on the clock, and the
    /// caller reads the answer whenever it wants one.
    clock: SessionClock,
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
    /// The subscriptions this session was opened with — including
    /// the allocated id assigned by the server for any factory
    /// subscribe (`Subscription::allocates`).
    #[must_use]
    pub fn subscriptions(&self) -> &[ResolvedSubscription] {
        self.receiver.subscriptions()
    }

    /// This session's clock measurement — how far the server's wall
    /// clock is from ours. See [`FrameReceiver::clock`].
    #[must_use]
    pub fn clock(&self) -> &SessionClock {
        self.receiver.clock()
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
/// for a fatal in-band server error or transport failure. Per-frame
/// server errors (`TX_REJECTED`, `NOT_SUBSCRIBED`, `NO_ACKNOWLEDGER`)
/// are logged via `tracing` and do not interrupt the stream — see
/// [`is_per_frame_error_code`].
pub struct FrameReceiver {
    rx: mpsc::Receiver<Result<CanFrame, ConnectionError>>,
    subscriptions: Vec<ResolvedSubscription>,
    clock: SessionClock,
}

impl FrameReceiver {
    /// The subscriptions this session was opened with — including
    /// any server-allocated id (see [`ResolvedSubscription`]).
    #[must_use]
    pub fn subscriptions(&self) -> &[ResolvedSubscription] {
        &self.subscriptions
    }

    /// How far this server's wall clock is from ours, as measured at
    /// session start (see [`crate::clock`]).
    ///
    /// The frames this receiver yields are **not** corrected by it —
    /// they carry the timestamps the server sent. This is the measured
    /// number and its error bound, for a caller that wants to show it
    /// or act on it.
    ///
    /// Reads never block: the answer is
    /// [`clock::ClockProbeStatus::Pending`] until the probe window
    /// closes, then either a measurement or
    /// [`clock::ClockProbeStatus::Unsupported`] for a peer that never
    /// answered.
    #[must_use]
    pub fn clock(&self) -> &SessionClock {
        &self.clock
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
/// client logs the rejection at `warn` through the `tracing` crate
/// (target `cannet_client`) and keeps the rx loop running. Fatal codes
/// (`UNKNOWN_INTERFACE`, `BUSY`, unrecognised) still surface through
/// [`FrameReceiver::next_frame`]'s `ConnectionError::Server` variant.
#[derive(Clone)]
pub struct SessionTransmitter {
    req_tx: tokio_mpsc::Sender<Envelope>,
}

impl SessionTransmitter {
    /// Send `frame` over the session, addressed to `interface_id`.
    pub fn transmit(&self, interface_id: &str, frame: &CanFrame) -> Result<(), SessionClosed> {
        self.transmit_batch(interface_id, std::slice::from_ref(frame))
    }

    /// Send `frames` over the session as **one** `FrameBatch` envelope,
    /// addressed to `interface_id`, preserving order. The wire protocol
    /// carries batches natively (the server iterates a batch's frames),
    /// so a caller with several frames due at once — the transmit
    /// scheduler's tick — pays channel and proto overhead once instead
    /// of per frame. An empty slice sends nothing.
    pub fn transmit_batch(
        &self,
        interface_id: &str,
        frames: &[CanFrame],
    ) -> Result<(), SessionClosed> {
        if frames.is_empty() {
            return Ok(());
        }
        let envelope = Envelope {
            body: Some(Body::FrameBatch(FrameBatch {
                interface_id: interface_id.to_string(),
                frames: frames.iter().map(frame_to_proto).collect(),
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

    /// Push a hardware configuration to `interface_id`.
    ///
    /// `speed_bps` is the nominal (arbitration-phase) bitrate.
    /// `fd_enabled` flips the interface into CAN-FD mode; when set,
    /// `fd_data_speed_bps` is the data-phase bitrate (a value of `0`
    /// means "same as nominal"). The sidecar reconfigures the channel
    /// by close+reopen, so live `FrameBatch` flow on this interface
    /// resumes within a few hundred milliseconds.
    ///
    /// Conflict semantics across concurrent clients are whatever the
    /// underlying driver does on reopen (ADR 0022). Errors come back
    /// as a wire `LogMessage` (level Error) on this session, not as a
    /// synchronous response from this call — the caller observes
    /// success indirectly via subsequent frame flow.
    pub fn configure_bus(
        &self,
        interface_id: &str,
        speed_bps: u64,
        fd_enabled: bool,
        fd_data_speed_bps: u64,
    ) -> Result<(), SessionClosed> {
        let envelope = Envelope {
            body: Some(Body::ConfigureBus(ConfigureBus {
                interface_id: interface_id.to_string(),
                speed_bps,
                fd_data_speed_bps,
                fd_enabled,
            })),
        };
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
    /// Wakes when the worker thread's closure drops its sending half —
    /// i.e. once the worker has returned and its runtime, with the gRPC
    /// stream inside it, is gone. See [`Self::shutdown_timeout`].
    done_rx: mpsc::Receiver<()>,
    _thread: thread::JoinHandle<()>,
}

impl SessionHandle {
    /// Synchronously signal the worker to disconnect. Equivalent to
    /// dropping the handle; provided for explicitness at call sites.
    pub fn shutdown(self) {
        // Drop fires here, sending the signal.
    }

    /// Signal the worker to disconnect and wait up to `timeout` for it
    /// to finish tearing the session down. Returns whether it finished
    /// inside the budget.
    ///
    /// Signalling alone — [`Self::shutdown`] or a plain drop — is
    /// asynchronous: the worker learns of it on its next poll. A caller
    /// that is about to end the process needs more than that, because a
    /// session torn down by process death is indistinguishable, from the
    /// server's side, from a client that crashed. This is that wait, and
    /// the budget is what stops it turning into a hang when the worker
    /// is wedged.
    #[must_use]
    pub fn shutdown_timeout(mut self, timeout: Duration) -> bool {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        // `Disconnected` is the success case: the worker dropped its
        // sender on the way out.
        !matches!(
            self.done_rx.recv_timeout(timeout),
            Err(mpsc::RecvTimeoutError::Timeout)
        )
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

/// Classify a server-side [`cannet_wire::proto::Error::Code`] as
/// per-frame (non-fatal) or session-fatal.
///
/// Per-frame codes — `NOT_SUBSCRIBED`, `TX_REJECTED`, `NO_ACKNOWLEDGER`
/// — refer to a single transmit; the session keeps running and the
/// receiver keeps yielding frames. Fatal codes — `UNKNOWN_INTERFACE`
/// (subscribe target nonexistent) and `BUSY` (single-client server) —
/// end the rx loop and surface through [`FrameReceiver::next_frame`].
/// `UNSPECIFIED` and unrecognised codes are treated as fatal so a
/// new code variant can't accidentally be silently swallowed.
fn is_per_frame_error_code(code: i32) -> bool {
    use cannet_wire::proto::error::Code;
    matches!(
        Code::try_from(code),
        Ok(Code::NotSubscribed | Code::TxRejected | Code::NoAcknowledger),
    )
}

fn run_worker(
    config: &ConnectConfig,
    subscriptions: Vec<Subscription>,
    frame_tx: mpsc::Sender<Result<CanFrame, ConnectionError>>,
    ready_tx: mpsc::SyncSender<Result<SessionReady, ConnectionError>>,
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
        run_session(config, subscriptions, frame_tx, ready_tx, shutdown_rx).await;
    });
}

#[allow(clippy::too_many_lines)]
async fn run_session(
    config: &ConnectConfig,
    subscriptions: Vec<Subscription>,
    frame_tx: mpsc::Sender<Result<CanFrame, ConnectionError>>,
    ready_tx: mpsc::SyncSender<Result<SessionReady, ConnectionError>>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    let mut client = match config.client().await {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };

    let (req_tx, req_rx) = tokio_mpsc::channel::<Envelope>(REQUEST_CHANNEL_DEPTH);
    for sub in &subscriptions {
        if let Some(cfg) = sub.config {
            let envelope = Envelope {
                body: Some(Body::ConfigureBus(ConfigureBus {
                    interface_id: sub.interface_id.clone(),
                    speed_bps: cfg.speed_bps,
                    fd_data_speed_bps: cfg.fd_data_speed_bps,
                    fd_enabled: cfg.fd_enabled,
                })),
            };
            if req_tx.send(envelope).await.is_err() {
                let _ = ready_tx.send(Err(ConnectionError::Session(
                    "request channel closed before configure was sent".into(),
                )));
                return;
            }
        }
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
            let _ = ready_tx.send(Err(ConnectionError::from(s)));
            return;
        }
    };

    // Resolved-subscription state. For non-factory subscribes the
    // allocation is fixed up-front; for factory subscribes we wait
    // for `InterfaceAllocated` envelopes before signalling readiness
    // and populate the allocated id then.
    let mut resolved: Vec<ResolvedSubscription> = subscriptions
        .iter()
        .map(|s| ResolvedSubscription {
            requested_id: s.interface_id.clone(),
            channel: s.channel,
            allocated_id: None,
        })
        .collect();
    // FIFO of indices into `resolved` for the not-yet-matched factory
    // subscribes, in the order their `Subscribe` envelopes were sent.
    // The wire has no correlation id; we rely on the server emitting
    // `InterfaceAllocated`s in the same order it sees the
    // `Subscribe`s (which the in-tree virtual-bus server does).
    let mut pending_allocations: std::collections::VecDeque<usize> = subscriptions
        .iter()
        .enumerate()
        .filter_map(|(i, s)| if s.allocates { Some(i) } else { None })
        .collect();

    // `id_to_channel` is what the rx-pump arm below uses to tag
    // incoming frames. Seed it with the non-factory ids; factory
    // entries are added once `InterfaceAllocated` arrives. Indexed
    // by the wire id the server actually puts on `FrameBatch`.
    let mut id_to_channel = std::collections::HashMap::with_capacity(subscriptions.len());
    for sub in &subscriptions {
        if !sub.allocates {
            id_to_channel.insert(sub.interface_id.clone(), sub.channel);
        }
    }
    // For factory subscriptions, the virtual-bus server tags each
    // fan-out `FrameBatch` with the *sender's* allocated id (ADR 0021),
    // not the receiver's. So a client subscribed via factory id
    // `virtual:bus0` and assigned participant `virtual:bus0/p1`
    // observes frames tagged `virtual:bus0/p0`, `virtual:bus0/p2`, …
    // Map any id whose prefix matches a factory subscription's
    // requested id (plus the canonical separator) onto that
    // subscription's channel.
    let factory_prefixes: Vec<(String, u8)> = subscriptions
        .iter()
        .filter(|s| s.allocates)
        .map(|s| (format!("{}/", s.interface_id), s.channel))
        .collect();

    // Keep the request side of the bidi stream alive for the session's
    // lifetime — dropping it would close the request half early.
    let req_tx_for_handle = req_tx.clone();
    let _req_tx = req_tx;

    // The clock probe runs alongside everything else rather than
    // gating readiness: a session must come up at the speed of its
    // subscribes, and a server that never answers must cost nothing
    // but a status of `Unsupported` once the window closes.
    let clock = SessionClock::pending();
    let mut clock_samples: Vec<ClockSample> = Vec::with_capacity(CLOCK_PROBE_COUNT);
    let mut probes_sent = 0usize;
    let mut probe_window_open = true;
    let mut probe_spacing = tokio::time::interval(CLOCK_PROBE_SPACING);
    let probe_deadline = tokio::time::sleep(CLOCK_PROBE_DEADLINE);
    tokio::pin!(probe_deadline);

    let mut stream = response.into_inner();
    let mut ready_sent = false;
    let mut maybe_ready = Some(ready_tx);
    // Signal readiness now if there's nothing to wait for.
    if pending_allocations.is_empty() {
        if let Some(tx) = maybe_ready.take() {
            let _ = tx.send(Ok(SessionReady {
                req_tx: req_tx_for_handle.clone(),
                resolved: resolved.clone(),
                clock: clock.clone(),
            }));
        }
        ready_sent = true;
    }
    loop {
        tokio::select! {
            biased;
            // Treat a shutdown signal as the highest-priority branch so a
            // pending FrameBatch in the stream can't keep the worker
            // alive after the user has dropped the source.
            _ = &mut shutdown_rx => return,
            // Send the start-up probe burst. `try_send` rather than an
            // await: the probe is best-effort and must never be the
            // thing holding this loop up. A full queue just means the
            // next tick tries again, inside the deadline below.
            _ = probe_spacing.tick(), if probe_window_open && probes_sent < CLOCK_PROBE_COUNT => {
                let t1 = wall_clock_ns();
                if req_tx_for_handle
                    .try_send(Envelope {
                        body: Some(Body::ClockProbe(ClockProbe { t1 })),
                    })
                    .is_ok()
                {
                    probes_sent += 1;
                }
            }
            // The window closed with fewer than the full set of
            // replies. Whatever arrived is what the measurement rests
            // on; nothing at all means the peer does not answer.
            () = &mut probe_deadline, if probe_window_open => {
                probe_window_open = false;
                clock.settle(&clock_samples);
            }
            message = stream.next() => match message {
                Some(Ok(envelope)) => match envelope.body {
                    Some(Body::FrameBatch(batch)) => {
                        let channel = if let Some(c) =
                            id_to_channel.get(&batch.interface_id).copied()
                        {
                            c
                        } else {
                            let Some((_, c)) = factory_prefixes
                                .iter()
                                .find(|(p, _)| batch.interface_id.starts_with(p))
                            else {
                                continue;
                            };
                            *c
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
                    Some(Body::InterfaceAllocated(alloc)) => {
                        // Pair with the oldest unresolved factory subscribe.
                        if let Some(idx) = pending_allocations.pop_front() {
                            resolved[idx].allocated_id = Some(alloc.interface_id.clone());
                            id_to_channel.insert(
                                alloc.interface_id,
                                resolved[idx].channel,
                            );
                            if pending_allocations.is_empty() && !ready_sent {
                                if let Some(tx) = maybe_ready.take() {
                                    let _ = tx.send(Ok(SessionReady {
                                        req_tx: req_tx_for_handle.clone(),
                                        resolved: resolved.clone(),
                                        clock: clock.clone(),
                                    }));
                                }
                                ready_sent = true;
                            }
                        }
                    }
                    Some(Body::Error(err)) => {
                        // A server-side error during the
                        // wait-for-allocation phase is reported back
                        // through the readiness channel so the caller
                        // sees `connect_and_subscribe` fail, not a
                        // post-success rx error.
                        if !ready_sent {
                            if let Some(tx) = maybe_ready.take() {
                                let _ = tx.send(Err(ConnectionError::Server {
                                    code: err.code,
                                    message: err.message,
                                }));
                            }
                            return;
                        }
                        // Per-frame errors (a transmit was rejected, a
                        // FrameBatch hit a non-subscribed interface,
                        // a virtual-bus transmit reached no listener)
                        // should not tear the session down. Surface
                        // them through `tracing` so they're visible to
                        // an attached subscriber, and continue the rx
                        // loop. Genuinely fatal codes still bubble out.
                        if is_per_frame_error_code(err.code) {
                            tracing::warn!(
                                target: "cannet_client",
                                code = err.code,
                                "server reported per-frame error: {}",
                                err.message,
                            );
                            continue;
                        }
                        let _ = frame_tx.send(Err(ConnectionError::Server {
                            code: err.code,
                            message: err.message,
                        }));
                        return;
                    }
                    Some(Body::ClockReply(reply)) => {
                        // t4 first: anything done before sampling it
                        // lands in the measured delay.
                        let t4 = wall_clock_ns();
                        if probe_window_open {
                            clock_samples.push(clock::sample(
                                reply.t1, reply.t2, reply.t3, t4,
                            ));
                            if clock_samples.len() >= CLOCK_PROBE_COUNT {
                                probe_window_open = false;
                                clock.settle(&clock_samples);
                            }
                        }
                    }
                    // Subscribe / Unsubscribe round-trips (a peer
                    // echoing the request) are ignored; wire `Log`
                    // envelopes (ADR 0014) and the remaining
                    // virtual-bus / hardware-server envelopes
                    // (`InterfaceState`, `ConfigureBus`,
                    // `AttachBridge`, `DetachBridge`) have no
                    // consumer in this crate; the GUI host bridges
                    // them into its own surfaces. A `ClockProbe` is
                    // a client→server envelope, so one arriving here
                    // is a peer echoing. `None` is the no-body case.
                    // All drop.
                    Some(
                        Body::Log(_)
                        | Body::Subscribe(_)
                        | Body::Unsubscribe(_)
                        | Body::ConfigureBus(_)
                        | Body::InterfaceState(_)
                        | Body::AttachBridge(_)
                        | Body::DetachBridge(_)
                        | Body::ClockProbe(_),
                    )
                    | None => {}
                },
                Some(Err(status)) => {
                    if !ready_sent {
                        if let Some(tx) = maybe_ready.take() {
                            let _ = tx.send(Err(ConnectionError::from(status)));
                        }
                        return;
                    }
                    let _ = frame_tx.send(Err(ConnectionError::from(status)));
                    return;
                }
                None => {
                    if !ready_sent {
                        if let Some(tx) = maybe_ready.take() {
                            let _ = tx.send(Err(ConnectionError::Session(
                                "server closed stream before allocating".into(),
                            )));
                        }
                    }
                    return;
                }
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
    /// The server presented a certificate whose fingerprint is not the
    /// pinned one — or none was pinned yet. The handshake was refused
    /// before any request was made, so nothing was disclosed to the
    /// peer. Both fingerprints are in the `SHA256:` display form the
    /// server prints, so a prompt can show them verbatim; `expected` is
    /// `None` on a first contact.
    ///
    /// Terminal: retrying reaches the same server with the same
    /// certificate. A new identity has to be accepted by the user.
    PinMismatch {
        expected: Option<String>,
        observed: String,
    },
    /// The server refused the credential presented (or its absence).
    ///
    /// Terminal for the same reason: the token will not become correct
    /// by asking again.
    Unauthenticated,
    /// The address names a scheme that contradicts how the connection
    /// is protected — a pinned server dialled over `http://`. Raised
    /// before any packet is sent.
    InsecureScheme { address: String },
    /// The bearer token configured for this server cannot be sent as
    /// gRPC metadata, which is ASCII-only.
    InvalidToken,
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
            Self::PinMismatch {
                expected: Some(expected),
                observed,
            } => write!(
                f,
                "the server's certificate has changed: expected {expected}, got {observed}"
            ),
            Self::PinMismatch {
                expected: None,
                observed,
            } => write!(
                f,
                "the server's certificate {observed} has not been accepted yet"
            ),
            Self::Unauthenticated => write!(f, "the server rejected the access token"),
            Self::InsecureScheme { address } => write!(
                f,
                "{address} names an unencrypted scheme, but this server is reached over TLS"
            ),
            Self::InvalidToken => {
                write!(
                    f,
                    "the access token contains characters that cannot be sent"
                )
            }
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

impl From<tonic::Status> for ConnectionError {
    /// `unauthenticated` gets its own variant because it is the one
    /// status a caller must not retry: the server's gate refused the
    /// credential (ADR 0041), and asking again with the same one is
    /// hammering, not recovery. Everything else stays an opaque status.
    fn from(status: tonic::Status) -> Self {
        if status.code() == tonic::Code::Unauthenticated {
            Self::Unauthenticated
        } else {
            Self::Status(status.message().into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_wire::proto::error::Code;

    #[test]
    fn a_configs_debug_output_never_carries_the_token() {
        // `ConnectConfig` is public, so a downstream consumer's
        // `tracing::debug!(?config)` is one line away at all times. The
        // token has to be unprintable at the type, the way the server
        // keeps `Debug` off `AccessToken` entirely — a convention that
        // every call site has to remember is not a guarantee.
        let config = ConnectConfig::pinned_with_token(
            "bench:50051",
            CertPin::parse("SHA256:cs3ZAB6bqcYQMSlAn4EPl1BC/YPtVN4V1PDT5DL5aOU").unwrap(),
            "the-bearer-token-value",
        );
        let rendered = format!("{config:?}");
        assert!(
            !rendered.contains("the-bearer-token-value"),
            "the token must not be printable: {rendered}"
        );
        // The shape is still debuggable: address, pin, and the fact
        // that a credential is held.
        assert!(rendered.contains("bench:50051"), "{rendered}");
        assert!(rendered.contains("redacted"), "{rendered}");
    }

    #[test]
    fn transmit_batch_sends_one_envelope_with_all_frames_in_order() {
        // A scheduler tick's due frames for one interface ride one
        // Envelope — not one per frame — so per-envelope channel and
        // proto overhead stops scaling with message count.
        let (tx, mut rx) = tokio_mpsc::channel::<Envelope>(4);
        let t = SessionTransmitter { req_tx: tx };
        let frames: Vec<CanFrame> = (0..3u32)
            .map(|i| {
                CanFrame::classic(
                    u64::from(i),
                    0,
                    cannet_core::CanId::standard(0x100 + i).unwrap(),
                    cannet_core::Direction::Tx,
                    vec![u8::try_from(i).unwrap()],
                )
                .unwrap()
            })
            .collect();
        t.transmit_batch("if0", &frames).unwrap();
        let env = rx.try_recv().expect("one envelope");
        let Some(Body::FrameBatch(batch)) = env.body else {
            panic!("expected FrameBatch");
        };
        assert_eq!(batch.interface_id, "if0");
        assert_eq!(batch.frames.len(), 3);
        assert_eq!(
            batch.frames.iter().map(|f| f.can_id).collect::<Vec<_>>(),
            vec![0x100, 0x101, 0x102],
        );
        assert!(rx.try_recv().is_err(), "exactly one envelope");
    }

    #[test]
    fn transmit_batch_of_nothing_sends_nothing() {
        let (tx, mut rx) = tokio_mpsc::channel::<Envelope>(1);
        let t = SessionTransmitter { req_tx: tx };
        t.transmit_batch("if0", &[]).unwrap();
        assert!(rx.try_recv().is_err(), "no empty batches on the wire");
    }

    #[test]
    fn per_frame_codes_do_not_end_the_session() {
        assert!(is_per_frame_error_code(Code::TxRejected as i32));
        assert!(is_per_frame_error_code(Code::NotSubscribed as i32));
        assert!(is_per_frame_error_code(Code::NoAcknowledger as i32));
    }

    #[test]
    fn fatal_codes_end_the_session() {
        assert!(!is_per_frame_error_code(Code::Unspecified as i32));
        assert!(!is_per_frame_error_code(Code::UnknownInterface as i32));
        assert!(!is_per_frame_error_code(Code::Busy as i32));
    }

    #[test]
    fn unrecognised_codes_are_treated_as_fatal() {
        // A future code variant the client doesn't know about must
        // bubble out rather than be silently swallowed.
        assert!(!is_per_frame_error_code(999));
    }
}
