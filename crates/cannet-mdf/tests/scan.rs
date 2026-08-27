//! The import dialog's census walk.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};

use cannet_core::{CanFrame, CanId, Direction};
use cannet_mdf::{
    scan_mdf, scan_mdf_cancellable, MdfCaptureLayout, MdfCaptureWriter, ScanOutcome, ScanProgress,
};

use common::{expected, expected_frames_in_emission_order, fixture_path};

/// Enough records that the walk crosses its checkpoint more than once —
/// a cancel raised at the first is only observable at the second.
const CENSUS_FIXTURE_FRAMES: u64 = 40_000;
const BASE_NS: u64 = 1_700_000_000_u64 * 1_000_000_000;

fn write_census_fixture(path: &std::path::Path) {
    let mut writer = MdfCaptureWriter::create(
        path,
        MdfCaptureLayout {
            start_time_ns: BASE_NS,
            max_payload_len: 8,
        },
    )
    .unwrap();
    for i in 0..CENSUS_FIXTURE_FRAMES {
        writer
            .append_frame(
                &CanFrame::classic(
                    BASE_NS + i * 1_000,
                    0,
                    CanId::standard(0x100).unwrap(),
                    Direction::Rx,
                    vec![1, 2, 3, 4, 5, 6, 7, 8],
                )
                .unwrap(),
            )
            .unwrap();
    }
    writer.finish().unwrap();
}

/// The MDF census walks the whole record stream before the mapping
/// dialog exists, exactly as the BLF one does, so it must be stoppable
/// the same way and report nothing when it stops.
#[test]
fn a_cancelled_census_stops_the_walk_and_reports_no_scan() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cancel.mf4");
    write_census_fixture(&path);

    let cancel = AtomicBool::new(false);
    let mut checkpoints = 0u32;
    let outcome = scan_mdf_cancellable(&path, &cancel, &mut |_| {
        checkpoints += 1;
        cancel.store(true, Ordering::Relaxed);
    })
    .unwrap();

    assert_eq!(outcome, ScanOutcome::Cancelled);
    assert!(
        checkpoints < 4,
        "the walk kept going past the cancel ({checkpoints} checkpoints)"
    );
}

/// The control: the same walk, nothing cancelling it, runs to the end
/// and reports every record — so the test above is about the cancel and
/// not about a checkpoint that stops the walk regardless.
#[test]
fn an_uncancelled_census_runs_to_the_end_of_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("uncancelled.mf4");
    write_census_fixture(&path);

    let cancel = AtomicBool::new(false);
    let mut checkpoints = 0u32;
    let outcome = scan_mdf_cancellable(&path, &cancel, &mut |_| checkpoints += 1).unwrap();

    let ScanOutcome::Complete(scan) = outcome else {
        panic!("an uncancelled census must complete");
    };
    assert_eq!(scan.frame_count, CENSUS_FIXTURE_FRAMES);
    assert!(
        checkpoints > 1,
        "only {checkpoints} checkpoints in {CENSUS_FIXTURE_FRAMES} records"
    );
}

/// Progress counts the record bytes the walk traverses: non-decreasing,
/// never past its own total, and landing on the whole of it.
#[test]
fn census_progress_is_record_bytes_walked_against_the_walks_own_total() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("progress.mf4");
    write_census_fixture(&path);

    let cancel = AtomicBool::new(false);
    let mut seen: Vec<ScanProgress> = Vec::new();
    let outcome = scan_mdf_cancellable(&path, &cancel, &mut |p| seen.push(p)).unwrap();
    assert!(matches!(outcome, ScanOutcome::Complete(_)));

    assert!(!seen.is_empty(), "no progress was reported at all");
    let total = seen[0].total_bytes;
    assert!(total > 0);
    for p in &seen {
        assert_eq!(p.total_bytes, total);
        assert!(p.bytes_read <= p.total_bytes, "progress overshot: {p:?}");
    }
    for pair in seen.windows(2) {
        assert!(
            pair[1].bytes_read >= pair[0].bytes_read,
            "progress went backwards: {pair:?}"
        );
    }
    assert_eq!(
        seen.last().unwrap().bytes_read,
        total,
        "the last report must be the whole walk"
    );
}

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

/// A cancel pressed *before* the walk starts is honoured, and no record
/// is walked.
///
/// This is the press that lands during `Mdf4File::open` — one
/// uninterruptible call that is most of a large file's scan time. The
/// caller publishes the flag before calling in, so the press is already
/// recorded; the question is only whether anything reads it before the
/// walk. Raising it up front is the same state the walk sees on entry.
///
/// **The checkpoint alone is not enough to cover this.** The first
/// checkpoint arrives `CHECKPOINT_RECORDS` records in, so on a file
/// holding fewer than that it never arrives at all and the scan would
/// complete despite the cancel. This fixture is deliberately small
/// enough to sit inside one checkpoint stride.
#[test]
fn a_cancel_raised_before_the_walk_starts_is_honoured() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cancel-before-walk.mf4");
    write_small_fixture(&path);

    let cancel = AtomicBool::new(true);
    let mut checkpoints = 0usize;
    let outcome = scan_mdf_cancellable(&path, &cancel, &mut |_| checkpoints += 1).unwrap();

    assert!(
        matches!(outcome, ScanOutcome::Cancelled),
        "a census entered with the cancel already raised must report Cancelled"
    );
    assert_eq!(
        checkpoints, 0,
        "no record should have been walked, so no checkpoint should have fired"
    );
}

/// Small enough that the walk never reaches its first checkpoint — the
/// regime `a_cancel_raised_before_the_walk_starts_is_honoured` needs.
fn write_small_fixture(path: &std::path::Path) {
    let mut writer = MdfCaptureWriter::create(
        path,
        MdfCaptureLayout {
            start_time_ns: BASE_NS,
            max_payload_len: 8,
        },
    )
    .unwrap();
    for i in 0..8u64 {
        writer
            .append_frame(
                &CanFrame::classic(
                    BASE_NS + i * 1_000,
                    0,
                    CanId::standard(0x100).unwrap(),
                    Direction::Rx,
                    vec![1, 2, 3, 4, 5, 6, 7, 8],
                )
                .unwrap(),
            )
            .unwrap();
    }
    writer.finish().unwrap();
}
