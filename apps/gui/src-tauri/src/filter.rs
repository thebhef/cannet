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
//! - `{ "fuzzy": "<query>" }` — the row's *searchable text* matches
//!   `<query>` under the app's one fzf dialect ([`crate::fuzzy`]).
//!   Messages, signal names and value-table labels are ranked together
//!   and the best match's kind ([`FuzzyWinner`]) decides what the query
//!   is about. See [`TaggedPredicate::Fuzzy`] for the whole rule and
//!   for why the leaf needs a [`MatchContext`].
//! - `{ "error_frame": <bool> }` — the frame is (`true`) or is not
//!   (`false`) a bus error frame. Unlike every other leaf this one reads
//!   nothing that narrows by arbitration id — an error frame carries no
//!   id of its own worth indexing — so it always leaves the candidate
//!   set un-narrowed and is confirmed per frame.
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

use crate::fuzzy;
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
    /// Whether the frame is a bus error frame. `false` is the useful
    /// direction: it is what a trace view applies to show a fault's
    /// coalesced summary instead of its hundred thousand rows, while
    /// the capture goes on holding every one of them.
    ErrorFrame(bool),
    /// `{ "fuzzy": "<query>" }` — the row's searchable text matches
    /// `<query>` under the app's one fzf dialect ([`crate::fuzzy`]):
    /// case-insensitive, with the relative floor
    /// ([`fuzzy::MIN_RELATIVE_SCORE`]) cutting the score-descending
    /// list. The frontend's filter slot (ADR 0044) ranks client-held
    /// rows the same way, so one query narrows a host-paged view and a
    /// client-held one alike.
    ///
    /// **The searchable text** is three lists ranked as one:
    ///
    /// - a **message** ([`FuzzyCandidate`]) — its bus name, its
    ///   arbitration id in both spellings the trace renders
    ///   (`s:1C0` / `s:448`), its decoded name and its transmitting
    ///   ECU;
    /// - a **signal** ([`FuzzySignal`]) — one entry per signal name a
    ///   message carries;
    /// - a **value** ([`FuzzyLabel`]) — one entry per value-table label
    ///   a signal defines.
    ///
    /// Payload bytes, numeric values and timestamps are deliberately
    /// out: a filter over those is what the other leaves are for.
    ///
    /// **The winner decides what the query is about.** The best match's
    /// kind is the query's [`FuzzyWinner`]. A message admits its
    /// frames; a signal admits the frames of the messages carrying it;
    /// a value admits the frames whose decoded signal reads it — and
    /// under a signal or value winner a message admitted only by its
    /// own haystack is dropped unless it clears
    /// [`fuzzy::MESSAGE_GATE`]. Without that gate a value query lands
    /// on the message's long haystack as a scattered subsequence and
    /// admits every frame of it, which is the whole point of the leaf
    /// defeated.
    ///
    /// **A by-id row is a message, not a frame.** In
    /// [`FuzzyMatchMode::Definitional`] a value matches when the
    /// message *defines* a signal whose value table holds it, whatever
    /// the latest frame reads; the chronological paths keep the
    /// per-frame decoded test over the whole history.
    ///
    /// **Why it needs a [`MatchContext`].** The floor is a cut on a
    /// *ranked list*, so "does this row match" is not a question one
    /// row can answer alone. The query is therefore resolved once
    /// against the databases and the bus names ([`FuzzyResolution`])
    /// and the per-row test is a lookup in that. A leaf evaluated
    /// without its resolution in the context matches nothing, the same
    /// rule an unparseable predicate follows.
    Fuzzy(String),
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
    pub fn matches(
        &self,
        ctx: &MatchContext,
        frame: &RawTraceFrame,
        decoded: Option<&DecodedRecord>,
    ) -> bool {
        self.matches_fields(
            ctx,
            frame.id,
            frame.extended,
            frame.bus_id.as_deref(),
            matches!(frame.payload, cannet_core::CanFramePayload::Error),
            decoded,
        )
    }

    /// Evaluate against the raw fields a predicate actually reads — the
    /// arbitration id, the logical bus, and the decoded message — without
    /// materializing a [`RawTraceFrame`]. The fetch path already holds a
    /// decoded record for each row, so it evaluates directly off that
    /// rather than fabricating a dummy frame to satisfy [`Self::matches`].
    /// `ctx` carries the standing facts a leaf cannot read off one
    /// frame — today only the resolution of each `fuzzy` query (see
    /// [`TaggedPredicate::Fuzzy`]). Every other leaf ignores it, so a
    /// caller with no fuzzy leaf in its predicate passes
    /// [`EMPTY_MATCH_CONTEXT`].
    #[must_use]
    pub fn matches_fields(
        &self,
        ctx: &MatchContext,
        id: u32,
        extended: bool,
        bus_id: Option<&str>,
        is_error_frame: bool,
        decoded: Option<&DecodedRecord>,
    ) -> bool {
        match self {
            FilterPredicate::Invalid(_) => false,
            FilterPredicate::Tagged(p) => {
                p.matches_fields(ctx, id, extended, bus_id, is_error_frame, decoded)
            }
        }
    }

    /// Every `fuzzy` leaf's query anywhere in the tree, in tree order —
    /// what a caller resolves into a [`MatchContext`] before it
    /// evaluates the predicate.
    #[must_use]
    pub fn fuzzy_queries(&self) -> Vec<&str> {
        let mut out = Vec::new();
        self.collect_fuzzy_queries(&mut out);
        out
    }

    fn collect_fuzzy_queries<'a>(&'a self, out: &mut Vec<&'a str>) {
        let FilterPredicate::Tagged(p) = self else {
            return;
        };
        match p {
            TaggedPredicate::All(children) | TaggedPredicate::Any(children) => {
                for c in children {
                    c.collect_fuzzy_queries(out);
                }
            }
            TaggedPredicate::Fuzzy(q) => out.push(q.as_str()),
            _ => {}
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
            // A `fuzzy` leaf's id-keyed half is answered by a lookup in
            // its resolution, with no decode at all; only its
            // enum-label half needs one, and which ids those are is a
            // property of the resolution rather than of the pattern.
            // See [`MatchContext::decode_ids`].
            TaggedPredicate::Fuzzy(_)
            | TaggedPredicate::Bus(_)
            | TaggedPredicate::IdRange(_)
            | TaggedPredicate::IdList(_)
            | TaggedPredicate::ErrorFrame(_) => {}
        }
    }
}

/// One `(bus, id, extended)` triple's searchable text, as the caller
/// spells it. Built from the capture's seen keys, the project's bus
/// names and the loaded databases — never from a frame's payload — so
/// the whole list is a pure function of facts that move far more
/// slowly than the capture does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FuzzyCandidate {
    pub bus_id: String,
    pub id: u32,
    pub extended: bool,
    /// Bus name, both id spellings, message name and transmitting ECU,
    /// joined with spaces — the filter slot's haystack convention
    /// (ADR 0044), one string per searchable thing. The message's
    /// *signal* names are deliberately not in here: they are ranked as
    /// [`FuzzySignal`] entries in their own right, so a query aimed at
    /// a signal (or at one of its values) is not also answered by the
    /// message that happens to carry it.
    pub haystack: String,
}

/// One signal name a database defines for a message on a bus. Ranked
/// beside the messages and the labels so a query's best match can be
/// identified as a signal — and so a signal match admits the frames of
/// the messages carrying it, rather than being one more word in a
/// message's haystack.
///
/// Bus-scoped like [`FuzzyCandidate`], because the database that names
/// the signal is the one assigned to that bus: the same arbitration id
/// on another bus is another message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FuzzySignal {
    pub bus_id: String,
    pub id: u32,
    pub extended: bool,
    pub signal: String,
}

/// One value-table label a database defines, with the signal, message
/// and bus it belongs to. Separate from [`FuzzyCandidate`] because a
/// label is a statement about a *value*: on a chronological row it is
/// only true of a frame whose decoded signal carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FuzzyLabel {
    pub bus_id: String,
    pub id: u32,
    pub extended: bool,
    pub signal: String,
    pub label: String,
}

/// What kind of thing a query's best match was — its **winner kind**.
///
/// A query can name a message (its bus, either id spelling, its name or
/// its transmitting ECU), one of a message's signals, or one of a
/// signal's value-table labels. Which of the three won decides what the
/// query admits, and it rides out with the page so the trace panel can
/// open the admitted rows to the signal a signal- or value-winning
/// query names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FuzzyWinner {
    Message,
    Signal,
    Value,
}

impl FuzzyWinner {
    /// Rung on the message → signal → value ladder. A match admits when
    /// it is at least as specific as the winner; a less specific one is
    /// what [`fuzzy::MESSAGE_GATE`] judges.
    fn specificity(self) -> u8 {
        match self {
            Self::Message => 0,
            Self::Signal => 1,
            Self::Value => 2,
        }
    }

    /// Who wins an exact score tie. A **message** wins any tie: its
    /// admission is dropped only when a more specific match *outscores*
    /// it, which is what keeps a query naming a message behaving as it
    /// always has. Between a signal and one of that signal's values the
    /// **value** wins: it is the narrower reading of the same text, and
    /// it still names the signal.
    fn tie_rank(self) -> u8 {
        match self {
            Self::Message => 2,
            Self::Value => 1,
            Self::Signal => 0,
        }
    }
}

/// How a value-table label is tested against a row — the one thing the
/// two trace modes disagree about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FuzzyMatchMode {
    /// A chronological row is a *frame*: a label matches when the
    /// frame's decoded signal carries it. Searching a value therefore
    /// searches the whole history for the frames that were in it.
    #[default]
    Chronological,
    /// A by-id row is a *message*, not a frame: a label matches when
    /// the message defines a signal whose value table holds it,
    /// whatever the latest frame happens to read. Definitional, so it
    /// reads no decode.
    Definitional,
}

/// What one `fuzzy` query resolves to — the frames it admits, settled
/// once so the per-frame test is a lookup.
///
/// All three halves come out of **one** ranked list: the messages'
/// haystacks, the signal names and the value-table labels are scored
/// together and cut at the single relative floor. The top of that list
/// is the query's [`FuzzyWinner`], and it decides what the rest of the
/// list is allowed to admit:
///
/// - a match at least as specific as the winner admits;
/// - a *message* below the winner admits only if it scores at least
///   [`fuzzy::MESSAGE_GATE`] of the winner's score — without that, a
///   value query lands on the message's long haystack as a scattered
///   subsequence and admits every frame of it;
/// - any other less specific match is dropped.
///
/// One query, one ranking, one floor, one gate.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FuzzyResolution {
    /// The kind of the query's best match, `None` when nothing cleared
    /// the floor.
    winner: Option<FuzzyWinner>,
    /// Per `(id, extended)`, the buses whose message survived the cut.
    /// Answering from this needs no decode at all.
    keys: HashMap<(u32, bool), Vec<String>>,
    /// Per `(id, extended)`, the signal names that survived.
    /// Decode-free too: the database that names the signal is the one
    /// that decodes the bus, so the message does carry it.
    signals: HashMap<(u32, bool), Vec<SignalHit>>,
    /// Per `(id, extended)`, the labels that survived. The only half
    /// that reads a decode, and only in
    /// [`FuzzyMatchMode::Chronological`].
    labels: HashMap<(u32, bool), Vec<LabelHit>>,
}

/// A surviving signal-name match on one message: the bus whose
/// database names the signal, and the name.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SignalHit {
    bus_id: String,
    signal: String,
}

/// A surviving value match on one message: the bus, the signal whose
/// value table defines the label, and the label.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LabelHit {
    bus_id: String,
    signal: String,
    label: String,
}

impl FuzzyResolution {
    /// Rank `candidates`, `signals` and `labels` against `query`, keep
    /// what clears the floor, and apply the winner's gate.
    #[must_use]
    pub fn resolve(
        query: &str,
        candidates: &[FuzzyCandidate],
        signals: &[FuzzySignal],
        labels: &[FuzzyLabel],
    ) -> Self {
        let haystacks = candidates
            .iter()
            .map(|c| c.haystack.as_str())
            .chain(signals.iter().map(|s| s.signal.as_str()))
            .chain(labels.iter().map(|l| l.label.as_str()));
        let ranked = fuzzy::rank(query, haystacks);
        let kept = fuzzy::above_floor(&ranked);
        let mut out = Self::default();
        let Some(best) = kept.first().copied() else {
            return out;
        };
        let kind_of = |index: usize| {
            if index < candidates.len() {
                FuzzyWinner::Message
            } else if index < candidates.len() + signals.len() {
                FuzzyWinner::Signal
            } else {
                FuzzyWinner::Value
            }
        };
        let winner = kept
            .iter()
            .take_while(|m| m.score == best.score)
            .map(|m| kind_of(m.index))
            .max_by_key(|k| k.tie_rank())
            .unwrap_or(FuzzyWinner::Message);
        let gate = f64::from(best.score) * fuzzy::MESSAGE_GATE;
        for m in kept {
            let kind = kind_of(m.index);
            let admits = kind.specificity() >= winner.specificity()
                || (kind == FuzzyWinner::Message && f64::from(m.score) >= gate);
            if !admits {
                continue;
            }
            match kind {
                FuzzyWinner::Message => {
                    let c = &candidates[m.index];
                    out.keys
                        .entry((c.id, c.extended))
                        .or_default()
                        .push(c.bus_id.clone());
                }
                FuzzyWinner::Signal => {
                    let s = &signals[m.index - candidates.len()];
                    out.signals
                        .entry((s.id, s.extended))
                        .or_default()
                        .push(SignalHit {
                            bus_id: s.bus_id.clone(),
                            signal: s.signal.clone(),
                        });
                }
                FuzzyWinner::Value => {
                    let l = &labels[m.index - candidates.len() - signals.len()];
                    out.labels
                        .entry((l.id, l.extended))
                        .or_default()
                        .push(LabelHit {
                            bus_id: l.bus_id.clone(),
                            signal: l.signal.clone(),
                            label: l.label.clone(),
                        });
                }
            }
        }
        out.winner = Some(winner);
        out
    }

    /// Does this row's searchable text match? The message and signal
    /// halves are map lookups; the label half reads the decode the way
    /// `signal_equals` does, unless `mode` says the row is a message
    /// rather than a frame.
    ///
    /// A row with no bus is admitted by nothing — the same rule
    /// [`dbc_applies`] follows, and every stored frame has one.
    fn admits(
        &self,
        id: u32,
        extended: bool,
        bus_id: Option<&str>,
        decoded: Option<&DecodedRecord>,
        mode: FuzzyMatchMode,
    ) -> bool {
        let Some(bus) = bus_id else { return false };
        let key = (id, extended);
        self.keys
            .get(&key)
            .is_some_and(|buses| buses.iter().any(|b| b == bus))
            || self
                .signals
                .get(&key)
                .is_some_and(|v| v.iter().any(|h| h.bus_id == bus))
            || self.labels.get(&key).is_some_and(|v| {
                v.iter()
                    .any(|h| h.bus_id == bus && label_holds(mode, decoded, &h.signal, &h.label))
            })
    }

    /// The signal names this row matched by — what the trace panel
    /// opens the row's disclosure to. Empty unless the query's winner
    /// was a signal or a value: a message-level winner says nothing
    /// about any one signal, and leaves the disclosure as the user had
    /// it.
    fn matching_signals(
        &self,
        id: u32,
        extended: bool,
        bus_id: Option<&str>,
        decoded: Option<&DecodedRecord>,
        mode: FuzzyMatchMode,
    ) -> Vec<String> {
        let (Some(bus), Some(winner)) = (bus_id, self.winner) else {
            return Vec::new();
        };
        if winner == FuzzyWinner::Message {
            return Vec::new();
        }
        let key = (id, extended);
        let mut out: Vec<String> = Vec::new();
        let mut push = |name: &String| {
            if !out.contains(name) {
                out.push(name.clone());
            }
        };
        for h in self.signals.get(&key).into_iter().flatten() {
            if h.bus_id == bus {
                push(&h.signal);
            }
        }
        for h in self.labels.get(&key).into_iter().flatten() {
            if h.bus_id == bus && label_holds(mode, decoded, &h.signal, &h.label) {
                push(&h.signal);
            }
        }
        out
    }

    /// The `(id, extended)` keys this query can admit — every key any
    /// of its three halves survived on.
    fn candidate_keys(&self) -> Vec<(u32, bool)> {
        let mut keys: Vec<(u32, bool)> = self.keys.keys().copied().collect();
        keys.extend(self.signals.keys().copied());
        keys.extend(self.labels.keys().copied());
        keys
    }
}

/// Whether a surviving `(signal, label)` pair is true of a row: of a
/// frame, that it decoded to that label; of a *message* row, that the
/// message defines the label at all (it is in the list, so it does).
fn label_holds(
    mode: FuzzyMatchMode,
    decoded: Option<&DecodedRecord>,
    signal: &str,
    label: &str,
) -> bool {
    match mode {
        FuzzyMatchMode::Definitional => true,
        FuzzyMatchMode::Chronological => decoded.is_some_and(|d| {
            d.signals
                .iter()
                .any(|s| s.name == signal && s.label.as_deref() == Some(label))
        }),
    }
}

/// The standing facts predicate evaluation reads that are not on the
/// frame: each `fuzzy` leaf's [`FuzzyResolution`], and the
/// [`FuzzyMatchMode`] the consumer's rows are.
///
/// The resolutions are keyed by the query text because that is the
/// leaf's whole identity — two `fuzzy` leaves spelling the same query
/// resolve to the same thing, and a predicate carries at most a
/// handful, so a linear scan beats a hash.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MatchContext {
    fuzzy: Vec<(String, FuzzyResolution)>,
    mode: FuzzyMatchMode,
}

/// A context that resolves nothing — for the callers whose predicates
/// carry no `fuzzy` leaf. A fuzzy leaf evaluated against it matches
/// nothing, as an unresolvable predicate should. A `static` rather than
/// a `const` so call sites can hand out a `&'static` one.
pub static EMPTY_MATCH_CONTEXT: MatchContext = MatchContext {
    fuzzy: Vec::new(),
    mode: FuzzyMatchMode::Chronological,
};

impl MatchContext {
    /// An empty context whose rows are `mode`.
    #[must_use]
    pub fn with_mode(mode: FuzzyMatchMode) -> Self {
        Self {
            fuzzy: Vec::new(),
            mode,
        }
    }

    /// Record a query's resolution. A repeated query is kept once.
    pub fn insert(&mut self, query: &str, resolution: FuzzyResolution) {
        if self.resolution(query).is_none() {
            self.fuzzy.push((query.to_string(), resolution));
        }
    }

    fn resolution(&self, query: &str) -> Option<&FuzzyResolution> {
        self.fuzzy.iter().find(|(q, _)| q == query).map(|(_, r)| r)
    }

    /// The winner kind of the first `fuzzy` query in the predicate —
    /// what the trace panel's one query matched best, returned with the
    /// page so the panel need not re-derive a model fact. `None` when
    /// there is no fuzzy leaf, or when nothing cleared the floor.
    #[must_use]
    pub fn winner(&self) -> Option<FuzzyWinner> {
        self.fuzzy.first().and_then(|(_, r)| r.winner)
    }

    /// The signal names a row matched by, across every `fuzzy` leaf —
    /// what the trace panel opens the row's disclosure to. Empty
    /// unless a winner was a signal or a value: a message-level winner
    /// says nothing about any one signal, and leaves the disclosure as
    /// the user had it.
    #[must_use]
    pub fn matching_signals(
        &self,
        id: u32,
        extended: bool,
        bus_id: Option<&str>,
        decoded: Option<&DecodedRecord>,
    ) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for (_, r) in &self.fuzzy {
            for name in r.matching_signals(id, extended, bus_id, decoded, self.mode) {
                if !out.contains(&name) {
                    out.push(name);
                }
            }
        }
        out
    }

    /// The `(id, extended)` keys `query` can admit; empty when the
    /// query was never resolved into this context.
    #[must_use]
    pub fn candidate_keys(&self, query: &str) -> Vec<(u32, bool)> {
        self.resolution(query)
            .map(FuzzyResolution::candidate_keys)
            .unwrap_or_default()
    }

    /// Every id whose decode a `fuzzy` leaf in this context could read
    /// — the messages defining a matching enum label, and nothing else.
    /// Unioned into the filter index's decode gate, because
    /// [`FilterPredicate::decode_dependent_leaves`] works off the
    /// predicate alone and cannot know which ids those are.
    #[must_use]
    pub fn decode_ids(&self) -> Vec<(u32, bool)> {
        let mut out: Vec<(u32, bool)> = self
            .fuzzy
            .iter()
            .flat_map(|(_, r)| r.labels.keys().copied())
            .collect();
        out.sort_unstable();
        out.dedup();
        out
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
    /// The resolved `fuzzy` queries. Unlike the closures above this is
    /// already-computed data: a fuzzy query's match set is a cut on a
    /// ranked list, so it is resolved once for the whole predicate and
    /// read here and by [`FilterPredicate::matches_fields`] alike.
    pub fuzzy: &'a MatchContext,
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
            keys: normalize(
                ids.iter()
                    .flat_map(|&id| [(id, false), (id, true)])
                    .collect(),
            ),
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
        // The same id can occur on more than one bus and the bus name
        // is part of the haystack, so membership in the key set is not
        // the match — the per-frame test still confirms the bus (and,
        // for the enum-label half, the decoded value).
        TaggedPredicate::Fuzzy(q) => Some(CandidateSet {
            keys: normalize(inputs.fuzzy.candidate_keys(q)),
            membership: false,
        }),
        // Not narrowable by arbitration id: an error frame's id says
        // nothing about it, so the caller visits the window and the
        // per-frame test decides. `None` is exactly that instruction.
        TaggedPredicate::ErrorFrame(_) => None,
        TaggedPredicate::All(children) => resolve_all(children, inputs),
        TaggedPredicate::Any(children) => resolve_any(children, inputs),
    }
}

/// `all`: the match set is the intersection of the children's, so any
/// narrowable child bounds it; intersect the narrowable children's keys
/// (a non-narrowable child doesn't shrink the bound). Membership only
/// survives if *every* child is a narrowable membership child.
fn resolve_all(children: &[FilterPredicate], inputs: &CandidateInputs<'_>) -> Option<CandidateSet> {
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
fn resolve_any(children: &[FilterPredicate], inputs: &CandidateInputs<'_>) -> Option<CandidateSet> {
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

/// Per-bus DBC scoping test — the one statement of "which databases may
/// decode this frame", shared by the decode gate, the filter, and every
/// other consumer of a database's bus assignment.
///
/// **Bus assignment governs decode.** A database applies to a frame only
/// when the frame's bus is in the database's assigned set, so a database
/// assigned to no bus decodes nothing: loading a file makes it available,
/// assigning it to a bus makes it decode. A `None` `bus_id` is a query
/// that names no bus — a file-backed signal, which has none, or a view
/// reference saved before per-bus signal binding; a stored frame always
/// has one. No assignment can contain "no bus", so such a query is
/// admitted by nothing.
#[must_use]
pub(crate) fn dbc_applies(buses: &[String], bus_id: Option<&str>) -> bool {
    match bus_id {
        Some(b) => buses.iter().any(|x| x == b),
        None => false,
    }
}

impl TaggedPredicate {
    fn matches_fields(
        &self,
        ctx: &MatchContext,
        id: u32,
        extended: bool,
        bus_id: Option<&str>,
        is_error_frame: bool,
        decoded: Option<&DecodedRecord>,
    ) -> bool {
        match self {
            Self::All(children) => children
                .iter()
                .all(|c| c.matches_fields(ctx, id, extended, bus_id, is_error_frame, decoded)),
            Self::Any(children) => children
                .iter()
                .any(|c| c.matches_fields(ctx, id, extended, bus_id, is_error_frame, decoded)),
            Self::Bus(b) => bus_id == Some(b.as_str()),
            Self::IdRange([lo, hi]) => id >= *lo && id <= *hi,
            Self::IdList(ids) => ids.contains(&id),
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
            Self::ErrorFrame(want) => is_error_frame == *want,
            Self::Fuzzy(q) => ctx
                .resolution(q)
                .is_some_and(|r| r.admits(id, extended, bus_id, decoded, ctx.mode)),
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

    fn error_frame_on(bus_id: Option<&str>) -> RawTraceFrame {
        RawTraceFrame {
            payload: CanFramePayload::Error,
            ..frame_with(0, bus_id)
        }
    }

    #[test]
    fn error_frames_can_be_excluded_and_the_rest_of_the_trace_left_alone() {
        // What a trace view applies to show a fault's coalesced summary
        // instead of its hundred thousand rows. The capture is
        // untouched — this is a predicate over a view, and the store
        // never sees it.
        let p: FilterPredicate = serde_json::from_str(r#"{"error_frame": false}"#).unwrap();
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &error_frame_on(Some("b1")), None));
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(0x123, Some("b1")), None));
    }

    #[test]
    fn the_predicate_reads_the_other_way_round_too() {
        // The control: `true` keeps only the error frames. If `false`
        // passed everything the test above would still pass.
        let p: FilterPredicate = serde_json::from_str(r#"{"error_frame": true}"#).unwrap();
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &error_frame_on(Some("b1")), None));
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(0x123, Some("b1")), None));
    }

    #[test]
    fn an_error_frame_leaf_narrows_no_ids_and_forces_the_per_frame_test() {
        // An error frame's arbitration id says nothing about it, so
        // there is no id set to index by. `None` tells the index build
        // to visit the window; an `all` carrying one keeps whatever its
        // narrowable siblings bound it to, but loses membership so the
        // per-frame test still runs.
        let inputs = CandidateInputs {
            seen_ids: &[(1, false), (2, false)],
            seen_on_bus: &|_| vec![(1, false)],
            regex_ids: &|_| Vec::new(),
            signal_ids: &|_| Vec::new(),
            fuzzy: &EMPTY_MATCH_CONTEXT,
        };
        let lone: FilterPredicate = serde_json::from_str(r#"{"error_frame": false}"#).unwrap();
        assert_eq!(resolve_candidates(&lone, &inputs), None);

        let combined: FilterPredicate =
            serde_json::from_str(r#"{"all": [{"id_list": [1]}, {"error_frame": false}]}"#).unwrap();
        let set = resolve_candidates(&combined, &inputs).unwrap();
        assert_eq!(set.keys, vec![(1, false), (1, true)]);
        assert!(!set.membership, "the frame still has to be read");
    }

    #[test]
    fn excluding_error_frames_composes_with_a_bus_predicate() {
        // The shape the trace panel builds: its own source predicate,
        // and the exclusion ANDed onto it.
        let p: FilterPredicate =
            serde_json::from_str(r#"{"all": [{"bus": "b1"}, {"error_frame": false}]}"#).unwrap();
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(0x123, Some("b1")), None));
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &error_frame_on(Some("b1")), None));
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(0x123, Some("b2")), None));
    }

    fn decoded(name: &str, signals: &[(&str, f64)]) -> DecodedRecord {
        DecodedRecord {
            name: name.into(),
            transmitter: None,
            signals: signals
                .iter()
                .map(|(n, v)| SignalRecord {
                    name: (*n).into(),
                    value: *v,
                    unit: String::new(),
                    raw_field: false,
                    display_hex: false,
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
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, None), None));
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(0x7FF, Some("a")), None));
    }

    #[test]
    fn empty_any_rejects_everything() {
        let p = parse(r#"{"any": []}"#);
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, None), None));
    }

    #[test]
    fn bus_predicate_matches_bus_id() {
        let p = parse(r#"{"bus": "powertrain"}"#);
        assert!(p.matches(
            &EMPTY_MATCH_CONTEXT,
            &frame_with(1, Some("powertrain")),
            None
        ));
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, Some("chassis")), None));
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, None), None));
    }

    #[test]
    fn id_range_is_inclusive() {
        let p = parse(r#"{"id_range": [100, 200]}"#);
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(100, None), None));
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(150, None), None));
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(200, None), None));
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(99, None), None));
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(201, None), None));
    }

    #[test]
    fn id_list_membership() {
        let p = parse(r#"{"id_list": [1, 3, 5]}"#);
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(3, None), None));
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(2, None), None));
    }

    #[test]
    fn name_regex_matches_decoded_message_name() {
        let p = parse(r#"{"name_regex": "^EngineStatus"}"#);
        let d = decoded("EngineStatus_HS", &[]);
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, None), Some(&d)));
        let d2 = decoded("BrakeStatus", &[]);
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, None), Some(&d2)));
        // No decode -> doesn't match.
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, None), None));
    }

    #[test]
    fn signal_equals_matches_signal_value_with_epsilon() {
        let p = parse(r#"{"signal_equals": {"name": "Rpm", "value": 800}}"#);
        let d = decoded("Eng", &[("Rpm", 800.0), ("Tq", 12.0)]);
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, None), Some(&d)));
        let d2 = decoded("Eng", &[("Rpm", 800.000_000_000_1)]);
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, None), Some(&d2)));
        let d3 = decoded("Eng", &[("Rpm", 801.0)]);
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, None), Some(&d3)));
    }

    #[test]
    fn all_and_any_compose() {
        let p = parse(
            r#"{"all": [{"bus": "p"}, {"any": [{"id_range": [1, 10]}, {"id_list": [99]}]}]}"#,
        );
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(5, Some("p")), None));
        assert!(p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(99, Some("p")), None));
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(5, Some("c")), None)); // bus mismatch
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(50, Some("p")), None));
        // id mismatch
    }

    #[test]
    fn invalid_predicate_matches_nothing() {
        let p = parse(r#"{"unknown_kind": 42}"#);
        assert!(matches!(p, FilterPredicate::Invalid(_)));
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, Some("p")), None));
    }

    #[test]
    fn invalid_regex_is_a_non_match() {
        // Unclosed group.
        let p = parse(r#"{"name_regex": "("}"#);
        let d = decoded("anything", &[]);
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, None), Some(&d)));
        // Still a non-match on the (cached) second evaluation.
        assert!(!p.matches(&EMPTY_MATCH_CONTEXT, &frame_with(1, None), Some(&d)));
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
            fuzzy: &EMPTY_MATCH_CONTEXT,
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
        let regex = |p: &str| {
            if p == "^Eng" {
                vec![(0x10, false)]
            } else {
                vec![]
            }
        };
        let signal = |n: &str| {
            if n == "Rpm" {
                vec![(0x10, false)]
            } else {
                vec![]
            }
        };
        let inp = inputs(&[], &none, &regex, &signal);
        let nr = resolve_candidates(&parse(r#"{"name_regex": "^Eng"}"#), &inp).unwrap();
        assert!(!nr.membership);
        assert_eq!(nr.keys, vec![(0x10, false)]);
        let se = resolve_candidates(
            &parse(r#"{"signal_equals":{"name":"Rpm","value":1}}"#),
            &inp,
        )
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
        assert!(
            resolve_candidates(&parse(r#"{"any": [{"id_list": [1]}, {"all": []}]}"#), &inp,)
                .is_none()
        );
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

    #[test]
    fn matches_fields_agrees_with_matches_over_raw_and_decoded_leaves() {
        // The field-view entry point (used by the decoded-record fetch
        // path) must return exactly what the RawTraceFrame path does, for
        // both raw leaves (bus / id) and decode-dependent leaves
        // (name_regex / signal_equals).
        let d = decoded("EngineStatus", &[("Rpm", 800.0)]);
        for (pred, id, bus, dec) in [
            (r#"{"bus": "p"}"#, 5u32, Some("p"), None),
            (r#"{"bus": "p"}"#, 5, Some("c"), None),
            (r#"{"id_range": [1, 10]}"#, 5, None, None),
            (r#"{"id_list": [5, 7]}"#, 5, None, None),
            (r#"{"name_regex": "^Engine"}"#, 5, None, Some(&d)),
            (r#"{"name_regex": "^Engine"}"#, 5, None, None),
            (
                r#"{"signal_equals": {"name": "Rpm", "value": 800}}"#,
                5,
                None,
                Some(&d),
            ),
            (r#"{"error_frame": false}"#, 5, None, None),
            (r#"{"error_frame": true}"#, 5, None, None),
        ] {
            let p = parse(pred);
            let frame = frame_with(id, bus);
            assert_eq!(
                p.matches_fields(&EMPTY_MATCH_CONTEXT, id, false, bus, false, dec),
                p.matches(&EMPTY_MATCH_CONTEXT, &frame, dec),
                "field-view disagreed for {pred} id={id} bus={bus:?}",
            );
        }
    }

    // ---- the `fuzzy` leaf --------------------------------------

    /// Three messages on two buses, as the host spells their
    /// searchable text: the message's own haystack (bus name, both id
    /// spellings, message name, transmitting ECU), its signal names,
    /// and its signals' value-table labels — three lists, ranked as
    /// one.
    fn fuzzy_fixture() -> (Vec<FuzzyCandidate>, Vec<FuzzySignal>, Vec<FuzzyLabel>) {
        let candidates = vec![
            FuzzyCandidate {
                bus_id: "b1".into(),
                id: 0x400,
                extended: false,
                haystack: "Zonal CAN s:400 s:1024 DoorLockStatus BodyGateway".into(),
            },
            FuzzyCandidate {
                bus_id: "b2".into(),
                id: 0x400,
                extended: false,
                haystack: "Pack CAN s:400 s:1024 PackStatus BMS".into(),
            },
            FuzzyCandidate {
                bus_id: "b1".into(),
                id: 0x401,
                extended: true,
                haystack: "Zonal CAN x:00000401 x:1025 WheelSpeed ZoneFrontLeft".into(),
            },
        ];
        let signals = vec![
            FuzzySignal {
                bus_id: "b1".into(),
                id: 0x400,
                extended: false,
                signal: "LockState".into(),
            },
            FuzzySignal {
                bus_id: "b2".into(),
                id: 0x400,
                extended: false,
                signal: "PackVoltage".into(),
            },
            FuzzySignal {
                bus_id: "b1".into(),
                id: 0x401,
                extended: true,
                signal: "Speed".into(),
            },
        ];
        let labels = vec![
            FuzzyLabel {
                bus_id: "b1".into(),
                id: 0x400,
                extended: false,
                signal: "LockState".into(),
                label: "DoubleLocked".into(),
            },
            FuzzyLabel {
                bus_id: "b1".into(),
                id: 0x400,
                extended: false,
                signal: "LockState".into(),
                label: "Unlocked".into(),
            },
        ];
        (candidates, signals, labels)
    }

    fn fuzzy_ctx(query: &str) -> MatchContext {
        let (candidates, signals, labels) = fuzzy_fixture();
        let mut ctx = MatchContext::default();
        ctx.insert(
            query,
            FuzzyResolution::resolve(query, &candidates, &signals, &labels),
        );
        ctx
    }

    #[test]
    fn a_fuzzy_leaf_round_trips_as_a_plain_query_string() {
        let p = parse(r#"{"fuzzy": "doorlock"}"#);
        assert_eq!(
            p,
            FilterPredicate::Tagged(TaggedPredicate::Fuzzy("doorlock".into())),
        );
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"fuzzy":"doorlock"}"#
        );
    }

    #[test]
    fn a_fuzzy_query_finds_a_frame_by_message_name_and_leaves_its_neighbour() {
        let p = parse(r#"{"fuzzy": "doorlock"}"#);
        let ctx = fuzzy_ctx("doorlock");
        assert!(p.matches_fields(&ctx, 0x400, false, Some("b1"), false, None));
        // Same id, other bus, other message — not this query's frame.
        assert!(!p.matches_fields(&ctx, 0x400, false, Some("b2"), false, None));
        assert!(!p.matches_fields(&ctx, 0x401, true, Some("b1"), false, None));
    }

    #[test]
    fn a_fuzzy_query_finds_a_frame_by_bus_name_id_spelling_ecu_and_signal() {
        // Every id-keyed part of the haystack the ruling names, one
        // query each, on the frame it should reach.
        for (query, id, extended, bus) in [
            ("pack can", 0x400u32, false, "b2"),
            ("x:00000401", 0x401, true, "b1"),
            ("s:1024", 0x400, false, "b1"),
            ("bodygateway", 0x400, false, "b1"),
            ("packvoltage", 0x400, false, "b2"),
        ] {
            let p = parse(&format!(r#"{{"fuzzy": "{query}"}}"#));
            let ctx = fuzzy_ctx(query);
            assert!(
                p.matches_fields(&ctx, id, extended, Some(bus), false, None),
                "query {query:?} missed the frame it names",
            );
        }
    }

    #[test]
    fn an_enum_label_query_needs_the_decoded_value_to_be_that_label() {
        // The decode-dependent half: the label resolves to a
        // (signal, label) pair and the frame is tested the way
        // `signal_equals` tests a value.
        let p = parse(r#"{"fuzzy": "doublelocked"}"#);
        let ctx = fuzzy_ctx("doublelocked");
        let mut hit = decoded("DoorLockStatus", &[("LockState", 2.0)]);
        hit.signals[0].label = Some("DoubleLocked".into());
        let mut miss = decoded("DoorLockStatus", &[("LockState", 0.0)]);
        miss.signals[0].label = Some("Unlocked".into());

        assert!(p.matches_fields(&ctx, 0x400, false, Some("b1"), false, Some(&hit)));
        assert!(!p.matches_fields(&ctx, 0x400, false, Some("b1"), false, Some(&miss)));
        // No decode at all: the label cannot be the frame's value.
        assert!(!p.matches_fields(&ctx, 0x400, false, Some("b1"), false, None));
    }

    #[test]
    fn a_fuzzy_leaf_with_no_resolution_in_the_context_matches_nothing() {
        // Same rule an unparseable predicate follows — a filter that
        // cannot be resolved narrows to nothing rather than silently
        // widening the view.
        let p = parse(r#"{"fuzzy": "doorlock"}"#);
        assert!(!p.matches_fields(&EMPTY_MATCH_CONTEXT, 0x400, false, Some("b1"), false, None));
        // A context resolved for a *different* query is no better.
        let ctx = fuzzy_ctx("packvoltage");
        assert!(!p.matches_fields(&ctx, 0x400, false, Some("b1"), false, None));
    }

    #[test]
    fn one_ranking_and_one_floor_cover_every_part_of_the_haystack() {
        // Messages, signal names and labels are ranked together, so a
        // query that lands squarely on a message name does not also
        // drag in a loosely-matching signal or label.
        let (candidates, signals, labels) = fuzzy_fixture();
        let r = FuzzyResolution::resolve("doorlockstatus", &candidates, &signals, &labels);
        assert_eq!(r.winner, Some(FuzzyWinner::Message));
        assert_eq!(r.candidate_keys(), vec![(0x400, false)]);
        assert!(r.labels.is_empty(), "no label clears the floor here");
        // And the other way: a label query brings its message in as a
        // decode candidate without admitting every frame of it.
        let r = FuzzyResolution::resolve("doublelocked", &candidates, &signals, &labels);
        assert_eq!(r.winner, Some(FuzzyWinner::Value));
        assert_eq!(
            r.labels.keys().copied().collect::<Vec<_>>(),
            vec![(0x400, false)]
        );
        assert!(r.keys.is_empty());
        // A signal name is a match in its own right, and it does not
        // drag its message's other frames in behind it.
        let r = FuzzyResolution::resolve("packvoltage", &candidates, &signals, &labels);
        assert_eq!(r.winner, Some(FuzzyWinner::Signal));
        assert_eq!(
            r.signals.keys().copied().collect::<Vec<_>>(),
            vec![(0x400, false)]
        );
        assert!(r.keys.is_empty(), "the message lost to its own signal");
    }

    #[test]
    fn a_fuzzy_leaf_narrows_to_its_keys_but_still_needs_the_per_frame_test() {
        // The same id occurs on two buses and the bus name is part of
        // the haystack, so membership in the key set is not the match.
        let none = |_: &str| Vec::new();
        let ctx = fuzzy_ctx("doorlock");
        let inp = CandidateInputs {
            seen_ids: &[],
            seen_on_bus: &none,
            regex_ids: &none,
            signal_ids: &none,
            fuzzy: &ctx,
        };
        let set = resolve_candidates(&parse(r#"{"fuzzy": "doorlock"}"#), &inp).unwrap();
        assert_eq!(set.keys, vec![(0x400, false)]);
        assert!(!set.membership, "the bus still has to be confirmed");
        // A query the context never resolved narrows to the empty set
        // rather than to everything.
        let set = resolve_candidates(&parse(r#"{"fuzzy": "other"}"#), &inp).unwrap();
        assert!(set.keys.is_empty());
    }

    #[test]
    fn only_the_enum_label_half_of_a_fuzzy_leaf_asks_for_a_decode() {
        // The id-keyed half is answered by a lookup, so naming a
        // message must not drag its frames through the decoder; naming
        // one of its labels must.
        let (candidates, signals, labels) = fuzzy_fixture();
        let mut ctx = MatchContext::default();
        ctx.insert(
            "doorlockstatus",
            FuzzyResolution::resolve("doorlockstatus", &candidates, &signals, &labels),
        );
        assert!(ctx.decode_ids().is_empty());
        // A signal name is answered by a lookup too.
        let mut ctx = MatchContext::default();
        ctx.insert(
            "packvoltage",
            FuzzyResolution::resolve("packvoltage", &candidates, &signals, &labels),
        );
        assert!(ctx.decode_ids().is_empty());

        let mut ctx = MatchContext::default();
        ctx.insert(
            "doublelocked",
            FuzzyResolution::resolve("doublelocked", &candidates, &signals, &labels),
        );
        assert_eq!(ctx.decode_ids(), vec![(0x400, false)]);
    }

    #[test]
    fn fuzzy_queries_are_collected_from_anywhere_in_the_tree() {
        let p = parse(
            r#"{"all": [
                {"bus": "b1"},
                {"fuzzy": "doorlock"},
                {"any": [{"id_list": [1]}, {"fuzzy": "packvoltage"}]}
            ]}"#,
        );
        assert_eq!(p.fuzzy_queries(), vec!["doorlock", "packvoltage"]);
        assert!(parse(r#"{"bus": "b1"}"#).fuzzy_queries().is_empty());
    }

    #[test]
    fn a_fuzzy_leaf_ands_into_the_panels_existing_narrowing() {
        // The shape the trace panel builds: its sources filter, the
        // error-frame exclusion, and the query.
        let p = parse(r#"{"all": [{"bus": "b1"}, {"error_frame": false}, {"fuzzy": "doorlock"}]}"#);
        let ctx = fuzzy_ctx("doorlock");
        assert!(p.matches_fields(&ctx, 0x400, false, Some("b1"), false, None));
        assert!(!p.matches_fields(&ctx, 0x400, false, Some("b1"), true, None));
        assert!(!p.matches_fields(&ctx, 0x401, true, Some("b1"), false, None));
    }

    #[test]
    fn a_database_assigned_to_no_bus_decodes_nothing() {
        // Assignment is the decode boundary: an empty bus list is "this
        // database is applied to nothing", not "applied to everything".
        assert!(!dbc_applies(&[], Some("p")));
        assert!(!dbc_applies(&[], None));
    }

    #[test]
    fn dbc_applies_honours_scoping() {
        // Assigned: only frames on a listed bus; a bus-less query never
        // matches.
        let buses = vec!["p".to_string(), "c".to_string()];
        assert!(dbc_applies(&buses, Some("p")));
        assert!(dbc_applies(&buses, Some("c")));
        assert!(!dbc_applies(&buses, Some("x")));
        assert!(!dbc_applies(&buses, None));
    }
}
