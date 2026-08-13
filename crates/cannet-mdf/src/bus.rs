//! The bus-logging composition layer.
//!
//! MDF ≥ 4.1's bus-logging standard stores a CAN frame as one *structure*
//! channel — `CAN_DataFrame`, `CAN_ErrorFrame` or `CAN_RemoteFrame` — whose
//! `cn_composition` link reaches a chain of sub-channels (`.ID`, `.DLC`,
//! `.DataBytes`, the FD flags `.EDL` / `.BRS` / `.ESI`, …). The
//! sub-channels **overlay** the parent's byte range at their own record
//! offsets; a reader that counted both would double every field.
//!
//! Following that link and slicing the fields out of each record is what
//! turns a channel group into [`cannet_core::CanFrame`]s.

use cannet_core::{CanFdFlags, CanFrame, CanFramePayload, CanId, Direction};
use mdf4_rs::blocks::ChannelBlock;

use crate::file::{Channel, Group, Mdf4File, CN_TYPE_VLSD};
use crate::MdfSourceError;

/// The three structure channel names the CAN bus-logging standard defines.
const FRAME_STRUCTURES: [(&str, FrameKind); 3] = [
    ("CAN_DataFrame", FrameKind::Data),
    ("CAN_ErrorFrame", FrameKind::Error),
    ("CAN_RemoteFrame", FrameKind::Remote),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrameKind {
    Data,
    Error,
    Remote,
}

/// The sub-channels of one bus-logging structure, resolved once per group
/// so that decoding a record is a handful of field reads.
#[derive(Debug)]
pub(crate) struct BusGroup {
    pub(crate) group: usize,
    pub(crate) kind: FrameKind,
    master: ChannelBlock,
    id: ChannelBlock,
    ide: Option<ChannelBlock>,
    dlc: Option<ChannelBlock>,
    data_length: Option<ChannelBlock>,
    data_bytes: Option<ChannelBlock>,
    bus_channel: Option<ChannelBlock>,
    dir: Option<ChannelBlock>,
    edl: Option<ChannelBlock>,
    brs: Option<ChannelBlock>,
    esi: Option<ChannelBlock>,
}

/// The structure channel a group is built around, if it has one.
pub(crate) fn frame_structure(group: &Group) -> Option<(&Channel, FrameKind)> {
    group.channels.iter().find_map(|channel| {
        FRAME_STRUCTURES
            .iter()
            .find(|(name, _)| *name == channel.name)
            .map(|(_, kind)| (channel, *kind))
    })
}

impl BusGroup {
    /// Resolve the composed fields of `group`'s frame structure.
    pub(crate) fn resolve(index: usize, group: &Group) -> Result<Self, MdfSourceError> {
        let (structure, kind) =
            frame_structure(group).ok_or(MdfSourceError::NotABusGroup(index))?;
        let field = |suffix: &str| {
            structure
                .components
                .iter()
                .find(|c| {
                    c.name
                        .rsplit_once('.')
                        .is_some_and(|(_, tail)| tail == suffix)
                })
                .map(|c| c.block.clone())
        };
        let master = group
            .master()
            .ok_or_else(|| MdfSourceError::MissingChannel {
                group: index,
                channel: "master (time)".to_owned(),
            })?
            .block
            .clone();
        let id = field("ID").ok_or_else(|| MdfSourceError::MissingChannel {
            group: index,
            channel: format!("{}.ID", structure.name),
        })?;
        Ok(Self {
            group: index,
            kind,
            master,
            id,
            ide: field("IDE"),
            dlc: field("DLC"),
            data_length: field("DataLength"),
            data_bytes: field("DataBytes"),
            bus_channel: field("BusChannel"),
            dir: field("Dir"),
            edl: field("EDL"),
            brs: field("BRS"),
            esi: field("ESI"),
        })
    }

    /// Turn one record into a frame, its timestamp already absolute.
    pub(crate) fn frame(&self, file: &Mdf4File, record: &[u8]) -> Result<CanFrame, MdfSourceError> {
        let timestamp_ns = self.timestamp_ns(file, record)?;
        let channel = self.channel_of(file, record)?;
        let raw_id = self.integer(file, record, Some(&self.id));
        let extended = self.integer(file, record, self.ide.as_ref()) != 0;
        // `cn_bit_count` is 29 for a conformant `.ID`, but writers have
        // been seen carrying IDE in the top bit; mask to the addressing
        // mode's own width rather than trusting the spare bits.
        let raw_id = u32::try_from(raw_id & 0x1FFF_FFFF).unwrap_or(u32::MAX);
        let id = CanId::new(raw_id, extended)?;
        let direction = if self.integer(file, record, self.dir.as_ref()) == 0 {
            Direction::Rx
        } else {
            Direction::Tx
        };
        let dlc = u8::try_from(self.integer(file, record, self.dlc.as_ref()) & 0xF).unwrap_or(0);

        let payload = match self.kind {
            FrameKind::Error => CanFramePayload::Error,
            FrameKind::Remote => CanFramePayload::Remote { dlc },
            FrameKind::Data => {
                let data = self.payload_bytes(file, record);
                if self.integer(file, record, self.edl.as_ref()) != 0 {
                    CanFramePayload::Fd {
                        flags: CanFdFlags {
                            bitrate_switch: self.integer(file, record, self.brs.as_ref()) != 0,
                            error_state_indicator: self.integer(file, record, self.esi.as_ref())
                                != 0,
                        },
                        data,
                    }
                } else {
                    CanFramePayload::Classic(data)
                }
            }
        };
        validate(&payload)?;
        Ok(CanFrame {
            timestamp_ns,
            channel,
            id,
            direction,
            payload,
        })
    }

    /// The record's master sample, re-absolutized against the file's
    /// `hd_start_time_ns` (ADR 0024 — every timestamp the rest of the
    /// system sees is nanoseconds since the UNIX epoch).
    pub(crate) fn timestamp_ns(
        &self,
        file: &Mdf4File,
        record: &[u8],
    ) -> Result<u64, MdfSourceError> {
        let seconds = crate::decode::as_f64(file, self.group, record, &self.master)
            .ok_or(MdfSourceError::UndecodableTimestamp { group: self.group })?;
        let offset_ns = (seconds * 1e9).round();
        if offset_ns < 0.0 {
            // A master axis that starts before the header time cannot be
            // expressed on the unsigned absolute timeline; clamp to it.
            return Ok(file.start_time_ns);
        }
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        Ok(file.start_time_ns.saturating_add(offset_ns as u64))
    }

    /// `BusChannel` is 1-based on disk, as BLF's channel field is;
    /// `cannet_core` counts from 0.
    pub(crate) fn channel_of(&self, file: &Mdf4File, record: &[u8]) -> Result<u8, MdfSourceError> {
        let raw = self.integer(file, record, self.bus_channel.as_ref());
        u8::try_from(raw.saturating_sub(1)).map_err(|_| MdfSourceError::ChannelOutOfRange(raw))
    }

    fn payload_bytes(&self, file: &Mdf4File, record: &[u8]) -> Vec<u8> {
        let Some(field) = self.data_bytes.as_ref() else {
            return Vec::new();
        };
        let bytes = crate::decode::as_bytes(file, self.group, record, field);
        // `DataLength` is the frame's real length; the `DataBytes` field is
        // sized for the group's longest frame and zero-padded past it.
        let length = match self.data_length.as_ref() {
            Some(len) => usize::try_from(self.integer(file, record, Some(len))).unwrap_or(0),
            None => bytes.len(),
        };
        let mut bytes = bytes;
        bytes.truncate(length.min(bytes.len()));
        bytes
    }

    fn integer(&self, file: &Mdf4File, record: &[u8], field: Option<&ChannelBlock>) -> u64 {
        field.map_or(0, |block| {
            crate::decode::as_u64(file, self.group, record, block)
        })
    }
}

/// Reject a payload `cannet_core` would refuse to hold, naming the limit
/// rather than letting the frame constructors panic downstream.
fn validate(payload: &CanFramePayload) -> Result<(), MdfSourceError> {
    let (len, max) = match payload {
        CanFramePayload::Classic(data) => (data.len(), cannet_core::CLASSIC_DATA_MAX),
        CanFramePayload::Fd { data, .. } => (data.len(), cannet_core::FD_DATA_MAX),
        CanFramePayload::Remote { .. } | CanFramePayload::Error => return Ok(()),
    };
    if len > max {
        return Err(MdfSourceError::PayloadTooLong { len, max });
    }
    Ok(())
}

/// Whether a channel stores its samples in an `##SD` chain the record only
/// points at. Those are strings and byte blobs, not a numeric series.
pub(crate) fn is_vlsd(block: &ChannelBlock) -> bool {
    block.channel_type == CN_TYPE_VLSD && block.data_addr != 0
}
