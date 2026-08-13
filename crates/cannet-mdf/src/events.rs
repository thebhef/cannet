//! MDF event (`##EV`) blocks — the file's timeline markers.
//!
//! An `##EV` block is a named point on the measurement timeline, reached
//! from the header block's event chain rather than from any record. That
//! is where a timeline event
//! ([ADR 0035](../../../docs/adr/0035-timeline-event-model.md)) belongs in
//! an MDF file, the way a `GLOBAL_MARKER` is where it belongs in a BLF.
//!
//! Beyond its name, an event carries whatever key/value pairs its `##MD`
//! comment's `common_properties` element holds. That element is the
//! format's own extension point for tool-specific metadata, so a caller
//! with more to say about an event than a name says it there rather than
//! beside the file ([ADR 0010](../../../docs/adr/0010-no-sidecar-files.md)).
//! Properties written by other tools read back untouched.

use mdf4_rs::blocks::{BlockParse, EventBlock, EventSyncType, MetadataBlock};

use crate::file::Mdf4File;
use crate::MdfSourceError;

/// One timeline marker, its time already absolute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdfEvent {
    /// Absolute ns since the UNIX epoch (ADR 0024), the file's
    /// `hd_start_time_ns` already added.
    pub timestamp_ns: u64,
    /// `ev_tx_name` — what the marker is called.
    pub name: String,
    /// The `common_properties` of the event's `##MD` comment, in file
    /// order. Empty when the event has no comment or no properties.
    pub properties: Vec<(String, String)>,
}

impl MdfEvent {
    /// The value of `key`, if this event carries it.
    pub fn property(&self, key: &str) -> Option<&str> {
        self.properties
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

/// Read the file's `##EV` chain, in link order.
///
/// Only time-synchronised events are reported: an event synchronised to an
/// angle, a distance or a record index has no place on the capture's
/// timeline, and putting one there would invent a timestamp for it.
pub(crate) fn read_events(file: &Mdf4File) -> Result<Vec<MdfEvent>, MdfSourceError> {
    let mut out = Vec::new();
    let mut addr = file.first_event_addr;
    let mut seen = Vec::new();
    while addr != 0 {
        if seen.contains(&addr) {
            return Err(MdfSourceError::Malformed(format!(
                "event link chain cycles at {addr:#x}"
            )));
        }
        seen.push(addr);
        let ev = EventBlock::from_bytes(file.slice_at(addr)?)?;
        let next = ev.next_ev_addr;
        if ev.sync_type == EventSyncType::Time {
            out.push(MdfEvent {
                timestamp_ns: absolute_ns(file.start_time_ns, ev.sync_value()),
                name: file.text_at(ev.name_addr)?.unwrap_or_default(),
                properties: read_properties(file, ev.comment_addr)?,
            });
        }
        addr = next;
    }
    Ok(out)
}

fn read_properties(file: &Mdf4File, addr: u64) -> Result<Vec<(String, String)>, MdfSourceError> {
    if addr == 0 || !file.is_block(addr, *b"##MD") {
        return Ok(Vec::new());
    }
    let md = MetadataBlock::from_bytes(file.slice_at(addr)?)?;
    Ok(parse_properties(&md.xml))
}

/// Event seconds → absolute nanoseconds, per ADR 0024. Mirrors what the
/// bus and signal readers do with a master sample.
fn absolute_ns(start_time_ns: u64, seconds: f64) -> u64 {
    let offset = (seconds * 1e9).round();
    if offset < 0.0 {
        return start_time_ns;
    }
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    start_time_ns.saturating_add(offset as u64)
}

/// The `##MD` comment an event with `properties` gets.
pub(crate) fn comment_xml(properties: &[(String, String)]) -> String {
    let mut xml = String::from("<EVcomment><common_properties>");
    for (key, value) in properties {
        xml.push_str("<e name=\"");
        escape_into(&mut xml, key);
        xml.push_str("\">");
        escape_into(&mut xml, value);
        xml.push_str("</e>");
    }
    xml.push_str("</common_properties></EVcomment>");
    xml
}

/// Pull `<e name="…">…</e>` pairs out of an event comment.
///
/// A scan rather than a parse: the one element shape this needs is
/// unambiguous, and an MDF comment is a fixed schema, not arbitrary
/// markup. Anything that does not match is left alone, so a comment from
/// another tool costs nothing and breaks nothing.
fn parse_properties(xml: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<e name=\"") {
        rest = &rest[start + 9..];
        let Some(quote) = rest.find('"') else { break };
        let key = unescape(&rest[..quote]);
        rest = &rest[quote + 1..];
        let Some(close) = rest.find('>') else { break };
        rest = &rest[close + 1..];
        let Some(end) = rest.find("</e>") else { break };
        out.push((key, unescape(&rest[..end])));
        rest = &rest[end + 4..];
    }
    out
}

fn escape_into(out: &mut String, text: &str) {
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn properties_survive_the_comment_they_are_written_into() {
        let properties = vec![
            ("cannet.id".to_owned(), "b7f0-1".to_owned()),
            ("cannet.color".to_owned(), "#FF8800".to_owned()),
        ];
        assert_eq!(parse_properties(&comment_xml(&properties)), properties);
    }

    #[test]
    fn markup_in_a_value_survives_escaping() {
        let properties = vec![("note".to_owned(), "a & b < c > d \" e ' f".to_owned())];
        let xml = comment_xml(&properties);
        assert!(!xml.contains("a & b"), "the raw ampersand must be escaped");
        assert_eq!(parse_properties(&xml), properties);
    }

    #[test]
    fn a_comment_without_properties_yields_none() {
        assert!(parse_properties("<EVcomment><TX>just a note</TX></EVcomment>").is_empty());
        assert!(parse_properties("").is_empty());
    }
}
