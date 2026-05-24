//! Vector BLF log file as a [`cannet_core::CanFrameSource`], plus the
//! Phase-9 [`BlfCaptureWriter`] that turns a stream of
//! [`cannet_core::CanFrame`]s back into a BLF file.
//!
//! Today the reader wraps `blf_asc::BlfReader` and translates each
//! `blf_asc::Message` into a [`cannet_core::CanFrame`], picking the
//! right [`CanFramePayload`] variant based on the BLF object flags
//! (classic data / FD / remote / error). The wire shape from the
//! underlying parser is hidden behind this adapter so the rest of
//! the system only ever sees `cannet_core` types.
//!
//! The writer mirrors the reader on top of `blf_asc::BlfWriter` and
//! streams to `<dest>.part` before atomically renaming into place on
//! [`BlfCaptureWriter::finish`] — a mid-write crash therefore leaves
//! no half-file behind at `<dest>`.
//!
//! ## Phase 9.5 — native implementation in progress
//!
//! Per [ADR 0009](../../../docs/adr/0009-dbc-blf-readers.md), the
//! `blf_asc` wrapper is being replaced tranche-by-tranche with a
//! focused native implementation rooted in [`format`]. The public
//! `BlfCanFrameSource` / `BlfCaptureWriter` surface stays unchanged
//! across the swap. The
//! [BLF feature-support matrix](../../../docs/blf-feature-support.md)
//! is the running checklist; each landed object type updates its
//! row in the same commit that ships the code. The
//! `vector-blf-oracle` cargo feature enables black-box comparison
//! tests against Technica's `vector_blf` C++ library
//! (`tests/oracle.rs`).
//!
//! [`CanFramePayload`]: cannet_core::CanFramePayload
//!
//! ## Marker / annotation round-trip
//!
//! Upstream `blf_asc` 0.2 covers only frame object types; it has no
//! `GLOBAL_MARKER` write surface and exposes no hook on `BlfWriter`
//! for arbitrary object emission. Phase 9 ships note round-trip via
//! a sidecar `<file>.blf.notes.json` written alongside the BLF —
//! the third-party-reader visibility of notes is a documented
//! deferral that Phase 9.5 Tranche 2 (`GLOBAL_MARKER` read+write)
//! unblocks.

pub mod format;

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use blf_asc::{ArbitrationId, BlfError, BlfReader, BlfWriter, DataBytes, Message};
use cannet_core::{
    CanFdFlags, CanFrame, CanFrameError, CanFramePayload, CanFrameSource, CanId, Direction, IdError,
};

/// A `CanFrameSource` backed by a Vector BLF log file.
pub struct BlfCanFrameSource {
    reader: BlfReader,
}

impl BlfCanFrameSource {
    /// Open `path` as a BLF file. Returns an error if the file can't be
    /// opened or fails BLF header validation.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, BlfSourceError> {
        let reader = BlfReader::open(path)?;
        Ok(Self { reader })
    }
}

impl CanFrameSource for BlfCanFrameSource {
    type Error = BlfSourceError;

    fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
        match self.reader.next_message()? {
            Some(msg) => Ok(Some(message_to_frame(&msg)?)),
            None => Ok(None),
        }
    }
}

#[derive(Debug)]
pub enum BlfSourceError {
    /// Underlying BLF parser error.
    Blf(BlfError),
    /// BLF channel field overflowed `CanFrame`'s 0..=255 channel space.
    ChannelOutOfRange(u16),
    /// BLF row carried a CAN id that didn't fit its declared addressing
    /// mode (standard / extended).
    InvalidId(IdError),
    /// Payload length didn't match the constraints of the chosen frame
    /// variant (e.g. >8 bytes on a classic frame).
    InvalidFrame(CanFrameError),
    /// Negative or non-finite timestamp, which BLF should never produce.
    InvalidTimestamp(f64),
}

impl std::fmt::Display for BlfSourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Blf(e) => write!(f, "blf parser error: {e}"),
            Self::ChannelOutOfRange(c) => {
                write!(f, "blf channel {c} exceeds CanFrame::channel u8 range")
            }
            Self::InvalidId(e) => write!(f, "invalid CAN id in BLF row: {e}"),
            Self::InvalidFrame(e) => write!(f, "invalid frame produced from BLF row: {e}"),
            Self::InvalidTimestamp(t) => write!(f, "non-representable BLF timestamp: {t}"),
        }
    }
}

impl std::error::Error for BlfSourceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Blf(e) => Some(e),
            Self::InvalidId(e) => Some(e),
            Self::InvalidFrame(e) => Some(e),
            Self::ChannelOutOfRange(_) | Self::InvalidTimestamp(_) => None,
        }
    }
}

impl From<BlfError> for BlfSourceError {
    fn from(value: BlfError) -> Self {
        Self::Blf(value)
    }
}
impl From<IdError> for BlfSourceError {
    fn from(value: IdError) -> Self {
        Self::InvalidId(value)
    }
}
impl From<CanFrameError> for BlfSourceError {
    fn from(value: CanFrameError) -> Self {
        Self::InvalidFrame(value)
    }
}

fn message_to_frame(msg: &Message) -> Result<CanFrame, BlfSourceError> {
    let timestamp_ns = seconds_to_nanos(msg.timestamp)?;
    let channel = u8::try_from(msg.channel)
        .map_err(|_| BlfSourceError::ChannelOutOfRange(msg.channel))?;

    let raw_id = u32::from(msg.arbitration_id);
    let id = if msg.is_extended_id {
        CanId::extended(raw_id)?
    } else {
        CanId::standard(raw_id)?
    };

    let direction = if msg.is_rx { Direction::Rx } else { Direction::Tx };

    let payload = if msg.is_error_frame {
        CanFramePayload::Error
    } else if msg.is_remote_frame {
        CanFramePayload::Remote { dlc: msg.dlc }
    } else if msg.is_fd {
        let flags = CanFdFlags {
            bitrate_switch: msg.bitrate_switch,
            error_state_indicator: msg.error_state_indicator,
        };
        CanFramePayload::Fd { data: msg.data.to_vec(), flags }
    } else {
        CanFramePayload::Classic(msg.data.to_vec())
    };

    // The validating constructors live on CanFrame, but we already chose the
    // payload variant explicitly above. Re-check via the constructors so
    // any length violation surfaces as InvalidFrame instead of silently
    // producing a malformed frame.
    match payload {
        CanFramePayload::Classic(data) => Ok(CanFrame::classic(timestamp_ns, channel, id, direction, data)?),
        CanFramePayload::Fd { data, flags } => {
            Ok(CanFrame::fd(timestamp_ns, channel, id, direction, data, flags)?)
        }
        CanFramePayload::Remote { dlc } => Ok(CanFrame::remote(timestamp_ns, channel, id, direction, dlc)),
        CanFramePayload::Error => Ok(CanFrame::error(timestamp_ns, channel, id, direction)),
    }
}

/// Streaming BLF writer driven by [`cannet_core::CanFrame`]s.
///
/// Streams to `<dest>.part` and renames to `<dest>` on
/// [`BlfCaptureWriter::finish`]. Drop without `finish` discards
/// the partial file. Frame types covered match what
/// [`BlfCanFrameSource`] reads back — classic CAN, CAN FD, error,
/// and remote.
///
/// # Time precision
///
/// `blf_asc` stores per-object timestamps as a relative `u64`
/// nanosecond offset from the file's start, but the public
/// `Message.timestamp` is `f64` seconds. The writer converts
/// `u64`-ns → `f64`-s and back via `blf_asc`; for absolute
/// timestamps in the modern epoch (≈1.7e18 ns) the round-trip
/// loses sub-microsecond precision. The caller can compare
/// [`BlfCaptureWriter::finish`]'s reported `max_timestamp_drift_ns`
/// against an expected tolerance to decide whether to surface a
/// "precision degraded" message — see the Phase-9 docs.
pub struct BlfCaptureWriter {
    /// Final destination path the temp file renames to on
    /// [`Self::finish`].
    dest: PathBuf,
    /// Temp file path the writer streams to (`<dest>.part`).
    temp: PathBuf,
    /// `Option` so [`Self::finish`] can take ownership and call
    /// `finish` on it before the rename. Cleared on success so
    /// [`Drop`] doesn't double-finish.
    inner: Option<BlfWriter>,
    /// Largest observed `|on-disk-ns - source-ns|` across the
    /// frames we've written so far. Reported by [`Self::finish`]
    /// so the host can warn if the f64-seconds round-trip is
    /// dropping measurable precision.
    max_drift_ns: u64,
    /// Frame count appended so far — included in
    /// [`FinishedCapture`] for system-log integration.
    frame_count: u64,
}

/// Successful [`BlfCaptureWriter::finish`] outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FinishedCapture {
    /// Number of frames written to the BLF.
    pub frame_count: u64,
    /// On-disk file size of the renamed-into-place BLF.
    pub byte_size: u64,
    /// Largest observed `|on-disk-ns - source-ns|` round-trip
    /// drift across the written frames. Useful for surfacing a
    /// "precision degraded" warning when the f64-seconds storage
    /// loses sub-microsecond precision vs. the in-memory ns
    /// timeline (which it does for modern absolute timestamps).
    pub max_timestamp_drift_ns: u64,
}

/// Anything that can go wrong driving a [`BlfCaptureWriter`].
#[derive(Debug)]
pub enum BlfWriteError {
    /// Underlying BLF writer error.
    Blf(BlfError),
    /// I/O error opening, finalising, or renaming the temp file.
    Io(io::Error),
    /// The wrapped writer's reported byte length didn't fit a
    /// `u64`. (Practically unreachable; reported for completeness
    /// rather than swallowed.)
    LengthOverflow,
}

impl std::fmt::Display for BlfWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Blf(e) => write!(f, "blf writer error: {e}"),
            Self::Io(e) => write!(f, "blf writer I/O error: {e}"),
            Self::LengthOverflow => f.write_str("finished BLF file length overflowed u64"),
        }
    }
}

impl std::error::Error for BlfWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Blf(e) => Some(e),
            Self::Io(e) => Some(e),
            Self::LengthOverflow => None,
        }
    }
}

impl From<BlfError> for BlfWriteError {
    fn from(value: BlfError) -> Self {
        Self::Blf(value)
    }
}

impl From<io::Error> for BlfWriteError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl BlfCaptureWriter {
    /// Open a new capture writer that will produce `dest` on
    /// success. Streams to `<dest>.part`; calling [`Self::finish`]
    /// renames into place atomically, while dropping without
    /// `finish` (mid-write crash) leaves only the temp file behind.
    pub fn create<P: AsRef<Path>>(dest: P) -> Result<Self, BlfWriteError> {
        let dest = dest.as_ref().to_path_buf();
        let temp = temp_path_for(&dest);
        let inner = BlfWriter::create(&temp)?;
        Ok(Self {
            dest,
            temp,
            inner: Some(inner),
            max_drift_ns: 0,
            frame_count: 0,
        })
    }

    /// Append one [`CanFrame`] to the capture.
    pub fn append(&mut self, frame: &CanFrame) -> Result<(), BlfWriteError> {
        let inner = self.inner.as_mut().ok_or_else(|| {
            BlfWriteError::Io(io::Error::other("writer has already been finished"))
        })?;
        let msg = frame_to_message(frame);
        // Track the round-trip drift the f64-seconds storage will
        // introduce. We're about to write `msg.timestamp`; the
        // reader will recover `(msg.timestamp * 1e9) as u64`, which
        // for modern absolute timestamps differs from the source
        // ns by tens to hundreds of ns. Comparing the two before
        // we hand off the message gives us the exact drift this
        // frame contributes.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let recovered_ns = (msg.timestamp * 1e9) as u64;
        let drift = recovered_ns.abs_diff(frame.timestamp_ns);
        if drift > self.max_drift_ns {
            self.max_drift_ns = drift;
        }
        inner.on_message_received(&msg)?;
        self.frame_count += 1;
        Ok(())
    }

    /// Flush, finalise, and rename the temp file into the
    /// destination. Returns the byte size and frame count for the
    /// host's system-message integration.
    pub fn finish(mut self) -> Result<FinishedCapture, BlfWriteError> {
        let mut inner = self
            .inner
            .take()
            .ok_or_else(|| BlfWriteError::Io(io::Error::other("writer has already been finished")))?;
        inner.finish()?;
        // Drop the writer to close the underlying file before
        // rename — on Windows, renaming a file with an open
        // handle fails.
        drop(inner);
        fs::rename(&self.temp, &self.dest)?;
        let byte_size = File::open(&self.dest)?.metadata()?.len();
        Ok(FinishedCapture {
            frame_count: self.frame_count,
            byte_size,
            max_timestamp_drift_ns: self.max_drift_ns,
        })
    }
}

impl Drop for BlfCaptureWriter {
    fn drop(&mut self) {
        // If we still have an inner writer, the caller never
        // reached `finish`. Drop the inner first so the file
        // handle closes, then remove the partial file so the
        // destination is observably untouched.
        if let Some(mut inner) = self.inner.take() {
            let _ = inner.finish();
            let _ = fs::remove_file(&self.temp);
        }
    }
}

/// `<dest>.part`. Kept as a free function so the unit tests can
/// reason about the contract without going through the writer.
fn temp_path_for(dest: &Path) -> PathBuf {
    let mut name = dest
        .file_name()
        .map(std::ffi::OsString::from)
        .unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

/// Convert a [`CanFrame`] into the on-the-wire `blf_asc::Message`
/// shape — the inverse of [`message_to_frame`]. The mapping is
/// total: every `CanFrame` produces one `Message`.
fn frame_to_message(frame: &CanFrame) -> Message {
    let timestamp = ns_to_seconds(frame.timestamp_ns);
    let arbitration_id = ArbitrationId(frame.id.raw());
    let is_extended_id = frame.id.is_extended();
    let is_rx = matches!(frame.direction, Direction::Rx);
    let channel = u16::from(frame.channel);

    let (is_remote_frame, is_error_frame, is_fd, bitrate_switch, error_state_indicator, dlc, data) =
        match &frame.payload {
            CanFramePayload::Classic(d) => (
                false,
                false,
                false,
                false,
                false,
                u8::try_from(d.len()).unwrap_or(u8::MAX),
                d.clone(),
            ),
            CanFramePayload::Fd { data, flags } => (
                false,
                false,
                true,
                flags.bitrate_switch,
                flags.error_state_indicator,
                u8::try_from(data.len()).unwrap_or(u8::MAX),
                data.clone(),
            ),
            CanFramePayload::Remote { dlc } => (
                true,
                false,
                false,
                false,
                false,
                *dlc,
                Vec::new(),
            ),
            CanFramePayload::Error => (false, true, false, false, false, 0, Vec::new()),
        };

    Message {
        timestamp,
        arbitration_id,
        is_extended_id,
        is_remote_frame,
        is_rx,
        is_error_frame,
        is_fd,
        bitrate_switch,
        error_state_indicator,
        dlc,
        data: DataBytes(data),
        channel,
    }
}

#[allow(clippy::cast_precision_loss)]
fn ns_to_seconds(ns: u64) -> f64 {
    (ns as f64) / 1e9
}

fn seconds_to_nanos(seconds: f64) -> Result<u64, BlfSourceError> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err(BlfSourceError::InvalidTimestamp(seconds));
    }
    // 2^64 ns ≈ 584 years; BLF timestamps cover well under that. The
    // largest f64 that fits in u64 is 2^64 - 2048 ≈ 1.844_674_407e19; the
    // exclusive upper bound `2.0_f64.powi(64)` is the cleanest guard.
    let ns = seconds * 1e9;
    if ns >= 2.0_f64.powi(64) {
        return Err(BlfSourceError::InvalidTimestamp(seconds));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let ns_u64 = ns as u64;
    Ok(ns_u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use blf_asc::{ArbitrationId, BlfWriter, DataBytes};
    use cannet_core::{pump, CanFrameSink};

    /// `blf_asc` only round-trips absolute timestamps when they fit a
    /// SYSTEMTIME header (≥ 1990-01-01). Tests use this base + a small
    /// offset so the round-trip preserves the offset.
    const TS_BASE: f64 = 1_700_000_000.0;

    fn message(offset_secs: f64, id: u32, data: Vec<u8>) -> Message {
        Message {
            timestamp: TS_BASE + offset_secs,
            arbitration_id: ArbitrationId(id),
            is_extended_id: false,
            is_remote_frame: false,
            is_rx: true,
            is_error_frame: false,
            is_fd: false,
            bitrate_switch: false,
            error_state_indicator: false,
            dlc: u8::try_from(data.len()).unwrap(),
            data: DataBytes(data),
            channel: 0,
        }
    }

    fn write_fixture(path: &std::path::Path, msgs: &[Message]) {
        let mut writer = BlfWriter::create(path).unwrap();
        for m in msgs {
            writer.on_message_received(m).unwrap();
        }
        writer.finish().unwrap();
    }

    #[derive(Default)]
    struct VecSink(Vec<CanFrame>);
    impl CanFrameSink for VecSink {
        type Error = std::convert::Infallible;
        fn submit(&mut self, frame: CanFrame) -> Result<(), Self::Error> {
            self.0.push(frame);
            Ok(())
        }
    }

    #[test]
    fn round_trips_classic_frame_through_blf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("classic.blf");
        write_fixture(&path, &[message(0.0, 0x123, vec![1, 2, 3, 4])]);

        let mut source = BlfCanFrameSource::open(&path).unwrap();
        let mut sink = VecSink::default();
        pump(&mut source, &mut sink).unwrap();

        assert_eq!(sink.0.len(), 1);
        let frame = &sink.0[0];
        assert_eq!(frame.id.raw(), 0x123);
        assert!(!frame.id.is_extended());
        assert_eq!(frame.payload.data(), &[1, 2, 3, 4]);
        assert_eq!(frame.direction, Direction::Rx);
    }

    #[test]
    fn maps_extended_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ext.blf");
        let msg = Message {
            arbitration_id: ArbitrationId(0x01AB_CDEF),
            is_extended_id: true,
            ..message(0.001, 0x01AB_CDEF, vec![0xAA])
        };
        write_fixture(&path, &[msg]);

        let mut source = BlfCanFrameSource::open(&path).unwrap();
        let frame = source.next_frame().unwrap().unwrap();
        assert!(frame.id.is_extended());
        assert_eq!(frame.id.raw(), 0x01AB_CDEF);
        // CanFrame is at offset 0.001 s. blf_asc round-trips timestamps as
        // f64 seconds, which loses sub-microsecond precision at modern
        // absolute timestamps; accept ±1 µs of slop.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let expected_ns = (TS_BASE * 1e9) as u64 + 1_000_000;
        let drift = frame.timestamp_ns.abs_diff(expected_ns);
        assert!(drift < 1_000, "timestamp drifted by {drift} ns");
    }

    #[test]
    fn maps_fd_frame_with_flags() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fd.blf");
        let msg = Message {
            is_fd: true,
            bitrate_switch: true,
            error_state_indicator: false,
            dlc: 9, // FD DLC 9 = 12 bytes
            data: DataBytes(vec![0; 12]),
            ..message(0.5, 0x100, vec![])
        };
        write_fixture(&path, &[msg]);

        let mut source = BlfCanFrameSource::open(&path).unwrap();
        let frame = source.next_frame().unwrap().unwrap();
        match &frame.payload {
            CanFramePayload::Fd { data, flags } => {
                assert_eq!(data.len(), 12);
                assert!(flags.bitrate_switch);
                assert!(!flags.error_state_indicator);
            }
            other => panic!("expected FD payload, got {other:?}"),
        }
    }

    #[test]
    fn maps_tx_direction() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tx.blf");
        let msg = Message { is_rx: false, ..message(0.0, 0x10, vec![]) };
        write_fixture(&path, &[msg]);

        let mut source = BlfCanFrameSource::open(&path).unwrap();
        let frame = source.next_frame().unwrap().unwrap();
        assert_eq!(frame.direction, Direction::Tx);
    }

    #[test]
    fn next_frame_returns_none_at_eof() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.blf");
        write_fixture(&path, &[]);

        let mut source = BlfCanFrameSource::open(&path).unwrap();
        assert!(source.next_frame().unwrap().is_none());
    }

    #[test]
    fn open_missing_file_errors() {
        let Err(err) = BlfCanFrameSource::open("/nonexistent/path/no.blf") else {
            panic!("expected error opening nonexistent file");
        };
        assert!(matches!(err, BlfSourceError::Blf(_)));
    }

    #[test]
    fn negative_timestamp_is_rejected() {
        assert!(matches!(
            seconds_to_nanos(-1.0),
            Err(BlfSourceError::InvalidTimestamp(_))
        ));
    }

    #[test]
    fn nan_timestamp_is_rejected() {
        assert!(matches!(
            seconds_to_nanos(f64::NAN),
            Err(BlfSourceError::InvalidTimestamp(_))
        ));
    }

    // ---- Phase-9 capture writer tests ----

    /// Round-trip a classic frame through `BlfCaptureWriter` and
    /// `BlfCanFrameSource`. The base `TS_BASE` is multiplied by 1e9
    /// to land in the same "modern absolute timestamps" regime the
    /// reader tests already use.
    #[test]
    fn capture_writer_round_trips_classic_frame() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.blf");
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let ts_ns = (TS_BASE * 1e9) as u64 + 1_000_000;
        let frame = CanFrame::classic(
            ts_ns,
            2,
            CanId::standard(0x123).unwrap(),
            Direction::Rx,
            vec![1, 2, 3, 4],
        )
        .unwrap();
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        w.append(&frame).unwrap();
        let outcome = w.finish().unwrap();
        assert_eq!(outcome.frame_count, 1);
        assert!(outcome.byte_size > 0);

        let mut r = BlfCanFrameSource::open(&dest).unwrap();
        let back = r.next_frame().unwrap().unwrap();
        assert_eq!(back.id.raw(), 0x123);
        assert!(!back.id.is_extended());
        assert_eq!(back.channel, 2);
        assert_eq!(back.payload.data(), &[1, 2, 3, 4]);
        // Round-trip ns drift fits in 1 µs — the documented
        // precision floor of the f64-seconds storage layer.
        let drift = back.timestamp_ns.abs_diff(ts_ns);
        assert!(drift < 1_000, "round-trip drift {drift} ns > 1 µs");
        assert!(r.next_frame().unwrap().is_none());
    }

    #[test]
    fn capture_writer_round_trips_fd_frame_with_flags() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("fd.blf");
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let ts_ns = (TS_BASE * 1e9) as u64;
        let frame = CanFrame::fd(
            ts_ns,
            0,
            CanId::extended(0x01AB_CDEF).unwrap(),
            Direction::Tx,
            vec![0xAA; 12],
            CanFdFlags {
                bitrate_switch: true,
                error_state_indicator: false,
            },
        )
        .unwrap();
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        w.append(&frame).unwrap();
        w.finish().unwrap();

        let mut r = BlfCanFrameSource::open(&dest).unwrap();
        let back = r.next_frame().unwrap().unwrap();
        assert!(back.id.is_extended());
        assert_eq!(back.id.raw(), 0x01AB_CDEF);
        assert_eq!(back.direction, Direction::Tx);
        match &back.payload {
            CanFramePayload::Fd { data, flags } => {
                assert_eq!(data.len(), 12);
                assert!(flags.bitrate_switch);
                assert!(!flags.error_state_indicator);
            }
            other => panic!("expected FD payload, got {other:?}"),
        }
    }

    #[test]
    fn capture_writer_round_trips_error_frame() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("err.blf");
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let ts_ns = (TS_BASE * 1e9) as u64;
        let frame = CanFrame::error(ts_ns, 1, CanId::standard(0x10).unwrap(), Direction::Rx);
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        w.append(&frame).unwrap();
        w.finish().unwrap();

        let mut r = BlfCanFrameSource::open(&dest).unwrap();
        let back = r.next_frame().unwrap().unwrap();
        assert!(matches!(back.payload, CanFramePayload::Error));
        assert_eq!(back.channel, 1);
    }

    /// Writes succeed across many frames, atomic rename actually
    /// produced the destination, and the temp path no longer exists.
    #[test]
    fn capture_writer_finish_renames_and_cleans_up_temp() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("many.blf");
        let temp = temp_path_for(&dest);
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let base = (TS_BASE * 1e9) as u64;
        for i in 0u32..32 {
            let f = CanFrame::classic(
                base + u64::from(i) * 1_000,
                0,
                CanId::standard(0x100 + i).unwrap(),
                Direction::Rx,
                vec![u8::try_from(i & 0xFF).unwrap()],
            )
            .unwrap();
            w.append(&f).unwrap();
        }
        // While writing the temp file exists at <dest>.part.
        assert!(temp.exists());
        let outcome = w.finish().unwrap();
        assert_eq!(outcome.frame_count, 32);
        assert!(dest.exists());
        assert!(!temp.exists(), "temp file should have been renamed away");
    }

    /// Dropping a writer without `finish` leaves no artefact at
    /// `<dest>`; the temp file is also cleaned up.
    #[test]
    fn capture_writer_drop_without_finish_leaves_no_dest_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("partial.blf");
        let temp = temp_path_for(&dest);
        {
            let mut w = BlfCaptureWriter::create(&dest).unwrap();
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let ts = (TS_BASE * 1e9) as u64;
            w.append(
                &CanFrame::classic(
                    ts,
                    0,
                    CanId::standard(0x10).unwrap(),
                    Direction::Rx,
                    vec![],
                )
                .unwrap(),
            )
            .unwrap();
            // Drop here — no `finish`.
        }
        assert!(!dest.exists(), "destination must not exist after drop");
        assert!(!temp.exists(), "temp file must be cleaned up after drop");
    }

    #[test]
    fn temp_path_helper_appends_part_extension() {
        assert_eq!(
            temp_path_for(Path::new("/tmp/x.blf")),
            PathBuf::from("/tmp/x.blf.part"),
        );
        // Bare filename (no directory part) still works.
        assert_eq!(temp_path_for(Path::new("x.blf")), PathBuf::from("x.blf.part"));
    }

    /// The reported drift is non-zero for modern absolute
    /// timestamps (f64 seconds can't represent ns precision at
    /// ≈1.7e18 ns) — verify it surfaces so the host can warn.
    #[test]
    fn capture_writer_reports_round_trip_drift_for_modern_timestamps() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("drift.blf");
        // 1.7e18 ns ≈ 2023-11-14 — modern, where f64-s drops
        // sub-microsecond precision. Pick a ns value that
        // *intentionally* lands between two representable f64-s
        // values: a prime under 1_000_000 keeps it away from
        // anything the conversion would happen to land on exactly.
        let ts_ns = 1_700_000_000_999_999_983u64;
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        w.append(
            &CanFrame::classic(
                ts_ns,
                0,
                CanId::standard(0x10).unwrap(),
                Direction::Rx,
                vec![],
            )
            .unwrap(),
        )
        .unwrap();
        let outcome = w.finish().unwrap();
        // Drift is non-zero for this regime, and is at most a
        // small number of ns (well under 1 µs).
        assert!(
            outcome.max_timestamp_drift_ns > 0,
            "expected non-zero drift; got {}",
            outcome.max_timestamp_drift_ns,
        );
        assert!(
            outcome.max_timestamp_drift_ns < 1_000,
            "drift {} ns exceeded 1 µs",
            outcome.max_timestamp_drift_ns,
        );
    }
}
