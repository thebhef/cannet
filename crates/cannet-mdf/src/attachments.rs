//! Attachment (`##AT`) blocks — files carried inside the capture.
//!
//! MDF 4.10 onwards, embedding the database a capture was recorded
//! against is standard practice: the `##AT` block holds the file's bytes,
//! its name and its MIME type, and every reader of the format sees them.
//! That is the in-file mechanism
//! [ADR 0010](../../../docs/adr/0010-no-sidecar-files.md) asks a format to
//! provide, so a project's DBCs travel with the capture rather than beside
//! it.

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

/// Read the file's `##AT` chain, in link order.
///
/// External attachments — the ones that name a file on disk instead of
/// carrying it — come back with empty `data`: there is nothing in the
/// capture to read, and chasing the reference would be the sidecar this
/// project does not do.
pub(crate) fn read_attachments(file: &Mdf4File) -> Result<Vec<MdfAttachment>, MdfSourceError> {
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
        out.push(MdfAttachment {
            file_name: file.text_at(at.filename_addr)?.unwrap_or_default(),
            mime_type: file.text_at(at.mimetype_addr)?.unwrap_or_default(),
            data: at.decompress()?.unwrap_or_default(),
        });
        addr = next;
    }
    Ok(out)
}
