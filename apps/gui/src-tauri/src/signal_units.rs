//! **Per-signal unit reinterpretation**: what a signal's unit really is,
//! where the database is wrong about it.
//!
//! A DBC's unit field is free text written by whoever wrote the
//! database, and it is sometimes simply wrong — a current channel
//! labelled `V`, a counter labelled `A`. The View signals panel is where
//! that is corrected, and correcting it is **reinterpretation, not
//! conversion**:
//!
//! - **any unit may be chosen**, and kinds may cross. The label was
//!   wrong about what the signal *measures*, so a picker restricted to
//!   like-kind units could not express the repair;
//! - **no scaling is applied**. The decoded value is read *as* the
//!   chosen unit from then on. Correcting a label does not move a
//!   number, and a store that quietly rescaled would make the panel a
//!   second, invisible decode stage.
//!
//! Everywhere units are *applied* — the plot's display-unit chip, a
//! math definition's target — the picker is kind-locked instead and the
//! choice is a real conversion. The two are different operations and
//! this module is only the first.
//!
//! ## Scope
//!
//! The store is **per signal and global**: one entry keyed by the
//! signal's identity (`signal_snapshot::signal_identity`), in force
//! everywhere that signal appears. It is not per view — the DBC's label
//! is wrong in every view at once — and it persists with the project,
//! beside the per-signal database picks
//! (`crate::signal_fingerprint::SignalDbcPicks`), which it is shaped
//! after.

use std::collections::BTreeMap;

use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::units::{Customizations, UnitId, UnitReading};

/// Signal identity → the unit that signal is to be read in.
///
/// Sparse: it holds only the signals a user has reinterpreted, and an
/// empty map is the shipped behaviour. Ordered, so the project file it
/// persists in writes the same bytes for the same content.
pub type SignalUnits = BTreeMap<String, UnitId>;

/// **The one application point.** The unit a signal is read in: the
/// reinterpretation the project records for it, and what the database's
/// own string means where there is none.
///
/// Answers with a [`UnitReading`] — the unit *and* how it reads — so a
/// reinterpretation reaches its consumers as the unit that was chosen
/// rather than as the string that unit renders as. Recovering a unit
/// from a rendering does not work and must not be attempted: `coulomb`
/// reads `C`, which recognition refuses (it would be a guess against
/// Celsius), so a signal read as a coulomb would arrive carrying
/// nothing. The database's own string is the only thing parsed here,
/// and that is ingest.
///
/// Every surface that reports a signal's unit reads this, so the panel,
/// the picker catalog, the signal rows and the math catalog cannot
/// disagree about what a signal is in.
#[must_use]
pub fn unit_of(
    units: &SignalUnits,
    identity: &str,
    declared: &str,
    customizations: &Customizations,
) -> UnitReading {
    units.get(identity).map_or_else(
        || UnitReading::declared(declared, customizations),
        |unit| UnitReading::typed(unit.clone()),
    )
}

/// **How a signal's unit reads**, for a row that shows it and asks
/// nothing else of it.
///
/// The rendering half of [`unit_of`] without the recognition — the
/// trace snapshot and the signal catalog fetch thousands of rows and
/// each needs a string, not a unit. Deliberately not a source of unit
/// *identity*: a caller that converts anything takes [`unit_of`], which
/// is the only thing that can answer what a rendering means.
///
/// The identity is a `format!`, and this runs **per row per fetch** —
/// so an empty store, which is what every project that has
/// reinterpreted nothing has, must not pay for one. It does not: the
/// composition is skipped outright.
#[must_use]
pub fn label_of_signal(
    units: &SignalUnits,
    bus_id: Option<&str>,
    signal: (u32, bool, &str),
    declared: &str,
) -> String {
    if units.is_empty() {
        return declared.to_string();
    }
    let (message_id, extended, name) = signal;
    let identity =
        crate::signal_snapshot::signal_identity(bus_id, message_id, extended, name, false);
    units
        .get(&identity)
        .map_or_else(|| declared.to_string(), crate::units::display_of)
}

/// [`unit_of`] for a signal whose identity has not been composed yet.
///
/// The same empty-store fast path [`label_of_signal`] takes, for the
/// same reason.
#[must_use]
pub fn unit_of_signal(
    units: &SignalUnits,
    bus_id: Option<&str>,
    signal: (u32, bool, &str),
    declared: &str,
    customizations: &Customizations,
) -> UnitReading {
    if units.is_empty() {
        return UnitReading::declared(declared, customizations);
    }
    let (message_id, extended, name) = signal;
    let identity =
        crate::signal_snapshot::signal_identity(bus_id, message_id, extended, name, false);
    unit_of(units, &identity, declared, customizations)
}

/// Reinterpret `signal` as `unit`, or clear the reinterpretation with
/// `None`.
///
/// A unit the facade cannot place is refused rather than stored: the
/// store's whole value is that what comes out of it is a unit.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn set_signal_unit(
    app: AppHandle,
    state: State<'_, AppState>,
    signal: String,
    unit: Option<UnitId>,
) {
    if !set_signal_unit_inner(&state, signal, unit) {
        return;
    }
    // A reinterpreted unit changes what every math definition reading
    // that signal converts from, so the derived caches go with it —
    // exactly as a database pick does.
    crate::app_state::invalidate_derived_caches(&state);
    crate::dbc_commands::announce_dbc_change(&app, "*");
}

/// [`set_signal_unit`]'s body: apply the choice, and say whether it
/// moved anything. Split out so the rule is testable against a real
/// `AppState` without a Tauri app.
pub(crate) fn set_signal_unit_inner(
    state: &AppState,
    signal: String,
    unit: Option<UnitId>,
) -> bool {
    let unit = unit.filter(|u| crate::units::dimension_of(u).is_some());
    let mut guard = state.signal_units();
    let current = guard.get(&signal).cloned();
    if current == unit {
        return false;
    }
    let mut next = (**guard).clone();
    match unit {
        Some(unit) => next.insert(signal, unit),
        None => next.remove(&signal),
    };
    *guard = std::sync::Arc::new(next);
    true
}

/// Every reinterpretation in force, for a panel that lists them.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn list_signal_units(state: State<'_, AppState>) -> Vec<(String, UnitId)> {
    state
        .signal_units()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::Prefix;

    fn store(entries: &[(&str, UnitId)]) -> SignalUnits {
        entries
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    fn none() -> Customizations {
        Customizations::new()
    }

    #[test]
    fn a_signal_with_no_reinterpretation_reads_what_its_database_says() {
        let units = store(&[]);
        let reading = unit_of(&units, "pack|s:256:Cell01", "V", &none());
        assert_eq!(reading.display, "V");
        assert_eq!(reading.unit, Some(UnitId::base("volt")));
        // Including a unit string nothing recognises, which is still
        // what the database says — and is reported as unplaceable.
        let unknown = unit_of(&units, "pack|s:256:Cell01", "widgets", &none());
        assert_eq!(unknown.display, "widgets");
        assert_eq!(unknown.unit, None);
        assert!(unknown.is_unplaceable());
    }

    #[test]
    fn a_reinterpreted_signal_reads_as_the_unit_that_was_chosen() {
        let units = store(&[("pack|s:256:Cell01", UnitId::new("ampere", Prefix::Nano))]);
        let reading = unit_of(&units, "pack|s:256:Cell01", "V", &none());
        assert_eq!(reading.display, "nA");
        assert_eq!(reading.unit, Some(UnitId::new("ampere", Prefix::Nano)));
        // Only that signal: the store is per signal, not per message.
        assert_eq!(
            unit_of(&units, "pack|s:256:Cell02", "V", &none()).display,
            "V"
        );
    }

    /// **The reinterpretation is handed on as a unit, never as the
    /// string it reads as.** `coulomb` reads `C`, which recognition
    /// refuses on purpose — so a hand-off through the spelling would
    /// lose the very choice the user made.
    #[test]
    fn a_reinterpretation_hands_on_the_unit_and_not_its_spelling() {
        let units = store(&[("pack|s:256:Q", UnitId::base("coulomb"))]);
        let reading = unit_of(&units, "pack|s:256:Q", "A", &none());
        assert_eq!(reading.display, "C", "it still reads as C");
        assert_eq!(reading.unit, Some(UnitId::base("coulomb")));
        assert!(!reading.is_unplaceable(), "a chosen unit is placed");
        assert_eq!(crate::units::recognize("C", &none()), None, "by design");
    }

    /// The per-row lookups: an empty store never composes an identity,
    /// and a non-empty one answers exactly as `unit_of` does.
    #[test]
    fn the_per_row_lookups_agree_with_the_identity_one() {
        let signal = (256u32, false, "Cell01");
        assert_eq!(label_of_signal(&store(&[]), Some("pack"), signal, "V"), "V");
        assert_eq!(
            unit_of_signal(&store(&[]), Some("pack"), signal, "V", &none()).display,
            "V"
        );
        let units = store(&[("pack|s:256:Cell01", UnitId::new("ampere", Prefix::Nano))]);
        assert_eq!(label_of_signal(&units, Some("pack"), signal, "V"), "nA");
        let reading = unit_of_signal(&units, Some("pack"), signal, "V", &none());
        assert_eq!(reading.display, "nA");
        assert_eq!(reading.unit, Some(UnitId::new("ampere", Prefix::Nano)));
        assert_eq!(
            label_of_signal(&units, Some("other"), signal, "V"),
            "V",
            "the identity carries the bus"
        );
    }

    /// A DBC spelling the user has mapped is placed by the dict, which
    /// is the second — and last — ingest surface.
    #[test]
    fn a_customized_spelling_places_a_declared_unit() {
        let mut dict = Customizations::new();
        dict.insert("widgets".to_string(), "percent".to_string());
        let reading = unit_of(&store(&[]), "pack|s:256:Cell01", "widgets", &dict);
        assert_eq!(reading.display, "widgets", "the database's own wording");
        assert_eq!(reading.unit, Some(UnitId::base("percent")));
    }

    #[test]
    fn a_reinterpretation_may_cross_kinds() {
        let units = store(&[("pack|s:256:Cell01", UnitId::base("ampere"))]);
        let reading = unit_of(&units, "pack|s:256:Cell01", "V", &none());
        assert_eq!(reading.display, "A");
        assert_eq!(reading.unit, Some(UnitId::base("ampere")));
    }
}
