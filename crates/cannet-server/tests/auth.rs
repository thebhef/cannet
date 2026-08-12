//! Bearer-token authentication on a TLS endpoint (ADR 0041).
//!
//! The gate is mounted the way production mounts it — as a server-wide
//! layer, not per service — so these tests exercise what that buys:
//! every RPC the server answers is behind it. Each of the three
//! (`ListInterfaces`, `WatchInterfaces`, `Session`) is asked for
//! without a credential, with the wrong one, and with the right one.
//!
//! The channel is real TLS, because that is the only configuration in
//! which a token is enforced: it may not ride an unencrypted channel.

use std::net::SocketAddr;
use std::time::Duration;

use cannet_core::BusConfig;
use cannet_server::{
    auth::token_gate, install_crypto_provider, AccessToken, ServerIdentity, VirtualBusServerImpl,
    VIRTUAL_BUS_FACTORY_ID,
};
use cannet_wire::proto::{
    cannet_server_client::CannetServerClient, envelope::Body, Envelope, ListInterfacesRequest,
    Subscribe, WatchInterfacesRequest,
};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tokio_stream::StreamExt as _;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Server};

/// A token no server ever minted.
const WRONG_TOKEN: &str = "not-the-token-the-server-printed-at-startup0";

/// A TLS-terminating, token-gated virtual-bus endpoint on an ephemeral
/// port, plus the material a client needs to reach it.
async fn spawn_protected_server() -> (
    SocketAddr,
    ServerIdentity,
    AccessToken,
    tempfile::TempDir,
    JoinHandle<()>,
) {
    install_crypto_provider();
    let dir = tempfile::tempdir().unwrap();
    let identity = ServerIdentity::load_or_generate(dir.path()).unwrap();
    let token = AccessToken::load_or_generate(dir.path()).unwrap();
    let tls = identity.tls_config();
    let gate = tonic::service::interceptor(token_gate(Some(token.clone())));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let service = VirtualBusServerImpl::new(BusConfig {
        speed_bps: 500_000,
        fd_data_speed_bps: None,
        fd_enabled: false,
    })
    .into_service();
    let handle = tokio::spawn(async move {
        let _ = Server::builder()
            .tls_config(tls)
            .unwrap()
            .layer(gate)
            .add_service(service)
            .serve_with_incoming(stream)
            .await;
    });
    (addr, identity, token, dir, handle)
}

/// A TLS channel to `addr`, trusting the certificate it presents.
/// Pinning is the client's half of ADR 0041 and is not what these tests
/// are about, so the certificate is handed over as a CA.
async fn connect(addr: SocketAddr, identity: &ServerIdentity) -> Channel {
    Channel::from_shared(format!("https://localhost:{}", addr.port()))
        .unwrap()
        .tls_config(
            ClientTlsConfig::new()
                .ca_certificate(Certificate::from_pem(identity.cert_pem()))
                .domain_name("localhost"),
        )
        .unwrap()
        .connect()
        .await
        .expect("the handshake should succeed against the server's own certificate")
}

/// An interceptor that presents `token` as an RFC 6750 credential, or
/// nothing at all when `token` is `None`.
// `tonic::Status` is the only error an interceptor may return, large or
// not.
#[allow(clippy::result_large_err)]
fn credential(token: Option<&str>) -> impl tonic::service::Interceptor + Clone {
    let header = token.map(|token| format!("Bearer {token}"));
    move |mut request: tonic::Request<()>| {
        if let Some(header) = &header {
            request
                .metadata_mut()
                .insert("authorization", header.parse().unwrap());
        }
        Ok(request)
    }
}

#[track_caller]
fn assert_unauthenticated(status: &tonic::Status, why: &str) {
    assert_eq!(status.code(), tonic::Code::Unauthenticated, "{why}");
    assert!(
        !status.message().contains(WRONG_TOKEN),
        "the server must not echo what was presented back to the caller: {}",
        status.message()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn list_interfaces_is_gated() {
    let (addr, identity, token, _dir, handle) = spawn_protected_server().await;
    let channel = connect(addr, &identity).await;

    let status = CannetServerClient::with_interceptor(channel.clone(), credential(None))
        .list_interfaces(ListInterfacesRequest {})
        .await
        .expect_err("no credential, no listing");
    assert_unauthenticated(
        &status,
        "an anonymous caller learns nothing about the hardware",
    );

    let status =
        CannetServerClient::with_interceptor(channel.clone(), credential(Some(WRONG_TOKEN)))
            .list_interfaces(ListInterfacesRequest {})
            .await
            .expect_err("the wrong token is no better than none");
    assert_unauthenticated(&status, "wrong token");

    let interfaces =
        CannetServerClient::with_interceptor(channel, credential(Some(token.as_str())))
            .list_interfaces(ListInterfacesRequest {})
            .await
            .expect("the token the server printed must open the RPC")
            .into_inner();
    assert_eq!(interfaces.interfaces.len(), 1);

    handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn watch_interfaces_is_gated() {
    let (addr, identity, token, _dir, handle) = spawn_protected_server().await;
    let channel = connect(addr, &identity).await;

    let status = CannetServerClient::with_interceptor(channel.clone(), credential(None))
        .watch_interfaces(WatchInterfacesRequest {})
        .await
        .expect_err("a stream is refused at the same door a unary call is");
    assert_unauthenticated(&status, "no credential");

    let status =
        CannetServerClient::with_interceptor(channel.clone(), credential(Some(WRONG_TOKEN)))
            .watch_interfaces(WatchInterfacesRequest {})
            .await
            .expect_err("wrong token");
    assert_unauthenticated(&status, "wrong token");

    let mut stream =
        CannetServerClient::with_interceptor(channel, credential(Some(token.as_str())))
            .watch_interfaces(WatchInterfacesRequest {})
            .await
            .expect("the right token opens the watch")
            .into_inner();
    let snapshot = timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("timed out waiting for the first snapshot")
        .expect("the watch stream ended early")
        .expect("the watch stream carried a transport error");
    assert!(snapshot
        .interfaces
        .iter()
        .any(|i| i.id == VIRTUAL_BUS_FACTORY_ID));

    handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn session_is_gated() {
    let (addr, identity, token, _dir, handle) = spawn_protected_server().await;
    let channel = connect(addr, &identity).await;

    // The RPC that matters most: opening a session is what puts a
    // client on the hardware (ADR 0041's primary risk).
    let (_tx, rx) = mpsc::channel::<Envelope>(8);
    let status = CannetServerClient::with_interceptor(channel.clone(), credential(None))
        .session(ReceiverStream::new(rx))
        .await
        .expect_err("an unauthenticated caller must never reach a bus");
    assert_unauthenticated(&status, "no credential");

    let (_tx, rx) = mpsc::channel::<Envelope>(8);
    let status =
        CannetServerClient::with_interceptor(channel.clone(), credential(Some(WRONG_TOKEN)))
            .session(ReceiverStream::new(rx))
            .await
            .expect_err("wrong token");
    assert_unauthenticated(&status, "wrong token");

    let (tx, rx) = mpsc::channel::<Envelope>(8);
    tx.send(Envelope {
        body: Some(Body::Subscribe(Subscribe {
            interface_id: VIRTUAL_BUS_FACTORY_ID.into(),
        })),
    })
    .await
    .unwrap();
    let mut stream =
        CannetServerClient::with_interceptor(channel, credential(Some(token.as_str())))
            .session(ReceiverStream::new(rx))
            .await
            .expect("the right token opens a session")
            .into_inner();
    let envelope = timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("timed out waiting for the subscription reply")
        .expect("the session ended early")
        .expect("the session carried a transport error");
    assert!(
        matches!(envelope.body, Some(Body::InterfaceAllocated(_))),
        "an authenticated session behaves exactly as an ungated one: {envelope:?}"
    );

    handle.abort();
}
