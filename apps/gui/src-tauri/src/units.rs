//! The unit facade: **the only place `runtime_units` is named**.
//!
//! Everything the host knows about units passes through here — the
//! selectable list, what dimension each belongs to, the affine that
//! carries a value from one to another, and what a DBC's free-text unit
//! string means.
//!
//! ## Why a facade
//!
//! A DBC's unit is an arbitrary string, so the host has to interpret it,
//! and interpreting units means owning a table of multipliers nobody
//! wants to hand-curate (5/9 for °F, 0.44704 for mph, 6894.757 for psi,
//! 2π/60 for rpm). The library supplies those numbers. What it does not
//! supply is a *policy*, and the two policies below are ours:
//!
//! - **Dimensions are our grouping, not the library's base units.** The
//!   library compares SI base dimensions, under which `rpm` converts to
//!   `Hz` (both s⁻¹, differing by 2π) and `N·m` converts to `J` (both
//!   kg·m²·s⁻²). Neither is a conversion a user asking for revolutions
//!   in hertz would recognise, so a conversion here is offered only
//!   **within one [`Dimension`]**, and every unit in a dimension is one
//!   library quantity's (`every_dimension_is_one_convertible_family`).
//! - **Offsets are ours.** The library's `UnitDefinition` carries a
//!   multiplier and nothing else, and its absolute-temperature quantity
//!   is not built in this release — so the constants that make °C and °F
//!   absolute readings rather than intervals live in this module's unit
//!   table, over the library's temperature-interval multipliers.
//!
//! ## Identity: base unit × SI prefix
//!
//! A unit is a [`UnitId`] — a **base unit and a [`Prefix`]**, never an
//! enumerated volts/millivolts/kilovolts list. The full SI range is in
//! the model whatever the crate happens to tabulate: where it enumerates
//! the pair (it has a `millivolt`) the facade takes its constant, and
//! where it does not (it stops at the microampere-hour, so `nAh` has no
//! variant) the factor is **composed** — the base's multiplier times
//! 10ⁿ. `every_prefixed_variant_the_crate_enumerates_matches_the_composed_factor`
//! cross-checks the two answers against each other for every pair the
//! crate does carry.
//!
//! ## Composition
//!
//! [`Composed`] is the same arithmetic one step out: the library's
//! `UnitDefinition` multiplication adds base dimensions and multiplies
//! factors, which is all of dimensional analysis. It is what a
//! non-pointwise function's output unit is — an integration is
//! `operand · [t]`, a derivative `operand / [t]`, a product the operands
//! multiplied — and it answers three questions: what it is
//! [named](Composed::named) where the table names it (`A · s` is a
//! coulomb, `nA · h` an `nAh`), what [kind](Composed::dimension) it is
//! (so a picker can lock to it), and what it
//! [converts to](Composed::convert_to) (which is how a target reachable
//! only *through* the function — amp-hours from an integrated current —
//! is reached at all). Compositions are rendered one-way and never
//! parsed or persisted.
//!
//! ## Recognising a DBC unit string
//!
//! [`recognize`] answers a [`UnitId`] or **nothing**; it never guesses.
//! The order is: the user's customization dict (which is what makes an
//! arbitrary in-house spelling work at all), then the built-in
//! recognitions exactly, then a unit's own id exactly, then
//! `[prefix][base]` exact-case (`nAh`), then the built-in recognitions
//! case-insensitively — that last only where exactly one recognition
//! matches, so `mV` and `MV` cannot silently collapse into each other.
//!
//! ## Listing the units for a picker
//!
//! [`list_units`] is the command a picker reads. A [`UnitListing`] is a
//! [`UnitInfo`] plus the two things a picker needs and must not derive
//! for itself: the heading its dimension groups under, and the
//! **spelling** to commit for it. That spelling is the unit's display
//! form where that recognises back to the unit (so a definition's target
//! unit reads `°C`, not `degree-celsius`) and the id otherwise — which
//! is why the id is a spelling at all: `coulomb` displays as `C`, and
//! `C` is a guess between coulomb and Celsius that this module refuses
//! to make.

use std::collections::BTreeMap;

use runtime_units::units::{
    AngularVelocityUnit, DimensionlessUnit, ElectricChargeUnit, ElectricCurrentUnit,
    ElectricPotentialUnit, EnergyUnit, FrequencyUnit, LengthUnit, PowerUnit, PressureUnit,
    RatioUnit, TemperatureIntervalUnit, TimeUnit, TorqueUnit, VelocityUnit,
};
use runtime_units::units_base::UnitDefinition;
use runtime_units::Units;
use serde::{Deserialize, Serialize};

/// `gain·x + offset` — the whole conversion model (owner ruling: affine,
/// so °C↔K↔°F is expressible).
///
/// Composition is `then`: `a.then(b)` is `b` applied to `a`'s output.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Affine {
    pub gain: f64,
    pub offset: f64,
}

impl Default for Affine {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Affine {
    /// The conversion that changes nothing. Kernels check for it and
    /// skip the pass entirely, so an unscaled operand costs nothing.
    pub const IDENTITY: Self = Self {
        gain: 1.0,
        offset: 0.0,
    };

    #[must_use]
    pub fn new(gain: f64, offset: f64) -> Self {
        Self { gain, offset }
    }

    /// Whether this is exactly the identity — a bit-equality test, not a
    /// tolerance: the identity is what a definition carrying no scaling
    /// at all produces, and a value that merely rounds to it earns its
    /// multiply.
    // Exact comparison is the point, not an oversight: this asks
    // "is there a conversion at all", and the only values that answer
    // no are the two literals a definition with no scaling produces.
    // A tolerance would silently drop a real 1.000_000_1 conversion.
    #[allow(clippy::float_cmp)]
    #[must_use]
    pub fn is_identity(&self) -> bool {
        self.gain == 1.0 && self.offset == 0.0
    }

    #[must_use]
    pub fn apply(&self, value: f64) -> f64 {
        self.gain.mul_add(value, self.offset)
    }

    /// This conversion followed by `next`.
    #[must_use]
    pub fn then(self, next: Self) -> Self {
        Self {
            gain: self.gain * next.gain,
            offset: next.gain.mul_add(self.offset, next.offset),
        }
    }
}

/// The physical quantity a unit measures — the facade's own grouping,
/// and the only thing that decides whether two units convert.
///
/// One dimension is one library quantity (`ratio` is the exception:
/// dimensionless scalars and percentages are one family to a user), so
/// the multipliers within a dimension share a base and composing them is
/// sound.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Dimension {
    Voltage,
    Current,
    Charge,
    Power,
    Energy,
    Torque,
    AngularVelocity,
    Pressure,
    Frequency,
    Ratio,
    Temperature,
    Speed,
    Time,
    Length,
    /// The no-unit placeholder — a bare count. Told apart from
    /// [`Self::Ratio`] by kind: a percentage is a *proportion* and
    /// converts to a bare 0–1 ratio, where a count of packets converts
    /// to nothing at all.
    Scalar,
}

impl Dimension {
    /// The label a picker groups by.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Voltage => "voltage",
            Self::Current => "current",
            Self::Charge => "charge",
            Self::Power => "power",
            Self::Energy => "energy",
            Self::Torque => "torque",
            Self::AngularVelocity => "angular velocity",
            Self::Pressure => "pressure",
            Self::Frequency => "frequency",
            Self::Ratio => "ratio",
            Self::Temperature => "temperature",
            Self::Speed => "speed",
            Self::Time => "time",
            Self::Length => "length",
            Self::Scalar => "scalar",
        }
    }
}

/// An SI decimal prefix — the second half of a unit's identity.
///
/// The **full** range is in the model, whatever the library happens to
/// enumerate: a picker offers a base unit and a prefix, so an exponent
/// the crate has no variant for is composed rather than missing (design
/// ruling — enumeration gaps do not dictate the model).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Prefix {
    Yocto,
    Zepto,
    Atto,
    Femto,
    Pico,
    Nano,
    Micro,
    Milli,
    Centi,
    Deci,
    /// No prefix — the base unit itself, and what every unit written
    /// before prefixes existed deserialises to.
    #[default]
    None,
    Deca,
    Hecto,
    Kilo,
    Mega,
    Giga,
    Tera,
    Peta,
    Exa,
    Zetta,
    Yotta,
}

/// Every prefix in **exponent order**, which is the order the picker
/// renders (design: one exponent-ordered list, opened centered on the
/// current selection).
static PREFIXES: &[Prefix] = &[
    Prefix::Yocto,
    Prefix::Zepto,
    Prefix::Atto,
    Prefix::Femto,
    Prefix::Pico,
    Prefix::Nano,
    Prefix::Micro,
    Prefix::Milli,
    Prefix::Centi,
    Prefix::Deci,
    Prefix::None,
    Prefix::Deca,
    Prefix::Hecto,
    Prefix::Kilo,
    Prefix::Mega,
    Prefix::Giga,
    Prefix::Tera,
    Prefix::Peta,
    Prefix::Exa,
    Prefix::Zetta,
    Prefix::Yotta,
];

impl Prefix {
    /// Every prefix, exponent-ordered.
    #[must_use]
    pub fn all() -> &'static [Self] {
        PREFIXES
    }

    /// The power of ten this prefix scales by.
    #[must_use]
    pub fn exponent(self) -> i32 {
        match self {
            Self::Yocto => -24,
            Self::Zepto => -21,
            Self::Atto => -18,
            Self::Femto => -15,
            Self::Pico => -12,
            Self::Nano => -9,
            Self::Micro => -6,
            Self::Milli => -3,
            Self::Centi => -2,
            Self::Deci => -1,
            Self::None => 0,
            Self::Deca => 1,
            Self::Hecto => 2,
            Self::Kilo => 3,
            Self::Mega => 6,
            Self::Giga => 9,
            Self::Tera => 12,
            Self::Peta => 15,
            Self::Exa => 18,
            Self::Zetta => 21,
            Self::Yotta => 24,
        }
    }

    /// The symbol a display and a DBC spelling carry — `m`, `k`, `µ` —
    /// and the empty string for [`Self::None`].
    #[must_use]
    pub fn symbol(self) -> &'static str {
        match self {
            Self::Yocto => "y",
            Self::Zepto => "z",
            Self::Atto => "a",
            Self::Femto => "f",
            Self::Pico => "p",
            Self::Nano => "n",
            Self::Micro => "µ",
            Self::Milli => "m",
            Self::Centi => "c",
            Self::Deci => "d",
            Self::None => "",
            Self::Deca => "da",
            Self::Hecto => "h",
            Self::Kilo => "k",
            Self::Mega => "M",
            Self::Giga => "G",
            Self::Tera => "T",
            Self::Peta => "P",
            Self::Exa => "E",
            Self::Zetta => "Z",
            Self::Yotta => "Y",
        }
    }

    /// The picker's spelled-out name, empty for [`Self::None`].
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Yocto => "yocto",
            Self::Zepto => "zepto",
            Self::Atto => "atto",
            Self::Femto => "femto",
            Self::Pico => "pico",
            Self::Nano => "nano",
            Self::Micro => "micro",
            Self::Milli => "milli",
            Self::Centi => "centi",
            Self::Deci => "deci",
            Self::None => "",
            Self::Deca => "deca",
            Self::Hecto => "hecto",
            Self::Kilo => "kilo",
            Self::Mega => "mega",
            Self::Giga => "giga",
            Self::Tera => "tera",
            Self::Peta => "peta",
            Self::Exa => "exa",
            Self::Zetta => "zetta",
            Self::Yotta => "yotta",
        }
    }

    /// `10^exponent` — the multiplier composition folds into the base
    /// unit's own.
    #[must_use]
    pub fn factor(self) -> f64 {
        10f64.powi(self.exponent())
    }

    /// Whether this is the bare base unit. Takes `&self` so it can also
    /// be a serde `skip_serializing_if`: an unprefixed unit writes the
    /// same JSON a unit id always did.
    #[must_use]
    #[allow(clippy::trivially_copy_pass_by_ref)]
    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }
}

/// **A unit's identity: a base unit and an SI prefix.**
///
/// This is what the model carries and what a project file persists. A
/// unit *string* exists only at the DBC-ingest boundary, where
/// [`recognize`] reads one; from there nothing is spelled until it is
/// displayed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitId {
    /// The base unit's stable id — an entry of this module's unit table
    /// that is not itself a prefixed form.
    pub base: String,
    #[serde(default, skip_serializing_if = "Prefix::is_none")]
    pub prefix: Prefix,
}

impl UnitId {
    #[must_use]
    pub fn new(base: impl Into<String>, prefix: Prefix) -> Self {
        Self {
            base: base.into(),
            prefix,
        }
    }

    /// The unprefixed unit with this base id.
    #[must_use]
    pub fn base(base: impl Into<String>) -> Self {
        Self::new(base, Prefix::None)
    }
}

/// **How one surface hands a unit to the next: the unit itself, and
/// how it reads.**
///
/// Identity and spelling are different things, and the second does not
/// recover the first — `coulomb` reads `C`, which [`recognize`] refuses
/// on purpose because a DBC that writes `C` means Celsius about as
/// often. So a unit the model already knows travels as a
/// [`UnitId`] with its rendering beside it, and is never recovered from
/// the rendering (owner ruling: units are consumed from a lossless and
/// unambiguous representation, never re-parsed).
///
/// A string becomes one of these exactly twice, at the two ingest
/// surfaces [`Self::declared`] serves: a database's own unit field, and
/// the user's customization dict. Everywhere else it is
/// [`Self::typed`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UnitReading {
    /// The unit, where anything places one. `None` is a blank field or
    /// a spelling nothing recognises — silence, never a guess.
    pub unit: Option<UnitId>,
    /// What a label shows: the unit's own spelling where there is one,
    /// and the database's string verbatim where there is not.
    pub display: String,
}

impl UnitReading {
    /// A unit the model already holds — a reinterpretation, a picked
    /// target, a derivation. Rendered here and parsed nowhere.
    #[must_use]
    pub fn typed(unit: UnitId) -> Self {
        Self {
            display: display_of(&unit),
            unit: Some(unit),
        }
    }

    /// **The ingest boundary**: a free-text unit string, read once
    /// through [`recognize`]. The string is kept as the display, so a
    /// spelling nothing places still reads as what its database wrote.
    #[must_use]
    pub fn declared(raw: &str, customizations: &Customizations) -> Self {
        Self {
            unit: recognize(raw, customizations),
            display: raw.to_string(),
        }
    }

    /// A unit already placed, reading as something other than its own
    /// spelling — a target the user typed that recognition placed, and
    /// which still reads as they wrote it.
    #[must_use]
    pub fn placed(unit: Option<UnitId>, display: String) -> Self {
        Self { unit, display }
    }

    /// Whether this names nothing at all: no unit, and nothing to show.
    #[must_use]
    pub fn is_blank(&self) -> bool {
        self.unit.is_none() && self.display.trim().is_empty()
    }

    /// Whether this reads as something the project **cannot place** —
    /// the state a mapping in Settings → Units repairs. Blank is not
    /// one: a signal that declares no unit has nothing to map.
    #[must_use]
    pub fn is_unplaceable(&self) -> bool {
        self.unit.is_none() && !self.display.trim().is_empty()
    }
}

/// One selectable unit.
///
/// `id` is the stable name everything else keys on — a project file's
/// source-unit override, the customization dict's value, a definition's
/// target unit. It is kebab-case ASCII so it is a safe JSON key and
/// survives a library swap; `display` is what a label shows.
struct Entry {
    id: &'static str,
    display: &'static str,
    dimension: Dimension,
    unit: Units,
    /// The constant added **before** the library's multiplier when
    /// converting to the dimension's base — zero for every unit but the
    /// absolute temperatures, where it is what makes °C a reading rather
    /// than an interval.
    constant: f64,
    /// The **base unit** this entry is a prefixed form of, or its own id
    /// where it is one. A `millivolt` row is the crate's enumerated
    /// variant of `{base: "volt", prefix: Milli}`, which is the identity
    /// the model actually carries.
    base: &'static str,
    prefix: Prefix,
    /// Whether the SI ladder applies to this base unit. False for the
    /// absolute temperatures (a milli-°C has no offset that means
    /// anything), the ratio family (which takes a scale choice instead)
    /// and the composite spellings — `km/h` is not prefixable, `km` is.
    /// Read only on a base entry.
    prefixable: bool,
}

impl Entry {
    /// Whether this row *is* a base unit rather than a prefixed form of
    /// one. Only base units are named by a [`UnitId`].
    fn is_base(&self) -> bool {
        self.prefix.is_none()
    }
}

/// One selectable unit, as a caller outside this module sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitInfo {
    pub id: &'static str,
    pub display: &'static str,
    pub dimension: Dimension,
}

/// One selectable unit as a **picker** lists it: the unit, the heading
/// it groups under, and the string to commit when it is chosen.
///
/// A view renders this and derives nothing: which units exist, how they
/// group and how they are spelled are all the facade's answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitListing {
    #[serde(flatten)]
    pub info: UnitInfo,
    /// [`Dimension::label`] — the group heading.
    pub dimension_label: &'static str,
    /// What a picker writes where a unit *string* is stored (a math
    /// definition's target unit): the display form where [`recognize`]
    /// carries it back to this unit, the id otherwise. Never used where
    /// a unit **id** is stored (a customization's value, an operand's
    /// source-unit override) — that is [`UnitInfo::id`].
    pub spelling: &'static str,
}

/// Every unit the app offers, in picker order.
///
/// Deliberately a **curated subset** of what the library carries: the
/// library has the whole SI prefix ladder for each quantity, and a
/// picker listing yoctovolts is worse than one listing the four voltages
/// anyone puts on a bus. Adding one is a line here.
static UNITS: &[Entry] = &[
    // Voltage
    entry(
        "volt",
        "V",
        Dimension::Voltage,
        Units::ElectricPotential(ElectricPotentialUnit::volt),
    ),
    prefixed(
        "millivolt",
        "mV",
        Dimension::Voltage,
        Units::ElectricPotential(ElectricPotentialUnit::millivolt),
        "volt",
        Prefix::Milli,
    ),
    prefixed(
        "kilovolt",
        "kV",
        Dimension::Voltage,
        Units::ElectricPotential(ElectricPotentialUnit::kilovolt),
        "volt",
        Prefix::Kilo,
    ),
    prefixed(
        "megavolt",
        "MV",
        Dimension::Voltage,
        Units::ElectricPotential(ElectricPotentialUnit::megavolt),
        "volt",
        Prefix::Mega,
    ),
    // Current
    entry(
        "ampere",
        "A",
        Dimension::Current,
        Units::ElectricCurrent(ElectricCurrentUnit::ampere),
    ),
    prefixed(
        "milliampere",
        "mA",
        Dimension::Current,
        Units::ElectricCurrent(ElectricCurrentUnit::milliampere),
        "ampere",
        Prefix::Milli,
    ),
    prefixed(
        "kiloampere",
        "kA",
        Dimension::Current,
        Units::ElectricCurrent(ElectricCurrentUnit::kiloampere),
        "ampere",
        Prefix::Kilo,
    ),
    // Charge
    entry(
        "coulomb",
        "C",
        Dimension::Charge,
        Units::ElectricCharge(ElectricChargeUnit::coulomb),
    ),
    entry(
        "ampere-hour",
        "Ah",
        Dimension::Charge,
        Units::ElectricCharge(ElectricChargeUnit::ampere_hour),
    ),
    prefixed(
        "milliampere-hour",
        "mAh",
        Dimension::Charge,
        Units::ElectricCharge(ElectricChargeUnit::milliampere_hour),
        "ampere-hour",
        Prefix::Milli,
    ),
    // Power
    entry("watt", "W", Dimension::Power, Units::Power(PowerUnit::watt)),
    prefixed(
        "milliwatt",
        "mW",
        Dimension::Power,
        Units::Power(PowerUnit::milliwatt),
        "watt",
        Prefix::Milli,
    ),
    prefixed(
        "kilowatt",
        "kW",
        Dimension::Power,
        Units::Power(PowerUnit::kilowatt),
        "watt",
        Prefix::Kilo,
    ),
    prefixed(
        "megawatt",
        "MW",
        Dimension::Power,
        Units::Power(PowerUnit::megawatt),
        "watt",
        Prefix::Mega,
    ),
    // Energy
    entry(
        "joule",
        "J",
        Dimension::Energy,
        Units::Energy(EnergyUnit::joule),
    ),
    prefixed(
        "kilojoule",
        "kJ",
        Dimension::Energy,
        Units::Energy(EnergyUnit::kilojoule),
        "joule",
        Prefix::Kilo,
    ),
    entry(
        "watt-hour",
        "Wh",
        Dimension::Energy,
        Units::Energy(EnergyUnit::watt_hour),
    ),
    prefixed(
        "kilowatt-hour",
        "kWh",
        Dimension::Energy,
        Units::Energy(EnergyUnit::kilowatt_hour),
        "watt-hour",
        Prefix::Kilo,
    ),
    // Torque
    entry(
        "newton-meter",
        "Nm",
        Dimension::Torque,
        Units::Torque(TorqueUnit::newton_meter),
    ),
    prefixed(
        "newton-millimeter",
        "Nmm",
        Dimension::Torque,
        Units::Torque(TorqueUnit::newton_millimeter),
        "newton-meter",
        Prefix::Milli,
    ),
    // Angular velocity
    fixed(
        "revolution-per-minute",
        "rpm",
        Dimension::AngularVelocity,
        Units::AngularVelocity(AngularVelocityUnit::revolution_per_minute),
    ),
    fixed(
        "radian-per-second",
        "rad/s",
        Dimension::AngularVelocity,
        Units::AngularVelocity(AngularVelocityUnit::radian_per_second),
    ),
    fixed(
        "degree-per-second",
        "°/s",
        Dimension::AngularVelocity,
        Units::AngularVelocity(AngularVelocityUnit::degree_per_second),
    ),
    // Pressure
    entry(
        "pascal",
        "Pa",
        Dimension::Pressure,
        Units::Pressure(PressureUnit::pascal),
    ),
    prefixed(
        "kilopascal",
        "kPa",
        Dimension::Pressure,
        Units::Pressure(PressureUnit::kilopascal),
        "pascal",
        Prefix::Kilo,
    ),
    prefixed(
        "megapascal",
        "MPa",
        Dimension::Pressure,
        Units::Pressure(PressureUnit::megapascal),
        "pascal",
        Prefix::Mega,
    ),
    // `bar` is prefixable even though the crate enumerates only the
    // millibar: the identity is base x prefix, and an enumeration gap
    // is a composition rather than a missing unit.
    entry(
        "bar",
        "bar",
        Dimension::Pressure,
        Units::Pressure(PressureUnit::bar),
    ),
    prefixed(
        "millibar",
        "mbar",
        Dimension::Pressure,
        Units::Pressure(PressureUnit::millibar),
        "bar",
        Prefix::Milli,
    ),
    fixed(
        "psi",
        "psi",
        Dimension::Pressure,
        Units::Pressure(PressureUnit::pound_force_per_square_inch),
    ),
    // Frequency
    entry(
        "hertz",
        "Hz",
        Dimension::Frequency,
        Units::Frequency(FrequencyUnit::hertz),
    ),
    prefixed(
        "kilohertz",
        "kHz",
        Dimension::Frequency,
        Units::Frequency(FrequencyUnit::kilohertz),
        "hertz",
        Prefix::Kilo,
    ),
    prefixed(
        "megahertz",
        "MHz",
        Dimension::Frequency,
        Units::Frequency(FrequencyUnit::megahertz),
        "hertz",
        Prefix::Mega,
    ),
    // Ratio: a scale choice, not an SI ladder, so none of the three
    // takes a prefix.
    fixed(
        "percent",
        "%",
        Dimension::Ratio,
        Units::Ratio(RatioUnit::percent),
    ),
    fixed(
        "part-per-million",
        "ppm",
        Dimension::Ratio,
        Units::Ratio(RatioUnit::part_per_million),
    ),
    // The bare 0–1 scale reads as `ratio`, which is also how a DBC
    // spells it — so the string this unit renders is one [`recognize`]
    // carries straight back to it. Every surface that reports a
    // signal's unit hands on a *string*, and a string nothing places
    // converts nothing, so a scale whose display did not round-trip
    // would silently defeat its own conversions.
    fixed(
        "ratio",
        "ratio",
        Dimension::Ratio,
        Units::Dimensionless(DimensionlessUnit::scalar),
    ),
    // The no-unit placeholder: the library's lone Dimensionless unit
    // under its own name, in a kind of its own so a count never
    // converts into a proportion.
    fixed(
        "scalar",
        "scalar",
        Dimension::Scalar,
        Units::Dimensionless(DimensionlessUnit::scalar),
    ),
    // Temperature: the three that carry a constant. The library's
    // absolute-temperature quantity is not built in this release, so
    // these ride its temperature-*interval* multipliers (K: 1, C: 1,
    // F: 5/9) with the offset supplied here. None takes a prefix.
    Entry {
        id: "kelvin",
        display: "K",
        dimension: Dimension::Temperature,
        unit: Units::TemperatureInterval(TemperatureIntervalUnit::kelvin),
        constant: 0.0,
        base: "kelvin",
        prefix: Prefix::None,
        prefixable: false,
    },
    Entry {
        id: "degree-celsius",
        display: "°C",
        dimension: Dimension::Temperature,
        unit: Units::TemperatureInterval(TemperatureIntervalUnit::degree_celsius),
        constant: 273.15,
        base: "degree-celsius",
        prefix: Prefix::None,
        prefixable: false,
    },
    Entry {
        id: "degree-fahrenheit",
        display: "°F",
        dimension: Dimension::Temperature,
        unit: Units::TemperatureInterval(TemperatureIntervalUnit::degree_fahrenheit),
        constant: 459.67,
        base: "degree-fahrenheit",
        prefix: Prefix::None,
        prefixable: false,
    },
    // Speed
    fixed(
        "meter-per-second",
        "m/s",
        Dimension::Speed,
        Units::Velocity(VelocityUnit::meter_per_second),
    ),
    fixed(
        "kilometer-per-hour",
        "km/h",
        Dimension::Speed,
        Units::Velocity(VelocityUnit::kilometer_per_hour),
    ),
    fixed(
        "mile-per-hour",
        "mph",
        Dimension::Speed,
        Units::Velocity(VelocityUnit::mile_per_hour),
    ),
    // Time
    entry(
        "second",
        "s",
        Dimension::Time,
        Units::Time(TimeUnit::second),
    ),
    prefixed(
        "millisecond",
        "ms",
        Dimension::Time,
        Units::Time(TimeUnit::millisecond),
        "second",
        Prefix::Milli,
    ),
    prefixed(
        "microsecond",
        "µs",
        Dimension::Time,
        Units::Time(TimeUnit::microsecond),
        "second",
        Prefix::Micro,
    ),
    fixed(
        "minute",
        "min",
        Dimension::Time,
        Units::Time(TimeUnit::minute),
    ),
    fixed("hour", "h", Dimension::Time, Units::Time(TimeUnit::hour)),
    fixed("day", "d", Dimension::Time, Units::Time(TimeUnit::day)),
    // Length
    entry(
        "meter",
        "m",
        Dimension::Length,
        Units::Length(LengthUnit::meter),
    ),
    prefixed(
        "millimeter",
        "mm",
        Dimension::Length,
        Units::Length(LengthUnit::millimeter),
        "meter",
        Prefix::Milli,
    ),
    prefixed(
        "centimeter",
        "cm",
        Dimension::Length,
        Units::Length(LengthUnit::centimeter),
        "meter",
        Prefix::Centi,
    ),
    prefixed(
        "kilometer",
        "km",
        Dimension::Length,
        Units::Length(LengthUnit::kilometer),
        "meter",
        Prefix::Kilo,
    ),
];

/// A **base unit** the SI prefix ladder applies to.
const fn entry(
    id: &'static str,
    display: &'static str,
    dimension: Dimension,
    unit: Units,
) -> Entry {
    Entry {
        id,
        display,
        dimension,
        unit,
        constant: 0.0,
        base: id,
        prefix: Prefix::None,
        prefixable: true,
    }
}

/// A base unit that takes **no** prefix: a composite spelling (`km/h`),
/// a non-decimal time (`min`), or a member of the ratio family.
const fn fixed(
    id: &'static str,
    display: &'static str,
    dimension: Dimension,
    unit: Units,
) -> Entry {
    Entry {
        id,
        display,
        dimension,
        unit,
        constant: 0.0,
        base: id,
        prefix: Prefix::None,
        prefixable: false,
    }
}

/// The crate's **enumerated** variant of `base` at `prefix`.
///
/// Listing these is not a second model — the identity is still
/// `(base, prefix)` — it is how the facade takes the library's own
/// tabulated constant where it has one, and composes only for the holes
/// (`every_prefixed_variant_the_crate_enumerates_matches_the_composed_factor`
/// is what keeps the two answers the same number).
const fn prefixed(
    id: &'static str,
    display: &'static str,
    dimension: Dimension,
    unit: Units,
    base: &'static str,
    prefix: Prefix,
) -> Entry {
    Entry {
        id,
        display,
        dimension,
        unit,
        constant: 0.0,
        base,
        prefix,
        prefixable: true,
    }
}

/// The DBC unit strings the host recognises without being told, paired
/// with the unit id each names.
///
/// Only spellings that are unambiguous *as written*: `C` is left out
/// because a DBC that says it means Celsius about as often as it means
/// coulomb, and a wrong conversion is worse than no conversion (owner
/// ruling: unknown means nothing, never a guess). The user's
/// customization dict is where an in-house spelling goes.
static RECOGNITIONS: &[(&str, &str)] = &[
    ("V", "volt"),
    ("volt", "volt"),
    ("volts", "volt"),
    ("mV", "millivolt"),
    ("kV", "kilovolt"),
    ("MV", "megavolt"),
    ("A", "ampere"),
    ("amp", "ampere"),
    ("amps", "ampere"),
    ("mA", "milliampere"),
    ("kA", "kiloampere"),
    ("Ah", "ampere-hour"),
    ("A·h", "ampere-hour"),
    ("mAh", "milliampere-hour"),
    ("W", "watt"),
    ("mW", "milliwatt"),
    ("kW", "kilowatt"),
    ("MW", "megawatt"),
    ("J", "joule"),
    ("kJ", "kilojoule"),
    ("Wh", "watt-hour"),
    ("kWh", "kilowatt-hour"),
    ("Nm", "newton-meter"),
    ("N·m", "newton-meter"),
    ("N m", "newton-meter"),
    ("rpm", "revolution-per-minute"),
    ("rad/s", "radian-per-second"),
    ("deg/s", "degree-per-second"),
    ("°/s", "degree-per-second"),
    ("Pa", "pascal"),
    ("kPa", "kilopascal"),
    ("MPa", "megapascal"),
    ("bar", "bar"),
    ("mbar", "millibar"),
    ("psi", "psi"),
    ("Hz", "hertz"),
    ("kHz", "kilohertz"),
    ("MHz", "megahertz"),
    // Which scale a proportion is on is carried by the spelling and
    // nothing else — the number's observed range is data, not a
    // declaration. `%` is the 0–100 reading; `%1.0` writes the range
    // into the string and means the bare 0–1 scale. Both are defaults
    // a project's own customizations may remap.
    ("%", "percent"),
    ("%1.0", "ratio"),
    ("ratio", "ratio"),
    ("percent", "percent"),
    // The no-unit placeholder: what a DBC writes when the number is a
    // count rather than a measurement.
    ("scalar", "scalar"),
    ("count", "scalar"),
    ("counts", "scalar"),
    ("cnt", "scalar"),
    ("ppm", "part-per-million"),
    ("K", "kelvin"),
    ("degC", "degree-celsius"),
    ("deg C", "degree-celsius"),
    ("°C", "degree-celsius"),
    ("degF", "degree-fahrenheit"),
    ("deg F", "degree-fahrenheit"),
    ("°F", "degree-fahrenheit"),
    ("m/s", "meter-per-second"),
    ("km/h", "kilometer-per-hour"),
    ("kph", "kilometer-per-hour"),
    ("mph", "mile-per-hour"),
    ("s", "second"),
    ("sec", "second"),
    ("ms", "millisecond"),
    ("us", "microsecond"),
    ("µs", "microsecond"),
    ("min", "minute"),
    ("h", "hour"),
    ("hr", "hour"),
    ("d", "day"),
    ("day", "day"),
    ("m", "meter"),
    ("mm", "millimeter"),
    ("cm", "centimeter"),
    ("km", "kilometer"),
];

/// The order composition resolves a set of SI base dimensions to a
/// **named** family.
///
/// Two of this table's families can share base dimensions — torque and
/// energy are both kg·m²·s⁻², revolutions-per-minute and hertz both s⁻¹
/// — so a composition landing on one of those has to be told which is
/// meant. An engineer who multiplies a current by an hour means a
/// charge; one who divides an amp-hour by a second means a current; and
/// nobody composing anything means revolutions. The scalar families sit
/// last for the same reason: a dimensionless composition is a number,
/// not a proportion.
static COMPOSITION_ORDER: &[Dimension] = &[
    Dimension::Charge,
    Dimension::Energy,
    Dimension::Power,
    Dimension::Voltage,
    Dimension::Current,
    Dimension::Frequency,
    Dimension::Pressure,
    Dimension::Speed,
    Dimension::Length,
    Dimension::Time,
    Dimension::Temperature,
    Dimension::Torque,
    Dimension::AngularVelocity,
    Dimension::Ratio,
    Dimension::Scalar,
];

/// **A unit built by dimensional analysis**: a product of units over a
/// product of units.
///
/// This is what a function's output unit is when the function is not
/// pointwise — an integration is `operand · [t]`, a derivative
/// `operand / [t]`, a product the operands multiplied together. The
/// arithmetic is the library's: [`UnitDefinition`] multiplication adds
/// the base dimensions and multiplies the factors, which is the whole of
/// dimensional analysis and the reason nanoamps times hours reaches an
/// `nAh` the crate never enumerates.
///
/// A composition is **structural and one-way**. It is rendered
/// ([`Self::display`]) and it is asked what it converts to
/// ([`Self::convert_to`]); it is never parsed back from a string and
/// never persisted — the function and its time parameter are what a
/// project file stores.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Composed {
    numerator: Vec<UnitId>,
    denominator: Vec<UnitId>,
}

impl Composed {
    /// The composition that is just this unit.
    #[must_use]
    pub fn of(unit: UnitId) -> Self {
        Self {
            numerator: vec![unit],
            denominator: Vec::new(),
        }
    }

    /// Multiply by `unit` — `A` times `h`.
    #[must_use]
    pub fn times(mut self, unit: UnitId) -> Self {
        self.numerator.push(unit);
        self
    }

    /// Divide by `unit` — `Ah` over `s`.
    #[must_use]
    pub fn over(mut self, unit: UnitId) -> Self {
        self.denominator.push(unit);
        self
    }

    /// The one unit this is, where nothing has been composed onto it.
    /// A pointwise function's output unit is one of these, and resolve
    /// converts its operands *to* it.
    #[must_use]
    pub fn single(&self) -> Option<&UnitId> {
        (self.denominator.is_empty() && self.numerator.len() == 1).then(|| &self.numerator[0])
    }

    /// The library definition of the whole composition.
    fn definition(&self) -> Option<UnitDefinition> {
        let mut composed = UnitDefinition::dimensionless();
        for unit in &self.numerator {
            composed *= definition_of(unit)?;
        }
        for unit in &self.denominator {
            composed /= definition_of(unit)?;
        }
        Some(composed)
    }

    /// The unit this composition **is**, where the table names one:
    /// `A · h` is the ampere-hour, `nA · h` the nanoampere-hour, `A · s`
    /// the coulomb.
    ///
    /// Searched base-first so a composition prefers the unprefixed name,
    /// and family by family in this module's composition order so a base
    /// dimension two families share resolves to the one an engineer
    /// means.
    #[must_use]
    pub fn named(&self) -> Option<UnitId> {
        let ours = self.definition()?;
        let matches = |candidate: &UnitId| {
            definition_of(candidate).is_some_and(|d| {
                d.is_convertible(ours) && (1.0 - ours.multiplier() / d.multiplier()).abs() < 1e-12
            })
        };
        for prefixes in [&[Prefix::None][..], PREFIXES] {
            for dimension in COMPOSITION_ORDER {
                for entry in UNITS
                    .iter()
                    .filter(|e| e.is_base() && e.dimension == *dimension && e.constant == 0.0)
                {
                    for prefix in prefixes {
                        let candidate = UnitId::new(entry.base, *prefix);
                        if matches(&candidate) {
                            return Some(candidate);
                        }
                    }
                }
            }
        }
        None
    }

    /// The family a kind-locked picker offers against — the composed
    /// base dimensions read back as one of this facade's own.
    #[must_use]
    pub fn dimension(&self) -> Option<Dimension> {
        let ours = self.definition()?;
        COMPOSITION_ORDER.iter().copied().find(|dimension| {
            UNITS
                .iter()
                .filter(|e| e.is_base() && e.dimension == *dimension)
                .any(|e| UnitDefinition::from(e.unit).is_convertible(ours))
        })
    }

    /// How this composition reads: the name where it has one, and the
    /// factors otherwise — `A·s` when nothing is named, `Ah/s` for a
    /// division. Rendered, never parsed.
    #[must_use]
    pub fn display(&self) -> String {
        // A name is used only where it spells the same thing the
        // factors do — `A · h` contracts to `Ah`, and `nA · h` to
        // `nAh`. A coulomb is what `A · s` *is*, but nobody reading a
        // product of amps and seconds expects to see `C` (which this
        // module will not even parse), and a volt-amp product is more
        // usefully `V·A` than `W`. The kind is served separately, so a
        // picker still offers the named units of the family.
        if let Some(named) = self.named() {
            let display = display_of(&named);
            if self.denominator.is_empty()
                && display == self.numerator.iter().map(display_of).collect::<String>()
            {
                return display;
            }
        }
        let join = |units: &[UnitId]| units.iter().map(display_of).collect::<Vec<_>>().join("·");
        let numerator = if self.numerator.is_empty() {
            "1".to_string()
        } else {
            join(&self.numerator)
        };
        if self.denominator.is_empty() {
            numerator
        } else {
            format!("{numerator}/{}", join(&self.denominator))
        }
    }

    /// The affine that carries a value in this composition to one in
    /// `target`, or `None` where the analysis does not place it there.
    ///
    /// This is what makes a target its operand only reaches *through the
    /// function* reachable: integrating amps over seconds is coulombs, so
    /// asking for amp-hours is ÷3600; differentiating amp-hours per
    /// second is amps, so asking for `A` is ×3600. An absolute
    /// temperature is refused — an offset has no meaning in a product.
    #[must_use]
    pub fn convert_to(&self, target: &UnitId) -> Option<Affine> {
        let entry = find(&target.base)?;
        if entry.constant != 0.0 {
            return None;
        }
        let (ours, theirs) = (self.definition()?, definition_of(target)?);
        if !ours.is_convertible(theirs) {
            return None;
        }
        Some(Affine::new(ours.multiplier() / theirs.multiplier(), 0.0))
    }
}

/// The user's DBC-unit-string → unit-id overrides. Sparse: it holds only
/// what the user changed, and an empty dict is the shipped behaviour.
///
/// Ordered so the workspace `settings.json` it persists in writes the
/// same bytes for the same content, which is what makes it reviewable
/// (ADR 0034 — the file is a hand-editable contract).
pub type Customizations = BTreeMap<String, String>;

/// Two scopes of mappings as one dict: `user` overlaid by `project`.
///
/// **Project wins** where both map the same string (design ruling): a
/// project's own reading of its databases is more specific than a habit
/// carried between projects.
#[must_use]
pub fn merge_customizations(user: &Customizations, project: &Customizations) -> Customizations {
    let mut merged = user.clone();
    merged.extend(project.iter().map(|(k, v)| (k.clone(), v.clone())));
    merged
}

/// Every selectable unit, in picker order.
#[must_use]
pub fn all() -> Vec<UnitInfo> {
    UNITS.iter().map(Entry::info).collect()
}

/// Every selectable unit as a picker offers it — the module's `Listing
/// the units for a picker` section is the contract.
#[tauri::command]
#[must_use]
pub fn list_units() -> Vec<UnitListing> {
    UNITS.iter().map(Entry::listing).collect()
}

/// The unit with this stable id.
#[must_use]
pub fn get(id: &str) -> Option<UnitInfo> {
    find(id).map(Entry::info)
}

fn find(id: &str) -> Option<&'static Entry> {
    UNITS.iter().find(|e| e.id == id)
}

/// The row the crate enumerates for this exact `(base, prefix)` pair,
/// where it has one.
fn find_typed(unit: &UnitId) -> Option<&'static Entry> {
    UNITS
        .iter()
        .find(|e| e.base == unit.base && e.prefix == unit.prefix)
}

/// An SI prefix as a dimensionless [`UnitDefinition`] — the right-hand
/// operand of the library's multiplication, and so the whole of how a
/// prefix composes onto a base unit.
fn prefix_definition(prefix: Prefix) -> UnitDefinition {
    UnitDefinition::new(prefix.factor(), 0, 0, 0, 0, 0, 0, 0)
}

/// The library definition of a typed unit: **the crate's enumerated
/// variant where it has one**, and the base composed with 10ⁿ where it
/// does not.
///
/// `None` for a base id nothing knows, and for a prefix on a base that
/// takes none.
fn definition_of(unit: &UnitId) -> Option<UnitDefinition> {
    let base = find(&unit.base).filter(|e| e.is_base())?;
    if !unit.prefix.is_none() && !base.prefixable {
        return None;
    }
    if let Some(enumerated) = find_typed(unit) {
        return Some(UnitDefinition::from(enumerated.unit));
    }
    Some(UnitDefinition::from(base.unit) * prefix_definition(unit.prefix))
}

/// The typed identity of a **stored** unit id — what every project file
/// written before prefixes existed carries. `millivolt` has always been
/// `{volt, milli}`; this is where it says so.
#[must_use]
pub fn typed(id: &str) -> Option<UnitId> {
    find(id).map(|e| UnitId::new(e.base, e.prefix))
}

/// The stored id for a typed unit, where the table enumerates the pair.
///
/// `None` for a composition the crate has no variant of (`nAh`), which
/// is exactly why the model carries the typed form and not this string.
#[must_use]
pub fn stored_id(unit: &UnitId) -> Option<&'static str> {
    find_typed(unit).map(|e| e.id)
}

/// How a typed unit reads: the enumerated variant's own spelling where
/// there is one, and the prefix symbol on the base unit's otherwise —
/// `mV`, and `nAh`.
#[must_use]
pub fn display_of(unit: &UnitId) -> String {
    if let Some(enumerated) = find_typed(unit) {
        return enumerated.display.to_string();
    }
    find(&unit.base).map_or_else(String::new, |base| {
        format!("{}{}", unit.prefix.symbol(), base.display)
    })
}

/// The family a typed unit belongs to — what a kind-locked picker
/// offers against.
#[must_use]
pub fn dimension_of(unit: &UnitId) -> Option<Dimension> {
    find(&unit.base).map(|e| e.dimension)
}

/// The affine carrying a value in `from` to one in `to`, or `None` when
/// either names nothing or the two measure different things.
#[must_use]
pub fn convert_units(from: &UnitId, to: &UnitId) -> Option<Affine> {
    let (from_base, to_base) = (find(&from.base)?, find(&to.base)?);
    if from_base.dimension != to_base.dimension {
        return None;
    }
    if from == to {
        return Some(Affine::IDENTITY);
    }
    let (a, b) = (definition_of(from)?, definition_of(to)?);
    let a = Affine::new(a.multiplier(), from_base.constant * a.multiplier());
    let b = Affine::new(b.multiplier(), to_base.constant * b.multiplier());
    Some(Affine::new(a.gain / b.gain, (a.offset - b.offset) / b.gain))
}

impl Entry {
    fn info(&self) -> UnitInfo {
        UnitInfo {
            id: self.id,
            display: self.display,
            dimension: self.dimension,
        }
    }

    fn listing(&self) -> UnitListing {
        UnitListing {
            info: self.info(),
            dimension_label: self.dimension.label(),
            spelling: if recognize(self.display, &Customizations::new()) == typed(self.id) {
                self.display
            } else {
                self.id
            },
        }
    }
}

/// The affine that carries a value in `from` to a value in `to`, or
/// `None` when either id is unknown or the two measure different things.
///
/// Same unit both sides is [`Affine::IDENTITY`] exactly, not a rounded
/// one — a conversion that changes nothing must cost nothing.
#[must_use]
pub fn convert(from: &str, to: &str) -> Option<Affine> {
    convert_units(&typed(from)?, &typed(to)?)
}

/// The unit a DBC's free-text unit string names, or `None`.
///
/// The user's `customizations` win — that is the point of them — and are
/// consulted on the raw string and on its trimmed form, since a DBC
/// commonly carries padding the user did not type. Then the built-in
/// recognitions exactly, then a unit's **own id** exactly, then the
/// built-in recognitions case-insensitively where exactly one of them
/// matches.
///
/// The id pass is what lets a picker offer a unit the recognition table
/// has no conventional spelling for (`coulomb`, whose display `C` would
/// be a guess between charge and Celsius) — see [`UnitListing::spelling`].
///
/// **Nothing is guessed.** An unrecognised string means the operand
/// carries no unit the host can reason about, which resolve reports
/// rather than papering over.
#[must_use]
pub fn recognize(raw: &str, customizations: &Customizations) -> Option<UnitId> {
    for key in [raw, raw.trim()] {
        if let Some(id) = customizations.get(key) {
            return typed(id);
        }
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some((_, id)) = RECOGNITIONS.iter().find(|(s, _)| *s == trimmed) {
        return typed(id);
    }
    if let Some(unit) = typed(trimmed) {
        return Some(unit);
    }
    if let Some(unit) = prefixed_spelling(trimmed) {
        return Some(unit);
    }
    let lowered = trimmed.to_lowercase();
    let mut hit = None;
    for (spelling, id) in RECOGNITIONS {
        if spelling.to_lowercase() != lowered {
            continue;
        }
        match hit {
            // Two recognitions differing only in case — `mV` beside
            // `MV`. Neither is the answer; the user says which.
            Some(other) if other != *id => return None,
            _ => hit = Some(*id),
        }
    }
    hit.and_then(typed)
}

/// The symbols a prefix may be spelled with. Only micro has two: `µ` is
/// the symbol, and `u` is what a keyboard produces — a substitution, not
/// a guess at case.
fn prefix_symbols(prefix: Prefix) -> &'static [&'static str] {
    match prefix {
        Prefix::Micro => &["µ", "u"],
        Prefix::Yocto => &["y"],
        Prefix::Zepto => &["z"],
        Prefix::Atto => &["a"],
        Prefix::Femto => &["f"],
        Prefix::Pico => &["p"],
        Prefix::Nano => &["n"],
        Prefix::Milli => &["m"],
        Prefix::Centi => &["c"],
        Prefix::Deci => &["d"],
        Prefix::None => &[""],
        Prefix::Deca => &["da"],
        Prefix::Hecto => &["h"],
        Prefix::Kilo => &["k"],
        Prefix::Mega => &["M"],
        Prefix::Giga => &["G"],
        Prefix::Tera => &["T"],
        Prefix::Peta => &["P"],
        Prefix::Exa => &["E"],
        Prefix::Zetta => &["Z"],
        Prefix::Yotta => &["Y"],
    }
}

/// `[prefix][base]`, **exact case** — how `nAh` is read without anyone
/// tabulating it.
///
/// Only a base unit's own display spelling takes a prefix: `nAh` is
/// nano on `Ah`, and `namps` is not a unit. Exact case throughout, so
/// `mV` and `MV` stay three orders of magnitude apart and `NAH` is
/// nothing. This pass runs **after** the exact recognitions and the unit
/// ids, so no spelling that already meant something changes meaning.
fn prefixed_spelling(spelling: &str) -> Option<UnitId> {
    for entry in UNITS.iter().filter(|e| e.is_base() && e.prefixable) {
        for prefix in PREFIXES.iter().filter(|p| !p.is_none()) {
            for symbol in prefix_symbols(*prefix) {
                if spelling.len() > entry.display.len()
                    && spelling.strip_prefix(symbol) == Some(entry.display)
                {
                    return Some(UnitId::new(entry.base, *prefix));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} vs {b}");
    }

    fn none() -> Customizations {
        Customizations::new()
    }

    #[test]
    fn every_unit_has_a_unique_id_and_is_findable_by_it() {
        let mut ids: Vec<&str> = UNITS.iter().map(|e| e.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate unit id");
        for entry in UNITS {
            let info = get(entry.id).expect(entry.id);
            assert_eq!(info.display, entry.display);
        }
        assert_eq!(all().len(), count);
        assert!(get("no-such-unit").is_none());
    }

    /// The facade's grouping has to be at least as strict as the
    /// library's: two units in one dimension must actually be one
    /// convertible family, or composing their multipliers would be
    /// nonsense. (The converse does not hold, and is the point of the
    /// grouping — the library calls `rpm` and `Hz` convertible.)
    #[test]
    fn every_dimension_is_one_convertible_family() {
        for a in UNITS {
            for b in UNITS.iter().filter(|b| b.dimension == a.dimension) {
                let (da, db) = (UnitDefinition::from(a.unit), UnitDefinition::from(b.unit));
                assert!(
                    da.is_convertible(db),
                    "{} and {} share a dimension but not a base",
                    a.id,
                    b.id
                );
            }
        }
    }

    #[test]
    fn a_conversion_within_a_dimension_is_the_ratio_of_the_multipliers() {
        let a = convert("milliampere", "ampere").expect("mA to A");
        close(a.gain, 0.001);
        close(a.offset, 0.0);
        close(a.apply(1500.0), 1.5);
        let back = convert("ampere", "milliampere").expect("A to mA");
        close(back.apply(1.5), 1500.0);
    }

    #[test]
    fn the_same_unit_both_sides_is_the_identity_exactly() {
        let a = convert("volt", "volt").expect("V to V");
        assert!(a.is_identity(), "{a:?}");
    }

    #[test]
    fn units_of_different_dimensions_do_not_convert() {
        assert!(convert("volt", "ampere").is_none());
        // The library would happily convert these two — both s⁻¹, and
        // both kg·m²·s⁻² — which is exactly what the facade's own
        // grouping exists to refuse.
        assert!(convert("revolution-per-minute", "hertz").is_none());
        assert!(convert("newton-meter", "joule").is_none());
    }

    #[test]
    fn an_unknown_unit_id_does_not_convert() {
        assert!(convert("volt", "furlong").is_none());
        assert!(convert("furlong", "volt").is_none());
    }

    #[test]
    fn temperature_converts_affinely_across_celsius_kelvin_and_fahrenheit() {
        let c_to_k = convert("degree-celsius", "kelvin").expect("°C to K");
        close(c_to_k.apply(0.0), 273.15);
        close(c_to_k.apply(25.0), 298.15);
        let k_to_c = convert("kelvin", "degree-celsius").expect("K to °C");
        close(k_to_c.apply(273.15), 0.0);
        let c_to_f = convert("degree-celsius", "degree-fahrenheit").expect("°C to °F");
        close(c_to_f.gain, 1.8);
        close(c_to_f.apply(0.0), 32.0);
        close(c_to_f.apply(100.0), 212.0);
        let f_to_c = convert("degree-fahrenheit", "degree-celsius").expect("°F to °C");
        close(f_to_c.apply(-40.0), -40.0);
        let f_to_k = convert("degree-fahrenheit", "kelvin").expect("°F to K");
        close(f_to_k.apply(32.0), 273.15);
    }

    #[test]
    fn a_percentage_converts_to_a_bare_ratio() {
        let a = convert("percent", "ratio").expect("% to ratio");
        close(a.apply(50.0), 0.5);
        let b = convert("ratio", "percent").expect("ratio to %");
        close(b.apply(0.31), 31.0);
        assert_eq!(
            recognize("ratio", &Customizations::new()),
            Some(UnitId::base("ratio"))
        );
    }

    /// **Which scale a `%` signal is on is settled by its spelling.**
    ///
    /// A DBC's unit field is free text, and the two conventions in the
    /// wild are `%` for the 0–100 reading and `%1.0` — the range
    /// written into the spelling — for the same quantity on the bare
    /// 0–1 scale. Nothing else distinguishes them: the number's range
    /// is data, not a declaration, so the string is the only thing that
    /// can say. Both ship as defaults here.
    #[test]
    fn the_two_percent_spellings_read_at_the_scales_they_name() {
        assert!(recognize("%1.0", &none()).is_some(), "%1.0 places nothing");
        assert_eq!(recognize("%", &none()), recognize("percent", &none()));
        assert_eq!(recognize("%1.0", &none()), recognize("ratio", &none()));
        // ×0.01 against ×1: the whole difference the spelling carries.
        close(convert("percent", "ratio").expect("% to ratio").gain, 0.01);
        close(convert("ratio", "ratio").expect("ratio to ratio").gain, 1.0);
    }

    /// The two percent spellings are **defaults, not rules**: a project
    /// whose databases mean the other thing by either says so in its
    /// own customizations, which win here as they do for every other
    /// built-in spelling.
    #[test]
    fn a_customization_remaps_either_percent_spelling() {
        let mut dict = Customizations::new();
        dict.insert("%".to_string(), "ratio".to_string());
        dict.insert("%1.0".to_string(), "percent".to_string());
        assert_eq!(recognize("%", &dict), recognize("ratio", &none()));
        assert_eq!(recognize("%1.0", &dict), recognize("percent", &none()));
    }

    /// One dimension read at three scales, and every pair of them is
    /// the plain power of ten between the two — nothing in the family
    /// shares a multiplier with another.
    #[test]
    fn the_ratio_family_converts_by_its_powers_of_ten() {
        let gain = |from: &str, to: &str| {
            convert(from, to)
                .unwrap_or_else(|| panic!("{from} to {to}"))
                .gain
        };
        close(gain("ratio", "percent"), 100.0);
        close(gain("ratio", "part-per-million"), 1e6);
        close(gain("percent", "part-per-million"), 1e4);
        close(gain("percent", "ratio"), 0.01);
        close(gain("part-per-million", "ratio"), 1e-6);
    }

    /// **A ratio scale's display string recognises back to it.**
    ///
    /// A signal's unit reaches a math definition as a *string*, so a
    /// scale rendered as something [`recognize`] cannot place converts
    /// nothing — and every target then serves the same number, which is
    /// the whole defect the bare scale's `ratio 0–1` display caused.
    #[test]
    fn every_ratio_scale_reads_as_a_string_that_recognises_back_to_it() {
        for id in ["ratio", "percent", "part-per-million"] {
            let display = get(id).unwrap_or_else(|| panic!("{id}")).display;
            assert_eq!(
                recognize(display, &none()),
                typed(id),
                "{id} reads {display}"
            );
        }
    }

    /// The pairings integration used to carry as a table — a current's
    /// integral is a charge, a power's an energy — now fall out of the
    /// composition, and reach further: nothing had to name the
    /// millicoulomb for a milliamp-second to be one.
    #[test]
    fn integrating_a_rate_composes_into_the_unit_its_integral_carries() {
        let seconds = UnitId::base("second");
        let charge = Composed::of(UnitId::base("ampere")).times(seconds.clone());
        assert_eq!(charge.named(), Some(UnitId::base("coulomb")));
        let energy = Composed::of(UnitId::base("watt")).times(seconds.clone());
        assert_eq!(energy.named(), Some(UnitId::base("joule")));
        assert_eq!(
            Composed::of(UnitId::new("ampere", Prefix::Milli))
                .times(seconds.clone())
                .named(),
            Some(UnitId::new("coulomb", Prefix::Milli))
        );
        // A quantity that is not a rate composes into something nothing
        // names, and says so rather than guessing.
        assert_eq!(
            Composed::of(UnitId::base("volt")).times(seconds).named(),
            None
        );
    }

    #[test]
    fn an_integrated_unit_converts_onward_to_what_a_user_asks_for() {
        // The output half of the integration path: amp-seconds to
        // amp-hours is ÷3600, watt-seconds to kilowatt-hours ÷3.6e6.
        let charge = Composed::of(UnitId::base("ampere")).times(UnitId::base("second"));
        close(
            charge
                .convert_to(&UnitId::base("ampere-hour"))
                .expect("A·s to Ah")
                .gain,
            1.0 / 3600.0,
        );
        let energy = Composed::of(UnitId::base("watt")).times(UnitId::base("second"));
        close(
            energy
                .convert_to(&UnitId::new("watt-hour", Prefix::Kilo))
                .expect("W·s to kWh")
                .gain,
            1.0 / 3_600_000.0,
        );
    }

    #[test]
    fn composing_two_affines_is_applying_them_in_order() {
        let a = Affine::new(2.0, 1.0);
        let b = Affine::new(10.0, -3.0);
        let composed = a.then(b);
        close(composed.apply(5.0), b.apply(a.apply(5.0)));
        assert_eq!(Affine::IDENTITY.then(a), a);
        assert_eq!(a.then(Affine::IDENTITY), a);
    }

    #[test]
    fn the_common_dbc_spellings_are_recognised() {
        let cases = [
            ("V", "volt"),
            ("mV", "millivolt"),
            ("A", "ampere"),
            ("mA", "milliampere"),
            ("degC", "degree-celsius"),
            ("°C", "degree-celsius"),
            ("K", "kelvin"),
            ("rpm", "revolution-per-minute"),
            ("km/h", "kilometer-per-hour"),
            ("%", "percent"),
            ("Nm", "newton-meter"),
            ("bar", "bar"),
            ("kPa", "kilopascal"),
            ("Hz", "hertz"),
            ("s", "second"),
            ("ms", "millisecond"),
        ];
        for (raw, id) in cases {
            assert_eq!(recognize(raw, &none()), typed(id), "{raw}");
        }
    }

    #[test]
    fn a_unit_string_is_recognised_around_its_padding() {
        assert_eq!(recognize("  rpm ", &none()), typed("revolution-per-minute"));
    }

    #[test]
    fn recognition_is_case_insensitive_only_where_one_spelling_matches() {
        assert_eq!(recognize("RPM", &none()), typed("revolution-per-minute"));
        assert_eq!(recognize("Bar", &none()), typed("bar"));
        assert_eq!(recognize("DEGC", &none()), typed("degree-celsius"));
        // `mV` and `MV` are both recognised exactly, so either spelling
        // typed exactly is honoured — and a third casing is refused
        // rather than picked between.
        assert_eq!(recognize("mV", &none()), typed("millivolt"));
        assert_eq!(recognize("MV", &none()), typed("megavolt"));
        assert_eq!(recognize("mv", &none()), None);
        assert_eq!(recognize("Mv", &none()), None);
    }

    #[test]
    fn an_unrecognised_string_is_nothing_rather_than_a_guess() {
        for raw in ["", "   ", "C", "Nm/rad", "widgets"] {
            assert_eq!(recognize(raw, &none()), None, "{raw:?}");
        }
    }

    #[test]
    fn a_customization_wins_over_the_built_in_recognitions() {
        let mut dict = Customizations::new();
        dict.insert("V".to_string(), "millivolt".to_string());
        dict.insert("widgets".to_string(), "percent".to_string());
        assert_eq!(recognize("V", &dict), typed("millivolt"));
        assert_eq!(recognize("widgets", &dict), typed("percent"));
        // Still exact: the dict is the user's spelling, not a pattern.
        assert_eq!(recognize("WIDGETS", &dict), None);
    }

    #[test]
    fn a_customization_naming_no_unit_recognises_nothing() {
        // A hand-edited settings file, or a unit id a later build
        // dropped. It is refused here rather than resolving to a
        // conversion nobody described.
        let mut dict = Customizations::new();
        dict.insert("widgets".to_string(), "furlong".to_string());
        assert_eq!(recognize("widgets", &dict), None);
    }

    /// Every built-in recognition names a unit that exists — the table
    /// and the unit list cannot drift apart.
    #[test]
    fn every_recognition_names_a_real_unit() {
        for (spelling, id) in RECOGNITIONS {
            assert!(get(id).is_some(), "{spelling} names unknown unit {id}");
        }
    }

    /// A unit's own id names it. The pickers need one string that is
    /// guaranteed to recognise back to the unit they offered, and the id
    /// is it — `coulomb` has no conventional spelling the table could
    /// carry without guessing at `C`.
    #[test]
    fn a_units_own_id_names_it() {
        for entry in UNITS {
            assert_eq!(
                recognize(entry.id, &none()),
                typed(entry.id),
                "{}",
                entry.id
            );
        }
    }

    /// What a target-unit picker commits round-trips. Without this the
    /// picker would offer units whose choice converts nothing.
    #[test]
    fn every_listed_spelling_recognises_back_to_its_unit() {
        let listed = list_units();
        assert_eq!(listed.len(), UNITS.len());
        for listing in listed {
            assert_eq!(
                recognize(listing.spelling, &none()),
                typed(listing.info.id),
                "{}",
                listing.info.id
            );
        }
    }

    /// A listing prefers the unit's own display spelling, so a plot's
    /// axis reads `°C` rather than `degree-celsius`, and falls back to
    /// the id only where the display is not a recognition of its own.
    #[test]
    fn a_listing_spells_a_unit_the_way_a_database_would() {
        let listed = list_units();
        let spelling = |id: &str| {
            listed
                .iter()
                .find(|l| l.info.id == id)
                .unwrap_or_else(|| panic!("{id}"))
                .spelling
        };
        assert_eq!(spelling("volt"), "V");
        assert_eq!(spelling("degree-celsius"), "°C");
        // `C` is deliberately unrecognised — it would be a guess between
        // coulomb and Celsius — so the picker commits the id.
        assert_eq!(spelling("coulomb"), "coulomb");
    }

    /// Every listing carries the heading a picker groups it under, so
    /// the grouping is the facade's and not re-derived by a view.
    #[test]
    fn every_listing_carries_its_dimensions_picker_label() {
        let listed = list_units();
        let rpm = listed
            .iter()
            .find(|l| l.info.id == "revolution-per-minute")
            .expect("rpm");
        assert_eq!(rpm.dimension_label, "angular velocity");
        assert_eq!(rpm.info.display, "rpm");
    }

    // ---- base × prefix identity, composition, prefixed recognition ----

    fn unit(base: &str, prefix: Prefix) -> UnitId {
        UnitId::new(base, prefix)
    }

    /// The crate's own enumerated variant for `abbreviation`, within the
    /// quantity `entry` belongs to — the comparand the composed factors
    /// are cross-checked against.
    fn enumerated(quantity: Units, abbreviation: &str) -> Option<UnitDefinition> {
        macro_rules! lookup {
            ($($variant:ident => $unit_enum:ident),+ $(,)?) => {
                match quantity {
                    $(Units::$variant(_) => $unit_enum::try_from(abbreviation)
                        .ok()
                        .map(|u| UnitDefinition::from(Units::$variant(u))),)+
                    // Quantities pulled in by a feature dependency that
                    // no entry of this table is stated in.
                    _ => None,
                }
            };
        }
        lookup!(
            Dimensionless => DimensionlessUnit,
            ElectricPotential => ElectricPotentialUnit,
            ElectricCurrent => ElectricCurrentUnit,
            ElectricCharge => ElectricChargeUnit,
            Power => PowerUnit,
            Energy => EnergyUnit,
            Torque => TorqueUnit,
            AngularVelocity => AngularVelocityUnit,
            Pressure => PressureUnit,
            Frequency => FrequencyUnit,
            Ratio => RatioUnit,
            TemperatureInterval => TemperatureIntervalUnit,
            Velocity => VelocityUnit,
            Time => TimeUnit,
            Length => LengthUnit,
        )
    }

    /// **The composition cross-check.** Wherever the crate enumerates a
    /// prefixed variant of one of our base units — it spells them
    /// `<prefix symbol><base abbreviation>`, so `mA` is the milliampere
    /// it tabulates as `1.0E-3` — the factor this facade *composes*
    /// (the base's multiplier times 10ⁿ) must be that same number.
    ///
    /// Without this, composition would be a second source of truth for
    /// numbers the library already carries, and a wrong power of ten
    /// would be invisible.
    #[test]
    fn every_prefixed_variant_the_crate_enumerates_matches_the_composed_factor() {
        let mut checked = 0usize;
        for entry in UNITS.iter().filter(|e| e.is_base() && e.prefixable) {
            for prefix in Prefix::all().iter().filter(|p| !p.is_none()) {
                let spelling = format!("{}{}", prefix.symbol(), entry.display);
                let Some(theirs) = enumerated(entry.unit, &spelling) else {
                    continue;
                };
                // Same quantity only: `try_from` is asked within the
                // base's own enum, so a hit is always convertible.
                let ours = definition_of(&unit(entry.base, *prefix)).expect(&spelling);
                assert!(
                    (1.0 - ours.multiplier() / theirs.multiplier()).abs() < 1e-12,
                    "{spelling}: composed {} vs enumerated {}",
                    ours.multiplier(),
                    theirs.multiplier()
                );
                checked += 1;
            }
        }
        // A cross-check that checked nothing would pass silently. The
        // crate enumerates the whole ladder for the SI base quantities,
        // so this is in the hundreds.
        assert!(checked > 100, "only {checked} pairs cross-checked");
    }

    /// The hole the composition exists for: the crate stops enumerating
    /// ampere-hours at the microampere-hour, so `nAh` has no variant to
    /// read and is composed — nano × ampere-hour — and converts.
    #[test]
    fn a_prefix_the_crate_does_not_enumerate_is_composed_and_converts() {
        assert!(enumerated(
            Units::ElectricCharge(ElectricChargeUnit::ampere_hour),
            "nAh"
        )
        .is_none());
        let nah = unit("ampere-hour", Prefix::Nano);
        let ah = unit("ampere-hour", Prefix::None);
        let to_ah = convert_units(&nah, &ah).expect("nAh to Ah");
        close(to_ah.apply(1e9), 1.0);
        let back = convert_units(&ah, &nah).expect("Ah to nAh").apply(1.0);
        assert!((1.0 - back / 1e9).abs() < 1e-12, "{back}");
        assert_eq!(display_of(&nah), "nAh");
    }

    #[test]
    fn a_prefixed_dbc_spelling_is_recognised_exact_case() {
        assert_eq!(
            recognize("nAh", &none()),
            Some(unit("ampere-hour", Prefix::Nano))
        );
        assert_eq!(recognize("µV", &none()), Some(unit("volt", Prefix::Micro)));
        assert_eq!(recognize("uV", &none()), Some(unit("volt", Prefix::Micro)));
        assert_eq!(recognize("GW", &none()), Some(unit("watt", Prefix::Giga)));
        assert_eq!(recognize("kbar", &none()), Some(unit("bar", Prefix::Kilo)));
        // Exact case, still: `NAH` is not `nAh`, and nothing guesses.
        assert_eq!(recognize("NAH", &none()), None);
        assert_eq!(recognize("nah", &none()), None);
    }

    /// The exact recognitions and the unit ids are consulted first, so
    /// adding the prefix pass cannot change what an existing spelling
    /// means.
    #[test]
    fn the_prefix_pass_never_overrides_an_exact_recognition() {
        assert_eq!(recognize("mV", &none()), Some(unit("volt", Prefix::Milli)));
        assert_eq!(recognize("MV", &none()), Some(unit("volt", Prefix::Mega)));
        assert_eq!(recognize("Pa", &none()), Some(unit("pascal", Prefix::None)));
        // …which leaves `PA` free to be what SI says it is.
        assert_eq!(recognize("PA", &none()), Some(unit("ampere", Prefix::Peta)));
        assert_eq!(
            recognize("Nm", &none()),
            Some(unit("newton-meter", Prefix::None))
        );
    }

    /// Prefixes apply to base units, not to every row: an absolute
    /// temperature and the ratio family take no SI prefix (a
    /// millidegree-celsius has no offset that makes sense), and asking
    /// for one is refused rather than composed.
    #[test]
    fn a_base_unit_that_takes_no_prefix_refuses_one() {
        assert!(definition_of(&unit("degree-celsius", Prefix::Milli)).is_none());
        assert!(definition_of(&unit("percent", Prefix::Kilo)).is_none());
        assert!(definition_of(&unit("hour", Prefix::Milli)).is_none());
        assert!(definition_of(&unit("degree-celsius", Prefix::None)).is_some());
    }

    /// A legacy unit id — what every project file written before this
    /// existed carries — reads back as the typed pair it always was.
    #[test]
    fn a_stored_unit_id_reads_back_as_a_base_and_a_prefix() {
        assert_eq!(typed("millivolt"), Some(unit("volt", Prefix::Milli)));
        assert_eq!(typed("volt"), Some(unit("volt", Prefix::None)));
        assert_eq!(
            typed("milliampere-hour"),
            Some(unit("ampere-hour", Prefix::Milli))
        );
        assert_eq!(
            typed("newton-millimeter"),
            Some(unit("newton-meter", Prefix::Milli))
        );
        assert_eq!(typed("furlong"), None);
    }

    /// Composition is the library's `UnitDefinition` multiplication —
    /// dimensions add, multipliers multiply — so an amp times an hour
    /// *is* the charge the table already names.
    #[test]
    fn a_product_of_two_units_composes_into_the_unit_it_names() {
        let amp_hour = Composed::of(unit("ampere", Prefix::None)).times(unit("hour", Prefix::None));
        assert_eq!(amp_hour.named(), Some(unit("ampere-hour", Prefix::None)));
        assert_eq!(amp_hour.display(), "Ah");
        assert_eq!(amp_hour.dimension(), Some(Dimension::Charge));

        let amp_second =
            Composed::of(unit("ampere", Prefix::None)).times(unit("second", Prefix::None));
        assert_eq!(amp_second.named(), Some(unit("coulomb", Prefix::None)));

        // The prefix rides through the composition: nanoamps by hours
        // is the nanoampere-hour the crate never enumerates.
        let nano = Composed::of(unit("ampere", Prefix::Nano)).times(unit("hour", Prefix::None));
        assert_eq!(nano.named(), Some(unit("ampere-hour", Prefix::Nano)));
        assert_eq!(nano.display(), "nAh");
    }

    /// A composition nothing names still says what it *is*: the display
    /// is rendered one-way from the factors, and the dimension is what
    /// a kind-locked picker offers against.
    #[test]
    fn a_composition_with_no_name_renders_its_factors_and_keeps_its_kind() {
        let volt_second =
            Composed::of(unit("volt", Prefix::None)).times(unit("second", Prefix::None));
        assert_eq!(volt_second.named(), None);
        assert_eq!(volt_second.display(), "V·s");

        // The design's division case: an amp-hour counter differentiated
        // per second is dimensionally a current, so `A` is reachable.
        let per_second =
            Composed::of(unit("ampere-hour", Prefix::None)).over(unit("second", Prefix::None));
        assert_eq!(per_second.display(), "Ah/s");
        assert_eq!(per_second.dimension(), Some(Dimension::Current));
        let to_amps = per_second
            .convert_to(&unit("ampere", Prefix::None))
            .expect("Ah/s to A");
        close(to_amps.gain, 3600.0);
    }

    /// A composition converts only where the analysis places it, and a
    /// unit of some other kind is refused as flatly as a pointwise
    /// mismatch is.
    #[test]
    fn a_composition_does_not_convert_to_a_unit_of_another_kind() {
        let amp_second =
            Composed::of(unit("ampere", Prefix::None)).times(unit("second", Prefix::None));
        close(
            amp_second
                .convert_to(&unit("ampere-hour", Prefix::None))
                .expect("A·s to Ah")
                .gain,
            1.0 / 3600.0,
        );
        assert!(amp_second.convert_to(&unit("volt", Prefix::None)).is_none());
    }

    /// The full SI ladder is in the model, exponent-ordered, and every
    /// entry says what it scales by — the one list the prefix picker
    /// renders (design: opened with the current selection centered).
    #[test]
    fn the_prefix_ladder_is_the_full_si_range_in_exponent_order() {
        let all = Prefix::all();
        assert_eq!(all.len(), 21);
        assert_eq!(all.first().map(|p| p.exponent()), Some(-24));
        assert_eq!(all.last().map(|p| p.exponent()), Some(24));
        assert!(all.windows(2).all(|w| w[0].exponent() < w[1].exponent()));
        assert_eq!(Prefix::None.symbol(), "");
        assert_eq!(Prefix::Micro.symbol(), "µ");
        close(Prefix::Kilo.factor(), 1000.0);
    }

    /// `scalar` is the no-unit placeholder, told apart from the ratio
    /// family by its kind — the DBC strings that mean "a count" land on
    /// it rather than on a percentage.
    #[test]
    fn a_count_is_a_scalar_and_not_a_ratio() {
        let scalar = recognize("counts", &none()).expect("counts");
        assert_eq!(scalar, unit("scalar", Prefix::None));
        assert_eq!(recognize("count", &none()), Some(scalar.clone()));
        assert_eq!(recognize("cnt", &none()), Some(scalar.clone()));
        assert_eq!(get("scalar").expect("scalar").dimension, Dimension::Scalar);
        // A ratio is a different kind, so nothing converts between them.
        assert!(convert("scalar", "percent").is_none());
    }

    /// No two recognitions spell the same string, which would make the
    /// exact-match pass depend on table order.
    #[test]
    fn no_two_recognitions_spell_the_same_string() {
        let mut seen: Vec<&str> = RECOGNITIONS.iter().map(|(s, _)| *s).collect();
        let count = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), count, "duplicate recognition spelling");
    }
}
