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
//! therefore leaves no half-file behind at `<dest>`.
//!
//! ## Phase 10 Track 1 — native implementation
//!
//! Per [ADR 0009](../../../docs/adr/0009-dbc-blf-readers.md), the
//! Phase-1 `blf_asc` wrapper was retired in Phase 10 Track 1. The native
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

/// A `CanFrameSource` backed by a Vector BLF log file.
pub struct BlfCanFrameSource {
    reader: BlfReader,
    /// File-level start time (ns since UNIX epoch). Per-event
    /// `object_timestamp` is *relative* to this; the adapter
    /// functions add it to recover the absolute timestamp the
    /// `CanFrame` carries.
    start_unix_nanos: u64,
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
        })
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
                // Non-frame events — text annotations
                // (GLOBAL_MARKER, EVENT_COMMENT, APP_TEXT),
                // diagnostic events (CAN_STATISTIC,
                // DATA_LOST_BEGIN, DATA_LOST_END), and `Other`
                // (anything we don't decode) — skip at the
                // adapter layer and keep walking. Consumers that
                // want them walk the same file through
                // `BlfReader` directly.
                Some(
                    BlfObject::GlobalMarker(_)
                    | BlfObject::EventComment(_)
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
        return Ok(CanFrame::remote(timestamp_ns, channel, id, direction, m.dlc));
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
        return Ok(CanFrame::remote(timestamp_ns, channel, id, direction, m.dlc));
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

fn can_fd_message_64_to_frame(m: &CanFdMessage64, start_ns: u64) -> Result<CanFrame, BlfSourceError> {
    let timestamp_ns = absolute_ts(m.event.timestamp_ns(), start_ns);
    let channel = adjust_channel_to_zero_based(u16::from(m.channel))?;
    let id = classify_id(m.can_id(), m.is_extended_id())?;
    // Direction in CAN_FD_MESSAGE_64 is encoded in `dir`, not in `flags`.
    // 0 = Rx, 1 = Tx (mirrors Vector's convention).
    let direction = if m.dir == 0 { Direction::Rx } else { Direction::Tx };
    if m.is_remote() {
        return Ok(CanFrame::remote(timestamp_ns, channel, id, direction, m.dlc));
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
        })
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
        Ok(())
    }

    /// Append a `GLOBAL_MARKER` (text annotation) at
    /// `timestamp_ns`. `marker_name` is the user-visible label;
    /// `description` carries opaque metadata the host wants to
    /// round-trip (e.g. a stable id). Both are written as raw
    /// UTF-8 bytes — BLF's "MBCS" is encoding-tolerant.
    ///
    /// The marker uses `group_name = "cannet"` and the default
    /// colour / relocatable flags `GlobalMarker::build` stamps.
    /// Markers ride in the same `LOG_CONTAINER`s as CAN frames in
    /// timestamp order; intersperse them with `append` as the
    /// capture timeline dictates.
    pub fn append_marker(
        &mut self,
        timestamp_ns: u64,
        marker_name: &str,
        description: &str,
    ) -> Result<(), BlfWriteError> {
        let inner = self.inner.as_mut().ok_or_else(|| {
            BlfWriteError::Io(io::Error::other("writer has already been finished"))
        })?;
        let candidate = (timestamp_ns / 1_000_000) * 1_000_000;
        let start = inner.set_start_if_unset(candidate);
        let rel = timestamp_ns.saturating_sub(start);
        let marker = format::marker::build(
            rel,
            b"cannet".to_vec(),
            marker_name.as_bytes().to_vec(),
            description.as_bytes().to_vec(),
        );
        let bytes = format::marker::encode(&marker);
        inner.append_object(&bytes, timestamp_ns)?;
        self.marker_count += 1;
        Ok(())
    }

    /// Flush, finalise, and rename the temp file into the
    /// destination. Returns the byte size and frame count for the
    /// host's system-message integration.
    pub fn finish(mut self) -> Result<FinishedCapture, BlfWriteError> {
        let inner = self
            .inner
            .take()
            .ok_or_else(|| BlfWriteError::Io(io::Error::other("writer has already been finished")))?;
        let byte_size = inner.finish()?;
        fs::rename(&self.temp, &self.dest)?;
        Ok(FinishedCapture {
            frame_count: self.frame_count,
            marker_count: self.marker_count,
            byte_size,
            max_timestamp_drift_ns: 0,
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
#[allow(clippy::too_many_lines)]
fn frame_to_object_bytes(frame: &CanFrame, start_ns: Option<u64>) -> Vec<u8> {
    use format::can::{
        encode_can_error_ext, encode_can_fd_message_64, encode_can_message2, CanErrorExt,
        CanFdMessage64, CanMessage2, CAN_EVENT_HEADER_BYTES, CAN_FD_64_FLAG_BRS,
        CAN_FD_64_FLAG_EDL, CAN_FD_64_FLAG_ESI, CAN_FD_MESSAGE_64_FIXED_PREFIX_BYTES,
        CAN_FLAG_RTR, CAN_FLAG_TX, CAN_ID_EXTENDED_BIT,
    };
    use format::object::{
        object_type, ObjectHeaderBase, ObjectHeaderV1, OBJECT_FLAG_TIME_ONE_NANS,
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
            let mut m = CanMessage2 {
                base: ObjectHeaderBase {
                    header_size: 32,
                    header_version: 1,
                    object_size: 0, // filled in below
                    object_type: object_type::CAN_MESSAGE2,
                },
                event: ObjectHeaderV1 {
                    object_flags: OBJECT_FLAG_TIME_ONE_NANS,
                    client_index: 0,
                    object_version: 0,
                    object_timestamp: rel_ns,
                },
                channel,
                flags,
                dlc,
                id_raw,
                data: data.clone(),
                frame_length_ns: 0,
                bit_count: 0,
            };
            m.base.object_size = u32::try_from(
                CAN_EVENT_HEADER_BYTES + 16 + data.len(),
            )
            .unwrap_or(u32::MAX);
            encode_can_message2(&m)
        }
        CanFramePayload::Remote { dlc } => {
            // Remote frames carry no data; emit a CAN_MESSAGE2 with
            // RTR bit set and an empty data slot.
            let mut m = CanMessage2 {
                base: ObjectHeaderBase {
                    header_size: 32,
                    header_version: 1,
                    object_size: 0,
                    object_type: object_type::CAN_MESSAGE2,
                },
                event: ObjectHeaderV1 {
                    object_flags: OBJECT_FLAG_TIME_ONE_NANS,
                    client_index: 0,
                    object_version: 0,
                    object_timestamp: rel_ns,
                },
                channel,
                flags: flags | CAN_FLAG_RTR,
                dlc: *dlc,
                id_raw,
                data: Vec::new(),
                frame_length_ns: 0,
                bit_count: 0,
            };
            m.base.object_size = u32::try_from(CAN_EVENT_HEADER_BYTES + 16).unwrap_or(u32::MAX);
            encode_can_message2(&m)
        }
        CanFramePayload::Fd { data, flags: fd_flags } => {
            let dlc = u8::try_from(data.len()).unwrap_or(u8::MAX);
            let valid_data_bytes = dlc;
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
            let mut m = CanFdMessage64 {
                base: ObjectHeaderBase {
                    header_size: 32,
                    header_version: 1,
                    object_size: 0,
                    object_type: object_type::CAN_FD_MESSAGE_64,
                },
                event: ObjectHeaderV1 {
                    object_flags: OBJECT_FLAG_TIME_ONE_NANS,
                    client_index: 0,
                    object_version: 0,
                    object_timestamp: rel_ns,
                },
                channel: channel_u8,
                dlc,
                valid_data_bytes,
                tx_count: 0,
                id_raw,
                frame_length_ns: 0,
                flags: flags_32,
                btr_cfg_arb: 0,
                btr_cfg_data: 0,
                time_offset_brs_ns: 0,
                time_offset_crc_del_ns: 0,
                bit_count: 0,
                dir,
                ext_data_offset: 0,
                crc: 0,
                data: data.clone(),
                trailing: Vec::new(),
            };
            m.base.object_size = u32::try_from(
                CAN_EVENT_HEADER_BYTES + CAN_FD_MESSAGE_64_FIXED_PREFIX_BYTES + data.len(),
            )
            .unwrap_or(u32::MAX);
            encode_can_fd_message_64(&m)
        }
        CanFramePayload::Error => {
            let flags_ext: u16 = if matches!(frame.direction, Direction::Rx) {
                0x0020
            } else {
                0
            };
            let mut e = CanErrorExt {
                base: ObjectHeaderBase {
                    header_size: 32,
                    header_version: 1,
                    object_size: 0,
                    object_type: object_type::CAN_ERROR_EXT,
                },
                event: ObjectHeaderV1 {
                    object_flags: OBJECT_FLAG_TIME_ONE_NANS,
                    client_index: 0,
                    object_version: 0,
                    object_timestamp: rel_ns,
                },
                channel,
                length: 0,
                flags: 0,
                ecc: 0,
                position: 0,
                dlc: 0,
                frame_length_in_ns: 0,
                id_raw,
                flags_ext,
                data: Vec::new(),
            };
            e.base.object_size = u32::try_from(CAN_EVENT_HEADER_BYTES + 24).unwrap_or(u32::MAX);
            encode_can_error_ext(&e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_core::{pump, CanFrameSink};

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
        w.append_marker(TS_BASE_NS + 1_000_000, "stuck bit", "note-uuid-1")
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
                    saw_marker = true;
                }
                _ => {}
            }
        }
        assert!(saw_frame);
        assert!(saw_marker);
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
        assert_eq!(temp_path_for(Path::new("x.blf")), PathBuf::from("x.blf.part"));
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
