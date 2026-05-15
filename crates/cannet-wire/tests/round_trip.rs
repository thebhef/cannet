//! End-to-end tests for the cannet-wire conversion + batching layers.
//!
//! These tests stay in-process: they exercise the wire types and
//! adapters without ever opening a TCP socket. Network transport is
//! covered in the server / client crates.

use std::time::Duration;

use cannet_core::{CanFdFlags, CanFrame, CanId, Direction};
use cannet_wire::{
    batch_frames, batch_to_proto, frame_to_proto, proto, proto_to_batch, proto_to_frame,
    unbatch_frames, BatchPolicy, ProtoConversionError,
};
use futures::stream::StreamExt;

const IFACE: &str = "blf:0";

fn classic(ts: u64, channel: u8, id: u32, dir: Direction, data: Vec<u8>) -> CanFrame {
    CanFrame::classic(ts, channel, CanId::standard(id).unwrap(), dir, data).unwrap()
}

fn fd(
    ts: u64,
    channel: u8,
    id: u32,
    dir: Direction,
    data: Vec<u8>,
    flags: CanFdFlags,
) -> CanFrame {
    CanFrame::fd(ts, channel, CanId::extended(id).unwrap(), dir, data, flags).unwrap()
}

// ---------- conversion ----------

#[test]
fn classic_frame_round_trips() {
    let original = classic(1_000_000, 2, 0x123, Direction::Rx, vec![1, 2, 3, 4]);
    let wire = frame_to_proto(&original);
    let decoded = proto_to_frame(&wire, original.channel).unwrap();
    assert_eq!(decoded, original);
}

#[test]
fn fd_frame_round_trips_with_brs_and_esi() {
    let flags = CanFdFlags { bitrate_switch: true, error_state_indicator: true };
    let original = fd(
        2_500_000,
        1,
        0x1A_BCDE,
        Direction::Tx,
        (0..32).collect(),
        flags,
    );
    let wire = frame_to_proto(&original);
    let decoded = proto_to_frame(&wire, original.channel).unwrap();
    assert_eq!(decoded, original);
}

#[test]
fn remote_frame_round_trips_with_dlc() {
    let original = CanFrame::remote(
        500,
        0,
        CanId::standard(0x7FF).unwrap(),
        Direction::Rx,
        4,
    );
    let wire = frame_to_proto(&original);
    let decoded = proto_to_frame(&wire, original.channel).unwrap();
    assert_eq!(decoded, original);
}

#[test]
fn error_frame_round_trips() {
    let original = CanFrame::error(900, 3, CanId::standard(0).unwrap(), Direction::Rx);
    let wire = frame_to_proto(&original);
    let decoded = proto_to_frame(&wire, original.channel).unwrap();
    assert_eq!(decoded, original);
}

#[test]
fn extended_id_survives_round_trip() {
    let original = CanFrame::classic(
        0,
        0,
        CanId::extended(0x1FFF_FFFF).unwrap(),
        Direction::Rx,
        vec![],
    )
    .unwrap();
    let wire = frame_to_proto(&original);
    assert!(wire.extended);
    let decoded = proto_to_frame(&wire, 0).unwrap();
    assert!(decoded.id.is_extended());
    assert_eq!(decoded.id.raw(), 0x1FFF_FFFF);
}

#[test]
fn unspecified_direction_is_rejected() {
    let mut wire = frame_to_proto(&classic(0, 0, 0x1, Direction::Rx, vec![]));
    wire.direction = proto::Direction::Unspecified.into();
    assert!(matches!(
        proto_to_frame(&wire, 0).unwrap_err(),
        ProtoConversionError::UnknownDirection(_)
    ));
}

#[test]
fn unspecified_kind_is_rejected() {
    let mut wire = frame_to_proto(&classic(0, 0, 0x1, Direction::Rx, vec![]));
    wire.kind = proto::FrameKind::Unspecified.into();
    assert!(matches!(
        proto_to_frame(&wire, 0).unwrap_err(),
        ProtoConversionError::UnknownKind(_)
    ));
}

#[test]
fn out_of_range_dlc_on_remote_is_rejected() {
    let mut wire = frame_to_proto(&CanFrame::remote(
        0,
        0,
        CanId::standard(0x1).unwrap(),
        Direction::Rx,
        0,
    ));
    wire.dlc = 16;
    assert!(matches!(
        proto_to_frame(&wire, 0).unwrap_err(),
        ProtoConversionError::InvalidDlc(16)
    ));
}

#[test]
fn out_of_range_extended_id_is_rejected() {
    // Forge a wire frame with extended=true but a value outside the
    // 29-bit range. frame_to_proto can't produce this on its own
    // because CanId::extended validates at construction time.
    let wire = proto::Frame {
        timestamp_ns: 0,
        can_id: 0x2000_0000,
        extended: true,
        direction: proto::Direction::Rx.into(),
        kind: proto::FrameKind::Classic.into(),
        data: vec![],
        brs: false,
        esi: false,
        dlc: 0,
    };
    assert!(matches!(
        proto_to_frame(&wire, 0).unwrap_err(),
        ProtoConversionError::InvalidId(_)
    ));
}

#[test]
fn batch_to_proto_tags_interface_id() {
    let frames = vec![
        classic(1, 0, 0x10, Direction::Rx, vec![1]),
        classic(2, 0, 0x11, Direction::Rx, vec![2, 3]),
    ];
    let batch = batch_to_proto(IFACE.to_string(), &frames);
    assert_eq!(batch.interface_id, IFACE);
    assert_eq!(batch.frames.len(), 2);

    let decoded = proto_to_batch(&batch, 0).unwrap();
    assert_eq!(decoded, frames);
}

// ---------- batching ----------

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn batch_frames_flushes_when_count_cap_is_reached() {
    let policy = BatchPolicy {
        max_frames_per_batch: 4,
        max_batch_latency: Duration::from_secs(60),
    };
    let frames: Vec<CanFrame> = (0u32..10)
        .map(|i| classic(u64::from(i), 0, 0x100 + i, Direction::Rx, vec![i.try_into().unwrap()]))
        .collect();
    let stream = futures::stream::iter(frames.clone());

    let batches: Vec<_> = batch_frames(IFACE.to_string(), stream, policy)
        .collect()
        .await;

    assert_eq!(batches.len(), 3, "expected 4 + 4 + 2 frames in three batches");
    assert_eq!(batches[0].frames.len(), 4);
    assert_eq!(batches[1].frames.len(), 4);
    assert_eq!(batches[2].frames.len(), 2);
    for batch in &batches {
        assert_eq!(batch.interface_id, IFACE);
    }

    let recovered: Vec<CanFrame> = batches
        .iter()
        .flat_map(|b| proto_to_batch(b, 0).unwrap())
        .collect();
    assert_eq!(recovered, frames);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn batch_frames_flushes_when_latency_cap_elapses() {
    let policy = BatchPolicy {
        max_frames_per_batch: 1024,
        max_batch_latency: Duration::from_millis(10),
    };
    // Two frames, then a long pause, then one more frame. The first
    // batch should flush after the 10 ms cap; the second after EOF.
    let stream = async_stream::stream! {
        yield classic(1, 0, 0x10, Direction::Rx, vec![1]);
        yield classic(2, 0, 0x11, Direction::Rx, vec![2]);
        tokio::time::sleep(Duration::from_millis(50)).await;
        yield classic(3, 0, 0x12, Direction::Rx, vec![3]);
    };

    let batches: Vec<_> = batch_frames(IFACE.to_string(), stream, policy)
        .collect()
        .await;

    assert_eq!(batches.len(), 2, "expected one latency-flush + one EOF flush");
    assert_eq!(batches[0].frames.len(), 2);
    assert_eq!(batches[1].frames.len(), 1);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn batch_frames_flushes_remaining_at_end_of_input() {
    let policy = BatchPolicy {
        max_frames_per_batch: 100,
        max_batch_latency: Duration::from_secs(60),
    };
    let frames: Vec<CanFrame> = (0u32..3)
        .map(|i| classic(u64::from(i), 0, 0x10, Direction::Rx, vec![i.try_into().unwrap()]))
        .collect();
    let stream = futures::stream::iter(frames.clone());

    let batches: Vec<_> = batch_frames(IFACE.to_string(), stream, policy)
        .collect()
        .await;

    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].frames.len(), 3);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn empty_input_produces_no_batches() {
    let policy = BatchPolicy::default();
    let stream = futures::stream::iter(Vec::<CanFrame>::new());
    let batches: Vec<_> = batch_frames(IFACE.to_string(), stream, policy)
        .collect()
        .await;
    assert!(batches.is_empty());
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn unbatch_flattens_to_interface_tagged_frames() {
    let frames_a = vec![classic(1, 0, 0x10, Direction::Rx, vec![1])];
    let frames_b = vec![
        classic(2, 0, 0x20, Direction::Rx, vec![2]),
        classic(3, 0, 0x21, Direction::Rx, vec![3]),
    ];
    let batches = vec![
        batch_to_proto("blf:0".into(), &frames_a),
        batch_to_proto("blf:1".into(), &frames_b),
    ];

    let flattened: Vec<_> = unbatch_frames(futures::stream::iter(batches)).collect().await;

    assert_eq!(flattened.len(), 3);
    assert_eq!(flattened[0].0, "blf:0");
    assert_eq!(flattened[1].0, "blf:1");
    assert_eq!(flattened[2].0, "blf:1");
    assert_eq!(flattened[0].1.can_id, 0x10);
    assert_eq!(flattened[1].1.can_id, 0x20);
    assert_eq!(flattened[2].1.can_id, 0x21);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn batch_then_unbatch_preserves_frames_in_order() {
    let policy = BatchPolicy {
        max_frames_per_batch: 3,
        max_batch_latency: Duration::from_millis(10),
    };
    let originals: Vec<CanFrame> = (0u32..7)
        .map(|i| classic(u64::from(i), 0, 0x100 + i, Direction::Rx, vec![i.try_into().unwrap()]))
        .collect();
    let stream = futures::stream::iter(originals.clone());

    let batches: Vec<proto::FrameBatch> =
        batch_frames(IFACE.to_string(), stream, policy).collect().await;

    let recovered: Vec<CanFrame> = unbatch_frames(futures::stream::iter(batches))
        .map(|(_, proto_frame)| proto_to_frame(&proto_frame, 0).unwrap())
        .collect()
        .await;

    assert_eq!(recovered, originals);
}

// ---------- Phase 7: LogMessage envelope ----------

#[test]
fn log_message_round_trips_through_protobuf() {
    use prost::Message;
    let log = proto::LogMessage {
        timestamp_ns: 1_234_567,
        level: proto::LogLevel::Warn as i32,
        source: "sidecar:peak".into(),
        message: "USB device unplugged".into(),
    };
    let envelope = proto::Envelope {
        body: Some(proto::envelope::Body::Log(log.clone())),
    };

    let bytes = envelope.encode_to_vec();
    let decoded = proto::Envelope::decode(bytes.as_slice()).unwrap();

    match decoded.body.expect("body present") {
        proto::envelope::Body::Log(decoded_log) => {
            assert_eq!(decoded_log.timestamp_ns, log.timestamp_ns);
            assert_eq!(decoded_log.level, log.level);
            assert_eq!(decoded_log.source, log.source);
            assert_eq!(decoded_log.message, log.message);
        }
        other => panic!("expected Log envelope, got {other:?}"),
    }
}

#[test]
fn log_message_is_distinct_from_error_envelope() {
    // An Error variant uses its own tag (4) and the Log variant uses
    // tag 5. Neither maps into the other.
    let err = proto::Envelope {
        body: Some(proto::envelope::Body::Error(proto::Error {
            code: proto::error::Code::Busy as i32,
            message: "already connected".into(),
        })),
    };
    let log = proto::Envelope {
        body: Some(proto::envelope::Body::Log(proto::LogMessage {
            timestamp_ns: 0,
            level: proto::LogLevel::Info as i32,
            source: "server".into(),
            message: "starting up".into(),
        })),
    };
    assert!(matches!(err.body, Some(proto::envelope::Body::Error(_))));
    assert!(matches!(log.body, Some(proto::envelope::Body::Log(_))));
}
