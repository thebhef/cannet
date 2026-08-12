//! End-to-end tests for the production hardware proxy (ADR 0040).
//!
//! The proxy's upstream is nothing more than a gRPC endpoint speaking
//! the cannet protocol, so these tests point it at in-process servers
//! this crate already ships — a virtual bus for the traffic cases, a
//! BLF replay for the single-client ones — and never at a Python
//! sidecar. What is under test is that envelopes cross the proxy
//! unaltered, in both directions, including the ones that end a
//! session.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use blf_asc::{ArbitrationId, BlfWriter, DataBytes, Message};
use cannet_core::BusConfig;
use cannet_server::{
    serve_virtual_bus_ephemeral, CannetServerImpl, LoopingBlfReplay, ProxyServerImpl,
    VIRTUAL_BUS_FACTORY_ID,
};
use cannet_wire::proto::{
    cannet_server_client::CannetServerClient, envelope::Body, error::Code,
    Direction as ProtoDirection, Envelope, Frame as ProtoFrame, FrameBatch, FrameKind,
    ListInterfacesRequest, Subscribe, WatchInterfacesRequest,
};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tokio_stream::StreamExt;
use tonic::transport::Server;

/// A proxy in front of `upstream`, on its own ephemeral port.
async fn spawn_proxy(upstream: SocketAddr) -> (SocketAddr, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let svc = ProxyServerImpl::new(move || Some(upstream.to_string())).into_service();
    let handle = tokio::spawn(async move {
        let _ = Server::builder()
            .add_service(svc)
            .serve_with_incoming(stream)
            .await;
    });
    (addr, handle)
}

/// A virtual bus (ADR 0021) as the thing being proxied.
async fn spawn_virtual_bus() -> (SocketAddr, JoinHandle<()>) {
    let config = BusConfig {
        speed_bps: 500_000,
        fd_data_speed_bps: None,
        fd_enabled: false,
    };
    let (addr_tx, addr_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        let _ = serve_virtual_bus_ephemeral(config, addr_tx).await;
    });
    (addr_rx.await.unwrap(), handle)
}

const TS_BASE: f64 = 1_700_000_000.0;

fn classic_msg(timestamp: f64, channel: u16, id: u32, data: Vec<u8>) -> Message {
    Message {
        timestamp: TS_BASE + timestamp,
        arbitration_id: ArbitrationId(id),
        is_extended_id: false,
        is_remote_frame: false,
        is_rx: true,
        is_error_frame: false,
        is_fd: false,
        bitrate_switch: false,
        error_state_indicator: false,
        dlc: u8::try_from(data.len()).unwrap(),
        data: DataBytes(data),
        channel,
    }
}

fn write_fixture(path: &Path, msgs: &[Message]) {
    let mut writer = BlfWriter::create(path).unwrap();
    for m in msgs {
        writer.on_message_received(m).unwrap();
    }
    writer.finish().unwrap();
}

/// A BLF replay as the thing being proxied. Single-client per process,
/// which is what makes it the right stand-in for a sidecar's
/// single-owner arbitration (ADR 0022).
async fn spawn_blf_replay() -> (SocketAddr, JoinHandle<()>) {
    let dir = tempfile::tempdir().unwrap();
    let blf_path = dir.path().join("proxy.blf");
    write_fixture(&blf_path, &[classic_msg(0.001, 0, 0x100, vec![1, 2])]);
    let replay = Arc::new(LoopingBlfReplay::open(&blf_path).unwrap());
    drop(dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let svc = CannetServerImpl::new(replay, 0.0).into_service();
    let handle = tokio::spawn(async move {
        let _ = Server::builder()
            .add_service(svc)
            .serve_with_incoming(stream)
            .await;
    });
    (addr, handle)
}

async fn connect(addr: SocketAddr) -> CannetServerClient<tonic::transport::Channel> {
    for _ in 0..20 {
        match CannetServerClient::connect(format!("http://{addr}")).await {
            Ok(client) => return client,
            Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }
    panic!("client could not connect to {addr}");
}

fn subscribe(interface_id: &str) -> Envelope {
    Envelope {
        body: Some(Body::Subscribe(Subscribe {
            interface_id: interface_id.into(),
        })),
    }
}

/// Open a session and subscribe to the virtual-bus factory, returning
/// the allocated participant id the server replied with.
async fn open_and_subscribe(
    addr: SocketAddr,
) -> (mpsc::Sender<Envelope>, tonic::Streaming<Envelope>, String) {
    let mut client = connect(addr).await;
    let (tx, rx) = mpsc::channel::<Envelope>(8);
    tx.send(subscribe(VIRTUAL_BUS_FACTORY_ID)).await.unwrap();
    let mut stream = client
        .session(ReceiverStream::new(rx))
        .await
        .unwrap()
        .into_inner();
    let env = next_envelope(&mut stream).await;
    let Some(Body::InterfaceAllocated(alloc)) = env.body else {
        panic!("expected InterfaceAllocated, got {env:?}");
    };
    (tx, stream, alloc.interface_id)
}

async fn next_envelope(stream: &mut tonic::Streaming<Envelope>) -> Envelope {
    timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("timed out waiting for an envelope")
        .expect("stream ended early")
        .expect("stream carried a transport error")
}

#[tokio::test(flavor = "multi_thread")]
async fn list_interfaces_reaches_the_client_unaltered() {
    let (upstream, upstream_handle) = spawn_virtual_bus().await;
    let (proxy, proxy_handle) = spawn_proxy(upstream).await;

    let direct = connect(upstream)
        .await
        .list_interfaces(ListInterfacesRequest {})
        .await
        .unwrap()
        .into_inner();
    let through_proxy = connect(proxy)
        .await
        .list_interfaces(ListInterfacesRequest {})
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        through_proxy, direct,
        "the proxy publishes the upstream's interfaces under their real identities"
    );
    assert!(through_proxy
        .interfaces
        .iter()
        .any(|i| i.id == VIRTUAL_BUS_FACTORY_ID));

    proxy_handle.abort();
    upstream_handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn watch_interfaces_relays_the_upstream_snapshot() {
    let (upstream, upstream_handle) = spawn_virtual_bus().await;
    let (proxy, proxy_handle) = spawn_proxy(upstream).await;

    let mut stream = connect(proxy)
        .await
        .watch_interfaces(WatchInterfacesRequest {})
        .await
        .unwrap()
        .into_inner();
    let snapshot = timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("timed out waiting for the watch snapshot")
        .expect("watch stream ended early")
        .expect("watch stream carried a transport error");

    assert!(snapshot
        .interfaces
        .iter()
        .any(|i| i.id == VIRTUAL_BUS_FACTORY_ID));

    proxy_handle.abort();
    upstream_handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_relays_envelopes_verbatim_in_both_directions() {
    let (upstream, upstream_handle) = spawn_virtual_bus().await;
    let (proxy, proxy_handle) = spawn_proxy(upstream).await;

    // One client through the proxy, one straight at the upstream: what
    // the proxied client sends has to reach the other participant as if
    // it had connected directly.
    let (proxied_tx, _proxied_stream, proxied_id) = open_and_subscribe(proxy).await;
    let (_direct_tx, mut direct_stream, direct_id) = open_and_subscribe(upstream).await;
    assert_ne!(proxied_id, direct_id);

    proxied_tx
        .send(Envelope {
            body: Some(Body::FrameBatch(FrameBatch {
                interface_id: proxied_id.clone(),
                frames: vec![ProtoFrame {
                    timestamp_ns: 42,
                    can_id: 0x123,
                    extended: false,
                    direction: ProtoDirection::Tx as i32,
                    kind: FrameKind::Classic as i32,
                    data: vec![0xDE, 0xAD],
                    brs: false,
                    esi: false,
                    dlc: 0,
                }],
            })),
        })
        .await
        .unwrap();

    let env = next_envelope(&mut direct_stream).await;
    let Some(Body::FrameBatch(batch)) = env.body else {
        panic!("expected a FrameBatch, got {env:?}");
    };
    assert_eq!(
        batch.interface_id, proxied_id,
        "the sender's allocated id crossed the proxy unchanged"
    );
    assert_eq!(batch.frames.len(), 1);
    assert_eq!(batch.frames[0].can_id, 0x123);
    assert_eq!(batch.frames[0].data, vec![0xDE, 0xAD]);

    proxy_handle.abort();
    upstream_handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_upstream_busy_rejection_reaches_the_client_untouched() {
    // The upstream arbitrates; the proxy neither re-terminates the
    // second session nor invents a rejection of its own.
    let (upstream, upstream_handle) = spawn_blf_replay().await;
    let (proxy, proxy_handle) = spawn_proxy(upstream).await;

    let mut first_client = connect(proxy).await;
    let (first_tx, first_rx) = mpsc::channel::<Envelope>(8);
    first_tx.send(subscribe("blf:0")).await.unwrap();
    let _first = first_client
        .session(ReceiverStream::new(first_rx))
        .await
        .unwrap()
        .into_inner();

    let mut second_client = connect(proxy).await;
    let (second_tx, second_rx) = mpsc::channel::<Envelope>(8);
    let mut second = second_client
        .session(ReceiverStream::new(second_rx))
        .await
        .unwrap()
        .into_inner();
    let env = next_envelope(&mut second).await;
    let Some(Body::Error(err)) = env.body else {
        panic!("expected the upstream's Error envelope, got {env:?}");
    };
    assert_eq!(err.code, i32::from(Code::Busy));

    drop(second_tx);
    drop(first_tx);
    proxy_handle.abort();
    upstream_handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_hanging_up_drops_its_upstream_session() {
    // A single-owner upstream is the only witness that matters: if the
    // proxy leaked the first session, the second client would be told
    // the server is Busy forever.
    let (upstream, upstream_handle) = spawn_blf_replay().await;
    let (proxy, proxy_handle) = spawn_proxy(upstream).await;

    {
        let mut client = connect(proxy).await;
        let (tx, rx) = mpsc::channel::<Envelope>(8);
        tx.send(subscribe("blf:0")).await.unwrap();
        let _stream = client
            .session(ReceiverStream::new(rx))
            .await
            .unwrap()
            .into_inner();
    } // client, request channel and response stream all drop here

    let mut second = connect(proxy).await;
    // The upstream releases its single-client gate when it sees the
    // relayed request stream end, which is a round trip away.
    for attempt in 0..40 {
        let (tx, rx) = mpsc::channel::<Envelope>(8);
        let mut stream = second
            .session(ReceiverStream::new(rx))
            .await
            .unwrap()
            .into_inner();
        tx.send(subscribe("blf:0")).await.unwrap();
        match timeout(Duration::from_millis(100), stream.next()).await {
            // A frame from the replay: the session was accepted.
            Ok(Some(Ok(env))) => {
                assert!(
                    !matches!(&env.body, Some(Body::Error(e)) if e.code == i32::from(Code::Busy)),
                    "the abandoned upstream session was never released"
                );
                break;
            }
            _ if attempt == 39 => panic!("no reply to the second session"),
            _ => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }

    proxy_handle.abort();
    upstream_handle.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_upstream_fails_the_rpc_rather_than_hanging() {
    // Bind and immediately release a port so we have an address nothing
    // is listening on.
    let dead = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap()
    };
    let (proxy, proxy_handle) = spawn_proxy(dead).await;

    let status = connect(proxy)
        .await
        .list_interfaces(ListInterfacesRequest {})
        .await
        .expect_err("an upstream that isn't there cannot be listed");
    assert_eq!(status.code(), tonic::Code::Unavailable);

    proxy_handle.abort();
}
