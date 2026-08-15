//! ASAM MDF 4.x bus-logging file as a [`cannet_core::CanFrameSource`].
//!
//! An `.mf4` file hides at least three different kinds of content behind
//! one extension, and the first thing this crate does with a file is
//! decide which it is looking at:
//!
//! | Content | What it holds | What happens |
//! | --- | --- | --- |
//! | Raw bus-logging groups | `CAN_DataFrame` / `CAN_ErrorFrame` / `CAN_RemoteFrame` structure channels | decoded into frames |
//! | Message-independent signal groups | signal channels with no frame behind them | offered through [`MdfCanFrameSource::signal_groups`] |
//! | Per-message DBC-decoded groups | one group per CAN message, its signals as plain channels | **skipped**, and reported |
//!
//! The third is what a tool writes when it decodes a capture with a DBC
//! and saves the result. Its signals are already implied by the raw
//! frames plus the project's own DBC, so importing them would count every
//! signal twice; they are recognised by the `CAN<n>.CAN_DataFrame.ID=…`
//! bus source path their group carries and left alone. Which groups were
//! skipped is available from [`MdfCanFrameSource::skipped_decoded_groups`]
//! and from [`scan_mdf`], so the decision is reported rather than silent.
//!
//! A file with no bus-logging group at all is a *signal file* — a
//! post-processed measurement, not a capture. Opening one fails with
//! [`MdfSourceError::SignalFile`] rather than yielding an empty capture.
//!
//! ## Timestamps
//!
//! A channel group's master channel is time relative to the file's
//! `hd_start_time_ns`. The adapter adds the two, so every
//! [`cannet_core::CanFrame`] leaves this crate carrying absolute
//! nanoseconds since the UNIX epoch, exactly as the BLF adapter's do
//! ([ADR 0024](../../../docs/adr/0024-trace-like-view-timing.md)).
//!
//! Frames arrive in timestamp order across all of the file's bus groups.
//! A sorted file keeps each group in its own data group, so the source
//! merges them; an unsorted file interleaves every group's records in one
//! data block, tagged by record ID, and the same merge holds there.
//!
//! ## Bus mapping
//!
//! `CAN_DataFrame.BusChannel` plays the part BLF's channel number plays,
//! and carries the same 1-based numbering, so the frames this crate emits
//! use `BusChannel - 1` as [`cannet_core::CanFrame::channel`]. [`scan_mdf`]
//! reports the file's channel census for the import dialog's channel → bus
//! mapping, mirroring `cannet_blf::scan_blf`.
//!
//! ## What comes from `mdf4-rs`
//!
//! Block parsing, the bit-level value decoder, the CC conversion
//! machinery and `##DZ` inflate (including the inverse transposition).
//! The block-graph walk, the record cursor and the bus-logging
//! composition layer are this crate's, because `mdf4-rs` never follows a
//! channel's `cn_composition` link and so exposes no frame fields of its
//! own.

mod bus;
mod decode;
mod file;
mod scan;
mod signals;

pub use scan::{scan_mdf, MdfScan};
pub use signals::{FileSignal, SignalChannelGroup};

use std::path::Path;

use cannet_core::{CanFrame, CanFrameSource, IdError};

use bus::BusGroup;
use file::{Mdf4File, RecordCursor, CG_FLAG_BUS_EVENT, CG_FLAG_PLAIN_BUS_EVENT};

/// A per-message DBC-decoded channel group that import stepped over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedDecodedGroup {
    /// Index of the channel group in the file, in link order.
    pub group_index: usize,
    /// The `si_path` that identified it, e.g.
    /// `CAN1.CAN_DataFrame.ID=0x310 EXT=False`.
    pub source_path: String,
    /// The group's `cg_acq_name`, if it has one — what a user would see
    /// the group called in another tool.
    pub name: Option<String>,
    /// How many signal channels the group carried (its master excluded).
    pub signal_count: usize,
}

/// A `CanFrameSource` backed by an ASAM MDF 4.x bus-logging file.
pub struct MdfCanFrameSource {
    file: Mdf4File,
    /// One cursor per bus-logging group, each holding the next frame it
    /// will emit so the merge can pick the earliest.
    heads: Vec<Head>,
    skipped: Vec<SkippedDecodedGroup>,
}

struct Head {
    bus: BusGroup,
    cursor: RecordCursor,
    next: Option<CanFrame>,
}

/// Summarised rather than derived: the source owns the whole file, and a
/// derived `Debug` would print every byte of it.
impl std::fmt::Debug for MdfCanFrameSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MdfCanFrameSource")
            .field("start_unix_nanos", &self.file.start_time_ns)
            .field("unfinalized", &self.file.unfinalized)
            .field("bus_groups", &self.heads.len())
            .field("skipped_decoded_groups", &self.skipped.len())
            .finish()
    }
}

impl MdfCanFrameSource {
    /// Open `path` as an MDF 4.x bus-logging file.
    ///
    /// # Errors
    ///
    /// [`MdfSourceError::SignalFile`] if the file carries no bus-logging
    /// channel group — a pre-decoded measurement rather than a capture.
    /// Otherwise the block-parsing and I/O errors of a malformed file.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, MdfSourceError> {
        let file = Mdf4File::open(path.as_ref())?;
        let skipped = collect_skipped(&file);

        let mut heads = Vec::new();
        for index in 0..file.groups.len() {
            if bus::frame_structure(&file.groups[index]).is_none() {
                continue;
            }
            let bus = BusGroup::resolve(index, &file.groups[index])?;
            let cursor = Mdf4File::cursor(index);
            heads.push(Head {
                bus,
                cursor,
                next: None,
            });
        }
        if heads.is_empty() {
            return Err(MdfSourceError::SignalFile {
                signal_groups: file.groups.len(),
                decoded_groups: skipped.len(),
            });
        }

        let mut source = Self {
            file,
            heads,
            skipped,
        };
        source.fill_heads()?;
        Ok(source)
    }

    /// The message-independent signal channel groups the file carries —
    /// signals recorded directly, with no frame behind them.
    ///
    /// Reading them is a one-time pass that completes, so this materialises
    /// the series rather than streaming it. Everything that can fail has
    /// already failed by the time a source exists, so this cannot.
    pub fn signal_groups(&self) -> Vec<SignalChannelGroup> {
        signals::signal_groups(&self.file)
    }

    /// The per-message DBC-decoded groups this file carries and import
    /// stepped over. Empty for a file that has none.
    pub fn skipped_decoded_groups(&self) -> &[SkippedDecodedGroup] {
        &self.skipped
    }

    /// The file's `hd_start_time_ns` — the wall clock the master channels
    /// are relative to, and the origin of every timestamp emitted here.
    pub fn start_unix_nanos(&self) -> u64 {
        self.file.start_time_ns
    }

    /// Whether the writer left the file unfinalized (`"UnFinMF "`), so
    /// cycle counts and the last data block's length are not to be
    /// trusted. Reading tolerates it; a caller may want to say so.
    pub fn is_unfinalized(&self) -> bool {
        self.file.unfinalized
    }

    fn fill_heads(&mut self) -> Result<(), MdfSourceError> {
        for head in &mut self.heads {
            if head.next.is_none() {
                head.next = advance(&self.file, head)?;
            }
        }
        Ok(())
    }
}

fn advance(file: &Mdf4File, head: &mut Head) -> Result<Option<CanFrame>, MdfSourceError> {
    let Some(record) = file.next_record(&mut head.cursor) else {
        return Ok(None);
    };
    head.bus.frame(file, record).map(Some)
}

impl CanFrameSource for MdfCanFrameSource {
    type Error = MdfSourceError;

    fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
        // Every bus group holds its next frame; emit the earliest, with
        // ties broken by group order so the sequence is deterministic.
        let earliest = self
            .heads
            .iter()
            .enumerate()
            .filter_map(|(i, h)| h.next.as_ref().map(|f| (f.timestamp_ns, i)))
            .min();
        let Some((_, index)) = earliest else {
            return Ok(None);
        };
        let head = &mut self.heads[index];
        let frame = head.next.take();
        head.next = advance(&self.file, head)?;
        Ok(frame)
    }
}

/// Recognise the per-message DBC-decoded groups: a bus source whose path
/// names the frame the signals were decoded from, on a group flagged as a
/// bus event but *not* as a plain (raw-frame) one.
fn collect_skipped(file: &Mdf4File) -> Vec<SkippedDecodedGroup> {
    file.groups
        .iter()
        .enumerate()
        .filter_map(|(index, g)| {
            let path = decoded_message_source(g)?;
            Some(SkippedDecodedGroup {
                group_index: index,
                source_path: path.to_owned(),
                name: g.acq_name.clone(),
                signal_count: g
                    .channels
                    .iter()
                    .filter(|c| c.block.channel_type != file::CN_TYPE_MASTER)
                    .count(),
            })
        })
        .collect()
}

/// The bus source path of a per-message DBC-decoded group, or `None` if
/// this group is something else. One definition, so the groups import
/// skips and the groups it offers as file-backed signals cannot disagree.
pub(crate) fn decoded_message_source(group: &file::Group) -> Option<&str> {
    if group.flags & CG_FLAG_PLAIN_BUS_EVENT != 0 || bus::frame_structure(group).is_some() {
        return None;
    }
    let source = group.source.as_ref()?;
    let path = source.path.as_deref()?;
    (source.is_can_bus() && is_decoded_message_path(path)).then_some(path)
}

/// `CAN1.CAN_DataFrame.ID=0x310 EXT=False` and its `CAN_ErrorFrame` /
/// `CAN_RemoteFrame` siblings — the source path a decoding tool writes on
/// the signal group it produced from a frame.
fn is_decoded_message_path(path: &str) -> bool {
    path.starts_with("CAN") && path.contains(".CAN_") && path.contains(".ID=")
}

/// Whether a group is one of the file's own bus-event groups, by its
/// `cg_flags` alone. Used where the channel names are not to hand.
pub(crate) fn is_bus_event(flags: u16) -> bool {
    flags & CG_FLAG_BUS_EVENT != 0
}

#[derive(Debug)]
pub enum MdfSourceError {
    /// Reading the file itself failed.
    Io(std::io::Error),
    /// `mdf4-rs` could not parse a block.
    Block(mdf4_rs::Error),
    /// The block graph does not describe itself — a bad link, a truncated
    /// block, an address past the end of the file.
    Malformed(String),
    /// The file carries no bus-logging channel group: it is a
    /// pre-decoded signal file, not a capture.
    SignalFile {
        /// How many channel groups it does have.
        signal_groups: usize,
        /// How many of those are per-message DBC-decoded groups.
        decoded_groups: usize,
    },
    /// A group treated as bus-logging turned out to have no frame
    /// structure channel.
    NotABusGroup(usize),
    /// A bus-logging group is missing a channel a frame cannot be built
    /// without.
    MissingChannel { group: usize, channel: String },
    /// A record's master sample would not decode, so its frame has no
    /// place on the timeline.
    UndecodableTimestamp { group: usize },
    /// `BusChannel` (1-based on disk) overflowed `CanFrame`'s 0..=255
    /// channel space after the 1-based → 0-based adjustment.
    ChannelOutOfRange(u64),
    /// A CAN id did not fit its declared addressing mode.
    InvalidId(IdError),
    /// `DataLength` claimed more payload than the frame kind can hold.
    PayloadTooLong { len: usize, max: usize },
}

impl std::fmt::Display for MdfSourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "mdf read error: {e}"),
            Self::Block(e) => write!(f, "mdf block error: {e:?}"),
            Self::Malformed(what) => write!(f, "malformed mdf file: {what}"),
            Self::SignalFile {
                signal_groups,
                decoded_groups,
            } => write!(
                f,
                "this MF4 file holds pre-decoded signals, not bus traffic: \
                 {signal_groups} channel group(s), {decoded_groups} of them \
                 per-message DBC-decoded, and no CAN_DataFrame / \
                 CAN_ErrorFrame / CAN_RemoteFrame group to import"
            ),
            Self::NotABusGroup(group) => {
                write!(f, "channel group {group} carries no CAN frame structure")
            }
            Self::MissingChannel { group, channel } => {
                write!(f, "channel group {group} has no {channel} channel")
            }
            Self::UndecodableTimestamp { group } => {
                write!(
                    f,
                    "channel group {group} has a record whose master sample does not decode"
                )
            }
            Self::ChannelOutOfRange(c) => write!(
                f,
                "BusChannel {c} exceeds CanFrame::channel u8 range once made 0-based"
            ),
            Self::InvalidId(e) => write!(f, "invalid CAN id in MF4 record: {e}"),
            Self::PayloadTooLong { len, max } => {
                write!(
                    f,
                    "MF4 record declares a {len}-byte payload, over the {max}-byte limit"
                )
            }
        }
    }
}

impl std::error::Error for MdfSourceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::InvalidId(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for MdfSourceError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<mdf4_rs::Error> for MdfSourceError {
    fn from(e: mdf4_rs::Error) -> Self {
        Self::Block(e)
    }
}

impl From<IdError> for MdfSourceError {
    fn from(e: IdError) -> Self {
        Self::InvalidId(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoded_message_paths_are_recognised() {
        assert!(is_decoded_message_path(
            "CAN1.CAN_DataFrame.ID=0x310 EXT=False"
        ));
        assert!(is_decoded_message_path(
            "CAN2.CAN_ErrorFrame.ID=0x18FEE125 EXT=True"
        ));
    }

    #[test]
    fn plain_source_paths_are_not_decoded_messages() {
        assert!(!is_decoded_message_path(""));
        assert!(!is_decoded_message_path("CAN"));
        assert!(!is_decoded_message_path("Powertrain"));
        assert!(!is_decoded_message_path("CAN1.CAN_DataFrame"));
    }
}
