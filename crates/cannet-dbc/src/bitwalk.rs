//! The shared bit-position walker behind [`crate::decode_signal_bits`],
//! [`crate::encode_signal_bits`], and `calc.rs`'s destination-byte
//! occupancy check — one definition of the DBC bit-numbering convention
//! (see [`walk`]'s doc) instead of the little/big-endian stepping
//! recurrence copy-pasted at each call site.

use can_dbc::ByteOrder;

/// One physical bit touched by a signal's layout: `byte_idx`/`bit_in_byte`
/// is where it lives in the payload; `value_bit` is which bit of the
/// *signal value* (0 = LSB) it holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BitPos {
    pub byte_idx: usize,
    pub bit_in_byte: u8,
    pub value_bit: u32,
}

/// Walk `size` bits starting at `start_bit` in DBC `byte_order`,
/// returning each touched position in signal-value-bit order (index 0
/// first). Returns `None` if `size` is `0`/`>64` or a position's bit
/// index overflows `usize`.
///
/// The DBC bit numbering convention: within a byte, bit 0 is the LSB
/// and bit 7 is the MSB; bytes go in increasing index. For
/// little-endian signals the bits run upward starting at `start_bit`
/// (value bit `i` sits at `start_bit + i`). For big-endian signals
/// (Vector / Motorola convention), `start_bit` is the MSB of the
/// signal: subsequent bits run downward within the same byte until the
/// LSB, then jump to the MSB (bit 7) of the next byte; the first
/// position walked holds the *most*-significant value bit.
// Safe — `size` is capped at 64 below, so `bit_in_byte` (< 8) fits `u8`
// and both `i` and `size - 1 - i` (< 64) fit `u32`.
#[allow(clippy::cast_possible_truncation)]
pub(crate) fn walk(start_bit: usize, size: usize, byte_order: ByteOrder) -> Option<Vec<BitPos>> {
    if size == 0 || size > 64 {
        return None;
    }
    let mut positions = Vec::with_capacity(size);
    match byte_order {
        ByteOrder::LittleEndian => {
            for i in 0..size {
                let bit_index = start_bit.checked_add(i)?;
                positions.push(BitPos {
                    byte_idx: bit_index / 8,
                    bit_in_byte: (bit_index % 8) as u8,
                    value_bit: i as u32,
                });
            }
        }
        ByteOrder::BigEndian => {
            let mut bit = start_bit;
            for i in 0..size {
                let bit_in_byte = bit % 8;
                positions.push(BitPos {
                    byte_idx: bit / 8,
                    bit_in_byte: bit_in_byte as u8,
                    value_bit: (size - 1 - i) as u32,
                });
                // Walk to the next bit in DBC big-endian (Motorola
                // sequential) order: drop one bit within the byte, but
                // on byte-boundary jump forward to the MSB (bit 7) of
                // the next byte.
                if bit_in_byte == 0 {
                    bit = bit.checked_add(15)?;
                } else {
                    bit -= 1;
                }
            }
        }
    }
    Some(positions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn little_endian_positions_run_upward_from_start_bit() {
        let positions = walk(2, 4, ByteOrder::LittleEndian).unwrap();
        assert_eq!(
            positions,
            vec![
                BitPos {
                    byte_idx: 0,
                    bit_in_byte: 2,
                    value_bit: 0
                },
                BitPos {
                    byte_idx: 0,
                    bit_in_byte: 3,
                    value_bit: 1
                },
                BitPos {
                    byte_idx: 0,
                    bit_in_byte: 4,
                    value_bit: 2
                },
                BitPos {
                    byte_idx: 0,
                    bit_in_byte: 5,
                    value_bit: 3
                },
            ]
        );
    }

    #[test]
    fn big_endian_first_position_holds_the_msb() {
        // start_bit=3, size=8: matches the decode/encode partial-byte-
        // crossing tests (bit3,2,1,0 of byte 0, then bit7..4 of byte 1).
        let positions = walk(3, 8, ByteOrder::BigEndian).unwrap();
        assert_eq!(
            positions[0],
            BitPos {
                byte_idx: 0,
                bit_in_byte: 3,
                value_bit: 7
            }
        );
        assert_eq!(
            positions[7],
            BitPos {
                byte_idx: 1,
                bit_in_byte: 4,
                value_bit: 0
            }
        );
    }

    #[test]
    fn zero_or_too_many_bits_returns_none() {
        assert_eq!(walk(0, 0, ByteOrder::LittleEndian), None);
        assert_eq!(walk(0, 65, ByteOrder::LittleEndian), None);
        assert_eq!(walk(0, 0, ByteOrder::BigEndian), None);
        assert_eq!(walk(0, 65, ByteOrder::BigEndian), None);
    }

    #[test]
    fn overflow_returns_none() {
        assert_eq!(walk(usize::MAX, 2, ByteOrder::LittleEndian), None);
        // Big-endian only advances past a byte boundary (the
        // `checked_add(15)` arm) when `bit_in_byte == 0`; pick a
        // start_bit that hits that arm right at the `usize` edge.
        assert_eq!(walk(usize::MAX - 7, 2, ByteOrder::BigEndian), None);
    }
}
