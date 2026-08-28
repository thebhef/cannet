//! The committed `examples/capture-features/` BLFs must keep exhibiting
//! what their README says they exhibit.
//!
//! These are demo files: they are looked at by hand, not diffed, so
//! nothing else would notice a regeneration that quietly stopped carrying
//! a colour state, an annotation record type, or a recoverable tail. That
//! is what this file is for — the same job
//! `crates/cannet-dbc/tests/ev_zonal_fixture.rs` does for the large DBC
//! pair.
//!
//! Regenerate with
//! `cargo run -p cannet-blf --example gen_annotated_blf`.

use std::path::{Path, PathBuf};

use cannet_blf::{scan_blf, BlfCanFrameSource, BlfScan};
use cannet_core::{CanFramePayload, CanFrameSource};

/// The neutral `foreground` / `background` pair a `GLOBAL_MARKER` carries
/// when its event has no colour — black glyphs on white, which is what
/// this crate's writer has always stamped.
const UNCOLOURED: (u32, u32) = (0x0000_0000, 0x00FF_FFFF);

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/capture-features")
        .join(name)
}

fn scan(name: &str) -> BlfScan {
    scan_blf(fixture(name)).unwrap_or_else(|e| panic!("scanning {name}: {e}"))
}

/// A marker's `description` as text, by the label it carries.
fn description_of(scan: &BlfScan, label: &str) -> String {
    let marker = scan
        .markers
        .iter()
        .find(|m| String::from_utf8_lossy(&m.marker.marker_name) == label)
        .unwrap_or_else(|| panic!("no marker labelled {label:?}"));
    String::from_utf8_lossy(&marker.marker.description).into_owned()
}

/// Both colour states are present and distinguishable. Black is a colour
/// someone chose; the absence of one is not. The record's two colour
/// fields are the only thing that tells them apart, so a fixture that
/// stopped carrying both would leave that distinction untestable by eye.
#[test]
fn the_annotated_fixture_carries_black_and_uncoloured_events() {
    let scan = scan("annotated.blf");
    let colours: Vec<(u32, u32)> = scan
        .markers
        .iter()
        .map(|m| (m.marker.foreground_color, m.marker.background_color))
        .collect();

    assert!(
        colours.contains(&(0x00FF_FFFF, 0x0000_0000)),
        "no black chip among {colours:x?}",
    );
    assert!(
        colours.contains(&UNCOLOURED),
        "no uncoloured control among {colours:x?}",
    );
}

/// Every annotation shape the README claims, one assertion each.
#[test]
fn the_annotated_fixture_carries_every_annotation_shape() {
    let scan = scan("annotated.blf");
    assert_eq!(scan.markers.len(), 5, "GLOBAL_MARKER count");
    assert_eq!(scan.comments.len(), 1, "EVENT_COMMENT count");

    // A comment is bound to the object type it annotates; a freestanding
    // one would carry 0, and then it is a marker in all but name.
    assert_eq!(
        scan.comments[0].comment.commented_event_type, 86,
        "the comment names CAN_MESSAGE2",
    );

    let later_build = description_of(&scan, "Written by a later cannet");
    assert!(
        later_build.contains("\nseverity: high"),
        "no unreadable key in {later_build:?}",
    );

    let bus_error = description_of(&scan, "Controller reported an error frame");
    assert!(
        bus_error.contains("\nkind: busError"),
        "no hidden-by-default kind in {bus_error:?}",
    );

    let subject_bearing = description_of(&scan, "Contactor opened under load");
    assert!(
        subject_bearing.contains("\nsignal: 0x100 VehSpeed")
            && subject_bearing.contains("\nmessage: 0x18FF40E5/ext"),
        "no structural subjects in {subject_bearing:?}",
    );
}

/// Two channels, and a frame of each payload kind. An import into a
/// one-bus project therefore has a channel left over to leave unmapped,
/// and the trace has a row that is not a data frame.
#[test]
fn the_annotated_fixture_carries_two_channels_and_every_payload_kind() {
    assert_eq!(scan("annotated.blf").channels, vec![0, 1]);

    let mut source = BlfCanFrameSource::open(fixture("annotated.blf")).unwrap();
    let (mut data, mut error, mut remote) = (0u32, 0u32, 0u32);
    while let Some(frame) = source.next_frame().unwrap() {
        match frame.payload {
            CanFramePayload::Classic(_) | CanFramePayload::Fd { .. } => data += 1,
            CanFramePayload::Error => error += 1,
            CanFramePayload::Remote { .. } => remote += 1,
        }
    }
    assert!(data > 100, "data frames: {data}");
    assert_eq!(error, 2, "error frames");
    assert_eq!(remote, 1, "remote frames");
}

/// The interrupted capture reads as what it is: never finalized, but with
/// its anchor already on disk and everything the writer flushed before the
/// kill still recoverable.
#[test]
fn the_interrupted_fixture_recovers_with_its_anchor() {
    let scan = scan("interrupted.blf");
    assert!(scan.unfinalized, "the header must still be the placeholder");
    assert_ne!(
        scan.start_unix_nanos, 0,
        "the anchor reaches the header at latch, not at finish",
    );
    assert_eq!(
        scan.first_timestamp_ns.map(|t| t - scan.start_unix_nanos),
        Some(10_000_000),
        "the first frame sits 10 ms after the declared start",
    );
    assert!(
        scan.frame_count > 1_000,
        "several containers' worth: {}",
        scan.frame_count,
    );
}

/// The cut variant loses its last container's tail and says so. What is
/// recoverable is still recovered — the point of the fixture is that the
/// reader stops at the last complete object rather than refusing the file.
#[test]
fn the_cut_fixture_reports_its_incomplete_tail() {
    let whole = scan("interrupted.blf");
    let cut = scan("interrupted-tail.blf");

    assert!(cut.unfinalized);
    assert!(
        cut.truncated_tail_bytes.is_some(),
        "a cut container must be reported, not swallowed",
    );
    assert!(
        cut.frame_count > 0 && cut.frame_count < whole.frame_count,
        "recovered {} of {} frames",
        cut.frame_count,
        whole.frame_count,
    );
}
