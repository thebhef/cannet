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
use cannet_core::{CanFrame, CanFrameSource, CanId, Direction, WindowedSource};

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

/// The fidelity guarantee: a capture whose *earliest* event is not its
/// first appended one keeps every timestamp, because the caller declares
/// the anchor before the first append instead of letting the writer latch
/// it. `[+1000 ms, +500 ms, +1100 ms]` is the sequence that used to come
/// back as `[+1000, +1000, +1100]`.
#[test]
fn a_declared_start_keeps_an_event_earlier_than_the_first_appended() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("declared.blf");
    let offsets = [1_000 * MS, 500 * MS, 1_100 * MS];
    let earliest = BASE_NS + offsets.iter().copied().min().unwrap();

    let mut writer = BlfCaptureWriter::create_with_start(&path, earliest).unwrap();
    for offset in offsets {
        writer.append(&frame(BASE_NS + offset)).unwrap();
    }
    let outcome = writer.finish().unwrap();
    assert_eq!(outcome.clamped_count, 0, "nothing needed clamping");
    assert_eq!(outcome.worst_clamp, None);

    let mut source = BlfCanFrameSource::open(&path).unwrap();
    let mut read_back = Vec::new();
    while let Some(f) = source.next_frame().unwrap() {
        read_back.push(f.timestamp_ns - BASE_NS);
    }
    assert_eq!(
        read_back, offsets,
        "the dip below the first-appended event must survive",
    );
}

/// A caller that declares no anchor still gets the old clamp — the
/// format cannot hold an event before the file's start — but it is
/// reported rather than silent, with the frame it hit and how far the
/// event moved.
#[test]
fn an_undeclared_start_clamps_and_reports_the_event_it_moved() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("undeclared.blf");

    let mut writer = BlfCaptureWriter::create(&path).unwrap();
    writer.append(&frame(BASE_NS + 1_000 * MS)).unwrap();
    writer.append(&frame(BASE_NS + 500 * MS)).unwrap();
    writer.append(&frame(BASE_NS + 900 * MS)).unwrap();
    let outcome = writer.finish().unwrap();

    assert_eq!(outcome.clamped_count, 2, "both events precede the anchor");
    let worst = outcome.worst_clamp.expect("a clamp was recorded");
    assert_eq!(worst.timestamp_ns, BASE_NS + 500 * MS);
    assert_eq!(worst.error_ns, 500 * MS, "the deepest dip is the one named");
    assert_eq!(worst.frame, Some((0, 0x100)));
}

/// `FileStatistics.last_object_time` is the capture's newest event, not
/// whichever event happened to be appended last. Appending
/// `[+1100 ms, +500 ms]` used to stamp a header whose stated span ran
/// backwards.
#[test]
fn the_headers_last_object_time_is_the_latest_event_not_the_last_appended() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("span.blf");

    let mut writer = BlfCaptureWriter::create_with_start(&path, BASE_NS + 500 * MS).unwrap();
    writer.append(&frame(BASE_NS + 1_100 * MS)).unwrap();
    writer.append(&frame(BASE_NS + 500 * MS)).unwrap();
    writer.finish().unwrap();

    let source = BlfCanFrameSource::open(&path).unwrap();
    let stats = source.file_statistics();
    assert_eq!(
        stats.measurement_start_time.to_unix_nanos(),
        BASE_NS + 500 * MS,
    );
    assert_eq!(
        stats.last_object_time.to_unix_nanos(),
        BASE_NS + 1_100 * MS,
        "the header must not claim an end before the file's newest event",
    );
}

/// A time-range import over an out-of-order file returns every frame in
/// the range. Before the fix, `WindowedSource` stopped at the first
/// frame past `end_ns` and never called the inner source again: on
/// this fixture, `end_ns = start + 1000 ms` kept only 31 of
/// the file's 121 frames, silently dropping its two *earliest* frames
/// (+120 ms, +300 ms) even though both are inside the requested window
/// — they arrive as the file's last two objects (see
/// `the_out_of_order_fixture_decodes_end_to_end_with_its_descent`
/// above). The fix reads to EOF and skips out-of-range frames instead,
/// so all 33 in-range frames come back.
#[test]
fn a_windowed_import_over_the_out_of_order_fixture_keeps_every_frame_in_range() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/time-origins/wall-clock-out-of-order.blf");
    let source = BlfCanFrameSource::open(&path).unwrap();
    let start = source
        .file_statistics()
        .measurement_start_time
        .to_unix_nanos();

    let mut windowed = WindowedSource::new(source, None, Some(start + 1_000 * MS));
    let mut offsets = Vec::new();
    while let Some(f) = windowed.next_frame().unwrap() {
        offsets.push(f.timestamp_ns - start);
    }

    assert_eq!(
        offsets.len(),
        33,
        "31 ascending frames plus the file's two earliest, which arrive last",
    );
    assert!(
        offsets.iter().all(|o| *o <= 1_000 * MS),
        "every kept frame is inside the requested window",
    );
    assert!(
        offsets.contains(&(120 * MS)),
        "the file's earliest frame must not be dropped",
    );
    assert!(
        offsets.contains(&(300 * MS)),
        "the file's second-earliest frame must not be dropped",
    );
}
