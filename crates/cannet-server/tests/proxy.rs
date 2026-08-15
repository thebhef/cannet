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
use std::sync::{Arc, Mutex};
use std::time::Duration;

use blf_asc::{ArbitrationId, BlfWriter, DataBytes, Message};
use cannet_core::BusConfig;
use cannet_server::{
    serve_virtual_bus_ephemeral, CannetServerImpl, LoopingBlfReplay, ProxyServerImpl,
    VIRTUAL_BUS_FACTORY_ID,
};
use cannet_wire::proto::{
    cannet_server_client::CannetServerClient, envelope::Body, error::Code, ClockProbe,
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

/// A virtual bus that records the `authorization` metadata of every
/// RPC it is asked for — the upstream's own view of what reached it.
async fn spawn_recording_upstream() -> (SocketAddr, Arc<Mutex<Vec<Option<String>>>>, JoinHandle<()>)
{
    let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let recorder = Arc::clone(&seen);
    #[allow(clippy::result_large_err)] // `Status` is an interceptor's only error type.
    let record = move |request: tonic::Request<()>| {
        recorder.lock().unwrap().push(
            request
                .metadata()
                .get("authorization")
                .map(|value| value.to_str().unwrap_or("<not ascii>").to_string()),
        );
        Ok::<_, tonic::Status>(request)
    };

    let config = BusConfig {
        speed_bps: 500_000,
        fd_data_speed_bps: None,
        fd_enabled: false,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let svc = cannet_server::VirtualBusServerImpl::new(config).into_service();
    let handle = tokio::spawn(async move {
        let _ = Server::builder()
            .layer(tonic::service::interceptor(record))
            .add_service(svc)
            .serve_with_incoming(stream)
            .await;
    });
    (addr, seen, handle)
}

/// A client-side interceptor presenting a bearer token, as a client of
/// a protected endpoint would (ADR 0041).
// The `Result` is the interceptor signature tonic asks for, and
// `Status` is the only error it may carry; this one just never fails.
#[allow(clippy::result_large_err, clippy::unnecessary_wraps)]
fn with_credential(mut request: tonic::Request<()>) -> Result<tonic::Request<()>, tonic::Status> {
    request
        .metadata_mut()
        .insert("authorization", "Bearer a-client-secret".parse().unwrap());
    Ok(request)
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
async fn the_proxy_forwards_no_client_credentials_upstream() {
    // The client's bearer token authenticates it to *this* endpoint
    // (ADR 0041). The upstream is a supervised sidecar on loopback that
    // never asked for one, so relaying the credential would leak it one
    // hop further than it belongs. The proxy builds a fresh request per
    // upstream call, which is what keeps that true — pinned here so it
    // stays deliberate.
    let (upstream, seen, upstream_handle) = spawn_recording_upstream().await;
    let (proxy, proxy_handle) = spawn_proxy(upstream).await;

    // First, straight at the upstream: proves the credential is really
    // being sent, so the assertion below cannot pass vacuously.
    let direct = CannetServerClient::with_interceptor(
        tonic::transport::Channel::from_shared(format!("http://{upstream}"))
            .unwrap()
            .connect()
            .await
            .unwrap(),
        with_credential,
    )
    .list_interfaces(ListInterfacesRequest {})
    .await
    .unwrap();
    assert_eq!(direct.into_inner().interfaces.len(), 1);
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        [Some("Bearer a-client-secret".to_string())],
        "a client that presents a credential does reach this upstream with it"
    );
    seen.lock().unwrap().clear();

    let channel = tonic::transport::Channel::from_shared(format!("http://{proxy}"))
        .unwrap()
        .connect()
        .await
        .unwrap();

    CannetServerClient::with_interceptor(channel.clone(), with_credential)
        .list_interfaces(ListInterfacesRequest {})
        .await
        .unwrap();
    let mut watch = CannetServerClient::with_interceptor(channel.clone(), with_credential)
        .watch_interfaces(WatchInterfacesRequest {})
        .await
        .unwrap()
        .into_inner();
    timeout(Duration::from_secs(5), watch.next())
        .await
        .expect("timed out waiting for the relayed snapshot")
        .expect("the watch stream ended early")
        .expect("the watch stream carried a transport error");
    let (tx, rx) = mpsc::channel::<Envelope>(8);
    tx.send(subscribe(VIRTUAL_BUS_FACTORY_ID)).await.unwrap();
    let mut session = CannetServerClient::with_interceptor(channel, with_credential)
        .session(ReceiverStream::new(rx))
        .await
        .unwrap()
        .into_inner();
    next_envelope(&mut session).await;

    let seen = seen.lock().unwrap();
    assert_eq!(
        seen.len(),
        3,
        "all three RPCs should have reached the upstream: {seen:?}"
    );
    assert!(
        seen.iter().all(Option::is_none),
        "the proxy must present no credential of the client's upstream: {seen:?}"
    );

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

/// A bare TCP relay in front of `target`, on its own ephemeral port,
/// whose connection can be severed on command. Cutting it drops both
/// sockets with no protocol-level goodbye — no `GOAWAY`, no
/// `END_STREAM`, nothing the peer can read as "I meant to leave" — which
/// is what the server sees when a client process is killed. Serves one
/// connection, which is all a session needs.
async fn spawn_severable_tunnel(
    target: SocketAddr,
) -> (SocketAddr, tokio::sync::oneshot::Sender<()>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (cut_tx, cut_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let (mut inbound, _) = listener.accept().await.unwrap();
        let mut outbound = tokio::net::TcpStream::connect(target).await.unwrap();
        tokio::select! {
            _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound) => {}
            _ = cut_rx => {}
        }
        // Both halves drop here.
    });
    (addr, cut_tx, handle)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_killed_mid_session_leaves_the_server_ready_for_the_next_one() {
    // The owner's case: quit the GUI (or kill it) while a session is
    // streaming, then connect again. Nothing nominal is ever sent — the
    // transport simply dies — and the server has to notice on its own,
    // or the hardware stays claimed by a client that no longer exists.
    // A single-owner upstream is the witness: if the abandoned session
    // leaked, the next one is told Busy forever.
    let (upstream, upstream_handle) = spawn_blf_replay().await;
    let (proxy, proxy_handle) = spawn_proxy(upstream).await;
    let (tunnel, cut, tunnel_handle) = spawn_severable_tunnel(proxy).await;

    let mut client = connect(tunnel).await;
    let (tx, rx) = mpsc::channel::<Envelope>(8);
    tx.send(subscribe("blf:0")).await.unwrap();
    let mut stream = client
        .session(ReceiverStream::new(rx))
        .await
        .unwrap()
        .into_inner();
    // A frame proves the session reached the upstream and is streaming
    // — otherwise the assertion below could pass against a session that
    // never claimed anything.
    let env = next_envelope(&mut stream).await;
    assert!(
        matches!(env.body, Some(Body::FrameBatch(_))),
        "expected a frame from the replay, got {env:?}",
    );

    // Sever the transport under the live session. The client side is
    // left entirely intact — its request stream is still open, and it is
    // held past the assertions below — so nothing here sends a close.
    cut.send(()).unwrap();

    let mut second = connect(proxy).await;
    let mut served = false;
    for _ in 0..40 {
        let (second_tx, second_rx) = mpsc::channel::<Envelope>(8);
        let mut second_stream = second
            .session(ReceiverStream::new(second_rx))
            .await
            .unwrap()
            .into_inner();
        second_tx.send(subscribe("blf:0")).await.unwrap();
        if let Ok(Some(Ok(env))) = timeout(Duration::from_millis(100), second_stream.next()).await {
            assert!(
                !matches!(&env.body, Some(Body::Error(e)) if e.code == i32::from(Code::Busy)),
                "the killed client's session was never released",
            );
            served = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(served, "no session was served after the client was killed");

    drop((client, tx, stream));
    tunnel_handle.abort();
    proxy_handle.abort();
    upstream_handle.abort();
}

#[tokio::test]
async fn a_clock_probe_crosses_to_the_upstream_and_its_reply_comes_back() {
    // The proxy does not answer clock probes itself. The clock a client
    // is measuring is the one that stamps the frames it will receive,
    // and that clock belongs to the upstream process — so the probe is
    // relayed like every other envelope and the upstream's stamps are
    // what come back. Anything else would measure a neighbouring
    // process and be right only by deployment coincidence.
    let (upstream_addr, upstream) = spawn_virtual_bus().await;
    let (proxy_addr, proxy) = spawn_proxy(upstream_addr).await;

    let mut client = connect(proxy_addr).await;
    let (tx, rx) = mpsc::channel::<Envelope>(8);
    let t1 = 1_760_000_000_123_456_789;
    tx.send(Envelope {
        body: Some(Body::ClockProbe(ClockProbe { t1 })),
    })
    .await
    .unwrap();
    let mut stream = client
        .session(ReceiverStream::new(rx))
        .await
        .unwrap()
        .into_inner();

    let env = next_envelope(&mut stream).await;
    let Some(Body::ClockReply(reply)) = env.body else {
        panic!("expected ClockReply, got {env:?}");
    };
    assert_eq!(reply.t1, t1, "the probe crossed unaltered");
    assert!(
        reply.t2 <= reply.t3,
        "the upstream's own receive/send stamps came back: t2={} t3={}",
        reply.t2,
        reply.t3,
    );

    drop(tx);
    proxy.abort();
    upstream.abort();
}
