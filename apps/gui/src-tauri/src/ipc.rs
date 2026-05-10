//! Serializable shapes carried between the Rust host and the React UI.
//!
//! Kept in one place so the React-side TypeScript types can mirror them
//! without spelunking through other modules.

use cannet_core::{Direction, CanFrame, CanFramePayload};

/// One trace-row's worth of data, ready for the trace view.
#[derive(serde::Serialize, Clone)]
pub struct CanFrameRecord {
    /// Source timestamp converted to seconds. f64 is what BLF round-trips
    /// natively, and JSON numbers can't safely carry u64 nanoseconds.
    pub timestamp_seconds: f64,
    pub channel: u8,
    pub id: u32,
    pub extended: bool,
    pub direction: &'static str,
    pub kind: CanFrameKind,
    pub data: Vec<u8>,
    pub decoded: Option<DecodedRecord>,
}

#[derive(serde::Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CanFrameKind {
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

impl CanFrameRecord {
    #[allow(clippy::cast_precision_loss)]
    pub fn from_frame(frame: &CanFrame, decoded: Option<DecodedRecord>) -> Self {
        let timestamp_seconds = (frame.timestamp_ns as f64) / 1e9;
        let direction = match frame.direction {
            Direction::Rx => "Rx",
            Direction::Tx => "Tx",
        };
        let (kind, data) = match &frame.payload {
            CanFramePayload::Classic(d) => (CanFrameKind::Classic, d.clone()),
            CanFramePayload::Fd { data, flags } => (
                CanFrameKind::Fd {
                    brs: flags.bitrate_switch,
                    esi: flags.error_state_indicator,
                },
                data.clone(),
            ),
            CanFramePayload::Remote { dlc } => (CanFrameKind::Remote { dlc: *dlc }, Vec::new()),
            CanFramePayload::Error => (CanFrameKind::Error, Vec::new()),
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
}

/// Returned from `attach_dbc` once the file is parsed and stored.
#[derive(serde::Serialize, Clone)]
pub struct DbcInfo {
    pub dbc_path: String,
    pub message_count: usize,
}

/// Frontend → backend payload for `decode_frames`. Carries the minimum
/// needed to identify a message and decode its bytes; we deliberately
/// reconstruct nothing about the original payload kind because cannet-dbc
/// only looks at id + bytes.
#[derive(serde::Deserialize)]
pub struct DecodeRequest {
    /// Channel is currently informational on the wire — we keep it so
    /// future per-channel DBC scoping can use it without a schema change.
    #[allow(dead_code)]
    pub channel: u8,
    pub id: u32,
    pub extended: bool,
    pub data: Vec<u8>,
}

/// Emitted alongside frame batches as the log progresses.
#[derive(serde::Serialize, Clone)]
pub struct CanFrameBatch {
    pub frames: Vec<CanFrameRecord>,
}

/// Emitted when the log finishes (cleanly or with an error).
#[derive(serde::Serialize, Clone)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LogFinished {
    Ok { total: u64 },
    Error { message: String },
}

/// One CAN interface as exposed by a remote `cannet-server`. Mirrors
/// `cannet_client::Interface`, kept here so the React side has a stable
/// snake_case payload to deserialize against.
#[derive(serde::Serialize, Clone)]
pub struct InterfaceRecord {
    pub id: String,
    pub display_name: String,
    pub fd_capable: bool,
}

impl From<cannet_client::Interface> for InterfaceRecord {
    fn from(value: cannet_client::Interface) -> Self {
        Self {
            id: value.id,
            display_name: value.display_name,
            fd_capable: value.fd_capable,
        }
    }
}

/// One subscription as committed by `connect_remote_server`. Echoes the
/// `interface_id → channel` mapping the host chose so the frontend can
/// label trace rows by interface.
#[derive(serde::Serialize, Clone)]
pub struct SubscriptionRecord {
    pub interface_id: String,
    pub channel: u8,
}

/// Returned from `connect_remote_server` once the gRPC session is up
/// and the pump thread has been spawned.
#[derive(serde::Serialize, Clone)]
pub struct RemoteSessionResult {
    pub address: String,
    pub interfaces: Vec<InterfaceRecord>,
    pub subscriptions: Vec<SubscriptionRecord>,
}
