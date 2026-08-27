//! The committed `examples/capture-features/annotated.mf4` must keep
//! exhibiting what its README says it exhibits.
//!
//! It is a demo file — looked at by hand, not diffed — so nothing else
//! would notice a regeneration that quietly stopped carrying the coded
//! series, the descending master, the native range pair or a payload kind.
//!
//! Regenerate with
//! `cargo run -p cannet-mdf --example gen_annotated_mdf`.

use std::path::{Path, PathBuf};

use cannet_core::{CanFramePayload, CanFrameSource};
use cannet_mdf::{FileSignal, MdfCanFrameSource, MdfEventRange};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/capture-features/annotated.mf4")
}

fn source() -> MdfCanFrameSource {
    MdfCanFrameSource::open(fixture()).expect("the fixture opens")
}

/// Every message-independent series in the file, flattened.
fn signals(source: &MdfCanFrameSource) -> Vec<FileSignal> {
    source
        .signal_groups()
        .into_iter()
        .flat_map(|g| g.signals)
        .collect()
}

fn signal(source: &MdfCanFrameSource, name: &str) -> FileSignal {
    signals(source)
        .into_iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("no signal named {name:?}"))
}

/// The file carries series with no frame behind them, one of them coded
/// by the file's own conversion block — so an enum lane can render labels
/// with no database in play at all.
#[test]
fn the_fixture_carries_a_coded_file_backed_series() {
    let source = source();
    let contactor = signal(&source, "ContactorState");
    assert_eq!(
        contactor
            .value_table
            .iter()
            .map(|(code, label)| (*code, label.as_str()))
            .collect::<Vec<_>>(),
        vec![(0, "Open"), (1, "Precharge"), (2, "Closed"), (3, "Fault"),],
    );
    assert!(
        signal(&source, "AmbientTemp").unit.as_deref() == Some("degC"),
        "the plain series keeps its unit",
    );
}

/// One group's samples are written newest first. The reader is where the
/// ascending guarantee is made good, so they come back ascending —
/// paired with the values they were written with, not merely sorted.
#[test]
fn the_descending_master_reads_back_ascending() {
    let source = source();
    let humidity = signal(&source, "CabinHumidity");

    assert!(
        humidity.timestamps_ns.windows(2).all(|w| w[0] <= w[1]),
        "timestamps must ascend: {:?}",
        &humidity.timestamps_ns[..5.min(humidity.timestamps_ns.len())],
    );
    // Written as `41.0 + i * 0.25` against ascending `i`, newest first —
    // so the earliest sample is the smallest value. A sort that dropped
    // the pairing would not put them back together.
    assert_eq!(humidity.values.first().copied(), Some(41.0));
    assert!(
        humidity.values.windows(2).all(|w| w[0] <= w[1]),
        "values must follow their own timestamps",
    );
}

/// MDF's own typed span, which this project stores nothing in but reads
/// as one more untyped link.
#[test]
fn the_fixture_carries_a_native_begin_end_pair() {
    let events = source().events().expect("events read");
    let begins = events
        .iter()
        .filter(|e| matches!(e.range, Some(MdfEventRange::Begin { .. })))
        .count();
    let ends = events
        .iter()
        .filter(|e| matches!(e.range, Some(MdfEventRange::End { .. })))
        .count();
    assert_eq!((begins, ends), (1, 1), "exactly one native pair");

    // One event with no `cannet-event/1` block at all: another tool's
    // marker, which must still read as an event.
    assert!(
        events
            .iter()
            .any(|e| !e.text.contains("cannet-event/1") && !e.text.is_empty()),
        "no foreign-tool event among {} events",
        events.len(),
    );
    // And the forward-compatible one, whose block this build cannot fully
    // read.
    assert!(
        events.iter().any(|e| e.text.contains("\nseverity: high")),
        "no unreadable key in any event",
    );
}

/// Data, error and remote frames all present, on two bus channels.
#[test]
fn the_fixture_carries_every_payload_kind_on_two_channels() {
    let mut source = source();
    let (mut data, mut error, mut remote) = (0u32, 0u32, 0u32);
    let mut channels: Vec<u8> = Vec::new();
    while let Some(frame) = source.next_frame().unwrap() {
        if !channels.contains(&frame.channel) {
            channels.push(frame.channel);
        }
        match frame.payload {
            CanFramePayload::Classic(_) | CanFramePayload::Fd { .. } => data += 1,
            CanFramePayload::Error => error += 1,
            CanFramePayload::Remote { .. } => remote += 1,
        }
    }
    channels.sort_unstable();
    assert_eq!(channels, vec![0, 1]);
    assert!(data > 100, "data frames: {data}");
    assert_eq!(error, 2, "error frames");
    assert_eq!(remote, 1, "remote frames");
}
