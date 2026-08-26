//! Header-only census walk over a BLF file.
//!
//! Building the import dialog's channel → bus mapping needs one fact per
//! frame — its wire channel — and nothing else. [`scan_blf`] walks every
//! object in the file through [`BlfReader::next_raw_object`] and reads
//! that field straight out of the object's bytes: no per-type decode, no
//! payload allocation, no [`cannet_core::CanFrame`] construction. What it
//! costs is the file's inflate, which no reader can avoid.
//!
//! Because the walk covers the **whole** file, the census is exact —
//! a channel that first appears in the last frame is reported like any
//! other. The capture's time span and the file's `GLOBAL_MARKER` records
//! fall out of the same walk for free (markers are rare enough that
//! decoding just those costs nothing), so a caller that needs the
//! capture's duration or its events does not walk again. The span is a
//! **min / max** over the walk rather than the first and last object
//! read: BLF makes no promise that objects are in timestamp order, and
//! the earliest timestamp is the imported capture's origin (ADR 0024).

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::format::marker::GlobalMarker;
use crate::format::object::{object_type, EVENT_HEADER_BYTES};
use crate::format::reader::{BlfReadError, BlfReader};
use crate::format::text::EventComment;
use crate::{adjust_channel_to_zero_based, BlfSourceError};

/// What one header-only walk of a BLF file found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlfScan {
    /// Every distinct wire channel carrying a CAN-class event, 0-based
    /// (as [`cannet_core::CanFrame::channel`] is) and ascending. Exact:
    /// the walk covers the whole file.
    pub channels: Vec<u8>,
    /// CAN-class events seen (frames, including error frames).
    pub frame_count: u64,
    /// Absolute timestamp (ns since the UNIX epoch) of the **earliest**
    /// CAN-class event, or `None` for a file with no frames. A min over
    /// the walk, not the first object read: BLF promises no ordering, and
    /// this is the capture's origin (ADR 0024) as well as the import
    /// dialog's range floor.
    pub first_timestamp_ns: Option<u64>,
    /// Absolute timestamp of the **latest** CAN-class event — a max over
    /// the walk, for the same reason. `last - first` is the capture's
    /// duration.
    pub last_timestamp_ns: Option<u64>,
    /// Every `GLOBAL_MARKER` in the file, in file order, decoded.
    pub markers: Vec<ScannedMarker>,
    /// Every `EVENT_COMMENT` in the file, in file order. The other
    /// annotation record type: a comment attached to the event it sits
    /// beside, rather than a freestanding marker on the timeline.
    pub comments: Vec<ScannedComment>,
    /// The file's measurement start time (ns since the UNIX epoch) —
    /// the wall clock the per-event timestamps are relative to. Zero
    /// when the file states none, which an `unfinalized` capture never
    /// does.
    pub start_unix_nanos: u64,
    /// True when the file still carries the placeholder header its
    /// writer stamped at open — the writer never finished. Everything
    /// this scan reports was derived from the walk, so the counts hold;
    /// what such a file cannot supply is its wall clock (see
    /// `start_unix_nanos`).
    pub unfinalized: bool,
    /// Size of the incomplete record at the end of the file, when the
    /// walk met one. Everything before it is in the counts above; the
    /// fragment itself, and whatever the writer still had buffered, is
    /// lost.
    pub truncated_tail_bytes: Option<u64>,
}

/// One `GLOBAL_MARKER` found by [`scan_blf`], with its timestamp already
/// resolved to the absolute nanoseconds the rest of the system uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedMarker {
    /// Absolute timestamp (ns since the UNIX epoch).
    pub timestamp_ns: u64,
    /// The decoded record, for callers that need its names or color.
    pub marker: GlobalMarker,
}

/// One `EVENT_COMMENT` found by [`scan_blf`], with its timestamp already
/// resolved to the absolute nanoseconds the rest of the system uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedComment {
    /// Absolute timestamp (ns since the UNIX epoch).
    pub timestamp_ns: u64,
    /// The decoded record, for callers that need its text or the type of
    /// the event it comments on.
    pub comment: EventComment,
}

/// The wire channel a CAN-class object carries, read from its body
/// without decoding the rest of the object. Every CAN-class type puts
/// the channel first in its body; `CAN_FD_MESSAGE_64` stores it as one
/// byte, the others as a little-endian `u16`. Returns `None` for object
/// types that aren't CAN-class, and for a body too short to hold the
/// field (a malformed object the census simply doesn't count).
fn channel_of(object_type_id: u32, object_bytes: &[u8]) -> Option<u16> {
    let body = object_bytes.get(EVENT_HEADER_BYTES..)?;
    match object_type_id {
        object_type::CAN_FD_MESSAGE_64 => body.first().map(|b| u16::from(*b)),
        object_type::CAN_MESSAGE
        | object_type::CAN_MESSAGE2
        | object_type::CAN_FD_MESSAGE
        | object_type::CAN_ERROR_EXT => body.get(0..2).map(|b| u16::from_le_bytes([b[0], b[1]])),
        _ => None,
    }
}

/// The per-event timestamp of an object, in nanoseconds relative to the
/// file's measurement start. Reads the `ObjectHeader` v1 extension only.
fn relative_timestamp_ns(object_bytes: &[u8]) -> Option<u64> {
    use crate::format::object::{ObjectHeaderV1, OBJECT_HEADER_BASE_BYTES};
    let ext = object_bytes.get(OBJECT_HEADER_BASE_BYTES..EVENT_HEADER_BYTES)?;
    ObjectHeaderV1::parse(ext)
        .ok()
        .map(ObjectHeaderV1::timestamp_ns)
}

/// How far a census walk has got, reported at each checkpoint.
///
/// Bytes, not frames: discovering the frame count is what the census is
/// *for*, so frames are not a total it knows before it starts, while
/// the file's length is known at open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanProgress {
    /// Bytes pulled off disk so far, header included. Non-decreasing,
    /// and equal to `total_bytes` once the walk has ended.
    pub bytes_read: u64,
    /// The file's length in bytes, as it was at open.
    pub total_bytes: u64,
}

/// What a cancellable census walk ended as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanOutcome {
    /// The walk reached the end of the file; here is what it found.
    Complete(BlfScan),
    /// The walk saw the cancel flag raised and stopped. A census
    /// produces nothing until it finishes — the channel set, the frame
    /// count and the span are only right once the whole file has been
    /// read — so there is no partial result to hand back, and nothing
    /// for a caller to undo.
    Cancelled,
}

/// Objects walked between two checkpoints.
///
/// A checkpoint is where the walk observes the cancel flag and reports
/// its progress, so the stride trades cancel latency against per-object
/// cost. The walk runs at roughly 13 M objects/s on a warm file, so
/// this is on the order of a millisecond of latency there, and stays
/// inside a frame's worth even on a walk an order of magnitude slower —
/// while the per-object cost is one increment and one compare.
const CHECKPOINT_OBJECTS: u64 = 16_384;

/// A cancel flag for the walks that have no cancel of their own — never
/// raised, so [`scan_blf`] compiles down to the same walk it always was
/// bar the checkpoint's counter.
static NEVER_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Walk `path` header-only and report its channel census, frame count,
/// time span, and markers. See the module docs for what this does and
/// does not decode.
///
/// Uninterruptible; [`scan_blf_cancellable`] is the same walk with a
/// cancel flag and a progress callback.
///
/// # Errors
///
/// Propagates the reader's I/O and framing errors, and
/// [`BlfSourceError::ChannelOutOfRange`] if an on-disk channel number
/// doesn't fit `cannet_core`'s 0-based `u8` channel space.
pub fn scan_blf<P: AsRef<Path>>(path: P) -> Result<BlfScan, BlfSourceError> {
    match scan_blf_cancellable(path, &NEVER_CANCELLED, &mut |_| {})? {
        ScanOutcome::Complete(scan) => Ok(scan),
        // Unreachable: the flag handed in is never raised.
        ScanOutcome::Cancelled => unreachable!("NEVER_CANCELLED was raised"),
    }
}

/// [`scan_blf`], but interruptible and reporting how far it has got.
///
/// Every `CHECKPOINT_OBJECTS` objects the walk reads `cancel` and
/// calls `on_progress`. Raising `cancel` stops the walk at the next
/// checkpoint and yields [`ScanOutcome::Cancelled`]; the walk has
/// written nothing anywhere, so stopping it costs nothing to undo.
///
/// `on_progress` is called from the walking thread and runs inside the
/// walk, so it must be cheap: a caller that publishes progress to a UI
/// throttles there, since the checkpoint fires far faster than any
/// consumer needs it to.
///
/// # Errors
///
/// As [`scan_blf`].
pub fn scan_blf_cancellable<P: AsRef<Path>>(
    path: P,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(ScanProgress),
) -> Result<ScanOutcome, BlfSourceError> {
    let mut reader = BlfReader::open(path)?;
    let start_unix_nanos = reader.start_unix_nanos();
    let unfinalized = reader.file_statistics().is_unfinalized();
    let mut channels: BTreeSet<u8> = BTreeSet::new();
    let mut frame_count = 0u64;
    let mut first_timestamp_ns: Option<u64> = None;
    let mut last_timestamp_ns: Option<u64> = None;
    let mut markers = Vec::new();
    let mut comments = Vec::new();
    let total_bytes = reader.file_bytes();
    let mut until_checkpoint = CHECKPOINT_OBJECTS;
    loop {
        // Ahead of the read, not after it: `next_raw_object` borrows the
        // reader for as long as the object it yields is alive, and the
        // checkpoint wants the reader's byte position.
        until_checkpoint -= 1;
        if until_checkpoint == 0 {
            until_checkpoint = CHECKPOINT_OBJECTS;
            if cancel.load(Ordering::Relaxed) {
                return Ok(ScanOutcome::Cancelled);
            }
            on_progress(ScanProgress {
                bytes_read: reader.disk_bytes_read(),
                total_bytes,
            });
        }
        let Some(raw) = reader.next_raw_object()? else {
            break;
        };
        if raw.base.object_type == object_type::GLOBAL_MARKER {
            let marker = crate::format::marker::decode(raw.bytes).map_err(BlfReadError::from)?;
            markers.push(ScannedMarker {
                timestamp_ns: start_unix_nanos.saturating_add(marker.event.timestamp_ns()),
                marker,
            });
            continue;
        }
        if raw.base.object_type == object_type::EVENT_COMMENT {
            let comment =
                crate::format::text::decode_event_comment(raw.bytes).map_err(BlfReadError::from)?;
            comments.push(ScannedComment {
                timestamp_ns: start_unix_nanos.saturating_add(comment.event.timestamp_ns()),
                comment,
            });
            continue;
        }
        let Some(disk_channel) = channel_of(raw.base.object_type, raw.bytes) else {
            continue;
        };
        channels.insert(adjust_channel_to_zero_based(disk_channel)?);
        frame_count += 1;
        if let Some(rel) = relative_timestamp_ns(raw.bytes) {
            let abs = start_unix_nanos.saturating_add(rel);
            first_timestamp_ns = Some(first_timestamp_ns.map_or(abs, |f: u64| f.min(abs)));
            last_timestamp_ns = Some(last_timestamp_ns.map_or(abs, |l: u64| l.max(abs)));
        }
    }
    // The walk is over, so the file has been read to its end: say so,
    // rather than leaving the last report a checkpoint short of it.
    on_progress(ScanProgress {
        bytes_read: reader.disk_bytes_read(),
        total_bytes,
    });
    Ok(ScanOutcome::Complete(BlfScan {
        channels: channels.into_iter().collect(),
        frame_count,
        first_timestamp_ns,
        last_timestamp_ns,
        markers,
        comments,
        start_unix_nanos,
        unfinalized,
        // Read after the walk: the fragment is at the end of the file,
        // so the reader can only have met it once it got there.
        truncated_tail_bytes: reader.truncated_tail_bytes(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BlfCaptureWriter;
    use cannet_core::{CanFdFlags, CanFrame, CanId, Direction};
    use std::sync::atomic::Ordering;

    const BASE_NS: u64 = 1_700_000_000_u64 * 1_000_000_000;

    fn classic(ts: u64, channel: u8, id: u32) -> CanFrame {
        CanFrame::classic(
            ts,
            channel,
            CanId::standard(id).unwrap(),
            Direction::Rx,
            vec![1, 2, 3, 4],
        )
        .unwrap()
    }

    /// The census must cover the **whole** file: a channel that first
    /// appears well past where the old capped pre-scan stopped is still
    /// reported. 200 001 frames is one past that cap, so this fails on
    /// any implementation that stops early.
    #[test]
    fn a_channel_appearing_only_past_the_old_scan_cap_is_still_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("late-channel.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        for i in 0..200_001u64 {
            writer
                .append(&classic(BASE_NS + i * 1_000, 0, 0x100))
                .unwrap();
        }
        writer
            .append(&classic(BASE_NS + 300_000_000, 3, 0x101))
            .unwrap();
        writer.finish().unwrap();

        let scan = scan_blf(&path).unwrap();
        assert_eq!(scan.channels, vec![0, 3]);
        assert_eq!(scan.frame_count, 200_002);
    }

    #[test]
    fn the_census_covers_every_can_class_object_type() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixed.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        writer.append(&classic(BASE_NS, 0, 0x100)).unwrap();
        writer
            .append(
                &CanFrame::fd(
                    BASE_NS + 1_000,
                    1,
                    CanId::extended(0x0001_2345).unwrap(),
                    Direction::Tx,
                    vec![0u8; 24],
                    CanFdFlags {
                        bitrate_switch: true,
                        error_state_indicator: false,
                    },
                )
                .unwrap(),
            )
            .unwrap();
        writer
            .append(&CanFrame::remote(
                BASE_NS + 2_000,
                2,
                CanId::standard(0x200).unwrap(),
                Direction::Rx,
                4,
            ))
            .unwrap();
        writer
            .append(&CanFrame::error(
                BASE_NS + 3_000,
                5,
                CanId::standard(0x0).unwrap(),
                Direction::Rx,
            ))
            .unwrap();
        writer.finish().unwrap();

        let scan = scan_blf(&path).unwrap();
        assert_eq!(scan.channels, vec![0, 1, 2, 5]);
        assert_eq!(scan.frame_count, 4);
    }

    /// The census agrees, frame for frame and channel for channel, with
    /// what the decoding `CanFrameSource` path sees — that equivalence
    /// is the whole justification for skipping the decode.
    #[test]
    fn the_header_only_census_matches_a_full_decode_walk() {
        use cannet_core::CanFrameSource as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agree.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        for i in 0..5_000u64 {
            writer
                .append(&classic(
                    BASE_NS + i * 1_000,
                    u8::try_from(i % 7).unwrap(),
                    0x100 + u32::try_from(i % 13).unwrap(),
                ))
                .unwrap();
        }
        writer.finish().unwrap();

        let mut source = crate::BlfCanFrameSource::open(&path).unwrap();
        let mut decoded_channels = BTreeSet::new();
        let mut decoded_count = 0u64;
        let mut decoded_first = None;
        let mut decoded_last = None;
        while let Some(frame) = source.next_frame().unwrap() {
            decoded_channels.insert(frame.channel);
            decoded_count += 1;
            decoded_first.get_or_insert(frame.timestamp_ns);
            decoded_last = Some(frame.timestamp_ns);
        }

        let scan = scan_blf(&path).unwrap();
        assert_eq!(
            scan.channels,
            decoded_channels.into_iter().collect::<Vec<_>>()
        );
        assert_eq!(scan.frame_count, decoded_count);
        assert_eq!(scan.first_timestamp_ns, decoded_first);
        assert_eq!(scan.last_timestamp_ns, decoded_last);
    }

    /// Markers ride the same walk — the census is what the import dialog
    /// reads its event list from, so it must see every one of them with
    /// absolute timestamps.
    #[test]
    fn markers_come_back_from_the_same_walk_with_absolute_timestamps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("marked.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        writer.append(&classic(BASE_NS, 0, 0x100)).unwrap();
        writer
            .append_marker(BASE_NS + 5_000, "halfway", "note-1", 0x00FF_8800)
            .unwrap();
        writer.append(&classic(BASE_NS + 10_000, 0, 0x101)).unwrap();
        writer.finish().unwrap();

        let scan = scan_blf(&path).unwrap();
        assert_eq!(scan.frame_count, 2, "markers are not frames");
        assert_eq!(scan.markers.len(), 1);
        let m = &scan.markers[0];
        assert_eq!(m.timestamp_ns, BASE_NS + 5_000);
        assert_eq!(m.marker.marker_name, b"halfway");
        assert_eq!(m.marker.description, b"note-1");
        assert_eq!(m.marker.background_color, 0x00FF_8800);
    }

    /// Path to one of the committed `examples/time-origins/` captures.
    fn time_origin_fixture(name: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/time-origins")
            .join(name)
    }

    /// BLF promises nothing about the order of its objects, so the
    /// census's span has to be a min / max over the walk rather than the
    /// first and last thing it happens to read. `wall-clock-out-of-order.blf`
    /// keeps its earliest frame (+120 ms) and its only marker (+100 ms)
    /// at the *end* of the file, after 99 frames starting at +500 ms —
    /// taken in file order the span comes back inverted (first 500 ms,
    /// last 300 ms), and the import dialog's range fields inherit it.
    #[test]
    fn the_span_is_the_min_and_max_of_the_walk_not_its_first_and_last_object() {
        const START: u64 = 1_709_294_400_000_000_000;
        let scan = scan_blf(time_origin_fixture("wall-clock-out-of-order.blf")).unwrap();

        assert_eq!(scan.start_unix_nanos, START, "the file states a wall clock");
        assert_eq!(
            scan.first_timestamp_ns,
            Some(START + 120_000_000),
            "the earliest frame is the second-to-last object in the file"
        );
        assert_eq!(
            scan.last_timestamp_ns,
            Some(START + 2_460_000_000),
            "the latest frame is well before the end of the file"
        );
        assert!(scan.first_timestamp_ns <= scan.last_timestamp_ns);
    }

    /// A census over a file whose bytes are all resident must still be
    /// interruptible: the checkpoint is what a cancel is observed at,
    /// and without one the phase can only be waited out.
    #[test]
    fn a_cancelled_census_stops_the_walk_and_reports_no_scan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cancel.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        for i in 0..400_000u64 {
            writer
                .append(&classic(BASE_NS + i * 1_000, 0, 0x100))
                .unwrap();
        }
        writer.finish().unwrap();

        // Raised at the first checkpoint, so the walk stops at the
        // second one at the latest — well short of the whole file.
        let cancel = AtomicBool::new(false);
        let mut checkpoints = 0u32;
        let outcome = scan_blf_cancellable(&path, &cancel, &mut |_| {
            checkpoints += 1;
            cancel.store(true, Ordering::Relaxed);
        })
        .unwrap();

        assert_eq!(outcome, ScanOutcome::Cancelled);
        assert!(
            checkpoints < 4,
            "the walk kept going past the cancel ({checkpoints} checkpoints)"
        );
    }

    /// The same walk, uncancelled, is the control: it runs to the end
    /// and reports every frame, so the assertion above is about the
    /// cancel and not about a checkpoint that stops the walk regardless.
    #[test]
    fn an_uncancelled_census_runs_to_the_end_of_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("uncancelled.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        for i in 0..400_000u64 {
            writer
                .append(&classic(BASE_NS + i * 1_000, 0, 0x100))
                .unwrap();
        }
        writer.finish().unwrap();

        let cancel = AtomicBool::new(false);
        let mut checkpoints = 0u32;
        let outcome = scan_blf_cancellable(&path, &cancel, &mut |_| checkpoints += 1).unwrap();

        let ScanOutcome::Complete(scan) = outcome else {
            panic!("an uncancelled census must complete");
        };
        assert_eq!(scan.frame_count, 400_000);
        assert!(
            checkpoints > 4,
            "only {checkpoints} checkpoints in 400k objects"
        );
    }

    /// Progress is reported against the file's own length: the census
    /// discovers the frame count, so bytes are the only total it knows
    /// before it starts. It must be non-decreasing, never overshoot,
    /// and land on the whole file when the walk ends.
    #[test]
    fn census_progress_is_bytes_read_against_the_files_length() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("progress.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        for i in 0..400_000u64 {
            writer
                .append(&classic(BASE_NS + i * 1_000, 0, 0x100))
                .unwrap();
        }
        writer.finish().unwrap();
        let on_disk = std::fs::metadata(&path).unwrap().len();

        let cancel = AtomicBool::new(false);
        let mut seen: Vec<ScanProgress> = Vec::new();
        let outcome = scan_blf_cancellable(&path, &cancel, &mut |p| seen.push(p)).unwrap();
        assert!(matches!(outcome, ScanOutcome::Complete(_)));

        assert!(!seen.is_empty(), "no progress was reported at all");
        for p in &seen {
            assert_eq!(p.total_bytes, on_disk);
            assert!(p.bytes_read <= p.total_bytes, "progress overshot: {p:?}");
        }
        for pair in seen.windows(2) {
            assert!(
                pair[1].bytes_read >= pair[0].bytes_read,
                "progress went backwards: {pair:?}"
            );
        }
        assert_eq!(
            seen.last().unwrap().bytes_read,
            on_disk,
            "the last report must be the whole file"
        );
    }

    #[test]
    fn an_empty_file_reports_no_channels_and_no_span() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.blf");
        BlfCaptureWriter::create(&path).unwrap().finish().unwrap();

        let scan = scan_blf(&path).unwrap();
        assert!(scan.channels.is_empty());
        assert_eq!(scan.frame_count, 0);
        assert_eq!(scan.first_timestamp_ns, None);
        assert_eq!(scan.last_timestamp_ns, None);
        assert!(scan.markers.is_empty());
    }
}
