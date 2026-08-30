//! A foreign file's sample order, normalised at the reader's boundary.
//!
//! `FileSignal::timestamps_ns` is documented ascending and every consumer
//! depends on it: the paged window lookup binary-searches it, the plot's
//! pyramid folds index-adjacent points into time-span envelopes, and
//! uPlot's own contract is an ascending x axis. Nothing in MDF forbids a
//! descending master, and the import path exists precisely for files
//! another tool wrote — so the reader is where the guarantee has to be
//! made good.
//!
//! Sorting a signal series loses nothing. Unlike the trace, whose row
//! order *is* arrival order (ADR 0024's two timing models), a series is a
//! set of `(time, value)` pairs and the pairing is the only thing that
//! matters.

use cannet_mdf::{FileSignal, MdfCanFrameSource, MdfCaptureLayout, MdfCaptureWriter};

/// `hd_start_time_ns` for the fixtures below.
const START_NS: u64 = 1_709_294_400_123_456_789;

/// Write one signal series verbatim, in the record order given, and read
/// it back through `signal_groups`.
fn round_trip(timestamps_ns: Vec<u64>, values: Vec<f64>) -> FileSignal {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("order.mf4");
    let mut writer = MdfCaptureWriter::create(
        &dest,
        MdfCaptureLayout {
            start_time_ns: START_NS,
            max_payload_len: 8,
        },
    )
    .expect("writer opens");
    writer.add_signal(
        Some("Analog".to_owned()),
        FileSignal {
            name: "PackCurrent".to_owned(),
            unit: Some("A".to_owned()),
            conversion: None,
            value_table: Vec::new(),
            timestamps_ns,
            values,
        },
    );
    writer.finish().expect("writer finishes");

    let source = MdfCanFrameSource::open(&dest).expect("opens");
    let mut groups = source.signal_groups();
    assert_eq!(groups.len(), 1);
    groups.remove(0).signals.remove(0)
}

/// The pairs, as pairs — what a sort is allowed to reorder without losing
/// anything.
fn pairs(signal: &FileSignal) -> Vec<(u64, f64)> {
    signal
        .timestamps_ns
        .iter()
        .copied()
        .zip(signal.values.iter().copied())
        .collect()
}

#[test]
fn a_descending_master_comes_back_ascending() {
    let want: Vec<(u64, f64)> = (0..6u32)
        .map(|i| (START_NS + u64::from(i) * 10_000_000, f64::from(i)))
        .collect();
    // Record order is the reverse: a legal MDF file, and one no cannet
    // writer produces.
    let got = round_trip(
        want.iter().rev().map(|(t, _)| *t).collect(),
        want.iter().rev().map(|(_, v)| *v).collect(),
    );

    assert!(
        got.timestamps_ns.windows(2).all(|w| w[0] <= w[1]),
        "timestamps ascend: {:?}",
        got.timestamps_ns
    );
    assert_eq!(pairs(&got), want, "every sample keeps its own value");
}

#[test]
fn a_pre_start_sample_late_in_record_order_leaves_no_descent() {
    // The master axis is seconds since `hd_start_time_ns`, and a sample
    // before that origin has no representation on it — it lands *at* the
    // origin. One of those in the middle of an otherwise ascending file
    // is enough to manufacture a descent the reader would then hand on.
    let got = round_trip(
        vec![
            START_NS + 10_000_000,
            START_NS + 20_000_000,
            START_NS - 5_000_000,
            START_NS + 30_000_000,
        ],
        vec![1.0, 2.0, 3.0, 4.0],
    );

    assert!(
        got.timestamps_ns.windows(2).all(|w| w[0] <= w[1]),
        "timestamps ascend: {:?}",
        got.timestamps_ns
    );
    assert_eq!(
        pairs(&got),
        vec![
            (START_NS, 3.0),
            (START_NS + 10_000_000, 1.0),
            (START_NS + 20_000_000, 2.0),
            (START_NS + 30_000_000, 4.0),
        ],
    );
}

/// The control: a well-formed file is handed on untouched, ties included.
/// A stable sort is what keeps two samples stamped alike in the order the
/// file put them.
#[test]
fn an_ascending_master_is_unchanged_and_ties_keep_file_order() {
    let want = vec![
        (START_NS, 1.0),
        (START_NS + 10_000_000, 2.0),
        (START_NS + 10_000_000, 3.0),
        (START_NS + 20_000_000, 4.0),
    ];
    let got = round_trip(
        want.iter().map(|(t, _)| *t).collect(),
        want.iter().map(|(_, v)| *v).collect(),
    );
    assert_eq!(pairs(&got), want);
}
