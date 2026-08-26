//! Census walk over an MF4 file, for the import dialog.
//!
//! Building the channel → bus mapping needs one fact per frame — its
//! `BusChannel` — plus the capture's time span. [`scan_mdf`] walks every
//! bus-logging record for those, without building a
//! [`cannet_core::CanFrame`] or allocating a payload, and reports the
//! file's other content alongside: its signal channel groups,
//! message-independent and per-message DBC-decoded alike, with the
//! decoded ones also listed on their own.
//!
//! Because the walk covers the whole file, the census is exact — a channel
//! that first appears in the last record is reported like any other. This
//! mirrors `cannet_blf::scan_blf`, so the dialog that consumes one
//! consumes the other.
//!
//! The signal side is a *census*, not a read: group names, kinds and
//! channel counts come off the block graph, so the scan says how much
//! signal content a file holds without materialising a single series.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::bus::{self, BusGroup};
use crate::file::Mdf4File;
use crate::{collect_decoded, DecodedMessageGroup, MdfSourceError, SignalGroupCensus};

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
    /// The file's signal channel groups, in file order — what
    /// [`crate::MdfCanFrameSource::signal_groups`] will return the series
    /// for, message-independent and per-message DBC-decoded alike.
    pub signal_groups: Vec<SignalGroupCensus>,
    /// The per-message DBC-decoded groups, listed on their own. Every one
    /// of them also appears in `signal_groups`, tagged with its
    /// `decoded_source`.
    pub decoded_message_groups: Vec<DecodedMessageGroup>,
    /// The file's timeline markers — its `##EV` blocks, in link order,
    /// with absolute timestamps.
    pub events: Vec<crate::MdfEvent>,
}

/// How far a census walk has got, reported at each checkpoint.
///
/// Bytes of the record stream, not records: `cg_cycle_count` is exactly
/// the field an unfinalized writer leaves stale, and the census must
/// report against something it derived itself. The resolved data blocks
/// give it that, and they are known before the first record is read.
///
/// The prologue is not covered. Reading the file in and walking its
/// block graph happens before there is a record stream to be a fraction
/// of; on a plain MF4 that is a tenth of the census, and no report goes
/// out until it is done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanProgress {
    /// Record-stream bytes traversed so far. Non-decreasing, and equal
    /// to `total_bytes` once the walk has ended.
    pub bytes_read: u64,
    /// Record-stream bytes the walk will traverse in total. A data block
    /// shared by two bus channel groups (an unsorted file) counts twice,
    /// because the walk crosses it twice: this is the size of the walk,
    /// not of the file.
    pub total_bytes: u64,
}

/// What a cancellable census walk ended as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanOutcome {
    /// The walk reached the end of the records; here is what it found.
    Complete(MdfScan),
    /// The walk saw the cancel flag raised and stopped. A census
    /// produces nothing until it finishes, so there is no partial result
    /// to hand back and nothing for a caller to undo.
    Cancelled,
}

/// Records walked between two checkpoints. See `cannet_blf`'s
/// counterpart: the two walks run at the same order of throughput, so
/// they trade cancel latency against per-record cost the same way.
const CHECKPOINT_RECORDS: u64 = 16_384;

/// A cancel flag for the walks that have no cancel of their own — never
/// raised, so [`scan_mdf`] is the same walk it always was.
static NEVER_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Walk `path` for its channel census, frame count, time span and content
/// shape. See the module docs for what this does and does not decode.
///
/// A file with no bus-logging group at all scans to an empty channel
/// census with its signal content listed in full — what a dialog needs
/// to offer that content and nothing else.
///
/// Uninterruptible; [`scan_mdf_cancellable`] is the same walk with a
/// cancel flag and a progress callback.
///
/// # Errors
///
/// The I/O and block-parsing errors of a malformed file.
pub fn scan_mdf<P: AsRef<Path>>(path: P) -> Result<MdfScan, MdfSourceError> {
    match scan_mdf_cancellable(path, &NEVER_CANCELLED, &mut |_| {})? {
        ScanOutcome::Complete(scan) => Ok(scan),
        // Unreachable: the flag handed in is never raised.
        ScanOutcome::Cancelled => unreachable!("NEVER_CANCELLED was raised"),
    }
}

/// [`scan_mdf`], but interruptible and reporting how far it has got.
///
/// Every [`CHECKPOINT_RECORDS`] records the walk reads `cancel` and
/// calls `on_progress`. Raising `cancel` stops the walk at the next
/// checkpoint and yields [`ScanOutcome::Cancelled`]; the walk has
/// written nothing anywhere, so stopping it costs nothing to undo.
///
/// Reading the file in and parsing its block graph is a single call
/// that cannot be interrupted, so a cancel raised during it cannot stop
/// it — but it **is** honoured the moment that call returns, before any
/// record is walked. The flag outlives the uninterruptible window
/// because the caller publishes it before calling in, so the press is
/// already recorded by the time there is somewhere to read it.
///
/// `on_progress` runs inside the walk and must be cheap; a caller
/// publishing to a UI throttles there.
///
/// # Errors
///
/// As [`scan_mdf`].
pub fn scan_mdf_cancellable<P: AsRef<Path>>(
    path: P,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(ScanProgress),
) -> Result<ScanOutcome, MdfSourceError> {
    let file = Mdf4File::open(path.as_ref())?;
    // The open above is one uninterruptible call, and it is most of a
    // large file's scan time — so a cancel pressed during it would
    // otherwise wait for the walk's first checkpoint, which on a file
    // holding fewer than `CHECKPOINT_RECORDS` records never arrives at
    // all. Read it here instead: nothing has been produced yet, so
    // stopping costs nothing to undo.
    // The open above is one uninterruptible call, and it is most of a
    // large file's scan time — so a cancel pressed during it would
    // otherwise wait for the walk's first checkpoint, which on a file
    // holding fewer than `CHECKPOINT_RECORDS` records never arrives at
    // all. Read it here instead: nothing has been produced yet, so
    // stopping costs nothing to undo.
    if cancel.load(Ordering::Relaxed) {
        return Ok(ScanOutcome::Cancelled);
    }
    let decoded_message_groups = collect_decoded(&file);

    let bus_groups: Vec<usize> = (0..file.groups.len())
        .filter(|i| bus::frame_structure(&file.groups[*i]).is_some())
        .collect();

    let total_bytes: u64 = bus_groups.iter().map(|i| file.group_data_bytes(*i)).sum();
    let mut walked_before = 0u64;
    let mut until_checkpoint = CHECKPOINT_RECORDS;

    let mut channels: BTreeSet<u8> = BTreeSet::new();
    let mut frame_count = 0u64;
    let mut first_timestamp_ns: Option<u64> = None;
    let mut last_timestamp_ns: Option<u64> = None;
    for index in bus_groups {
        let group = BusGroup::resolve(index, &file.groups[index])?;
        let mut cursor = Mdf4File::cursor(index);
        while let Some(record) = file.next_record(&mut cursor) {
            until_checkpoint -= 1;
            if until_checkpoint == 0 {
                until_checkpoint = CHECKPOINT_RECORDS;
                if cancel.load(Ordering::Relaxed) {
                    return Ok(ScanOutcome::Cancelled);
                }
                on_progress(ScanProgress {
                    bytes_read: walked_before + file.cursor_data_bytes(&cursor),
                    total_bytes,
                });
            }
            frame_count += 1;
            channels.insert(group.channel_of(&file, record)?);
            let at = group.timestamp_ns(&file, record)?;
            first_timestamp_ns = Some(first_timestamp_ns.map_or(at, |f: u64| f.min(at)));
            last_timestamp_ns = Some(last_timestamp_ns.map_or(at, |l: u64| l.max(at)));
        }
        walked_before += file.group_data_bytes(index);
    }
    // The walk is over, so every record byte it was going to cross has
    // been crossed: say so, rather than leaving the last report a
    // checkpoint short of it.
    on_progress(ScanProgress {
        bytes_read: walked_before,
        total_bytes,
    });

    let signal_groups = crate::signals::signal_group_census(&file);

    Ok(ScanOutcome::Complete(MdfScan {
        channels: channels.into_iter().collect(),
        frame_count,
        first_timestamp_ns,
        last_timestamp_ns,
        start_unix_nanos: file.start_time_ns,
        unfinalized: file.unfinalized,
        signal_groups,
        decoded_message_groups,
        events: crate::events::read_events(&file)?,
    }))
}
