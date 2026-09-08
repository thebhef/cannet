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
//! ## Units and scaling
//!
//! A definition stores **intent, not numbers**. Its
//! [`unit`](MathDefinition::unit) is the conversion *target*: at resolve
//! time each member's own unit — its database's string read through
//! [`crate::units`], or the per-operand
//! [`source_unit`](MathOperand::source_unit) override — is converted to
//! it, so a pattern-defined set whose members carry mixed units
//! (milliamps beside amps) gets a correct factor per member, and editing
//! the user's unit-customization dict rescales every dependent channel
//! on the next serve. Conversions are affine, which is what makes
//! °C↔K↔°F expressible.
//!
//! Beside that sits the unit-free path, for what a database does not
//! describe cleanly: a manual `(gain, offset)` on any operand (applied
//! *before* the conversion, so it corrects the raw value into the unit
//! it claims to be in) and on the definition's own output
//! ([`MathDefinition::output_gain`], applied after the function).
//!
//! Convertibility accounts for the **function's time dimension**
//! (owner ruling). [`MathFunction::integration()`] multiplies by seconds,
//! so a current operand asked for amp-hours is not the mismatch a
//! pointwise comparison of dimensions makes it: the operand converts
//! only as far as its family's canonical rate and the *output* carries
//! the canonical integral to the target (coulombs to amp-hours is
//! ÷3600). A target in the operand's own family — `mA` on an amp
//! operand — keeps the pointwise semantics and integrates in milliamps.
//! With no target at all, the derived unit names the integral where
//! [`crate::units`] carries one (`coulomb`, `joule`) rather than
//! suffixing `·s`.
//!
//! A member that cannot be converted **passes through unscaled and is
//! reported** ([`ResolvedMath::unconverted`]) — never silently
//! converted wrong. Every effective `(gain, offset)` joins the
//! fingerprint ([`crate::signal_fingerprint::math_encoding`]), so a
//! changed scalar or customization rebuilds the cache like any other
//! definition change.
//!
//! ## Cycles
//!
//! Math signals may take other math signals as operands. A definition
//! that would make a math signal reach itself is **refused when it is
//! defined**, so no serve can ever meet one.
//!
//! ## Unfinished definitions
//!
//! A definition is created the moment its function is picked and is
//! filled in field by field, each field committing as it is left — so
//! the registry **stores an unfinished definition** rather than
//! refusing it. [`MathDefinition::validate`] says what is still missing
//! (a name, an operand, a parameter in range, a pattern that compiles),
//! every surface shows that, and the kernels answer such a series empty
//! until it is finished. A duplicate id and a cycle are still refused:
//! neither is a state the user could be left in and repair.

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
    /// Running integral of the operand, held between samples.
    ///
    /// **Time is the function's parameter.** The output unit is the
    /// operand's composed with [`time_unit`](Self::Integration::time_unit)
    /// — `operand · h` derives `Ah` — and the accumulation is scaled to
    /// match, so integrating amps over hours yields amp-hours rather
    /// than amp-seconds relabelled.
    Integration {
        /// The time unit the integral accumulates in. Defaults to
        /// seconds, which is what every definition written before this
        /// existed deserialises to and exactly what it used to do.
        #[serde(default = "seconds")]
        time_unit: crate::units::UnitId,
    },
    /// Slope between consecutive samples: `(x - x_prev) / Δt`, with Δt
    /// read in [`time_unit`](Self::Derivative::time_unit).
    ///
    /// Plain consecutive-sample slope — no smoothing and no window
    /// (owner ruling). Smoothing is composed downstream by taking an
    /// exponential filter over this, the same way RMS leaves its
    /// averaging to the user.
    ///
    /// Its output unit is `operand / [t]`, and a division can land in a
    /// *named* family: an `Ah` counter over `d/ds` is `Ah/s`, which is
    /// dimensionally a current, so the picker offers `A` and the ×3600
    /// falls out of the analysis.
    Derivative {
        #[serde(default = "seconds")]
        time_unit: crate::units::UnitId,
    },
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
    /// An integration accumulating in **seconds** — the default, and
    /// what every definition written before the time parameter existed
    /// means.
    #[must_use]
    pub fn integration() -> Self {
        Self::Integration {
            time_unit: seconds(),
        }
    }

    /// A derivative per **second** — the default.
    #[must_use]
    pub fn derivative() -> Self {
        Self::Derivative {
            time_unit: seconds(),
        }
    }

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
            Self::Integration { .. } => "integration",
            Self::Derivative { .. } => "derivative",
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
            | Self::Rms => Vec::new(),
            // The time unit is a *parameter*, not a label: it decides
            // what the accumulation and the slope divide by, so it has
            // to move the fingerprint. Mixed as seconds-per-unit, a
            // number stable across builds where a serialised enum is
            // not (see this vector's docs).
            Self::Integration { time_unit } | Self::Derivative { time_unit } => {
                vec![seconds_per(time_unit)]
            }
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
            | Self::Integration { .. }
            | Self::Derivative { .. }
            | Self::Duty { .. }
            | Self::Frequency { .. }
            | Self::Statistic { .. }
            | Self::Rms => Arity::One,
            Self::HLine { .. } => Arity::None,
        }
    }

    /// **The unit this function produces**, by dimensional analysis over
    /// the operands' own units — a [`Composed`](crate::units::Composed),
    /// which may be one named unit or a product/quotient of several.
    ///
    /// Every function derives one where analysis can name one; deriving
    /// nothing where it can is unhelpful, so the cases are:
    ///
    /// - a function whose result is a **fixed** physical quantity states
    ///   it: duty is `%`, frequency is `Hz`;
    /// - **[`HLine`](Self::HLine)** has no operands to read, so it is
    ///   `scalar` until the user names something;
    /// - **[`Product`](Self::Product)** composes its operands' units —
    ///   `A` by `s` is `A·s`, dimensionally a charge;
    /// - **[`Integration`](Self::Integration)** composes the operand's
    ///   unit with the function's time unit (`A · h` is `Ah`), and
    ///   **[`Derivative`](Self::Derivative)** divides by it (`Ah / s`,
    ///   dimensionally a current);
    /// - everything else — the pointwise sets, the statistics, the
    ///   filters, scale and RMS — **inherits** the first placed
    ///   operand's unit, provided every other placed operand is
    ///   like-kind and so converts to it (`mA` beside `A` derives, the
    ///   members converting).
    ///
    /// An operand the project cannot place — a blank unit, an unknown
    /// spelling — is silence, not disagreement, so it is skipped rather
    /// than vetoing what the placed members inherit; a wide pattern
    /// match keeps its unit when one member arrives blank. The unplaced
    /// member stays badged as unplaced, which is where that is
    /// reported.
    ///
    /// The one no-derivation case is dimensionally honest: an additive
    /// set mixing dimensions (`V` beside `A`) cannot be summed, so it
    /// derives nothing and resolve badges its members.
    ///
    /// `operand_units` are **units**, not spellings: each member's has
    /// already been placed, whether by recognition of its database's
    /// string, by a reinterpretation the project records, or by the
    /// target another definition names. Nothing is parsed here — a unit
    /// recovered from its own rendering would lose exactly the ones
    /// whose spelling recognition refuses (`C`, `Nmm`).
    #[must_use]
    pub fn derived_unit(
        &self,
        operand_units: &[Option<crate::units::UnitId>],
    ) -> Option<crate::units::Composed> {
        use crate::units::{Composed, UnitId};
        match self {
            Self::Duty { .. } => return Some(Composed::of(UnitId::base("percent"))),
            Self::Frequency { .. } => return Some(Composed::of(UnitId::base("hertz"))),
            Self::HLine { .. } => return Some(Composed::of(UnitId::base("scalar"))),
            _ => {}
        }
        match self {
            Self::Product => {
                let mut composed = Composed::of(operand_units.first()?.clone()?);
                for unit in operand_units.iter().skip(1) {
                    composed = composed.times(unit.clone()?);
                }
                Some(composed)
            }
            Self::Integration { time_unit } => {
                Some(Composed::of(operand_units.first()?.clone()?).times(time_unit.clone()))
            }
            Self::Derivative { time_unit } => {
                Some(Composed::of(operand_units.first()?.clone()?).over(time_unit.clone()))
            }
            _ => {
                // Pointwise: the first *placed* member's unit, and only
                // where every other placed member converts to it. That
                // is what makes a mixed `mA`/`A` set derive at all —
                // resolve then converts the members to what was
                // derived. Members the project cannot place are skipped
                // rather than fatal: silence is not a dimension
                // disagreement, and one blank unit in a wide pattern
                // must not cost the rest their unit. They stay badged
                // as unplaced, which is where that is reported.
                let mut placed = operand_units.iter().flatten();
                let first = placed.next()?.clone();
                for unit in placed {
                    crate::units::convert_units(unit, &first)?;
                }
                Some(Composed::of(first))
            }
        }
    }
}

/// The default time unit of [`MathFunction::integration()`] and
/// [`MathFunction::Derivative`]: seconds, which is what a definition
/// written before the parameter existed always meant.
fn seconds() -> crate::units::UnitId {
    crate::units::UnitId::base("second")
}

/// How many seconds one of `time_unit` is — the number the kernels
/// divide and multiply by, and the one the fingerprint mixes.
///
/// One for anything that is not a time at all, which is what a
/// hand-edited project file can carry: a definition whose time unit
/// names no unit behaves exactly as it did before the parameter existed.
fn seconds_per(time_unit: &crate::units::UnitId) -> f64 {
    crate::units::convert_units(time_unit, &seconds()).map_or(1.0, |a| a.gain)
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

/// One operand as a definition *picks* it: the reference, plus the
/// scaling that rides beside it.
///
/// A wrapper rather than fields on [`MathOperandRef`] because that type
/// is `Eq + Hash` — it is the key membership is deduped and cycle-walked
/// on — and an `f64` field would take both away. The reference is
/// `serde(flatten)`ed, so a pick written before any of this existed is
/// still exactly this shape on disk and deserializes unchanged.
///
/// Every field is optional and omitted when unset: a definition that
/// scales nothing writes the same JSON it always did.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MathOperand {
    #[serde(flatten)]
    pub reference: MathOperandRef,
    /// Manual gain on this operand's samples, applied **before** any
    /// unit conversion — the affordance for a signal the database
    /// describes wrongly or not at all. `None` is 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain: Option<f64>,
    /// Manual offset, alongside [`Self::gain`]. `None` is 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<f64>,
    /// Read this operand as being in this unit ([`crate::units`] id),
    /// whatever its database says — "treat this one as mA". Local to
    /// this definition: it does not change the operand anywhere else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_unit: Option<String>,
}

impl MathOperand {
    /// An operand with no scaling of its own — what picking a signal
    /// produces before anyone types a number.
    #[must_use]
    pub fn new(reference: MathOperandRef) -> Self {
        Self {
            reference,
            gain: None,
            offset: None,
            source_unit: None,
        }
    }

    /// The manual `(gain, offset)` the user typed, as one affine.
    #[must_use]
    pub fn manual(&self) -> crate::units::Affine {
        crate::units::Affine::new(self.gain.unwrap_or(1.0), self.offset.unwrap_or(0.0))
    }
}

impl From<MathOperandRef> for MathOperand {
    fn from(reference: MathOperandRef) -> Self {
        Self::new(reference)
    }
}

/// What a definition selects: manual picks, plus — for a set function —
/// the live regex patterns whose matches join them (ADR 0020).
///
/// Picks are **ordered** because two functions read the order:
/// `difference` takes A − B, and a listing shows the set in the order
/// the user built it. Pattern matches are appended after the picks in
/// canonical-path order, so resolution is deterministic.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MathOperands {
    #[serde(default)]
    pub picks: Vec<MathOperand>,
    /// Regex patterns over the canonical signal path (ADR 0038).
    /// Meaningful only for [`Arity::Set`]; a definition of any other
    /// arity carries none.
    #[serde(default)]
    pub patterns: Vec<String>,
}

/// What a definition names as its unit: **the typed form**, or a
/// spelling.
///
/// Units are typed values in the model and strings exist only at the
/// DBC-ingest boundary, so a picker commits [`Self::Typed`] and that is
/// what persists. [`Self::Spelled`] is the other two cases, and both are
/// read rather than written: a project file saved before the typed form
/// existed, and the free-text "not in the library" path, which has
/// always been a **label** rather than a unit.
///
/// `serde(untagged)`, so the two are told apart by shape — a JSON string
/// is a spelling, an object is a typed unit — and neither an old file
/// nor a new one needs a version marker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UnitTarget {
    Typed(crate::units::UnitId),
    Spelled(String),
}

impl From<&str> for UnitTarget {
    /// A spelling, which is what a database and a free-text field carry.
    fn from(raw: &str) -> Self {
        Self::Spelled(raw.to_string())
    }
}

impl From<crate::units::UnitId> for UnitTarget {
    fn from(unit: crate::units::UnitId) -> Self {
        Self::Typed(unit)
    }
}

impl UnitTarget {
    /// The unit this names, where anything places it: the typed form
    /// directly, and a spelling through [`crate::units::recognize`] —
    /// which is the one place a string becomes a unit.
    #[must_use]
    pub fn resolve(
        &self,
        customizations: &crate::units::Customizations,
    ) -> Option<crate::units::UnitId> {
        match self {
            Self::Typed(unit) => crate::units::dimension_of(unit).map(|_| unit.clone()),
            Self::Spelled(raw) => crate::units::recognize(raw, customizations),
        }
    }

    /// How this reads on a label, whether or not anything places it —
    /// an unrecognised spelling is still what the user typed.
    #[must_use]
    pub fn spelling(&self, customizations: &crate::units::Customizations) -> String {
        match self {
            Self::Typed(unit) => crate::units::display_of(unit),
            Self::Spelled(raw) => self
                .resolve(customizations)
                .map_or_else(|| raw.clone(), |u| crate::units::display_of(&u)),
        }
    }

    /// Whether this names nothing at all — an empty spelling, which is
    /// what an editor commits when the field is cleared.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        matches!(self, Self::Spelled(raw) if raw.is_empty())
    }
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
    /// The unit the user chose. `None` means "derive it" —
    /// [`MathFunction::derived_unit`] over the operands' units.
    ///
    /// It is also the **conversion target** (owner ruling, ADR-free —
    /// see this module's `Units` section): where it places a unit, every
    /// operand whose own unit is recognised converts to it; where it
    /// does not, nothing converts and the samples are the operands' own.
    #[serde(default)]
    pub unit: Option<UnitTarget>,
    /// Gain applied to this series' **output**, after the function.
    /// `None` is 1. Distinct from [`MathFunction::Scale`], which is a
    /// function in its own right and mints its own series; this is a
    /// correction on whatever this definition already computes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_gain: Option<f64>,
    /// Offset applied to the output, alongside [`Self::output_gain`].
    /// `None` is 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_offset: Option<f64>,
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
    /// The definition has no display name. Only a set defined by a
    /// single pattern gets one derived ([`default_name`]); every other
    /// definition is named by the user, because a name composed from a
    /// selection reads as authoritative while being a guess.
    Unnamed,
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
            Self::Unnamed => write!(f, "name it — names aren't derived from selections"),
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
        if self.name.trim().is_empty() {
            return Err(MathError::Unnamed);
        }
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
    /// **The unit that signal is read in**, for
    /// [`MathFunction::derived_unit`] — the unit itself and how it
    /// reads, never a spelling something downstream has to place again
    /// (`crate::units::UnitReading`). Blank where nothing names one.
    pub unit: crate::units::UnitReading,
}

/// What the host made of one operand's unit string — the parse state an
/// editor shows beside the operand, before any conversion is attempted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UnitRecognition {
    /// The operand's database names no unit. Ordinary, not a defect.
    Blank,
    /// Its unit string places a unit.
    Recognized {
        unit: crate::units::UnitId,
        /// How that unit reads — what a chip shows.
        display: String,
    },
    /// Its unit string is not one this project can place. The repair is
    /// a mapping in Settings → Units, or a source-unit override here.
    Unrecognized { spelling: String },
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
    /// Each resolved operand's **effective** affine, index-parallel with
    /// [`Self::operands`]: its manual `(gain, offset)` followed by the
    /// conversion from its own source unit to the definition's target.
    ///
    /// Derived fresh here rather than stored on the definition, which is
    /// what lets a pattern-defined set whose members carry mixed units
    /// give each member its own factor, and what makes a customization
    /// edit rescale every dependent channel on the next resolve.
    /// [`crate::units::Affine::IDENTITY`] for an operand nothing scales,
    /// which the kernels skip outright.
    pub operand_affines: Vec<crate::units::Affine>,
    /// Indices into [`Self::operands`] of the members a target unit was
    /// asked for and **not** reached — an operand whose unit string
    /// nothing recognises, or one measuring something else entirely.
    /// An integration's operand counts as reached when the target is
    /// what integrating it produces, even though the two dimensions
    /// differ (see this module's *Units and scaling*).
    ///
    /// Such a member passes through unscaled, which is the only honest
    /// answer, and is reported here so a surface can say which: nothing
    /// converts silently wrong. Empty when the definition names no
    /// target unit, since then nothing was asked for.
    pub unconverted: Vec<usize>,
    /// The definition's output `(gain, offset)`, applied after the
    /// function — the manual pair the user typed, followed by the
    /// conversion an [integration](MathFunction::integration()) needs to
    /// land in a target unit its operand only reaches *through time*
    /// (coulombs to amp-hours).
    pub output_affine: crate::units::Affine,
    /// The unit the series carries: the user's, or the derived one.
    pub unit: String,
    /// The **kind** the series' unit belongs to — the composed dimension
    /// for an integration or a derivative, the operands' own for a
    /// pointwise function. `None` where nothing places it.
    ///
    /// This is what locks the override picker: an integration of a
    /// current is a charge, so the picker offers charges and nothing
    /// else. Derived here rather than in the picker, because the
    /// composition that names it is the model's (`CLAUDE.md`).
    pub kind: Option<crate::units::Dimension>,
    /// **What the host made of each operand's unit string**,
    /// index-parallel with [`Self::operands`].
    ///
    /// Convertibility is not the whole story at edit time: an operand
    /// whose unit string nothing recognises and one whose unit measures
    /// the wrong thing are different problems with different repairs
    /// (a customization in Settings → Units, versus a source-unit
    /// override on the row). The editor shows which.
    pub recognition: Vec<UnitRecognition>,
    /// Every bus that contributes input to this series, **transitively**
    /// and deduped, in bus-id order.
    ///
    /// A math series has no bus of its own — ADR 0038 gives it no
    /// canonical path to hang one on — so what a surface shows beside
    /// it is where its input comes from: one color chip per bus, and a
    /// label that says so when there is more than one. Following a math
    /// operand into *its* operands is what makes the answer true of the
    /// whole chain rather than of its last link. An operand with no bus
    /// (file-backed) and one naming a definition that is gone both
    /// contribute nothing.
    pub bus_ids: Vec<String>,
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
    ///
    /// `customizations` is the user's DBC-unit-string dict
    /// ([`crate::units::Customizations`]), which takes part in deriving
    /// every member's conversion — so editing it and re-resolving is
    /// what rescales a channel, and the moved fingerprint is what
    /// rebuilds its pyramid.
    #[must_use]
    pub fn resolve(
        definitions: &[MathDefinition],
        catalog: &[MathCatalogEntry],
        customizations: &crate::units::Customizations,
    ) -> Self {
        let mut model = Self::default();
        // Every definition, membership empty, so cycle checks below can
        // walk the whole graph while it is being built.
        let picks: HashMap<&str, &[MathOperand]> = definitions
            .iter()
            .map(|d| (d.id.as_str(), d.operands.picks.as_slice()))
            .collect();
        for definition in definitions {
            // A pick brings its own scaling; a pattern match has none of
            // its own and takes the conversion alone.
            let mut picked: Vec<MathOperand> = definition.operands.picks.clone();
            let mut operands: Vec<MathOperandRef> = picked
                .iter()
                .map(|p| p.reference.clone())
                .collect::<Vec<_>>();
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
                    picked.push(MathOperand::new(entry.reference.clone()));
                }
            }
            let units: Vec<crate::units::UnitReading> = operands
                .iter()
                .map(|r| operand_unit(r, catalog, definitions, customizations))
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
            let placed: Vec<Option<crate::units::UnitId>> =
                units.iter().map(|u| u.unit.clone()).collect();
            let derived = definition.function.derived_unit(&placed);
            let (target, unit, kind) = labelling(definition, derived.as_ref(), customizations);
            let recognition = units.iter().map(recognition_of).collect();
            let Scaling {
                operands: operand_affines,
                unconverted,
                output: output_affine,
            } = effective_affines(
                definition,
                &picked,
                &placed,
                derived.as_ref(),
                target.as_ref(),
            );
            model.order.push(definition.id.clone());
            model.by_id.insert(
                definition.id.clone(),
                ResolvedMath {
                    definition: definition.clone(),
                    operands,
                    operand_paths,
                    operand_affines,
                    unconverted,
                    output_affine,
                    unit,
                    kind,
                    recognition,
                    // Filled below: a definition may read one listed
                    // after it, so attribution needs the whole model.
                    bus_ids: Vec::new(),
                },
            );
        }
        model.attribute_buses();
        model
    }

    /// Fill every resolved definition's [`ResolvedMath::bus_ids`].
    ///
    /// A second pass, because attribution follows math operands and a
    /// definition may read one that resolves after it. Memoised on the
    /// way down, so a chain is walked once however many dependents
    /// share it; a cycle (unrepresentable — the registry refuses one)
    /// terminates on the in-progress set rather than looping.
    fn attribute_buses(&mut self) {
        let mut done: HashMap<String, Vec<String>> = HashMap::new();
        for id in &self.order {
            let mut path = HashSet::new();
            Self::buses_of(&self.by_id, id, &mut done, &mut path);
        }
        for (id, buses) in done {
            if let Some(resolved) = self.by_id.get_mut(&id) {
                resolved.bus_ids = buses;
            }
        }
    }

    fn buses_of(
        by_id: &HashMap<String, ResolvedMath>,
        id: &str,
        done: &mut HashMap<String, Vec<String>>,
        path: &mut HashSet<String>,
    ) -> Vec<String> {
        if let Some(hit) = done.get(id) {
            return hit.clone();
        }
        if !path.insert(id.to_string()) {
            return Vec::new();
        }
        let mut buses: Vec<String> = Vec::new();
        if let Some(resolved) = by_id.get(id) {
            for operand in &resolved.operands {
                match operand.math_id() {
                    Some(next) => buses.extend(Self::buses_of(by_id, next, done, path)),
                    None => buses.extend(operand.bus_id.clone()),
                }
            }
        }
        buses.sort_unstable();
        buses.dedup();
        path.remove(id);
        done.insert(id.to_string(), buses.clone());
        buses
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

/// What a definition's unit **reads as**, what it converts **to**, and
/// what **kind** that is.
///
/// The label is the user's choice spelled where they made one — and a
/// free-text unit the library does not carry stays exactly what they
/// typed, because that path has always been a label — and the
/// derivation where they made none. The kind is the target's family, or
/// the composition's, and is what locks a picker.
fn labelling(
    definition: &MathDefinition,
    derived: Option<&crate::units::Composed>,
    customizations: &crate::units::Customizations,
) -> (
    Option<crate::units::UnitId>,
    String,
    Option<crate::units::Dimension>,
) {
    let named = definition
        .unit
        .as_ref()
        .filter(|t| !t.is_empty())
        .map(|t| (t.resolve(customizations), t.spelling(customizations)));
    let target = named.as_ref().and_then(|(unit, _)| unit.clone());
    let unit = match &named {
        Some((_, spelling)) => spelling.clone(),
        None => derived
            .map(crate::units::Composed::display)
            .unwrap_or_default(),
    };
    let kind = target
        .as_ref()
        .and_then(crate::units::dimension_of)
        .or_else(|| derived.and_then(crate::units::Composed::dimension));
    (target, unit, kind)
}

/// What the host makes of one operand's unit — the state an editor
/// shows, which is not the same question as convertibility.
///
/// A reading, not a string: the placing already happened, at ingest or
/// at the picker, so this only reports it. `display` is the unit's own
/// spelling where one was placed — what the host made of the database's
/// wording — and the wording itself where nothing was.
fn recognition_of(reading: &crate::units::UnitReading) -> UnitRecognition {
    match &reading.unit {
        Some(unit) => UnitRecognition::Recognized {
            display: crate::units::display_of(unit),
            unit: unit.clone(),
        },
        None if reading.display.trim().is_empty() => UnitRecognition::Blank,
        None => UnitRecognition::Unrecognized {
            spelling: reading.display.clone(),
        },
    }
}

/// What one resolve derives for a definition: an affine per operand, the
/// indices a target unit was asked for and not reached, and the affine
/// its output carries.
struct Scaling {
    operands: Vec<crate::units::Affine>,
    unconverted: Vec<usize>,
    output: crate::units::Affine,
}

/// Every operand's **effective** affine, the definition's output affine,
/// and the indices of the members a target unit was asked for and not
/// reached.
///
/// `catalog_units` is index-parallel with `operands` — the unit each
/// member is **read in**, already placed, or `None` where nothing
/// places one.
/// `derived` is what the function's own analysis produces from those
/// units, and `target` the unit the definition names, where it names one
/// the facade places.
///
/// Four rules, and nothing else scales anything:
///
/// - the operand's manual `(gain, offset)` always applies, and applies
///   **first**: it corrects the raw value into the unit the operand
///   claims to be in; the definition's own output `(gain, offset)` is
///   the same correction on what the function computed;
/// - operands convert to the target where there is one, and otherwise
///   to the **derived** unit where the derivation is a single unit —
///   which is what makes a mixed `mA`/`A` set compute in one unit with
///   no target set at all;
/// - a target the operands cannot reach pointwise may still be what the
///   *function* produces: integrating amps over seconds is coulombs, so
///   asking for amp-hours is ÷3600 on the **output**, and
///   differentiating amp-hours per second is amps, so asking for `A` is
///   ×3600. The pointwise try comes first, so a target in the operand's
///   own family (`mA` on an amp operand) keeps pointwise semantics and
///   integrates in milliamps;
/// - a member a target was asked for and not reached passes through
///   unscaled and is **reported**, as is every member of a set whose
///   units are all placed and disagree in kind — the additive set that
///   derives nothing.
fn effective_affines(
    definition: &MathDefinition,
    operands: &[MathOperand],
    catalog_units: &[Option<crate::units::UnitId>],
    derived: Option<&crate::units::Composed>,
    target: Option<&crate::units::UnitId>,
) -> Scaling {
    let mut scaling = Scaling {
        operands: Vec::with_capacity(operands.len()),
        unconverted: Vec::new(),
        output: crate::units::Affine::new(
            definition.output_gain.unwrap_or(1.0),
            definition.output_offset.unwrap_or(0.0),
        ),
    };
    // Where the definition names no target, the derivation is one: a
    // set of like-kind members computes in the unit it derived, each
    // member converting to it.
    let asked = target.is_some();
    let inherited = derived.and_then(crate::units::Composed::single).cloned();
    let target = target.cloned().or(inherited);
    let sources: Vec<Option<crate::units::UnitId>> = operands
        .iter()
        .enumerate()
        .map(|(i, operand)| match operand.source_unit.as_deref() {
            Some(id) => crate::units::typed(id),
            None => catalog_units.get(i).cloned().flatten(),
        })
        .collect();
    // An additive set whose members are all placed and do not agree in
    // kind derives nothing — `V` beside `A` cannot be summed — and every
    // member is badged, whether or not a target was asked for.
    let mixed_kinds =
        derived.is_none() && operands.len() > 1 && sources.iter().all(Option::is_some);
    for (i, operand) in operands.iter().enumerate() {
        let manual = operand.manual();
        let conversion = target.as_ref().and_then(|target| {
            sources[i]
                .as_ref()
                .and_then(|source| crate::units::convert_units(source, target))
        });
        if let Some(conversion) = conversion {
            scaling.operands.push(manual.then(conversion));
        } else {
            scaling.operands.push(manual);
            if asked || mixed_kinds {
                scaling.unconverted.push(i);
            }
        }
    }
    // Nothing reached the target pointwise, so the question becomes what
    // the *function* produces: the composition carries the whole
    // conversion on the output. It runs after the manual output scalars,
    // which correct the value the function computed in the unit it
    // computed it in.
    if asked && !operands.is_empty() && scaling.unconverted.len() == operands.len() {
        if let Some(conversion) = derived
            .zip(target.as_ref())
            .and_then(|(derived, target)| derived.convert_to(target))
        {
            scaling.unconverted.clear();
            scaling.output = scaling.output.then(conversion);
        }
    }
    scaling
}

/// The unit the signal an operand names is **read in**, for unit
/// derivation and for the conversion to the definition's target.
///
/// A math operand answers with its own target as a *unit* — resolved
/// once, where the target is a spelling an old project file carries,
/// and passed straight through where a picker committed the typed form.
/// A catalog signal answers with the reading the catalog holds. Neither
/// hand-off goes through a spelling: a target picked as `coulomb` reads
/// `C`, and `C` is not a string anything can place back.
fn operand_unit(
    reference: &MathOperandRef,
    catalog: &[MathCatalogEntry],
    definitions: &[MathDefinition],
    customizations: &crate::units::Customizations,
) -> crate::units::UnitReading {
    if let Some(id) = reference.math_id() {
        return definitions
            .iter()
            .find(|d| d.id == id)
            .and_then(|d| d.unit.as_ref())
            .filter(|t| !t.is_empty())
            .map(|t| {
                crate::units::UnitReading::placed(
                    t.resolve(customizations),
                    t.spelling(customizations),
                )
            })
            .unwrap_or_default();
    }
    catalog
        .iter()
        .find(|e| &e.reference == reference)
        .map(|e| e.unit.clone())
        .unwrap_or_default()
}

/// Whether following `from`'s math operands reaches `target`, over the
/// definitions' **manual picks**.
///
/// Pattern matches are deliberately not walked: they are what this
/// guards, and a resolution that consulted them would depend on the
/// order definitions happen to be resolved in.
fn reaches(picks: &HashMap<&str, &[MathOperand]>, from: &MathOperandRef, target: &str) -> bool {
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
            let Some(next) = operand.reference.math_id() else {
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

    /// Add a definition.
    ///
    /// **An incomplete definition is stored, not refused** (owner
    /// ruling): a math signal is created the moment its function is
    /// picked and filled in field by field, so a registry that only
    /// accepted finished definitions would have nowhere to put the one
    /// the user is writing. Such a definition is marked invalid by
    /// [`MathDefinition::validate`] — every surface shows why — and the
    /// kernels answer it empty ([`crate::math_kernels::apply`]), so it
    /// serves nothing until it is finished.
    ///
    /// Only two things are still refused, because neither is a state
    /// the user can be left in and repair: a **duplicate id** (which
    /// would shadow another definition) and a **cycle** (which no serve
    /// could ever answer).
    pub fn define(&self, definition: MathDefinition) -> Result<(), MathError> {
        let mut defs = self
            .definitions
            .lock()
            .expect("math registry mutex poisoned");
        if defs.iter().any(|d| d.id == definition.id) {
            return Err(MathError::DuplicateId(definition.id));
        }
        let mut candidate: Vec<&MathDefinition> = defs.iter().collect();
        candidate.push(&definition);
        check_graph(&candidate, &definition.id)?;
        defs.push(definition);
        Ok(())
    }

    /// Replace the definition with `definition.id`, under the same two
    /// refusals [`Self::define`] applies. The position in the list is
    /// kept, so a listing does not reorder on an edit — which matters
    /// when every field commits as it is left.
    pub fn update(&self, definition: MathDefinition) -> Result<(), MathError> {
        let mut defs = self
            .definitions
            .lock()
            .expect("math registry mutex poisoned");
        let Some(at) = defs.iter().position(|d| d.id == definition.id) else {
            return Err(MathError::NoSuchDefinition(definition.id));
        };
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

/// Check the whole definition set for a cycle through `changed` — the
/// id whose definition is being added or replaced, and so the only one
/// that can have created one.
///
/// An operand naming no definition is **not** an error here: deleting a
/// definition leaves its dependents holding a dangling reference by
/// design, and they have to stay editable so the user can repair them.
/// The listing reports such an operand as missing.
fn check_graph(definitions: &[&MathDefinition], changed: &str) -> Result<(), MathError> {
    let by_id: HashMap<&str, &MathDefinition> =
        definitions.iter().map(|d| (d.id.as_str(), *d)).collect();
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
        let Some(next) = operand.reference.math_id() else {
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
    use crate::units::{Affine, UnitId};

    fn def(id: &str, function: MathFunction, operands: MathOperands) -> MathDefinition {
        MathDefinition {
            id: id.to_string(),
            name: id.to_string(),
            unit: None,
            output_gain: None,
            output_offset: None,
            function,
            operands,
        }
    }

    fn picks(refs: &[MathOperandRef]) -> MathOperands {
        MathOperands {
            picks: refs.iter().cloned().map(MathOperand::new).collect(),
            patterns: Vec::new(),
        }
    }

    /// The membership references of a resolved definition, which is what
    /// most of these tests assert on.
    fn names(model: &MathModel, id: &str) -> Vec<String> {
        model
            .get(id)
            .expect("resolved")
            .operands
            .iter()
            .map(|r| r.signal_name.clone())
            .collect()
    }

    /// Resolve with no unit customizations — the shipped state, and what
    /// every test that is not about the dict wants.
    fn resolve(definitions: &[MathDefinition], catalog: &[MathCatalogEntry]) -> MathModel {
        MathModel::resolve(definitions, catalog, &crate::units::Customizations::new())
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

    /// A catalog entry for a signal whose database declares `unit` —
    /// the ingest boundary, read once here as it is in the app.
    fn entry(name: &str, unit: &str) -> MathCatalogEntry {
        entry_with(name, unit, &crate::units::Customizations::new())
    }

    /// [`entry`] under a customization dict. The dict is read **where
    /// the catalog is built**, which is the boundary a database's
    /// wording crosses; `set_settings` drops the math model cache, so
    /// editing one rebuilds every entry and re-resolves every channel.
    fn entry_with(
        name: &str,
        unit: &str,
        customizations: &crate::units::Customizations,
    ) -> MathCatalogEntry {
        entry_reading(
            name,
            crate::units::UnitReading::declared(unit, customizations),
        )
    }

    /// A catalog entry carrying a unit the project already placed —
    /// a reinterpretation, or another definition's target.
    fn entry_reading(name: &str, unit: crate::units::UnitReading) -> MathCatalogEntry {
        MathCatalogEntry {
            reference: sig(name),
            path: format!("bus/ECU/Msg/{name}"),
            unit,
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
            (MathFunction::integration(), Arity::One),
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
    fn an_unfinished_definition_is_stored_and_marked_invalid() {
        // A math signal exists from the moment its function is picked
        // and is filled in field by field, so the registry has to hold
        // one that is not finished yet. It says why, and serves nothing
        // meanwhile.
        let registry = MathRegistry::new();
        let half = def("m1", MathFunction::Difference, picks(&[sig("A")]));
        assert!(matches!(half.validate(), Err(MathError::Arity { .. })));
        registry.define(half).expect("stored, unfinished");
        assert_eq!(registry.list().len(), 1);
        registry
            .update(def(
                "m1",
                MathFunction::Difference,
                picks(&[sig("A"), sig("B")]),
            ))
            .expect("finished in place");
        assert!(registry.list()[0].validate().is_ok());
    }

    #[test]
    fn a_definition_with_no_name_is_invalid_until_it_has_one() {
        // The one name the host derives is a pattern-only set's
        // `fn(pattern)`; every other definition is named by the user,
        // and is unusable until it is.
        let mut d = def("m1", MathFunction::Rms, picks(&[sig("A")]));
        d.name = String::new();
        assert!(matches!(d.validate(), Err(MathError::Unnamed)), "{d:?}");
        d.name = "Rectified".to_string();
        assert!(d.validate().is_ok());
    }

    #[test]
    fn only_a_set_function_takes_a_pattern() {
        let mut d = def("m1", MathFunction::Rms, picks(&[sig("A")]));
        d.operands.patterns = vec!["Cell".to_string()];
        assert!(
            matches!(d.validate(), Err(MathError::PatternsNotAllowed { .. })),
            "{d:?}"
        );
    }

    #[test]
    fn an_uncompilable_pattern_is_reported_on_the_definition_holding_it() {
        let d = def("m1", MathFunction::Max, pattern("Cell("));
        assert!(
            matches!(d.validate(), Err(MathError::BadPattern { .. })),
            "{d:?}"
        );
        // Stored anyway: a half-typed regex is a state the editor shows.
        MathRegistry::new().define(d).expect("stored");
    }

    #[test]
    fn a_zero_or_negative_time_constant_is_invalid() {
        for tau in [0.0, -1.0] {
            let d = def(
                "m1",
                MathFunction::ExpFilter { tau_seconds: tau },
                picks(&[sig("A")]),
            );
            assert!(
                matches!(d.validate(), Err(MathError::BadParameter { .. })),
                "{tau}"
            );
        }
    }

    #[test]
    fn a_percentile_outside_zero_to_a_hundred_is_invalid() {
        let d = def(
            "m1",
            MathFunction::Statistic {
                statistic: Statistic::Percentile,
                percentile: 150.0,
            },
            picks(&[sig("A")]),
        );
        assert!(
            matches!(d.validate(), Err(MathError::BadParameter { .. })),
            "{d:?}"
        );
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
        assert_eq!(
            registry.list()[0].operands.picks,
            [MathOperand::new(sig("A"))]
        );
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
                MathFunction::integration(),
                picks(&[MathOperandRef::math("m2")]),
            ))
            .expect("m3 over m2");
        assert_eq!(registry.list().len(), 3);
    }

    #[test]
    fn an_operand_naming_no_definition_is_kept() {
        // Deleting a definition leaves its dependents holding a
        // dangling reference by design; they stay editable, so the user
        // can repair them. The listing shows the operand as missing.
        let registry = MathRegistry::new();
        registry
            .define(def(
                "m1",
                MathFunction::Rms,
                picks(&[MathOperandRef::math("gone")]),
            ))
            .expect("stored with the dangling reference");
        assert_eq!(registry.list().len(), 1);
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
            o.picks = vec![MathOperand::new(sig("PackVolts"))];
            o
        })];
        let catalog = [
            entry("Cell01", "V"),
            entry("Cell02", "V"),
            entry("PackVolts", "V"),
            entry("Current", "A"),
        ];
        let model = resolve(&definitions, &catalog);
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
        let before = resolve(&definitions, &[entry("Cell01", "V")]);
        let after = resolve(&definitions, &[entry("Cell01", "V"), entry("Cell02", "V")]);
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
                unit: crate::units::UnitReading::default(),
            },
            entry("mA", "V"),
        ];
        let model = resolve(&definitions, &catalog);
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
    fn a_uniform_set_inherits_its_operand_unit_and_a_product_composes_them() {
        let uniform = vec![def("m1", MathFunction::Sum, pattern(r"Cell\d+"))];
        let model = resolve(&uniform, &[entry("Cell01", "V"), entry("Cell02", "V")]);
        assert_eq!(model.get("m1").expect("m1").unit, "V");

        // A product is dimensional analysis, not agreement: volts by
        // amps is `V·A`, which is a power.
        let product = vec![def(
            "m1",
            MathFunction::Product,
            picks(&[sig("PackVolts"), sig("Current")]),
        )];
        let model = resolve(&product, &[entry("PackVolts", "V"), entry("Current", "A")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.unit, "V·A");
        assert_eq!(r.kind, Some(crate::units::Dimension::Power));
    }

    /// The buses a math signal's row wears as color chips. A math
    /// series has no bus of its own (ADR 0038 gives it no path), so
    /// the chips name where its *input* comes from — and a set drawn
    /// from two buses is what turns the row's label into
    /// "Math - Multiple Busses".
    #[test]
    fn a_math_signal_names_every_bus_its_operands_come_from() {
        let definitions = vec![def(
            "m1",
            MathFunction::Sum,
            picks(&[
                MathOperandRef::dbc("pack", 256, false, "Cell01"),
                MathOperandRef::dbc("zonal", 257, false, "WheelSpeed"),
                MathOperandRef::dbc("pack", 256, false, "Cell02"),
            ]),
        )];
        let model = resolve(&definitions, &[]);
        // Sorted and deduped: the chips are a set, and their order must
        // not depend on the order the operands happen to be picked in.
        assert_eq!(model.get("m1").expect("m1").bus_ids, ["pack", "zonal"]);
    }

    /// Attribution is **transitive**: a math signal over a math signal
    /// wears the buses that reach it, however deep the chain.
    #[test]
    fn bus_attribution_follows_a_math_operand_into_its_own_operands() {
        let definitions = vec![
            def(
                "m2",
                MathFunction::Rms,
                picks(&[MathOperandRef::math("m1")]),
            ),
            def(
                "m1",
                MathFunction::Sum,
                picks(&[
                    MathOperandRef::dbc("pack", 256, false, "Cell01"),
                    MathOperandRef::dbc("zonal", 257, false, "WheelSpeed"),
                ]),
            ),
        ];
        // m2 is listed *before* the definition it reads, so this also
        // pins that attribution does not depend on registry order.
        let model = resolve(&definitions, &[]);
        assert_eq!(model.get("m2").expect("m2").bus_ids, ["pack", "zonal"]);
    }

    /// A file-backed operand carries no bus, and an operand naming a
    /// definition that is gone carries nothing at all — neither is an
    /// error, and neither invents a chip.
    #[test]
    fn an_operand_with_no_bus_contributes_no_chip() {
        let definitions = vec![def(
            "m1",
            MathFunction::Sum,
            picks(&[
                MathOperandRef::file(3, "EngineSpeed"),
                MathOperandRef::math("gone"),
                MathOperandRef::dbc("pack", 256, false, "Cell01"),
            ]),
        )];
        let model = resolve(&definitions, &[]);
        assert_eq!(model.get("m1").expect("m1").bus_ids, ["pack"]);
    }

    #[test]
    fn integration_derives_a_charge_and_duty_and_frequency_state_their_own() {
        let catalog = [entry("Current", "A")];
        let cases = [
            (MathFunction::integration(), "A·s"),
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
            let model = resolve(&definitions, &catalog);
            assert_eq!(model.get("m1").expect("m1").unit, unit, "{kind}");
        }
    }

    /// An integration's derived unit is the **composition**, spelled
    /// as its factors: `A · s` reads `A·s`, not the coulomb it is
    /// dimensionally (a contraction is used only where the named unit
    /// spells the same thing the factors do, which is what makes
    /// `A · h` read `Ah`). An operand the project cannot place derives
    /// nothing at all — nothing is guessed.
    #[test]
    fn an_integral_derives_the_composition_of_its_operand_and_its_time_unit() {
        let cases = [
            ("A", "A·s"),
            ("W", "W·s"),
            ("mA", "mA·s"),
            ("widgets", ""),
            ("V", "V·s"),
        ];
        for (unit, derived) in cases {
            let definitions = vec![def(
                "m1",
                MathFunction::integration(),
                picks(&[sig("Current")]),
            )];
            let model = resolve(&definitions, &[entry("Current", unit)]);
            assert_eq!(model.get("m1").expect("m1").unit, derived, "{unit}");
        }
    }

    /// The dict reaches the derived unit too: an in-house spelling that
    /// the user has placed integrates into the same charge `A` does.
    #[test]
    fn a_customization_reaches_the_derived_integral() {
        let definitions = vec![def(
            "m1",
            MathFunction::integration(),
            picks(&[sig("Current")]),
        )];
        let dict: crate::units::Customizations = [("Amperes".to_string(), "ampere".to_string())]
            .into_iter()
            .collect();
        let model = MathModel::resolve(
            &definitions,
            &[entry_with("Current", "Amperes", &dict)],
            &dict,
        );
        let r = model.get("m1").expect("m1");
        assert_eq!(r.unit, "A·s");
        assert_eq!(r.kind, Some(crate::units::Dimension::Charge));
    }

    #[test]
    fn a_user_specified_unit_wins_over_the_derived_one() {
        let mut d = def("m1", MathFunction::integration(), picks(&[sig("Current")]));
        d.unit = Some("C".into());
        let model = resolve(std::slice::from_ref(&d), &[entry("Current", "A")]);
        assert_eq!(model.get("m1").expect("m1").unit, "C");
    }

    // ---- derivation, time units, the derivative, recognition state ----

    /// Every function derives something. The three that state a fixed
    /// quantity state it; the composing ones compose; everything else
    /// inherits its operand's unit.
    #[test]
    fn every_function_derives_an_output_unit() {
        let cases: &[(MathFunction, &str)] = &[
            (MathFunction::Sum, "A"),
            (MathFunction::Min, "A"),
            (MathFunction::Max, "A"),
            (MathFunction::Average, "A"),
            (MathFunction::Median, "A"),
            (MathFunction::Range, "A"),
            (MathFunction::Rms, "A"),
            (
                MathFunction::Scale {
                    gain: 2.0,
                    offset: 0.0,
                },
                "A",
            ),
            (MathFunction::ExpFilter { tau_seconds: 1.0 }, "A"),
            (
                MathFunction::Statistic {
                    statistic: Statistic::Mean,
                    percentile: 0.0,
                },
                "A",
            ),
            (MathFunction::integration(), "A·s"),
            (MathFunction::derivative(), "A/s"),
            (
                MathFunction::Duty {
                    threshold: 1.0,
                    window_seconds: 5.0,
                },
                "%",
            ),
            (
                MathFunction::Frequency {
                    threshold: 1.0,
                    window_seconds: 5.0,
                },
                "Hz",
            ),
        ];
        for (function, unit) in cases {
            let kind = function.kind();
            let definitions = vec![def("m1", function.clone(), picks(&[sig("Current")]))];
            let model = resolve(&definitions, &[entry("Current", "A")]);
            assert_eq!(model.get("m1").expect("m1").unit, *unit, "{kind}");
        }
        // Two operands, so they get their own definitions.
        let pair = vec![def(
            "m1",
            MathFunction::Difference,
            picks(&[sig("A1"), sig("A2")]),
        )];
        let model = resolve(&pair, &[entry("A1", "A"), entry("A2", "A")]);
        assert_eq!(model.get("m1").expect("m1").unit, "A");
        // HLine has no operand to read, so it is a bare number.
        let hline = vec![def("m1", MathFunction::HLine { value: 1.0 }, picks(&[]))];
        assert_eq!(resolve(&hline, &[]).get("m1").expect("m1").unit, "scalar");
    }

    /// The exit criterion: a set whose members are like-kind converts
    /// and inherits **with no target set at all** â the derivation is
    /// what the members are summed in.
    #[test]
    fn a_mixed_like_kind_set_converts_to_the_unit_it_derives() {
        let definitions = vec![def("m1", MathFunction::Sum, pattern("Cell"))];
        let model = resolve(&definitions, &[entry("CellA", "A"), entry("CellB", "mA")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.unit, "A");
        assert_eq!(
            r.operand_affines,
            [Affine::IDENTITY, Affine::new(0.001, 0.0)]
        );
        assert!(r.unconverted.is_empty(), "{:?}", r.unconverted);
    }

    /// â¦and the honest opposite: an additive set mixing dimensions
    /// cannot be summed, so it derives nothing and every member is
    /// badged.
    #[test]
    fn an_additive_set_mixing_dimensions_derives_nothing_and_badges_its_members() {
        let definitions = vec![def("m1", MathFunction::Sum, pattern("Any"))];
        let model = resolve(
            &definitions,
            &[entry("AnyVolts", "V"), entry("AnyAmps", "A")],
        );
        let r = model.get("m1").expect("m1");
        assert_eq!(r.unit, "");
        assert_eq!(r.kind, None);
        assert_eq!(r.unconverted, [0, 1]);
    }

    /// A member the project cannot place is **not** a dimension
    /// disagreement — it is silence — so it does not veto what the
    /// members that *are* placed inherit. A wide pattern picks up a
    /// blank-unit signal sooner or later; the set still derives the
    /// volts its recognized members agree on, wherever the silent one
    /// falls in the order.
    #[test]
    fn an_unplaced_member_does_not_veto_the_unit_its_set_inherits() {
        let definitions = vec![def("m1", MathFunction::Range, pattern("Cell"))];
        // The unplaced member first, in the middle, and last: the
        // inherited unit is the same one every time.
        let cases: [&[(&str, &str)]; 3] = [
            &[("CellA", ""), ("CellB", "V"), ("CellC", "mV")],
            &[("CellA", "V"), ("CellB", "widgets"), ("CellC", "mV")],
            &[("CellA", "V"), ("CellB", "mV"), ("CellC", "")],
        ];
        for case in cases {
            let catalog: Vec<MathCatalogEntry> = case.iter().map(|(n, u)| entry(n, u)).collect();
            let model = resolve(&definitions, &catalog);
            assert_eq!(model.get("m1").expect("m1").unit, "V", "{case:?}");
        }

        // And a pattern-fed set derives exactly what the same members
        // picked by hand derive — membership is membership.
        let picked = vec![def(
            "m1",
            MathFunction::Range,
            picks(&[sig("CellA"), sig("CellB")]),
        )];
        let catalog = [entry("CellA", ""), entry("CellB", "V")];
        assert_eq!(resolve(&picked, &catalog).get("m1").expect("m1").unit, "V");
    }

    /// The other side of that line: silence is forgiven, disagreement
    /// is not. A set that mixes `V` with `A` derives nothing whether or
    /// not an unplaced member sits beside them.
    #[test]
    fn an_unplaced_member_does_not_rescue_a_set_that_mixes_dimensions() {
        let definitions = vec![def("m1", MathFunction::Sum, pattern("Any"))];
        let model = resolve(
            &definitions,
            &[
                entry("AnyBlank", ""),
                entry("AnyVolts", "V"),
                entry("AnyAmps", "A"),
            ],
        );
        let r = model.get("m1").expect("m1");
        assert_eq!(r.unit, "");
        assert_eq!(r.kind, None);
    }

    /// Time is the function's parameter: `operand · h` derives `Ah`,
    /// which is just `A · h` spelled the familiar way.
    #[test]
    fn an_integration_follows_its_function_row_time_unit() {
        let hours = MathFunction::Integration {
            time_unit: crate::units::UnitId::base("hour"),
        };
        let definitions = vec![def("m1", hours, picks(&[sig("Current")]))];
        let model = resolve(&definitions, &[entry("Current", "A")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.unit, "Ah");
        assert_eq!(r.kind, Some(crate::units::Dimension::Charge));
        // Nothing is asked for, so nothing converts â the kernel
        // accumulates in hours instead.
        assert_eq!(r.operand_affines, [Affine::IDENTITY]);
        assert!(r.output_affine.is_identity(), "{:?}", r.output_affine);
    }

    /// The derivative's unit is `operand / [t]`, and the division lands
    /// in a **named** family: an `Ah` counter over `d/ds` is `Ah/s`,
    /// dimensionally a current â so `A` is reachable, at ×3600.
    #[test]
    fn a_derivative_of_an_amp_hour_counter_reaches_amps() {
        let mut d = def("m1", MathFunction::derivative(), picks(&[sig("Charge")]));
        let model = resolve(std::slice::from_ref(&d), &[entry("Charge", "Ah")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.unit, "Ah/s");
        assert_eq!(r.kind, Some(crate::units::Dimension::Current));

        d.unit = Some("A".into());
        let model = resolve(std::slice::from_ref(&d), &[entry("Charge", "Ah")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.unit, "A");
        assert!(r.unconverted.is_empty(), "{:?}", r.unconverted);
        assert_eq!(r.operand_affines, [Affine::IDENTITY]);
        assert!(
            (r.output_affine.gain - 3600.0).abs() < 1e-9,
            "{:?}",
            r.output_affine
        );
    }

    /// The composition the crate never enumerates, end to end: a
    /// nanoamp operand integrated over hours is `nAh`, and asking for
    /// `Ah` is the billionth the analysis produces.
    #[test]
    fn a_nanoamp_integrated_over_hours_is_a_nanoamp_hour_and_reaches_amp_hours() {
        let hours = MathFunction::Integration {
            time_unit: crate::units::UnitId::base("hour"),
        };
        let mut d = def("m1", hours, picks(&[sig("Leak")]));
        let model = resolve(std::slice::from_ref(&d), &[entry("Leak", "nA")]);
        assert_eq!(model.get("m1").expect("m1").unit, "nAh");

        d.unit = Some("Ah".into());
        let model = resolve(std::slice::from_ref(&d), &[entry("Leak", "nA")]);
        let r = model.get("m1").expect("m1");
        assert!(r.unconverted.is_empty(), "{:?}", r.unconverted);
        let whole = r.operand_affines[0].gain * r.output_affine.gain;
        assert!((1.0 - whole / 1e-9).abs() < 1e-9, "{whole}");
    }

    /// **Recognition state, per operand.** Convertibility is not the
    /// whole story at edit time: an unplaceable unit string and a
    /// placeable one of the wrong kind are different problems.
    #[test]
    fn resolve_reports_each_operands_recognition_state() {
        let definitions = vec![def("m1", MathFunction::Sum, pattern("Any"))];
        let model = resolve(
            &definitions,
            &[
                entry("AnyAmps", "mA"),
                entry("AnyBlank", ""),
                entry("AnyOdd", "widgets"),
            ],
        );
        let r = model.get("m1").expect("m1");
        assert_eq!(
            r.recognition,
            [
                UnitRecognition::Recognized {
                    unit: crate::units::UnitId::new("ampere", crate::units::Prefix::Milli),
                    display: "mA".to_string(),
                },
                UnitRecognition::Blank,
                UnitRecognition::Unrecognized {
                    spelling: "widgets".to_string(),
                },
            ]
        );
    }

    /// A customization changes the parse state, which is what makes the
    /// editor's chip clear itself when the user maps the string.
    #[test]
    fn a_customization_moves_an_operand_from_unrecognised_to_recognised() {
        let definitions = vec![def("m1", MathFunction::Sum, picks(&[sig("Odd")]))];
        let plain = MathModel::resolve(
            &definitions,
            &[entry("Odd", "Amperes")],
            &crate::units::Customizations::new(),
        );
        assert!(matches!(
            plain.get("m1").expect("m1").recognition[0],
            UnitRecognition::Unrecognized { .. }
        ));
        let dict: crate::units::Customizations = [("Amperes".to_string(), "ampere".to_string())]
            .into_iter()
            .collect();
        let mapped =
            MathModel::resolve(&definitions, &[entry_with("Odd", "Amperes", &dict)], &dict);
        assert!(matches!(
            mapped.get("m1").expect("m1").recognition[0],
            UnitRecognition::Recognized { .. }
        ));
    }

    /// **Old files load unchanged.** A definition written before the
    /// time parameter and the typed unit existed deserialises to
    /// seconds and to a spelling, and means exactly what it did.
    #[test]
    fn an_old_definition_deserialises_to_seconds_and_a_spelled_unit() {
        let json = r#"{
            "id": "m1", "name": "Charge", "unit": "Ah",
            "function": {"kind": "integration"},
            "operands": {"picks": [], "patterns": []}
        }"#;
        let d: MathDefinition = serde_json::from_str(json).expect("old definition");
        assert_eq!(d.function, MathFunction::integration());
        assert_eq!(d.unit, Some(UnitTarget::Spelled("Ah".to_string())));
        assert_eq!(d.function.parameters(), [1.0]);
    }

    /// â¦and a definition saved with the typed form round-trips.
    #[test]
    fn a_typed_unit_target_round_trips_through_json() {
        let mut d = def("m1", MathFunction::derivative(), picks(&[sig("Charge")]));
        d.unit = Some(UnitTarget::Typed(crate::units::UnitId::new(
            "ampere-hour",
            crate::units::Prefix::Nano,
        )));
        let json = serde_json::to_string(&d).expect("serialize");
        let back: MathDefinition = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, d);
        // A typed target places a unit the same way a spelling does.
        let model = resolve(std::slice::from_ref(&d), &[entry("Charge", "Ah")]);
        assert_eq!(model.get("m1").expect("m1").unit, "nAh");
    }

    /// The time unit is a parameter, so changing it moves the
    /// fingerprint's parameter vector and rebuilds the series.
    #[test]
    fn the_time_unit_is_a_parameter_the_fingerprint_reads() {
        assert_eq!(MathFunction::integration().parameters(), [1.0]);
        assert_eq!(
            MathFunction::Integration {
                time_unit: crate::units::UnitId::base("hour"),
            }
            .parameters(),
            [3600.0]
        );
        assert_eq!(MathFunction::derivative().kind(), "derivative");
        assert_eq!(MathFunction::derivative().arity(), Arity::One);
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
                MathFunction::integration(),
                picks(&[MathOperandRef::math("m1")]),
            ),
            def(
                "m3",
                MathFunction::Difference,
                picks(&[MathOperandRef::math("m2"), MathOperandRef::math("m1")]),
            ),
        ];
        let model = resolve(&definitions, &[]);
        assert_eq!(
            model.dependency_order(&["m3".to_string()]),
            ["m1", "m2", "m3"]
        );
    }

    // ---- units and scaling ------------------------------------------

    /// The headline case: one pattern-defined set whose members carry
    /// milliamps beside amps, computed in the definition's target unit
    /// with a correct factor **per member**.
    #[test]
    fn a_target_unit_converts_each_member_by_its_own_factor() {
        let mut d = def("m1", MathFunction::Sum, pattern("Cell"));
        d.unit = Some("A".into());
        let model = resolve(&[d], &[entry("CellA", "A"), entry("CellB", "mA")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(names(&model, "m1"), ["CellA", "CellB"]);
        assert_eq!(
            r.operand_affines,
            [Affine::IDENTITY, Affine::new(0.001, 0.0)]
        );
        assert!(r.unconverted.is_empty(), "{:?}", r.unconverted);
    }

    /// **A set collected in the bare 0–1 scale converts to whichever
    /// scale its target names**: ×100 for a percentage, ×10⁶ for parts
    /// per million.
    ///
    /// Every unit reaches resolve as a *string* — the one the operand's
    /// database reports, and the one the definition names — so this is
    /// the round trip the bare scale has to survive. A scale rendered
    /// as something [`crate::units::recognize`] cannot place converts
    /// nothing, and every target then serves the operands' own numbers
    /// unchanged.
    #[test]
    fn a_ratio_set_converts_to_the_scale_its_target_names() {
        let bare = crate::units::get("ratio").expect("the bare ratio").display;
        for (target, gain) in [(bare, 1.0), ("%", 100.0), ("ppm", 1e6)] {
            let mut d = def("m1", MathFunction::Sum, pattern("Cell"));
            d.unit = Some(UnitTarget::from(target));
            let model = resolve(&[d], &[entry("CellA", bare), entry("CellB", bare)]);
            let r = model.get("m1").expect("m1");
            assert!(r.unconverted.is_empty(), "{target}: {:?}", r.unconverted);
            assert_eq!(r.operand_affines.len(), 2, "{target}");
            for affine in &r.operand_affines {
                assert!(
                    (affine.gain - gain).abs() < gain * 1e-9,
                    "{target}: {affine:?}"
                );
                assert!(affine.offset.abs() < 1e-9, "{target}: {affine:?}");
            }
        }
    }

    /// **A database that declares `%1.0` is declaring the bare 0–1
    /// scale**, and reaches a `%` target scaled ×100 — the spelling is
    /// the only thing that can say which scale a proportion is on, so
    /// this is the whole of the convention, end to end from the
    /// operand's database string.
    #[test]
    fn a_database_declaring_the_ratio_percent_spelling_reads_at_the_bare_scale() {
        for (declared, target, gain) in [("%1.0", "%", 100.0), ("%", "%1.0", 0.01)] {
            let mut d = def("m1", MathFunction::Sum, pattern("Cell"));
            d.unit = Some(UnitTarget::from(target));
            let model = resolve(&[d], &[entry("CellA", declared)]);
            let r = model.get("m1").expect("m1");
            assert!(
                r.unconverted.is_empty(),
                "{declared} to {target}: {:?}",
                r.unconverted
            );
            let affine = r.operand_affines[0];
            assert!(
                (affine.gain - gain).abs() < gain * 1e-9,
                "{declared} to {target}: {affine:?}"
            );
        }
    }

    /// A unit string the library does not carry is a **label**: it names
    /// the series and changes no number. What the members are summed in
    /// is the derivation's answer, not the label's.
    #[test]
    fn an_unplaceable_label_names_the_series_and_converts_nothing() {
        for unit in [None, Some(UnitTarget::from("widgets"))] {
            let mut d = def("m1", MathFunction::Sum, pattern("Cell"));
            d.unit.clone_from(&unit);
            let model = resolve(
                &[d],
                &[entry("CellA", "widgets"), entry("CellB", "widgets")],
            );
            let r = model.get("m1").expect("m1");
            assert_eq!(
                r.operand_affines,
                [Affine::IDENTITY, Affine::IDENTITY],
                "{unit:?}"
            );
            // Nothing was asked for and nothing was placed, so nothing
            // is reported as missed.
            assert!(r.unconverted.is_empty(), "{unit:?}");
        }
    }

    /// A member the target cannot be reached from passes through
    /// unscaled and is **reported** — the ruling that nothing converts
    /// silently wrong. Three ways to miss: a unit string nothing
    /// recognises, one naming something else entirely, and none at all.
    #[test]
    fn an_unconvertible_member_passes_through_unscaled_and_is_reported() {
        let mut d = def("m1", MathFunction::Sum, pattern("Cell"));
        d.unit = Some("A".into());
        let model = resolve(
            &[d],
            &[
                entry("CellA", "A"),
                entry("CellB", "widgets"),
                entry("CellC", "V"),
                entry("CellD", ""),
            ],
        );
        let r = model.get("m1").expect("m1");
        assert_eq!(r.unconverted, [1, 2, 3]);
        assert_eq!(r.operand_affines[0], Affine::IDENTITY);
        for i in &r.unconverted {
            assert_eq!(r.operand_affines[*i], Affine::IDENTITY, "operand {i}");
        }
    }

    #[test]
    fn a_source_unit_override_converts_a_mislabelled_operand() {
        let mut d = def("m1", MathFunction::Sum, picks(&[sig("Cell")]));
        d.unit = Some("A".into());
        d.operands.picks[0].source_unit = Some("milliampere".to_string());
        // The database calls it nothing the host knows; the override is
        // what makes it convertible, and it is local to this definition.
        let model = resolve(&[d], &[entry("Cell", "widgets")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.operand_affines, [Affine::new(0.001, 0.0)]);
        assert!(r.unconverted.is_empty());
    }

    /// **A unit chosen in the model is a unit, not the string it reads
    /// as.** A signal the project reinterpreted as coulomb converts as
    /// a coulomb even though `C` is deliberately absent from the
    /// recognition table (it would be a guess against Celsius).
    #[test]
    fn a_reinterpreted_charge_operand_converts_to_the_target_it_was_given() {
        let store: crate::signal_units::SignalUnits =
            [("bus|s:256:Q".to_string(), UnitId::base("coulomb"))]
                .into_iter()
                .collect();
        let reinterpreted = crate::signal_units::unit_of(
            &store,
            "bus|s:256:Q",
            "A",
            &crate::units::Customizations::new(),
        );
        assert_eq!(reinterpreted.display, "C", "it still reads as C");
        let mut d = def("m1", MathFunction::Sum, picks(&[sig("Q")]));
        d.unit = Some(UnitTarget::Typed(UnitId::new(
            "coulomb",
            crate::units::Prefix::Milli,
        )));
        let model = resolve(&[d], &[entry_reading("Q", reinterpreted)]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.operand_affines, [Affine::new(1000.0, 0.0)]);
        assert!(r.unconverted.is_empty());
    }

    /// The same, for the other unit whose spelling recognition refuses:
    /// `newton-millimeter` reads `Nmm`.
    #[test]
    fn a_reinterpreted_torque_operand_converts_to_the_target_it_was_given() {
        let store: crate::signal_units::SignalUnits = [(
            "bus|s:256:T".to_string(),
            UnitId::new("newton-meter", crate::units::Prefix::Milli),
        )]
        .into_iter()
        .collect();
        let reinterpreted = crate::signal_units::unit_of(
            &store,
            "bus|s:256:T",
            "Nm",
            &crate::units::Customizations::new(),
        );
        assert_eq!(reinterpreted.display, "Nmm", "it still reads as Nmm");
        let mut d = def("m1", MathFunction::Sum, picks(&[sig("T")]));
        d.unit = Some(UnitTarget::Typed(UnitId::base("newton-meter")));
        let model = resolve(&[d], &[entry_reading("T", reinterpreted)]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.operand_affines, [Affine::new(0.001, 0.0)]);
        assert!(r.unconverted.is_empty());
    }

    /// An integration of amps targeted at coulombs is the conversion
    /// the *function* produces, and it costs nothing.
    #[test]
    fn an_integration_of_amps_targeted_at_coulombs_converts_on_the_output() {
        let mut d = def("m1", MathFunction::integration(), picks(&[sig("I")]));
        d.unit = Some(UnitTarget::Typed(UnitId::base("coulomb")));
        let model = resolve(&[d], &[entry("I", "A")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.output_affine, Affine::IDENTITY);
        assert!(r.unconverted.is_empty());
    }

    /// A definition hands its own target on to the definitions that
    /// read it as a **unit**, so a chain through coulombs converts.
    #[test]
    fn a_definition_targeted_at_coulombs_hands_that_unit_to_its_readers() {
        let mut source = def("m1", MathFunction::integration(), picks(&[sig("I")]));
        source.unit = Some(UnitTarget::Typed(UnitId::base("coulomb")));
        let mut consumer = def(
            "m2",
            MathFunction::Sum,
            picks(&[MathOperandRef::math("m1")]),
        );
        consumer.unit = Some(UnitTarget::Typed(UnitId::new(
            "coulomb",
            crate::units::Prefix::Milli,
        )));
        let model = resolve(&[source, consumer], &[entry("I", "A")]);
        let r = model.get("m2").expect("m2");
        assert_eq!(r.operand_affines, [Affine::new(1000.0, 0.0)]);
        assert!(r.unconverted.is_empty());
    }

    #[test]
    fn manual_scalars_work_with_no_units_anywhere() {
        let mut d = def("m1", MathFunction::Sum, picks(&[sig("A")]));
        d.operands.picks[0].gain = Some(2.0);
        d.operands.picks[0].offset = Some(-1.0);
        d.output_gain = Some(10.0);
        d.output_offset = Some(3.0);
        let model = resolve(&[d], &[entry("A", "")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.operand_affines, [Affine::new(2.0, -1.0)]);
        assert_eq!(r.output_affine, Affine::new(10.0, 3.0));
    }

    /// The manual scalar corrects the *raw* value into the unit the
    /// operand claims to be in, so it runs ahead of the conversion.
    #[test]
    fn a_manual_scalar_composes_ahead_of_the_conversion() {
        let mut d = def("m1", MathFunction::Sum, picks(&[sig("Cell")]));
        d.unit = Some("A".into());
        d.operands.picks[0].gain = Some(0.5);
        let model = resolve(&[d], &[entry("Cell", "mA")]);
        let affine = model.get("m1").expect("m1").operand_affines[0];
        assert!((affine.gain - 0.000_5).abs() < 1e-12, "{affine:?}");
        assert!((affine.apply(4000.0) - 2.0).abs() < 1e-12, "{affine:?}");
    }

    /// Integration multiplies by time, so a target in the **integrated**
    /// dimension is reachable from a rate operand: the operand only has
    /// to reach its family's canonical rate, and the *output* carries
    /// the canonical integral to what the user asked for.
    #[test]
    fn integrating_a_current_reaches_a_charge_through_time() {
        let mut d = def("m1", MathFunction::integration(), picks(&[sig("Current")]));
        d.unit = Some("Ah".into());
        let model = resolve(std::slice::from_ref(&d), &[entry("Current", "A")]);
        let r = model.get("m1").expect("m1");
        // Amps are already the canonical rate, so the operand is
        // untouched — the owner's report was that this badged.
        assert_eq!(r.operand_affines, [Affine::IDENTITY]);
        assert!(r.unconverted.is_empty(), "{:?}", r.unconverted);
        // A·s is a coulomb; a coulomb is an amp-hour ÷ 3600.
        let out = r.output_affine;
        assert!((out.gain - 1.0 / 3600.0).abs() < 1e-15, "{out:?}");
        assert!((out.offset).abs() < 1e-15, "{out:?}");
    }

    /// A milliamp operand reaches amp-hours too, and by the whole
    /// factor: the composition `mA · s` is what converts, so the
    /// thousandth and the 3600th ride the output together and the
    /// operand's samples stay in the unit its database names.
    #[test]
    fn a_milliamp_operand_integrates_into_amp_hours() {
        let mut d = def("m1", MathFunction::integration(), picks(&[sig("Current")]));
        d.unit = Some("Ah".into());
        let model = resolve(std::slice::from_ref(&d), &[entry("Current", "mA")]);
        let r = model.get("m1").expect("m1");
        assert!(r.unconverted.is_empty(), "{:?}", r.unconverted);
        let whole = r.operand_affines[0].gain * r.output_affine.gain;
        assert!((whole - 0.001 / 3600.0).abs() < 1e-18, "{whole}");
    }

    #[test]
    fn integrating_a_power_reaches_an_energy() {
        let mut d = def("m1", MathFunction::integration(), picks(&[sig("Power")]));
        d.unit = Some("kWh".into());
        let model = resolve(std::slice::from_ref(&d), &[entry("Power", "W")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.operand_affines, [Affine::IDENTITY]);
        assert!(r.unconverted.is_empty(), "{:?}", r.unconverted);
        assert!(
            (r.output_affine.gain - 1.0 / 3_600_000.0).abs() < 1e-15,
            "{:?}",
            r.output_affine
        );
    }

    /// A target in the operand's **own** family keeps the pointwise
    /// semantics — integrate in milliamps, and the output is untouched.
    /// (The owner's workaround before the ruling, which stays valid.)
    #[test]
    fn a_target_in_the_operands_own_family_still_converts_the_operand() {
        let mut d = def("m1", MathFunction::integration(), picks(&[sig("Current")]));
        d.unit = Some("mA".into());
        let model = resolve(std::slice::from_ref(&d), &[entry("Current", "A")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.operand_affines, [Affine::new(1000.0, 0.0)]);
        assert!(r.unconverted.is_empty(), "{:?}", r.unconverted);
        assert_eq!(r.output_affine, Affine::IDENTITY);
    }

    /// Neither the operand's family nor its integral: a true dead end,
    /// which still passes through unscaled and is still reported.
    #[test]
    fn an_integration_target_of_another_dimension_is_still_unconverted() {
        let mut d = def("m1", MathFunction::integration(), picks(&[sig("Current")]));
        d.unit = Some("V".into());
        let model = resolve(std::slice::from_ref(&d), &[entry("Current", "A")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.unconverted, [0]);
        assert_eq!(r.operand_affines, [Affine::IDENTITY]);
        assert_eq!(r.output_affine, Affine::IDENTITY);
    }

    /// The time conversion is the function's, so it composes *after*
    /// the output scalars the user typed — which correct the value the
    /// function computed, in the unit it computed it in.
    #[test]
    fn the_integrated_conversion_composes_with_the_manual_output_scalars() {
        let mut d = def("m1", MathFunction::integration(), picks(&[sig("Current")]));
        d.unit = Some("Ah".into());
        d.output_gain = Some(2.0);
        d.output_offset = Some(3600.0);
        let model = resolve(std::slice::from_ref(&d), &[entry("Current", "A")]);
        let out = model.get("m1").expect("m1").output_affine;
        // 1 coulomb → 2·1 + 3600 coulombs → ÷3600 amp-hours.
        assert!((out.apply(1.0) - 3602.0 / 3600.0).abs() < 1e-15, "{out:?}");
    }

    /// Only integration reaches across dimensions: a pointwise function
    /// asked for a charge from a current is the mismatch it always was.
    #[test]
    fn a_pointwise_function_does_not_reach_the_integrated_dimension() {
        let mut d = def("m1", MathFunction::Rms, picks(&[sig("Current")]));
        d.unit = Some("Ah".into());
        let model = resolve(std::slice::from_ref(&d), &[entry("Current", "A")]);
        let r = model.get("m1").expect("m1");
        assert_eq!(r.unconverted, [0]);
        assert_eq!(r.output_affine, Affine::IDENTITY);
    }

    /// A customization is what makes an in-house unit string mean
    /// something — and editing it is what rescales the channel.
    #[test]
    fn a_customization_decides_what_a_member_converts_from() {
        let mut d = def("m1", MathFunction::Sum, picks(&[sig("Cell")]));
        d.unit = Some("A".into());
        let plain = MathModel::resolve(
            std::slice::from_ref(&d),
            &[entry("Cell", "counts")],
            &crate::units::Customizations::new(),
        );
        assert_eq!(plain.get("m1").expect("m1").unconverted, [0]);

        let dict: crate::units::Customizations =
            [("counts".to_string(), "milliampere".to_string())]
                .into_iter()
                .collect();
        let customized = MathModel::resolve(
            std::slice::from_ref(&d),
            &[entry_with("Cell", "counts", &dict)],
            &dict,
        );
        let r = customized.get("m1").expect("m1");
        assert_eq!(r.operand_affines, [Affine::new(0.001, 0.0)]);
        assert!(r.unconverted.is_empty());
    }

    /// Temperature is the affine case, and DBC readings are absolute
    /// (owner ruling), so a kelvin member read as °C shifts as well as
    /// scales.
    #[test]
    fn a_temperature_member_converts_absolutely() {
        let mut d = def("m1", MathFunction::Average, pattern("Cell"));
        d.unit = Some("degC".into());
        let model = resolve(&[d], &[entry("CellA", "K"), entry("CellB", "degF")]);
        let r = model.get("m1").expect("m1");
        assert!((r.operand_affines[0].apply(273.15) - 0.0).abs() < 1e-9);
        assert!((r.operand_affines[1].apply(212.0) - 100.0).abs() < 1e-9);
    }

    /// A math operand takes its source unit from the definition it
    /// names, so a chain converts as readily as a DBC-backed member.
    #[test]
    fn a_math_operand_converts_from_the_unit_its_definition_carries() {
        let mut over = def(
            "m2",
            MathFunction::Rms,
            picks(&[MathOperandRef::math("m1")]),
        );
        over.unit = Some("A".into());
        let mut under = def("m1", MathFunction::Sum, picks(&[sig("Cell")]));
        under.unit = Some("mA".into());
        let model = resolve(&[over, under], &[entry("Cell", "mA")]);
        assert_eq!(
            model.get("m2").expect("m2").operand_affines,
            [Affine::new(0.001, 0.0)]
        );
    }

    /// The schema is additive: a project file written before any of
    /// this existed still loads, and a definition that scales nothing
    /// still writes exactly what it always did.
    #[test]
    fn a_definition_written_before_scaling_existed_still_loads() {
        let json = r#"{
            "id": "m1",
            "name": "Old",
            "unit": null,
            "function": {"kind": "sum"},
            "operands": {
                "picks": [{
                    "busId": "b",
                    "messageId": 256,
                    "extended": false,
                    "signalName": "A"
                }],
                "patterns": []
            }
        }"#;
        let d: MathDefinition = serde_json::from_str(json).expect("old schema");
        assert_eq!(d.operands.picks[0].reference.signal_name, "A");
        assert_eq!(d.operands.picks[0].reference.bus_id.as_deref(), Some("b"));
        assert_eq!(d.operands.picks[0].gain, None);
        assert_eq!(d.output_gain, None);
        // And re-serialising it adds none of the new keys back.
        let back = serde_json::to_value(&d).expect("serialize");
        assert!(back.get("outputGain").is_none(), "{back}");
        assert!(back["operands"]["picks"][0].get("gain").is_none(), "{back}");
    }

    #[test]
    fn a_scaled_definition_round_trips_through_json() {
        let mut d = def("m1", MathFunction::Sum, picks(&[sig("A")]));
        d.unit = Some("A".into());
        d.output_gain = Some(2.0);
        d.output_offset = Some(0.5);
        d.operands.picks[0].gain = Some(0.25);
        d.operands.picks[0].source_unit = Some("milliampere".to_string());
        let json = serde_json::to_value(&d).expect("serialize");
        assert_eq!(json["outputGain"], 2.0);
        assert_eq!(json["operands"]["picks"][0]["gain"], 0.25);
        assert_eq!(json["operands"]["picks"][0]["sourceUnit"], "milliampere");
        // The flattened reference still writes its own fields flat.
        assert_eq!(json["operands"]["picks"][0]["signalName"], "A");
        let back: MathDefinition = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, d);
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
