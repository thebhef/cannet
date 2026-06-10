//! DBC database loading and runtime signal decoding.
//!
//! Parsing is delegated to the `can-dbc` crate, which produces an AST.
//! This crate builds an indexed, decode-friendly view on top of that AST
//! and runs the bit-extraction maths against `cannet_core::CanFrame` payloads.

mod decode;

pub use decode::{decode_signal_bits, sign_extend};

use std::collections::HashMap;

use cannet_core::CanFrame;
use can_dbc::{
    AttributeValue, Dbc, MessageId, MultiplexIndicator, Signal, SignalExtendedValueType, ValueType,
};

/// A parsed DBC database, indexed for fast frame lookup.
pub struct Database {
    messages: HashMap<MessageKey, MessageEntry>,
}

/// Lookup key matching a frame to a DBC message: raw id + addressing mode.
/// `can-dbc`'s `MessageId` already encodes both, so we reuse it directly.
type MessageKey = MessageId;

struct MessageEntry {
    name: String,
    /// Expected payload length in bytes from the DBC `BO_` declaration.
    expected_len: usize,
    signals: Vec<SignalEntry>,
}

struct SignalEntry {
    signal: Signal,
    /// Mirrors `SIG_VALTYPE_`. Defaults to integer when no entry is
    /// declared; `IEEEfloat32Bit` / `IEEEdouble64bit` switch the bit
    /// pattern from "scaled integer" to a real IEEE float.
    extended_type: SignalExtendedValueType,
    /// `VAL_` table for this signal: pairs of `(raw_value, label)`,
    /// sorted by raw value. Empty if the DBC defines no value table.
    /// Looked up by [`decode_signal`] to populate
    /// [`DecodedSignal::label`].
    value_table: Vec<ValueTableEntry>,
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

impl Database {
    /// Parse a DBC file from text.
    pub fn parse(text: &str) -> Result<Self, DbcError> {
        let dbc = Dbc::try_from(text).map_err(|e| DbcError::Parse(e.to_string()))?;

        // Long-name extension: the classic DBC format caps `BO_` / `SG_`
        // identifiers at 32 chars, so longer names appear truncated on
        // those lines plus a `BA_ "System{Message,Signal}LongSymbol" …`
        // attribute carrying the full one. Build the lookups up front so
        // the rest of the code (and our callers) see the real names.
        let long_message_names: HashMap<MessageId, String> = dbc
            .attribute_values_message
            .iter()
            .filter(|av| av.name == "SystemMessageLongSymbol")
            .filter_map(|av| string_value(&av.value).map(|s| (av.message_id, s)))
            .collect();
        let long_signal_names: HashMap<(MessageId, String), String> = dbc
            .attribute_values_signal
            .iter()
            .filter(|av| av.name == "SystemSignalLongSymbol")
            .filter_map(|av| {
                string_value(&av.value).map(|s| ((av.message_id, av.signal_name.clone()), s))
            })
            .collect();

        let mut messages = HashMap::with_capacity(dbc.messages.len());
        for msg in &dbc.messages {
            let expected_len = usize::try_from(msg.size).unwrap_or(usize::MAX);
            let signals = msg
                .signals
                .iter()
                .map(|s| {
                    // `SIG_VALTYPE_` references the signal by the name on
                    // its `SG_` line — the short one — so look it up
                    // before applying any long-symbol rename.
                    let extended_type = dbc
                        .extended_value_type_for_signal(msg.id, &s.name)
                        .copied()
                        .unwrap_or(SignalExtendedValueType::SignedOrUnsignedInteger);
                    let mut signal = s.clone();
                    if let Some(full) = long_signal_names.get(&(msg.id, s.name.clone())) {
                        signal.name.clone_from(full);
                    }
                    // `VAL_` lookups in `can-dbc` key on the original
                    // (short) signal name, the same as `SIG_VALTYPE_`.
                    let value_table = dbc
                        .value_descriptions_for_signal(msg.id, &s.name)
                        .map(|entries| {
                            let mut v: Vec<ValueTableEntry> = entries
                                .iter()
                                .map(|e| ValueTableEntry {
                                    raw: e.id,
                                    label: e.description.clone(),
                                })
                                .collect();
                            v.sort_by_key(|e| e.raw);
                            v
                        })
                        .unwrap_or_default();
                    SignalEntry {
                        signal,
                        extended_type,
                        value_table,
                    }
                })
                .collect();
            let name = long_message_names
                .get(&msg.id)
                .cloned()
                .unwrap_or_else(|| msg.name.clone());
            messages.insert(msg.id, MessageEntry {
                name,
                expected_len,
                signals,
            });
        }
        Ok(Self { messages })
    }

    /// Number of messages defined in this database.
    pub fn message_count(&self) -> usize {
        self.messages.len()
    }

    /// Every signal defined in the database, as `(message, signal)`
    /// descriptors suitable for a "pick a signal to plot" UI.
    ///
    /// The result is sorted by message name, then signal name, so the
    /// list is stable across calls regardless of `HashMap` iteration
    /// order. Multiplexed signals are listed unconditionally — whether a
    /// given frame actually carries one depends on its multiplexor value,
    /// which the sampler resolves per frame.
    #[must_use]
    pub fn signals(&self) -> Vec<SignalDescriptor> {
        let mut out: Vec<SignalDescriptor> = self
            .messages
            .iter()
            .flat_map(|(id, entry)| {
                let (message_id, extended) = message_id_parts(*id);
                entry.signals.iter().map(move |sig| SignalDescriptor {
                    message_id,
                    extended,
                    message_name: entry.name.clone(),
                    signal_name: sig.signal.name.clone(),
                    unit: sig.signal.unit.clone(),
                    has_value_table: !sig.value_table.is_empty(),
                })
            })
            .collect();
        out.sort_by(|a, b| {
            a.message_name
                .cmp(&b.message_name)
                .then_with(|| a.signal_name.cmp(&b.signal_name))
        });
        out
    }

    /// Look up the `VAL_` table for one `(message_id, extended,
    /// signal_name)`. Returns `None` if no such signal exists or it has
    /// no value table. Rows are sorted by raw value.
    ///
    /// Used by the plot panel's axis-tick rendering and the transmit
    /// panel's enum-signal dropdown — a separate call once per signal,
    /// because the same table doesn't have to ride along on every
    /// decoded frame.
    #[must_use]
    pub fn value_table_for_signal(
        &self,
        message_id: u32,
        extended: bool,
        signal_name: &str,
    ) -> Option<&[ValueTableEntry]> {
        let key = canid_to_message_id(if extended {
            cannet_core::CanId::extended(message_id).ok()?
        } else {
            cannet_core::CanId::standard(message_id).ok()?
        })?;
        let entry = self.messages.get(&key)?;
        let sig = entry.signals.iter().find(|s| s.signal.name == signal_name)?;
        if sig.value_table.is_empty() {
            None
        } else {
            Some(&sig.value_table)
        }
    }

    /// Decode `frame` against this database. Returns `None` if no message
    /// in the database matches the frame's id (and addressing mode).
    pub fn decode<'a>(&'a self, frame: &CanFrame) -> Option<DecodedMessage<'a>> {
        self.decode_raw(frame.id, frame.payload.data())
    }

    /// Decode by raw `(id, data)` without needing a `CanFrame`. The trace
    /// view uses this to retro-decode already-displayed frames when the
    /// user attaches a DBC after the fact.
    pub fn decode_raw<'a>(
        &'a self,
        id: cannet_core::CanId,
        data: &[u8],
    ) -> Option<DecodedMessage<'a>> {
        let key = canid_to_message_id(id)?;
        let entry = self.messages.get(&key)?;
        Some(decode_message(entry, data))
    }
}

/// The string payload of an attribute value, or `None` for the numeric
/// variants — the `System…LongSymbol` attributes are always strings.
fn string_value(value: &AttributeValue) -> Option<String> {
    match value {
        AttributeValue::String(s) => Some(s.clone()),
        AttributeValue::Uint(_) | AttributeValue::Int(_) | AttributeValue::Double(_) => None,
    }
}

/// Split a `can-dbc` [`MessageId`] back into the `(raw id, extended?)`
/// pair the rest of the codebase uses. The extended variant carries the
/// 31-bit-flagged form on the wire in some DBCs; mask it to the 29-bit
/// id so it round-trips with [`cannet_core::CanId::extended`].
fn message_id_parts(id: MessageId) -> (u32, bool) {
    match id {
        MessageId::Standard(s) => (u32::from(s), false),
        MessageId::Extended(e) => (e & 0x1FFF_FFFF, true),
    }
}

fn canid_to_message_id(id: cannet_core::CanId) -> Option<MessageId> {
    let raw = id.raw();
    if id.is_extended() {
        Some(MessageId::Extended(raw))
    } else {
        Some(MessageId::Standard(u16::try_from(raw).ok()?))
    }
}

fn decode_message<'a>(entry: &'a MessageEntry, data: &[u8]) -> DecodedMessage<'a> {
    // First pass: find the multiplexor signal value, if any, so we can
    // filter multiplexed signals to the matching selector.
    let multiplexor_value = entry
        .signals
        .iter()
        .find(|s| matches!(s.signal.multiplexer_indicator, MultiplexIndicator::Multiplexor))
        .and_then(|s| decode_signal(s, data).map(|d| d.raw_unsigned));

    let mut signals = Vec::with_capacity(entry.signals.len());
    for sig in &entry.signals {
        let include = match sig.signal.multiplexer_indicator {
            MultiplexIndicator::Plain | MultiplexIndicator::Multiplexor => true,
            MultiplexIndicator::MultiplexedSignal(selector)
            | MultiplexIndicator::MultiplexorAndMultiplexedSignal(selector) => {
                multiplexor_value == Some(selector)
            }
        };
        if !include {
            continue;
        }
        if let Some(decoded) = decode_signal(sig, data) {
            signals.push(decoded);
        }
    }

    DecodedMessage {
        name: &entry.name,
        expected_len: entry.expected_len,
        actual_len: data.len(),
        signals,
    }
}

fn decode_signal<'a>(entry: &'a SignalEntry, data: &[u8]) -> Option<DecodedSignal<'a>> {
    let sig = &entry.signal;
    let start_bit = usize::try_from(sig.start_bit).ok()?;
    let size = usize::try_from(sig.size).ok()?;
    let raw_unsigned = decode_signal_bits(data, start_bit, size, sig.byte_order)?;

    let raw_signed = if sig.value_type == ValueType::Signed {
        let bits = u32::try_from(sig.size).ok()?;
        sign_extend(raw_unsigned, bits)
    } else {
        // Unsigned signals never overflow i64 since size <= 64 and the
        // high bit will only be set for size == 64; the cast then wraps
        // intentionally — physical-value math uses raw_unsigned anyway.
        raw_unsigned.cast_signed()
    };

    // f64 has 52-bit mantissa: signal sizes up to 53 bits round-trip
    // exactly, larger ones lose precision but match the convention used
    // by every other DBC tool. Allow the cast explicitly here.
    #[allow(clippy::cast_precision_loss)]
    let physical = match entry.extended_type {
        SignalExtendedValueType::IEEEfloat32Bit if size == 32 => {
            let bits = u32::try_from(raw_unsigned).ok()?;
            f64::from(f32::from_bits(bits)).mul_add(sig.factor, sig.offset)
        }
        SignalExtendedValueType::IEEEdouble64bit if size == 64 => {
            f64::from_bits(raw_unsigned).mul_add(sig.factor, sig.offset)
        }
        _ if sig.value_type == ValueType::Signed => {
            (raw_signed as f64).mul_add(sig.factor, sig.offset)
        }
        _ => (raw_unsigned as f64).mul_add(sig.factor, sig.offset),
    };

    // Resolve the value-table label, if any. Signed signals compare
    // against `raw_signed`; unsigned against `raw_unsigned` widened to
    // `i64` (signal sizes are <=64 bits; values above `i64::MAX` would
    // never match a DBC `VAL_` row anyway since `can-dbc` parses them
    // as `i64`).
    let lookup_key: i64 = if sig.value_type == ValueType::Signed {
        raw_signed
    } else {
        i64::try_from(raw_unsigned).unwrap_or(i64::MAX)
    };
    let label = entry
        .value_table
        .iter()
        .find(|e| e.raw == lookup_key)
        .map(|e| e.label.as_str());

    Some(DecodedSignal {
        name: &sig.name,
        unit: &sig.unit,
        raw_unsigned,
        raw_signed,
        value: physical,
        label,
    })
}

/// A decoded CAN message: the message's name, its declared and observed
/// payload lengths, and one entry per signal that fit the payload.
#[derive(Debug, Clone)]
pub struct DecodedMessage<'a> {
    pub name: &'a str,
    pub expected_len: usize,
    pub actual_len: usize,
    pub signals: Vec<DecodedSignal<'a>>,
}

/// A decoded signal value with both its raw bit-pattern and its physical
/// value (raw * factor + offset).
///
/// `label` is `Some(&str)` only if the DBC's `VAL_` table for this
/// signal has a row matching the decoded raw value (signed vs.
/// unsigned chosen by the signal's `@…+` / `@…-` flag); otherwise
/// `None`. The trace view and transmit panel use `label` to render
/// enum signals symbolically.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedSignal<'a> {
    pub name: &'a str,
    pub unit: &'a str,
    pub raw_unsigned: u64,
    pub raw_signed: i64,
    pub value: f64,
    pub label: Option<&'a str>,
}

/// A `(message, signal)` pair available for plotting / picking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalDescriptor {
    /// Raw CAN id of the owning message (29-bit if `extended`).
    pub message_id: u32,
    /// Whether `message_id` is a 29-bit extended id.
    pub extended: bool,
    pub message_name: String,
    pub signal_name: String,
    pub unit: String,
    /// True if the DBC defines a `VAL_` table for this signal — i.e.
    /// it's an enum / state signal whose decoded value should be
    /// rendered symbolically. A picker / plotter can use this without a
    /// separate `value_table` round-trip to decide between numeric and
    /// symbolic rendering.
    pub has_value_table: bool,
}

#[derive(Debug)]
pub enum DbcError {
    Parse(String),
}

impl std::fmt::Display for DbcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(msg) => write!(f, "failed to parse DBC: {msg}"),
        }
    }
}

impl std::error::Error for DbcError {}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_core::{CanId, Direction, CanFrame};

    const SAMPLE_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU1 ECU2

BO_ 256 EngineData: 8 ECU1
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383.75] "rpm" ECU2
 SG_ EngineTemp : 16|8@1+ (1,-40) [-40|215] "degC" ECU2
 SG_ ThrottlePos : 24|8@1+ (0.392157,0) [0|100] "%" ECU2

BO_ 257 BigEndianMsg: 8 ECU1
 SG_ BeUnsigned : 7|16@0+ (1,0) [0|0] "" ECU2
 SG_ BeSigned : 23|16@0- (1,0) [0|0] "" ECU2

BO_ 258 SignedMsg: 8 ECU1
 SG_ LeSigned : 0|16@1- (1,0) [0|0] "" ECU2

BO_ 2566849794 ExtendedMsg: 8 ECU1
 SG_ ExtSig : 0|8@1+ (1,0) [0|0] "" ECU2

BO_ 512 MuxedMsg: 8 ECU1
 SG_ Mux M : 0|8@1+ (1,0) [0|0] "" ECU2
 SG_ Mode0Field m0 : 8|16@1+ (1,0) [0|0] "" ECU2
 SG_ Mode1Field m1 : 8|16@1+ (1,0) [0|0] "" ECU2
 SG_ Always : 24|8@1+ (1,0) [0|0] "" ECU2

BO_ 513 FloatMsg: 8 ECU1
 SG_ Lat : 0|32@1+ (1,0) [-90|90] "deg" ECU2
 SG_ Alt : 32|32@1- (0.01,0) [0|0] "m" ECU2

SIG_VALTYPE_ 513 Lat : 1;
"#;

    fn make_frame(raw_id: u32, extended: bool, data: Vec<u8>) -> CanFrame {
        let id = if extended {
            CanId::extended(raw_id).unwrap()
        } else {
            CanId::standard(raw_id).unwrap()
        };
        CanFrame::classic(0, 0, id, Direction::Rx, data).unwrap()
    }

    fn signal_by_name<'a>(msg: &'a DecodedMessage<'_>, name: &str) -> &'a DecodedSignal<'a> {
        msg.signals.iter().find(|s| s.name == name).unwrap_or_else(|| {
            panic!(
                "signal {name} not found, got: {:?}",
                msg.signals.iter().map(|s| s.name).collect::<Vec<_>>()
            )
        })
    }

    #[test]
    fn parses_sample_dbc() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        assert_eq!(db.message_count(), 6);
    }

    #[test]
    fn signals_lists_every_signal_sorted() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let sigs = db.signals();
        // 3 + 2 + 1 + 1 + 4 + 2 = 13 signals across the six messages.
        assert_eq!(sigs.len(), 13);
        // Sorted by (message_name, signal_name).
        let mut sorted = sigs.clone();
        sorted.sort_by(|a, b| {
            a.message_name
                .cmp(&b.message_name)
                .then_with(|| a.signal_name.cmp(&b.signal_name))
        });
        assert_eq!(sigs, sorted);

        let speed = sigs
            .iter()
            .find(|s| s.signal_name == "EngineSpeed")
            .unwrap();
        assert_eq!(speed.message_name, "EngineData");
        assert_eq!(speed.message_id, 256);
        assert!(!speed.extended);
        assert_eq!(speed.unit, "rpm");

        let ext = sigs.iter().find(|s| s.signal_name == "ExtSig").unwrap();
        assert!(ext.extended);
        assert_eq!(ext.message_id, 0x98FF_0502 & 0x1FFF_FFFF);
    }

    #[test]
    fn decode_returns_none_for_unknown_id() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let frame = make_frame(0x600, false, vec![0; 8]);
        assert!(db.decode(&frame).is_none());
    }

    #[test]
    fn decodes_little_endian_unsigned_with_factor_and_offset() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // EngineSpeed: 16 LE bits at offset 0, factor 0.25.
        // Raw 0x1234 (little-endian: bytes [0x34, 0x12]) → 4660 * 0.25 = 1165.0
        // EngineTemp: byte 2 = 100, factor 1, offset -40 → 60 degC
        let data = vec![0x34, 0x12, 100, 50, 0, 0, 0, 0];
        let frame = make_frame(256, false, data);
        let decoded = db.decode(&frame).unwrap();
        assert_eq!(decoded.name, "EngineData");

        let speed = signal_by_name(&decoded, "EngineSpeed");
        assert!((speed.value - 1165.0).abs() < 1e-9, "got {}", speed.value);
        assert_eq!(speed.unit, "rpm");

        let temp = signal_by_name(&decoded, "EngineTemp");
        assert!((temp.value - 60.0).abs() < 1e-9, "got {}", temp.value);
    }

    #[test]
    fn decodes_big_endian_unsigned() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // BeUnsigned: 16 BE bits starting at byte 0 MSB. Bytes [0x12, 0x34] → 0x1234 = 4660
        let data = vec![0x12, 0x34, 0, 0, 0, 0, 0, 0];
        let frame = make_frame(257, false, data);
        let decoded = db.decode(&frame).unwrap();
        let s = signal_by_name(&decoded, "BeUnsigned");
        assert_eq!(s.raw_unsigned, 0x1234);
        assert!((s.value - 4660.0).abs() < 1e-9);
    }

    #[test]
    fn decodes_big_endian_signed_negative() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // BeSigned: 16 BE bits starting at byte 2 MSB. Bytes [_,_,0xFF,0xFE,...]
        // → 0xFFFE = -2 in two's complement (16 bit signed).
        let data = vec![0, 0, 0xFF, 0xFE, 0, 0, 0, 0];
        let frame = make_frame(257, false, data);
        let decoded = db.decode(&frame).unwrap();
        let s = signal_by_name(&decoded, "BeSigned");
        assert_eq!(s.raw_signed, -2);
        assert!((s.value - -2.0).abs() < 1e-9);
    }

    #[test]
    fn decodes_little_endian_signed_negative() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // LeSigned: 16 LE bits at offset 0 signed.
        // Bytes [0xFF, 0xFF, ...] = 0xFFFF unsigned = -1 signed.
        let data = vec![0xFF, 0xFF, 0, 0, 0, 0, 0, 0];
        let frame = make_frame(258, false, data);
        let decoded = db.decode(&frame).unwrap();
        let s = signal_by_name(&decoded, "LeSigned");
        assert_eq!(s.raw_signed, -1);
        assert!((s.value - -1.0).abs() < 1e-9);
    }

    #[test]
    fn decodes_extended_id_message() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // BO_ 2566849794 (= 0x98FF0502) has the extended-id flag (bit 31)
        // set; the underlying 29-bit id is 0x18FF0502.
        let raw_id = 0x98FF_0502_u32 & 0x1FFF_FFFF;
        let data = vec![0x42, 0, 0, 0, 0, 0, 0, 0];
        let frame = make_frame(raw_id, true, data);
        let decoded = db.decode(&frame).unwrap();
        let s = signal_by_name(&decoded, "ExtSig");
        assert_eq!(s.raw_unsigned, 0x42);
    }

    #[test]
    fn standard_and_extended_ids_with_same_raw_dont_collide() {
        // Sanity: EngineData lives at standard 256. A frame at extended 256
        // should not match it.
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let frame = make_frame(256, true, vec![0; 8]);
        assert!(db.decode(&frame).is_none());
    }

    #[test]
    fn multiplexed_signal_only_decoded_for_matching_selector() {
        let db = Database::parse(SAMPLE_DBC).unwrap();

        // Mux=0, Mode0Field bytes 1..3 = 0xAA 0xBB → 0xBBAA
        let frame = make_frame(512, false, vec![0, 0xAA, 0xBB, 0x77, 0, 0, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        let names: Vec<&str> = decoded.signals.iter().map(|s| s.name).collect();
        assert!(names.contains(&"Mux"));
        assert!(names.contains(&"Mode0Field"));
        assert!(names.contains(&"Always"));
        assert!(!names.contains(&"Mode1Field"));

        let m0 = signal_by_name(&decoded, "Mode0Field");
        assert_eq!(m0.raw_unsigned, 0xBBAA);

        // Mux=1 → Mode1Field decoded, Mode0Field skipped.
        let frame = make_frame(512, false, vec![1, 0x12, 0x34, 0xEE, 0, 0, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        let names: Vec<&str> = decoded.signals.iter().map(|s| s.name).collect();
        assert!(!names.contains(&"Mode0Field"));
        assert!(names.contains(&"Mode1Field"));
        let m1 = signal_by_name(&decoded, "Mode1Field");
        assert_eq!(m1.raw_unsigned, 0x3412);
    }

    #[test]
    fn decodes_ieee_float_signal_via_sig_valtype() {
        // Lat is declared as a 32-bit signal with `SIG_VALTYPE_ ... 1;`
        // — the bits should be interpreted as IEEE 754 f32, not as a
        // scaled integer. Alt has no SIG_VALTYPE_ entry, so it falls
        // through to the signed-int path and exercises the regression
        // case for the rest of the message.
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let lat: f32 = 37.7749;
        let alt_raw_i32: i32 = -1234;
        let mut data = vec![0u8; 8];
        data[0..4].copy_from_slice(&lat.to_le_bytes());
        data[4..8].copy_from_slice(&alt_raw_i32.to_le_bytes());

        let frame = make_frame(513, false, data);
        let decoded = db.decode(&frame).unwrap();

        let lat_sig = signal_by_name(&decoded, "Lat");
        assert!((lat_sig.value - f64::from(lat)).abs() < 1e-5, "got {}", lat_sig.value);
        assert_eq!(lat_sig.unit, "deg");

        let alt_sig = signal_by_name(&decoded, "Alt");
        assert!((alt_sig.value - (f64::from(alt_raw_i32) * 0.01)).abs() < 1e-9);
    }

    // The long-name extension: a truncated name on the `BO_` / `SG_`
    // line plus a `BA_ "System…LongSymbol"` attribute with the real one.
    const LONG_SYMBOL_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU1 ECU2

BO_ 256 ShortMsg: 8 ECU1
 SG_ ShortSig : 0|8@1+ (1,0) [0|0] "" ECU2

BA_DEF_ BO_ "SystemMessageLongSymbol" STRING ;
BA_DEF_ SG_ "SystemSignalLongSymbol" STRING ;
BA_DEF_DEF_ "SystemMessageLongSymbol" "";
BA_DEF_DEF_ "SystemSignalLongSymbol" "";
BA_ "SystemMessageLongSymbol" BO_ 256 "AVeryLongMessageNameThatExceedsThirtyTwoChars";
BA_ "SystemSignalLongSymbol" SG_ 256 ShortSig "AVeryLongSignalNameThatExceedsThirtyTwoChars";
"#;

    #[test]
    fn resolves_long_symbol_message_and_signal_names() {
        let db = Database::parse(LONG_SYMBOL_DBC).unwrap();
        let decoded = db.decode(&make_frame(256, false, vec![7u8; 8])).unwrap();
        assert_eq!(decoded.name, "AVeryLongMessageNameThatExceedsThirtyTwoChars");
        assert_eq!(
            decoded.signals.iter().map(|s| s.name).collect::<Vec<_>>(),
            vec!["AVeryLongSignalNameThatExceedsThirtyTwoChars"],
        );
    }

    const VAL_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU1

BO_ 256 Gear: 8 ECU1
 SG_ Mode : 0|8@1+ (1,0) [0|0] "" ECU1
 SG_ Direction : 8|8@1- (1,0) [-1|1] "" ECU1
 SG_ Rpm : 16|16@1+ (1,0) [0|0] "rpm" ECU1

VAL_ 256 Mode 0 "Park" 1 "Reverse" 2 "Neutral" 3 "Drive" ;
VAL_ 256 Direction -1 "Backward" 0 "Stopped" 1 "Forward" ;
"#;

    #[test]
    fn decoded_signal_carries_value_table_label_for_unsigned() {
        let db = Database::parse(VAL_DBC).unwrap();
        // Mode = byte 0 = 3 -> "Drive"
        let frame = make_frame(256, false, vec![3, 0, 0, 0, 0, 0, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        let mode = signal_by_name(&decoded, "Mode");
        assert_eq!(mode.label, Some("Drive"));
        let rpm = signal_by_name(&decoded, "Rpm");
        assert_eq!(rpm.label, None, "no value table -> no label");
    }

    #[test]
    fn decoded_signal_carries_value_table_label_for_signed_negative() {
        let db = Database::parse(VAL_DBC).unwrap();
        // Direction = byte 1 = 0xFF -> -1 -> "Backward"
        let frame = make_frame(256, false, vec![0, 0xFF, 0, 0, 0, 0, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        let dir = signal_by_name(&decoded, "Direction");
        assert_eq!(dir.label, Some("Backward"));
    }

    #[test]
    fn decoded_signal_label_is_none_for_unmapped_value() {
        let db = Database::parse(VAL_DBC).unwrap();
        // Mode = 99 -> no VAL_ row -> no label
        let frame = make_frame(256, false, vec![99, 0, 0, 0, 0, 0, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        assert_eq!(signal_by_name(&decoded, "Mode").label, None);
    }

    #[test]
    fn signals_descriptor_marks_value_table_presence() {
        let db = Database::parse(VAL_DBC).unwrap();
        let sigs = db.signals();
        let mode = sigs.iter().find(|s| s.signal_name == "Mode").unwrap();
        assert!(mode.has_value_table);
        let rpm = sigs.iter().find(|s| s.signal_name == "Rpm").unwrap();
        assert!(!rpm.has_value_table);
    }

    #[test]
    fn value_table_for_signal_returns_sorted_rows() {
        let db = Database::parse(VAL_DBC).unwrap();
        let rows = db.value_table_for_signal(256, false, "Mode").unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].raw, 0);
        assert_eq!(rows[0].label, "Park");
        assert_eq!(rows[3].raw, 3);
        assert_eq!(rows[3].label, "Drive");
        // Signed table: rows sorted ascending, including the negative one.
        let signed = db.value_table_for_signal(256, false, "Direction").unwrap();
        assert_eq!(signed.iter().map(|e| e.raw).collect::<Vec<_>>(), vec![-1, 0, 1]);
        // No table -> None.
        assert!(db.value_table_for_signal(256, false, "Rpm").is_none());
        assert!(db.value_table_for_signal(999, false, "Mode").is_none());
    }

    #[test]
    fn signal_outside_payload_is_skipped() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // EngineData expects 8 bytes; if we pass only 1, every signal that
        // reaches past byte 0 should be skipped, not panic.
        let frame = make_frame(256, false, vec![0xAA]);
        let decoded = db.decode(&frame).unwrap();
        // EngineSpeed needs bits 0..16 (bytes 0..2) — won't fit, dropped.
        assert!(decoded
            .signals
            .iter()
            .all(|s| s.name != "EngineSpeed" && s.name != "EngineTemp"));
        assert_eq!(decoded.actual_len, 1);
        assert_eq!(decoded.expected_len, 8);
    }
}
