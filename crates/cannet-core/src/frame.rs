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
    /// Construct a `CanId`, selecting standard (11-bit) or extended
    /// (29-bit) addressing via `extended` — the single constructor for
    /// callers that carry the addressing mode as a runtime value
    /// (e.g. a wire-format flag) rather than choosing [`Self::standard`]
    /// or [`Self::extended`] directly at the call site.
    pub fn new(raw: u32, extended: bool) -> Result<Self, IdError> {
        if extended {
            Self::extended(raw)
        } else {
            Self::standard(raw)
        }
    }

    pub fn standard(raw: u32) -> Result<Self, IdError> {
        if raw > STANDARD_ID_MAX {
            return Err(IdError::StandardOutOfRange(raw));
        }
        Ok(Self {
            raw,
            extended: false,
        })
    }

    pub fn extended(raw: u32) -> Result<Self, IdError> {
        if raw > EXTENDED_ID_MAX {
            return Err(IdError::ExtendedOutOfRange(raw));
        }
        Ok(Self {
            raw,
            extended: true,
        })
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

/// How many bit times a frame occupies on the wire, split by the rate
/// each part is clocked at.
///
/// CAN FD switches bit rate mid-frame when BRS is set, so a single
/// figure cannot describe an FD frame's occupancy: the arbitration
/// phase runs at the nominal rate and the data phase at its own. A
/// classic frame puts everything in [`Self::arbitration`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OnWireBits {
    /// Bit times clocked at the nominal (arbitration) rate.
    pub arbitration: u64,
    /// Bit times clocked at the FD data rate. Zero unless the frame is
    /// CAN FD *with* BRS — an FD frame without BRS runs entirely at the
    /// nominal rate.
    pub data: u64,
}

/// Fixed-format bits of a classic frame with a standard id: start of
/// frame, arbitration, control, CRC and its delimiter, the ACK slot and
/// its delimiter, end of frame, and the intermission that must follow
/// before the next frame may start.
const STANDARD_FRAME_BITS: u64 = 47;
/// The same for an extended id, which carries 18 more id bits plus SRR
/// and IDE.
const EXTENDED_FRAME_BITS: u64 = 67;
/// An FD frame's data-phase trailer beyond the payload: the stuff-count
/// field, the CRC and its delimiter.
const FD_DATA_PHASE_TRAILER_BITS: u64 = 25;
/// An error flag (6 bits, up to 12 when other nodes superpose their
/// own) plus its 8-bit delimiter.
const ERROR_FRAME_BITS: u64 = 13;

impl CanFramePayload {
    /// Bit times this payload occupies on the wire for a frame with the
    /// given id width.
    ///
    /// **Stuff bits are not counted.** The number of them depends on the
    /// transmitted bit pattern including the controller-computed CRC,
    /// which is not on the wire format we retain, so a figure derived
    /// from this reads low against a heavily-stuffed stream rather than
    /// guessing at the difference. Everything computed from it — the
    /// virtual bus's frame pacing, a bus-load percentage — inherits that
    /// and says so.
    #[must_use]
    pub fn on_wire_bits(&self, extended: bool) -> OnWireBits {
        let fixed = if extended {
            EXTENDED_FRAME_BITS
        } else {
            STANDARD_FRAME_BITS
        };
        match self {
            Self::Classic(data) => OnWireBits {
                arbitration: fixed + 8 * data.len() as u64,
                data: 0,
            },
            Self::Remote { .. } => OnWireBits {
                arbitration: fixed,
                data: 0,
            },
            Self::Fd { data, flags } => {
                let payload = FD_DATA_PHASE_TRAILER_BITS + 8 * data.len() as u64;
                if flags.bitrate_switch {
                    OnWireBits {
                        arbitration: fixed,
                        data: payload,
                    }
                } else {
                    OnWireBits {
                        arbitration: fixed + payload,
                        data: 0,
                    }
                }
            }
            Self::Error => OnWireBits {
                arbitration: ERROR_FRAME_BITS,
                data: 0,
            },
        }
    }

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
    fn new_with_extended_false_matches_standard() {
        assert_eq!(CanId::new(0x123, false), CanId::standard(0x123));
    }

    #[test]
    fn new_with_extended_true_matches_extended() {
        assert_eq!(CanId::new(0x123, true), CanId::extended(0x123));
    }

    #[test]
    fn new_rejects_out_of_range_per_selected_mode() {
        assert_eq!(
            CanId::new(STANDARD_ID_MAX + 1, false).unwrap_err(),
            IdError::StandardOutOfRange(STANDARD_ID_MAX + 1)
        );
        assert_eq!(
            CanId::new(EXTENDED_ID_MAX + 1, true).unwrap_err(),
            IdError::ExtendedOutOfRange(EXTENDED_ID_MAX + 1)
        );
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
        let flags = CanFdFlags {
            bitrate_switch: true,
            error_state_indicator: false,
        };
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
        let frame =
            CanFrame::fd(0, 0, id, Direction::Rx, vec![0; 64], CanFdFlags::default()).unwrap();
        assert_eq!(frame.payload.data().len(), 64);
    }

    #[test]
    fn fd_frame_rejects_oversize_payload() {
        let id = CanId::standard(0x1).unwrap();
        let err =
            CanFrame::fd(0, 0, id, Direction::Rx, vec![0; 65], CanFdFlags::default()).unwrap_err();
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

    #[test]
    fn a_classic_frame_is_its_fixed_format_plus_its_payload() {
        let bits = CanFramePayload::Classic(vec![0; 8]).on_wire_bits(false);
        assert_eq!(
            bits,
            OnWireBits {
                arbitration: 47 + 64,
                data: 0
            }
        );
        // An extended id costs 20 more bit times and nothing else.
        let bits = CanFramePayload::Classic(vec![0; 8]).on_wire_bits(true);
        assert_eq!(
            bits,
            OnWireBits {
                arbitration: 67 + 64,
                data: 0
            }
        );
    }

    #[test]
    fn a_remote_frame_carries_no_payload_bits() {
        let bits = CanFramePayload::Remote { dlc: 8 }.on_wire_bits(false);
        assert_eq!(
            bits,
            OnWireBits {
                arbitration: 47,
                data: 0
            }
        );
    }

    #[test]
    fn only_a_bitrate_switched_fd_frame_puts_bits_in_the_data_phase() {
        // This is the whole reason the count is split: without BRS the
        // frame runs end to end at the nominal rate, and charging its
        // payload to the data rate would understate the wire it used.
        let payload = |brs| CanFramePayload::Fd {
            data: vec![0; 64],
            flags: CanFdFlags {
                bitrate_switch: brs,
                error_state_indicator: false,
            },
        };
        assert_eq!(
            payload(true).on_wire_bits(false),
            OnWireBits {
                arbitration: 47,
                data: 25 + 512
            },
        );
        assert_eq!(
            payload(false).on_wire_bits(false),
            OnWireBits {
                arbitration: 47 + 25 + 512,
                data: 0
            },
        );
    }

    #[test]
    fn an_error_frame_is_a_flag_and_a_delimiter() {
        // Smaller than any data frame: 6 dominant bits (up to 12 when
        // other nodes superpose their own) plus an 8-bit delimiter.
        let bits = CanFramePayload::Error.on_wire_bits(false);
        assert_eq!(
            bits,
            OnWireBits {
                arbitration: 13,
                data: 0
            }
        );
        // The id width is irrelevant: an error flag carries no id.
        assert_eq!(CanFramePayload::Error.on_wire_bits(true), bits);
    }
}
