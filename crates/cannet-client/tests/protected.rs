//! The client half of ADR 0041: a pinned, token-carrying connection
//! against a server that terminates TLS and gates every RPC.
//!
//! The server side is the production configuration — `ServerTlsConfig`
//! from a generated identity, the token gate mounted as a server-wide
//! layer — so what these tests exercise is exactly what a `--tls
//! --token` proxy presents.

use std::net::SocketAddr;
use std::time::Duration;

use cannet_client::tls::CertPin;
use cannet_client::{
    connect_and_subscribe, list_interfaces, watch_interfaces, ConnectConfig, ConnectionError,
    Subscription,
};
use cannet_core::{BusConfig, CanFrameSource};
use cannet_server::{
    auth::token_gate, install_crypto_provider, AccessToken, ServerIdentity, VirtualBusServerImpl,
    VIRTUAL_BUS_FACTORY_ID,
};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Server;

/// A token no server ever minted.
const WRONG_TOKEN: &str = "not-the-token-the-server-printed-at-startup0";

/// Everything a client needs to reach the protected server, and the
/// handle that shuts it down.
struct Protected {
    address: String,
    pin: CertPin,
    token: String,
    _dir: tempfile::TempDir,
    handle: JoinHandle<()>,
}

/// A TLS-terminating, token-gated virtual-bus endpoint on an ephemeral
/// loopback port.
async fn spawn_protected_server() -> Protected {
    install_crypto_provider();
    let dir = tempfile::tempdir().unwrap();
    let identity = ServerIdentity::load_or_generate(dir.path()).unwrap();
    let token = AccessToken::load_or_generate(dir.path()).unwrap();
    // The client is handed the fingerprint as text, exactly as an
    // operator copies it off the server's startup banner.
    let pin = CertPin::parse(&identity.fingerprint().to_string()).unwrap();
    let tls = identity.tls_config();
    let gate = tonic::service::interceptor(token_gate(Some(token.clone())));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let service = VirtualBusServerImpl::new(BusConfig::classic_500k()).into_service();
    let handle = tokio::spawn(async move {
        let _ = Server::builder()
            .tls_config(tls)
            .unwrap()
            .layer(gate)
            .add_service(service)
            .serve_with_incoming(stream)
            .await;
    });
    Protected {
        address: addr.to_string(),
        pin,
        token: token.as_str().to_string(),
        _dir: dir,
        handle,
    }
}

impl Protected {
    /// The configuration a GUI holds for this server once the user has
    /// accepted its fingerprint and entered its token.
    fn config(&self) -> ConnectConfig {
        ConnectConfig::pinned_with_token(&self.address, self.pin, &self.token)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pinned_client_with_the_token_lists_interfaces() {
    let server = spawn_protected_server().await;

    let interfaces = list_interfaces(&server.config())
        .await
        .expect("the pinned certificate and the minted token are all this needs");
    assert_eq!(interfaces.len(), 1);
    assert_eq!(interfaces[0].id, VIRTUAL_BUS_FACTORY_ID);

    server.handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn every_entry_point_carries_the_credential() {
    // The token gates all three RPCs, so a config that only reached
    // `ListInterfaces` would leave the other two unusable.
    let server = spawn_protected_server().await;
    let config = server.config();

    let mut stream = watch_interfaces(&config)
        .await
        .expect("WatchInterfaces must present the credential too");
    let snapshot = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("timed out waiting for the first snapshot")
        .expect("the watch stream carried an error")
        .expect("the watch stream ended before its first snapshot");
    assert_eq!(snapshot.len(), 1);
    drop(stream);

    // Two sessions, because the virtual bus fans a frame out to the
    // *other* participants — which also proves the credential is not
    // consumed by the first connection to use it.
    let open = |config: ConnectConfig, channel: u8| {
        tokio::task::spawn_blocking(move || {
            connect_and_subscribe(
                &config,
                vec![Subscription::factory(VIRTUAL_BUS_FACTORY_ID, channel)],
            )
        })
    };
    let sender = open(config.clone(), 0)
        .await
        .unwrap()
        .expect("Session must present the credential too");
    let listener = open(config, 1).await.unwrap().expect("second session");
    let allocated = sender
        .subscriptions()
        .first()
        .and_then(|s| s.allocated_id.clone())
        .expect("an authenticated session behaves exactly like an ungated one");

    // And frames really cross the pinned channel.
    let (_sender_handle, _sender_rx, transmitter) = sender.into_parts();
    let (_listener_handle, mut listener, _listener_tx) = listener.into_parts();
    let frame = cannet_core::CanFrame::classic(
        0,
        0,
        cannet_core::CanId::standard(0x321).unwrap(),
        cannet_core::Direction::Tx,
        vec![1, 2, 3],
    )
    .unwrap();
    let received = tokio::task::spawn_blocking(move || {
        transmitter.transmit(&allocated, &frame).unwrap();
        listener.next_frame()
    })
    .await
    .unwrap()
    .expect("the session must stay live over TLS")
    .expect("the transmitted frame must reach the other participant");
    assert_eq!(received.id.raw(), 0x321);
    assert_eq!(received.channel, 1);

    server.handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pinned_client_without_the_token_is_unauthenticated() {
    let server = spawn_protected_server().await;

    let error = list_interfaces(&ConnectConfig::pinned(&server.address, server.pin))
        .await
        .expect_err("pinning the certificate is not authentication");
    assert!(
        matches!(error, ConnectionError::Unauthenticated),
        "a rejected credential must be its own terminal variant, got {error:?}"
    );

    server.handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pinned_client_with_the_wrong_token_is_unauthenticated() {
    let server = spawn_protected_server().await;

    let error = list_interfaces(&ConnectConfig::pinned_with_token(
        &server.address,
        server.pin,
        WRONG_TOKEN,
    ))
    .await
    .expect_err("a near-miss token is still a miss");
    assert!(
        matches!(error, ConnectionError::Unauthenticated),
        "got {error:?}"
    );

    server.handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_wrong_pin_refuses_the_connection_and_names_both_fingerprints() {
    let server = spawn_protected_server().await;
    // A fingerprint from some other server — what a client holds after
    // the operator reinstalled the machine, or an attacker took the port.
    let other = tempfile::tempdir().unwrap();
    let stale = CertPin::parse(
        &ServerIdentity::load_or_generate(other.path())
            .unwrap()
            .fingerprint()
            .to_string(),
    )
    .unwrap();

    let error = list_interfaces(&ConnectConfig::pinned_with_token(
        &server.address,
        stale,
        &server.token,
    ))
    .await
    .expect_err("a server whose certificate changed must not be talked to");
    let ConnectionError::PinMismatch { expected, observed } = error else {
        panic!("expected a pin mismatch, got {error:?}");
    };
    assert_eq!(
        expected,
        Some(stale.to_string()),
        "the dialog has to show what was pinned"
    );
    assert_eq!(
        observed,
        server.pin.to_string(),
        "and what the server presented instead"
    );

    server.handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_first_contact_reports_the_fingerprint_with_nothing_expected() {
    // The trust-on-first-use probe: the handshake is refused, and the
    // fingerprint comes back for the user to accept. `expected: None` is
    // what distinguishes "new server" from "identity changed".
    let server = spawn_protected_server().await;

    let error = list_interfaces(&ConnectConfig::unpinned(&server.address))
        .await
        .expect_err("an unaccepted certificate is not trusted just because it is the first");
    let ConnectionError::PinMismatch { expected, observed } = error else {
        panic!("expected a pin mismatch, got {error:?}");
    };
    assert_eq!(expected, None);
    assert_eq!(observed, server.pin.to_string());

    server.handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pinned_config_refuses_an_http_address_without_dialling() {
    // Nothing listens on this port, so a `Connect` error would prove the
    // client went to the network anyway; the scheme conflict has to be
    // settled before a socket is opened.
    let unreachable: SocketAddr = "127.0.0.1:1".parse().unwrap();
    let pin = CertPin::parse("SHA256:/9c5GMrPKEb+y88Cz/9IR6C9kgQbs5hYt4Qa3FSat9c").unwrap();

    let error = list_interfaces(&ConnectConfig::pinned_with_token(
        format!("http://{unreachable}"),
        pin,
        "a-token-that-must-never-be-sent-in-the-clear",
    ))
    .await
    .expect_err("a pinned server may not be reached over an unencrypted scheme");
    assert!(
        matches!(error, ConnectionError::InsecureScheme { .. }),
        "got {error:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pinned_config_accepts_an_https_address() {
    // The scheme the address may spell out is the one the connection
    // actually uses; writing it must not be an error.
    let server = spawn_protected_server().await;

    let interfaces = list_interfaces(&ConnectConfig::pinned_with_token(
        format!("https://{}", server.address),
        server.pin,
        &server.token,
    ))
    .await
    .expect("`https://` is what a pinned connection is");
    assert_eq!(interfaces.len(), 1);

    server.handle.abort();
}
