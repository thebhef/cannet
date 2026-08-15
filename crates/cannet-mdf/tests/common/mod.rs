//! Shared loader for the committed fixture corpus and its
//! `expected/*.json` ground truth.
//!
//! Every fixture test compares against the JSON a `uv run --with asammdf`
//! generator wrote next to the `.mf4` file, so the default suite is
//! Python-free. See `tests/fixtures/gen_fixtures.py` for how the pair is
//! produced and re-verified.

#![allow(dead_code)] // each integration test binary uses a subset

use std::path::PathBuf;

use serde_json::Value;

pub fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(format!("{name}.mf4"))
}

pub fn expected(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/expected")
        .join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read expected JSON {}: {e}", path.display()));
    serde_json::from_str(&text).expect("expected JSON parses")
}

/// The `groups` entries of one fixture's expectation whose `kind` matches.
pub fn groups_of_kind<'a>(doc: &'a Value, kind: &str) -> Vec<&'a Value> {
    doc["groups"]
        .as_array()
        .expect("groups array")
        .iter()
        .filter(|g| g["kind"] == kind)
        .collect()
}

/// Every expected frame across the fixture's bus groups, ordered the way a
/// reader must emit them: ascending absolute timestamp, ties broken by
/// group index then by the frame's index within its group.
pub fn expected_frames_in_emission_order(doc: &Value) -> Vec<ExpectedFrame> {
    let mut out: Vec<ExpectedFrame> = Vec::new();
    for group in groups_of_kind(doc, "bus") {
        let group_index = group["index"].as_u64().expect("group index");
        let frame_type = group["frame_type"].as_str().expect("frame_type").to_owned();
        for frame in group["frames"].as_array().expect("frames") {
            out.push(ExpectedFrame::parse(&frame_type, group_index, frame));
        }
    }
    out.sort_by_key(|f| (f.timestamp_ns, f.group_index, f.index));
    out
}

/// Field-for-field mirror of one `frames[]` entry in the expected JSON,
/// flags and all, hence the row of bools.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedFrame {
    pub frame_type: String,
    pub group_index: u64,
    pub index: u64,
    pub timestamp_ns: u64,
    pub bus_channel: u32,
    pub id: u32,
    pub extended: bool,
    pub dlc: u8,
    pub data: Vec<u8>,
    pub tx: bool,
    pub edl: bool,
    pub brs: bool,
    pub esi: bool,
}

impl ExpectedFrame {
    fn parse(frame_type: &str, group_index: u64, frame: &Value) -> Self {
        let u = |key: &str| frame[key].as_u64().unwrap_or_else(|| panic!("frame.{key}"));
        let data = frame["data_hex"].as_str().expect("data_hex");
        Self {
            frame_type: frame_type.to_owned(),
            group_index,
            index: u("index"),
            timestamp_ns: u("t_abs_ns"),
            bus_channel: u32::try_from(u("bus_channel")).expect("bus channel fits u32"),
            id: u32::try_from(u("id")).expect("id fits u32"),
            extended: u("ide") != 0,
            dlc: u8::try_from(u("dlc")).expect("dlc fits u8"),
            data: hex_bytes(data),
            tx: u("dir") != 0,
            edl: u("edl") != 0,
            brs: u("brs") != 0,
            esi: u("esi") != 0,
        }
    }
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    assert!(hex.len().is_multiple_of(2), "hex string has an even length");
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("hex byte"))
        .collect()
}
