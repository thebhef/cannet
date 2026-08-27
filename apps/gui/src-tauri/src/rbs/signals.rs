//! The RBS signals panel's model: every field one `.cannet_rbs` config
//! transmits, and where its bits actually came from.
//!
//! This is the RBS analogue of `crate::view_signals`, sharing its
//! reason for existing — surfacing where a decoded/encoded value
//! silently diverges from what a document says — but with the
//! opposite scoping rule: the view-signals panel *combines* every open
//! view because per-view divergence is a defect, while this one is
//! scoped to **one** element, because two RBS configs are meant to
//! carry different values and never combine.
//!
//! The taxonomy is the encoder's own, drawn from what
//! [`reconstruct_payload`] actually reports rather than invented: a
//! row is **Muted** when the message won't play regardless of what it
//! carries; else **Not Encoded** when nothing in the resolved DBC
//! defines it at all (an override naming a signal the descriptor has
//! none of, or a message no scoped DBC defines); else **Unknown
//! Value** when the override *is* a real signal but its text didn't
//! resolve (bad hex, unrecognised enum label) — the signal is encoded,
//! just carrying the default because this value wasn't; else
//! **Override** when the file sets it and it applied; else
//! **Default** (DBC start value, or the file's fill bit). **Out of
//! Range** is deliberately not computed here — it is a frontend
//! concern (`rbsValueClamp.ts`): transmit truncation to the signal's
//! width is correct on the wire, so the host has nothing to flag, and
//! the grid's own severity order — including where Out of Range sits
//! among these — is resolved client-side because of it.

use std::collections::HashSet;

use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::ipc::CalcFieldsSpec;

use super::file_model::{parse_message_key, RbsValue};
use super::runtime::{for_each_scoped_message, reconstruct_payload, OverrideProblem};

/// One field of one RBS config: a (bus, message, signal) triple and
/// what currently supplies its bits. Not combined across elements —
/// the caller already scopes the request to one.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
// The bools are independent facts (bus resolution, override presence,
// signedness, value-table presence) — collapsing them loses which
// input each came from, the same call `RbsSignalView` already makes.
#[allow(clippy::struct_excessive_bools)]
pub struct RbsSignalRow {
    /// Stable within one element: `<bus key>|<message key>|<signal>`.
    pub id: String,
    /// The file's bus key (a project logical-bus name, ADR 0028) —
    /// shown verbatim, same as the RBS tree's own bus column.
    pub bus_key: String,
    /// The resolved project bus id, `None` when no project bus has
    /// this name — the value-table fetch (`useValueTables`) and the
    /// clamp-shared `RbsValueCell` both take this, so the row carries
    /// it rather than only the pass/fail `bool` a caller would
    /// otherwise have to re-derive.
    pub bus_id: Option<String>,
    /// The ECU key an edit's `RbsTarget` must name — the DBC's own
    /// transmitter grouping for a covered message (`for_each_scoped_
    /// message`'s `ecu_name`), which is what `entry_mut` (`rbs/
    /// commands.rs`) files a fresh override under. Not meaningful for
    /// a Not Encoded row (there is nothing to file an edit under), but
    /// always present so the frontend never has to special-case it.
    pub ecu_name: String,
    pub message_key: String,
    pub message_name: Option<String>,
    pub message_id: u32,
    pub extended: bool,
    pub signal_name: String,
    pub unit: String,
    pub status: RbsSignalStatus,
    /// Decoded physical value from the reconstructed buffer. `None`
    /// for a Not Encoded row (nothing to decode) or an inactive
    /// multiplexed arm.
    pub value: Option<f64>,
    pub label: Option<String>,
    pub overridden: bool,
    pub override_text: Option<String>,
    pub calc_role: Option<&'static str>,
    pub factor: f64,
    pub offset: f64,
    pub min: f64,
    pub max: f64,
    pub size: u32,
    pub signed: bool,
    pub has_value_table: bool,
    /// The DBC's start value for this signal, in physical units —
    /// `None` where the DBC declares none and the bits are the file's
    /// fill instead. The feed collapses the DBC and override layers
    /// into one live `value`, so without this an overridden field's
    /// DBC default has nowhere to show.
    pub default_value: Option<f64>,
    /// A short "what happened" note for the detail column — empty for
    /// a clean Default/Override row, the prototype's phrasing
    /// otherwise (e.g. "invalid hex value 0xZZ"). The undefaulted case
    /// is the Default column's to say, not a sentence here.
    pub detail: String,
}

/// The RBS signal taxonomy, in severity order (declaration order is
/// the sort key — mirrors `view_signals::ViewSignalStatus`). Out of
/// Range is not a variant here: it is decided in the frontend and
/// slotted into the same severity band there
/// (`rbsSignalsFilter.ts`).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum RbsSignalStatus {
    NotEncoded,
    UnknownValue,
    Override,
    Default,
    Muted,
}

/// Every field one element's resolved buses transmit, `None` if the
/// element isn't loaded. Unresolved bus names contribute rows only for
/// the overrides they actually list (nothing else is enumerable
/// without a DBC to walk) — same "list what's actually there" call
/// `view_signals` makes for file-backed series.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_signal_rows(
    state: State<'_, AppState>,
    element_id: String,
) -> Result<Option<Vec<RbsSignalRow>>, String> {
    Ok(build_rbs_signal_rows(&state, &element_id))
}

/// The command's body, factored out so tests call it directly rather
/// than driving the `async` Tauri wrapper (same shape
/// `dbc_commands::set_dbc_buses_inner` and `view_signals`'s `_inner`
/// functions already use — nothing here ever awaits).
#[allow(clippy::too_many_lines)]
fn build_rbs_signal_rows(state: &AppState, element_id: &str) -> Option<Vec<RbsSignalRow>> {
    let rbs = state.rbs();
    let element = rbs.elements.get(element_id)?;
    let dbs = state.databases();

    let mut rows = Vec::new();
    for (bus_key, bus) in &element.file.buses {
        let bus_id = rbs.resolve_bus(bus_key);
        let mut covered: HashSet<String> = HashSet::new();

        if let Some(bus_id) = &bus_id {
            for_each_scoped_message(&dbs, bus_id, |db, msg_key, id, desc, ecu_name| {
                covered.insert(msg_key.to_string());
                let entry = element.file.entry_for(bus_key, msg_key);
                let default_msg = super::file_model::RbsMessage::new();
                let msg = entry.map_or(&default_msg, |(_, m)| m);
                let muted = !bus.enabled
                    || bus.ecus.get(ecu_name).is_some_and(|e| !e.enabled)
                    || !element.file.is_message_enabled(bus_key, msg_key);

                let (data, warnings) =
                    reconstruct_payload(db, id, desc, msg, element.file.fill_bit);
                let decoded = db.decode_raw(id, &data);

                // Effective designation: override else DBC default —
                // the same precedence `build_message_view`
                // (rbs/view.rs) applies.
                let dbc_calc = CalcFieldsSpec::from_config(&desc.calc_fields);
                let counter_signal = msg.counter.clone().or(dbc_calc.counter).map(|c| c.signal);
                let crc_signal = msg.crc.clone().or(dbc_calc.crc).map(|c| c.signal);

                for s in &desc.signals {
                    let dec = decoded
                        .as_ref()
                        .and_then(|d| d.signals.iter().find(|x| x.name == s.name));
                    let override_value = msg.signals.get(&s.name);
                    let warning = warnings.iter().find(|w| w.signal == s.name);
                    let calc_role = if counter_signal.as_deref() == Some(s.name.as_str()) {
                        Some("counter")
                    } else if crc_signal.as_deref() == Some(s.name.as_str()) {
                        Some("crc")
                    } else {
                        None
                    };

                    let (status, detail) = if muted {
                        (
                            RbsSignalStatus::Muted,
                            "muted — not transmitted".to_string(),
                        )
                    } else if let Some(w) = warning {
                        // `UnknownSignal` can't reach here — `s` came
                        // from `desc.signals`, so the override matched
                        // a real signal by construction.
                        (RbsSignalStatus::UnknownValue, w.message().to_string())
                    } else if override_value.is_some() {
                        (RbsSignalStatus::Override, String::new())
                    } else if s.start_value_raw.is_some() {
                        (RbsSignalStatus::Default, "DBC start value".to_string())
                    } else {
                        // No start value: the Default column already
                        // says `none`, so the detail says nothing.
                        (RbsSignalStatus::Default, String::new())
                    };

                    rows.push(RbsSignalRow {
                        id: format!("{bus_key}|{msg_key}|{}", s.name),
                        bus_key: bus_key.clone(),
                        bus_id: Some(bus_id.clone()),
                        ecu_name: ecu_name.to_string(),
                        message_key: msg_key.to_string(),
                        message_name: Some(desc.name.clone()),
                        message_id: id.raw(),
                        extended: id.is_extended(),
                        signal_name: s.name.clone(),
                        unit: s.unit.clone(),
                        status,
                        value: dec.map(|d| d.value),
                        label: dec.and_then(|d| d.label.map(ToString::to_string)),
                        overridden: override_value.is_some(),
                        override_text: override_value.map(override_text),
                        calc_role,
                        factor: s.factor,
                        offset: s.offset,
                        min: s.min,
                        max: s.max,
                        size: s.size,
                        signed: s.signed,
                        has_value_table: s.has_value_table,
                        default_value: s.start_value_raw.map(|raw| raw.mul_add(s.factor, s.offset)),
                        detail,
                    });
                }

                // Overrides naming a signal this message doesn't
                // define — `reconstruct_payload`'s `UnknownSignal`
                // case, surfaced as its own Not Encoded row per
                // override key rather than folded into the loop above
                // (there is no `SignalDescriptor` to hang it on).
                for w in warnings
                    .iter()
                    .filter(|w| w.problem == OverrideProblem::UnknownSignal)
                {
                    rows.push(not_encoded_row(
                        bus_key,
                        Some(bus_id.clone()),
                        msg_key,
                        id,
                        Some(&desc.name),
                        &w.signal,
                        ecu_name,
                    ));
                }
            });
        }

        // File-listed messages nothing covers: no scoped DBC defines
        // them (or the bus itself doesn't resolve). Every override key
        // they list is Not Encoded — there is no message-known-but-
        // this-value-broke case to reach because there is no
        // descriptor at all.
        for (ecu_key, ecu) in &bus.ecus {
            for (msg_key, msg) in &ecu.messages {
                if covered.contains(msg_key) {
                    continue;
                }
                let (id, extended) = parse_message_key(msg_key).unwrap_or((0, false));
                for name in msg.signals.keys() {
                    rows.push(not_encoded_row_raw(
                        bus_key,
                        bus_id.clone(),
                        msg_key,
                        id,
                        extended,
                        name,
                        ecu_key,
                    ));
                }
            }
        }
    }

    rows.sort_by(|a, b| {
        (&a.bus_key, &a.message_key, &a.signal_name).cmp(&(
            &b.bus_key,
            &b.message_key,
            &b.signal_name,
        ))
    });
    Some(rows)
}

/// A Not Encoded row for an override on a *resolved* message — the id
/// and message name are known, only this signal isn't. Not
/// `overridden` in the row-model sense (matching the prototype: only
/// an applied Override row offers a reset) even though the file does
/// carry an entry for this name — there is nowhere to file an edit
/// under, so the row offers none.
fn not_encoded_row(
    bus_key: &str,
    bus_id: Option<String>,
    msg_key: &str,
    id: cannet_core::CanId,
    message_name: Option<&str>,
    signal_name: &str,
    ecu_name: &str,
) -> RbsSignalRow {
    RbsSignalRow {
        id: format!("{bus_key}|{msg_key}|{signal_name}"),
        bus_key: bus_key.to_string(),
        bus_id,
        ecu_name: ecu_name.to_string(),
        message_key: msg_key.to_string(),
        message_name: message_name.map(ToString::to_string),
        message_id: id.raw(),
        extended: id.is_extended(),
        signal_name: signal_name.to_string(),
        unit: String::new(),
        status: RbsSignalStatus::NotEncoded,
        value: None,
        label: None,
        overridden: false,
        override_text: None,
        calc_role: None,
        factor: 1.0,
        offset: 0.0,
        min: 0.0,
        max: 0.0,
        size: 0,
        signed: false,
        has_value_table: false,
        default_value: None,
        detail: "No mapped database encodes this field".to_string(),
    }
}

/// A Not Encoded row for a message no scoped DBC defines at all (or an
/// unresolved bus) — even the message id/name are the file's own, not
/// a DBC's.
fn not_encoded_row_raw(
    bus_key: &str,
    bus_id: Option<String>,
    msg_key: &str,
    message_id: u32,
    extended: bool,
    signal_name: &str,
    ecu_name: &str,
) -> RbsSignalRow {
    RbsSignalRow {
        id: format!("{bus_key}|{msg_key}|{signal_name}"),
        bus_key: bus_key.to_string(),
        bus_id,
        ecu_name: ecu_name.to_string(),
        message_key: msg_key.to_string(),
        message_name: None,
        message_id,
        extended,
        signal_name: signal_name.to_string(),
        unit: String::new(),
        status: RbsSignalStatus::NotEncoded,
        value: None,
        label: None,
        overridden: false,
        override_text: None,
        calc_role: None,
        factor: 1.0,
        offset: 0.0,
        min: 0.0,
        max: 0.0,
        size: 0,
        signed: false,
        has_value_table: false,
        default_value: None,
        detail: "No mapped database encodes this field".to_string(),
    }
}

/// The override as written, for the row's raw-value display — same
/// rendering `rbs/view.rs`'s `RbsSignalView::override_text` uses.
fn override_text(v: &RbsValue) -> String {
    match v {
        RbsValue::Number(n) => n.to_string(),
        RbsValue::Text(t) => t.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rbs::runtime::RbsElementState;
    use crate::rbs::RbsFile;

    /// `Mode` carries a `GenSigStartValue` (raw 2 = "Auto") and a
    /// `VAL_` table; `Level` has none, so its default is the file's
    /// fill bit. One message (`0x123`, `BMS`) is enough to exercise
    /// every per-signal status; a second (`0x200`) has no DBC
    /// definition at all, to exercise the message-level Not Encoded
    /// path.
    const DBC: &str = r#"VERSION ""
NS_ :
BS_:
BU_: BMS
BO_ 291 Status: 8 BMS
 SG_ Mode : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Level : 8|8@1+ (1,0) [0|255] "pct" Vector__XXX
BA_DEF_ SG_ "GenSigStartValue" FLOAT 0 100000;
BA_DEF_DEF_ "GenSigStartValue" 0;
BA_ "GenSigStartValue" SG_ 291 Mode 2;
VAL_ 291 Mode 0 "Off" 1 "On" 2 "Auto";
"#;

    fn setup(file_json: &str) -> AppState {
        let state = crate::tests::test_state();
        state
            .databases
            .lock()
            .unwrap()
            .push(crate::tests::loaded_scoped("a.dbc", DBC, &["p1"]));
        let file = RbsFile::parse(file_json).unwrap();
        let mut rbs = state.rbs.lock().unwrap();
        rbs.project_buses = vec![("p1".into(), "Powertrain".into())];
        rbs.elements.insert(
            "el1".into(),
            RbsElementState {
                watch: crate::watched_file::WatchedFile::default(),
                changed_on_disk: false,
                file,
                dirty: false,
                run: false,
            },
        );
        drop(rbs);
        state
    }

    fn row<'a>(rows: &'a [RbsSignalRow], bus: &str, msg: &str, sig: &str) -> &'a RbsSignalRow {
        rows.iter()
            .find(|r| r.bus_key == bus && r.message_key == msg && r.signal_name == sig)
            .unwrap_or_else(|| panic!("no row for {bus}/{msg}/{sig}: {rows:#?}"))
    }

    #[test]
    fn unknown_element_yields_none() {
        let state = crate::tests::test_state();
        assert!(build_rbs_signal_rows(&state, "nope").is_none());
    }

    /// One pass over a config that exercises every status the encoder
    /// can actually produce: an applied override (`Override`), a
    /// tracked start value and a tracked fill (`Default`, both
    /// flavours), a bad enum label (`UnknownValue`), an override
    /// naming a signal the message doesn't define (`NotEncoded` off a
    /// real message), a message no DBC defines at all (`NotEncoded`
    /// off a phantom message), and an unresolved bus's own override
    /// (`NotEncoded`, `busResolved: false`).
    #[test]
    fn statuses_reflect_the_encoders_own_report() {
        let state = setup(
            r#"{ "schema_version": 1, "buses": {
                 "Powertrain": { "ecus": { "BMS": { "messages": {
                     "0x123": { "signals": { "Mode": "On", "Ghost": 1 } },
                     "0x999": { "signals": { "Phantom": 1 } }
                 } } } },
                 "Sidecar": { "ecus": { "X": { "messages": {
                     "0x1": { "signals": { "Whatever": 5 } }
                 } } } }
             } }"#,
        );
        let rows = build_rbs_signal_rows(&state, "el1").expect("element is loaded");

        let mode = row(&rows, "Powertrain", "0x123", "Mode");
        assert_eq!(mode.status, RbsSignalStatus::Override);
        assert_eq!(mode.bus_id.as_deref(), Some("p1"));
        assert_eq!(mode.message_name.as_deref(), Some("Status"));
        assert_eq!(mode.ecu_name, "BMS", "the DBC's own transmitter grouping");

        let level = row(&rows, "Powertrain", "0x123", "Level");
        assert_eq!(level.status, RbsSignalStatus::Default);
        assert_eq!(
            level.default_value, None,
            "the DBC gives Level no start value — the grid's Default column says so"
        );
        assert_eq!(
            level.detail, "",
            "and the detail no longer carries the sentence the column replaced"
        );

        let ghost = row(&rows, "Powertrain", "0x123", "Ghost");
        assert_eq!(ghost.status, RbsSignalStatus::NotEncoded);
        assert_eq!(
            ghost.bus_id.as_deref(),
            Some("p1"),
            "the message resolves; only the signal doesn't"
        );
        assert!(ghost.value.is_none());

        let phantom = row(&rows, "Powertrain", "0x999", "Phantom");
        assert_eq!(phantom.status, RbsSignalStatus::NotEncoded);
        assert_eq!(
            phantom.bus_id.as_deref(),
            Some("p1"),
            "the bus resolves; only the message doesn't"
        );
        assert!(phantom.message_name.is_none());

        let whatever = row(&rows, "Sidecar", "0x1", "Whatever");
        assert_eq!(whatever.status, RbsSignalStatus::NotEncoded);
        assert_eq!(whatever.bus_id, None, "no project bus is named Sidecar");
    }

    /// The Default column is the DBC's start value in physical units —
    /// what `reconstruct_payload` actually encodes before any override
    /// — carried per row so the grid can show it beside the live value
    /// the override collapsed on top of.
    #[test]
    fn a_dbc_start_value_reaches_the_row_even_under_an_override() {
        let state = setup(
            r#"{ "schema_version": 1, "buses": {
                 "Powertrain": { "ecus": { "BMS": { "messages": {
                     "0x123": { "signals": { "Mode": "On", "Ghost": 1 } }
                 } } } } } }"#,
        );
        let rows = build_rbs_signal_rows(&state, "el1").unwrap();
        let mode = row(&rows, "Powertrain", "0x123", "Mode");
        assert_eq!(mode.status, RbsSignalStatus::Override);
        assert_eq!(
            mode.default_value,
            Some(2.0),
            "GenSigStartValue 2 = Auto, which the override hides from the value cell"
        );
        // A row with no descriptor to read a start value off carries
        // none either.
        let ghost = row(&rows, "Powertrain", "0x123", "Ghost");
        assert_eq!(ghost.default_value, None);
    }

    #[test]
    fn a_bad_enum_label_reads_unknown_value_not_not_encoded() {
        let state = setup(
            r#"{ "schema_version": 1, "buses": {
                 "Powertrain": { "ecus": { "BMS": { "messages": {
                     "0x123": { "signals": { "Mode": "Nonsense" } }
                 } } } } } }"#,
        );
        let rows = build_rbs_signal_rows(&state, "el1").unwrap();
        let mode = row(&rows, "Powertrain", "0x123", "Mode");
        // The signal itself is real and encoded (it decodes to the
        // tracked default); only the override text didn't resolve.
        assert_eq!(mode.status, RbsSignalStatus::UnknownValue);
        assert!(mode.detail.contains("Nonsense"), "{}", mode.detail);
        assert_eq!(mode.label.as_deref(), Some("Auto"), "default survives");
    }

    #[test]
    fn a_message_the_run_flags_would_never_play_reads_muted_regardless_of_overrides() {
        let state = setup(
            r#"{ "schema_version": 1, "buses": {
                 "Powertrain": { "ecus": { "BMS": { "messages": {
                     "0x123": { "signals": { "Mode": "On" } }
                 } } } } } }"#,
        );
        state
            .rbs
            .lock()
            .unwrap()
            .elements
            .get_mut("el1")
            .unwrap()
            .file
            .disabled_messages
            .insert("Powertrain/0x123".into());
        let rows = build_rbs_signal_rows(&state, "el1").unwrap();
        let mode = row(&rows, "Powertrain", "0x123", "Mode");
        assert_eq!(mode.status, RbsSignalStatus::Muted);
        let level = row(&rows, "Powertrain", "0x123", "Level");
        assert_eq!(
            level.status,
            RbsSignalStatus::Muted,
            "muting is message-wide, not per override"
        );
    }
}
