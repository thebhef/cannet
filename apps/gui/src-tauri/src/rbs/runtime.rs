//! Rest-of-bus runtime reconciliation: the host-side state for
//! loaded RBS elements, payload-buffer reconstruction, and the
//! registration / schedule-reconciliation machinery (ADR 0028).

use std::collections::{HashMap, HashSet};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::ipc::{CalcFieldsSpec, TransmitKind, TransmitRequest};
use crate::sys_warn;
use crate::transmit_frames::{TransmitFrame, TransmitMode, TransmitSource};

use super::file_model::{format_message_key, RbsBus, RbsFile, RbsMessage, RbsValue};

// ---------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------

/// One loaded RBS element's host state: the `.cannet_rbs` it has open
/// (no path until the config is first saved — a fresh element lives
/// entirely in memory), the in-memory document (the override source of
/// truth), the dirty flag, and the element's Run flag (mirrored from
/// the project element so the host can schedule without the frontend
/// awake).
pub struct RbsElementState {
    /// The open file and the content the app last exchanged with it —
    /// what tells an external edit from cannet's own Save
    /// ([`crate::rbs::watch`]).
    pub watch: crate::watched_file::WatchedFile,
    pub file: RbsFile,
    pub dirty: bool,
    pub run: bool,
    /// An external change to the file that was *not* applied, because
    /// the element was dirty or running when it landed (ADR 0053 §1).
    /// Cleared by anything that resolves it: a save, a load, or the
    /// user dismissing it.
    pub changed_on_disk: bool,
}

/// All RBS host state: loaded elements, the project's logical-bus
/// name → id map (pushed by the frontend, which owns the project),
/// and the global runtime-only kill-switch.
#[derive(Default)]
pub struct RbsRuntime {
    pub elements: HashMap<String, RbsElementState>,
    /// `(bus id, bus name)` pairs from the project — RBS bus keys are
    /// *names* (ADR 0028), the transmit layer routes by *id*.
    pub project_buses: Vec<(String, String)>,
    pub kill_switch: bool,
}

impl RbsRuntime {
    /// Resolve a file's logical-bus-name key to the project bus id.
    pub(super) fn resolve_bus(&self, name: &str) -> Option<String> {
        self.project_buses
            .iter()
            .find(|(_, n)| n == name)
            .map(|(id, _)| id.clone())
    }

    /// Ensure `element_id` has state, seeding the file-less default
    /// (project buses pre-added, Run off) when absent. Returns whether
    /// a seed was created. Both the fresh-element path and the
    /// load-failure fallback land here — an RBS element always has
    /// *something* to view.
    pub(super) fn ensure_seeded(&mut self, element_id: &str) -> bool {
        if self.elements.contains_key(element_id) {
            return false;
        }
        let file = seeded_file(&self.project_buses);
        self.elements.insert(
            element_id.to_string(),
            RbsElementState {
                watch: crate::watched_file::WatchedFile::default(),
                file,
                dirty: false,
                run: false,
                changed_on_disk: false,
            },
        );
        true
    }
}

/// The registry id of one RBS row — deterministic so no id map needs
/// keeping: `rbs:<element>:<bus key>:<message key>`.
pub(super) fn row_id(element: &str, bus_key: &str, msg_key: &str) -> String {
    format!("rbs:{element}:{bus_key}:{msg_key}")
}

// ---------------------------------------------------------------------
// Buffer reconstruction
// ---------------------------------------------------------------------

/// Why one override couldn't be applied — the same three cases
/// `reconstruct_payload` has always distinguished, named so a caller
/// can classify without re-parsing the message text (task 89 phase 6:
/// the signals panel's Not Encoded / Unknown Value split is drawn on
/// this distinction — a signal the DBC doesn't define is not encoded
/// at all, one whose *value* isn't recognised still transmits, just
/// carrying the default).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OverrideProblem {
    /// The override names a signal the message descriptor has none of.
    UnknownSignal,
    /// A `0x…` override whose digits don't parse.
    InvalidHex,
    /// A text override matching no `VAL_` label.
    UnknownEnumLabel,
}

/// One override the encoder could not apply, carrying enough to both
/// classify it (`problem`) and reproduce today's system-log wording
/// (`message`) without a second formatting rule to drift from the
/// first.
#[derive(Debug, Clone)]
pub(super) struct OverrideWarning {
    pub signal: String,
    pub problem: OverrideProblem,
    message: String,
}

impl OverrideWarning {
    /// The human-readable warning text (unchanged from what
    /// `reconstruct_payload` has always produced).
    pub(super) fn message(&self) -> &str {
        &self.message
    }
}

/// Reconstruct one message's payload buffer: fill bit → DBC defaults
/// (`GenSigStartValue`) → overrides (ADR 0028). Returns the buffer
/// plus a warning per override that couldn't be applied (unknown
/// signal, unknown enum label, malformed hex).
pub(super) fn reconstruct_payload(
    db: &cannet_dbc::Database,
    id: cannet_core::CanId,
    desc: &cannet_dbc::MessageDescriptor,
    msg: &RbsMessage,
    fill_bit: u8,
) -> (Vec<u8>, Vec<OverrideWarning>) {
    let fill = if fill_bit == 0 { 0x00 } else { 0xFF };
    let mut buf = vec![fill; desc.expected_len];
    let mut warnings = Vec::new();

    // DBC defaults, in declared order (the multiplexor's default picks
    // the active arm if defaults overlap).
    let defaults: Vec<(&str, f64)> = desc
        .signals
        .iter()
        .filter_map(|s| {
            s.start_value_raw
                .map(|raw| (s.name.as_str(), raw.mul_add(s.factor, s.offset)))
        })
        .collect();
    if !defaults.is_empty() {
        let _ = db.encode_frame(id, &defaults, &mut buf);
    }

    // Overrides.
    for (name, value) in &msg.signals {
        let Some(sig) = desc.signals.iter().find(|s| &s.name == name) else {
            warnings.push(OverrideWarning {
                signal: name.clone(),
                problem: OverrideProblem::UnknownSignal,
                message: format!("unknown signal {name}"),
            });
            continue;
        };
        let physical = match value {
            RbsValue::Number(n) => Some(*n),
            RbsValue::Text(text) => {
                let t = text.trim();
                if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
                    // Hex = raw bits; physical via the signal's scale
                    // (signed raw sign-extends at the signal's width).
                    if let Ok(raw) = u64::from_str_radix(hex, 16) {
                        #[allow(clippy::cast_precision_loss)]
                        let raw_f = if sig.signed {
                            cannet_dbc::sign_extend(raw, sig.size) as f64
                        } else {
                            raw as f64
                        };
                        Some(raw_f.mul_add(sig.factor, sig.offset))
                    } else {
                        warnings.push(OverrideWarning {
                            signal: name.clone(),
                            problem: OverrideProblem::InvalidHex,
                            message: format!("{name}: invalid hex value {text}"),
                        });
                        None
                    }
                } else {
                    // Enum label through the VAL_ table.
                    let raw = db
                        .value_table_for_signal(id.raw(), id.is_extended(), name)
                        .and_then(|rows| rows.iter().find(|r| r.label == t).map(|r| r.raw));
                    #[allow(clippy::cast_precision_loss)]
                    if let Some(raw) = raw {
                        Some((raw as f64).mul_add(sig.factor, sig.offset))
                    } else {
                        warnings.push(OverrideWarning {
                            signal: name.clone(),
                            problem: OverrideProblem::UnknownEnumLabel,
                            message: format!("{name}: no enum label \"{t}\""),
                        });
                        None
                    }
                }
            }
        };
        if let Some(physical) = physical {
            let _ = db.encode_frame(id, &[(name.as_str(), physical)], &mut buf);
        }
    }
    (buf, warnings)
}

// ---------------------------------------------------------------------
// Registration and schedule reconciliation
// ---------------------------------------------------------------------

/// Whether DBC `d` is scoped to bus `bus_id` — the same scoping rule
/// the decode path applies ([`crate::filter::dbc_applies`]).
fn dbc_scoped_to(d: &crate::app_state::LoadedDbc, bus_id: &str) -> bool {
    crate::filter::dbc_applies(&d.buses, Some(bus_id))
}

/// Visit every message the rest-of-bus simulation should show for
/// `bus_id`, drawn from **all** DBCs scoped to that bus — a bus may
/// have several (the ev-demo example scopes two per bus). Messages
/// sharing an id are de-duplicated, first DBC on the bus winning. For
/// each surviving message `visit` receives the owning database, the
/// message key, its [`cannet_core::CanId`], the decoded descriptor, and
/// the resolved transmitter (ECU) name. The row rebuild and the panel
/// view share this so they can never disagree about which messages a
/// bus carries.
pub(super) fn for_each_scoped_message<F>(
    dbs: &[crate::app_state::LoadedDbc],
    bus_id: &str,
    mut visit: F,
) where
    F: FnMut(&cannet_dbc::Database, &str, cannet_core::CanId, &cannet_dbc::MessageDescriptor, &str),
{
    let mut seen: HashSet<String> = HashSet::new();
    for loaded in dbs.iter().filter(|d| dbc_scoped_to(d, bus_id)) {
        for content in loaded.db.dbc_content() {
            let key = format_message_key(content.message_id, content.extended);
            let id = if content.extended {
                cannet_core::CanId::extended(content.message_id)
            } else {
                cannet_core::CanId::standard(content.message_id)
            };
            let Ok(id) = id else { continue };
            let Some(desc) = loaded.db.describe_message(id) else {
                continue;
            };
            if !seen.insert(key.clone()) {
                continue;
            }
            let ecu_name = desc
                .transmitter
                .clone()
                .unwrap_or_else(|| "(no transmitter)".to_string());
            visit(&loaded.db, &key, id, &desc, &ecu_name);
        }
    }
}

/// Rebuild one element's registry rows: **every DBC message on each
/// resolved file bus** gets a provenance-tagged registry entry with a
/// freshly reconstructed buffer (overrides applied where the file has
/// an entry); rows that no longer resolve are removed. Returns
/// warnings to surface (file entries no DBC defines, transmitter
/// mismatches, bad overrides).
#[allow(clippy::too_many_lines)]
fn rebuild_element_rows(state: &AppState, element_id: &str) -> Vec<String> {
    let rbs = state.rbs();
    let Some(element) = rbs.elements.get(element_id) else {
        return Vec::new();
    };
    let mut warnings = Vec::new();
    let mut desired: Vec<TransmitFrame> = Vec::new();
    let no_overrides = RbsMessage::new();

    let dbs = state.databases();
    for bus_key in element.file.buses.keys() {
        let Some(bus_id) = rbs.resolve_bus(bus_key) else {
            // Unresolved logical bus: rows render inert in the panel,
            // never a load failure (ADR 0028).
            continue;
        };
        // No DBC scoped to this bus: skip it entirely — no rows, and no
        // "undefined message" warnings for the file's entries.
        if !dbs.iter().any(|d| dbc_scoped_to(d, &bus_id)) {
            continue;
        }
        let mut covered: HashSet<String> = HashSet::new();
        for_each_scoped_message(&dbs, &bus_id, |db, msg_key, id, desc, ecu_name| {
            covered.insert(msg_key.to_string());
            let entry = element.file.entry_for(bus_key, msg_key);
            if let Some((file_ecu, _)) = entry {
                if file_ecu != ecu_name {
                    warnings.push(format!(
                        "{bus_key}/{file_ecu}/{msg_key}: DBC says {ecu_name} transmits {} — using the DBC grouping",
                        desc.name
                    ));
                }
            }
            let msg = entry.map_or(&no_overrides, |(_, m)| m);
            let (data, w) = reconstruct_payload(db, id, desc, msg, element.file.fill_bit);
            warnings.extend(
                w.iter()
                    .map(|w| format!("{bus_key}/{ecu_name}/{msg_key}: {}", w.message())),
            );
            let calc = if msg.counter.is_some() || msg.crc.is_some() {
                Some(CalcFieldsSpec {
                    counter: msg.counter.clone(),
                    crc: msg.crc.clone(),
                })
            } else {
                None
            };
            desired.push(TransmitFrame {
                id: row_id(element_id, bus_key, msg_key),
                description: String::new(),
                request: TransmitRequest {
                    bus_id: bus_id.clone(),
                    id: id.raw(),
                    extended: id.is_extended(),
                    kind: if desc.is_fd {
                        TransmitKind::Fd
                    } else {
                        TransmitKind::Classic
                    },
                    data,
                    brs: desc.brs,
                    esi: false,
                    dlc: 0,
                },
                cycle_ms: msg.period_ms.or(desc.gen_msg_cycle_time_ms).unwrap_or(0),
                mode: TransmitMode::Periodic,
                source: TransmitSource::Rbs {
                    element: element_id.to_string(),
                    bus: bus_key.clone(),
                    ecu: ecu_name.to_string(),
                    message: msg_key.to_string(),
                },
                calc,
            });
        });
        // File entries the DBC doesn't define: carried (the overrides
        // are the user's), warned, no row (ADR 0028).
        if let Some(bus) = element.file.buses.get(bus_key) {
            for (ecu_key, ecu) in &bus.ecus {
                for msg_key in ecu.messages.keys() {
                    if !covered.contains(msg_key) {
                        warnings.push(format!(
                            "{bus_key}/{ecu_key}/{msg_key}: no DBC on this bus defines the message — not loaded"
                        ));
                    }
                }
            }
        }
    }
    drop(dbs);
    drop(rbs);

    let mut registry = state.transmit_frames();
    let desired_ids: HashSet<&str> = desired.iter().map(|f| f.id.as_str()).collect();
    for stale in registry.rbs_row_ids(element_id) {
        if !desired_ids.contains(stale.as_str()) {
            registry.remove(&stale);
            state.transmit_scheduler.stop(stale);
        }
    }
    for frame in desired {
        registry.set(frame);
    }
    warnings
}

/// Reconcile every RBS row's scheduled state with what the model says
/// it should be: `element.run && bus.enabled && ecu.enabled &&
/// !muted && !kill_switch` (per-bus *connectivity* gates inside the
/// scheduler, not here — a disconnected bus parks its rows and they
/// resume when the route returns, ADR 0039). Derives desired-state from the
/// row keys the registry's provenance carries — no DBC lock, so the
/// hot enable / run / kill-switch paths stay light. Idempotent.
pub(super) fn sync_schedules(state: &AppState) {
    let rbs = state.rbs();
    let mut registry = state.transmit_frames();
    for row in registry.rbs_rows() {
        let want = !rbs.kill_switch
            && rbs.elements.get(&row.element).is_some_and(|element| {
                element.run
                    && element.file.buses.get(&row.bus).is_some_and(|bus| {
                        bus.enabled && bus.ecus.get(&row.ecu).is_none_or(|e| e.enabled)
                    })
                    && element.file.is_message_enabled(&row.bus, &row.message)
            });
        if want {
            if registry.begin_periodic(&row.id) == Ok(true) {
                let cycle_ms = registry.cycle_ms(&row.id).unwrap_or(0);
                state.transmit_scheduler.start(row.id, cycle_ms);
            }
        } else if registry.stop_periodic(&row.id) {
            state.transmit_scheduler.stop(row.id);
        }
    }
}

/// The light mutation tail for edits that only change *scheduling*
/// (enable toggles, run flag, kill-switch): reconcile and notify —
/// no row rebuild, no calc re-resolution, no verification rebuild.
/// Keeps the interactive toggle path off the heavy locks while the
/// scheduler is firing.
pub(super) fn notify_schedule_change(app: &AppHandle, element_id: &str) {
    let state: State<'_, AppState> = app.state();
    sync_schedules(&state);
    let _ = app.emit("rbs-changed", element_id);
}

/// Rebuild rows + re-resolve calculated fields + rebuild the
/// ingest-time verification index + reconcile schedules for one
/// element, then notify panels. The standard tail of every mutation
/// command.
pub(super) fn refresh_element(app: &AppHandle, element_id: &str) {
    let state: State<'_, AppState> = app.state();
    let warnings = rebuild_element_rows(&state, element_id);
    for w in &warnings {
        sys_warn!(app, "rbs", "{element_id}: {w}");
    }
    crate::app_state::refresh_calc_resolutions(app);
    crate::app_state::rebuild_verification(&state);
    sync_schedules(&state);
    let _ = app.emit("rbs-changed", element_id);
}

/// Re-derive everything that depends on the DBC set or the project
/// bus list: every element's rows, every TX entry's calculated-field
/// resolution (project entries included), and the schedules. The DBC
/// mutation commands call this instead of bare
/// `refresh_calc_resolutions`.
pub(crate) fn refresh_all_elements(app: &AppHandle) {
    let state: State<'_, AppState> = app.state();
    let ids: Vec<String> = {
        let rbs = state.rbs();
        rbs.elements.keys().cloned().collect()
    };
    for id in ids {
        for w in rebuild_element_rows(&state, &id) {
            sys_warn!(app, "rbs", "{id}: {w}");
        }
    }
    crate::app_state::refresh_calc_resolutions(app);
    crate::app_state::rebuild_verification(&state);
    sync_schedules(&state);
    let _ = app.emit("rbs-changed", "*");
}
/// A fresh, file-less default config: every current project bus is
/// pre-added (the panel then lists each bus's DBC tree), nothing is
/// enabled, no overrides. What [`crate::rbs::rbs_init`] seeds.
fn seeded_file(project_buses: &[(String, String)]) -> RbsFile {
    let mut file = RbsFile::new();
    for (_, name) in project_buses {
        file.buses.insert(name.clone(), RbsBus::new());
    }
    file
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rbs::parse_message_key;

    /// The checked-in ev-zonal example RBS must stay consistent with
    /// its DBCs: every entry's message key resolves, sits under the
    /// DBC's transmitter ECU (a mismatch would warn at load), and its
    /// signal-value overrides encode warning-free. Every
    /// `disabled_messages` key must name a real message too.
    #[test]
    fn ev_zonal_fixture_rbs_resolves_against_its_dbcs() {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/ev-zonal");
        let read = |p: std::path::PathBuf| {
            std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
        };
        let file = RbsFile::parse(&read(root.join("ev-zonal.cannet_rbs"))).unwrap();
        let dbs: std::collections::BTreeMap<&str, cannet_dbc::Database> =
            [("Pack", "pack.dbc"), ("Zonal", "zonal.dbc")]
                .into_iter()
                .map(|(bus, f)| {
                    let db = cannet_dbc::Database::parse(&read(root.join("dbc").join(f))).unwrap();
                    (bus, db)
                })
                .collect();

        let resolve = |bus_key: &str, msg_key: &str| {
            let db = dbs
                .get(bus_key)
                .unwrap_or_else(|| panic!("unknown bus key {bus_key}"));
            let (id, ext) =
                parse_message_key(msg_key).unwrap_or_else(|e| panic!("{bus_key}/{msg_key}: {e}"));
            let can_id = if ext {
                cannet_core::CanId::extended(id)
            } else {
                cannet_core::CanId::standard(id)
            }
            .unwrap();
            let desc = db
                .describe_message(can_id)
                .unwrap_or_else(|| panic!("{bus_key}/{msg_key}: no such message in DBC"));
            (db, can_id, desc)
        };

        for (bus_key, bus) in &file.buses {
            for (ecu_key, ecu) in &bus.ecus {
                for (msg_key, msg) in &ecu.messages {
                    let (db, can_id, desc) = resolve(bus_key, msg_key);
                    assert_eq!(
                        desc.transmitter.as_deref(),
                        Some(ecu_key.as_str()),
                        "{bus_key}/{ecu_key}/{msg_key}: entry filed under the wrong ECU",
                    );
                    let (_, warnings) = reconstruct_payload(db, can_id, &desc, msg, file.fill_bit);
                    assert!(
                        warnings.is_empty(),
                        "{bus_key}/{ecu_key}/{msg_key}: {warnings:?}",
                    );
                }
            }
        }
        for key in &file.disabled_messages {
            let (bus_key, msg_key) = key
                .split_once('/')
                .unwrap_or_else(|| panic!("malformed disabled_messages key {key}"));
            resolve(bus_key, msg_key);
        }
    }

    /// Fixture DBC for the runtime tests: `BMS` transmits `Status`
    /// (counter + CRC attributes, `GenSigStartValue` defaults, an
    /// enum signal, `GenMsgCycleTime` 100); 0x200 has no cycle time.
    const RBS_DBC: &str = r#"VERSION ""

NS_ :

BS_:

BU_: BMS GW

BO_ 291 Status: 8 BMS
 SG_ TargetMode : 0|8@1+ (1,0) [0|255] "" GW
 SG_ PackVoltage : 8|16@1+ (0.1,0) [0|6553.5] "V" GW
 SG_ AliveCtr : 48|4@1+ (1,0) [0|15] "" GW
 SG_ Crc8 : 56|8@1+ (1,0) [0|255] "" GW

BO_ 512 Aux: 8 BMS
 SG_ AuxVal : 0|8@1+ (1,0) [0|255] "" GW

BA_DEF_ BO_ "GenMsgCycleTime" INT 0 100000;
BA_DEF_ SG_ "GenSigStartValue" FLOAT 0 100000;
BA_DEF_ SG_ "CannetCounter" STRING ;
BA_DEF_ SG_ "CannetCrc" STRING ;
BA_DEF_DEF_ "GenMsgCycleTime" 0;
BA_DEF_DEF_ "GenSigStartValue" 0;
BA_DEF_DEF_ "CannetCounter" "";
BA_DEF_DEF_ "CannetCrc" "";
BA_ "GenMsgCycleTime" BO_ 291 100;
BA_ "GenSigStartValue" SG_ 291 TargetMode 2;
BA_ "GenSigStartValue" SG_ 291 PackVoltage 1000;
BA_ "CannetCounter" SG_ 291 AliveCtr "increment=1;rollover=15";
BA_ "CannetCrc" SG_ 291 Crc8 "alg=CRC-8/SAE-J1850;range=0:56";

VAL_ 291 TargetMode 0 "Off" 1 "Standby" 2 "Active";
"#;

    /// A second, disjoint DBC (message 0x300, transmitter `MOT`) used to
    /// exercise more-than-one-DBC-per-bus scoping.
    const SECOND_DBC: &str = r#"VERSION ""
NS_ :
BS_:
BU_: MOT
BO_ 768 MotorStatus: 8 MOT
 SG_ Rpm : 0|16@1+ (1,0) [0|65535] "" Vector__XXX
BA_DEF_ BO_ "GenMsgCycleTime" INT 0 100000;
BA_DEF_DEF_ "GenMsgCycleTime" 0;
BA_ "GenMsgCycleTime" BO_ 768 20;
"#;

    /// A third DBC (message 0x500) scoped to a *different* bus, to prove
    /// the scoping filter excludes off-bus DBCs.
    const THIRD_DBC: &str = r#"VERSION ""
NS_ :
BS_:
BU_: AUX
BO_ 1280 AuxFrame: 8 AUX
 SG_ Val : 0|8@1+ (1,0) [0|255] "" Vector__XXX
"#;

    fn db() -> cannet_dbc::Database {
        cannet_dbc::Database::parse(RBS_DBC).unwrap()
    }

    /// The scoped-message visitor — shared by the row rebuild and the
    /// panel view — unions every DBC scoped to the bus, de-dupes shared
    /// ids (first DBC wins), and excludes DBCs scoped to other buses.
    #[test]
    fn scoped_message_visitor_unions_dedups_and_filters_by_bus() {
        let dbs = vec![
            crate::tests::loaded_scoped("a.dbc", RBS_DBC, &["p1"]), // 0x123, 0x200
            crate::tests::loaded_scoped("a2.dbc", RBS_DBC, &["p1"]), // dup ids → deduped
            crate::tests::loaded_scoped("b.dbc", SECOND_DBC, &["p1"]), // 0x300
            crate::tests::loaded_scoped("c.dbc", THIRD_DBC, &["p2"]), // off-bus → excluded
        ];
        let mut keys = Vec::new();
        for_each_scoped_message(&dbs, "p1", |_db, key, _id, _desc, _ecu| {
            keys.push(key.to_string());
        });
        keys.sort();
        assert_eq!(keys, vec!["0x123", "0x200", "0x300"]);
    }

    #[test]
    fn payload_reconstruction_layers_fill_then_defaults_then_overrides() {
        let database = db();
        let id = cannet_core::CanId::standard(291).unwrap();
        let desc = database.describe_message(id).unwrap();

        // Fill 1 + defaults only: untouched bytes are 0xFF, defaulted
        // signals carry GenSigStartValue (raw 2 / raw 1000).
        let (buf, warnings) = reconstruct_payload(&database, id, &desc, &RbsMessage::new(), 1);
        assert!(warnings.is_empty());
        assert_eq!(buf[0], 2, "TargetMode raw default");
        assert_eq!(
            u16::from_le_bytes([buf[1], buf[2]]),
            1000,
            "PackVoltage raw"
        );
        assert_eq!(buf[7], 0xFF, "no default → fill bit");

        // Overrides: enum by label, hex raw, physical number.
        let mut msg = RbsMessage::new();
        msg.signals
            .insert("TargetMode".into(), RbsValue::Text("Standby".into()));
        msg.signals
            .insert("PackVoltage".into(), RbsValue::Number(403.2));
        msg.signals
            .insert("AliveCtr".into(), RbsValue::Text("0xA".into()));
        msg.signals.insert("Nope".into(), RbsValue::Number(1.0));
        let (buf, warnings) = reconstruct_payload(&database, id, &desc, &msg, 0);
        assert_eq!(buf[0], 1, "enum label Standby = raw 1");
        assert_eq!(u16::from_le_bytes([buf[1], buf[2]]), 4032, "403.2 V / 0.1");
        assert_eq!(buf[6] & 0x0F, 0xA, "hex override is raw bits");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert_eq!(warnings[0].signal, "Nope");
        assert_eq!(warnings[0].problem, OverrideProblem::UnknownSignal);
        assert!(warnings[0].message().contains("Nope"));

        // Unknown enum label warns and leaves the default in place.
        let mut msg = RbsMessage::new();
        msg.signals
            .insert("TargetMode".into(), RbsValue::Text("Nonsense".into()));
        let (buf, warnings) = reconstruct_payload(&database, id, &desc, &msg, 0);
        assert_eq!(buf[0], 2, "default survives a bad override");
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].problem, OverrideProblem::UnknownEnumLabel);

        // Malformed hex is its own, distinct problem — the taxonomy
        // (task 89 phase 6) reads it the same as a bad enum label
        // (Unknown Value: the signal is real, the text isn't), but the
        // two are still classified separately rather than collapsed.
        let mut msg = RbsMessage::new();
        msg.signals
            .insert("AliveCtr".into(), RbsValue::Text("0xZZ".into()));
        let (_, warnings) = reconstruct_payload(&database, id, &desc, &msg, 0);
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].problem, OverrideProblem::InvalidHex);
    }

    /// A bus may have more than one DBC scoped to it (the `ev-demo`
    /// example scopes two per bus). Every message from *every* scoped
    /// DBC must load — not just the first DBC's — and a file entry a
    /// later DBC defines must not be reported as "no DBC defines it".
    #[test]
    fn rows_union_across_every_dbc_scoped_to_a_bus() {
        let state = crate::tests::test_state();
        // Two DBCs, both scoped to bus p1.
        state
            .databases
            .lock()
            .unwrap()
            .push(crate::tests::loaded_scoped("a.dbc", RBS_DBC, &["p1"]));
        state
            .databases
            .lock()
            .unwrap()
            .push(crate::tests::loaded_scoped("b.dbc", SECOND_DBC, &["p1"]));
        // The file references a message from each DBC.
        let file = RbsFile::parse(
            r#"{ "schema_version": 1, "buses": {
                 "Powertrain": { "ecus": {
                     "BMS": { "messages": { "0x123": {} } },
                     "MOT": { "messages": { "0x300": {} } }
                 } } }
             }"#,
        )
        .unwrap();
        {
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
        }

        let warnings = rebuild_element_rows(&state, "el1");
        assert!(
            warnings.is_empty(),
            "no message should be unmatched: {warnings:?}"
        );

        let registry = state.transmit_frames.lock().unwrap();
        let ids = registry.rbs_row_ids("el1");
        // Both DBCs' full message sets register: 0x123 + 0x200 (RBS_DBC)
        // and 0x300 (SECOND_DBC).
        assert!(
            ids.iter()
                .any(|i| i == &row_id("el1", "Powertrain", "0x300")),
            "the second DBC's message must load: {ids:?}"
        );
        assert!(
            ids.iter()
                .any(|i| i == &row_id("el1", "Powertrain", "0x123")),
            "the first DBC's message must still load: {ids:?}"
        );
    }

    /// End-to-end host model: load a file into state, rebuild rows,
    /// and reconcile schedules through run flag / enables /
    /// kill-switch transitions.
    #[test]
    #[allow(clippy::too_many_lines)]
    fn rows_register_and_schedules_follow_the_anded_enables() {
        let state = crate::tests::test_state();
        state
            .databases
            .lock()
            .unwrap()
            .push(crate::tests::loaded_scoped("a.dbc", RBS_DBC, &["p1"]));
        let file = RbsFile::parse(
            r#"{ "schema_version": 1, "buses": {
                 "Powertrain": { "ecus": { "BMS": { "messages": {
                     "0x123": { "signals": { "PackVoltage": 403.2 } },
                     "0x200": {},
                     "0x999": {}
                 } } } },
                 "Ghost": { "ecus": { "X": { "messages": { "0x1": {} } } } }
             } }"#,
        )
        .unwrap();
        {
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
        }

        let warnings = rebuild_element_rows(&state, "el1");
        // 0x999 isn't in the DBC → warned, not loaded. The Ghost bus
        // doesn't resolve → silently inert (no warning, no rows).
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].contains("0x999"));

        let registry = state.transmit_frames.lock().unwrap();
        let ids = registry.rbs_row_ids("el1");
        assert_eq!(ids.len(), 2, "{ids:?}");
        let status_id = row_id("el1", "Powertrain", "0x123");
        let data = registry.request_data(&status_id).unwrap();
        assert_eq!(
            u16::from_le_bytes([data[1], data[2]]),
            4032,
            "override encoded"
        );
        assert_eq!(data[0], 2, "DBC default encoded");
        // Provenance keeps RBS rows out of the panel list / snapshot.
        assert!(registry.list().is_empty());
        assert!(registry.snapshot().is_empty());
        drop(registry);

        // Not running until the element's Run flag is on.
        sync_schedules(&state);
        assert!(!state.transmit_frames.lock().unwrap().is_running(&status_id));

        state
            .rbs
            .lock()
            .unwrap()
            .elements
            .get_mut("el1")
            .unwrap()
            .run = true;
        sync_schedules(&state);
        {
            let registry = state.transmit_frames.lock().unwrap();
            assert!(registry.is_running(&status_id));
            // 0x200 has no period anywhere → can't run.
            assert!(!registry.is_running(&row_id("el1", "Powertrain", "0x200")));
        }

        // Kill switch stops everything; releasing it resumes.
        state.rbs.lock().unwrap().kill_switch = true;
        sync_schedules(&state);
        assert!(!state.transmit_frames.lock().unwrap().is_running(&status_id));
        state.rbs.lock().unwrap().kill_switch = false;
        sync_schedules(&state);
        assert!(state.transmit_frames.lock().unwrap().is_running(&status_id));

        // Disabling the ECU level mutes the message (ANDed enables).
        {
            let mut rbs = state.rbs.lock().unwrap();
            let el = rbs.elements.get_mut("el1").unwrap();
            el.file
                .buses
                .get_mut("Powertrain")
                .unwrap()
                .ecus
                .get_mut("BMS")
                .unwrap()
                .enabled = false;
        }
        sync_schedules(&state);
        assert!(!state.transmit_frames.lock().unwrap().is_running(&status_id));

        // The scheduler fires through the shared fire path: calc
        // fields from the DBC attributes apply on emission.
        {
            let mut rbs = state.rbs.lock().unwrap();
            let el = rbs.elements.get_mut("el1").unwrap();
            el.file
                .buses
                .get_mut("Powertrain")
                .unwrap()
                .ecus
                .get_mut("BMS")
                .unwrap()
                .enabled = true;
        }
        sync_schedules(&state);
        {
            let dbs = state.databases.lock().unwrap();
            let mut registry = state.transmit_frames.lock().unwrap();
            for (id, request, spec) in registry.resolution_inputs() {
                let resolved =
                    crate::resolve_effective_calc(&dbs, &request, spec.as_ref()).unwrap();
                registry.set_resolved_calc(&id, resolved);
            }
            let (fired, cycle_ms) = registry.fire_info(&status_id).unwrap();
            assert_eq!(cycle_ms, 100, "GenMsgCycleTime fallback");
            assert_eq!(fired.data[6] & 0x0F, 1, "counter stepped on fire");
            assert_ne!(fired.data[7], 0, "CRC computed on fire");
        }

        // Message-level mute: the flat disabled list (messages are
        // enabled by default — rest-of-bus plays everything).
        {
            let mut rbs = state.rbs.lock().unwrap();
            let el = rbs.elements.get_mut("el1").unwrap();
            el.file.disabled_messages.insert("Powertrain/0x123".into());
        }
        sync_schedules(&state);
        assert!(!state.transmit_frames.lock().unwrap().is_running(&status_id));
        {
            let mut rbs = state.rbs.lock().unwrap();
            let el = rbs.elements.get_mut("el1").unwrap();
            el.file.disabled_messages.remove("Powertrain/0x123");
        }
        sync_schedules(&state);
        assert!(state.transmit_frames.lock().unwrap().is_running(&status_id));

        // Removing a message's file entry only drops its *overrides* —
        // the row is DBC-derived and stays. Removing the bus entry
        // removes the bus's rows.
        {
            let mut rbs = state.rbs.lock().unwrap();
            let el = rbs.elements.get_mut("el1").unwrap();
            el.file
                .buses
                .get_mut("Powertrain")
                .unwrap()
                .ecus
                .get_mut("BMS")
                .unwrap()
                .messages
                .remove("0x123");
        }
        rebuild_element_rows(&state, "el1");
        assert!(state
            .transmit_frames
            .lock()
            .unwrap()
            .rbs_row_ids("el1")
            .contains(&status_id));
        {
            let mut rbs = state.rbs.lock().unwrap();
            let el = rbs.elements.get_mut("el1").unwrap();
            el.file.buses.remove("Powertrain");
        }
        rebuild_element_rows(&state, "el1");
        assert!(state
            .transmit_frames
            .lock()
            .unwrap()
            .rbs_row_ids("el1")
            .is_empty());
    }

    /// A fresh element's default config pre-adds every project bus
    /// (no overrides) so the panel immediately shows each bus's DBC
    /// tree — and, messages being enabled by default, Run plays the
    /// whole bus.
    #[test]
    fn seeded_default_lists_the_project_buses_and_run_plays_them() {
        let file = seeded_file(&[
            ("p1".into(), "Powertrain".into()),
            ("c1".into(), "Chassis".into()),
        ]);
        assert_eq!(
            file.buses.keys().collect::<Vec<_>>(),
            vec!["Chassis", "Powertrain"]
        );
        assert!(file.buses.values().all(|b| b.enabled && b.ecus.is_empty()));
        let state = crate::tests::test_state();
        state
            .databases
            .lock()
            .unwrap()
            .push(crate::tests::loaded_scoped("a.dbc", RBS_DBC, &["p1"]));
        {
            let mut rbs = state.rbs.lock().unwrap();
            rbs.project_buses = vec![("p1".into(), "Powertrain".into())];
            rbs.elements.insert(
                "el1".into(),
                RbsElementState {
                    watch: crate::watched_file::WatchedFile::default(),
                    changed_on_disk: false,
                    file,
                    dirty: false,
                    run: true,
                },
            );
        }
        rebuild_element_rows(&state, "el1");
        sync_schedules(&state);
        let registry = state.transmit_frames.lock().unwrap();
        // Every DBC message on the resolved bus is a row.
        assert_eq!(registry.rbs_row_ids("el1").len(), 2);
        // Enabled by default + Run on → the periodic-capable message
        // schedules with no file entry at all.
        assert!(registry.is_running(&row_id("el1", "Powertrain", "0x123")));
        // No period anywhere → can't schedule (but isn't an error).
        assert!(!registry.is_running(&row_id("el1", "Powertrain", "0x200")));
    }

    /// An RBS entry names a message by bus and hex id — never by the
    /// database that defined it — so replacing a DBC with a different
    /// *file* that defines the same messages leaves every entry, its
    /// signal-value overrides included, resolving. The replace is the
    /// two DBC-set changes it really is: the new file installed
    /// alongside, then the old one removed, with the rows rebuilt after
    /// each (which is what `add_dbc` / `remove_dbc` do through
    /// `refresh_all_elements`).
    #[test]
    fn rbs_entries_survive_a_dbc_replaced_by_a_different_file() {
        let state = crate::tests::test_state();
        let file = RbsFile::parse(
            r#"{ "schema_version": 1, "buses": {
                 "Powertrain": { "ecus": { "BMS": { "messages": {
                     "0x123": { "signals": { "PackVoltage": 403.2 } }
                 } } } } } }"#,
        )
        .unwrap();
        {
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
        }
        let resolved = |label: &str| {
            let warnings = rebuild_element_rows(&state, "el1");
            assert!(warnings.is_empty(), "{label}: {warnings:?}");
            let registry = state.transmit_frames.lock().unwrap();
            assert!(
                registry
                    .rbs_row_ids("el1")
                    .contains(&row_id("el1", "Powertrain", "0x123")),
                "{label}: the entry's row is registered",
            );
        };

        state
            .databases
            .lock()
            .unwrap()
            .push(crate::tests::loaded_scoped("a.dbc", RBS_DBC, &["p1"]));
        resolved("under the original database");

        // The replacement, installed alongside…
        state
            .databases
            .lock()
            .unwrap()
            .push(crate::tests::loaded_scoped("b.dbc", RBS_DBC, &["p1"]));
        resolved("with both loaded");

        // …and the original removed.
        state
            .databases
            .lock()
            .unwrap()
            .retain(|d| d.path != "a.dbc");
        resolved("under the replacement alone");
    }

    /// The seeded fallback is idempotent: first call creates the
    /// file-less default, repeats are no-ops (an `rbs_load` must never
    /// be overwritten by a late `rbs_init`).
    #[test]
    fn ensure_seeded_creates_once_and_never_overwrites() {
        let mut rbs = RbsRuntime {
            project_buses: vec![("p1".into(), "Powertrain".into())],
            ..RbsRuntime::default()
        };
        assert!(rbs.ensure_seeded("el1"));
        assert!(rbs.elements["el1"].file.buses.contains_key("Powertrain"));
        assert!(rbs.elements["el1"].watch.path().is_none());
        // A loaded element is left untouched.
        rbs.elements
            .get_mut("el1")
            .unwrap()
            .watch
            .point_at(std::path::Path::new("/tmp/x.cannet_rbs"), String::new());
        rbs.elements.get_mut("el1").unwrap().run = true;
        assert!(!rbs.ensure_seeded("el1"));
        assert_eq!(
            rbs.elements["el1"].watch.path(),
            Some(std::path::Path::new("/tmp/x.cannet_rbs"))
        );
        assert!(rbs.elements["el1"].run);
    }

    #[test]
    fn transmitter_mismatch_loads_with_a_warning() {
        let state = crate::tests::test_state();
        state
            .databases
            .lock()
            .unwrap()
            .push(crate::tests::loaded_scoped("a.dbc", RBS_DBC, &["p1"]));
        let file = RbsFile::parse(
            r#"{ "schema_version": 1, "buses": {
                 "Powertrain": { "ecus": { "NotBms": { "messages": { "0x123": {} } } } }
             } }"#,
        )
        .unwrap();
        {
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
        }
        let warnings = rebuild_element_rows(&state, "el1");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].contains("BMS transmits"), "{warnings:?}");
        // Loaded anyway (the DBC grouping wins); rows cover the
        // whole DBC tree.
        assert_eq!(
            state
                .transmit_frames
                .lock()
                .unwrap()
                .rbs_row_ids("el1")
                .len(),
            2
        );
    }

    #[test]
    fn unassigning_a_database_stops_the_rbs_rows_it_was_driving() {
        // An RBS row is a periodic like any other: once no database
        // assigned to its bus defines the message, it is transmitting
        // definitions the project no longer applies, so it stops —
        // counted in the one entry the unassign logs, before the row
        // rebuild takes the row away entirely.
        let state = crate::tests::test_state();
        state
            .databases
            .lock()
            .unwrap()
            .push(crate::tests::loaded_scoped("a.dbc", RBS_DBC, &["p1"]));
        let file = RbsFile::parse(
            r#"{ "schema_version": 1, "buses": {
                 "Powertrain": { "ecus": { "BMS": { "messages": { "0x123": {} } } } }
             } }"#,
        )
        .unwrap();
        {
            let mut rbs = state.rbs.lock().unwrap();
            rbs.project_buses = vec![("p1".into(), "Powertrain".into())];
            rbs.elements.insert(
                "el1".into(),
                RbsElementState {
                    watch: crate::watched_file::WatchedFile::default(),
                    changed_on_disk: false,
                    file,
                    dirty: false,
                    run: true,
                },
            );
        }
        rebuild_element_rows(&state, "el1");
        sync_schedules(&state);
        let status_id = row_id("el1", "Powertrain", "0x123");
        assert!(state.transmit_frames.lock().unwrap().is_running(&status_id));

        let stopped = crate::dbc_commands::set_dbc_buses_inner(&state, "a.dbc", Vec::new());

        assert_eq!(stopped, vec![status_id.clone()]);
        assert!(!state.transmit_frames.lock().unwrap().is_running(&status_id));
        // And the rebuild the announcement runs takes the row away, so
        // the stop is not a state only this path can produce.
        rebuild_element_rows(&state, "el1");
        sync_schedules(&state);
        assert!(state
            .transmit_frames
            .lock()
            .unwrap()
            .rbs_row_ids("el1")
            .is_empty());
    }
}
