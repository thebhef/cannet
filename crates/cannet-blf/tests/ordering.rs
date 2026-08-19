//! A BLF's objects are not promised to be in timestamp order, and
//! nothing in this crate's read path requires that they are.
//!
//! `objectTimeStamp` is an unsigned offset from the file's
//! `measurement_start_time`, so the format's only timestamp constraint
//! is that no event precede the file's start — never that successive
//! objects ascend. `docs/blf-feature-support.md` § "Object timestamps
//! and ordering" carries the evidence; these tests pin the behaviour
//! that verdict rests on.

use cannet_blf::{scan_blf, BlfCanFrameSource, BlfCaptureWriter};
use cannet_core::{CanFrame, CanFrameSource, CanId, Direction};

const BASE_NS: u64 = 1_700_000_000_u64 * 1_000_000_000;
const MS: u64 = 1_000_000;

fn frame(timestamp_ns: u64) -> CanFrame {
    CanFrame::classic(
        timestamp_ns,
        0,
        CanId::standard(0x100).unwrap(),
        Direction::Rx,
        vec![1, 2, 3, 4],
    )
    .unwrap()
}

/// A capture whose timestamps dip — arrival order is not timestamp
/// order on a multi-bus capture (ADR 0024) — survives a write / read
/// round trip with the dip intact, so long as no event precedes the
/// one the writer anchored on. The descent is written to disk as a
/// descent and read back as one; nothing sorts, nothing clamps.
#[test]
fn a_descending_timestamp_survives_the_round_trip_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("descent.blf");
    let offsets = [0, 1_000 * MS, 500 * MS, 1_100 * MS];

    let mut writer = BlfCaptureWriter::create(&path).unwrap();
    for offset in offsets {
        writer.append(&frame(BASE_NS + offset)).unwrap();
    }
    writer.finish().unwrap();

    let mut source = BlfCanFrameSource::open(&path).unwrap();
    let mut read_back = Vec::new();
    while let Some(f) = source.next_frame().unwrap() {
        read_back.push(f.timestamp_ns - BASE_NS);
    }
    assert_eq!(
        read_back, offsets,
        "the third frame is 500 ms behind the second and must stay there",
    );

    let scan = scan_blf(&path).unwrap();
    assert_eq!(scan.first_timestamp_ns, Some(BASE_NS));
    assert_eq!(scan.last_timestamp_ns, Some(BASE_NS + 1_100 * MS));
}

/// The committed out-of-order fixture decodes end to end through the
/// full `CanFrameSource` path — not just the header-only census — with
/// its descent intact and no error. Its last three objects are the
/// file's *earliest* events, so a read path that required ascending
/// timestamps would have to fail, drop, or reorder them.
#[test]
fn the_out_of_order_fixture_decodes_end_to_end_with_its_descent() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/time-origins/wall-clock-out-of-order.blf");
    let mut source = BlfCanFrameSource::open(&path).unwrap();
    let start = source
        .file_statistics()
        .measurement_start_time
        .to_unix_nanos();

    let mut offsets = Vec::new();
    while let Some(f) = source.next_frame().unwrap() {
        offsets.push(f.timestamp_ns - start);
    }

    assert_eq!(offsets.len(), 121);
    assert_eq!(offsets[0], 500 * MS, "the first object is not the earliest");
    assert_eq!(
        &offsets[offsets.len() - 3..],
        &[2_460 * MS, 120 * MS, 300 * MS],
        "the file's earliest frames are its last two objects",
    );
    assert_eq!(
        offsets.windows(2).filter(|w| w[1] < w[0]).count(),
        1,
        "exactly one descent, delivered rather than smoothed over",
    );
}
