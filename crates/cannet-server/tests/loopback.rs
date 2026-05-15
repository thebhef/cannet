//! End-to-end test for the `cannet-server --loopback` mode: subscribe,
//! transmit, observe the mirrored frame come back as `Rx`.

use std::time::Duration;

use cannet_server::{LoopbackServerImpl, LOOPBACK_INTERFACE_ID};
use cannet_wire::proto::{
    cannet_server_client::CannetServerClient,
    envelope::Body,
    Direction as ProtoDirection, Envelope, Frame as ProtoFrame, FrameBatch, FrameKind,
    ListInterfacesRequest, Subscribe,
};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tokio_stream::StreamExt;
use tonic::transport::Server;

async fn spawn_loopback_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let svc = LoopbackServerImpl::new().into_service();
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
    for _ in 0..20 {
        match CannetServerClient::connect(format!("http://{addr}")).await {
            Ok(client) => return client,
            Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }
    panic!("client could not connect to {addr}");
}

#[tokio::test]
async fn list_interfaces_returns_one_loopback_interface() {
    let (addr, server_handle) = spawn_loopback_server().await;
    let mut client = connect(addr).await;

    let response = client.list_interfaces(ListInterfacesRequest {}).await.unwrap();
    let interfaces = response.into_inner().interfaces;
    assert_eq!(interfaces.len(), 1);
    assert_eq!(interfaces[0].id, LOOPBACK_INTERFACE_ID);
    assert!(interfaces[0].fd_capable);

    server_handle.abort();
}

#[tokio::test]
async fn submitted_frame_is_echoed_back_as_rx() {
    let (addr, server_handle) = spawn_loopback_server().await;
    let mut client = connect(addr).await;

    let (tx, rx) = mpsc::channel(8);
    tx.send(Envelope {
        body: Some(Body::Subscribe(Subscribe {
            interface_id: LOOPBACK_INTERFACE_ID.into(),
        })),
    })
    .await
    .unwrap();

    let mut stream = client
        .session(ReceiverStream::new(rx))
        .await
        .unwrap()
        .into_inner();

    // Give the server a tick to install the subscription before we
    // transmit — otherwise the pump can mirror the frame before the
    // subscribe lands and silently drop it.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let payload = vec![0xDE, 0xAD, 0xBE, 0xEF];
    tx.send(Envelope {
        body: Some(Body::FrameBatch(FrameBatch {
            interface_id: LOOPBACK_INTERFACE_ID.into(),
            frames: vec![ProtoFrame {
                timestamp_ns: 0,
                can_id: 0x123,
                extended: false,
                direction: ProtoDirection::Tx as i32,
                kind: FrameKind::Classic as i32,
                data: payload.clone(),
                brs: false,
                esi: false,
                dlc: 0,
            }],
        })),
    })
    .await
    .unwrap();

    // First non-error envelope is the mirrored frame.
    let env = timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("timed out waiting for mirrored frame")
        .expect("stream closed")
        .expect("status error");
    let Some(Body::FrameBatch(batch)) = env.body else {
        panic!("expected FrameBatch envelope, got {env:?}");
    };
    assert_eq!(batch.interface_id, LOOPBACK_INTERFACE_ID);
    assert_eq!(batch.frames.len(), 1);
    let f = &batch.frames[0];
    assert_eq!(f.can_id, 0x123);
    assert_eq!(f.data, payload);
    assert_eq!(
        f.direction,
        ProtoDirection::Rx as i32,
        "loopback should rewrite Tx -> Rx",
    );

    drop(tx);
    server_handle.abort();
}

#[tokio::test]
async fn frame_for_unknown_interface_is_rejected() {
    let (addr, server_handle) = spawn_loopback_server().await;
    let mut client = connect(addr).await;

    let (tx, rx) = mpsc::channel(8);
    tx.send(Envelope {
        body: Some(Body::FrameBatch(FrameBatch {
            interface_id: "nope".into(),
            frames: vec![],
        })),
    })
    .await
    .unwrap();

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
    assert_eq!(
        err.code,
        cannet_wire::proto::error::Code::UnknownInterface as i32,
    );

    drop(tx);
    server_handle.abort();
}
