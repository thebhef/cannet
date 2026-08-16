//! Reading one channel's sample out of one record.
//!
//! The bit-level extraction (every MDF data type, sub-byte fields, both
//! byte orders), the invalidation-bit check and the CC conversion all come
//! from `mdf4-rs`; this module is the adapter that hands it the record and
//! turns the result into the shape the caller wants.

use mdf4_rs::blocks::{ChannelBlock, ConversionBlock, ConversionType};
use mdf4_rs::parsing::decoder::decode_channel_value_with_validity;
use mdf4_rs::DecodedValue;

use crate::file::Mdf4File;

/// The raw (unconverted) sample, or `None` when the record is too short or
/// the invalidation bit marks the sample invalid.
fn raw(file: &Mdf4File, group: usize, record: &[u8], block: &ChannelBlock) -> Option<DecodedValue> {
    let decoded = decode_channel_value_with_validity(
        record,
        file.record_id_size(group),
        file.record_data_bytes(group),
        block,
    )?;
    decoded.is_valid.then_some(decoded.value)
}

/// A field read as an unsigned integer. Bus-logging structure fields are
/// unsigned integers by definition, so a missing or undecodable one reads
/// as 0 — the same value the field would carry if the writer left it out.
pub(crate) fn as_u64(file: &Mdf4File, group: usize, record: &[u8], block: &ChannelBlock) -> u64 {
    match raw(file, group, record, block) {
        Some(DecodedValue::UnsignedInteger(v)) => v,
        Some(DecodedValue::SignedInteger(v)) => u64::try_from(v).unwrap_or(0),
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        Some(DecodedValue::Float(v)) if v >= 0.0 => v as u64,
        _ => 0,
    }
}

/// A field read as a byte array — the `DataBytes` of a frame.
pub(crate) fn as_bytes(
    file: &Mdf4File,
    group: usize,
    record: &[u8],
    block: &ChannelBlock,
) -> Vec<u8> {
    match raw(file, group, record, block) {
        Some(DecodedValue::ByteArray(bytes)) => bytes,
        _ => Vec::new(),
    }
}

/// A field read as a physical `f64`, conversion applied. Used for the
/// master (time) axis and for signal-channel samples, where a conversion
/// is the rule rather than the exception.
pub(crate) fn as_f64(
    file: &Mdf4File,
    group: usize,
    record: &[u8],
    block: &ChannelBlock,
) -> Option<f64> {
    let raw = raw(file, group, record, block)?;
    block
        .apply_conversion_value(raw, file.bytes())
        .ok()?
        .as_f64()
}

/// A signal-channel sample as an `f64`, the channel's conversion applied
/// where it yields a number and the stored code kept where it does not.
///
/// A coded signal — a DBC enumeration, and the shape most state channels
/// in a decoded group take — carries a value-to-text conversion, so its
/// converted sample is a *string*. The series is still a numeric one: the
/// codes are the values, and the text is a label for them, which is
/// exactly what a value table is elsewhere in this project. Dropping such
/// a sample would silently lose the whole channel, so the raw code is
/// kept instead.
pub(crate) fn as_signal_f64(
    file: &Mdf4File,
    group: usize,
    record: &[u8],
    block: &ChannelBlock,
) -> Option<f64> {
    let raw = raw(file, group, record, block)?;
    let converted = block.apply_conversion_value(raw.clone(), file.bytes()).ok();
    numeric_sample(converted.as_ref(), &raw)
}

/// The numeric reading of one sample: the converted value when the
/// conversion produced a number, and otherwise the stored code. `None`
/// when neither is a number — a genuine text channel, which has no
/// numeric series to offer.
fn numeric_sample(converted: Option<&DecodedValue>, raw: &DecodedValue) -> Option<f64> {
    converted
        .and_then(DecodedValue::as_f64)
        .or_else(|| raw.as_f64())
}

/// The channel's value→text table as `(code, label)` pairs, in the
/// conversion's own order — empty for a channel whose conversion labels
/// nothing.
///
/// This is the other half of [`as_signal_f64`]: that keeps the stored
/// code where the conversion yields text, and this reads the table that
/// says what each code means. The labels are asked of the conversion
/// itself rather than read out of its links, so a table whose entries
/// chain through further blocks resolves exactly as a sample of that
/// value would.
pub(crate) fn value_table(file: &Mdf4File, block: &ChannelBlock) -> Vec<(i64, String)> {
    let Some(conversion) = block.conversion.as_ref() else {
        return Vec::new();
    };
    labelled_codes(conversion)
        .into_iter()
        .filter_map(|code| {
            match block.apply_conversion_value(DecodedValue::SignedInteger(code), file.bytes()) {
                Ok(DecodedValue::String(label)) => Some((code, label)),
                _ => None,
            }
        })
        .collect()
}

/// The codes a text-table conversion labels one at a time.
///
/// `ValueToText` states them directly. `RangeToText` — the shape a tool
/// writes a DBC enumeration as — states `[min, max]` pairs, and only a
/// pair that is a single value names a code; a range spanning several
/// values labels a band rather than a code, and a value table has no way
/// to say that. Anything else is a numeric conversion with no labels in
/// it at all.
// A range is a single value when its two bounds are the *same stored
// number*, which is what an exact comparison asks: these are the file's
// own bytes, not the result of arithmetic, so there is no rounding for a
// tolerance to absorb.
#[allow(clippy::float_cmp)]
fn labelled_codes(conversion: &ConversionBlock) -> Vec<i64> {
    let keys: Vec<f64> = match conversion.conversion_type {
        ConversionType::ValueToText => conversion.values.clone(),
        ConversionType::RangeToText => conversion
            .values
            .chunks_exact(2)
            .filter(|range| range[0] == range[1])
            .map(|range| range[0])
            .collect(),
        _ => return Vec::new(),
    };
    keys.into_iter().filter_map(exact_code).collect()
}

/// A key read as the integer code it is, or `None` when it is not one —
/// a code is what a coded signal stores, and nothing else can be one.
fn exact_code(key: f64) -> Option<i64> {
    #[allow(clippy::cast_possible_truncation)]
    (key.fract() == 0.0 && key.abs() < 9.0e15).then_some(key as i64)
}

#[cfg(test)]
mod tests {
    use super::{labelled_codes, numeric_sample, ConversionBlock, ConversionType, DecodedValue};

    fn conversion(conversion_type: ConversionType, values: Vec<f64>) -> ConversionBlock {
        ConversionBlock {
            conversion_type,
            values,
            ..ConversionBlock::identity()
        }
    }

    #[test]
    fn a_value_to_text_conversion_labels_each_of_its_values() {
        let cc = conversion(ConversionType::ValueToText, vec![0.0, 1.0, 7.0]);
        assert_eq!(labelled_codes(&cc), vec![0, 1, 7]);
    }

    #[test]
    fn a_range_to_text_conversion_labels_the_ranges_that_are_single_values() {
        // The shape a DBC enumeration takes on the way into MDF: one
        // `[code, code]` range per enumerator.
        let cc = conversion(
            ConversionType::RangeToText,
            vec![0.0, 0.0, 1.0, 1.0, -2.0, -2.0],
        );
        assert_eq!(labelled_codes(&cc), vec![0, 1, -2]);
    }

    #[test]
    fn a_range_spanning_more_than_one_value_has_no_single_code_to_label() {
        let cc = conversion(ConversionType::RangeToText, vec![0.0, 0.0, 1.0, 10.0]);
        assert_eq!(labelled_codes(&cc), vec![0]);
    }

    #[test]
    fn a_fractional_key_is_not_a_code() {
        let cc = conversion(ConversionType::ValueToText, vec![0.5, 2.0]);
        assert_eq!(labelled_codes(&cc), vec![2]);
    }

    #[test]
    fn a_numeric_conversion_labels_nothing() {
        let cc = conversion(ConversionType::Linear, vec![0.0, 0.1]);
        assert!(labelled_codes(&cc).is_empty());
    }

    #[test]
    fn a_numeric_conversion_wins_over_the_stored_code() {
        let raw = DecodedValue::UnsignedInteger(7);
        let converted = DecodedValue::Float(3.5);
        assert_eq!(numeric_sample(Some(&converted), &raw), Some(3.5));
    }

    #[test]
    fn a_text_conversion_falls_back_to_the_stored_code() {
        // The `CurrentBMSState = 1 -> "Idle"` shape: the label is not a
        // number, the code is, and the code is the series.
        let raw = DecodedValue::UnsignedInteger(1);
        let converted = DecodedValue::String("Idle".into());
        assert_eq!(numeric_sample(Some(&converted), &raw), Some(1.0));
    }

    #[test]
    fn an_unconverted_channel_reads_its_stored_value() {
        let raw = DecodedValue::SignedInteger(-4);
        assert_eq!(numeric_sample(None, &raw), Some(-4.0));
    }

    #[test]
    fn a_text_channel_has_no_numeric_reading() {
        let raw = DecodedValue::String("ready".into());
        let converted = DecodedValue::String("ready".into());
        assert_eq!(numeric_sample(Some(&converted), &raw), None);
    }
}
