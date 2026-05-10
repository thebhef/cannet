//! In-memory BLF replay source for the Phase-2 server.
//!
//! Loads a BLF file completely into memory at startup, partitions its
//! frames by channel, and exposes one [`Interface`] per channel. The
//! server crate iterates each channel's frames in a loop while a client
//! is subscribed.
//!
//! The "in-memory" choice is deliberate for Phase 2: it keeps the
//! server's hot path completely allocation-free per frame, and it makes
//! looping trivial (just walk the slice again). For multi-GB BLFs the
//! tradeoff is wrong — that's a Phase 5 perf concern, not a Phase 2 one.

use std::collections::BTreeMap;
use std::path::Path;

use cannet_blf::{BlfCanFrameSource, BlfSourceError};
use cannet_core::{CanFrame, CanFrameSource, CanFramePayload};

/// One CAN interface exposed by a [`LoopingBlfReplay`].
#[derive(Debug, Clone)]
pub struct Interface {
    /// Stable, human-readable identifier (e.g. `"blf:0"`).
    pub id: String,
    /// Display label for the GUI.
    pub display_name: String,
    /// True if any frame on this channel is a CAN FD frame.
    pub fd_capable: bool,
    /// Underlying BLF channel index this interface maps to.
    pub channel: u8,
}

/// A BLF file loaded into memory and ready to replay.
pub struct LoopingBlfReplay {
    interfaces: Vec<Interface>,
    /// Frames grouped by channel, in their original BLF order.
    frames_by_channel: BTreeMap<u8, Vec<CanFrame>>,
}

impl LoopingBlfReplay {
    /// Open `path`, drain it, and partition the frames by channel.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, ReplayError> {
        let mut source = BlfCanFrameSource::open(path)?;
        let mut frames_by_channel: BTreeMap<u8, Vec<CanFrame>> = BTreeMap::new();
        let mut fd_capable: BTreeMap<u8, bool> = BTreeMap::new();
        while let Some(frame) = source.next_frame()? {
            let entry_fd = matches!(frame.payload, CanFramePayload::Fd { .. });
            *fd_capable.entry(frame.channel).or_insert(false) |= entry_fd;
            frames_by_channel.entry(frame.channel).or_default().push(frame);
        }
        let interfaces = frames_by_channel
            .keys()
            .map(|&channel| Interface {
                id: format!("blf:{channel}"),
                display_name: format!("BLF channel {channel}"),
                fd_capable: fd_capable.get(&channel).copied().unwrap_or(false),
                channel,
            })
            .collect();
        Ok(Self { interfaces, frames_by_channel })
    }

    /// All interfaces exposed by this replay, in ascending channel order.
    #[must_use]
    pub fn interfaces(&self) -> &[Interface] {
        &self.interfaces
    }

    /// Frames recorded on `channel`, or `None` if no such channel exists.
    #[must_use]
    pub fn frames_for_channel(&self, channel: u8) -> Option<&[CanFrame]> {
        self.frames_by_channel.get(&channel).map(Vec::as_slice)
    }

    /// Look up the interface metadata by wire `interface_id`.
    #[must_use]
    pub fn interface_by_id(&self, interface_id: &str) -> Option<&Interface> {
        self.interfaces.iter().find(|iface| iface.id == interface_id)
    }
}

/// Errors that can arise constructing a [`LoopingBlfReplay`].
#[derive(Debug)]
pub enum ReplayError {
    /// The underlying BLF file failed to open or parse.
    Blf(BlfSourceError),
}

impl std::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Blf(e) => write!(f, "blf replay: {e}"),
        }
    }
}

impl std::error::Error for ReplayError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Blf(e) => Some(e),
        }
    }
}

impl From<BlfSourceError> for ReplayError {
    fn from(value: BlfSourceError) -> Self {
        Self::Blf(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use blf_asc::{ArbitrationId, BlfWriter, DataBytes, Message};

    fn classic_msg(timestamp: f64, channel: u16, id: u32, data: Vec<u8>) -> Message {
        Message {
            timestamp: 1_700_000_000.0 + timestamp,
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
            channel,
        }
    }

    fn fd_msg(timestamp: f64, channel: u16, id: u32, data: Vec<u8>) -> Message {
        Message {
            is_fd: true,
            ..classic_msg(timestamp, channel, id, data)
        }
    }

    fn write_fixture(path: &Path, msgs: &[Message]) {
        let mut writer = BlfWriter::create(path).unwrap();
        for m in msgs {
            writer.on_message_received(m).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn partitions_frames_by_channel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("multi.blf");
        write_fixture(
            &path,
            &[
                classic_msg(0.001, 0, 0x100, vec![1]),
                classic_msg(0.002, 1, 0x200, vec![2]),
                classic_msg(0.003, 0, 0x101, vec![3]),
            ],
        );

        let replay = LoopingBlfReplay::open(&path).unwrap();
        assert_eq!(replay.interfaces().len(), 2);
        assert_eq!(replay.interfaces()[0].id, "blf:0");
        assert_eq!(replay.interfaces()[1].id, "blf:1");
        assert_eq!(replay.frames_for_channel(0).unwrap().len(), 2);
        assert_eq!(replay.frames_for_channel(1).unwrap().len(), 1);
        assert!(replay.frames_for_channel(2).is_none());
    }

    #[test]
    fn marks_interface_fd_capable_when_any_fd_frame_present() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fd.blf");
        write_fixture(
            &path,
            &[
                classic_msg(0.001, 0, 0x100, vec![1]),
                fd_msg(0.002, 0, 0x200, vec![0; 12]),
                classic_msg(0.003, 1, 0x300, vec![3]),
            ],
        );

        let replay = LoopingBlfReplay::open(&path).unwrap();
        let iface_0 = replay.interface_by_id("blf:0").unwrap();
        let iface_1 = replay.interface_by_id("blf:1").unwrap();
        assert!(iface_0.fd_capable);
        assert!(!iface_1.fd_capable);
    }

    #[test]
    fn frames_keep_their_recorded_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("order.blf");
        write_fixture(
            &path,
            &[
                classic_msg(0.001, 0, 0x10, vec![1]),
                classic_msg(0.002, 0, 0x11, vec![2]),
                classic_msg(0.003, 0, 0x12, vec![3]),
            ],
        );

        let replay = LoopingBlfReplay::open(&path).unwrap();
        let frames = replay.frames_for_channel(0).unwrap();
        let ids: Vec<u32> = frames.iter().map(|f| f.id.raw()).collect();
        assert_eq!(ids, vec![0x10, 0x11, 0x12]);
    }

    #[test]
    fn empty_blf_yields_no_interfaces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.blf");
        write_fixture(&path, &[]);

        let replay = LoopingBlfReplay::open(&path).unwrap();
        assert!(replay.interfaces().is_empty());
    }
}
