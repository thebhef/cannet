//! Vector BLF log file as a [`cannet_core::CanFrameSource`], plus the
//! [`BlfCaptureWriter`] that turns a stream of
//! [`cannet_core::CanFrame`]s back into a BLF file.
//!
//! Both the reader and the writer are native implementations
//! rooted in [`format`] — they own the on-disk codec end-to-end
//! (`FileStatistics` header → top-level `LOG_CONTAINER` framing →
//! zlib deflate/inflate → per-type CAN event decoders/encoders).
//! The wire shape is hidden behind [`BlfCanFrameSource`] and
//! [`BlfCaptureWriter`] so the rest of the system only ever sees
//! `cannet_core` types.
//!
//! The writer streams to `<dest>.part` before atomically renaming
//! into place on [`BlfCaptureWriter::finish`] — a mid-write crash
//! therefore leaves no half-file behind at `<dest>`. A hard kill
//! skips [`Drop`] and does leave the `<dest>.part`, carrying the
//! placeholder header the writer stamped at open; the reader recovers
//! what such a file holds rather than refusing it (see
//! [`format::reader`]).
//!
//! A third entry point, [`scan_blf`], walks a file header-only for a
//! channel census, time span, and markers — everything the import
//! dialog needs before a single frame is decoded.
//!
//! ## Native implementation
//!
//! Per [ADR 0009](../../../docs/adr/0009-dbc-blf-readers.md), the
//! earlier `blf_asc` wrapper was retired. The native
//! implementation in [`format`] covers reading and writing of
//! `CAN_MESSAGE` (1), `CAN_MESSAGE2` (86),
//! `CAN_FD_MESSAGE` (100), `CAN_FD_MESSAGE_64` (101), and
//! `CAN_ERROR_EXT` (73) — plus the `LOG_CONTAINER` (10) outer
//! wrapper and the `FileStatistics` header. The
//! [BLF feature-support matrix](../../../docs/blf-feature-support.md)
//! is the running checklist; each landed object type updates its
//! row in the same commit that ships the code. The
//! `vector-blf-oracle` cargo feature enables black-box comparison
//! tests against Technica's `vector_blf` C++ library
//! (`tests/oracle.rs`).
//!
//! [`CanFramePayload`]: cannet_core::CanFramePayload

pub mod format;
mod scan;

pub use scan::{scan_blf, scan_blf_cancellable, BlfScan, ScanOutcome, ScanProgress, ScannedMarker};

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use cannet_core::{
    CanFdFlags, CanFrame, CanFrameError, CanFramePayload, CanFrameSource, CanId, Direction, IdError,
};

use format::can::{
    CanErrorExt, CanFdMessage, CanFdMessage64, CanMessage, CanMessage2, CAN_FLAG_RTR, CAN_FLAG_TX,
};
use format::reader::{BlfObject, BlfReadError, BlfReader};

/// Handler for the `GLOBAL_MARKER` records a
/// [`BlfCanFrameSource`] walks past. See
/// [`BlfCanFrameSource::on_marker`].
pub type MarkerSink = Box<dyn FnMut(ScannedMarker) + Send>;

/// A `CanFrameSource` backed by a Vector BLF log file.
pub struct BlfCanFrameSource {
    reader: BlfReader,
    /// File-level start time (ns since UNIX epoch). Per-event
    /// `object_timestamp` is *relative* to this; the adapter
    /// functions add it to recover the absolute timestamp the
    /// `CanFrame` carries.
    start_unix_nanos: u64,
    /// Optional handler for the markers `next_frame` walks past, set by
    /// [`Self::on_marker`]. Without one they are skipped as before.
    marker_sink: Option<MarkerSink>,
}

impl BlfCanFrameSource {
    /// Open `path` as a BLF file. Returns an error if the file can't be
    /// opened or fails BLF header validation.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, BlfSourceError> {
        let reader = BlfReader::open(path)?;
        let start_unix_nanos = reader.start_unix_nanos();
        Ok(Self {
            reader,
            start_unix_nanos,
            marker_sink: None,
        })
    }

    /// Hand every `GLOBAL_MARKER` this source walks past to `sink`, with
    /// its timestamp already resolved to absolute nanoseconds.
    ///
    /// A file's frames and its markers are interleaved in one object
    /// stream, so a consumer that wants both gets both from the single
    /// pass it was already making — there is no second walk to find the
    /// annotations. Markers are rare, so decoding the ones that turn up
    /// costs nothing measurable per frame. Setting a second sink
    /// replaces the first.
    pub fn on_marker(&mut self, sink: impl FnMut(ScannedMarker) + Send + 'static) {
        self.marker_sink = Some(Box::new(sink));
    }

    /// The file's `FileStatistics` header (object count, compressed /
    /// uncompressed sizes, measurement start time, application id).
    /// Parsed once at open; lets a host log a load summary without
    /// re-reading the file.
    pub fn file_statistics(&self) -> &format::header::FileStatistics {
        self.reader.file_statistics()
    }

    /// True when the file still carries the placeholder header its
    /// writer stamped at open, i.e. the writer never finished. The
    /// frames are read the same way either way; what the file cannot
    /// supply is its wall clock, so
    /// [`Self::file_statistics`]`().measurement_start_time` is the
    /// unset sentinel and every frame's timestamp is an offset from
    /// zero.
    pub fn is_unfinalized(&self) -> bool {
        self.reader.file_statistics().is_unfinalized()
    }

    /// Size of the incomplete record this source stopped on, once the
    /// walk has run out. See
    /// [`format::reader::BlfReader::truncated_tail_bytes`].
    pub fn truncated_tail_bytes(&self) -> Option<u64> {
        self.reader.truncated_tail_bytes()
    }
}

impl CanFrameSource for BlfCanFrameSource {
    type Error = BlfSourceError;

    fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
        loop {
            match self.reader.next_object()? {
                None => return Ok(None),
                Some(BlfObject::CanMessage(m)) => {
                    return can_message_to_frame(&m, self.start_unix_nanos).map(Some)
                }
                Some(BlfObject::CanMessage2(m)) => {
                    return can_message2_to_frame(&m, self.start_unix_nanos).map(Some)
                }
                Some(BlfObject::CanFdMessage(m)) => {
                    return can_fd_message_to_frame(&m, self.start_unix_nanos).map(Some)
                }
                Some(BlfObject::CanFdMessage64(m)) => {
                    return can_fd_message_64_to_frame(&m, self.start_unix_nanos).map(Some)
                }
                Some(BlfObject::CanErrorExt(m)) => {
                    return can_error_ext_to_frame(&m, self.start_unix_nanos).map(Some)
                }
                // Markers are the one non-frame object a consumer can
                // ask to see (`on_marker`) — they carry the capture's
                // annotations, and finding them on this pass is what
                // spares a second walk of the whole file.
                Some(BlfObject::GlobalMarker(m)) => {
                    if let Some(sink) = self.marker_sink.as_mut() {
                        sink(ScannedMarker {
                            timestamp_ns: self
                                .start_unix_nanos
                                .saturating_add(m.event.timestamp_ns()),
                            marker: m,
                        });
                    }
                }
                // The remaining non-frame events — text annotations
                // (EVENT_COMMENT, APP_TEXT), diagnostic events
                // (CAN_STATISTIC, DATA_LOST_BEGIN, DATA_LOST_END), and
                // `Other` (anything we don't decode) — skip at the
                // adapter layer and keep walking. Consumers that
                // want them walk the same file through
                // `BlfReader` directly.
                Some(
                    BlfObject::EventComment(_)
                    | BlfObject::AppText(_)
                    | BlfObject::CanStatistic(_)
                    | BlfObject::DataLostBegin(_)
                    | BlfObject::DataLostEnd(_)
                    | BlfObject::Other(_),
                ) => {}
            }
        }
    }
}

#[derive(Debug)]
pub enum BlfSourceError {
    /// Native BLF reader error (I/O, framing, decode).
    Read(BlfReadError),
    /// BLF channel field (1-based on disk; cannet uses 0-based)
    /// overflowed `CanFrame`'s 0..=255 channel space after the
    /// 1-based → 0-based adjustment.
    ChannelOutOfRange(u16),
    /// BLF row carried a CAN id that didn't fit its declared addressing
    /// mode (standard / extended).
    InvalidId(IdError),
    /// Payload length didn't match the constraints of the chosen frame
    /// variant (e.g. >8 bytes on a classic frame).
    InvalidFrame(CanFrameError),
}

impl std::fmt::Display for BlfSourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read(e) => write!(f, "blf reader error: {e}"),
            Self::ChannelOutOfRange(c) => {
                write!(f, "blf channel {c} exceeds CanFrame::channel u8 range")
            }
            Self::InvalidId(e) => write!(f, "invalid CAN id in BLF row: {e}"),
            Self::InvalidFrame(e) => write!(f, "invalid frame produced from BLF row: {e}"),
        }
    }
}

impl std::error::Error for BlfSourceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Read(e) => Some(e),
            Self::InvalidId(e) => Some(e),
            Self::InvalidFrame(e) => Some(e),
            Self::ChannelOutOfRange(_) => None,
        }
    }
}

impl From<BlfReadError> for BlfSourceError {
    fn from(value: BlfReadError) -> Self {
        Self::Read(value)
    }
}
impl From<IdError> for BlfSourceError {
    fn from(value: IdError) -> Self {
        Self::InvalidId(value)
    }
}
impl From<CanFrameError> for BlfSourceError {
    fn from(value: CanFrameError) -> Self {
        Self::InvalidFrame(value)
    }
}

/// BLF stores 1-based channel numbers on disk (channel 0 means
/// "unknown"). cannet's [`CanFrame`] uses 0-based channels, so we
/// subtract 1 here (saturating). Round-trips with `blf_asc`'s
/// writer match: `blf_asc`'s writer adds 1 on the way to disk.
fn adjust_channel_to_zero_based(disk_channel: u16) -> Result<u8, BlfSourceError> {
    let zero_based = disk_channel.saturating_sub(1);
    u8::try_from(zero_based).map_err(|_| BlfSourceError::ChannelOutOfRange(disk_channel))
}

fn classify_id(id_raw: u32, is_extended: bool) -> Result<CanId, BlfSourceError> {
    if is_extended {
        Ok(CanId::extended(id_raw)?)
    } else {
        Ok(CanId::standard(id_raw)?)
    }
}

fn classify_direction(flags: u8) -> Direction {
    if (flags & CAN_FLAG_TX) != 0 {
        Direction::Tx
    } else {
        Direction::Rx
    }
}

fn absolute_ts(rel: u64, start: u64) -> u64 {
    start.saturating_add(rel)
}

fn can_message_to_frame(m: &CanMessage, start_ns: u64) -> Result<CanFrame, BlfSourceError> {
    let timestamp_ns = absolute_ts(m.event.timestamp_ns(), start_ns);
    let channel = adjust_channel_to_zero_based(m.channel)?;
    let id = classify_id(m.can_id(), m.is_extended_id())?;
    let direction = classify_direction(m.flags);
    if (m.flags & CAN_FLAG_RTR) != 0 {
        return Ok(CanFrame::remote(
            timestamp_ns,
            channel,
            id,
            direction,
            m.dlc,
        ));
    }
    Ok(CanFrame::classic(
        timestamp_ns,
        channel,
        id,
        direction,
        m.payload().to_vec(),
    )?)
}

fn can_message2_to_frame(m: &CanMessage2, start_ns: u64) -> Result<CanFrame, BlfSourceError> {
    let timestamp_ns = absolute_ts(m.event.timestamp_ns(), start_ns);
    let channel = adjust_channel_to_zero_based(m.channel)?;
    let id = classify_id(m.can_id(), m.is_extended_id())?;
    let direction = classify_direction(m.flags);
    if m.is_remote() {
        return Ok(CanFrame::remote(
            timestamp_ns,
            channel,
            id,
            direction,
            m.dlc,
        ));
    }
    Ok(CanFrame::classic(
        timestamp_ns,
        channel,
        id,
        direction,
        m.data.clone(),
    )?)
}

fn can_fd_message_to_frame(m: &CanFdMessage, start_ns: u64) -> Result<CanFrame, BlfSourceError> {
    let timestamp_ns = absolute_ts(m.event.timestamp_ns(), start_ns);
    let channel = adjust_channel_to_zero_based(m.channel)?;
    let id = classify_id(m.can_id(), m.is_extended_id())?;
    let direction = classify_direction(m.flags);
    Ok(CanFrame::fd(
        timestamp_ns,
        channel,
        id,
        direction,
        m.payload().to_vec(),
        CanFdFlags {
            bitrate_switch: m.bitrate_switch(),
            error_state_indicator: m.error_state_indicator(),
        },
    )?)
}

fn can_fd_message_64_to_frame(
    m: &CanFdMessage64,
    start_ns: u64,
) -> Result<CanFrame, BlfSourceError> {
    let timestamp_ns = absolute_ts(m.event.timestamp_ns(), start_ns);
    let channel = adjust_channel_to_zero_based(u16::from(m.channel))?;
    let id = classify_id(m.can_id(), m.is_extended_id())?;
    // Direction in CAN_FD_MESSAGE_64 is encoded in `dir`, not in `flags`.
    // 0 = Rx, 1 = Tx (mirrors Vector's convention).
    let direction = if m.dir == 0 {
        Direction::Rx
    } else {
        Direction::Tx
    };
    if m.is_remote() {
        return Ok(CanFrame::remote(
            timestamp_ns,
            channel,
            id,
            direction,
            m.dlc,
        ));
    }
    Ok(CanFrame::fd(
        timestamp_ns,
        channel,
        id,
        direction,
        m.data.clone(),
        CanFdFlags {
            bitrate_switch: m.bitrate_switch(),
            error_state_indicator: m.error_state_indicator(),
        },
    )?)
}

fn can_error_ext_to_frame(m: &CanErrorExt, start_ns: u64) -> Result<CanFrame, BlfSourceError> {
    let timestamp_ns = absolute_ts(m.event.timestamp_ns(), start_ns);
    let channel = adjust_channel_to_zero_based(m.channel)?;
    let id = classify_id(m.can_id(), m.is_extended_id())?;
    // CAN_ERROR_EXT carries direction in flags_ext bit 5 (1 = RX).
    let direction = if (m.flags_ext & 0x0020) != 0 {
        Direction::Rx
    } else {
        Direction::Tx
    };
    Ok(CanFrame::error(timestamp_ns, channel, id, direction))
}

/// Streaming BLF writer driven by [`cannet_core::CanFrame`]s.
///
/// Streams to `<dest>.part` and renames to `<dest>` on
/// [`BlfCaptureWriter::finish`]. Drop without `finish` discards
/// the partial file.
///
/// # On-disk shape
///
/// Classic frames are written as `CAN_MESSAGE2` (object type 86)
/// and CAN FD frames as `CAN_FD_MESSAGE_64` (object type 101) —
/// the modern types Vector's own tools emit. Error frames are
/// `CAN_ERROR_EXT` (73). Remote frames become a `CAN_MESSAGE2`
/// with the RTR flag bit set.
///
/// # Time precision
///
/// Per-event `object_timestamp` is encoded as `u64` nanoseconds
/// relative to the file's `measurement_start_time`. The conversion
/// is lossless — there's no `f64` precision boundary anywhere on
/// the write path. [`FinishedCapture::max_timestamp_drift_ns`]
/// stays for backwards compatibility but is always 0 with the
/// native writer.
pub struct BlfCaptureWriter {
    /// Final destination path the temp file renames to on
    /// [`Self::finish`].
    dest: PathBuf,
    /// Temp file path the writer streams to (`<dest>.part`).
    temp: PathBuf,
    /// `Option` so [`Self::finish`] can take ownership before the
    /// rename. Cleared on success so [`Drop`] doesn't double-finish.
    inner: Option<format::writer::BlfFileWriter>,
    /// Frame count appended so far — included in
    /// [`FinishedCapture`] for system-log integration.
    frame_count: u64,
    /// `GLOBAL_MARKER` (note) count appended so far.
    marker_count: u64,
    /// Events written at the anchor because they preceded it.
    clamped_count: u64,
    /// The deepest such clamp seen so far.
    worst_clamp: Option<ClampedEvent>,
}

/// Successful [`BlfCaptureWriter::finish`] outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FinishedCapture {
    /// Number of frames written to the BLF.
    pub frame_count: u64,
    /// Number of `GLOBAL_MARKER` (note) objects written.
    pub marker_count: u64,
    /// On-disk file size of the renamed-into-place BLF.
    pub byte_size: u64,
    /// Largest observed `|on-disk-ns - source-ns|` round-trip
    /// drift across the written frames. Always 0 with the native
    /// writer (the f64-seconds storage layer that drove this field
    /// retired when `blf_asc` did); kept in the struct for
    /// backwards compatibility with system-message consumers.
    pub max_timestamp_drift_ns: u64,
    /// How many events were written later than their own timestamp
    /// because they preceded the file's `measurement_start_time`.
    /// Zero for a caller that declared its capture's minimum via
    /// [`BlfCaptureWriter::create_with_start`].
    pub clamped_count: u64,
    /// The deepest of those clamps, or `None` when there were none.
    /// Enough to name what moved, so the caller can say so rather
    /// than shipping a file that quietly differs from its capture.
    pub worst_clamp: Option<ClampedEvent>,
}

/// An event the writer could not place at its own timestamp.
///
/// BLF's `objectTimeStamp` is an unsigned offset from the file's
/// `measurement_start_time`, so an event earlier than that anchor has
/// no representation and is written *at* the anchor instead. Reported
/// through [`FinishedCapture::worst_clamp`] so the loss is never
/// silent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClampedEvent {
    /// The event's own timestamp, ns since the UNIX epoch — where it
    /// should have landed.
    pub timestamp_ns: u64,
    /// How far forward it moved to reach the anchor, in nanoseconds.
    pub error_ns: u64,
    /// The clamped frame's `(channel, raw id)`, or `None` when what
    /// clamped was a marker (which carries neither).
    pub frame: Option<(u8, u32)>,
}

/// Anything that can go wrong driving a [`BlfCaptureWriter`].
#[derive(Debug)]
pub enum BlfWriteError {
    /// I/O error opening, writing, finalising, or renaming the file.
    Io(io::Error),
}

impl std::fmt::Display for BlfWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "blf writer I/O error: {e}"),
        }
    }
}

impl std::error::Error for BlfWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
        }
    }
}

impl From<io::Error> for BlfWriteError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl BlfCaptureWriter {
    /// Open a new capture writer that will produce `dest` on
    /// success. Streams to `<dest>.part`; calling [`Self::finish`]
    /// renames into place atomically, while dropping without
    /// `finish` (mid-write crash) leaves only the temp file behind.
    pub fn create<P: AsRef<Path>>(dest: P) -> Result<Self, BlfWriteError> {
        let dest = dest.as_ref().to_path_buf();
        let temp = temp_path_for(&dest);
        let inner = format::writer::BlfFileWriter::create(&temp)?;
        Ok(Self {
            dest,
            temp,
            inner: Some(inner),
            frame_count: 0,
            marker_count: 0,
            clamped_count: 0,
            worst_clamp: None,
        })
    }

    /// Open a capture writer whose `measurement_start_time` is
    /// **declared** up front rather than latched from the first event
    /// appended.
    ///
    /// Per-event `object_timestamp` is an *unsigned* offset from that
    /// start, so the format's one timestamp constraint is that no event
    /// precede it — and arrival order is not timestamp order on a
    /// multi-bus capture
    /// ([ADR 0024](../../../docs/adr/0024-trace-like-view-timing.md)),
    /// so the first event appended is routinely not the earliest. A
    /// caller that knows its capture's minimum passes it here and every
    /// event lands where it belongs: no reordering, and no second pass
    /// over encoded objects. This is the same shape the GUI's MDF save
    /// already uses for the identically-constrained `hd_start_time_ns`
    /// — one pass for the minimum over frames and notes, then a
    /// streaming write.
    ///
    /// `start_unix_nanos` is floored to the enclosing millisecond, the
    /// resolution BLF's SYSTEMTIME-encoded start carries; per-event
    /// offsets keep the sub-millisecond tail.
    ///
    /// A caller that does not know its minimum uses [`Self::create`]
    /// and reads [`FinishedCapture::worst_clamp`] afterwards.
    pub fn create_with_start<P: AsRef<Path>>(
        dest: P,
        start_unix_nanos: u64,
    ) -> Result<Self, BlfWriteError> {
        let mut writer = Self::create(dest)?;
        if let Some(inner) = writer.inner.as_mut() {
            inner.set_start_if_unset((start_unix_nanos / 1_000_000) * 1_000_000);
        }
        Ok(writer)
    }

    /// Append one [`CanFrame`] to the capture.
    pub fn append(&mut self, frame: &CanFrame) -> Result<(), BlfWriteError> {
        let inner = self.inner.as_mut().ok_or_else(|| {
            BlfWriteError::Io(io::Error::other("writer has already been finished"))
        })?;
        // Floor the candidate start to a ms boundary so the
        // SYSTEMTIME-encoded `measurement_start_time` round-trips
        // losslessly. `set_start_if_unset` returns the agreed start
        // (existing or just-set) so the encoder produces a relative
        // per-event timestamp that carries the sub-ms tail.
        let candidate = (frame.timestamp_ns / 1_000_000) * 1_000_000;
        let start = inner.set_start_if_unset(candidate);
        let bytes = frame_to_object_bytes(frame, Some(start));
        inner.append_object(&bytes, frame.timestamp_ns)?;
        self.frame_count += 1;
        self.note_clamp(
            start,
            frame.timestamp_ns,
            Some((frame.channel, frame.id.raw())),
        );
        Ok(())
    }

    /// Record an event that the anchor moved forward. `start` is the
    /// file's `measurement_start_time`; an event at or after it is not
    /// clamped and this does nothing.
    fn note_clamp(&mut self, start: u64, timestamp_ns: u64, frame: Option<(u8, u32)>) {
        let error_ns = start.saturating_sub(timestamp_ns);
        if error_ns == 0 {
            return;
        }
        self.clamped_count += 1;
        if self.worst_clamp.is_none_or(|w| error_ns > w.error_ns) {
            self.worst_clamp = Some(ClampedEvent {
                timestamp_ns,
                error_ns,
                frame,
            });
        }
    }

    /// Append a `GLOBAL_MARKER` (text annotation) at
    /// `timestamp_ns`. `marker_name` is the user-visible label;
    /// `description` carries opaque metadata the host wants to
    /// round-trip (e.g. a stable id). Both are written as raw
    /// UTF-8 bytes — BLF's "MBCS" is encoding-tolerant.
    ///
    /// The marker uses `group_name = "cannet"` and the relocatable
    /// flag `GlobalMarker::build` stamps; `foreground_color` is the
    /// event's `0x00RRGGBB` color (ADR 0035), `0` for the build
    /// default (black). Markers ride in the same `LOG_CONTAINER`s as
    /// CAN frames in timestamp order; intersperse them with `append`
    /// as the capture timeline dictates.
    pub fn append_marker(
        &mut self,
        timestamp_ns: u64,
        marker_name: &str,
        description: &str,
        foreground_color: u32,
    ) -> Result<(), BlfWriteError> {
        let inner = self.inner.as_mut().ok_or_else(|| {
            BlfWriteError::Io(io::Error::other("writer has already been finished"))
        })?;
        let candidate = (timestamp_ns / 1_000_000) * 1_000_000;
        let start = inner.set_start_if_unset(candidate);
        let rel = timestamp_ns.saturating_sub(start);
        let mut marker = format::marker::build(
            rel,
            b"cannet".to_vec(),
            marker_name.as_bytes().to_vec(),
            description.as_bytes().to_vec(),
        );
        // Carry the event's color (ADR 0035) in the marker's `0x00RRGGBB`
        // foreground color; `0` is the build default (black) for an
        // uncolored event, preserving the prior byte output.
        marker.foreground_color = foreground_color;
        let bytes = format::marker::encode(&marker);
        inner.append_object(&bytes, timestamp_ns)?;
        self.marker_count += 1;
        self.note_clamp(start, timestamp_ns, None);
        Ok(())
    }

    /// Flush, finalise, and rename the temp file into the
    /// destination. Returns the byte size and frame count for the
    /// host's system-message integration.
    pub fn finish(mut self) -> Result<FinishedCapture, BlfWriteError> {
        let inner = self.inner.take().ok_or_else(|| {
            BlfWriteError::Io(io::Error::other("writer has already been finished"))
        })?;
        let byte_size = inner.finish()?;
        fs::rename(&self.temp, &self.dest)?;
        Ok(FinishedCapture {
            frame_count: self.frame_count,
            marker_count: self.marker_count,
            byte_size,
            max_timestamp_drift_ns: 0,
            clamped_count: self.clamped_count,
            worst_clamp: self.worst_clamp,
        })
    }
}

impl Drop for BlfCaptureWriter {
    fn drop(&mut self) {
        // If we still have an inner writer, the caller never
        // reached `finish`. Drop it (closes the underlying file
        // handle) and remove the partial file so the destination
        // is observably untouched.
        if let Some(inner) = self.inner.take() {
            drop(inner);
            let _ = fs::remove_file(&self.temp);
        }
    }
}

/// `<dest>.part`. Kept as a free function so the unit tests can
/// reason about the contract without going through the writer.
fn temp_path_for(dest: &Path) -> PathBuf {
    let mut name = dest
        .file_name()
        .map(std::ffi::OsString::from)
        .unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

/// Channel-convention inverse of [`adjust_channel_to_zero_based`]:
/// cannet's 0-based channel becomes the 1-based on-disk value.
fn adjust_channel_to_one_based(cannet_channel: u8) -> u16 {
    u16::from(cannet_channel).saturating_add(1)
}

/// Encode `frame` to its on-disk object bytes. The object's
/// `event.timestamp` is the *relative* offset from `start_ns`; the
/// caller (`BlfFileWriter::append_object`) tracks the absolute
/// timestamp separately so it can stamp the `FileStatistics`
/// `measurement_start_time` correctly.
///
/// Header/body layout is owned by `format::can`'s `build_*`
/// constructors — this function only derives cannet-side framing
/// values (relative timestamp, 1-based channel, wire id, TX flag)
/// and picks which object type + builder the payload maps to.
fn frame_to_object_bytes(frame: &CanFrame, start_ns: Option<u64>) -> Vec<u8> {
    use format::can::{
        build_can_error_ext, build_can_fd_message_64, build_can_message2, encode_can_error_ext,
        encode_can_fd_message_64, encode_can_message2, CAN_FD_64_FLAG_BRS, CAN_FD_64_FLAG_EDL,
        CAN_FD_64_FLAG_ESI, CAN_FLAG_RTR, CAN_FLAG_TX, CAN_ID_EXTENDED_BIT,
    };

    let rel_ns = match start_ns {
        None => 0,
        Some(s) => frame.timestamp_ns.saturating_sub(s),
    };
    let channel = adjust_channel_to_one_based(frame.channel);
    let id_raw = if frame.id.is_extended() {
        frame.id.raw() | CAN_ID_EXTENDED_BIT
    } else {
        frame.id.raw()
    };
    let mut flags: u8 = 0;
    if matches!(frame.direction, Direction::Tx) {
        flags |= CAN_FLAG_TX;
    }

    match &frame.payload {
        CanFramePayload::Classic(data) => {
            let dlc = u8::try_from(data.len()).unwrap_or(u8::MAX);
            let m = build_can_message2(rel_ns, channel, flags, dlc, id_raw, data.clone());
            encode_can_message2(&m)
        }
        CanFramePayload::Remote { dlc } => {
            // Remote frames carry no data; emit a CAN_MESSAGE2 with
            // RTR bit set and an empty data slot.
            let m = build_can_message2(
                rel_ns,
                channel,
                flags | CAN_FLAG_RTR,
                *dlc,
                id_raw,
                Vec::new(),
            );
            encode_can_message2(&m)
        }
        CanFramePayload::Fd {
            data,
            flags: fd_flags,
        } => {
            let dlc = u8::try_from(data.len()).unwrap_or(u8::MAX);
            let mut flags_32: u32 = CAN_FD_64_FLAG_EDL;
            if fd_flags.bitrate_switch {
                flags_32 |= CAN_FD_64_FLAG_BRS;
            }
            if fd_flags.error_state_indicator {
                flags_32 |= CAN_FD_64_FLAG_ESI;
            }
            let dir: u8 = u8::from(matches!(frame.direction, Direction::Tx));
            // `channel` in CAN_FD_MESSAGE_64 is a single byte —
            // cap the on-disk channel at 255 (effectively at
            // cannet's u8 channel + 1 saturating to u8::MAX).
            let channel_u8 = u8::try_from(channel).unwrap_or(u8::MAX);
            let m = build_can_fd_message_64(
                rel_ns,
                channel_u8,
                dlc,
                dlc,
                id_raw,
                flags_32,
                dir,
                data.clone(),
            );
            encode_can_fd_message_64(&m)
        }
        CanFramePayload::Error => {
            let flags_ext: u16 = if matches!(frame.direction, Direction::Rx) {
                0x0020
            } else {
                0
            };
            let e = build_can_error_ext(rel_ns, channel, id_raw, flags_ext);
            encode_can_error_ext(&e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_core::{pump, CanFrameSink, WindowedSource};
    use std::sync::{Arc, Mutex};

    /// Base timestamp for round-trip tests — a "modern" absolute
    /// value where the native writer should now be ns-exact. (The
    /// blf_asc-backed writer this replaced lost sub-µs precision
    /// at this regime; we now expect zero drift.)
    const TS_BASE_NS: u64 = 1_700_000_000_u64 * 1_000_000_000;

    /// Build, write, finish a one-frame BLF and return its path's
    /// owning tempdir + the file path.
    fn write_one(frame: &CanFrame) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.blf");
        let mut w = BlfCaptureWriter::create(&path).unwrap();
        w.append(frame).unwrap();
        w.finish().unwrap();
        (dir, path)
    }

    #[derive(Default)]
    struct VecSink(Vec<CanFrame>);
    impl CanFrameSink for VecSink {
        type Error = std::convert::Infallible;
        fn submit(&mut self, frame: CanFrame) -> Result<(), Self::Error> {
            self.0.push(frame);
            Ok(())
        }
    }

    /// Path to one of the committed `examples/time-origins/` captures.
    fn time_origin_fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/time-origins")
            .join(name)
    }

    /// The origin rule, BLF half (ADR 0024): a file that states a
    /// measurement start time keeps absolute wall-clock timestamps, and
    /// one carrying the all-zero "unset" `SYSTEMTIME` is anchored at
    /// zero and reads as relative. Same arithmetic either way — the
    /// header simply supplies zero — which is what makes it one rule
    /// rather than a special case.
    #[test]
    fn a_stated_measurement_start_makes_timestamps_wall_clock_and_an_unset_one_anchors_at_zero() {
        const WALL_CLOCK_NS: u64 = 1_709_294_400_000_000_000;

        let mut stated =
            BlfCanFrameSource::open(time_origin_fixture("wall-clock-out-of-order.blf")).unwrap();
        assert_eq!(
            stated
                .file_statistics()
                .measurement_start_time
                .to_unix_nanos(),
            WALL_CLOCK_NS,
        );
        let first = stated.next_frame().unwrap().unwrap();
        assert_eq!(
            first.timestamp_ns,
            WALL_CLOCK_NS + 500_000_000,
            "the per-object offset is added to the stated start"
        );

        let mut relative =
            BlfCanFrameSource::open(time_origin_fixture("relative-zero.blf")).unwrap();
        assert_eq!(
            relative
                .file_statistics()
                .measurement_start_time
                .to_unix_nanos(),
            0,
            "the all-zero SYSTEMTIME is the unset sentinel"
        );
        let first = relative.next_frame().unwrap().unwrap();
        assert_eq!(
            first.timestamp_ns, 0,
            "with no stated start the capture is anchored at zero and reads as relative"
        );
    }

    #[test]
    fn round_trips_classic_frame_through_blf() {
        let frame = CanFrame::classic(
            TS_BASE_NS,
            0,
            CanId::standard(0x123).unwrap(),
            Direction::Rx,
            vec![1, 2, 3, 4],
        )
        .unwrap();
        let (_dir, path) = write_one(&frame);

        let mut source = BlfCanFrameSource::open(&path).unwrap();
        let mut sink = VecSink::default();
        pump(&mut source, &mut sink).unwrap();

        assert_eq!(sink.0.len(), 1);
        let back = &sink.0[0];
        assert_eq!(back.id.raw(), 0x123);
        assert!(!back.id.is_extended());
        assert_eq!(back.payload.data(), &[1, 2, 3, 4]);
        assert_eq!(back.direction, Direction::Rx);
    }

    #[test]
    fn maps_extended_ids() {
        let ts_ns = TS_BASE_NS + 1_000_000;
        let frame = CanFrame::classic(
            ts_ns,
            0,
            CanId::extended(0x01AB_CDEF).unwrap(),
            Direction::Rx,
            vec![0xAA],
        )
        .unwrap();
        let (_dir, path) = write_one(&frame);

        let mut source = BlfCanFrameSource::open(&path).unwrap();
        let back = source.next_frame().unwrap().unwrap();
        assert!(back.id.is_extended());
        assert_eq!(back.id.raw(), 0x01AB_CDEF);
        // Native writer/reader is ns-exact; no drift.
        assert_eq!(back.timestamp_ns, ts_ns);
    }

    #[test]
    fn maps_fd_frame_with_flags() {
        let frame = CanFrame::fd(
            TS_BASE_NS + 500_000_000,
            0,
            CanId::standard(0x100).unwrap(),
            Direction::Rx,
            vec![0; 12],
            CanFdFlags {
                bitrate_switch: true,
                error_state_indicator: false,
            },
        )
        .unwrap();
        let (_dir, path) = write_one(&frame);

        let mut source = BlfCanFrameSource::open(&path).unwrap();
        let back = source.next_frame().unwrap().unwrap();
        match &back.payload {
            CanFramePayload::Fd { data, flags } => {
                assert_eq!(data.len(), 12);
                assert!(flags.bitrate_switch);
                assert!(!flags.error_state_indicator);
            }
            other => panic!("expected FD payload, got {other:?}"),
        }
    }

    #[test]
    fn maps_tx_direction() {
        let frame = CanFrame::classic(
            TS_BASE_NS,
            0,
            CanId::standard(0x10).unwrap(),
            Direction::Tx,
            vec![],
        )
        .unwrap();
        let (_dir, path) = write_one(&frame);

        let mut source = BlfCanFrameSource::open(&path).unwrap();
        let back = source.next_frame().unwrap().unwrap();
        assert_eq!(back.direction, Direction::Tx);
    }

    #[test]
    fn next_frame_returns_none_at_eof() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.blf");
        let w = BlfCaptureWriter::create(&path).unwrap();
        w.finish().unwrap();

        let mut source = BlfCanFrameSource::open(&path).unwrap();
        assert!(source.next_frame().unwrap().is_none());
    }

    #[test]
    fn open_missing_file_errors() {
        let Err(err) = BlfCanFrameSource::open("/nonexistent/path/no.blf") else {
            panic!("expected error opening nonexistent file");
        };
        // Native reader surfaces an I/O error inside BlfReadError::Io.
        assert!(matches!(err, BlfSourceError::Read(_)));
    }

    /// The import time range (ADR 0046) is `WindowedSource` wrapped
    /// around the real `CanFrameSource` — no BLF-specific fork. Pumping
    /// a windowed `BlfCanFrameSource` must keep every frame inside the
    /// inclusive bound, including one that arrives *after* a frame past
    /// `end_ns` — a capture's frames are not promised to arrive in
    /// timestamp order (ADR 0024), so the wrapper reads its source to
    /// EOF rather than stopping at the first out-of-range frame. The
    /// marker sink — which fires from inside the wrapped source's own
    /// `next_frame`, ahead of the window check — sees every marker the
    /// whole walk passes, not just a prefix.
    #[test]
    fn windowed_source_filters_a_blf_import_range_reads_to_eof_and_sees_every_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("windowed.blf");
        let mut writer = BlfCaptureWriter::create(&path).unwrap();
        let frame_at = |ts: u64| {
            CanFrame::classic(
                ts,
                0,
                CanId::standard(0x100).unwrap(),
                Direction::Rx,
                vec![1],
            )
            .unwrap()
        };
        writer.append(&frame_at(TS_BASE_NS)).unwrap(); // before start: dropped, walk still passes it
        writer
            .append_marker(TS_BASE_NS, "before", "note-before", 0)
            .unwrap();
        writer.append(&frame_at(TS_BASE_NS + 1_000)).unwrap(); // == start: kept
        writer.append(&frame_at(TS_BASE_NS + 2_000)).unwrap(); // inside: kept
        writer.append(&frame_at(TS_BASE_NS + 3_000)).unwrap(); // == end: kept
        writer.append(&frame_at(TS_BASE_NS + 4_000)).unwrap(); // past end: skipped, walk continues
        writer
            .append_marker(TS_BASE_NS + 4_000, "after", "note-after", 0)
            .unwrap();
        writer.append(&frame_at(TS_BASE_NS + 1_500)).unwrap(); // a dip back in range: must not be lost
        writer.finish().unwrap();

        let mut source = BlfCanFrameSource::open(&path).unwrap();
        let seen_markers: Arc<Mutex<Vec<ScannedMarker>>> = Arc::default();
        source.on_marker({
            let seen_markers = Arc::clone(&seen_markers);
            move |m| seen_markers.lock().unwrap().push(m)
        });
        let mut windowed =
            WindowedSource::new(source, Some(TS_BASE_NS + 1_000), Some(TS_BASE_NS + 3_000));
        let mut sink = VecSink::default();
        pump(&mut windowed, &mut sink).unwrap();

        let kept: Vec<u64> = sink.0.iter().map(|f| f.timestamp_ns).collect();
        assert_eq!(
            kept,
            vec![
                TS_BASE_NS + 1_000,
                TS_BASE_NS + 2_000,
                TS_BASE_NS + 3_000,
                TS_BASE_NS + 1_500,
            ],
            "the dip after the past-end frame must still be kept",
        );

        let markers = seen_markers.lock().unwrap();
        assert_eq!(
            markers.len(),
            2,
            "both markers were walked past — the walk runs to EOF"
        );
        assert_eq!(markers[0].marker.marker_name, b"before");
        assert_eq!(markers[1].marker.marker_name, b"after");
    }

    // ---- BlfCaptureWriter tests ----

    /// Round-trip a classic frame through `BlfCaptureWriter` and
    /// `BlfCanFrameSource`. With the native writer/reader the
    /// timestamp is ns-exact; no drift.
    #[test]
    fn capture_writer_round_trips_classic_frame() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.blf");
        let ts_ns = TS_BASE_NS + 1_000_000;
        let frame = CanFrame::classic(
            ts_ns,
            2,
            CanId::standard(0x123).unwrap(),
            Direction::Rx,
            vec![1, 2, 3, 4],
        )
        .unwrap();
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        w.append(&frame).unwrap();
        let outcome = w.finish().unwrap();
        assert_eq!(outcome.frame_count, 1);
        assert!(outcome.byte_size > 0);
        // Native path has no f64-seconds precision boundary.
        assert_eq!(outcome.max_timestamp_drift_ns, 0);

        let mut r = BlfCanFrameSource::open(&dest).unwrap();
        let back = r.next_frame().unwrap().unwrap();
        assert_eq!(back.id.raw(), 0x123);
        assert!(!back.id.is_extended());
        assert_eq!(back.channel, 2);
        assert_eq!(back.payload.data(), &[1, 2, 3, 4]);
        // Native is ns-exact; no drift.
        assert_eq!(back.timestamp_ns, ts_ns);
        assert!(r.next_frame().unwrap().is_none());
    }

    #[test]
    fn capture_writer_round_trips_fd_frame_with_flags() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("fd.blf");
        let frame = CanFrame::fd(
            TS_BASE_NS,
            0,
            CanId::extended(0x01AB_CDEF).unwrap(),
            Direction::Tx,
            vec![0xAA; 12],
            CanFdFlags {
                bitrate_switch: true,
                error_state_indicator: false,
            },
        )
        .unwrap();
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        w.append(&frame).unwrap();
        w.finish().unwrap();

        let mut r = BlfCanFrameSource::open(&dest).unwrap();
        let back = r.next_frame().unwrap().unwrap();
        assert!(back.id.is_extended());
        assert_eq!(back.id.raw(), 0x01AB_CDEF);
        assert_eq!(back.direction, Direction::Tx);
        match &back.payload {
            CanFramePayload::Fd { data, flags } => {
                assert_eq!(data.len(), 12);
                assert!(flags.bitrate_switch);
                assert!(!flags.error_state_indicator);
            }
            other => panic!("expected FD payload, got {other:?}"),
        }
    }

    #[test]
    fn capture_writer_round_trips_error_frame() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("err.blf");
        let frame = CanFrame::error(TS_BASE_NS, 1, CanId::standard(0x10).unwrap(), Direction::Rx);
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        w.append(&frame).unwrap();
        w.finish().unwrap();

        let mut r = BlfCanFrameSource::open(&dest).unwrap();
        let back = r.next_frame().unwrap().unwrap();
        assert!(matches!(back.payload, CanFramePayload::Error));
        assert_eq!(back.channel, 1);
    }

    /// `append_marker` interleaves with frame writes; the reader's
    /// `next_object` surface sees the marker; the
    /// `CanFrameSource` adapter still yields just the frame.
    #[test]
    fn capture_writer_appends_a_marker_alongside_a_frame() {
        use format::reader::{BlfObject, BlfReader};
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("notes.blf");
        let frame = CanFrame::classic(
            TS_BASE_NS,
            0,
            CanId::standard(0x123).unwrap(),
            Direction::Rx,
            vec![1, 2, 3, 4],
        )
        .unwrap();
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        w.append(&frame).unwrap();
        w.append_marker(
            TS_BASE_NS + 1_000_000,
            "stuck bit",
            "note-uuid-1",
            0x00FF_8800,
        )
        .unwrap();
        let outcome = w.finish().unwrap();
        assert_eq!(outcome.frame_count, 1);
        assert_eq!(outcome.marker_count, 1);

        // CanFrameSource path: just the frame.
        let mut src = BlfCanFrameSource::open(&dest).unwrap();
        let back = src.next_frame().unwrap().unwrap();
        assert_eq!(back.id.raw(), 0x123);
        assert!(src.next_frame().unwrap().is_none());

        // BlfReader path: frame + marker.
        let mut reader = BlfReader::open(&dest).unwrap();
        let mut saw_frame = false;
        let mut saw_marker = false;
        while let Some(obj) = reader.next_object().unwrap() {
            match obj {
                BlfObject::CanMessage2(_) | BlfObject::CanMessage(_) => saw_frame = true,
                BlfObject::GlobalMarker(m) => {
                    assert_eq!(m.group_name, b"cannet");
                    assert_eq!(m.marker_name, b"stuck bit");
                    assert_eq!(m.description, b"note-uuid-1");
                    assert_eq!(m.foreground_color, 0x00FF_8800, "color round-trips");
                    saw_marker = true;
                }
                _ => {}
            }
        }
        assert!(saw_frame);
        assert!(saw_marker);
    }

    /// A consumer that wants a file's annotations gets them from the
    /// pass it was already making: the frame stream is unchanged, and
    /// every marker reaches the sink with an absolute timestamp — so
    /// nothing has to walk the file a second time to find them.
    #[test]
    fn a_marker_sink_sees_every_marker_on_the_frame_walk() {
        use std::sync::{Arc, Mutex};
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("interleaved.blf");
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        for i in 0u32..6 {
            let ts = TS_BASE_NS + u64::from(i) * 1_000_000;
            w.append(
                &CanFrame::classic(
                    ts,
                    0,
                    CanId::standard(0x100 + i).unwrap(),
                    Direction::Rx,
                    vec![u8::try_from(i).unwrap()],
                )
                .unwrap(),
            )
            .unwrap();
            if i % 2 == 0 {
                w.append_marker(ts, &format!("m{i}"), &format!("id-{i}"), 0)
                    .unwrap();
            }
        }
        w.finish().unwrap();

        let seen: Arc<Mutex<Vec<ScannedMarker>>> = Arc::default();
        let mut src = BlfCanFrameSource::open(&dest).unwrap();
        src.on_marker({
            let seen = Arc::clone(&seen);
            move |m| seen.lock().unwrap().push(m)
        });
        let mut frames = 0;
        while src.next_frame().unwrap().is_some() {
            frames += 1;
        }
        assert_eq!(frames, 6, "the marker sink must not disturb the frames");

        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.iter().map(|m| m.timestamp_ns).collect::<Vec<_>>(),
            vec![TS_BASE_NS, TS_BASE_NS + 2_000_000, TS_BASE_NS + 4_000_000],
        );
        assert_eq!(seen[1].marker.marker_name, b"m2");
        assert_eq!(seen[1].marker.description, b"id-2");
    }

    /// Without a sink, markers stay invisible to the frame adapter —
    /// the pre-existing contract, and what every non-import consumer
    /// (the remote pumps, the replay tests) relies on.
    #[test]
    fn without_a_sink_markers_are_skipped_silently() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("unwatched.blf");
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        w.append_marker(TS_BASE_NS, "m", "id", 0).unwrap();
        w.append(
            &CanFrame::classic(
                TS_BASE_NS,
                0,
                CanId::standard(0x1).unwrap(),
                Direction::Rx,
                vec![],
            )
            .unwrap(),
        )
        .unwrap();
        w.finish().unwrap();

        let mut src = BlfCanFrameSource::open(&dest).unwrap();
        assert!(src.next_frame().unwrap().is_some());
        assert!(src.next_frame().unwrap().is_none());
    }

    /// Writes succeed across many frames, atomic rename actually
    /// produced the destination, and the temp path no longer exists.
    #[test]
    fn capture_writer_finish_renames_and_cleans_up_temp() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("many.blf");
        let temp = temp_path_for(&dest);
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        for i in 0u32..32 {
            let f = CanFrame::classic(
                TS_BASE_NS + u64::from(i) * 1_000,
                0,
                CanId::standard(0x100 + i).unwrap(),
                Direction::Rx,
                vec![u8::try_from(i & 0xFF).unwrap()],
            )
            .unwrap();
            w.append(&f).unwrap();
        }
        // While writing the temp file exists at <dest>.part.
        assert!(temp.exists());
        let outcome = w.finish().unwrap();
        assert_eq!(outcome.frame_count, 32);
        assert!(dest.exists());
        assert!(!temp.exists(), "temp file should have been renamed away");
    }

    /// Dropping a writer without `finish` leaves no artefact at
    /// `<dest>`; the temp file is also cleaned up.
    #[test]
    fn capture_writer_drop_without_finish_leaves_no_dest_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("partial.blf");
        let temp = temp_path_for(&dest);
        {
            let mut w = BlfCaptureWriter::create(&dest).unwrap();
            w.append(
                &CanFrame::classic(
                    TS_BASE_NS,
                    0,
                    CanId::standard(0x10).unwrap(),
                    Direction::Rx,
                    vec![],
                )
                .unwrap(),
            )
            .unwrap();
            // Drop here — no `finish`.
        }
        assert!(!dest.exists(), "destination must not exist after drop");
        assert!(!temp.exists(), "temp file must be cleaned up after drop");
    }

    #[test]
    fn temp_path_helper_appends_part_extension() {
        assert_eq!(
            temp_path_for(Path::new("/tmp/x.blf")),
            PathBuf::from("/tmp/x.blf.part"),
        );
        // Bare filename (no directory part) still works.
        assert_eq!(
            temp_path_for(Path::new("x.blf")),
            PathBuf::from("x.blf.part")
        );
    }

    /// The native writer is ns-exact — drift on a high-precision
    /// modern timestamp is zero.
    #[test]
    fn capture_writer_reports_zero_drift_for_modern_timestamps() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("drift.blf");
        let ts_ns = 1_700_000_000_999_999_983u64;
        let mut w = BlfCaptureWriter::create(&dest).unwrap();
        w.append(
            &CanFrame::classic(
                ts_ns,
                0,
                CanId::standard(0x10).unwrap(),
                Direction::Rx,
                vec![],
            )
            .unwrap(),
        )
        .unwrap();
        let outcome = w.finish().unwrap();
        assert_eq!(outcome.max_timestamp_drift_ns, 0);

        // Confirm the read-back ns matches the input bit-for-bit.
        let mut r = BlfCanFrameSource::open(&dest).unwrap();
        let back = r.next_frame().unwrap().unwrap();
        assert_eq!(back.timestamp_ns, ts_ns);
    }
}
