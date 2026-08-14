//! Writer tests: build a capture in memory, write it, and read it back
//! with this crate's own reader — the reader the fixture suite already
//! pins field-for-field against an asammdf oracle, so a write that
//! survives it survives the format.

use cannet_core::{CanFdFlags, CanFrame, CanFrameSource, CanId, Direction};
use cannet_mdf::{
    FileSignal, MdfAttachment, MdfCanFrameSource, MdfCaptureLayout, MdfCaptureWriter, MdfEvent,
    MdfWriteError,
};

/// `hd_start_time_ns` of every capture below — an arbitrary wall clock
/// with a sub-millisecond tail, so a writer that rounds the origin shows.
const START_NS: u64 = 1_709_294_400_123_456_789;

fn classic(ts_ns: u64, channel: u8, id: u32, extended: bool, data: &[u8]) -> CanFrame {
    CanFrame::classic(
        ts_ns,
        channel,
        CanId::new(id, extended).expect("id in range"),
        Direction::Rx,
        data.to_vec(),
    )
    .expect("classic payload fits")
}

/// The capture every round-trip test writes: two buses, both addressing
/// modes, every payload length a classic frame can carry, FD frames with
/// each flag combination, and one error and one remote frame.
fn capture() -> Vec<CanFrame> {
    let mut frames = Vec::new();
    for i in 0..9u8 {
        let data: Vec<u8> = (0..i).map(|b| b.wrapping_mul(37).wrapping_add(5)).collect();
        frames.push(classic(
            START_NS + u64::from(i) * 1_000_037,
            i % 2,
            if i % 3 == 0 { 0x1A5 } else { 0x18FE_E125 },
            i % 3 != 0,
            &data,
        ));
    }
    for (i, (brs, esi)) in [(false, false), (true, false), (false, true), (true, true)]
        .into_iter()
        .enumerate()
    {
        let len = [12usize, 16, 48, 64][i];
        let data: Vec<u8> = (0..len)
            .map(|b| u8::try_from(b % 251).expect("fits"))
            .collect();
        frames.push(
            CanFrame::fd(
                START_NS + 20_000_000 + i as u64 * 1_000_001,
                1,
                CanId::standard(0x200 + u32::try_from(i).expect("fits")).expect("id in range"),
                Direction::Tx,
                data,
                CanFdFlags {
                    bitrate_switch: brs,
                    error_state_indicator: esi,
                },
            )
            .expect("fd payload fits"),
        );
    }
    frames.push(CanFrame::error(
        START_NS + 30_000_000,
        0,
        CanId::standard(0x7FF).expect("id in range"),
        Direction::Rx,
    ));
    frames.push(CanFrame::remote(
        START_NS + 31_000_000,
        1,
        CanId::extended(0x0CF0_0400).expect("id in range"),
        Direction::Tx,
        6,
    ));
    frames
}

/// Emission order of the reader: ascending timestamp, ties broken by the
/// structure group (data, error, remote) the frame belongs to.
fn in_emission_order(frames: &[CanFrame]) -> Vec<CanFrame> {
    use cannet_core::CanFramePayload as P;
    let mut out = frames.to_vec();
    out.sort_by_key(|f| {
        let group = match f.payload {
            P::Classic(_) | P::Fd { .. } => 0,
            P::Error => 1,
            P::Remote { .. } => 2,
        };
        (f.timestamp_ns, group)
    });
    out
}

fn write(dir: &std::path::Path, frames: &[CanFrame]) -> std::path::PathBuf {
    let dest = dir.join("capture.mf4");
    let max_payload = frames
        .iter()
        .map(|f| f.payload.data().len())
        .max()
        .unwrap_or(0);
    let mut writer = MdfCaptureWriter::create(
        &dest,
        MdfCaptureLayout {
            start_time_ns: frames.iter().map(|f| f.timestamp_ns).min().unwrap_or(0),
            max_payload_len: max_payload,
        },
    )
    .expect("writer opens");
    for frame in frames {
        writer.append_frame(frame).expect("frame appends");
    }
    writer.finish().expect("writer finishes");
    dest
}

fn read_back(path: &std::path::Path) -> Vec<CanFrame> {
    let mut source = MdfCanFrameSource::open(path).expect("written file opens");
    let mut out = Vec::new();
    while let Some(frame) = source.next_frame().expect("frame decodes") {
        out.push(frame);
    }
    out
}

#[test]
fn every_frame_survives_the_write_field_for_field() {
    let dir = tempfile::tempdir().expect("temp dir");
    let frames = capture();
    let path = write(dir.path(), &frames);
    assert_eq!(read_back(&path), in_emission_order(&frames));
}

#[test]
fn the_written_file_is_sorted_and_finalized() {
    let dir = tempfile::tempdir().expect("temp dir");
    let frames = capture();
    let path = write(dir.path(), &frames);

    let source = MdfCanFrameSource::open(&path).expect("opens");
    assert!(!source.is_unfinalized());
    assert_eq!(source.start_unix_nanos(), START_NS);
    assert!(source.decoded_message_groups().is_empty());

    let scan = cannet_mdf::scan_mdf(&path).expect("scans");
    assert_eq!(scan.frame_count, frames.len() as u64);
    assert_eq!(scan.channels, vec![0, 1]);
    assert_eq!(
        scan.first_timestamp_ns,
        frames.iter().map(|f| f.timestamp_ns).min()
    );
    assert_eq!(
        scan.last_timestamp_ns,
        frames.iter().map(|f| f.timestamp_ns).max()
    );
    assert!(!scan.unfinalized);
}

#[test]
fn absolute_nanoseconds_come_back_exactly() {
    let dir = tempfile::tempdir().expect("temp dir");
    // Offsets no multiple of a millisecond, spanning an hour, so the
    // f64-seconds master axis is exercised where rounding would show.
    let frames: Vec<CanFrame> = [0u64, 1, 999_999_999, 3_600_000_000_007]
        .iter()
        .map(|off| classic(START_NS + off, 0, 0x123, false, &[1, 2, 3]))
        .collect();
    let path = write(dir.path(), &frames);
    let got: Vec<u64> = read_back(&path).iter().map(|f| f.timestamp_ns).collect();
    assert_eq!(
        got,
        frames.iter().map(|f| f.timestamp_ns).collect::<Vec<_>>()
    );
}

#[test]
fn a_capture_with_no_frames_still_reads_as_a_capture() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = write(dir.path(), &[]);
    assert!(read_back(&path).is_empty());
    let scan = cannet_mdf::scan_mdf(&path).expect("an empty capture is still a logger file");
    assert_eq!(scan.frame_count, 0);
}

#[test]
fn file_backed_signals_come_back_verbatim() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("signals.mf4");
    let series = |name: &str, unit: Option<&str>, step: u64, scale: f64| FileSignal {
        name: name.to_owned(),
        unit: unit.map(ToOwned::to_owned),
        conversion: None,
        timestamps_ns: (0..12u64).map(|i| START_NS + i * step).collect(),
        values: (0..12).map(|i| f64::from(i) * scale - 3.25).collect(),
    };
    let written = [
        (
            Some("Analog".to_owned()),
            series("EngineSpeed", Some("rpm"), 9_000_001, 12.5),
        ),
        (
            Some("Analog".to_owned()),
            series("CoolantTemp", Some("degC"), 11_000_003, 1.0),
        ),
        (None, series("Unnamed", None, 7_000_000, 0.5)),
    ];

    let mut writer = MdfCaptureWriter::create(
        &dest,
        MdfCaptureLayout {
            start_time_ns: START_NS,
            max_payload_len: 8,
        },
    )
    .expect("writer opens");
    writer
        .append_frame(&classic(START_NS, 0, 0x100, false, &[1]))
        .expect("frame appends");
    for (group, signal) in &written {
        writer.add_signal(group.clone(), signal.clone());
    }
    writer.finish().expect("writer finishes");

    let source = MdfCanFrameSource::open(&dest).expect("opens");
    let groups = source.signal_groups();
    assert_eq!(groups.len(), written.len(), "one channel group per signal");
    for (group, (name, signal)) in groups.iter().zip(&written) {
        assert_eq!(&group.name, name);
        assert_eq!(group.signals.len(), 1);
        let got = &group.signals[0];
        assert_eq!(got.name, signal.name);
        assert_eq!(got.unit, signal.unit.clone().filter(|u| !u.is_empty()));
        assert_eq!(got.timestamps_ns, signal.timestamps_ns);
        assert_eq!(got.values, signal.values);
    }
}

#[test]
fn timeline_events_come_back_with_their_time_and_properties() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("events.mf4");
    let events = vec![
        MdfEvent {
            timestamp_ns: START_NS + 1,
            name: "trigger armed".to_owned(),
            properties: vec![
                ("cannet.id".to_owned(), "3f1c-0".to_owned()),
                ("cannet.color".to_owned(), "#FF8800".to_owned()),
            ],
        },
        MdfEvent {
            timestamp_ns: START_NS + 12_345_678_901,
            name: "fault & recovery".to_owned(),
            properties: Vec::new(),
        },
    ];

    let mut writer = MdfCaptureWriter::create(
        &dest,
        MdfCaptureLayout {
            start_time_ns: START_NS,
            max_payload_len: 8,
        },
    )
    .expect("writer opens");
    writer
        .append_frame(&classic(START_NS, 0, 0x100, false, &[1]))
        .expect("frame appends");
    for event in &events {
        writer.add_event(event.clone());
    }
    writer.finish().expect("writer finishes");

    let source = MdfCanFrameSource::open(&dest).expect("opens");
    assert_eq!(source.events().expect("events read"), events);
    assert_eq!(cannet_mdf::scan_mdf(&dest).expect("scans").events, events);
}

#[test]
fn an_embedded_attachment_comes_back_byte_for_byte() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("attached.mf4");
    let attachments = vec![
        MdfAttachment {
            file_name: "powertrain.dbc".to_owned(),
            mime_type: "application/vnd.vector.dbc".to_owned(),
            data: b"BO_ 256 EngineData: 8 ECU\n".to_vec(),
        },
        MdfAttachment {
            file_name: "chassis.dbc".to_owned(),
            mime_type: "application/vnd.vector.dbc".to_owned(),
            data: (0..=255u8).collect(),
        },
    ];

    let mut writer = MdfCaptureWriter::create(
        &dest,
        MdfCaptureLayout {
            start_time_ns: START_NS,
            max_payload_len: 8,
        },
    )
    .expect("writer opens");
    writer
        .append_frame(&classic(START_NS, 0, 0x100, false, &[1]))
        .expect("frame appends");
    for attachment in &attachments {
        writer.add_attachment(attachment.clone());
    }
    let outcome = writer.finish().expect("writer finishes");
    assert_eq!(outcome.attachment_count, 2);

    let source = MdfCanFrameSource::open(&dest).expect("opens");
    assert_eq!(source.attachments().expect("attachments read"), attachments);
}

#[test]
fn an_abandoned_write_leaves_the_destination_alone() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("abandoned.mf4");
    {
        let mut writer = MdfCaptureWriter::create(
            &dest,
            MdfCaptureLayout {
                start_time_ns: START_NS,
                max_payload_len: 8,
            },
        )
        .expect("writer opens");
        writer
            .append_frame(&classic(START_NS, 0, 0x100, false, &[1]))
            .expect("frame appends");
    }
    assert!(!dest.exists(), "the destination is only created by finish");
    assert!(
        !dest.with_extension("mf4.part").exists(),
        "the temp file goes with the abandoned writer"
    );
}

#[test]
fn a_payload_longer_than_the_layout_is_refused() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("short.mf4");
    let mut writer = MdfCaptureWriter::create(
        &dest,
        MdfCaptureLayout {
            start_time_ns: START_NS,
            max_payload_len: 8,
        },
    )
    .expect("writer opens");
    let long = CanFrame::fd(
        START_NS,
        0,
        CanId::standard(0x100).expect("id in range"),
        Direction::Rx,
        vec![0u8; 16],
        CanFdFlags::default(),
    )
    .expect("fd payload fits");
    assert!(matches!(
        writer.append_frame(&long),
        Err(MdfWriteError::PayloadOverLayout { len: 16, field: 8 })
    ));
}
