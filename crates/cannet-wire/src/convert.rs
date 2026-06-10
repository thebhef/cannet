//! Conversion between in-process [`cannet_core::CanFrame`] and the wire
//! [`proto::Frame`] / [`proto::FrameBatch`] types.
//!
//! Encoding from `CanFrame` to wire is infallible: every valid `CanFrame`
//! has a valid wire encoding. Decoding from wire to `CanFrame` is
//! fallible — a wire frame may carry an out-of-range CAN id, an oversize
//! payload, an unrecognised enum variant, or a DLC outside `0..=15`.
//!
//! The wire layer addresses interfaces by string (`interface_id`) carried
//! on [`proto::FrameBatch`]; in-process [`CanFrame`]s carry a numeric
//! `channel: u8`. Mapping between the two is application-level: the
//! conversion helpers that produce a `CanFrame` accept the channel as a
//! parameter so the caller controls the mapping.

use cannet_core::{
    CanFdFlags, CanFrame, CanFrameError, CanFramePayload, CanId, Direction, IdError,
};

use crate::proto;

/// Maximum value representable in the 4-bit CAN DLC field.
const DLC_MAX: u32 = 15;

/// Errors that can arise when decoding a [`proto::Frame`] back into a
/// [`CanFrame`].
#[derive(Debug)]
pub enum ProtoConversionError {
    /// The wire frame's `extended` flag and `can_id` value disagree
    /// (e.g. a value above the 11-bit range with `extended = false`).
    InvalidId(IdError),
    /// The wire frame's payload is longer than its kind allows.
    InvalidPayload(CanFrameError),
    /// `Direction` was `DIRECTION_UNSPECIFIED` or an unrecognised tag.
    UnknownDirection(i32),
    /// `FrameKind` was `FRAME_KIND_UNSPECIFIED` or an unrecognised tag.
    UnknownKind(i32),
    /// A Remote frame's `dlc` value exceeded the 4-bit range.
    InvalidDlc(u32),
}

impl std::fmt::Display for ProtoConversionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidId(e) => write!(f, "invalid CAN id on wire: {e}"),
            Self::InvalidPayload(e) => write!(f, "invalid wire payload: {e}"),
            Self::UnknownDirection(t) => write!(f, "unrecognised Direction tag {t}"),
            Self::UnknownKind(t) => write!(f, "unrecognised FrameKind tag {t}"),
            Self::InvalidDlc(d) => write!(f, "Remote DLC {d} exceeds 4-bit range"),
        }
    }
}

impl std::error::Error for ProtoConversionError {}

/// Convert an in-process [`CanFrame`] to the wire [`proto::Frame`].
#[must_use]
pub fn frame_to_proto(frame: &CanFrame) -> proto::Frame {
    let direction = match frame.direction {
        Direction::Rx => proto::Direction::Rx,
        Direction::Tx => proto::Direction::Tx,
    };
    let (kind, data, brs, esi, dlc) = match &frame.payload {
        CanFramePayload::Classic(d) => {
            (proto::FrameKind::Classic, d.clone(), false, false, 0)
        }
        CanFramePayload::Fd { data, flags } => (
            proto::FrameKind::Fd,
            data.clone(),
            flags.bitrate_switch,
            flags.error_state_indicator,
            0,
        ),
        CanFramePayload::Remote { dlc } => (
            proto::FrameKind::Remote,
            Vec::new(),
            false,
            false,
            u32::from(*dlc),
        ),
        CanFramePayload::Error => (proto::FrameKind::Error, Vec::new(), false, false, 0),
    };
    proto::Frame {
        timestamp_ns: frame.timestamp_ns,
        can_id: frame.id.raw(),
        extended: frame.id.is_extended(),
        direction: direction.into(),
        kind: kind.into(),
        data,
        brs,
        esi,
        dlc,
    }
}

/// Convert a wire [`proto::Frame`] to an in-process [`CanFrame`].
///
/// The caller provides the logical `channel` to attach. The wire layer
/// uses string `interface_id`s on [`proto::FrameBatch`] instead; mapping
/// from `interface_id` to `channel` is application-level.
pub fn proto_to_frame(
    proto_frame: &proto::Frame,
    channel: u8,
) -> Result<CanFrame, ProtoConversionError> {
    let id = if proto_frame.extended {
        CanId::extended(proto_frame.can_id).map_err(ProtoConversionError::InvalidId)?
    } else {
        CanId::standard(proto_frame.can_id).map_err(ProtoConversionError::InvalidId)?
    };
    let direction = match proto::Direction::try_from(proto_frame.direction) {
        Ok(proto::Direction::Rx) => Direction::Rx,
        Ok(proto::Direction::Tx) => Direction::Tx,
        Ok(proto::Direction::Unspecified) | Err(_) => {
            return Err(ProtoConversionError::UnknownDirection(proto_frame.direction));
        }
    };
    let kind = proto::FrameKind::try_from(proto_frame.kind)
        .map_err(|_| ProtoConversionError::UnknownKind(proto_frame.kind))?;
    let frame = match kind {
        proto::FrameKind::Classic => CanFrame::classic(
            proto_frame.timestamp_ns,
            channel,
            id,
            direction,
            proto_frame.data.clone(),
        )
        .map_err(ProtoConversionError::InvalidPayload)?,
        proto::FrameKind::Fd => CanFrame::fd(
            proto_frame.timestamp_ns,
            channel,
            id,
            direction,
            proto_frame.data.clone(),
            CanFdFlags {
                bitrate_switch: proto_frame.brs,
                error_state_indicator: proto_frame.esi,
            },
        )
        .map_err(ProtoConversionError::InvalidPayload)?,
        proto::FrameKind::Remote => {
            if proto_frame.dlc > DLC_MAX {
                return Err(ProtoConversionError::InvalidDlc(proto_frame.dlc));
            }
            #[allow(clippy::cast_possible_truncation)]
            let dlc = proto_frame.dlc as u8;
            CanFrame::remote(proto_frame.timestamp_ns, channel, id, direction, dlc)
        }
        proto::FrameKind::Error => {
            CanFrame::error(proto_frame.timestamp_ns, channel, id, direction)
        }
        proto::FrameKind::Unspecified => {
            return Err(ProtoConversionError::UnknownKind(proto_frame.kind));
        }
    };
    Ok(frame)
}

/// Convert a slice of [`CanFrame`]s to a single [`proto::FrameBatch`]
/// tagged with `interface_id`.
#[must_use]
pub fn batch_to_proto(interface_id: String, frames: &[CanFrame]) -> proto::FrameBatch {
    proto::FrameBatch {
        interface_id,
        frames: frames.iter().map(frame_to_proto).collect(),
    }
}

/// Convert a wire [`proto::FrameBatch`] to a vector of [`CanFrame`]s,
/// each attached to the given `channel`.
pub fn proto_to_batch(
    batch: &proto::FrameBatch,
    channel: u8,
) -> Result<Vec<CanFrame>, ProtoConversionError> {
    batch.frames.iter().map(|f| proto_to_frame(f, channel)).collect()
}
