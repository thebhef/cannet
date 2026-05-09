//! DBC database loading and runtime signal decoding.
//!
//! Parsing is delegated to the `can-dbc` crate, which produces an AST.
//! This crate builds an indexed, decode-friendly view on top of that AST
//! and runs the bit-extraction maths against `cannet_core::CanFrame` payloads.

mod decode;

pub use decode::{decode_signal_bits, sign_extend};

use std::collections::HashMap;

use cannet_core::CanFrame;
use can_dbc::{Dbc, MessageId, MultiplexIndicator, Signal, SignalExtendedValueType, ValueType};

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
}

impl Database {
    /// Parse a DBC file from text.
    pub fn parse(text: &str) -> Result<Self, DbcError> {
        let dbc = Dbc::try_from(text).map_err(|e| DbcError::Parse(e.to_string()))?;
        let mut messages = HashMap::with_capacity(dbc.messages.len());
        for msg in &dbc.messages {
            let expected_len = usize::try_from(msg.size).unwrap_or(usize::MAX);
            let signals = msg
                .signals
                .iter()
                .map(|s| SignalEntry {
                    extended_type: dbc
                        .extended_value_type_for_signal(msg.id, &s.name)
                        .copied()
                        .unwrap_or(SignalExtendedValueType::SignedOrUnsignedInteger),
                    signal: s.clone(),
                })
                .collect();
            let entry = MessageEntry {
                name: msg.name.clone(),
                expected_len,
                signals,
            };
            messages.insert(msg.id, entry);
        }
        Ok(Self { messages })
    }

    /// Number of messages defined in this database.
    pub fn message_count(&self) -> usize {
        self.messages.len()
    }

    /// Decode `frame` against this database. Returns `None` if no message
    /// in the database matches the frame's id (and addressing mode).
    pub fn decode<'a>(&'a self, frame: &CanFrame) -> Option<DecodedMessage<'a>> {
        let key = frame_to_message_id(frame)?;
        let entry = self.messages.get(&key)?;
        let data = frame.payload.data();
        Some(decode_message(entry, data))
    }
}

fn frame_to_message_id(frame: &CanFrame) -> Option<MessageId> {
    let raw = frame.id.raw();
    if frame.id.is_extended() {
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

    Some(DecodedSignal {
        name: &sig.name,
        unit: &sig.unit,
        raw_unsigned,
        raw_signed,
        value: physical,
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
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedSignal<'a> {
    pub name: &'a str,
    pub unit: &'a str,
    pub raw_unsigned: u64,
    pub raw_signed: i64,
    pub value: f64,
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
