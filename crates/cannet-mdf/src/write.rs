//! Writing a capture back out as a sorted, finalized MDF 4.10 file.
//!
//! ## What the writer emits
//!
//! One data group per channel group (that is what *sorted* means in MDF),
//! `##DT` records uncompressed, and the ID block's finalization flags
//! clear:
//!
//! | Channel group | Holds |
//! | --- | --- |
//! | `CAN_DataFrame` | every classic and FD data frame, `BusChannel` carrying the bus |
//! | `CAN_ErrorFrame` | error frames |
//! | `CAN_RemoteFrame` | remote frames |
//! | one per signal | a directly recorded series, verbatim |
//!
//! The three bus groups are always written, empty or not, as real logger
//! files do — a capture with no error frames still says so in the shape of
//! the file, and a capture with no frames at all is still recognisably a
//! logger file rather than a signal file.
//!
//! Each bus group is a **structure channel**: one `##CN` spanning the
//! frame, its `cn_composition` reaching a chain of one `##CN` per member
//! (`.ID`, `.DLC`, `.DataBytes`, the FD flags `.EDL` / `.BRS` / `.ESI`, …)
//! that overlay the parent's byte range. That composition is what makes a
//! file bus logging rather than an opaque byte array, so it is spelled out
//! here rather than left to a library.
//!
//! ## Timestamps
//!
//! `hd_start_time_ns` is the caller's [`MdfCaptureLayout::start_time_ns`]
//! and every master sample is `f64` seconds relative to it, so the origin
//! plus the offset reproduces the absolute nanoseconds the rest of the
//! system carries ([ADR 0024](../../../docs/adr/0024-trace-like-view-timing.md)).
//! Recovery is exact while the capture's span stays under about 26 days;
//! past that a nanosecond is finer than an `f64` second's last bit.
//!
//! ## What rides along
//!
//! Timeline events become `##EV` marker blocks ([`crate::MdfEvent`]), and
//! files a caller wants to travel with the capture — the project's DBCs —
//! become embedded `##AT` attachments. Both are the format's own in-file
//! mechanisms, which is what
//! [ADR 0010](../../../docs/adr/0010-no-sidecar-files.md) asks for.
//!
//! ## Memory
//!
//! Data-frame records stream to the file as they are appended; nothing
//! about a frame is retained after [`MdfCaptureWriter::append_frame`]
//! returns. Error and remote records, signals, events and attachments
//! buffer until [`MdfCaptureWriter::finish`], because they are small next
//! to the frame stream and their blocks land after it.

use std::fs::{self, File};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use cannet_core::{CanFrame, CanFramePayload, Direction};
use mdf4_rs::blocks::{
    AttachmentBlock, BlockHeader, ChannelBlock, ChannelGroupBlock, ConversionBlock, ConversionType,
    DataGroupBlock, DataType, EventBlock, EventCause, EventRangeType, EventSyncType, EventType,
    FileHistoryBlock, HeaderBlock, IdentificationBlock, MetadataBlock, SourceBlock, TextBlock,
};

use crate::attachments::MdfAttachment;
use crate::events::{comment_xml, MdfEvent, MdfEventRange};
use crate::file::{CN_TYPE_MASTER, SI_BUS_CAN, SI_TYPE_BUS};
use crate::signals::FileSignal;

/// `cn_flags` bit 10 — the channel is part of a bus event.
const CN_FLAG_BUS_EVENT: u32 = 0x400;
/// `cn_sync_type` 1 — the master axis is time.
const CN_SYNC_TIME: u8 = 1;
/// `cg_flags` bits 1 and 2 — bus events, and *plain* (raw-frame) ones.
const CG_FLAGS_PLAIN_BUS_EVENT: u16 = 0x2 | 0x4;
/// `hd_time_flags` bit 1 — the timezone / DST offsets are valid.
const HD_TIME_OFFSETS_VALID: u8 = 0x2;

/// Where the ID and HD blocks end, and so where the data-frame `##DT`
/// begins. Both are fixed-size and written before any record.
const DATA_BLOCK_ADDR: u64 = 64 + 104;
/// Bytes of common header on every `##XX` block.
const BLOCK_HEADER_LEN: u64 = 24;

/// Byte offsets of a bus-logging record's fixed part; the payload field
/// follows at [`PAYLOAD_OFFSET`], sized by the capture's layout.
const MASTER_OFFSET: u32 = 0;
const BUS_CHANNEL_OFFSET: u32 = 8;
const ID_OFFSET: u32 = 10;
const IDE_OFFSET: u32 = 14;
const DLC_OFFSET: u32 = 15;
const DATA_LENGTH_OFFSET: u32 = 16;
const DIR_OFFSET: u32 = 17;
const EDL_OFFSET: u32 = 18;
const BRS_OFFSET: u32 = 19;
const ESI_OFFSET: u32 = 20;
const PAYLOAD_OFFSET: u32 = 21;

/// One record of a signal channel group: master seconds, then the value.
const SIGNAL_RECORD_SIZE: u32 = 16;

/// `ev_type` for a user-placed marker.
///
/// Written as a byte rather than through `mdf4_rs::blocks::EventType`,
/// because the two disagree: the crate numbers `Marker` **2**, and ASAM
/// MDF 4.x assigns 2 to `EV_T_ACQUISITION_INTERRUPT` and puts
/// `EV_T_MARKER` at **6**. asammdf — an independent implementation of the
/// same standard — agrees with the standard (`EVENT_TYPE_MARKER = 6`), so
/// a file written through the crate's enum would tell every conformant
/// reader that a user's note was an interrupted acquisition.
const EV_TYPE_MARKER: u8 = 6;

/// Byte offset of `ev_type` inside a serialized `##EV` block: the 24-byte
/// block header, then the five fixed links this writer emits (it writes
/// no scope or attachment links, so there are no variable ones).
const EV_TYPE_OFFSET: usize = 24 + 5 * 8;

/// Byte offset of `ev_ev_range` — the third of the five fixed links.
const EV_RANGE_LINK_OFFSET: u64 = 24 + 2 * 8;

/// Payload lengths a CAN FD DLC can express, ascending — the index is the
/// DLC once the classic 0..=8 range is past.
const FD_LENGTHS: [usize; 7] = [12, 16, 20, 24, 32, 48, 64];

/// What the record layout has to know before the first frame is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MdfCaptureLayout {
    /// `hd_start_time_ns`: the wall clock every master sample is relative
    /// to. Pass the capture's earliest timestamp — anything earlier works,
    /// anything later loses what comes before it.
    pub start_time_ns: u64,
    /// The longest data-frame payload the capture holds. MDF records are a
    /// fixed layout, so the `CAN_DataFrame.DataBytes` field is sized once
    /// for the whole group; a longer payload later is refused rather than
    /// silently truncated.
    pub max_payload_len: usize,
}

/// What a finished write produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MdfWritten {
    pub frame_count: u64,
    pub event_count: u64,
    pub signal_count: u64,
    pub attachment_count: u64,
    /// On-disk size of the renamed-into-place file.
    pub byte_size: u64,
}

/// Anything that can go wrong driving an [`MdfCaptureWriter`].
#[derive(Debug)]
pub enum MdfWriteError {
    Io(std::io::Error),
    /// A block serializer refused what it was handed.
    Block(mdf4_rs::Error),
    /// A frame's payload is longer than the record layout reserved.
    PayloadOverLayout {
        len: usize,
        field: usize,
    },
}

impl std::fmt::Display for MdfWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "mdf write error: {e}"),
            Self::Block(e) => write!(f, "mdf block serialization error: {e:?}"),
            Self::PayloadOverLayout { len, field } => write!(
                f,
                "a {len}-byte payload does not fit the {field}-byte DataBytes field this \
                 capture's layout reserved"
            ),
        }
    }
}

impl std::error::Error for MdfWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for MdfWriteError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<mdf4_rs::Error> for MdfWriteError {
    fn from(e: mdf4_rs::Error) -> Self {
        Self::Block(e)
    }
}

/// A signal channel group waiting to be written: one series, plus the name
/// of the group it came from.
struct PendingSignal {
    group_name: Option<String>,
    signal: FileSignal,
}

/// Writes a capture to `dest` as a sorted, finalized MDF 4.10 file.
///
/// Frames go out as bus-logging structure groups (`CAN_DataFrame`,
/// `CAN_ErrorFrame`, `CAN_RemoteFrame`, all three always present), signals
/// added with [`Self::add_signal`] as their own channel groups, events as
/// `##EV` blocks and attachments as embedded `##AT` blocks. Timestamps are
/// `f64` seconds against [`MdfCaptureLayout::start_time_ns`], which
/// reproduces the absolute nanoseconds that went in for any capture
/// spanning less than about 26 days (ADR 0024).
///
/// Streams to `<dest>.part` and renames on [`Self::finish`], so a
/// half-written capture never appears at the destination; dropping without
/// finishing removes the temp file.
pub struct MdfCaptureWriter {
    dest: PathBuf,
    temp: PathBuf,
    /// `Option` so `finish` can take it before the rename, and so `Drop`
    /// can tell a finished writer from an abandoned one.
    out: Option<BufWriter<File>>,
    start_time_ns: u64,
    payload_bytes: usize,
    /// Records written into the streamed data-frame `##DT` so far.
    data_records: u64,
    error_records: Vec<u8>,
    remote_records: Vec<u8>,
    signals: Vec<PendingSignal>,
    events: Vec<MdfEvent>,
    attachments: Vec<MdfAttachment>,
}

impl MdfCaptureWriter {
    /// Open a writer for `dest`, fixing the record layout.
    pub fn create<P: AsRef<Path>>(
        dest: P,
        layout: MdfCaptureLayout,
    ) -> Result<Self, MdfWriteError> {
        let dest = dest.as_ref().to_path_buf();
        let temp = temp_path_for(&dest);
        let mut out = BufWriter::new(File::create(&temp)?);

        // ID and HD are fixed-size and come first; HD's links are patched
        // in `finish`, once the blocks they point at have addresses.
        out.write_all(&identification().to_bytes()?)?;
        out.write_all(&HeaderBlock::default().to_bytes()?)?;
        // The data-frame `##DT` header, its length patched in `finish`.
        out.write_all(&block_header("##DT", BLOCK_HEADER_LEN))?;

        Ok(Self {
            dest,
            temp,
            out: Some(out),
            start_time_ns: layout.start_time_ns,
            payload_bytes: layout
                .max_payload_len
                .clamp(cannet_core::CLASSIC_DATA_MAX, cannet_core::FD_DATA_MAX),
            data_records: 0,
            error_records: Vec::new(),
            remote_records: Vec::new(),
            signals: Vec::new(),
            events: Vec::new(),
            attachments: Vec::new(),
        })
    }

    /// Append one frame. Frames are written in call order within their
    /// structure group, so a caller that appends chronologically gets a
    /// chronological file.
    pub fn append_frame(&mut self, frame: &CanFrame) -> Result<(), MdfWriteError> {
        let record = self.encode(frame)?;
        match frame.payload {
            CanFramePayload::Classic(_) | CanFramePayload::Fd { .. } => {
                let out = self.out.as_mut().ok_or_else(finished)?;
                out.write_all(&record)?;
                self.data_records += 1;
            }
            CanFramePayload::Error => self.error_records.extend_from_slice(&record),
            CanFramePayload::Remote { .. } => self.remote_records.extend_from_slice(&record),
        }
        Ok(())
    }

    /// Add a directly recorded signal series, written as its own channel
    /// group named `group_name`.
    ///
    /// One group per signal rather than one per source group: a channel
    /// group is a *shared* sample axis by definition, and two series that
    /// came from one group need not still share one by the time they are
    /// written back out. Splitting them keeps every series verbatim.
    pub fn add_signal(&mut self, group_name: Option<String>, signal: FileSignal) {
        self.signals.push(PendingSignal { group_name, signal });
    }

    /// Add a timeline event, written as an `##EV` marker block.
    pub fn add_event(&mut self, event: MdfEvent) {
        self.events.push(event);
    }

    /// Add a file to embed as an `##AT` attachment.
    pub fn add_attachment(&mut self, attachment: MdfAttachment) {
        self.attachments.push(attachment);
    }

    /// Write everything that is not a data-frame record, patch the links
    /// and lengths that were placeholders, and rename into place.
    pub fn finish(mut self) -> Result<MdfWritten, MdfWriteError> {
        let mut out = self.out.take().ok_or_else(finished)?;
        let record_size = self.record_size();
        let data_length = BLOCK_HEADER_LEN + self.data_records * u64::from(record_size);

        // Blocks start 8-byte aligned; a record stream need not end there.
        let pad =
            usize::try_from((8 - ((DATA_BLOCK_ADDR + data_length) % 8)) % 8).unwrap_or_default();
        out.write_all(&[0u8; 8][..pad])?;
        let trailer_base = DATA_BLOCK_ADDR + data_length + pad as u64;

        let (trailer, header) = self.build_trailer(trailer_base)?;
        out.write_all(&trailer.buf)?;

        // The two placeholders written before any record existed.
        out.seek(SeekFrom::Start(DATA_BLOCK_ADDR + 8))?;
        out.write_all(&data_length.to_le_bytes())?;
        out.seek(SeekFrom::Start(64))?;
        out.write_all(&header.to_bytes()?)?;

        out.flush()?;
        let file = out
            .into_inner()
            .map_err(std::io::IntoInnerError::into_error)?;
        let byte_size = file.metadata()?.len();
        drop(file);
        fs::rename(&self.temp, &self.dest)?;

        Ok(MdfWritten {
            frame_count: self.data_records
                + count_records(&self.error_records, record_size)
                + count_records(&self.remote_records, record_size),
            event_count: self.events.len() as u64,
            signal_count: self.signals.len() as u64,
            attachment_count: self.attachments.len() as u64,
            byte_size,
        })
    }

    /// `cg_data_bytes` of a bus-logging group: the fixed fields plus the
    /// payload field this capture's layout reserved.
    fn record_size(&self) -> u32 {
        PAYLOAD_OFFSET + u32::try_from(self.payload_bytes).unwrap_or(u32::MAX)
    }

    fn encode(&self, frame: &CanFrame) -> Result<Vec<u8>, MdfWriteError> {
        let data = frame.payload.data();
        if data.len() > self.payload_bytes {
            return Err(MdfWriteError::PayloadOverLayout {
                len: data.len(),
                field: self.payload_bytes,
            });
        }
        let mut record = vec![0u8; self.record_size() as usize];
        let mut put = |at: u32, bytes: &[u8]| {
            let at = at as usize;
            record[at..at + bytes.len()].copy_from_slice(bytes);
        };
        put(
            MASTER_OFFSET,
            &seconds_since(self.start_time_ns, frame.timestamp_ns).to_le_bytes(),
        );
        // `BusChannel` is 1-based on disk, as BLF's channel number is.
        put(
            BUS_CHANNEL_OFFSET,
            &(u16::from(frame.channel) + 1).to_le_bytes(),
        );
        put(ID_OFFSET, &frame.id.raw().to_le_bytes());
        put(IDE_OFFSET, &[u8::from(frame.id.is_extended())]);
        let dlc = match frame.payload {
            CanFramePayload::Remote { dlc } => dlc,
            _ => dlc_for(data.len()),
        };
        put(DLC_OFFSET, &[dlc]);
        put(
            DATA_LENGTH_OFFSET,
            &[u8::try_from(data.len()).unwrap_or(u8::MAX)],
        );
        put(DIR_OFFSET, &[u8::from(frame.direction == Direction::Tx)]);
        if let CanFramePayload::Fd { flags, .. } = &frame.payload {
            put(EDL_OFFSET, &[1]);
            put(BRS_OFFSET, &[u8::from(flags.bitrate_switch)]);
            put(ESI_OFFSET, &[u8::from(flags.error_state_indicator)]);
        }
        put(PAYLOAD_OFFSET, data);
        Ok(record)
    }

    /// Lay out every block that follows the streamed record stream, plus
    /// the header block that links to them.
    fn build_trailer(&self, base: u64) -> Result<(Trailer, HeaderBlock), MdfWriteError> {
        let mut t = Trailer::new(base);
        let record_size = self.record_size();

        // Group order decides the group index a re-import sees, and it is
        // the order the reader's own merge breaks timestamp ties by.
        let error_dt = t.data_block(&self.error_records);
        let remote_dt = t.data_block(&self.remote_records);
        let mut groups = vec![
            self.bus_group(&mut t, "CAN_DataFrame", DATA_BLOCK_ADDR, self.data_records)?,
            self.bus_group(
                &mut t,
                "CAN_ErrorFrame",
                error_dt,
                count_records(&self.error_records, record_size),
            )?,
            self.bus_group(
                &mut t,
                "CAN_RemoteFrame",
                remote_dt,
                count_records(&self.remote_records, record_size),
            )?,
        ];
        for pending in &self.signals {
            groups.push(self.signal_group(&mut t, pending)?);
        }

        // Sorted, so one channel group per data group. Built back to
        // front, because each block has to know its successor's address.
        let mut first_dg = 0u64;
        for (cg_addr, dt_addr) in groups.iter().rev() {
            let dg = DataGroupBlock {
                next_dg_addr: first_dg,
                first_cg_addr: *cg_addr,
                data_block_addr: *dt_addr,
                record_id_size: 0,
                ..DataGroupBlock::default()
            };
            first_dg = t.put(&dg.to_bytes()?);
        }

        let first_event = self.write_events(&mut t)?;
        let first_attachment = self.write_attachments(&mut t)?;
        let fh_comment = t.md(FH_COMMENT);
        let fh = FileHistoryBlock {
            comment_addr: fh_comment,
            time_flags: HD_TIME_OFFSETS_VALID,
            ..FileHistoryBlock::new(self.start_time_ns)
        };
        let fh_addr = t.put(&fh.to_bytes()?);

        let header = HeaderBlock {
            first_dg_addr: first_dg,
            file_history_addr: fh_addr,
            first_event_addr: first_event,
            first_attachment_addr: first_attachment,
            start_time_ns: self.start_time_ns,
            time_flags: HD_TIME_OFFSETS_VALID,
            ..HeaderBlock::default()
        };
        Ok((t, header))
    }

    /// One bus-logging channel group: the master, the frame structure, and
    /// the structure's members. Returns `(cg_addr, dt_addr)`.
    fn bus_group(
        &self,
        t: &mut Trailer,
        structure: &str,
        dt_addr: u64,
        cycles: u64,
    ) -> Result<(u64, u64), MdfWriteError> {
        let payload_bits = 8 * u32::try_from(self.payload_bytes).unwrap_or(u32::MAX);
        let members: [(&str, u32, u32, DataType); 10] = [
            (
                "BusChannel",
                BUS_CHANNEL_OFFSET,
                16,
                DataType::UnsignedIntegerLE,
            ),
            ("ID", ID_OFFSET, 32, DataType::UnsignedIntegerLE),
            ("IDE", IDE_OFFSET, 8, DataType::UnsignedIntegerLE),
            ("DLC", DLC_OFFSET, 8, DataType::UnsignedIntegerLE),
            (
                "DataLength",
                DATA_LENGTH_OFFSET,
                8,
                DataType::UnsignedIntegerLE,
            ),
            ("Dir", DIR_OFFSET, 8, DataType::UnsignedIntegerLE),
            ("EDL", EDL_OFFSET, 8, DataType::UnsignedIntegerLE),
            ("BRS", BRS_OFFSET, 8, DataType::UnsignedIntegerLE),
            ("ESI", ESI_OFFSET, 8, DataType::UnsignedIntegerLE),
            (
                "DataBytes",
                PAYLOAD_OFFSET,
                payload_bits,
                DataType::ByteArray,
            ),
        ];
        // Back to front, so each member can link to the one after it.
        let mut first_member = 0u64;
        for (name, offset, bits, data_type) in members.iter().rev() {
            let name_addr = t.tx(&format!("{structure}.{name}"));
            let cn = ChannelBlock {
                next_ch_addr: first_member,
                flags: CN_FLAG_BUS_EVENT,
                ..channel(name_addr, *data_type, *offset, *bits)
            };
            first_member = t.put(&cn.to_bytes()?);
        }

        let struct_name = t.tx(structure);
        let structure_cn = ChannelBlock {
            component_addr: first_member,
            flags: CN_FLAG_BUS_EVENT,
            ..channel(
                struct_name,
                DataType::ByteArray,
                BUS_CHANNEL_OFFSET,
                8 * (PAYLOAD_OFFSET - BUS_CHANNEL_OFFSET) + payload_bits,
            )
        };
        let structure_addr = t.put(&structure_cn.to_bytes()?);
        let first_ch = t.master_channel(structure_addr)?;

        let source = t.can_bus_source()?;
        let acq_name = t.tx("CAN");
        let cg = ChannelGroupBlock {
            first_ch_addr: first_ch,
            acq_name_addr: acq_name,
            acq_source_addr: source,
            cycle_count: cycles,
            flags: CG_FLAGS_PLAIN_BUS_EVENT,
            record_size: self.record_size(),
            ..ChannelGroupBlock::default()
        };
        Ok((t.put(&cg.to_bytes()?), dt_addr))
    }

    /// One directly recorded series as its own channel group: master
    /// seconds at byte 0, the physical value as an `f64` at byte 8.
    ///
    /// The values go out as they came in — already physical — so a
    /// numeric conversion is not written back: a `cc_type` a source file
    /// once applied is provenance, not something to re-apply. A **value
    /// table** is the exception, because it was never applied to the
    /// values in the first place: the series is codes and the table says
    /// what they mean, so a coded signal's channel carries a `cc_type` 7
    /// block holding it. Dropping it would write out half a signal.
    fn signal_group(
        &self,
        t: &mut Trailer,
        pending: &PendingSignal,
    ) -> Result<(u64, u64), MdfWriteError> {
        let signal = &pending.signal;
        let mut records = Vec::with_capacity(signal.values.len() * 16);
        for (ts, value) in signal.timestamps_ns.iter().zip(&signal.values) {
            records.extend_from_slice(&seconds_since(self.start_time_ns, *ts).to_le_bytes());
            records.extend_from_slice(&value.to_le_bytes());
        }
        let dt_addr = t.data_block(&records);

        let name_addr = t.tx(&signal.name);
        let unit_addr = match signal.unit.as_deref().filter(|u| !u.is_empty()) {
            Some(unit) => t.tx(unit),
            None => 0,
        };
        let conversion_addr = t.value_to_text(&signal.value_table)?;
        let value_cn = ChannelBlock {
            unit_addr,
            conversion_addr,
            ..channel(name_addr, DataType::FloatLE, 8, 64)
        };
        let value_addr = t.put(&value_cn.to_bytes()?);
        let first_ch = t.master_channel(value_addr)?;

        let acq_name = match pending.group_name.as_deref() {
            Some(name) => t.tx(name),
            None => 0,
        };
        let cg = ChannelGroupBlock {
            first_ch_addr: first_ch,
            acq_name_addr: acq_name,
            cycle_count: signal.values.len() as u64,
            record_size: SIGNAL_RECORD_SIZE,
            ..ChannelGroupBlock::default()
        };
        Ok((t.put(&cg.to_bytes()?), dt_addr))
    }

    /// The `##EV` chain, back to front. Returns the first block's address.
    fn write_events(&self, t: &mut Trailer) -> Result<u64, MdfWriteError> {
        let mut first = 0u64;
        // Block address of each event by its position in `self.events`,
        // so the range links can be filled in once every address is known.
        let mut addrs = vec![0u64; self.events.len()];
        for (i, event) in self.events.iter().enumerate().rev() {
            let name_addr = t.tx(&event.name);
            let comment_addr = if event.text.is_empty() && event.properties.is_empty() {
                0
            } else {
                t.md(&comment_xml(&event.text, &event.properties))
            };
            let ev = EventBlock {
                cause: EventCause::User,
                name_addr,
                comment_addr,
                next_ev_addr: first,
                range_type: match event.range {
                    None => EventRangeType::Point,
                    Some(MdfEventRange::Begin { .. }) => EventRangeType::RangeBegin,
                    Some(MdfEventRange::End { .. }) => EventRangeType::RangeEnd,
                },
                // Nanoseconds as the base value with a 1e-9 factor, so the
                // stored time is an integer and the physical value is
                // seconds — the same axis the master channels use.
                sync_base_value: i64::try_from(
                    event.timestamp_ns.saturating_sub(self.start_time_ns),
                )
                .unwrap_or(i64::MAX),
                sync_factor: 1e-9,
                ..EventBlock::new(EventType::Marker, EventSyncType::Time, 0.0)
            };
            let mut bytes = ev.to_bytes()?;
            bytes[EV_TYPE_OFFSET] = EV_TYPE_MARKER;
            first = t.put(&bytes);
            addrs[i] = first;
        }
        // A range link is an address, so it can only be written once every
        // block is placed — an end event points back at a begin event
        // written after it.
        for (i, event) in self.events.iter().enumerate() {
            let other = match event.range {
                None => continue,
                Some(MdfEventRange::Begin { end }) => end,
                Some(MdfEventRange::End { begin }) => begin,
            };
            let Some(target) = addrs.get(other).copied() else {
                continue;
            };
            t.patch_u64(addrs[i] + EV_RANGE_LINK_OFFSET, target);
        }
        Ok(first)
    }

    /// The `##AT` chain, back to front. Returns the first block's address.
    fn write_attachments(&self, t: &mut Trailer) -> Result<u64, MdfWriteError> {
        let mut first = 0u64;
        for attachment in self.attachments.iter().rev() {
            let filename_addr = t.tx(&attachment.file_name);
            let mimetype_addr = t.tx(&attachment.mime_type);
            let at = AttachmentBlock {
                filename_addr,
                mimetype_addr,
                next_at_addr: first,
                ..AttachmentBlock::embedded(&attachment.data)
            };
            first = t.put(&at.to_bytes()?);
        }
        Ok(first)
    }
}

impl Drop for MdfCaptureWriter {
    fn drop(&mut self) {
        // Never reached `finish`: the destination must look untouched.
        if let Some(out) = self.out.take() {
            drop(out);
            let _ = fs::remove_file(&self.temp);
        }
    }
}

/// Every block that follows the streamed record stream, laid out into one
/// buffer whose start address is known, so a link can be resolved before a
/// byte of the buffer reaches the file.
struct Trailer {
    base: u64,
    buf: Vec<u8>,
    /// The `time` text block, shared by every group's master channel.
    time_name: u64,
}

impl Trailer {
    fn new(base: u64) -> Self {
        let mut t = Self {
            base,
            buf: Vec::new(),
            time_name: 0,
        };
        t.time_name = t.tx("time");
        t
    }

    /// Append a block, 8-byte aligned, and return its address.
    fn put(&mut self, bytes: &[u8]) -> u64 {
        while !self.buf.len().is_multiple_of(8) {
            self.buf.push(0);
        }
        let addr = self.base + self.buf.len() as u64;
        self.buf.extend_from_slice(bytes);
        addr
    }

    /// Overwrite a `u64` at an absolute address inside a block already
    /// appended. Only for links whose target is not known until later —
    /// the trailer is still in memory, so this is a write, not a seek.
    fn patch_u64(&mut self, addr: u64, value: u64) {
        let at = usize::try_from(addr - self.base).expect("a trailer offset fits a usize");
        self.buf[at..at + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn tx(&mut self, text: &str) -> u64 {
        let bytes = TextBlock::new(text)
            .to_bytes()
            .expect("a ##TX block built from its own text always serializes");
        self.put(&bytes)
    }

    fn md(&mut self, xml: &str) -> u64 {
        let bytes = MetadataBlock::new(xml)
            .to_bytes()
            .expect("a ##MD block built from its own text always serializes");
        self.put(&bytes)
    }

    /// A `##DT` block holding `records`, or `0` for an empty group — an
    /// empty data group links to nothing rather than to a header-only
    /// block.
    fn data_block(&mut self, records: &[u8]) -> u64 {
        if records.is_empty() {
            return 0;
        }
        let mut bytes = block_header("##DT", BLOCK_HEADER_LEN + records.len() as u64);
        bytes.extend_from_slice(records);
        self.put(&bytes)
    }

    /// The group's master channel — `f64` seconds relative to
    /// `hd_start_time_ns` — heading a chain that continues at `next`.
    fn master_channel(&mut self, next: u64) -> Result<u64, MdfWriteError> {
        let cn = ChannelBlock {
            next_ch_addr: next,
            channel_type: CN_TYPE_MASTER,
            sync_type: CN_SYNC_TIME,
            ..channel(self.time_name, DataType::FloatLE, MASTER_OFFSET, 64)
        };
        Ok(self.put(&cn.to_bytes()?))
    }

    /// A `cc_type` 7 (value-to-text) conversion block holding `table`,
    /// or `0` for a channel with no table — a channel whose values need
    /// no conversion links to none.
    ///
    /// The links run one `##TX` per entry followed by a NIL default, the
    /// layout the standard gives `cc_ref` for this type: a code the
    /// table does not name falls through to the default, and a NIL one
    /// leaves it unlabelled rather than mislabelled.
    fn value_to_text(&mut self, table: &[(i64, String)]) -> Result<u64, MdfWriteError> {
        if table.is_empty() {
            return Ok(0);
        }
        // `cc_ref_count` and `cc_val_count` are 16-bit, so the format
        // itself caps the table at 65534 entries plus the default. No
        // enumeration comes near that; a table that somehow did is
        // written short rather than with counts its links contradict.
        let table = &table[..table.len().min(usize::from(u16::MAX) - 1)];
        let mut refs: Vec<u64> = table.iter().map(|(_, label)| self.tx(label)).collect();
        refs.push(0);
        #[allow(clippy::cast_precision_loss)]
        let values: Vec<f64> = table.iter().map(|(code, _)| *code as f64).collect();
        let counts = |n: usize| u16::try_from(n).expect("the table was capped to fit the counts");
        let cc = ConversionBlock {
            conversion_type: ConversionType::ValueToText,
            ref_count: counts(refs.len()),
            value_count: counts(values.len()),
            refs,
            values,
            ..ConversionBlock::identity()
        };
        Ok(self.put(&cc.to_bytes()?))
    }

    fn can_bus_source(&mut self) -> Result<u64, MdfWriteError> {
        let name_addr = self.tx("CAN");
        let path_addr = self.tx("CAN");
        let si = SourceBlock {
            name_addr,
            path_addr,
            source_type: SI_TYPE_BUS,
            bus_type: SI_BUS_CAN,
            ..SourceBlock::default()
        };
        Ok(self.put(&si.to_bytes()?))
    }
}

fn channel(name_addr: u64, data_type: DataType, byte_offset: u32, bit_count: u32) -> ChannelBlock {
    ChannelBlock {
        name_addr,
        data_type,
        byte_offset,
        bit_count,
        ..ChannelBlock::default()
    }
}

fn identification() -> IdentificationBlock {
    IdentificationBlock {
        program_id: "cannet  ".to_owned(),
        ..IdentificationBlock::default()
    }
}

/// A bare block header — for the `##DT` blocks, which `mdf4-rs` parses but
/// does not serialize (they are a header plus opaque record bytes).
fn block_header(id: &str, length: u64) -> Vec<u8> {
    BlockHeader {
        id: id.to_owned(),
        reserved: 0,
        length,
        link_count: 0,
    }
    .to_bytes()
    .expect("a block header always serializes")
}

fn count_records(records: &[u8], record_size: u32) -> u64 {
    records.len() as u64 / u64::from(record_size)
}

/// Master-axis value for `timestamp_ns`: seconds since `start_time_ns`.
#[allow(clippy::cast_precision_loss)]
fn seconds_since(start_time_ns: u64, timestamp_ns: u64) -> f64 {
    timestamp_ns.saturating_sub(start_time_ns) as f64 / 1e9
}

/// The DLC that expresses `len` payload bytes — the classic 0..=8 range
/// verbatim, then the FD lengths. A length between two FD steps takes the
/// next one up, which is the frame a controller would have sent.
fn dlc_for(len: usize) -> u8 {
    if len <= cannet_core::CLASSIC_DATA_MAX {
        return u8::try_from(len).unwrap_or(8);
    }
    let step = FD_LENGTHS.iter().position(|l| *l >= len).unwrap_or(6);
    u8::try_from(9 + step).unwrap_or(15)
}

fn finished() -> MdfWriteError {
    MdfWriteError::Io(std::io::Error::other("writer has already been finished"))
}

/// `<dest>.part`, matching what the BLF writer does.
fn temp_path_for(dest: &Path) -> PathBuf {
    let mut name = dest
        .file_name()
        .map(std::ffi::OsString::from)
        .unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

/// The `##FH` comment every MDF file needs — who wrote it, in the schema
/// the standard defines for that block.
const FH_COMMENT: &str = concat!(
    "<FHcomment><TX>capture written by cannet</TX><tool_id>cannet</tool_id>",
    "<tool_vendor>cannet</tool_vendor><tool_version>",
    env!("CARGO_PKG_VERSION"),
    "</tool_version></FHcomment>"
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classic_lengths_are_their_own_dlc() {
        for len in 0..=8usize {
            assert_eq!(dlc_for(len), u8::try_from(len).expect("fits"));
        }
    }

    #[test]
    fn fd_lengths_take_their_canonical_dlc() {
        for (step, len) in FD_LENGTHS.iter().enumerate() {
            assert_eq!(dlc_for(*len), u8::try_from(9 + step).expect("fits"));
        }
    }

    #[test]
    fn a_length_between_two_fd_steps_rounds_up() {
        assert_eq!(dlc_for(9), 9); // 9..=12 bytes travel as a 12-byte frame
        assert_eq!(dlc_for(33), 14); // 33..=48 as a 48-byte one
    }

    #[test]
    fn the_master_axis_recovers_whole_nanoseconds() {
        let start = 1_709_294_400_123_456_789u64;
        for offset in [0u64, 1, 999_999_999, 60_000_000_003, 3_600_000_000_007] {
            let seconds = seconds_since(start, start + offset);
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let back = (seconds * 1e9).round() as u64;
            assert_eq!(back, offset, "offset {offset} did not survive the f64 axis");
        }
    }
}
