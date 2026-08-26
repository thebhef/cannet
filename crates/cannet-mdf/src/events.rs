//! MDF event (`##EV`) blocks — the file's timeline markers.
//!
//! An `##EV` block is a named point on the measurement timeline, reached
//! from the header block's event chain rather than from any record. That
//! is where a timeline event
//! ([ADR 0035](../../../docs/adr/0035-timeline-event-model.md)) belongs in
//! an MDF file, the way a `GLOBAL_MARKER` is where it belongs in a BLF.
//!
//! Beyond its name, an event carries an `##MD` comment with two halves the
//! format defines for it: a `<TX>` element of free text, and a
//! `common_properties` element of key/value pairs. Both are the format's
//! own extension points, so a caller with more to say about an event than
//! a name says it there rather than beside the file
//! ([ADR 0010](../../../docs/adr/0010-no-sidecar-files.md)). Text and
//! properties written by other tools read back untouched.
//!
//! An `##EV` block also has *typed* fields our timeline events have no
//! equivalent of — a begin/end range pair being the one that matters here.
//! [`MdfEventRange`] exposes it, and
//! [ADR 0056](../../../docs/adr/0056-an-event-subject-is-a-structural-reference.md)
//! fixes what it may be used for: interop, never storage.

use mdf4_rs::blocks::{BlockParse, EventBlock, EventRangeType, EventSyncType, MetadataBlock};

use crate::file::Mdf4File;
use crate::MdfSourceError;

/// One timeline marker, its time already absolute.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MdfEvent {
    /// Absolute ns since the UNIX epoch (ADR 0024), the file's
    /// `hd_start_time_ns` already added.
    pub timestamp_ns: u64,
    /// `ev_tx_name` — what the marker is called.
    pub name: String,
    /// The `<TX>` element of the event's `##MD` comment: free text about
    /// the event, in the slot the format reserves for exactly that. Empty
    /// when the event has no comment or no text in it.
    pub text: String,
    /// The `common_properties` of the event's `##MD` comment, in file
    /// order. Empty when the event has no comment or no properties.
    pub properties: Vec<(String, String)>,
    /// The event's half of a native begin/end range pair, if it is in one.
    pub range: Option<MdfEventRange>,
}

/// An `##EV` block's range pairing — MDF's own, **typed** span.
///
/// A cannet event has no span field and never will: span-ness is a
/// relationship between two events, not a property of either
/// ([ADR 0056](../../../docs/adr/0056-an-event-subject-is-a-structural-reference.md)).
/// So this is an interop courtesy in both directions — written where a
/// link happens to join exactly two events, read back as one more untyped
/// link — and never the storage form.
///
/// The index is a position in the same list: the order events were added
/// to the writer, and the order `read_events` returns them in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MdfEventRange {
    /// This event begins a range that the event at this index ends.
    Begin { end: usize },
    /// This event ends the range that the event at this index begins.
    End { begin: usize },
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
    // Block address of each reported event, so a range link — which is a
    // file address — can be resolved to the position of the event it names.
    let mut addrs: Vec<u64> = Vec::new();
    let mut ranges: Vec<(EventRangeType, u64)> = Vec::new();
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
            let comment = read_comment(file, ev.comment_addr)?;
            out.push(MdfEvent {
                timestamp_ns: absolute_ns(file.start_time_ns, ev.sync_value()),
                name: file.text_at(ev.name_addr)?.unwrap_or_default(),
                text: comment.0,
                properties: comment.1,
                range: None,
            });
            addrs.push(addr);
            ranges.push((ev.range_type, ev.range_ev_addr));
        }
        addr = next;
    }
    // Second pass, once every reported event's address is known: a range
    // link naming an event this walk skipped (one synchronised to
    // something other than time) resolves to nothing and is dropped.
    for (i, (range_type, target)) in ranges.into_iter().enumerate() {
        let Some(other) = addrs.iter().position(|a| *a == target) else {
            continue;
        };
        out[i].range = match range_type {
            EventRangeType::RangeBegin => Some(MdfEventRange::Begin { end: other }),
            EventRangeType::RangeEnd => Some(MdfEventRange::End { begin: other }),
            EventRangeType::Point => None,
        };
    }
    Ok(out)
}

/// The `<TX>` text and the `common_properties` of an event's `##MD`
/// comment.
fn read_comment(
    file: &Mdf4File,
    addr: u64,
) -> Result<(String, Vec<(String, String)>), MdfSourceError> {
    if addr == 0 || !file.is_block(addr, *b"##MD") {
        return Ok((String::new(), Vec::new()));
    }
    let md = MetadataBlock::from_bytes(file.slice_at(addr)?)?;
    Ok((parse_text(&md.xml), parse_properties(&md.xml)))
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

/// The `##MD` comment an event with `text` and/or `properties` gets.
///
/// `<TX>` comes first, which is the order the `EVcomment` schema fixes and
/// the order any reader showing an event's comment will display.
pub(crate) fn comment_xml(text: &str, properties: &[(String, String)]) -> String {
    let mut xml = String::from("<EVcomment>");
    if !text.is_empty() {
        xml.push_str("<TX>");
        escape_into(&mut xml, text);
        xml.push_str("</TX>");
    }
    if !properties.is_empty() {
        xml.push_str("<common_properties>");
        for (key, value) in properties {
            xml.push_str("<e name=\"");
            escape_into(&mut xml, key);
            xml.push_str("\">");
            escape_into(&mut xml, value);
            xml.push_str("</e>");
        }
        xml.push_str("</common_properties>");
    }
    xml.push_str("</EVcomment>");
    xml
}

/// The `<TX>` element of an event comment, or `""` when it has none.
///
/// A scan, for the same reason [`parse_properties`] is one: the element is
/// unambiguous, and anything else in the comment is left alone.
fn parse_text(xml: &str) -> String {
    let Some(start) = xml.find("<TX>") else {
        return String::new();
    };
    let rest = &xml[start + 4..];
    let Some(end) = rest.find("</TX>") else {
        return String::new();
    };
    unescape(&rest[..end])
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
        assert_eq!(parse_properties(&comment_xml("", &properties)), properties);
    }

    #[test]
    fn markup_in_a_value_survives_escaping() {
        let properties = vec![("note".to_owned(), "a & b < c > d \" e ' f".to_owned())];
        let xml = comment_xml("", &properties);
        assert!(!xml.contains("a & b"), "the raw ampersand must be escaped");
        assert_eq!(parse_properties(&xml), properties);
    }

    #[test]
    fn a_comment_without_properties_yields_none() {
        assert!(parse_properties("<EVcomment><TX>just a note</TX></EVcomment>").is_empty());
        assert!(parse_properties("").is_empty());
    }

    /// `<TX>` is the format's own slot for free text about an event, and
    /// it has to survive alongside the properties rather than instead of
    /// them — a foreign tool's properties must still round-trip.
    #[test]
    fn the_comment_text_and_the_properties_share_one_comment() {
        let text = "opened under load\n\ncannet-event/1\nid: 7f3a1c";
        let properties = vec![("other.tool".to_owned(), "kept".to_owned())];
        let xml = comment_xml(text, &properties);
        assert!(
            xml.find("<TX>") < xml.find("<common_properties>"),
            "the EVcomment schema puts TX first: {xml}",
        );
        assert_eq!(parse_text(&xml), text);
        assert_eq!(parse_properties(&xml), properties);
    }

    #[test]
    fn markup_in_the_comment_text_survives_escaping() {
        let text = "a & b < c > d \" e ' f";
        let xml = comment_xml(text, &[]);
        assert!(!xml.contains("a & b"), "the raw ampersand must be escaped");
        assert_eq!(parse_text(&xml), text);
    }

    #[test]
    fn a_comment_without_text_yields_none() {
        assert!(parse_text(&comment_xml("", &[])).is_empty());
        assert!(parse_text("").is_empty());
        assert!(parse_text("<EVcomment><TX>unterminated").is_empty());
    }
}
