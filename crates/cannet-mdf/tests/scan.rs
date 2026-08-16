//! The import dialog's census walk.

mod common;

use cannet_mdf::scan_mdf;

use common::{expected, expected_frames_in_emission_order, fixture_path};

/// The census must agree with a full decode of the same file: same frame
/// count, same channels, same span. It is the cheap walk, not a different
/// answer.
#[test]
fn census_agrees_with_the_decoded_frames() {
    for name in [
        "sorted_finalized_classic",
        "sorted_finalized_fd",
        "sorted_finalized_dz",
        "sorted_finalized_errorremote",
        "unsorted_finalized_classic",
        "unsorted_unfinalized_classic",
        "sorted_finalized_mixed",
        "sorted_finalized_dbcdecoded",
    ] {
        let doc = expected(name);
        let frames = expected_frames_in_emission_order(&doc);
        let scan = scan_mdf(fixture_path(name)).unwrap_or_else(|e| panic!("scan {name}: {e}"));

        assert_eq!(scan.frame_count, frames.len() as u64, "{name} frame count");
        let mut channels: Vec<u8> = frames
            .iter()
            .map(|f| u8::try_from(f.bus_channel - 1).unwrap())
            .collect();
        channels.sort_unstable();
        channels.dedup();
        assert_eq!(scan.channels, channels, "{name} channel census");
        assert_eq!(
            scan.first_timestamp_ns,
            frames.first().map(|f| f.timestamp_ns),
            "{name} first timestamp"
        );
        assert_eq!(
            scan.last_timestamp_ns,
            frames.last().map(|f| f.timestamp_ns),
            "{name} last timestamp"
        );
        assert_eq!(
            scan.start_unix_nanos,
            doc["hd_start_time_ns"].as_u64().unwrap(),
            "{name} hd start time"
        );
        assert_eq!(
            scan.unfinalized,
            !doc["finalized"].as_bool().unwrap(),
            "{name} finalization"
        );
    }
}

#[test]
fn census_reports_the_files_other_content() {
    let scan = scan_mdf(fixture_path("sorted_finalized_mixed")).unwrap();
    let names: Vec<_> = scan.signal_groups.iter().map(|g| g.name.clone()).collect();
    assert_eq!(names, vec![Some("Analog".to_owned())]);
    assert!(scan
        .signal_groups
        .iter()
        .all(|g| g.decoded_source.is_none()));
    assert!(scan.decoded_message_groups.is_empty());

    // A decoded group is signal content too, so the census counts it —
    // and says which message it came from.
    let scan = scan_mdf(fixture_path("sorted_finalized_dbcdecoded")).unwrap();
    assert_eq!(scan.signal_groups.len(), 2);
    assert!(scan
        .signal_groups
        .iter()
        .all(|g| g.decoded_source.is_some()));
    assert_eq!(
        scan.signal_groups
            .iter()
            .map(|g| g.signal_count)
            .sum::<usize>(),
        3,
        "two signals on 0x100, one on 0x1a5"
    );
    assert_eq!(scan.decoded_message_groups.len(), 2);

    // A pure logger file holds no signal content at all.
    let scan = scan_mdf(fixture_path("sorted_finalized_classic")).unwrap();
    assert!(scan.signal_groups.is_empty());
    assert!(scan.decoded_message_groups.is_empty());
}
