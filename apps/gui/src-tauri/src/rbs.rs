//! Rest-of-bus simulation: the `.cannet_rbs` file model and its host
//! runtime (ADR 0028).
//!
//! An RBS config is a human-editable JSON document of **sparse
//! overrides** nested `bus → ecu → message`: a signal absent from a
//! message's `signals` keeps tracking its DBC default
//! (`GenSigStartValue`, else the file's `fill_bit`); `period_ms`
//! absent falls back to `GenMsgCycleTime`; `counter` / `crc` absent
//! fall back to the DBC's `CannetCounter` / `CannetCrc` attributes
//! (ADR 0027). Bus keys are the project's *logical bus names*; message
//! keys are hex CAN ids with a trailing `x` marking extended ids.
//!
//! At runtime **every DBC message on each configured bus** becomes a
//! provenance-tagged entry in the one
//! [`crate::transmit_frames::TransmitFrameRegistry`] (`rbs:<element>` —
//! excluded from the transmit panel and the project snapshot), with a
//! payload buffer reconstructed **fill bit → DBC defaults →
//! overrides** (a message needs a file entry only to carry
//! overrides). Messages are **enabled by default** — rest-of-bus:
//! everything plays unless muted via the flat `disabled_messages`
//! list. Whether an entry is *scheduled* is the AND of the element's
//! Run flag, the bus / ECU enables, the message not being muted, and
//! the global kill-switch; actual wire transmission additionally
//! gates on per-bus connectivity inside the scheduler (a disconnected
//! bus keeps ticking and resumes on reconnect). Reconciliation is
//! idempotent: [`sync_schedules`] recomputes desired-running for
//! every row (from the row keys the provenance tag carries — no DBC
//! walk) and starts / stops the difference.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ipc::{CalcFieldsSpec, CounterSpec, CrcSpec, TransmitKind, TransmitRequest};
use crate::transmit_frames::{TransmitFrame, TransmitMode, TransmitSource};
use crate::{sys_info, sys_warn, AppState};

/// Current `.cannet_rbs` schema version — current-only, no migrators
/// (ADR 0011 semantics).
pub const RBS_SCHEMA_VERSION: u32 = 1;

// ---------------------------------------------------------------------
// File model (sparse overrides — what the user owns and edits)
// ---------------------------------------------------------------------

/// The `.cannet_rbs` document. `BTreeMap`s keep the serialized key
/// order stable so saves diff cleanly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RbsFile {
    pub schema_version: u32,
    /// The bit value payload bytes start from where the DBC specifies
    /// no default: `0` or `1` (whole-byte fill `0x00` / `0xFF`).
    #[serde(default)]
    pub fill_bit: u8,
    /// Muted messages, flat `"<bus key>/<message key>"` entries.
    /// Everything not listed is enabled — rest-of-bus: every message
    /// plays unless muted. Combined (AND) with the bus / ECU enables.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub disabled_messages: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub buses: BTreeMap<String, RbsBus>,
}

/// The `disabled_messages` key for one message.
fn disabled_key(bus: &str, message: &str) -> String {
    format!("{bus}/{message}")
}

impl RbsFile {
    /// A fresh, empty config.
    #[must_use]
    pub fn new() -> Self {
        Self {
            schema_version: RBS_SCHEMA_VERSION,
            fill_bit: 0,
            disabled_messages: BTreeSet::new(),
            buses: BTreeMap::new(),
        }
    }

    /// Whether a message is enabled (not muted). Default true — a
    /// message needs no file presence to play.
    #[must_use]
    pub fn is_message_enabled(&self, bus: &str, message: &str) -> bool {
        !self.disabled_messages.contains(&disabled_key(bus, message))
    }

    /// The file entry carrying a message's overrides, wherever the
    /// author placed it (the DBC's transmitter grouping wins for
    /// display; a mismatched placement warns).
    fn entry_for(&self, bus: &str, message: &str) -> Option<(&str, &RbsMessage)> {
        self.buses.get(bus).and_then(|b| {
            b.ecus
                .iter()
                .find_map(|(ek, e)| e.messages.get(message).map(|m| (ek.as_str(), m)))
        })
    }

    /// Parse a `.cannet_rbs` document. Only the current
    /// `schema_version` is accepted (ADR 0011).
    pub fn parse(text: &str) -> Result<Self, String> {
        let raw: serde_json::Value =
            serde_json::from_str(text).map_err(|e| format!("invalid RBS JSON: {e}"))?;
        let version = raw
            .get("schema_version")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "missing schema_version".to_string())?;
        if version != u64::from(RBS_SCHEMA_VERSION) {
            return Err(format!(
                "schema version {version}; this build expects {RBS_SCHEMA_VERSION}"
            ));
        }
        let mut file: Self =
            serde_json::from_value(raw).map_err(|e| format!("invalid RBS JSON: {e}"))?;
        if file.fill_bit > 1 {
            return Err(format!("fill_bit must be 0 or 1, got {}", file.fill_bit));
        }
        // The format's first revision carried a per-entry `enabled`
        // flag; fold any `false` into the flat mute list (the field
        // is read but never written now).
        let mut legacy: Vec<String> = Vec::new();
        for (bus_key, bus) in &mut file.buses {
            for ecu in bus.ecus.values_mut() {
                for (msg_key, msg) in &mut ecu.messages {
                    if !msg.enabled {
                        legacy.push(disabled_key(bus_key, msg_key));
                        msg.enabled = true;
                    }
                }
            }
        }
        file.disabled_messages.extend(legacy);
        Ok(file)
    }
}

impl Default for RbsFile {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RbsBus {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub ecus: BTreeMap<String, RbsEcu>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RbsEcu {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub messages: BTreeMap<String, RbsMessage>,
}

/// One message entry — it exists to carry *overrides* (period,
/// signal values, counter / CRC designations). Enabled-ness lives in
/// the file's flat `disabled_messages` list, not here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RbsMessage {
    /// Legacy per-entry mute from the format's first revision: read
    /// and folded into `disabled_messages` on parse, never written.
    #[serde(default = "default_true", skip_serializing)]
    pub enabled: bool,
    /// Send period override; absent → the DBC's `GenMsgCycleTime`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_ms: Option<u32>,
    /// Sparse signal-value overrides: physical numbers, enum labels
    /// as strings, or `0x…` hex (raw) strings.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub signals: BTreeMap<String, RbsValue>,
    /// Counter designation override — replaces the DBC's
    /// `CannetCounter` default wholesale when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counter: Option<CounterSpec>,
    /// CRC designation override — replaces the DBC's `CannetCrc`
    /// default wholesale when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crc: Option<CrcSpec>,
}

impl RbsEcu {
    fn new() -> Self {
        Self {
            enabled: true,
            messages: BTreeMap::new(),
        }
    }
}

impl RbsBus {
    fn new() -> Self {
        Self {
            enabled: true,
            ecus: BTreeMap::new(),
        }
    }
}

impl RbsMessage {
    fn new() -> Self {
        Self {
            enabled: true,
            period_ms: None,
            signals: BTreeMap::new(),
            counter: None,
            crc: None,
        }
    }
}

fn default_true() -> bool {
    true
}

/// A signal override value as written in the file: a physical number,
/// or a string carrying an enum label / `0x…` raw hex.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RbsValue {
    Number(f64),
    Text(String),
}

/// Parse a message key: hex CAN id, trailing `x` = extended
/// (`"0x123"`, `"0x18FF40E5x"`). A bare hex string without the `0x`
/// prefix is accepted too.
pub fn parse_message_key(key: &str) -> Result<(u32, bool), String> {
    // A trailing x marks an extended id — except when it's the x of a
    // bare "0x" prefix (rest == "0"), which is just a malformed key.
    let (body, extended) = match key.strip_suffix(['x', 'X']) {
        Some(rest) if !rest.is_empty() && rest != "0" => (rest, true),
        _ => (key, false),
    };
    let digits = body
        .strip_prefix("0x")
        .or_else(|| body.strip_prefix("0X"))
        .unwrap_or(body);
    let id = u32::from_str_radix(digits, 16).map_err(|_| format!("invalid message key {key}"))?;
    Ok((id, extended))
}

/// Format a message key — the inverse of [`parse_message_key`].
#[must_use]
pub fn format_message_key(id: u32, extended: bool) -> String {
    if extended {
        format!("0x{id:X}x")
    } else {
        format!("0x{id:X}")
    }
}

// ---------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------

/// One loaded RBS element's host state: the file path (`None` until
/// the config is first saved — a fresh element lives entirely in
/// memory), the in-memory document (the override source of truth),
/// the dirty flag, and the element's Run flag (mirrored from the
/// project element so the host can schedule without the frontend
/// awake).
pub struct RbsElementState {
    pub path: Option<String>,
    pub file: RbsFile,
    pub dirty: bool,
    pub run: bool,
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
    fn resolve_bus(&self, name: &str) -> Option<String> {
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
    fn ensure_seeded(&mut self, element_id: &str) -> bool {
        if self.elements.contains_key(element_id) {
            return false;
        }
        let file = seeded_file(&self.project_buses);
        self.elements.insert(
            element_id.to_string(),
            RbsElementState {
                path: None,
                file,
                dirty: false,
                run: false,
            },
        );
        true
    }
}

/// The registry id of one RBS row — deterministic so no id map needs
/// keeping: `rbs:<element>:<bus key>:<message key>`.
fn row_id(element: &str, bus_key: &str, msg_key: &str) -> String {
    format!("rbs:{element}:{bus_key}:{msg_key}")
}

// ---------------------------------------------------------------------
// Buffer reconstruction
// ---------------------------------------------------------------------

/// Reconstruct one message's payload buffer: fill bit → DBC defaults
/// (`GenSigStartValue`) → overrides (ADR 0028). Returns the buffer
/// plus a warning per override that couldn't be applied (unknown
/// signal, unknown enum label, malformed hex).
fn reconstruct_payload(
    db: &cannet_dbc::Database,
    id: cannet_core::CanId,
    desc: &cannet_dbc::MessageDescriptor,
    msg: &RbsMessage,
    fill_bit: u8,
) -> (Vec<u8>, Vec<String>) {
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
            warnings.push(format!("unknown signal {name}"));
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
                        warnings.push(format!("{name}: invalid hex value {text}"));
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
                        warnings.push(format!("{name}: no enum label \"{t}\""));
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

/// Whether DBC `d` is scoped to bus `bus_id`. An empty scope is the
/// "applies to all buses" default.
fn dbc_scoped_to(d: &crate::LoadedDbc, bus_id: &str) -> bool {
    d.buses.is_empty() || d.buses.iter().any(|b| b == bus_id)
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
fn for_each_scoped_message<F>(dbs: &[crate::LoadedDbc], bus_id: &str, mut visit: F)
where
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
    let rbs = state.rbs.lock().expect("rbs mutex poisoned");
    let Some(element) = rbs.elements.get(element_id) else {
        return Vec::new();
    };
    let mut warnings = Vec::new();
    let mut desired: Vec<TransmitFrame> = Vec::new();
    let no_overrides = RbsMessage::new();

    let dbs = state.databases.lock().expect("databases mutex poisoned");
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
            let (data, mut w) = reconstruct_payload(db, id, desc, msg, element.file.fill_bit);
            warnings.extend(
                w.drain(..)
                    .map(|w| format!("{bus_key}/{ecu_name}/{msg_key}: {w}")),
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

    let mut registry = state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned");
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
/// scheduler, not here — a disconnected bus keeps its schedule
/// ticking and resumes on reconnect). Derives desired-state from the
/// row keys the registry's provenance carries — no DBC lock, so the
/// hot enable / run / kill-switch paths stay light. Idempotent.
fn sync_schedules(state: &AppState) {
    let rbs = state.rbs.lock().expect("rbs mutex poisoned");
    let mut registry = state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned");
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
                state.transmit_scheduler.start(row.id);
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
fn notify_schedule_change(app: &AppHandle, element_id: &str) {
    let state: State<'_, AppState> = app.state();
    sync_schedules(&state);
    let _ = app.emit("rbs-changed", element_id);
}

/// Rebuild rows + re-resolve calculated fields + rebuild the
/// ingest-time verification index + reconcile schedules for one
/// element, then notify panels. The standard tail of every mutation
/// command.
fn refresh_element(app: &AppHandle, element_id: &str) {
    let state: State<'_, AppState> = app.state();
    let warnings = rebuild_element_rows(&state, element_id);
    for w in &warnings {
        sys_warn!(app, "rbs", "{element_id}: {w}");
    }
    crate::refresh_calc_resolutions(app);
    crate::rebuild_verification(&state);
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
        let rbs = state.rbs.lock().expect("rbs mutex poisoned");
        rbs.elements.keys().cloned().collect()
    };
    for id in ids {
        for w in rebuild_element_rows(&state, &id) {
            sys_warn!(app, "rbs", "{id}: {w}");
        }
    }
    crate::refresh_calc_resolutions(app);
    crate::rebuild_verification(&state);
    sync_schedules(&state);
    let _ = app.emit("rbs-changed", "*");
}

// ---------------------------------------------------------------------
// IPC commands
// ---------------------------------------------------------------------

/// Load (or reload) a `.cannet_rbs` file for an RBS element. The run
/// flag starts/stays as the element previously had it only when
/// reloading the same element id; a fresh load starts stopped — the
/// frontend pushes the project-persisted Run flag separately via
/// [`rbs_set_run`].
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_load(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    path: String,
) -> Result<(), String> {
    // On any failure the element still gets state — the seeded
    // file-less default — so its panel shows the usual tree instead
    // of nothing (the error is on the system log; the element's path
    // is left unset so a later Save can't clobber the unreadable
    // file).
    let fallback = |msg: String| {
        crate::sys_error!(&app, "rbs", "{msg}");
        let seeded = state
            .rbs
            .lock()
            .expect("rbs mutex poisoned")
            .ensure_seeded(&element_id);
        if seeded {
            refresh_element(&app, &element_id);
        }
        msg
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => return Err(fallback(format!("failed to read RBS file at {path}: {e}"))),
    };
    let file = match RbsFile::parse(&text) {
        Ok(f) => f,
        Err(e) => return Err(fallback(format!("RBS file at {path}: {e}"))),
    };
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let run = rbs.elements.get(&element_id).is_some_and(|e| e.run);
        rbs.elements.insert(
            element_id.clone(),
            RbsElementState {
                path: Some(path.clone()),
                file,
                dirty: false,
                run,
            },
        );
    }
    sys_info!(&app, "rbs", "loaded RBS config {path}");
    refresh_element(&app, &element_id);
    Ok(())
}

/// A fresh, file-less default config: every current project bus is
/// pre-added (the panel then lists each bus's DBC tree), nothing is
/// enabled, no overrides. What [`rbs_init`] seeds.
fn seeded_file(project_buses: &[(String, String)]) -> RbsFile {
    let mut file = RbsFile::new();
    for (_, name) in project_buses {
        file.buses.insert(name.clone(), RbsBus::new());
    }
    file
}

/// Ensure an element has host state. A fresh RBS element needs no
/// file: it starts as an in-memory config pre-seeded with the
/// project's current logical buses, and only touches disk when the
/// user saves (`rbs_save` / Save All prompt for a path). A no-op for
/// an element that's already loaded.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_init(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
) -> Result<(), String> {
    let seeded = state
        .rbs
        .lock()
        .expect("rbs mutex poisoned")
        .ensure_seeded(&element_id);
    if seeded {
        refresh_element(&app, &element_id);
    }
    Ok(())
}

/// Tear down an element's rows (element removed / project closing).
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_unload(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
) -> Result<(), String> {
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        rbs.elements.remove(&element_id);
    }
    let mut registry = state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned");
    for id in registry.rbs_row_ids(&element_id) {
        registry.remove(&id);
        state.transmit_scheduler.stop(id);
    }
    drop(registry);
    let _ = app.emit("rbs-changed", element_id);
    Ok(())
}

/// Push the project's logical-bus list (id, name pairs). RBS bus keys
/// resolve against the *names*; the frontend (which owns the project)
/// calls this on open and on any bus add / rename / remove.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_sync_project_buses(
    app: AppHandle,
    state: State<'_, AppState>,
    buses: Vec<(String, String)>,
) -> Result<(), String> {
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        rbs.project_buses = buses;
    }
    refresh_all_elements(&app);
    Ok(())
}

/// Set an element's Run flag (the project persists it; default off).
/// false→true seeds every row's counter at 0 (ADR 0028: counters seed
/// when the element starts running) before scheduling.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_run(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    run: bool,
) -> Result<(), String> {
    let started = {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let Some(element) = rbs.elements.get_mut(&element_id) else {
            return Ok(());
        };
        let started = run && !element.run;
        element.run = run;
        started
    };
    if started {
        let mut registry = state
            .transmit_frames
            .lock()
            .expect("transmit_frames mutex poisoned");
        for id in registry.rbs_row_ids(&element_id) {
            registry.reset_counter(&id);
        }
    }
    sync_schedules(&state);
    let _ = app.emit("rbs-changed", element_id);
    Ok(())
}

/// The global RBS kill-switch (runtime-only, never persisted): on
/// stops every RBS row everywhere; off resumes whatever the model
/// says should run.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_kill_switch(
    app: AppHandle,
    state: State<'_, AppState>,
    on: bool,
) -> Result<(), String> {
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        rbs.kill_switch = on;
    }
    sys_info!(
        &app,
        "rbs",
        "global RBS kill-switch {}",
        if on {
            "ON — all simulation transmit stopped"
        } else {
            "off"
        }
    );
    sync_schedules(&state);
    // Dedicated event so every surface that mirrors the runtime-only
    // flag (panel button, palette toggle) tracks the same value.
    let _ = app.emit("rbs-kill-switch", on);
    let _ = app.emit("rbs-changed", "*");
    Ok(())
}

/// Mutate one element's file document in place, mark it dirty, and
/// run the rebuild/resolve/sync/notify tail. The closure returns
/// `Err` to reject the edit (nothing is marked dirty).
fn edit_file<F>(app: &AppHandle, state: &AppState, element_id: &str, edit: F) -> Result<(), String>
where
    F: FnOnce(&mut RbsFile) -> Result<(), String>,
{
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let element = rbs
            .elements
            .get_mut(element_id)
            .ok_or_else(|| format!("no RBS element {element_id}"))?;
        edit(&mut element.file)?;
        element.dirty = true;
    }
    refresh_element(app, element_id);
    Ok(())
}

/// Address one message entry in a file, creating the path (bus → ecu
/// → message) if missing.
fn entry_mut<'a>(file: &'a mut RbsFile, bus: &str, ecu: &str, message: &str) -> &'a mut RbsMessage {
    file.buses
        .entry(bus.to_string())
        .or_insert_with(RbsBus::new)
        .ecus
        .entry(ecu.to_string())
        .or_insert_with(RbsEcu::new)
        .messages
        .entry(message.to_string())
        .or_insert_with(RbsMessage::new)
}

/// Set an `enabled` flag. `ecu` / `message` absent address the outer
/// levels. A message toggle edits the flat `disabled_messages` list
/// (messages are enabled by default); bus / ECU toggles edit their
/// entries (created as needed — adding a missing bus brings its DBC
/// tree into the simulation). Toggling an outer level preserves the
/// inner state (ADR 0028).
///
/// Pure-scheduling edits skip the row rebuild: only a *new bus*
/// changes what rows exist.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    bus: String,
    ecu: Option<String>,
    message: Option<String>,
    enabled: bool,
) -> Result<(), String> {
    let new_bus = {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let element = rbs
            .elements
            .get_mut(&element_id)
            .ok_or_else(|| format!("no RBS element {element_id}"))?;
        let new_bus = !element.file.buses.contains_key(&bus);
        match (&ecu, &message) {
            (None, _) => {
                element
                    .file
                    .buses
                    .entry(bus)
                    .or_insert_with(RbsBus::new)
                    .enabled = enabled;
            }
            (Some(ecu), None) => {
                element
                    .file
                    .buses
                    .entry(bus)
                    .or_insert_with(RbsBus::new)
                    .ecus
                    .entry(ecu.clone())
                    .or_insert_with(RbsEcu::new)
                    .enabled = enabled;
            }
            (Some(_), Some(message)) => {
                let key = disabled_key(&bus, message);
                if enabled {
                    element.file.disabled_messages.remove(&key);
                } else {
                    element.file.disabled_messages.insert(key);
                }
            }
        }
        element.dirty = true;
        new_bus
    };
    if new_bus {
        refresh_element(&app, &element_id);
    } else {
        notify_schedule_change(&app, &element_id);
    }
    Ok(())
}

/// Addresses one message entry in an element's file — the `bus →
/// ecu → message` key path the per-message mutation commands share.
#[derive(Deserialize, Clone, Debug)]
pub struct RbsTarget {
    pub bus: String,
    pub ecu: String,
    pub message: String,
}

/// Set or clear a message's period override.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_period(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    target: RbsTarget,
    period_ms: Option<u32>,
) -> Result<(), String> {
    edit_file(&app, state.inner(), &element_id, |file| {
        entry_mut(file, &target.bus, &target.ecu, &target.message).period_ms = period_ms;
        Ok(())
    })
}

/// Set a signal-value override (`value` is a number, an enum label,
/// or a `0x…` hex string), or clear it with `None` — the signal goes
/// back to tracking its DBC default.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_signal(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    target: RbsTarget,
    signal: String,
    value: Option<RbsValue>,
) -> Result<(), String> {
    edit_file(&app, state.inner(), &element_id, |file| {
        let entry = entry_mut(file, &target.bus, &target.ecu, &target.message);
        match value {
            Some(v) => {
                entry.signals.insert(signal, v);
            }
            None => {
                entry.signals.remove(&signal);
            }
        }
        Ok(())
    })
}

/// Set or clear a message's calculated-field overrides (each replaces
/// the DBC default wholesale for that field — ADR 0027).
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_set_calc(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    target: RbsTarget,
    counter: Option<CounterSpec>,
    crc: Option<CrcSpec>,
) -> Result<(), String> {
    edit_file(&app, state.inner(), &element_id, |file| {
        let entry = entry_mut(file, &target.bus, &target.ecu, &target.message);
        entry.counter = counter;
        entry.crc = crc;
        Ok(())
    })
}

/// Write an element's document back to its file (pretty-printed) and
/// clear the dirty flag. Errors when the element has never been
/// saved — the caller routes through [`rbs_save_as`] with a
/// user-picked path in that case.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_save(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
) -> Result<(), String> {
    let path = {
        let rbs = state.rbs.lock().expect("rbs mutex poisoned");
        rbs.elements
            .get(&element_id)
            .ok_or_else(|| format!("no RBS element {element_id}"))?
            .path
            .clone()
            .ok_or("RBS config has no file yet — pick a path (Save As)")?
    };
    write_element(&app, state.inner(), &element_id, &path)
}

/// First save of a file-less config (or an explicit re-point): set
/// the element's path and write.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_save_as(
    app: AppHandle,
    state: State<'_, AppState>,
    element_id: String,
    path: String,
) -> Result<(), String> {
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let element = rbs
            .elements
            .get_mut(&element_id)
            .ok_or_else(|| format!("no RBS element {element_id}"))?;
        element.path = Some(path.clone());
    }
    write_element(&app, state.inner(), &element_id, &path)
}

fn write_element(
    app: &AppHandle,
    state: &AppState,
    element_id: &str,
    path: &str,
) -> Result<(), String> {
    let text = {
        let rbs = state.rbs.lock().expect("rbs mutex poisoned");
        let element = rbs
            .elements
            .get(element_id)
            .ok_or_else(|| format!("no RBS element {element_id}"))?;
        serde_json::to_string_pretty(&element.file).map_err(|e| e.to_string())?
    };
    std::fs::write(path, text).map_err(|e| {
        let msg = format!("failed to write RBS file to {path}: {e}");
        crate::sys_error!(app, "rbs", "{msg}");
        msg
    })?;
    {
        let mut rbs = state.rbs.lock().expect("rbs mutex poisoned");
        if let Some(element) = rbs.elements.get_mut(element_id) {
            element.dirty = false;
        }
    }
    sys_info!(app, "rbs", "saved RBS config {path}");
    let _ = app.emit("rbs-changed", element_id.to_string());
    Ok(())
}

/// One dirty element, for Save All and the exit prompt.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RbsDirtyRecord {
    pub element_id: String,
    /// `None` = never saved; Save All prompts for a path.
    pub path: Option<String>,
}

/// Every element with unsaved override edits.
#[tauri::command]
#[allow(clippy::needless_pass_by_value, clippy::unused_async)]
pub async fn rbs_dirty(state: State<'_, AppState>) -> Result<Vec<RbsDirtyRecord>, String> {
    let rbs = state.rbs.lock().expect("rbs mutex poisoned");
    let mut out: Vec<RbsDirtyRecord> = rbs
        .elements
        .iter()
        .filter(|(_, e)| e.dirty)
        .map(|(id, e)| RbsDirtyRecord {
            element_id: id.clone(),
            path: e.path.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.element_id.cmp(&b.element_id));
    Ok(out)
}

// ---------------------------------------------------------------------
// The view query
// ---------------------------------------------------------------------

/// The whole tree one RBS panel renders, assembled host-side: the
/// file's buses overlaid on each resolved bus's DBC content (every
/// DBC message grouped per transmitter ECU, whether or not the file
/// lists it), with effective values decoded from the reconstructed
/// buffers.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RbsView {
    pub element_id: String,
    /// `None` until the config is first saved.
    pub path: Option<String>,
    pub fill_bit: u8,
    pub dirty: bool,
    pub run: bool,
    pub kill_switch: bool,
    pub buses: Vec<RbsBusView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RbsBusView {
    /// The file's key — the project logical-bus *name*.
    pub key: String,
    /// The resolved project bus id, or `None` when no project bus has
    /// this name (rows render inert).
    pub bus_id: Option<String>,
    /// Whether an active session currently routes this bus.
    pub connected: bool,
    pub enabled: bool,
    pub ecus: Vec<RbsEcuView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RbsEcuView {
    pub name: String,
    pub enabled: bool,
    pub messages: Vec<RbsMessageView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
// The flags are independent facts (file membership, enables, schedule
// state, FD-ness, per-field override markers) — collapsing them would
// erase which input each came from.
#[allow(clippy::struct_excessive_bools)]
pub struct RbsMessageView {
    /// The file key form (`0x…` / `0x…x`).
    pub key: String,
    pub message_id: u32,
    pub extended: bool,
    /// DBC message name; `None` when no scoped DBC defines the id
    /// (file-listed but unknown — inert row).
    pub name: Option<String>,
    /// Whether the file lists this message (it carries overrides /
    /// an enable). DBC messages not in the file render disabled.
    pub in_file: bool,
    pub enabled: bool,
    /// Scheduled right now (run flag && enables && !kill-switch).
    pub running: bool,
    /// The effective period: the file override, else
    /// `GenMsgCycleTime`. `None` = no period anywhere — the message
    /// can't be enabled.
    pub period_ms: Option<u32>,
    pub period_overridden: bool,
    pub is_fd: bool,
    pub expected_len: usize,
    /// Current payload buffer (reconstructed; live entries show the
    /// registry buffer with the last-applied calculated fields).
    pub data: Vec<u8>,
    /// Effective designations (override else DBC default), spec-shaped.
    pub counter: Option<CounterSpec>,
    pub counter_overridden: bool,
    pub crc: Option<CrcSpec>,
    pub crc_overridden: bool,
    /// DBC transmitter disagreeing with the file's ECU placement.
    pub transmitter_mismatch: Option<String>,
    pub signals: Vec<RbsSignalView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RbsSignalView {
    pub name: String,
    pub unit: String,
    /// Decoded physical value from the current buffer (`None` for an
    /// inactive multiplexed arm).
    pub value: Option<f64>,
    /// `VAL_` label for the decoded value, if any.
    pub label: Option<String>,
    /// Whether the file overrides this signal.
    pub overridden: bool,
    /// The override as written (number rendered, or the raw string).
    pub override_text: Option<String>,
    /// `"counter"` / `"crc"` when this signal is the effective
    /// destination of a calculated field (cells render read-only).
    pub calc_role: Option<&'static str>,
    pub factor: f64,
    pub offset: f64,
    pub min: f64,
    pub max: f64,
    pub size: u32,
    pub signed: bool,
    pub float_kind: &'static str,
    pub has_value_table: bool,
}

/// Assemble the panel view for one element. `None` if the element
/// isn't loaded.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    clippy::too_many_lines,
    clippy::unused_async
)]
pub async fn rbs_view(
    state: State<'_, AppState>,
    element_id: String,
) -> Result<Option<RbsView>, String> {
    let rbs = state.rbs.lock().expect("rbs mutex poisoned");
    let Some(element) = rbs.elements.get(&element_id) else {
        return Ok(None);
    };
    let dbs = state.databases.lock().expect("databases mutex poisoned");
    let registry = state
        .transmit_frames
        .lock()
        .expect("transmit_frames mutex poisoned");
    let sessions = state
        .remote_sessions
        .lock()
        .expect("remote_sessions mutex poisoned");

    let mut buses = Vec::new();
    for (bus_key, bus) in &element.file.buses {
        let bus_id = rbs.resolve_bus(bus_key);
        let connected = bus_id
            .as_deref()
            .is_some_and(|b| crate::resolve_bus_route(&sessions, b).is_some());

        // ECU grouping: every message of every scoped DBC, grouped by
        // transmitter, merged with the file's (possibly DBC-unknown)
        // entries.
        let mut ecus: BTreeMap<String, Vec<RbsMessageView>> = BTreeMap::new();
        if let Some(bus_id) = &bus_id {
            for_each_scoped_message(&dbs, bus_id, |db, key, id, desc, ecu_name| {
                // The file entry, if the message is listed — under *any*
                // ECU key (hand-edits may misplace it; the DBC grouping
                // wins, with a warning).
                let file_entry: Option<(&String, &RbsMessage)> = bus
                    .ecus
                    .iter()
                    .find_map(|(ek, e)| e.messages.get(key).map(|m| (ek, m)));
                let view = build_message_view(
                    MessageViewInputs {
                        element_id: &element_id,
                        bus_key,
                        key,
                        enabled: element.file.is_message_enabled(bus_key, key),
                        id,
                        db,
                        desc,
                        file_entry,
                        fill_bit: element.file.fill_bit,
                        ecu_name,
                    },
                    &registry,
                );
                ecus.entry(ecu_name.to_string()).or_default().push(view);
            });
        }
        // File-listed messages no DBC defines (or for an unresolved
        // bus): inert rows under their file ECU.
        for (ecu_key, ecu) in &bus.ecus {
            for (msg_key, msg) in &ecu.messages {
                let already = ecus.values().flatten().any(|m| &m.key == msg_key);
                if already {
                    continue;
                }
                let (message_id, extended) = parse_message_key(msg_key).unwrap_or((0, false));
                ecus.entry(ecu_key.clone())
                    .or_default()
                    .push(RbsMessageView {
                        key: msg_key.clone(),
                        message_id,
                        extended,
                        name: None,
                        in_file: true,
                        enabled: element.file.is_message_enabled(bus_key, msg_key),
                        running: false,
                        period_ms: msg.period_ms,
                        period_overridden: msg.period_ms.is_some(),
                        is_fd: false,
                        expected_len: 0,
                        data: Vec::new(),
                        counter: msg.counter.clone(),
                        counter_overridden: msg.counter.is_some(),
                        crc: msg.crc.clone(),
                        crc_overridden: msg.crc.is_some(),
                        transmitter_mismatch: None,
                        signals: Vec::new(),
                    });
            }
        }

        let ecu_views: Vec<RbsEcuView> = ecus
            .into_iter()
            .map(|(name, mut messages)| {
                messages.sort_by_key(|a| (a.extended, a.message_id));
                let enabled = bus.ecus.get(&name).is_none_or(|e| e.enabled);
                RbsEcuView {
                    name,
                    enabled,
                    messages,
                }
            })
            .collect();
        buses.push(RbsBusView {
            key: bus_key.clone(),
            bus_id,
            connected,
            enabled: bus.enabled,
            ecus: ecu_views,
        });
    }

    Ok(Some(RbsView {
        element_id: element_id.clone(),
        path: element.path.clone(),
        fill_bit: element.file.fill_bit,
        dirty: element.dirty,
        run: element.run,
        kill_switch: rbs.kill_switch,
        buses,
    }))
}

/// Inputs for one message row's view assembly — bundled so the
/// builder's signature stays readable.
#[derive(Clone, Copy)]
struct MessageViewInputs<'a> {
    element_id: &'a str,
    bus_key: &'a str,
    key: &'a str,
    /// From the file's `disabled_messages` (default enabled).
    enabled: bool,
    id: cannet_core::CanId,
    db: &'a cannet_dbc::Database,
    desc: &'a cannet_dbc::MessageDescriptor,
    file_entry: Option<(&'a String, &'a RbsMessage)>,
    fill_bit: u8,
    ecu_name: &'a str,
}

fn build_message_view(
    inputs: MessageViewInputs<'_>,
    registry: &crate::transmit_frames::TransmitFrameRegistry,
) -> RbsMessageView {
    let MessageViewInputs {
        element_id,
        bus_key,
        key,
        enabled,
        id,
        db,
        desc,
        file_entry,
        fill_bit,
        ecu_name,
    } = inputs;
    let default_msg = RbsMessage::new();
    let (file_ecu, msg, in_file) = match file_entry {
        Some((ecu_key, m)) => (Some(ecu_key.as_str()), m, true),
        None => (None, &default_msg, false),
    };

    // Live entries show the registry's buffer (it carries the last
    // applied counter / CRC bytes); unlisted rows reconstruct on the
    // fly.
    let registry_data = registry.request_data(&row_id(element_id, bus_key, key));
    let running = registry.is_running(&row_id(element_id, bus_key, key));
    let data = registry_data.unwrap_or_else(|| reconstruct_payload(db, id, desc, msg, fill_bit).0);

    // Effective designations: override else DBC default (per field).
    let dbc_calc = CalcFieldsSpec::from_config(&desc.calc_fields);
    let counter = msg.counter.clone().or(dbc_calc.counter);
    let crc = msg.crc.clone().or(dbc_calc.crc);

    let decoded = db.decode_raw(id, &data);
    let signals = desc
        .signals
        .iter()
        .map(|s| {
            let dec = decoded
                .as_ref()
                .and_then(|d| d.signals.iter().find(|x| x.name == s.name));
            let override_value = msg.signals.get(&s.name);
            let calc_role = if counter.as_ref().is_some_and(|c| c.signal == s.name) {
                Some("counter")
            } else if crc.as_ref().is_some_and(|c| c.signal == s.name) {
                Some("crc")
            } else {
                None
            };
            RbsSignalView {
                name: s.name.clone(),
                unit: s.unit.clone(),
                value: dec.map(|d| d.value),
                label: dec.and_then(|d| d.label.map(ToString::to_string)),
                overridden: override_value.is_some(),
                override_text: override_value.map(|v| match v {
                    RbsValue::Number(n) => n.to_string(),
                    RbsValue::Text(t) => t.clone(),
                }),
                calc_role,
                factor: s.factor,
                offset: s.offset,
                min: s.min,
                max: s.max,
                size: s.size,
                signed: s.signed,
                float_kind: match s.float_kind {
                    cannet_dbc::FloatKind::Integer => "integer",
                    cannet_dbc::FloatKind::Float32 => "float32",
                    cannet_dbc::FloatKind::Float64 => "float64",
                },
                has_value_table: s.has_value_table,
            }
        })
        .collect();

    let transmitter_mismatch = match (file_ecu, &desc.transmitter) {
        (Some(fe), Some(t)) if fe != t && fe != ecu_name => Some(t.clone()),
        _ => None,
    };

    RbsMessageView {
        key: key.to_string(),
        message_id: id.raw(),
        extended: id.is_extended(),
        name: Some(desc.name.clone()),
        in_file,
        enabled,
        running,
        period_ms: msg.period_ms.or(desc.gen_msg_cycle_time_ms),
        period_overridden: msg.period_ms.is_some(),
        is_fd: desc.is_fd,
        expected_len: desc.expected_len,
        data,
        counter,
        counter_overridden: msg.counter.is_some(),
        crc,
        crc_overridden: msg.crc.is_some(),
        transmitter_mismatch,
        signals,
    }
}

/// The available CRC algorithm names (the `crc-catalog` list) for the
/// GUI's algorithm combo.
#[tauri::command]
pub fn rbs_crc_algorithms() -> Vec<&'static str> {
    cannet_dbc::named_crc_algorithms()
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn message_keys_round_trip_and_reject_garbage() {
        assert_eq!(parse_message_key("0x123"), Ok((0x123, false)));
        assert_eq!(parse_message_key("0x18FF40E5x"), Ok((0x18FF_40E5, true)));
        assert_eq!(parse_message_key("123"), Ok((0x123, false)));
        assert_eq!(parse_message_key("10x"), Ok((0x10, true)));
        assert_eq!(parse_message_key("0x10"), Ok((0x10, false)));
        assert_eq!(parse_message_key("0X1AX"), Ok((0x1A, true)));
        for (id, ext) in [
            (0u32, false),
            (0, true),
            (0x7FF, false),
            (0x1FFF_FFFF, true),
        ] {
            assert_eq!(
                parse_message_key(&format_message_key(id, ext)),
                Ok((id, ext)),
                "round trip {id:#x} ext={ext}"
            );
        }
        assert!(parse_message_key("").is_err());
        assert!(parse_message_key("0x").is_err());
        assert!(parse_message_key("zz").is_err());
        assert!(parse_message_key("x").is_err());
    }

    /// The ADR 0028 example document (comments stripped) parses, and
    /// the sparse semantics round-trip: serialize → parse → equal,
    /// nothing absent materialises.
    #[test]
    fn adr_example_parses_and_round_trips_sparsely() {
        let text = r#"{
          "schema_version": 1,
          "fill_bit": 0,
          "buses": {
            "Powertrain": {
              "enabled": true,
              "ecus": {
                "BMS": {
                  "enabled": true,
                  "messages": {
                    "0x123": {
                      "enabled": false,
                      "period_ms": 10,
                      "signals": {
                        "TargetMode": "Standby",
                        "CmdWord": "0x1A2B",
                        "PackVoltage": 403.2
                      },
                      "counter": { "signal": "AliveCtr", "increment": 1, "rollover": 15 },
                      "crc": { "signal": "Crc8", "algorithm": "CRC-8/SAE-J1850",
                               "range_bits": [0, 56], "prefix": "A3" }
                    }
                  }
                }
              }
            }
          }
        }"#;
        let file = RbsFile::parse(text).unwrap();
        let msg = &file.buses["Powertrain"].ecus["BMS"].messages["0x123"];
        // The first revision's per-entry `enabled: false` folds into
        // the flat mute list on parse (and the field normalises true).
        assert!(msg.enabled);
        assert!(!file.is_message_enabled("Powertrain", "0x123"));
        assert!(file.disabled_messages.contains("Powertrain/0x123"));
        assert_eq!(msg.period_ms, Some(10));
        assert_eq!(msg.signals["PackVoltage"], RbsValue::Number(403.2));
        assert_eq!(msg.signals["TargetMode"], RbsValue::Text("Standby".into()));
        assert_eq!(msg.counter.as_ref().unwrap().rollover, Some(15));
        assert_eq!(msg.crc.as_ref().unwrap().prefix, "A3");

        let round = RbsFile::parse(&serde_json::to_string_pretty(&file).unwrap()).unwrap();
        assert_eq!(round, file);

        // Sparse: a minimal message entry defaults to enabled, no
        // overrides — and serializes back without materialising keys.
        let minimal: RbsFile = RbsFile::parse(
            r#"{ "schema_version": 1,
                 "buses": { "B": { "ecus": { "E": { "messages": { "0x1": {} } } } } } }"#,
        )
        .unwrap();
        let msg = &minimal.buses["B"].ecus["E"].messages["0x1"];
        assert!(msg.enabled && msg.period_ms.is_none() && msg.signals.is_empty());
        let text = serde_json::to_string(&minimal).unwrap();
        assert!(!text.contains("period_ms"), "{text}");
        assert!(!text.contains("signals"), "{text}");
        // The legacy per-entry flag is read-only: never written back.
        let msg_json = serde_json::to_string(&RbsMessage::new()).unwrap();
        assert!(!msg_json.contains("enabled"), "{msg_json}");
    }

    #[test]
    fn parse_gates_on_schema_version_and_fill_bit() {
        assert!(RbsFile::parse(r#"{ "schema_version": 2 }"#).is_err());
        assert!(RbsFile::parse(r#"{ "fill_bit": 0 }"#).is_err());
        assert!(RbsFile::parse(r#"{ "schema_version": 1, "fill_bit": 7 }"#).is_err());
        assert!(RbsFile::parse("not json").is_err());
        assert!(RbsFile::parse(r#"{ "schema_version": 1 }"#).is_ok());
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
        assert!(warnings[0].contains("Nope"));

        // Unknown enum label warns and leaves the default in place.
        let mut msg = RbsMessage::new();
        msg.signals
            .insert("TargetMode".into(), RbsValue::Text("Nonsense".into()));
        let (buf, warnings) = reconstruct_payload(&database, id, &desc, &msg, 0);
        assert_eq!(buf[0], 2, "default survives a bad override");
        assert_eq!(warnings.len(), 1);
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
                    path: Some("/tmp/x.cannet_rbs".into()),
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
            .push(crate::tests::loaded("a.dbc", RBS_DBC));
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
                    path: Some("/tmp/x.cannet_rbs".into()),
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
            .push(crate::tests::loaded("a.dbc", RBS_DBC));
        {
            let mut rbs = state.rbs.lock().unwrap();
            rbs.project_buses = vec![("p1".into(), "Powertrain".into())];
            rbs.elements.insert(
                "el1".into(),
                RbsElementState {
                    path: None,
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
        assert!(rbs.elements["el1"].path.is_none());
        // A loaded element is left untouched.
        rbs.elements.get_mut("el1").unwrap().path = Some("/tmp/x.cannet_rbs".into());
        rbs.elements.get_mut("el1").unwrap().run = true;
        assert!(!rbs.ensure_seeded("el1"));
        assert_eq!(
            rbs.elements["el1"].path.as_deref(),
            Some("/tmp/x.cannet_rbs")
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
            .push(crate::tests::loaded("a.dbc", RBS_DBC));
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
                    path: Some("/tmp/x.cannet_rbs".into()),
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
}
