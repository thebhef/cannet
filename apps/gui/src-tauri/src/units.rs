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
//! ## Rates and their integrals
//!
//! [`integral_of`] is the third thing this module knows: which units are
//! **rates**, and what a second's worth of one is called (A·s is a
//! coulomb, W·s a joule). A conversion is pointwise, so it cannot answer
//! whether a current reaches amp-hours; that question is a function's,
//! and the pairing is what lets one ask it.
//!
//! ## Recognising a DBC unit string
//!
//! [`recognize`] answers a unit id or **nothing**; it never guesses. The
//! order is: the user's customization dict (which is what makes an
//! arbitrary in-house spelling work at all), then the built-in
//! recognitions exactly, then a unit's own id exactly, then the built-in
//! recognitions case-insensitively — that last only where exactly one
//! recognition matches, so `mV` and `MV` cannot silently collapse into
//! each other.
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
        }
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
    entry(
        "millivolt",
        "mV",
        Dimension::Voltage,
        Units::ElectricPotential(ElectricPotentialUnit::millivolt),
    ),
    entry(
        "kilovolt",
        "kV",
        Dimension::Voltage,
        Units::ElectricPotential(ElectricPotentialUnit::kilovolt),
    ),
    entry(
        "megavolt",
        "MV",
        Dimension::Voltage,
        Units::ElectricPotential(ElectricPotentialUnit::megavolt),
    ),
    // Current
    entry(
        "ampere",
        "A",
        Dimension::Current,
        Units::ElectricCurrent(ElectricCurrentUnit::ampere),
    ),
    entry(
        "milliampere",
        "mA",
        Dimension::Current,
        Units::ElectricCurrent(ElectricCurrentUnit::milliampere),
    ),
    entry(
        "kiloampere",
        "kA",
        Dimension::Current,
        Units::ElectricCurrent(ElectricCurrentUnit::kiloampere),
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
    entry(
        "milliampere-hour",
        "mAh",
        Dimension::Charge,
        Units::ElectricCharge(ElectricChargeUnit::milliampere_hour),
    ),
    // Power
    entry("watt", "W", Dimension::Power, Units::Power(PowerUnit::watt)),
    entry(
        "milliwatt",
        "mW",
        Dimension::Power,
        Units::Power(PowerUnit::milliwatt),
    ),
    entry(
        "kilowatt",
        "kW",
        Dimension::Power,
        Units::Power(PowerUnit::kilowatt),
    ),
    entry(
        "megawatt",
        "MW",
        Dimension::Power,
        Units::Power(PowerUnit::megawatt),
    ),
    // Energy
    entry(
        "joule",
        "J",
        Dimension::Energy,
        Units::Energy(EnergyUnit::joule),
    ),
    entry(
        "kilojoule",
        "kJ",
        Dimension::Energy,
        Units::Energy(EnergyUnit::kilojoule),
    ),
    entry(
        "watt-hour",
        "Wh",
        Dimension::Energy,
        Units::Energy(EnergyUnit::watt_hour),
    ),
    entry(
        "kilowatt-hour",
        "kWh",
        Dimension::Energy,
        Units::Energy(EnergyUnit::kilowatt_hour),
    ),
    // Torque
    entry(
        "newton-meter",
        "Nm",
        Dimension::Torque,
        Units::Torque(TorqueUnit::newton_meter),
    ),
    entry(
        "newton-millimeter",
        "Nmm",
        Dimension::Torque,
        Units::Torque(TorqueUnit::newton_millimeter),
    ),
    // Angular velocity
    entry(
        "revolution-per-minute",
        "rpm",
        Dimension::AngularVelocity,
        Units::AngularVelocity(AngularVelocityUnit::revolution_per_minute),
    ),
    entry(
        "radian-per-second",
        "rad/s",
        Dimension::AngularVelocity,
        Units::AngularVelocity(AngularVelocityUnit::radian_per_second),
    ),
    entry(
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
    entry(
        "kilopascal",
        "kPa",
        Dimension::Pressure,
        Units::Pressure(PressureUnit::kilopascal),
    ),
    entry(
        "megapascal",
        "MPa",
        Dimension::Pressure,
        Units::Pressure(PressureUnit::megapascal),
    ),
    entry(
        "bar",
        "bar",
        Dimension::Pressure,
        Units::Pressure(PressureUnit::bar),
    ),
    entry(
        "millibar",
        "mbar",
        Dimension::Pressure,
        Units::Pressure(PressureUnit::millibar),
    ),
    entry(
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
    entry(
        "kilohertz",
        "kHz",
        Dimension::Frequency,
        Units::Frequency(FrequencyUnit::kilohertz),
    ),
    entry(
        "megahertz",
        "MHz",
        Dimension::Frequency,
        Units::Frequency(FrequencyUnit::megahertz),
    ),
    // Ratio
    entry(
        "percent",
        "%",
        Dimension::Ratio,
        Units::Ratio(RatioUnit::percent),
    ),
    entry(
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
    entry(
        "ratio",
        "ratio",
        Dimension::Ratio,
        Units::Dimensionless(DimensionlessUnit::scalar),
    ),
    // Temperature — the three that carry a constant. The library's
    // absolute-temperature quantity is not built in this release, so
    // these ride its temperature-*interval* multipliers (K: 1, °C: 1,
    // °F: 5/9) with the offset supplied here.
    Entry {
        id: "kelvin",
        display: "K",
        dimension: Dimension::Temperature,
        unit: Units::TemperatureInterval(TemperatureIntervalUnit::kelvin),
        constant: 0.0,
    },
    Entry {
        id: "degree-celsius",
        display: "°C",
        dimension: Dimension::Temperature,
        unit: Units::TemperatureInterval(TemperatureIntervalUnit::degree_celsius),
        constant: 273.15,
    },
    Entry {
        id: "degree-fahrenheit",
        display: "°F",
        dimension: Dimension::Temperature,
        unit: Units::TemperatureInterval(TemperatureIntervalUnit::degree_fahrenheit),
        constant: 459.67,
    },
    // Speed
    entry(
        "meter-per-second",
        "m/s",
        Dimension::Speed,
        Units::Velocity(VelocityUnit::meter_per_second),
    ),
    entry(
        "kilometer-per-hour",
        "km/h",
        Dimension::Speed,
        Units::Velocity(VelocityUnit::kilometer_per_hour),
    ),
    entry(
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
    entry(
        "millisecond",
        "ms",
        Dimension::Time,
        Units::Time(TimeUnit::millisecond),
    ),
    entry(
        "microsecond",
        "µs",
        Dimension::Time,
        Units::Time(TimeUnit::microsecond),
    ),
    entry(
        "minute",
        "min",
        Dimension::Time,
        Units::Time(TimeUnit::minute),
    ),
    entry("hour", "h", Dimension::Time, Units::Time(TimeUnit::hour)),
    // Length
    entry(
        "meter",
        "m",
        Dimension::Length,
        Units::Length(LengthUnit::meter),
    ),
    entry(
        "millimeter",
        "mm",
        Dimension::Length,
        Units::Length(LengthUnit::millimeter),
    ),
    entry(
        "centimeter",
        "cm",
        Dimension::Length,
        Units::Length(LengthUnit::centimeter),
    ),
    entry(
        "kilometer",
        "km",
        Dimension::Length,
        Units::Length(LengthUnit::kilometer),
    ),
];

/// An [`Entry`] with no constant — every unit but the three absolute
/// temperatures.
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
    ("scalar", "ratio"),
    ("percent", "percent"),
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
    ("m", "meter"),
    ("mm", "millimeter"),
    ("cm", "centimeter"),
    ("km", "kilometer"),
];

/// A rate and the unit its integral over **seconds** carries: current ×
/// t is charge (A·s is a coulomb), power × t is energy (W·s is a joule).
///
/// `rate` is the family's canonical unit — the one a value has to be
/// read in for its integral to come out in `integral` — so an operand in
/// milliamps converts to `rate` first and the integral is still
/// coulombs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RateIntegral {
    pub rate: &'static str,
    pub integral: &'static str,
}

/// Every rate whose integral this facade can name. Two, because two is
/// what a bus carries: a current to accumulate into charge and a power
/// to accumulate into energy. Adding one is a line here plus its units
/// in [`UNITS`].
static RATE_INTEGRALS: &[(Dimension, RateIntegral)] = &[
    (
        Dimension::Current,
        RateIntegral {
            rate: "ampere",
            integral: "coulomb",
        },
    ),
    (
        Dimension::Power,
        RateIntegral {
            rate: "watt",
            integral: "joule",
        },
    ),
];

/// The pairing for the family `unit_id` belongs to, or `None` where
/// integrating it names nothing this facade carries.
///
/// Keyed on the *dimension*, so every unit of a rate family answers the
/// same pairing — `milliampere` and `ampere` both integrate into
/// coulombs, once the value is read in amps.
#[must_use]
pub fn integral_of(unit_id: &str) -> Option<RateIntegral> {
    let dimension = find(unit_id)?.dimension;
    RATE_INTEGRALS
        .iter()
        .find(|(d, _)| *d == dimension)
        .map(|(_, pairing)| *pairing)
}

/// The user's DBC-unit-string → unit-id overrides. Sparse: it holds only
/// what the user changed, and an empty dict is the shipped behaviour.
///
/// Ordered so the workspace `settings.json` it persists in writes the
/// same bytes for the same content, which is what makes it reviewable
/// (ADR 0034 — the file is a hand-editable contract).
pub type Customizations = BTreeMap<String, String>;

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
            spelling: if recognize(self.display, &Customizations::new()) == Some(self.id) {
                self.display
            } else {
                self.id
            },
        }
    }

    /// This unit's affine to its dimension's base unit: the library's
    /// multiplier, with the constant folded in ahead of it, so
    /// `base = gain·v + offset`.
    fn to_base(&self) -> Affine {
        let gain = UnitDefinition::from(self.unit).multiplier();
        Affine::new(gain, self.constant * gain)
    }
}

/// The affine that carries a value in `from` to a value in `to`, or
/// `None` when either id is unknown or the two measure different things.
///
/// Same unit both sides is [`Affine::IDENTITY`] exactly, not a rounded
/// one — a conversion that changes nothing must cost nothing.
#[must_use]
pub fn convert(from: &str, to: &str) -> Option<Affine> {
    let (from, to) = (find(from)?, find(to)?);
    if from.dimension != to.dimension {
        return None;
    }
    if from.id == to.id {
        return Some(Affine::IDENTITY);
    }
    let (a, b) = (from.to_base(), to.to_base());
    Some(Affine::new(a.gain / b.gain, (a.offset - b.offset) / b.gain))
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
pub fn recognize(raw: &str, customizations: &Customizations) -> Option<&'static str> {
    for key in [raw, raw.trim()] {
        if let Some(id) = customizations.get(key) {
            return find(id).map(|e| e.id);
        }
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some((_, id)) = RECOGNITIONS.iter().find(|(s, _)| *s == trimmed) {
        return Some(id);
    }
    if let Some(entry) = find(trimmed) {
        return Some(entry.id);
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
    hit
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
        assert_eq!(recognize("scalar", &Customizations::new()), Some("ratio"));
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
                Some(id),
                "{id} reads {display}"
            );
        }
    }

    #[test]
    fn a_rate_pairs_with_the_unit_its_integral_over_seconds_carries() {
        let current = integral_of("ampere").expect("a current integrates");
        assert_eq!(current.rate, "ampere");
        assert_eq!(current.integral, "coulomb");
        // Every unit of the family answers the same pairing — what
        // makes a milliamp operand reachable, once it is read in amps.
        assert_eq!(integral_of("milliampere"), Some(current));
        let power = integral_of("kilowatt").expect("a power integrates");
        assert_eq!(power.rate, "watt");
        assert_eq!(power.integral, "joule");
    }

    #[test]
    fn a_quantity_that_is_not_a_rate_integrates_into_nothing_nameable() {
        // A charge is already an integral, and nothing here says what a
        // volt-second is called.
        assert!(integral_of("coulomb").is_none());
        assert!(integral_of("volt").is_none());
        assert!(integral_of("degree-celsius").is_none());
        assert!(integral_of("furlong").is_none());
    }

    /// Every pairing names units this table carries, and names an
    /// integral of a *different* dimension from its rate — or the
    /// pairing would be a conversion, not an integration.
    #[test]
    fn every_pairing_names_two_real_units_of_two_dimensions() {
        for (dimension, pairing) in RATE_INTEGRALS {
            let rate = get(pairing.rate).expect(pairing.rate);
            let integral = get(pairing.integral).expect(pairing.integral);
            assert_eq!(rate.dimension, *dimension, "{}", pairing.rate);
            assert_ne!(rate.dimension, integral.dimension, "{}", pairing.rate);
        }
    }

    #[test]
    fn an_integrated_unit_converts_onward_to_what_a_user_asks_for() {
        // The output half of the integration path: coulombs to
        // amp-hours is ÷3600, joules to kilowatt-hours ÷3.6e6.
        let charge = convert(integral_of("ampere").unwrap().integral, "ampere-hour");
        close(charge.expect("C to Ah").gain, 1.0 / 3600.0);
        let energy = convert(integral_of("watt").unwrap().integral, "kilowatt-hour");
        close(energy.expect("J to kWh").gain, 1.0 / 3_600_000.0);
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
            assert_eq!(recognize(raw, &none()), Some(id), "{raw}");
        }
    }

    #[test]
    fn a_unit_string_is_recognised_around_its_padding() {
        assert_eq!(recognize("  rpm ", &none()), Some("revolution-per-minute"));
    }

    #[test]
    fn recognition_is_case_insensitive_only_where_one_spelling_matches() {
        assert_eq!(recognize("RPM", &none()), Some("revolution-per-minute"));
        assert_eq!(recognize("Bar", &none()), Some("bar"));
        assert_eq!(recognize("DEGC", &none()), Some("degree-celsius"));
        // `mV` and `MV` are both recognised exactly, so either spelling
        // typed exactly is honoured — and a third casing is refused
        // rather than picked between.
        assert_eq!(recognize("mV", &none()), Some("millivolt"));
        assert_eq!(recognize("MV", &none()), Some("megavolt"));
        assert_eq!(recognize("mv", &none()), None);
        assert_eq!(recognize("Mv", &none()), None);
    }

    #[test]
    fn an_unrecognised_string_is_nothing_rather_than_a_guess() {
        for raw in ["", "   ", "counts", "C", "Nm/rad", "widgets"] {
            assert_eq!(recognize(raw, &none()), None, "{raw:?}");
        }
    }

    #[test]
    fn a_customization_wins_over_the_built_in_recognitions() {
        let mut dict = Customizations::new();
        dict.insert("V".to_string(), "millivolt".to_string());
        dict.insert("counts".to_string(), "percent".to_string());
        assert_eq!(recognize("V", &dict), Some("millivolt"));
        assert_eq!(recognize("counts", &dict), Some("percent"));
        // Still exact: the dict is the user's spelling, not a pattern.
        assert_eq!(recognize("COUNTS", &dict), None);
    }

    #[test]
    fn a_customization_naming_no_unit_recognises_nothing() {
        // A hand-edited settings file, or a unit id a later build
        // dropped. It is refused here rather than resolving to a
        // conversion nobody described.
        let mut dict = Customizations::new();
        dict.insert("counts".to_string(), "furlong".to_string());
        assert_eq!(recognize("counts", &dict), None);
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
            assert_eq!(recognize(entry.id, &none()), Some(entry.id), "{}", entry.id);
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
                Some(listing.info.id),
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
