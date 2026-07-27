//! Bit-level encode primitives — the inverse of [`crate::decode`]. Used
//! by [`crate::Database::encode_frame`] to write a signal's bits into a
//! payload buffer without disturbing any other bits.

use can_dbc::ByteOrder;

use crate::bitwalk;

/// Write the low `size` bits of `value` into `data` starting at
/// `start_bit`, in DBC `byte_order`. Bits outside the `[start_bit,
/// start_bit + size)` window are preserved. Returns `None` (and does
/// not mutate `data`) if any required bit lies past the end of `data`,
/// or if `size` is `0` / `> 64`.
///
/// See [`bitwalk::walk`] for the DBC bit numbering convention (shared
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
