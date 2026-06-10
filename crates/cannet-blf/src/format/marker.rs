//! BLF `GLOBAL_MARKER` (object type 96) — text annotation attached
//! to a point in time. Vector tools use this for user-authored
//! markers on a capture; `BlfCaptureWriter::append_marker` writes
//! cannet's plot-panel notes as these, keeping the annotations
//! inside the BLF itself (ADR 0010).
//!
//! Body layout (after the 32-byte CAN-event header — base + v1):
//!
//! ```text
//! offset (from object start)  size  field
//! 32                          4     commented_event_type
//! 36                          4     foreground_color
//! 40                          4     background_color
//! 44                          1     is_relocatable
//! 45                          1     reserved1
//! 46                          2     reserved2
//! 48                          4     group_name_length        (bytes, no NUL)
//! 52                          4     marker_name_length
//! 56                          4     description_length
//! 60                          4     reserved3
//! 64                          8     reserved4
//! 72                          *     group_name (raw bytes, no NUL terminator)
//! 72+gnl                      *     marker_name
//! 72+gnl+mnl                  *     description
//! ```
//!
//! Strings are exposed as `Vec<u8>` so invalid UTF-8 round-trips
//! verbatim (a real-world BLF can carry latin-1 or other 8-bit
//! encodings); higher-level code can `String::from_utf8` or
//! `from_utf8_lossy` as it sees fit.

use super::object::{
    object_type, ObjectHeaderBase, ObjectHeaderError, ObjectHeaderV1, OBJECT_HEADER_BASE_BYTES,
    OBJECT_HEADER_V1_BYTES,
};

/// Width of the per-event header that prefixes a `GLOBAL_MARKER`:
/// `ObjectHeaderBase` (16) + `ObjectHeader` v1 (16) = 32 bytes.
/// Same shape as the CAN-class objects.
pub const MARKER_EVENT_HEADER_BYTES: usize = OBJECT_HEADER_BASE_BYTES + OBJECT_HEADER_V1_BYTES;

/// Width of the `GLOBAL_MARKER`-specific fixed prefix (everything
/// before the three variable-length strings).
pub const MARKER_FIXED_PREFIX_BYTES: usize = 40;

/// Decoded `GLOBAL_MARKER`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalMarker {
    pub base: ObjectHeaderBase,
    pub event: ObjectHeaderV1,
    /// Type of the commented event. Zero for "freestanding"
    /// time-anchored markers; otherwise the `ObjectType` of an
    /// adjacent event the marker comments on.
    pub commented_event_type: u32,
    /// 24-bit RGB packed into a `u32` (`0x00RR_GGBB`). Vector tools
    /// render markers in the chosen colour; our reader/writer
    /// preserves the raw u32.
    pub foreground_color: u32,
    pub background_color: u32,
    /// Whether the marker may be moved by the user in Vector's
    /// tooling. Non-zero = relocatable.
    pub is_relocatable: u8,
    pub group_name: Vec<u8>,
    pub marker_name: Vec<u8>,
    pub description: Vec<u8>,
}

/// Errors specific to decoding a `GLOBAL_MARKER`.
#[derive(Debug)]
pub enum MarkerError {
    /// The object's `ObjectHeaderBase.object_type` wasn't `GLOBAL_MARKER`.
    WrongObjectType(u32),
    /// `ObjectHeaderBase` parse failed.
    BaseHeader(ObjectHeaderError),
    /// `ObjectHeader` v1 parse failed.
    EventHeader(ObjectHeaderError),
    /// `object_size` was smaller than the 72-byte minimum (event
    /// header + fixed prefix). Carries `(object_size, required)`.
    TooSmall(u32, usize),
    /// Buffer length was less than `object_size`.
    Truncated(usize, u32),
    /// One or more of the three declared string lengths overflowed
    /// the body. Carries (declared total string bytes, available).
    StringLengthOverflowsBody(u64, usize),
}

impl std::fmt::Display for MarkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongObjectType(t) => write!(
                f,
                "expected GLOBAL_MARKER (object_type={}), got object_type={t}",
                object_type::GLOBAL_MARKER,
            ),
            Self::BaseHeader(e) => write!(f, "GLOBAL_MARKER base header invalid: {e}"),
            Self::EventHeader(e) => write!(f, "GLOBAL_MARKER event header invalid: {e}"),
            Self::TooSmall(got, required) => write!(
                f,
                "GLOBAL_MARKER object_size={got} below required {required} bytes",
            ),
            Self::Truncated(got, required) => write!(
                f,
                "GLOBAL_MARKER buffer = {got} bytes, object_size declares {required}",
            ),
            Self::StringLengthOverflowsBody(want, have) => write!(
                f,
                "GLOBAL_MARKER declared {want} bytes of string content but only {have} bytes remain after the fixed prefix",
            ),
        }
    }
}

impl std::error::Error for MarkerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::BaseHeader(e) | Self::EventHeader(e) => Some(e),
            _ => None,
        }
    }
}

/// Decode one `GLOBAL_MARKER`.
// `try_into().unwrap()` calls are unreachable: every slice is
// length-checked at the top.
#[allow(clippy::missing_panics_doc)]
pub fn decode(object_bytes: &[u8]) -> Result<GlobalMarker, MarkerError> {
    let base = ObjectHeaderBase::parse(object_bytes).map_err(MarkerError::BaseHeader)?;
    if base.object_type != object_type::GLOBAL_MARKER {
        return Err(MarkerError::WrongObjectType(base.object_type));
    }
    let required = MARKER_EVENT_HEADER_BYTES + MARKER_FIXED_PREFIX_BYTES;
    if (base.object_size as usize) < required {
        return Err(MarkerError::TooSmall(base.object_size, required));
    }
    if object_bytes.len() < base.object_size as usize {
        return Err(MarkerError::Truncated(
            object_bytes.len(),
            base.object_size,
        ));
    }
    let event = ObjectHeaderV1::parse(
        &object_bytes[OBJECT_HEADER_BASE_BYTES..OBJECT_HEADER_BASE_BYTES + OBJECT_HEADER_V1_BYTES],
    )
    .map_err(MarkerError::EventHeader)?;

    let body = &object_bytes[MARKER_EVENT_HEADER_BYTES..base.object_size as usize];

    let commented_event_type = u32::from_le_bytes(body[0..4].try_into().unwrap());
    let foreground_color = u32::from_le_bytes(body[4..8].try_into().unwrap());
    let background_color = u32::from_le_bytes(body[8..12].try_into().unwrap());
    let is_relocatable = body[12];
    // body[13] reserved1, body[14..16] reserved2
    let group_name_length = u32::from_le_bytes(body[16..20].try_into().unwrap());
    let marker_name_length = u32::from_le_bytes(body[20..24].try_into().unwrap());
    let description_length = u32::from_le_bytes(body[24..28].try_into().unwrap());
    // body[28..32] reserved3, body[32..40] reserved4

    let total_str = u64::from(group_name_length)
        + u64::from(marker_name_length)
        + u64::from(description_length);
    let avail = body.len() - MARKER_FIXED_PREFIX_BYTES;
    if total_str > avail as u64 {
        return Err(MarkerError::StringLengthOverflowsBody(total_str, avail));
    }

    let mut p = MARKER_FIXED_PREFIX_BYTES;
    let group_name = body[p..p + group_name_length as usize].to_vec();
    p += group_name_length as usize;
    let marker_name = body[p..p + marker_name_length as usize].to_vec();
    p += marker_name_length as usize;
    let description = body[p..p + description_length as usize].to_vec();

    Ok(GlobalMarker {
        base,
        event,
        commented_event_type,
        foreground_color,
        background_color,
        is_relocatable,
        group_name,
        marker_name,
        description,
    })
}

/// Convenience constructor: build a `GLOBAL_MARKER` at a given
/// timestamp with `group` / `marker` / `description` text.
/// `commented_event_type` is 0 (freestanding) and the colours are
/// black-on-white by default. The caller can adjust the returned
/// struct before encoding.
// `expect` is unreachable on realistic note payloads.
#[allow(clippy::missing_panics_doc)]
#[must_use]
pub fn build(
    timestamp_ns: u64,
    group_name: Vec<u8>,
    marker_name: Vec<u8>,
    description: Vec<u8>,
) -> GlobalMarker {
    use super::object::OBJECT_FLAG_TIME_ONE_NANS;
    let object_size = u32::try_from(
        MARKER_EVENT_HEADER_BYTES
            + MARKER_FIXED_PREFIX_BYTES
            + group_name.len()
            + marker_name.len()
            + description.len(),
    )
    .expect("GLOBAL_MARKER size fits in u32 for realistic note payloads");
    GlobalMarker {
        base: ObjectHeaderBase {
            header_size: 32,
            header_version: 1,
            object_size,
            object_type: object_type::GLOBAL_MARKER,
        },
        event: ObjectHeaderV1 {
            object_flags: OBJECT_FLAG_TIME_ONE_NANS,
            client_index: 0,
            object_version: 0,
            object_timestamp: timestamp_ns,
        },
        commented_event_type: 0,
        foreground_color: 0x0000_0000,
        background_color: 0x00FF_FFFF,
        is_relocatable: 0,
        group_name,
        marker_name,
        description,
    }
}

/// Encode a `GLOBAL_MARKER` to its on-disk bytes. Recomputes
/// `object_size` from the actual string lengths so a caller-edited
/// marker round-trips correctly even if `base.object_size` was
/// left stale.
// `expect` is unreachable on realistic note payloads.
#[allow(clippy::missing_panics_doc)]
#[must_use]
pub fn encode(m: &GlobalMarker) -> Vec<u8> {
    let body_size = MARKER_FIXED_PREFIX_BYTES
        + m.group_name.len()
        + m.marker_name.len()
        + m.description.len();
    let object_size = u32::try_from(MARKER_EVENT_HEADER_BYTES + body_size)
        .expect("GLOBAL_MARKER object_size fits in u32 for realistic note payloads");
    let group_name_length = u32::try_from(m.group_name.len())
        .expect("group_name length fits in u32");
    let marker_name_length = u32::try_from(m.marker_name.len())
        .expect("marker_name length fits in u32");
    let description_length = u32::try_from(m.description.len())
        .expect("description length fits in u32");

    let base = ObjectHeaderBase {
        object_size,
        ..m.base
    };
    let mut out = Vec::with_capacity(object_size as usize);
    out.extend_from_slice(&base.encode());
    out.extend_from_slice(&m.event.encode());
    out.extend_from_slice(&m.commented_event_type.to_le_bytes());
    out.extend_from_slice(&m.foreground_color.to_le_bytes());
    out.extend_from_slice(&m.background_color.to_le_bytes());
    out.push(m.is_relocatable);
    out.push(0); // reserved1
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved2
    out.extend_from_slice(&group_name_length.to_le_bytes());
    out.extend_from_slice(&marker_name_length.to_le_bytes());
    out.extend_from_slice(&description_length.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved3
    out.extend_from_slice(&0u64.to_le_bytes()); // reserved4
    out.extend_from_slice(&m.group_name);
    out.extend_from_slice(&m.marker_name);
    out.extend_from_slice(&m.description);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::reader::{BlfObject, BlfReader};
    use crate::format::writer::BlfFileWriter;

    #[test]
    fn decode_encode_round_trip() {
        let m = build(
            42_000_000,
            b"NotesGroup".to_vec(),
            b"first marker".to_vec(),
            b"User-authored marker for the start of bus contention.".to_vec(),
        );
        let bytes = encode(&m);
        let parsed = decode(&bytes).unwrap();
        assert_eq!(parsed, m);
    }

    #[test]
    fn build_with_empty_strings_round_trips() {
        let m = build(0, Vec::new(), Vec::new(), Vec::new());
        let bytes = encode(&m);
        let parsed = decode(&bytes).unwrap();
        assert!(parsed.group_name.is_empty());
        assert!(parsed.marker_name.is_empty());
        assert!(parsed.description.is_empty());
    }

    #[test]
    fn rejects_wrong_object_type() {
        let m = build(0, Vec::new(), Vec::new(), Vec::new());
        let mut bytes = encode(&m);
        bytes[12..16].copy_from_slice(&object_type::CAN_MESSAGE2.to_le_bytes());
        let err = decode(&bytes).unwrap_err();
        assert!(matches!(
            err,
            MarkerError::WrongObjectType(t) if t == object_type::CAN_MESSAGE2,
        ));
    }

    #[test]
    fn rejects_string_length_overflow() {
        let m = build(0, b"AB".to_vec(), Vec::new(), Vec::new());
        let mut bytes = encode(&m);
        // Inflate group_name_length to claim more bytes than the
        // body has. group_name_length is at offset 32 + 16 = 48.
        bytes[48..52].copy_from_slice(&999_u32.to_le_bytes());
        let err = decode(&bytes).unwrap_err();
        assert!(matches!(err, MarkerError::StringLengthOverflowsBody(_, _)));
    }

    /// End-to-end: write one marker through `BlfFileWriter`, read
    /// it back via `BlfReader`. The reader's `BlfObject` exposes
    /// the marker variant so callers can pick it out of the
    /// inflated stream.
    #[test]
    fn round_trips_through_native_writer_and_reader() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("marker.blf");
        let mut w = BlfFileWriter::create(&path).unwrap();

        let abs_ns = 1_700_000_000_u64 * 1_000_000_000 + 12_345_678;
        // Ms-floor the start (matches what BlfCaptureWriter does)
        // so the per-event rel preserves sub-ms precision.
        let start = w.set_start_if_unset((abs_ns / 1_000_000) * 1_000_000);
        let rel = abs_ns - start;

        let m = build(
            rel,
            b"Notes".to_vec(),
            b"start-of-bus-contention".to_vec(),
            b"Capture annotation: bus load spiked here.".to_vec(),
        );
        let bytes = encode(&m);
        w.append_object(&bytes, abs_ns).unwrap();
        w.finish().unwrap();

        let mut r = BlfReader::open(&path).unwrap();
        let mut seen = 0;
        while let Some(obj) = r.next_object().unwrap() {
            if let BlfObject::GlobalMarker(g) = obj {
                assert_eq!(g.group_name, b"Notes");
                assert_eq!(g.marker_name, b"start-of-bus-contention");
                assert_eq!(g.description, b"Capture annotation: bus load spiked here.");
                seen += 1;
            }
        }
        assert_eq!(seen, 1);
    }
}
