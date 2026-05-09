//! Vector BLF log file as a [`cannet_core::CanFrameSource`].
//!
//! Wraps `blf_asc::BlfReader` and translates each `blf_asc::Message` into
//! a `cannet_core::CanFrame`, picking the right `CanFramePayload` variant based on
//! the BLF object flags (classic data / FD / remote / error). The wire
//! shape from the underlying parser is hidden behind this adapter so the
//! rest of the system only ever sees `cannet_core` types.

use std::path::Path;

use blf_asc::{BlfError, BlfReader, Message};
use cannet_core::{
    CanId, Direction, CanFdFlags, CanFrame, CanFrameError, CanFramePayload, CanFrameSource, IdError,
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
}
