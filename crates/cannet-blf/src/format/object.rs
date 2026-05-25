//! BLF `ObjectHeaderBase` — the fixed 16-byte preamble of every
//! on-disk object.
//!
//! Layout per Vector's `binlog_objects.h` (2018 v8) §
//! `VBLObjectHeaderBase`, cross-referenced against `vector_blf`'s
//! `ObjectHeaderBase.h`:
//!
//! ```text
//! offset  size  field
//! 0       4     signature       ("LOBJ" = 0x4A42_4F4C little-endian)
//! 4       2     header_size     (bytes from start of this base header
//!                                to the end of the per-type extension
//!                                header — e.g. 16 for v1 of v2-only
//!                                objects like `LOG_CONTAINER`, 32 for
//!                                objects that embed an `ObjectHeader` v1)
//! 6       2     header_version  (1 → `ObjectHeader`, 2 → `ObjectHeader2`,
//!                                or 1 for `LOG_CONTAINER` which uses
//!                                only the base header)
//! 8       4     object_size     (total bytes of the object, including
//!                                this 16-byte base header)
//! 12      4     object_type     (enum value; e.g. 10 = `LOG_CONTAINER`,
//!                                86 = `CAN_MESSAGE2`, 96 = `GLOBAL_MARKER`)
//! ```
//!
//! Total: 16 bytes. All multi-byte integers are little-endian.
//!
//! This module owns the *base* header only. Per-type body framing
//! (`LOG_CONTAINER`, `CAN_MESSAGE2`, …) lives in the per-type modules
//! that consume the body starting at `+header_size`.

/// Vector's `LOBJ` per-object signature, little-endian (the bytes are
/// `L O B J` in the order they appear on disk).
pub const OBJECT_SIGNATURE: u32 = 0x4A42_4F4C;

/// The fixed byte width of the `ObjectHeaderBase` preamble.
pub const OBJECT_HEADER_BASE_BYTES: usize = 16;

/// Object-type IDs we decode natively. Unknown values stay as the raw
/// `u32` on `ObjectHeaderBase::object_type` so the caller can skip
/// past them using `object_size`.
pub mod object_type {
    pub const CAN_MESSAGE: u32 = 1;
    pub const LOG_CONTAINER: u32 = 10;
    pub const CAN_ERROR_EXT: u32 = 73;
    pub const CAN_MESSAGE2: u32 = 86;
    pub const GLOBAL_MARKER: u32 = 96;
    pub const CAN_FD_MESSAGE: u32 = 100;
    pub const CAN_FD_MESSAGE_64: u32 = 101;
}

/// Parsed `ObjectHeaderBase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectHeaderBase {
    /// Combined size in bytes of the base header plus the per-type
    /// extension header (see module docs). The object's *body*
    /// starts at `+header_size`.
    pub header_size: u16,
    /// Header version: 1 for objects whose extension is
    /// `ObjectHeader`, 2 for `ObjectHeader2`. `LOG_CONTAINER` reports
    /// 1 and uses no extension.
    pub header_version: u16,
    /// Total bytes of the on-disk object, *including* the 16-byte
    /// base header.
    pub object_size: u32,
    /// Type discriminator. See [`object_type`] for known values; any
    /// other value is a type this implementation doesn't decode.
    pub object_type: u32,
}

/// Parse errors specific to the per-object base header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectHeaderError {
    /// Buffer was shorter than the 16-byte base header.
    /// Carries the byte length we got.
    Truncated(usize),
    /// First 4 bytes weren't `LOBJ`. Carries what we saw.
    BadSignature(u32),
    /// `header_size` was smaller than the 16-byte base, which would
    /// place the body inside the base header. Carries the reported size.
    HeaderSizeTooSmall(u16),
    /// `object_size` was smaller than `header_size`, which would
    /// leave no room for the body and would underflow the body-size
    /// calculation. Carries `(object_size, header_size)`.
    ObjectSizeBelowHeader(u32, u16),
}

impl std::fmt::Display for ObjectHeaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated(n) => write!(
                f,
                "BLF object header truncated: got {n} bytes, need at least {OBJECT_HEADER_BASE_BYTES}",
            ),
            Self::BadSignature(sig) => write!(
                f,
                "BLF object signature mismatch: expected {OBJECT_SIGNATURE:#010x} (LOBJ), got {sig:#010x}",
            ),
            Self::HeaderSizeTooSmall(n) => write!(
                f,
                "BLF ObjectHeaderBase.header_size = {n} bytes, below the {OBJECT_HEADER_BASE_BYTES}-byte minimum",
            ),
            Self::ObjectSizeBelowHeader(obj, hdr) => write!(
                f,
                "BLF ObjectHeaderBase.object_size = {obj} < header_size = {hdr}",
            ),
        }
    }
}

impl std::error::Error for ObjectHeaderError {}

impl ObjectHeaderBase {
    /// Parse the 16-byte base header at the start of `bytes`.
    /// Trailing bytes past 16 are the per-type extension header and
    /// the body, which this module does not touch.
    // The `try_into().unwrap()` calls are unreachable: every slice
    // is taken from the bytes[0..N] window after the length check
    // at the top.
    #[allow(clippy::missing_panics_doc)]
    pub fn parse(bytes: &[u8]) -> Result<Self, ObjectHeaderError> {
        if bytes.len() < OBJECT_HEADER_BASE_BYTES {
            return Err(ObjectHeaderError::Truncated(bytes.len()));
        }
        let signature = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        if signature != OBJECT_SIGNATURE {
            return Err(ObjectHeaderError::BadSignature(signature));
        }
        let header_size = u16::from_le_bytes(bytes[4..6].try_into().unwrap());
        let header_version = u16::from_le_bytes(bytes[6..8].try_into().unwrap());
        let object_size = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let object_type = u32::from_le_bytes(bytes[12..16].try_into().unwrap());

        if (header_size as usize) < OBJECT_HEADER_BASE_BYTES {
            return Err(ObjectHeaderError::HeaderSizeTooSmall(header_size));
        }
        if object_size < u32::from(header_size) {
            return Err(ObjectHeaderError::ObjectSizeBelowHeader(
                object_size,
                header_size,
            ));
        }

        Ok(Self {
            header_size,
            header_version,
            object_size,
            object_type,
        })
    }

    /// Bytes consumed by this object on disk, including the trailing
    /// padding Vector writes between consecutive objects. **The
    /// padding rule is `object_size % 4`**, not `(4 - object_size %
    /// 4) % 4` — this matches Vector's own `LogContainer.cpp`
    /// (`is.seekg(objectSize % 4, std::ios_base::cur);`) and
    /// `blf_asc`'s writer/reader. The padding therefore doesn't
    /// 4-align the next object's start in general; it's a vestigial
    /// formula but every BLF implementation in the wild follows it
    /// so we do too.
    pub fn advance_bytes(&self) -> u64 {
        let raw = u64::from(self.object_size);
        raw + (raw % 4)
    }

    /// Encode this base header to its fixed 16 bytes.
    pub fn encode(&self) -> [u8; OBJECT_HEADER_BASE_BYTES] {
        let mut bytes = [0u8; OBJECT_HEADER_BASE_BYTES];
        bytes[0..4].copy_from_slice(&OBJECT_SIGNATURE.to_le_bytes());
        bytes[4..6].copy_from_slice(&self.header_size.to_le_bytes());
        bytes[6..8].copy_from_slice(&self.header_version.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.object_size.to_le_bytes());
        bytes[12..16].copy_from_slice(&self.object_type.to_le_bytes());
        bytes
    }
}

// ---- ObjectHeader v1 ---------------------------------------------

/// The v1 per-object extension header that follows `ObjectHeaderBase`
/// for every event type except `LOG_CONTAINER`. Carries the per-object
/// timestamp and flags. Total: 16 bytes; combined with the 16-byte
/// base header, an `ObjectHeader`-bearing object's body starts at +32.
///
/// Layout per Vector's `binlog_objects.h` § `VBLObjectHeader`,
/// cross-referenced against `vector_blf::ObjectHeader`:
///
/// ```text
/// offset  size  field
/// 0       4     object_flags     (1 = 10-µs ticks, 2 = ns)
/// 4       2     client_index
/// 6       2     object_version
/// 8       8     object_timestamp (units determined by object_flags)
/// ```
pub const OBJECT_HEADER_V1_BYTES: usize = 16;

/// `object_flags` enumerand: timestamp is in 10-microsecond ticks.
pub const OBJECT_FLAG_TIME_TEN_MICS: u32 = 1;
/// `object_flags` enumerand: timestamp is in nanoseconds.
pub const OBJECT_FLAG_TIME_ONE_NANS: u32 = 2;

/// Parsed `ObjectHeader` v1 extension (the 16 bytes after `ObjectHeaderBase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectHeaderV1 {
    pub object_flags: u32,
    pub client_index: u16,
    pub object_version: u16,
    /// Raw `object_timestamp` field. Multiply by 10000 if
    /// `object_flags == OBJECT_FLAG_TIME_TEN_MICS`, or use as-is if
    /// `OBJECT_FLAG_TIME_ONE_NANS`. Use [`Self::timestamp_ns`] for
    /// the normalised value.
    pub object_timestamp: u64,
}

impl ObjectHeaderV1 {
    /// Parse the 16-byte extension at the start of `bytes`. Caller
    /// must have already consumed the 16-byte `ObjectHeaderBase` and
    /// be looking at the extension's first byte.
    // `try_into().unwrap()` is unreachable: slices come from a
    // length-checked window.
    #[allow(clippy::missing_panics_doc)]
    pub fn parse(bytes: &[u8]) -> Result<Self, ObjectHeaderError> {
        if bytes.len() < OBJECT_HEADER_V1_BYTES {
            return Err(ObjectHeaderError::Truncated(bytes.len()));
        }
        Ok(Self {
            object_flags: u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
            client_index: u16::from_le_bytes(bytes[4..6].try_into().unwrap()),
            object_version: u16::from_le_bytes(bytes[6..8].try_into().unwrap()),
            object_timestamp: u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        })
    }

    /// Normalise `object_timestamp` to nanoseconds per `object_flags`.
    /// Unknown flag values default to ns (matching `vector_blf`'s
    /// permissive read).
    pub fn timestamp_ns(self) -> u64 {
        match self.object_flags {
            OBJECT_FLAG_TIME_TEN_MICS => self.object_timestamp.saturating_mul(10_000),
            _ => self.object_timestamp,
        }
    }

    /// Encode this v1 extension header to its fixed 16 bytes.
    pub fn encode(&self) -> [u8; OBJECT_HEADER_V1_BYTES] {
        let mut bytes = [0u8; OBJECT_HEADER_V1_BYTES];
        bytes[0..4].copy_from_slice(&self.object_flags.to_le_bytes());
        bytes[4..6].copy_from_slice(&self.client_index.to_le_bytes());
        bytes[6..8].copy_from_slice(&self.object_version.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.object_timestamp.to_le_bytes());
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_constant_matches_lobj_ascii() {
        assert_eq!(OBJECT_SIGNATURE.to_le_bytes(), *b"LOBJ");
    }

    fn synth_header(header_size: u16, header_version: u16, object_size: u32, object_type: u32) -> [u8; 16] {
        let mut bytes = [0u8; 16];
        bytes[0..4].copy_from_slice(b"LOBJ");
        bytes[4..6].copy_from_slice(&header_size.to_le_bytes());
        bytes[6..8].copy_from_slice(&header_version.to_le_bytes());
        bytes[8..12].copy_from_slice(&object_size.to_le_bytes());
        bytes[12..16].copy_from_slice(&object_type.to_le_bytes());
        bytes
    }

    #[test]
    fn parses_a_minimum_synthetic_header() {
        // A degenerate but well-formed LOG_CONTAINER preamble (no
        // body, no extension): header_size == object_size == 16.
        let bytes = synth_header(16, 1, 16, object_type::LOG_CONTAINER);
        let parsed = ObjectHeaderBase::parse(&bytes).expect("base header should parse");
        assert_eq!(parsed.header_size, 16);
        assert_eq!(parsed.header_version, 1);
        assert_eq!(parsed.object_size, 16);
        assert_eq!(parsed.object_type, object_type::LOG_CONTAINER);
    }

    #[test]
    fn parses_a_can_message2_preamble() {
        // CAN_MESSAGE2: header_size = 32 (ObjectHeaderBase + ObjectHeader v1),
        // object_size = 32 + 16 (CAN_MESSAGE2 body) + 0 data bytes = 48.
        let bytes = synth_header(32, 1, 48, object_type::CAN_MESSAGE2);
        let parsed = ObjectHeaderBase::parse(&bytes).expect("CAN_MESSAGE2 preamble parses");
        assert_eq!(parsed.header_size, 32);
        assert_eq!(parsed.object_type, object_type::CAN_MESSAGE2);
    }

    #[test]
    fn rejects_short_buffer() {
        let err = ObjectHeaderBase::parse(&[0u8; 15]).unwrap_err();
        assert_eq!(err, ObjectHeaderError::Truncated(15));
    }

    #[test]
    fn rejects_bad_signature() {
        let mut bytes = synth_header(16, 1, 16, object_type::LOG_CONTAINER);
        bytes[0..4].copy_from_slice(b"NOPE");
        let err = ObjectHeaderBase::parse(&bytes).unwrap_err();
        assert!(matches!(err, ObjectHeaderError::BadSignature(_)));
    }

    #[test]
    fn rejects_undersized_header_size() {
        let bytes = synth_header(8, 1, 32, object_type::LOG_CONTAINER);
        let err = ObjectHeaderBase::parse(&bytes).unwrap_err();
        assert_eq!(err, ObjectHeaderError::HeaderSizeTooSmall(8));
    }

    #[test]
    fn rejects_object_size_below_header() {
        let bytes = synth_header(32, 1, 24, object_type::CAN_MESSAGE2);
        let err = ObjectHeaderBase::parse(&bytes).unwrap_err();
        assert_eq!(err, ObjectHeaderError::ObjectSizeBelowHeader(24, 32));
    }

    #[test]
    fn object_header_v1_parses_a_nanosecond_timestamp() {
        let mut bytes = [0u8; 16];
        bytes[0..4].copy_from_slice(&OBJECT_FLAG_TIME_ONE_NANS.to_le_bytes());
        bytes[4..6].copy_from_slice(&7u16.to_le_bytes());
        bytes[6..8].copy_from_slice(&0u16.to_le_bytes());
        bytes[8..16].copy_from_slice(&1_700_000_000_999_888_777u64.to_le_bytes());
        let parsed = ObjectHeaderV1::parse(&bytes).unwrap();
        assert_eq!(parsed.object_flags, OBJECT_FLAG_TIME_ONE_NANS);
        assert_eq!(parsed.client_index, 7);
        assert_eq!(parsed.timestamp_ns(), 1_700_000_000_999_888_777);
    }

    #[test]
    fn object_header_v1_scales_ten_micros_to_nanoseconds() {
        let mut bytes = [0u8; 16];
        bytes[0..4].copy_from_slice(&OBJECT_FLAG_TIME_TEN_MICS.to_le_bytes());
        bytes[8..16].copy_from_slice(&123u64.to_le_bytes());
        let parsed = ObjectHeaderV1::parse(&bytes).unwrap();
        assert_eq!(parsed.timestamp_ns(), 123 * 10_000);
    }

    #[test]
    fn object_header_v1_rejects_short_buffer() {
        let err = ObjectHeaderV1::parse(&[0u8; 8]).unwrap_err();
        assert_eq!(err, ObjectHeaderError::Truncated(8));
    }

    /// Padding formula is `object_size % 4` per Vector's own code
    /// (and `blf_asc`'s). For `object_size` = 17, that's 1 byte of
    /// padding → next object starts at offset 18, NOT 20.
    #[test]
    fn advance_bytes_follows_vector_padding_formula() {
        let cases = [
            (16u32, 16u64), // 16 % 4 = 0
            (17, 18),       // 17 % 4 = 1
            (18, 20),       // 18 % 4 = 2
            (19, 22),       // 19 % 4 = 3
            (20, 20),       // 20 % 4 = 0
            (48, 48),       // 48 % 4 = 0 (CAN_MESSAGE / CAN_MESSAGE2 with empty body)
            (113, 114),     // matches the LOG_CONTAINER size seen in a real BLF
        ];
        for (size, expected) in cases {
            let bytes = synth_header(16, 1, size, object_type::LOG_CONTAINER);
            let parsed = ObjectHeaderBase::parse(&bytes).unwrap();
            assert_eq!(
                parsed.advance_bytes(),
                expected,
                "object_size={size} expected advance {expected}",
            );
        }
    }
}
