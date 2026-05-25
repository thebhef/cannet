//! BLF CAN-class object decoders. As of Phase 9.5 Tranche 1 this
//! module covers `CAN_MESSAGE2` (object type 86); subsequent steps
//! add `CAN_MESSAGE` (1), `CAN_FD_MESSAGE` (100),
//! `CAN_FD_MESSAGE_64` (101), and `CAN_ERROR_EXT` (73).
//!
//! All CAN-class objects share the same outer framing:
//!
//! 1. 16-byte [`ObjectHeaderBase`] (`format::object`)
//! 2. 16-byte [`ObjectHeaderV1`] (timestamp, flags)
//! 3. Per-type body
//!
//! The body layout for `CAN_MESSAGE2` (per `vector_blf::CanMessage2`):
//!
//! ```text
//! offset (from object start)  size  field
//! 32                          2     channel
//! 34                          1     flags        (bit 0: TX, 5: NERR, 6: WU, 7: RTR)
//! 35                          1     dlc          (classic CAN: 0..=8)
//! 36                          4     id           (raw ID; bit 31 = extended-id marker)
//! 40                          *     data         (`object_size - 48` bytes)
//! 40+data                     4     frame_length (ns)
//! 44+data                     1     bit_count
//! 45+data                     1     reserved1
//! 46+data                     2     reserved2
//! ```
//!
//! [`ObjectHeaderBase`]: super::object::ObjectHeaderBase
//! [`ObjectHeaderV1`]: super::object::ObjectHeaderV1

use super::object::{
    object_type, ObjectHeaderBase, ObjectHeaderError, ObjectHeaderV1, OBJECT_HEADER_BASE_BYTES,
    OBJECT_HEADER_V1_BYTES,
};

/// Width of the per-event header that prefixes every CAN-class
/// object: `ObjectHeaderBase` (16) + `ObjectHeader` v1 (16) = 32 bytes.
pub const CAN_EVENT_HEADER_BYTES: usize = OBJECT_HEADER_BASE_BYTES + OBJECT_HEADER_V1_BYTES;

/// Fixed (non-data) bytes in a `CAN_MESSAGE2` body: `channel` + `flags`
/// + `dlc` + `id` + `frame_length` + `bit_count` + 2 × `reserved`.
pub const CAN_MESSAGE2_FIXED_BODY_BYTES: usize = 16;

/// Bit 0 of `flags` (and `CAN_MESSAGE2.flags`): 1 → frame is TX.
pub const CAN_FLAG_TX: u8 = 1 << 0;
/// Bit 5 of `flags`: NERR (single-wire error).
pub const CAN_FLAG_NERR: u8 = 1 << 5;
/// Bit 6 of `flags`: wake-up message.
pub const CAN_FLAG_WU: u8 = 1 << 6;
/// Bit 7 of `flags`: remote transmission request (`RTR`).
pub const CAN_FLAG_RTR: u8 = 1 << 7;

/// Bit 31 of the raw `id` field marks an extended (29-bit) CAN id.
/// The low 29 bits are the actual id when set, low 11 bits otherwise.
pub const CAN_ID_EXTENDED_BIT: u32 = 1 << 31;
/// Mask for the standard-id portion of `id` (11 bits).
pub const CAN_ID_STANDARD_MASK: u32 = 0x0000_07FF;
/// Mask for the extended-id portion of `id` (29 bits).
pub const CAN_ID_EXTENDED_MASK: u32 = 0x1FFF_FFFF;

/// Errors specific to decoding CAN-class objects.
#[derive(Debug)]
pub enum CanObjectError {
    /// The object's `ObjectHeaderBase.object_type` didn't match the
    /// type the decoder was asked for. Carries `(expected, got)`.
    WrongObjectType(u32, u32),
    /// `ObjectHeaderBase` parse failed (signature / size validation).
    BaseHeader(ObjectHeaderError),
    /// `ObjectHeader` v1 parse failed (truncation).
    EventHeader(ObjectHeaderError),
    /// `object_size` was smaller than the fixed CAN-event header +
    /// the per-type fixed body. Carries `(object_size, required)`.
    TooSmall(u32, usize),
    /// Buffer length was less than `object_size`.
    Truncated(usize, u32),
}

impl std::fmt::Display for CanObjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongObjectType(expected, got) => write!(
                f,
                "expected CAN-class object_type={expected}, got object_type={got}",
            ),
            Self::BaseHeader(e) => write!(f, "CAN object base header invalid: {e}"),
            Self::EventHeader(e) => write!(f, "CAN object event header invalid: {e}"),
            Self::TooSmall(got, required) => write!(
                f,
                "CAN object_size={got} below required {required} bytes for this type",
            ),
            Self::Truncated(got, required) => write!(
                f,
                "CAN object buffer = {got} bytes, object_size declares {required}",
            ),
        }
    }
}

impl std::error::Error for CanObjectError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::BaseHeader(e) | Self::EventHeader(e) => Some(e),
            _ => None,
        }
    }
}

/// Decoded `CAN_MESSAGE2`. Owns its data bytes (we don't borrow from
/// the input slice; the decoded payload typically outlives the
/// per-container scratch buffer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanMessage2 {
    pub base: ObjectHeaderBase,
    pub event: ObjectHeaderV1,
    pub channel: u16,
    pub flags: u8,
    pub dlc: u8,
    /// Raw on-disk `id` (bit 31 = extended-id marker). Use
    /// [`Self::is_extended_id`] / [`Self::can_id`] for the decoded form.
    pub id_raw: u32,
    pub data: Vec<u8>,
    pub frame_length_ns: u32,
    pub bit_count: u8,
}

impl CanMessage2 {
    /// True if the source frame used a 29-bit extended id.
    pub fn is_extended_id(&self) -> bool {
        (self.id_raw & CAN_ID_EXTENDED_BIT) != 0
    }
    /// Decoded CAN id (low 11 or 29 bits per [`Self::is_extended_id`]).
    pub fn can_id(&self) -> u32 {
        if self.is_extended_id() {
            self.id_raw & CAN_ID_EXTENDED_MASK
        } else {
            self.id_raw & CAN_ID_STANDARD_MASK
        }
    }
    /// True iff the TX bit (0) is set in `flags`.
    pub fn is_tx(&self) -> bool {
        (self.flags & CAN_FLAG_TX) != 0
    }
    /// True iff the RTR bit (7) is set in `flags`.
    pub fn is_remote(&self) -> bool {
        (self.flags & CAN_FLAG_RTR) != 0
    }
}

/// Decode one `CAN_MESSAGE2` whose on-disk bytes start at the front of
/// `object_bytes`. The slice must contain at least `object_size`
/// bytes (typically exactly that, the window taken out of the
/// container's inflated payload).
// The `try_into().unwrap()` calls are unreachable: every slice is
// taken from `body[..]` after the length check that body is at
// least `CAN_MESSAGE2_FIXED_BODY_BYTES` long.
#[allow(clippy::missing_panics_doc)]
pub fn decode_can_message2(object_bytes: &[u8]) -> Result<CanMessage2, CanObjectError> {
    let base = ObjectHeaderBase::parse(object_bytes).map_err(CanObjectError::BaseHeader)?;
    if base.object_type != object_type::CAN_MESSAGE2 {
        return Err(CanObjectError::WrongObjectType(
            object_type::CAN_MESSAGE2,
            base.object_type,
        ));
    }
    let required = CAN_EVENT_HEADER_BYTES + CAN_MESSAGE2_FIXED_BODY_BYTES;
    if (base.object_size as usize) < required {
        return Err(CanObjectError::TooSmall(base.object_size, required));
    }
    if object_bytes.len() < base.object_size as usize {
        return Err(CanObjectError::Truncated(
            object_bytes.len(),
            base.object_size,
        ));
    }

    let event = ObjectHeaderV1::parse(
        &object_bytes[OBJECT_HEADER_BASE_BYTES..OBJECT_HEADER_BASE_BYTES + OBJECT_HEADER_V1_BYTES],
    )
    .map_err(CanObjectError::EventHeader)?;

    let body = &object_bytes[CAN_EVENT_HEADER_BYTES..base.object_size as usize];
    let channel = u16::from_le_bytes(body[0..2].try_into().unwrap());
    let flags = body[2];
    let dlc = body[3];
    let id_raw = u32::from_le_bytes(body[4..8].try_into().unwrap());

    // Data sits between `id` and the trailing fixed fields.
    let data_len = body.len() - CAN_MESSAGE2_FIXED_BODY_BYTES;
    let data_start = 8usize;
    let data_end = data_start + data_len;
    let data = body[data_start..data_end].to_vec();

    let tail = &body[data_end..];
    let frame_length_ns = u32::from_le_bytes(tail[0..4].try_into().unwrap());
    let bit_count = tail[4];

    Ok(CanMessage2 {
        base,
        event,
        channel,
        flags,
        dlc,
        id_raw,
        data,
        frame_length_ns,
        bit_count,
    })
}

#[cfg(test)]
mod tests {
    use super::super::object::OBJECT_FLAG_TIME_ONE_NANS;
    use super::*;

    /// Test fixture: every field of a `CAN_MESSAGE2` the synth
    /// helper can vary. Defaults match a benign zero-data frame.
    #[derive(Clone, Copy)]
    struct Cm2Fixture<'a> {
        timestamp_ns: u64,
        channel: u16,
        flags: u8,
        dlc: u8,
        id_raw: u32,
        data: &'a [u8],
        frame_length_ns: u32,
        bit_count: u8,
    }

    impl Cm2Fixture<'_> {
        fn benign() -> Self {
            Self {
                timestamp_ns: 0,
                channel: 0,
                flags: 0,
                dlc: 0,
                id_raw: 0,
                data: &[],
                frame_length_ns: 0,
                bit_count: 0,
            }
        }
    }

    /// Build one full on-disk `CAN_MESSAGE2` object (no inter-object padding).
    fn synth_can_message2(f: Cm2Fixture<'_>) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(CAN_EVENT_HEADER_BYTES + CAN_MESSAGE2_FIXED_BODY_BYTES + f.data.len());

        let object_size = u32::try_from(
            CAN_EVENT_HEADER_BYTES + CAN_MESSAGE2_FIXED_BODY_BYTES + f.data.len(),
        )
        .unwrap();

        // ObjectHeaderBase
        bytes.extend_from_slice(b"LOBJ");
        bytes.extend_from_slice(&32u16.to_le_bytes()); // header_size
        bytes.extend_from_slice(&1u16.to_le_bytes()); // header_version
        bytes.extend_from_slice(&object_size.to_le_bytes());
        bytes.extend_from_slice(&object_type::CAN_MESSAGE2.to_le_bytes());
        // ObjectHeader v1
        bytes.extend_from_slice(&OBJECT_FLAG_TIME_ONE_NANS.to_le_bytes()); // object_flags
        bytes.extend_from_slice(&0u16.to_le_bytes()); // client_index
        bytes.extend_from_slice(&0u16.to_le_bytes()); // object_version
        bytes.extend_from_slice(&f.timestamp_ns.to_le_bytes());
        // Body
        bytes.extend_from_slice(&f.channel.to_le_bytes());
        bytes.push(f.flags);
        bytes.push(f.dlc);
        bytes.extend_from_slice(&f.id_raw.to_le_bytes());
        bytes.extend_from_slice(f.data);
        bytes.extend_from_slice(&f.frame_length_ns.to_le_bytes());
        bytes.push(f.bit_count);
        bytes.push(0); // reserved1
        bytes.extend_from_slice(&0u16.to_le_bytes()); // reserved2
        bytes
    }

    #[test]
    fn decodes_a_classic_standard_id_frame() {
        let bytes = synth_can_message2(Cm2Fixture {
            timestamp_ns: 1_700_000_000_000_000_000u64,
            channel: 2,
            dlc: 4,
            id_raw: 0x123,
            data: &[1, 2, 3, 4],
            frame_length_ns: 1_200,
            bit_count: 42,
            ..Cm2Fixture::benign()
        });
        let m = decode_can_message2(&bytes).expect("decode");
        assert_eq!(m.event.timestamp_ns(), 1_700_000_000_000_000_000u64);
        assert_eq!(m.channel, 2);
        assert!(!m.is_extended_id());
        assert!(!m.is_tx());
        assert!(!m.is_remote());
        assert_eq!(m.can_id(), 0x123);
        assert_eq!(m.data, vec![1, 2, 3, 4]);
        assert_eq!(m.dlc, 4);
        assert_eq!(m.frame_length_ns, 1_200);
        assert_eq!(m.bit_count, 42);
    }

    #[test]
    fn decodes_an_extended_id_tx_frame() {
        let bytes = synth_can_message2(Cm2Fixture {
            timestamp_ns: 5_000_000,
            flags: CAN_FLAG_TX,
            dlc: 8,
            id_raw: 0x01AB_CDEF | CAN_ID_EXTENDED_BIT,
            data: &[0xAA; 8],
            frame_length_ns: 2_400,
            bit_count: 128,
            ..Cm2Fixture::benign()
        });
        let m = decode_can_message2(&bytes).unwrap();
        assert!(m.is_extended_id());
        assert!(m.is_tx());
        assert_eq!(m.can_id(), 0x01AB_CDEF);
        assert_eq!(m.data.len(), 8);
    }

    #[test]
    fn decodes_a_zero_byte_data_frame() {
        let bytes = synth_can_message2(Cm2Fixture {
            id_raw: 0x10,
            ..Cm2Fixture::benign()
        });
        let m = decode_can_message2(&bytes).unwrap();
        assert!(m.data.is_empty());
    }

    #[test]
    fn rejects_wrong_object_type() {
        let mut bytes = synth_can_message2(Cm2Fixture::benign());
        bytes[12..16].copy_from_slice(&object_type::LOG_CONTAINER.to_le_bytes());
        let err = decode_can_message2(&bytes).unwrap_err();
        assert!(matches!(
            err,
            CanObjectError::WrongObjectType(expected, got)
                if expected == object_type::CAN_MESSAGE2 && got == object_type::LOG_CONTAINER,
        ));
    }

    #[test]
    fn rejects_object_size_too_small() {
        // Hand-build a base header with object_size=40, well below
        // the required CAN_EVENT_HEADER_BYTES + fixed-body = 48.
        let mut bytes = vec![0u8; 40];
        bytes[0..4].copy_from_slice(b"LOBJ");
        bytes[4..6].copy_from_slice(&32u16.to_le_bytes());
        bytes[6..8].copy_from_slice(&1u16.to_le_bytes());
        bytes[8..12].copy_from_slice(&40u32.to_le_bytes());
        bytes[12..16].copy_from_slice(&object_type::CAN_MESSAGE2.to_le_bytes());
        let err = decode_can_message2(&bytes).unwrap_err();
        assert!(matches!(err, CanObjectError::TooSmall(40, 48)));
    }

    /// Round-trip: write a frame through our (still `blf_asc`-backed)
    /// writer, pull the first inner CAN object out of the
    /// `LOG_CONTAINER`, and assert the native decoder reads back the
    /// same payload. `blf_asc` writes CAN frames as `CAN_MESSAGE`
    /// (type 1), not `CAN_MESSAGE2` (86), so this test is skipped at
    /// the type-detection step when the inner object isn't 86; the
    /// equivalent assertion for `CAN_MESSAGE` lands with its decoder
    /// in the next step. When `blf_asc` is replaced with our native
    /// writer (step 9), the inner type becomes `CAN_MESSAGE2` and the
    /// payload assertion runs.
    #[test]
    fn round_trips_first_inner_can_message2_when_present() {
        use super::super::header::FILE_STATISTICS_MIN_BYTES;
        use super::super::log_container;
        use crate::BlfCaptureWriter;
        use cannet_core::{CanFrame, CanId, Direction};
        use std::io::Read;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cm2.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        let frame = CanFrame::classic(
            1_700_000_000_u64 * 1_000_000_000,
            1,
            CanId::standard(0x321).unwrap(),
            Direction::Rx,
            vec![0xDE, 0xAD, 0xBE, 0xEF],
        )
        .unwrap();
        writer.append(&frame).unwrap();
        writer.finish().unwrap();

        let mut all = Vec::new();
        std::fs::File::open(&path).unwrap().read_to_end(&mut all).unwrap();
        let after_stats = &all[FILE_STATISTICS_MIN_BYTES..];
        let base = ObjectHeaderBase::parse(after_stats).unwrap();
        let container =
            log_container::decode(&after_stats[..base.object_size as usize]).unwrap();

        let inner_base = ObjectHeaderBase::parse(&container.uncompressed_payload).unwrap();
        if inner_base.object_type != object_type::CAN_MESSAGE2 {
            // `blf_asc` writes CAN_MESSAGE (type 1) — wait for step 6.
            return;
        }
        let m = decode_can_message2(
            &container.uncompressed_payload[..inner_base.object_size as usize],
        )
        .unwrap();
        assert_eq!(m.can_id(), 0x321);
        assert_eq!(m.data, vec![0xDE, 0xAD, 0xBE, 0xEF]);
    }
}
