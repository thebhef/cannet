//! Generate the two BLF import-time-origin fixtures in
//! `examples/time-origins/`.
//!
//! Run from the repository root:
//!
//! ```text
//! cargo run -p cannet-blf --example gen_time_origin_fixtures
//! ```
//!
//! The two files differ in exactly one thing — whether the file states
//! a measurement start time — and that is the fork the import origin
//! rule turns on (ADR 0024):
//!
//! - `relative-zero.blf` carries the all-zero "unset" `SYSTEMTIME`, so
//!   its per-event offsets are offsets from zero and the capture reads
//!   as relative. Every BLF `python-can`'s `BLFWriter` produces from a
//!   capture-relative timeline has this shape, including this repo's
//!   own `examples/cannet-demo.blf`.
//! - `wall-clock-out-of-order.blf` states a wall clock, and its objects
//!   are deliberately **not** in timestamp order: a `GLOBAL_MARKER` and
//!   two frames sit before the first frame in file order. BLF does not
//!   promise chronological objects, so a reader that anchors on "the
//!   first object it sees" anchors above the file's earliest event.
//!
//! The second file is assembled through [`format::writer::BlfFileWriter`]
//! rather than [`cannet_blf::BlfCaptureWriter`], because the capture
//! writer anchors its header on the first frame appended and clamps
//! anything earlier — it cannot express the out-of-order shape a foreign
//! tool can.

use std::path::{Path, PathBuf};

use cannet_blf::format::can::{build_can_message2, encode_can_message2};
use cannet_blf::format::marker;
use cannet_blf::format::writer::BlfFileWriter;
use cannet_blf::BlfCaptureWriter;
use cannet_core::{CanFrame, CanId, Direction};

/// 2024-03-01T12:00:00Z — the wall clock the "stated start" fixture
/// claims, matching the other example captures in this repo.
const WALL_CLOCK_NS: u64 = 1_709_294_400_000_000_000;

/// `EngineData` from `time-origins.dbc`.
const ENGINE_DATA_ID: u32 = 0x100;
/// `Status` from `time-origins.dbc`.
const STATUS_ID: u32 = 0x200;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir: PathBuf = std::env::args_os().nth(1).map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/time-origins"),
        PathBuf::from,
    );
    std::fs::create_dir_all(&dir)?;

    write_relative_zero(&dir.join("relative-zero.blf"))?;
    write_wall_clock_out_of_order(&dir.join("wall-clock-out-of-order.blf"))?;
    Ok(())
}

/// Payload for `EngineData` at `i` — a ramping rpm and a sawtooth
/// coolant temperature, so a plot over the fixture has something to draw.
fn engine_payload(i: u64) -> Vec<u8> {
    let rpm = u16::try_from(800 + (i * 37) % 4_800).unwrap_or(u16::MAX);
    let temp = i8::try_from(i64::try_from(i % 90).unwrap_or(0) - 40).unwrap_or(0);
    let mut data = vec![0u8; 8];
    data[0..2].copy_from_slice(&rpm.to_le_bytes());
    data[2] = temp.to_le_bytes()[0];
    data
}

/// Payload for `Status` at `i` — a three-state enum lane and a counter.
fn status_payload(i: u64) -> Vec<u8> {
    let mut data = vec![0u8; 8];
    data[0] = u8::try_from((i / 10) % 3).unwrap_or(0);
    data[1] = u8::try_from(i % 256).unwrap_or(0);
    data
}

fn frame(ts_ns: u64, id: u32, data: Vec<u8>) -> CanFrame {
    CanFrame::classic(
        ts_ns,
        0,
        CanId::standard(id).expect("fixture ids are 11-bit"),
        Direction::Rx,
        data,
    )
    .expect("fixture frames are well formed")
}

/// The unset-header fixture: two seconds of traffic on a timeline that
/// starts at zero. `BlfCaptureWriter` anchors its `measurement_start_time`
/// on the first frame appended (ms-floored), so a first frame at zero
/// writes the all-zero "unset" `SYSTEMTIME` — the same header
/// `python-can` writes for a capture-relative log.
fn write_relative_zero(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut writer = BlfCaptureWriter::create(path)?;
    for i in 0..100u64 {
        let t = i * 20_000_000; // 20 ms
        writer.append(&frame(t, ENGINE_DATA_ID, engine_payload(i)))?;
        if i % 5 == 0 {
            writer.append(&frame(t + 1_000_000, STATUS_ID, status_payload(i)))?;
        }
    }
    writer.append_marker(1_000_000_000, "halfway", "", 0)?;
    writer.finish()?;
    Ok(())
}

/// One `CAN_MESSAGE2` object's bytes at `rel_ns` after the file's
/// measurement start.
fn message2_bytes(rel_ns: u64, id: u32, data: Vec<u8>) -> Vec<u8> {
    let dlc = u8::try_from(data.len()).expect("fixture payloads are <= 8 bytes");
    let m = build_can_message2(rel_ns, 1, 0, dlc, id, data);
    encode_can_message2(&m)
}

/// The stated-start fixture, written object by object so the file can
/// carry the shape a capture writer cannot: objects out of timestamp
/// order, with the file's earliest event well after the first object in
/// file order.
///
/// File order (relative to the stated start):
///
/// | # | object | offset |
/// |---|---|---|
/// | 1 | `CAN_MESSAGE2` | 500 ms — the first object, *not* the earliest |
/// | … | `CAN_MESSAGE2` × 98 | 520 ms … 2.46 s |
/// | n−2 | `GLOBAL_MARKER` | 100 ms |
/// | n−1 | `CAN_MESSAGE2` | 120 ms |
/// | n | `CAN_MESSAGE2` | 300 ms |
fn write_wall_clock_out_of_order(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fn push(
        writer: &mut BlfFileWriter,
        rel_ns: u64,
        id: u32,
        data: Vec<u8>,
    ) -> std::io::Result<()> {
        let bytes = message2_bytes(rel_ns, id, data);
        writer.append_object(&bytes, WALL_CLOCK_NS + rel_ns)
    }

    let mut writer = BlfFileWriter::create(path)?;
    // The stated measurement start. Set explicitly (rather than
    // inferred from the first object) because that *is* the fixture:
    // the file states a wall clock and the objects are offsets from it.
    let start = writer.set_start_if_unset(WALL_CLOCK_NS);
    assert_eq!(start, WALL_CLOCK_NS);

    for i in 0..99u64 {
        let rel = 500_000_000 + i * 20_000_000;
        push(&mut writer, rel, ENGINE_DATA_ID, engine_payload(i))?;
        if i % 5 == 0 {
            push(&mut writer, rel + 1_000_000, STATUS_ID, status_payload(i))?;
        }
    }

    // The tail the reader meets last and the file's own timeline meets
    // first: an annotation at +100 ms and two frames at +120 ms / +300 ms,
    // all before the first object in file order.
    let m = marker::build(
        100_000_000,
        b"cannet".to_vec(),
        b"early marker".to_vec(),
        Vec::new(),
    );
    let bytes = marker::encode(&m);
    writer.append_object(&bytes, WALL_CLOCK_NS + 100_000_000)?;
    push(
        &mut writer,
        120_000_000,
        ENGINE_DATA_ID,
        engine_payload(200),
    )?;
    push(&mut writer, 300_000_000, STATUS_ID, status_payload(200))?;

    writer.finish()?;
    Ok(())
}
