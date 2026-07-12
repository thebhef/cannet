//! Filter predicate model and evaluation.
//!
//! A filter element (`Project.elements` entry `{kind: "filter", ...}`)
//! carries a structured [`FilterPredicate`] that the host evaluates
//! against each frame in a slice. The predicate is JSON-friendly and
//! round-trips through `serde_json`, so the frontend can edit it
//! directly and pass it down on `fetch_trace_range` /
//! `fetch_by_id_page` / `sample_signals` without any wire-format
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

use std::cell::RefCell;
use std::collections::HashMap;

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

    /// Collect the predicate's decode-dependent leaves — the
    /// `name_regex` patterns and `signal_equals` signal names anywhere
    /// in the tree. A bulk scan resolves these against the loaded DBCs
    /// into the set of arbitration ids whose decode could possibly
    /// change the verdict, and skips decoding every other frame: an id
    /// that no DBC decodes to a matching name / signal makes these
    /// leaves false with or without the decode.
    #[must_use]
    pub fn decode_dependent_leaves(&self) -> Vec<DecodeDependentLeaf<'_>> {
        let mut out = Vec::new();
        self.collect_decode_dependent(&mut out);
        out
    }

    fn collect_decode_dependent<'a>(&'a self, out: &mut Vec<DecodeDependentLeaf<'a>>) {
        let FilterPredicate::Tagged(p) = self else {
            return;
        };
        match p {
            TaggedPredicate::All(children) | TaggedPredicate::Any(children) => {
                for c in children {
                    c.collect_decode_dependent(out);
                }
            }
            TaggedPredicate::NameRegex(pat) => {
                out.push(DecodeDependentLeaf::MessageNameRegex(pat));
            }
            TaggedPredicate::SignalEquals(m) => {
                out.push(DecodeDependentLeaf::SignalName(&m.name));
            }
            TaggedPredicate::Bus(_) | TaggedPredicate::IdRange(_) | TaggedPredicate::IdList(_) => {}
        }
    }
}

/// The by-id candidate set a filter index builds from (ADR 0002 DS-3):
/// the arbitration keys whose frames *could* match the predicate, plus
/// whether every such frame matches (so the build can skip reading
/// frames). See [`resolve_candidates`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateSet {
    /// Candidate `(id, extended)` keys, sorted and deduped. The filter
    /// index visits only these ids' frames (via the by-id index).
    pub keys: Vec<(u32, bool)>,
    /// `true` when membership in `keys` *is* the match — every candidate
    /// frame matches, so the index records them without a frame read
    /// (`id_list` / `id_range`). `false` when a per-frame `keep` test is
    /// still needed (`bus` confirms `bus_id`; `name_regex` / `signal_equals`
    /// decode).
    pub membership: bool,
}

/// The DBC- and capture-derived facts [`resolve_candidates`] needs, passed
/// as closures so the resolver is pure logic testable without a real DBC
/// or store.
pub struct CandidateInputs<'a> {
    /// Distinct `(id, extended)` keys seen in the capture, sorted. Used to
    /// turn an `id_range` (which can't be enumerated) into the ids that
    /// actually occurred in it.
    pub seen_ids: &'a [(u32, bool)],
    /// The `(id, extended)` keys seen on a given logical bus.
    pub seen_on_bus: &'a dyn Fn(&str) -> Vec<(u32, bool)>,
    /// The ids whose DBC message name matches a `name_regex` pattern.
    pub regex_ids: &'a dyn Fn(&str) -> Vec<(u32, bool)>,
    /// The ids whose DBC message carries a named signal.
    pub signal_ids: &'a dyn Fn(&str) -> Vec<(u32, bool)>,
}

/// Resolve a predicate to its by-id candidate set, or `None` when it is
/// not id-narrowable (the caller must visit the whole window).
///
/// The match set is always a subset of the returned `keys`, so building an
/// index off `keys` (then applying `keep` unless `membership`) is sound.
/// `None` means "could be any id" — an empty `all` (vacuous-true) or an
/// `any` with a non-narrowable branch.
#[must_use]
pub fn resolve_candidates(
    predicate: &FilterPredicate,
    inputs: &CandidateInputs<'_>,
) -> Option<CandidateSet> {
    let p = match predicate {
        // An invalid predicate matches nothing — an empty, membership set.
        FilterPredicate::Invalid(_) => {
            return Some(CandidateSet {
                keys: Vec::new(),
                membership: true,
            })
        }
        FilterPredicate::Tagged(p) => p,
    };
    match p {
        TaggedPredicate::IdList(ids) => Some(CandidateSet {
            keys: normalize(ids.iter().flat_map(|&id| [(id, false), (id, true)]).collect()),
            membership: true,
        }),
        TaggedPredicate::IdRange([lo, hi]) => Some(CandidateSet {
            keys: inputs
                .seen_ids
                .iter()
                .copied()
                .filter(|&(id, _)| id >= *lo && id <= *hi)
                .collect(),
            membership: true,
        }),
        TaggedPredicate::Bus(b) => Some(CandidateSet {
            keys: normalize((inputs.seen_on_bus)(b)),
            // A frame's id can occur on another bus, so confirm bus_id.
            membership: false,
        }),
        TaggedPredicate::NameRegex(pat) => Some(CandidateSet {
            keys: normalize((inputs.regex_ids)(pat)),
            // Per-bus DBC scoping: confirm by decoding.
            membership: false,
        }),
        TaggedPredicate::SignalEquals(m) => Some(CandidateSet {
            keys: normalize((inputs.signal_ids)(&m.name)),
            membership: false,
        }),
        TaggedPredicate::All(children) => resolve_all(children, inputs),
        TaggedPredicate::Any(children) => resolve_any(children, inputs),
    }
}

/// `all`: the match set is the intersection of the children's, so any
/// narrowable child bounds it; intersect the narrowable children's keys
/// (a non-narrowable child doesn't shrink the bound). Membership only
/// survives if *every* child is a narrowable membership child.
fn resolve_all(
    children: &[FilterPredicate],
    inputs: &CandidateInputs<'_>,
) -> Option<CandidateSet> {
    let mut acc: Option<Vec<(u32, bool)>> = None;
    let mut membership = true;
    for c in children {
        match resolve_candidates(c, inputs) {
            Some(set) => {
                membership &= set.membership;
                acc = Some(match acc {
                    None => set.keys,
                    Some(prev) => intersect(&prev, &set.keys),
                });
            }
            None => membership = false, // un-narrowable child needs testing
        }
    }
    acc.map(|keys| CandidateSet { keys, membership })
}

/// `any`: the match set is the union of the children's. If any child is
/// non-narrowable the union spans all ids, so the `any` is too; otherwise
/// union the keys. Membership survives only if every child is membership.
fn resolve_any(
    children: &[FilterPredicate],
    inputs: &CandidateInputs<'_>,
) -> Option<CandidateSet> {
    let mut keys: Vec<(u32, bool)> = Vec::new();
    let mut membership = true;
    for c in children {
        let set = resolve_candidates(c, inputs)?; // any None ⇒ whole `any` None
        membership &= set.membership;
        keys.extend(set.keys);
    }
    Some(CandidateSet {
        keys: normalize(keys),
        membership,
    })
}

fn normalize(mut v: Vec<(u32, bool)>) -> Vec<(u32, bool)> {
    v.sort_unstable();
    v.dedup();
    v
}

/// Intersection of two sorted, deduped key slices.
fn intersect(a: &[(u32, bool)], b: &[(u32, bool)]) -> Vec<(u32, bool)> {
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::new();
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
        }
    }
    out
}

/// One decode-dependent predicate leaf, borrowed from the predicate
/// tree. See [`FilterPredicate::decode_dependent_leaves`].
#[derive(Debug, PartialEq, Eq)]
pub enum DecodeDependentLeaf<'a> {
    /// A `name_regex` pattern, matched against decoded message names.
    MessageNameRegex(&'a str),
    /// A `signal_equals` signal name, matched against decoded signals.
    SignalName(&'a str),
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
}

thread_local! {
    /// Per-thread memo of compiled patterns for [`regex_match`].
    /// Predicate evaluation runs per *frame* in bulk scans, and
    /// `Regex::new` costs tens of microseconds — recompiling per frame
    /// was the dominant cost of a name-filtered scan, dwarfing the
    /// decode it gated. `None` caches "pattern doesn't compile" so an
    /// invalid pattern isn't re-parsed per frame either. Patterns come
    /// from the project's filter elements (a handful), but the cache is
    /// bounded anyway so arbitrary churn can't grow it without limit.
    static REGEX_CACHE: RefCell<HashMap<String, Option<regex::Regex>>> =
        RefCell::new(HashMap::new());
}

/// [`REGEX_CACHE`] entry cap; on overflow the cache is simply cleared
/// (it re-warms in one scan pass).
const REGEX_CACHE_CAP: usize = 64;

/// Regex helper: compiles `pat` (memoized per thread) and tests
/// `haystack`. An invalid pattern matches nothing — consistent with
/// the "bad predicate = empty result" rule.
pub(crate) fn regex_match(pat: &str, haystack: &str) -> bool {
    REGEX_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(compiled) = cache.get(pat) {
            return compiled.as_ref().is_some_and(|re| re.is_match(haystack));
        }
        if cache.len() >= REGEX_CACHE_CAP {
            cache.clear();
        }
        let compiled = regex::Regex::new(pat).ok();
        let matched = compiled.as_ref().is_some_and(|re| re.is_match(haystack));
        cache.insert(pat.to_string(), compiled);
        matched
    })
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
        // Still a non-match on the (cached) second evaluation.
        assert!(!p.matches(&frame_with(1, None), Some(&d)));
    }

    #[test]
    fn regex_match_is_stable_across_repeated_calls() {
        // The memo cache must not change verdicts: same pattern, both
        // outcomes, repeatedly.
        for _ in 0..3 {
            assert!(regex_match("^Eng", "EngineData"));
            assert!(!regex_match("^Eng", "BrakeStatus"));
        }
    }

    fn inputs<'a>(
        seen: &'a [(u32, bool)],
        on_bus: &'a dyn Fn(&str) -> Vec<(u32, bool)>,
        regex: &'a dyn Fn(&str) -> Vec<(u32, bool)>,
        signal: &'a dyn Fn(&str) -> Vec<(u32, bool)>,
    ) -> CandidateInputs<'a> {
        CandidateInputs {
            seen_ids: seen,
            seen_on_bus: on_bus,
            regex_ids: regex,
            signal_ids: signal,
        }
    }

    #[test]
    fn id_list_is_a_membership_set_over_both_addressing_modes() {
        let none = |_: &str| Vec::new();
        let inp = inputs(&[], &none, &none, &none);
        let set = resolve_candidates(&parse(r#"{"id_list": [1, 3]}"#), &inp).unwrap();
        assert!(set.membership);
        assert_eq!(set.keys, vec![(1, false), (1, true), (3, false), (3, true)]);
    }

    #[test]
    fn id_range_intersects_with_seen_ids() {
        let none = |_: &str| Vec::new();
        let seen = [(5, false), (50, false), (150, false), (250, true)];
        let inp = inputs(&seen, &none, &none, &none);
        let set = resolve_candidates(&parse(r#"{"id_range": [10, 200]}"#), &inp).unwrap();
        assert!(set.membership);
        assert_eq!(set.keys, vec![(50, false), (150, false)]);
    }

    #[test]
    fn bus_resolves_to_seen_on_bus_and_needs_a_keep_test() {
        let none = |_: &str| Vec::new();
        let on_bus = |b: &str| {
            if b == "pt" {
                vec![(0x100, false), (0x200, false)]
            } else {
                vec![]
            }
        };
        let inp = inputs(&[], &on_bus, &none, &none);
        let set = resolve_candidates(&parse(r#"{"bus": "pt"}"#), &inp).unwrap();
        assert!(!set.membership, "bus must confirm bus_id per frame");
        assert_eq!(set.keys, vec![(0x100, false), (0x200, false)]);
    }

    #[test]
    fn name_regex_and_signal_equals_use_dbc_ids_and_need_decode() {
        let none = |_: &str| Vec::new();
        let regex = |p: &str| if p == "^Eng" { vec![(0x10, false)] } else { vec![] };
        let signal = |n: &str| if n == "Rpm" { vec![(0x10, false)] } else { vec![] };
        let inp = inputs(&[], &none, &regex, &signal);
        let nr = resolve_candidates(&parse(r#"{"name_regex": "^Eng"}"#), &inp).unwrap();
        assert!(!nr.membership);
        assert_eq!(nr.keys, vec![(0x10, false)]);
        let se =
            resolve_candidates(&parse(r#"{"signal_equals":{"name":"Rpm","value":1}}"#), &inp)
                .unwrap();
        assert!(!se.membership);
        assert_eq!(se.keys, vec![(0x10, false)]);
    }

    #[test]
    fn all_intersects_children_and_drops_membership_when_tested() {
        let none = |_: &str| Vec::new();
        let on_bus = |_: &str| vec![(1, false), (2, false), (3, false)];
        let inp = inputs(&[], &on_bus, &none, &none);
        // bus∩id_list: candidate = {1,2,3} ∩ {2,4} = {2}; tested (bus leaf).
        let set = resolve_candidates(
            &parse(r#"{"all": [{"bus": "p"}, {"id_list": [2, 4]}]}"#),
            &inp,
        )
        .unwrap();
        assert!(!set.membership);
        assert_eq!(set.keys, vec![(2, false)]);
    }

    #[test]
    fn all_of_membership_children_stays_membership() {
        let none = |_: &str| Vec::new();
        let seen = [(2, false), (3, false), (4, false)];
        let inp = inputs(&seen, &none, &none, &none);
        // id_range[1,3] ∩ id_list{2,3,9} = {2,3}; both membership ⇒ membership.
        let set = resolve_candidates(
            &parse(r#"{"all": [{"id_range": [1, 3]}, {"id_list": [2, 3, 9]}]}"#),
            &inp,
        )
        .unwrap();
        assert!(set.membership);
        assert_eq!(set.keys, vec![(2, false), (3, false)]);
    }

    #[test]
    fn any_unions_children_but_a_nonnarrowable_branch_is_unbounded() {
        let none = |_: &str| Vec::new();
        let inp = inputs(&[], &none, &none, &none);
        // any of two id_lists ⇒ union, membership.
        let set = resolve_candidates(
            &parse(r#"{"any": [{"id_list": [1]}, {"id_list": [2]}]}"#),
            &inp,
        )
        .unwrap();
        assert!(set.membership);
        assert_eq!(set.keys, vec![(1, false), (1, true), (2, false), (2, true)]);
        // An empty `all` is vacuous-true (any id) ⇒ that `any` branch is
        // non-narrowable ⇒ the whole `any` is None.
        assert!(resolve_candidates(
            &parse(r#"{"any": [{"id_list": [1]}, {"all": []}]}"#),
            &inp,
        )
        .is_none());
    }

    #[test]
    fn empty_all_is_not_narrowable_and_invalid_matches_nothing() {
        let none = |_: &str| Vec::new();
        let inp = inputs(&[], &none, &none, &none);
        assert!(resolve_candidates(&parse(r#"{"all": []}"#), &inp).is_none());
        let invalid = resolve_candidates(&parse(r#"{"unknown": 1}"#), &inp).unwrap();
        assert!(invalid.membership && invalid.keys.is_empty());
    }

    #[test]
    fn decode_dependent_leaves_collects_name_and_signal_leaves() {
        let p = parse(
            r#"{"all": [
                {"bus": "p"},
                {"name_regex": "^Fault"},
                {"any": [{"id_list": [1]}, {"signal_equals": {"name": "Rpm", "value": 1}}]}
            ]}"#,
        );
        assert_eq!(
            p.decode_dependent_leaves(),
            vec![
                DecodeDependentLeaf::MessageNameRegex("^Fault"),
                DecodeDependentLeaf::SignalName("Rpm"),
            ],
        );
        // Raw-only predicates have no decode-dependent leaves.
        assert!(parse(r#"{"all": [{"bus": "p"}, {"id_range": [1, 10]}]}"#)
            .decode_dependent_leaves()
            .is_empty());
        // Invalid predicates contribute nothing.
        assert!(parse(r#"{"unknown_kind": 42}"#)
            .decode_dependent_leaves()
            .is_empty());
    }
}
