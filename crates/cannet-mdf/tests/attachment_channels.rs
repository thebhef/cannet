//! Which bus channels a capture says an attached database is for.
//!
//! A capture says it the way python-can writes it and asammdf reads it:
//! a frame group's `CAN_DataFrame` channel links the attachment through
//! `cn_at_reference`, and the census reports the bus channels that
//! group's frames were on. A capture may also say nothing.
//!
//! This crate's writer links nothing, so the files here are made by
//! rewriting a written capture's bytes: the frame channel is copied to
//! the end of the file with the extra links in place, and the link that
//! led to it is repointed.

use std::path::Path;

use cannet_core::{CanFrame, CanFrameSource, CanId, Direction};
use cannet_mdf::{
    scan_mdf, AttachmentCensus, MdfAttachment, MdfCanFrameSource, MdfCaptureLayout,
    MdfCaptureWriter,
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

/// One frame on each of `channels`, and `attachments`.
fn write(dest: &Path, channels: &[u8], attachments: &[MdfAttachment]) {
    let mut writer = MdfCaptureWriter::create(
        dest,
        MdfCaptureLayout {
            start_time_ns: START_NS,
            max_payload_len: 8,
        },
    )
    .expect("writer opens");
    for (i, channel) in channels.iter().enumerate() {
        let frame = CanFrame::classic(
            START_NS + i as u64 * 1_000_000,
            *channel,
            CanId::standard(0x100).expect("id in range"),
            Direction::Rx,
            vec![u8::try_from(i).expect("fits")],
        )
        .expect("classic payload fits");
        writer.append_frame(&frame).expect("frame appends");
    }
    for attachment in attachments {
        writer.add_attachment(attachment.clone());
    }
    writer.finish().expect("writer finishes");
}

fn frames(path: &Path) -> Vec<CanFrame> {
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

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().expect("8 bytes"))
}

/// Byte offset of link `index` of the block at `block`.
fn link_at(block: u64, index: usize) -> usize {
    usize::try_from(block).expect("fits") + 24 + 8 * index
}

/// Where every MDF 4 file's `##HD` block sits.
const HD: u64 = 64;

fn text(bytes: &[u8], tx: u64) -> String {
    let start = usize::try_from(tx).expect("fits");
    let len = usize::try_from(u64_at(bytes, start + 8)).expect("fits");
    let body = &bytes[start + 24..start + len];
    let end = body.iter().position(|b| *b == 0).unwrap_or(body.len());
    String::from_utf8_lossy(&body[..end]).into_owned()
}

/// Rewrite `path` so its `CAN_DataFrame` channel links the attachments
/// at `which` (positions in the `##AT` chain) through `cn_at_reference`.
fn reference_attachments(path: &Path, which: &[usize]) {
    let mut bytes = std::fs::read(path).expect("reads");

    let mut attachments = Vec::new();
    let mut at = u64_at(&bytes, link_at(HD, 3));
    while at != 0 {
        attachments.push(at);
        at = u64_at(&bytes, link_at(at, 0));
    }

    // The frame channel, and where the link that leads to it sits.
    let mut found = None;
    let mut dg = u64_at(&bytes, link_at(HD, 0));
    while dg != 0 && found.is_none() {
        let mut cg = u64_at(&bytes, link_at(dg, 1));
        while cg != 0 && found.is_none() {
            let mut pointer = link_at(cg, 1);
            let mut cn = u64_at(&bytes, pointer);
            while cn != 0 {
                if text(&bytes, u64_at(&bytes, link_at(cn, 2))) == "CAN_DataFrame" {
                    found = Some((cn, pointer));
                    break;
                }
                pointer = link_at(cn, 0);
                cn = u64_at(&bytes, pointer);
            }
            cg = u64_at(&bytes, link_at(cg, 0));
        }
        dg = u64_at(&bytes, link_at(dg, 0));
    }
    let (cn, pointer) = found.expect("the capture has a CAN_DataFrame channel");

    let old = usize::try_from(cn).expect("fits");
    let len = usize::try_from(u64_at(&bytes, old + 8)).expect("fits");
    let fixed_links_end = old + 24 + 8 * 8;
    // Header and the eight fixed links, the attachment links, then the
    // fixed fields — which is where `cn_attachment_count` lives.
    let mut block = bytes[old..fixed_links_end].to_vec();
    for index in which {
        block.extend_from_slice(&attachments[*index].to_le_bytes());
    }
    let mut fields = bytes[fixed_links_end..old + len].to_vec();
    let count = u16::try_from(which.len()).expect("fits");
    fields[22..24].copy_from_slice(&count.to_le_bytes());
    block.extend_from_slice(&fields);
    let length = block.len() as u64;
    block[8..16].copy_from_slice(&length.to_le_bytes());
    block[16..24].copy_from_slice(&(8 + which.len() as u64).to_le_bytes());

    while !bytes.len().is_multiple_of(8) {
        bytes.push(0);
    }
    let moved = bytes.len() as u64;
    bytes.extend_from_slice(&block);
    bytes[pointer..pointer + 8].copy_from_slice(&moved.to_le_bytes());
    std::fs::write(path, bytes).expect("writes");
}

#[test]
fn a_capture_that_links_nothing_names_no_channels() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("silent.mf4");
    write(&dest, &[0, 1], &[dbc("powertrain.dbc")]);

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

#[test]
fn a_frame_channel_s_attachment_is_for_the_channels_its_frames_were_on() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("referenced.mf4");
    write(&dest, &[0, 1, 1], &[dbc("powertrain.dbc"), dbc("body.dbc")]);
    let before = frames(&dest);
    reference_attachments(&dest, &[1]);

    // A channel block with attachment links carries its fixed fields
    // after them; the frames must read as they did.
    assert_eq!(frames(&dest), before);

    let census = census(&dest);
    assert_eq!(census[0].file_name, "powertrain.dbc");
    assert_eq!(census[0].bus_channels, Vec::<u8>::new());
    assert_eq!(census[1].file_name, "body.dbc");
    assert_eq!(census[1].bus_channels, vec![0, 1]);
}

#[test]
fn a_frame_channel_may_link_several_attachments() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("several.mf4");
    write(&dest, &[2], &[dbc("powertrain.dbc"), dbc("body.dbc")]);
    reference_attachments(&dest, &[0, 1]);

    let census = census(&dest);
    assert_eq!(census[0].bus_channels, vec![2]);
    assert_eq!(census[1].bus_channels, vec![2]);
}
