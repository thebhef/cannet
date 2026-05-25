//! BLF `LOG_CONTAINER` (object type 10) — the outer wrapper every
//! "real" BLF object lives inside.
//!
//! After the standard 16-byte [`ObjectHeaderBase`], the on-disk
//! container body is:
//!
//! ```text
//! offset  size  field
//! 16      2     compression_method     (0 = none, 2 = zlib deflate)
//! 18      2     reserved_log_container1
//! 20      4     reserved_log_container2
//! 24      4     uncompressed_file_size
//! 28      4     reserved_log_container3
//! 32      *     compressed_payload     (object_size - 32 bytes)
//! ```
//!
//! The on-disk advance after one container is `object_size +
//! pad_to_4(object_size)` — see [`ObjectHeaderBase::advance_bytes`].
//!
//! The decompressed payload is itself a back-to-back sequence of
//! BLF objects (each starting with its own `ObjectHeaderBase`). The
//! per-type decoders consume that stream.
//!
//! [`ObjectHeaderBase`]: super::object::ObjectHeaderBase
//! [`ObjectHeaderBase::advance_bytes`]: super::object::ObjectHeaderBase::advance_bytes

use std::io::{Read, Write};

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;

use super::object::{
    object_type, ObjectHeaderBase, ObjectHeaderError, OBJECT_HEADER_BASE_BYTES,
};

/// Width of the `LOG_CONTAINER`-specific extension body that sits
/// between the 16-byte [`ObjectHeaderBase`] and the compressed
/// payload bytes. Matches `vector_blf::LogContainer::internalHeaderSize`
/// minus the base header.
///
/// [`ObjectHeaderBase`]: super::object::ObjectHeaderBase
pub const LOG_CONTAINER_EXT_HEADER_BYTES: usize = 16;

/// Width of the full per-object header for a `LOG_CONTAINER`:
/// 16 (base) + 16 (extension) = 32 bytes. The compressed payload
/// starts at this offset within the object.
pub const LOG_CONTAINER_HEADER_BYTES: usize = 32;

/// `compression_method` enumerand: payload bytes are stored verbatim.
pub const COMPRESSION_NONE: u16 = 0;
/// `compression_method` enumerand: payload bytes are zlib-compressed
/// (raw zlib stream, *not* gzip).
pub const COMPRESSION_ZLIB: u16 = 2;

/// Parsed `LOG_CONTAINER` header (the 16-byte extension after
/// `ObjectHeaderBase`). The compressed payload follows immediately
/// at `+32` bytes from the start of the object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogContainerHeader {
    /// 0 = no compression, 2 = zlib deflate. Any other value is
    /// returned to the caller as [`LogContainerError::UnknownCompressionMethod`]
    /// from [`decode`] rather than being silently accepted here.
    pub compression_method: u16,
    pub reserved_log_container1: u16,
    pub reserved_log_container2: u32,
    /// Size in bytes of the *decompressed* payload. For
    /// `compression_method == 0` this equals `compressed_payload.len()`.
    pub uncompressed_file_size: u32,
    pub reserved_log_container3: u32,
}

impl LogContainerHeader {
    /// Parse the 16-byte extension header. Slice must start at
    /// offset 16 of the on-disk object (i.e. immediately after the
    /// base header).
    // `try_into().unwrap()` is unreachable: slices come from a
    // length-checked window.
    #[allow(clippy::missing_panics_doc)]
    pub fn parse(bytes: &[u8]) -> Result<Self, LogContainerError> {
        if bytes.len() < LOG_CONTAINER_EXT_HEADER_BYTES {
            return Err(LogContainerError::Truncated(bytes.len()));
        }
        Ok(Self {
            compression_method: u16::from_le_bytes(bytes[0..2].try_into().unwrap()),
            reserved_log_container1: u16::from_le_bytes(bytes[2..4].try_into().unwrap()),
            reserved_log_container2: u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            uncompressed_file_size: u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            reserved_log_container3: u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
        })
    }
}

/// Errors specific to `LOG_CONTAINER` framing and inflation.
#[derive(Debug)]
pub enum LogContainerError {
    /// Buffer was shorter than the 16-byte `LOG_CONTAINER` extension
    /// header. Carries the byte length we got.
    Truncated(usize),
    /// The object's `ObjectHeaderBase.object_type` wasn't `LOG_CONTAINER`.
    /// Carries the actual type so the caller can decide whether to
    /// skip past or surface the mismatch.
    WrongObjectType(u32),
    /// Base header was structurally invalid.
    Header(ObjectHeaderError),
    /// `compression_method` was neither 0 (none) nor 2 (zlib).
    /// Carries the raw method ID.
    UnknownCompressionMethod(u16),
    /// `object_size` was smaller than 32 (base + ext header), so
    /// there's no room for even an empty body. Carries the
    /// reported `object_size`.
    BodyMissing(u32),
    /// zlib inflate returned an error before producing
    /// `uncompressed_file_size` bytes.
    Inflate(std::io::Error),
    /// inflate returned, but produced fewer or more bytes than
    /// `uncompressed_file_size`. Carries `(got, expected)`.
    InflateSizeMismatch(usize, u32),
}

impl std::fmt::Display for LogContainerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated(n) => write!(
                f,
                "LOG_CONTAINER extension header truncated: got {n} bytes, need at least {LOG_CONTAINER_EXT_HEADER_BYTES}",
            ),
            Self::WrongObjectType(t) => write!(
                f,
                "expected LOG_CONTAINER (object_type={}), got object_type={t}",
                object_type::LOG_CONTAINER,
            ),
            Self::Header(e) => write!(f, "LOG_CONTAINER base header invalid: {e}"),
            Self::UnknownCompressionMethod(m) => write!(
                f,
                "LOG_CONTAINER.compression_method = {m}; only 0 (none) and 2 (zlib) are defined",
            ),
            Self::BodyMissing(s) => write!(
                f,
                "LOG_CONTAINER.object_size = {s} < {LOG_CONTAINER_HEADER_BYTES}; no room for the compressed body",
            ),
            Self::Inflate(e) => write!(f, "LOG_CONTAINER zlib inflate failed: {e}"),
            Self::InflateSizeMismatch(got, expected) => write!(
                f,
                "LOG_CONTAINER inflated to {got} bytes, expected {expected}",
            ),
        }
    }
}

impl std::error::Error for LogContainerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Header(e) => Some(e),
            Self::Inflate(e) => Some(e),
            _ => None,
        }
    }
}

impl From<ObjectHeaderError> for LogContainerError {
    fn from(value: ObjectHeaderError) -> Self {
        Self::Header(value)
    }
}

/// One fully decoded `LOG_CONTAINER`: its parsed header plus the
/// inflated payload bytes (the back-to-back inner object stream).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogContainer {
    pub base: ObjectHeaderBase,
    pub header: LogContainerHeader,
    /// Decompressed payload bytes. For `compression_method == 0`
    /// this is a copy of the on-disk bytes; for `compression_method
    /// == 2` it's the zlib-inflated output.
    pub uncompressed_payload: Vec<u8>,
}

/// Encode a sequence of inner-object bytes into one on-disk
/// `LOG_CONTAINER`, including the 16-byte base header, the 16-byte
/// extension, the (compressed or raw) payload, and the trailing
/// `object_size % 4` padding bytes. Returns the on-disk byte
/// sequence ready to write.
///
/// `inner_bytes` is the back-to-back stream of already-encoded
/// inner objects (each with its own `ObjectHeaderBase`, body, and
/// any inter-object padding). The caller built it; this function
/// just wraps and compresses.
///
/// `compression_method` must be either [`COMPRESSION_NONE`] (0) or
/// [`COMPRESSION_ZLIB`] (2).
///
/// # Errors
///
/// Returns [`LogContainerError::UnknownCompressionMethod`] for any
/// other method value; the zlib path itself can't fail (we use
/// `flate2::write::ZlibEncoder<Vec<u8>>`, an in-memory sink).
#[allow(clippy::missing_panics_doc)]
pub fn encode(inner_bytes: &[u8], compression_method: u16) -> Result<Vec<u8>, LogContainerError> {
    let compressed = match compression_method {
        COMPRESSION_NONE => inner_bytes.to_vec(),
        COMPRESSION_ZLIB => {
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(inner_bytes).expect("in-memory write");
            encoder.finish().expect("in-memory finish")
        }
        other => return Err(LogContainerError::UnknownCompressionMethod(other)),
    };

    let object_size = u32::try_from(LOG_CONTAINER_HEADER_BYTES + compressed.len())
        .expect("LOG_CONTAINER size fits in u32 (4 GiB upper bound)");
    let padding = (object_size % 4) as usize;

    let mut out = Vec::with_capacity(object_size as usize + padding);

    let base = ObjectHeaderBase {
        header_size: u16::try_from(OBJECT_HEADER_BASE_BYTES)
            .expect("OBJECT_HEADER_BASE_BYTES == 16, fits in u16"),
        header_version: 1,
        object_size,
        object_type: object_type::LOG_CONTAINER,
    };
    out.extend_from_slice(&base.encode());

    // Extension header
    out.extend_from_slice(&compression_method.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved1
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved2
    let uncompressed_file_size = u32::try_from(inner_bytes.len())
        .expect("inner_bytes length fits in u32");
    out.extend_from_slice(&uncompressed_file_size.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved3

    // Payload + padding
    out.extend_from_slice(&compressed);
    out.resize(out.len() + padding, 0);

    Ok(out)
}

/// Decode one `LOG_CONTAINER` object whose on-disk bytes start at
/// the front of `object_bytes`. Slice length must be at least
/// `base.object_size` — typically the caller will pass exactly that
/// window taken from the underlying file.
///
/// The 4-byte inter-object padding ([`ObjectHeaderBase::advance_bytes`])
/// is *not* consumed here; the caller advances by that amount when
/// stepping to the next object.
///
/// [`ObjectHeaderBase::advance_bytes`]: super::object::ObjectHeaderBase::advance_bytes
pub fn decode(object_bytes: &[u8]) -> Result<LogContainer, LogContainerError> {
    let base = ObjectHeaderBase::parse(object_bytes)?;
    if base.object_type != object_type::LOG_CONTAINER {
        return Err(LogContainerError::WrongObjectType(base.object_type));
    }
    if (base.object_size as usize) < LOG_CONTAINER_HEADER_BYTES {
        return Err(LogContainerError::BodyMissing(base.object_size));
    }
    // Vector stamps `header_size = 16` (base-only) on LOG_CONTAINER;
    // the 16-byte LOG_CONTAINER extension sits *after* the base
    // header but is not counted in `header_size`. We locate it at
    // the canonical fixed offset, matching `vector_blf::LogContainer::read`.
    let header = LogContainerHeader::parse(
        &object_bytes[super::object::OBJECT_HEADER_BASE_BYTES..LOG_CONTAINER_HEADER_BYTES],
    )?;
    let compressed = &object_bytes[LOG_CONTAINER_HEADER_BYTES..base.object_size as usize];

    let uncompressed_payload = match header.compression_method {
        COMPRESSION_NONE => compressed.to_vec(),
        COMPRESSION_ZLIB => {
            let mut out = Vec::with_capacity(header.uncompressed_file_size as usize);
            let mut decoder = ZlibDecoder::new(compressed);
            decoder
                .read_to_end(&mut out)
                .map_err(LogContainerError::Inflate)?;
            if out.len() != header.uncompressed_file_size as usize {
                return Err(LogContainerError::InflateSizeMismatch(
                    out.len(),
                    header.uncompressed_file_size,
                ));
            }
            out
        }
        other => return Err(LogContainerError::UnknownCompressionMethod(other)),
    };

    Ok(LogContainer {
        base,
        header,
        uncompressed_payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hand-rolls one full `LOG_CONTAINER` object's on-disk bytes
    /// (base header + extension + payload), no padding. The caller
    /// is responsible for any inter-object padding.
    fn synth_container(compression_method: u16, payload: &[u8], uncompressed_size: u32) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(LOG_CONTAINER_HEADER_BYTES + payload.len());
        // base header
        bytes.extend_from_slice(b"LOBJ");
        bytes.extend_from_slice(&16u16.to_le_bytes()); // header_size
        bytes.extend_from_slice(&1u16.to_le_bytes()); // header_version
        let object_size = u32::try_from(LOG_CONTAINER_HEADER_BYTES + payload.len()).unwrap();
        bytes.extend_from_slice(&object_size.to_le_bytes()); // object_size
        bytes.extend_from_slice(&object_type::LOG_CONTAINER.to_le_bytes()); // object_type
        // extension header
        bytes.extend_from_slice(&compression_method.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes()); // reserved1
        bytes.extend_from_slice(&0u32.to_le_bytes()); // reserved2
        bytes.extend_from_slice(&uncompressed_size.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes()); // reserved3
        // payload
        bytes.extend_from_slice(payload);
        bytes
    }

    fn zlib_compress(input: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(input).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn decodes_an_uncompressed_container() {
        let inner = b"hello world, this is the inner BLF object stream";
        let bytes = synth_container(COMPRESSION_NONE, inner, u32::try_from(inner.len()).unwrap());
        let decoded = decode(&bytes).expect("uncompressed container decodes");
        assert_eq!(decoded.base.object_type, object_type::LOG_CONTAINER);
        assert_eq!(decoded.header.compression_method, COMPRESSION_NONE);
        assert_eq!(decoded.uncompressed_payload, inner);
    }

    #[test]
    fn decodes_a_zlib_compressed_container() {
        // Compressible body: a 1024-byte run with structure (low
        // nibble counts up 0..15, high nibble cycles slowly), so
        // zlib produces a meaningful payload to inflate.
        let inner: Vec<u8> = (0..1024u32)
            .map(|i| u8::try_from(i & 0xFF).unwrap())
            .collect();
        let compressed = zlib_compress(&inner);
        let bytes = synth_container(
            COMPRESSION_ZLIB,
            &compressed,
            u32::try_from(inner.len()).unwrap(),
        );
        let decoded = decode(&bytes).expect("zlib container decodes");
        assert_eq!(decoded.header.compression_method, COMPRESSION_ZLIB);
        assert_eq!(decoded.uncompressed_payload, inner);
    }

    #[test]
    fn rejects_non_log_container_object_type() {
        let inner = b"x";
        let mut bytes = synth_container(COMPRESSION_NONE, inner, 1);
        bytes[12..16].copy_from_slice(&object_type::CAN_MESSAGE2.to_le_bytes());
        let err = decode(&bytes).unwrap_err();
        assert!(matches!(err, LogContainerError::WrongObjectType(t) if t == object_type::CAN_MESSAGE2));
    }

    #[test]
    fn rejects_unknown_compression_method() {
        let bytes = synth_container(7, b"abc", 3);
        let err = decode(&bytes).unwrap_err();
        assert!(matches!(err, LogContainerError::UnknownCompressionMethod(7)));
    }

    #[test]
    fn rejects_inflate_size_mismatch() {
        // Compress 4 bytes but lie about the uncompressed size.
        let inner = b"abcd";
        let compressed = zlib_compress(inner);
        let bytes = synth_container(COMPRESSION_ZLIB, &compressed, 999);
        let err = decode(&bytes).unwrap_err();
        assert!(matches!(
            err,
            LogContainerError::InflateSizeMismatch(4, 999)
        ));
    }

    #[test]
    fn rejects_object_size_too_small_for_body() {
        // Build a base header that claims object_size = 24, less than
        // the 32-byte LOG_CONTAINER header.
        let mut bytes = vec![0u8; 24];
        bytes[0..4].copy_from_slice(b"LOBJ");
        bytes[4..6].copy_from_slice(&16u16.to_le_bytes());
        bytes[6..8].copy_from_slice(&1u16.to_le_bytes());
        bytes[8..12].copy_from_slice(&24u32.to_le_bytes());
        bytes[12..16].copy_from_slice(&object_type::LOG_CONTAINER.to_le_bytes());
        let err = decode(&bytes).unwrap_err();
        assert!(matches!(err, LogContainerError::BodyMissing(24)));
    }

    #[test]
    fn encode_round_trips_through_decode() {
        let inner = (0..512u32)
            .map(|i| u8::try_from(i & 0xFF).unwrap())
            .collect::<Vec<_>>();
        for method in [COMPRESSION_NONE, COMPRESSION_ZLIB] {
            let bytes = encode(&inner, method).unwrap();
            let decoded = decode(&bytes).unwrap();
            assert_eq!(decoded.header.compression_method, method);
            assert_eq!(decoded.uncompressed_payload, inner);
            // Padding is applied correctly: total bytes is object_size
            // plus `object_size % 4`.
            let expected_total = decoded.base.object_size as usize
                + (decoded.base.object_size as usize % 4);
            assert_eq!(bytes.len(), expected_total);
        }
    }

    #[test]
    fn encode_rejects_unknown_compression_method() {
        let err = encode(b"abc", 7).unwrap_err();
        assert!(matches!(err, LogContainerError::UnknownCompressionMethod(7)));
    }

    /// Round-trip: pull the (single, well-formed) `LOG_CONTAINER` out
    /// of a real BLF written by our wrapper (still `blf_asc`-backed
    /// in Tranche 0/early-1) and inflate it. Confirms the on-disk
    /// shape `blf_asc` produces matches what our parser expects.
    #[test]
    fn decodes_log_container_of_a_blf_written_by_our_writer() {
        use crate::BlfCaptureWriter;
        use cannet_core::{CanFrame, CanId, Direction};
        use std::io::Read;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("container.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        for i in 0u32..16 {
            let f = CanFrame::classic(
                1_700_000_000_u64 * 1_000_000_000 + u64::from(i) * 1_000_000,
                0,
                CanId::standard(0x100 + i).unwrap(),
                Direction::Rx,
                vec![u8::try_from(i & 0xFF).unwrap()],
            )
            .unwrap();
            writer.append(&f).unwrap();
        }
        writer.finish().unwrap();

        // Read the file; skip the 144-byte FileStatistics; parse the
        // first object — which `blf_asc` writes as a LOG_CONTAINER.
        let mut file = std::fs::File::open(&path).unwrap();
        let mut all = Vec::new();
        file.read_to_end(&mut all).unwrap();
        let after_stats = &all[super::super::header::FILE_STATISTICS_MIN_BYTES..];

        let base = ObjectHeaderBase::parse(after_stats).unwrap();
        assert_eq!(
            base.object_type,
            object_type::LOG_CONTAINER,
            "first object after FileStatistics should be LOG_CONTAINER",
        );

        let container = decode(&after_stats[..base.object_size as usize])
            .expect("real LOG_CONTAINER decodes");
        // The inflated payload starts with another ObjectHeaderBase
        // (the first inner CAN_MESSAGE2 / CAN_MESSAGE).
        let inner = ObjectHeaderBase::parse(&container.uncompressed_payload)
            .expect("inner object header parses");
        assert!(
            inner.object_type == object_type::CAN_MESSAGE
                || inner.object_type == object_type::CAN_MESSAGE2,
            "first inner object should be a CAN message, got type {}",
            inner.object_type,
        );
    }
}
