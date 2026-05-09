//! Serializable shapes carried between the Rust host and the React UI.
//!
//! Kept in one place so the React-side TypeScript types can mirror them
//! without spelunking through other modules.

use can_core::{Direction, Frame, FramePayload};

/// One trace-row's worth of data, ready for the trace view.
#[derive(serde::Serialize, Clone)]
pub struct FrameRecord {
    /// Source timestamp converted to seconds. f64 is what BLF round-trips
    /// natively, and JSON numbers can't safely carry u64 nanoseconds.
    pub timestamp_seconds: f64,
    pub channel: u8,
    pub id: u32,
    pub extended: bool,
    pub direction: &'static str,
    pub kind: FrameKindWire,
    pub data: Vec<u8>,
    pub decoded: Option<DecodedRecord>,
}

#[derive(serde::Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FrameKindWire {
    Classic,
    Fd { brs: bool, esi: bool },
    Remote { dlc: u8 },
    Error,
}

#[derive(serde::Serialize, Clone)]
pub struct DecodedRecord {
    pub name: String,
    pub signals: Vec<SignalRecord>,
}

#[derive(serde::Serialize, Clone)]
pub struct SignalRecord {
    pub name: String,
    /// Physical value (raw * factor + offset).
    pub value: f64,
    pub unit: String,
}

impl FrameRecord {
    #[allow(clippy::cast_precision_loss)]
    pub fn from_frame(frame: &Frame, decoded: Option<DecodedRecord>) -> Self {
        let timestamp_seconds = (frame.timestamp_ns as f64) / 1e9;
        let direction = match frame.direction {
            Direction::Rx => "Rx",
            Direction::Tx => "Tx",
        };
        let (kind, data) = match &frame.payload {
            FramePayload::Classic(d) => (FrameKindWire::Classic, d.clone()),
            FramePayload::Fd { data, flags } => (
                FrameKindWire::Fd {
                    brs: flags.bitrate_switch,
                    esi: flags.error_state_indicator,
                },
                data.clone(),
            ),
            FramePayload::Remote { dlc } => (FrameKindWire::Remote { dlc: *dlc }, Vec::new()),
            FramePayload::Error => (FrameKindWire::Error, Vec::new()),
        };
        Self {
            timestamp_seconds,
            channel: frame.channel,
            id: frame.id.raw(),
            extended: frame.id.is_extended(),
            direction,
            kind,
            data,
            decoded,
        }
    }
}

/// Returned from `open_log` once the worker is running.
#[derive(serde::Serialize, Clone)]
pub struct OpenLogResult {
    pub blf_path: String,
    pub dbc_path: Option<String>,
    /// Number of messages found in the DBC, if one was attached.
    pub dbc_message_count: Option<usize>,
}

/// Emitted alongside frame batches as the log progresses.
#[derive(serde::Serialize, Clone)]
pub struct FrameBatch {
    pub frames: Vec<FrameRecord>,
}

/// Emitted when the log finishes (cleanly or with an error).
#[derive(serde::Serialize, Clone)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LogFinished {
    Ok { total: u64 },
    Error { message: String },
}
