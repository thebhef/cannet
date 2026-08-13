//! Reading one channel's sample out of one record.
//!
//! The bit-level extraction (every MDF data type, sub-byte fields, both
//! byte orders), the invalidation-bit check and the CC conversion all come
//! from `mdf4-rs`; this module is the adapter that hands it the record and
//! turns the result into the shape the caller wants.

use mdf4_rs::blocks::ChannelBlock;
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
