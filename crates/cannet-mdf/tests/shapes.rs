//! The three content shapes an `.mf4` file can carry, and what the reader
//! does with each: frames decoded, message-independent signals offered,
//! per-message DBC-decoded groups skipped and reported, signal files
//! rejected outright.

mod common;

use cannet_mdf::{scan_mdf, MdfCanFrameSource, MdfSourceError};

use common::{expected, fixture_path, groups_of_kind};

#[test]
fn mixed_file_exposes_its_message_independent_signals() {
    let doc = expected("sorted_finalized_mixed");
    let want = groups_of_kind(&doc, "signal");
    assert_eq!(want.len(), 1, "the mixed fixture has one signal group");

    let source = MdfCanFrameSource::open(fixture_path("sorted_finalized_mixed")).unwrap();
    let got = source.signal_groups();
    assert_eq!(got.len(), want.len());

    let (got, want) = (&got[0], want[0]);
    assert_eq!(
        got.group_index,
        usize::try_from(want["index"].as_u64().unwrap()).unwrap()
    );
    assert_eq!(got.name.as_deref(), want["acq_name"].as_str());

    let want_signals = want["signals"].as_array().unwrap();
    assert_eq!(got.signals.len(), want_signals.len());
    for (got, want) in got.signals.iter().zip(want_signals) {
        assert_eq!(got.name, want["name"].as_str().unwrap());
        assert_eq!(
            got.unit.as_deref().unwrap_or(""),
            want["unit"].as_str().unwrap()
        );
        let samples = want["samples"].as_array().unwrap();
        assert_eq!(got.values.len(), samples.len(), "{} sample count", got.name);
        assert_eq!(got.timestamps_ns.len(), got.values.len());
        for (i, sample) in samples.iter().enumerate() {
            assert_eq!(
                got.timestamps_ns[i],
                sample["t_abs_ns"].as_u64().unwrap(),
                "{}[{i}] timestamp",
                got.name
            );
            assert!(
                (got.values[i] - sample["value"].as_f64().unwrap()).abs() < f64::EPSILON,
                "{}[{i}] value {} != {}",
                got.name,
                got.values[i],
                sample["value"]
            );
        }
    }
}

#[test]
fn a_pure_logger_file_has_no_signal_groups() {
    let source = MdfCanFrameSource::open(fixture_path("sorted_finalized_classic")).unwrap();
    assert!(source.signal_groups().is_empty());
}

#[test]
fn per_message_decoded_groups_are_skipped_and_reported() {
    let doc = expected("sorted_finalized_dbcdecoded");
    let want = groups_of_kind(&doc, "dbc_decoded");
    assert_eq!(want.len(), 2, "the fixture carries two decoded groups");

    let source = MdfCanFrameSource::open(fixture_path("sorted_finalized_dbcdecoded")).unwrap();
    let skipped = source.skipped_decoded_groups();
    assert_eq!(skipped.len(), want.len(), "every decoded group is reported");
    for (got, want) in skipped.iter().zip(&want) {
        assert_eq!(
            got.group_index,
            usize::try_from(want["index"].as_u64().unwrap()).unwrap()
        );
        assert_eq!(got.source_path, want["source_path"].as_str().unwrap());
        assert_eq!(got.name.as_deref(), want["acq_name"].as_str());
        assert_eq!(
            got.signal_count,
            want["channels"].as_array().unwrap().len() - 1,
            "signal count excludes the master channel"
        );
    }

    // Skipped means skipped: their signals must not reappear as
    // file-backed ones, or every signal would be counted twice.
    assert!(
        source.signal_groups().is_empty(),
        "decoded groups must not be offered as message-independent signals"
    );
}

#[test]
fn a_signal_file_is_rejected_rather_than_read_as_empty() {
    let doc = expected("signal_only");
    assert_eq!(doc["shape"], "signal_file");
    let groups = doc["groups"].as_array().unwrap().len();

    let err = MdfCanFrameSource::open(fixture_path("signal_only")).unwrap_err();
    match err {
        MdfSourceError::SignalFile {
            signal_groups,
            decoded_groups,
        } => {
            assert_eq!(signal_groups, groups);
            assert_eq!(decoded_groups, 0);
        }
        other => panic!("expected a signal-file rejection, got {other:?}"),
    }
    // The message has to say what the file is, so a user is not left
    // wondering why their capture came up empty.
    let message = MdfCanFrameSource::open(fixture_path("signal_only"))
        .unwrap_err()
        .to_string();
    assert!(message.contains("pre-decoded signals"), "{message}");

    // The scan says the same thing, so the import dialog fails the same
    // way the import itself would.
    assert!(matches!(
        scan_mdf(fixture_path("signal_only")).unwrap_err(),
        MdfSourceError::SignalFile { .. }
    ));
}
