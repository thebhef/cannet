//! Serializable shapes carried between the Rust host and the React UI.
//!
//! Kept in one place so the React-side TypeScript types can mirror them
//! without spelunking through other modules.

use cannet_core::{Direction, CanFramePayload};

use crate::trace_store::RawTraceFrame;

/// One trace-row's worth of data ready for the trace view, returned by
/// `fetch_trace_range`. Carries its absolute index in the trace store
/// so the frontend cache can key on it directly.
#[derive(serde::Serialize, Clone)]
pub struct TraceFrameRecord {
    /// 0-based absolute index in the trace store.
    pub index: u64,
    /// Source timestamp converted to seconds. JSON numbers can't safely
    /// carry u64 nanoseconds, so the host divides on the way out.
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

impl TraceFrameRecord {
    #[allow(clippy::cast_precision_loss)]
    pub fn from_raw(
        index: u64,
        frame: &RawTraceFrame,
        decoded: Option<DecodedRecord>,
    ) -> Self {
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
            index,
            timestamp_seconds,
            channel: frame.channel,
            id: frame.id,
            extended: frame.extended,
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

/// Periodic IPC event carrying the trace store's current size and rate.
/// Fired at ~10 Hz when there's been activity since the last tick.
#[derive(serde::Serialize, Clone)]
pub struct TraceGrew {
    /// Total number of frames in the store right now.
    pub count: u64,
    /// Estimated current frame rate (frames per second over the last
    /// second of appends).
    pub frames_per_second: f64,
    /// The last frames in the store (up to a fixed cap), already decoded
    /// against the currently-attached DBC. The auto-scrolling trace view
    /// paints its live tail straight from this instead of round-tripping
    /// to `fetch_trace_range` for rows the chunk cache hasn't caught up
    /// with — without it, every tick repainted the visible window as a
    /// band of placeholders until the follow-up fetch landed.
    pub tail: Vec<TraceFrameRecord>,
}

/// One row of the per-message-ID view: the id's latest frame plus its
/// current message rate (frames/second).
#[derive(serde::Serialize, Clone)]
pub struct ByIdSnapshot {
    pub frame: TraceFrameRecord,
    pub rate: f64,
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
/// `snake_case` payload to deserialize against.
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
