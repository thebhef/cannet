//! Runtime frame decoding: the bit-level primitives (`decode_signal_bits`
//! / `sign_extend`), the per-message / per-signal decode walk, the
//! decoded-value types, and the `Database` decode entry points.

use can_dbc::{ByteOrder, MultiplexIndicator, SignalExtendedValueType, ValueType};
use cannet_core::CanFrame;

use crate::bitwalk;
use crate::model::{
    canid_to_message_id, is_enum, value_is_raw_integer, Database, MessageEntry, SignalEntry,
};
use crate::view_builders::{
    float_kind_from_extended, signal_mux_from_indicator, FloatKind, SignalMux,
};

/// Extract `size` bits from `data` starting at `start_bit`, interpreting
/// the layout per `byte_order`. Returns `None` if any required bit lies
/// past the end of `data`.
///
/// See `bitwalk::walk` for the DBC bit numbering convention.
pub fn decode_signal_bits(
    data: &[u8],
    start_bit: usize,
    size: usize,
    byte_order: ByteOrder,
) -> Option<u64> {
    let positions = bitwalk::walk(start_bit, size, byte_order)?;
    let mut value: u64 = 0;
    for pos in positions {
        let byte = *data.get(pos.byte_idx)?;
        let bit = u64::from((byte >> pos.bit_in_byte) & 1);
        value |= bit << pos.value_bit;
    }
    Some(value)
}

/// Sign-extend `value` from a `bits`-wide unsigned representation to a
/// signed 64-bit value. `bits` must be in 1..=64.
pub fn sign_extend(value: u64, bits: u32) -> i64 {
    debug_assert!((1..=64).contains(&bits));
    if bits == 64 {
        return value.cast_signed();
    }
    let sign_bit = 1u64 << (bits - 1);
    if value & sign_bit == 0 {
        value.cast_signed()
    } else {
        // Set every bit above the value's range to extend the sign.
        let extension = u64::MAX << bits;
        (value | extension).cast_signed()
    }
}

impl Database {
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

    /// Every **decode spec** this database offers for `signal_name` in
    /// the message `id` addresses, in `SG_` declaration order — the
    /// inputs `decode_signal` reads, and nothing else.
    ///
    /// This is the question "would this signal decode differently?"
    /// asked without decoding: a consumer that caches decoded samples
    /// can compare specs to tell an edit that changes its samples from
    /// one that changes only how they are labelled or described. What is
    /// deliberately *absent* is everything `decode_signal` never reads —
    /// the `VAL_` table (labels are resolved where they are displayed),
    /// the unit, the comment, the declared range, the `BO_` declared
    /// length (bit extraction bounds-checks the payload it is given, not
    /// the declaration), and every `BA_` attribute that isn't
    /// `SIG_VALTYPE_` or a long-symbol rename.
    ///
    /// A **vector**, not an `Option`, for the two reasons resolution is
    /// not a single lookup: a message may declare the same signal name
    /// more than once (in different multiplexor arms), and
    /// `decode_message` picks between them per payload. Empty when
    /// this database has no such message, or the message has no such
    /// signal — the caller then knows this database contributes nothing
    /// to that signal's decode.
    #[must_use]
    pub fn signal_decode_specs(
        &self,
        id: cannet_core::CanId,
        signal_name: &str,
    ) -> Vec<SignalDecodeSpec> {
        let Some(key) = canid_to_message_id(id) else {
            return Vec::new();
        };
        let Some(entry) = self.messages.get(&key) else {
            return Vec::new();
        };
        // The gate `decode_message` actually uses: the *first* signal
        // declared `Multiplexor`. A `MultiplexorAndMultiplexedSignal`
        // does not match that arm there, so it must not match here.
        let gate = entry
            .signals
            .iter()
            .find(|s| {
                matches!(
                    s.signal.multiplexer_indicator,
                    MultiplexIndicator::Multiplexor
                )
            })
            .map(|s| MuxGate {
                start_bit: s.signal.start_bit,
                size: s.signal.size,
                big_endian: s.signal.byte_order == ByteOrder::BigEndian,
            });
        entry
            .signals
            .iter()
            .filter(|s| s.signal.name == signal_name)
            .map(|s| SignalDecodeSpec {
                start_bit: s.signal.start_bit,
                size: s.signal.size,
                big_endian: s.signal.byte_order == ByteOrder::BigEndian,
                signed: s.signal.value_type == ValueType::Signed,
                factor: s.signal.factor,
                offset: s.signal.offset,
                float_kind: float_kind_from_extended(s.extended_type),
                mux: signal_mux_from_indicator(s.signal.multiplexer_indicator),
                mux_gate: match s.signal.multiplexer_indicator {
                    MultiplexIndicator::MultiplexedSignal(_)
                    | MultiplexIndicator::MultiplexorAndMultiplexedSignal(_) => gate,
                    // A plain signal and the multiplexor itself are in
                    // every frame of the message whatever the gate says,
                    // so the gate is not an input to their decode.
                    MultiplexIndicator::Plain | MultiplexIndicator::Multiplexor => None,
                },
            })
            .collect()
    }

    /// Decode just the multiplexor-selector value from `(id, data)` —
    /// a couple of bit operations, cheap enough for a per-frame append
    /// path. Returns `None` when no message matches `id`, the message
    /// has no multiplexor, or the payload is too short to carry it.
    /// Pairs with [`crate::SignalDescriptor::mux_selector`]: a frame carries a
    /// multiplexed signal iff this value equals the signal's group.
    #[must_use]
    pub fn decode_mux_selector(&self, id: cannet_core::CanId, data: &[u8]) -> Option<u64> {
        let key = canid_to_message_id(id)?;
        let entry = self.messages.get(&key)?;
        let mux = entry.signals.get(entry.multiplexor?)?;
        decode_signal(mux, data).map(|d| d.raw_unsigned)
    }
}

fn decode_message<'a>(entry: &'a MessageEntry, data: &[u8]) -> DecodedMessage<'a> {
    // First pass: find the multiplexor signal value, if any, so we can
    // filter multiplexed signals to the matching selector.
    let multiplexor_value = entry
        .signals
        .iter()
        .find(|s| {
            matches!(
                s.signal.multiplexer_indicator,
                MultiplexIndicator::Multiplexor
            )
        })
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
        transmitter: entry.transmitter.as_deref(),
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
        value_is_raw_integer: value_is_raw_integer(entry),
        is_enum: is_enum(&entry.value_table),
        display_hex: entry.display_hex,
        label,
    })
}

/// What one signal's decode reads, and nothing else — the output of
/// [`Database::signal_decode_specs`].
///
/// Every field here appears in `decode_signal`: the four that place and
/// interpret the bits (`start_bit`, `size`, `big_endian`, `signed`), the
/// two that scale them (`factor`, `offset`), the `SIG_VALTYPE_` override
/// that replaces "scaled integer" with an IEEE bit pattern
/// (`float_kind`), and the two that decide whether the signal is in a
/// given frame at all (`mux`, `mux_gate`). Two signals with equal specs
/// decode any payload to the same physical value.
#[derive(Debug, Clone, PartialEq)]
pub struct SignalDecodeSpec {
    /// `SG_` start bit, in the DBC's own bit numbering (see
    /// `bitwalk::walk`).
    pub start_bit: u64,
    /// Signal width in bits.
    pub size: u64,
    /// `@0` (big-endian / Motorola) rather than `@1`.
    pub big_endian: bool,
    /// `-` (two's-complement) rather than `+`.
    pub signed: bool,
    pub factor: f64,
    pub offset: f64,
    /// `SIG_VALTYPE_` override. Carried verbatim as declared: it only
    /// takes effect when it agrees with `size` (32 / 64), and `size` is
    /// right here to say whether it does.
    pub float_kind: FloatKind,
    /// The signal's own multiplexor indicator and, for a multiplexed
    /// signal, the selector value that admits it.
    pub mux: SignalMux,
    /// The message's multiplexor gate — present only when `mux` makes
    /// this signal conditional on it.
    pub mux_gate: Option<MuxGate>,
}

/// The bits a multiplexed signal's gate is read from: what its owning
/// message's multiplexor signal extracts, which is what
/// `decode_message` compares the signal's selector against.
///
/// Only the three extraction inputs, because the comparison is against
/// the multiplexor's `raw_unsigned` — its scaling, sign and value table
/// change nothing about which arm a frame carries. Its *name* is absent
/// for the same reason: the gate is found by indicator, not by name, so
/// renaming a multiplexor re-decodes nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MuxGate {
    pub start_bit: u64,
    pub size: u64,
    pub big_endian: bool,
}

/// A decoded CAN message: the message's name, its declared and observed
/// payload lengths, and one entry per signal that fit the payload.
#[derive(Debug, Clone)]
pub struct DecodedMessage<'a> {
    pub name: &'a str,
    /// The owning message's `BO_` transmitting node, or `None` for the
    /// `Vector__XXX` "no sender" placeholder — same convention as
    /// [`crate::SignalDescriptor::transmitter`].
    pub transmitter: Option<&'a str>,
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
    /// True when `value` is exactly the raw integer — the signal is
    /// integer-typed (no `SIG_VALTYPE_` float override for its width)
    /// and the DBC declares `factor == 1` with `offset == 0`, so no
    /// scaling was applied. Consumers use it to tell a bit pattern /
    /// id / serial from a scaled measurement — combined with `unit` and
    /// `is_enum` through [`crate::is_raw_field`]. The catalog-side twin
    /// is [`SignalDescriptor::value_is_raw_integer`], from the same
    /// internal predicate.
    ///
    /// [`SignalDescriptor::value_is_raw_integer`]: crate::SignalDescriptor::value_is_raw_integer
    pub value_is_raw_integer: bool,
    /// True when the signal's `VAL_` table makes it an enum — per
    /// [`crate::is_enum`], at least two members. A single-member table
    /// (an SNA sentinel on an otherwise numeric signal) leaves this
    /// false; `label` still resolves on an exact raw match.
    pub is_enum: bool,
    /// The DBC asks for this signal's value to render as a bit pattern
    /// — `CannetDisplay "radix=hex"` on a signal that is a raw field
    /// (ADR 0043). False is the default: a raw integer reads base 10
    /// unless its DBC says otherwise. The catalog-side twin is
    /// [`SignalDescriptor::display_hex`].
    ///
    /// [`SignalDescriptor::display_hex`]: crate::SignalDescriptor::display_hex
    pub display_hex: bool,
    pub label: Option<&'a str>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn little_endian_byte_aligned() {
        let data = [0xAB, 0xCD, 0xEF, 0x01];
        // 16 bits starting at bit 0 → first two bytes as u16
        assert_eq!(
            decode_signal_bits(&data, 0, 16, ByteOrder::LittleEndian),
            Some(0xCDAB)
        );
    }

    #[test]
    fn little_endian_offset_in_byte() {
        let data = [0b1011_0100, 0b0000_0011];
        // 4 bits starting at bit 2 → bits 2..6 of byte 0 = 0b1101 = 13
        assert_eq!(
            decode_signal_bits(&data, 2, 4, ByteOrder::LittleEndian),
            Some(0b1101)
        );
    }

    #[test]
    fn little_endian_crossing_byte_boundary() {
        let data = [0xF0, 0x0F];
        // 8 bits starting at bit 4 → upper nibble of byte 0 + lower nibble of byte 1
        assert_eq!(
            decode_signal_bits(&data, 4, 8, ByteOrder::LittleEndian),
            Some(0xFF)
        );
    }

    #[test]
    fn big_endian_full_byte() {
        let data = [0xAB];
        // 8 bits starting at bit 7 (MSB of byte 0)
        assert_eq!(
            decode_signal_bits(&data, 7, 8, ByteOrder::BigEndian),
            Some(0xAB)
        );
    }

    #[test]
    fn big_endian_two_bytes() {
        let data = [0x12, 0x34];
        assert_eq!(
            decode_signal_bits(&data, 7, 16, ByteOrder::BigEndian),
            Some(0x1234)
        );
    }

    #[test]
    fn big_endian_partial_byte_crossing() {
        // start_bit=3, size=8. Big-endian walks: bit 3, 2, 1, 0 of byte 0,
        // then bit 7, 6, 5, 4 of byte 1. With byte 0 = 0b0000_1111
        // (bits 0..3 set, bits 4..7 clear) and byte 1 = 0b1111_0000
        // (bits 4..7 set, bits 0..3 clear), the walk reads:
        //   bit3=1, bit2=1, bit1=1, bit0=1 (from byte 0, MSBs of result),
        //   bit7=1, bit6=1, bit5=1, bit4=1 (from byte 1, LSBs of result)
        // → 0b1111_1111 = 0xFF.
        let data = [0b0000_1111, 0b1111_0000];
        assert_eq!(
            decode_signal_bits(&data, 3, 8, ByteOrder::BigEndian),
            Some(0xFF)
        );
    }

    #[test]
    fn out_of_range_returns_none() {
        let data = [0xFF];
        assert_eq!(
            decode_signal_bits(&data, 0, 16, ByteOrder::LittleEndian),
            None
        );
        assert_eq!(decode_signal_bits(&data, 7, 16, ByteOrder::BigEndian), None);
    }

    #[test]
    fn zero_or_too_many_bits_returns_none() {
        let data = [0xFF; 16];
        assert_eq!(
            decode_signal_bits(&data, 0, 0, ByteOrder::LittleEndian),
            None
        );
        assert_eq!(
            decode_signal_bits(&data, 0, 65, ByteOrder::LittleEndian),
            None
        );
    }

    #[test]
    fn sign_extend_positive() {
        assert_eq!(sign_extend(0x7F, 8), 127);
    }

    #[test]
    fn sign_extend_negative_8bit() {
        assert_eq!(sign_extend(0xFF, 8), -1);
        assert_eq!(sign_extend(0x80, 8), -128);
    }

    #[test]
    fn sign_extend_64bit_passthrough() {
        assert_eq!(sign_extend(u64::MAX, 64), -1_i64);
    }

    #[test]
    fn sign_extend_16bit() {
        assert_eq!(sign_extend(0xFFFE, 16), -2);
    }
}
