//! The `cannet-event/1` text block — one grammar, both capture formats.
//!
//! A timeline event ([ADR 0035](../../../docs/adr/0035-timeline-event-model.md))
//! holds more than any capture format has fields for: a stable id, a kind,
//! a tag, and the structural subject references of
//! [ADR 0056](../../../docs/adr/0056-an-event-subject-is-a-structural-reference.md).
//! [ADR 0057](../../../docs/adr/0057-one-text-block-carries-an-event.md)
//! decides where that goes: a line-oriented text block appended to the
//! event's own text field, inside the file — BLF's `GLOBAL_MARKER`
//! `description`, BLF's `EVENT_COMMENT` text, MDF's `##EV` comment `<TX>`.
//! No sidecar ([ADR 0010](../../../docs/adr/0010-no-sidecar-files.md)), and
//! the same serializer and parser for every carrier.
//!
//! The shape:
//!
//! ```text
//! Contactor opened under load
//!
//! cannet-event/1
//! id: 7f3a1c
//! kind: note
//! tag: fault
//! signal: 0x180 PackCurrent
//! message: 0x2A1
//! link: 91c2de
//! ```
//!
//! The human description comes **first and verbatim**, so a reader in
//! someone else's tool sees their own words on line one. Everything the
//! carrier has no field for follows the header. A container that *does*
//! have a field for something — a marker's name, its colour — keeps it
//! there, and the block leaves that key out.
//!
//! Parsing is deliberately forgiving, because the text field belongs to
//! the user as much as to us:
//!
//! - Split at the **last** line that is exactly a recognised header. With
//!   no header the whole string is the description, so a foreign marker
//!   whose prose happens to mention `cannet-event` round-trips unharmed.
//! - A line whose key this version does not understand, or that does not
//!   parse, is **kept verbatim** and does not invalidate the block.

use crate::notes::{EventKind, EventSubject, Note};

/// The header line: the block's name and its schema version in one token,
/// so a reader sees the version without parsing anything.
const HEADER: &str = "cannet-event/1";

/// The parsed contents of an event's text field: the user's own prose,
/// then whatever the block carried.
///
/// Every field is optional because a *container* may carry it natively
/// instead — the writer leaves out what the record already holds, and the
/// reader takes the block's value when there is one and the native field
/// otherwise.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct EventText {
    /// The prose above the block, verbatim. `None` when there is none.
    pub description: Option<String>,
    /// `id` — the frontend-stable event id.
    pub id: Option<String>,
    /// `kind` — the event kind, camelCased as it is on the wire.
    pub kind: Option<EventKind>,
    /// `label` — written only by a carrier with no name field of its own.
    pub label: Option<String>,
    /// `color` — `#RRGGBB`, written only by a carrier with no colour field.
    pub color: Option<String>,
    /// `tag` — the user's own classification axis.
    pub tag: Option<String>,
    /// `commentedEventType` — the BLF object type a message-bound event's
    /// comment is attached to. Written only by a carrier with no field for
    /// it, which is every carrier but the `EVENT_COMMENT` record itself.
    pub commented_event_type: Option<u32>,
    /// `message` / `signal` / `link` lines, in file order.
    pub subjects: Vec<EventSubject>,
    /// Lines the block carried that this version could not read, verbatim
    /// and in order — a file written by a later version keeps its fields
    /// through a parse.
    pub extra: Vec<String>,
}

impl EventText {
    /// The parts of `note` that ride the block on **every** carrier: its
    /// id, kind, tag, subjects, and the object type a message-bound
    /// event's comment is attached to, under its own description — plus
    /// whatever a later schema version wrote that this build cannot read,
    /// carried through verbatim. A caller whose container has no name or
    /// colour field fills `label` / `color` in afterwards.
    ///
    /// `commentedEventType` is in the block even where the record has its
    /// own field for it (BLF's `EVENT_COMMENT`, which still gets the
    /// native field for a foreign reader): one grammar that says the same
    /// thing whatever is carrying it.
    pub(crate) fn from_note(note: &Note) -> Self {
        Self {
            description: note.description.clone(),
            id: Some(note.id.clone()),
            kind: Some(note.kind),
            label: None,
            color: None,
            tag: note.tag.clone(),
            commented_event_type: note.commented_event_type,
            subjects: note.subjects.clone(),
            extra: note.unknown_block_lines.clone(),
        }
    }

    /// Does this hold anything at all beyond the description?
    fn has_fields(&self) -> bool {
        self.id.is_some()
            || self.kind.is_some()
            || self.label.is_some()
            || self.color.is_some()
            || self.tag.is_some()
            || self.commented_event_type.is_some()
            || !self.subjects.is_empty()
            || !self.extra.is_empty()
    }
}

/// Serialize an [`EventText`] into the one string a carrier's text field
/// holds. Nothing but a description is written as the bare description —
/// no header, nothing for another tool to read around.
pub(crate) fn encode(text: &EventText) -> String {
    let description = text.description.as_deref().unwrap_or_default();
    if !text.has_fields() {
        return description.to_owned();
    }
    let mut out = String::new();
    if !description.is_empty() {
        out.push_str(description);
        out.push_str("\n\n");
    }
    out.push_str(HEADER);
    if let Some(id) = &text.id {
        out.push_str("\nid: ");
        out.push_str(id);
    }
    if let Some(kind) = text.kind {
        out.push_str("\nkind: ");
        out.push_str(kind_key(kind));
    }
    if let Some(label) = &text.label {
        out.push_str("\nlabel: ");
        out.push_str(label);
    }
    if let Some(color) = &text.color {
        out.push_str("\ncolor: ");
        out.push_str(color);
    }
    if let Some(tag) = &text.tag {
        out.push_str("\ntag: ");
        out.push_str(tag);
    }
    if let Some(commented) = text.commented_event_type {
        out.push_str("\ncommentedEventType: ");
        out.push_str(&commented.to_string());
    }
    for subject in &text.subjects {
        out.push('\n');
        out.push_str(&subject_line(subject));
    }
    for line in &text.extra {
        out.push('\n');
        out.push_str(line);
    }
    out
}

/// Parse whatever a carrier's text field held. Never fails: text with no
/// header is all description, and a line this version cannot read is kept
/// in [`EventText::extra`] rather than dropped.
pub(crate) fn decode(raw: &str) -> EventText {
    let Some((description, body)) = split_at_header(raw) else {
        return EventText {
            description: (!raw.is_empty()).then(|| raw.to_owned()),
            ..EventText::default()
        };
    };
    let mut out = EventText {
        description: (!description.is_empty()).then(|| description.to_owned()),
        ..EventText::default()
    };
    for line in body.lines() {
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(": ") else {
            out.extra.push(line.to_owned());
            continue;
        };
        match key {
            "id" => out.id = Some(value.to_owned()),
            "kind" => match kind_from_key(value) {
                Some(kind) => out.kind = Some(kind),
                None => out.extra.push(line.to_owned()),
            },
            "label" => out.label = Some(value.to_owned()),
            "color" => out.color = Some(value.to_owned()),
            "tag" => out.tag = Some(value.to_owned()),
            "commentedEventType" => match value.parse() {
                Ok(object_type) => out.commented_event_type = Some(object_type),
                Err(_) => out.extra.push(line.to_owned()),
            },
            "message" | "signal" | "link" => match parse_subject(key, value) {
                Some(subject) => out.subjects.push(subject),
                None => out.extra.push(line.to_owned()),
            },
            _ => out.extra.push(line.to_owned()),
        }
    }
    out
}

/// Does `raw` carry a `cannet-event/1` block at all? The question a
/// reader asks before falling back to an older form or to another tool's
/// prose — [`decode`] answers it too, but only by what it found inside.
pub(crate) fn has_block(raw: &str) -> bool {
    split_at_header(raw).is_some()
}

/// Split `raw` at the **last** line that is exactly the header, returning
/// `(description, body)`. `None` when there is no header line at all.
///
/// The last one, not the first, so prose that quotes a block — someone
/// pasting one into their own note — leaves the real block as the one read.
fn split_at_header(raw: &str) -> Option<(&str, &str)> {
    let mut found: Option<(usize, usize)> = None;
    let mut offset = 0usize;
    for line in raw.split('\n') {
        if line.trim_end_matches('\r') == HEADER {
            found = Some((offset, offset + line.len()));
        }
        offset += line.len() + 1;
    }
    let (start, end) = found?;
    let description = raw[..start].trim_end_matches(['\n', '\r']);
    Some((description, &raw[end..]))
}

/// A subject as one line of the block.
fn subject_line(subject: &EventSubject) -> String {
    match subject {
        EventSubject::Message {
            message_id,
            extended,
        } => format!("message: {}", reference_id(*message_id, *extended)),
        EventSubject::Signal {
            message_id,
            extended,
            signal_name,
        } => format!(
            "signal: {} {signal_name}",
            reference_id(*message_id, *extended)
        ),
        EventSubject::Event { id } => format!("link: {id}"),
    }
}

/// An arbitration id as the grammar writes it: `0x` hex, with `/ext`
/// suffixed for a 29-bit id — message identity in this app is
/// `(message_id, extended)` (ADR 0056), so both halves are on the line.
fn reference_id(message_id: u32, extended: bool) -> String {
    if extended {
        format!("{message_id:#X}/ext")
    } else {
        format!("{message_id:#X}")
    }
}

/// The inverse of [`reference_id`].
fn parse_reference_id(token: &str) -> Option<(u32, bool)> {
    let (digits, extended) = match token.strip_suffix("/ext") {
        Some(rest) => (rest, true),
        None => (token, false),
    };
    let digits = digits
        .strip_prefix("0x")
        .or_else(|| digits.strip_prefix("0X"))?;
    u32::from_str_radix(digits, 16)
        .ok()
        .map(|id| (id, extended))
}

/// One `message` / `signal` / `link` line's value.
///
/// A signal's name is **the rest of the line**, so a name containing a
/// space survives.
fn parse_subject(key: &str, value: &str) -> Option<EventSubject> {
    match key {
        "link" => (!value.is_empty()).then(|| EventSubject::Event {
            id: value.to_owned(),
        }),
        "message" => {
            let (message_id, extended) = parse_reference_id(value)?;
            Some(EventSubject::Message {
                message_id,
                extended,
            })
        }
        "signal" => {
            let (id_token, signal_name) = value.split_once(' ')?;
            let (message_id, extended) = parse_reference_id(id_token)?;
            (!signal_name.is_empty()).then(|| EventSubject::Signal {
                message_id,
                extended,
                signal_name: signal_name.to_owned(),
            })
        }
        _ => None,
    }
}

/// An [`EventKind`] as the `kind:` line spells it — the same camelCase the
/// wire uses, so one vocabulary covers the IPC and the file.
fn kind_key(kind: EventKind) -> &'static str {
    match kind {
        EventKind::Note => "note",
        EventKind::MessageBound => "messageBound",
        EventKind::BusError => "busError",
    }
}

/// The inverse of [`kind_key`]. An unrecognised kind is not one this
/// version knows, so the caller keeps the line rather than guessing.
fn kind_from_key(key: &str) -> Option<EventKind> {
    match key {
        "note" => Some(EventKind::Note),
        "messageBound" => Some(EventKind::MessageBound),
        "busError" => Some(EventKind::BusError),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str) -> Note {
        Note {
            id: id.to_owned(),
            timestamp_ns: 0,
            label: "l".to_owned(),
            kind: EventKind::Note,
            color: None,
            description: None,
            tag: None,
            commented_event_type: None,
            subjects: Vec::new(),
            unknown_block_lines: Vec::new(),
        }
    }

    #[test]
    fn the_human_description_comes_first_and_the_block_follows_it() {
        let mut text = EventText::from_note(&Note {
            description: Some("Contactor opened under load".to_owned()),
            tag: Some("fault".to_owned()),
            subjects: vec![
                EventSubject::Signal {
                    message_id: 0x180,
                    extended: false,
                    signal_name: "PackCurrent".to_owned(),
                },
                EventSubject::Message {
                    message_id: 0x2A1,
                    extended: false,
                },
                EventSubject::Event {
                    id: "91c2de".to_owned(),
                },
            ],
            ..note("7f3a1c")
        });
        text.kind = Some(EventKind::Note);
        assert_eq!(
            encode(&text),
            "Contactor opened under load\n\
             \n\
             cannet-event/1\n\
             id: 7f3a1c\n\
             kind: note\n\
             tag: fault\n\
             signal: 0x180 PackCurrent\n\
             message: 0x2A1\n\
             link: 91c2de",
        );
    }

    #[test]
    fn every_subject_kind_survives_the_round_trip() {
        let text = EventText::from_note(&Note {
            subjects: vec![
                EventSubject::Message {
                    message_id: 0x18DA_00F1,
                    extended: true,
                },
                EventSubject::Signal {
                    message_id: 0x18DA_00F1,
                    extended: true,
                    signal_name: "Pack Current".to_owned(),
                },
                EventSubject::Event {
                    id: "other".to_owned(),
                },
            ],
            ..note("e")
        });
        assert_eq!(decode(&encode(&text)), text);
    }

    #[test]
    fn an_extended_id_is_distinguishable_from_an_eleven_bit_one() {
        let plain = EventText::from_note(&Note {
            subjects: vec![EventSubject::Message {
                message_id: 0x1AB,
                extended: false,
            }],
            ..note("e")
        });
        let extended = EventText::from_note(&Note {
            subjects: vec![EventSubject::Message {
                message_id: 0x1AB,
                extended: true,
            }],
            ..note("e")
        });
        assert!(encode(&plain).contains("message: 0x1AB\n") || encode(&plain).ends_with("0x1AB"));
        assert!(encode(&extended).ends_with("message: 0x1AB/ext"));
        assert_eq!(decode(&encode(&plain)), plain);
        assert_eq!(decode(&encode(&extended)), extended);
    }

    #[test]
    fn a_signal_name_with_a_space_survives() {
        let text = EventText::from_note(&Note {
            subjects: vec![EventSubject::Signal {
                message_id: 0x100,
                extended: false,
                signal_name: "Pack Current 2".to_owned(),
            }],
            ..note("e")
        });
        assert_eq!(decode(&encode(&text)).subjects, text.subjects);
    }

    #[test]
    fn text_with_no_header_is_all_description() {
        let parsed = decode("looks wrong here\nwatch this ID");
        assert_eq!(
            parsed.description.as_deref(),
            Some("looks wrong here\nwatch this ID"),
        );
        assert_eq!(parsed.id, None);
        assert!(parsed.subjects.is_empty());
        assert!(parsed.extra.is_empty());
    }

    /// A foreign marker whose prose happens to mention the block must
    /// round-trip unharmed rather than being eaten.
    #[test]
    fn prose_that_merely_mentions_the_block_is_not_a_block() {
        let raw = "cannet-event/1 is the thing I was telling you about";
        assert_eq!(decode(raw).description.as_deref(), Some(raw));
    }

    /// Split at the *last* header, so a description that quotes one still
    /// leaves the real block as the block.
    #[test]
    fn the_last_header_wins_when_the_prose_quotes_one() {
        let raw = "I pasted this in:\ncannet-event/1\nid: quoted\n\ncannet-event/1\nid: real";
        let parsed = decode(raw);
        assert_eq!(parsed.id.as_deref(), Some("real"));
        assert_eq!(
            parsed.description.as_deref(),
            Some("I pasted this in:\ncannet-event/1\nid: quoted"),
        );
    }

    #[test]
    fn an_unknown_key_is_kept_verbatim_and_the_rest_of_the_block_still_reads() {
        let parsed = decode("cannet-event/1\nid: a\nfuture: whatever it means\ntag: t");
        assert_eq!(parsed.id.as_deref(), Some("a"));
        assert_eq!(parsed.tag.as_deref(), Some("t"));
        assert_eq!(parsed.extra, vec!["future: whatever it means".to_owned()]);
        assert!(encode(&parsed).contains("future: whatever it means"));
    }

    #[test]
    fn a_malformed_line_is_kept_and_does_not_invalidate_the_block() {
        let parsed = decode("cannet-event/1\nid: a\nthis line has no key\nmessage: nonsense");
        assert_eq!(parsed.id.as_deref(), Some("a"));
        assert!(parsed.subjects.is_empty());
        assert_eq!(
            parsed.extra,
            vec![
                "this line has no key".to_owned(),
                "message: nonsense".to_owned(),
            ],
        );
    }

    #[test]
    fn a_kind_this_version_does_not_know_is_kept_rather_than_guessed() {
        let parsed = decode("cannet-event/1\nid: a\nkind: somethingNew");
        assert_eq!(parsed.kind, None);
        assert_eq!(parsed.extra, vec!["kind: somethingNew".to_owned()]);
    }

    #[test]
    fn nothing_but_a_description_writes_no_header() {
        let text = EventText {
            description: Some("just prose".to_owned()),
            ..EventText::default()
        };
        assert_eq!(encode(&text), "just prose");
        assert_eq!(decode(&encode(&text)), text);
    }

    #[test]
    fn a_carrier_without_a_name_or_colour_field_carries_them_in_the_block() {
        let mut text = EventText::from_note(&note("c1"));
        text.label = Some("contactor closed".to_owned());
        text.color = Some("#FF8800".to_owned());
        let parsed = decode(&encode(&text));
        assert_eq!(parsed.label.as_deref(), Some("contactor closed"));
        assert_eq!(parsed.color.as_deref(), Some("#FF8800"));
        assert_eq!(parsed, text);
    }

    #[test]
    fn a_multi_line_description_keeps_its_blank_lines() {
        let text = EventText::from_note(&Note {
            description: Some("first\n\nthird".to_owned()),
            ..note("e")
        });
        assert_eq!(decode(&encode(&text)).description, text.description);
    }

    /// Every kind the host can hold spells itself the way the wire does,
    /// so one vocabulary covers the IPC and the file.
    #[test]
    fn every_kind_round_trips_through_its_key() {
        for kind in [
            EventKind::Note,
            EventKind::MessageBound,
            EventKind::BusError,
        ] {
            assert_eq!(kind_from_key(kind_key(kind)), Some(kind));
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(
                json.trim_matches('"'),
                kind_key(kind),
                "the block's key and the wire's spelling must not drift",
            );
        }
    }
}
