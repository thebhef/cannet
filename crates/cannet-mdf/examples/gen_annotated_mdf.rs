//! Generate the MF4 fixture in `examples/capture-features/`.
//!
//! Run from the repository root:
//!
//! ```text
//! cargo run -p cannet-mdf --example gen_annotated_mdf
//! ```
//!
//! `annotated.mf4` is the MDF half of the pair whose BLF half
//! `cargo run -p cannet-blf --example gen_annotated_blf` writes: the same
//! two seconds of traffic, the same events, decodable against the same
//! `examples/cannet-demo.dbc`. What it adds is everything MDF has a place
//! for and BLF does not:
//!
//! - **Message-independent signal groups** — series recorded directly,
//!   with no frame behind them, one of them *coded* so its lane renders
//!   labels from the file's own conversion block rather than from a DBC.
//! - **A descending master.** One group's samples are written newest
//!   first, which no file this project writes does and plenty of foreign
//!   ones do. The reader sorts at its boundary; the fixture is what makes
//!   that visible by hand.
//! - **A native begin/end range pair.** MDF's own typed span, which reads
//!   back as one more untyped link between two events
//!   ([ADR 0056](../../../docs/adr/0056-an-event-subject-is-a-structural-reference.md)).
//! - **Error and remote frames** in their own bus groups.
//!
//! The payload helpers are deliberately a copy of the BLF generator's
//! rather than shared: a fixture generator should be readable end to end
//! on its own, and the two crates do not otherwise know about each other.

use std::path::{Path, PathBuf};

use cannet_core::{CanFrame, CanId, Direction};
use cannet_mdf::{FileSignal, MdfCaptureLayout, MdfCaptureWriter, MdfEvent, MdfEventRange};

/// 2024-03-01T12:00:00Z — the wall clock every stated-start example
/// capture in this repository claims.
const WALL_CLOCK_NS: u64 = 1_709_294_400_000_000_000;

/// `VehicleState` in `examples/cannet-demo.dbc`.
const VEHICLE_STATE_ID: u32 = 0x100;
/// `SensorMux` in `examples/cannet-demo.dbc`.
const SENSOR_MUX_ID: u32 = 0x200;
/// `BatteryDiag` in `examples/cannet-demo.dbc` — extended id.
const BATTERY_DIAG_ID: u32 = 0x18FF_40E5;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir: PathBuf = std::env::args_os().nth(1).map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/capture-features"),
        PathBuf::from,
    );
    std::fs::create_dir_all(&dir)?;
    write_annotated(&dir.join("annotated.mf4"))?;
    Ok(())
}

// ---------------------------------------------------------------- payloads

/// Place `value`'s low `len` bits at bit `start`, Intel (little-endian)
/// bit numbering — the layout every signal in `cannet-demo.dbc` uses.
fn put_bits(data: &mut [u8], start: usize, len: usize, value: u64) {
    for i in 0..len {
        let bit = start + i;
        if (value >> i) & 1 == 1 {
            data[bit / 8] |= 1 << (bit % 8);
        }
    }
}

/// Round to the nearest raw count, then keep the low `bits`. The sign is
/// deliberately reinterpreted rather than lost — two's complement is the
/// point.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn raw(value: f64, bits: usize) -> u64 {
    let rounded = value.round() as i64;
    (rounded as u64) & ((1u64 << bits) - 1)
}

fn vehicle_state(i: u64) -> Vec<u8> {
    #[allow(clippy::cast_precision_loss)]
    let phase = (i % 50) as f64;
    let speed_kmh = 40.0 + 25.0 * phase / 50.0;
    let rpm = 900.0 + speed_kmh * 42.0;
    let gear = match i {
        0..=9 => 0,
        10..=19 => 1,
        20..=29 => 2,
        _ => 3,
    };
    let brake = if (55..=64).contains(&i) { 80.0 } else { 0.0 };

    let mut data = vec![0u8; 8];
    put_bits(&mut data, 0, 16, raw(speed_kmh / 0.01, 16));
    put_bits(&mut data, 16, 16, raw(rpm / 0.25, 16));
    put_bits(&mut data, 32, 3, gear);
    put_bits(&mut data, 35, 8, raw(brake / 0.5, 8));
    data
}

fn battery_diag(i: u64) -> Vec<u8> {
    #[allow(clippy::cast_precision_loss)]
    let step = (i % 20) as f64;
    let mut data = vec![0u8; 8];
    put_bits(&mut data, 0, 16, raw((396.0 - step * 0.4) / 0.01, 16));
    put_bits(&mut data, 16, 16, raw((28.0 + step * 0.3 + 40.0) / 0.1, 16));
    put_bits(&mut data, 32, 16, raw((85.0 - step * 1.5) / 0.05, 16));
    data
}

fn sensor_mux(i: u64) -> Vec<u8> {
    let selector = i % 4;
    let value = match selector {
        0 => raw((21.0 - 25.0) / 0.01, 16),
        1 => raw(101.3 / 0.1, 16),
        2 => raw(46.0 / 0.1, 16),
        _ => raw(0.12 / 0.001, 16),
    };
    let mut data = vec![0u8; 8];
    put_bits(&mut data, 0, 4, selector);
    put_bits(&mut data, 8, 16, value);
    data
}

fn classic(ts_ns: u64, channel: u8, id: u32, data: Vec<u8>) -> CanFrame {
    CanFrame::classic(
        ts_ns,
        channel,
        CanId::standard(id).expect("fixture ids are 11-bit"),
        Direction::Rx,
        data,
    )
    .expect("fixture frames are well formed")
}

fn extended(ts_ns: u64, channel: u8, id: u32, data: Vec<u8>) -> CanFrame {
    CanFrame::classic(
        ts_ns,
        channel,
        CanId::extended(id).expect("fixture ids are 29-bit"),
        Direction::Rx,
        data,
    )
    .expect("fixture frames are well formed")
}

// ------------------------------------------------------------------ events

/// One event's `<TX>` text: the human description first and verbatim, then
/// the block. An `##EV` block has a name field, so `label` is left out —
/// but it has nowhere to put a colour, so `color` is in the block here
/// where the BLF fixture's markers leave it to the record.
fn block(description: Option<&str>, lines: &[&str]) -> String {
    let mut out = String::new();
    if let Some(description) = description {
        out.push_str(description);
        out.push_str("\n\n");
    }
    out.push_str("cannet-event/1");
    for line in lines {
        out.push('\n');
        out.push_str(line);
    }
    out
}

fn event(offset_ns: u64, name: &str, text: String, range: Option<MdfEventRange>) -> MdfEvent {
    MdfEvent {
        timestamp_ns: WALL_CLOCK_NS + offset_ns,
        name: name.to_owned(),
        text,
        properties: Vec::new(),
        range,
    }
}

/// The events, in the order they are added — which is the order the range
/// indices below refer to.
fn events() -> Vec<MdfEvent> {
    vec![
        // 0 and 1 are MDF's own begin/end pair: a span expressed the way
        // the format expresses one, which reads back as an untyped link.
        event(
            100_000_000,
            "Run start",
            block(
                Some("Bench run, cold pack, contactors closing."),
                &["id: mdf-0001", "kind: note", "color: #22c55e", "tag: phase"],
            ),
            Some(MdfEventRange::Begin { end: 1 }),
        ),
        event(
            1_900_000_000,
            "Run end",
            block(
                None,
                &["id: mdf-0002", "kind: note", "color: #22c55e", "tag: phase"],
            ),
            Some(MdfEventRange::End { begin: 0 }),
        ),
        event(
            500_000_000,
            "Contactor opened under load",
            block(
                Some("Pack current was still climbing when it dropped out."),
                &[
                    "id: mdf-0003",
                    "kind: note",
                    // Black, and here the block is the only place it can
                    // live — an `##EV` has no colour field to fold it into.
                    "color: #000000",
                    "tag: fault",
                    "signal: 0x100 VehSpeed",
                    "message: 0x18FF40E5/ext",
                ],
            ),
            None,
        ),
        event(
            1_300_000_000,
            "Controller reported an error frame",
            block(
                Some("A kind that hides itself until the filter asks for it."),
                &[
                    "id: mdf-0004",
                    "kind: busError",
                    "color: #ef4444",
                    "message: 0x100",
                ],
            ),
            None,
        ),
        event(
            1_400_000_000,
            "Written by a later cannet",
            block(
                Some("Its block carries a key this build has no field for."),
                &[
                    "id: mdf-0005",
                    "kind: note",
                    "color: #a855f7",
                    "tag: forward-compat",
                    "severity: high",
                    "link: mdf-0003",
                ],
            ),
            None,
        ),
        // An event with no block at all — another tool's marker. It gets a
        // synthetic id on import, and its prose stays its prose.
        event(
            1_750_000_000,
            "Marker from another tool",
            "Logged by the bench rig, which has never heard of cannet.".to_owned(),
            None,
        ),
    ]
}

// ---------------------------------------------------------------- fixtures

fn write_annotated(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut w = MdfCaptureWriter::create(
        path,
        MdfCaptureLayout {
            start_time_ns: WALL_CLOCK_NS,
            max_payload_len: 8,
        },
    )?;
    append_frames(&mut w)?;
    add_signals(&mut w);
    for event in events() {
        w.add_event(event);
    }
    w.finish()?;
    Ok(())
}

/// Two seconds of traffic on two bus channels, with an error frame, a
/// remote frame, and a pair of records deliberately written out of order.
fn append_frames(w: &mut MdfCaptureWriter) -> Result<(), Box<dyn std::error::Error>> {
    for step in 0..100u64 {
        let t = WALL_CLOCK_NS + step * 20_000_000;
        w.append_frame(&classic(t, 0, VEHICLE_STATE_ID, vehicle_state(step)))?;
        if step % 5 == 0 {
            let i = step / 5;
            w.append_frame(&extended(
                t + 2_000_000,
                0,
                BATTERY_DIAG_ID,
                battery_diag(i),
            ))?;
            w.append_frame(&classic(t + 4_000_000, 0, SENSOR_MUX_ID, sensor_mux(i)))?;
        }
        if step % 10 == 0 {
            w.append_frame(&classic(
                t + 6_000_000,
                1,
                VEHICLE_STATE_ID,
                vehicle_state(step),
            ))?;
        }
        match step {
            20 => w.append_frame(&CanFrame::error(
                t + 8_000_000,
                0,
                CanId::standard(VEHICLE_STATE_ID).expect("11-bit"),
                Direction::Rx,
            ))?,
            45 => w.append_frame(&CanFrame::remote(
                t + 8_000_000,
                0,
                CanId::standard(SENSOR_MUX_ID).expect("11-bit"),
                Direction::Tx,
                8,
            ))?,
            81 => w.append_frame(&CanFrame::error(
                t + 8_000_000,
                0,
                CanId::extended(BATTERY_DIAG_ID).expect("29-bit"),
                Direction::Rx,
            ))?,
            _ => {}
        }
    }

    // Two frames written *after* the ones that follow them in time, so the
    // record order dips. MDF promises nothing about record order either;
    // what the file states is each record's own master value.
    w.append_frame(&classic(
        WALL_CLOCK_NS + 700_000_000,
        0,
        VEHICLE_STATE_ID,
        vehicle_state(35),
    ))?;
    w.append_frame(&classic(
        WALL_CLOCK_NS + 300_000_000,
        0,
        VEHICLE_STATE_ID,
        vehicle_state(15),
    ))?;
    Ok(())
}

/// The three message-independent series: one ordinary, one whose master
/// descends, and one coded by the file's own conversion block.
fn add_signals(w: &mut MdfCaptureWriter) {
    // An ordinary ascending series.
    let n = 40u64;
    w.add_signal(
        Some("Ambient".into()),
        FileSignal {
            name: "AmbientTemp".into(),
            unit: Some("degC".into()),
            conversion: None,
            value_table: Vec::new(),
            timestamps_ns: (0..n).map(|i| WALL_CLOCK_NS + i * 50_000_000).collect(),
            #[allow(clippy::cast_precision_loss)]
            values: (0..n).map(|i| 18.0 + (i as f64) * 0.1).collect(),
        },
    );

    // The descending master: identical sample times, written newest
    // first. A reader that trusts record order reads this series
    // backwards; one that sorts at its boundary does not.
    w.add_signal(
        Some("Ambient".into()),
        FileSignal {
            name: "CabinHumidity".into(),
            unit: Some("%".into()),
            conversion: None,
            value_table: Vec::new(),
            timestamps_ns: (0..n)
                .rev()
                .map(|i| WALL_CLOCK_NS + i * 50_000_000)
                .collect(),
            #[allow(clippy::cast_precision_loss)]
            values: (0..n).rev().map(|i| 41.0 + (i as f64) * 0.25).collect(),
        },
    );

    // A coded series: the values are codes and the labels are the file's
    // own, so the lane renders labels with no DBC in play at all.
    w.add_signal(
        Some("Charger".into()),
        FileSignal {
            name: "ContactorState".into(),
            unit: None,
            conversion: Some("value_to_text".into()),
            value_table: vec![
                (0, "Open".into()),
                (1, "Precharge".into()),
                (2, "Closed".into()),
                (3, "Fault".into()),
            ],
            timestamps_ns: (0..n).map(|i| WALL_CLOCK_NS + i * 50_000_000).collect(),
            values: (0..n)
                .map(|i| match i {
                    0..=3 => 0.0,
                    4..=7 => 1.0,
                    30..=32 => 3.0,
                    _ => 2.0,
                })
                .collect(),
        },
    );
}
