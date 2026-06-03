//! In-process CAN / CAN FD frame representation.
//!
//! Designed to be the single shape used by every in-process consumer (trace,
//! decode) and the network transport — adapters convert at the
//! source, not between consumers.

use core::fmt;

/// Maximum value representable in an 11-bit standard CAN identifier.
pub const STANDARD_ID_MAX: u32 = 0x7FF;
/// Maximum value representable in a 29-bit extended CAN identifier.
pub const EXTENDED_ID_MAX: u32 = 0x1FFF_FFFF;

/// Maximum payload length of a classic CAN data frame, in bytes.
pub const CLASSIC_DATA_MAX: usize = 8;
/// Maximum payload length of a CAN FD data frame, in bytes.
pub const FD_DATA_MAX: usize = 64;

/// A CAN identifier together with its addressing mode (standard / extended).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct CanId {
    raw: u32,
    extended: bool,
}

impl CanId {
    pub fn standard(raw: u32) -> Result<Self, IdError> {
        if raw > STANDARD_ID_MAX {
            return Err(IdError::StandardOutOfRange(raw));
        }
        Ok(Self { raw, extended: false })
    }

    pub fn extended(raw: u32) -> Result<Self, IdError> {
        if raw > EXTENDED_ID_MAX {
            return Err(IdError::ExtendedOutOfRange(raw));
        }
        Ok(Self { raw, extended: true })
    }

    pub fn raw(self) -> u32 {
        self.raw
    }

    pub fn is_extended(self) -> bool {
        self.extended
    }
}

impl fmt::Debug for CanId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let width = if self.extended { 8 } else { 3 };
        let tag = if self.extended { 'x' } else { 's' };
        write!(f, "CanId({tag}:{:0width$X})", self.raw, width = width)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdError {
    StandardOutOfRange(u32),
    ExtendedOutOfRange(u32),
}

impl fmt::Display for IdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StandardOutOfRange(v) => {
                write!(f, "standard CAN id {v:#X} exceeds 11-bit range")
            }
            Self::ExtendedOutOfRange(v) => {
                write!(f, "extended CAN id {v:#X} exceeds 29-bit range")
            }
        }
    }
}

impl std::error::Error for IdError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Rx,
    Tx,
}

/// CAN FD-specific bits carried alongside a data frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CanFdFlags {
    pub bitrate_switch: bool,
    pub error_state_indicator: bool,
}

/// What kind of frame this is on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanFramePayload {
    /// Classic CAN data frame, 0..=8 payload bytes.
    Classic(Vec<u8>),
    /// CAN FD data frame, 0..=64 payload bytes plus FD flags.
    Fd { data: Vec<u8>, flags: CanFdFlags },
    /// Classic CAN remote-transmission-request frame; carries DLC only.
    Remote { dlc: u8 },
    /// Bus error frame surfaced by the controller.
    Error,
}

impl CanFramePayload {
    pub fn data(&self) -> &[u8] {
        match self {
            Self::Classic(d) | Self::Fd { data: d, .. } => d.as_slice(),
            Self::Remote { .. } | Self::Error => &[],
        }
    }

    pub fn is_fd(&self) -> bool {
        matches!(self, Self::Fd { .. })
    }
}

/// A timestamped CAN / CAN FD frame as observed on a logical channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanFrame {
    /// Source-defined timestamp in nanoseconds (file offset, hardware
    /// counter, etc — comparison is only meaningful within one source).
    pub timestamp_ns: u64,
    /// 0-based logical channel within the analyzer.
    pub channel: u8,
    pub id: CanId,
    pub direction: Direction,
    pub payload: CanFramePayload,
}

impl CanFrame {
    pub fn classic(
        timestamp_ns: u64,
        channel: u8,
        id: CanId,
        direction: Direction,
        data: Vec<u8>,
    ) -> Result<Self, CanFrameError> {
        if data.len() > CLASSIC_DATA_MAX {
            return Err(CanFrameError::ClassicPayloadTooLarge(data.len()));
        }
        Ok(Self {
            timestamp_ns,
            channel,
            id,
            direction,
            payload: CanFramePayload::Classic(data),
        })
    }

    pub fn fd(
        timestamp_ns: u64,
        channel: u8,
        id: CanId,
        direction: Direction,
        data: Vec<u8>,
        flags: CanFdFlags,
    ) -> Result<Self, CanFrameError> {
        if data.len() > FD_DATA_MAX {
            return Err(CanFrameError::FdPayloadTooLarge(data.len()));
        }
        Ok(Self {
            timestamp_ns,
            channel,
            id,
            direction,
            payload: CanFramePayload::Fd { data, flags },
        })
    }

    pub fn remote(
        timestamp_ns: u64,
        channel: u8,
        id: CanId,
        direction: Direction,
        dlc: u8,
    ) -> Self {
        Self {
            timestamp_ns,
            channel,
            id,
            direction,
            payload: CanFramePayload::Remote { dlc },
        }
    }

    pub fn error(timestamp_ns: u64, channel: u8, id: CanId, direction: Direction) -> Self {
        Self {
            timestamp_ns,
            channel,
            id,
            direction,
            payload: CanFramePayload::Error,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanFrameError {
    ClassicPayloadTooLarge(usize),
    FdPayloadTooLarge(usize),
}

impl fmt::Display for CanFrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ClassicPayloadTooLarge(n) => write!(
                f,
                "classic CAN payload length {n} exceeds {CLASSIC_DATA_MAX} bytes"
            ),
            Self::FdPayloadTooLarge(n) => {
                write!(f, "CAN FD payload length {n} exceeds {FD_DATA_MAX} bytes")
            }
        }
    }
}

impl std::error::Error for CanFrameError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_id_accepts_11_bit_max() {
        let id = CanId::standard(STANDARD_ID_MAX).unwrap();
        assert_eq!(id.raw(), STANDARD_ID_MAX);
        assert!(!id.is_extended());
    }

    #[test]
    fn standard_id_rejects_above_11_bits() {
        assert_eq!(
            CanId::standard(STANDARD_ID_MAX + 1).unwrap_err(),
            IdError::StandardOutOfRange(STANDARD_ID_MAX + 1)
        );
    }

    #[test]
    fn extended_id_accepts_29_bit_max() {
        let id = CanId::extended(EXTENDED_ID_MAX).unwrap();
        assert_eq!(id.raw(), EXTENDED_ID_MAX);
        assert!(id.is_extended());
    }

    #[test]
    fn extended_id_rejects_above_29_bits() {
        assert_eq!(
            CanId::extended(EXTENDED_ID_MAX + 1).unwrap_err(),
            IdError::ExtendedOutOfRange(EXTENDED_ID_MAX + 1)
        );
    }

    #[test]
    fn standard_and_extended_with_same_raw_are_distinct() {
        let s = CanId::standard(0x123).unwrap();
        let x = CanId::extended(0x123).unwrap();
        assert_ne!(s, x);
    }

    #[test]
    fn classic_frame_round_trips_payload() {
        let id = CanId::standard(0x123).unwrap();
        let frame = CanFrame::classic(1_000, 0, id, Direction::Rx, vec![1, 2, 3]).unwrap();
        assert_eq!(frame.payload.data(), &[1, 2, 3]);
        assert!(!frame.payload.is_fd());
    }

    #[test]
    fn classic_frame_rejects_oversize_payload() {
        let id = CanId::standard(0x1).unwrap();
        let err = CanFrame::classic(0, 0, id, Direction::Rx, vec![0; 9]).unwrap_err();
        assert_eq!(err, CanFrameError::ClassicPayloadTooLarge(9));
    }

    #[test]
    fn fd_frame_carries_brs_and_esi() {
        let id = CanId::extended(0x1AB).unwrap();
        let flags = CanFdFlags { bitrate_switch: true, error_state_indicator: false };
        let frame = CanFrame::fd(0, 1, id, Direction::Tx, vec![0xDE, 0xAD], flags).unwrap();
        match &frame.payload {
            CanFramePayload::Fd { data, flags } => {
                assert_eq!(data, &[0xDE, 0xAD]);
                assert!(flags.bitrate_switch);
                assert!(!flags.error_state_indicator);
            }
            other => panic!("expected FD payload, got {other:?}"),
        }
    }

    #[test]
    fn fd_frame_accepts_64_byte_payload() {
        let id = CanId::standard(0x1).unwrap();
        let frame = CanFrame::fd(0, 0, id, Direction::Rx, vec![0; 64], CanFdFlags::default()).unwrap();
        assert_eq!(frame.payload.data().len(), 64);
    }

    #[test]
    fn fd_frame_rejects_oversize_payload() {
        let id = CanId::standard(0x1).unwrap();
        let err = CanFrame::fd(0, 0, id, Direction::Rx, vec![0; 65], CanFdFlags::default()).unwrap_err();
        assert_eq!(err, CanFrameError::FdPayloadTooLarge(65));
    }

    #[test]
    fn remote_frame_has_no_payload_bytes() {
        let id = CanId::standard(0x7FF).unwrap();
        let frame = CanFrame::remote(0, 0, id, Direction::Rx, 4);
        assert_eq!(frame.payload.data(), &[]);
        assert!(matches!(frame.payload, CanFramePayload::Remote { dlc: 4 }));
    }

    #[test]
    fn error_frame_has_no_payload_bytes() {
        let id = CanId::standard(0).unwrap();
        let frame = CanFrame::error(0, 0, id, Direction::Rx);
        assert_eq!(frame.payload.data(), &[]);
        assert!(matches!(frame.payload, CanFramePayload::Error));
    }

    #[test]
    fn debug_formats_extended_id_with_x_prefix() {
        let id = CanId::extended(0x001A_BCDE).unwrap();
        assert_eq!(format!("{id:?}"), "CanId(x:001ABCDE)");
    }

    #[test]
    fn debug_formats_standard_id_with_s_prefix() {
        let id = CanId::standard(0x123).unwrap();
        assert_eq!(format!("{id:?}"), "CanId(s:123)");
    }
}
