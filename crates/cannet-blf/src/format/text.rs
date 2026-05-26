//! BLF text-annotation objects:
//!
//! - `EVENT_COMMENT` (type 92) — free-form comment attached to an
//!   adjacent event (CAN frame, error frame, etc.). Vector's Trace
//!   window writes these when a user comments on a row.
//! - `APP_TEXT` (type 65) — application-defined text. Three
//!   `source` flavours: 0 = measurement comment, 1 = database
//!   channel info, 2 = meta data. The `reserved_app_text1` field
//!   carries source-dependent payload (e.g. channel + bus type
//!   when `source == 1`).
//!
//! Both objects share the same outer framing as the CAN-class
//! events:
//!
//! 1. 16-byte [`ObjectHeaderBase`]
//! 2. 16-byte [`ObjectHeaderV1`] (timestamp, flags)
//! 3. Per-type body (16-byte fixed prefix + variable-length text)
//!
//! Text is exposed as `Vec<u8>` for the same reason as
//! [`super::marker::GlobalMarker`] — Vector's "MBCS" text can be
//! latin-1 or other 8-bit; lossless round-trip wins over forced
//! UTF-8 validation.
//!
//! [`ObjectHeaderBase`]: super::object::ObjectHeaderBase
//! [`ObjectHeaderV1`]: super::object::ObjectHeaderV1

use super::object::{
    object_type, ObjectHeaderBase, ObjectHeaderError, ObjectHeaderV1, OBJECT_FLAG_TIME_ONE_NANS,
    OBJECT_HEADER_BASE_BYTES, OBJECT_HEADER_V1_BYTES,
};

/// Width of the per-event header (base + v1) that prefixes both
/// `EVENT_COMMENT` and `APP_TEXT`: 32 bytes.
pub const TEXT_EVENT_HEADER_BYTES: usize = OBJECT_HEADER_BASE_BYTES + OBJECT_HEADER_V1_BYTES;

/// Fixed prefix of an `EVENT_COMMENT` body: `commented_event_type`
/// (4) + `text_length` (4) + `reserved` (8) = 16 bytes.
pub const EVENT_COMMENT_FIXED_PREFIX_BYTES: usize = 16;

/// Fixed prefix of an `APP_TEXT` body: `source` (4) + `reserved1`
/// (4) + `text_length` (4) + `reserved2` (4) = 16 bytes.
pub const APP_TEXT_FIXED_PREFIX_BYTES: usize = 16;

/// `APP_TEXT.source` enumerand: free-form measurement comment.
pub const APP_TEXT_SOURCE_MEASUREMENT_COMMENT: u32 = 0;
/// `APP_TEXT.source` enumerand: database channel info.
/// `reserved_app_text1` then carries channel + bus-type metadata.
pub const APP_TEXT_SOURCE_DB_CHANNEL_INFO: u32 = 1;
/// `APP_TEXT.source` enumerand: arbitrary meta data.
pub const APP_TEXT_SOURCE_META_DATA: u32 = 2;

// =================================================================
// Errors
// =================================================================

/// Errors specific to the text-annotation decoders.
#[derive(Debug)]
pub enum TextError {
    /// The object's `ObjectHeaderBase.object_type` didn't match the
    /// type the decoder was asked for. Carries `(expected, got)`.
    WrongObjectType(u32, u32),
    /// `ObjectHeaderBase` parse failed.
    BaseHeader(ObjectHeaderError),
    /// `ObjectHeader` v1 parse failed.
    EventHeader(ObjectHeaderError),
    /// `object_size` was smaller than the per-type minimum.
    /// Carries `(object_size, required)`.
    TooSmall(u32, usize),
    /// Buffer length was less than `object_size`.
    Truncated(usize, u32),
    /// `text_length` claimed more bytes than the body holds.
    /// Carries `(declared, available)`.
    TextLengthOverflowsBody(u32, usize),
}

impl std::fmt::Display for TextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongObjectType(expected, got) => write!(
                f,
                "expected text-annotation object_type={expected}, got object_type={got}",
            ),
            Self::BaseHeader(e) => write!(f, "text-annotation base header invalid: {e}"),
            Self::EventHeader(e) => write!(f, "text-annotation event header invalid: {e}"),
            Self::TooSmall(got, required) => write!(
                f,
                "text-annotation object_size={got} below required {required} bytes",
            ),
            Self::Truncated(got, required) => write!(
                f,
                "text-annotation buffer = {got} bytes, object_size declares {required}",
            ),
            Self::TextLengthOverflowsBody(want, have) => write!(
                f,
                "text-annotation declared text_length={want} bytes but only {have} remain after the fixed prefix",
            ),
        }
    }
}

impl std::error::Error for TextError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::BaseHeader(e) | Self::EventHeader(e) => Some(e),
            _ => None,
        }
    }
}

// =================================================================
// EVENT_COMMENT (object type 92)
// =================================================================

/// Decoded `EVENT_COMMENT`. Text is the raw on-disk bytes (Vector's
/// "MBCS" — may be UTF-8, latin-1, or another 8-bit encoding).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventComment {
    pub base: ObjectHeaderBase,
    pub event: ObjectHeaderV1,
    /// `ObjectType` of the commented event (the CAN frame / error
    /// frame / etc. the comment applies to). Zero for freestanding
    /// time-anchored comments.
    pub commented_event_type: u32,
    pub text: Vec<u8>,
}

/// Decode one `EVENT_COMMENT`.
// `try_into().unwrap()` is unreachable: every slice is length-checked.
#[allow(clippy::missing_panics_doc)]
pub fn decode_event_comment(object_bytes: &[u8]) -> Result<EventComment, TextError> {
    let base = ObjectHeaderBase::parse(object_bytes).map_err(TextError::BaseHeader)?;
    if base.object_type != object_type::EVENT_COMMENT {
        return Err(TextError::WrongObjectType(
            object_type::EVENT_COMMENT,
            base.object_type,
        ));
    }
    let required = TEXT_EVENT_HEADER_BYTES + EVENT_COMMENT_FIXED_PREFIX_BYTES;
    if (base.object_size as usize) < required {
        return Err(TextError::TooSmall(base.object_size, required));
    }
    if object_bytes.len() < base.object_size as usize {
        return Err(TextError::Truncated(object_bytes.len(), base.object_size));
    }
    let event = ObjectHeaderV1::parse(
        &object_bytes[OBJECT_HEADER_BASE_BYTES..OBJECT_HEADER_BASE_BYTES + OBJECT_HEADER_V1_BYTES],
    )
    .map_err(TextError::EventHeader)?;
    let body = &object_bytes[TEXT_EVENT_HEADER_BYTES..base.object_size as usize];
    let commented_event_type = u32::from_le_bytes(body[0..4].try_into().unwrap());
    let text_length = u32::from_le_bytes(body[4..8].try_into().unwrap());
    // body[8..16] = reservedEventComment (u64)
    let avail = body.len() - EVENT_COMMENT_FIXED_PREFIX_BYTES;
    if text_length as usize > avail {
        return Err(TextError::TextLengthOverflowsBody(text_length, avail));
    }
    let text =
        body[EVENT_COMMENT_FIXED_PREFIX_BYTES..EVENT_COMMENT_FIXED_PREFIX_BYTES + text_length as usize]
            .to_vec();
    Ok(EventComment {
        base,
        event,
        commented_event_type,
        text,
    })
}

/// Convenience constructor for `EVENT_COMMENT`.
// `expect` is unreachable on realistic comment payloads.
#[allow(clippy::missing_panics_doc)]
#[must_use]
pub fn build_event_comment(
    timestamp_ns: u64,
    commented_event_type: u32,
    text: Vec<u8>,
) -> EventComment {
    let object_size = u32::try_from(
        TEXT_EVENT_HEADER_BYTES + EVENT_COMMENT_FIXED_PREFIX_BYTES + text.len(),
    )
    .expect("EVENT_COMMENT size fits in u32 for realistic text payloads");
    EventComment {
        base: ObjectHeaderBase {
            header_size: 32,
            header_version: 1,
            object_size,
            object_type: object_type::EVENT_COMMENT,
        },
        event: ObjectHeaderV1 {
            object_flags: OBJECT_FLAG_TIME_ONE_NANS,
            client_index: 0,
            object_version: 0,
            object_timestamp: timestamp_ns,
        },
        commented_event_type,
        text,
    }
}

/// Encode an `EVENT_COMMENT` to its on-disk bytes. Recomputes
/// `object_size` from `text.len()` so callers can edit a decoded
/// comment and re-emit without manually adjusting the header.
// `expect` is unreachable on realistic comment payloads.
#[allow(clippy::missing_panics_doc)]
#[must_use]
pub fn encode_event_comment(c: &EventComment) -> Vec<u8> {
    let body_size = EVENT_COMMENT_FIXED_PREFIX_BYTES + c.text.len();
    let object_size = u32::try_from(TEXT_EVENT_HEADER_BYTES + body_size)
        .expect("EVENT_COMMENT object_size fits in u32 for realistic text payloads");
    let text_length =
        u32::try_from(c.text.len()).expect("text length fits in u32 for realistic payloads");
    let base = ObjectHeaderBase {
        object_size,
        ..c.base
    };
    let mut out = Vec::with_capacity(object_size as usize);
    out.extend_from_slice(&base.encode());
    out.extend_from_slice(&c.event.encode());
    out.extend_from_slice(&c.commented_event_type.to_le_bytes());
    out.extend_from_slice(&text_length.to_le_bytes());
    out.extend_from_slice(&0u64.to_le_bytes()); // reservedEventComment
    out.extend_from_slice(&c.text);
    out
}

// =================================================================
// APP_TEXT (object type 65)
// =================================================================

/// Decoded `APP_TEXT`. See module docs for the three `source`
/// flavours.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppText {
    pub base: ObjectHeaderBase,
    pub event: ObjectHeaderV1,
    /// `APP_TEXT_SOURCE_*` constant.
    pub source: u32,
    /// Source-dependent payload. For `source = DB_CHANNEL_INFO`,
    /// holds packed (version, channel number, bus type, CAN-FD flag);
    /// other sources leave it unused.
    pub reserved_app_text1: u32,
    pub text: Vec<u8>,
}

/// Decode one `APP_TEXT`.
// `try_into().unwrap()` is unreachable: every slice is length-checked.
#[allow(clippy::missing_panics_doc)]
pub fn decode_app_text(object_bytes: &[u8]) -> Result<AppText, TextError> {
    let base = ObjectHeaderBase::parse(object_bytes).map_err(TextError::BaseHeader)?;
    if base.object_type != object_type::APP_TEXT {
        return Err(TextError::WrongObjectType(
            object_type::APP_TEXT,
            base.object_type,
        ));
    }
    let required = TEXT_EVENT_HEADER_BYTES + APP_TEXT_FIXED_PREFIX_BYTES;
    if (base.object_size as usize) < required {
        return Err(TextError::TooSmall(base.object_size, required));
    }
    if object_bytes.len() < base.object_size as usize {
        return Err(TextError::Truncated(object_bytes.len(), base.object_size));
    }
    let event = ObjectHeaderV1::parse(
        &object_bytes[OBJECT_HEADER_BASE_BYTES..OBJECT_HEADER_BASE_BYTES + OBJECT_HEADER_V1_BYTES],
    )
    .map_err(TextError::EventHeader)?;
    let body = &object_bytes[TEXT_EVENT_HEADER_BYTES..base.object_size as usize];
    let source = u32::from_le_bytes(body[0..4].try_into().unwrap());
    let reserved_app_text1 = u32::from_le_bytes(body[4..8].try_into().unwrap());
    let text_length = u32::from_le_bytes(body[8..12].try_into().unwrap());
    // body[12..16] = reservedAppText2
    let avail = body.len() - APP_TEXT_FIXED_PREFIX_BYTES;
    if text_length as usize > avail {
        return Err(TextError::TextLengthOverflowsBody(text_length, avail));
    }
    let text =
        body[APP_TEXT_FIXED_PREFIX_BYTES..APP_TEXT_FIXED_PREFIX_BYTES + text_length as usize]
            .to_vec();
    Ok(AppText {
        base,
        event,
        source,
        reserved_app_text1,
        text,
    })
}

/// Convenience constructor for `APP_TEXT`.
// `expect` is unreachable on realistic text payloads.
#[allow(clippy::missing_panics_doc)]
#[must_use]
pub fn build_app_text(
    timestamp_ns: u64,
    source: u32,
    reserved_app_text1: u32,
    text: Vec<u8>,
) -> AppText {
    let object_size =
        u32::try_from(TEXT_EVENT_HEADER_BYTES + APP_TEXT_FIXED_PREFIX_BYTES + text.len())
            .expect("APP_TEXT size fits in u32 for realistic text payloads");
    AppText {
        base: ObjectHeaderBase {
            header_size: 32,
            header_version: 1,
            object_size,
            object_type: object_type::APP_TEXT,
        },
        event: ObjectHeaderV1 {
            object_flags: OBJECT_FLAG_TIME_ONE_NANS,
            client_index: 0,
            object_version: 0,
            object_timestamp: timestamp_ns,
        },
        source,
        reserved_app_text1,
        text,
    }
}

/// Encode an `APP_TEXT` to its on-disk bytes.
// `expect` is unreachable on realistic text payloads.
#[allow(clippy::missing_panics_doc)]
#[must_use]
pub fn encode_app_text(a: &AppText) -> Vec<u8> {
    let body_size = APP_TEXT_FIXED_PREFIX_BYTES + a.text.len();
    let object_size = u32::try_from(TEXT_EVENT_HEADER_BYTES + body_size)
        .expect("APP_TEXT object_size fits in u32 for realistic text payloads");
    let text_length =
        u32::try_from(a.text.len()).expect("text length fits in u32 for realistic payloads");
    let base = ObjectHeaderBase {
        object_size,
        ..a.base
    };
    let mut out = Vec::with_capacity(object_size as usize);
    out.extend_from_slice(&base.encode());
    out.extend_from_slice(&a.event.encode());
    out.extend_from_slice(&a.source.to_le_bytes());
    out.extend_from_slice(&a.reserved_app_text1.to_le_bytes());
    out.extend_from_slice(&text_length.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // reservedAppText2
    out.extend_from_slice(&a.text);
    out
}

// =================================================================
// Helpers for the DB_CHANNEL_INFO encoding of reserved_app_text1
// =================================================================

/// Pack the four sub-fields of `APP_TEXT.reserved_app_text1` when
/// `source == APP_TEXT_SOURCE_DB_CHANNEL_INFO` per Vector's spec:
///
/// - bits 0-7:   version
/// - bits 8-15:  channel number
/// - bits 16-23: bus type (1 = CAN, 5 = LIN, 6 = MOST, …)
/// - bit 24:     1 if CAN-FD, 0 otherwise
/// - bits 25-31: reserved (zero)
#[must_use]
pub fn pack_db_channel_info(version: u8, channel: u8, bus_type: u8, is_can_fd: bool) -> u32 {
    u32::from(version)
        | (u32::from(channel) << 8)
        | (u32::from(bus_type) << 16)
        | (u32::from(is_can_fd) << 24)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::reader::{BlfObject, BlfReader};
    use crate::format::writer::BlfFileWriter;

    // ----- EVENT_COMMENT ----------------------------------------

    #[test]
    fn event_comment_round_trips() {
        let c = build_event_comment(
            123_000_000,
            object_type::CAN_MESSAGE2,
            b"Looks like a stuck bit at this offset.".to_vec(),
        );
        let bytes = encode_event_comment(&c);
        let parsed = decode_event_comment(&bytes).unwrap();
        assert_eq!(parsed, c);
    }

    #[test]
    fn event_comment_with_empty_text_round_trips() {
        let c = build_event_comment(0, 0, Vec::new());
        let bytes = encode_event_comment(&c);
        let parsed = decode_event_comment(&bytes).unwrap();
        assert!(parsed.text.is_empty());
    }

    #[test]
    fn event_comment_rejects_wrong_object_type() {
        let c = build_event_comment(0, 0, b"hi".to_vec());
        let mut bytes = encode_event_comment(&c);
        bytes[12..16].copy_from_slice(&object_type::CAN_MESSAGE2.to_le_bytes());
        let err = decode_event_comment(&bytes).unwrap_err();
        assert!(matches!(
            err,
            TextError::WrongObjectType(expected, _) if expected == object_type::EVENT_COMMENT,
        ));
    }

    #[test]
    fn event_comment_rejects_text_length_overflow() {
        let c = build_event_comment(0, 0, b"AB".to_vec());
        let mut bytes = encode_event_comment(&c);
        // text_length sits at base_header(16) + event_header(16) + commented_type(4) = offset 36.
        bytes[36..40].copy_from_slice(&999_u32.to_le_bytes());
        let err = decode_event_comment(&bytes).unwrap_err();
        assert!(matches!(err, TextError::TextLengthOverflowsBody(999, _)));
    }

    // ----- APP_TEXT ---------------------------------------------

    #[test]
    fn app_text_round_trips_measurement_comment() {
        let a = build_app_text(
            456_000_000,
            APP_TEXT_SOURCE_MEASUREMENT_COMMENT,
            0,
            b"Capture from 2024-01-15 dyno run #3.".to_vec(),
        );
        let bytes = encode_app_text(&a);
        let parsed = decode_app_text(&bytes).unwrap();
        assert_eq!(parsed, a);
    }

    #[test]
    fn app_text_round_trips_db_channel_info() {
        let packed = pack_db_channel_info(/*version*/ 1, /*channel*/ 2, /*bus*/ 1, /*fd*/ true);
        let a = build_app_text(
            0,
            APP_TEXT_SOURCE_DB_CHANNEL_INFO,
            packed,
            b"PowerTrain.dbc;PT;Body.dbc;Body".to_vec(),
        );
        let bytes = encode_app_text(&a);
        let parsed = decode_app_text(&bytes).unwrap();
        assert_eq!(parsed.source, APP_TEXT_SOURCE_DB_CHANNEL_INFO);
        assert_eq!(parsed.reserved_app_text1, packed);
        assert_eq!(parsed.text, a.text);
    }

    #[test]
    fn pack_db_channel_info_layout() {
        // version=1, channel=2, bus=1, fd=true → 0x0101_0201
        assert_eq!(pack_db_channel_info(1, 2, 1, true), 0x0101_0201);
        // All zero
        assert_eq!(pack_db_channel_info(0, 0, 0, false), 0);
        // Fd flag only
        assert_eq!(pack_db_channel_info(0, 0, 0, true), 0x0100_0000);
    }

    #[test]
    fn app_text_rejects_wrong_object_type() {
        let a = build_app_text(0, 0, 0, b"hi".to_vec());
        let mut bytes = encode_app_text(&a);
        bytes[12..16].copy_from_slice(&object_type::EVENT_COMMENT.to_le_bytes());
        let err = decode_app_text(&bytes).unwrap_err();
        assert!(matches!(
            err,
            TextError::WrongObjectType(expected, _) if expected == object_type::APP_TEXT,
        ));
    }

    // ----- End-to-end through BlfFileWriter + BlfReader ---------

    #[test]
    fn round_trips_event_comment_through_native_writer_and_reader() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("comment.blf");
        let mut w = BlfFileWriter::create(&path).unwrap();

        let abs_ns = 1_700_000_000_u64 * 1_000_000_000 + 5_000_000;
        let start = w.set_start_if_unset((abs_ns / 1_000_000) * 1_000_000);
        let rel = abs_ns - start;

        let c = build_event_comment(
            rel,
            object_type::CAN_MESSAGE2,
            b"Comment on the previous frame.".to_vec(),
        );
        let bytes = encode_event_comment(&c);
        w.append_object(&bytes, abs_ns).unwrap();
        w.finish().unwrap();

        let mut r = BlfReader::open(&path).unwrap();
        let mut seen = 0;
        while let Some(obj) = r.next_object().unwrap() {
            if let BlfObject::EventComment(c) = obj {
                assert_eq!(c.text, b"Comment on the previous frame.");
                assert_eq!(c.commented_event_type, object_type::CAN_MESSAGE2);
                seen += 1;
            }
        }
        assert_eq!(seen, 1);
    }

    #[test]
    fn round_trips_app_text_through_native_writer_and_reader() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("apptext.blf");
        let mut w = BlfFileWriter::create(&path).unwrap();

        let abs_ns = 1_700_000_000_u64 * 1_000_000_000 + 5_000_000;
        let start = w.set_start_if_unset((abs_ns / 1_000_000) * 1_000_000);
        let rel = abs_ns - start;

        let a = build_app_text(
            rel,
            APP_TEXT_SOURCE_MEASUREMENT_COMMENT,
            0,
            b"Round-trip measurement comment.".to_vec(),
        );
        let bytes = encode_app_text(&a);
        w.append_object(&bytes, abs_ns).unwrap();
        w.finish().unwrap();

        let mut r = BlfReader::open(&path).unwrap();
        let mut seen = 0;
        while let Some(obj) = r.next_object().unwrap() {
            if let BlfObject::AppText(a) = obj {
                assert_eq!(a.text, b"Round-trip measurement comment.");
                assert_eq!(a.source, APP_TEXT_SOURCE_MEASUREMENT_COMMENT);
                seen += 1;
            }
        }
        assert_eq!(seen, 1);
    }
}
