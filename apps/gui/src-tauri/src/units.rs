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
//! supply is a *policy*, and the policies below are ours:
//!
//! - **Dimensions are our grouping, not the library's base units.** The
//!   library compares SI base dimensions, under which `rpm` converts to
//!   `Hz` (both s⁻¹, differing by 2π) and `N·m` converts to `J` (both
//!   kg·m²·s⁻²). Neither is a conversion a user asking for revolutions
//!   in hertz would recognise, so a conversion here is offered only
//!   **within one [`Dimension`]**, and every unit in a dimension is one
//!   library quantity's (`every_dimension_is_one_convertible_family`).
//! - **Offsets are ours.** The library's `UnitDefinition` carries a
//!   multiplier and nothing else, and it builds no absolute-temperature
//!   quantity — so the constants that make °C and °F absolute readings
//!   rather than intervals are this module's
//!   (`ABSOLUTE_TEMPERATURES`), laid over the library's
//!   temperature-*interval* multipliers. The intervals themselves are a
//!   dimension of their own beside them.
//! - **A proportion takes a scale, not an SI ladder.** The ratio family
//!   is one picker row whose second column is every ratio unit the
//!   library carries, largest scale first; a millipercent is not a unit
//!   anybody means.
//! - **A count is not a proportion.** The library's one dimensionless
//!   `scalar` is a dimension of its own here — the no-unit placeholder
//!   a bare count of packets carries, which converts to nothing at all
//!   where a percentage converts to a 0–1 ratio.
//!
//! ## Where the table comes from
//!
//! **Every unit of every quantity the library builds is offered**, and
//! nothing here chooses between them. [`Dimension`] names the library's
//! quantities — that list is the only hand-written part — and the rows
//! are read back out of the library: its own enumeration of a
//! quantity's units, each one's multiplier, and its symbol, singular and
//! plural. A unit is a **prefixed rung** of another where the library's
//! name for it says so *and* its multiplier agrees with the prefix
//! (`prefix_rung`); everything else is a base unit, which is the
//! footing `bar`, `psi` and every imperial unit ride on.
//!
//! Two spellings are derived rather than taken verbatim: a unit reads as
//! its symbol with the library's ` · ` product separator closed up (`A
//! · h` is `Ah`, which is what a database writes and what a
//! composition contracts to), and the library's one unit with no symbol
//! at all — the bare 0–1 ratio — reads as its id.
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
//! is reached at all). Compositions the *host* builds are rendered
//! one-way and never parsed or persisted.
//!
//! ## Units the user composes
//!
//! A person may also name a composition themselves — `VA` is `V * A` —
//! in the settings view's units section. That string is a **second
//! ingest boundary**, read exactly once by [`install_definitions`],
//! which turns the pair into a unit the model holds like any other —
//! from there it is a [`UnitId`] like everything else. Nothing
//! downstream ever sees the composition string again; the row that shows
//! it in the settings table shows what the user typed, not something
//! re-derived from the model.
//!
//! ## Recognising a DBC unit string
//!
//! [`recognize`] answers a [`UnitId`] or **nothing**; it never guesses.
//! The order is: the user's customization dict (which is what makes an
//! arbitrary in-house spelling work at all), then the built-in
//! recognitions exactly, then a unit's own id exactly, then **every
//! spelling the library gives a unit** — its symbol, singular and
//! plural — then `[prefix][base]` exact-case (`nAh`), then the built-in
//! recognitions case-insensitively. The last three passes are each
//! *unique or nothing*: `kg/m³` is a mass density and a mass
//! concentration alike, and `mV` and `MV` cannot silently collapse into
//! each other, so an ambiguous spelling reaches no unit at all.
//!
//! The library pass is what makes the whole table reachable from a
//! database (`L`, `psi`, `liters per minute`) without anyone tabulating
//! two thousand spellings here; the passes ahead of it are what keep a
//! spelling meaning what it always meant.
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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{LazyLock, PoisonError, RwLock};

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

/// One unit as the **library** hands it over, before this module has
/// decided what to call it or whether it is a rung of a ladder.
struct Row {
    /// The library's own name for the unit, which is what
    /// [`prefix_rung`] reads and what the id is spelled from.
    variant: String,
    symbol: &'static str,
    singular: &'static str,
    plural: &'static str,
    multiplier: f64,
    unit: Units,
}

fn library_rows(
    spellings: &'static [&'static str],
    read: impl Fn(&'static str) -> Option<Row>,
) -> Vec<Row> {
    spellings.iter().copied().filter_map(read).collect()
}

/// Declares [`Dimension`] over the library's quantities: one variant per
/// quantity, and the reading of that quantity's units that every lookup
/// in this module goes through.
macro_rules! dimensions {
    ($($variant:ident => $unit:ident),+ $(,)?) => {
        /// The physical quantity a unit measures — the facade's own
        /// grouping, and the only thing that decides whether two units
        /// convert.
        ///
        /// One dimension is one library quantity, so the multipliers
        /// within a dimension share a base and composing them is sound
        /// (`every_dimension_is_one_convertible_family`). The exception
        /// is [`Self::Temperature`]: the library builds no absolute
        /// temperature, so this module lays its own offsets over the
        /// library's temperature intervals, which stay a dimension of
        /// their own.
        ///
        /// The serialized name is the variant in kebab-case, and it is a
        /// math signal's `kind` in a project file — so a spelling here
        /// is a contract, not a label.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "kebab-case")]
        pub enum Dimension {
            $($variant,)+
        }

        /// Every dimension, in the order composition resolves them.
        static DIMENSIONS: &[Dimension] = &[$(Dimension::$variant,)+];

        impl Dimension {
            /// The variant's own spelling — what [`Dimension::kebab`]
            /// and [`Dimension::label`] are both derived from, so
            /// neither can drift from the name in the source.
            fn spelled(self) -> &'static str {
                match self {
                    $(Self::$variant => stringify!($variant),)+
                }
            }

            /// Every unit the library enumerates for this dimension's
            /// quantity.
            ///
            /// The library lists a quantity's units by their singular
            /// name and reads a unit back from a spelling; a name two
            /// units of one quantity share reaches only the first of
            /// them, so the round-trip is checked rather than assumed.
            fn rows(self) -> Vec<Row> {
                match self {
                    $(Self::$variant => library_rows(
                        runtime_units::units::$unit::units(),
                        |spelling| {
                            let unit =
                                runtime_units::units::$unit::try_from(spelling).ok()?;
                            (unit.singular() == spelling).then(|| Row {
                                variant: format!("{unit:?}"),
                                symbol: unit.abbreviation(),
                                singular: unit.singular(),
                                plural: unit.plural(),
                                multiplier: unit.multiplier(),
                                unit: Units::from(unit),
                            })
                        },
                    ),)+
                }
            }

            /// What the **library** makes of a spelling inside this
            /// dimension's quantity — the independent answer the prefix
            /// cross-check holds this module's composed factors against.
            #[cfg(test)]
            fn library_definition(self, spelling: &str) -> Option<UnitDefinition> {
                match self {
                    $(Self::$variant => runtime_units::units::$unit::try_from(spelling)
                        .ok()
                        .map(|unit| UnitDefinition::from(Units::from(unit))),)+
                }
            }
        }
    };
}

// The head of this list is the fifteen dimensions this facade named
// before the table came from the library, **in the order composition has
// always resolved them**: a product landing on base dimensions two
// families share reads as the first of them, so an amp times an hour is
// a charge rather than a duration of current. Everything after it is
// alphabetical — an order nobody has to maintain, and one that leaves
// every automotive family ahead of the quantities that merely share its
// exponents.
dimensions! {
    Charge => ElectricChargeUnit,
    Energy => EnergyUnit,
    Power => PowerUnit,
    Voltage => ElectricPotentialUnit,
    Current => ElectricCurrentUnit,
    Frequency => FrequencyUnit,
    Pressure => PressureUnit,
    Speed => VelocityUnit,
    Length => LengthUnit,
    Time => TimeUnit,
    Temperature => TemperatureIntervalUnit,
    Torque => TorqueUnit,
    AngularVelocity => AngularVelocityUnit,
    Ratio => RatioUnit,
    Scalar => DimensionlessUnit,

    Absement => AbsementUnit,
    AbsorbedDose => AbsorbedDoseUnit,
    Acceleration => AccelerationUnit,
    Action => ActionUnit,
    AmountOfSubstance => AmountOfSubstanceUnit,
    Angle => AngleUnit,
    AngularAcceleration => AngularAccelerationUnit,
    AngularJerk => AngularJerkUnit,
    Area => AreaUnit,
    ArealDensityOfStates => ArealDensityOfStatesUnit,
    ArealMassDensity => ArealMassDensityUnit,
    ArealNumberDensity => ArealNumberDensityUnit,
    ArealNumberRate => ArealNumberRateUnit,
    Capacitance => CapacitanceUnit,
    CatalyticActivity => CatalyticActivityUnit,
    CatalyticActivityConcentration => CatalyticActivityConcentrationUnit,
    CubeRootScaledLength => CubeRootScaledLengthUnit,
    Curvature => CurvatureUnit,
    DiffusionCoefficient => DiffusionCoefficientUnit,
    DoseEquivalent => DoseEquivalentUnit,
    DynamicViscosity => DynamicViscosityUnit,
    ElectricChargeArealDensity => ElectricChargeArealDensityUnit,
    ElectricChargeLinearDensity => ElectricChargeLinearDensityUnit,
    ElectricChargeVolumetricDensity => ElectricChargeVolumetricDensityUnit,
    ElectricCurrentDensity => ElectricCurrentDensityUnit,
    ElectricDipoleMoment => ElectricDipoleMomentUnit,
    ElectricDisplacementField => ElectricDisplacementFieldUnit,
    ElectricField => ElectricFieldUnit,
    ElectricFlux => ElectricFluxUnit,
    ElectricPermittivity => ElectricPermittivityUnit,
    ElectricQuadrupoleMoment => ElectricQuadrupoleMomentUnit,
    ElectricalConductance => ElectricalConductanceUnit,
    ElectricalConductivity => ElectricalConductivityUnit,
    ElectricalMobility => ElectricalMobilityUnit,
    ElectricalResistance => ElectricalResistanceUnit,
    ElectricalResistivity => ElectricalResistivityUnit,
    Force => ForceUnit,
    FrequencyDrift => FrequencyDriftUnit,
    HeatCapacity => HeatCapacityUnit,
    HeatFluxDensity => HeatFluxDensityUnit,
    HeatTransfer => HeatTransferUnit,
    Inductance => InductanceUnit,
    Information => InformationUnit,
    InformationRate => InformationRateUnit,
    Jerk => JerkUnit,
    LinearDensityOfStates => LinearDensityOfStatesUnit,
    LinearMassDensity => LinearMassDensityUnit,
    LinearNumberDensity => LinearNumberDensityUnit,
    LinearNumberRate => LinearNumberRateUnit,
    LinearPowerDensity => LinearPowerDensityUnit,
    Luminance => LuminanceUnit,
    LuminousIntensity => LuminousIntensityUnit,
    MagneticFieldStrength => MagneticFieldStrengthUnit,
    MagneticFlux => MagneticFluxUnit,
    MagneticFluxDensity => MagneticFluxDensityUnit,
    MagneticMoment => MagneticMomentUnit,
    MagneticPermeability => MagneticPermeabilityUnit,
    Mass => MassUnit,
    MassConcentration => MassConcentrationUnit,
    MassDensity => MassDensityUnit,
    MassFlux => MassFluxUnit,
    MassRate => MassRateUnit,
    Molality => MolalityUnit,
    MolarConcentration => MolarConcentrationUnit,
    MolarEnergy => MolarEnergyUnit,
    MolarFlux => MolarFluxUnit,
    MolarHeatCapacity => MolarHeatCapacityUnit,
    MolarMass => MolarMassUnit,
    MolarRadioactivity => MolarRadioactivityUnit,
    MolarVolume => MolarVolumeUnit,
    MomentOfInertia => MomentOfInertiaUnit,
    Momentum => MomentumUnit,
    PressureImpulse => PressureImpulseUnit,
    RadiantExposure => RadiantExposureUnit,
    Radioactivity => RadioactivityUnit,
    ReciprocalLength => ReciprocalLengthUnit,
    SolidAngle => SolidAngleUnit,
    SpecificArea => SpecificAreaUnit,
    SpecificEnergy => SpecificEnergyUnit,
    SpecificHeatCapacity => SpecificHeatCapacityUnit,
    SpecificRadioactivity => SpecificRadioactivityUnit,
    SpecificVolume => SpecificVolumeUnit,
    SurfaceElectricCurrentDensity => SurfaceElectricCurrentDensityUnit,
    TemperatureCoefficient => TemperatureCoefficientUnit,
    TemperatureGradient => TemperatureGradientUnit,
    TemperatureInterval => TemperatureIntervalUnit,
    ThermalConductivity => ThermalConductivityUnit,
    Volume => VolumeUnit,
    VolumeRate => VolumeRateUnit,
    VolumetricDensityOfStates => VolumetricDensityOfStatesUnit,
    VolumetricHeatCapacity => VolumetricHeatCapacityUnit,
    VolumetricNumberDensity => VolumetricNumberDensityUnit,
    VolumetricNumberRate => VolumetricNumberRateUnit,
    VolumetricPowerDensity => VolumetricPowerDensityUnit,
}

/// The absolute temperature scales, and the constant that makes each a
/// reading rather than an interval.
///
/// **This is the facade's own contribution**, and the reason
/// [`Dimension::Temperature`] exists at all: the library carries
/// temperature *intervals* (a °C step is a K step) and builds no
/// absolute-temperature quantity, so a 0 °C that is 273.15 K comes from
/// here. Each names a library interval unit; the multipliers are still
/// the library's.
static ABSOLUTE_TEMPERATURES: &[(&str, f64)] = &[
    ("kelvin", 0.0),
    ("degree_celsius", 273.15),
    ("degree_fahrenheit", 459.67),
    // Rankine is Fahrenheit-sized and absolute already, so its offset is
    // nothing — it is here because the library carries it and this
    // module does not pick among the scales it finds.
    ("degree_rankine", 0.0),
];

fn absolute_constant(variant: &str) -> Option<f64> {
    ABSOLUTE_TEMPERATURES
        .iter()
        .find(|(name, _)| *name == variant)
        .map(|(_, constant)| *constant)
}

/// `AngularVelocity` → `angular-velocity`: serde's own kebab rule,
/// spelled out so the picker label and the id qualifier read the same
/// name the project file does.
fn kebab_case(camel: &str) -> String {
    let mut out = String::with_capacity(camel.len() + 8);
    for (at, ch) in camel.char_indices() {
        if at != 0 && ch.is_ascii_uppercase() {
            out.push('-');
        }
        out.extend(ch.to_lowercase());
    }
    out
}

/// The serialized name and the picker label of every dimension, both
/// derived from the variant's spelling.
static NAMES: LazyLock<Vec<(&'static str, &'static str)>> = LazyLock::new(|| {
    DIMENSIONS
        .iter()
        .map(|dimension| {
            let kebab: &'static str = String::leak(kebab_case(dimension.spelled()));
            let label: &'static str = String::leak(kebab.replace('-', " "));
            (kebab, label)
        })
        .collect()
});

impl Dimension {
    /// Every dimension, in the order composition resolves them.
    #[must_use]
    pub fn all() -> &'static [Self] {
        DIMENSIONS
    }

    fn index(self) -> usize {
        self as usize
    }

    /// The **serialized** name — a math signal's `kind` in a project
    /// file.
    #[must_use]
    pub fn kebab(self) -> &'static str {
        NAMES[self.index()].0
    }

    /// The label a picker groups by.
    #[must_use]
    pub fn label(self) -> &'static str {
        NAMES[self.index()].1
    }
}

/// An SI decimal prefix — the second half of a unit's identity.
///
/// The **full** range is in the model, whatever the library happens to
/// enumerate: a picker offers a base unit and a prefix, so an exponent
/// the crate has no variant for is composed rather than missing (design
/// ruling — enumeration gaps do not dictate the model).
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
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
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
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
/// target unit. It is the library's own name for the unit in kebab-case,
/// so it is a safe JSON key; `display` is what a label shows.
struct Entry {
    id: String,
    display: String,
    dimension: Dimension,
    unit: Units,
    /// The constant added **before** the library's multiplier when
    /// converting to the dimension's base — zero for every unit but the
    /// absolute temperatures, where it is what makes °C a reading rather
    /// than an interval.
    constant: f64,
    /// The **base unit** this entry is a prefixed form of, or its own id
    /// where it is one. A `millivolt` row is the library's enumerated
    /// variant of `{base: "volt", prefix: Milli}`, which is the identity
    /// the model actually carries.
    base: String,
    prefix: Prefix,
    /// Whether the SI ladder applies to this base unit — true exactly
    /// where the library tabulates a rung of it, after which the whole
    /// range is in the model whatever it happens to carry (`kbar` from
    /// `mbar` alone). False for a unit with no rung at all: an absolute
    /// temperature, a member of the ratio family, `min`, `psi`, `km/h`.
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
///
/// Owned strings rather than `&'static str`: a unit the user composed is
/// as selectable as a tabulated one, and its name is theirs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitInfo {
    pub id: String,
    pub display: String,
    pub dimension: Dimension,
}

/// One selectable unit as a **picker** lists it: the unit, the heading
/// it groups under, and the string to commit when it is chosen.
///
/// A view renders this and derives nothing: which units exist, how they
/// group and how they are spelled are all the facade's answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
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
    pub spelling: String,
}

/// **Every unit the library carries**, plus the absolute temperature
/// scales this module lays over its temperature intervals.
///
/// Nothing here is written by hand: [`Dimension`] names the library's
/// quantities and the rows are read back out of it, so a unit the
/// library gains is a unit this app offers. [`Table`] is the built form
/// — the rows plus the indexes every lookup goes through, since a
/// linear scan of two thousand rows is not a lookup.
static UNITS: LazyLock<Table> = LazyLock::new(build);

/// The built unit table and the indexes onto it.
struct Table {
    entries: Vec<Entry>,
    /// Stable id → row. Ids are unique, which is what makes one a safe
    /// JSON key.
    by_id: HashMap<String, usize>,
    /// `(base, prefix)` → the row the library **enumerates** for that
    /// pair, where it has one. The holes are what composition fills.
    by_typed: HashMap<(String, Prefix), usize>,
    /// The base rows of each dimension, indexed by
    /// [`Dimension::index`] — what composition walks.
    bases: Vec<Vec<usize>>,
    /// Every spelling the library gives a unit — symbol, singular and
    /// plural — mapped to the unit it names, or to `None` where two
    /// units spell themselves the same way. Ambiguity is refused, never
    /// resolved by order.
    spellings: HashMap<String, Option<UnitId>>,
}

impl Table {
    fn iter(&self) -> std::slice::Iter<'_, Entry> {
        self.entries.iter()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Whether `row` is a **prefixed rung** of another unit in the same
/// quantity, and of which one.
///
/// Both halves of the rule are load-bearing. The library's **name** has
/// to say so — `millivolt` is `volt` with `milli` spliced in, and so is
/// `newton_millimeter` from `newton_meter`, which is why the prefix is
/// looked for at every word of the name and not only at its head. And
/// the **number** has to agree: `ampere per micrometer` reads as a micro
/// rung of `ampere per meter` and is a million of them, so the ladder
/// only holds where the multiplier really is the prefix's power of ten.
/// Where the two disagree the unit is a base of its own, which is also
/// the footing every imperial and US customary unit rides on.
fn prefix_rung(row: &Row, rows: &[Row]) -> Option<(usize, Prefix)> {
    let mut best: Option<(usize, usize, usize, Prefix)> = None;
    for prefix in Prefix::all().iter().filter(|p| !p.is_none()) {
        let name = prefix.name();
        for (at, _) in row.variant.match_indices(name) {
            // A prefix splices in at a word of the library's name, so
            // `newton_millimeter` strips to `newton_meter` and
            // `abvolt` strips to nothing at all.
            if at != 0 && !row.variant[..at].ends_with('_') {
                continue;
            }
            let stripped = format!("{}{}", &row.variant[..at], &row.variant[at + name.len()..]);
            let stripped = stripped.trim_matches('_').replace("__", "_");
            if stripped == row.variant {
                continue;
            }
            let Some(index) = rows.iter().position(|r| r.variant == stripped) else {
                continue;
            };
            let base = rows[index].multiplier;
            if base == 0.0 || (row.multiplier / base / prefix.factor() - 1.0).abs() > 1e-9 {
                continue;
            }
            // Earliest splice point first, and the longest prefix there
            // — so `daV` is a decavolt and never a deci-`aV`.
            let key = (at, usize::MAX - name.len(), index, *prefix);
            if best.is_none_or(|current| key < current) {
                best = Some(key);
            }
        }
    }
    best.map(|(_, _, index, prefix)| (index, prefix))
}

/// The base a rung really sits on, once a rung **of a rung** is walked
/// down to it.
///
/// The library names a `kilogram yottameter per second` off the
/// `kilogram meter per second` that is itself a kilo-rung of the
/// `gram meter per second` — so the ladder it is on is the gram's, at
/// 10²⁷, which is no SI prefix at all. A rung whose prefixes do not
/// add up to one is a base unit of its own.
fn settled_rung(index: usize, rungs: &[Option<(usize, Prefix)>]) -> Option<(usize, Prefix)> {
    let (mut base, first) = rungs[index]?;
    let mut exponent = first.exponent();
    let mut steps = 0;
    while let Some((next, prefix)) = rungs[base] {
        exponent += prefix.exponent();
        base = next;
        steps += 1;
        assert!(steps <= rungs.len(), "a unit is a prefixed form of itself");
    }
    Prefix::all()
        .iter()
        .copied()
        .find(|p| !p.is_none() && p.exponent() == exponent)
        .map(|prefix| (base, prefix))
}

fn build() -> Table {
    let mut entries: Vec<Entry> = Vec::new();
    let mut spelled: Vec<(&'static str, UnitId)> = Vec::new();
    // An id is a JSON key and a project file's stored unit, so it has to
    // be unique across the whole table. Where two quantities carry the
    // same unit — a minute is a time and an angle — the dimension that
    // resolves first keeps the plain spelling and the later one wears
    // its dimension's name.
    let mut taken: HashSet<String> = HashSet::new();
    for dimension in Dimension::all().iter().copied() {
        let absolute = dimension == Dimension::Temperature;
        let mut rows = dimension.rows();
        if absolute {
            rows.retain(|row| absolute_constant(&row.variant).is_some());
        }
        let ids: Vec<String> = rows
            .iter()
            .map(|row| {
                let plain = row.variant.replace('_', "-");
                let id = if taken.contains(&plain) {
                    format!("{}-{plain}", dimension.kebab())
                } else {
                    plain
                };
                taken.insert(id.clone());
                id
            })
            .collect();
        // An absolute scale is not a rung of anything: a
        // millidegree-celsius has no offset that means a temperature.
        //
        // The library sometimes names one rung twice — a `kilonewton
        // meter` and a `newton kilometer` are the same unit — and both
        // rows then carry the same identity, because the rule only
        // places a rung where the multiplier really is the prefix's: two
        // names for one number are one unit.
        let direct: Vec<Option<(usize, Prefix)>> = rows
            .iter()
            .map(|row| (!absolute).then(|| prefix_rung(row, &rows)).flatten())
            .collect();
        for (index, (row, id)) in rows.iter().zip(&ids).enumerate() {
            let rung = settled_rung(index, &direct);
            let (base, prefix) = rung.map_or_else(
                || (id.clone(), Prefix::None),
                |(index, prefix)| (ids[index].clone(), prefix),
            );
            let unit = UnitId::new(&base, prefix);
            for spelling in [row.symbol, row.singular, row.plural] {
                if !spelling.trim().is_empty() {
                    spelled.push((spelling, unit.clone()));
                }
            }
            // The library spells a product `A · h`; a database writes
            // `Ah`, and a composition of an amp and an hour contracts to
            // it. Its one unit with no symbol at all is the bare 0–1
            // ratio, which reads as its own name.
            let display = row.symbol.replace(" · ", "");
            entries.push(Entry {
                display: if display.is_empty() {
                    id.clone()
                } else {
                    display
                },
                id: id.clone(),
                dimension,
                unit: row.unit,
                constant: if absolute {
                    absolute_constant(&row.variant).unwrap_or_default()
                } else {
                    0.0
                },
                base,
                prefix,
                prefixable: false,
            });
        }
    }
    // A base takes the SI ladder exactly where the library gave it a
    // rung: the whole range is then in the model whatever the library
    // happens to tabulate, which is how `kbar` works from `mbar` alone.
    let ladders: HashSet<String> = entries
        .iter()
        .filter(|e| !e.is_base())
        .map(|e| e.base.clone())
        .collect();
    let mut bases: Vec<Vec<usize>> = vec![Vec::new(); Dimension::all().len()];
    let mut by_id = HashMap::with_capacity(entries.len());
    let mut by_typed = HashMap::with_capacity(entries.len());
    for entry in &mut entries {
        entry.prefixable = ladders.contains(&entry.id);
    }
    for (index, entry) in entries.iter().enumerate() {
        by_id.insert(entry.id.clone(), index);
        by_typed.insert((entry.base.clone(), entry.prefix), index);
        if entry.is_base() {
            bases[entry.dimension.index()].push(index);
        }
    }
    let mut spellings: HashMap<String, Option<UnitId>> = HashMap::with_capacity(spelled.len());
    for (spelling, unit) in spelled {
        spellings
            .entry(spelling.to_string())
            .and_modify(|held| {
                if held.as_ref() != Some(&unit) {
                    *held = None;
                }
            })
            .or_insert(Some(unit));
    }
    Table {
        entries,
        by_id,
        by_typed,
        bases,
        spellings,
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
/// **named** family: [`Dimension::all`], which is declared in exactly
/// that order.
///
/// Families share base dimensions — torque and energy are both
/// kg·m²·s⁻², revolutions-per-minute and hertz and becquerels all s⁻¹
/// — so a composition landing on one of those has to be told which is
/// meant. An engineer who multiplies a current by an hour means a
/// charge; one who divides an amp-hour by a second means a current; and
/// nobody composing anything means revolutions. The resolution is the
/// **first** match and the user may override it with any dimension of
/// the same exponents (owner ruling), which is what
/// [`Composed::dimensions`] serves.
fn composition_order() -> &'static [Dimension] {
    Dimension::all()
}

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
            for dimension in composition_order() {
                for entry in base_entries(*dimension).filter(|e| e.constant == 0.0) {
                    for prefix in prefixes {
                        let candidate = UnitId::new(&entry.base, *prefix);
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
    /// base dimensions read back as **the first** of this facade's own
    /// that shares them.
    #[must_use]
    pub fn dimension(&self) -> Option<Dimension> {
        self.dimensions().first().copied()
    }

    /// **Every** dimension the composition's base dimensions place it
    /// in, in composition order — the first is [`Self::dimension`] and
    /// the rest are what a user may override it with (owner ruling: the
    /// first resolution stands and the user may name any dimension of
    /// the same exponents).
    ///
    /// Empty where the analysis places it nowhere, which is a
    /// composition no picker can offer against at all.
    #[must_use]
    pub fn dimensions(&self) -> Vec<Dimension> {
        let Some(ours) = self.definition() else {
            return Vec::new();
        };
        composition_order()
            .iter()
            .copied()
            .filter(|dimension| {
                base_entries(*dimension).any(|e| UnitDefinition::from(e.unit).is_convertible(ours))
            })
            .collect()
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
        self.factors()
    }

    /// The composition spelled as its **factors**, never contracted —
    /// `A·h` where [`Self::display`] would say `Ah`.
    ///
    /// This is what an editor's unit note states (`composed: A·h`): the
    /// button already carries the name, and what the note adds is where
    /// that name came from.
    #[must_use]
    pub fn factors(&self) -> String {
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
        let (_, constant) = family(target)?;
        if constant != 0.0 {
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

/// The user's composed-unit definitions: a unit's **name**, and the
/// string it is composed from (`"VA"` → `"V * A"`).
///
/// The same shape and the same two scopes as [`Customizations`], and
/// ordered for the same reason — the settings file it persists in is a
/// hand-editable contract (ADR 0034).
pub type Definitions = BTreeMap<String, String>;

/// One unit the user composed, as the model holds it: the identity is
/// the **name** alone (`UnitId::base(name)`), and everything else was
/// settled when the composition string was read.
#[derive(Clone, Debug)]
struct Custom {
    name: String,
    dimension: Dimension,
    /// What dimensional analysis made of the composition, times its
    /// numeric factor — the one number every conversion needs.
    definition: UnitDefinition,
}

/// **The units the user composed, in force.** Written whole by
/// [`install_definitions`] and read by every lookup in this module, so a
/// composed unit behaves exactly as a tabulated one does.
///
/// A process global for the same reason the settings cache is: a unit
/// string is recognised deep inside database loading and signal serving,
/// far from any settings handle, and threading the dict to all of it
/// would put the user's units on a different footing from the shipped
/// ones.
static CUSTOM: RwLock<Vec<Custom>> = RwLock::new(Vec::new());

fn with_custom<R>(name: &str, read: impl FnOnce(&Custom) -> R) -> Option<R> {
    let guard = CUSTOM.read().unwrap_or_else(PoisonError::into_inner);
    guard.iter().find(|c| c.name == name).map(read)
}

fn custom_units() -> Vec<Custom> {
    CUSTOM
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// The composition string, read **once**: a product of terms, each
/// either a unit this project already knows or a plain number.
///
/// The grammar is the whole of what the settings entry accepts: terms
/// separated by `*` (or `·`) and `/`, whitespace ignored around them.
/// `1000 * V * A` is a kilovolt-ampere; `1 / s` is a hertz. Nothing
/// nests — a composition is a product over a product, which is what
/// [`Composed`] is and all dimensional analysis needs.
///
/// Returns the composition and the numeric factor separately, because
/// [`Composed`] is dimensional and a factor is not.
fn parse_composition(
    source: &str,
    customizations: &Customizations,
) -> Result<(Composed, f64), String> {
    if source.trim().is_empty() {
        return Err("the composition is empty — name what it is built from, like `V * A`".into());
    }
    let mut terms: Vec<(bool, String)> = Vec::new();
    let mut divide = false;
    let mut current = String::new();
    for ch in source.chars() {
        match ch {
            '*' | '·' | '/' => {
                terms.push((divide, std::mem::take(&mut current)));
                divide = ch == '/';
            }
            _ => current.push(ch),
        }
    }
    terms.push((divide, current));

    let mut composed = Composed::default();
    let mut factor = 1.0_f64;
    for (divide, term) in terms {
        let term = term.trim();
        if term.is_empty() {
            return Err(format!(
                "`{source}` has an empty term — every `*` and `/` needs a unit or a number on \
                 both sides"
            ));
        }
        if let Ok(number) = term.parse::<f64>() {
            if !number.is_finite() || (divide && number == 0.0) {
                return Err(format!("`{term}` is not a factor anything can scale by"));
            }
            if divide {
                factor /= number;
            } else {
                factor *= number;
            }
            continue;
        }
        let Some(unit) = recognize(term, customizations) else {
            return Err(format!("`{term}` is not a unit this project knows"));
        };
        composed = if divide {
            composed.over(unit)
        } else {
            composed.times(unit)
        };
    }
    Ok((composed, factor))
}

/// Read one `name = composition` pair into a unit, or say why it is not
/// one.
///
/// Every refusal names what is wrong with it, because this is the only
/// place the user finds out: past here the unit is typed, and a typed
/// unit cannot be malformed.
fn define(
    name: &str,
    composition: &str,
    customizations: &Customizations,
) -> Result<Custom, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("the unit needs a name".into());
    }
    if name.contains(['*', '/', '·']) {
        return Err(format!(
            "`{name}` cannot be a unit name — `*`, `·` and `/` are what compose one"
        ));
    }
    // Recognition, not the id table: `W` is not an id but every
    // database that writes it means the watt, so taking that name would
    // quietly change what this project reads.
    if let Some(existing) = recognize(name, customizations) {
        return Err(format!(
            "`{name}` already names {} — pick another name",
            display_of(&existing)
        ));
    }
    let (composed, factor) = parse_composition(composition, customizations)?;
    let definition = composed
        .definition()
        .ok_or_else(|| format!("`{composition}` does not compose to a unit"))?
        * UnitDefinition::new(factor, 0, 0, 0, 0, 0, 0, 0);
    let dimension = composed
        .dimension()
        .ok_or_else(|| format!("`{composition}` lands on no dimension this app names"))?;
    Ok(Custom {
        name: name.to_string(),
        dimension,
        definition,
    })
}

/// Whether this `name = composition` pair would define a unit, and why
/// it would not.
///
/// The settings entry asks before it persists, so a refusal is shown
/// where it was typed rather than becoming a broken row.
///
/// # Errors
///
/// One sentence saying what is wrong with the name or the composition.
pub fn check_definition(
    name: &str,
    composition: &str,
    customizations: &Customizations,
) -> Result<(), String> {
    define(name, composition, customizations).map(|_| ())
}

/// Where one composed unit's definition is stored, and why it is not in
/// force where it is not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinedUnit {
    pub name: String,
    pub composition: String,
    /// [`MappingSource::Project`] or [`MappingSource::User`] — never
    /// built in, since nothing here ships with the app.
    pub scope: MappingSource,
    pub error: Option<String>,
}

/// **Install the user's composed units**, replacing whatever was in
/// force, and report what each definition did.
///
/// The two scopes merge exactly as [`merge_customizations`] does, so a
/// project's definition of a name wins over the user's. Definitions may
/// build on one another (`Wh = VA * h` after `VA = V * A`) whatever
/// order the dict happens to be in, so this runs to a fixpoint: each
/// pass installs whatever now resolves, and stops when a pass adds
/// nothing. Whatever is left over is reported with the reason it did not
/// resolve.
#[must_use]
pub fn install_definitions(
    user: &Definitions,
    project: &Definitions,
    customizations: &Customizations,
) -> Vec<DefinedUnit> {
    let merged = merge_customizations(user, project);
    let mut installed: Vec<Custom> = Vec::new();
    loop {
        CUSTOM
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .clone_from(&installed);
        let before = installed.len();
        for (name, composition) in &merged {
            if installed.iter().any(|c| c.name == name.trim()) {
                continue;
            }
            if let Ok(custom) = define(name, composition, customizations) {
                installed.push(custom);
            }
        }
        if installed.len() == before {
            break;
        }
    }
    merged
        .iter()
        .map(|(name, composition)| DefinedUnit {
            error: if installed.iter().any(|c| c.name == name.trim()) {
                None
            } else {
                define(name, composition, customizations).err()
            },
            scope: if project.contains_key(name) {
                MappingSource::Project
            } else {
                MappingSource::User
            },
            name: name.clone(),
            composition: composition.clone(),
        })
        .collect()
}

/// The dimension a unit measures and the constant that makes it an
/// absolute reading, from the table or from the user's own units.
///
/// One lookup rather than two because the pair is what a conversion
/// needs, and because it is the one place a composed unit has to be
/// treated as a peer of a tabulated one.
fn family(unit: &UnitId) -> Option<(Dimension, f64)> {
    if let Some(entry) = find(&unit.base) {
        return Some((entry.dimension, entry.constant));
    }
    // A composed unit is its own base and takes no prefix: the user
    // named the whole thing.
    with_custom(&unit.base, |c| (c.dimension, 0.0))
}

/// **Where a unit falls in every list this facade serves** — the
/// picker's base column, the settings view's units table, the flat
/// source-unit list.
///
/// [`UNITS`] runs in composition order and a reader cannot predict
/// where a unit sits in it, so no surface inherits that order: they are
/// all sorted by this one rule, and a unit is looked for in the same
/// place wherever it is offered. Dimension label alphabetically, then
/// the **base** unit's display, then up the prefix ladder — so `mV`
/// sits under `V` on the voltage rung rather than in a tail of prefixed
/// rows after every base.
fn list_order(unit: &UnitId) -> (&'static str, String, i32) {
    (
        dimension_of(unit).map_or("", Dimension::label),
        find(&unit.base).map_or_else(
            || unit.base.to_lowercase(),
            |base| base.display.to_lowercase(),
        ),
        unit.prefix.exponent(),
    )
}

/// Everything selectable — the shipped table and the user's own
/// compositions — each with the identity [`list_order`] sorts on.
///
/// The two are one list from here on: a unit someone composed is offered
/// wherever a tabulated one is, in the same place its dimension puts it.
fn ordered_rows<T>(
    of_entry: impl Fn(&'static Entry) -> T,
    of_custom: impl Fn(&Custom) -> T,
) -> Vec<T> {
    let mut rows: Vec<(UnitId, T)> = UNITS
        .iter()
        .map(|e| (UnitId::new(&e.base, e.prefix), of_entry(e)))
        .chain(
            custom_units()
                .iter()
                .map(|c| (UnitId::base(&c.name), of_custom(c))),
        )
        .collect();
    rows.sort_by_cached_key(|(unit, _)| list_order(unit));
    rows.into_iter().map(|(_, row)| row).collect()
}

/// Every selectable unit, in list order.
#[must_use]
pub fn all() -> Vec<UnitInfo> {
    ordered_rows(Entry::info, Custom::info)
}

/// Every selectable unit as a picker offers it — the module's `Listing
/// the units for a picker` section is the contract.
#[tauri::command]
#[must_use]
pub fn list_units() -> Vec<UnitListing> {
    ordered_rows(Entry::listing, Custom::listing)
}

/// One row of the **base × prefix picker**: a base unit, and the scale
/// choices its second column offers.
///
/// A unit's identity is base × prefix, so the picker is two columns and
/// this is the first. The crate's enumerated prefixed variants are
/// *scales* here, not rows — a `millivolt` row beside a `volt` row is
/// the flat list this replaces.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitPickerEntry {
    /// The base unit's stable id.
    pub id: String,
    /// How the base reads unscaled.
    pub display: String,
    pub dimension: Dimension,
    /// [`Dimension::label`] — the group heading.
    pub dimension_label: &'static str,
    /// The second column, in the order it renders: the whole SI ladder
    /// for a prefixable base, every scale the library carries for
    /// `ratio`, and the base alone for anything that takes neither.
    /// Never empty, so a pick is always a whole unit.
    pub scales: Vec<UnitScale>,
}

/// One choice in the picker's second column.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitScale {
    /// What picking this commits.
    pub unit: UnitId,
    /// What the column shows — a prefix symbol, or a ratio scale's own
    /// spelling.
    pub label: String,
    /// How the composed unit reads — `mV`, `nAh`, `%`. Spelled here so
    /// a picker never composes a unit string of its own.
    pub display: String,
    /// The power of ten this scale carries, for the `×10ⁿ` its row
    /// shows. `None` for a scale that is not one — a base that takes no
    /// prefix.
    pub exponent: Option<i32>,
}

/// The ratio family as the picker offers it: **one row whose second
/// column is every ratio unit the library carries**, largest scale
/// first (owner ruling — a proportion takes a scale choice, not an SI
/// ladder, and the scale column is not curated either).
///
/// Largest first is what makes the list readable and what makes the
/// row's identity the bare 0–1 ratio rather than whichever unit the
/// library happens to declare first.
fn ratio_scales() -> Vec<&'static Entry> {
    let mut scales: Vec<&'static Entry> = base_entries(Dimension::Ratio).collect();
    scales.sort_by(|a, b| {
        UnitDefinition::from(b.unit)
            .multiplier()
            .total_cmp(&UnitDefinition::from(a.unit).multiplier())
            .then_with(|| a.id.cmp(&b.id))
    });
    scales
}

/// The base × prefix picker's whole model.
///
/// Everything a picker needs and must not derive: which bases exist, how
/// they group, what scales each takes, and how each `(base, scale)` pair
/// is **spelled** — `nAh` is composed here, never in a view.
#[tauri::command]
#[must_use]
pub fn list_unit_picker() -> Vec<UnitPickerEntry> {
    let mut out = Vec::new();
    let ratios = ratio_scales();
    for entry in UNITS.iter().filter(|e| e.is_base()) {
        if entry.dimension == Dimension::Ratio {
            // One row for the whole family, minted at the largest scale.
            if Some(&entry.id) != ratios.first().map(|e| &e.id) {
                continue;
            }
            out.push(UnitPickerEntry {
                id: entry.id.clone(),
                display: entry.display.clone(),
                dimension: entry.dimension,
                dimension_label: entry.dimension.label(),
                scales: ratios
                    .iter()
                    .map(|scale| scale_of(UnitId::base(&scale.id), scale.display.clone(), None))
                    .collect(),
            });
            continue;
        }
        let scales = if entry.prefixable {
            PREFIXES
                .iter()
                .map(|p| {
                    scale_of(
                        UnitId::new(&entry.base, *p),
                        p.symbol().to_string(),
                        Some(p.exponent()),
                    )
                })
                .collect()
        } else {
            vec![scale_of(UnitId::base(&entry.base), String::new(), None)]
        };
        out.push(UnitPickerEntry {
            id: entry.id.clone(),
            display: entry.display.clone(),
            dimension: entry.dimension,
            dimension_label: entry.dimension.label(),
            scales,
        });
    }
    // A unit the user composed is one row with one scale: they named the
    // whole thing, so there is no ladder under it.
    for custom in custom_units() {
        let unit = UnitId::base(&custom.name);
        out.push(UnitPickerEntry {
            id: custom.name.clone(),
            display: custom.name.clone(),
            dimension: custom.dimension,
            dimension_label: custom.dimension.label(),
            scales: vec![UnitScale {
                display: custom.name.clone(),
                exponent: None,
                label: String::new(),
                unit,
            }],
        });
    }
    out.sort_by_cached_key(|entry| list_order(&UnitId::base(&entry.id)));
    out
}

/// One scale row: the unit, how it reads, and its power of ten where it
/// is one rung of the SI ladder.
fn scale_of(unit: UnitId, label: String, exponent: Option<i32>) -> UnitScale {
    UnitScale {
        display: display_of(&unit),
        exponent,
        label,
        unit,
    }
}

/// One series' declared unit string, and the display unit a view has
/// chosen for it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayUnitQuery {
    /// **The unit the series is read in**, where the model already
    /// placed one — a reinterpretation, a math definition's target, or
    /// what recognition made of a database's own string. Handed over
    /// rather than recovered from [`Self::declared`]: a series read as a
    /// coulomb spells `C`, which recognition refuses on purpose, so a
    /// query that carried only the spelling could not convert it.
    #[serde(default)]
    pub source: Option<UnitId>,
    /// How the series reads today — a DBC's free text, or a math
    /// signal's resolved label. The label a view falls back to, and the
    /// **ingest** reading for a caller that has no placed unit to give.
    pub declared: String,
    /// The unit the view wants it read in, where the user chose one.
    #[serde(default)]
    pub chosen: Option<UnitId>,
}

/// How one series reads and converts for display.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayUnit {
    /// The unit the declared string places, typed — what a picker opens
    /// on when nothing has been chosen. `None` where nothing places it,
    /// which is also why no conversion is possible.
    pub source: Option<UnitId>,
    /// The dimension a **kind-locked** picker offers against. Converting
    /// a display unit is a real conversion, so only like-kind units are
    /// on offer; `None` disables the affordance entirely.
    pub kind: Option<Dimension>,
    /// How the series reads after the choice — the declared string
    /// verbatim where nothing was chosen or nothing places it, and the
    /// chosen unit's spelling otherwise.
    pub display: String,
    /// The affine carrying a value in the declared unit to one in the
    /// display unit. [`Affine::IDENTITY`] where nothing was chosen, and
    /// **also** where the choice cannot be reached — a view must not
    /// rescale by a factor nothing computed.
    pub affine: Affine,
}

/// [`DisplayUnit`] for each query, index-parallel.
///
/// The whole per-series unit question in one answer: a plot asks it once
/// per series set and re-derives none of it (ADR 0025 — recognition, the
/// kind and the factor are all the model's).
#[must_use]
pub fn display_units(
    queries: &[DisplayUnitQuery],
    customizations: &Customizations,
) -> Vec<DisplayUnit> {
    queries
        .iter()
        .map(|q| {
            // The caller's placed unit wins outright; recognition is the
            // fallback for a query that carries only a string, which is
            // ingest and the one place a spelling becomes a unit.
            let source = q
                .source
                .clone()
                .or_else(|| recognize(&q.declared, customizations));
            let kind = source.as_ref().and_then(dimension_of);
            let conversion = match (&source, &q.chosen) {
                (Some(from), Some(to)) => convert_units(from, to).map(|a| (a, to.clone())),
                _ => None,
            };
            match conversion {
                Some((affine, to)) => DisplayUnit {
                    display: display_of(&to),
                    source,
                    kind,
                    affine,
                },
                None => DisplayUnit {
                    display: q.declared.clone(),
                    source,
                    kind,
                    affine: Affine::IDENTITY,
                },
            }
        })
        .collect()
}

/// Where one unit-string mapping comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MappingSource {
    /// A recognition this module ships — not stored anywhere, and not
    /// removable.
    BuiltIn,
    /// The project's customization dict (workspace scope).
    Project,
    /// The person's own dict, in force in every project they open.
    User,
}

/// One DBC unit string that reads as a unit, and where that reading
/// comes from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitMapping {
    pub spelling: String,
    pub source: MappingSource,
}

/// One row of the settings view's units table: a unit, and every string
/// this project reads as it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitMappingRow {
    pub unit: UnitId,
    /// The **stored id** a customization writes to name this unit — what
    /// the row's add path commits. `None` for a unit the table
    /// enumerates no id for, which cannot be a mapping target; such a
    /// row is listed but takes no new spelling.
    pub id: Option<String>,
    /// How the unit reads — the row's heading.
    pub display: String,
    /// [`Dimension::label`].
    pub dimension_label: &'static str,
    /// The strings that reach this unit, in spelling order whatever
    /// scope each comes from — the chip says which, and grouping by
    /// source as well would make one string hard to find in a row that
    /// carries several.
    pub mappings: Vec<UnitMapping>,
    /// The string this unit was **composed** from, where the user
    /// defined it rather than the app shipping it — shown back
    /// verbatim, never re-read.
    pub composition: Option<String>,
    /// Which scope holds that definition, so the row's checkboxes can
    /// move it and its delete can remove it from the right dict.
    pub definition_scope: Option<MappingSource>,
    /// Why a definition is not in force. A row carrying one names no
    /// working unit — it is here so the entry that failed can be seen
    /// and fixed rather than silently doing nothing.
    pub error: Option<String>,
}

/// The settings table: **every base unit**, plus any unit a
/// customization names that the base list has no row for, each carrying
/// the strings that read as it.
///
/// Which row a string lands on is [`recognize`]'s answer and nothing
/// else, so the table cannot disagree with what the app actually does —
/// and a string both scopes map appears once, on the reading that wins
/// (the project's).
///
/// Rows come out in the picker's own order — dimension, then the base
/// unit's display, then up the prefix ladder — so a unit a customization
/// earned a row for lands beside the units it belongs with rather than
/// in a tail after every base unit.
///
/// `defined` is what [`install_definitions`] made of the user's
/// compositions. Each one gets a row: a working definition's row is the
/// unit's own, and a refused one's carries the reason instead — a
/// failed entry has to be visible somewhere or it silently does nothing,
/// and its own row is where the user will look.
#[must_use]
pub fn mappings(
    user: &Customizations,
    project: &Customizations,
    defined: &[DefinedUnit],
) -> Vec<UnitMappingRow> {
    let merged = merge_customizations(user, project);
    let mut order: Vec<UnitId> = UNITS
        .iter()
        .filter(|e| e.is_base())
        .map(|e| UnitId::base(&e.base))
        .collect();
    order.extend(defined.iter().map(|d| UnitId::base(d.name.trim())));
    let mut rows: BTreeMap<UnitId, Vec<UnitMapping>> =
        order.iter().map(|u| (u.clone(), Vec::new())).collect();
    let scoped = |spelling: &str| {
        if project.contains_key(spelling) {
            MappingSource::Project
        } else if user.contains_key(spelling) {
            MappingSource::User
        } else {
            MappingSource::BuiltIn
        }
    };
    let spellings = RECOGNITIONS
        .iter()
        .map(|(s, _)| (*s).to_string())
        .chain(user.keys().cloned())
        .chain(project.keys().cloned())
        .collect::<std::collections::BTreeSet<_>>();
    for spelling in spellings {
        let Some(unit) = recognize(&spelling, &merged) else {
            continue;
        };
        let source = scoped(&spelling);
        let row = rows.entry(unit.clone()).or_insert_with(|| {
            order.push(unit.clone());
            Vec::new()
        });
        row.push(UnitMapping { spelling, source });
    }
    order.sort_by_key(list_order);
    order.dedup();
    order
        .into_iter()
        .map(|unit| {
            let definition = defined.iter().find(|d| d.name.trim() == unit.base);
            UnitMappingRow {
                id: stored_id(&unit),
                // A refused definition names no unit, so nothing can
                // render it — it reads as the name the user typed.
                display: match definition.filter(|d| d.error.is_some()) {
                    Some(refused) => refused.name.clone(),
                    None => display_of(&unit),
                },
                dimension_label: dimension_of(&unit).map_or("", Dimension::label),
                mappings: rows.remove(&unit).unwrap_or_default(),
                composition: definition.map(|d| d.composition.clone()),
                definition_scope: definition.map(|d| d.scope),
                error: definition.and_then(|d| d.error.clone()),
                unit,
            }
        })
        .collect()
}

/// The unit with this stable id.
#[must_use]
pub fn get(id: &str) -> Option<UnitInfo> {
    find(id)
        .map(Entry::info)
        .or_else(|| with_custom(id, Custom::info))
}

fn find(id: &str) -> Option<&'static Entry> {
    UNITS.by_id.get(id).map(|index| &UNITS.entries[*index])
}

/// The row the library enumerates for this exact `(base, prefix)` pair,
/// where it has one.
fn find_typed(unit: &UnitId) -> Option<&'static Entry> {
    UNITS
        .by_typed
        .get(&(unit.base.clone(), unit.prefix))
        .map(|index| &UNITS.entries[*index])
}

/// The **base** rows of one dimension — what composition walks and what
/// the picker's first column lists.
fn base_entries(dimension: Dimension) -> impl Iterator<Item = &'static Entry> {
    UNITS.bases[dimension.index()]
        .iter()
        .map(|index| &UNITS.entries[*index])
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
    let Some(base) = find(&unit.base).filter(|e| e.is_base()) else {
        // A unit the user composed: dimensional analysis already
        // settled its factor, and the SI ladder does not apply to a
        // name someone chose.
        return unit
            .prefix
            .is_none()
            .then(|| with_custom(&unit.base, |c| c.definition))
            .flatten();
    };
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
///
/// A unit the user composed is named by itself, so its own name is its
/// stored id too.
#[must_use]
pub fn typed(id: &str) -> Option<UnitId> {
    find(id)
        .map(|e| UnitId::new(&e.base, e.prefix))
        .or_else(|| with_custom(id, |c| UnitId::base(&c.name)))
}

/// The stored id for a typed unit, where the table enumerates the pair
/// or the user named it.
///
/// `None` for a composition the crate has no variant of (`nAh`), which
/// is exactly why the model carries the typed form and not this string.
#[must_use]
pub fn stored_id(unit: &UnitId) -> Option<String> {
    if let Some(entry) = find_typed(unit) {
        return Some(entry.id.clone());
    }
    unit.prefix
        .is_none()
        .then(|| with_custom(&unit.base, |c| c.name.clone()))
        .flatten()
}

/// How a typed unit reads: the enumerated variant's own spelling where
/// there is one, and the prefix symbol on the base unit's otherwise —
/// `mV`, and `nAh`.
#[must_use]
pub fn display_of(unit: &UnitId) -> String {
    if let Some(enumerated) = find_typed(unit) {
        return enumerated.display.clone();
    }
    if let Some(base) = find(&unit.base) {
        return format!("{}{}", unit.prefix.symbol(), base.display);
    }
    // A composed unit reads as the name the user gave it, and nothing
    // else — the composition is how it was defined, not how it reads.
    unit.prefix
        .is_none()
        .then(|| with_custom(&unit.base, |c| c.name.clone()))
        .flatten()
        .unwrap_or_default()
}

/// The family a typed unit belongs to — what a kind-locked picker
/// offers against.
#[must_use]
pub fn dimension_of(unit: &UnitId) -> Option<Dimension> {
    family(unit).map(|(dimension, _)| dimension)
}

/// The affine carrying a value in `from` to one in `to`, or `None` when
/// either names nothing or the two measure different things.
#[must_use]
pub fn convert_units(from: &UnitId, to: &UnitId) -> Option<Affine> {
    let ((from_dimension, from_constant), (to_dimension, to_constant)) =
        (family(from)?, family(to)?);
    if from_dimension != to_dimension {
        return None;
    }
    if from == to {
        return Some(Affine::IDENTITY);
    }
    let (a, b) = (definition_of(from)?, definition_of(to)?);
    let a = Affine::new(a.multiplier(), from_constant * a.multiplier());
    let b = Affine::new(b.multiplier(), to_constant * b.multiplier());
    Some(Affine::new(a.gain / b.gain, (a.offset - b.offset) / b.gain))
}

impl Entry {
    fn info(&self) -> UnitInfo {
        UnitInfo {
            id: self.id.clone(),
            display: self.display.clone(),
            dimension: self.dimension,
        }
    }

    fn listing(&self) -> UnitListing {
        UnitListing {
            info: self.info(),
            dimension_label: self.dimension.label(),
            spelling: if recognize(&self.display, &Customizations::new()) == typed(&self.id) {
                self.display.clone()
            } else {
                self.id.clone()
            },
        }
    }
}

impl Custom {
    fn info(&self) -> UnitInfo {
        UnitInfo {
            id: self.name.clone(),
            display: self.name.clone(),
            dimension: self.dimension,
        }
    }

    /// A composed unit's name is its id, its display **and** the string
    /// that reads back to it, so all three are the same word.
    fn listing(&self) -> UnitListing {
        UnitListing {
            info: self.info(),
            dimension_label: self.dimension.label(),
            spelling: self.name.clone(),
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

/// Spellings the **library** resolves that this module will not.
///
/// `C` is the library's symbol for the coulomb and is unambiguous inside
/// it, because it spells Celsius `°C`. A database is not so careful: a
/// DBC that writes `C` means Celsius about as often as charge, and a
/// wrong conversion is worse than no conversion (owner ruling: unknown
/// means nothing, never a guess). The user's customization dict is where
/// a project says which it means.
static REFUSED: &[&str] = &["C"];

/// The unit a DBC's free-text unit string names, or `None`.
///
/// The user's `customizations` win — that is the point of them — and are
/// consulted on the raw string and on its trimmed form, since a DBC
/// commonly carries padding the user did not type. Then the built-in
/// recognitions exactly, then a unit's **own id** exactly, then every
/// spelling the library gives a unit — its symbol, singular and plural
/// — where exactly one unit spells itself that way, then
/// `[prefix][base]` exact-case (`nAh`), then the built-in recognitions
/// case-insensitively where exactly one of them matches.
///
/// The library pass is what makes the whole table reachable from a
/// database (`L`, `lbf/in²`, `liters per minute`) without anyone
/// tabulating two thousand spellings here. It is **unique or nothing**:
/// `kg/m³` is a mass density and a mass concentration, and neither is
/// the answer. The passes ahead of it are what keep a spelling meaning
/// what it always meant — `K` is the absolute kelvin rather than the
/// interval, `h` an hour rather than the Planck constant.
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
    if !REFUSED.contains(&trimmed) {
        if let Some(unit) = UNITS.spellings.get(trimmed) {
            return unit.clone();
        }
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
///
/// Unique or nothing, like every other pass: two dimensions carry a
/// `g/m³`, so `kg/m³` composes onto both and neither is the answer.
fn prefixed_spelling(spelling: &str) -> Option<UnitId> {
    let mut hit: Option<UnitId> = None;
    for entry in UNITS.iter().filter(|e| e.is_base() && e.prefixable) {
        for prefix in PREFIXES.iter().filter(|p| !p.is_none()) {
            for symbol in prefix_symbols(*prefix) {
                if spelling.len() <= entry.display.len()
                    || spelling.strip_prefix(symbol) != Some(entry.display.as_str())
                {
                    continue;
                }
                let composed = UnitId::new(&entry.base, *prefix);
                match &hit {
                    Some(other) if *other != composed => return None,
                    _ => hit = Some(composed),
                }
            }
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

    fn picker_entry(id: &str) -> UnitPickerEntry {
        list_unit_picker()
            .into_iter()
            .find(|e| e.id == id)
            .unwrap_or_else(|| panic!("no picker entry `{id}`"))
    }

    /// The picker's first column is **base units**, never the crate's
    /// enumerated prefixed variants: a row for `millivolt` beside one
    /// for `volt` is the flat list this replaces.
    #[test]
    fn the_picker_lists_base_units_and_never_a_prefixed_variant() {
        let _shared = listing();
        let entries = list_unit_picker();
        assert!(entries.iter().any(|e| e.id == "volt"));
        assert!(
            !entries.iter().any(|e| e.id == "millivolt"),
            "a prefixed variant is a scale of its base, not a row of its own"
        );
    }

    /// Whether `labels` runs through its dimension groups
    /// alphabetically, each group contiguous.
    fn grouped_alphabetically(labels: &[&str]) -> bool {
        let mut sorted = labels.to_vec();
        sorted.sort_unstable();
        labels == sorted.as_slice()
    }

    /// **One order for every unit list.** The table this file declares is
    /// grouped by hand and a reader cannot predict where a unit sits in
    /// it, so every list surface is sorted before it leaves: dimension
    /// label alphabetically, then the base unit's display, then up the
    /// prefix ladder.
    #[test]
    fn every_unit_list_runs_in_dimension_then_display_order() {
        let _shared = listing();
        let picker = list_unit_picker();
        let labels: Vec<&str> = picker.iter().map(|e| e.dimension_label).collect();
        assert!(grouped_alphabetically(&labels), "{labels:?}");

        // Inside a group, by the base unit's display, case-folded —
        // asserted as the rule rather than as a list, because the list
        // is every unit the library carries.
        let shown = |dimension: &str| -> Vec<String> {
            picker
                .iter()
                .filter(|e| e.dimension_label == dimension)
                .map(|e| e.display.to_lowercase())
                .collect()
        };
        for dimension in ["charge", "time", "pressure", "volume"] {
            let displays = shown(dimension);
            assert!(!displays.is_empty(), "{dimension} lists nothing");
            assert!(
                displays.windows(2).all(|w| w[0] <= w[1]),
                "{dimension}: {displays:?}"
            );
        }
        // The units that were hand-typed before the table came from the
        // library are still where they were.
        assert!(shown("charge").contains(&"ah".to_string()));
        assert!(shown("pressure").contains(&"bar".to_string()));
        assert!(shown("volume").contains(&"l".to_string()), "litres");

        // The flat list the source-unit combobox reads groups the same
        // way — it is the same table, so it cannot answer differently.
        let flat: Vec<&str> = list_units().iter().map(|u| u.dimension_label).collect();
        assert!(grouped_alphabetically(&flat), "{flat:?}");
    }

    /// The settings table orders by the same rule, which puts a prefixed
    /// row on its base unit's ladder instead of in a tail after every
    /// base row.
    #[test]
    fn the_mapping_table_puts_a_prefixed_row_on_its_bases_ladder() {
        let _shared = listing();
        let rows = mappings(&none(), &none(), &[]);
        let labels: Vec<&str> = rows.iter().map(|r| r.dimension_label).collect();
        assert!(grouped_alphabetically(&labels), "{labels:?}");

        // A prefixed row sits on its base's rung, in exponent order,
        // rather than in a tail after every base — asserted over the
        // rows the table actually has, which is every base unit plus
        // whatever a recognition earned a row.
        let ladder = |base: &str| -> Vec<i32> {
            rows.iter()
                .filter(|r| r.unit.base == base)
                .map(|r| r.unit.prefix.exponent())
                .collect()
        };
        for base in ["volt", "meter", "ampere-hour"] {
            let rungs = ladder(base);
            assert!(!rungs.is_empty(), "no rows for {base}");
            assert!(rungs.windows(2).all(|w| w[0] < w[1]), "{base}: {rungs:?}");
        }
        let voltage: Vec<&str> = rows
            .iter()
            .filter(|r| r.dimension_label == "voltage")
            .map(|r| r.display.as_str())
            .collect();
        assert!(
            voltage.contains(&"mV") && voltage.contains(&"V"),
            "{voltage:?}"
        );
    }

    /// The second column is the whole SI ladder, exponent-ordered, each
    /// row carrying its power of ten and the composed spelling — which
    /// is what the picker renders and must not compose itself.
    #[test]
    fn a_prefixable_base_offers_the_whole_exponent_ordered_ladder() {
        let _shared = listing();
        let volt = picker_entry("volt");
        assert_eq!(volt.scales.len(), Prefix::all().len());
        let exponents: Vec<Option<i32>> = volt.scales.iter().map(|s| s.exponent).collect();
        assert_eq!(exponents.first().copied().flatten(), Some(-24));
        assert_eq!(exponents.last().copied().flatten(), Some(24));
        assert!(exponents.windows(2).all(|w| w[0] < w[1]));
        let milli = volt
            .scales
            .iter()
            .find(|s| s.unit.prefix == Prefix::Milli)
            .expect("milli");
        assert_eq!(milli.display, "mV");
        assert_eq!(milli.label, "m");
        assert_eq!(milli.unit, UnitId::new("volt", Prefix::Milli));
    }

    /// The ratio family is **one** row taking a scale choice, and the
    /// column is every ratio unit the library carries, largest scale
    /// first (owner ruling — the scale column is not curated either).
    #[test]
    fn the_ratio_family_is_one_row_carrying_every_scale_the_library_has() {
        let _shared = listing();
        let entries = list_unit_picker();
        let ratios: Vec<&UnitPickerEntry> = entries
            .iter()
            .filter(|e| e.dimension == Dimension::Ratio)
            .collect();
        assert_eq!(ratios.len(), 1, "one row for the family");
        let scales: Vec<&str> = ratios[0]
            .scales
            .iter()
            .map(|s| s.unit.base.as_str())
            .collect();
        let carried: Vec<&str> = Dimension::Ratio
            .rows()
            .iter()
            .map(|r| r.variant.replace('_', "-"))
            .map(|id| Box::leak(id.into_boxed_str()) as &str)
            .collect();
        for id in &carried {
            assert!(scales.contains(id), "{id} is not offered: {scales:?}");
        }
        assert_eq!(scales.len(), carried.len());
        // Largest scale first, and the row is minted at it.
        assert_eq!(scales.first(), Some(&"ratio"));
        assert_eq!(ratios[0].id, "ratio");
        let factors: Vec<f64> = ratios[0]
            .scales
            .iter()
            .map(|s| definition_of(&s.unit).expect("a scale").multiplier())
            .collect();
        assert!(factors.windows(2).all(|w| w[0] >= w[1]), "{factors:?}");
        // The label is the scale's own spelling, so a view composes
        // nothing.
        let percent = ratios[0]
            .scales
            .iter()
            .find(|s| s.unit.base == "percent")
            .expect("percent");
        assert_eq!(percent.label, "%");
        assert_eq!(percent.exponent, None, "a scale is not a power of ten");
    }

    /// A base that takes no ladder still offers exactly one choice, so
    /// the picker's second column is never empty and a pick is always a
    /// whole unit.
    #[test]
    fn a_base_that_takes_no_prefix_offers_itself_alone() {
        let _shared = listing();
        let celsius = picker_entry("degree-celsius");
        assert_eq!(celsius.scales.len(), 1);
        assert_eq!(celsius.scales[0].unit, UnitId::base("degree-celsius"));
        assert_eq!(celsius.scales[0].display, "°C");
        assert_eq!(celsius.scales[0].exponent, None);
    }

    /// Every scale the picker offers is a unit the facade places, so a
    /// pick can always be converted, spelled and stored.
    #[test]
    fn every_offered_scale_is_a_unit_the_facade_places() {
        let _shared = listing();
        for entry in list_unit_picker() {
            for scale in &entry.scales {
                assert!(
                    dimension_of(&scale.unit).is_some(),
                    "{:?} places nothing",
                    scale.unit
                );
                assert_eq!(scale.display, display_of(&scale.unit));
            }
        }
    }

    fn placed_queries(rows: &[(Option<UnitId>, &str, Option<UnitId>)]) -> Vec<DisplayUnitQuery> {
        rows.iter()
            .map(|(source, declared, chosen)| DisplayUnitQuery {
                source: source.clone(),
                declared: (*declared).to_string(),
                chosen: chosen.clone(),
            })
            .collect()
    }

    fn queries(pairs: &[(&str, Option<UnitId>)]) -> Vec<DisplayUnitQuery> {
        pairs
            .iter()
            .map(|(declared, chosen)| DisplayUnitQuery {
                source: None,
                declared: (*declared).to_string(),
                chosen: chosen.clone(),
            })
            .collect()
    }

    /// The plot's display-unit chip asks one question per series: what
    /// does the declared string mean, what family does a kind-locked
    /// picker offer, how does it read, and by what factor.
    #[test]
    fn a_display_unit_answers_the_whole_per_series_question() {
        let _shared = listing();
        let asked = queries(&[
            ("mV", None),
            ("mV", Some(UnitId::base("volt"))),
            ("widgets", Some(UnitId::base("volt"))),
        ]);
        let answers = display_units(&asked, &none());

        // Nothing chosen: the string reads as it stands and nothing
        // scales, but the picker still knows where to open and what to
        // offer.
        assert_eq!(answers[0].display, "mV");
        assert_eq!(answers[0].source, Some(UnitId::new("volt", Prefix::Milli)));
        assert_eq!(answers[0].kind, Some(Dimension::Voltage));
        assert_eq!(answers[0].affine, Affine::IDENTITY);

        // Chosen: a real conversion — an mV series joins the V lane at
        // ÷1000.
        assert_eq!(answers[1].display, "V");
        close(answers[1].affine.gain, 0.001);

        // A string nothing places converts by nothing: a view must not
        // rescale by a factor nobody computed.
        assert_eq!(answers[2].display, "widgets");
        assert_eq!(answers[2].source, None);
        assert_eq!(answers[2].kind, None);
        assert_eq!(answers[2].affine, Affine::IDENTITY);
    }

    /// **A unit the model already placed is used, not re-read.** A
    /// series reinterpreted as a coulomb spells `C`, which recognition
    /// refuses on purpose (it would be a guess against Celsius) — so
    /// the query carries the unit, and the chip converts and offers the
    /// charge family exactly as it would for any other unit.
    #[test]
    fn a_placed_source_unit_converts_whatever_its_spelling_reads_as() {
        let _shared = listing();
        let asked = placed_queries(&[
            (Some(UnitId::base("coulomb")), "C", None),
            (
                Some(UnitId::base("coulomb")),
                "C",
                Some(UnitId::new("coulomb", Prefix::Milli)),
            ),
            (
                Some(UnitId::new("newton-meter", Prefix::Milli)),
                "Nmm",
                Some(UnitId::base("newton-meter")),
            ),
        ]);
        assert_eq!(recognize("C", &none()), None, "by design");
        let answers = display_units(&asked, &none());

        assert_eq!(answers[0].display, "C", "it still reads as C");
        assert_eq!(answers[0].source, Some(UnitId::base("coulomb")));
        assert_eq!(answers[0].kind, Some(Dimension::Charge));

        assert_eq!(answers[1].display, "mC");
        close(answers[1].affine.gain, 1000.0);

        assert_eq!(answers[2].display, "Nm");
        close(answers[2].affine.gain, 0.001);
    }

    /// A choice of the wrong kind is refused the same way — the picker
    /// is kind-locked, so this is a hand-edited project file rather than
    /// something the UI can produce, and it must not scale.
    #[test]
    fn a_display_unit_of_another_kind_scales_nothing() {
        let _shared = listing();
        let answers = display_units(&queries(&[("V", Some(UnitId::base("ampere")))]), &none());
        assert_eq!(answers[0].display, "V");
        assert_eq!(answers[0].affine, Affine::IDENTITY);
    }

    /// The settings table's rows: every base unit, and every string that
    /// reads as one — the built-ins and the two customization scopes,
    /// each labelled with where it comes from.
    #[test]
    fn the_mapping_table_puts_each_string_on_the_row_it_recognises_to() {
        let _shared = listing();
        let rows = mappings(&none(), &none(), &[]);
        assert!(rows.iter().any(|r| r.unit == UnitId::base("volt")));
        let celsius = rows
            .iter()
            .find(|r| r.unit == UnitId::base("degree-celsius"))
            .expect("celsius row");
        let spellings: Vec<&str> = celsius
            .mappings
            .iter()
            .map(|m| m.spelling.as_str())
            .collect();
        assert!(spellings.contains(&"degC"), "{spellings:?}");
        assert!(celsius
            .mappings
            .iter()
            .all(|m| m.source == MappingSource::BuiltIn));
        // The id the row's add path commits — a customization names a
        // unit by id, never by spelling.
        assert_eq!(celsius.id.as_deref(), Some("degree-celsius"));
        assert!(
            rows.iter().all(|r| r.id.is_some()),
            "every listed row is a mapping target"
        );
    }

    /// A customization joins the row its unit names, wearing the scope
    /// it is stored at — and **the project wins**, so a string both
    /// scopes map is listed once, as the project's.
    #[test]
    fn a_customization_joins_its_units_row_wearing_its_scope() {
        let _shared = listing();
        let user: Customizations = [
            ("widgets".to_string(), "volt".to_string()),
            ("Deg C".to_string(), "kelvin".to_string()),
        ]
        .into_iter()
        .collect();
        let project: Customizations = [("Deg C".to_string(), "degree-celsius".to_string())]
            .into_iter()
            .collect();
        let rows = mappings(&user, &project, &[]);
        let find = |unit: UnitId| {
            rows.iter()
                .find(|r| r.unit == unit)
                .unwrap_or_else(|| panic!("no row for {unit:?}"))
                .mappings
                .iter()
                .map(|m| (m.spelling.as_str(), m.source))
                .collect::<Vec<_>>()
        };
        let volt = find(UnitId::base("volt"));
        assert!(volt.contains(&("widgets", MappingSource::User)), "{volt:?}");
        assert!(!volt.contains(&("widgets", MappingSource::Project)));
        let celsius = find(UnitId::base("degree-celsius"));
        assert!(
            celsius.contains(&("Deg C", MappingSource::Project)),
            "{celsius:?}"
        );
        let kelvin = find(UnitId::base("kelvin"));
        assert!(
            !kelvin.iter().any(|(s, _)| *s == "Deg C"),
            "the project's reading wins outright: {kelvin:?}"
        );
    }

    /// A **prefixed** unit is not a base, so the table has no row for it
    /// until something maps a string to it — then it earns one, and the
    /// string is never invisible. (`mA` is such a row already: a
    /// built-in recognition reaches a unit the base list does not
    /// list.)
    #[test]
    fn a_customization_naming_a_prefixed_unit_earns_its_own_row() {
        let _shared = listing();
        let milliampere = UnitId::new("ampere", Prefix::Milli);
        assert!(
            !list_unit_picker().iter().any(|e| e.id == "milliampere"),
            "the base list carries no prefixed row"
        );
        let project: Customizations = [("mAmp".to_string(), "milliampere".to_string())]
            .into_iter()
            .collect();
        let rows = mappings(&none(), &project, &[]);
        let row = rows
            .iter()
            .find(|r| r.unit == milliampere)
            .expect("a row for the milliampere");
        assert_eq!(row.display, "mA");
        assert_eq!(row.dimension_label, "current");
        assert!(row
            .mappings
            .iter()
            .any(|m| m.spelling == "mAmp" && m.source == MappingSource::Project));
        assert!(
            row.mappings
                .iter()
                .any(|m| m.spelling == "mA" && m.source == MappingSource::BuiltIn),
            "the built-in that reaches the same unit shares the row: {:?}",
            row.mappings
        );
    }

    #[test]
    fn every_unit_has_a_unique_id_and_is_findable_by_it() {
        let _shared = listing();
        let mut ids: Vec<&str> = UNITS.iter().map(|e| e.id.as_str()).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate unit id");
        for entry in UNITS.iter() {
            let info = get(&entry.id).unwrap_or_else(|| panic!("{}", entry.id));
            assert_eq!(info.display, entry.display);
        }
        assert_eq!(all().len(), count);
        assert_eq!(UNITS.len(), count);
        assert!(get("no-such-unit").is_none());
    }

    /// The facade's grouping has to be at least as strict as the
    /// library's: two units in one dimension must actually be one
    /// convertible family, or composing their multipliers would be
    /// nonsense. (The converse does not hold, and is the point of the
    /// grouping — the library calls `rpm` and `Hz` convertible.)
    #[test]
    fn every_dimension_is_one_convertible_family() {
        let _shared = listing();
        for a in UNITS.iter() {
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
        let _shared = listing();
        let a = convert("milliampere", "ampere").expect("mA to A");
        close(a.gain, 0.001);
        close(a.offset, 0.0);
        close(a.apply(1500.0), 1.5);
        let back = convert("ampere", "milliampere").expect("A to mA");
        close(back.apply(1.5), 1500.0);
    }

    #[test]
    fn the_same_unit_both_sides_is_the_identity_exactly() {
        let _shared = listing();
        let a = convert("volt", "volt").expect("V to V");
        assert!(a.is_identity(), "{a:?}");
    }

    #[test]
    fn units_of_different_dimensions_do_not_convert() {
        let _shared = listing();
        assert!(convert("volt", "ampere").is_none());
        // The library would happily convert these two — both s⁻¹, and
        // both kg·m²·s⁻² — which is exactly what the facade's own
        // grouping exists to refuse.
        assert!(convert("revolution-per-minute", "hertz").is_none());
        assert!(convert("newton-meter", "joule").is_none());
    }

    #[test]
    fn an_unknown_unit_id_does_not_convert() {
        let _shared = listing();
        assert!(convert("volt", "furlong").is_none());
        assert!(convert("furlong", "volt").is_none());
    }

    #[test]
    fn temperature_converts_affinely_across_celsius_kelvin_and_fahrenheit() {
        let _shared = listing();
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
        let _shared = listing();
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
        let _shared = listing();
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
        let _shared = listing();
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
        let _shared = listing();
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
        let _shared = listing();
        for id in ["ratio", "percent", "part-per-million"] {
            let display = get(id).unwrap_or_else(|| panic!("{id}")).display;
            assert_eq!(
                recognize(&display, &none()),
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
        let _shared = listing();
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
        // A product the table names outside the automotive families is
        // still named — volt-seconds are webers — because the table is
        // now every quantity the library carries.
        assert_eq!(
            Composed::of(UnitId::base("volt")).times(seconds).named(),
            Some(UnitId::base("weber"))
        );
    }

    #[test]
    fn an_integrated_unit_converts_onward_to_what_a_user_asks_for() {
        let _shared = listing();
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
        let _shared = listing();
        let a = Affine::new(2.0, 1.0);
        let b = Affine::new(10.0, -3.0);
        let composed = a.then(b);
        close(composed.apply(5.0), b.apply(a.apply(5.0)));
        assert_eq!(Affine::IDENTITY.then(a), a);
        assert_eq!(a.then(Affine::IDENTITY), a);
    }

    #[test]
    fn the_common_dbc_spellings_are_recognised() {
        let _shared = listing();
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
        let _shared = listing();
        assert_eq!(recognize("  rpm ", &none()), typed("revolution-per-minute"));
    }

    #[test]
    fn recognition_is_case_insensitive_only_where_one_spelling_matches() {
        let _shared = listing();
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
        let _shared = listing();
        for raw in ["", "   ", "C", "Nm/rad", "widgets"] {
            assert_eq!(recognize(raw, &none()), None, "{raw:?}");
        }
    }

    #[test]
    fn a_customization_wins_over_the_built_in_recognitions() {
        let _shared = listing();
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
        let _shared = listing();
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
        let _shared = listing();
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
        let _shared = listing();
        for entry in UNITS.iter() {
            assert_eq!(
                recognize(&entry.id, &none()),
                typed(&entry.id),
                "{}",
                entry.id
            );
        }
    }

    /// What a target-unit picker commits round-trips. Without this the
    /// picker would offer units whose choice converts nothing.
    #[test]
    fn every_listed_spelling_recognises_back_to_its_unit() {
        let _shared = listing();
        let listed = list_units();
        assert_eq!(listed.len(), UNITS.len());
        for listing in listed {
            assert_eq!(
                recognize(&listing.spelling, &none()),
                typed(&listing.info.id),
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
        let _shared = listing();
        let listed = list_units();
        let spelling = |id: &str| {
            listed
                .iter()
                .find(|l| l.info.id == id)
                .unwrap_or_else(|| panic!("{id}"))
                .spelling
                .as_str()
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
        let _shared = listing();
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

    /// The **library's** own answer for a spelling, inside one
    /// dimension's quantity — the comparand the composed factors are
    /// cross-checked against.
    fn enumerated(dimension: Dimension, abbreviation: &str) -> Option<UnitDefinition> {
        dimension.library_definition(abbreviation)
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
        let _shared = listing();
        let mut checked = 0usize;
        for entry in UNITS.iter().filter(|e| e.is_base() && e.prefixable) {
            for prefix in Prefix::all().iter().filter(|p| !p.is_none()) {
                let spelling = format!("{}{}", prefix.symbol(), entry.display);
                let Some(theirs) = enumerated(entry.dimension, &spelling) else {
                    continue;
                };
                // A spelling the library tabulates at a number its own
                // name contradicts is not this rung at all: 0.6.3 has a
                // `daSv` worth a tenth of a sievert, which the table
                // holds as a unit of its own (see
                // `a_library_unit_whose_number_contradicts_its_name_is_a_base_of_its_own`).
                if find_typed(&unit(&entry.base, *prefix)).is_none() {
                    continue;
                }
                // Same quantity only: `try_from` is asked within the
                // base's own enum, so a hit is always convertible.
                let ours = UnitDefinition::from(entry.unit) * prefix_definition(*prefix);
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
        // library enumerates the whole ladder for the SI base
        // quantities, so this is in the thousands.
        assert!(checked > 1000, "only {checked} pairs cross-checked");
    }

    /// The hole the composition exists for: the crate stops enumerating
    /// ampere-hours at the microampere-hour, so `nAh` has no variant to
    /// read and is composed — nano × ampere-hour — and converts.
    #[test]
    fn a_prefix_the_crate_does_not_enumerate_is_composed_and_converts() {
        let _shared = listing();
        assert!(enumerated(Dimension::Charge, "nAh").is_none());
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
        let _shared = listing();
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
        let _shared = listing();
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
        let _shared = listing();
        assert!(definition_of(&unit("degree-celsius", Prefix::Milli)).is_none());
        assert!(definition_of(&unit("percent", Prefix::Kilo)).is_none());
        assert!(definition_of(&unit("hour", Prefix::Milli)).is_none());
        assert!(definition_of(&unit("degree-celsius", Prefix::None)).is_some());
    }

    /// A legacy unit id — what every project file written before this
    /// existed carries — reads back as the typed pair it always was.
    #[test]
    fn a_stored_unit_id_reads_back_as_a_base_and_a_prefix() {
        let _shared = listing();
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
        let _shared = listing();
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
        let _shared = listing();
        // A name is used only where it spells what the factors spell:
        // volt-seconds *are* webers, and nobody reading a product of
        // volts and seconds expects `Wb`.
        let volt_second =
            Composed::of(unit("volt", Prefix::None)).times(unit("second", Prefix::None));
        assert_eq!(volt_second.named(), Some(UnitId::base("weber")));
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
        let _shared = listing();
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
        let _shared = listing();
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
        let _shared = listing();
        let scalar = recognize("counts", &none()).expect("counts");
        assert_eq!(scalar, unit("scalar", Prefix::None));
        assert_eq!(recognize("count", &none()), Some(scalar.clone()));
        assert_eq!(recognize("cnt", &none()), Some(scalar.clone()));
        assert_eq!(get("scalar").expect("scalar").dimension, Dimension::Scalar);
        // A ratio is a different kind, so nothing converts between them.
        assert!(convert("scalar", "percent").is_none());
    }

    // ---- the table is the library's -----------------------------------

    /// **Every unit the library enumerates is offered**, as a base unit
    /// of its own or as one rung of a base's ladder — enumerated from
    /// the library here, never from a list kept in this file.
    ///
    /// This is the whole no-curation policy in one assertion: a unit the
    /// library carries and this app does not offer would be a choice
    /// nobody made on purpose.
    #[test]
    fn every_unit_the_library_enumerates_is_offered_as_a_base_or_a_rung_of_one() {
        let _shared = listing();
        let picker = list_unit_picker();
        // What a pick can commit: a base row's own identity, and every
        // scale under it.
        let offered: std::collections::BTreeSet<UnitId> = picker
            .iter()
            .flat_map(|entry| entry.scales.iter().map(|s| s.unit.clone()))
            .collect();
        let mut seen = 0usize;
        for dimension in Dimension::all().iter().copied() {
            // The absolute scales are this module's reading of the
            // library's intervals, which are offered under their own
            // dimension.
            if dimension == Dimension::Temperature {
                continue;
            }
            for row in dimension.rows() {
                seen += 1;
                let id = row.variant.replace('_', "-");
                let unit = typed(&id)
                    .or_else(|| typed(&format!("{}-{id}", dimension.kebab())))
                    .unwrap_or_else(|| panic!("{} {id} is not in the table", dimension.kebab()));
                assert!(
                    offered.contains(&unit),
                    "{} {id} is in the table but not offered: {unit:?}",
                    dimension.kebab()
                );
            }
        }
        // A coverage check that covered nothing would pass silently.
        assert!(seen > 2000, "only {seen} library units enumerated");
    }

    /// The **serialized** dimension name is the variant in kebab-case,
    /// and the fifteen a project file has always carried are unchanged
    /// — a math signal written as `kind: voltage` reads back as one.
    #[test]
    fn the_dimension_a_project_file_names_reads_back_as_the_same_dimension() {
        let _shared = listing();
        let legacy = [
            ("voltage", Dimension::Voltage),
            ("current", Dimension::Current),
            ("charge", Dimension::Charge),
            ("power", Dimension::Power),
            ("energy", Dimension::Energy),
            ("torque", Dimension::Torque),
            ("angular-velocity", Dimension::AngularVelocity),
            ("pressure", Dimension::Pressure),
            ("frequency", Dimension::Frequency),
            ("ratio", Dimension::Ratio),
            ("temperature", Dimension::Temperature),
            ("speed", Dimension::Speed),
            ("time", Dimension::Time),
            ("length", Dimension::Length),
            ("scalar", Dimension::Scalar),
        ];
        for (name, dimension) in legacy {
            assert_eq!(
                serde_json::to_string(&dimension).expect("serialize"),
                format!("\"{name}\""),
                "{name}"
            );
            let read: Dimension =
                serde_json::from_str(&format!("\"{name}\"")).expect("deserialize");
            assert_eq!(read, dimension, "{name}");
        }
        // And the rule the other ninety-four follow, so the label and
        // the serialized name cannot drift from the variant.
        for dimension in Dimension::all().iter().copied() {
            assert_eq!(
                serde_json::to_string(&dimension).expect("serialize"),
                format!("\"{}\"", dimension.kebab()),
                "{dimension:?}"
            );
            assert_eq!(dimension.label(), dimension.kebab().replace('-', " "));
        }
        assert_eq!(Dimension::VolumeRate.kebab(), "volume-rate");
        assert_eq!(Dimension::VolumeRate.label(), "volume rate");
    }

    /// **The first resolution of every composition this module's tests
    /// name**, pinned.
    ///
    /// A product lands on the first dimension of [`Dimension::all`]
    /// whose base is convertible with it, and many of the library's
    /// quantities share exponents — so what a composed unit is *called*
    /// is decided by that order and nothing else. Pinning it is what
    /// makes widening the order a visible change.
    #[test]
    fn every_composition_resolves_to_the_dimension_the_order_gives_it() {
        let _shared = listing();
        let of = |unit: &str| Composed::of(UnitId::base(unit));
        let cases: Vec<(&str, Composed, Dimension)> = vec![
            (
                "A·s",
                of("ampere").times(UnitId::base("second")),
                Dimension::Charge,
            ),
            (
                "A·h",
                of("ampere").times(UnitId::base("hour")),
                Dimension::Charge,
            ),
            (
                "W·s",
                of("watt").times(UnitId::base("second")),
                Dimension::Energy,
            ),
            (
                "V·A",
                of("volt").times(UnitId::base("ampere")),
                Dimension::Power,
            ),
            (
                "Ah/s",
                of("ampere-hour").over(UnitId::base("second")),
                Dimension::Current,
            ),
            (
                "1/s",
                Composed::default().over(UnitId::base("second")),
                Dimension::Frequency,
            ),
            (
                "V·s",
                of("volt").times(UnitId::base("second")),
                Dimension::MagneticFlux,
            ),
            // `N · m` is kg·m²·s⁻², which energy and torque share; the
            // order puts energy first, so that is what a product of a
            // newton and a metre is called and torque is what the user
            // overrides it with.
            (
                "N·m",
                of("newton").times(UnitId::base("meter")),
                Dimension::Energy,
            ),
        ];
        for (spelling, composed, expected) in cases {
            assert_eq!(composed.dimension(), Some(expected), "{spelling}");
            assert_eq!(
                composed.dimensions().first().copied(),
                Some(expected),
                "{spelling}: the first of the equivalents is the resolution"
            );
        }
    }

    /// **Every dimension of the same exponents**, which is what a
    /// kind-locked picker widens to (owner ruling: the first resolution
    /// stands and the user overrides it).
    #[test]
    fn a_composition_offers_every_dimension_of_its_exponents() {
        let _shared = listing();
        let newton_meter = Composed::of(UnitId::base("newton")).times(UnitId::base("meter"));
        let equivalents = newton_meter.dimensions();
        assert!(equivalents.contains(&Dimension::Energy), "{equivalents:?}");
        assert!(equivalents.contains(&Dimension::Torque), "{equivalents:?}");
        assert_eq!(
            equivalents.first().copied(),
            newton_meter.dimension(),
            "the first equivalent is the resolution"
        );
        // In composition order, and never repeating a dimension.
        let order: Vec<usize> = equivalents.iter().map(|d| d.index()).collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{order:?}");
        // A composition the analysis places nowhere offers nothing.
        assert!(Composed::of(UnitId::base("furlong"))
            .dimensions()
            .is_empty());
    }

    /// Where the library's own name and number disagree, the unit is a
    /// base of its own rather than a rung of a ladder it does not sit
    /// on.
    ///
    /// `runtime_units` 0.6.3 tabulates every sievert above the sievert
    /// with an extra ×10⁻², so its `decasievert` is a *tenth* of a
    /// sievert and collides with its `decisievert`. The classification
    /// rule refuses it — the name says deca and the number does not —
    /// so it is offered under its own name and the ladder is composed
    /// from the sievert instead.
    #[test]
    fn a_library_unit_whose_number_contradicts_its_name_is_a_base_of_its_own() {
        let _shared = listing();
        assert_eq!(typed("millisievert"), Some(unit("sievert", Prefix::Milli)));
        assert_eq!(typed("decasievert"), Some(UnitId::base("decasievert")));
        close(
            convert("decasievert", "sievert").expect("daSv to Sv").gain,
            0.1,
        );
    }

    /// **A spelling the library gives a unit names it**, where exactly
    /// one unit spells itself that way — which is what makes `L`,
    /// `lbf/in²` and `liters per minute` readable from a database
    /// without anyone tabulating them here.
    #[test]
    fn a_library_spelling_names_its_unit_where_exactly_one_unit_spells_it() {
        let _shared = listing();
        assert_eq!(recognize("L", &none()), typed("liter"));
        assert_eq!(recognize("liters", &none()), typed("liter"));
        assert_eq!(
            recognize("pound-force per square inch", &none()),
            typed("pound-force-per-square-inch")
        );
        assert_eq!(
            recognize("liters per second", &none()),
            typed("liter-per-second")
        );
        // Unique or nothing. Two dimensions carry a `kg/m³`, and a mass
        // density is not a mass concentration; 0.6.3 also gives a
        // pressure impulse the pressure's own `lbf/in²`, so neither
        // answers to it and the singular names still do.
        assert_eq!(recognize("kg/m³", &none()), None);
        assert_eq!(recognize("lbf/in²", &none()), None);
        // And a spelling the library resolves but a database does not
        // mean unambiguously stays refused.
        assert_eq!(recognize("C", &none()), None, "coulomb or Celsius");
    }

    /// The spellings an automotive database actually writes still place
    /// the units they always did — the passes ahead of the library's own
    /// spellings are what keeps `K` the absolute kelvin rather than the
    /// interval, and `h` an hour rather than the Planck constant.
    #[test]
    fn the_spellings_an_automotive_database_writes_still_place_their_units() {
        let _shared = listing();
        let cases = [
            ("V", "volt"),
            ("A", "ampere"),
            ("rpm", "revolution-per-minute"),
            ("km/h", "kilometer-per-hour"),
            ("bar", "bar"),
            ("°C", "degree-celsius"),
            ("°F", "degree-fahrenheit"),
            ("K", "kelvin"),
            ("%", "percent"),
            ("psi", "psi"),
            ("h", "hour"),
            ("Ah", "ampere-hour"),
            ("Nm", "newton-meter"),
            ("mph", "mile-per-hour"),
        ];
        for (raw, id) in cases {
            assert_eq!(recognize(raw, &none()), typed(id), "{raw}");
        }
        // The absolute temperature wins over the interval of the same
        // name, and the interval is still reachable by its own id.
        assert_eq!(
            dimension_of(&recognize("°C", &none()).expect("°C")),
            Some(Dimension::Temperature)
        );
        assert_eq!(
            typed("temperature-interval-degree-celsius").and_then(|u| dimension_of(&u)),
            Some(Dimension::TemperatureInterval)
        );
    }

    /// The quantity the whole task came from: litres and litres per
    /// minute are units of dimensions this app names, so a composition
    /// can land on one.
    #[test]
    fn volume_and_volume_rate_are_dimensions_with_the_library_units_in_them() {
        let _shared = listing();
        assert_eq!(
            get("liter").map(|u| u.dimension),
            Some(Dimension::Volume),
            "litres"
        );
        assert_eq!(
            get("liter-per-second").map(|u| u.dimension),
            Some(Dimension::VolumeRate)
        );
        // The library has no litre-per-minute, which is the whole reason
        // a project composes one — and a composition of a litre over a
        // minute now lands on a dimension this app names.
        assert!(get("liter-per-minute").is_none());
        let per_minute = Composed::of(UnitId::base("liter")).over(UnitId::base("minute"));
        assert_eq!(per_minute.dimension(), Some(Dimension::VolumeRate));
        close(
            per_minute
                .convert_to(&UnitId::base("cubic-meter-per-second"))
                .expect("L/min to m³/s")
                .gain,
            1.0 / 60_000.0,
        );
    }

    // ---- Units the user composes ------------------------------------
    //
    // The registry these exercise is a process global that changes what
    // `recognize`, `convert_units` and every list surface answer — so an
    // installing test cannot run beside any other test in this module.
    //
    // The rule is therefore blanket, not a judgement call: **every test
    // here takes `REGISTRY`**, the ones below exclusively (`install`,
    // which undoes itself when its guard drops) and every other one
    // shared (`listing`). Reads do not exclude each other, so the only
    // thing serialized is an install. Scoping the shared guard to the
    // tests that "obviously" read a list is what made this flaky the
    // first time: a test asserting why an empty composition is refused
    // reads the registry too, through the name-collision check.

    static REGISTRY: RwLock<()> = RwLock::new(());

    fn listing() -> std::sync::RwLockReadGuard<'static, ()> {
        REGISTRY.read().unwrap_or_else(PoisonError::into_inner)
    }

    struct Installed(#[allow(dead_code)] std::sync::RwLockWriteGuard<'static, ()>);

    impl Drop for Installed {
        fn drop(&mut self) {
            let _ = install_definitions(&Definitions::new(), &Definitions::new(), &none());
        }
    }

    fn dict(pairs: &[(&str, &str)]) -> Definitions {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    /// Install `project`-scope definitions for the life of the guard.
    fn install(pairs: &[(&str, &str)]) -> (Installed, Vec<DefinedUnit>) {
        install_scoped(&[], pairs)
    }

    fn install_scoped(
        user: &[(&str, &str)],
        project: &[(&str, &str)],
    ) -> (Installed, Vec<DefinedUnit>) {
        let guard = Installed(REGISTRY.write().unwrap_or_else(PoisonError::into_inner));
        let defined = install_definitions(&dict(user), &dict(project), &none());
        (guard, defined)
    }

    fn refusal(defined: &[DefinedUnit], name: &str) -> String {
        defined
            .iter()
            .find(|d| d.name == name)
            .unwrap_or_else(|| panic!("no definition `{name}`"))
            .error
            .clone()
            .unwrap_or_else(|| panic!("`{name}` was accepted"))
    }

    /// A composed unit is a unit: it measures what dimensional analysis
    /// says its composition measures, and reads as the name its author
    /// gave it.
    #[test]
    fn a_composed_unit_takes_the_dimension_its_composition_implies() {
        let (_guard, defined) = install(&[("VA", "V * A")]);
        assert_eq!(defined.iter().filter(|d| d.error.is_some()).count(), 0);
        let volt_amp = UnitId::base("VA");
        assert_eq!(dimension_of(&volt_amp), Some(Dimension::Power));
        assert_eq!(display_of(&volt_amp), "VA");
        assert_eq!(typed("VA"), Some(volt_amp));
    }

    /// The factor is the composition's, so a volt-ampere *is* a watt and
    /// a leading number scales it.
    #[test]
    fn a_composed_unit_converts_by_the_factor_its_composition_implies() {
        let (_guard, _) = install(&[("VA", "V * A"), ("kVA", "1000 * V * A")]);
        let watt = UnitId::base("watt");
        close(
            convert_units(&UnitId::base("VA"), &watt)
                .expect("VA→W")
                .gain,
            1.0,
        );
        close(
            convert_units(&UnitId::base("kVA"), &watt)
                .expect("kVA→W")
                .gain,
            1000.0,
        );
        // And back the other way, since a composed unit is a peer.
        close(
            convert_units(&watt, &UnitId::base("kVA"))
                .expect("W→kVA")
                .gain,
            0.001,
        );
        // Not across dimensions, no more than for a tabulated unit.
        assert!(convert_units(&UnitId::base("VA"), &UnitId::base("volt")).is_none());
    }

    /// Division composes too, so a reciprocal second is a hertz.
    #[test]
    fn a_composition_may_divide() {
        let (_guard, defined) = install(&[("per-sec", "1 / s")]);
        assert_eq!(refusals(&defined), Vec::<String>::new());
        let per_second = UnitId::base("per-sec");
        assert_eq!(dimension_of(&per_second), Some(Dimension::Frequency));
        close(
            convert_units(&per_second, &UnitId::base("hertz"))
                .expect("per-sec→Hz")
                .gain,
            1.0,
        );
    }

    /// The unit this whole change came from: a project that writes
    /// `LPM` composes it out of a litre over a minute, because the
    /// library carries no litre-per-minute of its own. Once defined it
    /// is a unit like any other — it lands on volume rate, a database
    /// that spells it gets it back, and it converts to the library's
    /// own volume rates by the factors the arithmetic implies.
    #[test]
    fn a_litre_per_minute_composed_in_the_settings_entry_reads_and_converts() {
        // Nothing recognises it before it is defined; that is the gap.
        assert_eq!(recognize("LPM", &none()), None);
        // The settings entry asks this before it persists the pair.
        {
            let _shared = listing();
            check_definition("LPM", "L / min", &none()).expect("`L / min` composes");
        }
        let (_guard, defined) = install(&[("LPM", "L / min")]);
        assert_eq!(refusals(&defined), Vec::<String>::new());
        let lpm = UnitId::base("LPM");
        assert_eq!(dimension_of(&lpm), Some(Dimension::VolumeRate));
        assert_eq!(recognize("LPM", &none()), Some(lpm.clone()));
        close(
            convert_units(&lpm, &UnitId::base("liter-per-second"))
                .expect("LPM→L/s")
                .gain,
            1.0 / 60.0,
        );
        close(
            convert_units(&lpm, &UnitId::base("cubic-meter-per-second"))
                .expect("LPM→m³/s")
                .gain,
            1.0 / 60_000.0,
        );
    }

    fn refusals(defined: &[DefinedUnit]) -> Vec<String> {
        defined.iter().filter_map(|d| d.error.clone()).collect()
    }

    /// A database that spells the user's own unit gets it back — the
    /// name is the spelling, and recognition is where a string becomes
    /// a unit.
    #[test]
    fn a_composed_unit_is_recognised_when_a_database_spells_it() {
        let (_guard, _) = install(&[("VA", "V * A")]);
        assert_eq!(recognize("VA", &none()), Some(UnitId::base("VA")));
        assert_eq!(recognize(" VA ", &none()), Some(UnitId::base("VA")));
        assert_eq!(recognize("va", &none()), None, "nothing is guessed");
        // And a customization can point an in-house spelling at it.
        let mapped = dict(&[("VoltAmps", "VA")]);
        assert_eq!(recognize("VoltAmps", &mapped), Some(UnitId::base("VA")));
    }

    /// Composed units are offered wherever tabulated ones are, in the
    /// one order every list surface uses.
    #[test]
    fn a_composed_unit_is_offered_in_the_lists_in_normalized_order() {
        let (_guard, _) = install(&[("VA", "V * A")]);
        let listed = list_units();
        let row = listed
            .iter()
            .find(|u| u.info.id == "VA")
            .expect("VA is selectable");
        assert_eq!(row.dimension_label, "power");
        assert_eq!(row.spelling, "VA", "its name is what a picker commits");
        // It sits inside its dimension's run rather than in a tail
        // after every shipped unit — the whole point of `list_order`.
        let power: Vec<usize> = listed
            .iter()
            .enumerate()
            .filter(|(_, u)| u.dimension_label == "power")
            .map(|(i, _)| i)
            .collect();
        let composed = listed.iter().position(|u| u.info.id == "VA").expect("VA");
        assert!(power.contains(&composed));
        assert_eq!(
            power.last().copied().unwrap_or(0) - power[0] + 1,
            power.len(),
            "the power group is contiguous"
        );
        let picker = list_unit_picker();
        let entry = picker.iter().find(|e| e.id == "VA").expect("VA in picker");
        assert_eq!(entry.scales.len(), 1, "the user named the whole unit");
        assert_eq!(entry.scales[0].unit, UnitId::base("VA"));
    }

    /// Every refusal says what is wrong, because the entry that typed it
    /// is the only place the user finds out.
    #[test]
    fn a_composition_naming_an_unknown_unit_is_refused() {
        let (_guard, defined) = install(&[("VA", "V * bananas")]);
        assert!(
            refusal(&defined, "VA").contains("bananas"),
            "{:?}",
            refusal(&defined, "VA")
        );
        assert_eq!(typed("VA"), None, "a refused definition installs nothing");
    }

    /// A shipped unit's spelling is not free to take: `W` is already
    /// the watt, and quietly shadowing it would change what every
    /// database in the project reads as.
    #[test]
    fn a_name_that_already_names_a_unit_is_refused() {
        let (_guard, defined) = install(&[("W", "V * A"), ("VA", "V * A"), ("VA2", "VA * 1")]);
        assert!(
            refusal(&defined, "W").contains("already names"),
            "{}",
            refusal(&defined, "W")
        );
        assert_eq!(recognize("W", &none()), typed("watt"));
        // A name built on another composed unit is fine — it is only
        // *taking* an existing name that is not.
        assert_eq!(refusals(&defined).len(), 1);
        assert_eq!(dimension_of(&UnitId::base("VA2")), Some(Dimension::Power));
    }

    #[test]
    fn an_empty_name_or_an_empty_composition_is_refused() {
        let _shared = listing();
        assert!(check_definition("  ", "V * A", &none())
            .unwrap_err()
            .contains("name"));
        assert!(check_definition("VA", "   ", &none())
            .unwrap_err()
            .contains("empty"));
        assert!(check_definition("VA", "V *", &none())
            .unwrap_err()
            .contains("empty term"));
        assert!(check_definition("V/A", "V * A", &none())
            .unwrap_err()
            .contains("cannot be a unit name"));
    }

    /// A definition may name another, whichever way round the dict
    /// happens to sort — the install runs to a fixpoint.
    #[test]
    fn a_definition_may_build_on_another_whatever_order_the_dict_is_in() {
        // `VA` sorts after `Ah-ish`, so a single pass in dict order
        // would leave the dependent one unresolved.
        let (_guard, defined) = install(&[("AVh", "VA * h"), ("VA", "V * A")]);
        assert_eq!(refusals(&defined), Vec::<String>::new());
        close(
            convert_units(&UnitId::base("AVh"), &typed("kilowatt-hour").expect("kWh"))
                .expect("AVh→kWh")
                .gain,
            0.001,
        );
    }

    /// The two scopes join exactly as the mapping scopes do.
    #[test]
    fn the_project_scope_wins_where_both_define_one_name() {
        let (_guard, defined) = install_scoped(&[("VA", "1000 * V * A")], &[("VA", "V * A")]);
        assert_eq!(refusals(&defined), Vec::<String>::new());
        close(
            convert_units(&UnitId::base("VA"), &UnitId::base("watt"))
                .expect("VA→W")
                .gain,
            1.0,
        );
        let row = defined.iter().find(|d| d.name == "VA").expect("VA");
        assert_eq!(row.scope, MappingSource::Project);
        assert_eq!(row.composition, "V * A");
    }

    /// The settings table is where a composed unit lives: its own row,
    /// carrying what it was composed from — and a refused definition
    /// gets a row too, saying why, so it can be seen and fixed.
    #[test]
    fn the_units_table_carries_a_composed_unit_and_why_a_refused_one_failed() {
        let (_guard, defined) = install_scoped(&[("VA", "V * A")], &[("Nope", "V * bananas")]);
        let rows = mappings(&none(), &none(), &defined);
        let volt_amp = rows
            .iter()
            .find(|r| r.unit == UnitId::base("VA"))
            .expect("a row for VA");
        assert_eq!(volt_amp.composition.as_deref(), Some("V * A"));
        assert_eq!(volt_amp.definition_scope, Some(MappingSource::User));
        assert_eq!(volt_amp.error, None);
        assert_eq!(
            volt_amp.id.as_deref(),
            Some("VA"),
            "spellings can map to it"
        );
        assert_eq!(volt_amp.dimension_label, "power");

        let refused = rows
            .iter()
            .find(|r| r.display == "Nope")
            .expect("a row for the refused definition");
        assert_eq!(refused.composition.as_deref(), Some("V * bananas"));
        assert_eq!(refused.definition_scope, Some(MappingSource::Project));
        assert!(refused
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("bananas"));
        assert_eq!(refused.id, None, "it names no unit to map a spelling to");

        // No shipped row grew a composition it does not have.
        let volt = rows
            .iter()
            .find(|r| r.unit == UnitId::base("volt"))
            .expect("volt");
        assert_eq!(volt.composition, None);
        assert_eq!(volt.error, None);
    }

    /// Deleting the definition deletes the unit: the registry is
    /// replaced whole, never added to.
    #[test]
    fn removing_a_definition_removes_the_unit() {
        let (guard, _) = install(&[("VA", "V * A")]);
        assert!(typed("VA").is_some());
        let defined = install_definitions(&Definitions::new(), &Definitions::new(), &none());
        assert!(defined.is_empty());
        assert_eq!(typed("VA"), None);
        assert_eq!(recognize("VA", &none()), None);
        assert!(!list_units().iter().any(|u| u.info.id == "VA"));
        drop(guard);
    }

    /// No two recognitions spell the same string, which would make the
    /// exact-match pass depend on table order.
    #[test]
    fn no_two_recognitions_spell_the_same_string() {
        let _shared = listing();
        let mut seen: Vec<&str> = RECOGNITIONS.iter().map(|(s, _)| *s).collect();
        let count = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), count, "duplicate recognition spelling");
    }
}
