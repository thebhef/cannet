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
    /// Logical bus id this frame was routed onto, or `None` if no
    /// binding/mapping assigned one (Phase 6). `None` for an unassigned
    /// frame, which a filter `{bus: ...}` predicate never matches.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bus_id: Option<String>,
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
    /// `VAL_` label matching this decoded value, if any. The trace
    /// view's decoded-signal grid renders `<value> "<label>"` when
    /// this is present; otherwise just `<value>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
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
            bus_id: frame.bus_id.clone(),
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
    /// Logical bus ids this DBC is scoped to (Phase 6). An empty vec
    /// is the conventional "all buses" default.
    #[serde(default)]
    pub buses: Vec<String>,
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

/// One frame the GUI's transmit panel wants sent. `camelCase` on the
/// wire (Tauri only renames *top-level* command args, not nested
/// fields). `data` is the raw payload (empty for `remote` / `error`).
/// `brs` / `esi` are only meaningful for `fd` kinds; `dlc` only for
/// `remote`.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransmitRequest {
    pub channel: u8,
    pub id: u32,
    pub extended: bool,
    pub kind: TransmitKind,
    #[serde(default)]
    pub data: Vec<u8>,
    #[serde(default)]
    pub brs: bool,
    #[serde(default)]
    pub esi: bool,
    #[serde(default)]
    pub dlc: u8,
}

/// Frame kind the transmit panel picks. Lower-case on the wire so the
/// frontend's discriminated union matches.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransmitKind {
    Classic,
    Fd,
    Remote,
    Error,
}

/// Returned from `transmit_frame`. The frame *always* lands in the
/// trace as a Tx-direction row at `tx_confirm_index` (the tx-confirm a
/// real analyzer shows for its own transmits). `wire_status` reports
/// what happened with the wire forward:
///
/// - `not_connected` — no remote session is open; only the local
///   tx-confirm fired.
/// - `sent` — handed off to the gRPC session; the server's
///   acknowledgement (e.g. `Error::TX_REJECTED`) surfaces inline on
///   the next frame the receive pump observes.
/// - `failed { message }` — the session was open but the transmit
///   could not be enqueued (session closed mid-call, or the channel
///   has no mapped interface).
#[derive(serde::Serialize, Clone, Debug)]
pub struct TransmitResult {
    pub tx_confirm_index: u64,
    pub wire_status: TransmitWireStatus,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TransmitWireStatus {
    NotConnected,
    Sent { interface_id: String },
    Failed { message: String },
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

/// One `(message, signal)` pair the attached DBC defines, returned by
/// `list_signals` to populate a plot panel's signal picker.
#[derive(serde::Serialize, Clone)]
pub struct SignalDescriptorRecord {
    pub message_id: u32,
    pub extended: bool,
    pub message_name: String,
    pub signal_name: String,
    pub unit: String,
    /// True if the DBC defines a `VAL_` table for this signal. Lets
    /// the plot panel pick stepped/symbolic rendering and the
    /// transmit panel offer a dropdown without a separate
    /// `value_table` round-trip.
    pub has_value_table: bool,
}

impl From<cannet_dbc::SignalDescriptor> for SignalDescriptorRecord {
    fn from(d: cannet_dbc::SignalDescriptor) -> Self {
        Self {
            message_id: d.message_id,
            extended: d.extended,
            message_name: d.message_name,
            signal_name: d.signal_name,
            unit: d.unit,
            has_value_table: d.has_value_table,
        }
    }
}

/// One row of a signal's `VAL_` table — mirrors
/// [`cannet_dbc::ValueTableEntry`] for the wire.
#[derive(serde::Serialize, Clone, Debug)]
pub struct ValueTableEntryRecord {
    pub raw: i64,
    pub label: String,
}

/// One `(message, signal)` a plot panel wants sampled — the query side
/// of [`sample_signals`](crate::sample_signals). `camelCase` on the wire
/// (Tauri only renames *top-level* command args, not nested fields).
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SignalQuery {
    pub message_id: u32,
    pub extended: bool,
    pub signal_name: String,
}

/// One signal's freshly-decoded points, parallel arrays (`t[i]` is the
/// source time in seconds of `v[i]`), shaped for a uPlot `[xs, ys]`
/// column.
#[derive(serde::Serialize, Clone, Debug)]
pub struct SampledPoints {
    pub t: Vec<f64>,
    pub v: Vec<f64>,
}

/// Return of [`sample_signals`](crate::sample_signals): one
/// [`SampledPoints`] per requested signal (same order), plus the
/// window's anchor timestamps so a live plot can place its x-origin and
/// "follow live" edge without a second round-trip. `from_seconds` is the
/// timestamp of the frame at the requested `from_index` — the x-axis
/// origin when `from_index` is the trace window's start; `last_seconds`
/// is the last frame before `window_end`. Both are `null` when the
/// window is empty.
#[derive(serde::Serialize, Clone, Debug)]
pub struct SignalsSample {
    pub from_seconds: Option<f64>,
    pub last_seconds: Option<f64>,
    pub series: Vec<SampledPoints>,
    /// Wall-clock time the host spent in the lock-held slice
    /// (`slice_matching_many`), milliseconds — how much of the per-call
    /// cost is store-lock contention with the pump.
    pub slice_ms: f64,
    /// Wall-clock time the host spent decoding + decimating off the
    /// store lock, milliseconds.
    pub decode_ms: f64,
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
