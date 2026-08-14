//! The MDF 4.x block graph, walked once at open into an owned tree.
//!
//! ## Why the walk is ours
//!
//! `mdf4-rs` ships a high-level reader (`MDF` → `ChannelGroup` →
//! `Channel`), but every handle in it borrows a file struct the crate
//! only constructs privately from a path. A [`cannet_core::CanFrameSource`]
//! has to hold its position between `next_frame` calls, which with those
//! handles means a self-referential struct — and the same privacy makes
//! the DZ-decompressing data-block resolver unreachable from a borrowed
//! handle, which is why a compressed logger file does not read through
//! that API at all.
//!
//! Owning the walk answers both at once. This module holds the file
//! bytes, follows the `HD → DG → CG → CN` links itself, and hands out
//! records as `(chunk, offset)` indices, so a cursor is plain integers
//! and DZ decompression is just another chunk. What stays with
//! `mdf4-rs` is the part worth borrowing: every block parser, the
//! bit-level value decoder, the CC conversion machinery, and the DZ
//! inflate (with its inverse transposition).

use std::collections::BTreeMap;
use std::ops::Range;
use std::path::Path;

use mdf4_rs::blocks::{
    BlockHeader, BlockParse, ChannelBlock, ChannelGroupBlock, DataGroupBlock, DataListBlock,
    DzBlock, HeaderBlock, IdentificationBlock, SourceBlock, TextBlock,
};

use crate::MdfSourceError;

/// `cg_flags` bit 0 — the group stores variable-length signal data
/// rather than fixed-size records.
const CG_FLAG_VLSD: u16 = 0x1;
/// `cg_flags` bit 2 — those bus events are *plain* bus events: raw
/// frames rather than signals decoded out of them.
pub(crate) const CG_FLAG_PLAIN_BUS_EVENT: u16 = 0x4;

/// `cn_type` 2 — the group's master (time) channel.
pub(crate) const CN_TYPE_MASTER: u8 = 2;
/// `cn_type` 1 — variable-length signal data, stored in an `##SD` chain
/// the record only references.
pub(crate) const CN_TYPE_VLSD: u8 = 1;

/// One channel, with whatever `cn_composition` hangs off it.
#[derive(Debug, Clone)]
pub(crate) struct Channel {
    pub(crate) block: ChannelBlock,
    pub(crate) name: String,
    pub(crate) unit: Option<String>,
    /// Sub-channels reached through `cn_composition`. In a bus-logging
    /// group these are the `CAN_DataFrame.ID` / `.DLC` / `.DataBytes`
    /// fields, which **overlay** the parent's byte range rather than
    /// adding to it.
    pub(crate) components: Vec<Channel>,
}

/// `si_type` 2 — the source is a bus.
pub(crate) const SI_TYPE_BUS: u8 = 2;
/// `si_bus_type` 2 — that bus is CAN.
pub(crate) const SI_BUS_CAN: u8 = 2;

/// An `##SI` source, as far as classification cares about it.
#[derive(Debug, Clone)]
pub(crate) struct Source {
    pub(crate) path: Option<String>,
    pub(crate) si_type: u8,
    pub(crate) si_bus_type: u8,
}

impl Source {
    pub(crate) fn is_can_bus(&self) -> bool {
        self.si_type == SI_TYPE_BUS && self.si_bus_type == SI_BUS_CAN
    }
}

/// One channel group, flattened out of its data group.
#[derive(Debug, Clone)]
pub(crate) struct Group {
    /// Index into [`Mdf4File::data_groups`].
    pub(crate) data_group_index: usize,
    pub(crate) record_id: u64,
    pub(crate) flags: u16,
    pub(crate) acq_name: Option<String>,
    pub(crate) source: Option<Source>,
    pub(crate) channels: Vec<Channel>,
}

impl Group {
    /// The group's master (time) channel, if it declares one.
    pub(crate) fn master(&self) -> Option<&Channel> {
        self.channels
            .iter()
            .find(|c| c.block.channel_type == CN_TYPE_MASTER)
    }
}

/// A stretch of record bytes: either a range of the file (`##DT` /
/// `##DV`) or a buffer we inflated out of a `##DZ`.
#[derive(Debug, Clone)]
enum Chunk {
    Range(Range<usize>),
    Owned(Vec<u8>),
}

/// The record shape of one channel group within its data group.
#[derive(Debug, Clone, Copy)]
struct RecordShape {
    /// `cg_data_bytes` — where the invalidation bits start.
    data: usize,
    /// `cg_data_bytes + cg_inval_bytes`, excluding the record-ID prefix.
    body: usize,
    vlsd: bool,
}

#[derive(Debug, Clone)]
struct DataGroup {
    record_id_size: usize,
    /// Record ID → shape. A sorted data group has one entry keyed 0.
    shapes: BTreeMap<u64, RecordShape>,
    chunks: Vec<Chunk>,
}

/// An MDF 4.x file: the bytes, plus the block graph walked out of them.
#[derive(Debug)]
pub(crate) struct Mdf4File {
    bytes: Vec<u8>,
    /// `hd_start_time_ns` — the wall clock every master sample is
    /// relative to.
    pub(crate) start_time_ns: u64,
    pub(crate) unfinalized: bool,
    /// `hd_ev_first` — head of the file's event (`##EV`) chain, `0` when it
    /// carries none.
    pub(crate) first_event_addr: u64,
    /// `hd_at_first` — head of the file's attachment (`##AT`) chain.
    pub(crate) first_attachment_addr: u64,
    pub(crate) groups: Vec<Group>,
    data_groups: Vec<DataGroup>,
}

/// A position in one channel group's record stream.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RecordCursor {
    group: usize,
    chunk: usize,
    pos: usize,
}

impl Mdf4File {
    pub(crate) fn open(path: &Path) -> Result<Self, MdfSourceError> {
        let bytes = std::fs::read(path)?;
        Self::parse(bytes)
    }

    fn parse(bytes: Vec<u8>) -> Result<Self, MdfSourceError> {
        if bytes.len() < 64 + 104 {
            return Err(MdfSourceError::Malformed(format!(
                "file is {} bytes, too short for an ID block plus an HD block",
                bytes.len()
            )));
        }
        let identification = IdentificationBlock::from_bytes(&bytes[0..64])?;
        let header = HeaderBlock::from_bytes(&bytes[64..64 + 104])?;
        // `id_file` is "UnFinMF " while a writer still has the file open;
        // the flags at file offset 60 say which fields it left stale.
        let unfinalized = identification.file_id.trim_end() == "UnFinMF";

        let mut groups = Vec::new();
        let mut data_groups = Vec::new();
        let mut dg_addr = header.first_dg_addr;
        let mut seen = Vec::new();
        while dg_addr != 0 {
            if seen.contains(&dg_addr) {
                return Err(MdfSourceError::Malformed(format!(
                    "data group link chain cycles at {dg_addr:#x}"
                )));
            }
            seen.push(dg_addr);
            let dg = DataGroupBlock::from_bytes(slice_at(&bytes, dg_addr)?)?;
            let next = dg.next_dg_addr;
            let record_id_size = dg.record_id_size as usize;
            let data_group_index = data_groups.len();

            let mut shapes = BTreeMap::new();
            let mut cg_addr = dg.first_cg_addr;
            let mut seen_cg = Vec::new();
            while cg_addr != 0 {
                if seen_cg.contains(&cg_addr) {
                    return Err(MdfSourceError::Malformed(format!(
                        "channel group link chain cycles at {cg_addr:#x}"
                    )));
                }
                seen_cg.push(cg_addr);
                let cg = ChannelGroupBlock::from_bytes(slice_at(&bytes, cg_addr)?)?;
                let next_cg = cg.next_cg_addr;
                shapes.insert(
                    cg.record_id,
                    RecordShape {
                        data: cg.record_size as usize,
                        body: cg.record_size as usize + cg.invalidation_size as usize,
                        vlsd: cg.flags & CG_FLAG_VLSD != 0,
                    },
                );
                groups.push(Group {
                    data_group_index,
                    record_id: cg.record_id,
                    flags: cg.flags,
                    acq_name: read_text(&bytes, cg.acq_name_addr)?,
                    source: read_source(&bytes, cg.acq_source_addr)?,
                    channels: read_channel_chain(&bytes, cg.first_ch_addr)?,
                });
                cg_addr = next_cg;
            }

            data_groups.push(DataGroup {
                record_id_size,
                chunks: resolve_chunks(&bytes, dg.data_block_addr, unfinalized)?,
                shapes,
            });
            dg_addr = next;
        }

        Ok(Self {
            bytes,
            start_time_ns: header.start_time_ns,
            unfinalized,
            first_event_addr: header.first_event_addr,
            first_attachment_addr: header.first_attachment_addr,
            groups,
            data_groups,
        })
    }

    /// The file from `addr` on, for a block parser to read its header and
    /// body out of.
    pub(crate) fn slice_at(&self, addr: u64) -> Result<&[u8], MdfSourceError> {
        slice_at(&self.bytes, addr)
    }

    /// Whether the block at `addr` carries the four-byte id `id`.
    pub(crate) fn is_block(&self, addr: u64, id: [u8; 4]) -> bool {
        is_block(&self.bytes, addr, id)
    }

    /// The text of the `##TX` block at `addr`, or `None` for a null link
    /// or a block of another kind.
    pub(crate) fn text_at(&self, addr: u64) -> Result<Option<String>, MdfSourceError> {
        read_text(&self.bytes, addr)
    }

    /// The whole file, for the `mdf4-rs` decoders that resolve links
    /// (conversions) while decoding a value.
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Bytes reserved at the front of every record of `group` for its
    /// record ID — what `mdf4-rs`'s decoders call `record_id_size`.
    pub(crate) fn record_id_size(&self, group: usize) -> usize {
        self.data_groups[self.groups[group].data_group_index].record_id_size
    }

    /// `cg_data_bytes` for `group`, the invalidation bytes excluded —
    /// what the decoder needs to find the invalidation bits.
    pub(crate) fn record_data_bytes(&self, group: usize) -> u32 {
        let g = &self.groups[group];
        let shape = self.data_groups[g.data_group_index].shapes[&g.record_id];
        u32::try_from(shape.data).unwrap_or(u32::MAX)
    }

    pub(crate) fn cursor(group: usize) -> RecordCursor {
        RecordCursor {
            group,
            chunk: 0,
            pos: 0,
        }
    }

    /// The next record belonging to the cursor's channel group, record-ID
    /// prefix included, or `None` at the end of the group's records.
    ///
    /// In an unsorted data group the records of several channel groups
    /// interleave in one block, each tagged with its `cg_record_id`;
    /// records of other groups are stepped over here.
    pub(crate) fn next_record(&self, cursor: &mut RecordCursor) -> Option<&[u8]> {
        let group = &self.groups[cursor.group];
        let dg = &self.data_groups[group.data_group_index];
        loop {
            let chunk = dg.chunks.get(cursor.chunk)?;
            let buf = match chunk {
                Chunk::Range(r) => &self.bytes[r.clone()],
                Chunk::Owned(v) => v.as_slice(),
            };
            match next_in_chunk(buf, cursor.pos, dg, group.record_id) {
                Step::Yield { record, next } => {
                    cursor.pos = next;
                    return Some(record);
                }
                Step::Skip { next } => cursor.pos = next,
                Step::EndOfChunk => {
                    cursor.chunk += 1;
                    cursor.pos = 0;
                }
            }
        }
    }
}

enum Step<'a> {
    Yield { record: &'a [u8], next: usize },
    Skip { next: usize },
    EndOfChunk,
}

fn next_in_chunk<'a>(buf: &'a [u8], pos: usize, dg: &DataGroup, want: u64) -> Step<'a> {
    if dg.record_id_size == 0 {
        // Sorted: one channel group owns every record in the block.
        let Some(shape) = dg.shapes.values().next() else {
            return Step::EndOfChunk;
        };
        let end = pos + shape.body;
        if shape.body == 0 || end > buf.len() {
            return Step::EndOfChunk;
        }
        return Step::Yield {
            record: &buf[pos..end],
            next: end,
        };
    }

    let Some(id) = read_record_id(buf, pos, dg.record_id_size) else {
        return Step::EndOfChunk;
    };
    let Some(shape) = dg.shapes.get(&id) else {
        // An ID no channel group claims means the block does not describe
        // itself; resyncing by guesswork would invent frames, so stop.
        return Step::EndOfChunk;
    };
    let body = if shape.vlsd {
        let len_at = pos + dg.record_id_size;
        let Some(raw) = buf.get(len_at..len_at + 4) else {
            return Step::EndOfChunk;
        };
        4 + u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize
    } else {
        shape.body
    };
    let end = pos + dg.record_id_size + body;
    if end > buf.len() {
        return Step::EndOfChunk;
    }
    if id == want && !shape.vlsd {
        Step::Yield {
            record: &buf[pos..end],
            next: end,
        }
    } else {
        Step::Skip { next: end }
    }
}

fn read_record_id(buf: &[u8], pos: usize, size: usize) -> Option<u64> {
    let raw = buf.get(pos..pos + size)?;
    let mut id = 0u64;
    for (i, b) in raw.iter().enumerate().take(8) {
        id |= u64::from(*b) << (8 * i);
    }
    Some(id)
}

/// Follow a data group's `dg_data` link into the record bytes it leads to,
/// through any `##DL` list, `##HL` header and `##DZ` compression on the way.
fn resolve_chunks(
    bytes: &[u8],
    first_addr: u64,
    unfinalized: bool,
) -> Result<Vec<Chunk>, MdfSourceError> {
    let mut chunks = Vec::new();
    let mut addr = first_addr;
    let mut seen = Vec::new();
    while addr != 0 {
        if seen.contains(&addr) {
            return Err(MdfSourceError::Malformed(format!(
                "data block link chain cycles at {addr:#x}"
            )));
        }
        seen.push(addr);
        let start = usize_addr(addr)?;
        let header = BlockHeader::from_bytes(bounded(bytes, start, 24)?)?;
        match header.id.as_str() {
            "##DT" | "##DV" => {
                chunks.push(data_chunk(bytes, start, &header, unfinalized));
                addr = 0;
            }
            "##DZ" => {
                chunks.push(inflate(bytes, start)?);
                addr = 0;
            }
            "##DL" => {
                let list = DataListBlock::from_bytes(slice_at(bytes, addr)?)?;
                for fragment in &list.data_block_addrs {
                    if *fragment == 0 {
                        continue;
                    }
                    let at = skip_hl(bytes, *fragment)?;
                    let offset = usize_addr(at)?;
                    let head = BlockHeader::from_bytes(bounded(bytes, offset, 24)?)?;
                    match head.id.as_str() {
                        "##DT" | "##DV" => {
                            chunks.push(data_chunk(bytes, offset, &head, unfinalized));
                        }
                        "##DZ" => chunks.push(inflate(bytes, offset)?),
                        other => {
                            return Err(MdfSourceError::Malformed(format!(
                                "data list fragment at {at:#x} is {other}, not ##DT / ##DV / ##DZ"
                            )))
                        }
                    }
                }
                addr = list.next_dl_addr;
            }
            "##HL" => addr = hl_first_dl(bytes, start)?,
            other => {
                return Err(MdfSourceError::Malformed(format!(
                    "data block at {addr:#x} is {other}, not ##DT / ##DV / ##DZ / ##DL / ##HL"
                )))
            }
        }
    }
    Ok(chunks)
}

fn data_chunk(bytes: &[u8], start: usize, header: &BlockHeader, unfinalized: bool) -> Chunk {
    // An unfinalized writer may not have patched the last block's length;
    // the standard says to take the records as running to end of file.
    let data_start = start.saturating_add(24);
    let end = if unfinalized && header.length == 24 {
        bytes.len()
    } else {
        let len = usize::try_from(header.length).unwrap_or(usize::MAX);
        start.saturating_add(len)
    };
    Chunk::Range(data_start..end.clamp(data_start, bytes.len()))
}

fn inflate(bytes: &[u8], start: usize) -> Result<Chunk, MdfSourceError> {
    let dz = DzBlock::from_bytes(&bytes[start..])?;
    Ok(Chunk::Owned(dz.decompress()?))
}

/// `##HL` wraps a `##DL` chain; its single link is the first list block.
fn hl_first_dl(bytes: &[u8], start: usize) -> Result<u64, MdfSourceError> {
    let raw = bounded(bytes, start + 24, 8)?;
    Ok(u64::from_le_bytes(raw.try_into().expect("8 bytes")))
}

fn skip_hl(bytes: &[u8], addr: u64) -> Result<u64, MdfSourceError> {
    let start = usize_addr(addr)?;
    let header = BlockHeader::from_bytes(bounded(bytes, start, 24)?)?;
    if header.id == "##HL" {
        hl_first_dl(bytes, start)
    } else {
        Ok(addr)
    }
}

fn read_channel_chain(bytes: &[u8], first: u64) -> Result<Vec<Channel>, MdfSourceError> {
    let mut out = Vec::new();
    let mut addr = first;
    let mut seen = Vec::new();
    while addr != 0 {
        if seen.contains(&addr) {
            return Err(MdfSourceError::Malformed(format!(
                "channel link chain cycles at {addr:#x}"
            )));
        }
        seen.push(addr);
        let mut block = ChannelBlock::from_bytes(slice_at(bytes, addr)?)?;
        block.resolve_name(bytes)?;
        block.resolve_conversion(bytes)?;
        let next = block.next_ch_addr;
        // `cn_composition` reaches either a channel chain (a structure,
        // which is how bus logging stores a frame) or a `##CA` array
        // block, which describes the parent's own layout instead.
        let components =
            if block.component_addr != 0 && is_block(bytes, block.component_addr, *b"##CN") {
                read_channel_chain(bytes, block.component_addr)?
            } else {
                Vec::new()
            };
        out.push(Channel {
            name: block.name.clone().unwrap_or_default(),
            unit: read_text(bytes, block.unit_addr)?,
            block,
            components,
        });
        addr = next;
    }
    Ok(out)
}

fn is_block(bytes: &[u8], addr: u64, id: [u8; 4]) -> bool {
    usize_addr(addr)
        .ok()
        .and_then(|start| bytes.get(start..start + 4))
        .is_some_and(|head| head == id)
}

fn read_text(bytes: &[u8], addr: u64) -> Result<Option<String>, MdfSourceError> {
    if addr == 0 || !is_block(bytes, addr, *b"##TX") {
        return Ok(None);
    }
    Ok(Some(TextBlock::from_bytes(slice_at(bytes, addr)?)?.text))
}

fn read_source(bytes: &[u8], addr: u64) -> Result<Option<Source>, MdfSourceError> {
    if addr == 0 || !is_block(bytes, addr, *b"##SI") {
        return Ok(None);
    }
    let block = SourceBlock::from_bytes(slice_at(bytes, addr)?)?;
    Ok(Some(Source {
        path: read_text(bytes, block.path_addr)?,
        si_type: block.source_type,
        si_bus_type: block.bus_type,
    }))
}

fn usize_addr(addr: u64) -> Result<usize, MdfSourceError> {
    usize::try_from(addr).map_err(|_| {
        MdfSourceError::Malformed(format!(
            "block address {addr:#x} does not fit this platform"
        ))
    })
}

fn slice_at(bytes: &[u8], addr: u64) -> Result<&[u8], MdfSourceError> {
    let start = usize_addr(addr)?;
    bytes.get(start..).ok_or_else(|| {
        MdfSourceError::Malformed(format!(
            "block address {addr:#x} is past the end of the file"
        ))
    })
}

fn bounded(bytes: &[u8], start: usize, len: usize) -> Result<&[u8], MdfSourceError> {
    bytes.get(start..start + len).ok_or_else(|| {
        MdfSourceError::Malformed(format!("block at {start:#x} runs past the end of the file"))
    })
}
