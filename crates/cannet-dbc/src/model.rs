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
    /// attributes (`CannetCounter` / `CannetCrc` / `CannetDisplay`) —
    /// a malformed value, a duplicate designation, or a display mode
    /// asked for on a signal that cannot take it. The file still
    /// loads; callers surface these on their log.
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
    /// The signal declares `CannetDisplay "radix=hex"` *and* is a raw
    /// field ([`is_raw_field`]) — so its value renders as a bit
    /// pattern instead of base 10 (ADR 0043). Both halves are settled
    /// at parse (an attribute on an ineligible signal warns and leaves
    /// this false), so every consumer only has to render what it is
    /// told. Absent attribute means base 10.
    pub(crate) display_hex: bool,
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

/// Whether the signal's physical value is *exactly* its raw integer: the
/// bits decode as an integer (no `SIG_VALTYPE_` float override for the
/// declared width) and the DBC applies no scaling (`factor == 1`,
/// `offset == 0`). A property of the `SG_` line alone, so both the
/// decode path ([`DecodedSignal::value_is_raw_integer`]) and the
/// catalog path ([`SignalDescriptor::value_is_raw_integer`]) read it
/// from here rather than each deriving it.
///
/// [`DecodedSignal::value_is_raw_integer`]: crate::DecodedSignal::value_is_raw_integer
/// [`SignalDescriptor::value_is_raw_integer`]: crate::SignalDescriptor::value_is_raw_integer
pub(crate) fn value_is_raw_integer(sig: &SignalEntry) -> bool {
    // Exact comparison is the point: a factor of exactly 1 and an offset
    // of exactly 0 are what "unscaled" means; anything else is scaled.
    #[allow(clippy::float_cmp)]
    let unscaled = sig.signal.factor == 1.0 && sig.signal.offset == 0.0;
    !decodes_as_float(sig) && unscaled
}

/// Whether the signal's bits decode as an IEEE float rather than an
/// integer. Mirrors the physical-value match in `decode_signal`: an
/// IEEE type whose declared width doesn't match its signal falls
/// through to the integer arms there, so it is an integer here.
fn decodes_as_float(sig: &SignalEntry) -> bool {
    match sig.extended_type {
        SignalExtendedValueType::IEEEfloat32Bit => sig.signal.size == 32,
        SignalExtendedValueType::IEEEdouble64bit => sig.signal.size == 64,
        SignalExtendedValueType::SignedOrUnsignedInteger => false,
    }
}

/// Most decimal places [`fixed_decimals`] will attribute to a factor.
/// A DBC factor is a decimal literal someone wrote down; past nine
/// places the value is a computed ratio (or a `1/2^n`-style binary
/// fraction), which is not the "this signal steps by 0.25" fact a
/// fixed-precision readout is after.
const MAX_FIXED_DECIMALS: u8 = 9;

/// How many decimal places a signal's physical values land on, or
/// `None` when the DBC implies no fixed precision.
///
/// A scaled integer takes exactly the decimals its `factor` needs to
/// write down: `0.25` steps land on two places, `0.1` on one, an
/// unscaled or integral factor on none. The offset is deliberately not
/// consulted — it shifts every value by the same amount, so it cannot
/// make the steps finer than the factor already does.
///
/// `None` means "this is not a fixed-precision quantity" and the value
/// should be rendered by whatever rule the renderer uses for floats.
/// Two cases reach it: a `SIG_VALTYPE_` float (its bits are an IEEE
/// value, and nothing declares what precision they land on) and a
/// factor with no finite decimal expansion within
/// [`MAX_FIXED_DECIMALS`] (`1/3`).
pub(crate) fn fixed_decimals(sig: &SignalEntry) -> Option<u8> {
    if decodes_as_float(sig) {
        return None;
    }
    let factor = sig.signal.factor.abs();
    // `is_normal` rules out zero, subnormals, infinities and NaN in one
    // go — none of which is a scale anything can be written against.
    if !factor.is_normal() {
        return None;
    }
    (0..=MAX_FIXED_DECIMALS).find(|d| {
        let scaled = factor * 10f64.powi(i32::from(*d));
        // Relative tolerance: the factor arrives as the nearest f64 to a
        // decimal literal, so `0.392157 * 1e6` is 392157.00000000006,
        // not 392157. A few thousand ulps of slack covers that while
        // staying far below the ~0.33 residue a non-terminating factor
        // leaves at every probe.
        (scaled - scaled.round()).abs() <= scaled * 1e-12
    })
}

/// Whether a signal is a *raw field*: an opaque bit pattern carrying no
/// engineering meaning — an id, a serial, a CRC, a flag word. Its value
/// is exactly the raw integer (unscaled, integer-typed), it declares no
/// unit, and no `VAL_` table makes it an enum, so nothing about it
/// claims to be a measurement or a symbolic state.
///
/// The arguments are the three facts every signal-shaped type in this
/// crate carries ([`crate::DecodedSignal`], [`crate::SignalDescriptor`]),
/// so every surface reaches the same verdict from the same code — a
/// signal cannot read one way on a trace row and another in the signal
/// view.
#[must_use]
pub fn is_raw_field(value_is_raw_integer: bool, unit: &str, is_enum: bool) -> bool {
    value_is_raw_integer && unit.is_empty() && !is_enum
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
