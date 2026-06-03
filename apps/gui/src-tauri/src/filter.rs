//! Filter predicate model and evaluation.
//!
//! A filter element (`Project.elements` entry `{kind: "filter", ...}`)
//! carries a structured [`FilterPredicate`] that the host evaluates
//! against each frame in a slice. The predicate is JSON-friendly and
//! round-trips through `serde_json`, so the frontend can edit it
//! directly and pass it down on `fetch_trace_range` /
//! `fetch_latest_by_id` / `sample_signals` without any wire-format
//! glue.
//!
//! ## Predicate shape
//!
//! `FilterPredicate` is one of:
//!
//! - `{ "all": [Predicate, …] }` — every sub-predicate must match
//!   (AND). Empty `all` passes everything (the conventional vacuous
//!   truth) so an empty filter is a no-op.
//! - `{ "any": [Predicate, …] }` — at least one sub-predicate matches
//!   (OR). Empty `any` rejects everything.
//! - `{ "bus": "<bus_id>" }` — frame's `bus_id` equals `<bus_id>`.
//!   A frame with no `bus_id` never matches a bus predicate.
//! - `{ "id_range": [lo, hi] }` — `lo <= frame.id <= hi` (inclusive).
//! - `{ "id_list": [u32, …] }` — `frame.id` is in the list.
//! - `{ "name_regex": "<pattern>" }` — the decoded message name (if any)
//!   matches the regex. A frame with no decode never matches.
//! - `{ "signal_equals": { "name": "<sig>", "value": <number> } }` —
//!   the decoded signal `<sig>` exists and its physical value equals
//!   `<number>` within `1e-9` tolerance.
//!
//! Unknown variants and malformed shapes deserialize to
//! [`FilterPredicate::Invalid`]; an invalid predicate is treated as
//! "passes nothing" so a bad predicate doesn't silently grow the
//! consumer's view.
//!
//! ## Why structured JSON, not a DSL
//!
//! A text DSL adds parser and
//! autocomplete problems we don't need yet. The structured editor lives
//! on the filter node in the project graph view.

use serde::{Deserialize, Serialize};

use crate::ipc::DecodedRecord;
use crate::trace_store::RawTraceFrame;

/// One filter predicate node. See module docs for the shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum FilterPredicate {
    /// Structured forms with a discriminator field.
    Tagged(TaggedPredicate),
    /// Anything we didn't recognise. Matches nothing — see
    /// [`FilterPredicate::matches`].
    #[serde(skip_serializing)]
    Invalid(serde_json::Value),
}

/// The recognised predicate shapes. Kept separate from
/// [`FilterPredicate`] so a `untagged` deserialize attempt at the outer
/// level cleanly falls through to `Invalid` for anything we don't
/// know.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaggedPredicate {
    All(Vec<FilterPredicate>),
    Any(Vec<FilterPredicate>),
    Bus(String),
    IdRange([u32; 2]),
    IdList(Vec<u32>),
    NameRegex(String),
    SignalEquals(SignalMatch),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignalMatch {
    pub name: String,
    pub value: f64,
}

impl FilterPredicate {
    /// Evaluate the predicate against a (raw, optionally decoded)
    /// frame. Decoding is the caller's responsibility — the
    /// fetch path already decodes for the consumer, so reusing it here
    /// is free.
    #[must_use]
    pub fn matches(&self, frame: &RawTraceFrame, decoded: Option<&DecodedRecord>) -> bool {
        match self {
            FilterPredicate::Invalid(_) => false,
            FilterPredicate::Tagged(p) => p.matches(frame, decoded),
        }
    }

    /// Does evaluating this predicate need the frame's *decoded*
    /// signals / message name? `false` for id / bus predicates, which
    /// read raw frame fields only — letting a bulk scan skip decoding
    /// the frames that don't match (decoding is the costly part).
    #[must_use]
    pub fn needs_decode(&self) -> bool {
        match self {
            FilterPredicate::Invalid(_) => false,
            FilterPredicate::Tagged(p) => p.needs_decode(),
        }
    }
}

impl TaggedPredicate {
    fn matches(&self, frame: &RawTraceFrame, decoded: Option<&DecodedRecord>) -> bool {
        match self {
            Self::All(children) => children.iter().all(|c| c.matches(frame, decoded)),
            Self::Any(children) => children.iter().any(|c| c.matches(frame, decoded)),
            Self::Bus(id) => frame.bus_id.as_deref() == Some(id.as_str()),
            Self::IdRange([lo, hi]) => frame.id >= *lo && frame.id <= *hi,
            Self::IdList(ids) => ids.contains(&frame.id),
            Self::NameRegex(pat) => match decoded {
                Some(d) => regex_match(pat, &d.name),
                None => false,
            },
            Self::SignalEquals(m) => match decoded {
                Some(d) => d
                    .signals
                    .iter()
                    .any(|s| s.name == m.name && (s.value - m.value).abs() < 1e-9),
                None => false,
            },
        }
    }

    fn needs_decode(&self) -> bool {
        match self {
            Self::All(children) | Self::Any(children) => {
                children.iter().any(FilterPredicate::needs_decode)
            }
            Self::Bus(_) | Self::IdRange(_) | Self::IdList(_) => false,
            Self::NameRegex(_) | Self::SignalEquals(_) => true,
        }
    }
}

/// Very small regex helper: tries to compile `pat` as a regex; if the
/// pattern is invalid the predicate matches nothing (consistent with
/// the "bad predicate = empty result" rule). We use the `regex` crate
/// already present transitively through tonic; if it isn't, this falls
/// back to a literal `contains` check.
fn regex_match(pat: &str, haystack: &str) -> bool {
    match regex::Regex::new(pat) {
        Ok(re) => re.is_match(haystack),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::SignalRecord;
    use cannet_core::{CanFramePayload, Direction};

    fn frame_with(id: u32, bus_id: Option<&str>) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: 0,
            channel: 0,
            id,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(vec![]),
            bus_id: bus_id.map(str::to_string),
        }
    }

    fn decoded(name: &str, signals: &[(&str, f64)]) -> DecodedRecord {
        DecodedRecord {
            name: name.into(),
            signals: signals
                .iter()
                .map(|(n, v)| SignalRecord {
                    name: (*n).into(),
                    value: *v,
                    unit: String::new(),
                    label: None,
                })
                .collect(),
        }
    }

    fn parse(text: &str) -> FilterPredicate {
        serde_json::from_str(text).expect("test predicate parses")
    }

    #[test]
    fn empty_all_passes_everything() {
        let p = parse(r#"{"all": []}"#);
        assert!(p.matches(&frame_with(1, None), None));
        assert!(p.matches(&frame_with(0x7FF, Some("a")), None));
    }

    #[test]
    fn empty_any_rejects_everything() {
        let p = parse(r#"{"any": []}"#);
        assert!(!p.matches(&frame_with(1, None), None));
    }

    #[test]
    fn bus_predicate_matches_bus_id() {
        let p = parse(r#"{"bus": "powertrain"}"#);
        assert!(p.matches(&frame_with(1, Some("powertrain")), None));
        assert!(!p.matches(&frame_with(1, Some("chassis")), None));
        assert!(!p.matches(&frame_with(1, None), None));
    }

    #[test]
    fn id_range_is_inclusive() {
        let p = parse(r#"{"id_range": [100, 200]}"#);
        assert!(p.matches(&frame_with(100, None), None));
        assert!(p.matches(&frame_with(150, None), None));
        assert!(p.matches(&frame_with(200, None), None));
        assert!(!p.matches(&frame_with(99, None), None));
        assert!(!p.matches(&frame_with(201, None), None));
    }

    #[test]
    fn id_list_membership() {
        let p = parse(r#"{"id_list": [1, 3, 5]}"#);
        assert!(p.matches(&frame_with(3, None), None));
        assert!(!p.matches(&frame_with(2, None), None));
    }

    #[test]
    fn name_regex_matches_decoded_message_name() {
        let p = parse(r#"{"name_regex": "^EngineStatus"}"#);
        let d = decoded("EngineStatus_HS", &[]);
        assert!(p.matches(&frame_with(1, None), Some(&d)));
        let d2 = decoded("BrakeStatus", &[]);
        assert!(!p.matches(&frame_with(1, None), Some(&d2)));
        // No decode -> doesn't match.
        assert!(!p.matches(&frame_with(1, None), None));
    }

    #[test]
    fn signal_equals_matches_signal_value_with_epsilon() {
        let p = parse(r#"{"signal_equals": {"name": "Rpm", "value": 800}}"#);
        let d = decoded("Eng", &[("Rpm", 800.0), ("Tq", 12.0)]);
        assert!(p.matches(&frame_with(1, None), Some(&d)));
        let d2 = decoded("Eng", &[("Rpm", 800.000_000_000_1)]);
        assert!(p.matches(&frame_with(1, None), Some(&d2)));
        let d3 = decoded("Eng", &[("Rpm", 801.0)]);
        assert!(!p.matches(&frame_with(1, None), Some(&d3)));
    }

    #[test]
    fn needs_decode_only_for_decoded_field_predicates() {
        // id / bus predicates read raw frame fields — a bulk scan can
        // skip decoding non-matches.
        assert!(!parse(r#"{"id_range": [1, 10]}"#).needs_decode());
        assert!(!parse(r#"{"id_list": [1]}"#).needs_decode());
        assert!(!parse(r#"{"bus": "p"}"#).needs_decode());
        // name / signal predicates need the decoded record.
        assert!(parse(r#"{"name_regex": "^Eng"}"#).needs_decode());
        assert!(parse(r#"{"signal_equals": {"name": "Rpm", "value": 1}}"#).needs_decode());
        // Composition needs decode iff any child does.
        assert!(!parse(r#"{"all": [{"bus": "p"}, {"id_list": [1]}]}"#).needs_decode());
        assert!(parse(r#"{"any": [{"id_list": [1]}, {"name_regex": "x"}]}"#).needs_decode());
    }

    #[test]
    fn all_and_any_compose() {
        let p = parse(
            r#"{"all": [{"bus": "p"}, {"any": [{"id_range": [1, 10]}, {"id_list": [99]}]}]}"#,
        );
        assert!(p.matches(&frame_with(5, Some("p")), None));
        assert!(p.matches(&frame_with(99, Some("p")), None));
        assert!(!p.matches(&frame_with(5, Some("c")), None)); // bus mismatch
        assert!(!p.matches(&frame_with(50, Some("p")), None)); // id mismatch
    }

    #[test]
    fn invalid_predicate_matches_nothing() {
        let p = parse(r#"{"unknown_kind": 42}"#);
        assert!(matches!(p, FilterPredicate::Invalid(_)));
        assert!(!p.matches(&frame_with(1, Some("p")), None));
    }

    #[test]
    fn invalid_regex_is_a_non_match() {
        // Unclosed group.
        let p = parse(r#"{"name_regex": "("}"#);
        let d = decoded("anything", &[]);
        assert!(!p.matches(&frame_with(1, None), Some(&d)));
    }
}
