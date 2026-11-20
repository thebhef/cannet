//! The multi-bus fixtures that carry their databases — captures written
//! by asammdf, so an outside writer's files — against their committed
//! `expected/*.json`: the frames of every bus, each attached database,
//! and the bus channels its frame groups link it from.
//!
//! - `multibus_databases`: three buses, a `CAN_DataFrame` group each;
//!   one database linked from bus 1's group, one from bus 2's, one from
//!   nowhere, and bus 3 linking nothing.
//! - `shared_group_database`: two buses in one group that links one
//!   database — the link names the group, so it is for both.

mod common;

use cannet_core::{CanFrame, CanFrameSource};
use cannet_mdf::{scan_mdf, MdfCanFrameSource};
use serde_json::Value;

use common::{expected, expected_frames_in_emission_order, fixture_path};

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, b| {
        write!(out, "{b:02x}").expect("writing to a string");
        out
    })
}

fn channels(want: &Value) -> Vec<u8> {
    want["bus_channels"]
        .as_array()
        .expect("bus_channels")
        .iter()
        .map(|c| u8::try_from(c.as_u64().expect("channel")).expect("fits"))
        .collect()
}

fn assert_attachments_match(name: &str) {
    let doc = expected(name);
    let want = doc["attachments"].as_array().expect("attachments");

    let scan = scan_mdf(fixture_path(name)).expect("scans");
    assert_eq!(
        scan.attachments.len(),
        want.len(),
        "{name} attachment count"
    );
    for (got, want) in scan.attachments.iter().zip(want) {
        let at = format!("{name} {}", got.file_name);
        assert_eq!(got.file_name, want["file_name"], "{at} name");
        assert_eq!(got.mime_type, want["mime_type"], "{at} mime type");
        assert_eq!(got.embedded, want["embedded"], "{at} embedded");
        assert_eq!(got.bus_channels, channels(want), "{at} bus channels");
    }

    let source = MdfCanFrameSource::open(fixture_path(name)).expect("opens");
    let attachments = source.attachments().expect("attachments read");
    for (got, want) in attachments.iter().zip(want) {
        assert_eq!(
            hex(&got.data),
            want["data_hex"],
            "{name} {} bytes",
            got.file_name
        );
    }
}

fn frames(name: &str) -> Vec<CanFrame> {
    let mut source = MdfCanFrameSource::open(fixture_path(name)).expect("opens");
    let mut out = Vec::new();
    while let Some(frame) = source.next_frame().expect("frame reads") {
        out.push(frame);
    }
    out
}

/// Every bus's frames, merged in time order — and the channel each one
/// is on, which is what an import's channel → bus mapping keys on.
fn assert_frames_match(name: &str) {
    let want = expected_frames_in_emission_order(&expected(name));
    let got = frames(name);
    assert_eq!(got.len(), want.len(), "{name} frame count");
    for (i, (got, want)) in got.iter().zip(&want).enumerate() {
        assert_eq!(got.timestamp_ns, want.timestamp_ns, "{name}[{i}] timestamp");
        assert_eq!(
            u32::from(got.channel),
            want.bus_channel - 1,
            "{name}[{i}] channel"
        );
        assert_eq!(got.id.raw(), want.id, "{name}[{i}] id");
        assert_eq!(
            got.payload.data(),
            want.data.as_slice(),
            "{name}[{i}] payload"
        );
    }
}

#[test]
fn multibus_databases_reads_three_buses() {
    assert_frames_match("multibus_databases");
    let scan = scan_mdf(fixture_path("multibus_databases")).expect("scans");
    assert_eq!(scan.channels, vec![0, 1, 2]);
    assert_eq!(scan.frame_count, 18);
}

#[test]
fn multibus_databases_links_each_database_from_its_own_bus() {
    assert_attachments_match("multibus_databases");
}

#[test]
fn shared_group_database_reads_two_buses_from_one_group() {
    assert_frames_match("shared_group_database");
    let scan = scan_mdf(fixture_path("shared_group_database")).expect("scans");
    assert_eq!(scan.channels, vec![0, 1]);
}

#[test]
fn shared_group_database_is_for_every_bus_in_the_group() {
    assert_attachments_match("shared_group_database");
}
