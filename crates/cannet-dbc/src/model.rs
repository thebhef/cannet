//! The in-memory DBC model: the indexed [`Database`] and the per-message
//! / per-signal entries the parser builds and the decode / encode / view
//! layers read. Also the small shared helpers that map between
//! `can-dbc`'s [`MessageId`] and [`cannet_core::CanId`].

use std::collections::HashMap;

use can_dbc::{MessageId, Signal, SignalExtendedValueType};

use crate::calc;

/// A parsed DBC database, indexed for fast frame lookup.
pub struct Database {
    pub(crate) messages: HashMap<MessageKey, MessageEntry>,
    /// Non-fatal problems found while interpreting cannet-specific
    /// attributes (`CannetCounter` / `CannetCrc`) — a malformed value
    /// or a duplicate designation. The file still loads; callers
    /// surface these on their log.
    pub(crate) warnings: Vec<String>,
}

/// Lookup key matching a frame to a DBC message: raw id + addressing mode.
/// `can-dbc`'s `MessageId` already encodes both, so we reuse it directly.
pub(crate) type MessageKey = MessageId;

pub(crate) struct MessageEntry {
    pub(crate) name: String,
    /// Expected payload length in bytes from the DBC `BO_` declaration.
    pub(crate) expected_len: usize,
    /// True if the DBC marks this message as CAN-FD — either via the
    /// `VFrameFormat` attribute being one of the FD codes
    /// (14 = Standard CAN-FD, 15 = Extended CAN-FD), or as a fallback
    /// when `expected_len` exceeds the classic max of 8 bytes.
    pub(crate) is_fd: bool,
    /// CAN-FD BRS (Bit Rate Switch) setting from the DBC's
    /// `GenMsgCANFDBRS` per-message attribute. `1` = on, `0` = off;
    /// when the attribute is absent on an FD message, default to
    /// `true` (the typical real-world setting). Always `false` for
    /// classic messages.
    pub(crate) brs: bool,
    /// The DBC's `GenMsgCycleTime` per-message attribute, in
    /// milliseconds — the message's intended cyclic send period.
    /// `Some(n)` when the attribute is present (the value verbatim,
    /// including `0`); `None` when absent. The transmit panel uses it
    /// to pre-fill the cycle period when a message is added from the
    /// DBC.
    pub(crate) gen_msg_cycle_time_ms: Option<u32>,
    /// `CM_ BO_ <id> "..."` free-text comment. Empty when absent.
    /// Captured during parse so the DBC panel's fuzzy search can
    /// match it without re-walking the AST.
    pub(crate) comment: String,
    /// The DBC's `GenMsgSendType` attribute resolved to its label —
    /// for ENUM-typed definitions the integer value is mapped through
    /// the `BA_DEF_` label list; STRING values pass through verbatim.
    /// `None` when the attribute is absent.
    pub(crate) gen_msg_send_type: Option<String>,
    /// The `BO_` line's transmitting node, or `None` for the
    /// `Vector__XXX` "no sender" placeholder. The RBS panel groups
    /// messages per ECU by this.
    pub(crate) transmitter: Option<String>,
    /// `BA_ "<name>" BO_ <id> <value>` attribute values targeted at
    /// this message, sorted by attribute name. Values are stringified
    /// up front because the panel both displays them and searches
    /// them; sorting up front keeps the tree's per-node attribute
    /// list stable across runs.
    pub(crate) attributes: Vec<DbcAttribute>,
    /// Calculated-field designation declared in the DBC via the
    /// cannet `CannetCounter` / `CannetCrc` signal attributes
    /// (ADR 0027). Empty when none are declared. This is the
    /// *default* layer — a `.cannet_rbs` file or the GUI may override
    /// it wholesale per message.
    pub(crate) calc_fields: calc::CalculatedFieldsConfig,
    /// Index into `signals` of the `Multiplexor` signal, if the message
    /// is multiplexed. Precomputed at parse so per-frame selector
    /// extraction ([`Database::decode_mux_selector`], run on the trace
    /// append path) doesn't re-scan the signal list.
    pub(crate) multiplexor: Option<usize>,
    pub(crate) signals: Vec<SignalEntry>,
}

pub(crate) struct SignalEntry {
    pub(crate) signal: Signal,
    /// Mirrors `SIG_VALTYPE_`. Defaults to integer when no entry is
    /// declared; `IEEEfloat32Bit` / `IEEEdouble64bit` switch the bit
    /// pattern from "scaled integer" to a real IEEE float.
    pub(crate) extended_type: SignalExtendedValueType,
    /// `VAL_` table for this signal: pairs of `(raw_value, label)`,
    /// sorted by raw value. Empty if the DBC defines no value table.
    /// Looked up by [`decode_signal`] to populate
    /// [`DecodedSignal::label`].
    pub(crate) value_table: Vec<ValueTableEntry>,
    /// `CM_ SG_ <id> <name> "..."` comment. Empty when absent.
    pub(crate) comment: String,
    /// `BA_ "<name>" SG_ <id> <name> <value>` attribute values
    /// targeted at this signal, sorted by attribute name.
    pub(crate) attributes: Vec<DbcAttribute>,
    /// The DBC's `GenSigStartValue` attribute, verbatim — the
    /// signal's initial value in *raw* (pre-scale) units, per the
    /// attribute's conventional definition. `None` when absent.
    pub(crate) start_value_raw: Option<f64>,
}

/// Whether a `VAL_` table makes its signal an *enum* — the central
/// "is an enum" vs "has labels" distinction: a table needs **at least
/// two members** to be an enum. A single-member table is typically an
/// SNA / "not available" sentinel on an otherwise numeric signal; its
/// label still applies on an exact raw match, but the signal must be
/// rendered numerically (numeric plot axis, unit kept), not as an
/// enum. Every consumer deciding "render as enum?" goes through this
/// predicate; consumers that only need the labels use the table
/// itself (e.g. [`Database::value_table_for_signal`], which returns
/// single-member tables unchanged).
#[must_use]
pub fn is_enum(value_table: &[ValueTableEntry]) -> bool {
    value_table.len() >= 2
}

/// One row of a signal's `VAL_` value table: a raw value and its
/// symbolic label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValueTableEntry {
    /// Raw value (the same domain as
    /// [`DecodedSignal::raw_unsigned`] / [`DecodedSignal::raw_signed`]).
    /// Stored as `i64` to match `can-dbc`'s API; signed signals use
    /// negative entries, unsigned signals re-cast at the call site.
    pub raw: i64,
    /// Symbolic name for `raw`. Quoted in the DBC; stripped on parse.
    pub label: String,
}

/// One `BA_ "<name>" … <value>` attribute pair, stringified for
/// both display and fuzzy search in the DBC panel.
///
/// Numeric attributes (`Uint` / `Int` / `Double` in the DBC AST)
/// are formatted in their natural source-text shape: integers
/// without trailing zeroes, floats using Rust's default `f64`
/// formatter. Round-tripping the textual form is not a goal —
/// callers that need the original numeric value should read the
/// underlying DBC AST.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbcAttribute {
    pub name: String,
    pub value: String,
}

impl Database {
    /// Number of messages defined in this database.
    pub fn message_count(&self) -> usize {
        self.messages.len()
    }

    /// Whether any message in this database is multiplexed. Lets the
    /// host skip installing a per-frame selector extractor entirely
    /// when no loaded DBC needs one.
    #[must_use]
    pub fn has_multiplexor(&self) -> bool {
        self.messages.values().any(|e| e.multiplexor.is_some())
    }
}

/// Split a `can-dbc` [`MessageId`] back into the `(raw id, extended?)`
/// pair the rest of the codebase uses. The extended variant carries the
/// 31-bit-flagged form on the wire in some DBCs; mask it to the 29-bit
/// id so it round-trips with [`cannet_core::CanId::extended`].
pub(crate) fn message_id_parts(id: MessageId) -> (u32, bool) {
    match id {
        MessageId::Standard(s) => (u32::from(s), false),
        MessageId::Extended(e) => (e & 0x1FFF_FFFF, true),
    }
}

pub(crate) fn canid_to_message_id(id: cannet_core::CanId) -> Option<MessageId> {
    let raw = id.raw();
    if id.is_extended() {
        Some(MessageId::Extended(raw))
    } else {
        Some(MessageId::Standard(u16::try_from(raw).ok()?))
    }
}
