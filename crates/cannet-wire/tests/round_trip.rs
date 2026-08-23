//! End-to-end tests for the cannet-wire conversion layer.
//!
//! These tests stay in-process: they exercise the wire types and
//! conversions without ever opening a TCP socket. Network transport is
//! covered in the server / client crates.

use cannet_core::{CanFdFlags, CanFrame, CanId, Direction};
use cannet_wire::{
    batch_to_proto, frame_to_proto, proto, proto_to_batch, proto_to_frame, ProtoConversionError,
};

const IFACE: &str = "blf:0";

fn classic(ts: u64, channel: u8, id: u32, dir: Direction, data: Vec<u8>) -> CanFrame {
    CanFrame::classic(ts, channel, CanId::standard(id).unwrap(), dir, data).unwrap()
}

fn fd(ts: u64, channel: u8, id: u32, dir: Direction, data: Vec<u8>, flags: CanFdFlags) -> CanFrame {
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
    let flags = CanFdFlags {
        bitrate_switch: true,
        error_state_indicator: true,
    };
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
    let original = CanFrame::remote(500, 0, CanId::standard(0x7FF).unwrap(), Direction::Rx, 4);
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

// ---------- LogMessage envelope (ADR 0014) ----------

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

// ---------- Virtual-bus envelopes (ADR 0021) ----------

#[test]
fn configure_bus_envelope_round_trips() {
    use prost::Message;
    let cfg = proto::ConfigureBus {
        interface_id: "virtual:bus0".into(),
        speed_bps: 500_000,
        fd_data_speed_bps: 2_000_000,
        fd_enabled: true,
    };
    let envelope = proto::Envelope {
        body: Some(proto::envelope::Body::ConfigureBus(cfg.clone())),
    };
    let bytes = envelope.encode_to_vec();
    let decoded = proto::Envelope::decode(bytes.as_slice()).unwrap();
    match decoded.body.expect("body present") {
        proto::envelope::Body::ConfigureBus(c) => assert_eq!(c, cfg),
        other => panic!("expected ConfigureBus, got {other:?}"),
    }
}

#[test]
fn interface_allocated_envelope_round_trips() {
    use prost::Message;
    let alloc = proto::InterfaceAllocated {
        interface_id: "virtual:bus0/p0".into(),
    };
    let envelope = proto::Envelope {
        body: Some(proto::envelope::Body::InterfaceAllocated(alloc.clone())),
    };
    let bytes = envelope.encode_to_vec();
    let decoded = proto::Envelope::decode(bytes.as_slice()).unwrap();
    match decoded.body.expect("body present") {
        proto::envelope::Body::InterfaceAllocated(a) => assert_eq!(a, alloc),
        other => panic!("expected InterfaceAllocated, got {other:?}"),
    }
}

#[test]
fn interface_state_envelope_round_trips_every_controller_state() {
    use prost::Message;
    for state in [
        proto::ControllerState::Active,
        proto::ControllerState::Passive,
        proto::ControllerState::BusOff,
        proto::ControllerState::Unavailable,
        proto::ControllerState::Warning,
    ] {
        let s = proto::InterfaceState {
            interface_id: "virtual:bus0/bridge-can0".into(),
            state: state.into(),
            tec: 0x80,
            rec: 0x40,
        };
        let envelope = proto::Envelope {
            body: Some(proto::envelope::Body::InterfaceState(s.clone())),
        };
        let bytes = envelope.encode_to_vec();
        let decoded = proto::Envelope::decode(bytes.as_slice()).unwrap();
        match decoded.body.expect("body present") {
            proto::envelope::Body::InterfaceState(d) => assert_eq!(d, s),
            other => panic!("expected InterfaceState, got {other:?}"),
        }
    }
}

#[test]
fn attach_bridge_envelope_round_trips_with_optional_name() {
    use prost::Message;
    let attach = proto::AttachBridge {
        remote_address: "127.0.0.1:7000".into(),
        interface_id: "kvaser:0".into(),
        name: "can0".into(),
    };
    let envelope = proto::Envelope {
        body: Some(proto::envelope::Body::AttachBridge(attach.clone())),
    };
    let bytes = envelope.encode_to_vec();
    let decoded = proto::Envelope::decode(bytes.as_slice()).unwrap();
    match decoded.body.expect("body present") {
        proto::envelope::Body::AttachBridge(a) => assert_eq!(a, attach),
        other => panic!("expected AttachBridge, got {other:?}"),
    }
}

#[test]
fn detach_bridge_envelope_round_trips() {
    use prost::Message;
    let detach = proto::DetachBridge {
        name: "can0".into(),
    };
    let envelope = proto::Envelope {
        body: Some(proto::envelope::Body::DetachBridge(detach.clone())),
    };
    let bytes = envelope.encode_to_vec();
    let decoded = proto::Envelope::decode(bytes.as_slice()).unwrap();
    match decoded.body.expect("body present") {
        proto::envelope::Body::DetachBridge(d) => assert_eq!(d, detach),
        other => panic!("expected DetachBridge, got {other:?}"),
    }
}

#[test]
fn no_acknowledger_error_code_round_trips() {
    use prost::Message;
    let err = proto::Error {
        code: proto::error::Code::NoAcknowledger as i32,
        message: "tx reached zero recipients".into(),
    };
    let envelope = proto::Envelope {
        body: Some(proto::envelope::Body::Error(err.clone())),
    };
    let bytes = envelope.encode_to_vec();
    let decoded = proto::Envelope::decode(bytes.as_slice()).unwrap();
    match decoded.body.expect("body present") {
        proto::envelope::Body::Error(d) => {
            assert_eq!(d.code, proto::error::Code::NoAcknowledger as i32);
            assert_eq!(d.message, err.message);
        }
        other => panic!("expected Error, got {other:?}"),
    }
}

#[test]
fn error_frame_protobuf_round_trips_through_envelope() {
    // The conversion-layer error-frame round-trip is already covered
    // by `error_frame_round_trips`; this test confirms a CanFrame
    // error-frame survives encoding inside a FrameBatch envelope too
    // (bridges forward controller-emitted error frames as ordinary
    // frame batches — ADR 0021).
    use prost::Message;
    let original = CanFrame::error(
        12_345,
        2,
        CanId::extended(0x1234_5678).unwrap(),
        Direction::Rx,
    );
    let envelope = proto::Envelope {
        body: Some(proto::envelope::Body::FrameBatch(proto::FrameBatch {
            interface_id: "virtual:bus0/bridge-can0".into(),
            frames: vec![frame_to_proto(&original)],
        })),
    };
    let bytes = envelope.encode_to_vec();
    let decoded = proto::Envelope::decode(bytes.as_slice()).unwrap();
    let batch = match decoded.body.expect("body present") {
        proto::envelope::Body::FrameBatch(b) => b,
        other => panic!("expected FrameBatch, got {other:?}"),
    };
    assert_eq!(batch.frames.len(), 1);
    let decoded_frame = proto_to_frame(&batch.frames[0], original.channel).unwrap();
    assert_eq!(decoded_frame, original);
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

// ---------- clock probe (SNTP-over-Session) ----------

#[test]
fn clock_probe_and_reply_round_trip_their_epoch_stamps() {
    // The four-timestamp exchange of RFC 4330 carried on our own
    // Session stream: the client's t1 rides out on the probe and comes
    // back on the reply alongside the server's receive (t2) and send
    // (t3) stamps, so the client can pair them without correlation
    // state of its own.
    use prost::Message;
    let probe = proto::Envelope {
        body: Some(proto::envelope::Body::ClockProbe(proto::ClockProbe {
            t1: 1_760_000_000_123_456_789,
        })),
    };
    let decoded = proto::Envelope::decode(probe.encode_to_vec().as_slice()).unwrap();
    let proto::envelope::Body::ClockProbe(p) = decoded.body.expect("body present") else {
        panic!("expected ClockProbe");
    };
    assert_eq!(p.t1, 1_760_000_000_123_456_789);

    let reply = proto::Envelope {
        body: Some(proto::envelope::Body::ClockReply(proto::ClockReply {
            t1: 1_760_000_000_123_456_789,
            t2: 1_760_000_004_000_000_000,
            t3: 1_760_000_004_000_050_000,
        })),
    };
    let decoded = proto::Envelope::decode(reply.encode_to_vec().as_slice()).unwrap();
    let proto::envelope::Body::ClockReply(r) = decoded.body.expect("body present") else {
        panic!("expected ClockReply");
    };
    assert_eq!(r.t1, 1_760_000_000_123_456_789);
    assert_eq!(r.t2, 1_760_000_004_000_000_000);
    assert_eq!(r.t3, 1_760_000_004_000_050_000);
}

#[test]
fn an_envelope_variant_this_build_does_not_know_decodes_as_no_body() {
    // The compatibility claim the clock envelopes rest on: a peer built
    // before a `oneof` variant existed still parses the message, it
    // just sees no body. Hand-rolled bytes for a hypothetical future
    // tag stand in for the older peer we cannot compile here.
    use prost::Message;
    let mut bytes = Vec::new();
    // Field 99, wire type 2 (length-delimited), empty payload.
    prost::encoding::encode_key(99, prost::encoding::WireType::LengthDelimited, &mut bytes);
    prost::encoding::encode_varint(0, &mut bytes);

    let decoded = proto::Envelope::decode(bytes.as_slice())
        .expect("an unknown variant must not fail the decode");
    assert!(
        decoded.body.is_none(),
        "an unknown variant is ignored, not misread as a known one"
    );
}
