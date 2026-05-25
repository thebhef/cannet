//! BLF CAN-class object decoders. Tranche 1 covers:
//!
//! - `CAN_MESSAGE` (type 1) — older, fixed 8-byte data
//! - `CAN_ERROR_EXT` (type 73) — extended error frame
//! - `CAN_MESSAGE2` (type 86) — modern classic CAN, variable data
//! - `CAN_FD_MESSAGE` (type 100) — CAN FD, fixed 64-byte data slot
//! - `CAN_FD_MESSAGE_64` (type 101) — CAN FD, variable data, ext-frame-data
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

// =================================================================
// CAN_MESSAGE (object type 1)
// =================================================================
//
// Per `vector_blf::CanMessage`: same layout as CAN_MESSAGE2 minus
// the trailing frame_length / bit_count / reserved tail, and with a
// fixed 8-byte `data` slot (rather than variable).
//
// Body offset (from object start):
//   32  2  channel
//   34  1  flags     (see CAN_FLAG_* constants)
//   35  1  dlc
//   36  4  id        (raw; bit 31 = extended-id marker)
//   40  8  data      (always 8 bytes — std::array<uint8_t, 8>)
//
// object_size: 48 bytes (CAN_EVENT_HEADER_BYTES + 16).

/// Fixed body size of a `CAN_MESSAGE`: `channel` + `flags` + `dlc` +
/// `id` + 8-byte data = 16 bytes.
pub const CAN_MESSAGE_BODY_BYTES: usize = 16;

/// Decoded `CAN_MESSAGE`. Same on-the-wire shape as `CanMessage2`
/// minus the frame-length / bit-count / reserved trailer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanMessage {
    pub base: ObjectHeaderBase,
    pub event: ObjectHeaderV1,
    pub channel: u16,
    pub flags: u8,
    pub dlc: u8,
    /// Raw on-disk id (bit 31 = extended-id marker).
    pub id_raw: u32,
    /// On-disk data is always 8 bytes, but the *valid* portion is
    /// `dlc` bytes (max 8). We expose all 8; callers slice by `dlc`.
    pub data: [u8; 8],
}

impl CanMessage {
    pub fn is_extended_id(&self) -> bool {
        (self.id_raw & CAN_ID_EXTENDED_BIT) != 0
    }
    pub fn can_id(&self) -> u32 {
        if self.is_extended_id() {
            self.id_raw & CAN_ID_EXTENDED_MASK
        } else {
            self.id_raw & CAN_ID_STANDARD_MASK
        }
    }
    pub fn is_tx(&self) -> bool {
        (self.flags & CAN_FLAG_TX) != 0
    }
    pub fn is_remote(&self) -> bool {
        (self.flags & CAN_FLAG_RTR) != 0
    }
    /// The first `dlc.min(8)` bytes of [`Self::data`] — the
    /// caller-visible payload, matching what classic CAN actually
    /// transmits.
    pub fn payload(&self) -> &[u8] {
        let len = usize::from(self.dlc).min(self.data.len());
        &self.data[..len]
    }
}

/// Decode one `CAN_MESSAGE`. See module docs for the layout.
// `try_into().unwrap()` calls are unreachable: every slice is
// length-checked at the top.
#[allow(clippy::missing_panics_doc)]
pub fn decode_can_message(object_bytes: &[u8]) -> Result<CanMessage, CanObjectError> {
    let base = ObjectHeaderBase::parse(object_bytes).map_err(CanObjectError::BaseHeader)?;
    if base.object_type != object_type::CAN_MESSAGE {
        return Err(CanObjectError::WrongObjectType(
            object_type::CAN_MESSAGE,
            base.object_type,
        ));
    }
    let required = CAN_EVENT_HEADER_BYTES + CAN_MESSAGE_BODY_BYTES;
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
    let body = &object_bytes[CAN_EVENT_HEADER_BYTES..CAN_EVENT_HEADER_BYTES + CAN_MESSAGE_BODY_BYTES];
    Ok(CanMessage {
        base,
        event,
        channel: u16::from_le_bytes(body[0..2].try_into().unwrap()),
        flags: body[2],
        dlc: body[3],
        id_raw: u32::from_le_bytes(body[4..8].try_into().unwrap()),
        data: body[8..16].try_into().unwrap(),
    })
}

// =================================================================
// CAN_FD_MESSAGE (object type 100)
// =================================================================
//
// Per `vector_blf::CanFdMessage`: classic CAN-FD frame with a fixed
// 64-byte `data` slot; `validDataBytes` reports the meaningful portion.
//
// Body offset (from object start):
//   32  2  channel
//   34  1  flags             (see CAN_FLAG_* constants)
//   35  1  dlc
//   36  4  id                (raw; bit 31 = extended-id marker)
//   40  4  frame_length      (ns)
//   44  1  arb_bit_count
//   45  1  can_fd_flags      (see CAN_FD_FLAG_* constants)
//   46  1  valid_data_bytes  (length of meaningful prefix in data, ≤ 64)
//   47  1  reserved1
//   48  2  reserved2
//   50  64 data              (always 64 bytes — std::array<uint8_t, 64>)
//   114 4  reserved3
//
// object_size: 32 + 88 = 120 bytes.

/// Fixed body size of `CAN_FD_MESSAGE`: 86 bytes (per
/// `vector_blf::CanFdMessage::calculateObjectSize` —
/// 18 bytes of fixed prefix + 64-byte `data` slot + 4-byte
/// `reserved3` trailer).
pub const CAN_FD_MESSAGE_BODY_BYTES: usize = 86;
/// Fixed-width `data` slot in a `CAN_FD_MESSAGE`. The meaningful
/// prefix is `valid_data_bytes` long.
pub const CAN_FD_MESSAGE_DATA_BYTES: usize = 64;

/// Bit 0 of `can_fd_flags`: EDL (extended data length — distinguishes
/// CAN FD from classic CAN).
pub const CAN_FD_FLAG_EDL: u8 = 1 << 0;
/// Bit 1 of `can_fd_flags`: BRS (bit rate switch).
pub const CAN_FD_FLAG_BRS: u8 = 1 << 1;
/// Bit 2 of `can_fd_flags`: ESI (error state indicator).
pub const CAN_FD_FLAG_ESI: u8 = 1 << 2;

/// Decoded `CAN_FD_MESSAGE`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanFdMessage {
    pub base: ObjectHeaderBase,
    pub event: ObjectHeaderV1,
    pub channel: u16,
    pub flags: u8,
    pub dlc: u8,
    pub id_raw: u32,
    pub frame_length_ns: u32,
    pub arb_bit_count: u8,
    pub can_fd_flags: u8,
    pub valid_data_bytes: u8,
    pub data: [u8; CAN_FD_MESSAGE_DATA_BYTES],
}

impl CanFdMessage {
    pub fn is_extended_id(&self) -> bool {
        (self.id_raw & CAN_ID_EXTENDED_BIT) != 0
    }
    pub fn can_id(&self) -> u32 {
        if self.is_extended_id() {
            self.id_raw & CAN_ID_EXTENDED_MASK
        } else {
            self.id_raw & CAN_ID_STANDARD_MASK
        }
    }
    pub fn is_tx(&self) -> bool {
        (self.flags & CAN_FLAG_TX) != 0
    }
    pub fn bitrate_switch(&self) -> bool {
        (self.can_fd_flags & CAN_FD_FLAG_BRS) != 0
    }
    pub fn error_state_indicator(&self) -> bool {
        (self.can_fd_flags & CAN_FD_FLAG_ESI) != 0
    }
    /// The valid prefix of [`Self::data`] (`valid_data_bytes` long,
    /// capped at 64). Anything past this index is on-disk padding.
    pub fn payload(&self) -> &[u8] {
        let len = usize::from(self.valid_data_bytes).min(self.data.len());
        &self.data[..len]
    }
}

/// Decode one `CAN_FD_MESSAGE`.
// `try_into().unwrap()` calls are unreachable: every slice is
// length-checked at the top.
#[allow(clippy::missing_panics_doc)]
pub fn decode_can_fd_message(object_bytes: &[u8]) -> Result<CanFdMessage, CanObjectError> {
    let base = ObjectHeaderBase::parse(object_bytes).map_err(CanObjectError::BaseHeader)?;
    if base.object_type != object_type::CAN_FD_MESSAGE {
        return Err(CanObjectError::WrongObjectType(
            object_type::CAN_FD_MESSAGE,
            base.object_type,
        ));
    }
    let required = CAN_EVENT_HEADER_BYTES + CAN_FD_MESSAGE_BODY_BYTES;
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
    let body = &object_bytes[CAN_EVENT_HEADER_BYTES..CAN_EVENT_HEADER_BYTES + CAN_FD_MESSAGE_BODY_BYTES];
    Ok(CanFdMessage {
        base,
        event,
        channel: u16::from_le_bytes(body[0..2].try_into().unwrap()),
        flags: body[2],
        dlc: body[3],
        id_raw: u32::from_le_bytes(body[4..8].try_into().unwrap()),
        frame_length_ns: u32::from_le_bytes(body[8..12].try_into().unwrap()),
        arb_bit_count: body[12],
        can_fd_flags: body[13],
        valid_data_bytes: body[14],
        // body[15] = reserved1
        // body[16..18] = reserved2
        data: body[18..18 + CAN_FD_MESSAGE_DATA_BYTES].try_into().unwrap(),
        // body[82..86] = reserved3
    })
}

// =================================================================
// CAN_FD_MESSAGE_64 (object type 101)
// =================================================================
//
// Per `vector_blf::CanFdMessage64`: variable-length CAN FD frame
// with an optional `CanFdExtFrameData` trailer. The decoder reads
// the fixed prefix and `valid_data_bytes` bytes of data; the
// optional ext-frame-data (referenced via `extDataOffset`) is
// preserved as opaque bytes for forward compatibility.
//
// Body offset (from object start):
//   32  1  channel
//   33  1  dlc
//   34  1  valid_data_bytes
//   35  1  tx_count
//   36  4  id
//   40  4  frame_length     (ns)
//   44  4  flags            (per-bit flags — see CAN_FD_64_FLAG_*)
//   48  4  btr_cfg_arb
//   52  4  btr_cfg_data
//   56  4  time_offset_brs_ns
//   60  4  time_offset_crc_del_ns
//   64  2  bit_count
//   66  1  dir
//   67  1  ext_data_offset
//   68  4  crc
//   72  * data             (`valid_data_bytes` bytes)
//   72+v * ext_frame_data  (optional; recognised by `ext_data_offset != 0`)
//   ...   trailing reserved bytes up to `object_size`
//
// Fixed prefix: 40 bytes.

/// Fixed prefix of a `CAN_FD_MESSAGE_64` body (everything before the
/// variable-length `data` slot).
pub const CAN_FD_MESSAGE_64_FIXED_PREFIX_BYTES: usize = 40;

/// Bit 12 of `CAN_FD_MESSAGE_64.flags`: EDL — set means CAN FD frame.
pub const CAN_FD_64_FLAG_EDL: u32 = 1 << 12;
/// Bit 13 of `CAN_FD_MESSAGE_64.flags`: BRS — bit rate switch.
pub const CAN_FD_64_FLAG_BRS: u32 = 1 << 13;
/// Bit 14 of `CAN_FD_MESSAGE_64.flags`: ESI — error state indicator.
pub const CAN_FD_64_FLAG_ESI: u32 = 1 << 14;
/// Bit 4 of `CAN_FD_MESSAGE_64.flags`: 1 → remote frame (only valid
/// for non-FD frames carried on a CAN FD channel).
pub const CAN_FD_64_FLAG_REMOTE: u32 = 1 << 4;

/// Decoded `CAN_FD_MESSAGE_64`. `data` is the meaningful payload
/// (length = `valid_data_bytes`); the optional `CanFdExtFrameData`
/// trailer and reserved padding are preserved verbatim for
/// round-trip parity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanFdMessage64 {
    pub base: ObjectHeaderBase,
    pub event: ObjectHeaderV1,
    pub channel: u8,
    pub dlc: u8,
    pub valid_data_bytes: u8,
    pub tx_count: u8,
    pub id_raw: u32,
    pub frame_length_ns: u32,
    pub flags: u32,
    pub btr_cfg_arb: u32,
    pub btr_cfg_data: u32,
    pub time_offset_brs_ns: u32,
    pub time_offset_crc_del_ns: u32,
    pub bit_count: u16,
    pub dir: u8,
    pub ext_data_offset: u8,
    pub crc: u32,
    pub data: Vec<u8>,
    /// Bytes after `data`, up to `object_size`. May include the
    /// `CanFdExtFrameData` trailer and any writer-specific padding.
    /// Preserved verbatim so the writer can round-trip them when we
    /// re-emit; not parsed at this layer.
    pub trailing: Vec<u8>,
}

impl CanFdMessage64 {
    pub fn is_extended_id(&self) -> bool {
        (self.id_raw & CAN_ID_EXTENDED_BIT) != 0
    }
    pub fn can_id(&self) -> u32 {
        if self.is_extended_id() {
            self.id_raw & CAN_ID_EXTENDED_MASK
        } else {
            self.id_raw & CAN_ID_STANDARD_MASK
        }
    }
    pub fn bitrate_switch(&self) -> bool {
        (self.flags & CAN_FD_64_FLAG_BRS) != 0
    }
    pub fn error_state_indicator(&self) -> bool {
        (self.flags & CAN_FD_64_FLAG_ESI) != 0
    }
    pub fn is_remote(&self) -> bool {
        (self.flags & CAN_FD_64_FLAG_REMOTE) != 0
    }
}

/// Decode one `CAN_FD_MESSAGE_64`.
// `try_into().unwrap()` calls are unreachable: every slice is
// length-checked at the top.
#[allow(clippy::missing_panics_doc)]
pub fn decode_can_fd_message_64(
    object_bytes: &[u8],
) -> Result<CanFdMessage64, CanObjectError> {
    let base = ObjectHeaderBase::parse(object_bytes).map_err(CanObjectError::BaseHeader)?;
    if base.object_type != object_type::CAN_FD_MESSAGE_64 {
        return Err(CanObjectError::WrongObjectType(
            object_type::CAN_FD_MESSAGE_64,
            base.object_type,
        ));
    }
    let required = CAN_EVENT_HEADER_BYTES + CAN_FD_MESSAGE_64_FIXED_PREFIX_BYTES;
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
    let valid_data_bytes = body[2];
    let data_end_in_body = CAN_FD_MESSAGE_64_FIXED_PREFIX_BYTES + usize::from(valid_data_bytes);
    if data_end_in_body > body.len() {
        return Err(CanObjectError::TooSmall(
            base.object_size,
            CAN_EVENT_HEADER_BYTES + data_end_in_body,
        ));
    }

    let data = body[CAN_FD_MESSAGE_64_FIXED_PREFIX_BYTES..data_end_in_body].to_vec();
    let trailing = body[data_end_in_body..].to_vec();

    Ok(CanFdMessage64 {
        base,
        event,
        channel: body[0],
        dlc: body[1],
        valid_data_bytes,
        tx_count: body[3],
        id_raw: u32::from_le_bytes(body[4..8].try_into().unwrap()),
        frame_length_ns: u32::from_le_bytes(body[8..12].try_into().unwrap()),
        flags: u32::from_le_bytes(body[12..16].try_into().unwrap()),
        btr_cfg_arb: u32::from_le_bytes(body[16..20].try_into().unwrap()),
        btr_cfg_data: u32::from_le_bytes(body[20..24].try_into().unwrap()),
        time_offset_brs_ns: u32::from_le_bytes(body[24..28].try_into().unwrap()),
        time_offset_crc_del_ns: u32::from_le_bytes(body[28..32].try_into().unwrap()),
        bit_count: u16::from_le_bytes(body[32..34].try_into().unwrap()),
        dir: body[34],
        ext_data_offset: body[35],
        crc: u32::from_le_bytes(body[36..40].try_into().unwrap()),
        data,
        trailing,
    })
}

// =================================================================
// CAN_ERROR_EXT (object type 73)
// =================================================================
//
// Per `vector_blf::CanErrorFrameExt`: extended CAN error frame.
//
// Body offset (from object start):
//   32  2  channel
//   34  2  length              (legacy; may be 0)
//   36  4  flags               (bitmask: 1=ecc valid, 2=ext-code valid, …)
//   40  1  ecc
//   41  1  position
//   42  1  dlc
//   43  1  reserved1
//   44  4  frame_length_in_ns
//   48  4  id                  (corrupted-message id)
//   52  2  flags_ext
//   54  2  reserved2
//   56  *  data                (object_size - 56 bytes; CAN-Core payload)

/// Fixed body prefix of `CAN_ERROR_EXT`: 24 bytes (everything before
/// the variable-length `data` slot).
pub const CAN_ERROR_EXT_FIXED_PREFIX_BYTES: usize = 24;

/// Decoded `CAN_ERROR_EXT`. `data` (CAN-Core payload of the corrupted
/// message) is variable and may be empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanErrorExt {
    pub base: ObjectHeaderBase,
    pub event: ObjectHeaderV1,
    pub channel: u16,
    pub length: u16,
    pub flags: u32,
    pub ecc: u8,
    pub position: u8,
    pub dlc: u8,
    pub frame_length_in_ns: u32,
    pub id_raw: u32,
    pub flags_ext: u16,
    pub data: Vec<u8>,
}

impl CanErrorExt {
    pub fn is_extended_id(&self) -> bool {
        (self.id_raw & CAN_ID_EXTENDED_BIT) != 0
    }
    pub fn can_id(&self) -> u32 {
        if self.is_extended_id() {
            self.id_raw & CAN_ID_EXTENDED_MASK
        } else {
            self.id_raw & CAN_ID_STANDARD_MASK
        }
    }
}

/// Decode one `CAN_ERROR_EXT`.
// `try_into().unwrap()` calls are unreachable: every slice is
// length-checked at the top.
#[allow(clippy::missing_panics_doc)]
pub fn decode_can_error_ext(object_bytes: &[u8]) -> Result<CanErrorExt, CanObjectError> {
    let base = ObjectHeaderBase::parse(object_bytes).map_err(CanObjectError::BaseHeader)?;
    if base.object_type != object_type::CAN_ERROR_EXT {
        return Err(CanObjectError::WrongObjectType(
            object_type::CAN_ERROR_EXT,
            base.object_type,
        ));
    }
    let required = CAN_EVENT_HEADER_BYTES + CAN_ERROR_EXT_FIXED_PREFIX_BYTES;
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
    let data = body[CAN_ERROR_EXT_FIXED_PREFIX_BYTES..].to_vec();

    Ok(CanErrorExt {
        base,
        event,
        channel: u16::from_le_bytes(body[0..2].try_into().unwrap()),
        length: u16::from_le_bytes(body[2..4].try_into().unwrap()),
        flags: u32::from_le_bytes(body[4..8].try_into().unwrap()),
        ecc: body[8],
        position: body[9],
        dlc: body[10],
        // body[11] = reserved1
        frame_length_in_ns: u32::from_le_bytes(body[12..16].try_into().unwrap()),
        id_raw: u32::from_le_bytes(body[16..20].try_into().unwrap()),
        flags_ext: u16::from_le_bytes(body[20..22].try_into().unwrap()),
        // body[22..24] = reserved2
        data,
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

    // ----- CAN_MESSAGE ------------------------------------------

    /// Hand-rolls one full on-disk `CAN_MESSAGE` object.
    fn synth_can_message(
        timestamp_ns: u64,
        channel: u16,
        flags: u8,
        dlc: u8,
        id_raw: u32,
        data: [u8; 8],
    ) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(CAN_EVENT_HEADER_BYTES + CAN_MESSAGE_BODY_BYTES);
        let object_size = u32::try_from(CAN_EVENT_HEADER_BYTES + CAN_MESSAGE_BODY_BYTES).unwrap();
        bytes.extend_from_slice(b"LOBJ");
        bytes.extend_from_slice(&32u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&object_size.to_le_bytes());
        bytes.extend_from_slice(&object_type::CAN_MESSAGE.to_le_bytes());
        bytes.extend_from_slice(&OBJECT_FLAG_TIME_ONE_NANS.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&timestamp_ns.to_le_bytes());
        bytes.extend_from_slice(&channel.to_le_bytes());
        bytes.push(flags);
        bytes.push(dlc);
        bytes.extend_from_slice(&id_raw.to_le_bytes());
        bytes.extend_from_slice(&data);
        bytes
    }

    #[test]
    fn decodes_a_classic_can_message() {
        let bytes = synth_can_message(
            1_500_000_000_000_000_000u64,
            3,
            0,
            4,
            0x101,
            [1, 2, 3, 4, 0, 0, 0, 0],
        );
        let m = decode_can_message(&bytes).unwrap();
        assert_eq!(m.channel, 3);
        assert_eq!(m.dlc, 4);
        assert!(!m.is_extended_id());
        assert_eq!(m.can_id(), 0x101);
        assert_eq!(m.payload(), &[1, 2, 3, 4]);
        // Trailing padding bytes still observable via .data
        assert_eq!(m.data, [1, 2, 3, 4, 0, 0, 0, 0]);
    }

    #[test]
    fn can_message_payload_caps_at_8_bytes_even_with_oversized_dlc() {
        // Some writers set DLC > 8 on remote frames; the on-disk
        // data slot is still 8 bytes, so payload() clamps.
        let bytes = synth_can_message(0, 0, CAN_FLAG_RTR, 12, 0x20, [0xFF; 8]);
        let m = decode_can_message(&bytes).unwrap();
        assert!(m.is_remote());
        assert_eq!(m.payload().len(), 8);
    }

    #[test]
    fn can_message_rejects_wrong_object_type() {
        let mut bytes = synth_can_message(0, 0, 0, 0, 0, [0; 8]);
        bytes[12..16].copy_from_slice(&object_type::CAN_MESSAGE2.to_le_bytes());
        let err = decode_can_message(&bytes).unwrap_err();
        assert!(matches!(
            err,
            CanObjectError::WrongObjectType(expected, _) if expected == object_type::CAN_MESSAGE,
        ));
    }

    /// Round-trip the `CAN_MESSAGE` our (still `blf_asc`-backed)
    /// writer produces today.
    #[test]
    fn round_trips_first_inner_can_message_when_present() {
        use super::super::header::FILE_STATISTICS_MIN_BYTES;
        use super::super::log_container;
        use crate::BlfCaptureWriter;
        use cannet_core::{CanFrame, CanId, Direction};
        use std::io::Read;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cm.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        let frame = CanFrame::classic(
            1_700_000_000_u64 * 1_000_000_000,
            1,
            CanId::standard(0x456).unwrap(),
            Direction::Rx,
            vec![0xCA, 0xFE],
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
        if inner_base.object_type != object_type::CAN_MESSAGE {
            // If `blf_asc` ever flips to CAN_MESSAGE2, the other test
            // covers it; this one is then a no-op.
            return;
        }
        let m = decode_can_message(
            &container.uncompressed_payload[..inner_base.object_size as usize],
        )
        .unwrap();
        assert_eq!(m.can_id(), 0x456);
        assert_eq!(m.payload(), &[0xCA, 0xFE]);
        // Channel-convention reconciliation (BLF stores 1-based,
        // cannet uses 0-based) lives in the conversion layer (step
        // 6); at the format layer we only assert the raw on-disk
        // value is non-zero — which is the spec's "known channel"
        // sentinel.
        assert!(m.channel >= 1, "expected non-zero channel, got {}", m.channel);
    }

    // ----- CAN_FD_MESSAGE ---------------------------------------

    #[test]
    fn decodes_a_can_fd_message() {
        // Hand-build: 32-byte event header + 88-byte body.
        let mut bytes = Vec::with_capacity(CAN_EVENT_HEADER_BYTES + CAN_FD_MESSAGE_BODY_BYTES);
        let object_size = u32::try_from(CAN_EVENT_HEADER_BYTES + CAN_FD_MESSAGE_BODY_BYTES).unwrap();
        bytes.extend_from_slice(b"LOBJ");
        bytes.extend_from_slice(&32u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&object_size.to_le_bytes());
        bytes.extend_from_slice(&object_type::CAN_FD_MESSAGE.to_le_bytes());
        bytes.extend_from_slice(&OBJECT_FLAG_TIME_ONE_NANS.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&42_u64.to_le_bytes()); // timestamp
        // Body
        bytes.extend_from_slice(&0u16.to_le_bytes()); // channel
        bytes.push(CAN_FLAG_TX); // flags
        bytes.push(9); // dlc (FD DLC 9 = 12 bytes)
        bytes.extend_from_slice(&0x200_u32.to_le_bytes()); // id
        bytes.extend_from_slice(&5_000_u32.to_le_bytes()); // frame_length
        bytes.push(0); // arb_bit_count
        bytes.push(CAN_FD_FLAG_EDL | CAN_FD_FLAG_BRS); // can_fd_flags
        bytes.push(12); // valid_data_bytes
        bytes.push(0); // reserved1
        bytes.extend_from_slice(&0u16.to_le_bytes()); // reserved2
        let mut data = [0u8; CAN_FD_MESSAGE_DATA_BYTES];
        for (i, byte) in data.iter_mut().take(12).enumerate() {
            *byte = u8::try_from(i + 1).unwrap();
        }
        bytes.extend_from_slice(&data);
        bytes.extend_from_slice(&0u32.to_le_bytes()); // reserved3

        let m = decode_can_fd_message(&bytes).unwrap();
        assert_eq!(m.dlc, 9);
        assert_eq!(m.valid_data_bytes, 12);
        assert!(m.is_tx());
        assert!(m.bitrate_switch());
        assert!(!m.error_state_indicator());
        assert_eq!(m.payload(), (1u8..=12).collect::<Vec<_>>());
        assert_eq!(m.can_id(), 0x200);
        assert_eq!(m.event.timestamp_ns(), 42);
    }

    // ----- CAN_FD_MESSAGE_64 ------------------------------------

    #[test]
    fn decodes_a_can_fd_message_64() {
        // Fixed prefix 40 bytes + 16 bytes of data, no ext-data, no trailing.
        let data_len = 16usize;
        let body_len = CAN_FD_MESSAGE_64_FIXED_PREFIX_BYTES + data_len;
        let object_size = u32::try_from(CAN_EVENT_HEADER_BYTES + body_len).unwrap();
        let mut bytes = Vec::with_capacity(CAN_EVENT_HEADER_BYTES + body_len);
        bytes.extend_from_slice(b"LOBJ");
        bytes.extend_from_slice(&32u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&object_size.to_le_bytes());
        bytes.extend_from_slice(&object_type::CAN_FD_MESSAGE_64.to_le_bytes());
        bytes.extend_from_slice(&OBJECT_FLAG_TIME_ONE_NANS.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&100_u64.to_le_bytes());
        // Body
        bytes.push(4); // channel
        bytes.push(10); // dlc (FD 10 = 16 bytes)
        bytes.push(u8::try_from(data_len).unwrap()); // valid_data_bytes
        bytes.push(0); // tx_count
        bytes.extend_from_slice(&(0x01AB_CDEF | CAN_ID_EXTENDED_BIT).to_le_bytes());
        bytes.extend_from_slice(&3_000_u32.to_le_bytes()); // frame_length
        bytes.extend_from_slice(&(CAN_FD_64_FLAG_EDL | CAN_FD_64_FLAG_BRS).to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes()); // btr_cfg_arb
        bytes.extend_from_slice(&0u32.to_le_bytes()); // btr_cfg_data
        bytes.extend_from_slice(&0u32.to_le_bytes()); // time_offset_brs_ns
        bytes.extend_from_slice(&0u32.to_le_bytes()); // time_offset_crc_del_ns
        bytes.extend_from_slice(&128u16.to_le_bytes()); // bit_count
        bytes.push(0); // dir
        bytes.push(0); // ext_data_offset
        bytes.extend_from_slice(&0xDEAD_BEEF_u32.to_le_bytes()); // crc
        let payload: Vec<u8> = (0..data_len).map(|i| u8::try_from(i).unwrap()).collect();
        bytes.extend_from_slice(&payload);

        let m = decode_can_fd_message_64(&bytes).unwrap();
        assert_eq!(m.channel, 4);
        assert_eq!(m.dlc, 10);
        assert_eq!(m.valid_data_bytes, u8::try_from(data_len).unwrap());
        assert!(m.is_extended_id());
        assert_eq!(m.can_id(), 0x01AB_CDEF);
        assert!(m.bitrate_switch());
        assert!(!m.error_state_indicator());
        assert_eq!(m.crc, 0xDEAD_BEEF);
        assert_eq!(m.data, payload);
        assert!(m.trailing.is_empty());
    }

    #[test]
    fn can_fd_message_64_preserves_trailing_bytes() {
        // Same as above but tack on 8 bytes of "trailing" content
        // (simulating CanFdExtFrameData padding).
        let data_len = 4usize;
        let trailing = vec![0xAAu8, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11];
        let body_len = CAN_FD_MESSAGE_64_FIXED_PREFIX_BYTES + data_len + trailing.len();
        let object_size = u32::try_from(CAN_EVENT_HEADER_BYTES + body_len).unwrap();
        let mut bytes = Vec::with_capacity(CAN_EVENT_HEADER_BYTES + body_len);
        bytes.extend_from_slice(b"LOBJ");
        bytes.extend_from_slice(&32u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&object_size.to_le_bytes());
        bytes.extend_from_slice(&object_type::CAN_FD_MESSAGE_64.to_le_bytes());
        bytes.extend_from_slice(&OBJECT_FLAG_TIME_ONE_NANS.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.push(0); // channel
        bytes.push(4); // dlc
        bytes.push(u8::try_from(data_len).unwrap());
        bytes.push(0);
        bytes.extend_from_slice(&0x10_u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&CAN_FD_64_FLAG_EDL.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.push(0);
        bytes.push(0);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        bytes.extend_from_slice(&trailing);

        let m = decode_can_fd_message_64(&bytes).unwrap();
        assert_eq!(m.data, vec![0xDE, 0xAD, 0xBE, 0xEF]);
        assert_eq!(m.trailing, trailing);
    }

    // ----- CAN_ERROR_EXT ----------------------------------------

    #[test]
    fn decodes_a_can_error_ext_with_payload() {
        let data: Vec<u8> = vec![0x55, 0x66, 0x77];
        let body_len = CAN_ERROR_EXT_FIXED_PREFIX_BYTES + data.len();
        let object_size = u32::try_from(CAN_EVENT_HEADER_BYTES + body_len).unwrap();
        let mut bytes = Vec::with_capacity(CAN_EVENT_HEADER_BYTES + body_len);
        bytes.extend_from_slice(b"LOBJ");
        bytes.extend_from_slice(&32u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&object_size.to_le_bytes());
        bytes.extend_from_slice(&object_type::CAN_ERROR_EXT.to_le_bytes());
        bytes.extend_from_slice(&OBJECT_FLAG_TIME_ONE_NANS.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&7u64.to_le_bytes());
        bytes.extend_from_slice(&5u16.to_le_bytes()); // channel
        bytes.extend_from_slice(&0u16.to_le_bytes()); // length
        bytes.extend_from_slice(&0b1110u32.to_le_bytes()); // flags
        bytes.push(0x42); // ecc
        bytes.push(7); // position
        bytes.push(8); // dlc
        bytes.push(0); // reserved1
        bytes.extend_from_slice(&123_456u32.to_le_bytes()); // frame_length_in_ns
        bytes.extend_from_slice(&0x789u32.to_le_bytes()); // id
        bytes.extend_from_slice(&0x0020u16.to_le_bytes()); // flags_ext (bit 5: RX)
        bytes.extend_from_slice(&0u16.to_le_bytes()); // reserved2
        bytes.extend_from_slice(&data);

        let e = decode_can_error_ext(&bytes).unwrap();
        assert_eq!(e.channel, 5);
        assert_eq!(e.ecc, 0x42);
        assert_eq!(e.position, 7);
        assert_eq!(e.dlc, 8);
        assert_eq!(e.frame_length_in_ns, 123_456);
        assert_eq!(e.can_id(), 0x789);
        assert_eq!(e.flags_ext, 0x0020);
        assert_eq!(e.data, data);
    }

    #[test]
    fn decodes_can_error_ext_with_empty_payload() {
        let body_len = CAN_ERROR_EXT_FIXED_PREFIX_BYTES;
        let object_size = u32::try_from(CAN_EVENT_HEADER_BYTES + body_len).unwrap();
        let mut bytes = vec![0u8; CAN_EVENT_HEADER_BYTES + body_len];
        bytes[0..4].copy_from_slice(b"LOBJ");
        bytes[4..6].copy_from_slice(&32u16.to_le_bytes());
        bytes[6..8].copy_from_slice(&1u16.to_le_bytes());
        bytes[8..12].copy_from_slice(&object_size.to_le_bytes());
        bytes[12..16].copy_from_slice(&object_type::CAN_ERROR_EXT.to_le_bytes());
        bytes[16..20].copy_from_slice(&OBJECT_FLAG_TIME_ONE_NANS.to_le_bytes());
        let e = decode_can_error_ext(&bytes).unwrap();
        assert!(e.data.is_empty());
    }
}
