//! Bit-level decode primitives shared between unit tests and the public
//! `Database::decode` path.

use can_dbc::ByteOrder;

/// Extract `size` bits from `data` starting at `start_bit`, interpreting
/// the layout per `byte_order`. Returns `None` if any required bit lies
/// past the end of `data`.
///
/// The DBC bit numbering convention: within a byte, bit 0 is the LSB and
/// bit 7 is the MSB; bytes go in increasing index. For little-endian
/// signals the bits run upward starting at `start_bit`. For big-endian
/// signals (Vector / Motorola convention), `start_bit` is the MSB of the
/// signal: subsequent bits run downward within the same byte until the
/// LSB, then jump to the MSB (bit 7) of the next byte.
pub fn decode_signal_bits(
    data: &[u8],
    start_bit: usize,
    size: usize,
    byte_order: ByteOrder,
) -> Option<u64> {
    if size == 0 || size > 64 {
        return None;
    }
    match byte_order {
        ByteOrder::LittleEndian => decode_little_endian(data, start_bit, size),
        ByteOrder::BigEndian => decode_big_endian(data, start_bit, size),
    }
}

fn decode_little_endian(data: &[u8], start_bit: usize, size: usize) -> Option<u64> {
    let mut value: u64 = 0;
    for i in 0..size {
        let bit_index = start_bit.checked_add(i)?;
        let byte_idx = bit_index / 8;
        let bit_in_byte = bit_index % 8;
        let byte = *data.get(byte_idx)?;
        let bit = u64::from((byte >> bit_in_byte) & 1);
        value |= bit << i;
    }
    Some(value)
}

fn decode_big_endian(data: &[u8], start_bit: usize, size: usize) -> Option<u64> {
    let mut value: u64 = 0;
    let mut bit = start_bit;
    for _ in 0..size {
        let byte_idx = bit / 8;
        let bit_in_byte = bit % 8;
        let byte = *data.get(byte_idx)?;
        let extracted = u64::from((byte >> bit_in_byte) & 1);
        value = (value << 1) | extracted;
        // Walk to the next bit in DBC big-endian (Motorola sequential)
        // order: drop one bit within the byte, but on byte-boundary jump
        // forward to the MSB (bit 7) of the next byte.
        if bit_in_byte == 0 {
            bit = bit.checked_add(15)?;
        } else {
            bit -= 1;
        }
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
