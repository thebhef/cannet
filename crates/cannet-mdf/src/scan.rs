//! Census walk over an MF4 file, for the import dialog.
//!
//! Building the channel → bus mapping needs one fact per frame — its
//! `BusChannel` — plus the capture's time span. [`scan_mdf`] walks every
//! bus-logging record for those, without building a
//! [`cannet_core::CanFrame`] or allocating a payload, and reports the
//! file's other content alongside: the message-independent signal groups
//! it holds, and the per-message DBC-decoded groups import will step over.
//!
//! Because the walk covers the whole file, the census is exact — a channel
//! that first appears in the last record is reported like any other. This
//! mirrors `cannet_blf::scan_blf`, so the dialog that consumes one
//! consumes the other.

use std::collections::BTreeSet;
use std::path::Path;

use crate::bus::{self, BusGroup};
use crate::file::Mdf4File;
use crate::{collect_skipped, MdfSourceError, SkippedDecodedGroup};

/// What one walk of an MF4 file found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdfScan {
    /// Every distinct wire channel carrying a CAN-class event, 0-based
    /// (as [`cannet_core::CanFrame::channel`] is) and ascending. Exact:
    /// the walk covers the whole file.
    pub channels: Vec<u8>,
    /// CAN-class records seen, error and remote frames included.
    pub frame_count: u64,
    /// Absolute timestamp (ns since the UNIX epoch) of the earliest
    /// CAN-class record, or `None` for a file with no frames.
    pub first_timestamp_ns: Option<u64>,
    /// Absolute timestamp of the latest CAN-class record.
    pub last_timestamp_ns: Option<u64>,
    /// The file's `hd_start_time_ns` — the wall clock the master channels
    /// are relative to.
    pub start_unix_nanos: u64,
    /// Whether the writer left the file unfinalized (`"UnFinMF "`).
    pub unfinalized: bool,
    /// Names of the message-independent signal channel groups, in file
    /// order — what [`crate::MdfCanFrameSource::signal_groups`] will
    /// return the series for.
    pub signal_group_names: Vec<Option<String>>,
    /// The per-message DBC-decoded groups import will skip.
    pub skipped_decoded_groups: Vec<SkippedDecodedGroup>,
    /// The file's timeline markers — its `##EV` blocks, in link order,
    /// with absolute timestamps.
    pub events: Vec<crate::MdfEvent>,
}

/// Walk `path` for its channel census, frame count, time span and content
/// shape. See the module docs for what this does and does not decode.
///
/// # Errors
///
/// [`MdfSourceError::SignalFile`] for a file with no bus-logging group,
/// and otherwise the I/O and block-parsing errors of a malformed file.
pub fn scan_mdf<P: AsRef<Path>>(path: P) -> Result<MdfScan, MdfSourceError> {
    let file = Mdf4File::open(path.as_ref())?;
    let skipped_decoded_groups = collect_skipped(&file);

    let bus_groups: Vec<usize> = (0..file.groups.len())
        .filter(|i| bus::frame_structure(&file.groups[*i]).is_some())
        .collect();
    if bus_groups.is_empty() {
        return Err(MdfSourceError::SignalFile {
            signal_groups: file.groups.len(),
            decoded_groups: skipped_decoded_groups.len(),
        });
    }

    let mut channels: BTreeSet<u8> = BTreeSet::new();
    let mut frame_count = 0u64;
    let mut first_timestamp_ns: Option<u64> = None;
    let mut last_timestamp_ns: Option<u64> = None;
    for index in bus_groups {
        let group = BusGroup::resolve(index, &file.groups[index])?;
        let mut cursor = Mdf4File::cursor(index);
        while let Some(record) = file.next_record(&mut cursor) {
            frame_count += 1;
            channels.insert(group.channel_of(&file, record)?);
            let at = group.timestamp_ns(&file, record)?;
            first_timestamp_ns = Some(first_timestamp_ns.map_or(at, |f: u64| f.min(at)));
            last_timestamp_ns = Some(last_timestamp_ns.map_or(at, |l: u64| l.max(at)));
        }
    }

    let signal_group_names = crate::signals::signal_groups(&file)
        .into_iter()
        .map(|g| g.name)
        .collect();

    Ok(MdfScan {
        channels: channels.into_iter().collect(),
        frame_count,
        first_timestamp_ns,
        last_timestamp_ns,
        start_unix_nanos: file.start_time_ns,
        unfinalized: file.unfinalized,
        signal_group_names,
        skipped_decoded_groups,
        events: crate::events::read_events(&file)?,
    })
}
