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
//! | Per-message DBC-decoded groups | one group per CAN message, its signals as plain channels | offered the same way, tagged with the message they came from |
//!
//! The third is what a tool writes when it decodes a capture with a DBC
//! and saves the result. They are recognised by the
//! `CAN<n>.CAN_DataFrame.ID=…` bus source path their group carries, and
//! that path rides along on
//! [`SignalChannelGroup::decoded_source`] so a caller can tell the two
//! signal kinds apart; [`MdfCanFrameSource::decoded_message_groups`] and
//! [`scan_mdf`] list them on their own for a caller that wants to say
//! what a file holds before reading it. They are *series a file carries*
//! like any other: the database they were decoded against is the
//! recording tool's, not this project's, so nothing here can re-derive
//! them from the raw frames.
//!
//! A file with no bus-logging group at all is a *signal file* — a
//! post-processed measurement rather than a recording of bus traffic. It
//! is read like any other: no frames come out of it, and its signal
//! groups are its content.
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
//! ## Writing
//!
//! [`MdfCaptureWriter`] is the inverse: it writes a capture back out as a
//! sorted, finalized MDF 4.10 file — frames as bus-logging groups,
//! directly recorded signals as their own signal groups, timeline events
//! as `##EV` blocks and databases as embedded `##AT` attachments. What it
//! writes, this crate reads back field for field; [`MdfCaptureWriter`]'s
//! own docs carry the layout and its limits.
//!
//! ## What comes from `mdf4-rs`
//!
//! Block parsing and serialization, the bit-level value decoder, the CC
//! conversion machinery and `##DZ` inflate (including the inverse
//! transposition). The block-graph walk, the record cursor and the
//! bus-logging composition layer are this crate's, in both directions:
//! `mdf4-rs` never follows a channel's `cn_composition` link, so it
//! exposes no frame fields of its own and its own bus-logging writer
//! emits an opaque byte array no other tool reads as CAN traffic.

mod attachments;
mod bus;
mod decode;
mod events;
mod file;
mod scan;
mod signals;
mod write;

pub use attachments::MdfAttachment;
pub use events::MdfEvent;
pub use scan::{scan_mdf, MdfScan};
pub use signals::{FileSignal, SignalChannelGroup, SignalGroupCensus};
pub use write::{MdfCaptureLayout, MdfCaptureWriter, MdfWriteError, MdfWritten};

use std::path::Path;

use cannet_core::{CanFrame, CanFrameSource, IdError};

use bus::BusGroup;
use file::{Mdf4File, RecordCursor, CG_FLAG_PLAIN_BUS_EVENT};

/// A per-message DBC-decoded channel group — one CAN message's signals,
/// as some other tool's DBC decoded them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedMessageGroup {
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
    decoded: Vec<DecodedMessageGroup>,
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
            .field("decoded_message_groups", &self.decoded.len())
            .finish()
    }
}

impl MdfCanFrameSource {
    /// Open `path` as an MDF 4.x file.
    ///
    /// A file with no bus-logging channel group at all opens like any
    /// other and emits no frames: its content is signal groups, which
    /// [`Self::signal_groups`] serves.
    ///
    /// # Errors
    ///
    /// The block-parsing and I/O errors of a malformed file.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, MdfSourceError> {
        let file = Mdf4File::open(path.as_ref())?;
        let decoded = collect_decoded(&file);

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
        let mut source = Self {
            file,
            heads,
            decoded,
        };
        source.fill_heads()?;
        Ok(source)
    }

    /// The signal channel groups the file carries — every group that is
    /// series rather than frames, message-independent and per-message
    /// DBC-decoded alike (each says which it is through
    /// [`SignalChannelGroup::decoded_source`]).
    ///
    /// Reading them is a one-time pass that completes, so this materialises
    /// the series rather than streaming it. Everything that can fail has
    /// already failed by the time a source exists, so this cannot.
    pub fn signal_groups(&self) -> Vec<SignalChannelGroup> {
        signals::signal_groups(&self.file)
    }

    /// The per-message DBC-decoded groups this file carries, listed on
    /// their own so a caller can say what the file holds. Their series
    /// come back from [`Self::signal_groups`] with the rest. Empty for a
    /// file that has none.
    pub fn decoded_message_groups(&self) -> &[DecodedMessageGroup] {
        &self.decoded
    }

    /// The file's timeline markers — its `##EV` blocks, with absolute
    /// timestamps. Empty for a file that carries none.
    ///
    /// # Errors
    ///
    /// [`MdfSourceError::Malformed`] if the event chain does not describe
    /// itself, and the block-parsing errors of a bad `##EV`.
    pub fn events(&self) -> Result<Vec<MdfEvent>, MdfSourceError> {
        events::read_events(&self.file)
    }

    /// The files embedded in this capture as `##AT` attachments — the
    /// databases it was recorded against, when its writer put them there.
    ///
    /// # Errors
    ///
    /// [`MdfSourceError::Malformed`] if the attachment chain does not
    /// describe itself, and the block-parsing errors of a bad `##AT`.
    pub fn attachments(&self) -> Result<Vec<MdfAttachment>, MdfSourceError> {
        attachments::read_attachments(&self.file)
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
fn collect_decoded(file: &Mdf4File) -> Vec<DecodedMessageGroup> {
    file.groups
        .iter()
        .enumerate()
        .filter_map(|(index, g)| {
            let path = decoded_message_source(g)?;
            Some(DecodedMessageGroup {
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
/// this group is something else. One definition, so the groups listed as
/// decoded and the signal groups tagged as decoded cannot disagree.
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

#[derive(Debug)]
pub enum MdfSourceError {
    /// Reading the file itself failed.
    Io(std::io::Error),
    /// `mdf4-rs` could not parse a block.
    Block(mdf4_rs::Error),
    /// The block graph does not describe itself — a bad link, a truncated
    /// block, an address past the end of the file.
    Malformed(String),
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

    /// The origin rule, MDF half (ADR 0024): a file that states an
    /// `hd_start_time_ns` keeps absolute wall-clock timestamps on
    /// *everything* it carries — frames, message-independent signal
    /// samples, and `##EV` events alike — so nothing the file holds can
    /// read as earlier than the file's own start. Same rule the BLF
    /// reader follows, where the stated start comes from
    /// `measurement_start_time` and an unset one supplies zero.
    #[test]
    fn a_stated_hd_start_time_puts_every_kind_of_timestamp_on_the_wall_clock() {
        use cannet_core::CanFrameSource as _;
        const WALL_CLOCK_NS: u64 = 1_709_294_400_000_000_000;

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/time-origins")
            .join("wall-clock-signals.mf4");
        let mut source = MdfCanFrameSource::open(&path).unwrap();
        assert_eq!(source.start_unix_nanos(), WALL_CLOCK_NS);

        let groups = source.signal_groups();
        let samples: Vec<u64> = groups
            .iter()
            .flat_map(|g| &g.signals)
            .flat_map(|s| s.timestamps_ns.iter().copied())
            .collect();
        assert!(!samples.is_empty());
        assert_eq!(
            samples.iter().copied().min(),
            Some(WALL_CLOCK_NS),
            "the earliest sample sits exactly at the stated start"
        );

        let events = source.events().unwrap();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.timestamp_ns >= WALL_CLOCK_NS));

        let mut frames = 0u64;
        while let Some(f) = source.next_frame().unwrap() {
            assert!(f.timestamp_ns >= WALL_CLOCK_NS);
            frames += 1;
        }
        assert_eq!(frames, 120);
    }

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
