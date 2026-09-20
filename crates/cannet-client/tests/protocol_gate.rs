//! The protocol-major gate (ADR 0059): every connection this crate
//! makes asks `ServerInfo` first and refuses a server whose package
//! list does not hold ours.
//!
//! The fake server here serves the real `cannet.v1` service — so the
//! refusal cannot be an accident of the RPC being missing — while its
//! `ServerInfo` claims `cannet.v2` and nothing else. That is exactly
//! the shape of the future this rule exists for: a server that has
//! moved a major on, still answering the one unversioned RPC, telling
//! an old client what it now speaks.

use std::net::SocketAddr;

use cannet_client::{connect_and_subscribe, list_interfaces, watch_interfaces, ConnectConfig};
use cannet_client::{ConnectionError, Subscription};
use cannet_core::BusConfig;
use cannet_server::{ServerInfoImpl, VirtualBusServerImpl, VIRTUAL_BUS_FACTORY_ID};
use cannet_wire::info::cannet_info_server::{CannetInfo, CannetInfoServer};
use cannet_wire::info::{ServerInfoRequest, ServerInfoResponse};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Server;

/// A `ServerInfo` that answers with whatever package list it was built
/// with — the only way to stand up a server from a protocol major this
/// workspace does not implement.
struct FakeInfo {
    packages: Vec<String>,
}

#[tonic::async_trait]
impl CannetInfo for FakeInfo {
    async fn server_info(
        &self,
        _request: tonic::Request<ServerInfoRequest>,
    ) -> Result<tonic::Response<ServerInfoResponse>, tonic::Status> {
        Ok(tonic::Response::new(ServerInfoResponse {
            packages: self.packages.clone(),
            version: "v9.9.9".into(),
            instance_name: "future".into(),
        }))
    }
}

/// Which `ServerInfo` a test server mounts, if any.
enum Info {
    /// This workspace's own — the ordinary, compatible server.
    Ours,
    /// A server from another major, answering the unversioned RPC.
    Serving(&'static [&'static str]),
    /// A server built before `ServerInfo` existed: the call itself is
    /// `UNIMPLEMENTED`.
    None,
}

async fn spawn(info: Info) -> (SocketAddr, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let bus = VirtualBusServerImpl::new(BusConfig::classic_500k()).into_service();
    let handle = tokio::spawn(async move {
        let builder = Server::builder().add_service(bus);
        let _ = match info {
            Info::Ours => {
                builder
                    .add_service(ServerInfoImpl::new("v0.0.0-test", "ours").into_service())
                    .serve_with_incoming(stream)
                    .await
            }
            Info::Serving(packages) => {
                let fake = FakeInfo {
                    packages: packages.iter().map(|p| (*p).to_string()).collect(),
                };
                builder
                    .add_service(CannetInfoServer::new(fake))
                    .serve_with_incoming(stream)
                    .await
            }
            Info::None => builder.serve_with_incoming(stream).await,
        };
    });
    (addr, handle)
}

fn subscription() -> Vec<Subscription> {
    vec![Subscription::factory(VIRTUAL_BUS_FACTORY_ID, 0)]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_serving_another_major_is_refused_with_both_sides_named() {
    let (addr, server) = spawn(Info::Serving(&["cannet.v2"])).await;
    let config = ConnectConfig::plaintext(addr.to_string());

    let error = list_interfaces(&config)
        .await
        .expect_err("a cannet.v2-only server must not be listed from");
    assert!(
        matches!(&error, ConnectionError::IncompatibleProtocol { served } if served == &["cannet.v2"]),
        "{error:?}",
    );
    // The exact sentence the Servers panel, the CLI and the python
    // client all show. Both sides are in it, because "incompatible" on
    // its own tells whoever reads it nothing about what to do.
    assert_eq!(
        error.to_string(),
        "serves cannet.v2; this client speaks cannet.v1"
    );

    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn every_entry_point_asks_before_it_does_anything_else() {
    // The gate lives in one place on purpose; this is what proves the
    // three public ways in all go through it.
    let (addr, server) = spawn(Info::Serving(&["cannet.v2"])).await;
    let config = ConnectConfig::plaintext(addr.to_string());

    let watch = watch_interfaces(&config)
        .await
        .err()
        .expect("the interface subscription is refused too");
    assert!(
        matches!(watch, ConnectionError::IncompatibleProtocol { .. }),
        "{watch:?}",
    );

    let session = {
        let config = config.clone();
        tokio::task::spawn_blocking(move || connect_and_subscribe(&config, subscription()))
            .await
            .unwrap()
            .err()
            .expect("and so is the session that would put us on the bus")
    };
    assert!(
        matches!(session, ConnectionError::IncompatibleProtocol { .. }),
        "{session:?}",
    );

    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_that_cannot_be_asked_at_all_is_refused_rather_than_retried() {
    // A peer built before `ServerInfo` existed. `UNIMPLEMENTED` used to
    // fall through to a retry, which made an incompatible server
    // indistinguishable from one that keeps flapping.
    let (addr, server) = spawn(Info::None).await;
    let error = list_interfaces(&ConnectConfig::plaintext(addr.to_string()))
        .await
        .expect_err("a server with no ServerInfo is not one this client can speak to");
    assert!(
        matches!(error, ConnectionError::Unimplemented(_)),
        "{error:?}",
    );
    assert!(
        error.to_string().contains("this client speaks cannet.v1"),
        "{error}",
    );

    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_serving_our_major_among_others_is_accepted() {
    // The deprecation window the rule promises: a server that has moved
    // on keeps the old major beside the new one, and an unmigrated
    // client keeps working.
    let (addr, server) = spawn(Info::Serving(&["cannet.v1", "cannet.v2"])).await;
    let interfaces = list_interfaces(&ConnectConfig::plaintext(addr.to_string()))
        .await
        .expect("cannet.v1 is served, so the connection goes through");
    assert!(interfaces.iter().any(|i| i.id == VIRTUAL_BUS_FACTORY_ID));

    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ordinary_server_is_unaffected() {
    let (addr, server) = spawn(Info::Ours).await;
    let interfaces = list_interfaces(&ConnectConfig::plaintext(addr.to_string()))
        .await
        .expect("this workspace's own server serves this workspace's own package");
    assert!(interfaces.iter().any(|i| i.id == VIRTUAL_BUS_FACTORY_ID));

    server.abort();
}
