//! End-to-end gRPC tests: spin up `cannet-server` over a real TCP
//! socket on a random port, connect with the tonic-generated client,
//! and exercise the protocol the way the real Phase-2 client will.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use blf_asc::{ArbitrationId, BlfWriter, DataBytes, Message};
use cannet_server::{CannetServerImpl, LoopingBlfReplay};
use cannet_wire::proto::{
    cannet_server_client::CannetServerClient, envelope::Body, error::Code, Envelope, FrameBatch,
    ListInterfacesRequest, Subscribe, Unsubscribe,
};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tokio_stream::StreamExt;
use tonic::transport::Server;

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

/// Build a small two-channel fixture and start a server on a random
/// port. Returns the bound address and a join handle for shutdown.
async fn spawn_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let dir = tempfile::tempdir().unwrap();
    let blf_path = dir.path().join("test.blf");
    write_fixture(
        &blf_path,
        &[
            classic_msg(0.001, 0, 0x100, vec![1, 2]),
            classic_msg(0.002, 0, 0x101, vec![3, 4]),
            classic_msg(0.003, 1, 0x200, vec![5]),
        ],
    );
    let replay = Arc::new(LoopingBlfReplay::open(&blf_path).unwrap());
    // dir drops here after replay has loaded the BLF into memory.
    drop(dir);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    // rate = 0 keeps the test pacing-free so they don't sit on
    // wall-clock waits.
    let svc = CannetServerImpl::new(replay, 0.0).into_service();
    let handle = tokio::spawn(async move {
        Server::builder()
            .add_service(svc)
            .serve_with_incoming(stream)
            .await
            .unwrap();
    });
    (addr, handle)
}

async fn connect(addr: std::net::SocketAddr) -> CannetServerClient<tonic::transport::Channel> {
    // Tonic's connect retries internally; loop is only here to outlast
    // the kernel's RST window on slow CI.
    for _ in 0..20 {
        match CannetServerClient::connect(format!("http://{addr}")).await {
            Ok(client) => return client,
            Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }
    panic!("client could not connect to {addr}");
}

fn subscribe_envelope(interface_id: &str) -> Envelope {
    Envelope {
        body: Some(Body::Subscribe(Subscribe {
            interface_id: interface_id.into(),
        })),
    }
}

fn unsubscribe_envelope(interface_id: &str) -> Envelope {
    Envelope {
        body: Some(Body::Unsubscribe(Unsubscribe {
            interface_id: interface_id.into(),
        })),
    }
}

fn frame_batch_envelope(interface_id: &str) -> Envelope {
    Envelope {
        body: Some(Body::FrameBatch(FrameBatch {
            interface_id: interface_id.into(),
            frames: vec![],
        })),
    }
}

#[tokio::test]
async fn list_interfaces_returns_replay_channels() {
    let (addr, server_handle) = spawn_server().await;
    let mut client = connect(addr).await;

    let response = client
        .list_interfaces(ListInterfacesRequest {})
        .await
        .unwrap();
    let interfaces = response.into_inner().interfaces;

    assert_eq!(interfaces.len(), 2);
    assert_eq!(interfaces[0].id, "blf:0");
    assert_eq!(interfaces[1].id, "blf:1");
    assert_eq!(interfaces[0].display_name, "BLF channel 0");

    server_handle.abort();
}

#[tokio::test]
async fn session_streams_subscribed_interface_frames() {
    let (addr, server_handle) = spawn_server().await;
    let mut client = connect(addr).await;

    let (tx, rx) = mpsc::channel(8);
    tx.send(subscribe_envelope("blf:0")).await.unwrap();
    let mut stream = client
        .session(ReceiverStream::new(rx))
        .await
        .unwrap()
        .into_inner();

    // First batch should arrive within a generous timeout.
    let env = timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("timed out waiting for first frame batch")
        .expect("server closed stream prematurely")
        .expect("server returned a Status error");
    let Some(Body::FrameBatch(batch)) = env.body else {
        panic!("expected FrameBatch envelope, got {env:?}");
    };
    assert_eq!(batch.interface_id, "blf:0");
    assert!(!batch.frames.is_empty());
    assert!(
        batch
            .frames
            .iter()
            .all(|f| f.can_id == 0x100 || f.can_id == 0x101),
        "received unexpected frame ids: {:?}",
        batch.frames.iter().map(|f| f.can_id).collect::<Vec<_>>(),
    );

    drop(tx); // close the request stream
    server_handle.abort();
}

#[tokio::test]
async fn unsubscribe_stops_the_per_interface_pump() {
    let (addr, server_handle) = spawn_server().await;
    let mut client = connect(addr).await;

    let (tx, rx) = mpsc::channel(8);
    tx.send(subscribe_envelope("blf:0")).await.unwrap();
    let mut stream = client
        .session(ReceiverStream::new(rx))
        .await
        .unwrap()
        .into_inner();

    // Wait for at least one batch so we know the pump is running.
    timeout(Duration::from_secs(2), stream.next())
        .await
        .unwrap();

    tx.send(unsubscribe_envelope("blf:0")).await.unwrap();

    // Drain anything still in flight; subsequent reads should eventually
    // time out (no more batches arriving).
    let drain_deadline = Duration::from_millis(200);
    while let Ok(Some(Ok(_))) = timeout(drain_deadline, stream.next()).await {
        // discard
    }
    let post_unsubscribe = timeout(Duration::from_millis(200), stream.next()).await;
    assert!(
        post_unsubscribe.is_err(),
        "server kept sending after unsubscribe: {post_unsubscribe:?}",
    );

    drop(tx);
    server_handle.abort();
}

#[tokio::test]
async fn subscribing_to_unknown_interface_yields_unknown_interface_error() {
    let (addr, server_handle) = spawn_server().await;
    let mut client = connect(addr).await;

    let (tx, rx) = mpsc::channel(8);
    tx.send(subscribe_envelope("blf:99")).await.unwrap();
    let mut stream = client
        .session(ReceiverStream::new(rx))
        .await
        .unwrap()
        .into_inner();

    let env = timeout(Duration::from_secs(2), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Some(Body::Error(err)) = env.body else {
        panic!("expected Error envelope, got {env:?}");
    };
    assert_eq!(err.code, i32::from(Code::UnknownInterface));

    drop(tx);
    server_handle.abort();
}

#[tokio::test]
async fn client_transmit_attempt_is_rejected() {
    let (addr, server_handle) = spawn_server().await;
    let mut client = connect(addr).await;

    let (tx, rx) = mpsc::channel(8);
    tx.send(frame_batch_envelope("blf:0")).await.unwrap();
    let mut stream = client
        .session(ReceiverStream::new(rx))
        .await
        .unwrap()
        .into_inner();

    let env = timeout(Duration::from_secs(2), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Some(Body::Error(err)) = env.body else {
        panic!("expected Error envelope, got {env:?}");
    };
    assert_eq!(err.code, i32::from(Code::TxRejected));

    drop(tx);
    server_handle.abort();
}

#[tokio::test]
async fn second_concurrent_client_is_rejected_with_busy() {
    let (addr, server_handle) = spawn_server().await;
    let mut client_a = connect(addr).await;
    let mut client_b = connect(addr).await;

    // Open the first session and start streaming so the busy flag is set.
    let (tx_a, rx_a) = mpsc::channel(8);
    tx_a.send(subscribe_envelope("blf:0")).await.unwrap();
    let mut stream_a = client_a
        .session(ReceiverStream::new(rx_a))
        .await
        .unwrap()
        .into_inner();
    timeout(Duration::from_secs(2), stream_a.next())
        .await
        .unwrap();

    // Second session should be greeted with BUSY.
    let (_tx_b, rx_b) = mpsc::channel(8);
    let mut stream_b = client_b
        .session(ReceiverStream::new(rx_b))
        .await
        .unwrap()
        .into_inner();
    let env = timeout(Duration::from_secs(2), stream_b.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Some(Body::Error(err)) = env.body else {
        panic!("expected Error envelope, got {env:?}");
    };
    assert_eq!(err.code, i32::from(Code::Busy));

    drop(tx_a);
    server_handle.abort();
}
