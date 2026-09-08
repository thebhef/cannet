//! Tauri commands over the math-signal registry
//! ([`crate::math_signals`]): the definition CRUD every surface that
//! shows a math signal edits it through.
//!
//! The registry is the single model (ADR 0025 — the frontend renders
//! views onto host state), so these commands are the whole write path:
//! the Database panel's Computed branch, an expanded row in a signal
//! panel and a plot's side list all reach the same definitions here.
//! Every mutator emits [`MATH_SIGNALS_CHANGED`], and the views refetch.
//!
//! **The bus names travel with the call.** A pattern is evaluated
//! against the canonical signal path (ADR 0038), whose first segment is
//! the bus *name*, and the host has no other record of what a project's
//! buses are called — so every command carries the map, exactly as
//! `fetch_signal_page` does, and latches it for the serves that have no
//! caller to ask.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::math_signals::{self, Arity, MathDefinition, MathOperandRef};

/// Emitted whenever the definition set changes. The payload is empty:
/// the views refetch through [`list_math_signals`], which resolves
/// membership against the live catalog anyway.
pub(crate) const MATH_SIGNALS_CHANGED: &str = "math-signals-changed";

/// One math signal as a listing shows it: the stored definition, plus
/// what it currently resolves to.
///
/// The resolved half is derived, never stored — a set's membership is
/// picks ∪ live pattern matches, so it moves when the catalog does. The
/// host answers it here rather than letting each surface re-derive it
/// (ADR 0025).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MathSignalRecord {
    #[serde(flatten)]
    pub definition: MathDefinition,
    /// The series identity this math signal is keyed by everywhere —
    /// `*|m:0:<id>`, the fourth member of the provenance flag set
    /// (`math_signals::math_identity`). A view keys its row on this
    /// rather than composing it, so the two spellings cannot drift.
    pub identity: String,
    /// The function's discriminant, so a view can switch on it without
    /// unpacking the tagged parameter object.
    pub kind: &'static str,
    pub arity: Arity,
    /// Manual picks then live pattern matches, in resolution order —
    /// what the fill reads and what the fingerprint covers.
    ///
    /// Deliberately **not** called `operands`: the flattened definition
    /// already carries a field of that name (its picks and patterns),
    /// and two fields serialising under one key leave a reader only
    /// whichever was written last. An editor needs both halves — the
    /// stored selection to prefill, the resolution to show.
    pub resolved_operands: Vec<MathOperandRef>,
    /// The canonical path (ADR 0038) of each resolved operand,
    /// index-parallel with `resolved_operands`; empty for one the catalog no
    /// longer holds, which is how an editor shows a missing operand.
    pub operand_paths: Vec<String>,
    /// Each resolved operand's effective `(gain, offset)` —
    /// index-parallel with `resolved_operands` — as the definition's
    /// target unit, the per-operand source-unit override and the manual
    /// scalars compose to. Derived by the model, never stored.
    pub operand_affines: Vec<crate::units::Affine>,
    /// Indices into `resolved_operands` of the members that could
    /// **not** be converted to the target unit and pass through
    /// unscaled. Empty when the definition names no target unit. The
    /// editor flags these: nothing converts silently wrong.
    pub unconverted: Vec<usize>,
    /// The unit the series carries: the user's, or the derived one.
    pub unit_resolved: String,
    /// What dimensional analysis makes of this function, spelled —
    /// whatever the user has named on top. The editor's unit button
    /// states it: `composed: A · h` while nothing is set, and the
    /// conversion once something is.
    pub unit_derived: Option<String>,
    /// The unit that derivation **is**, where the table names one — what
    /// a picker offers as "the composition, prefixable". `None` for a
    /// composition no unit names (`Ah/s`).
    pub unit_composed: Option<crate::units::UnitId>,
    /// **The unit this series is read in**, typed — the definition's
    /// target where it names one, and the derivation's own unit
    /// otherwise. `None` where nothing places one.
    ///
    /// The typed half of `unit_resolved`, carried beside it rather than
    /// recovered from it: a series targeted at a coulomb reads `C`, and
    /// `C` is a spelling recognition refuses on purpose. A plot's
    /// display-unit chip converts through this.
    pub unit_typed: Option<crate::units::UnitId>,
    /// The unit conversion the button's note states once a target is
    /// named: derivation → target, without the user's own output
    /// scalars.
    pub unit_conversion: Option<crate::units::Affine>,
    /// The **kind** the resolved unit belongs to — the composed
    /// dimension for an integration or a derivative, the operands' own
    /// for a pointwise function. What a kind-locked unit picker offers
    /// against; `None` where nothing places it. Deliberately not called
    /// `kind`: that is already the function's discriminant.
    pub unit_kind: Option<crate::units::Dimension>,
    /// What the host made of each operand's unit string,
    /// index-parallel with `resolved_operands` — the parse state the
    /// editor shows at edit time, which `unconverted` does not say
    /// (an unplaceable string and a placeable one of the wrong kind
    /// are different problems with different repairs).
    pub recognition: Vec<math_signals::UnitRecognition>,
    /// Every bus contributing input to this series, transitively and
    /// deduped — the color chips a row wears, and what makes its label
    /// read "Math - Multiple Busses" when there is more than one. The
    /// walk is the model's (ADR 0025): a surface cannot follow a math
    /// operand into another definition's operands.
    pub bus_ids: Vec<String>,
    /// `None` when the definition is usable as it stands; otherwise why
    /// it is not — an arity a live membership no longer satisfies, a
    /// pattern that stopped compiling.
    pub invalid: Option<String>,
}

/// Fill in the one name the host is allowed to derive: a set defined
/// by exactly one pattern and nothing else defaults to `fn(pattern)`.
/// Applied on every write, not only the first: a set that gains its
/// pattern after it was created earns the same default.
///
/// No other heuristic name exists, by ruling — a name composed from a
/// selection reads as authoritative while being a guess, so a manually
/// picked set, a pair and a single-operand function are all named by
/// the user.
fn with_default_name(mut definition: MathDefinition) -> MathDefinition {
    if definition.name.trim().is_empty() {
        if let Some(name) =
            math_signals::default_name(&definition.function, &definition.operands.patterns)
        {
            if definition.operands.picks.is_empty() {
                definition.name = name;
            }
        }
    }
    definition
}

/// Latch the caller's bus-name map and drop the resolved model, so the
/// next read rebuilds against it.
fn latch_bus_names(state: &AppState, bus_names: Vec<(String, String)>) {
    let mut latched = state.math_bus_names();
    if *latched != bus_names {
        *latched = bus_names;
        drop(latched);
        *state.math_model_cache() = None;
    }
}

/// Every math signal, in creation order, with its membership resolved.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn list_math_signals(
    state: State<'_, AppState>,
    bus_names: Vec<(String, String)>,
) -> Vec<MathSignalRecord> {
    latch_bus_names(&state, bus_names);
    let dbcs = state.databases();
    let model = state.math_model(&dbcs);
    drop(dbcs);
    model
        .iter()
        .map(|resolved| {
            let mut candidate = resolved.definition.clone();
            // Validity is judged against the *resolved* membership: a
            // pattern-defined set whose matches have all gone no longer
            // satisfies its arity, and the editor says so.
            candidate.operands.picks = resolved
                .operands
                .iter()
                .cloned()
                .map(math_signals::MathOperand::new)
                .collect();
            MathSignalRecord {
                identity: math_signals::math_identity(&resolved.definition.id),
                kind: resolved.definition.function.kind(),
                arity: resolved.definition.function.arity(),
                operand_paths: resolved.operand_paths.clone(),
                operand_affines: resolved.operand_affines.clone(),
                unconverted: resolved.unconverted.clone(),
                resolved_operands: resolved.operands.clone(),
                unit_resolved: resolved.unit.clone(),
                unit_derived: resolved.derived.clone(),
                unit_composed: resolved.composed.clone(),
                unit_typed: resolved
                    .target
                    .clone()
                    .or_else(|| resolved.composed.clone()),
                unit_conversion: resolved.target_conversion,
                unit_kind: resolved.kind,
                recognition: resolved.recognition.clone(),
                bus_ids: resolved.bus_ids.clone(),
                invalid: candidate.validate().err().map(|e| e.to_string()),
                definition: resolved.definition.clone(),
            }
        })
        .collect()
}

/// Add a math signal.
///
/// A definition is created the moment the user picks a function, so
/// what arrives here is usually **unfinished** — it is stored, marked
/// invalid by its own validation, and serves nothing until it is filled
/// in. Only a duplicate id and a cycle are refused.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn define_math_signal(
    app: AppHandle,
    definition: MathDefinition,
    bus_names: Vec<(String, String)>,
) -> Result<(), String> {
    let state: State<'_, AppState> = app.state();
    latch_bus_names(&state, bus_names);
    state
        .math
        .define(with_default_name(definition))
        .map_err(|e| e.to_string())?;
    changed(&app, &state);
    Ok(())
}

/// Replace a math signal's definition, under the same two refusals
/// [`define_math_signal`] applies. Its place in the listing is kept, so
/// an edit does not reorder the Computed branch — which matters when
/// every field commits as it is left.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn update_math_signal(
    app: AppHandle,
    definition: MathDefinition,
    bus_names: Vec<(String, String)>,
) -> Result<(), String> {
    let state: State<'_, AppState> = app.state();
    latch_bus_names(&state, bus_names);
    state
        .math
        .update(with_default_name(definition))
        .map_err(|e| e.to_string())?;
    changed(&app, &state);
    Ok(())
}

/// Remove a math signal.
///
/// A definition that took it as an operand keeps the reference: the
/// serve answers such a series empty and the editor shows the operand
/// as missing, which the user can repair — silently rewriting their
/// other definitions is not something to do on their behalf.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn delete_math_signal(app: AppHandle, id: String) -> Result<(), String> {
    let state: State<'_, AppState> = app.state();
    state.math.delete(&id).map_err(|e| e.to_string())?;
    changed(&app, &state);
    Ok(())
}

/// Drop the resolved model and tell the views.
///
/// The pyramids are deliberately **not** touched here. A definition
/// change moves the compositional fingerprint of every series that
/// reaches it, and the next serve's `invalidate_dbcs` pass parks them
/// against the new stamp — the same path a DBC edit takes (ADR 0047).
fn changed(app: &AppHandle, state: &AppState) {
    *state.math_model_cache() = None;
    crate::app_state::invalidate_derived_caches(state);
    let _ = app.emit(MATH_SIGNALS_CHANGED, ());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math_signals::{MathDefinition, MathFunction, MathOperands};

    fn record() -> MathSignalRecord {
        let definition = MathDefinition {
            id: "m1".to_string(),
            name: "CellSpread".to_string(),
            unit: None,
            output_gain: None,
            output_offset: None,
            function: MathFunction::Sum,
            operands: MathOperands {
                picks: vec![MathOperandRef::dbc("bus-a", 0x120, false, "Cell01").into()],
                patterns: vec![r"Cell\d+".to_string()],
            },
        };
        MathSignalRecord {
            identity: math_signals::math_identity(&definition.id),
            kind: definition.function.kind(),
            arity: definition.function.arity(),
            resolved_operands: definition
                .operands
                .picks
                .iter()
                .map(|p| p.reference.clone())
                .collect(),
            operand_affines: vec![crate::units::Affine::new(0.001, 0.0)],
            unconverted: vec![1],
            operand_paths: vec!["CAN1/BMS/Cells/Cell01".to_string()],
            unit_resolved: "V".to_string(),
            unit_derived: Some("V".to_string()),
            unit_composed: Some(crate::units::UnitId::base("volt")),
            unit_typed: Some(crate::units::UnitId::base("volt")),
            unit_conversion: None,
            unit_kind: Some(crate::units::Dimension::Voltage),
            recognition: vec![math_signals::UnitRecognition::Recognized {
                unit: crate::units::UnitId::base("volt"),
                display: "V".to_string(),
            }],
            bus_ids: vec!["bus-a".to_string()],
            invalid: None,
            definition,
        }
    }

    /// The stored selection and its live resolution are two different
    /// facts, and an editor prefills from the first while showing the
    /// second — so both have to survive the wire. They did not once:
    /// the resolved list was called `operands` too, and serialising it
    /// beside the flattened definition's own `operands` left a JSON
    /// reader only the last one written.
    #[test]
    fn a_listing_carries_the_stored_selection_and_its_resolution_apart() {
        let json = serde_json::to_value(record()).unwrap();
        assert_eq!(json["operands"]["patterns"][0], r"Cell\d+");
        assert_eq!(json["operands"]["picks"][0]["signalName"], "Cell01");
        assert_eq!(json["resolvedOperands"][0]["signalName"], "Cell01");
        assert_eq!(json["operandPaths"][0], "CAN1/BMS/Cells/Cell01");
    }

    /// The rest of the listing's derived half, which every surface
    /// keys and labels its row from.
    #[test]
    fn a_listing_carries_the_identity_the_series_is_keyed_by() {
        let json = serde_json::to_value(record()).unwrap();
        assert_eq!(json["identity"], "*|m:0:m1");
        assert_eq!(json["kind"], "sum");
        assert_eq!(json["arity"], "set");
        assert_eq!(json["unitResolved"], "V");
        // The derivation the unit button states, beside the unit the
        // series carries — two facts, never one.
        assert_eq!(json["unitDerived"], "V");
        assert_eq!(json["unitComposed"]["base"], "volt");
        assert_eq!(json["unitConversion"], serde_json::Value::Null);
        // The kind a unit picker locks to, and the parse state the
        // operand chip shows — both the model's, neither re-derived.
        assert_eq!(json["unitKind"], "voltage");
        assert_eq!(json["recognition"][0]["state"], "recognized");
        assert_eq!(json["recognition"][0]["unit"]["base"], "volt");
        assert_eq!(json["recognition"][0]["display"], "V");
        assert_eq!(json["busIds"][0], "bus-a");
        assert_eq!(json["invalid"], serde_json::Value::Null);
    }

    /// The parameter names the editor writes into a function object.
    /// The enum renames its *variants* (the `kind` tag), not the fields
    /// inside them, so each parameter travels under its Rust name.
    #[test]
    fn a_function_carries_its_parameters_under_their_own_names() {
        let json = serde_json::to_value(MathFunction::Duty {
            threshold: 0.5,
            window_seconds: 5.0,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind": "duty", "threshold": 0.5, "window_seconds": 5.0})
        );
        let json = serde_json::to_value(MathFunction::Statistic {
            statistic: crate::math_signals::Statistic::Percentile,
            percentile: 95.0,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind": "statistic", "statistic": "percentile", "percentile": 95.0})
        );
        let json = serde_json::to_value(MathFunction::ExpFilter { tau_seconds: 2.0 }).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind": "expfilter", "tau_seconds": 2.0})
        );
    }
}
