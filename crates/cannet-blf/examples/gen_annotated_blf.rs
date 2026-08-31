//! Generate the BLF fixtures in `examples/capture-features/`.
//!
//! Run from the repository root:
//!
//! ```text
//! cargo run -p cannet-blf --example gen_annotated_blf
//! ```
//!
//! Everything here decodes against `examples/cannet-demo.dbc`, so the set
//! needs no database of its own.
//!
//! | File | What it is |
//! |---|---|
//! | `annotated.blf` | A finished 2 s capture carrying every annotation record a BLF has: `GLOBAL_MARKER` events in four colour states (black among them, which is a colour and not the absence of one), an `EVENT_COMMENT` bound to a message, `cannet-event/1` blocks with tags and structural subjects, one block a *later* schema version wrote, an event of a kind hidden by default, plus error and remote frames on two channels. |
//! | `interrupted.blf` | The same shape of traffic left **unfinalized**: the header carries the anchor the writer latched and nothing else. What a hard kill leaves behind. |
//! | `interrupted-tail.blf` | The same file with its last bytes cut away, so the final `LOG_CONTAINER` ends mid-object. |
//!
//! Event text is spelled out here as literal `cannet-event/1` lines rather
//! than built through the GUI's serializer, which is private to that
//! crate. That is deliberate — a fixture a human can read in a hex dump is
//! worth more than one that shares code with what it exercises. The
//! grammar is
//! [ADR 0057](../../../docs/adr/0057-one-text-block-carries-an-event.md);
//! subjects are
//! [ADR 0056](../../../docs/adr/0056-an-event-subject-is-a-structural-reference.md).

use std::path::{Path, PathBuf};

use cannet_blf::BlfCaptureWriter;
use cannet_core::{CanFrame, CanId, Direction};

/// 2024-03-01T12:00:00Z — the wall clock every stated-start example
/// capture in this repository claims.
const WALL_CLOCK_NS: u64 = 1_709_294_400_000_000_000;

/// `VehicleState` in `examples/cannet-demo.dbc`.
const VEHICLE_STATE_ID: u32 = 0x100;
/// `SensorMux` in `examples/cannet-demo.dbc`.
const SENSOR_MUX_ID: u32 = 0x200;
/// `BatteryDiag` in `examples/cannet-demo.dbc` — extended id.
const BATTERY_DIAG_ID: u32 = 0x18FF_40E5;

/// `CAN_MESSAGE2`, the object type a comment on a classic data frame
/// names in its `commentedEventType`.
const OBJECT_TYPE_CAN_MESSAGE2: u32 = 86;

/// How many frames the interrupted capture appends before it is
/// abandoned. Sized to cross the writer's 128 KiB container buffer
/// several times, so the recovered file holds a run of complete
/// `LOG_CONTAINER`s and one buffer's worth that never reached disk —
/// which is what a kill actually costs.
const INTERRUPTED_FRAMES: u64 = 9_000;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir: PathBuf = std::env::args_os().nth(1).map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/capture-features"),
        PathBuf::from,
    );
    std::fs::create_dir_all(&dir)?;

    // A second argument asks for a *large* capture instead — the one
    // shape a committed demo file cannot be, since the surfaces that need
    // one (determinate load progress, a stopped capture's window scan)
    // need millions of frames and the whole example set is meant to stay
    // a few hundred kilobytes. It is written where it is asked for and
    // never committed.
    if let Some(frames) = std::env::args().nth(2) {
        let frames: u64 = frames.parse()?;
        let path = dir.join("large.blf");
        write_large(&path, frames)?;
        println!("{} — {frames} frames", path.display());
        return Ok(());
    }

    write_annotated(&dir.join("annotated.blf"))?;
    write_interrupted(&dir.join("interrupted.blf"))?;
    truncate_tail(
        &dir.join("interrupted.blf"),
        &dir.join("interrupted-tail.blf"),
    )?;
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

/// Round to the nearest raw count, then keep the low `bits` — the encoding
/// a signed DBC signal's two's-complement slot wants. The sign is
/// deliberately reinterpreted rather than lost: a negative physical value
/// is exactly what two's complement is for here.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn raw(value: f64, bits: usize) -> u64 {
    let rounded = value.round() as i64;
    (rounded as u64) & ((1u64 << bits) - 1)
}

/// `VehicleState`: speed ramps, rpm follows it, the gear lever steps
/// through `P → R → N → D` so the enum lane has four arms, and the brake
/// pedal spikes once mid-capture.
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

/// `BatteryDiag`: the signed-with-offset case (`BattTemp` is
/// `int16 × 0.1 − 40`) beside an unsigned voltage and a signed current.
fn battery_diag(i: u64) -> Vec<u8> {
    #[allow(clippy::cast_precision_loss)]
    let step = (i % 20) as f64;
    let volts = 396.0 - step * 0.4;
    let temp_c = 28.0 + step * 0.3;
    let amps = 85.0 - step * 1.5;

    let mut data = vec![0u8; 8];
    put_bits(&mut data, 0, 16, raw(volts / 0.01, 16));
    put_bits(&mut data, 16, 16, raw((temp_c + 40.0) / 0.1, 16));
    put_bits(&mut data, 32, 16, raw(amps / 0.05, 16));
    data
}

/// `SensorMux`: the selector cycles `0..=3`, so all four arms appear.
fn sensor_mux(i: u64) -> Vec<u8> {
    let selector = i % 4;
    let value = match selector {
        0 => raw((21.0 - 25.0) / 0.01, 16), // TempSensor, degC
        1 => raw(101.3 / 0.1, 16),          // PressureSensor, kPa
        2 => raw(46.0 / 0.1, 16),           // HumiditySensor, %
        _ => raw(0.12 / 0.001, 16),         // AccelSensor, g
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

/// One event's text field: the human description first and verbatim, then
/// the block. A `GLOBAL_MARKER` has its own name and colour fields, so
/// those keys are left out of its block — the block carries only what the
/// carrier cannot.
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

/// The `GLOBAL_MARKER` events in timestamp order: offset from the capture
/// start, label, text, colour.
///
/// `color` is `None` for the uncoloured event and `Some(0)` for the black
/// one. That pair is half the point of the fixture: the record's two
/// colour fields are what tell "no colour" from "black", so a reader that
/// folds `Some(0)` into `None` silently loses a choice someone made.
fn markers() -> Vec<(u64, &'static str, String, Option<u32>)> {
    vec![
        (
            100_000_000,
            "Run start",
            block(
                Some("Bench run, cold pack, contactors closing."),
                &["id: ann-0001", "kind: note", "tag: phase"],
            ),
            Some(0x0022_C55E),
        ),
        (
            500_000_000,
            "Contactor opened under load",
            block(
                Some("Pack current was still climbing when it dropped out."),
                &[
                    "id: ann-0002",
                    "kind: note",
                    "tag: fault",
                    "signal: 0x100 VehSpeed",
                    "message: 0x18FF40E5/ext",
                ],
            ),
            // Black — chosen, not defaulted.
            Some(0x0000_0000),
        ),
        (
            1_100_000_000,
            "Brake spike",
            block(
                None,
                &[
                    "id: ann-0003",
                    "kind: note",
                    "signal: 0x100 BrakePedal",
                    "link: ann-0002",
                ],
            ),
            // No colour at all — the neutral default a marker has always
            // had, and the control the black one is read against.
            None,
        ),
        (
            1_300_000_000,
            "Controller reported an error frame",
            block(
                Some("A kind that hides itself until the filter asks for it."),
                &["id: ann-0006", "kind: busError", "message: 0x100"],
            ),
            Some(0x00EF_4444),
        ),
        (
            1_400_000_000,
            "Written by a later cannet",
            block(
                Some("Its block carries a key this build has no field for."),
                &[
                    "id: ann-0004",
                    "kind: note",
                    "tag: forward-compat",
                    "severity: high",
                    "link: ann-0001",
                ],
            ),
            Some(0x00A8_55F7),
        ),
    ]
}

/// The one `EVENT_COMMENT`: a message-bound event. The record has no name
/// or colour field of its own, so its block carries both — and the object
/// type it is attached to is written twice, in the record's own field for
/// a foreign reader and in the block so the grammar reads the same
/// whatever is carrying it.
fn comment_text() -> String {
    block(
        Some("Gear engaged with the pedal still down."),
        &[
            "id: ann-0005",
            "kind: messageBound",
            "label: Gear change",
            "color: #f97316",
            "tag: review",
            &format!("commentedEventType: {OBJECT_TYPE_CAN_MESSAGE2}"),
            "message: 0x100",
        ],
    )
}

// ----------------------------------------------------------------- fixtures

/// The finished capture: 2 s, ~200 frames, every annotation record.
///
/// Traffic is on two channels. Channel 1 carries the decodable messages;
/// channel 2 carries a thin second stream, so an import into a project
/// with one bus has a channel left over to leave unmapped.
fn write_annotated(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut w = BlfCaptureWriter::create_with_start(path, WALL_CLOCK_NS)?;
    let mut markers = markers().into_iter().peekable();
    let mut comment_written = false;

    for step in 0..100u64 {
        let t = WALL_CLOCK_NS + step * 20_000_000;

        while markers.peek().is_some_and(|m| WALL_CLOCK_NS + m.0 <= t) {
            let (offset, label, text, color) = markers.next().expect("peeked");
            w.append_marker(WALL_CLOCK_NS + offset, label, &text, color)?;
        }
        if !comment_written && t >= WALL_CLOCK_NS + 1_750_000_000 {
            comment_written = true;
            w.append_comment(
                WALL_CLOCK_NS + 1_750_000_000,
                &comment_text(),
                OBJECT_TYPE_CAN_MESSAGE2,
            )?;
        }

        w.append(&classic(t, 0, VEHICLE_STATE_ID, vehicle_state(step)))?;
        if step % 5 == 0 {
            let i = step / 5;
            w.append(&extended(
                t + 2_000_000,
                0,
                BATTERY_DIAG_ID,
                battery_diag(i),
            ))?;
            w.append(&classic(t + 4_000_000, 0, SENSOR_MUX_ID, sensor_mux(i)))?;
        }
        // The thin second channel.
        if step % 10 == 0 {
            w.append(&classic(
                t + 6_000_000,
                1,
                VEHICLE_STATE_ID,
                vehicle_state(step),
            ))?;
        }
        // Two bus errors and one remote frame, so the trace has a row of
        // each kind rather than only data frames.
        match step {
            20 => w.append(&CanFrame::error(
                t + 8_000_000,
                0,
                CanId::standard(VEHICLE_STATE_ID).expect("11-bit"),
                Direction::Rx,
            ))?,
            45 => w.append(&CanFrame::remote(
                t + 8_000_000,
                0,
                CanId::standard(SENSOR_MUX_ID).expect("11-bit"),
                Direction::Tx,
                8,
            ))?,
            81 => w.append(&CanFrame::error(
                t + 8_000_000,
                0,
                CanId::extended(BATTERY_DIAG_ID).expect("29-bit"),
                Direction::Rx,
            ))?,
            _ => {}
        }
    }
    w.finish()?;
    Ok(())
}

/// The interrupted capture. `BlfCaptureWriter` writes straight to
/// `dest`, so producing the state a hard kill leaves is a matter of
/// never calling `finish` — `mem::forget` skips `Drop` too, so not even
/// the file handle's flush runs, and the result costs exactly what a
/// kill costs: the containers already flushed survive, the scratch
/// buffer does not, and the header keeps the anchor the writer latched
/// at open with every statistic still zero.
fn write_interrupted(dest: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut w = BlfCaptureWriter::create_with_start(dest, WALL_CLOCK_NS)?;
    w.append_marker(
        WALL_CLOCK_NS + 5_000_000,
        "Capture started",
        &block(
            Some("The run this file was killed in the middle of."),
            &["id: cut-0001", "kind: note", "tag: phase"],
        ),
        Some(0x0022_C55E),
    )?;
    for step in 0..INTERRUPTED_FRAMES {
        let t = WALL_CLOCK_NS + 10_000_000 + step * 1_000_000;
        w.append(&classic(t, 0, VEHICLE_STATE_ID, vehicle_state(step)))
            .map_err(Box::new)?;
        if step % 5 == 0 {
            w.append(&classic(
                t + 200_000,
                0,
                SENSOR_MUX_ID,
                sensor_mux(step / 5),
            ))?;
        }
    }
    std::mem::forget(w);
    Ok(())
}

/// A capture of arbitrary length, for the surfaces that only show
/// themselves at scale: `frames` frames of the same three messages at
/// 1 ms, finished normally. Measured at ~8.8 bytes per requested frame
/// once compressed — each one brings 0.4 of another message with it — so
/// two million is about 18 MB.
fn write_large(path: &Path, frames: u64) -> Result<(), Box<dyn std::error::Error>> {
    let mut w = BlfCaptureWriter::create_with_start(path, WALL_CLOCK_NS)?;
    for step in 0..frames {
        let t = WALL_CLOCK_NS + step * 1_000_000;
        w.append(&classic(t, 0, VEHICLE_STATE_ID, vehicle_state(step)))?;
        if step % 5 == 0 {
            w.append(&extended(
                t + 100_000,
                0,
                BATTERY_DIAG_ID,
                battery_diag(step / 5),
            ))?;
            w.append(&classic(
                t + 200_000,
                0,
                SENSOR_MUX_ID,
                sensor_mux(step / 5),
            ))?;
        }
    }
    w.finish()?;
    Ok(())
}

/// Copy an unfinalized file with its last bytes removed, so its final
/// `LOG_CONTAINER` ends mid-object. A recovery that stops at the last
/// *complete* object keeps everything before the cut; one that trusts the
/// container's declared length does not.
fn truncate_tail(from: &Path, to: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = std::fs::read(from)?;
    // Enough to land inside the last container's compressed payload
    // rather than on one of its boundaries.
    let keep = bytes.len().saturating_sub(4_096);
    std::fs::write(to, &bytes[..keep])?;
    Ok(())
}
