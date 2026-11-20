//! Attachment (`##AT`) blocks — files carried inside the capture.
//!
//! MDF 4.10 onwards, embedding the database a capture was recorded
//! against is standard practice: the `##AT` block holds the file's bytes,
//! its name and its MIME type, and every reader of the format sees them.
//! That is the in-file mechanism
//! [ADR 0010](../../../docs/adr/0010-no-sidecar-files.md) asks a format to
//! provide, so a project's DBCs travel with the capture rather than beside
//! it.
//!
//! ## Which bus channels a database is for
//!
//! A capture holds frames from several bus channels and may hold several
//! databases. It says which goes with which the way python-can writes it
//! and asammdf reads it: the `CAN_DataFrame` channel of a frame group
//! links the attachment through `cn_at_reference`, and the database
//! decodes that group's frames. The standard provides the link — a
//! channel may refer to a number of attachments — and those tools give
//! it this meaning.
//!
//! The link names a channel *group*, not bus channels, so what it says
//! about channels is a fact about the frames: the bus channels that
//! group's frames were recorded on. That takes a walk of the records, so
//! it is the census ([`crate::scan_mdf`]) that reports it, as
//! [`AttachmentCensus::bus_channels`]. A capture whose frame channels
//! link nothing says nothing.

use mdf4_rs::blocks::{AttachmentBlock, BlockParse};

use crate::file::Mdf4File;
use crate::MdfSourceError;

/// One file embedded in a capture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdfAttachment {
    /// `at_tx_filename` — the name the file had, not a path to read.
    pub file_name: String,
    /// `at_tx_mimetype`, e.g. `application/vnd.vector.dbc`.
    pub mime_type: String,
    /// The file's bytes.
    pub data: Vec<u8>,
}

/// One attachment as the census sees it: what it is, and which bus
/// channels the capture says it is for — without its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentCensus {
    /// See [`MdfAttachment::file_name`].
    pub file_name: String,
    /// See [`MdfAttachment::mime_type`].
    pub mime_type: String,
    /// Whether the capture carries the file's bytes. An external
    /// attachment names a file on disk instead, and has none to read.
    pub embedded: bool,
    /// The bus channels of every frame group whose `CAN_DataFrame`
    /// channel links this attachment — 0-based and ascending, as
    /// [`cannet_core::CanFrame::channel`] is. Empty when no frame
    /// channel links it, or the groups that do hold no frames.
    pub bus_channels: Vec<u8>,
}

/// One `##AT` block, short of its bytes.
pub(crate) struct AttachmentEntry {
    pub(crate) addr: u64,
    pub(crate) file_name: String,
    pub(crate) mime_type: String,
    pub(crate) embedded: bool,
}

/// Walk the file's `##AT` chain, in link order, calling `visit` with
/// each block.
fn walk<T>(
    file: &Mdf4File,
    mut visit: impl FnMut(u64, &AttachmentBlock<'_>) -> Result<T, MdfSourceError>,
) -> Result<Vec<T>, MdfSourceError> {
    let mut out = Vec::new();
    let mut addr = file.first_attachment_addr;
    let mut seen = Vec::new();
    while addr != 0 {
        if seen.contains(&addr) {
            return Err(MdfSourceError::Malformed(format!(
                "attachment link chain cycles at {addr:#x}"
            )));
        }
        seen.push(addr);
        let at = AttachmentBlock::from_bytes(file.slice_at(addr)?)?;
        let next = at.next_at_addr;
        out.push(visit(addr, &at)?);
        addr = next;
    }
    Ok(out)
}

/// The file's `##AT` chain without the files' bytes.
pub(crate) fn attachment_entries(file: &Mdf4File) -> Result<Vec<AttachmentEntry>, MdfSourceError> {
    walk(file, |addr, at| {
        Ok(AttachmentEntry {
            addr,
            file_name: file.text_at(at.filename_addr)?.unwrap_or_default(),
            mime_type: file.text_at(at.mimetype_addr)?.unwrap_or_default(),
            embedded: at.flags.is_embedded(),
        })
    })
}

/// Read the file's `##AT` chain, in link order.
///
/// External attachments — the ones that name a file on disk instead of
/// carrying it — come back with empty `data`: there is nothing in the
/// capture to read, and chasing the reference would be the sidecar this
/// project does not do.
pub(crate) fn read_attachments(file: &Mdf4File) -> Result<Vec<MdfAttachment>, MdfSourceError> {
    walk(file, |_, at| {
        Ok(MdfAttachment {
            file_name: file.text_at(at.filename_addr)?.unwrap_or_default(),
            mime_type: file.text_at(at.mimetype_addr)?.unwrap_or_default(),
            data: at.decompress()?.unwrap_or_default(),
        })
    })
}
