//! **Math signals**: user-authored series computed from other signals.
//!
//! A math signal is a fourth [decode
//! provenance](crate::signal_cache) beside DBC-backed and file-backed
//! series — "provenance decides the fill, and only the fill". Its
//! samples are computed from its *operands'* level-0 series rather than
//! decoded from frames or read out of a capture file; everything
//! downstream is the same store, the same pyramid, the same paged serve
//! and the same persistence.
//!
//! This module holds the **definitions** — what a math signal is — and
//! the registry that owns them. [`crate::math_kernels`] holds the
//! arithmetic, and `signal_cache` holds the fill that drives it.
//!
//! ## Identity
//!
//! A definition carries a **stable id**, minted once and never reused.
//! The display name is mutable, so a rename must not invalidate a
//! pyramid, break a plot's stored series or orphan a project's
//! reference — the same split ADR 0038 draws between a signal's
//! canonical path (what it is called) and its descriptor key (what it
//! is). The series key of a math signal is its id in the signal slot
//! under provenance flag `m` ([`math_identity`]).
//!
//! ## Membership
//!
//! A *set* function's operands are **manual picks ∪ live regex
//! matches** over the canonical signal path `bus/ecu/message/signal`
//! (ADR 0038) — the plot-area filter-mode model of ADR 0020. A signal
//! that starts matching the pattern joins the set on its own, which
//! moves the definition's fingerprint and so rebuilds the series.
//!
//! ## Fingerprint
//!
//! A math series' fingerprint is **compositional**: the function, its
//! parameters, the resolved operand list, and each operand's own
//! fingerprint ([`crate::signal_fingerprint`]). So a DBC edit under an
//! operand — or a redefinition of an operand that is itself a math
//! signal — moves this fingerprint too, and the dependent pyramid parks
//! exactly as an encoding change parks a decoded one (ADR 0047, ADR
//! 0054).
//!
//! ## Cycles
//!
//! Math signals may take other math signals as operands. A definition
//! that would make a math signal reach itself is **refused when it is
//! defined**, so no serve can ever meet one.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Which statistic [`MathFunction::Statistic`] reduces a capture to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Statistic {
    Min,
    Max,
    Mean,
    Median,
    /// The percentile named by [`MathFunction::Statistic`]'s
    /// `percentile` field, nearest-rank over the sorted samples.
    Percentile,
}

/// How many operands a function takes — what an editor prepopulates
/// its operand sections from, and what [`MathDefinition::validate`]
/// checks a definition against.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arity {
    /// No operand at all — a user-authored constant.
    None,
    /// Exactly one signal.
    One,
    /// Exactly two, in order: A then B.
    Pair,
    /// One or more, unordered — the set functions, whose membership is
    /// manual picks ∪ live pattern matches.
    Set,
}

/// The math function set.
///
/// Parameters live **in the variant** rather than in a side map, so a
/// definition cannot carry a parameter its function does not read, and
/// a function cannot be missing one it does.
///
/// Every variant is pointwise over the operands' shared timeline except
/// the four that are not, and each of those is called out where it is
/// implemented ([`crate::math_kernels`]):
///
/// - [`Self::ExpFilter`] is a **sequential recurrence**, so it must run
///   over the raw level-0 series. Its output would otherwise depend on
///   the zoom the caller happened to ask at.
/// - [`Self::Integration`] accumulates.
/// - [`Self::Duty`] and [`Self::Frequency`] read a trailing window.
/// - [`Self::Statistic`] reduces the whole capture to one value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MathFunction {
    /// Σ of the set.
    Sum,
    /// Π of the set.
    Product,
    /// A − B.
    Difference,
    /// gain·x + offset. Distinct from a plot series' *display* gain and
    /// offset: this mints a new series, which is what makes it a math
    /// function rather than a view transform.
    Scale { gain: f64, offset: f64 },
    /// Pointwise minimum of the set — the time-varying lower envelope,
    /// not one number over the capture.
    Min,
    /// Pointwise maximum of the set.
    Max,
    /// Pointwise arithmetic mean of the set.
    Average,
    /// Pointwise median of the set. Even memberships take the mean of
    /// the two middle values.
    Median,
    /// Pointwise max − min of the set.
    Range,
    /// First-order exponential filter with time constant `tau_seconds`.
    #[serde(rename = "expfilter")]
    ExpFilter { tau_seconds: f64 },
    /// Running integral of the operand, held between samples. The
    /// result's unit is the operand's with `·s` appended.
    Integration,
    /// Percentage of the trailing `window_seconds` the operand spent
    /// above `threshold`.
    Duty { threshold: f64, window_seconds: f64 },
    /// Rising crossings of `threshold` per second over the trailing
    /// `window_seconds`.
    Frequency { threshold: f64, window_seconds: f64 },
    /// One statistic over every sample so far — a capture-constant
    /// series, drawn as a horizontal line.
    Statistic {
        statistic: Statistic,
        /// Read only when `statistic` is [`Statistic::Percentile`], as
        /// a percentage in `[0, 100]`.
        percentile: f64,
    },
    /// Instantaneous √(x²), i.e. |x|. Smoothing is composed by the
    /// user downstream (an exponential filter over this yields a
    /// rectified average, not a windowed RMS).
    Rms,
    /// A user-authored constant. The zero-operand math channel; it
    /// draws as data (solid), not as extrapolation.
    #[serde(rename = "hline")]
    HLine { value: f64 },
}

impl MathFunction {
    /// The wire/persistence discriminant — the same string the `kind`
    /// tag serialises as, so a listing can name a function without
    /// round-tripping the whole variant.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Sum => "sum",
            Self::Product => "product",
            Self::Difference => "difference",
            Self::Scale { .. } => "scale",
            Self::Min => "min",
            Self::Max => "max",
            Self::Average => "average",
            Self::Median => "median",
            Self::Range => "range",
            Self::ExpFilter { .. } => "expfilter",
            Self::Integration => "integration",
            Self::Duty { .. } => "duty",
            Self::Frequency { .. } => "frequency",
            Self::Statistic { .. } => "statistic",
            Self::Rms => "rms",
            Self::HLine { .. } => "hline",
        }
    }

    /// This function's parameters as an ordered, fixed-width vector —
    /// the canonical form [`crate::signal_fingerprint::math_encoding`]
    /// mixes.
    ///
    /// A vector rather than the serialised variant because a
    /// fingerprint must be stable across Rust and serde versions (see
    /// that module's docs): the length and the order are the variant's,
    /// spelled here once, and a selected statistic is its own ordinal.
    #[must_use]
    pub fn parameters(&self) -> Vec<f64> {
        match self {
            Self::Sum
            | Self::Product
            | Self::Difference
            | Self::Min
            | Self::Max
            | Self::Average
            | Self::Median
            | Self::Range
            | Self::Integration
            | Self::Rms => Vec::new(),
            Self::Scale { gain, offset } => vec![*gain, *offset],
            Self::ExpFilter { tau_seconds } => vec![*tau_seconds],
            Self::Duty {
                threshold,
                window_seconds,
            }
            | Self::Frequency {
                threshold,
                window_seconds,
            } => vec![*threshold, *window_seconds],
            Self::Statistic {
                statistic,
                percentile,
            } => vec![f64::from(*statistic as u8), *percentile],
            Self::HLine { value } => vec![*value],
        }
    }

    /// How many operands this function takes.
    #[must_use]
    pub fn arity(&self) -> Arity {
        match self {
            Self::Sum
            | Self::Product
            | Self::Min
            | Self::Max
            | Self::Average
            | Self::Median
            | Self::Range => Arity::Set,
            Self::Difference => Arity::Pair,
            Self::Scale { .. }
            | Self::ExpFilter { .. }
            | Self::Integration
            | Self::Duty { .. }
            | Self::Frequency { .. }
            | Self::Statistic { .. }
            | Self::Rms => Arity::One,
            Self::HLine { .. } => Arity::None,
        }
    }

    /// The unit this function produces where the user has not named
    /// one, given the operands' units (`None` for an operand whose own
    /// unit is unknown or empty).
    ///
    /// Three rules, and nothing else guesses:
    ///
    /// - a function whose result is a **fixed** physical quantity
    ///   states it: duty is `%`, frequency is `Hz`;
    /// - **integration** appends `·s` to the operand's unit;
    /// - everything else inherits the operand unit when every operand
    ///   agrees on one, and yields nothing when they disagree — a sum
    ///   of volts and amps has no unit anyone can name.
    ///
    /// A product of two different units is deliberately *not* composed
    /// (`V` · `A` is not `V·A` to this function): the user names it.
    #[must_use]
    pub fn derived_unit(&self, operand_units: &[Option<&str>]) -> Option<String> {
        match self {
            Self::Duty { .. } => return Some("%".to_string()),
            Self::Frequency { .. } => return Some("Hz".to_string()),
            _ => {}
        }
        let mut units = operand_units.iter().map(|u| u.filter(|s| !s.is_empty()));
        let first = units.next().flatten()?;
        if !units.all(|u| u == Some(first)) {
            return None;
        }
        match self {
            Self::Integration => Some(format!("{first}·s")),
            _ => Some(first.to_string()),
        }
    }
}

/// A reference to one operand series, mirroring the series key's four
/// fields plus its provenance flag — so an operand may be a DBC-backed
/// signal, a file-backed one, or another math signal.
///
/// When `math` is set, `signal_name` is the operand definition's
/// **stable id**: an operand survives the rename of what it points at
/// (ADR 0038's split between the path and the key).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MathOperandRef {
    /// The bus the operand decodes from. `None` for a file-backed or
    /// math operand, neither of which has one.
    #[serde(default)]
    pub bus_id: Option<String>,
    /// The message id — or, file-backed, the source file's signal
    /// channel group index. Zero and meaningless for a math operand.
    #[serde(default)]
    pub message_id: u32,
    #[serde(default)]
    pub extended: bool,
    /// The signal name — or, for a math operand, the referenced
    /// definition's stable id.
    pub signal_name: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub file_backed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub math: bool,
}

impl MathOperandRef {
    /// A reference to another math signal by its stable id.
    #[must_use]
    pub fn math(id: impl Into<String>) -> Self {
        Self {
            bus_id: None,
            message_id: 0,
            extended: false,
            signal_name: id.into(),
            file_backed: false,
            math: true,
        }
    }

    /// A reference to a DBC-backed signal.
    #[must_use]
    pub fn dbc(bus_id: impl Into<String>, message_id: u32, extended: bool, name: &str) -> Self {
        Self {
            bus_id: Some(bus_id.into()),
            message_id,
            extended,
            signal_name: name.to_string(),
            file_backed: false,
            math: false,
        }
    }

    /// A reference to a file-backed signal in signal channel group
    /// `group`.
    #[must_use]
    pub fn file(group: u32, name: &str) -> Self {
        Self {
            bus_id: None,
            message_id: group,
            extended: false,
            signal_name: name.to_string(),
            file_backed: false,
            math: false,
        }
        .with_file_backed()
    }

    fn with_file_backed(mut self) -> Self {
        self.file_backed = true;
        self
    }

    /// The definition id this reference names, or `None` when it names
    /// a signal rather than a math series.
    #[must_use]
    pub fn math_id(&self) -> Option<&str> {
        self.math.then_some(self.signal_name.as_str())
    }
}

/// What a definition selects: manual picks, plus — for a set function —
/// the live regex patterns whose matches join them (ADR 0020).
///
/// Picks are **ordered** because two functions read the order:
/// `difference` takes A − B, and a listing shows the set in the order
/// the user built it. Pattern matches are appended after the picks in
/// canonical-path order, so resolution is deterministic.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MathOperands {
    #[serde(default)]
    pub picks: Vec<MathOperandRef>,
    /// Regex patterns over the canonical signal path (ADR 0038).
    /// Meaningful only for [`Arity::Set`]; a definition of any other
    /// arity carries none.
    #[serde(default)]
    pub patterns: Vec<String>,
}

/// One math signal, as it is defined and as it persists.
///
/// This is the record the project file stores and the registry owns.
/// It holds no samples and no resolved membership: both are derived,
/// the first by the signal cache and the second by
/// [`MathModel::resolve`] against the live catalog.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MathDefinition {
    /// Stable, never reused. Persistence and every operand reference
    /// are keyed on it, so a rename is free.
    pub id: String,
    /// The user's display name. No heuristic ever writes one from a
    /// selection; a pattern-only set may default to `fn(pattern)`,
    /// which [`default_name`] spells.
    pub name: String,
    /// The unit the user typed. `None` means "derive it" —
    /// [`MathFunction::derived_unit`] over the operands' units.
    #[serde(default)]
    pub unit: Option<String>,
    pub function: MathFunction,
    #[serde(default)]
    pub operands: MathOperands,
}

/// Why a definition was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MathError {
    /// No definition carries this id.
    NoSuchDefinition(String),
    /// The id is already taken.
    DuplicateId(String),
    /// The function's arity is not satisfied: `needed` describes what
    /// it wants, `got` how many operands the definition offers.
    Arity {
        function: &'static str,
        needed: &'static str,
        got: usize,
    },
    /// A pattern does not compile.
    BadPattern { pattern: String, message: String },
    /// Only a set function's membership may be widened by a pattern.
    PatternsNotAllowed { function: &'static str },
    /// The definition would make a math signal reach itself. `chain`
    /// names the cycle in the order it was walked, starting and ending
    /// at the same id.
    Cycle { chain: Vec<String> },
    /// An operand names a math definition that does not exist.
    UnknownOperand { id: String },
    /// A parameter is outside the range its function can use.
    BadParameter {
        function: &'static str,
        parameter: &'static str,
        message: String,
    },
}

impl std::fmt::Display for MathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoSuchDefinition(id) => write!(f, "no math signal with id {id}"),
            Self::DuplicateId(id) => write!(f, "a math signal with id {id} already exists"),
            Self::Arity {
                function,
                needed,
                got,
            } => write!(f, "{function} needs {needed}, got {got}"),
            Self::BadPattern { pattern, message } => {
                write!(f, "pattern {pattern:?} does not compile: {message}")
            }
            Self::PatternsNotAllowed { function } => {
                write!(f, "{function} does not take a pattern-defined set")
            }
            Self::Cycle { chain } => {
                write!(f, "that would make a cycle: {}", chain.join(" → "))
            }
            Self::UnknownOperand { id } => {
                write!(f, "operand names no math signal: {id}")
            }
            Self::BadParameter {
                function,
                parameter,
                message,
            } => write!(f, "{function}'s {parameter} {message}"),
        }
    }
}

impl std::error::Error for MathError {}

impl serde::Serialize for MathError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// The default display name for a **pattern-only** set: `fn(pattern)`,
/// the form the owner's rulings name (`max(Cell\d+)`).
///
/// Nothing else gets a derived name. A manually-picked set, a pair and
/// a single-operand function are all named by the user, because a name
/// composed from a selection reads as authoritative while being a
/// guess.
#[must_use]
pub fn default_name(function: &MathFunction, patterns: &[String]) -> Option<String> {
    match patterns {
        [one] => Some(format!("{}({one})", function.kind())),
        _ => None,
    }
}

impl MathDefinition {
    /// Check everything about this definition that does not depend on
    /// the other definitions: arity, parameter ranges and pattern
    /// compilation. Cycles need the whole set and are checked by
    /// [`MathRegistry`].
    pub fn validate(&self) -> Result<(), MathError> {
        let function = self.function.kind();
        let picks = self.operands.picks.len();
        let patterns = self.operands.patterns.len();
        match self.function.arity() {
            Arity::None => {
                if picks + patterns > 0 {
                    return Err(MathError::Arity {
                        function,
                        needed: "no operands",
                        got: picks,
                    });
                }
            }
            Arity::One => {
                if picks != 1 {
                    return Err(MathError::Arity {
                        function,
                        needed: "exactly one signal",
                        got: picks,
                    });
                }
                if patterns > 0 {
                    return Err(MathError::PatternsNotAllowed { function });
                }
            }
            Arity::Pair => {
                if picks != 2 {
                    return Err(MathError::Arity {
                        function,
                        needed: "exactly two signals, A and B",
                        got: picks,
                    });
                }
                if patterns > 0 {
                    return Err(MathError::PatternsNotAllowed { function });
                }
            }
            Arity::Set => {
                if picks == 0 && patterns == 0 {
                    return Err(MathError::Arity {
                        function,
                        needed: "at least one signal or a pattern",
                        got: 0,
                    });
                }
            }
        }
        for pattern in &self.operands.patterns {
            regex::Regex::new(pattern).map_err(|e| MathError::BadPattern {
                pattern: pattern.clone(),
                message: e.to_string(),
            })?;
        }
        self.validate_parameters()
    }

    fn validate_parameters(&self) -> Result<(), MathError> {
        let function = self.function.kind();
        let finite = |parameter: &'static str, v: f64| {
            v.is_finite().then_some(()).ok_or(MathError::BadParameter {
                function,
                parameter,
                message: "must be a finite number".to_string(),
            })
        };
        match &self.function {
            MathFunction::Scale { gain, offset } => {
                finite("gain", *gain)?;
                finite("offset", *offset)?;
            }
            MathFunction::HLine { value } => finite("value", *value)?,
            MathFunction::ExpFilter { tau_seconds } => {
                finite("τ", *tau_seconds)?;
                if *tau_seconds <= 0.0 {
                    return Err(MathError::BadParameter {
                        function,
                        parameter: "τ",
                        message: "must be greater than zero".to_string(),
                    });
                }
            }
            MathFunction::Duty {
                threshold,
                window_seconds,
            }
            | MathFunction::Frequency {
                threshold,
                window_seconds,
            } => {
                finite("threshold", *threshold)?;
                finite("window", *window_seconds)?;
                if *window_seconds <= 0.0 {
                    return Err(MathError::BadParameter {
                        function,
                        parameter: "window",
                        message: "must be greater than zero".to_string(),
                    });
                }
            }
            MathFunction::Statistic {
                statistic: Statistic::Percentile,
                percentile,
            } => {
                finite("percentile", *percentile)?;
                if !(0.0..=100.0).contains(percentile) {
                    return Err(MathError::BadParameter {
                        function,
                        parameter: "percentile",
                        message: "must be between 0 and 100".to_string(),
                    });
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// One catalog entry a pattern may match: a signal reference and the
/// canonical path (ADR 0038) patterns are evaluated against.
///
/// The host builds this from the same model that answers decode
/// queries, so a pattern selects the same signals here as it does in
/// a signal view (ADR 0025 — regex evaluation is the model's job).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MathCatalogEntry {
    pub reference: MathOperandRef,
    pub path: String,
    /// The signal's unit, for [`MathFunction::derived_unit`]. Empty
    /// where the database names none.
    pub unit: String,
}

/// One definition with its membership resolved against a live catalog.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedMath {
    pub definition: MathDefinition,
    /// Manual picks, then pattern matches in canonical-path order,
    /// deduped. This is what the fill reads and what the fingerprint
    /// covers — so a signal that starts matching the pattern rebuilds
    /// the series rather than being quietly left out.
    pub operands: Vec<MathOperandRef>,
    /// Each resolved operand's canonical path (ADR 0038),
    /// index-parallel with [`Self::operands`]. Empty for an operand the
    /// catalog no longer holds — a signal whose database was unloaded,
    /// or a deleted math definition — which is how an editor shows a
    /// missing operand without re-deriving anything.
    pub operand_paths: Vec<String>,
    /// The unit the series carries: the user's, or the derived one.
    pub unit: String,
}

/// Every math definition with its membership resolved — the per-serve
/// snapshot the signal cache reads.
///
/// Built once against the live catalog and shared for the length of a
/// serve, the way [`crate::signal_fingerprint::DecodeModel`] is: the
/// membership of a set must not move between two series of the same
/// batch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MathModel {
    by_id: HashMap<String, ResolvedMath>,
    /// Ids in registry order, so a listing is stable.
    order: Vec<String>,
}

impl MathModel {
    /// Resolve `definitions` against `catalog`: each set function's
    /// membership becomes its picks plus every catalog entry whose
    /// canonical path matches one of its patterns.
    ///
    /// A math definition never matches its own patterns, and a match
    /// that would close a cycle is dropped rather than refused — the
    /// pattern is live, so a signal appearing under it must not be able
    /// to break a definition the user already has (cycles a *user*
    /// writes are refused at definition time instead).
    ///
    /// An uncompilable pattern contributes nothing.
    /// [`MathDefinition::validate`] rejects one at definition time, so
    /// this only covers a project file edited by hand.
    #[must_use]
    pub fn resolve(definitions: &[MathDefinition], catalog: &[MathCatalogEntry]) -> Self {
        let mut model = Self::default();
        // Every definition, membership empty, so cycle checks below can
        // walk the whole graph while it is being built.
        let picks: HashMap<&str, &[MathOperandRef]> = definitions
            .iter()
            .map(|d| (d.id.as_str(), d.operands.picks.as_slice()))
            .collect();
        for definition in definitions {
            let mut operands = definition.operands.picks.clone();
            if definition.function.arity() == Arity::Set {
                let mut seen: HashSet<MathOperandRef> = operands.iter().cloned().collect();
                let mut matched: Vec<&MathCatalogEntry> = Vec::new();
                for pattern in &definition.operands.patterns {
                    let Ok(re) = regex::Regex::new(pattern) else {
                        continue;
                    };
                    for entry in catalog {
                        if entry.reference.math_id() == Some(definition.id.as_str()) {
                            continue;
                        }
                        if re.is_match(&entry.path) && !seen.contains(&entry.reference) {
                            seen.insert(entry.reference.clone());
                            matched.push(entry);
                        }
                    }
                }
                matched.sort_by(|a, b| a.path.cmp(&b.path));
                for entry in matched {
                    if reaches(&picks, &entry.reference, &definition.id) {
                        continue;
                    }
                    operands.push(entry.reference.clone());
                }
            }
            let units: Vec<Option<&str>> = operands
                .iter()
                .map(|r| operand_unit(r, catalog, definitions))
                .collect();
            let operand_paths: Vec<String> = operands
                .iter()
                .map(|r| {
                    catalog
                        .iter()
                        .find(|e| &e.reference == r)
                        .map(|e| e.path.clone())
                        .unwrap_or_default()
                })
                .collect();
            let unit = definition
                .unit
                .clone()
                .filter(|u| !u.is_empty())
                .or_else(|| definition.function.derived_unit(&units))
                .unwrap_or_default();
            model.order.push(definition.id.clone());
            model.by_id.insert(
                definition.id.clone(),
                ResolvedMath {
                    definition: definition.clone(),
                    operands,
                    operand_paths,
                    unit,
                },
            );
        }
        model
    }

    /// The resolved definition with this id.
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&ResolvedMath> {
        self.by_id.get(id)
    }

    /// Every resolved definition, in registry order.
    pub fn iter(&self) -> impl Iterator<Item = &ResolvedMath> {
        self.order.iter().filter_map(|id| self.by_id.get(id))
    }

    /// Whether this model holds no definitions — the state almost every
    /// project is in, and the one every serve checks before doing any
    /// math work at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// `id`'s operands, then *their* math operands, and so on —
    /// dependencies before dependents, each id once.
    ///
    /// This is the order a fill must run in: an operand's level-0
    /// series has to be complete before the series above it reads it.
    /// A cycle is unrepresentable here (the registry refuses one), and
    /// the walk is defensive against one anyway rather than looping.
    #[must_use]
    pub fn dependency_order(&self, ids: &[String]) -> Vec<String> {
        let mut out = Vec::new();
        let mut done: HashSet<String> = HashSet::new();
        let mut path: HashSet<String> = HashSet::new();
        for id in ids {
            self.visit(id, &mut out, &mut done, &mut path);
        }
        out
    }

    fn visit(
        &self,
        id: &str,
        out: &mut Vec<String>,
        done: &mut HashSet<String>,
        path: &mut HashSet<String>,
    ) {
        if done.contains(id) || !path.insert(id.to_string()) {
            return;
        }
        if let Some(resolved) = self.by_id.get(id) {
            for operand in &resolved.operands {
                if let Some(next) = operand.math_id() {
                    self.visit(next, out, done, path);
                }
            }
        }
        path.remove(id);
        if done.insert(id.to_string()) {
            out.push(id.to_string());
        }
    }
}

/// The unit of the signal an operand names, for unit derivation.
fn operand_unit<'a>(
    reference: &MathOperandRef,
    catalog: &'a [MathCatalogEntry],
    definitions: &'a [MathDefinition],
) -> Option<&'a str> {
    if let Some(id) = reference.math_id() {
        return definitions
            .iter()
            .find(|d| d.id == id)
            .and_then(|d| d.unit.as_deref())
            .filter(|u| !u.is_empty());
    }
    catalog
        .iter()
        .find(|e| &e.reference == reference)
        .map(|e| e.unit.as_str())
        .filter(|u| !u.is_empty())
}

/// Whether following `from`'s math operands reaches `target`, over the
/// definitions' **manual picks**.
///
/// Pattern matches are deliberately not walked: they are what this
/// guards, and a resolution that consulted them would depend on the
/// order definitions happen to be resolved in.
fn reaches(picks: &HashMap<&str, &[MathOperandRef]>, from: &MathOperandRef, target: &str) -> bool {
    let Some(id) = from.math_id() else {
        return false;
    };
    if id == target {
        return true;
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut stack = vec![id];
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        let Some(operands) = picks.get(id) else {
            continue;
        };
        for operand in *operands {
            let Some(next) = operand.math_id() else {
                continue;
            };
            if next == target {
                return true;
            }
            stack.push(next);
        }
    }
    false
}

/// The central, host-side store of math definitions.
///
/// One registry per app, holding the definitions in the order the user
/// created them. Everything that shows a math signal — the Database
/// panel's Computed branch, a signal panel row, a plot's side list —
/// reads *this*, so an edit made on one surface is the same edit
/// everywhere (the `NotesStore` / `TransmitFrameRegistry` shape).
///
/// The registry owns definitions, not samples: it never touches the
/// signal cache. A caller that changes a definition re-resolves the
/// [`MathModel`] and the cache's own fingerprint check does the rest
/// (ADR 0047).
#[derive(Debug, Default)]
pub struct MathRegistry {
    definitions: Mutex<Vec<MathDefinition>>,
}

impl MathRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every definition, in creation order.
    #[must_use]
    pub fn list(&self) -> Vec<MathDefinition> {
        self.definitions
            .lock()
            .expect("math registry mutex poisoned")
            .clone()
    }

    /// Replace the whole set — the project-load path.
    ///
    /// A stored set is adopted as it stands: it was validated when it
    /// was written, and refusing to load a project because one
    /// definition has gone stale would cost the user the rest of them.
    pub fn replace(&self, definitions: Vec<MathDefinition>) {
        *self
            .definitions
            .lock()
            .expect("math registry mutex poisoned") = definitions;
    }

    /// Add a definition, refusing a duplicate id, an unsatisfied arity,
    /// an unknown math operand and a cycle.
    pub fn define(&self, definition: MathDefinition) -> Result<(), MathError> {
        let mut defs = self
            .definitions
            .lock()
            .expect("math registry mutex poisoned");
        if defs.iter().any(|d| d.id == definition.id) {
            return Err(MathError::DuplicateId(definition.id));
        }
        definition.validate()?;
        let mut candidate: Vec<&MathDefinition> = defs.iter().collect();
        candidate.push(&definition);
        check_graph(&candidate, &definition.id)?;
        defs.push(definition);
        Ok(())
    }

    /// Replace the definition with `definition.id`, under the same
    /// checks [`Self::define`] applies. The position in the list is
    /// kept, so a listing does not reorder on an edit.
    pub fn update(&self, definition: MathDefinition) -> Result<(), MathError> {
        let mut defs = self
            .definitions
            .lock()
            .expect("math registry mutex poisoned");
        let Some(at) = defs.iter().position(|d| d.id == definition.id) else {
            return Err(MathError::NoSuchDefinition(definition.id));
        };
        definition.validate()?;
        let candidate: Vec<&MathDefinition> = defs
            .iter()
            .enumerate()
            .map(|(i, d)| if i == at { &definition } else { d })
            .collect();
        check_graph(&candidate, &definition.id)?;
        defs[at] = definition;
        Ok(())
    }

    /// Remove a definition. Every definition that took it as an operand
    /// keeps the now-dangling reference: the fill answers such a series
    /// empty and the editor shows the operand as missing, which is
    /// recoverable — silently rewriting other people's definitions is
    /// not.
    pub fn delete(&self, id: &str) -> Result<MathDefinition, MathError> {
        let mut defs = self
            .definitions
            .lock()
            .expect("math registry mutex poisoned");
        let Some(at) = defs.iter().position(|d| d.id == id) else {
            return Err(MathError::NoSuchDefinition(id.to_string()));
        };
        Ok(defs.remove(at))
    }
}

/// Check the whole definition set for unknown math operands and for a
/// cycle through `changed` — the id whose definition is being added or
/// replaced, and so the only one that can have created one.
fn check_graph(definitions: &[&MathDefinition], changed: &str) -> Result<(), MathError> {
    let by_id: HashMap<&str, &MathDefinition> =
        definitions.iter().map(|d| (d.id.as_str(), *d)).collect();
    for definition in definitions {
        for operand in &definition.operands.picks {
            if let Some(id) = operand.math_id() {
                if !by_id.contains_key(id) {
                    return Err(MathError::UnknownOperand { id: id.to_string() });
                }
            }
        }
    }
    let mut chain = vec![changed.to_string()];
    let mut seen: HashSet<&str> = HashSet::new();
    if walk(&by_id, changed, changed, &mut chain, &mut seen) {
        return Err(MathError::Cycle { chain });
    }
    Ok(())
}

/// Depth-first walk from `id`'s operands looking for `target`,
/// recording the route in `chain` so the refusal can name the cycle.
fn walk<'a>(
    by_id: &HashMap<&'a str, &'a MathDefinition>,
    id: &'a str,
    target: &str,
    chain: &mut Vec<String>,
    seen: &mut HashSet<&'a str>,
) -> bool {
    let Some(definition) = by_id.get(id) else {
        return false;
    };
    for operand in &definition.operands.picks {
        let Some(next) = operand.math_id() else {
            continue;
        };
        let Some((next, _)) = by_id.get_key_value(next) else {
            continue;
        };
        chain.push((*next).to_string());
        if *next == target {
            return true;
        }
        if seen.insert(next) && walk(by_id, next, target, chain, seen) {
            return true;
        }
        chain.pop();
    }
    false
}

/// The series identity of a math signal: its **stable id** in the
/// signal slot under provenance flag `m`.
///
/// The fourth member of the flag set `s|x|f|m`, mirrored byte for byte
/// by the frontend's `signalKey` (`plotData.ts`). A math series has no
/// bus and no message — the same gap a file-backed one has — so the bus
/// segment is `*` and the numeric slot is zero; the id in the name slot
/// is what makes it unique. See
/// `signal_snapshot::signal_identity` for the shared format.
#[must_use]
pub fn math_identity(id: &str) -> String {
    format!("*|m:0:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(id: &str, function: MathFunction, operands: MathOperands) -> MathDefinition {
        MathDefinition {
            id: id.to_string(),
            name: id.to_string(),
            unit: None,
            function,
            operands,
        }
    }

    fn picks(refs: &[MathOperandRef]) -> MathOperands {
        MathOperands {
            picks: refs.to_vec(),
            patterns: Vec::new(),
        }
    }

    fn pattern(p: &str) -> MathOperands {
        MathOperands {
            picks: Vec::new(),
            patterns: vec![p.to_string()],
        }
    }

    fn sig(name: &str) -> MathOperandRef {
        MathOperandRef::dbc("bus", 256, false, name)
    }

    fn entry(name: &str, unit: &str) -> MathCatalogEntry {
        MathCatalogEntry {
            reference: sig(name),
            path: format!("bus/ECU/Msg/{name}"),
            unit: unit.to_string(),
        }
    }

    #[test]
    fn every_function_names_its_arity() {
        let cases: [(MathFunction, Arity); 16] = [
            (MathFunction::Sum, Arity::Set),
            (MathFunction::Product, Arity::Set),
            (MathFunction::Min, Arity::Set),
            (MathFunction::Max, Arity::Set),
            (MathFunction::Average, Arity::Set),
            (MathFunction::Median, Arity::Set),
            (MathFunction::Range, Arity::Set),
            (MathFunction::Difference, Arity::Pair),
            (
                MathFunction::Scale {
                    gain: 1.0,
                    offset: 0.0,
                },
                Arity::One,
            ),
            (MathFunction::ExpFilter { tau_seconds: 1.0 }, Arity::One),
            (MathFunction::Integration, Arity::One),
            (
                MathFunction::Duty {
                    threshold: 0.5,
                    window_seconds: 5.0,
                },
                Arity::One,
            ),
            (
                MathFunction::Frequency {
                    threshold: 0.5,
                    window_seconds: 5.0,
                },
                Arity::One,
            ),
            (
                MathFunction::Statistic {
                    statistic: Statistic::Mean,
                    percentile: 95.0,
                },
                Arity::One,
            ),
            (MathFunction::Rms, Arity::One),
            (MathFunction::HLine { value: 0.0 }, Arity::None),
        ];
        for (function, arity) in cases {
            assert_eq!(function.arity(), arity, "{}", function.kind());
        }
    }

    #[test]
    fn a_definition_round_trips_through_json() {
        let d = def(
            "m1",
            MathFunction::Duty {
                threshold: 0.5,
                window_seconds: 5.0,
            },
            picks(&[sig("A")]),
        );
        let json = serde_json::to_string(&d).expect("serialize");
        assert!(json.contains(r#""kind":"duty""#), "{json}");
        let back: MathDefinition = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, d);
    }

    #[test]
    fn a_math_operand_round_trips_as_a_bare_id() {
        let r = MathOperandRef::math("m1");
        let json = serde_json::to_string(&r).expect("serialize");
        let back: MathOperandRef = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, r);
        assert_eq!(back.math_id(), Some("m1"));
    }

    #[test]
    fn arity_is_enforced_at_definition_time() {
        let registry = MathRegistry::new();
        let err = registry
            .define(def("m1", MathFunction::Difference, picks(&[sig("A")])))
            .expect_err("a difference needs two operands");
        assert!(matches!(err, MathError::Arity { .. }), "{err:?}");
        registry
            .define(def(
                "m1",
                MathFunction::Difference,
                picks(&[sig("A"), sig("B")]),
            ))
            .expect("two operands is a difference");
    }

    #[test]
    fn only_a_set_function_takes_a_pattern() {
        let registry = MathRegistry::new();
        let mut d = def("m1", MathFunction::Rms, picks(&[sig("A")]));
        d.operands.patterns = vec!["Cell".to_string()];
        let err = registry.define(d).expect_err("rms takes one signal");
        assert!(
            matches!(err, MathError::PatternsNotAllowed { .. }),
            "{err:?}"
        );
    }

    #[test]
    fn an_uncompilable_pattern_is_refused() {
        let registry = MathRegistry::new();
        let err = registry
            .define(def("m1", MathFunction::Max, pattern("Cell(")))
            .expect_err("that pattern does not compile");
        assert!(matches!(err, MathError::BadPattern { .. }), "{err:?}");
    }

    #[test]
    fn a_zero_or_negative_time_constant_is_refused() {
        let registry = MathRegistry::new();
        for tau in [0.0, -1.0] {
            let err = registry
                .define(def(
                    "m1",
                    MathFunction::ExpFilter { tau_seconds: tau },
                    picks(&[sig("A")]),
                ))
                .expect_err("τ must be positive");
            assert!(matches!(err, MathError::BadParameter { .. }), "{err:?}");
        }
    }

    #[test]
    fn a_percentile_outside_zero_to_a_hundred_is_refused() {
        let registry = MathRegistry::new();
        let err = registry
            .define(def(
                "m1",
                MathFunction::Statistic {
                    statistic: Statistic::Percentile,
                    percentile: 150.0,
                },
                picks(&[sig("A")]),
            ))
            .expect_err("a percentile is a percentage");
        assert!(matches!(err, MathError::BadParameter { .. }), "{err:?}");
    }

    #[test]
    fn a_definition_that_would_reach_itself_is_refused() {
        let registry = MathRegistry::new();
        registry
            .define(def("m1", MathFunction::Rms, picks(&[sig("A")])))
            .expect("m1");
        registry
            .define(def(
                "m2",
                MathFunction::Scale {
                    gain: 2.0,
                    offset: 0.0,
                },
                picks(&[MathOperandRef::math("m1")]),
            ))
            .expect("m2 over m1");
        // Repointing m1 at m2 closes the loop m1 → m2 → m1.
        let err = registry
            .update(def(
                "m1",
                MathFunction::Rms,
                picks(&[MathOperandRef::math("m2")]),
            ))
            .expect_err("that closes a cycle");
        let MathError::Cycle { chain } = err else {
            panic!("expected a cycle, got {err:?}");
        };
        assert_eq!(chain, ["m1", "m2", "m1"]);
        // The refusal left the registry as it was.
        assert_eq!(registry.list()[0].operands.picks, [sig("A")]);
    }

    #[test]
    fn a_definition_naming_itself_is_refused() {
        let registry = MathRegistry::new();
        let err = registry
            .define(def(
                "m1",
                MathFunction::Rms,
                picks(&[MathOperandRef::math("m1")]),
            ))
            .expect_err("a self-reference is a cycle");
        assert!(matches!(err, MathError::Cycle { .. }), "{err:?}");
    }

    #[test]
    fn math_on_math_is_allowed_while_it_stays_acyclic() {
        let registry = MathRegistry::new();
        registry
            .define(def("m1", MathFunction::Rms, picks(&[sig("A")])))
            .expect("m1");
        registry
            .define(def(
                "m2",
                MathFunction::ExpFilter { tau_seconds: 2.0 },
                picks(&[MathOperandRef::math("m1")]),
            ))
            .expect("m2 over m1");
        registry
            .define(def(
                "m3",
                MathFunction::Integration,
                picks(&[MathOperandRef::math("m2")]),
            ))
            .expect("m3 over m2");
        assert_eq!(registry.list().len(), 3);
    }

    #[test]
    fn an_operand_naming_no_definition_is_refused() {
        let registry = MathRegistry::new();
        let err = registry
            .define(def(
                "m1",
                MathFunction::Rms,
                picks(&[MathOperandRef::math("gone")]),
            ))
            .expect_err("no such definition");
        assert!(matches!(err, MathError::UnknownOperand { .. }), "{err:?}");
    }

    #[test]
    fn a_duplicate_id_is_refused_and_an_update_keeps_its_place() {
        let registry = MathRegistry::new();
        registry
            .define(def("m1", MathFunction::Rms, picks(&[sig("A")])))
            .expect("m1");
        registry
            .define(def("m2", MathFunction::Rms, picks(&[sig("B")])))
            .expect("m2");
        let err = registry
            .define(def("m1", MathFunction::Rms, picks(&[sig("C")])))
            .expect_err("m1 is taken");
        assert!(matches!(err, MathError::DuplicateId(_)), "{err:?}");
        registry
            .update(def("m1", MathFunction::Rms, picks(&[sig("C")])))
            .expect("update m1");
        let ids: Vec<String> = registry.list().into_iter().map(|d| d.id).collect();
        assert_eq!(ids, ["m1", "m2"]);
    }

    #[test]
    fn deleting_an_absent_definition_says_so() {
        let registry = MathRegistry::new();
        let err = registry.delete("nope").expect_err("nothing to delete");
        assert!(matches!(err, MathError::NoSuchDefinition(_)), "{err:?}");
    }

    #[test]
    fn a_sets_membership_is_picks_plus_live_pattern_matches() {
        let definitions = vec![def("m1", MathFunction::Max, {
            let mut o = pattern(r"Cell\d+");
            o.picks = vec![sig("PackVolts")];
            o
        })];
        let catalog = [
            entry("Cell01", "V"),
            entry("Cell02", "V"),
            entry("PackVolts", "V"),
            entry("Current", "A"),
        ];
        let model = MathModel::resolve(&definitions, &catalog);
        let names: Vec<&str> = model
            .get("m1")
            .expect("m1")
            .operands
            .iter()
            .map(|r| r.signal_name.as_str())
            .collect();
        // The pick first, then the matches in canonical-path order; the
        // pick is not repeated by the pattern that also matches it.
        assert_eq!(names, ["PackVolts", "Cell01", "Cell02"]);
    }

    #[test]
    fn a_new_matching_signal_joins_the_set_on_its_own() {
        let definitions = vec![def("m1", MathFunction::Average, pattern(r"Cell\d+"))];
        let before = MathModel::resolve(&definitions, &[entry("Cell01", "V")]);
        let after = MathModel::resolve(&definitions, &[entry("Cell01", "V"), entry("Cell02", "V")]);
        assert_eq!(before.get("m1").expect("m1").operands.len(), 1);
        assert_eq!(after.get("m1").expect("m1").operands.len(), 2);
    }

    #[test]
    fn a_pattern_match_that_would_close_a_cycle_is_dropped() {
        // m2 takes m1; m1's pattern would otherwise swallow m2.
        let definitions = vec![
            def("m1", MathFunction::Sum, pattern("m")),
            def(
                "m2",
                MathFunction::Rms,
                picks(&[MathOperandRef::math("m1")]),
            ),
        ];
        let catalog = [
            MathCatalogEntry {
                reference: MathOperandRef::math("m2"),
                path: "//Computed/m2".to_string(),
                unit: String::new(),
            },
            entry("mA", "V"),
        ];
        let model = MathModel::resolve(&definitions, &catalog);
        let names: Vec<&str> = model
            .get("m1")
            .expect("m1")
            .operands
            .iter()
            .map(|r| r.signal_name.as_str())
            .collect();
        assert_eq!(names, ["mA"]);
    }

    #[test]
    fn a_uniform_set_inherits_its_operand_unit_and_a_mixed_one_does_not() {
        let uniform = vec![def("m1", MathFunction::Sum, pattern(r"Cell\d+"))];
        let model = MathModel::resolve(&uniform, &[entry("Cell01", "V"), entry("Cell02", "V")]);
        assert_eq!(model.get("m1").expect("m1").unit, "V");

        let mixed = vec![def(
            "m1",
            MathFunction::Product,
            picks(&[sig("PackVolts"), sig("Current")]),
        )];
        let model = MathModel::resolve(&mixed, &[entry("PackVolts", "V"), entry("Current", "A")]);
        assert_eq!(model.get("m1").expect("m1").unit, "");
    }

    #[test]
    fn integration_appends_a_second_and_duty_and_frequency_state_their_own() {
        let catalog = [entry("Current", "A")];
        let cases = [
            (MathFunction::Integration, "A·s"),
            (
                MathFunction::Duty {
                    threshold: 0.5,
                    window_seconds: 5.0,
                },
                "%",
            ),
            (
                MathFunction::Frequency {
                    threshold: 0.5,
                    window_seconds: 5.0,
                },
                "Hz",
            ),
            (MathFunction::Rms, "A"),
        ];
        for (function, unit) in cases {
            let kind = function.kind();
            let definitions = vec![def("m1", function, picks(&[sig("Current")]))];
            let model = MathModel::resolve(&definitions, &catalog);
            assert_eq!(model.get("m1").expect("m1").unit, unit, "{kind}");
        }
    }

    #[test]
    fn a_user_specified_unit_wins_over_the_derived_one() {
        let mut d = def("m1", MathFunction::Integration, picks(&[sig("Current")]));
        d.unit = Some("C".to_string());
        let model = MathModel::resolve(&[d], &[entry("Current", "A")]);
        assert_eq!(model.get("m1").expect("m1").unit, "C");
    }

    #[test]
    fn only_a_single_pattern_set_gets_a_default_name() {
        assert_eq!(
            default_name(&MathFunction::Max, &["Cell\\d+".to_string()]).as_deref(),
            Some("max(Cell\\d+)")
        );
        assert_eq!(default_name(&MathFunction::Max, &[]), None);
        assert_eq!(
            default_name(&MathFunction::Max, &["a".to_string(), "b".to_string()]),
            None
        );
    }

    #[test]
    fn dependencies_are_ordered_below_their_dependents() {
        let definitions = vec![
            def("m1", MathFunction::Rms, picks(&[sig("A")])),
            def(
                "m2",
                MathFunction::Integration,
                picks(&[MathOperandRef::math("m1")]),
            ),
            def(
                "m3",
                MathFunction::Difference,
                picks(&[MathOperandRef::math("m2"), MathOperandRef::math("m1")]),
            ),
        ];
        let model = MathModel::resolve(&definitions, &[]);
        assert_eq!(
            model.dependency_order(&["m3".to_string()]),
            ["m1", "m2", "m3"]
        );
    }

    #[test]
    fn a_math_identity_is_the_fourth_provenance_flag() {
        assert_eq!(math_identity("m1"), "*|m:0:m1");
        // It cannot collide with a DBC-backed or file-backed identity,
        // whatever their numbers.
        assert_ne!(
            math_identity("m1"),
            crate::signal_snapshot::signal_identity(None, 0, false, "m1", true)
        );
    }
}
