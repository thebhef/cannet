//! DBC database loading and runtime signal decoding.
//!
//! Parsing is delegated to the `can-dbc` crate, which produces an AST.
//! This crate builds an indexed, decode-friendly view on top of that AST
//! and runs the bit-extraction maths against `cannet_core::CanFrame` payloads.

mod bitwalk;
mod calc;
mod crc_named;
mod decode;
mod encode;
mod model;
mod parse;
mod view_builders;

pub use calc::{
    named_crc_algorithms, parse_counter_attribute, parse_crc_attribute, CalcFieldError,
    CalculatedFieldsConfig, CounterConfig, CrcAlgorithm, CrcConfig, FieldViolation,
    PayloadTooShort, RawCrcParams, ResolvedCalculatedFields, VerifyOutcome,
};
pub use decode::{decode_signal_bits, sign_extend, DecodedMessage, DecodedSignal};
pub use encode::encode_signal_bits;
pub use model::{is_enum, Database, DbcAttribute, ValueTableEntry};
pub use parse::DbcError;
pub use view_builders::{
    ByteOrder, DbcMessageContent, DbcSignalContent, FloatKind, MessageDescriptor, SignalDescriptor,
    SignalDescriptorRich, SignalMux,
};

use model::{canid_to_message_id, message_id_parts, MessageEntry};

use can_dbc::{Signal, SignalExtendedValueType, ValueType};

impl Database {
    /// The calculated-field designation the DBC itself declares for
    /// the message addressed by `id` (the `CannetCounter` /
    /// `CannetCrc` attributes — ADR 0027). The returned config is the
    /// *default* layer; overrides replace it wholesale per field.
    /// `None` when no message matches `id`; an empty config when the
    /// message declares no calculated fields.
    #[must_use]
    pub fn dbc_calculated_fields(
        &self,
        id: cannet_core::CanId,
    ) -> Option<&calc::CalculatedFieldsConfig> {
        let key = canid_to_message_id(id)?;
        self.messages.get(&key).map(|e| &e.calc_fields)
    }

    /// Partial-encode `signals` into `base`. For each `(name, physical)`
    /// pair, looks up the signal by name on the message addressed by
    /// `id`, converts the physical value back to its raw bit pattern
    /// (`(physical - offset) / factor`, rounded; IEEE float signals
    /// take the f32 / f64 bit pattern directly), and writes those bits
    /// into `base` at the signal's `start_bit / size / byte_order`. All
    /// other bits in `base` are preserved.
    ///
    /// The encoder is the inverse of [`Database::decode`] in the
    /// strong sense: for every signal in the database, encoding a
    /// decoded `physical` value back into a zeroed buffer (then
    /// decoding) round-trips to the same physical (modulo rounding and
    /// f32 precision for `SIG_VALTYPE_ 1` signals).
    ///
    /// Returns `None` if no message matches `id`. Otherwise returns an
    /// [`EncodeReport`] with one entry per signal — `written` for the
    /// successful encodes, `skipped` for the ones that couldn't fit
    /// the payload or whose name didn't resolve. Skipped signals leave
    /// `base` untouched.
    ///
    /// **Multiplexing.** The encoder is mux-agnostic: it writes the
    /// bits the caller names. If the caller wants the inactive arm's
    /// bits zeroed on a switch change, it passes the new switch value
    /// *and* each new-arm sub-signal set to `0.0` in the same call;
    /// the encoder writes them in order.
    ///
    /// Out-of-range physical values are saturated to the signal's
    /// representable range (`[0, 2^size - 1]` unsigned;
    /// `[-2^(size-1), 2^(size-1) - 1]` signed) before encoding, and
    /// the [`EncodedSignal::saturated`] flag is set.
    /// Every message that declares calculated fields via the cannet
    /// attributes, as `(raw id, extended, config)` — what an
    /// ingest-time verifier enumerates to build its per-id config
    /// index. Sorted by `(extended, id)` for stable iteration.
    #[must_use]
    pub fn calculated_field_messages(&self) -> Vec<(u32, bool, &CalculatedFieldsConfig)> {
        let mut out: Vec<(u32, bool, &CalculatedFieldsConfig)> = self
            .messages
            .iter()
            .filter(|(_, e)| !e.calc_fields.is_empty())
            .map(|(id, e)| {
                let (raw, extended) = message_id_parts(*id);
                (raw, extended, &e.calc_fields)
            })
            .collect();
        out.sort_by_key(|(id, ext, _)| (*ext, *id));
        out
    }

    /// Resolve a calculated-fields config against the message addressed
    /// by `id`: destination signals become bit placements, the CRC
    /// algorithm becomes a ready-built engine, and every config error
    /// surfaces here (see [`CalcFieldError`]) so the per-send
    /// [`ResolvedCalculatedFields::apply`] cannot fail on config.
    /// See ADR 0027.
    pub fn resolve_calculated_fields(
        &self,
        id: cannet_core::CanId,
        config: &CalculatedFieldsConfig,
    ) -> Result<ResolvedCalculatedFields, CalcFieldError> {
        let entry = canid_to_message_id(id)
            .and_then(|key| self.messages.get(&key))
            .ok_or(CalcFieldError::MessageNotFound)?;
        calc::resolve(entry, config)
    }

    pub fn encode_frame(
        &self,
        id: cannet_core::CanId,
        signals: &[(&str, f64)],
        base: &mut [u8],
    ) -> Option<EncodeReport> {
        let key = canid_to_message_id(id)?;
        let entry = self.messages.get(&key)?;

        let mut report = EncodeReport::default();
        for &(name, physical) in signals {
            match encode_one_signal(entry, name, physical, base) {
                Ok(written) => report.written.push(written),
                Err(skipped) => report.skipped.push(skipped),
            }
        }
        Some(report)
    }
}

/// Encode one named signal's bits into `data`, leaving all other bits
/// untouched. Returns `Err(SkippedSignal)` and does not mutate `data`
/// if the signal is unknown or its bits don't fit `data`.
fn encode_one_signal(
    entry: &MessageEntry,
    name: &str,
    physical: f64,
    data: &mut [u8],
) -> Result<EncodedSignal, SkippedSignal> {
    let Some(sig_entry) = entry.signals.iter().find(|s| s.signal.name == name) else {
        return Err(SkippedSignal {
            name: name.to_string(),
            reason: SkipReason::SignalNotFound,
        });
    };
    let sig = &sig_entry.signal;
    let Ok(start_bit) = usize::try_from(sig.start_bit) else {
        return Err(SkippedSignal {
            name: name.to_string(),
            reason: SkipReason::SizeOutOfRange,
        });
    };
    let size_usize = match usize::try_from(sig.size) {
        Ok(s) if (1..=64).contains(&s) => s,
        _ => {
            return Err(SkippedSignal {
                name: name.to_string(),
                reason: SkipReason::SizeOutOfRange,
            });
        }
    };
    // Safe — checked above.
    #[allow(clippy::cast_possible_truncation)]
    let size_u32 = size_usize as u32;

    let (raw_unsigned, saturated) =
        physical_to_raw(physical, sig, size_u32, sig_entry.extended_type);

    if encode::encode_signal_bits(data, start_bit, size_usize, raw_unsigned, sig.byte_order)
        .is_none()
    {
        return Err(SkippedSignal {
            name: name.to_string(),
            reason: SkipReason::BaseTooShort,
        });
    }

    Ok(EncodedSignal {
        name: name.to_string(),
        raw_unsigned,
        saturated,
    })
}

/// Convert a physical value back to a raw bit pattern according to the
/// signal's type. For integer signals this is `round((physical - offset)
/// / factor)`, then saturated to the signal's signed / unsigned range.
/// For IEEE-typed signals (`SIG_VALTYPE_ … 1` / `2`) the result is the
/// `f32` / `f64` bit pattern of the same expression — matching the
/// shape `decode_signal` parses on the way back.
fn physical_to_raw(
    physical: f64,
    sig: &Signal,
    size_bits: u32,
    extended_type: SignalExtendedValueType,
) -> (u64, bool) {
    // Float branches first — they ignore the signed flag and don't
    // saturate via integer bounds; an out-of-range physical clamps at
    // f32 ±inf, which is still a representable f32 bit pattern.
    match extended_type {
        SignalExtendedValueType::IEEEfloat32Bit if size_bits == 32 => {
            let scaled = (physical - sig.offset) / sig.factor;
            // `as f32` saturates infinities to +/- inf and clamps
            // overflows toward the same — both are still well-defined
            // bit patterns, so we don't flag them as "saturated" here.
            #[allow(clippy::cast_possible_truncation)]
            let f32_val = scaled as f32;
            return (u64::from(f32_val.to_bits()), false);
        }
        SignalExtendedValueType::IEEEdouble64bit if size_bits == 64 => {
            let scaled = (physical - sig.offset) / sig.factor;
            return (scaled.to_bits(), false);
        }
        _ => {}
    }

    let raw_f = (physical - sig.offset) / sig.factor;
    let raw_rounded = raw_f.round();

    if sig.value_type == ValueType::Signed {
        // Signed: range [-2^(size-1), 2^(size-1) - 1]. At size==64 use
        // i64's bounds directly; otherwise compute them from `size`.
        let (min_i, max_i) = if size_bits == 64 {
            (i64::MIN, i64::MAX)
        } else {
            let high = 1_i64 << (size_bits - 1);
            (-high, high - 1)
        };
        // Cast to f64 for the comparison — for sizes <= 53 bits this is
        // exact; for larger signed sizes (rare) f64 mantissa loss can
        // push the boundary by 1 ulp, which we accept.
        #[allow(clippy::cast_precision_loss)]
        let (min_f, max_f) = (min_i as f64, max_i as f64);
        let (raw_i, saturated) = if !raw_rounded.is_finite() || raw_rounded > max_f {
            (max_i, true)
        } else if raw_rounded < min_f {
            (min_i, true)
        } else {
            // In-range cast: f64 → i64 is well-defined here.
            #[allow(clippy::cast_possible_truncation)]
            let v = raw_rounded as i64;
            (v, false)
        };
        let raw_u = if size_bits == 64 {
            raw_i.cast_unsigned()
        } else {
            (raw_i.cast_unsigned()) & ((1u64 << size_bits) - 1)
        };
        (raw_u, saturated)
    } else {
        let max_u = if size_bits == 64 {
            u64::MAX
        } else {
            (1u64 << size_bits) - 1
        };
        #[allow(clippy::cast_precision_loss)]
        let max_f = max_u as f64;
        let (raw_u, saturated) = if !raw_rounded.is_finite() || raw_rounded > max_f {
            (max_u, true)
        } else if raw_rounded < 0.0 {
            (0u64, true)
        } else {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let v = raw_rounded as u64;
            (v, false)
        };
        (raw_u, saturated)
    }
}

/// Result of a [`Database::encode_frame`] call: one entry per input
/// signal, partitioned into the ones whose bits were written and the
/// ones that couldn't be (unknown name, doesn't fit `base`, …).
#[derive(Debug, Default, Clone)]
pub struct EncodeReport {
    /// Successful per-signal writes, in input order.
    pub written: Vec<EncodedSignal>,
    /// Per-signal skips, in input order. Skipped signals do not mutate
    /// `base`.
    pub skipped: Vec<SkippedSignal>,
}

/// A signal whose bits were written into the payload.
#[derive(Debug, Clone, PartialEq)]
pub struct EncodedSignal {
    pub name: String,
    /// Raw bit pattern actually placed in the payload (post-saturation,
    /// post-rounding). Width matches the signal's declared `size`.
    pub raw_unsigned: u64,
    /// True if the requested physical value lay outside the signal's
    /// representable range and was clamped before encoding.
    pub saturated: bool,
}

/// A signal that couldn't be encoded.
#[derive(Debug, Clone, PartialEq)]
pub struct SkippedSignal {
    pub name: String,
    pub reason: SkipReason,
}

/// Why a signal was skipped by [`Database::encode_frame`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// No signal with this name on the resolved message.
    SignalNotFound,
    /// The signal's bits would have run past the end of `base`.
    BaseTooShort,
    /// The signal's `start_bit` / `size` are outside the encoder's
    /// supported range (`size` ∈ `1..=64`, `start_bit` fits `usize`).
    SizeOutOfRange,
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_core::{CanId, Direction, CanFrame};
    use std::collections::HashMap;

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
    fn message_names_lists_every_message_with_id_parts() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut names: Vec<(u32, bool, &str)> = db.message_names().collect();
        names.sort_unstable();
        assert_eq!(names.len(), 6);
        assert!(names.contains(&(256, false, "EngineData")));
        // Extended-id flag split out of the raw BO_ id.
        assert!(names.contains(&(0x98FF_0502 & 0x1FFF_FFFF, true, "ExtendedMsg")));
    }

    #[test]
    fn signal_names_maps_signals_to_their_message_id() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let names: Vec<(u32, bool, &str)> = db.signal_names().collect();
        assert_eq!(names.len(), 13); // same total as `signals()`
        assert!(names.contains(&(256, false, "EngineSpeed")));
        assert!(names.contains(&(0x98FF_0502 & 0x1FFF_FFFF, true, "ExtSig")));
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
 SG_ Counter : 32|16@1+ (1,0) [0|65535] "count" ECU1

VAL_ 256 Mode 0 "Park" 1 "Reverse" 2 "Neutral" 3 "Drive" ;
VAL_ 256 Direction -1 "Backward" 0 "Stopped" 1 "Forward" ;
VAL_ 256 Counter 65535 "SNA" ;
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
    fn signals_descriptor_is_enum_requires_two_members() {
        let db = Database::parse(VAL_DBC).unwrap();
        let sigs = db.signals();
        let mode = sigs.iter().find(|s| s.signal_name == "Mode").unwrap();
        assert!(mode.is_enum, "multi-member VAL_ table -> enum");
        let rpm = sigs.iter().find(|s| s.signal_name == "Rpm").unwrap();
        assert!(!rpm.is_enum, "no VAL_ table -> not an enum");
        let counter = sigs.iter().find(|s| s.signal_name == "Counter").unwrap();
        assert!(
            !counter.is_enum,
            "single-member VAL_ table (SNA sentinel) -> not an enum"
        );
    }

    #[test]
    fn is_enum_requires_at_least_two_members() {
        let row = |raw: i64| ValueTableEntry {
            raw,
            label: format!("L{raw}"),
        };
        assert!(!is_enum(&[]));
        assert!(!is_enum(&[row(65535)]));
        assert!(is_enum(&[row(0), row(1)]));
    }

    #[test]
    fn single_member_value_table_label_only_on_exact_match() {
        let db = Database::parse(VAL_DBC).unwrap();
        // Counter = bytes 4..6 little-endian. 65535 -> the SNA label.
        let frame = make_frame(256, false, vec![0, 0, 0, 0, 0xFF, 0xFF, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        let counter = signal_by_name(&decoded, "Counter");
        assert_eq!(counter.label, Some("SNA"));

        // Any other value decodes numerically, keeps its unit, no label.
        let frame = make_frame(256, false, vec![0, 0, 0, 0, 5, 0, 0, 0]);
        let decoded = db.decode(&frame).unwrap();
        let counter = signal_by_name(&decoded, "Counter");
        assert_eq!(counter.label, None, "ordinary value must not get the SNA label");
        assert!((counter.value - 5.0).abs() < 1e-12);
        assert_eq!(counter.unit, "count");
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
        // Single-member table: still returned — the label stays
        // available even though the signal is not an enum.
        let single = db.value_table_for_signal(256, false, "Counter").unwrap();
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].raw, 65535);
        assert_eq!(single[0].label, "SNA");
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

    // --- encode_frame ---

    fn std_id(raw: u32) -> CanId {
        CanId::standard(raw).unwrap()
    }

    /// Look up a signal's decoded physical value, asserting it exists.
    fn physical_of(msg: &DecodedMessage<'_>, name: &str) -> f64 {
        signal_by_name(msg, name).value
    }

    #[test]
    fn encode_returns_none_for_unknown_id() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        assert!(db.encode_frame(std_id(0x600), &[("Whatever", 0.0)], &mut base).is_none());
    }

    #[test]
    fn encode_flags_unknown_signals_but_still_reports() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        let report = db
            .encode_frame(
                std_id(256),
                &[("EngineSpeed", 1165.0), ("NotASignal", 0.0)],
                &mut base,
            )
            .unwrap();
        assert_eq!(report.written.len(), 1);
        assert_eq!(report.written[0].name, "EngineSpeed");
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(report.skipped[0].name, "NotASignal");
        assert_eq!(report.skipped[0].reason, SkipReason::SignalNotFound);
    }

    #[test]
    fn encode_round_trips_little_endian_unsigned_with_factor() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // EngineSpeed: 16 LE bits factor 0.25.
        db.encode_frame(std_id(256), &[("EngineSpeed", 1165.0)], &mut base)
            .unwrap();
        let decoded = db.decode(&make_frame(256, false, base.clone())).unwrap();
        assert!((physical_of(&decoded, "EngineSpeed") - 1165.0).abs() < 1e-9);
        // Bytes 0..2 are the encoded raw 0x1234; bytes 2..8 untouched.
        assert_eq!(&base[0..2], &[0x34, 0x12]);
        assert_eq!(&base[2..], &[0u8; 6]);
    }

    #[test]
    fn encode_round_trips_little_endian_signed_negative() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // LeSigned: 16 LE bits signed, factor 1 offset 0.
        db.encode_frame(std_id(258), &[("LeSigned", -1.0)], &mut base)
            .unwrap();
        assert_eq!(&base[0..2], &[0xFF, 0xFF]);
        let decoded = db.decode(&make_frame(258, false, base.clone())).unwrap();
        let s = signal_by_name(&decoded, "LeSigned");
        assert_eq!(s.raw_signed, -1);
        assert!((s.value + 1.0).abs() < 1e-9);
    }

    #[test]
    fn encode_round_trips_big_endian_signed_negative() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // BeSigned lives at start_bit 23, 16 BE bits; bytes [2] then [3].
        db.encode_frame(std_id(257), &[("BeSigned", -2.0)], &mut base)
            .unwrap();
        assert_eq!(base[2], 0xFF);
        assert_eq!(base[3], 0xFE);
        let decoded = db.decode(&make_frame(257, false, base.clone())).unwrap();
        let s = signal_by_name(&decoded, "BeSigned");
        assert_eq!(s.raw_signed, -2);
    }

    #[test]
    fn encode_round_trips_offset_signal() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // EngineTemp: 8 bits factor 1 offset -40 → physical 60 → raw 100.
        db.encode_frame(std_id(256), &[("EngineTemp", 60.0)], &mut base)
            .unwrap();
        assert_eq!(base[2], 100);
        let decoded = db.decode(&make_frame(256, false, base.clone())).unwrap();
        assert!((physical_of(&decoded, "EngineTemp") - 60.0).abs() < 1e-9);
    }

    #[test]
    fn encode_round_trips_ieee_float32_signal() {
        // Lat has `SIG_VALTYPE_ … 1;`, factor 1 offset 0.
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        let physical = 37.7749_f64;
        db.encode_frame(std_id(513), &[("Lat", physical)], &mut base)
            .unwrap();
        let decoded = db.decode(&make_frame(513, false, base.clone())).unwrap();
        let lat = signal_by_name(&decoded, "Lat");
        // f32 precision: agree to ~1e-5.
        assert!((lat.value - physical).abs() < 1e-4);
    }

    #[test]
    fn encode_preserves_neighbouring_bytes() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // Pre-populate the payload with a pattern that doesn't overlap
        // EngineSpeed's bytes — bytes 2..8 are EngineTemp/ThrottlePos/pad.
        let mut base = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x12, 0x34, 0x56, 0x78];
        db.encode_frame(std_id(256), &[("EngineSpeed", 1165.0)], &mut base)
            .unwrap();
        // Bytes 0..2 are EngineSpeed's; bytes 2..8 must survive intact.
        assert_eq!(&base[2..], &[0xBE, 0xEF, 0x12, 0x34, 0x56, 0x78]);
    }

    #[test]
    fn encode_saturates_out_of_range_unsigned() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // EngineSpeed: 16-bit unsigned, factor 0.25. Max raw = 65535,
        // max physical = 65535 * 0.25 = 16383.75. Asking for 20000 should
        // saturate to raw=65535.
        let report = db
            .encode_frame(std_id(256), &[("EngineSpeed", 20000.0)], &mut base)
            .unwrap();
        assert_eq!(report.written.len(), 1);
        assert!(report.written[0].saturated, "expected saturation flag");
        assert_eq!(report.written[0].raw_unsigned, 0xFFFF);
        assert_eq!(&base[0..2], &[0xFF, 0xFF]);

        // Negative value on an unsigned signal saturates to 0.
        let mut base = vec![0xAAu8; 8];
        let report = db
            .encode_frame(std_id(256), &[("EngineSpeed", -1.0)], &mut base)
            .unwrap();
        assert!(report.written[0].saturated);
        assert_eq!(report.written[0].raw_unsigned, 0);
        assert_eq!(&base[0..2], &[0x00, 0x00]);
        // Bytes outside EngineSpeed's window preserved.
        assert_eq!(&base[2..], &[0xAA; 6]);
    }

    #[test]
    fn encode_saturates_out_of_range_signed() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];
        // LeSigned: 16-bit signed; max +32767, min -32768.
        let report = db
            .encode_frame(std_id(258), &[("LeSigned", 1e9)], &mut base)
            .unwrap();
        assert!(report.written[0].saturated);
        // Raw bits should be the unsigned representation of 32767.
        assert_eq!(report.written[0].raw_unsigned, 0x7FFF);

        let report = db
            .encode_frame(std_id(258), &[("LeSigned", -1e9)], &mut base)
            .unwrap();
        assert!(report.written[0].saturated);
        // i16::MIN = -32768 = 0x8000 (low 16 bits).
        assert_eq!(report.written[0].raw_unsigned, 0x8000);
    }

    #[test]
    fn encode_skips_signals_that_dont_fit_base() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // Only 1 byte of base; EngineSpeed needs 2.
        let mut base = vec![0xAAu8; 1];
        let before = base.clone();
        let report = db
            .encode_frame(std_id(256), &[("EngineSpeed", 1165.0)], &mut base)
            .unwrap();
        assert_eq!(report.written.len(), 0);
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(report.skipped[0].reason, SkipReason::BaseTooShort);
        // Base must be unchanged when the only signal was skipped.
        assert_eq!(base, before);
    }

    #[test]
    fn encode_round_trips_muxed_signals_for_each_arm() {
        // MuxedMsg has Mux (selector), Mode0Field m0, Mode1Field m1,
        // Always (plain). Encoding switch + the active arm's sub-signal
        // should round-trip through decode.
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let mut base = vec![0u8; 8];

        // Arm 0: M=0, Mode0Field=0xAABB, Always=0x77.
        db.encode_frame(
            std_id(512),
            &[
                ("Mux", 0.0),
                ("Mode0Field", 0xAABB_u32.into()),
                ("Always", 0x77_u32.into()),
            ],
            &mut base,
        )
        .unwrap();
        let decoded = db.decode(&make_frame(512, false, base.clone())).unwrap();
        let names: Vec<&str> = decoded.signals.iter().map(|s| s.name).collect();
        assert!(names.contains(&"Mode0Field"));
        assert!(!names.contains(&"Mode1Field"));
        assert_eq!(signal_by_name(&decoded, "Mode0Field").raw_unsigned, 0xAABB);
        assert_eq!(signal_by_name(&decoded, "Always").raw_unsigned, 0x77);

        // Arm 1: M=1, Mode1Field=0x1234 — write switch + new sub-signal
        // in the same call. The bits for Mode0Field overlap Mode1Field
        // in the payload, so Mode0Field bits get overwritten by the new
        // sub-signal write. Always (a non-mux signal) survives.
        db.encode_frame(
            std_id(512),
            &[("Mux", 1.0), ("Mode1Field", 0x1234_u32.into())],
            &mut base,
        )
        .unwrap();
        let decoded = db.decode(&make_frame(512, false, base.clone())).unwrap();
        let names: Vec<&str> = decoded.signals.iter().map(|s| s.name).collect();
        assert!(!names.contains(&"Mode0Field"));
        assert!(names.contains(&"Mode1Field"));
        assert_eq!(signal_by_name(&decoded, "Mode1Field").raw_unsigned, 0x1234);
        // Always (byte 3, not part of mux) preserved through the switch.
        assert_eq!(signal_by_name(&decoded, "Always").raw_unsigned, 0x77);
    }

    #[test]
    fn describe_message_returns_rich_descriptor_with_range_and_mux() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // MuxedMsg: switch + two mux arms + Always.
        let desc = db.describe_message(std_id(512)).unwrap();
        assert_eq!(desc.name, "MuxedMsg");
        assert_eq!(desc.expected_len, 8);
        assert!(!desc.uses_extended_mux);

        let by_name: HashMap<&str, &SignalDescriptorRich> =
            desc.signals.iter().map(|s| (s.name.as_str(), s)).collect();
        assert!(matches!(by_name["Mux"].mux, SignalMux::Multiplexor));
        assert!(matches!(
            by_name["Mode0Field"].mux,
            SignalMux::Multiplexed { selector: 0 },
        ));
        assert!(matches!(
            by_name["Mode1Field"].mux,
            SignalMux::Multiplexed { selector: 1 },
        ));
        assert!(matches!(by_name["Always"].mux, SignalMux::Plain));

        // EngineSpeed declares [0|16383.75] — non-default range.
        let speed = db
            .describe_message(std_id(256))
            .unwrap()
            .signals
            .into_iter()
            .find(|s| s.name == "EngineSpeed")
            .unwrap();
        assert!((speed.min - 0.0).abs() < 1e-9);
        assert!((speed.max - 16383.75).abs() < 1e-9);
        assert_eq!(speed.size, 16);
        assert!(!speed.signed);
        assert!(matches!(speed.float_kind, FloatKind::Integer));
        assert!((speed.factor - 0.25).abs() < 1e-9);
    }

    #[test]
    fn describe_message_reports_gen_msg_cycle_time() {
        // A DBC that sets GenMsgCycleTime on one message (100 ms) and
        // leaves another with the default (0). The first reports the
        // value; the second — only the default, no per-message BA_ —
        // reports None (the value isn't carried on the message).
        let dbc = r#"VERSION ""
NS_ :
BS_:
BU_: ECU
BO_ 256 Cyclic: 8 ECU
 SG_ A : 0|8@1+ (1,0) [0|255] "" ECU
BO_ 257 OnDemand: 8 ECU
 SG_ B : 0|8@1+ (1,0) [0|255] "" ECU
BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;
BA_DEF_DEF_ "GenMsgCycleTime" 0;
BA_ "GenMsgCycleTime" BO_ 256 100;
"#;
        let db = Database::parse(dbc).unwrap();
        assert_eq!(
            db.describe_message(std_id(256)).unwrap().gen_msg_cycle_time_ms,
            Some(100),
        );
        assert_eq!(
            db.describe_message(std_id(257)).unwrap().gen_msg_cycle_time_ms,
            None,
        );
    }

    #[test]
    fn describe_message_marks_ieee_float_signals() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let desc = db.describe_message(std_id(513)).unwrap();
        let lat = desc.signals.iter().find(|s| s.name == "Lat").unwrap();
        assert!(matches!(lat.float_kind, FloatKind::Float32));
        // Alt has no SIG_VALTYPE_ entry — stays Integer despite being
        // a signed 32-bit signal with a fractional factor.
        let alt = desc.signals.iter().find(|s| s.name == "Alt").unwrap();
        assert!(matches!(alt.float_kind, FloatKind::Integer));
        assert!(alt.signed);
    }

    #[test]
    fn describe_message_returns_none_for_unknown_id() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        assert!(db.describe_message(std_id(0x600)).is_none());
    }

    const FD_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU

BO_ 100 ClassicByDefault: 8 ECU
 SG_ Sig : 0|8@1+ (1,0) [0|0] "" ECU

BO_ 200 FdByVFrameFormat: 8 ECU
 SG_ Sig : 0|8@1+ (1,0) [0|0] "" ECU

BO_ 300 FdBySize: 16 ECU
 SG_ Sig : 0|8@1+ (1,0) [0|0] "" ECU

BO_ 400 FdBrsOff: 8 ECU
 SG_ Sig : 0|8@1+ (1,0) [0|0] "" ECU

BA_DEF_ BO_ "VFrameFormat" INT 0 16;
BA_DEF_ BO_ "GenMsgCANFDBRS" INT 0 1;
BA_DEF_DEF_ "VFrameFormat" 0;
BA_DEF_DEF_ "GenMsgCANFDBRS" 1;
BA_ "VFrameFormat" BO_ 200 14;
BA_ "VFrameFormat" BO_ 400 14;
BA_ "GenMsgCANFDBRS" BO_ 400 0;
"#;

    #[test]
    fn describe_message_derives_fd_from_vframeformat_or_size() {
        let db = Database::parse(FD_DBC).unwrap();
        let classic = db.describe_message(std_id(100)).unwrap();
        assert!(!classic.is_fd, "size==8 with no VFrameFormat → classic");
        assert!(!classic.brs);

        let by_attr = db.describe_message(std_id(200)).unwrap();
        assert!(by_attr.is_fd, "VFrameFormat=14 → FD");
        assert!(by_attr.brs, "no GenMsgCANFDBRS → default true on FD");

        let by_size = db.describe_message(std_id(300)).unwrap();
        assert!(by_size.is_fd, "size>8 → FD fallback");
        assert!(by_size.brs);

        let brs_off = db.describe_message(std_id(400)).unwrap();
        assert!(brs_off.is_fd);
        assert!(!brs_off.brs, "GenMsgCANFDBRS=0 → BRS off");
    }

    #[test]
    fn encode_round_trips_every_signal_in_demo_fixture() {
        // Property test: for every (message, signal) pair, encoding the
        // physical value `factor + offset` (which maps to raw = 1 for
        // any integer signal, exactly representable for any signal
        // size ≥ 1 bit, signed or unsigned) round-trips through decode
        // to the same physical value. IEEE-typed signals just need a
        // finite physical f32 / f64 can hold.
        let db = Database::parse(SAMPLE_DBC).unwrap();
        // Walk the signals via the parsed entries so we can look up
        // factor / offset per signal. `db.signals()` returns a
        // descriptor view that doesn't carry these.
        for (key, entry) in &db.messages {
            let (raw_id, extended) = message_id_parts(*key);
            let id = if extended {
                CanId::extended(raw_id).unwrap()
            } else {
                CanId::standard(raw_id).unwrap()
            };
            for sig in &entry.signals {
                let physical: f64 = sig.signal.factor + sig.signal.offset;
                let mut base = vec![0u8; entry.expected_len.max(8)];
                let report = db
                    .encode_frame(id, &[(sig.signal.name.as_str(), physical)], &mut base)
                    .unwrap_or_else(|| panic!("encode_frame returned None for {}", entry.name));
                assert_eq!(
                    report.written.len(),
                    1,
                    "no successful write for {}::{} (skipped: {:?})",
                    entry.name,
                    sig.signal.name,
                    report.skipped,
                );

                let decoded = db
                    .decode(&make_frame(raw_id, extended, base.clone()))
                    .unwrap();
                // Muxed sub-signals are filtered by decode when the
                // mux switch's encoded raw value doesn't match this
                // arm; in that case there's nothing to compare against
                // and we move on. The non-muxed and switch signals are
                // always present.
                if let Some(s) = decoded
                    .signals
                    .iter()
                    .find(|s| s.name == sig.signal.name)
                {
                    // f32 IEEE signals lose precision in the bottom
                    // few bits; everything else is exact.
                    let tol = if matches!(
                        sig.extended_type,
                        SignalExtendedValueType::IEEEfloat32Bit
                    ) {
                        1e-5
                    } else {
                        1e-9
                    };
                    assert!(
                        (s.value - physical).abs() < tol,
                        "{}::{}: encoded {physical}, decoded back as {} (raw_unsigned={})",
                        entry.name,
                        sig.signal.name,
                        s.value,
                        s.raw_unsigned,
                    );
                }
            }
        }
    }

    // --- dbc_content (DBC panel) ---

    /// Fixture covering the kinds of text the discovery panel's fuzzy
    /// search has to match: per-message comments + attributes, per-signal
    /// comments + attributes, units, and value tables.
    const COMMENTED_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU1

BO_ 256 Gear: 8 ECU1
 SG_ Mode : 0|8@1+ (1,0) [0|0] "" ECU1
 SG_ Rpm : 16|16@1+ (1,0) [0|0] "rpm" ECU1

BO_ 257 Coolant: 8 ECU1
 SG_ Temperature : 0|8@1+ (1,-40) [-40|215] "degC" ECU1

CM_ BO_ 256 "Gear shifter state.";
CM_ SG_ 256 Mode "Selected gear mode.";
CM_ SG_ 257 Temperature "Engine coolant temperature.";

BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;
BA_DEF_ SG_ "GenSigStartValue" FLOAT 0 1000;
BA_DEF_DEF_ "GenMsgCycleTime" 0;
BA_ "GenMsgCycleTime" BO_ 256 100;
BA_ "GenMsgCycleTime" BO_ 257 20;
BA_ "GenSigStartValue" SG_ 256 Mode 1;

VAL_ 256 Mode 0 "Park" 1 "Reverse" 2 "Neutral" 3 "Drive" ;
"#;

    #[test]
    fn dbc_content_sorts_messages_by_id_and_preserves_signal_order() {
        let db = Database::parse(COMMENTED_DBC).unwrap();
        let content = db.dbc_content();
        assert_eq!(content.len(), 2);
        // Message 256 (Gear) comes before 257 (Coolant) by id.
        assert_eq!(content[0].message_id, 256);
        assert!(!content[0].extended);
        assert_eq!(content[0].name, "Gear");
        assert_eq!(content[1].message_id, 257);
        assert_eq!(content[1].name, "Coolant");

        // Signals in source order (Mode before Rpm — they appear that way
        // in the fixture).
        assert_eq!(
            content[0]
                .signals
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Mode", "Rpm"],
        );
    }

    #[test]
    fn dbc_content_carries_message_and_signal_comments() {
        let db = Database::parse(COMMENTED_DBC).unwrap();
        let content = db.dbc_content();
        let gear = content.iter().find(|m| m.name == "Gear").unwrap();
        assert_eq!(gear.comment, "Gear shifter state.");
        let mode = gear.signals.iter().find(|s| s.name == "Mode").unwrap();
        assert_eq!(mode.comment, "Selected gear mode.");
        // Rpm has no signal comment — empty string, not absent.
        let rpm = gear.signals.iter().find(|s| s.name == "Rpm").unwrap();
        assert_eq!(rpm.comment, "");
    }

    #[test]
    fn dbc_content_carries_message_attributes_stringified() {
        let db = Database::parse(COMMENTED_DBC).unwrap();
        let content = db.dbc_content();
        let gear = content.iter().find(|m| m.message_id == 256).unwrap();
        let cycle = gear
            .attributes
            .iter()
            .find(|a| a.name == "GenMsgCycleTime")
            .unwrap();
        assert_eq!(cycle.value, "100");
        // Attributes are sorted by name for a stable display order.
        assert!(gear.attributes.windows(2).all(|w| w[0].name <= w[1].name));
    }

    #[test]
    fn dbc_content_carries_signal_attributes() {
        let db = Database::parse(COMMENTED_DBC).unwrap();
        let content = db.dbc_content();
        let gear = content.iter().find(|m| m.name == "Gear").unwrap();
        let mode = gear.signals.iter().find(|s| s.name == "Mode").unwrap();
        let start = mode
            .attributes
            .iter()
            .find(|a| a.name == "GenSigStartValue")
            .unwrap();
        // The attribute value was `1` (parsed as Uint), so it serialises
        // back as "1" (no float formatting).
        assert_eq!(start.value, "1");
    }

    #[test]
    fn dbc_content_carries_signal_value_table() {
        let db = Database::parse(COMMENTED_DBC).unwrap();
        let content = db.dbc_content();
        let gear = content.iter().find(|m| m.name == "Gear").unwrap();
        let mode = gear.signals.iter().find(|s| s.name == "Mode").unwrap();
        let labels: Vec<&str> = mode.value_table.iter().map(|e| e.label.as_str()).collect();
        assert_eq!(labels, vec!["Park", "Reverse", "Neutral", "Drive"]);
        // Signals without a VAL_ table get an empty (not absent) list.
        let rpm = gear.signals.iter().find(|s| s.name == "Rpm").unwrap();
        assert!(rpm.value_table.is_empty());
    }

    #[test]
    fn dbc_content_includes_extended_id_messages() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let content = db.dbc_content();
        let ext = content.iter().find(|m| m.name == "ExtendedMsg").unwrap();
        assert!(ext.extended);
        assert_eq!(ext.message_id, 0x98FF_0502 & 0x1FFF_FFFF);
    }

    #[test]
    fn dbc_content_carries_message_layout_fields() {
        // EngineData in SAMPLE_DBC is a classic 8-byte message; the
        // discovery panel needs its expected_len, is_fd, brs,
        // uses_extended_mux flags.
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let content = db.dbc_content();
        let engine = content.iter().find(|m| m.name == "EngineData").unwrap();
        assert_eq!(engine.expected_len, 8);
        assert!(!engine.is_fd);
        assert!(!engine.brs);
        assert!(!engine.uses_extended_mux);
    }

    #[test]
    fn dbc_content_carries_signal_bit_layout() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let content = db.dbc_content();
        let engine = content.iter().find(|m| m.name == "EngineData").unwrap();
        let speed = engine.signals.iter().find(|s| s.name == "EngineSpeed").unwrap();
        assert_eq!(speed.start_bit, 0);
        assert_eq!(speed.length, 16);
        assert_eq!(speed.byte_order, ByteOrder::Little);
        assert!(!speed.signed);
        let be_signed = content
            .iter()
            .find(|m| m.name == "BigEndianMsg")
            .unwrap()
            .signals
            .iter()
            .find(|s| s.name == "BeSigned")
            .unwrap();
        assert_eq!(be_signed.byte_order, ByteOrder::Big);
        assert!(be_signed.signed);
    }

    #[test]
    fn dbc_content_carries_signal_factor_offset_and_range() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let content = db.dbc_content();
        let engine = content.iter().find(|m| m.name == "EngineData").unwrap();
        let speed = engine.signals.iter().find(|s| s.name == "EngineSpeed").unwrap();
        assert!((speed.factor - 0.25).abs() < 1e-9);
        assert!((speed.offset - 0.0).abs() < 1e-9);
        assert!((speed.min - 0.0).abs() < 1e-9);
        assert!((speed.max - 16383.75).abs() < 1e-9);
        let temp = engine.signals.iter().find(|s| s.name == "EngineTemp").unwrap();
        assert!((temp.offset - -40.0).abs() < 1e-9);
        assert!((temp.min - -40.0).abs() < 1e-9);
        assert!((temp.max - 215.0).abs() < 1e-9);
    }

    #[test]
    fn dbc_content_carries_mux_indicator() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let content = db.dbc_content();
        let muxed = content.iter().find(|m| m.name == "MuxedMsg").unwrap();
        let switch = muxed.signals.iter().find(|s| s.name == "Mux").unwrap();
        assert_eq!(switch.mux, SignalMux::Multiplexor);
        let mode0 = muxed.signals.iter().find(|s| s.name == "Mode0Field").unwrap();
        assert_eq!(mode0.mux, SignalMux::Multiplexed { selector: 0 });
        let always = muxed.signals.iter().find(|s| s.name == "Always").unwrap();
        assert_eq!(always.mux, SignalMux::Plain);
    }

    #[test]
    fn dbc_content_carries_float_kind_from_sig_valtype() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let content = db.dbc_content();
        let floats = content.iter().find(|m| m.name == "FloatMsg").unwrap();
        let lat = floats.signals.iter().find(|s| s.name == "Lat").unwrap();
        // Lat is declared `SIG_VALTYPE_ 513 Lat : 1;` in SAMPLE_DBC.
        assert_eq!(lat.float_kind, FloatKind::Float32);
        let alt = floats.signals.iter().find(|s| s.name == "Alt").unwrap();
        // Alt has no SIG_VALTYPE_ entry — falls through to integer.
        assert_eq!(alt.float_kind, FloatKind::Integer);
    }

    #[test]
    fn dbc_content_uses_long_symbol_names() {
        // LONG_SYMBOL_DBC is defined for the existing
        // `resolves_long_symbol_message_and_signal_names` test.
        let db = Database::parse(LONG_SYMBOL_DBC).unwrap();
        let content = db.dbc_content();
        assert_eq!(content.len(), 1);
        assert_eq!(
            content[0].name,
            "AVeryLongMessageNameThatExceedsThirtyTwoChars",
        );
        assert_eq!(content[0].signals.len(), 1);
        assert_eq!(
            content[0].signals[0].name,
            "AVeryLongSignalNameThatExceedsThirtyTwoChars",
        );
    }

    /// Two messages, one with a named transmitter and one with the
    /// `Vector__XXX` "no sender" placeholder — the discovery tree's
    /// per-ECU grouping needs to distinguish them.
    const TRANSMITTER_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU1

BO_ 256 Sent: 8 ECU1
 SG_ A : 0|8@1+ (1,0) [0|0] "" ECU1

BO_ 257 Orphan: 8 Vector__XXX
 SG_ B : 0|8@1+ (1,0) [0|0] "" ECU1
"#;

    #[test]
    fn dbc_content_carries_the_transmitter() {
        let db = Database::parse(TRANSMITTER_DBC).unwrap();
        let content = db.dbc_content();
        let sent = content.iter().find(|m| m.name == "Sent").unwrap();
        assert_eq!(sent.transmitter.as_deref(), Some("ECU1"));
        // The `Vector__XXX` placeholder means "no sender", not an ECU
        // named Vector__XXX.
        let orphan = content.iter().find(|m| m.name == "Orphan").unwrap();
        assert_eq!(orphan.transmitter, None);
    }

    #[test]
    fn signals_carry_the_transmitter() {
        let db = Database::parse(TRANSMITTER_DBC).unwrap();
        let sigs = db.signals();
        let a = sigs.iter().find(|s| s.signal_name == "A").unwrap();
        assert_eq!(a.transmitter.as_deref(), Some("ECU1"));
        let b = sigs.iter().find(|s| s.signal_name == "B").unwrap();
        assert_eq!(b.transmitter, None);
    }

    #[test]
    fn signals_carry_the_mux_selector() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        let sigs = db.signals();
        let sel = |name: &str| sigs.iter().find(|s| s.signal_name == name).unwrap().mux_selector;
        // Multiplexed signals carry their selector group; the
        // multiplexor itself and plain signals carry none.
        assert_eq!(sel("Mode0Field"), Some(0));
        assert_eq!(sel("Mode1Field"), Some(1));
        assert_eq!(sel("Mux"), None);
        assert_eq!(sel("Always"), None);
        assert_eq!(sel("EngineSpeed"), None);
    }

    #[test]
    fn decode_mux_selector_reads_only_the_multiplexor() {
        let db = Database::parse(SAMPLE_DBC).unwrap();
        assert!(db.has_multiplexor());
        assert!(!Database::parse(TRANSMITTER_DBC).unwrap().has_multiplexor());
        let id = cannet_core::CanId::standard(512).unwrap();
        assert_eq!(db.decode_mux_selector(id, &[0, 0xAA, 0xBB, 0, 0, 0, 0, 0]), Some(0));
        assert_eq!(db.decode_mux_selector(id, &[1, 0x12, 0x34, 0, 0, 0, 0, 0]), Some(1));
        // A message without a multiplexor has no selector.
        let plain = cannet_core::CanId::standard(256).unwrap();
        assert_eq!(db.decode_mux_selector(plain, &[0; 8]), None);
        // Unknown id / payload too short for the multiplexor: None.
        let unknown = cannet_core::CanId::standard(0x600).unwrap();
        assert_eq!(db.decode_mux_selector(unknown, &[0; 8]), None);
        assert_eq!(db.decode_mux_selector(id, &[]), None);
    }

    #[test]
    fn decode_carries_the_transmitter() {
        let db = Database::parse(TRANSMITTER_DBC).unwrap();
        let sent = db.decode(&make_frame(256, false, vec![0; 8])).unwrap();
        assert_eq!(sent.transmitter, Some("ECU1"));
        // `Vector__XXX` means "no sender", not an ECU named Vector__XXX.
        let orphan = db.decode(&make_frame(257, false, vec![0; 8])).unwrap();
        assert_eq!(orphan.transmitter, None);
    }

    /// Fixture exercising the ADR 0027 attribute surface: cannet
    /// calculated-field designations plus the Gen* attributes the
    /// transmit path consumes.
    const CALC_ATTR_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU1 GW

BO_ 291 Status: 8 ECU1
 SG_ Mode : 0|8@1+ (1,0) [0|255] "" GW
 SG_ Volts : 8|16@1+ (0.01,0) [0|655.35] "V" GW
 SG_ AliveCtr : 48|4@1+ (1,0) [0|15] "" GW
 SG_ Crc8 : 56|8@1+ (1,0) [0|255] "" GW

BA_DEF_ SG_ "CannetCounter" STRING ;
BA_DEF_ SG_ "CannetCrc" STRING ;
BA_DEF_ SG_ "GenSigStartValue" FLOAT 0 100000;
BA_DEF_ BO_ "GenMsgSendType" ENUM "Cyclic","OnEvent","NoMsgSendType";
BA_DEF_DEF_ "CannetCounter" "";
BA_DEF_DEF_ "CannetCrc" "";
BA_DEF_DEF_ "GenSigStartValue" 0;
BA_DEF_DEF_ "GenMsgSendType" "NoMsgSendType";
BA_ "CannetCounter" SG_ 291 AliveCtr "increment=1;rollover=15";
BA_ "CannetCrc" SG_ 291 Crc8 "alg=CRC-8/SAE-J1850;range=0:56;prefix=A3";
BA_ "GenMsgSendType" BO_ 291 0;
BA_ "GenSigStartValue" SG_ 291 Mode 5;
BA_ "GenSigStartValue" SG_ 291 Volts 1250;
"#;

    #[test]
    fn cannet_attributes_become_the_dbc_default_calc_fields() {
        let db = Database::parse(CALC_ATTR_DBC).unwrap();
        assert!(db.parse_warnings().is_empty(), "{:?}", db.parse_warnings());
        let id = CanId::standard(291).unwrap();
        let config = db.dbc_calculated_fields(id).unwrap();
        assert_eq!(
            config.counter,
            Some(CounterConfig {
                signal: "AliveCtr".into(),
                increment: 1,
                rollover: Some(15),
            })
        );
        assert_eq!(
            config.crc,
            Some(CrcConfig {
                signal: "Crc8".into(),
                algorithm: CrcAlgorithm::Named("CRC-8/SAE-J1850".into()),
                range_bits: (0, 56),
                prefix: vec![0xA3],
            })
        );
        // The declared config resolves and applies cleanly.
        let resolved = db.resolve_calculated_fields(id, config).unwrap();
        let mut payload = [0u8; 8];
        let mut counter = 0;
        resolved.apply(&mut counter, &mut payload).unwrap();
        assert_eq!(counter, 1);
        // No designation on an id without the attributes; unknown id
        // is None.
        assert!(db
            .dbc_calculated_fields(CanId::standard(999).unwrap())
            .is_none());
    }

    #[test]
    fn gen_sig_start_value_and_send_type_have_typed_accessors() {
        let db = Database::parse(CALC_ATTR_DBC).unwrap();
        let desc = db.describe_message(CanId::standard(291).unwrap()).unwrap();
        // ENUM-typed GenMsgSendType value 0 resolves to its label.
        assert_eq!(desc.gen_msg_send_type.as_deref(), Some("Cyclic"));
        assert_eq!(desc.calc_fields.counter.as_ref().unwrap().signal, "AliveCtr");
        let start = |name: &str| {
            desc.signals
                .iter()
                .find(|s| s.name == name)
                .unwrap()
                .start_value_raw
        };
        // Raw units, verbatim — Volts' physical default is
        // 1250 * 0.01 = 12.5 V, derived by the consumer.
        assert_eq!(start("Mode"), Some(5.0));
        assert_eq!(start("Volts"), Some(1250.0));
        assert_eq!(start("AliveCtr"), None);
    }

    #[test]
    fn malformed_and_duplicate_designations_warn_but_load() {
        let dbc = CALC_ATTR_DBC.replace(
            r#"BA_ "CannetCounter" SG_ 291 AliveCtr "increment=1;rollover=15";"#,
            concat!(
                r#"BA_ "CannetCounter" SG_ 291 AliveCtr "rolover=15";"#,
                "\n",
                r#"BA_ "CannetCounter" SG_ 291 Mode "increment=2";"#,
                "\n",
                r#"BA_ "CannetCounter" SG_ 291 Volts "increment=3";"#,
            ),
        );
        let db = Database::parse(&dbc).unwrap();
        let id = CanId::standard(291).unwrap();
        let config = db.dbc_calculated_fields(id).unwrap();
        // The malformed AliveCtr value warns; the first good
        // designation (Mode, in SG_ declared order) wins; the second
        // good one (Volts) warns as a duplicate.
        assert_eq!(config.counter.as_ref().unwrap().signal, "Mode");
        assert_eq!(config.counter.as_ref().unwrap().increment, 2);
        let warnings = db.parse_warnings();
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(warnings.iter().any(|w| w.contains("bad CannetCounter")));
        assert!(warnings.iter().any(|w| w.contains("second CannetCounter")));
        // CRC unaffected.
        assert!(config.crc.is_some());
    }

    /// The shipped demo DBC carries hand-authored calculated-field
    /// examples (`BmsCommand`) — guard that they stay parseable and
    /// resolvable.
    #[test]
    fn demo_dbc_calculated_field_examples_resolve() {
        let text = include_str!("../../../examples/cannet-demo.dbc");
        let db = Database::parse(text).unwrap();
        assert!(db.parse_warnings().is_empty(), "{:?}", db.parse_warnings());
        let id = CanId::standard(1042).unwrap();
        let config = db.dbc_calculated_fields(id).unwrap();
        assert!(config.counter.is_some() && config.crc.is_some());
        db.resolve_calculated_fields(id, config).unwrap();
        let desc = db.describe_message(id).unwrap();
        assert_eq!(desc.gen_msg_send_type.as_deref(), Some("Cyclic"));
        assert_eq!(desc.gen_msg_cycle_time_ms, Some(100));
        assert_eq!(desc.transmitter.as_deref(), Some("ECU2"));
        let contactor = desc.signals.iter().find(|s| s.name == "ContactorReq").unwrap();
        assert_eq!(contactor.start_value_raw, Some(2.0));
    }
}
