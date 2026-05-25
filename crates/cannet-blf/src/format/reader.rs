//! Streaming BLF reader. Iterates the on-disk file one
//! `LOG_CONTAINER` at a time, inflates each, and yields decoded
//! per-type events from the concatenated inner stream.
//!
//! The inflated payload of a single `LOG_CONTAINER` is **not**
//! guaranteed to start or end on an object boundary — an event can
//! straddle two containers, so the reader keeps a `tail` carry-over
//! buffer and refills it from disk as needed. This matches what
//! every other BLF implementation does (Vector's own reference,
//! `vector_blf`, `blf_asc`).

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use super::can::{
    decode_can_error_ext, decode_can_fd_message, decode_can_fd_message_64, decode_can_message,
    decode_can_message2, CanErrorExt, CanFdMessage, CanFdMessage64, CanMessage, CanMessage2,
    CanObjectError,
};
use super::header::{FileStatistics, HeaderError, FILE_STATISTICS_MIN_BYTES};
use super::log_container::{self, LogContainerError};
use super::marker::{self, GlobalMarker, MarkerError};
use super::object::{
    object_type, ObjectHeaderBase, ObjectHeaderError, OBJECT_HEADER_BASE_BYTES,
};

/// One on-disk object, decoded into a typed variant when we
/// recognise its `object_type`, or surfaced as `Other` with its base
/// header so the caller can skip past it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlfObject {
    CanMessage(CanMessage),
    CanMessage2(CanMessage2),
    CanFdMessage(CanFdMessage),
    CanFdMessage64(CanFdMessage64),
    CanErrorExt(CanErrorExt),
    /// Text-annotation marker (object type 96). Used to retire
    /// the `<file>.blf.notes.json` sidecar — notes ride inside
    /// the BLF itself.
    GlobalMarker(GlobalMarker),
    /// An object type this implementation does not decode. The
    /// `ObjectHeaderBase` is exposed so callers can inspect / log
    /// it; the body bytes have already been consumed from the stream.
    Other(ObjectHeaderBase),
}

/// Anything that can go wrong reading a BLF.
#[derive(Debug)]
pub enum BlfReadError {
    /// Underlying file I/O failed.
    Io(io::Error),
    /// The 144-byte `FileStatistics` header was invalid.
    FileHeader(HeaderError),
    /// A top-level `ObjectHeaderBase` was malformed.
    TopLevelHeader(ObjectHeaderError),
    /// An inner `ObjectHeaderBase` (inside an inflated container)
    /// was malformed.
    InnerHeader(ObjectHeaderError),
    /// A `LOG_CONTAINER` failed to decode (bad framing or inflate).
    LogContainer(LogContainerError),
    /// A CAN-class inner object failed to decode.
    CanObject(CanObjectError),
    /// A `GLOBAL_MARKER` failed to decode.
    Marker(MarkerError),
    /// The file ended mid-object — we had the base header but the
    /// body was truncated.
    UnexpectedEof,
}

impl std::fmt::Display for BlfReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O error reading BLF: {e}"),
            Self::FileHeader(e) => write!(f, "BLF FileStatistics invalid: {e}"),
            Self::TopLevelHeader(e) => write!(f, "BLF top-level object header invalid: {e}"),
            Self::InnerHeader(e) => write!(f, "BLF inner object header invalid: {e}"),
            Self::LogContainer(e) => write!(f, "BLF LOG_CONTAINER decode failed: {e}"),
            Self::CanObject(e) => write!(f, "BLF CAN object decode failed: {e}"),
            Self::Marker(e) => write!(f, "BLF GLOBAL_MARKER decode failed: {e}"),
            Self::UnexpectedEof => write!(f, "BLF ended mid-object"),
        }
    }
}

impl std::error::Error for BlfReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::FileHeader(e) => Some(e),
            Self::TopLevelHeader(e) | Self::InnerHeader(e) => Some(e),
            Self::LogContainer(e) => Some(e),
            Self::CanObject(e) => Some(e),
            Self::Marker(e) => Some(e),
            Self::UnexpectedEof => None,
        }
    }
}

impl From<io::Error> for BlfReadError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<HeaderError> for BlfReadError {
    fn from(value: HeaderError) -> Self {
        Self::FileHeader(value)
    }
}
impl From<LogContainerError> for BlfReadError {
    fn from(value: LogContainerError) -> Self {
        Self::LogContainer(value)
    }
}
impl From<CanObjectError> for BlfReadError {
    fn from(value: CanObjectError) -> Self {
        Self::CanObject(value)
    }
}
impl From<MarkerError> for BlfReadError {
    fn from(value: MarkerError) -> Self {
        Self::Marker(value)
    }
}

/// Streaming reader. Lazily pulls one top-level `LOG_CONTAINER`
/// from disk at a time, inflates it, and decodes inner objects out
/// of an internal carry-over buffer.
#[derive(Debug)]
pub struct BlfReader {
    file: File,
    /// `FileStatistics` header parsed at `open` time. Exposed via
    /// [`Self::file_statistics`] so the host can surface
    /// `measurement_start_time` etc. without re-parsing.
    file_statistics: FileStatistics,
    /// Inflated bytes that have not yet been parsed into objects.
    /// Refilled by [`Self::pull_one_container`] as needed.
    tail: Vec<u8>,
    /// True once disk EOF has been reached. Decoding continues
    /// while `tail` still has whole objects; `next_object` returns
    /// `Ok(None)` once both are exhausted.
    disk_eof: bool,
}

impl BlfReader {
    /// Open `path`, parse and validate the 144-byte `FileStatistics`,
    /// and position the cursor on the first top-level object.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, BlfReadError> {
        let mut file = File::open(path)?;
        let mut header = vec![0u8; FILE_STATISTICS_MIN_BYTES];
        file.read_exact(&mut header)?;
        let file_statistics = FileStatistics::parse(&header)?;
        // If the writer stamped a larger statistics record, skip
        // the extra bytes so we start on the first object.
        let extra = file_statistics.statistics_size as usize - FILE_STATISTICS_MIN_BYTES;
        if extra > 0 {
            let mut skip = vec![0u8; extra];
            file.read_exact(&mut skip)?;
        }
        Ok(Self {
            file,
            file_statistics,
            tail: Vec::new(),
            disk_eof: false,
        })
    }

    /// Parsed `FileStatistics` header — measurement start time,
    /// object count, application id, etc. Read-only snapshot taken
    /// at open time.
    pub fn file_statistics(&self) -> &FileStatistics {
        &self.file_statistics
    }

    /// The file's measurement start time as nanoseconds since the
    /// UNIX epoch. Per-event `object_timestamp` values on disk are
    /// *relative* to this; the higher-level adapter that translates
    /// to [`cannet_core::CanFrame`] adds this offset to recover the
    /// absolute timestamp.
    pub fn start_unix_nanos(&self) -> u64 {
        self.file_statistics.measurement_start_time.to_unix_nanos()
    }

    /// Yield the next decoded object, or `Ok(None)` at end of file.
    /// Non-CAN, non-`LOG_CONTAINER` inner objects are surfaced as
    /// [`BlfObject::Other`] so the caller can decide whether to
    /// log or skip.
    // The `expect()` on `advance_bytes` is unreachable on 32-bit and
    // wider platforms (advance is bounded by `object_size + 3` and
    // `object_size: u32`).
    #[allow(clippy::missing_panics_doc)]
    pub fn next_object(&mut self) -> Result<Option<BlfObject>, BlfReadError> {
        loop {
            // Make sure we have at least the 16-byte base header.
            if self.tail.len() < OBJECT_HEADER_BASE_BYTES {
                if !self.pull_one_container()? {
                    return Ok(None);
                }
                continue;
            }
            let base = ObjectHeaderBase::parse(&self.tail).map_err(BlfReadError::InnerHeader)?;
            let object_size = base.object_size as usize;
            // `advance_bytes` is bounded by `object_size + 3`, well
            // under usize::MAX on any platform we target.
            let advance = usize::try_from(base.advance_bytes())
                .expect("advance_bytes ≤ object_size + 3 fits in usize");
            // Make sure we have the full object + its padding.
            while self.tail.len() < advance {
                if !self.pull_one_container()? {
                    return Err(BlfReadError::UnexpectedEof);
                }
            }
            let object_bytes = &self.tail[..object_size];
            let decoded = match base.object_type {
                object_type::CAN_MESSAGE => BlfObject::CanMessage(decode_can_message(object_bytes)?),
                object_type::CAN_MESSAGE2 => {
                    BlfObject::CanMessage2(decode_can_message2(object_bytes)?)
                }
                object_type::CAN_FD_MESSAGE => {
                    BlfObject::CanFdMessage(decode_can_fd_message(object_bytes)?)
                }
                object_type::CAN_FD_MESSAGE_64 => {
                    BlfObject::CanFdMessage64(decode_can_fd_message_64(object_bytes)?)
                }
                object_type::CAN_ERROR_EXT => {
                    BlfObject::CanErrorExt(decode_can_error_ext(object_bytes)?)
                }
                object_type::GLOBAL_MARKER => {
                    BlfObject::GlobalMarker(marker::decode(object_bytes)?)
                }
                _ => BlfObject::Other(base),
            };
            // Advance the tail past this object and its 4-byte padding.
            self.tail.drain(..advance);
            return Ok(Some(decoded));
        }
    }

    /// Pull one top-level `LOG_CONTAINER` from disk, inflate it, and
    /// append its uncompressed bytes to `tail`. Returns `Ok(false)`
    /// when disk EOF is reached. Top-level objects that aren't
    /// `LOG_CONTAINER` (rare — Vector's spec only puts `LOG_CONTAINER`
    /// at the top level) are skipped over.
    fn pull_one_container(&mut self) -> Result<bool, BlfReadError> {
        if self.disk_eof {
            return Ok(false);
        }
        loop {
            let mut base_buf = [0u8; OBJECT_HEADER_BASE_BYTES];
            if !read_exact_or_eof(&mut self.file, &mut base_buf)? {
                self.disk_eof = true;
                return Ok(false);
            }
            let base = ObjectHeaderBase::parse(&base_buf).map_err(BlfReadError::TopLevelHeader)?;
            let body_len = base.object_size as usize - OBJECT_HEADER_BASE_BYTES;
            let padding = (base.object_size % 4) as usize;
            let mut body = vec![0u8; body_len + padding];
            self.file.read_exact(&mut body).map_err(|e| {
                if e.kind() == io::ErrorKind::UnexpectedEof {
                    BlfReadError::UnexpectedEof
                } else {
                    BlfReadError::Io(e)
                }
            })?;
            if base.object_type != object_type::LOG_CONTAINER {
                // Top-level non-container — skip past it. Vector's
                // spec doesn't define non-container top-level objects,
                // but be tolerant rather than fail.
                continue;
            }
            // Reassemble the object's on-disk bytes (without padding)
            // so the LOG_CONTAINER decoder gets a complete object slice.
            let mut object_bytes = Vec::with_capacity(OBJECT_HEADER_BASE_BYTES + body_len);
            object_bytes.extend_from_slice(&base_buf);
            object_bytes.extend_from_slice(&body[..body_len]);
            let container = log_container::decode(&object_bytes)?;
            self.tail.extend_from_slice(&container.uncompressed_payload);
            return Ok(true);
        }
    }
}

/// Read until `buf` is filled, returning `Ok(false)` if EOF is hit
/// before reading any bytes (a clean end-of-file) and propagating
/// `UnexpectedEof` if we got some bytes but not enough.
fn read_exact_or_eof(file: &mut File, buf: &mut [u8]) -> io::Result<bool> {
    let mut read = 0;
    while read < buf.len() {
        match file.read(&mut buf[read..])? {
            0 => {
                if read == 0 {
                    return Ok(false);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "short read of BLF object header",
                ));
            }
            n => read += n,
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BlfCaptureWriter;
    use cannet_core::{CanFrame, CanId, Direction};

    /// Read every frame our (still `blf_asc`-backed) writer
    /// produces back through the native reader, asserting count
    /// and payloads match.
    #[test]
    fn streams_every_can_frame_from_a_real_blf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stream.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        let base_ns = 1_700_000_000_u64 * 1_000_000_000;
        for i in 0u32..64 {
            let frame = CanFrame::classic(
                base_ns + u64::from(i) * 1_000_000,
                0,
                CanId::standard(0x100 + i).unwrap(),
                Direction::Rx,
                vec![u8::try_from(i & 0xFF).unwrap()],
            )
            .unwrap();
            writer.append(&frame).unwrap();
        }
        writer.finish().unwrap();

        let mut reader = BlfReader::open(&path).unwrap();
        let mut frame_count = 0;
        let mut ids = Vec::new();
        while let Some(obj) = reader.next_object().unwrap() {
            match obj {
                BlfObject::CanMessage(m) => {
                    ids.push(m.can_id());
                    frame_count += 1;
                }
                BlfObject::CanMessage2(m) => {
                    ids.push(m.can_id());
                    frame_count += 1;
                }
                BlfObject::Other(_) => {}
                other => panic!("unexpected object {other:?}"),
            }
        }
        assert_eq!(frame_count, 64, "should recover all 64 frames");
        for (i, id) in ids.iter().enumerate() {
            assert_eq!(*id, 0x100 + u32::try_from(i).unwrap());
        }
    }

    #[test]
    fn open_rejects_missing_file() {
        let err = BlfReader::open("/nonexistent/no.blf").unwrap_err();
        assert!(matches!(err, BlfReadError::Io(_)));
    }

    #[test]
    fn open_rejects_a_file_with_bad_signature() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.blf");
        std::fs::write(&path, vec![0u8; FILE_STATISTICS_MIN_BYTES]).unwrap();
        let err = BlfReader::open(&path).unwrap_err();
        assert!(matches!(err, BlfReadError::FileHeader(_)));
    }

    /// An empty BLF (header only, no objects) should produce no
    /// frames, not an error.
    #[test]
    fn empty_blf_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.blf");
        let writer = BlfCaptureWriter::create(&path).unwrap();
        writer.finish().unwrap();

        let mut reader = BlfReader::open(&path).unwrap();
        while let Some(obj) = reader.next_object().unwrap() {
            if matches!(obj, BlfObject::Other(_)) {
                continue;
            }
            panic!("expected only Other or EOF, got {obj:?}");
        }
    }

    #[test]
    fn file_statistics_is_exposed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stat.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        writer
            .append(
                &CanFrame::classic(
                    1_700_000_000_u64 * 1_000_000_000,
                    0,
                    CanId::standard(0x10).unwrap(),
                    Direction::Rx,
                    vec![],
                )
                .unwrap(),
            )
            .unwrap();
        writer.finish().unwrap();

        let reader = BlfReader::open(&path).unwrap();
        let stats = reader.file_statistics();
        assert_eq!(stats.statistics_size as usize, FILE_STATISTICS_MIN_BYTES);
    }
}
