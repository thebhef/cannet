//! Frame encoding — the inverse of [`crate::decode`]: the bit-level
//! `encode_signal_bits` primitive, the physical→raw conversion, and the
//! `Database::encode_frame` entry point that writes named signals into a
//! payload buffer without disturbing any other bits.

use can_dbc::{ByteOrder, Signal, SignalExtendedValueType, ValueType};

use crate::bitwalk;
use crate::model::{canid_to_message_id, Database, MessageEntry};

/// Write the low `size` bits of `value` into `data` starting at
/// `start_bit`, in DBC `byte_order`. Bits outside the `[start_bit,
/// start_bit + size)` window are preserved. Returns `None` (and does
/// not mutate `data`) if any required bit lies past the end of `data`,
/// or if `size` is `0` / `> 64`.
///
/// See `bitwalk::walk` for the DBC bit numbering convention (shared
/// with [`crate::decode_signal_bits`]).
pub fn encode_signal_bits(
    data: &mut [u8],
    start_bit: usize,
    size: usize,
    value: u64,
    byte_order: ByteOrder,
) -> Option<()> {
    let positions = bitwalk::walk(start_bit, size, byte_order)?;
    // Bounds-check every position up front so a partial write can't
    // leave the buffer in a half-mutated state.
    if positions.iter().any(|pos| pos.byte_idx >= data.len()) {
        return None;
    }
    for pos in positions {
        let bit = u8::try_from((value >> pos.value_bit) & 1).ok()?;
        let mask: u8 = 1u8 << pos.bit_in_byte;
        data[pos.byte_idx] = (data[pos.byte_idx] & !mask) | (bit << pos.bit_in_byte);
    }
    Some(())
}

impl Database {
    /// Partial-encode `signals` into `base`. For each `(name, physical)`
    /// pair, looks up the signal by name on the message addressed by
    /// `id`, converts the physical value back to its raw bit pattern
    /// (`(physical - offset) / factor`, rounded; IEEE float signals take
    /// the f32 / f64 bit pattern directly), and writes those bits into
    /// `base` at the signal's `start_bit / size / byte_order`. All other
    /// bits in `base` are preserved.
    ///
    /// The encoder is the inverse of [`Database::decode`] in the strong
    /// sense: for every signal in the database, encoding a decoded
    /// `physical` value back into a zeroed buffer (then decoding)
    /// round-trips to the same physical (modulo rounding and f32
    /// precision for `SIG_VALTYPE_ 1` signals).
    ///
    /// Returns `None` if no message matches `id`. Otherwise returns an
    /// [`EncodeReport`] with one entry per signal — `written` for the
    /// successful encodes, `skipped` for the ones that couldn't fit the
    /// payload or whose name didn't resolve. Skipped signals leave
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

    if encode_signal_bits(data, start_bit, size_usize, raw_unsigned, sig.byte_order).is_none() {
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
    use crate::decode_signal_bits;

    #[test]
    fn little_endian_byte_aligned_round_trip() {
        let mut data = [0u8; 4];
        encode_signal_bits(&mut data, 0, 16, 0xCDAB, ByteOrder::LittleEndian).unwrap();
        assert_eq!(data, [0xAB, 0xCD, 0x00, 0x00]);
        assert_eq!(
            decode_signal_bits(&data, 0, 16, ByteOrder::LittleEndian),
            Some(0xCDAB)
        );
    }

    #[test]
    fn little_endian_preserves_neighbouring_bits() {
        // Pre-existing bits outside the [2, 6) window must survive
        // the write — bit 0, bit 1, bit 6, bit 7 of byte 0 stay 1.
        let mut data = [0b1100_0011_u8];
        encode_signal_bits(&mut data, 2, 4, 0b1010, ByteOrder::LittleEndian).unwrap();
        assert_eq!(data, [0b1110_1011]);
    }

    #[test]
    fn little_endian_crossing_byte_boundary() {
        let mut data = [0u8; 2];
        encode_signal_bits(&mut data, 4, 8, 0xFF, ByteOrder::LittleEndian).unwrap();
        assert_eq!(data, [0xF0, 0x0F]);
        assert_eq!(
            decode_signal_bits(&data, 4, 8, ByteOrder::LittleEndian),
            Some(0xFF)
        );
    }

    #[test]
    fn big_endian_full_byte_round_trip() {
        let mut data = [0u8; 1];
        encode_signal_bits(&mut data, 7, 8, 0xAB, ByteOrder::BigEndian).unwrap();
        assert_eq!(data, [0xAB]);
        assert_eq!(
            decode_signal_bits(&data, 7, 8, ByteOrder::BigEndian),
            Some(0xAB)
        );
    }

    #[test]
    fn big_endian_two_bytes_round_trip() {
        let mut data = [0u8; 2];
        encode_signal_bits(&mut data, 7, 16, 0x1234, ByteOrder::BigEndian).unwrap();
        assert_eq!(data, [0x12, 0x34]);
        assert_eq!(
            decode_signal_bits(&data, 7, 16, ByteOrder::BigEndian),
            Some(0x1234)
        );
    }

    #[test]
    fn big_endian_partial_byte_crossing_round_trip() {
        // Mirrors the matching decode test: start_bit=3, size=8.
        let mut data = [0u8; 2];
        encode_signal_bits(&mut data, 3, 8, 0xFF, ByteOrder::BigEndian).unwrap();
        assert_eq!(
            decode_signal_bits(&data, 3, 8, ByteOrder::BigEndian),
            Some(0xFF)
        );
        // Bits inside the window are 1; everything else stays 0.
        // Walked positions (byte_idx, bit_in_byte):
        //   byte 0: bits 3,2,1,0 = 0b0000_1111
        //   byte 1: bits 7,6,5,4 = 0b1111_0000
        assert_eq!(data, [0b0000_1111, 0b1111_0000]);
    }

    #[test]
    fn out_of_range_refuses_atomically() {
        let mut data = [0xFFu8; 1];
        let before = data;
        // 16 LE bits at offset 0 would need 2 bytes; only have 1.
        assert_eq!(
            encode_signal_bits(&mut data, 0, 16, 0, ByteOrder::LittleEndian),
            None,
        );
        assert_eq!(data, before, "buffer must be untouched on rejection");

        // Same for big-endian.
        let before = data;
        assert_eq!(
            encode_signal_bits(&mut data, 7, 16, 0, ByteOrder::BigEndian),
            None,
        );
        assert_eq!(data, before, "buffer must be untouched on rejection");
    }

    #[test]
    fn zero_or_too_many_bits_returns_none() {
        let mut data = [0xFFu8; 16];
        assert_eq!(
            encode_signal_bits(&mut data, 0, 0, 0, ByteOrder::LittleEndian),
            None
        );
        assert_eq!(
            encode_signal_bits(&mut data, 0, 65, 0, ByteOrder::LittleEndian),
            None
        );
    }
}
