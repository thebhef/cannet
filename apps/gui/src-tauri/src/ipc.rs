//! Serializable shapes carried between the Rust host and the React UI.
//!
//! Kept in one place so the React-side TypeScript types can mirror them
//! without spelunking through other modules.

use cannet_core::{CanFramePayload, Direction};

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
    /// binding/mapping assigned one. `None` for an unassigned
    /// frame, which a filter `{bus: ...}` predicate never matches.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bus_id: Option<String>,
    /// Ingest-time verification finding for this frame (`"crc"` /
    /// `"counter"` / `"truncated"`), if any — the trace view renders
    /// flagged rows red (ADR 0027). Absent for clean frames.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub violation: Option<&'static str>,
}

/// A page of a filtered chronological trace view: the total match
/// The frozen **row-addressed accessor response** of the windowed-source
/// contract (ADR 0025): a page of rows addressed by row index, carrying
/// the extent (`count`)
/// that drives the scrollbar and the absolute `start` of `rows[0]` so the
/// view positions the page without re-deriving where it goes. The three
/// row views — raw chronological, filtered chronological, and by-ID —
/// all return this; they differ only in *which* rows, not in how a page
/// is shaped. The signature is store-independent by design: the in-RAM
/// `Vec` and the disk-spilled store return the same `RowPage`, so the
/// disk-spilled store is a second implementation behind it, not a
/// redesign.
#[derive(serde::Serialize, Clone)]
pub struct RowPage<T> {
    /// Extent: total rows for the request (e.g. total matches in a
    /// filtered scan's `[scan_start, scan_end)` range). Drives the
    /// scrollbar; advances on capture growth without re-paging history.
    pub count: u64,
    /// Absolute index of `rows[0]` (0 when `rows` is empty).
    pub start: u64,
    /// The page itself — `rows[count..]` is never materialised.
    pub rows: Vec<T>,
}

/// The filtered chronological trace's page — the first instantiation of
/// the [`RowPage`] contract. Returned by `fetch_filtered_trace`; the
/// frontend pages this, holding only the visible slice and never the
/// whole filtered set.
pub type FilteredTracePage = RowPage<TraceFrameRecord>;

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

#[derive(serde::Serialize, Clone, Debug)]
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
    pub fn from_raw(index: u64, frame: &RawTraceFrame, decoded: Option<DecodedRecord>) -> Self {
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
            violation: None,
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
    /// Logical bus ids this DBC is scoped to. An empty vec
    /// is the conventional "all buses" default.
    #[serde(default)]
    pub buses: Vec<String>,
}

/// One bus's current frame rate, as carried by [`TraceGrew`].
#[derive(serde::Serialize, Clone)]
pub struct BusFps {
    /// Logical bus id, or `None` for the unassigned bucket.
    pub bus_id: Option<String>,
    /// Estimated frames per second on this bus over the last second.
    pub frames_per_second: f64,
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
    /// Per-bus breakdown of the current frame rate — what localises a
    /// slowdown to a specific bus on a multi-bus stream.
    pub frames_per_second_by_bus: Vec<BusFps>,
    /// Cumulative frames the session-start guard has dropped (stale
    /// pipeline frames). Climbs only on a clear/reconnect race.
    pub frames_dropped_before_session: u64,
    /// Session-start timestamp in seconds (Unix epoch, fractional). The
    /// trace UI displays everything relative to this — a single, stable
    /// origin for the whole live capture / replay. Live capture sets it
    /// to wall-clock now on Clear / Connect; BLF replay sets it to the
    /// first frame's timestamp. Zero before any session has been
    /// configured.
    pub session_start_seconds: f64,
    /// Wall-clock span of the buffered frames in seconds (newest −
    /// oldest timestamp). Shown in the status line as "N s buffered";
    /// zero when fewer than two frames are stored.
    pub buffer_seconds: f64,
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
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransmitRequest {
    /// Destination bus id (one of the project's logical buses). The
    /// host resolves this to the matching session's wire channel via
    /// `RemoteSession.channel_to_bus`. Replaces the old per-frame
    /// `channel: u8` field; channels are a host-side detail now.
    pub bus_id: String,
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
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransmitKind {
    Classic,
    Fd,
    Remote,
    Error,
}

/// Calculated-fields configuration as it travels and persists — on a
/// TX message (`TransmitFrame::calc`), in a `.cannet_rbs` message
/// entry, and over IPC. The JSON shape is ADR 0028's: `counter` /
/// `crc` objects with `signal`, `increment` / `rollover`,
/// `algorithm` XOR raw Rocksoft fields, `range_bits: [start, length]`
/// and a hex-string `prefix`. Field names stay `snake_case` (they're
/// part of the human-edited file format).
///
/// This is the *spec* (what the user wrote); resolution against a DBC
/// produces a `cannet_dbc::ResolvedCalculatedFields` via
/// [`Self::to_config`] + `Database::resolve_calculated_fields`.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct CalcFieldsSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counter: Option<CounterSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crc: Option<CrcSpec>,
}

impl CalcFieldsSpec {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.counter.is_none() && self.crc.is_none()
    }

    /// Convert to the `cannet-dbc` config type, validating the
    /// algorithm form (named XOR raw) and the hex prefix.
    pub fn to_config(&self) -> Result<cannet_dbc::CalculatedFieldsConfig, String> {
        let counter = self.counter.as_ref().map(|c| cannet_dbc::CounterConfig {
            signal: c.signal.clone(),
            increment: c.increment,
            rollover: c.rollover,
        });
        let crc = self.crc.as_ref().map(CrcSpec::to_config).transpose()?;
        Ok(cannet_dbc::CalculatedFieldsConfig { counter, crc })
    }

    /// The spec form of a parsed config — how a DBC-declared default
    /// is shown to the GUI in the same shape as overrides.
    #[must_use]
    pub fn from_config(config: &cannet_dbc::CalculatedFieldsConfig) -> Self {
        let counter = config.counter.as_ref().map(|c| CounterSpec {
            signal: c.signal.clone(),
            increment: c.increment,
            rollover: c.rollover,
        });
        let crc = config.crc.as_ref().map(|c| {
            let (algorithm, raw) = match &c.algorithm {
                cannet_dbc::CrcAlgorithm::Named(name) => (Some(name.clone()), None),
                cannet_dbc::CrcAlgorithm::Raw(p) => (None, Some(*p)),
            };
            CrcSpec {
                signal: c.signal.clone(),
                algorithm,
                width: raw.map(|p| p.width),
                poly: raw.map(|p| p.poly),
                init: raw.map(|p| p.init),
                refin: raw.map(|p| p.refin),
                refout: raw.map(|p| p.refout),
                xorout: raw.map(|p| p.xorout),
                range_bits: c.range_bits,
                prefix: hex_string(&c.prefix),
            }
        });
        Self { counter, crc }
    }
}

/// Counter spec — ADR 0028's `"counter"` object.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CounterSpec {
    pub signal: String,
    #[serde(default = "default_increment")]
    pub increment: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollover: Option<u64>,
}

fn default_increment() -> u64 {
    1
}

/// CRC spec — ADR 0028's `"crc"` object. Exactly one of `algorithm`
/// (catalogue name) or the raw Rocksoft fields (`width` + `poly`
/// required; `init` / `xorout` default 0, `refin` / `refout` default
/// false) — enforced by [`Self::to_config`], not the deserializer, so
/// a bad file yields a per-message warning instead of a load failure.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CrcSpec {
    pub signal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex_u64")]
    pub poly: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex_u64")]
    pub init: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refin: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refout: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_hex_u64")]
    pub xorout: Option<u64>,
    /// `[start, length]` in bits — byte-aligned (validated at
    /// resolution).
    pub range_bits: (u32, u32),
    /// Hex bytes prepended to the ranged data (E2E Data ID). Empty =
    /// none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prefix: String,
}

impl CrcSpec {
    fn to_config(&self) -> Result<cannet_dbc::CrcConfig, String> {
        let raw_given = self.width.is_some()
            || self.poly.is_some()
            || self.init.is_some()
            || self.refin.is_some()
            || self.refout.is_some()
            || self.xorout.is_some();
        let algorithm = match (&self.algorithm, raw_given) {
            (Some(_), true) => {
                return Err("algorithm and raw CRC parameters are mutually exclusive".into());
            }
            (Some(name), false) => cannet_dbc::CrcAlgorithm::Named(name.clone()),
            (None, _) => cannet_dbc::CrcAlgorithm::Raw(cannet_dbc::RawCrcParams {
                width: self.width.ok_or("raw CRC parameters require width")?,
                poly: self.poly.ok_or("raw CRC parameters require poly")?,
                init: self.init.unwrap_or(0),
                refin: self.refin.unwrap_or(false),
                refout: self.refout.unwrap_or(false),
                xorout: self.xorout.unwrap_or(0),
            }),
        };
        let prefix = if self.prefix.is_empty() {
            Vec::new()
        } else {
            parse_hex_prefix(&self.prefix)?
        };
        Ok(cannet_dbc::CrcConfig {
            signal: self.signal.clone(),
            algorithm,
            range_bits: self.range_bits,
            prefix,
        })
    }
}

fn hex_string(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02X}");
        s
    })
}

fn parse_hex_prefix(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) {
        return Err(format!("invalid hex prefix \"{text}\" (need full bytes)"));
    }
    (0..text.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&text[i..i + 2], 16)
                .map_err(|_| format!("invalid hex prefix \"{text}\""))
        })
        .collect()
}

/// (De)serialize `Option<u64>` accepting either a JSON number or a
/// `"0x…"` / decimal string, writing the hex-string form — CRC
/// polynomials read naturally in hex in a hand-edited file.
mod opt_hex_u64 {
    // serde `with` modules must take the field type by reference.
    #[allow(clippy::ref_option)]
    pub fn serialize<S: serde::Serializer>(value: &Option<u64>, ser: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(v) => ser.serialize_str(&format!("{v:#X}")),
            None => ser.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(de: D) -> Result<Option<u64>, D::Error> {
        use serde::Deserialize;

        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum NumOrStr {
            Num(u64),
            Str(String),
        }
        let Some(v) = Option::<NumOrStr>::deserialize(de)? else {
            return Ok(None);
        };
        match v {
            NumOrStr::Num(n) => Ok(Some(n)),
            NumOrStr::Str(s) => {
                let t = s.trim();
                let parsed =
                    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
                        u64::from_str_radix(hex, 16)
                    } else {
                        t.parse()
                    };
                parsed
                    .map(Some)
                    .map_err(|_| serde::de::Error::custom(format!("invalid number \"{s}\"")))
            }
        }
    }
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

/// One row of the per-message-ID view: the id's latest frame, its
/// current message rate (frames/second), and the total number of frames
/// seen for the id over the session.
#[derive(serde::Serialize, Clone)]
pub struct ByIdSnapshot {
    pub frame: TraceFrameRecord,
    pub rate: f64,
    pub count: u64,
}

/// Emitted when the log finishes (cleanly or with an error).
#[derive(serde::Serialize, Clone)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LogFinished {
    Ok { total: u64 },
    Error { message: String },
}

/// One `(bus, message, signal)` triple the loaded DBCs define,
/// returned by `list_signals` to populate a plot panel's signal
/// picker. The same signal name on two different buses is two
/// separate records, so a plot picker can bind one signal to one
/// `(bus_id, message_id)` pair unambiguously. Snake-case on the
/// wire — the response side is what the frontend's
/// `types.ts::SignalDescriptorRecord` mirrors.
#[derive(serde::Serialize, Clone)]
pub struct SignalDescriptorRecord {
    /// Logical bus this descriptor applies to. `None` only when no
    /// project bus is configured *and* the DBC is unscoped — a
    /// degenerate state the plot picker treats as "any frame".
    pub bus_id: Option<String>,
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

/// One row of a signal's `VAL_` table — mirrors
/// [`cannet_dbc::ValueTableEntry`] for the wire.
#[derive(serde::Serialize, Clone, Debug)]
pub struct ValueTableEntryRecord {
    pub raw: i64,
    pub label: String,
}

/// The full content of one loaded DBC, shaped for the DBC
/// discovery panel (tree-with-fuzzy-search). One entry per loaded DBC
/// file; each carries the path so the panel can group by file and a
/// flat `messages` list whose order is the host's
/// `(extended, message_id)` sort.
///
/// Mirrored on the frontend by `types.ts::DbcContentRecord`. Sent
/// camel-cased so the JS side reads it as
/// `{ dbcPath, messages: [...] }` without a wire-name shim.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DbcContentRecord {
    /// Filesystem path of the DBC the host loaded this content from.
    /// Stable across reloads of the same file — the panel can use it
    /// as the React key for the file's root tree node.
    pub dbc_path: String,
    pub messages: Vec<DbcMessageContentRecord>,
}

/// One message row in a [`DbcContentRecord`] — fuzzy-search-shaped:
/// every text field is owned + inlined so the JS-side matcher has
/// nothing left to fetch. The bit-layout / FD / mux / encoder
/// metadata is also present so the discovery panel can show the
/// full per-message detail without a second `describe_message`
/// round-trip.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)] // a serialized search record, not a state machine
pub struct DbcMessageContentRecord {
    pub message_id: u32,
    pub extended: bool,
    pub name: String,
    /// `CM_ BO_` comment. Empty when absent — empty (not absent) so the
    /// search has nothing optional to special-case.
    pub comment: String,
    /// Declared `BO_` payload length in bytes.
    pub expected_len: usize,
    /// `true` for CAN-FD messages (`VFrameFormat` 14/15, or
    /// `expectedLen > 8` fallback).
    pub is_fd: bool,
    /// CAN-FD BRS (`GenMsgCANFDBRS`). False on classic frames.
    pub brs: bool,
    /// `true` if any signal uses nested / extended multiplexing.
    pub uses_extended_mux: bool,
    /// `BA_ "<name>" BO_ <id> <value>` attribute values, sorted by name.
    pub attributes: Vec<DbcAttributeRecord>,
    pub signals: Vec<DbcSignalContentRecord>,
}

/// One signal row in a [`DbcMessageContentRecord`]. Stays in `SG_`
/// declared order — preserves the DBC author's bit-layout intent.
/// The bit-layout / scale / range / mux / float-kind fields mirror
/// the rich-encoder shape so the discovery panel can show the same
/// detail the transmit panel uses without a separate round-trip.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DbcSignalContentRecord {
    pub name: String,
    pub unit: String,
    pub comment: String,
    /// First bit of the signal in the payload.
    pub start_bit: u32,
    /// Width in bits, 1..=64.
    pub length: u32,
    /// `little` (Intel / `@1`) or `big` (Motorola / `@0`).
    pub byte_order: &'static str,
    /// `+` / `-` flag on the `SG_` line — `true` for signed.
    pub signed: bool,
    /// `factor` / `offset` describe `physical = raw * factor + offset`.
    pub factor: f64,
    pub offset: f64,
    /// DBC-declared physical range (`SG_ ... [min|max]`). When
    /// `min == max` the DBC didn't set a useful range.
    pub min: f64,
    pub max: f64,
    /// Multiplexor / multiplexed-arm marker.
    pub mux: SignalMuxRecord,
    /// `integer` / `float32` / `float64` (from `SIG_VALTYPE_`).
    pub float_kind: &'static str,
    pub attributes: Vec<DbcAttributeRecord>,
    pub value_table: Vec<ValueTableEntryRecord>,
}

/// One `BA_ "<name>" … <value>` attribute pair as it travels to the
/// frontend — both display string and fuzzy-search target.
#[derive(serde::Serialize, Clone, Debug)]
pub struct DbcAttributeRecord {
    pub name: String,
    pub value: String,
}

/// One signal edit the transmit panel wants pushed through the encoder:
/// the DBC signal name and the physical value the user typed. The host
/// runs every entry through [`cannet_dbc::Database::encode_frame`] in
/// order; partial encode means the call effectively writes one signal's
/// bits at a time, leaving everything else intact.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncodeFrameSignal {
    pub name: String,
    pub physical: f64,
}

/// Response from `encode_frame`. `bytes` is the partial-encoded
/// payload — `dataHex` for the frame goes through `bytes.to_hex()` on
/// the frontend. `skipped` lists each signal the encoder couldn't
/// place (unknown name, signal bits past the end of `base`, …) so the
/// panel can surface a hint; in normal use the panel only passes
/// signals it just listed via `list_signals`, so this stays empty.
#[derive(serde::Serialize, Clone, Debug)]
pub struct EncodeFrameResponse {
    pub bytes: Vec<u8>,
    pub skipped: Vec<EncodeFrameSkipped>,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncodeFrameSkipped {
    pub name: String,
    /// Stable identifier the frontend can match on:
    /// `signal_not_found` / `base_too_short` / `size_out_of_range`.
    pub reason: &'static str,
}

/// Rich descriptor for one DBC message — what the transmit panel's
/// signals table needs to render rows. Returned by
/// `describe_message`. `None` (Tauri-side `null`) when no DBC matches
/// the requested `(message_id, extended)` pair.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MessageDescriptorRecord {
    pub name: String,
    /// `BO_` declared length in bytes.
    pub expected_len: usize,
    /// `true` when the DBC marks this as a CAN-FD message
    /// (`VFrameFormat` = 14/15, or `expected_len > 8` as fallback).
    pub is_fd: bool,
    /// CAN-FD BRS from the `GenMsgCANFDBRS` attribute (default `true`
    /// on FD messages with no attribute). Always `false` on classic.
    pub brs: bool,
    /// The DBC's `GenMsgCycleTime` attribute in milliseconds, or `None`
    /// when absent. The transmit panel pre-fills a newly-added
    /// message's cycle period from this.
    pub gen_msg_cycle_time_ms: Option<u32>,
    /// The DBC's `GenMsgSendType` attribute resolved to its label
    /// (ENUM values mapped through the `BA_DEF_` list), or `None`.
    pub gen_msg_send_type: Option<String>,
    /// `true` iff any signal uses nested / extended multiplexing
    /// (`m<N>M`). The transmit panel falls back to bytes-only editing
    /// in that case.
    pub uses_extended_mux: bool,
    /// The calculated-field designation the DBC itself declares for
    /// this message (`CannetCounter` / `CannetCrc` — ADR 0027), in
    /// the same spec shape overrides use. `None` when the DBC
    /// declares none. The panels render this as the default layer
    /// under any per-message override.
    pub calc_fields: Option<CalcFieldsSpec>,
    pub signals: Vec<SignalDescriptorRichRecord>,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SignalDescriptorRichRecord {
    pub name: String,
    pub unit: String,
    pub factor: f64,
    pub offset: f64,
    /// DBC `SG_` declared min. When `min == max` the DBC didn't set a
    /// useful range — the transmit panel derives a fallback from
    /// `factor / offset / size / signed`.
    pub min: f64,
    pub max: f64,
    pub size: u32,
    pub signed: bool,
    pub mux: SignalMuxRecord,
    /// `integer` / `float32` / `float64`. Float kinds have no integer
    /// range; the panel renders a free-form numeric input.
    pub float_kind: &'static str,
    pub has_value_table: bool,
    /// The DBC's `GenSigStartValue` (raw units, verbatim), or `None`.
    /// Consumers derive the physical default as
    /// `raw * factor + offset`.
    pub start_value_raw: Option<f64>,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SignalMuxRecord {
    Plain,
    Multiplexor,
    Multiplexed { selector: u64 },
    MultiplexorAndMultiplexed { selector: u64 },
}

/// Decoded signals for a hypothetical frame the transmit panel is
/// constructing — same shape the trace view uses for received frames,
/// but reached through `decode_frame` (no [`crate::trace_store`]
/// involvement). `None` when no DBC matches the id.
#[derive(serde::Serialize, Clone, Debug)]
pub struct DecodedFrameRecord {
    pub name: String,
    pub signals: Vec<SignalRecord>,
}

/// One `(bus, message, signal)` triple a plot panel wants sampled —
/// the query side of [`sample_signals`](crate::sample_signals).
/// `bus_id` scopes the slice to frames from that bus, so the same
/// arbitration id on two different buses (with different DBCs) gives
/// two independent series. `camelCase` on the wire (Tauri only
/// renames *top-level* command args, not nested fields).
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SignalQuery {
    /// Bus the signal is bound to. `None` is the legacy "any bus"
    /// path — kept so a plot from a project that pre-dates per-bus
    /// signal binding still samples.
    pub bus_id: Option<String>,
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

/// The frozen **time-addressed, lossy accessor response** of the
/// windowed-source contract (ADR 0025): the plot's decimated range.
/// Unlike a [`RowPage`] it is addressed by
/// time, not row index, and is lossy (one min/max bucket per pixel
/// column), so "page N of a signal" is meaningless — that single
/// distinction is why the contract has two accessors, not one. Like
/// `RowPage` the signature is store-independent: the disk-spilled store's
/// decimated tier reimplements it behind the same shape.
///
/// Return of [`sample_signals`](crate::sample_signals): one
/// [`SampledPoints`] per requested signal (same order), plus the
/// window's anchor timestamps so a live plot can place its x-origin and
/// "follow live" edge without a second round-trip. `from_seconds` is the
/// timestamp of the frame at the requested `from_index` — the x-axis
/// origin when `from_index` is the trace window's start; `last_seconds`
/// is the last frame before `window_end`. Both are `null` when the
/// window is empty.
#[derive(serde::Serialize, Clone, Debug)]
pub struct DecimatedRange {
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
