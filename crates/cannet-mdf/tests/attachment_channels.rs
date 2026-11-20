//! Which bus channels a capture says an attached database is for.
//!
//! A capture says it the way python-can writes it and asammdf reads it:
//! a frame group's `CAN_DataFrame` channel links the attachment through
//! `cn_at_reference`. The writer groups data frames by bus channel so
//! that a link can name one, and the census reports the channels of the
//! groups that link each attachment.

use std::path::Path;

use cannet_core::{CanFrame, CanFrameSource, CanId, Direction};
use cannet_mdf::{
    scan_mdf, AttachmentCensus, MdfAttachment, MdfCanFrameSource, MdfCaptureLayout,
    MdfCaptureWriter, FRAGMENT_BYTES,
};

const START_NS: u64 = 1_709_294_400_123_456_789;
const DBC_MIME: &str = "application/vnd.vector.dbc";

fn dbc(name: &str) -> MdfAttachment {
    MdfAttachment {
        file_name: name.to_owned(),
        mime_type: DBC_MIME.to_owned(),
        data: format!("BO_ 256 {name}: 8 ECU\n").into_bytes(),
    }
}

fn frame(index: u64, channel: u8) -> CanFrame {
    CanFrame::classic(
        START_NS + index * 1_000_000,
        channel,
        CanId::standard(0x100 + u32::from(channel)).expect("id in range"),
        Direction::Rx,
        index.to_le_bytes().to_vec(),
    )
    .expect("classic payload fits")
}

/// `frames`, and each attachment with the channels it is for.
fn write(dest: &Path, frames: &[CanFrame], attachments: &[(MdfAttachment, &[u8])]) {
    let mut writer = MdfCaptureWriter::create(
        dest,
        MdfCaptureLayout {
            start_time_ns: START_NS,
            max_payload_len: 8,
        },
    )
    .expect("writer opens");
    for frame in frames {
        writer.append_frame(frame).expect("frame appends");
    }
    for (attachment, channels) in attachments {
        writer.add_attachment(attachment.clone(), channels);
    }
    writer.finish().expect("writer finishes");
}

fn read(path: &Path) -> Vec<CanFrame> {
    let mut source = MdfCanFrameSource::open(path).expect("opens");
    let mut out = Vec::new();
    while let Some(frame) = source.next_frame().expect("frame reads") {
        out.push(frame);
    }
    out
}

fn census(path: &Path) -> Vec<AttachmentCensus> {
    scan_mdf(path).expect("scans").attachments
}

#[test]
fn an_attachment_for_no_channel_is_linked_from_nowhere() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("silent.mf4");
    write(
        &dest,
        &[frame(0, 0), frame(1, 1)],
        &[(dbc("powertrain.dbc"), &[])],
    );

    assert_eq!(
        census(&dest),
        vec![AttachmentCensus {
            file_name: "powertrain.dbc".to_owned(),
            mime_type: DBC_MIME.to_owned(),
            embedded: true,
            bus_channels: Vec::new(),
        }]
    );
}

/// The point of grouping frames by bus: a link names a whole group, so a
/// capture whose channels shared one group could only ever say "every
/// channel".
#[test]
fn each_channel_s_group_links_the_databases_that_are_for_it() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("linked.mf4");
    let frames: Vec<CanFrame> = (0..9u8)
        .map(|i| frame(u64::from(i), [0, 2, 5][usize::from(i) % 3]))
        .collect();
    write(
        &dest,
        &frames,
        &[
            (dbc("powertrain.dbc"), &[0]),
            (dbc("body.dbc"), &[2, 5]),
            (dbc("shared.dbc"), &[0, 2, 5]),
            (dbc("spare.dbc"), &[]),
        ],
    );

    // The frames read back as they were written, in time order across
    // the groups — a channel block with attachment links carries its
    // fixed fields after them, so the frames are the first thing at risk.
    assert_eq!(read(&dest), frames);

    let channels: Vec<(String, Vec<u8>)> = census(&dest)
        .into_iter()
        .map(|a| (a.file_name, a.bus_channels))
        .collect();
    assert_eq!(
        channels,
        vec![
            ("powertrain.dbc".to_owned(), vec![0]),
            ("body.dbc".to_owned(), vec![2, 5]),
            ("shared.dbc".to_owned(), vec![0, 2, 5]),
            ("spare.dbc".to_owned(), Vec::new()),
        ]
    );
}

/// A channel with no data frame has no group, so nothing can say a
/// database is for it.
#[test]
fn a_channel_with_no_frames_cannot_be_named() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("absent.mf4");
    write(&dest, &[frame(0, 0)], &[(dbc("body.dbc"), &[0, 3])]);
    assert_eq!(census(&dest)[0].bus_channels, vec![0]);
}

/// A channel's frames are written a fragment at a time and listed in a
/// `##DL`; a capture that spans several fragments on interleaved
/// channels reads back whole and in order.
#[test]
fn a_long_capture_spans_fragments_and_reads_back_in_order() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("long.mf4");
    // A record is a few tens of bytes, so this many frames is several
    // fragments' worth: two thirds of them on channel 0, the rest on 1.
    let total = (FRAGMENT_BYTES / 8) as u64;
    let frames: Vec<CanFrame> = (0..total).map(|i| frame(i, u8::from(i % 3 == 0))).collect();
    write(&dest, &frames, &[(dbc("body.dbc"), &[1])]);

    let back = read(&dest);
    assert_eq!(back.len(), frames.len());
    assert!(back == frames, "the frames read back as written");
    let scan = scan_mdf(&dest).expect("scans");
    assert_eq!(scan.frame_count, total);
    assert_eq!(scan.channels, vec![0, 1]);
    assert_eq!(scan.attachments[0].bus_channels, vec![1]);
}
