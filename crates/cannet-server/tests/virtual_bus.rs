//! End-to-end tests for the virtual-bus server (ADR 0021).

use std::time::Duration;

use cannet_core::BusConfig;
use cannet_server::{VirtualBusServerImpl, VIRTUAL_BUS_FACTORY_ID};
use cannet_wire::proto::{
    cannet_server_client::CannetServerClient, envelope::Body, AttachBridge, ConfigureBus,
    DetachBridge, Direction as ProtoDirection, Envelope, Frame as ProtoFrame, FrameBatch,
    FrameKind, ListInterfacesRequest, Subscribe, WatchInterfacesRequest,
};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tokio_stream::StreamExt;
use tonic::transport::Server;

async fn spawn_server(config: BusConfig) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpListenerStream::new(listener);
    let svc = VirtualBusServerImpl::new(config).into_service();
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

/// Open a session, subscribe to the factory id, and return the
/// (outgoing channel, incoming stream, allocated participant id).
async fn open_and_subscribe(
    addr: std::net::SocketAddr,
) -> (mpsc::Sender<Envelope>, tonic::Streaming<Envelope>, String) {
    let mut client = connect(addr).await;
    let (tx, rx) = mpsc::channel::<Envelope>(8);
    tx.send(Envelope {
        body: Some(Body::Subscribe(Subscribe {
            interface_id: VIRTUAL_BUS_FACTORY_ID.into(),
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
        .expect("timed out waiting for InterfaceAllocated")
        .expect("stream ended")
        .expect("status error");
    let Some(Body::InterfaceAllocated(alloc)) = env.body else {
        panic!("expected InterfaceAllocated, got {env:?}");
    };
    (tx, stream, alloc.interface_id)
}

fn classic_tx(can_id: u32, data: Vec<u8>) -> ProtoFrame {
    ProtoFrame {
        timestamp_ns: 0,
        can_id,
        extended: false,
        direction: ProtoDirection::Tx as i32,
        kind: FrameKind::Classic as i32,
        data,
        brs: false,
        esi: false,
        dlc: 0,
    }
}

async fn next_envelope(stream: &mut tonic::Streaming<Envelope>, label: &str) -> Envelope {
    // Keep this tight — if the server can't push a queued envelope in
    // under a second on an idle box, something is wedged.
    let Ok(item) = timeout(Duration::from_secs(1), stream.next()).await else {
        panic!("timed out waiting for {label}");
    };
    let Some(result) = item else {
        panic!("stream closed before {label}");
    };
    match result {
        Ok(env) => env,
        Err(s) => panic!("status error before {label}: {s:?}"),
    }
}

#[tokio::test]
async fn list_interfaces_returns_one_factory_entry() {
    let (addr, server) = spawn_server(BusConfig::fd_500k_2m()).await;
    let mut client = connect(addr).await;

    let response = client
        .list_interfaces(ListInterfacesRequest {})
        .await
        .unwrap();
    let interfaces = response.into_inner().interfaces;
    assert_eq!(interfaces.len(), 1);
    assert_eq!(interfaces[0].id, VIRTUAL_BUS_FACTORY_ID);
    assert!(
        interfaces[0].fd_capable,
        "FD-configured bus reports fd_capable"
    );

    server.abort();
}

#[tokio::test]
async fn subscribe_allocates_distinct_participant_ids() {
    let (addr, server) = spawn_server(BusConfig::classic_500k()).await;

    let (_a_tx, _a_stream, a_id) = open_and_subscribe(addr).await;
    let (_b_tx, _b_stream, b_id) = open_and_subscribe(addr).await;

    assert!(
        a_id.starts_with(&format!("{VIRTUAL_BUS_FACTORY_ID}/p")),
        "allocated id should be factory-scoped: {a_id}"
    );
    assert_ne!(a_id, b_id, "two subscribes must allocate distinct ids");

    server.abort();
}

#[tokio::test]
async fn frames_fan_out_to_other_subscribers_tagged_with_sender_id() {
    let (addr, server) = spawn_server(BusConfig::classic_500k()).await;

    let (a_tx, _a_stream, a_id) = open_and_subscribe(addr).await;
    let (_b_tx, mut b_stream, _b_id) = open_and_subscribe(addr).await;

    a_tx.send(Envelope {
        body: Some(Body::FrameBatch(FrameBatch {
            interface_id: a_id.clone(),
            frames: vec![classic_tx(0x321, vec![0xAA, 0xBB, 0xCC])],
        })),
    })
    .await
    .unwrap();

    let env = next_envelope(&mut b_stream, "fan-out FrameBatch").await;
    let Some(Body::FrameBatch(batch)) = env.body else {
        panic!("expected FrameBatch envelope, got {env:?}");
    };
    assert_eq!(
        batch.interface_id, a_id,
        "fan-out FrameBatch should carry the sender's allocated id"
    );
    assert_eq!(batch.frames.len(), 1);
    let f = &batch.frames[0];
    assert_eq!(f.can_id, 0x321);
    assert_eq!(f.data, vec![0xAA, 0xBB, 0xCC]);
    assert_eq!(
        f.direction,
        ProtoDirection::Rx as i32,
        "fan-out delivery should be Rx-directed"
    );

    server.abort();
}

#[tokio::test]
async fn solo_participant_transmit_yields_no_acknowledger() {
    let (addr, server) = spawn_server(BusConfig::classic_500k()).await;

    let (a_tx, mut a_stream, a_id) = open_and_subscribe(addr).await;

    a_tx.send(Envelope {
        body: Some(Body::FrameBatch(FrameBatch {
            interface_id: a_id.clone(),
            frames: vec![classic_tx(0x100, vec![1])],
        })),
    })
    .await
    .unwrap();

    let env = next_envelope(&mut a_stream, "NoAcknowledger").await;
    let Some(Body::Error(err)) = env.body else {
        panic!("expected Error envelope, got {env:?}");
    };
    assert_eq!(
        err.code,
        cannet_wire::proto::error::Code::NoAcknowledger as i32,
        "solo transmit should yield NoAcknowledger; got {err:?}"
    );

    server.abort();
}

/// The virtual-bus server doesn't model controller config; any
/// `ConfigureBus` (factory id, unknown id, or anything else) is
/// silently dropped — that surface belongs to the hardware server
/// (ADR 0021 § "Server roles").
#[tokio::test]
async fn configure_bus_is_silently_ignored() {
    let (addr, server) = spawn_server(BusConfig::classic_500k()).await;

    let (tx, mut stream, _id) = open_and_subscribe(addr).await;

    for interface_id in [VIRTUAL_BUS_FACTORY_ID, "blf:0", "totally:made:up"] {
        tx.send(Envelope {
            body: Some(Body::ConfigureBus(ConfigureBus {
                interface_id: interface_id.into(),
                speed_bps: 1_000_000,
                fd_data_speed_bps: 0,
                fd_enabled: false,
            })),
        })
        .await
        .unwrap();
    }

    // Nothing should come back for any of them. A short timeout
    // confirms the server processed them silently.
    let nothing = timeout(Duration::from_millis(200), stream.next()).await;
    assert!(
        nothing.is_err(),
        "ConfigureBus should be silently dropped on the virtual-bus server, got {nothing:?}"
    );

    server.abort();
}

#[tokio::test]
async fn subscribe_to_unknown_interface_returns_unknown_interface_error() {
    let (addr, server) = spawn_server(BusConfig::classic_500k()).await;
    let mut client = connect(addr).await;

    let (tx, rx) = mpsc::channel(8);
    tx.send(Envelope {
        body: Some(Body::Subscribe(Subscribe {
            interface_id: "not:a:bus".into(),
        })),
    })
    .await
    .unwrap();

    let mut stream = client
        .session(ReceiverStream::new(rx))
        .await
        .unwrap()
        .into_inner();

    let env = next_envelope(&mut stream, "UnknownInterface").await;
    let Some(Body::Error(err)) = env.body else {
        panic!("expected Error envelope, got {env:?}");
    };
    assert_eq!(
        err.code,
        cannet_wire::proto::error::Code::UnknownInterface as i32,
    );

    drop(tx);
    server.abort();
}

// ---- Bridge tests (ADR 0021 § "Bridge installation") ----

/// Send `envelope` and wait for the server's reply; `Ok(())` if the
/// server reports no in-band error within the window. Used to confirm
/// `AttachBridge` / `DetachBridge` that should silently succeed.
async fn expect_no_error_for(
    tx: &mpsc::Sender<Envelope>,
    stream: &mut tonic::Streaming<Envelope>,
    envelope: Envelope,
    label: &str,
) {
    tx.send(envelope).await.unwrap();
    let nothing = timeout(Duration::from_millis(400), stream.next()).await;
    if let Ok(Some(Ok(env))) = nothing {
        if let Some(Body::Error(err)) = env.body {
            panic!(
                "{label} should not produce an error envelope, got code={} message={:?}",
                err.code, err.message
            );
        }
    }
}

/// Wait for the next non-snapshot watch entry; returns the new
/// interface list.
async fn next_snapshot(
    stream: &mut tonic::Streaming<cannet_wire::proto::InterfaceList>,
) -> Vec<cannet_wire::proto::Interface> {
    let item = timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("timed out waiting for WatchInterfaces snapshot")
        .expect("watch stream closed")
        .expect("watch status error");
    item.interfaces
}

#[tokio::test]
async fn attach_bridge_with_empty_name_is_rejected() {
    let (addr, server) = spawn_server(BusConfig::classic_500k()).await;
    let (tx, mut stream, _id) = open_and_subscribe(addr).await;

    tx.send(Envelope {
        body: Some(Body::AttachBridge(AttachBridge {
            remote_address: "127.0.0.1:1".into(),
            interface_id: VIRTUAL_BUS_FACTORY_ID.into(),
            name: String::new(),
        })),
    })
    .await
    .unwrap();

    let env = next_envelope(&mut stream, "TxRejected for empty name").await;
    let Some(Body::Error(err)) = env.body else {
        panic!("expected Error envelope, got {env:?}");
    };
    assert_eq!(err.code, cannet_wire::proto::error::Code::TxRejected as i32,);

    server.abort();
}

#[tokio::test]
async fn attach_bridge_to_unreachable_address_is_rejected() {
    let (addr, server) = spawn_server(BusConfig::classic_500k()).await;
    let (tx, mut stream, _id) = open_and_subscribe(addr).await;

    // Port 1 is reserved for tcpmux on most systems and almost
    // never listening — a reliable "connect should fail" target.
    tx.send(Envelope {
        body: Some(Body::AttachBridge(AttachBridge {
            remote_address: "127.0.0.1:1".into(),
            interface_id: VIRTUAL_BUS_FACTORY_ID.into(),
            name: "to-nowhere".into(),
        })),
    })
    .await
    .unwrap();

    // BridgeRemote::connect's failure path; allow a longer window
    // since tonic's transport error path can take a moment.
    let item = timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("timed out waiting for unreachable-bridge error")
        .expect("stream closed")
        .expect("status error");
    let Some(Body::Error(err)) = item.body else {
        panic!("expected Error envelope, got {item:?}");
    };
    assert_eq!(
        err.code,
        cannet_wire::proto::error::Code::TxRejected as i32,
        "unreachable bridge target should produce TxRejected"
    );

    server.abort();
}

#[tokio::test]
async fn attach_bridge_appears_in_list_and_watch_snapshots() {
    let (a_addr, a_server) = spawn_server(BusConfig::classic_500k()).await;
    let (b_addr, b_server) = spawn_server(BusConfig::classic_500k()).await;

    // Subscribe a watcher to A before attaching the bridge so we
    // observe both the initial single-entry snapshot and the post-
    // attach two-entry snapshot.
    let mut watch_client = connect(a_addr).await;
    let mut watch_stream = watch_client
        .watch_interfaces(WatchInterfacesRequest {})
        .await
        .unwrap()
        .into_inner();

    let initial = next_snapshot(&mut watch_stream).await;
    assert_eq!(initial.len(), 1, "initial snapshot is just the factory");

    let (tx, mut stream, _id) = open_and_subscribe(a_addr).await;
    expect_no_error_for(
        &tx,
        &mut stream,
        Envelope {
            body: Some(Body::AttachBridge(AttachBridge {
                remote_address: b_addr.to_string(),
                interface_id: VIRTUAL_BUS_FACTORY_ID.into(),
                name: "to-b".into(),
            })),
        },
        "AttachBridge to peer virtual-bus server",
    )
    .await;

    // ListInterfaces on A now includes the bridge.
    let mut a_client = connect(a_addr).await;
    let after_attach = a_client
        .list_interfaces(ListInterfacesRequest {})
        .await
        .unwrap()
        .into_inner()
        .interfaces;
    let ids: Vec<&str> = after_attach.iter().map(|i| i.id.as_str()).collect();
    assert!(
        ids.contains(&format!("{VIRTUAL_BUS_FACTORY_ID}/bridge-to-b").as_str()),
        "expected bridge id in list, got {ids:?}"
    );

    // WatchInterfaces pushed a fresh snapshot on attach.
    let after = next_snapshot(&mut watch_stream).await;
    let watch_ids: Vec<&str> = after.iter().map(|i| i.id.as_str()).collect();
    assert!(
        watch_ids.contains(&format!("{VIRTUAL_BUS_FACTORY_ID}/bridge-to-b").as_str()),
        "WatchInterfaces should push the new bridge, got {watch_ids:?}"
    );

    a_server.abort();
    b_server.abort();
}

#[tokio::test]
async fn attach_bridge_with_duplicate_name_is_rejected() {
    let (a_addr, a_server) = spawn_server(BusConfig::classic_500k()).await;
    let (b_addr, b_server) = spawn_server(BusConfig::classic_500k()).await;

    let (tx, mut stream, _id) = open_and_subscribe(a_addr).await;
    expect_no_error_for(
        &tx,
        &mut stream,
        Envelope {
            body: Some(Body::AttachBridge(AttachBridge {
                remote_address: b_addr.to_string(),
                interface_id: VIRTUAL_BUS_FACTORY_ID.into(),
                name: "dup".into(),
            })),
        },
        "first AttachBridge with name `dup`",
    )
    .await;

    tx.send(Envelope {
        body: Some(Body::AttachBridge(AttachBridge {
            remote_address: b_addr.to_string(),
            interface_id: VIRTUAL_BUS_FACTORY_ID.into(),
            name: "dup".into(),
        })),
    })
    .await
    .unwrap();
    let env = next_envelope(&mut stream, "TxRejected for duplicate name").await;
    let Some(Body::Error(err)) = env.body else {
        panic!("expected Error envelope, got {env:?}");
    };
    assert_eq!(err.code, cannet_wire::proto::error::Code::TxRejected as i32,);

    a_server.abort();
    b_server.abort();
}

#[tokio::test]
async fn cross_server_bridge_carries_traffic_in_both_directions() {
    // Server A bridges to server B's factory. A participant on each
    // server should see the other's transmits. This is the CAN-over-IP
    // gateway shape (ADR 0021 § "Bridge installation").
    let (a_addr, a_server) = spawn_server(BusConfig::classic_500k()).await;
    let (b_addr, b_server) = spawn_server(BusConfig::classic_500k()).await;

    let (a_tx, mut a_stream, a_id) = open_and_subscribe(a_addr).await;
    let (b_tx, mut b_stream, b_id) = open_and_subscribe(b_addr).await;

    // Install the bridge on A pointing at B's factory.
    let (ctl_tx, mut ctl_stream, _ctl_id) = open_and_subscribe(a_addr).await;
    expect_no_error_for(
        &ctl_tx,
        &mut ctl_stream,
        Envelope {
            body: Some(Body::AttachBridge(AttachBridge {
                remote_address: b_addr.to_string(),
                interface_id: VIRTUAL_BUS_FACTORY_ID.into(),
                name: "to-b".into(),
            })),
        },
        "AttachBridge A→B",
    )
    .await;

    // A → B: participant on A transmits; participant on B sees Rx.
    a_tx.send(Envelope {
        body: Some(Body::FrameBatch(FrameBatch {
            interface_id: a_id.clone(),
            frames: vec![classic_tx(0x111, vec![0xA1, 0xA2])],
        })),
    })
    .await
    .unwrap();
    let env = next_envelope(&mut b_stream, "B receives A's frame").await;
    let Some(Body::FrameBatch(batch)) = env.body else {
        panic!("expected FrameBatch on B, got {env:?}");
    };
    assert_eq!(batch.frames.len(), 1);
    assert_eq!(batch.frames[0].can_id, 0x111);
    assert_eq!(batch.frames[0].data, vec![0xA1, 0xA2]);

    // B → A: participant on B transmits; participant on A sees Rx.
    b_tx.send(Envelope {
        body: Some(Body::FrameBatch(FrameBatch {
            interface_id: b_id.clone(),
            frames: vec![classic_tx(0x222, vec![0xB1, 0xB2])],
        })),
    })
    .await
    .unwrap();
    let env = next_envelope(&mut a_stream, "A receives B's frame").await;
    let Some(Body::FrameBatch(batch)) = env.body else {
        panic!("expected FrameBatch on A, got {env:?}");
    };
    assert_eq!(batch.frames.len(), 1);
    assert_eq!(batch.frames[0].can_id, 0x222);
    assert_eq!(batch.frames[0].data, vec![0xB1, 0xB2]);

    a_server.abort();
    b_server.abort();
}

#[tokio::test]
async fn detach_bridge_removes_from_list_and_watch_snapshots() {
    let (a_addr, a_server) = spawn_server(BusConfig::classic_500k()).await;
    let (b_addr, b_server) = spawn_server(BusConfig::classic_500k()).await;

    let (tx, mut stream, _id) = open_and_subscribe(a_addr).await;
    expect_no_error_for(
        &tx,
        &mut stream,
        Envelope {
            body: Some(Body::AttachBridge(AttachBridge {
                remote_address: b_addr.to_string(),
                interface_id: VIRTUAL_BUS_FACTORY_ID.into(),
                name: "ephem".into(),
            })),
        },
        "AttachBridge",
    )
    .await;

    // Confirm present.
    let mut a_client = connect(a_addr).await;
    let present = a_client
        .list_interfaces(ListInterfacesRequest {})
        .await
        .unwrap()
        .into_inner()
        .interfaces;
    assert_eq!(present.len(), 2);

    // Subscribe a fresh watcher *after* attach so the next snapshot
    // it sees corresponds to the detach.
    let mut watch_client = connect(a_addr).await;
    let mut watch_stream = watch_client
        .watch_interfaces(WatchInterfacesRequest {})
        .await
        .unwrap()
        .into_inner();
    let initial = next_snapshot(&mut watch_stream).await;
    assert_eq!(initial.len(), 2, "snapshot before detach has the bridge");

    expect_no_error_for(
        &tx,
        &mut stream,
        Envelope {
            body: Some(Body::DetachBridge(DetachBridge {
                name: "ephem".into(),
            })),
        },
        "DetachBridge",
    )
    .await;

    // ListInterfaces no longer contains the bridge.
    let absent = a_client
        .list_interfaces(ListInterfacesRequest {})
        .await
        .unwrap()
        .into_inner()
        .interfaces;
    assert_eq!(absent.len(), 1);
    assert_eq!(absent[0].id, VIRTUAL_BUS_FACTORY_ID);

    // Watch snapshot pushed on detach.
    let post = next_snapshot(&mut watch_stream).await;
    assert_eq!(post.len(), 1);

    a_server.abort();
    b_server.abort();
}
