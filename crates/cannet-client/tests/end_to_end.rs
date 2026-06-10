//! End-to-end tests: spin up cannet-server in-process, drive it via
//! cannet-client. Validates that the client-side `CanFrameSource`
//! adapter behaves exactly like an in-process source from the
//! consumer's perspective.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use blf_asc::{ArbitrationId, BlfWriter, DataBytes, Message};
use cannet_client::{
    connect_and_subscribe, list_interfaces, watch_interfaces, ConnectionError, FrameReceiver,
    RemoteCanFrameSource, SessionHandle, Subscription,
};
use cannet_core::CanFrameSource;
use cannet_server::{CannetServerImpl, LoopingBlfReplay};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_stream::wrappers::TcpListenerStream;
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

async fn spawn_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let dir = tempfile::tempdir().unwrap();
    let blf_path = dir.path().join("test.blf");
    write_fixture(
        &blf_path,
        &[
            classic_msg(0.001, 0, 0x100, vec![1, 2]),
            classic_msg(0.002, 0, 0x101, vec![3, 4]),
            classic_msg(0.003, 1, 0x200, vec![5]),
            classic_msg(0.004, 1, 0x201, vec![6, 7]),
        ],
    );
    let replay = Arc::new(LoopingBlfReplay::open(&blf_path).unwrap());
    drop(dir);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
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

/// `connect_and_subscribe` is sync. The test runtime owns the server
/// task; the client lives in a worker thread the function spawns.
fn drain_n(source: &mut RemoteCanFrameSource, n: usize) -> Vec<cannet_core::CanFrame> {
    let mut frames = Vec::with_capacity(n);
    for _ in 0..n {
        match source.next_frame() {
            Ok(Some(frame)) => frames.push(frame),
            Ok(None) => panic!("source ended early"),
            Err(e) => panic!("source errored: {e}"),
        }
    }
    frames
}

#[tokio::test(flavor = "multi_thread")]
async fn list_interfaces_round_trip() {
    let (addr, server) = spawn_server().await;
    let interfaces = list_interfaces(&addr.to_string()).await.unwrap();
    assert_eq!(interfaces.len(), 2);
    assert_eq!(interfaces[0].id, "blf:0");
    assert_eq!(interfaces[1].id, "blf:1");
    server.abort();
}

/// `WatchInterfaces` against the BLF server: emits exactly one
/// snapshot (the channel set is fixed for the session) and then
/// keeps the stream open until the client drops it. ADR 0016
/// specifies this initial-snapshot-on-subscribe behaviour as the
/// minimum useful contract.
#[tokio::test(flavor = "multi_thread")]
async fn watch_interfaces_emits_initial_snapshot() {
    let (addr, server) = spawn_server().await;
    let mut stream = watch_interfaces(&addr.to_string()).await.unwrap();
    let first = timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("initial snapshot should arrive promptly")
        .expect("watch stream errored")
        .expect("watch stream closed before snapshot");
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].id, "blf:0");
    assert_eq!(first[1].id, "blf:1");
    // No second snapshot should arrive — BLF replay's interface set
    // never changes. A short timeout confirms the stream is sitting
    // open with nothing to push.
    let pending = timeout(Duration::from_millis(150), stream.next()).await;
    assert!(
        pending.is_err(),
        "expected the watch stream to stay quiet after the initial snapshot, got {pending:?}"
    );
    drop(stream);
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn subscribe_one_interface_yields_frames_with_chosen_channel() {
    let (addr, server) = spawn_server().await;
    let address = addr.to_string();

    let mut source = tokio::task::spawn_blocking(move || {
        connect_and_subscribe(
            &address,
            vec![Subscription::new("blf:0", 7)],
        )
    })
    .await
    .unwrap()
    .unwrap();

    let frames = tokio::task::spawn_blocking(move || {
        let frames = drain_n(&mut source, 4);
        (source, frames)
    })
    .await
    .unwrap()
    .1;

    assert!(frames.iter().all(|f| f.channel == 7));
    assert!(frames
        .iter()
        .all(|f| f.id.raw() == 0x100 || f.id.raw() == 0x101));
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn subscribing_to_unknown_interface_surfaces_server_error() {
    let (addr, server) = spawn_server().await;
    let address = addr.to_string();

    let mut source = tokio::task::spawn_blocking(move || {
        connect_and_subscribe(
            &address,
            vec![Subscription::new("blf:99", 0)],
        )
    })
    .await
    .unwrap()
    .unwrap();

    let result = tokio::task::spawn_blocking(move || source.next_frame())
        .await
        .unwrap();
    let err = result.unwrap_err();
    assert!(
        matches!(err, ConnectionError::Server { .. }),
        "expected Server error variant, got {err:?}",
    );
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn into_parts_lets_handle_and_receiver_live_in_different_threads() {
    let (addr, server) = spawn_server().await;
    let address = addr.to_string();

    // Open a session and immediately split it. The handle goes to one
    // task; the receiver to another. Frames flow until the handle is
    // dropped; the receiver then observes end-of-stream.
    let (handle, mut receiver, _transmitter): (SessionHandle, FrameReceiver, _) =
        tokio::task::spawn_blocking(move || {
            let source = connect_and_subscribe(
                &address,
                vec![Subscription::new("blf:0", 0)],
            )
            .unwrap();
            source.into_parts()
        })
        .await
        .unwrap();

    // Drain a frame to confirm the split session is live.
    let receiver = tokio::task::spawn_blocking(move || {
        use cannet_core::CanFrameSource;
        receiver.next_frame().unwrap().expect("expected at least one frame");
        receiver
    })
    .await
    .unwrap();

    // Dropping only the handle (in the test runtime thread, not the
    // worker thread) signals shutdown.
    drop(handle);

    // The receiver, still living in a blocking task, should see
    // end-of-stream within a generous timeout.
    let saw_end = tokio::task::spawn_blocking(move || {
        use cannet_core::CanFrameSource;
        let mut receiver = receiver;
        loop {
            match receiver.next_frame() {
                Ok(Some(_)) => {}
                Ok(None) => return true,
                Err(_) => return false,
            }
        }
    });
    let result = timeout(Duration::from_secs(5), saw_end).await.unwrap().unwrap();
    assert!(
        result,
        "FrameReceiver did not observe end-of-stream after SessionHandle drop",
    );

    server.abort();
}

/// Spin up a virtual-bus server (ADR 0021) — the wire-level transmit
/// round-trip target now that loopback is retired.
async fn spawn_virtual_bus_server(
) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    use cannet_core::BusConfig;
    use cannet_server::VirtualBusServerImpl;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let svc = VirtualBusServerImpl::new(BusConfig::classic_500k()).into_service();
    let handle = tokio::spawn(async move {
        Server::builder()
            .add_service(svc)
            .serve_with_incoming(stream)
            .await
            .unwrap();
    });
    (addr, handle)
}

#[tokio::test(flavor = "multi_thread")]
async fn factory_subscribe_surfaces_allocated_id_and_round_trips_tx() {
    // Two sessions to the same virtual-bus server. Each subscribes
    // to the factory and gets a participant. Session A transmits;
    // session B receives the frame as Rx.
    let (addr, server) = spawn_virtual_bus_server().await;

    let address_a = addr.to_string();
    let session_a = tokio::task::spawn_blocking(move || {
        connect_and_subscribe(
            &address_a,
            vec![Subscription::factory(
                cannet_server::VIRTUAL_BUS_FACTORY_ID,
                0,
            )],
        )
    })
    .await
    .unwrap()
    .unwrap();

    let address_b = addr.to_string();
    let mut session_b = tokio::task::spawn_blocking(move || {
        connect_and_subscribe(
            &address_b,
            vec![Subscription::factory(
                cannet_server::VIRTUAL_BUS_FACTORY_ID,
                9,
            )],
        )
    })
    .await
    .unwrap()
    .unwrap();

    // Both sessions should have an allocated id surfaced.
    let allocated_a = session_a
        .subscriptions()
        .first()
        .and_then(|s| s.allocated_id.clone())
        .expect("session A: expected allocated id from InterfaceAllocated");
    let allocated_b = session_b
        .subscriptions()
        .first()
        .and_then(|s| s.allocated_id.clone())
        .expect("session B: expected allocated id from InterfaceAllocated");
    assert_ne!(
        allocated_a, allocated_b,
        "the server must allocate distinct ids per subscriber",
    );

    let (handle_a, _recv_a, tx_a) = session_a.into_parts();
    let frame_to_send = cannet_core::CanFrame::classic(
        0,
        0,
        cannet_core::CanId::standard(0x321).unwrap(),
        cannet_core::Direction::Tx,
        vec![0xDE, 0xAD, 0xBE, 0xEF],
    )
    .unwrap();
    // `SessionTransmitter::transmit` blocks on a tokio channel; the
    // test runtime is multi-threaded but the call must still leave
    // the executor thread to `blocking_send`.
    let allocated_a_for_tx = allocated_a.clone();
    let frame_for_tx = frame_to_send.clone();
    tokio::task::spawn_blocking(move || {
        tx_a.transmit(&allocated_a_for_tx, &frame_for_tx).unwrap();
    })
    .await
    .unwrap();

    // Session B should receive it (as Rx) tagged with channel 9 — the
    // mapping its subscription requested.
    let frame = tokio::task::spawn_blocking(move || {
        // Generous timeout: wire round-trip on loopback in CI.
        for _ in 0..200 {
            match session_b.next_frame() {
                Ok(Some(f)) => return f,
                Ok(None) => panic!("session B ended before frame arrived"),
                Err(e) => panic!("session B errored: {e}"),
            }
        }
        panic!("session B never observed the transmitted frame");
    })
    .await
    .unwrap();
    assert_eq!(frame.id.raw(), 0x321);
    assert_eq!(frame.channel, 9);
    assert_eq!(frame.payload.data(), &[0xDE, 0xAD, 0xBE, 0xEF]);

    drop(handle_a);
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn dropping_source_disconnects_cleanly() {
    let (addr, server) = spawn_server().await;
    let address = addr.to_string();

    // Open + drop the source. No assertion on the server side here
    // beyond "the test doesn't hang" — the worker thread should exit
    // when the runtime drops, releasing the gRPC stream.
    tokio::task::spawn_blocking(move || {
        let source = connect_and_subscribe(
            &address,
            vec![Subscription::new("blf:0", 0)],
        )
        .unwrap();
        drop(source);
    })
    .await
    .unwrap();

    // After the first session ends, a fresh connect should succeed
    // (i.e. the server's BUSY flag was released).
    let address = addr.to_string();
    let interfaces = list_interfaces(&address).await.unwrap();
    assert_eq!(interfaces.len(), 2);

    // Give the server's busy guard a generous moment to fire — it
    // releases on the per-session task drop, not synchronously when
    // the request stream closes.
    let mut subsequent = None;
    for _ in 0..40 {
        let address = address.clone();
        match tokio::task::spawn_blocking(move || {
            connect_and_subscribe(
                &address,
                vec![Subscription::new("blf:0", 0)],
            )
        })
        .await
        .unwrap()
        {
            Ok(s) => {
                subsequent = Some(s);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
    let mut subsequent = subsequent.expect("second session never accepted after disconnect");

    // Confirm frames flow on the second session.
    let frames = tokio::task::spawn_blocking(move || drain_n(&mut subsequent, 1))
        .await
        .unwrap();
    assert_eq!(frames.len(), 1);
    server.abort();
}
