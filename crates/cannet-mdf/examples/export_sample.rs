//! Write a deterministic sample capture as MDF, plus a JSON of exactly
//! what went into it, for the asammdf oracle to check the file against.
//!
//! The Rust suite proves the writer against this crate's own reader. This
//! example is the other half: it produces a file for
//! `tests/fixtures/validate_export.py`, which opens it with Python
//! asammdf — the ecosystem's reference implementation — and checks that an
//! outside reader sees the same capture. Run it as
//!
//! ```text
//! cargo run -p cannet-mdf --example export_sample -- <out.mf4>
//! uv run --with asammdf --with numpy python \
//!     crates/cannet-mdf/tests/fixtures/validate_export.py <out.mf4>
//! ```
//!
//! Everything here is invented; nothing comes from any real capture.

use std::path::PathBuf;

use cannet_core::{CanFdFlags, CanFrame, CanFramePayload, CanId, Direction};
use cannet_mdf::{FileSignal, MdfAttachment, MdfCaptureLayout, MdfCaptureWriter, MdfEvent};
use serde_json::json;

/// Sub-millisecond wall clock, so a rounded origin would show.
const START_NS: u64 = 1_709_294_400_123_456_789;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out: PathBuf = std::env::args_os()
        .nth(1)
        .ok_or("usage: export_sample <out.mf4>")?
        .into();

    let frames = frames();
    let signals = signals();
    let events = events();
    let attachment = attachment();

    let max_payload_len = frames
        .iter()
        .map(|f| f.payload.data().len())
        .max()
        .unwrap_or(0);
    let mut writer = MdfCaptureWriter::create(
        &out,
        MdfCaptureLayout {
            start_time_ns: START_NS,
            max_payload_len,
        },
    )?;
    for frame in &frames {
        writer.append_frame(frame)?;
    }
    for (group, signal) in &signals {
        writer.add_signal(group.clone(), signal.clone());
    }
    for event in &events {
        writer.add_event(event.clone());
    }
    writer.add_attachment(attachment.clone());
    let written = writer.finish()?;

    let expectations = json!({
        "file": out.file_name().and_then(|n| n.to_str()),
        "start_time_ns": START_NS,
        "frames": frames.iter().map(frame_json).collect::<Vec<_>>(),
        "signals": signals.iter().map(|(group, signal)| json!({
            "group_name": group,
            "name": signal.name,
            "unit": signal.unit,
            "t_abs_ns": signal.timestamps_ns,
            "values": signal.values,
        })).collect::<Vec<_>>(),
        "events": events.iter().map(|e| json!({
            "t_abs_ns": e.timestamp_ns,
            "name": e.name,
            "properties": e.properties.iter()
                .map(|(k, v)| (k.clone(), serde_json::Value::from(v.clone())))
                .collect::<serde_json::Map<_, _>>(),
        })).collect::<Vec<_>>(),
        "attachment": {
            "file_name": attachment.file_name,
            "mime_type": attachment.mime_type,
            "data_hex": hex(&attachment.data),
        },
        "written": {
            "frame_count": written.frame_count,
            "event_count": written.event_count,
            "signal_count": written.signal_count,
            "attachment_count": written.attachment_count,
            "byte_size": written.byte_size,
        },
    });
    let json_path = out.with_extension("json");
    std::fs::write(
        &json_path,
        serde_json::to_string_pretty(&expectations)? + "\n",
    )?;

    println!(
        "wrote {} ({} bytes, {} frames) and {}",
        out.display(),
        written.byte_size,
        written.frame_count,
        json_path.display()
    );
    Ok(())
}

fn frames() -> Vec<CanFrame> {
    let mut frames = Vec::new();
    for i in 0..24u8 {
        let data: Vec<u8> = (0..i % 9)
            .map(|b| b.wrapping_mul(37).wrapping_add(5))
            .collect();
        frames.push(
            CanFrame::classic(
                START_NS + u64::from(i) * 1_000_037,
                i % 2,
                CanId::new(if i % 3 == 0 { 0x1A5 } else { 0x18FE_E125 }, i % 3 != 0)
                    .expect("id in range"),
                if i % 2 == 0 {
                    Direction::Rx
                } else {
                    Direction::Tx
                },
                data,
            )
            .expect("classic payload fits"),
        );
    }
    for (i, (brs, esi)) in [(false, false), (true, false), (false, true), (true, true)]
        .into_iter()
        .enumerate()
    {
        let len = [12usize, 16, 48, 64][i];
        let data: Vec<u8> = (0..len)
            .map(|b| u8::try_from(b % 251).expect("fits"))
            .collect();
        frames.push(
            CanFrame::fd(
                START_NS + 50_000_000 + i as u64 * 1_000_001,
                1,
                CanId::standard(0x200 + u32::try_from(i).expect("fits")).expect("id in range"),
                Direction::Rx,
                data,
                CanFdFlags {
                    bitrate_switch: brs,
                    error_state_indicator: esi,
                },
            )
            .expect("fd payload fits"),
        );
    }
    frames.push(CanFrame::error(
        START_NS + 60_000_000,
        0,
        CanId::standard(0x7FF).expect("id in range"),
        Direction::Rx,
    ));
    frames.push(CanFrame::remote(
        START_NS + 61_000_000,
        1,
        CanId::extended(0x0CF0_0400).expect("id in range"),
        Direction::Tx,
        6,
    ));
    frames
}

fn signals() -> Vec<(Option<String>, FileSignal)> {
    let series = |name: &str, unit: &str, step: u64, base: f64, slope: f64| FileSignal {
        name: name.to_owned(),
        unit: (!unit.is_empty()).then(|| unit.to_owned()),
        conversion: None,
        value_table: Vec::new(),
        timestamps_ns: (0..20u64).map(|i| START_NS + i * step).collect(),
        values: (0..20).map(|i| base + f64::from(i) * slope).collect(),
    };
    vec![
        (
            Some("Analog".to_owned()),
            series("EngineSpeed", "rpm", 9_000_001, 800.0, 12.5),
        ),
        (
            Some("Analog".to_owned()),
            series("CoolantTemp", "degC", 11_000_003, 70.0, 1.0),
        ),
        (
            Some("Electrical".to_owned()),
            series("BatteryVolts", "V", 7_000_000, 11.8, 0.05),
        ),
    ]
}

fn events() -> Vec<MdfEvent> {
    vec![
        MdfEvent {
            timestamp_ns: START_NS + 5_000_000,
            name: "run start".to_owned(),
            properties: vec![("cannet.id".to_owned(), "sample-0".to_owned())],
        },
        MdfEvent {
            timestamp_ns: START_NS + 45_678_901_234,
            name: "fault & recovery".to_owned(),
            properties: vec![
                ("cannet.id".to_owned(), "sample-1".to_owned()),
                ("cannet.color".to_owned(), "#FF8800".to_owned()),
            ],
        },
    ]
}

fn attachment() -> MdfAttachment {
    MdfAttachment {
        file_name: "sample.dbc".to_owned(),
        mime_type: "application/vnd.vector.dbc".to_owned(),
        data: b"VERSION \"\"\n\nBO_ 421 EngineData: 8 ECU\n SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383] \"rpm\" Vector__XXX\n"
            .to_vec(),
    }
}

fn frame_json(frame: &CanFrame) -> serde_json::Value {
    let (kind, edl, brs, esi) = match &frame.payload {
        CanFramePayload::Classic(_) => ("CAN_DataFrame", 0, 0, 0),
        CanFramePayload::Fd { flags, .. } => (
            "CAN_DataFrame",
            1,
            i32::from(flags.bitrate_switch),
            i32::from(flags.error_state_indicator),
        ),
        CanFramePayload::Error => ("CAN_ErrorFrame", 0, 0, 0),
        CanFramePayload::Remote { .. } => ("CAN_RemoteFrame", 0, 0, 0),
    };
    json!({
        "structure": kind,
        "t_abs_ns": frame.timestamp_ns,
        "bus_channel": u16::from(frame.channel) + 1,
        "id": frame.id.raw(),
        "ide": u8::from(frame.id.is_extended()),
        "dir": u8::from(frame.direction == Direction::Tx),
        "data_length": frame.payload.data().len(),
        "data_hex": hex(frame.payload.data()),
        "edl": edl,
        "brs": brs,
        "esi": esi,
    })
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}
