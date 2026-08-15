//! Per-fixture frame decode: every fixture's frames, compared field by
//! field against the committed `expected/*.json`.

mod common;

use cannet_core::{CanFrame, CanFramePayload, CanFrameSource, Direction};
use cannet_mdf::MdfCanFrameSource;

use common::{expected_frames_in_emission_order, fixture_path, ExpectedFrame};

fn decode(name: &str) -> Vec<CanFrame> {
    let mut source = MdfCanFrameSource::open(fixture_path(name))
        .unwrap_or_else(|e| panic!("open fixture {name}: {e}"));
    let mut frames = Vec::new();
    while let Some(frame) = source
        .next_frame()
        .unwrap_or_else(|e| panic!("decode fixture {name}: {e}"))
    {
        frames.push(frame);
    }
    frames
}

/// Compare one decoded frame against its expectation, naming the fixture
/// and frame index in every failure so a mismatch points at a row.
fn assert_frame_matches(name: &str, at: usize, got: &CanFrame, want: &ExpectedFrame) {
    let at = format!("{name}[{at}] (group {} #{})", want.group_index, want.index);
    assert_eq!(got.timestamp_ns, want.timestamp_ns, "{at} timestamp");
    assert_eq!(
        u32::from(got.channel),
        want.bus_channel - 1,
        "{at} channel (0-based; BusChannel is 1-based)"
    );
    assert_eq!(got.id.raw(), want.id, "{at} id");
    assert_eq!(got.id.is_extended(), want.extended, "{at} extended");
    assert_eq!(
        got.direction,
        if want.tx {
            Direction::Tx
        } else {
            Direction::Rx
        },
        "{at} direction"
    );
    match (&got.payload, want.frame_type.as_str()) {
        (CanFramePayload::Classic(data), "CAN_DataFrame") => {
            assert!(!want.edl, "{at} classic payload for an EDL frame");
            assert_eq!(data, &want.data, "{at} payload");
        }
        (CanFramePayload::Fd { data, flags }, "CAN_DataFrame") => {
            assert!(want.edl, "{at} FD payload for a non-EDL frame");
            assert_eq!(data, &want.data, "{at} payload");
            assert_eq!(flags.bitrate_switch, want.brs, "{at} BRS");
            assert_eq!(flags.error_state_indicator, want.esi, "{at} ESI");
        }
        (CanFramePayload::Remote { dlc }, "CAN_RemoteFrame") => {
            assert_eq!(*dlc, want.dlc, "{at} remote DLC");
        }
        (CanFramePayload::Error, "CAN_ErrorFrame") => {}
        (payload, frame_type) => panic!("{at} payload {payload:?} does not match {frame_type}"),
    }
}

fn assert_fixture_decodes(name: &str) {
    let want = expected_frames_in_emission_order(&common::expected(name));
    let got = decode(name);
    assert_eq!(got.len(), want.len(), "{name} frame count");
    for (i, (got, want)) in got.iter().zip(&want).enumerate() {
        assert_frame_matches(name, i, got, want);
    }
}

#[test]
fn sorted_finalized_classic_matches_expected() {
    assert_fixture_decodes("sorted_finalized_classic");
}

#[test]
fn sorted_finalized_fd_matches_expected() {
    assert_fixture_decodes("sorted_finalized_fd");
}

#[test]
fn sorted_finalized_dz_matches_expected() {
    assert_fixture_decodes("sorted_finalized_dz");
}

#[test]
fn sorted_finalized_errorremote_matches_expected() {
    assert_fixture_decodes("sorted_finalized_errorremote");
}

#[test]
fn sorted_finalized_mixed_matches_expected() {
    assert_fixture_decodes("sorted_finalized_mixed");
}

#[test]
fn sorted_finalized_dbcdecoded_matches_expected() {
    assert_fixture_decodes("sorted_finalized_dbcdecoded");
}

#[test]
fn unsorted_finalized_classic_matches_expected() {
    assert_fixture_decodes("unsorted_finalized_classic");
}

#[test]
fn unsorted_unfinalized_classic_matches_expected() {
    assert_fixture_decodes("unsorted_unfinalized_classic");
}

/// The unfinalized twin is the same bytes with the cycle counts zeroed,
/// the last data block's length left header-only and the file stamped
/// `"UnFinMF "`. It must decode to exactly the same frames.
#[test]
fn unfinalized_decodes_identically_to_its_finalized_twin() {
    let finalized = decode("unsorted_finalized_classic");
    let unfinalized = decode("unsorted_unfinalized_classic");
    assert_eq!(finalized, unfinalized);
    let source = MdfCanFrameSource::open(fixture_path("unsorted_unfinalized_classic")).unwrap();
    assert!(source.is_unfinalized(), "fixture is stamped unfinalized");
    let twin = MdfCanFrameSource::open(fixture_path("unsorted_finalized_classic")).unwrap();
    assert!(!twin.is_unfinalized());
}

/// Frames leave the source in ascending timestamp order even when the file
/// keeps each bus group in its own data group.
#[test]
fn frames_arrive_in_timestamp_order() {
    for name in [
        "sorted_finalized_errorremote",
        "unsorted_finalized_classic",
        "sorted_finalized_dbcdecoded",
    ] {
        let frames = decode(name);
        assert!(
            frames
                .windows(2)
                .all(|w| w[0].timestamp_ns <= w[1].timestamp_ns),
            "{name} frames are not in timestamp order"
        );
    }
}
