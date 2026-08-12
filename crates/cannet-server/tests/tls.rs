//! TLS termination on a cannet endpoint (ADR 0041).
//!
//! The server presents the identity it generated for itself; a client
//! that has been handed that certificate out of band completes a real
//! handshake and a real RPC through it, and a client that speaks
//! plaintext to the same port gets nowhere. Certificate *pinning* — the
//! client-side half of ADR 0041's trust model — is not here: this test
//! trusts the certificate as a CA, which is the plain tonic way to
//! prove the server side terminates TLS correctly.

use std::net::SocketAddr;

use cannet_core::BusConfig;
use cannet_server::{install_crypto_provider, ServerIdentity, VirtualBusServerImpl};
use cannet_wire::proto::{cannet_server_client::CannetServerClient, ListInterfacesRequest};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Server};

fn bus_config() -> BusConfig {
    BusConfig {
        speed_bps: 500_000,
        fd_data_speed_bps: None,
        fd_enabled: false,
    }
}

/// A TLS-terminating virtual-bus endpoint on an ephemeral port, plus
/// the identity it presents.
async fn spawn_tls_server() -> (
    SocketAddr,
    ServerIdentity,
    tempfile::TempDir,
    JoinHandle<()>,
) {
    install_crypto_provider();
    let dir = tempfile::tempdir().unwrap();
    let identity = ServerIdentity::load_or_generate(dir.path()).unwrap();
    let tls = identity.tls_config();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let service = VirtualBusServerImpl::new(bus_config()).into_service();
    let handle = tokio::spawn(async move {
        let _ = Server::builder()
            .tls_config(tls)
            .unwrap()
            .add_service(service)
            .serve_with_incoming(stream)
            .await;
    });
    (addr, identity, dir, handle)
}

#[tokio::test]
async fn a_client_holding_the_certificate_completes_an_rpc_over_tls() {
    let (addr, identity, _dir, handle) = spawn_tls_server().await;

    // `localhost` is one of the SANs on the generated certificate, so a
    // client can name the server without any name-check exemption.
    let tls = ClientTlsConfig::new()
        .ca_certificate(Certificate::from_pem(identity.cert_pem()))
        .domain_name("localhost");
    let channel = Channel::from_shared(format!("https://localhost:{}", addr.port()))
        .unwrap()
        .tls_config(tls)
        .unwrap()
        .connect()
        .await
        .expect("the handshake should succeed against the server's own certificate");

    let interfaces = CannetServerClient::new(channel)
        .list_interfaces(ListInterfacesRequest {})
        .await
        .expect("ListInterfaces should cross the TLS channel")
        .into_inner();
    assert_eq!(interfaces.interfaces.len(), 1);

    handle.abort();
}

#[tokio::test]
async fn a_client_without_the_certificate_is_refused() {
    let (addr, _identity, _dir, handle) = spawn_tls_server().await;

    // No CA configured: the self-signed certificate chains to nothing
    // the client's roots know, so the handshake must fail rather than
    // fall back to anything.
    let result = Channel::from_shared(format!("https://localhost:{}", addr.port()))
        .unwrap()
        .tls_config(ClientTlsConfig::new().domain_name("localhost"))
        .unwrap()
        .connect()
        .await;
    assert!(
        result.is_err(),
        "an untrusted self-signed certificate must not be accepted"
    );

    handle.abort();
}

#[tokio::test]
async fn a_plaintext_client_gets_nowhere_against_the_tls_port() {
    let (addr, _identity, _dir, handle) = spawn_tls_server().await;

    let channel = Channel::from_shared(format!("http://{addr}")).unwrap();
    let outcome = match channel.connect().await {
        // Plaintext h2 to a TLS listener: the connect may complete at
        // the TCP level, in which case the first RPC is what fails.
        Ok(channel) => CannetServerClient::new(channel)
            .list_interfaces(ListInterfacesRequest {})
            .await
            .err()
            .map(|status| status.to_string()),
        Err(e) => Some(e.to_string()),
    };
    assert!(
        outcome.is_some(),
        "a plaintext client must not reach a TLS endpoint"
    );

    handle.abort();
}
