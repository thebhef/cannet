//! The three content shapes an `.mf4` file can carry, and what the reader
//! does with each: frames decoded, message-independent signals offered,
//! per-message DBC-decoded groups reported and offered too, and a file
//! that is nothing but signal groups read as exactly that.

mod common;

use cannet_mdf::{scan_mdf, MdfCanFrameSource};

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
fn per_message_decoded_groups_are_reported() {
    let doc = expected("sorted_finalized_dbcdecoded");
    let want = groups_of_kind(&doc, "dbc_decoded");
    assert_eq!(want.len(), 2, "the fixture carries two decoded groups");

    let source = MdfCanFrameSource::open(fixture_path("sorted_finalized_dbcdecoded")).unwrap();
    let decoded = source.decoded_message_groups();
    assert_eq!(decoded.len(), want.len(), "every decoded group is reported");
    for (got, want) in decoded.iter().zip(&want) {
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
}

#[test]
fn per_message_decoded_groups_are_offered_as_signals() {
    let doc = expected("sorted_finalized_dbcdecoded");
    let want = groups_of_kind(&doc, "dbc_decoded");

    let source = MdfCanFrameSource::open(fixture_path("sorted_finalized_dbcdecoded")).unwrap();
    let got = source.signal_groups();
    assert_eq!(
        got.len(),
        want.len(),
        "the fixture's only signal-shaped groups are its decoded ones"
    );
    for (got, want) in got.iter().zip(&want) {
        assert_eq!(
            got.group_index,
            usize::try_from(want["index"].as_u64().unwrap()).unwrap()
        );
        assert_eq!(got.name.as_deref(), want["acq_name"].as_str());
        assert_eq!(
            got.decoded_source.as_deref(),
            want["source_path"].as_str(),
            "a decoded group says which message it was decoded from"
        );
        // The master channel is the time axis, not a signal.
        let channels = want["channels"].as_array().unwrap();
        assert_eq!(got.signals.len(), channels.len() - 1);
        let cycles = usize::try_from(want["cycles"].as_u64().unwrap()).unwrap();
        for (signal, name) in got.signals.iter().zip(channels.iter().skip(1)) {
            assert_eq!(signal.name, name.as_str().unwrap());
            assert_eq!(signal.values.len(), cycles, "{} sample count", signal.name);
            assert_eq!(signal.timestamps_ns.len(), signal.values.len());
        }
    }
}

#[test]
fn a_message_independent_group_carries_no_decoded_source() {
    let source = MdfCanFrameSource::open(fixture_path("sorted_finalized_mixed")).unwrap();
    let groups = source.signal_groups();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].decoded_source, None);
}

/// A file with only signal groups carries series and no frames, and that
/// is a shape this reader has: it opens, emits nothing down the frame
/// path, and offers every group it has through the signal path.
#[test]
fn a_signal_only_file_opens_and_offers_its_signals() {
    use cannet_core::CanFrameSource as _;

    let doc = expected("signal_only");
    assert_eq!(doc["shape"], "signal_file");
    let want = groups_of_kind(&doc, "signal");
    assert_eq!(want.len(), 2, "the signal-only fixture has two groups");

    let mut source = MdfCanFrameSource::open(fixture_path("signal_only")).unwrap();
    assert!(
        source.next_frame().unwrap().is_none(),
        "a file with no bus-logging group has no frames to emit"
    );

    let got = source.signal_groups();
    assert_eq!(got.len(), want.len());
    for (got, want) in got.iter().zip(&want) {
        assert_eq!(
            got.group_index,
            usize::try_from(want["index"].as_u64().unwrap()).unwrap()
        );
        assert_eq!(got.name.as_deref(), want["acq_name"].as_str());
        assert_eq!(
            got.decoded_source, None,
            "these groups are message-independent"
        );
        let want_signals = want["signals"].as_array().unwrap();
        assert_eq!(got.signals.len(), want_signals.len());
        for (signal, want) in got.signals.iter().zip(want_signals) {
            assert_eq!(signal.name, want["name"].as_str().unwrap());
            assert_eq!(
                signal.values.len(),
                want["samples"].as_array().unwrap().len(),
                "{} sample count",
                signal.name
            );
        }
    }
    assert!(source.decoded_message_groups().is_empty());
}

/// The census says the same thing, so the import dialog can offer the
/// file's signals — and no CAN-message content, there being none.
#[test]
fn a_signal_only_file_scans_as_a_frameless_census() {
    let scan = scan_mdf(fixture_path("signal_only")).unwrap();
    assert!(scan.channels.is_empty(), "no frames, so no wire channels");
    assert_eq!(scan.frame_count, 0);
    assert_eq!(scan.first_timestamp_ns, None);
    assert_eq!(scan.last_timestamp_ns, None);
    assert_eq!(
        scan.signal_groups
            .iter()
            .map(|g| (g.name.as_deref(), g.signal_count))
            .collect::<Vec<_>>(),
        vec![(Some("Powertrain"), 2), (Some("Electrical"), 1)],
    );
    assert!(scan.decoded_message_groups.is_empty());
}
